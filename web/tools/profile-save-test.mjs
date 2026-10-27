// End-to-end: title -> NEW DRIVER PROFILE -> type a name -> Enter, with every
// file operation of the game logged (FILELIST=1).  Asserts the profile files
// land in the OPFS save overlay and the game keeps rendering afterwards.
//   GAME_ENV=K=V,K2=V2 node web/tools/profile-save-test.mjs [outDir] [name]
import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/nfsu1-profile';
const NAME = process.argv[3] ?? 'LELLIS';
const SAVE = 'save-profiletest';
fs.mkdirSync(OUT, { recursive: true });
const logf = fs.createWriteStream(`${OUT}/console.log`);

// one Chrome profile for both scripts: the OPFS save overlay must survive between them
const USER_DATA = process.env.USER_DATA ?? `${OUT}/../chrome-profile`;
const browser = await chromium.launchPersistentContext(USER_DATA, { channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'], viewport: { width: 1280, height: 720 } });
const page = browser.pages()[0] ?? await browser.newPage();
page.on('console', m => logf.write(m.text() + '\n'));
page.on('pageerror', e => logf.write(`[pageerror] ${e}\n`));

const shot = async n => page.screenshot({ path: `${OUT}/${n}.png` });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The game polls a per-frame action mask (level, not edge): a down+up inside one
// poll cancels out, so hold the key across a few frames like a human does.
const tap = async key => { await page.keyboard.down(key); await sleep(120); await page.keyboard.up(key); };
// FEng screen stack (addresses from the 1.4 exe: FEngine container 0x735784)
const state = () => page.evaluate(() => {
  const p = globalThis.nfsu2Proc; if (!p?.memory) return null;
  const u32 = new Uint32Array(p.memory.buffer), u8 = new Uint8Array(p.memory.buffer);
  const str = a => { let s = ''; for (let i = 0; a && i < 64 && u8[a + i]; i++) s += String.fromCharCode(u8[a + i]); return s; };
  const ctr = u32[0x735784 >> 2], root = ctr ? u32[(ctr + 8) >> 2] : 0;
  const screens = []; for (let c = root ? u32[(root + 0xe4) >> 2] : 0, i = 0; c && i < 8; i++, c = u32[(c + 4) >> 2]) screens.push(str(u32[(c + 0xc) >> 2]));
  return { screens, textActive: u32[0x7363a0 >> 2], feInput: root ? u8[root + 1] : -1 };
});
const waitFor = async (pred, secs, label) => {
  for (let i = 0; i < secs * 2; i++) { const s = await state(); if (s && pred(s)) return s; await sleep(500); }
  const s = await state(); console.log(`TIMEOUT waiting ${label}:`, JSON.stringify(s)); return null;
};
const opfsList = () => page.evaluate(async save => {
  const out = [];
  const walk = async (d, pre) => { for await (const [n, h] of d.entries()) {
    if (h.kind === 'directory') await walk(h, `${pre}${n}/`); else out.push(`${pre}${n} ${(await h.getFile()).size}`); } };
  try { await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(save), ''); } catch (e) { out.push(String(e)); }
  return out;
}, SAVE);

const extraEnv = (process.env.GAME_ENV ?? '').split(',').filter(Boolean).map(e => `&env=${encodeURIComponent(e)}`).join('');
await page.goto(`http://localhost:8080/test/play.html?fresh&save=${SAVE}&env=FILELIST=1${extraEnv}`);
await page.locator('canvas').click();
// FEng "accepts input" byte (FEngine root +1): log every change with the screen stack
await page.evaluate(() => {
  let last = -1;
  setInterval(() => {
    const p = globalThis.nfsu2Proc; if (!p?.memory) return;
    const u32 = new Uint32Array(p.memory.buffer), u8 = new Uint8Array(p.memory.buffer);
    const ctr = u32[0x735784 >> 2], root = ctr ? u32[(ctr + 8) >> 2] : 0;
    const v = root ? u8[root + 1] : -2;
    if (v !== last) { console.log(`[feinput] ${last} -> ${v} at ${performance.now().toFixed(0)} ms`); last = v; }
  }, 20);
});
let s = await waitFor(s => s.screens.some(n => /Splash/i.test(n)) && s.feInput === 1, 90, 'splash');
console.log('splash:', JSON.stringify(s)); await sleep(300); await shot('01_splash');

await tap('Enter');
s = await waitFor(s => s.screens.some(n => /NewOrLoad/i.test(n)), 20, 'NewOrLoad');
console.log('newOrLoad:', JSON.stringify(s)); await sleep(1500); await shot('02_new_or_load');

await tap('Enter');
s = await waitFor(s => s.textActive === 1, 15, 'text entry');
console.log('textEntry:', JSON.stringify(s)); await shot('03_text_entry');

await page.keyboard.type(NAME, { delay: 120 });
await sleep(500); await shot('04_typed');
const mark = fs.statSync(`${OUT}/console.log`).size;
await tap('Enter');
for (let i = 1; i <= 15; i++) { await sleep(1000); if (i % 3 === 0) await shot(`05_after_${i}s`); }
console.log('after enter:', JSON.stringify(await state()));
console.log('OPFS:', JSON.stringify(await opfsList(), null, 1));
logf.end(); await sleep(200);
const tail = fs.readFileSync(`${OUT}/console.log`, 'utf8').slice(mark);
// the renderer prints "[gpu] N frames" every ~10 s: still presenting after Enter?
console.log('gpu after Enter:', tail.split('\n').filter(l => l.startsWith('[gpu]')).map(l => l.split(',')[0]).join(' | ') || 'none');
console.log('--- file ops after Enter ---\n' + tail.split('\n').filter(l => /\[file\]|\[write\]|!\]/.test(l)).slice(0, 80).join('\n'));
await browser.close();
