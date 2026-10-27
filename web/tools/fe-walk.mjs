// Walk the game's menus with a list of steps and report the FEng screen stack after each one.
// The building block of the menu and coverage tests: one boot per run, so give it the whole path.
//
//   node web/tools/fe-walk.mjs <outDir> "<steps>"     (steps: comma-separated)
//
// Steps:
//   Enter | Escape | ArrowUp | ... | w | e   tap a key (held 120 ms: shorter taps fall between the game's polls)
//   Key*3                                    the same key three times
//   hold:<key>:<ms>                          hold a key down (the throttle) that long
//   down:<key> | up:<key>                    press / release (stays down across the next steps)
//   wait:<regex>[:<secs>]                    until a screen in the stack matches (default 30 s); fails the walk on timeout
//   sleep:<ms>                               just wait
//   until:<regex>:<key>[:<max>]              tap the key (1.2 s apart, at most max, default 10) until a screen matches
//   gpu                                      print the renderer's last frame-rate line
//   leave                                    out of a race to the menus: Leave Race from the post-race menu, or from
//                                            the pause menu (Escape) and OK on its "counts as a loss" prompt
//   shot:<name>                              screenshot <outDir>/<name>.png
//   profile                                  boot to the main menu with the walk's profile (creates it the first time)
//
// The Chrome profile (OPFS saves) is <outDir>/../fe-walk-profile, kept between runs (FE_PROFILE= another).
// The page is the test page (no movies: NOMOVIES unset); FE_ENV=K=V,K2=V2 adds game environment.
// Exit 1 when a wait times out or the page throws; the console is <outDir>/console.log.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [OUT, STEPS = ''] = process.argv.slice(2);
if (!OUT) { console.log('usage: node web/tools/fe-walk.mjs <outDir> "<steps>"'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const URL_ = process.env.FE_URL ?? 'http://localhost:8080';
const PROFILE = process.env.FE_PROFILE ?? path.join(OUT, '..', 'fe-walk-profile');
const NAME = process.env.FE_NAME ?? 'WALKER';
const SAVE = 'fewalk';   // the page's OPFS save folder (?save=)
const env = ['FILELIST=1', 'NFSU2_SAVEDIR=/save', 'NFSU2_READONLY_DATA=1', 'NFSU2_REGFILE=/save/registry.txt',
  ...(process.env.FE_ENV ?? '').split(',').filter(Boolean)].map(e => `&env=${encodeURIComponent(e)}`).join('');

const logf = fs.createWriteStream(path.join(OUT, 'console.log'));
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'], viewport: { width: 1280, height: 720 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
const t0 = Date.now(), at = () => ((Date.now() - t0) / 1000).toFixed(1);
let pageError = null;
page.on('console', m => logf.write(`${at()} ${m.text()}\n`));
page.on('pageerror', e => { pageError = String(e); logf.write(`${at()} [pageerror] ${e}\n`); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const state = () => page.evaluate(() => {
  const p = globalThis.nfsu2Proc; if (!p?.memory) return null;
  const u32 = new Uint32Array(p.memory.buffer), u8 = new Uint8Array(p.memory.buffer);
  const str = a => { let s = ''; for (let i = 0; a && i < 64 && u8[a + i]; i++) s += String.fromCharCode(u8[a + i]); return s; };
  const ctr = u32[0x735784 >> 2], root = ctr ? u32[(ctr + 8) >> 2] : 0;   // FEng manager (SPEED.EXE 1.4)
  const screens = []; for (let c = root ? u32[(root + 0xe4) >> 2] : 0, i = 0; c && i < 8; i++, c = u32[(c + 4) >> 2]) screens.push(str(u32[(c + 0xc) >> 2]));
  return { screens, fe: root ? u8[root + 1] : -1 };
}).catch(() => null);
const show = s => (s?.screens ?? []).join(' > ') || '(none)';
const tap = async k => { await page.keyboard.down(k); await sleep(120); await page.keyboard.up(k); await sleep(450); };
const waitFor = async (re, secs) => {
  for (let i = 0; i < secs * 2; i++) {
    const s = await state();
    if (s && s.fe === 1 && s.screens.some(n => re.test(n))) return s;
    await sleep(500);
  }
  return null;
};
const fail = async msg => {
  console.log(`FAIL ${msg} | now: ${show(await state())}`);
  await page.screenshot({ path: path.join(OUT, 'fail.png') }).catch(() => {});
  logf.end(); await ctx.close(); process.exit(1);
};

/** boot to the main menu with this walk's profile, creating it on the first run */
async function profile() {
  if (!await waitFor(/Splash/, 120)) await fail('no splash');
  // an Enter can land between the splash's polls: again until NEW/LOAD
  let nl = null;
  for (let i = 0; i < 6 && !nl; i++) { await sleep(500); await tap('Enter'); nl = await waitFor(/NewOrLoad/, 5); }
  if (!nl) await fail('no NEW/LOAD');
  await sleep(1000);
  const saved = await page.evaluate(async dir => {
    try {
      const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle(dir)).getDirectoryHandle('NFS Underground');
      for await (const k of d.keys()) if (/\.opt$/i.test(k)) return true;
    } catch { /* no save folder yet */ }
    return false;
  }, SAVE);
  if (saved) {
    await tap('ArrowDown'); await tap('Enter');              // LOAD: one profile loads straight to the menu
  } else {
    await tap('Enter');                                        // NEW: the name entry (as profile-save-test.mjs)
    await sleep(1500);
    await page.keyboard.type(NAME, { delay: 120 });
    await sleep(500); await tap('Enter');
    // a prompt after the save (if any) takes one more Enter
    if (!await waitFor(/MU_Main/, 20)) await tap('Enter');
  }
  if (!await waitFor(/MU_Main/, 40)) await fail(`no main menu after ${saved ? 'LOAD' : 'NEW'}`);
  await sleep(1500);
}

await page.goto(`${URL_}/test/play.html?save=${SAVE}${env}`);
await page.locator('canvas').click().catch(() => {});
let steps = STEPS.split(',').map(s => s.trim()).filter(Boolean);
for (const st of steps) {
  const [op, a, b] = st.split(':');
  const rep = /^(.+)\*(\d+)$/.exec(st);
  if (rep) for (let i = 0; i < +rep[2]; i++) await tap(rep[1]);
  else if (op === 'profile') await profile();
  else if (op === 'wait') { if (!await waitFor(new RegExp(a), +(b ?? 30))) await fail(`wait ${a}`); }
  else if (op === 'sleep') await sleep(+a);
  else if (op === 'until') {
    const re = new RegExp(a); let ok = false;
    for (let i = 0; i < +(st.split(':')[3] ?? 10) && !ok; i++) {
      const s = await state(); if (s?.screens.some(n => re.test(n))) { ok = true; break; }
      await tap(b.length === 1 ? `Key${b.toUpperCase()}` : b); await sleep(750);
    }
    if (!ok && !(await state())?.screens.some(n => re.test(n))) await fail(`until ${a}`);
  }
  else if (op === 'leave') {
    const now = await state();
    if (now?.screens.some(n => /PostRaceMenu/.test(n))) { await tap('ArrowDown'); await tap('ArrowDown'); await tap('Enter'); }
    else {
      await tap('Escape'); await sleep(1500);
      if (!(await state())?.screens.some(n => /MU_Pause/.test(n))) await fail('leave: no pause menu');
      await tap('ArrowDown'); await tap('ArrowDown'); await tap('ArrowDown'); await tap('Enter'); await sleep(1500);
      if ((await state())?.screens.some(n => /PauseConfirm/.test(n))) { await tap('ArrowLeft'); await tap('Enter'); }
    }
    if (!await waitFor(/MU_Main|QuickRaceModeSelect|MU_UG_/, 60)) await fail('leave: not back in the menus');
  }
  else if (op === 'gpu') {
    const l = fs.readFileSync(path.join(OUT, 'console.log'), 'utf8').split('\n').filter(x => /\[gpu\] \d+ frames|fps/.test(x)).pop();
    console.log(`        gpu: ${l ?? '(no frame-rate line yet)'}`);
  }
  else if (op === 'shot') await page.screenshot({ path: path.join(OUT, `${a}.png`) });
  else if (op === 'hold') { await page.keyboard.down(a); await sleep(+b); await page.keyboard.up(a); }
  else if (op === 'down') await page.keyboard.down(a);
  else if (op === 'up') await page.keyboard.up(a);
  else await tap(st.length === 1 ? `Key${st.toUpperCase()}` : st);
  console.log(`${at().padStart(6)}s  ${st.padEnd(22)} ${show(await state())}`);
  if (pageError) await fail(`page error: ${pageError}`);
}
logf.end(); await sleep(200);
const bad = fs.readFileSync(path.join(OUT, 'console.log'), 'utf8').split('\n')
  .filter(l => /UNIMPLEMENTED|unsupported_insn|lift-error|\*\*\* |pageerror|CANNOT OPEN/.test(l) && !/ZDIR\.BIN|Config\.bin|Profiles\.usr/.test(l));
if (bad.length) console.log(`console: ${bad.length} complaint(s)\n  ` + [...new Set(bad.map(l => l.replace(/^[\d.]+ /, '')))].slice(0, 15).join('\n  '));
await ctx.close();
