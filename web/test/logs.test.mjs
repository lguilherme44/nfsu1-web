// The app's log (web/src/app/logs.ts): a full log keeps its opening lines and the session lines, and repeats
// (a line, or a short group like the force-feedback errors players' logs were full of) fold into a count.
//   node --test web/test/logs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const js = (await esbuild.build({ entryPoints: [path.join(ROOT, 'web/src/app/logs.ts')], bundle: true, format: 'esm', write: false })).outputFiles[0].text;
const { LogRing } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const lines = log => log.text().trimEnd().split('\n');

test('a log under its budget is every line, as added', () => {
  const log = new LogRing(1 << 20, false);
  for (let i = 0; i < 1000; i++) log.add(`line ${i}`);
  assert.deepEqual(lines(log), Array.from({ length: 1000 }, (_, i) => `line ${i}`));
});

test('a full log keeps its opening lines and the kept ones, and says where lines were dropped', () => {
  const log = new LogRing(2000, false, 3);
  log.add('[app] game module abc'); log.add('[app] display refresh 60'); log.add('=== NFSU2 web, game abc ===');
  for (let i = 0; i < 500; i++) log.add(`game ${i}`);
  log.keep('=== NFSU2 web, the second game ===');
  for (let i = 0; i < 500; i++) log.add(`again ${i}`);
  const t = lines(log);
  assert.deepEqual(t.slice(0, 3), ['[app] game module abc', '[app] display refresh 60', '=== NFSU2 web, game abc ===']);
  assert.match(t[3], /^\[\.\.\. 500 lines dropped: the log keeps its opening lines and the last 0 MB\]$/);
  assert.equal(t[4], '=== NFSU2 web, the second game ===');
  assert.match(t[5], /^\[\.\.\. \d+ lines dropped/);
  assert.equal(t.at(-1), 'again 499');
  assert.ok(log.size < 2000 + 200, `size ${log.size}`);
  // what is left of the droppable lines is the newest, in order
  const rest = t.slice(6).map(l => +l.split(' ')[1]);
  assert.deepEqual(rest, Array.from({ length: rest.length }, (_, i) => 500 - rest.length + i));
});

test('a line repeated back to back is kept once, with a count', () => {
  const log = new LogRing(1 << 20, false, 0);
  log.add('before');
  for (let i = 0; i < 1000; i++) log.add('[4!] [dbg] ERROR: something');
  log.add('after');
  assert.deepEqual(lines(log), ['before', '[4!] [dbg] ERROR: something', '[log] the line above repeated 999 more times', 'after']);
});

test('two copies stay as they are', () => {
  const log = new LogRing(1 << 20, false, 0);
  for (const l of ['a', 'x', 'x', 'b', 'y', 'z', 'y', 'z', 'c']) log.add(l);
  assert.deepEqual(lines(log), ['a', 'x', 'x', 'b', 'y', 'z', 'y', 'z', 'c']);
});

test('the force-feedback errors (a four-line group) fold, and a group cut short keeps its lines', () => {
  const log = new LogRing(1 << 20, false, 0);
  const g = ['[4!] [dbg] ', '[4!] [dbg] ERROR: Failed to create periodic effect on channel 0',
    '[4!] [dbg] ', '[4!] [dbg] ERROR: Trying to start force effect on channel 0 but we have an invalid effectid'];
  for (let i = 0; i < 2000; i++) log.add(g[i % 4]);
  log.add(g[0]); log.add(g[1]);
  log.add('[4!]   [matrix] good=1 bad=0 zero=0');
  for (let i = 0; i < 40; i++) log.add(g[i % 4]);
  assert.deepEqual(lines(log), [...g, '[log] the 4 lines above repeated 499 more times', g[0], g[1],
    '[4!]   [matrix] good=1 bad=0 zero=0', ...g, '[log] the 4 lines above repeated 9 more times (so far)']);
});

test('the opening lines are not folded away, and a kept line ends a fold', () => {
  const log = new LogRing(1 << 20, false, 2);
  for (let i = 0; i < 6; i++) log.add('same');
  log.keep('=== session ===');
  for (let i = 0; i < 3; i++) log.add('same');
  assert.deepEqual(lines(log), ['same', 'same', 'same', '[log] the line above repeated 3 more times', '=== session ===',
    'same', '[log] the line above repeated 2 more times (so far)']);
});

test('tail is the end of the text, kept lines in their place (the test tools read it)', () => {
  const log = new LogRing(1 << 20, false, 3);
  for (let i = 0; i < 10; i++) log.add(`a ${i}`);
  log.keep('=== kept ===');
  for (let i = 0; i < 5; i++) log.add('same');
  log.add('b'); log.keep('=== kept 2 ==='); log.add('c');
  for (let i = 0; i < 4; i++) log.add('again');
  const t = lines(log);
  for (const n of [1, 2, 3, 5, 8, 12, 15, t.length, t.length + 5]) assert.deepEqual(log.tail(n), t.slice(-n), `tail(${n})`);
  log.clear();
  assert.deepEqual(log.tail(10), []);
  log.add('fresh');
  assert.deepEqual(lines(log), ['fresh']);
});

test('spam in a full log no longer pushes out the history', () => {
  const log = new LogRing(64 << 10, false, 2);
  log.add('[app] game module abc'); log.add('=== NFSU2 web ===');
  for (let i = 0; i < 100; i++) log.add(`history ${i}`);
  for (let i = 0; i < 200000; i++) log.add(i % 2 ? '[dbg] ERROR' : '[dbg] ');
  log.add('TRAP in thread 4');
  const t = lines(log);
  assert.equal(t.length, 2 + 100 + 2 + 1 + 1);
  assert.equal(t[2], 'history 0');
  assert.equal(t.at(-2), '[log] the 2 lines above repeated 99999 more times');
});
