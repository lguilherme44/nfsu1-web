// The render check (web/src/app/rendercheck.ts) on a fake clock and a fake game: a phone at 75% that keeps its
// rate with GPU time to spare starts at 100% from its next game; one without the room stays; at 100% a phone that
// falls behind goes back to 75%.  Only driving at the game's own rate counts, after the warm-up.
//   node --test web/test/rendercheck.test.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const js = (await esbuild.build({ entryPoints: [path.join(ROOT, 'web/src/app/rendercheck.ts')], bundle: true, format: 'esm', write: false })).outputFiles[0].text;
const { RenderCheck, RENDER_CHECK_TIMES } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const KEY = 'nfsu2.device.render';
const SEC = 1000, MIN = 60 * SEC;

// the page: localStorage, a document that may be hidden; the game: its status block (counted every 250 ms) and
// the renderer's GPU times
function setup(render, stored = null) {
  mock.timers.enable({ apis: ['setInterval'] });
  const store = new Map(stored ? [[KEY, stored]] : []);
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  globalThis.document = { hidden: false };
  const g = { frames: 0, t: 5000, rate: 60, drive: 0, done: [], logs: [] };
  const s = {
    status: { read: () => new Map([['frames', g.frames], ['frames_t', g.t], ['rate', g.rate], ['drive', g.drive]]) },
    renderer: { doneMs: () => { const d = g.done; g.done = []; return d; } },
  };
  const check = new RenderCheck(s, render, RENDER_CHECK_TIMES, l => g.logs.push(l));
  // ms of play: fps frames a second, each taking gpu ms on the GPU
  const play = (ms, { fps = 60, gpu = 5, drive = 1, rate = 60 } = {}) => {
    g.drive = drive; g.rate = rate;
    for (let k = 0; k < ms; k += 250) {
      const n = fps / 4;
      g.frames += n; g.t += 250;
      for (let i = 0; i < n; i++) g.done.push(gpu);
      mock.timers.tick(250);
    }
  };
  return { g, check, play, store };
}
const done = (x) => { x.check.stop(); mock.timers.reset(); };

test('75%, the rate kept and GPU time to spare: 100% from the next game, decided after 3 min of driving', () => {
  const x = setup('scale:0.75');
  try {
    x.play(MIN, { gpu: 40, fps: 30 });                  // the warm-up: hitches and slow frames do not count
    x.play(2 * MIN - 5 * SEC, { gpu: 5 });
    assert.equal(x.check.state().verdict, null, 'not before 3 min of driving');
    assert.equal(x.store.get(KEY), undefined);
    x.play(10 * SEC, { gpu: 5 });
    assert.match(x.check.state().verdict, /^room to spare/);
    assert.equal(x.store.get(KEY), 'backing');
    assert.match(x.g.logs.at(-1), /render check after 3\.0 min of driving at 75%: \d+ frames of \d+ \(100%\), a frame 16\.7 ms, GPU p50 5\.0 \/ p90 5\.0 ms \(8\.9 ms at 100%\): room to spare/);
    x.play(MIN, { gpu: 50, fps: 20 });
    assert.equal(x.g.logs.length, 1, 'one verdict a game');
  } finally { done(x); }
});

test('75%, no room: GPU time that would not fit at 100%, or frames missed, keep it at 75%', () => {
  for (const [what, opt] of [['GPU 7 ms (12.4 ms at 100%, over 2/3 of 16.7)', { gpu: 7 }], ['54 of 60 fps', { gpu: 3, fps: 54 }]]) {
    const x = setup('scale:0.75');
    try {
      x.play(3 * MIN + 5 * SEC, opt);
      assert.match(x.check.state().verdict, /^no room to spare: it stays at 75%/, what);
      assert.equal(x.store.get(KEY), undefined, what);
    } finally { done(x); }
  }
});

test('only driving counts: the menus, a cutscene\'s 30 fps and a tab in the background do not', () => {
  const x = setup('scale:0.75');
  try {
    x.play(5 * MIN, { drive: 0, gpu: 2 });               // menus
    x.play(5 * MIN, { rate: 30, fps: 30, gpu: 2 });      // the race's start, a cutscene's rate
    globalThis.document.hidden = true;
    x.play(5 * MIN, { gpu: 2 });
    globalThis.document.hidden = false;
    assert.equal(x.check.state().drivingMs, 0);
    x.play(MIN + 10 * SEC, { gpu: 2 });
    assert.ok(Math.abs(x.check.state().drivingMs - (MIN + 9750)) <= 250, `${x.check.state().drivingMs}`);
    assert.equal(x.check.state().verdict, null);
  } finally { done(x); }
});

test('120 Hz: the budget is 8.3 ms a frame', () => {
  for (const [gpu, room] of [[3, true], [3.5, false]]) {
    const x = setup('scale:0.75');
    try {
      x.play(3 * MIN + 5 * SEC, { rate: 120, fps: 120, gpu });
      assert.equal(x.store.get(KEY) === 'backing', room, `GPU ${gpu} ms`);
    } finally { done(x); }
  }
});

test('100% (an earlier verdict): falling behind with the GPU over 2/3 of a frame goes back to 75%; keeping up stays', () => {
  const behind = setup('backing', 'backing');
  try {
    behind.play(3 * MIN + 5 * SEC, { fps: 50, gpu: 14 });
    assert.match(behind.check.state().verdict, /^behind: this phone starts at 75% again/);
    assert.equal(behind.store.get(KEY), undefined);
  } finally { done(behind); }
  for (const [what, opt, re] of [['keeps up', { fps: 60, gpu: 14 }, /^keeps up: it stays at 100%/],
                                 ['behind, not the GPU', { fps: 50, gpu: 6 }, /^behind, but not for the GPU: it stays at 100%/]]) {
    const x = setup('backing', 'backing');
    try {
      x.play(3 * MIN + 5 * SEC, opt);
      assert.match(x.check.state().verdict, re, what);
      assert.equal(x.store.get(KEY), 'backing', what);
    } finally { done(x); }
  }
});
