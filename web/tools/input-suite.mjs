// Runs the keyboard and pad autotest scripts (tests/scripts/kb_*, pad_*) in
// headless Chrome through the aicheck page, one after another, and compares
// each run's peek values with the Mac port's reference log of the same
// script where one exists (heap addresses normalised).
//
//   node web/tools/input-suite.mjs <outdir> [name ...]   (server: --base, default http://localhost:8614, started with --dev)
//   --page hostcheck   run through the headless test page without the page's
//                      input layer: the ns* commands are then translated in C
//                      (runtime/web/input_web.c), as the suite runner does
//
// Chained scenarios share a browser profile, so the saves and the registry
// one script writes are there for the next (kb_rebind_save -> load -> reset).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// the Mac port's run logs, to compare against (NFSU2_MAC_RUNS, else ~/projects/nsfu2/work/runs)
const MAC = process.env.NFSU2_MAC_RUNS || path.join(os.homedir(), 'projects/nsfu2/work/runs');
const out = path.resolve(process.argv[2] ?? 'out/web/input-suite');
const ai = process.argv.indexOf('--base');
const base = ai > 0 ? process.argv[ai + 1] : 'http://localhost:8614';
await (await import('./dev-server.mjs')).requireDev(base);
const pgi = process.argv.indexOf('--page');
const pageName = pgi > 0 ? process.argv[pgi + 1] : 'aicheck';
const only = process.argv.slice(3).filter((a, i, l) => !a.startsWith('--') && l[i - 1] !== '--base' && l[i - 1] !== '--page');
fs.mkdirSync(out, { recursive: true });

const ENV = ['NFSU2_SAVEDIR=/save', 'NFSU2_READONLY_DATA=1', 'NOMOVIES=1', 'SNDSYNC=0', 'GPUVS=1', 'NFSU2_FNG_LOG=1',
  'NFSU2_STATUS_EVERY=600', 'NFSU2_DISCORD=0', 'NOFOCUS=2'];
// name, script, extra env, chain (profile) or null, Mac reference run, timeout s
const SCEN = [
  ['kb_focus_mouse', 'kb_focus_mouse', [], null, 'kbdrev-07-kb_focus_mouse', 300],
  ['kb_profile', 'kb_profile', [], null, 'int2-fin-kb/kb_profile', 300],
  ['kb_no_pad_controls', 'kb_no_pad_controls', [], null, null, 300],
  ['kb_pad_capture_escape', 'kb_pad_capture_escape', [], null, 'kbdrev-07-kb_pad_capture_escape', 300],
  ['kb_rebind_save', 'kb_rebind_save', [], 'kb', 'int2-fin-kb/kb_rebind_save', 400],
  ['kb_rebind_load', 'kb_rebind_load', [], 'kb', 'int2-fin-kb/kb_rebind_load', 300],
  ['kb_rebind_reset', 'kb_rebind_reset', [], 'kb', 'kbd-23-reset', 300],
  ['pad_probe', 'pad_probe', [], null, 'pad-rvf-probe', 200],
  ['pad_probe_off', 'pad_probe', ['NFSU2_PAD=0'], null, 'pad-rvf-probe-off', 200],
  ['pad_quickrace', 'pad_quickrace', [], null, 'pad-rvf-quickrace', 300],
  ['pad_race', 'pad_race', [], null, 'pad-rvf-race', 300],
  ['pad_fe_buttons', 'pad_fe_buttons', [], null, 'pad-rvf-fe_buttons', 300],
  ['pad_controls', 'pad_controls', [], null, 'pad-rvf-controls', 300],
  ['pad_mixed', 'pad_mixed', [], null, 'pad-rvf-mixed', 600],
  ['pad_throttle', 'pad_throttle', ['PAD_RT=1'], null, 'pad-rvf-throttle', 600],
  ['pad_unplug', 'pad_unplug', [], null, 'pad-rvf-unplug', 300],
  ['pad_late_connect', 'pad_late_connect', [], null, null, 300],
  ['pad_hotplug', 'pad_hotplug', ['NFSU2_PAD=hotplug'], null, 'pad-rvf-hotplug', 300],
  ['pad_hotplug_controls', 'pad_hotplug_controls', ['NFSU2_PAD=hotplug'], null, null, 600],
  ['pad_hotplug_race', 'pad_hotplug_race', ['NFSU2_PAD=hotplug'], null, null, 300],
  // a steering wheel: the game's driving device, its layout and steering; a wheel taking over from a pad and back
  ['pad_wheel_race', 'pad_wheel_race', [], null, null, 300],
  ['pad_wheel_switch', 'pad_wheel_switch', [], null, null, 300],
  ['pad_bind_save', 'pad_bind_save', [], 'pad', 'pad-rvf-bind_save', 400],
  ['pad_bind_load', 'pad_bind_load', [], 'pad', 'pad-rvf-bind_load', 300],
];
const FAULT = /FAULT IN GUEST|GUEST MEMORY FAULT|HOST SEGV|TIME LIMIT REACHED|^\[trap\]|UNRESOLVED INDIRECT|\[expect\] FAIL|TRAP in thread|PAGEERROR|^TIMEOUT/;
// the raw values only: printf spells a NaN's sign differently on wasi-libc ("-nan")
const norm = l => l.replace(/^\[\d+!?\] /, '').replace(/^.*?\] f=\d+ /, '').replace(/\[0x(0[5-9a-f]|1[0-9a-f]|2[0-7])[0-9a-f]{6}\]/g, '[heap]')
  .replace(/ \([^()]*\)$/, '');
