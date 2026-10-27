// Unit checks of the page-side input tables, without a browser:
// KeyboardEvent.code -> DIK/VK (web/src/input/keymap.ts), the characters
// synthetic events carry, and the Gamepad API mapping and controller
// families (web/src/input/gamepad.ts).  Also: every key the autotest can name
// (runtime/web/input_web.c's table) has a DOM code to be synthesised with.
//   node web/tools/unit-input.mjs        (exit 1 on a failure)
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const out = await esbuild.build({
  stdin: { contents: "export * from './keymap'; export { familyOf, mapStandard } from './gamepad';",
    resolveDir: path.join(ROOT, 'web/src/input'), loader: 'ts' },
  bundle: true, format: 'esm', write: false, platform: 'neutral',
});
const url = 'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64');
const m = await import(url);

let fails = 0, n = 0;
const eq = (what, got, want) => {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fails++; console.log(`FAIL ${what}: got ${g}, want ${w}`); }
};

// keys: positions, virtual keys, the extended bit (DIK bit 7)
eq('KeyQ', m.CODES.KeyQ, { dik: 0x10, vk: 0x51 });
eq('KeyA', m.CODES.KeyA, { dik: 0x1E, vk: 0x41 });
eq('ArrowUp', m.CODES.ArrowUp, { dik: 0xC8, vk: 0x26 });
eq('NumpadEnter', m.CODES.NumpadEnter, { dik: 0x9C, vk: 0x0D });
eq('ControlRight', m.CODES.ControlRight, { dik: 0x9D, vk: 0x11 });
eq('AltLeft', m.CODES.AltLeft, { dik: 0x38, vk: 0x12 });
eq('AltRight', m.CODES.AltRight, { dik: 0xB8, vk: 0x12 });
eq('IntlBackslash', m.CODES.IntlBackslash, { dik: 0x56, vk: 0xE2 });
eq('Escape', m.CODES.Escape, { dik: 0x01, vk: 0x1B });
eq('F12', m.CODES.F12, { dik: 0x58, vk: 0x7B });
const ext = Object.entries(m.CODES).filter(([, k]) => k.dik & 0x80).map(([c]) => c).sort();
for (const c of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete',
  'ControlRight', 'AltRight', 'NumpadEnter', 'NumpadDivide', 'MetaLeft', 'MetaRight', 'ContextMenu']) eq(`extended ${c}`, ext.includes(c), true);
for (const c of ['ControlLeft', 'AltLeft', 'Enter', 'Numpad8', 'NumpadMultiply']) eq(`not extended ${c}`, ext.includes(c), false);
// every DIK has one key, except the aliases
const byDik = {};
for (const [c, k] of Object.entries(m.CODES)) (byDik[k.dik] ??= []).push(c);
const aliases = new Set(['KanaMode,Lang1', 'Insert,Help', 'MetaLeft,OSLeft', 'MetaRight,OSRight']);
for (const [d, cs] of Object.entries(byDik)) if (cs.length > 1 && !aliases.has(cs.join(','))) eq(`DIK 0x${(+d).toString(16)} unique`, cs, [cs[0]]);

// code page 1252
eq('cp1252 e-acute', m.cp1252(0xE9), 0xE9);
eq('cp1252 euro', m.cp1252(0x20AC), 0x80);
eq('cp1252 o-double-acute', m.cp1252(0x0151), -1);
eq('cp1252 A', m.cp1252(0x41), 0x41);

// characters of synthetic events (US layout when the browser gives no layout map)
eq('key a', m.keyFor('KeyA', false, false, true, null), 'a');
eq('key A shift', m.keyFor('KeyA', true, false, true, null), 'A');
eq('key A caps (mac)', m.keyFor('KeyA', false, true, true, null), 'A');
eq('key A caps+shift (mac)', m.keyFor('KeyA', true, true, true, null), 'A');
eq('key a caps+shift (windows)', m.keyFor('KeyA', true, true, false, null), 'a');
eq('key 1 shift', m.keyFor('Digit1', true, false, false, null), '!');
eq('key Enter', m.keyFor('Enter', false, false, false, null), 'Enter');
eq('key F5', m.keyFor('F5', false, false, false, null), 'F5');
eq('key Numpad7', m.keyFor('Numpad7', false, false, false, null), '7');
const azerty = new Map([['KeyQ', 'a'], ['KeyA', 'q'], ['KeyM', ','], ['Semicolon', 'm']]);
eq('key AZERTY KeyQ', m.keyFor('KeyQ', false, false, false, azerty), 'a');
eq('stroke T', m.strokeFor('T', null), { code: 'KeyT', shift: true });
eq('stroke !', m.strokeFor('!', null), { code: 'Digit1', shift: true });
eq('stroke space', m.strokeFor(' ', null), { code: 'Space', shift: false });
eq('stroke 7', m.strokeFor('7', null), { code: 'Digit7', shift: false });
eq('stroke e-acute (not on US)', m.strokeFor('é', null), null);
eq('stroke AZERTY a', m.strokeFor('a', azerty), { code: 'KeyQ', shift: false });

// every key the autotest names has a DOM code
const src = fs.readFileSync(path.join(ROOT, 'runtime/web/input_web.c'), 'utf8');
const tbl = src.slice(src.indexOf('static const MacKey K[128]'), src.indexOf('static const struct { const char *alias'));
for (const mm of tbl.matchAll(/\{"([A-Z0-9_]+)", (0x[0-9A-F]+)\}/g)) eq(`synth ${mm[1]}`, !!m.CODE_OF_DIK[Number(mm[2])], true);

// controllers: family and name from Gamepad.id
eq('xbox', m.familyOf('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), { family: 1, name: 'Xbox Wireless Controller' });
eq('dualsense', m.familyOf('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), { family: 2, name: 'DualSense Wireless Controller' });
eq('dualshock4', m.familyOf('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'), { family: 2, name: 'Wireless Controller' });
eq('switch pro', m.familyOf('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'), { family: 3, name: 'Pro Controller' });
eq('firefox style', m.familyOf('054c-0ce6-DualSense Wireless Controller'), { family: 2, name: 'DualSense Wireless Controller' });
eq('generic', m.familyOf('Logitech Dual Action (STANDARD GAMEPAD Vendor: 046d Product: c216)'), { family: 0, name: 'Logitech Dual Action' });
eq('xinput', m.familyOf('xinput'), { family: 1, name: 'xinput' });

// standard mapping -> PadState
const btn = v => ({ pressed: v > 0.5, touched: v > 0, value: v });
const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 2, mapping: 'standard',
  axes: [-0.5, 0.25, 1, -1], buttons: Array.from({ length: 17 }, () => btn(0)) };
pad.buttons[0] = btn(1); pad.buttons[3] = btn(1); pad.buttons[6] = btn(0.3); pad.buttons[7] = btn(1); pad.buttons[9] = btn(1);
pad.buttons[12] = btn(1); pad.buttons[16] = btn(1);
const s = m.mapStandard(pad);
eq('pad buttons A|Y|START|DUP|HOME', s.buttons, (1 << 0) | (1 << 3) | (1 << 7) | (1 << 11) | (1 << 10));
eq('pad axes (y down, triggers 0..1)', s.axes, [-0.5, 0.25, 1, -1, 0.3, 1]);
eq('pad family', [s.family, s.index, s.connected], [1, 2, true]);

console.log(fails ? `unit-input: ${fails} of ${n} checks FAILED` : `unit-input: OK, ${n} checks`);
process.exit(fails ? 1 : 0);
