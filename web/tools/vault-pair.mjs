// Keyphrase saves between two browsers (web/src/app/vault-ui.ts, the server's /vault): two Chrome contexts (each its
// own OPFS and localStorage) on the start page of a running server.
//
//   node web/tools/vault-pair.mjs --base http://127.0.0.1:8080 --backup <a "Download a backup" zip> [--state <dir>] [--play] [--headed]
//
// A restores the backup and makes a keyphrase; B (with a screenshot of its own) types it in, in another shape, and
// loads the saves; a rename in A comes to B at its next page load; both rename (a conflict: B keeps its own, A takes
// it at its next load); A deletes the saves from the server and B is told at its next load.  The profile's bytes are
// compared between the two, B's screenshot must stay throughout.  --state: the server's state folder as this machine
// reads it (\\wsl.localhost\... from Windows): exactly one keyphrase file in its vault folder, which holds neither the
// profile's name nor a byte of the profile.  --play (a server with --dev and a module): two more browsers on fresh
// save folders, C with a keyphrase of no profile plays tests/scripts/app_rw_probe.txt (a new profile ROTEST, saved,
// a Quick Race, the game's own close): the save goes to the server during the game, 10 s after it; D loads it,
// the same bytes, and renames it; C's next Play takes the rename before the game starts.  Prints each step, PASS or
// FAIL at the end (exit code 1).
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const BASE = opt('base'), BACKUP = opt('backup'), STATE = opt('state');
if (!BASE || !BACKUP) { console.error('usage: node web/tools/vault-pair.mjs --base <url> --backup <zip> [--state <dir>] [--headed]'); process.exit(2); }

const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, f, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await f().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`${what}: not within ${ms / 1000} s`);
    await sleep(200);
  }
}

/** a page's file of the save folder: its SHA-256, or null */
const fileHash = (page, rel, save = 'save') => page.evaluate(async ([rel, save]) => {
  let d = await (await navigator.storage.getDirectory()).getDirectoryHandle(save);
  const parts = rel.split('/');
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
  const f = await (await d.getFileHandle(parts[parts.length - 1])).getFile();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
}, [rel, save]).catch(() => null);
const writeFile = (page, rel, bytes) => page.evaluate(async ({ rel, bytes }) => {
  const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('save', { create: true });
  const w = await (await d.getFileHandle(rel, { create: true })).createWritable();
  await w.write(new Uint8Array(bytes)); await w.close();
}, { rel, bytes });
const link = (page, save = 'save') => page.evaluate(save => JSON.parse(localStorage.getItem(`nfsu2-keyphrase:${save}`) ?? 'null'), save);
const phase = page => page.evaluate(() => window.__nfsu2?.phase);
const profiles = page => page.$$eval('#profiles .name', els => els.map(e => e.textContent));
const status = page => page.textContent('#vault-status');
/** synced: "Synced <when>" beside the heading, nothing to say under it */
const synced = async page => /^Synced /.test(await page.textContent('#vault-when')) && !(await status(page));
const syncedNote = page => page.textContent('#vault-when');
async function confirmOk(page) { await page.waitForSelector('#confirm[open]'); await page.click('#confirm-ok'); }
async function open(page, query = '') {
  await page.goto(`${BASE}/${query}`);
  await page.waitForSelector('#vault:not([hidden])', { timeout: 20000 });
  await sleep(500);                    // the tab takes the saves over (instance.ts), its settings load, it syncs
}
async function rename(page, from, to) {
  await page.click(`#profiles button[aria-label="Rename ${from}"]`);
  await page.fill('#profiles li.renaming input', to);
  await page.click('#profiles li.renaming [type="submit"]');
  await until(`${to} in the list`, async () => (await profiles(page)).includes(to));
}

