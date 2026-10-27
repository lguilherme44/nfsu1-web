// The server's game module against a made-up build, so it runs anywhere:
//   node --test web/test/module.test.mjs
// /game.json names the module (its hash), and no cache keeps it; /game.wasm?v=<that hash> may be kept for good by
// every cache, Cloudflare's too; the bare address, an answer as it is (no br, a byte range) is revalidated and
// never kept by a shared cache; another hash (a new build since /game.json) is refused with 409, so a copy of one
// build is never kept under another's address.
// Port: NFSU2_TEST_MODULE_PORT (8533).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { serverCommand } from '../tools/server-cmd.mjs';

const PORT = +(process.env.NFSU2_TEST_MODULE_PORT || 8533);
const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'nfsu2-module-test-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const DATA = path.join(TMP, 'game'), WASM = path.join(TMP, 'game.wasm');
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'SPEED.EXE'), 'MZ');
const INFO = { pages: 16384, maxPages: 65536, guestEnd: 671088640, rev: 'abc1234', size: 0, opt: 'O2' };
/** a build: a module (bytes that compress, as code does) and its game.json */
function build(seed) {
  const b = crypto.createHash('sha256').update(seed).digest();
  const mod = Buffer.alloc(3 << 20);
  for (let i = 0; i < mod.length; i++) mod[i] = b[(i * 7) % 32] & 0x0f;
  fs.writeFileSync(WASM, mod);
  fs.writeFileSync(path.join(TMP, 'game.json'), JSON.stringify({ ...INFO, rev: seed, size: mod.length }) + '\n');
  return { mod, hash: crypto.createHash('sha256').update(mod).digest('base64url').slice(0, 22) };
}

async function server() {
  const srv = spawn(...serverCommand(['--data', DATA, '--http-port', String(PORT), '--state', path.join(TMP, 'state'), '--wasm', WASM]),
    { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    let out = '';
    const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
    srv.stdout.on('data', d => { out += d; if (out.includes('  access    :')) { clearTimeout(t); res(); } });
    srv.on('exit', c => { clearTimeout(t); rej(new Error('server exited ' + c + ' ' + out)); });
  });
  return { stop: async () => { const gone = srv.exitCode !== null ? null : new Promise(r => srv.once('exit', r)); srv.kill(); await gone; } };
}
/** an answer and its body, decoded */
function get(p, { ae = 'gzip, deflate, br, zstd', method = 'GET', headers = {} } = {}) {
  return new Promise((res, rej) => {
    const q = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { host: `localhost:${PORT}`, 'accept-encoding': ae, ...headers } }, r => {
      const c = []; r.on('data', d => c.push(d));
      r.on('end', () => {
        const wire = Buffer.concat(c);
        try { res({ status: r.statusCode, headers: r.headers, body: r.headers['content-encoding'] === 'br' && wire.length ? zlib.brotliDecompressSync(wire) : wire }); }
        catch (e) { rej(e); }
      });
    });
    q.on('error', rej); q.end();
  });
}
const KEEP = 'public, max-age=31536000, immutable';
/** what the caches are told: 'keep' (every cache, for good), 'revalidate' (the browser asks each time, no shared
 *  cache keeps it) or 'no' (nobody keeps it) */
const kept = r => {
  const h = r.headers, edgeNo = h['cdn-cache-control'] === 'no-store' && h['cloudflare-cdn-cache-control'] === 'no-store';
  if (h['cache-control'] === KEEP + ', no-transform' && h['cdn-cache-control'] === KEEP && h['cloudflare-cdn-cache-control'] === KEEP) return 'keep';
  if (edgeNo && h['cache-control'] === 'private, no-cache, no-transform') return 'revalidate';
  if (edgeNo && h['cache-control'] === 'private, no-store, no-transform') return 'no';
  return JSON.stringify(h);
};
// (the server compresses a new build when it is first asked for)
const json = async () => { const r = await get('/game.json'); return { r, info: JSON.parse(r.body) }; };

test('/game.json names the module; /game.wasm?v= of that module is kept for good, nothing else is', { timeout: 60_000 }, async () => {
  const a = build('a');
  const s = await server();
  try {
    const { r: jr, info } = await json();
    assert.equal(jr.status, 200);
    assert.deepEqual(info, { ...INFO, rev: 'a', size: a.mod.length, module: a.hash });
    assert.equal(kept(jr), 'no', 'no cache keeps /game.json: it says which module is the current one');
    assert.equal(jr.headers['content-type'], 'application/json');
    const latest = JSON.parse((await get('/game.json?latest')).body);
    assert.equal(latest.module, a.hash);

    // this module, brotli: every cache keeps it, and it is the exact bytes
    const m = await get(`/game.wasm?v=${a.hash}`);
    assert.equal(m.status, 200); assert.equal(m.headers['content-encoding'], 'br');
    assert.equal(kept(m), 'keep');
    assert.match(m.headers.vary ?? '', /accept-encoding/i);
    assert.ok(m.body.equals(a.mod));
    const h = await get(`/game.wasm?v=${a.hash}`, { method: 'HEAD' });
    assert.equal(h.status, 200); assert.equal(kept(h), 'keep'); assert.equal(h.body.length, 0);
    const again = await get(`/game.wasm?v=${a.hash}`, { headers: { 'if-none-match': m.headers.etag } });
    assert.equal(again.status, 304); assert.equal(kept(again), 'keep');

    // revalidated, no shared cache: the bare address (an older page), as it is (no br), a byte range
    for (const [what, p, o] of [['bare', '/game.wasm', {}], ['no br', `/game.wasm?v=${a.hash}`, { ae: 'gzip' }],
      ['range', `/game.wasm?v=${a.hash}`, { headers: { range: 'bytes=0-99' } }]]) {
      const r = await get(p, o);
      assert.ok(r.status === 200 || r.status === 206, `${what}: ${r.status}`);
      assert.equal(kept(r), 'revalidate', what);
      assert.ok(r.body.equals(r.status === 206 ? a.mod.subarray(0, 100) : a.mod), what);
    }

    // another hash: refused, and nobody keeps the refusal
    for (const v of ['nope', a.hash.slice(1), '']) {
      const r = await get(`/game.wasm?v=${v}`);
      assert.equal(r.status, 409, v); assert.equal(kept(r), 'no', v);
    }
  } finally { await s.stop(); }
});

test('/game.wasm: a new build is a new address; the old one is refused, never answered with the new module', { timeout: 60_000 }, async () => {
  const a = build('a');
  const s = await server();
  try {
    assert.equal((await json()).info.module, a.hash);
    assert.ok((await get(`/game.wasm?v=${a.hash}`)).body.equals(a.mod));
    // a new build while the server runs (a page that read /game.json just before asks for the old module)
    await new Promise(r => setTimeout(r, 20));
    const b = build('b');
    assert.notEqual(b.hash, a.hash);
    const old = await get(`/game.wasm?v=${a.hash}`);
    assert.equal(old.status, 409); assert.equal(kept(old), 'no');
    const { info } = await json();
    assert.equal(info.module, b.hash); assert.equal(info.rev, 'b');
    const m = await get(`/game.wasm?v=${b.hash}`);
    assert.equal(m.status, 200); assert.equal(kept(m), 'keep');
    assert.ok(m.body.equals(b.mod));
  } finally { await s.stop(); }
});

test('/game.json without a module to name: sent as it is', { timeout: 60_000 }, async () => {
  build('a');
  fs.rmSync(WASM);
  const s = await server();
  try {
    const r = await get('/game.json');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).module, undefined);
    assert.equal((await get('/game.wasm?v=x')).status, 404);
  } finally { await s.stop(); }
});
