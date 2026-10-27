// Guest memory type punning on WebAssembly:
//   node --test web/test/alias.test.mjs        (needs wasi-sdk in deps/)
// 1. web/tools/aliasguard.sh: every guest access macro of runtime/cpu.h's wasm
//    branches keeps its may_alias type, and the guard itself fails on a cpu.h
//    with MR16/MR64/MRF64 back to plain types (the glow review's experiment,
//    which tests/web/aliastest.c alone passed);
// 2. web/tools/aliastest.sh: the lifted-style vector normalize in V8.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hasWasi = fs.readdirSync(path.join(REPO, 'deps')).some(d => d.startsWith('wasi-sdk-'));
const sh = (script, env = {}) => spawnSync('bash', [path.join(REPO, script)], { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env } });

test('aliasguard: the guest access macros keep their may_alias types', { skip: !hasWasi && 'no wasi-sdk in deps/' }, () => {
  const r = sh('web/tools/aliasguard.sh');
  console.log(r.stdout.trim());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // a cpu.h whose 16- and 64-bit accesses lost the type: the guard refuses it
  const dir = fs.mkdtempSync(path.join(REPO, 'out/web/aliasguard-'));
  try {
    const h = fs.readFileSync(path.join(REPO, 'runtime/cpu.h'), 'utf8')
      .replace(/\(gm_u16 +\*\)/g, '(uint16_t *)').replace(/\(gm_u64 +\*\)/g, '(uint64_t *)').replace(/\(gm_f64 +\*\)/g, '(double *)');
    fs.writeFileSync(path.join(dir, 'cpu.h'), h);
    const bad = sh('web/tools/aliasguard.sh', { CPU_H: dir });
    console.log(bad.stdout.trim().split('\n').slice(0, 3).join('\n'));
    assert.notEqual(bad.status, 0, 'the guard fails on plain-typed MR16/MR64/MRF64');
    assert.match(bad.stdout, /MR16 does not access guest memory as gm_u16/);
    assert.match(bad.stdout, /MRF64 \(-DNFSU2_MEMCHECK\) does not access guest memory as gm_f64/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('aliastest: an f32 store then an i32 load of the same guest address stay in order', { skip: !hasWasi && 'no wasi-sdk in deps/' }, () => {
  const r = sh('web/tools/aliastest.sh');
  console.log(r.stdout.trim().split('\n').slice(-2).join('\n'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /alias test: passed/);
});
