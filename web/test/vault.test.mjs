// Keyphrase saves in the page (web/src/app/vault.ts):
//   node --test web/test/vault.test.mjs
// - keyphrases: "nfsu2-xyz-" and 8 words of the list, read back in any case and with any separators
// - the key and the token: PBKDF2-SHA-256 as node:crypto makes it; sealed saves open only with their keyphrase
// - packing: a player's folder (a profile's .opt, two career saves, the text files) packs far below the server's 256 KB;
//   the content hash ignores the files' times
// - VaultSync, two browsers on a server that keeps what /vault keeps (crates/vault's rules, in memory): made in one,
//   loaded in the other, each one's saves taken by the other, a conflict either way, the same change on both sides,
//   a browser with no profile left, a torn profile during a game, a version with no profile or an older one (a server
//   gone back), a keyphrase deleted elsewhere or lost on the server (still linked, sent again), the server's refusals
// The real server and two real browsers: web/tools/vault-pair.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = `export * as V from './web/src/app/vault.ts'; export { WORDS } from './web/src/app/vault-words.ts';
  export { unzip } from './web/src/app/zip.ts';`;
const js = (await esbuild.build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral' })).outputFiles[0].text;
const { V, WORDS, unzip } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const enc = new TextEncoder();
const DIR = 'NFS Underground', B = 36;

/** a profile's .opt as the game saves one (as far as the page reads it: version 0x13, the name at 8), `money` a marker
 *  in it; `stale`: read halfway through a save (no version yet), which ug1save.ts badFile refuses */
function profile(name, { money = 1000, stale = false } = {}) {
  const f = Buffer.alloc(749);
  f.writeUInt32LE(stale ? 0 : 0x13, 0);
  f.write(name, 8, 'latin1');
  f.writeUInt32LE(money, B + 100);
  return new Uint8Array(f.buffer, f.byteOffset, f.length);
}
/** a career save (<NAME>_<slot>.ugd, 63,123 bytes) */
const career = () => { const d = new Uint8Array(63123); new DataView(d.buffer).setUint32(0, 0x13, true); d.set(enc.encode('auto'), 4); return d; };
const at = n => `${DIR}/${n}.opt`;

test('keyphrases: made from the list, read back however they are typed', () => {
  assert.equal(WORDS.length, 1296);
  assert.equal(new Set(WORDS).size, 1296);
  assert.ok(WORDS.every(w => /^[a-z]{3,5}$/.test(w)));
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const p = V.newPhrase();
    const w = p.split('-');
    assert.deepEqual(w.slice(0, 2), ['nfsu2', 'xyz']);
    assert.equal(w.length, 10);
    assert.ok(w.slice(2).every(x => WORDS.includes(x)), p);
    assert.deepEqual(V.readPhrase(p), { phrase: p });
    seen.add(p);
  }
  assert.equal(seen.size, 500);
  const p = 'nfsu2-xyz-acid-acorn-acre-acts-afar-affix-aged-agent';
  for (const typed of [p, p.toUpperCase(), ' acid acorn acre acts afar affix aged agent ', 'NFSU2.xyz: acid,acorn, acre;acts afar\naffix aged agent', 'nfsu2 xyz acid-acorn-acre-acts-afar-affix-aged-agent'])
    assert.deepEqual(V.readPhrase(typed), { phrase: p }, typed);
  assert.match(V.readPhrase('').bad, /Type or paste/);
  assert.match(V.readPhrase('nfsu2-xyz-acid-acorn-acre-acts-afar-affix-aged').bad, /8 words .* this has 7/);
  assert.match(V.readPhrase(p + '-agent').bad, /this has 9/);
  assert.match(V.readPhrase('nfsu2-xyz-acid-acorn-acre-acts-afar-affix-aged-agnet').bad, /"agnet" is not a keyphrase word/);
});

test('the key and token: PBKDF2-SHA-256, 100,000 rounds; sealed saves open with their keyphrase only', async () => {
  const p = 'nfsu2-xyz-acid-acorn-acre-acts-afar-affix-aged-agent';
  const k = await V.keysOf(p);
  const bits = crypto.pbkdf2Sync(p, 'nfsu2-xyz keyphrase saves v1', 100000, 64, 'sha256');
  assert.equal(k.token, bits.subarray(32).toString('base64url'));
  assert.match(k.token, /^[A-Za-z0-9_-]{43}$/);
  const plain = enc.encode('the saves');
  const box = await V.seal(k.key, plain);
  assert.equal(box[0], 1);
  assert.equal(box.length, 1 + 12 + plain.length + 16);
  // the key is the first half: AES-GCM as node:crypto does it
  const d = crypto.createDecipheriv('aes-256-gcm', bits.subarray(0, 32), box.subarray(1, 13));
  d.setAAD(Buffer.from('nfsu2-xyz keyphrase saves v1'));
  d.setAuthTag(box.subarray(box.length - 16));
  assert.equal(Buffer.concat([d.update(box.subarray(13, box.length - 16)), d.final()]).toString(), 'the saves');
  assert.deepEqual(await V.unseal(k.key, box), plain);
  const other = await V.keysOf('nfsu2-xyz-acid-acorn-acre-acts-afar-affix-aged-agile');
  await assert.rejects(V.unseal(other.key, box), /do not open with this keyphrase/);
  const bent = box.slice(); bent[20] ^= 1;
  await assert.rejects(V.unseal(k.key, bent), /do not open/);
  const v2 = box.slice(); v2[0] = 2;
  await assert.rejects(V.unseal(k.key, v2), /not a keyphrase's saves/);
  // two seals of the same saves differ (a new IV each time)
  assert.notDeepEqual(await V.seal(k.key, plain), box);
});

test('a player\'s folder packs far below what the server takes; the hash is of the content', async () => {
  const files = [
    { path: at('THOM'), data: profile('THOM'), mtime: 1 },
    { path: `${DIR}/THOM_autosave.ugd`, data: career(), mtime: 2 },
    { path: `${DIR}/THOM_slot1.ugd`, data: career(), mtime: 3 },
    { path: 'registry.txt', data: enc.encode('[HKEY]\nx=1\n'.repeat(30)), mtime: 4 },
    { path: 'settings.ini', data: enc.encode('# settings\n#fps = 60\n'.repeat(200)), mtime: 5 },
  ];
  const packed = await V.pack(files);
  assert.ok(packed.length < 16 << 10, `${packed.length} bytes`);
  const back = await unzip(await V.unpack(packed));
  assert.deepEqual(back.map(e => [e.name, e.data.length]), files.map(f => [f.path, f.data.length]));
  assert.deepEqual(back[0].data, files[0].data);
  const h = await V.contentHash(files);
  assert.equal(await V.contentHash(files.map(f => ({ ...f, mtime: 99 }))), h, 'times do not count');
  assert.equal(await V.contentHash([...files].reverse()), h, 'nor the order');
  assert.notEqual(await V.contentHash(files.map((f, i) => i === 3 ? { ...f, data: enc.encode('changed') } : f)), h);
  assert.notEqual(await V.contentHash(files.map((f, i) => i === 3 ? { ...f, path: 'registry2.txt' } : f)), h);
  assert.deepEqual(V.profilesIn(files), ['THOM']);
  assert.ok(V.keeps('settings.ini') && V.keeps(at('THOM')) && !V.keeps('nfsu2000.tga') && !V.keeps('autotest-script.txt'));
  await assert.rejects(V.unpack(enc.encode('not deflate')), /damaged/);
});

// ---- two browsers and a server ----

const DAY = 86400000;

/** /vault as the Rust server answers it (crates/vault, src/app/vault.rs), in memory */
function server() {
  const kept = new Map();
  const s = { now: Date.parse('2026-10-22T12:00:00Z'), kept, refuse: 0, off: false };
  const tag = n => `"${n.toString(16).padStart(16, '0')}"`;
  let revs = 1;
  const head = (v, earlier) => ({ etag: tag(v.rev), 'x-vault-saved': String(v.saved), ...(earlier ? { 'x-vault-earlier': String(earlier.saved) } : {}) });
  s.fetch = async (url, init = {}) => {
    const h = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const token = (h.authorization ?? '').replace(/^Bearer /, '');
    if (s.off) return new Response('Not found', { status: 404 });            // --vault-gb 0
    if (!token) return new Response('A keyphrase\'s token is needed', { status: 401 });
    if (s.refuse) return new Response('no', { status: s.refuse });
    const k = kept.get(token), method = init.method ?? 'GET';
    if (method === 'GET') {
      const v = url.endsWith('?earlier') ? k?.earlier : k?.cur;
      if (!v) return new Response('Not found', { status: 404 });
      if (!url.endsWith('?earlier') && h['if-none-match'] === tag(v.rev)) return new Response(null, { status: 304, headers: head(v, k.earlier) });
      return new Response(v.body, { status: 200, headers: head(v, url.endsWith('?earlier') ? null : k.earlier) });
    }
    if (method === 'PUT') {
      if (h['if-none-match'] === '*' ? k : !k || h['if-match'] !== tag(k.cur.rev))
        return new Response('Changed elsewhere', { status: 412, headers: k ? head(k.cur, k.earlier) : {} });
      const body = new Uint8Array(init.body);
      if (body.length > 256 << 10) return new Response('Too large', { status: 413 });
      const v = { rev: revs++, saved: s.now, body };
      const n = !k ? { cur: v, earlier: null }
        : Math.floor(k.cur.saved / DAY) !== Math.floor(s.now / DAY) ? { cur: v, earlier: k.cur } : { cur: v, earlier: k.earlier };
      kept.set(token, n);
      return new Response('Saved', { status: k ? 200 : 201, headers: head(v, n.earlier) });
    }
    if (method === 'DELETE') { const had = kept.delete(token); return new Response(had ? 'Deleted' : 'Not found', { status: had ? 200 : 404 }); }
    return new Response('no', { status: 405 });
  };
  return s;
}

/** a browser: its save folder (path -> bytes), its localStorage link, and its VaultSync */
function browser(srv, link = null) {
  const b = { files: new Map(), link, taken: 0 };
  b.sync = new V.VaultSync({
    files: async () => [...b.files].filter(([p]) => V.keeps(p)).map(([path, data]) => ({ path, data })),
    restore: async zip => {
      for (const p of [...b.files.keys()]) if (V.keeps(p)) b.files.delete(p);
      for (const e of await unzip(zip)) b.files.set(e.name, e.data);
    },
    load: () => b.link && JSON.parse(b.link),
    save: l => { b.link = l && JSON.stringify(l); },
    fetch: srv.fetch,
  });
  b.sync.onTaken = () => b.taken++;
  b.money = n => new DataView(b.files.get(n).buffer, b.files.get(n).byteOffset).getUint32(B + 100, true);
  return b;
}

/** b's saves: one profile with this much money, its settings */
function seed(b, money, ini = '# settings\n') {
  b.files.set(at('THOM'), profile('THOM', { money }));
  b.files.set('settings.ini', enc.encode(ini));
  b.files.set('nfsu2000.tga', new Uint8Array(100));        // a screenshot: never sent
}

test('two browsers on one keyphrase: made, loaded, synced both ways', async () => {
  const srv = server(), a = browser(srv), b = browser(srv);
  seed(a, 1000);
  const phrase = await a.sync.create();
  assert.match(phrase, /^nfsu2-xyz(-[a-z]{3,5}){8}$/);
  assert.equal(a.sync.state.s, 'synced');
  assert.equal(srv.kept.size, 1);
  // the server holds neither the keyphrase nor a save: only sealed bytes under the token
  const [[token, held]] = srv.kept;
  assert.equal(token, (await V.keysOf(phrase)).token);
  assert.ok(!Buffer.from(held.cur.body).includes('THOM') && !Buffer.from(held.cur.body).includes('settings'));
  // b: an unknown keyphrase, then a's
  assert.equal(await b.sync.peek('nfsu2-xyz-acid-acorn-acre-acts-afar-affix-aged-agent'), null);
  const got = await b.sync.peek(phrase);
  assert.deepEqual((await unzip(got.zip)).map(e => e.name).sort(), [at('THOM'), 'settings.ini']);
  b.files.set('nfsu2001.tga', new Uint8Array(5));
  for (const e of await unzip(got.zip)) b.files.set(e.name, e.data);
  await b.sync.adopt(phrase, got.remote);
  assert.equal(b.sync.state.s, 'synced');
  assert.equal(b.money(at('THOM')), 1000);
  // nothing changed: nothing sent, nothing taken
  const rev = srv.kept.get(token).cur.rev;
  await b.sync.push(); await a.sync.pull(); await b.sync.pull();
  assert.equal(srv.kept.get(token).cur.rev, rev);
  // a plays: b takes it (b's screenshot stays)
  a.files.set(at('THOM'), profile('THOM', { money: 2000 }));
  await a.sync.push();
  await b.sync.pull();
  assert.equal(b.money(at('THOM')), 2000);
  assert.equal(b.taken, 1);
  assert.ok(b.files.has('nfsu2001.tga'));
  // b plays: a takes it
  b.files.set(at('THOM'), profile('THOM', { money: 3000 }));
  await b.sync.push();
  await a.sync.pull();
  assert.equal(a.money(at('THOM')), 3000);
  assert.equal(a.sync.state.s, 'synced');
});

test('a conflict, settled either way; the same change on both sides is none', async () => {
  const srv = server(), a = browser(srv), b = browser(srv);
  seed(a, 1000);
  const phrase = await a.sync.create();
  const got = await b.sync.peek(phrase);
  for (const e of await unzip(got.zip)) b.files.set(e.name, e.data);
  await b.sync.adopt(phrase, got.remote);
  // both play
  a.files.set(at('THOM'), profile('THOM', { money: 5000 }));
  b.files.set(at('THOM'), profile('THOM', { money: 7000 }));
  await a.sync.push();
  await b.sync.push();
  assert.equal(b.sync.state.s, 'conflict');
  assert.equal(b.sync.state.why, 'both');
  assert.equal(b.sync.state.theirs.saved, srv.now);
  // while it waits for the player, nothing syncs by itself
  await b.sync.pull(); await b.sync.push();
  assert.equal(b.money(at('THOM')), 7000);
  // b keeps its own: a takes it
  await b.sync.keepMine();
  assert.equal(b.sync.state.s, 'synced');
  await a.sync.pull();
  assert.equal(a.money(at('THOM')), 7000);
  // again, and a takes the other's this time
  a.files.set(at('THOM'), profile('THOM', { money: 8000 }));
  b.files.set(at('THOM'), profile('THOM', { money: 9000 }));
  await b.sync.push();
  await a.sync.pull();
  assert.equal(a.sync.state.s, 'conflict');
  await a.sync.takeTheirs();
  assert.equal(a.money(at('THOM')), 9000);
  assert.equal(a.sync.state.s, 'synced');
  // both pages bring settings.ini up to date the same way: no conflict
  const up = enc.encode('# settings\n#new = 1\n');
  a.files.set('settings.ini', up); b.files.set('settings.ini', up);
  await a.sync.push();
  await b.sync.pull();
  assert.equal(b.sync.state.s, 'synced');
  assert.equal(b.sync.link.rev, a.sync.link.rev);
});

test('no profile here is never sent by itself; a torn profile waits; the copy of an earlier day', async () => {
  const srv = server(), a = browser(srv);
  seed(a, 1000);
  await a.sync.create();
  // the game is writing the profile while it is read: checksums that do not hold
  a.files.set(at('THOM'), profile('THOM', { money: 1500, stale: true }));
  const rev = a.sync.link.rev;
  await a.sync.push({ playing: true });
  assert.equal(a.sync.link.rev, rev, 'not sent during a game');
  a.files.set(at('THOM'), profile('THOM', { money: 1500 }));
  await a.sync.push({ playing: true });
  assert.notEqual(a.sync.link.rev, rev);
  // the next day: the version of the day before is the earlier copy
  srv.now += DAY;
  a.files.set(at('THOM'), profile('THOM', { money: 2500 }));
  await a.sync.push();
  assert.equal(a.sync.link.earlier, srv.now - DAY);
  const e = await a.sync.peek(a.sync.link.phrase, true);
  const prof = (await unzip(e.zip)).find(x => x.name === at('THOM')).data;
  assert.equal(new DataView(prof.buffer, prof.byteOffset).getUint32(B + 100, true), 1500);
  // the profiles gone here (cleared storage): nothing sent; the keyphrase's come back
  a.files.delete(at('THOM'));
  await a.sync.push();
  assert.deepEqual([a.sync.state.s, a.sync.state.why], ['conflict', 'empty']);
  await a.sync.takeTheirs();
  assert.equal(a.money(at('THOM')), 2500);
  // or, sent anyway
  a.files.delete(at('THOM'));
  await a.sync.push();
  await a.sync.keepMine();
  assert.equal(a.sync.state.s, 'synced');
  assert.equal(a.sync.link.profiles, 0);
});

test('deleted elsewhere, and the server\'s refusals', async () => {
  const srv = server(), a = browser(srv), b = browser(srv);
  seed(a, 1000);
  const phrase = await a.sync.create();
  const got = await b.sync.peek(phrase);
  for (const e of await unzip(got.zip)) b.files.set(e.name, e.data);
  await b.sync.adopt(phrase, got.remote);
  srv.refuse = 429;
  a.files.set(at('THOM'), profile('THOM', { money: 1 }));
  await assert.rejects(a.sync.push());
  assert.deepEqual(a.sync.state, { s: 'error', msg: 'the server asks this address to wait a minute (too many requests)' });
  srv.refuse = 507;
  await assert.rejects(a.sync.push());
  assert.equal(a.sync.state.msg, 'the server has no room for more saves now');
  srv.refuse = 0;
  await a.sync.push();
  assert.equal(a.sync.state.s, 'synced');
  // b deletes it: a learns at its next sync, and keeps its saves
  await b.sync.remove();
  assert.equal(b.sync.link, null);
  assert.equal(b.link, null);
  assert.equal(srv.kept.size, 0);
  await a.sync.pull();
  assert.equal(a.sync.state.s, 'gone');
  assert.equal(a.money(at('THOM')), 1);
  // a keeps the keyphrase and sends nothing by itself, after a reload too
  assert.equal(a.sync.link.phrase, phrase);
  assert.equal(a.sync.link.gone, true);
  a.files.set(at('THOM'), profile('THOM', { money: 2 }));
  await a.sync.push();
  assert.equal(srv.kept.size, 0);
  const a2 = browser(srv, a.link); a2.files = a.files;          // a reloaded
  assert.equal(a2.sync.state.s, 'gone');
  // the player sends them again: there under the same keyphrase, a syncs again
  await a.sync.resend();
  assert.equal(a.sync.state.s, 'synced');
  assert.ok(!a.sync.link.gone);
  assert.equal(srv.kept.size, 1);
  // a server whose folder came back: a browser marked gone syncs again by itself
  await a2.sync.pull();
  assert.equal(a2.sync.state.s, 'synced');
  assert.ok(!a2.sync.link.gone);
  // a server that keeps no keyphrase saves now (--vault-gb 0): a failure, the link as it was
  srv.off = true;
  await assert.rejects(a.sync.pull());
  assert.deepEqual(a.sync.state, { s: 'error', msg: 'the server keeps no cloud saves now' });
  assert.equal(a.sync.link.phrase, phrase);
  assert.ok(!a.sync.link.gone);
  srv.off = false;
  await a.sync.pull();
  assert.equal(a.sync.state.s, 'synced');
  // a server that does not answer
  const c = browser({ fetch: async () => { throw new TypeError('fetch failed'); } });
  seed(c, 1);
  await assert.rejects(c.sync.create());
  assert.deepEqual(c.sync.state, { s: 'error', msg: 'the server does not answer' });
  assert.equal(c.sync.link, null);
});

test('a version older than the one here, or with no profile, never replaces the saves here by itself', async () => {
  const srv = server(), a = browser(srv), b = browser(srv);
  seed(a, 1000);
  const phrase = await a.sync.create();
  const got = await b.sync.peek(phrase);
  for (const e of await unzip(got.zip)) b.files.set(e.name, e.data);
  await b.sync.adopt(phrase, got.remote);
  const token = (await V.keysOf(phrase)).token, backup = srv.kept.get(token);
  // a plays on: b takes it
  srv.now += 60_000;
  a.files.set(at('THOM'), profile('THOM', { money: 5000 }));
  await a.sync.push();
  await b.sync.pull();
  assert.equal(b.money(at('THOM')), 5000);
  // the server goes back (its folder restored from a backup): b keeps its saves and asks
  srv.kept.set(token, backup);
  await b.sync.pull();
  assert.deepEqual([b.sync.state.s, b.sync.state.why], ['conflict', 'older']);
  assert.equal(b.money(at('THOM')), 5000);
  await b.sync.keepMine();
  assert.equal(b.sync.state.s, 'synced');
  await a.sync.pull();
  assert.equal(a.sync.state.s, 'synced');
  assert.equal(a.money(at('THOM')), 5000);
  // a keeps its empty saves over the cloud's: b, unchanged since, keeps its profile and asks
  srv.now += 60_000;
  a.files.delete(at('THOM'));
  await a.sync.push();
  assert.deepEqual([a.sync.state.s, a.sync.state.why], ['conflict', 'empty']);
  await a.sync.keepMine();
  await b.sync.pull();
  assert.deepEqual([b.sync.state.s, b.sync.state.why], ['conflict', 'bare']);
  assert.equal(b.money(at('THOM')), 5000);
  await b.sync.takeTheirs();
  assert.ok(!b.files.has(at('THOM')));
});
