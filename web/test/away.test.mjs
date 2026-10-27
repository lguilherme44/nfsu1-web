// The app's away check (web/src/app/away.ts) on a fake clock: no input for a while gets a warning and then the
// place on the server goes back; a tab in the background gives it back without one; input brings it back.
//   node --test web/test/away.test.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const js = (await esbuild.build({ entryPoints: [path.join(ROOT, 'web/src/app/away.ts')], bundle: true, format: 'esm', write: false })).outputFiles[0].text;
const { AwayCheck } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const L = { inputMs: 20 * 60_000, hiddenMs: 10 * 60_000, warnMs: 60_000 };
const MIN = 60_000;

// the page: a clock, a document that may be hidden, the game's input and network as the app sees them
function setup({ holding = true, input = true } = {}) {
  mock.timers.enable({ apis: ['setInterval'] });
  let t = 1000;
  Object.defineProperty(globalThis, 'performance', { value: { now: () => t }, configurable: true });
  const vis = new Set();
  globalThis.document = { hidden: false, addEventListener: (k, f) => vis.add(f), removeEventListener: (k, f) => vis.delete(f) };
  const g = { last: t, holding, calls: [], shown: [], logs: [] };
  const s = {
    input: { lastInput: () => (input ? g.last : null) },
    net: { holding: () => g.holding, away: on => { g.calls.push(on); g.holding = !on && g.holding; } },
  };
  const check = new AwayCheck(s, L, text => g.shown.push(text), l => g.logs.push(l));
  const tick = ms => { for (let k = 0; k < ms; k += 1000) { t += 1000; mock.timers.tick(1000); } };
  const use = () => { g.last = t; };
  const hide = on => { globalThis.document.hidden = on; for (const f of vis) f(); };
  return { g, check, tick, use, hide, now: () => t };
}
const done = (x) => { x.check.stop(); mock.timers.reset(); };

test('no input for 20 min: a warning that counts down 60 s, then the place goes back; input brings it back', () => {
  const x = setup();
  try {
    x.tick(20 * MIN - 1000);
    assert.deepEqual(x.g.shown, [], 'nothing before 20 min');
    x.tick(1000);
    assert.match(x.g.shown.at(-1), /^Still there\? In 60 s you stop playing with others/);
    x.tick(30_000);
    assert.match(x.g.shown.at(-1), /In 30 s/);
    assert.deepEqual(x.g.calls, []);
    x.tick(30_000);
    assert.deepEqual(x.g.calls, [true], 'the place went back');
    assert.match(x.g.shown.at(-1), /^You were away/);
    x.tick(10 * MIN);
    assert.deepEqual(x.g.calls, [true], 'once');
    x.use(); x.tick(1000);
    assert.deepEqual(x.g.calls, [true, false], 'back');
    assert.equal(x.g.shown.at(-1), null, 'the message is gone');
    assert.ok(x.g.logs.some(l => /no input for 21 min/.test(l)));
  } finally { done(x); }
});

test('input during the warning: it goes and the place stays', () => {
  const x = setup();
  try {
    x.tick(20 * MIN + 10_000);
    assert.match(x.g.shown.at(-1), /^Still there\?/);
    x.use(); x.tick(1000);
    assert.equal(x.g.shown.at(-1), null);
    x.tick(5 * MIN);
    assert.deepEqual(x.g.calls, []);
    x.tick(15 * MIN);                        // 20 min after that input: the warning again
    assert.match(x.g.shown.at(-1), /^Still there\?/);
  } finally { done(x); }
});

test('a tab in the background for 10 min: the place goes back at once, no warning first', () => {
  const x = setup();
  try {
    x.tick(5 * MIN); x.use();
    x.hide(true);
    x.tick(10 * MIN - 1000);
    assert.deepEqual(x.g.calls, []);
    x.tick(1000);
    assert.deepEqual(x.g.calls, [true]);
    assert.ok(!x.g.shown.some(s => s && /Still there/.test(s)), 'no warning');
    assert.match(x.g.shown.at(-1), /^You were away/, 'the message for when they come back');
    x.hide(false); x.tick(5000);
    assert.deepEqual(x.g.calls, [true], 'seeing the tab again is not input');
    x.use(); x.tick(1000);
    assert.deepEqual(x.g.calls, [true, false]);
  } finally { done(x); }
});

test('a tab in the background for a while and back: the 10 min start again', () => {
  const x = setup();
  try {
    x.hide(true); x.tick(8 * MIN); x.hide(false); x.use(); x.tick(1000);
    x.hide(true); x.tick(8 * MIN);
    assert.deepEqual(x.g.calls, []);
  } finally { done(x); }
});

test('nothing while the game holds no place, or the page cannot see the input', () => {
  for (const o of [{ holding: false }, { input: false }]) {
    const x = setup(o);
    try {
      x.tick(30 * MIN); x.hide(true); x.tick(15 * MIN);
      assert.deepEqual(x.g.calls, [], JSON.stringify(o));
      assert.deepEqual(x.g.shown.filter(s => s !== null), []);
    } finally { done(x); }
  }
});

test('the place given up some other way during the warning (the game left free roam): the warning goes', () => {
  const x = setup();
  try {
    x.tick(20 * MIN + 5000);
    assert.match(x.g.shown.at(-1), /^Still there\?/);
    x.g.holding = false; x.tick(1000);
    assert.equal(x.g.shown.at(-1), null);
    x.tick(5 * MIN);
    assert.deepEqual(x.g.calls, []);
  } finally { done(x); }
});
