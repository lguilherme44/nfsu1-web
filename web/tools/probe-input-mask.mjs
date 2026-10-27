// Hold Enter on the title and sample the game's own input state:
//   0x719780/84  combined action mask (active low: a pressed action clears bit 1<<uAppData)
//   0x736500     "ignore keyboard" byte (set: events drained, mask forced to all-released)
//   [0x735784]+8 +1  FEngine "accepts input"
//   node web/tools/probe-input-mask.mjs
import { chromium } from 'playwright';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://localhost:8080/test/play.html?fresh&save=save-probe${process.env.GAME_ENV ? '&env=' + process.env.GAME_ENV : ''}`);
await page.locator('canvas').click();
const read = () => page.evaluate(() => {
  const p = globalThis.nfsu2Proc; if (!p?.memory) return null;
  const u32 = new Uint32Array(p.memory.buffer), u8 = new Uint8Array(p.memory.buffer);
  const ctr = u32[0x735784 >> 2], root = ctr ? u32[(ctr + 8) >> 2] : 0;
  const str = a => { let s = ''; for (let i = 0; a && i < 64 && u8[a + i]; i++) s += String.fromCharCode(u8[a + i]); return s; };
  const screens = []; for (let c = root ? u32[(root + 0xe4) >> 2] : 0, i = 0; c && i < 8; i++, c = u32[(c + 4) >> 2]) screens.push(str(u32[(c + 0xc) >> 2]));
  return { mask: (u32[0x719784 >> 2] >>> 0).toString(16).padStart(8, '0') + (u32[0x719780 >> 2] >>> 0).toString(16).padStart(8, '0'),
           ignore: u8[0x736500], fe: root ? u8[root + 1] : -1, screens: screens.join(',') };
});
for (let i = 0; i < 120; i++) { const s = await read(); if (s && /Splash/.test(s.screens) && s.fe === 1) break; await sleep(500); }
console.log('idle   ', JSON.stringify(await read()));
await page.evaluate(() => globalThis.nfsu2Input.key('Enter', true));
for (let i = 0; i < 5; i++) { await sleep(60); console.log('held   ', JSON.stringify(await read())); }
await page.evaluate(() => globalThis.nfsu2Input.key('Enter', false));
await sleep(1500);
console.log('after  ', JSON.stringify(await read()));
await browser.close();
