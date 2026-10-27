// NFS Underground's save folder in the page (web/src/app/ug1save.ts; saves-ui.ts readBackup, addProfiles;
// vault.ts profilesIn; savefs.ts listProfiles's grouping):
//   node --test web/test/ug1save.test.mjs
// - Profiles.usr as SPEED.EXE 1.4 writes it (36 bytes for one profile: the slot after the name's NUL is
//   stack garbage) reads as its names; the page's own index reads back the same
// - a profile is its .opt with the .cfg and <NAME>_<slot>.ugd beside it, a name with a "_" too
// - a backup restores whole files; a profile with a file of another version is refused with all of its
//   files; Profiles.usr is made again (the game lists only the profiles in it)
// - the PC game's folder zipped in any shape adds its profiles; adding replaces a profile of the same
//   name (in any case) and keeps every other one in the index
// The .opt/.ugd here are synthetic: version 0x13, the name, zeros.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = `export * as U from './web/src/app/ug1save.ts'; export { readBackup, addProfiles } from './web/src/app/saves-ui.ts';
  export { profilesIn } from './web/src/app/vault.ts'; export { zip } from './web/src/app/zip.ts';`;
const js = (await esbuild.build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral' })).outputFiles[0].text;
const { U, readBackup, addProfiles, profilesIn, zip } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const D = 'NFS Underground';
const enc = new TextEncoder();
// the index the game wrote for LELLIS (2026-10-24): count 1, "LELLIS", then what was on its stack
const GAME_INDEX = Uint8Array.from(Buffer.from('010000004c454c4c495300000c000000b09f5608a89c5608c895560801000000' + '04000000', 'hex'));
const opt = (name, version = 0x13) => { const d = new Uint8Array(749); new DataView(d.buffer).setUint32(0, version, true); d.set(enc.encode(name), 8); return d; };
const ugd = (version = 0x13) => { const d = new Uint8Array(63123); new DataView(d.buffer).setUint32(0, version, true); d.set(enc.encode('auto'), 4); return d; };
const cfg = () => enc.encode('BPP: 32\r\nRES: 0\r\n');
const profile = (name, dir = D) => [
  { name: `${dir}/${name}.opt`, data: opt(name) }, { name: `${dir}/${name}.cfg`, data: cfg() }, { name: `${dir}/${name}_autosave.ugd`, data: ugd() }];

/** a save folder in memory, with the file functions saves-ui.ts takes */
function folder(entries) {
  const m = new Map(entries.map(e => [e.path ?? e.name, e.data]));
  return { m,
    listFiles: async () => [...m.keys()].sort().map(p => ({ path: p })),
    readBytes: async p => { if (!m.has(p)) throw new Error(`no ${p}`); return m.get(p); },
    readText: async p => m.has(p) ? new TextDecoder().decode(m.get(p)) : null,
    writeFile: async (p, d) => { m.set(p, typeof d === 'string' ? enc.encode(d) : d); },
    remove: async p => { for (const k of [...m.keys()]) if (k === p || k.startsWith(p + '/')) m.delete(k); } };
}

test("the game's own Profiles.usr reads as its names, and the page's reads back the same", () => {
  assert.deepEqual(U.readIndex(GAME_INDEX), ['LELLIS']);
  const mine = U.makeIndex(['LELLIS', 'ANA']);
  assert.equal(mine.length, 4 + 2 * 32);
  assert.deepEqual(U.readIndex(mine), ['LELLIS', 'ANA']);
  assert.deepEqual([...mine.subarray(4 + 7, 4 + 32)], new Array(25).fill(0));        // no garbage after the NUL
  assert.equal(U.readIndex(GAME_INDEX.subarray(0, 35)), null);                       // not 4 + 32n
  assert.equal(U.readIndex(U.makeIndex([])).length, 0);
});

test("a profile is its .opt with the .cfg and saves beside it, whatever the name's case or '_'", () => {
  assert.deepEqual(U.ug1File(`${D}/LELLIS.opt`), { name: 'LELLIS', kind: 'opt' });
  assert.deepEqual(U.ug1File(`${D}/LELLIS_autosave.ugd`), { name: 'LELLIS', kind: 'save' });
  assert.deepEqual(U.ug1File(`${D}/MY_CAR_slot1.ugd`, ['MY_CAR']), { name: 'MY_CAR', kind: 'save' });
  assert.equal(U.ug1File(`${D}/Profiles.usr`), null);
  assert.equal(U.ug1File(`${D}/sub/LELLIS.opt`), null);
  assert.equal(U.ug1File('registry.txt'), null);
  const ps = U.ug1Profiles([`${D}/LELLIS.opt`, `${D}/lellis.cfg`, `${D}/LELLIS_autosave.ugd`, `${D}/MY_CAR.opt`, `${D}/MY_CAR_x.ugd`, `${D}/ORPHAN_autosave.ugd`]);
  assert.deepEqual(ps.map(p => [p.name, p.files.length]), [['LELLIS', 3], ['MY_CAR', 2]]);
  assert.equal(U.badFile('opt', 'LELLIS', opt('OTHER')), 'LELLIS.opt holds the profile "OTHER"');
  assert.match(U.badFile('save', 'LELLIS', ugd(0x10)), /not one of this version/);
  assert.equal(U.badFile('opt', 'lellis', opt('LELLIS')), null);
});

test('a backup restores whole files, refuses a profile of another version, and makes Profiles.usr again', async () => {
  const bad = profile('OLD'); bad[2] = { name: `${D}/OLD_autosave.ugd`, data: ugd(0x10) };
  const buf = zip([...profile('LELLIS'), ...profile('ANA'), ...bad,
    { name: `${D}/Profiles.usr`, data: U.makeIndex(['ANA', 'OLD', 'GONE']) }, { name: 'registry.txt', data: enc.encode('x') }]);
  const r = await readBackup(buf);
  assert.equal(r.kind, 'backup');
  assert.deepEqual(r.profiles.sort(), ['ANA', 'LELLIS']);
  assert.deepEqual(r.refused.map(x => x.name), ['OLD']);
  assert.ok(!r.entries.some(e => e.path.startsWith(`${D}/OLD`)));
  // its own order first (ANA), then the profiles it did not list (LELLIS); OLD (refused) and GONE (no files) leave it
  assert.deepEqual(U.readIndex(r.entries.find(e => e.path === `${D}/Profiles.usr`).data), ['ANA', 'LELLIS']);
  assert.ok(r.entries.some(e => e.path === 'registry.txt'));
});

test("a backup without Profiles.usr gets one, or the game would list none of its profiles", async () => {
  const r = await readBackup(zip([...profile('LELLIS'), { name: 'settings.ini', data: enc.encode('') }]));
  assert.deepEqual(U.readIndex(r.entries.find(e => e.path === `${D}/Profiles.usr`).data), ['LELLIS']);
});

test("the PC game's folder, zipped in any shape, adds its profiles; adding keeps the others in the index", async () => {
  const pc = zip([...profile('ANA', 'Documents/NFS Underground'), { name: 'Documents/NFS Underground/Profiles.usr', data: U.makeIndex(['ANA']) },
    { name: 'Documents/NFS Underground/readme.txt', data: enc.encode('hi') }]);
  const r = await readBackup(pc, 'pc.zip');
  assert.equal(r.kind, 'profiles');
  assert.deepEqual(r.profiles, ['ANA']);
  assert.deepEqual(r.entries.map(e => e.path).sort(), [`${D}/ANA.cfg`, `${D}/ANA.opt`, `${D}/ANA_autosave.ugd`]);
  // here: LELLIS, and an older "ana" with a save slot the new one does not have
  const fs = folder([...profile('LELLIS'), { path: `${D}/ana.opt`, data: opt('ana') }, { path: `${D}/ana_slot2.ugd`, data: ugd() },
    { path: `${D}/Profiles.usr`, data: GAME_INDEX }]);
  fs.m.set(`${D}/Profiles.usr`, U.makeIndex(['LELLIS', 'ana']));
  await addProfiles(fs, r);
  assert.deepEqual(U.readIndex(fs.m.get(`${D}/Profiles.usr`)), ['LELLIS', 'ANA']);
  assert.ok(!fs.m.has(`${D}/ana_slot2.ugd`), "the replaced profile's other files go");
  assert.ok(fs.m.has(`${D}/LELLIS_autosave.ugd`) && fs.m.has(`${D}/ANA_autosave.ugd`));
  assert.ok(!fs.m.has(`${D}/readme.txt`));
});

test("adding to a folder with the game's own index (garbage after the names) keeps its profiles", async () => {
  const fs = folder([...profile('LELLIS'), { path: `${D}/Profiles.usr`, data: GAME_INDEX }]);
  await addProfiles(fs, await readBackup(zip(profile('ANA', 'x')), 'x.zip'));
  assert.deepEqual(U.readIndex(fs.m.get(`${D}/Profiles.usr`)), ['LELLIS', 'ANA']);
});

test('the keyphrase saves name their profiles by the .opt files', () => {
  const files = [...profile('LELLIS'), { name: `${D}/Profiles.usr`, data: GAME_INDEX }].map(e => ({ path: e.name, data: e.data }));
  assert.deepEqual(profilesIn(files), ['LELLIS']);
});
