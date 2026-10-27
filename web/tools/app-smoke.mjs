// The real page (index.html, the shell: settings, env, save overlay) end to end:
// open it, wait for Play, play, and report where the game got to.
//   node web/tools/app-smoke.mjs [url] [outDir]     (default https://localhost:8443/, compose.local.yml)
import { chromium } from 'playwright';
import fs from 'node:fs';
const URL_ = process.argv[2] ?? 'https://localhost:8443/';
const OUT = process.argv[3] ?? '/tmp/nfsu1-app-smoke';
fs.mkdirSync(OUT, { recursive: true });
const logf = fs.createWriteStream(`${OUT}/console.log`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launchPersistentContext(`${OUT}/chrome-profile`, {
  channel: 'chrome', headless: true, ignoreHTTPSErrors: true, args: ['--enable-unsafe-webgpu'], viewport: { width: 1280, height: 720 } });
const page = browser.pages()[0] ?? await browser.newPage();
page.on('console', m => logf.write(m.text() + '\n'));
page.on('pageerror', e => logf.write(`[pageerror] ${e}\n`));
await page.goto(URL_);
console.log('crossOriginIsolated:', await page.evaluate(() => crossOriginIsolated));
try { await page.waitForSelector('#play:not([disabled])', { timeout: 120000 }); }
catch { await page.screenshot({ path: `${OUT}/not_ready.png` }); console.log('Play never enabled'); await browser.close(); process.exit(1); }
await page.screenshot({ path: `${OUT}/01_ready.png` });
await page.click('#play');
const screens = () => page.evaluate(() => {
  const p = globalThis.nfsu2Proc ?? globalThis.__nfsu2?.session?.proc; if (!p?.memory) return null;   // test page / the real page
  const u32 = new Uint32Array(p.memory.buffer), u8 = new Uint8Array(p.memory.buffer);
  const str = a => { let s = ''; for (let i = 0; a && i < 64 && u8[a + i]; i++) s += String.fromCharCode(u8[a + i]); return s; };
  const ctr = u32[0x735784 >> 2], root = ctr ? u32[(ctr + 8) >> 2] : 0;
  const out = []; for (let c = root ? u32[(root + 0xe4) >> 2] : 0, i = 0; c && i < 8; i++, c = u32[(c + 4) >> 2]) out.push(str(u32[(c + 0xc) >> 2]));
  return out;
});
let last = '';
for (let i = 1; i <= +(process.env.SMOKE_SECS ?? 60); i++) {
  await sleep(1000);
  const s = JSON.stringify(await screens().catch(() => null));
  if (s !== last) { console.log(`t+${i}s`, s); last = s; }
  if (/Splash/.test(s)) break;
}
await sleep(2000);
await page.screenshot({ path: `${OUT}/02_after_play.png` });
logf.end(); await sleep(200);
console.log(fs.readFileSync(`${OUT}/console.log`, 'utf8').split('\n').filter(l => /NOMOVIES|movies|pageerror|\[app\]|UNIMPL|\*\*\*/.test(l)).slice(0, 20).join('\n'));
await browser.close();
