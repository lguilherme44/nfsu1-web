// LAN play's Winsock HLE in the browser, built for wasm:
//   node --test web/test/lan-wasm.test.mjs        (needs wasi-sdk in deps/)
// web/test/lan_unit.c: runtime/winsock.c (Windows semantics) over
// runtime/web/net_lan.c (the virtual-LAN backend), the test playing the page
// and the other browsers on the switch; plus SHA-256 (runtime/web/sha256.c,
// server.dll's pin) against the FIPS 180-4 vectors.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WASI = (fs.existsSync(path.join(REPO, 'deps')) ? fs.readdirSync(path.join(REPO, 'deps')) : []).filter(d => d.startsWith('wasi-sdk-')).map(d => path.join(REPO, 'deps', d)).pop();
const CC = WASI && path.join(WASI, 'bin/clang');
const OUT = path.join(REPO, 'out/web/test'); fs.mkdirSync(OUT, { recursive: true });
// web/build.sh's target, features and defines
const FLAGS = ['--target=wasm32-wasip1-threads', '-pthread', '-O2', '-msimd128', '-mbulk-memory', '-mnontrapping-fptoint',
  '-mtail-call', '-mexception-handling', '-mllvm', '-wasm-enable-sjlj', '-mllvm', '-wasm-use-legacy-eh=false',
  '-D_WASI_EMULATED_MMAN', '-D_WASI_EMULATED_SIGNAL', '-D_WASI_EMULATED_PROCESS_CLOCKS', '-fno-delete-null-pointer-checks',
  '-include', 'runtime/web/compat/wasm_plat.h', '-Iruntime/web/compat', '-Iruntime', '-Iruntime/web'];
const LINK = ['-Wl,--import-memory,--export-memory,--shared-memory,--initial-memory=67108864,--max-memory=268435456',
  '-Wl,-z,stack-size=1048576', '-lsetjmp', '-lwasi-emulated-mman', '-lwasi-emulated-signal', '-lwasi-emulated-process-clocks'];

test('lan_unit on wasm (winsock.c + net_lan.c)', { skip: !CC && 'no wasi-sdk in deps/' }, () => {
  const w = path.join(OUT, 'lan_unit.wasm');
  execFileSync(CC, [...FLAGS, '-o', w, 'web/test/lan_unit.c', 'runtime/winsock.c', 'runtime/web/net_lan.c', 'runtime/web/sha256.c',
    'runtime/mem.c', 'runtime/web/thread_exit.c', ...LINK], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = spawnSync(process.execPath, [path.join(REPO, 'web/test/wasi-run.mjs'), w], { encoding: 'utf8' });
  const out = run.stdout ?? '', err = run.stderr ?? '';
  if (run.status !== 0) console.log(err);
  console.log(out.trim().split('\n').filter(l => /FAIL|lan_unit:/.test(l)).join('\n'));
  const m = /lan_unit: (\d+) passed, (\d+) failed/.exec(out);
  assert.ok(m, 'lan_unit ran to the end');
  assert.equal(+m[2], 0, 'no failed check');
  assert.ok(+m[1] >= 80, 'every check ran');
  // the page closing its link at exit is logged as that, not as a lost switch
  const tail = err.slice(err.indexOf('lan_unit: the page closes the link'));
  assert.ok(err.includes('lan_unit: the page closes the link'), 'the test closed the link');
  assert.match(tail, /\[net\] virtual LAN closed/, 'a "closed" line');
  assert.doesNotMatch(tail, /reconnecting/, 'no "reconnecting" line');
  // the page letting the switch go when no network session wants it is logged as that too
  const idle = err.slice(err.indexOf('lan_unit: the page lets go'), err.indexOf('lan_unit: the page closes the link'));
  assert.match(idle, /\[net\] virtual LAN idle: no network session/, 'an "idle" line');
  assert.doesNotMatch(idle, /reconnecting/, 'no "reconnecting" line');
});
