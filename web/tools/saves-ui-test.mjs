// The start page's Saves section with NFS Underground's profiles (ug1save.ts), end to end in the real page:
//   1. the save folder has a profile (its files copied from a game's save): the list shows it
//   2. Restore a zip of the PC game's folder ("<anything>/NFS Underground/...") with that profile and one of another
//      version: the confirm names the first and refuses the second; after it, Profiles.usr lists the profile
//   3. Play: the profile restored by the page loads in the game (LOAD DRIVER PROFILE -> main menu)
//   node web/tools/saves-ui-test.mjs <dir with LELLIS.opt, LELLIS.cfg, LELLIS_autosave.ugd> <pc.zip> [outDir] [url]
import { chromium } from 'playwright';
import fs from 'node:fs';
const [SRC, PCZIP, OUT = '/tmp/nfsu1-saves-ui', URL_ = 'http://localhost:8080/'] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(`${OUT}/chrome-profile`, { recursive: true, force: true });
const logf = fs.createWriteStream(`${OUT}/console.log`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launchPersistentContext(`${OUT}/chrome-profile`, {
  channel: 'chrome', headless: true, ignoreHTTPSErrors: true, args: ['--enable-unsafe-webgpu'], viewport: { width: 1280, height: 900 } });
const page = browser.pages()[0] ?? await browser.newPage();
page.on('console', m => logf.write(m.text() + '\n'));
const opfs = (fn, arg) => page.evaluate(fn, arg);
const names = () => page.$$eval('#profiles li .name', l => l.map(x => x.textContent));
const index = () => opfs(async () => {
  const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('save')).getDirectoryHandle('NFS Underground');
  const b = new Uint8Array(await (await (await d.getFileHandle('Profiles.usr')).getFile()).arrayBuffer());
  const n = new DataView(b.buffer).getUint32(0, true), out = [];
  for (let i = 0; i < n; i++) { let s = ''; for (let k = 4 + i * 32; b[k]; k++) s += String.fromCharCode(b[k]); out.push(s); }
  return out;
});

await page.goto(URL_);
// 1. seed the save folder with the profile's files (no Profiles.usr: the page lists by the .opt)
const files = Object.fromEntries(fs.readdirSync(SRC).filter(f => !/^Profiles/i.test(f)).map(f => [f, [...fs.readFileSync(`${SRC}/${f}`)]]));
await opfs(async files => {
  const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('save', { create: true })).getDirectoryHandle('NFS Underground', { create: true });
  for (const [n, a] of Object.entries(files)) { const w = await (await d.getFileHandle(n, { create: true })).createWritable(); await w.write(new Uint8Array(a)); await w.close(); }
}, files);
await page.reload();
await page.waitForSelector('#profiles li .name', { timeout: 30000 });
console.log('1. listed:', JSON.stringify(await names()), '| meta:', await page.$eval('#profiles li .meta', x => x.textContent));
console.log('   rename buttons:', await page.$$eval('#profiles .rename-btn', l => l.length));
await page.locator('#profiles').screenshot({ path: `${OUT}/01_profiles.png` });

// 2. Restore the PC folder's zip
await page.setInputFiles('#import', PCZIP);
await page.waitForSelector('#confirm[open]', { timeout: 15000 });
console.log('2. confirm:', (await page.$eval('#confirm', d => d.innerText)).replace(/\s+/g, ' '));
await page.locator('#confirm').screenshot({ path: `${OUT}/02_confirm.png` });
await page.click('#confirm-ok');
await page.waitForFunction(() => /Added|stopped/.test(document.querySelector('#saves-msg')?.textContent ?? ''), null, { timeout: 15000 });
console.log('   msg:', await page.$eval('#saves-msg', x => x.textContent), '| index:', JSON.stringify(await index()), '| listed:', JSON.stringify(await names()));

// 3. play and load it
await page.waitForSelector('#play:not([disabled])', { timeout: 120000 });
await page.click('#play');
const state = () => page.evaluate(() => {
  const p = globalThis.nfsu2Proc ?? globalThis.__nfsu2?.session?.proc; if (!p?.memory) return null;   // test page / the real page   // test page / the real page
  const u32 = new Uint32Array(p.memory.buffer), u8 = new Uint8Array(p.memory.buffer);
  const str = a => { let s = ''; for (let i = 0; a && i < 64 && u8[a + i]; i++) s += String.fromCharCode(u8[a + i]); return s; };
  const ctr = u32[0x735784 >> 2], root = ctr ? u32[(ctr + 8) >> 2] : 0;
  const screens = []; for (let c = root ? u32[(root + 0xe4) >> 2] : 0, i = 0; c && i < 8; i++, c = u32[(c + 4) >> 2]) screens.push(str(u32[(c + 0xc) >> 2]));
  return { screens: screens.join(','), fe: root ? u8[root + 1] : -1 };
});
const waitFor = async (re, secs) => { for (let i = 0; i < secs * 2; i++) { const s = await state(); if (s && re.test(s.screens) && s.fe === 1) return s; await sleep(500); } return state(); };
const tap = async k => { await page.keyboard.down(k); await sleep(120); await page.keyboard.up(k); await sleep(400); };
await page.locator('canvas').click().catch(() => {});
await waitFor(/Splash/, 90); await tap('Enter');
await waitFor(/NewOrLoad/, 20); await sleep(1000);
await tap('ArrowDown'); await tap('Enter');
const s = await waitFor(/MU_Main/, 20);
console.log('3. after LOAD:', JSON.stringify(s));
await page.screenshot({ path: `${OUT}/03_loaded.png` });
logf.end(); await browser.close();
