// The saves panel's restore limits (web/src/app/saves-ui.ts readBackup) on a
// backup bigger than the restore budget: 24 F12 screenshots at this Mac's
// native size (3024x1964 TGA, 23.8 MB each, 570 MB in all) listed before the
// profile, registry.txt and settings.ini (phase-1 app review, finding 5).
//   node --test web/test/restore-limit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = `export { readBackup, isScreenshot } from './web/src/app/saves-ui.ts'; export { zip, unzip } from './web/src/app/zip.ts';
`;
const js = (await esbuild.build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral' })).outputFiles[0].text;
const { readBackup, isScreenshot, zip } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const SHOT = 18 + 3024 * 1964 * 4;                       // a 32-bit TGA at 3024x1964
const enc = new TextEncoder();
/** a profile's files the game would load (ug1save.ts badFile: version 0x13, the name inside the .opt), all else zero */
const versioned = (n, name) => { const f = new Uint8Array(n); new DataView(f.buffer).setUint32(0, 0x13, true); if (name) f.set(enc.encode(name), 8); return f; };
const profile = name => [{ name: `NFS Underground/${name}.opt`, data: versioned(749, name) },
  { name: `NFS Underground/${name}_autosave.ugd`, data: versioned(63123) }];
function backup(nShots) {
  const e = [];
  const shot = new Uint8Array(SHOT); shot[2] = 2;
  for (let i = 0; i < nShots; i++) e.push({ name: `nfsu2${String(i).padStart(3, '0')}.tga`, data: shot });
  e.push(...profile('ROTEST'));
  e.push({ name: 'registry.txt', data: enc.encode('NotFirstTime=1\n') });
  e.push({ name: 'settings.ini', data: enc.encode('# NFSU2 settings\nmovies = off\n') });
  return zip(e);
}

test('screenshots never crowd out the profile, registry.txt or settings.ini', async () => {
  const z = backup(24);
  assert.ok(z.length > 512 * 1048576, `backup ${z.length} bytes`);
  const r = await readBackup(z);
  const paths = r.entries.map(e => e.path);
  for (const p of ['NFS Underground/ROTEST.opt', 'NFS Underground/ROTEST_autosave.ugd', 'registry.txt', 'settings.ini']) assert.ok(paths.includes(p), `${p} kept`);
  assert.deepEqual(r.profiles, ['ROTEST']);
  const shots = paths.filter(isScreenshot);
  assert.equal(shots.length, 22, 'the first 512 MiB of screenshots');
  assert.deepEqual(r.skipped, ['nfsu2022.tga', 'nfsu2023.tga']);
  console.log(`backup ${(z.length / 1048576).toFixed(0)} MB, ${r.entries.length} entries kept, skipped ${r.skipped.join(', ')}`);
});

test('a backup within the budget restores whole', async () => {
  const r = await readBackup(backup(3));
  // 3 screenshots, the profile's .opt and .ugd, registry.txt, settings.ini and the Profiles.usr made for them
  assert.equal(r.entries.length, 8);
  assert.ok(r.entries.some(e => e.path === 'NFS Underground/Profiles.usr'));
  assert.deepEqual(r.skipped, []);
});