const peeks = txt => txt.split('\n').filter(l => /\] f=\d+ (peek|expect)/.test(l)).map(norm);

// --recheck: judge the logs already in <outdir> again, without running anything
const recheck = process.argv.includes('--recheck');
const empty = path.join(out, 'nosteps.json'); fs.writeFileSync(empty, '[]');
const rows = [];
const started = new Set();
for (const [name, script, extra, chain, ref, tmo] of SCEN) {
  if (only.length && !only.includes(name)) continue;
  fs.rmSync(path.join(out, `${name}.diff`), { force: true });
  const prof = chain ? path.join(out, `profile-${chain}`) : null;
  const first = chain && !started.has(chain);
  if (first) { fs.rmSync(prof, { recursive: true, force: true }); started.add(chain); }
  const env = [...ENV, ...extra];
  if (chain && !first) env.push('NFSU2_REGFILE=/save/registry.txt');
  const q = new URLSearchParams();
  q.set('wasm', '/game.wasm'); q.set('pages', '16384'); q.set('arg', '/data/SPEED2.EXE');
  for (const e of env) q.append('env', e);
  q.set('script', `/tests/scripts/${script}.txt`); q.set('save', chain ? `suite-${chain}` : `suite-${name}`);
  if (!chain || first) { q.set('reg', '/tests/web/seed/registry_perf4_native.txt'); q.set('fresh', ''); }
  const url = `${base}/test/${pageName}.html?${q}`;
  const t0 = Date.now();
  const r = recheck ? { stdout: fs.existsSync(path.join(out, `${name}.log`)) ? fs.readFileSync(path.join(out, `${name}.log`), 'utf8') : '' } : spawnSync('node', [path.join(ROOT, 'web/tools/drive.mjs'), url, String(tmo * 1000), empty, ...(prof ? ['--profile', prof] : [])],
    { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, CHROME_ARGS: process.env.CHROME_ARGS ?? '--autoplay-policy=no-user-gesture-required' } });
  const log = (r.stdout ?? '') + (r.stderr ?? '');
  if (recheck && !log) continue;
  if (!recheck) fs.writeFileSync(path.join(out, `${name}.log`), log);
  const exit = /^EXIT (-?\d+)/m.exec(log)?.[1] ?? '-';
  const quit = /quit at guest frame (\d+)/.exec(log)?.[1] ?? '-';
  const faults = log.split('\n').filter(l => FAULT.test(l.replace(/^\[\d+!?\] /, '')));
  const waits = log.split('\n').filter(l => /TIMEOUT \(top=|satisfied/.test(l));
  const wtmo = waits.filter(l => /TIMEOUT/.test(l)).length;
  const mine = peeks(log);
  let cmp = 'no reference';
  if (ref && fs.existsSync(path.join(MAC, ref, 'log.txt'))) {
    const theirs = peeks(fs.readFileSync(path.join(MAC, ref, 'log.txt'), 'utf8'));
    let same = 0; const diffs = [];
    for (let i = 0; i < Math.max(mine.length, theirs.length); i++) {
      if (mine[i] === theirs[i]) same++; else if (diffs.length < 6) diffs.push(`    #${i}: mac ${theirs[i] ?? '-'} | web ${mine[i] ?? '-'}`);
    }
    cmp = `${same}/${Math.max(mine.length, theirs.length)} peeks equal to ${ref}`;
    if (diffs.length) fs.writeFileSync(path.join(out, `${name}.diff`), diffs.join('\n') + '\n');
  }
  const ok = exit === '0' && quit !== '-' && !faults.length && !wtmo;
  rows.push({ name, ok, exit, quit, s: ((Date.now() - t0) / 1000).toFixed(0), faults: faults.length, wtmo, cmp });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(22)} exit=${exit} quit@${quit} ${rows.at(-1).s}s faults=${faults.length} waitTimeouts=${wtmo}  ${cmp}`);
  if (faults.length) console.log('    ' + faults.slice(0, 3).join('\n    '));
  if (fs.existsSync(path.join(out, `${name}.diff`))) console.log(fs.readFileSync(path.join(out, `${name}.diff`), 'utf8').trimEnd());
}
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(rows, null, 1));
console.log(`${rows.filter(r => r.ok).length}/${rows.length} passed`);
