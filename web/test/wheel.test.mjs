// Steering wheels through the Gamepad API (web/src/input/wheel.ts, gamepad.ts): which controllers are wheels, the
// layout guessed from where a wheel's axes sat when it showed up, the pad they make, and the set-up's steps.
//   node --test web/test/wheel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = async (f) => import('data:text/javascript;base64,' + Buffer.from((await esbuild.build({
  entryPoints: [path.join(ROOT, f)], bundle: true, format: 'esm', write: false })).outputFiles[0].text).toString('base64'));
const W = await load('web/src/input/wheel.ts');
const P = await load('web/src/input/proto.ts');
const G = await load('web/src/input/gamepad.ts');
const bit = (...b) => b.reduce((m, x) => m | 1 << x, 0);

const G29 = 'G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)';
// a G29 under Chrome on Windows with G HUB: X the wheel, Y the gas, Rz the brake, the slider the clutch (the pedals
// let go at +1), the hat switch let go on axis 9
const G29_REST = [0.002, 1, 0, 0, 0, 1, 1, 0, 0, 9 / 7];

test('wheels by their USB ids, in Chrome\'s and Firefox\'s ids, and by name', () => {
  assert.deepEqual(W.wheelOf(G29), { vendor: '046d', product: 'c24f', layout: 'ps', degrees: 900 });
  assert.equal(W.wheelOf('046d-c24f-G29 Driving Force Racing Wheel').layout, 'ps');
  assert.equal(W.wheelOf('46d-c262-Logitech G920 Driving Force Racing Wheel').layout, 'xbox');
  assert.equal(W.wheelOf('Thrustmaster T300RS Racing wheel (Vendor: 044f Product: b66e)').layout, 'generic');
  assert.equal(W.wheelOf('FANATEC CSL Elite Wheel Base (Vendor: 0eb7 Product: 0e03)').degrees, 0);
  assert.equal(W.wheelOf('Some USB Wheel (Vendor: 1234 Product: 5678)').layout, 'generic');
  assert.equal(W.wheelOf('Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c216)'), null);
  assert.equal(W.wheelOf('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), null);
  assert.equal(W.wheelOf('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), null);
});

test('a G29 let go makes a pad at rest: no stick held down (the report: "down" pressed all the time)', () => {
  const m = W.guessMap(W.wheelOf(G29), G29_REST, 25);
  const hat = W.findHat(G29_REST);
  assert.equal(hat, 9);
  const r = W.readWheel(G29_REST, Array(25).fill(false), m, hat);
  assert.equal(r.buttons, 0);
  assert.deepEqual(r.axes.map(v => +v.toFixed(3)), [0.007, 0, 0, 0, 0, 0]);
});

test('the G29\'s guessed layout: the wheel, Y the gas, Rz the brake, its buttons', () => {
  const m = W.guessMap(W.wheelOf(G29), G29_REST, 25);
  assert.equal(m.steer, 0);
  assert.equal(+m.lock.toFixed(3), 0.3);                      // 270 of its 900 degrees
  assert.deepEqual(m.gas, { axis: 1, rest: 1, full: -1 });
  assert.deepEqual(m.brake, { axis: 5, rest: 1, full: -1 });
  const press = (...i) => W.readWheel(G29_REST, Array.from({ length: 25 }, (_, j) => i.includes(j)), m, 9).buttons;
  assert.equal(press(0), bit(P.PAD_A));                       // Cross
  assert.equal(press(1), bit(P.PAD_X));                       // Square
  assert.equal(press(2), bit(P.PAD_B));                       // Circle
  assert.equal(press(3), bit(P.PAD_Y));                       // Triangle
  assert.equal(press(4, 5), bit(P.PAD_RB, P.PAD_LB));         // the paddles
  assert.equal(press(8, 9), bit(P.PAD_BACK, P.PAD_START));    // Share, Options
  assert.equal(press(10, 11), bit(P.PAD_RS, P.PAD_LS));       // R3, L3
  assert.equal(press(12, 13, 18), 0);                         // the shifter
  assert.equal(press(21), bit(P.PAD_DDOWN));                  // the dial
  assert.equal(press(23), bit(P.PAD_A));                      // Enter
  assert.equal(press(24), bit(P.PAD_HOME));                   // PS: the page's menu
});

test('the wheel, the pedals and the D-pad as the pad', () => {
  const m = W.guessMap(W.wheelOf(G29), G29_REST, 25);
  const at = (over) => { const a = G29_REST.slice(); for (const [i, v] of Object.entries(over)) a[+i] = v; return W.readWheel(a, [], m, 9); };
  assert.equal(+at({ 0: 0.15 }).axes[0].toFixed(3), 0.5);       // half lock: 67.5 degrees right
  assert.equal(at({ 0: -0.45 }).axes[0], -1);                   // past full lock left
  assert.equal(at({ 1: -1 }).axes[5], 1);                       // gas floored
  assert.equal(at({ 1: 0 }).axes[5], 0.5);                      // half
  assert.equal(at({ 5: -1 }).axes[4], 1);                       // brake floored
  assert.equal(at({ 6: -1 }).axes.slice(4).join(), '0,0');      // the clutch: nothing
  const dirs = [-1, -5 / 7, -3 / 7, -1 / 7, 1 / 7, 3 / 7, 5 / 7, 1].map(v => at({ 9: v }).buttons);
  const U = bit(P.PAD_DUP), D = bit(P.PAD_DDOWN), L = bit(P.PAD_DLEFT), R = bit(P.PAD_DRIGHT);
  assert.deepEqual(dirs, [U, U | R, R, D | R, D, D | L, L, U | L]);
  assert.equal(at({ 9: 0 }).buttons, 0);                        // no report yet
  assert.equal(at({ 9: 3.2857 }).buttons, 0);                   // let go (another hat's range)
});

test('other layouts: combined pedals, axes in report order, a G920', () => {
  // G HUB's combined pedals: Y rests in the middle, the gas pulls it up, the brake down
  const c = W.guessMap(W.wheelOf(G29), [0, 0, 0, 0, 0, 0, 0, 0, 0, 9 / 7], 25);
  assert.deepEqual([c.gas, c.brake], [{ axis: 1, rest: 0, full: -1 }, { axis: 1, rest: 0, full: 1 }]);
  assert.deepEqual(W.readWheel([0, -0.6], [], c, -1).axes.slice(4), [0, 0.6]);
  assert.deepEqual(W.readWheel([0, 0.8], [], c, -1).axes.slice(4), [0.8, 0]);
  // axes one after another (Linux): X, Y, Z, Rz, the hat's two axes; the brake is Rz, the last pedal
  const l = W.guessMap(W.wheelOf(G29), [0, 1, 1, 1, 0, 0], 25);
  assert.deepEqual([l.gas.axis, l.brake.axis], [1, 3]);
  // pedals resting at -1
  const n = W.guessMap(W.wheelOf('46d-c262-G920'), [0, -1, -1, 0, 0, 0], 11);
  assert.deepEqual(n.gas, { axis: 1, rest: -1, full: 1 });
  assert.deepEqual(n.brake, { axis: 2, rest: -1, full: 1 });
  assert.deepEqual(n.buttons.slice(0, 8), [P.PAD_A, P.PAD_B, P.PAD_X, P.PAD_Y, P.PAD_RB, P.PAD_LB, P.PAD_START, P.PAD_BACK]);
  // a wheel of unknown rotation: all of it is full lock
  assert.equal(W.guessMap(W.wheelOf('Some USB Wheel'), [0, 1, 1], 12).lock, 1);
});

test('the set-up: let go, turn right to full lock, the gas, the brake', () => {
  const base = W.guessMap(W.wheelOf(G29), G29_REST, 25);
  const L = new W.WheelLearn(base);
  let t = 0;
  const hold = (axes, ms = 800) => { for (let e = 0; e <= ms; e += 16) L.feed(axes, t += 16); };
  const a = (over) => { const x = [-0.01, 1, 0, 0, 0, 1, 1, 0, 0, 9 / 7]; for (const [i, v] of Object.entries(over)) x[+i] = v; return x; };
  hold(a({}));
  assert.equal(L.step, 'steer');
  hold(a({ 9: -1 }));                                           // the D-pad is no wheel
  assert.equal(L.step, 'steer');
  for (let v = 0; v <= 0.2; v += 0.02) L.feed(a({ 0: v }), t += 16);   // turning: not held yet
  assert.equal(L.step, 'steer');
  hold(a({ 0: 0.19 }));
  assert.equal(L.step, 'gas');
  hold(a({ 0: 0.19, 6: -1 }));                                  // the clutch, pressed first, is taken as the gas
  assert.equal(L.step, 'brake');
  const L2 = new W.WheelLearn(base);
  t = 0;
  const hold2 = (axes) => { for (let e = 0; e <= 800; e += 16) L2.feed(axes, t += 16); };
  hold2(a({})); hold2(a({ 0: -0.21 })); hold2(a({ 1: -1 })); hold2(a({ 5: -0.98 }));
  assert.equal(L2.step, 'done');
  const m = L2.map();
  assert.equal(m.steer, 0);
  assert.equal(+m.centre.toFixed(2), -0.01);
  assert.equal(+m.lock.toFixed(2), -0.2);                       // this wheel's axis runs the other way
  assert.deepEqual(m.gas, { axis: 1, rest: 1, full: -1 });
  assert.deepEqual(m.brake, { axis: 5, rest: 1, full: -0.98 });
  assert.equal(m.learned, true);
  assert.deepEqual(m.buttons, base.buttons);
  assert.equal(W.readWheel(a({ 0: -0.21 }), [], m, 9).axes[0], 1);   // right, as turned in the set-up
});

test('the set-up with combined pedals: the brake is the gas\'s axis the other way', () => {
  const L = new W.WheelLearn(W.guessMap(W.wheelOf(G29), [0, 0], 25));
  let t = 0;
  const hold = (axes) => { for (let e = 0; e <= 800; e += 16) L.feed(axes, t += 16); };
  hold([0, 0]); hold([0.3, 0]); hold([0, -1]);
  assert.equal(L.step, 'brake');
  hold([0, -1]);                                                // still the gas: no brake
  assert.equal(L.step, 'brake');
  hold([0, 0.9]);
  assert.deepEqual([L.map().gas, L.map().brake], [{ axis: 1, rest: 0, full: -1 }, { axis: 1, rest: 0, full: 0.9 }]);
});

test('controller families from Chrome\'s and Firefox\'s ids, a wheel\'s from its buttons', () => {
  assert.deepEqual(G.familyOf('54c-ce6-DualSense Wireless Controller'), { family: P.PADF_PLAYSTATION, name: 'DualSense Wireless Controller' });
  assert.deepEqual(G.familyOf('054c-0ce6-DualSense Wireless Controller'), { family: P.PADF_PLAYSTATION, name: 'DualSense Wireless Controller' });
  assert.deepEqual(G.familyOf(G29), { family: P.PADF_PLAYSTATION, name: 'G29 Driving Force Racing Wheel' });
  assert.equal(G.familyOf('46d-c262-G920 Driving Force Racing Wheel').family, P.PADF_XBOX);
  assert.equal(G.familyOf('Xbox 360 Controller (XInput STANDARD GAMEPAD)').family, P.PADF_XBOX);
});

test('a controller without the standard mapping: an axis that rested at an end is no stick', () => {
  const g = { id: 'Generic USB Joystick (Vendor: 0079 Product: 0006)', index: 0, mapping: '', axes: [0, 1, 0, -1],
    buttons: Array.from({ length: 12 }, () => ({ pressed: false, value: 0 })) };
  const s = G.mapStandard(g, new Set([1, 3]));
  assert.deepEqual(s.axes, [0, 0, 0, 0, 0, 0]);
  assert.equal(s.buttons, 0);
  assert.deepEqual(G.mapStandard(g).axes.slice(0, 4), [0, 1, 0, -1]);    // as before, without
});
