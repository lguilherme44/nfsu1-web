// Second half of profile-save-test.mjs: reload with the SAME save overlay,
// LOAD DRIVER PROFILE, then GO UNDERGROUND (career start + its FMV).
// Logs every change of the FEng screen stack and whether frames keep coming.
//   node web/tools/profile-save-test.mjs <out>   (first: creates the profile)
//   node web/tools/career-test.mjs <out>
import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/nfsu1-career';
const SAVE = 'save-profiletest';
const ENV = (process.env.GAME_ENV ? '&env=' + process.env.GAME_ENV : '') + '&env=FILELIST=1&env=NFSU2_SAVEDIR=/save&env=NFSU2_READONLY_DATA=1&env=NFSU2_REGFILE=/save/registry.txt';
fs.mkdirSync(OUT, { recursive: true });
const logf = fs.createWriteStream(`${OUT}/console.log`);
// one Chrome profile for both scripts: the OPFS save overlay must survive between them
const USER_DATA = process.env.USER_DATA ?? `${OUT}/../chrome-profile`;
const browser = await chromium.launchPersistentContext(USER_DATA, { channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'], viewport: { width: 1280, height: 720 } });
const page = browser.pages()[0] ?? await browser.newPage();
page.on('console', m => logf.write(m.text() + '\n'));
page.on('pageerror', e => logf.write(`[pageerror] ${e}\n`));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = n => page.screenshot({ path: `${OUT}/${n}.png` });
const tap = async key => { await page.keyboard.down(key); await sleep(120); await page.keyboard.up(key); await sleep(400); };
const state = () => page.evaluate(() => {
  const p = globalThis.nfsu2Proc; if (!p?.memory) return null;
  const u32 = new Uint32Array(p.memory.buffer), u8 = new Uint8Array(p.memory.buffer);
  const str = a => { let s = ''; for (let i = 0; a && i < 64 && u8[a + i]; i++) s += String.fromCharCode(u8[a + i]); return s; };
  const ctr = u32[0x735784 >> 2], root = ctr ? u32[(ctr + 8) >> 2] : 0;
  const screens = []; for (let c = root ? u32[(root + 0xe4) >> 2] : 0, i = 0; c && i < 8; i++, c = u32[(c + 4) >> 2]) screens.push(str(u32[(c + 0xc) >> 2]));
  return { screens, fe: root ? u8[root + 1] : -1 };
});
const waitFor = async (pred, secs, label) => {
  for (let i = 0; i < secs * 2; i++) { const s = await state(); if (s && pred(s)) return s; await sleep(500); }
  console.log(`TIMEOUT ${label}:`, JSON.stringify(await state())); return null;
};
const has = re => s => s.screens.some(n => re.test(n));

await page.goto(`http://localhost:8080/test/play.html?save=${SAVE}${ENV}`);
await page.locator('canvas').click();
await waitFor(s => has(/Splash/)(s) && s.fe === 1, 90, 'splash');
await tap('Enter');
console.log('newOrLoad', JSON.stringify(await waitFor(has(/NewOrLoad/), 20, 'NewOrLoad')));
await sleep(1000);
await tap('ArrowDown'); await shot('01_load_selected');
await tap('Enter');                                          // one profile: it loads straight to the menu
const menu = await waitFor(has(/MU_Main/), 15, 'main menu');
console.log('menu', JSON.stringify(menu)); await sleep(1500); await shot('02_main_menu');
await tap('ArrowUp');                                        // the menu opens on QUICK RACE; GO UNDERGROUND is above it
await shot('03_go_underground_selected');
const mark = fs.statSync(`${OUT}/console.log`).size;
await tap('Enter');
let last = '', accepted = false;
for (let i = 1; i <= 90; i++) {
  await sleep(1000);
  const s = await state(); const k = JSON.stringify(s?.screens);
  if (k !== last) { console.log(`t+${i}s`, k); last = k; }
  // "Welcome to Underground Mode!" opens on Exit: Accept is to its left
  if (!accepted && s && has(/MU_UG_Explained/)(s)) {
    await sleep(1000); await tap('ArrowLeft'); await shot('04_accept_selected'); await tap('Enter');
    accepted = true; console.log(`t+${i}s accepted the career`);
  }
  // first race: once the countdown is over, hold the throttle (Up) and see the car move
  if (s && has(/HUD_SingleRace/)(s) && !has(/PreRaceStats|Loading/)(s) && !globalThis.drove) {
    globalThis.drove = true; await sleep(6000);
    const gas = process.env.GAS_KEY ?? 'ArrowUp', steer = process.env.STEER_KEY ?? 'ArrowLeft';
    await page.keyboard.down(gas); await sleep(4000); await shot('05_throttle_4s');
    await page.keyboard.down(steer); await sleep(1500); await shot('05_throttle_steer'); await page.keyboard.up(steer);
    await sleep(2500); await shot('05_throttle_8s'); await page.keyboard.up(gas);
    console.log(`t+${i}s drove 8 s on the throttle`); break;
  }
  if (i % 10 === 0) await shot(`04_career_${i}s`);
}
logf.end(); await sleep(200);
const tail = fs.readFileSync(`${OUT}/console.log`, 'utf8').slice(mark).split('\n');
console.log('gpu after GO UNDERGROUND:', tail.filter(l => l.startsWith('[gpu]')).map(l => l.split(',')[0]).join(' | ') || 'none');
console.log(tail.filter(l => /\.mad|UNIMPLEMENTED|CANNOT OPEN|pageerror|\*\*\*|guest\]/.test(l)).slice(0, 40).join('\n'));
await browser.close();
