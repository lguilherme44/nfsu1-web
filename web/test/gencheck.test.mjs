// Stale lifted C (the perf review): gen.sh stamps gen/all and gen/server
// (tools/genstamp.sh), web/build.sh refuses a gen made from another override
// list, hook list or lifter (web/tools/gencheck.sh), and web/gen.sh lifts
// only the SPEED.EXE those lists were made for.
//   node --test web/test/gencheck.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(REPO, 'out/web/test'); fs.mkdirSync(OUT, { recursive: true });
const sources = execFileSync('bash', [path.join(REPO, 'tools/genstamp.sh'), 'sources'], { encoding: 'utf8' }).trim();
const orig = execFileSync('bash', [path.join(REPO, 'tools/genstamp.sh'), 'overrides'], { encoding: 'utf8' }).trim().split(',').filter(Boolean);
const STAMP = `# gen.sh 2026-10-18T00:00:00Z: what gen/all and gen/server were lifted from\n${sources}\nexe 0 server.dll 0\noptions X87PC=1 X87OPT=1 FLAGABI=0\n`;

/** a fake gen dir: decls.h with the runtime's _orig declarations, and the given stamps */
function gen(name, { all = STAMP, server = all, decls = orig } = {}) {
  const g = path.join(OUT, `gencheck-${name}`);
  fs.rmSync(g, { recursive: true, force: true });
  for (const d of ['all', 'server']) fs.mkdirSync(path.join(g, d), { recursive: true });
  fs.writeFileSync(path.join(g, 'all/decls.h'), decls.map(a => `void sub_00${a}_orig(CPU*);\n`).join(''));
  if (all !== null) fs.writeFileSync(path.join(g, 'all/stamp.txt'), all);
  if (server !== null) fs.writeFileSync(path.join(g, 'server/stamp.txt'), server);
  return g;
}
const check = (g, env = {}) => spawnSync('bash', [path.join(REPO, 'web/tools/gencheck.sh')], { cwd: REPO, encoding: 'utf8', env: { ...process.env, GEN: g, ...env } });

test('gencheck: a gen stamped from this checkout passes', () => {
  const r = check(gen('ok'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
});

test('gencheck: another hook list, override list or lifter is refused, and says which', () => {
  for (const [k, what] of [['hooks', /hook list/], ['overrides', /override list/], ['lifter', /lifter \(tools\/lift\.py/]]) {
    const stale = STAMP.replace(new RegExp(`^${k} \\S+`, 'm'), `${k} 0000000000000000`);
    const r = check(gen(`stale-${k}`, { all: stale }));
    assert.equal(r.status, 1, `${k}: ${r.stdout}`);
    assert.match(r.stdout, /is stale/);
    assert.match(r.stdout, what);
    const ok = check(gen(`stale-ok-${k}`, { all: stale }), { GEN_STALE_OK: '1' });
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /building anyway/);
  }
});

test('gencheck: an unfinished lift, a gen/server from another run, missing _orig declarations are refused', () => {
  let r = check(gen('incomplete', { all: 'incomplete: gen.sh has not finished (or failed)\n', server: null }));
  assert.equal(r.status, 1); assert.match(r.stdout, /not a finished lift/);
  r = check(gen('server', { server: STAMP.replace('2026-10-18T00:00:00Z', '2026-10-17T00:00:00Z') }));
  assert.equal(r.status, 1); assert.match(r.stdout, /server is not from the gen\.sh run/);
  r = check(gen('server-missing', { server: null }));
  assert.equal(r.status, 1); assert.match(r.stdout, /differs or is missing/);
  r = check(gen('decls', { decls: orig.slice(1) }));
  assert.equal(r.status, 1); assert.match(r.stdout, /older than the runtime/);
});

test('gencheck: a gen without a stamp (made before stamps) gets a note only', () => {
  const r = check(gen('nostamp', { all: null, server: null }));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /has no stamp/);
});

test('web/gen.sh refuses an executable that is not SPEED.EXE 1.4, before it touches gen/', { skip: !fs.existsSync(path.join(REPO, '.venv/bin/python')) && 'no .venv' }, () => {
  // a PE header whose timestamp is not 0x40072965: every override and hook address would be another function
  const exe = path.join(OUT, 'gencheck-notspeed.exe');
  const b = Buffer.alloc(0x100); b.writeUInt32LE(0x80, 0x3c); b.write('PE\0\0', 0x80, 'latin1'); b.writeUInt32LE(0x12345678, 0x88);
  fs.writeFileSync(exe, b);
  const stamp = path.join(REPO, 'gen/all/stamp.txt');
  const before = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : null;
  const r = spawnSync('bash', [path.join(REPO, 'web/gen.sh'), exe], { cwd: REPO, encoding: 'utf8', env: { ...process.env, NFSU1_ANY_EXE: '' } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /is not SPEED\.EXE 1\.4 \(PE timestamp 0x12345678, want 0x40072965\)/);
  assert.equal(fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : null, before, 'gen/all/stamp.txt is untouched');
});
