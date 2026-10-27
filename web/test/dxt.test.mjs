// The DXT unpacking of GPUs without texture-compression-bc (web/src/gpu/dxt.ts):
//   node --test web/test/dxt.test.mjs
// Hand-computed blocks for each mode: DXT1 with four colours (c0 > c1) and with
// three plus transparent black (c0 <= c1); DXT3's explicit alphas and its
// colour block, four colours whatever the order; DXT5's 8-level and 6-level
// alpha ramps; the 5/6-bit to 8-bit expansion; and the layout: edge blocks of a
// 6x6 level, a row pitch wider than the blocks, a 1x1 level, an offset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = `export { unpackDxt } from './web/src/gpu/dxt.ts';`;
const js = (await esbuild.build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral' })).outputFiles[0].text;
const { unpackDxt } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const DXT1 = 0x31545844, DXT3 = 0x33545844, DXT5 = 0x35545844;
const hex = s => Uint8Array.from(s.split(/\s+/).filter(Boolean).map(x => parseInt(x, 16)));
/** the unpacked BGRA texels as [r, g, b, a] */
const rgba = out => Array.from({ length: out.length / 4 }, (_, i) => [out[4 * i + 2], out[4 * i + 1], out[4 * i], out[4 * i + 3]]);
const block = (fmt, bytes) => rgba(unpackDxt(fmt, hex(bytes), 0, fmt === DXT1 ? 8 : 16, 4, 4));
const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255];

test('DXT1, c0 > c1: four colours, the two between at thirds', () => {
  // c0 = F800 (red), c1 = 001F (blue); first row codes 0 1 2 3, the rest 0
  const t = block(DXT1, '00 F8 1F 00 E4 00 00 00');
  assert.deepEqual(t.slice(0, 4), [RED, BLUE, [170, 0, 85, 255], [85, 0, 170, 255]]);
  assert.deepEqual(t.slice(4), Array(12).fill(RED));
});

test('DXT1, c0 <= c1: three colours and transparent black', () => {
  const t = block(DXT1, '1F 00 00 F8 E4 00 00 00');
  assert.deepEqual(t.slice(0, 4), [BLUE, RED, [127, 0, 127, 255], [0, 0, 0, 0]]);
});

test('DXT1: 5 and 6-bit channels widen to 8 bits by repeating their top bits', () => {
  // 8410: r 16 -> 132, g 32 -> 130, b 16 -> 132; FFFF -> white
  assert.deepEqual(block(DXT1, '10 84 00 00 00 00 00 00')[0], [132, 130, 132, 255]);
  assert.deepEqual(block(DXT1, 'FF FF 00 00 00 00 00 00')[0], [255, 255, 255, 255]);
});

test('DXT3: 4-bit alphas, and four colours even when c0 <= c1', () => {
  // alphas F 0 7 8 (x17), then the colour block of the three-colour DXT1 case above
  const t = block(DXT3, '0F 87 00 00 00 00 00 00  1F 00 00 F8 E4 00 00 00');
  assert.deepEqual(t.slice(0, 4), [[0, 0, 255, 255], [255, 0, 0, 0], [85, 0, 170, 119], [170, 0, 85, 136]]);
  assert.deepEqual(t[4], [0, 0, 255, 0]);
});

test('DXT5: a0 > a1 gives 8 alpha levels, a0 <= a1 gives 6 plus 0 and 255', () => {
  // codes 0..7 for texels 0..7 (88 C6 FA), code 0 for the rest; a white colour block
  const a8 = block(DXT5, 'FF 00 88 C6 FA 00 00 00  FF FF 00 00 00 00 00 00').map(c => c[3]);
  assert.deepEqual(a8, [255, 0, 218, 182, 145, 109, 72, 36, ...Array(8).fill(255)]);
  const a6 = block(DXT5, '00 FF 88 C6 FA 00 00 00  FF FF 00 00 00 00 00 00').map(c => c[3]);
  assert.deepEqual(a6, [0, 255, 51, 102, 153, 204, 0, 255, ...Array(8).fill(0)]);
  assert.deepEqual(block(DXT5, 'FF 00 00 00 00 00 00 00  FF FF 00 00 00 00 00 00')[0], [255, 255, 255, 255]);
});

test('layout: edge blocks, a pitch wider than the blocks, a 1x1 level, an offset', () => {
  // a 6x6 DXT1 level: 2x2 solid blocks red, green / blue, grey, rows of blocks 24 bytes apart, 5 bytes in
  const solid = c => [c & 255, c >> 8, 0, 0, 0, 0, 0, 0];
  const src = new Uint8Array(5 + 24 * 2);
  src.set([...solid(0xF800), ...solid(0x07E0)], 5);
  src.set([...solid(0x001F), ...solid(0x8410)], 5 + 24);
  const t = rgba(unpackDxt(DXT1, src, 5, 24, 6, 6));
  assert.equal(t.length, 36);
  const want = (x, y) => y < 4 ? (x < 4 ? RED : [0, 255, 0, 255]) : (x < 4 ? BLUE : [132, 130, 132, 255]);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) assert.deepEqual(t[y * 6 + x], want(x, y), `texel ${x},${y}`);
  assert.deepEqual(rgba(unpackDxt(DXT1, src, 5 + 24, 8, 1, 1)), [BLUE]);
});