const browser = await chromium.launch({ channel: 'chrome', headless: !argv.includes('--headed'), args: ['--enable-unsafe-webgpu'] });
try {
  // (A may write the clipboard: the eye copies the keyphrase; reading it back the page's own policy refuses)
  const a = await (await browser.newContext({ permissions: ['clipboard-write'] })).newPage(), b = await (await browser.newContext()).newPage();
  for (const [n, p] of [['A', a], ['B', b]]) p.on('pageerror', e => console.log(`${n} page error: ${e.message}`));

  // A: a backup's saves, then a keyphrase for them
  await open(a);
  await a.setInputFiles('#import', BACKUP);
  await confirmOk(a);
  const name = await until('a profile restored in A', async () => (await profiles(a))[0]);
  const at = n => `NFS Underground 2/${n}/${n}`;
  await a.click('#vault-make');
  const phrase = await until('the keyphrase in the box', async () => (await link(a)) && (await a.inputValue('#vault-input')).trim());
  const box = page => page.evaluate(() => ({ masked: document.querySelector('#vault-box').classList.contains('masked'), dots: document.querySelector('#vault-mask').textContent,
    readOnly: document.querySelector('#vault-input').readOnly, selected: [document.querySelector('#vault-input').selectionStart, document.querySelector('#vault-input').selectionEnd] }));
  console.log(`A: profile ${name}, keyphrase ${phrase}`);
  const made = await box(a);
  check(/^nfsu2-xyz(-[a-z]{3,5}){8}$/.test(phrase) && !made.masked && made.readOnly, 'A made a keyphrase of nfsu2-xyz and 8 words, shown in the box, read only');
  await a.click('#vault-eye');
  const hid = await box(a);
  check(hid.masked && hid.dots === 'nfs' + '\u2022'.repeat(phrase.length - 3), `the eye hides it but its first 3 characters ("${hid.dots.slice(0, 6)}...")`);
  await a.click('#vault-eye');
  const shownAgain = await box(a);
  const copied = await until('Copied.', async () => (await a.textContent('#vault-msg')) === 'Copied.', 5000).catch(() => false);
  check(!shownAgain.masked && shownAgain.selected[0] === 0 && shownAgain.selected[1] === phrase.length && copied, 'shown again, it is all selected and copied');
  await a.click('#vault-eye');
  check(await synced(a), `A synced: "${await syncedNote(a)}"`);
  check(!!(await link(a))?.rev, 'A keeps the link in localStorage');

  // B: a screenshot of its own, then the keyphrase typed in another shape
  await open(b);
  await writeFile(b, 'nfsu2000.tga', [1, 2, 3, 4]);
  const typing = ` ${phrase.split('-').slice(2).join(' ').toUpperCase()} `;
  await b.fill('#vault-input', typing);
  const typed = await box(b);
  check(typed.masked && typed.dots === typing.slice(0, 3) + '\u2022'.repeat(typing.length - 3), 'what is typed is dotted too, but its first 3 characters');
  await b.click('#vault-load');
  await confirmOk(b);
  await until('the profile in B', async () => (await profiles(b)).includes(name));
  await until('B linked', async () => synced(b));
  check(true, `B loaded the keyphrase's saves: "${await syncedNote(b)}"`);
  check((await fileHash(a, at(name))) === (await fileHash(b, at(name))) && !!(await fileHash(b, at(name))), 'the profile is the same bytes in A and B');
  check((await fileHash(a, 'settings.ini')) === (await fileHash(b, 'settings.ini')), 'settings.ini came along');
  check(!!(await fileHash(b, 'nfsu2000.tga')), 'B\'s screenshot stayed');

  // A renames: B has it after its next page load
  const rev0 = (await link(a)).rev;
  await rename(a, name, 'RENAMED');
  await until('A sent the rename', async () => (await link(a))?.rev !== rev0);
  await open(b);
  await until('the rename in B', async () => (await profiles(b)).includes('RENAMED'));
  check(!(await profiles(b)).includes(name), 'B took A\'s rename');
  check(!!(await fileHash(b, 'nfsu2000.tga')), 'B\'s screenshot stayed after the sync');

  // both rename: a conflict in B, which keeps its own; A takes it at its next load
  const rev1 = (await link(a)).rev;
  await rename(a, 'RENAMED', 'FROMA');
  await until('A sent its rename', async () => (await link(a))?.rev !== rev1);
  await rename(b, 'RENAMED', 'FROMB');
  await b.waitForSelector('#vault-conflict:not([hidden])', { timeout: 20000 });
  check(/^Changed here and in another browser/.test(await status(b)), `B sees the conflict: "${await status(b)}"`);
  await b.click('#vault-mine');
  await until('B synced again', async () => synced(b));
  await open(a);
  await until('B\'s rename in A', async () => (await profiles(a)).includes('FROMB'));
  check(!(await profiles(a)).includes('FROMA'), 'A took B\'s choice');

  if (STATE) {
    // the keyphrase's file: the SHA-256 of its token (vault.ts keysOf), one file for both versions
    const token = crypto.pbkdf2Sync(phrase, 'nfsu2-xyz keyphrase saves v1', 100000, 64, 'sha256').subarray(32).toString('base64url');
    const id = crypto.createHash('sha256').update(token).digest('hex');
    const shard = path.join(STATE, 'vault', id.slice(0, 3));
    const files = fs.readdirSync(shard).filter(f => f.startsWith(id));
    check(files.length === 1 && files[0] === id, `its file on the server: ${id.slice(0, 3)}/${files.join(', ')}`);
    const held = files.length ? fs.readFileSync(path.join(shard, files[0])) : Buffer.alloc(0);
    check(held.subarray(0, 4).toString() === 'NFV1' && !held.includes('FROMB') && !held.includes('20CM') && !held.includes('settings'), 'it holds no name, no profile, no settings in the clear');
    check(!held.includes(phrase.split('-')[2]), 'nor the keyphrase');
  }

  // A deletes the saves from the server: B is told at its next load, and keeps its own
  await a.click('#vault-delete');
  await confirmOk(a);
  await until('A unlinked', async () => !(await link(a)));
  await open(b);
  await until('B told', async () => /gone from the cloud/.test(await status(b)));
  check(true, `B: "${await status(b)}"`);
  check((await profiles(b)).includes('FROMB') && !!(await fileHash(b, 'nfsu2000.tga')), 'B keeps its saves and screenshot');

  if (argv.includes('--play')) {
    const ENV = ['NOMOVIES=1', 'SNDSYNC=0', 'GPUVS=1', 'NFSU2_TIMEOUT=400'].map(e => `env=${encodeURIComponent(e)}`).join('&');
    const c = await (await browser.newContext()).newPage(), d = await (await browser.newContext()).newPage();
    c.on('pageerror', e => console.log(`C page error: ${e.message}`));
    await open(c, `?save=vplay&fresh&${ENV}&script=/tests/scripts/app_rw_probe.txt`);
    await until('C ready to play', async () => (await phase(c)) === 'ready', 120000);
    await c.click('#vault-make');
    const phrase2 = await until('C\'s keyphrase', async () => (await link(c, 'vplay')) && (await c.inputValue('#vault-input')).trim());
    check((await link(c, 'vplay'))?.profiles === 0, 'C made a keyphrase with no profile yet');
    await c.click('#play');
    await until('C playing', async () => (await phase(c)) === 'playing', 60000);
    let during = false;
    await until('the game over', async () => {
      const [ph, l] = [await phase(c), await link(c, 'vplay')];
      if (ph === 'playing' && l?.profiles === 1) during = true;
      return ph === 'exited';
    }, 400000);
    const exit = await c.evaluate(() => window.__nfsu2.lastExit);
    const log = await c.evaluate(() => window.__nfsu2.log.text());
    check(exit?.code === 0 && /the game saved profile ROTEST/.test(log), `C's game saved ROTEST and closed (${JSON.stringify(exit)})`);
    check(during, 'its save went to the server while the game ran');
    await until('C synced after the game', async () => (await synced(c)) && (await link(c, 'vplay'))?.profiles === 1);
    check(true, `C after the game: "${await syncedNote(c)}"`);
    await open(d, '?save=vplay2&fresh');
    await d.fill('#vault-input', phrase2);
    await d.click('#vault-load');
    await confirmOk(d);
    await until('ROTEST in D', async () => (await profiles(d)).includes('ROTEST'));
    check((await fileHash(c, at('ROTEST'), 'vplay')) === (await fileHash(d, at('ROTEST'), 'vplay2')), 'D has the game\'s save, the same bytes');
    const rev2 = (await link(d, 'vplay2')).rev;
    await rename(d, 'ROTEST', 'AFTER');
    await until('D sent the rename', async () => (await link(d, 'vplay2'))?.rev !== rev2);
    // C, not reloaded: Play takes the rename before the game starts
    await c.click('#play');
    await until('C playing again', async () => (await phase(c)) === 'playing', 60000);
    const took = !!(await fileHash(c, at('AFTER'), 'vplay')) && !(await fileHash(c, at('ROTEST'), 'vplay'));
    if (!took) console.log(`C: "${await status(c)}"\n${(await c.evaluate(() => window.__nfsu2.log.text())).split('\n').filter(l => /keyphrase|\[app\] (the game|autosave|settings)/.test(l)).slice(-12).join('\n')}`);
    // F9, Quit game: the game's own close (or its input script's, which ends with one)
    await sleep(5000);
    await c.keyboard.press('F9');
    await c.click('#menu [data-act="quit"]').catch(() => {});
    await until('C quit', async () => (await phase(c)) === 'exited', 400000);
    check(took, 'C\'s Play took D\'s rename before the game started');
  }
} catch (e) {
  check(false, `stopped: ${e.message}`);
} finally {
  await browser.close();
}
console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
