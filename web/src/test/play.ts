// Test page with the WebGPU renderer: runs the game (?wasm=/game.wasm) through
// the real host and draws it on a canvas.  Same parameters as hostcheck.ts,
// plus:
//   w, h        canvas size in device pixels (default 1280x720); the game's
//               "native" display row follows it
//   artifacts   URL prefix for frame dumps (PUT), e.g. /artifacts/ when the
//               server runs with --artifacts <dir>
//   dumpscale   scale of the dump PNGs (0.6 of 1800x1098 = the Mac references' 1080x658)
//   trace       log every record of these guest frames (comma list), or "dumps" for every dumped frame
//   shaders     log the WGSL of every registered shader module
//   dumptex     with every dump also write these texture ids (comma list)
//   watchtex    log every create / upload / free of these texture ids
//   resizeat    <seconds>:<w>x<h>: resize the canvas then (tests the device reset that follows)
//   gputime     measure GPU time per frame with timestamp queries (in the stats)
//   bc=0        unpack the DXT textures on the CPU, as on a GPU without texture-compression-bc
//   poke=0|1    while a frame waits for the GPU, poll it with empty submits (default: in Firefox)
//   gpuburn     <iterations>: busy GPU work in every frame, a slower GPU (RendererOptions.gpuBurn)
//   detachat    <seconds>: detach the renderer then (the game drops to the null
//               renderer at its next present), and try to attach a second one
//   net         attach the virtual LAN under this player name (free roam, LAN play: web/src/net)
//   bench       the perf benchmark (web/tools/bench.mjs): renderer distributions
//               between the script's "log race_loaded" and "log drive_end"
//               lines, printed as one "[bench] renderer {json}" line, and the race load
//               time (the loading screen to the race)
// When the game exits the title becomes DONE (web/tools/run-page.mjs waits for it).
import { startProcess } from '../host/process';
import { attachRenderer, type Renderer } from '../gpu/index';
import { attachNet } from '../net/index';
import { attachInput, type InputHandle } from '../input/index';
const q = new URLSearchParams(location.search);
const log = (s: string) => console.log(s);
const W = +(q.get('w') ?? 1280), H = +(q.get('h') ?? 720);
document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
const canvas = document.createElement('canvas');
canvas.width = W; canvas.height = H;
canvas.style.cssText = `width:${W / devicePixelRatio}px;height:${H / devicePixelRatio}px;display:block`;
document.body.append(canvas);

const loader = document.createElement('div');
loader.id = 'loader';
loader.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle at center, #111a24 0%, #05080c 100%);color:#fff;font-family:system-ui,sans-serif;z-index:999;transition:opacity 0.4s ease-out;';
loader.innerHTML = `
  <div style="width:48px;height:48px;border:4px solid rgba(0,212,255,0.2);border-top-color:#00d4ff;border-radius:50%;animation:loader-spin 0.9s linear infinite;margin-bottom:20px;"></div>
  <style>@keyframes loader-spin{to{transform:rotate(360deg)}}</style>
  <div style="font-size:24px;font-weight:900;letter-spacing:2px;color:#00d4ff;margin-bottom:10px;text-shadow:0 0 15px rgba(0,212,255,0.6);">NEED FOR SPEED: UNDERGROUND</div>
  <div id="loader-desc" style="font-size:14px;color:#8fa0b0;">Baixando e compilando WebAssembly (110 MB)...</div>
`;
document.body.append(loader);

const t0 = performance.now();
const mod = await WebAssembly.compileStreaming(fetch(q.get('wasm') ?? '/game.wasm'));
log(`compiled in ${(performance.now() - t0).toFixed(0)} ms`);
const desc = document.getElementById('loader-desc');
if (desc) desc.textContent = 'Inicializando emulador e carregando arquivos...';
const saveDir = q.get('save') ?? 'save-play';
if (q.has('fresh')) {
  const root = await navigator.storage.getDirectory();
  for await (const [name] of (root as any).entries()) if (name === saveDir) await root.removeEntry(name, { recursive: true });
}
async function preload(url: string, name: string) {
  const txt = await (await fetch(url, { cache: 'no-store' })).text();
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(saveDir, { create: true });
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(txt); await w.close();
}
const env: Record<string, string> = { NFSU2_RENDERER: 'webgpu', NFSU2_WIDTH: String(W), NFSU2_HEIGHT: String(H) };
if (q.get('reg')) { await preload(q.get('reg')!, 'registry.txt'); env.NFSU2_REGFILE = '/save/registry.txt'; }
if (q.get('script')) { await preload(q.get('script')!, 'autotest-script.txt'); env.NFSU2_INPUT_SCRIPT = '/save/autotest-script.txt'; }
for (const e of q.getAll('env')) env[e.slice(0, e.indexOf('='))] = e.slice(e.indexOf('=') + 1);
const bench = q.has('bench');
let loadT0 = 0;
let r: Renderer | null = null;
const p = await startProcess({
  module: mod, pool: +(q.get('pool') ?? 24), initialPages: q.get('pages') ? +q.get('pages')! : undefined,
  cfg: { args: ['nfsu1', ...q.getAll('arg')], env: { HOME: '/save', NFSU2_DATA: '/data', ...env }, dataBase: '/data/', manifestUrl: '/data-manifest', saveDir },
  onNote: log,
  onLog: (s, fd, tid) => {
    log(`[${tid}${fd === 2 ? '!' : ''}] ${s}`);
    if (bench && s.includes('tapuntil PC_Loading.fng satisfied')) loadT0 = performance.now();
    if (bench && s.includes(' LOG race_loaded') && loadT0) log(`[bench] race load ${(performance.now() - loadT0).toFixed(0)} ms`);
    if (bench && r && s.includes(' LOG race_loaded')) r.window(true);
    if (bench && r && s.includes(' LOG drive_end')) log(`[bench] renderer ${JSON.stringify(r.window(true))}`);
  },
});
(globalThis as any).nfsu2Proc = p;
const net = q.has('net') ? attachNet(p, { name: q.get('net') || 'player', log }) : null;
(globalThis as any).nfsu2Net = net;
let input: InputHandle | null = null;
if (q.get('input') !== '0') {
  input = attachInput(p, canvas, { log });
  (globalThis as any).nfsu2Input = input;
}
try {
  const trace = q.get('trace');
  r = await attachRenderer(p, canvas, { artifacts: q.get('artifacts') ?? undefined, dumpScale: q.get('dumpscale') ? +q.get('dumpscale')! : undefined, log,
    trace: trace === 'dumps' ? 'dumps' : trace ? trace.split(',').map(Number) : undefined, logShaders: q.has('shaders'),
    dumpTex: q.get('dumptex') ? q.get('dumptex')!.split(',').map(Number) : undefined,
    watchTex: q.get('watchtex') ? q.get('watchtex')!.split(',').map(Number) : undefined, gpuTiming: q.has('gputime'),
    direct: q.get('direct') !== '0', noBC: q.get('bc') === '0', poke: q.has('poke') ? q.get('poke') !== '0' : undefined,
    onFrame: (frames: number) => {
      if (frames === 1 && loader.parentElement) {
        loader.style.opacity = '0';
        setTimeout(() => loader.remove(), 400);
      }
    },
    gpuBurn: +(q.get('gpuburn') ?? 0) });
} catch (x) { log(`renderer: ${x}`); }
const rz = /^(\d+(?:\.\d+)?):(\d+)x(\d+)$/.exec(q.get('resizeat') ?? '');
if (rz) setTimeout(() => {
  canvas.width = +rz[2]; canvas.height = +rz[3];
  canvas.style.width = `${+rz[2] / devicePixelRatio}px`; canvas.style.height = `${+rz[3] / devicePixelRatio}px`;
  log(`[play] canvas resized to ${rz[2]}x${rz[3]}`);
}, +rz[1] * 1000);
const da = +(q.get('detachat') ?? 0);
if (da > 0) setTimeout(async () => {
  if (!r) return;
  const before = r.stats().frames;
  log(`[play] detach at ${((performance.now() - t0) / 1000).toFixed(1)} s after ${before} frames`);
  r.detach(); r = null;
  // one renderer per control block: a second attach is refused
  try { await attachRenderer(p, canvas, { log }); log('[play] second attach: accepted (unexpected)'); }
  catch (x) { log(`[play] second attach refused: ${(x as Error).message}`); }
}, da * 1000);
const statTimer = setInterval(() => {
  if (!r) return;
  const s = r.stats();
  log(`[gpu] ${s.frames} frames, last ${s.drawsLast} draws ${s.passesLast} passes ${s.encodeMsLast.toFixed(2)} ms, avg encode ${s.encodeMsAvg.toFixed(2)} ms${s.gpuMsAvg ? `, GPU ${s.gpuMsAvg.toFixed(2)} ms avg ${s.gpuMsMax.toFixed(2)} max` : ''}, rAF ${s.rafHz.toFixed(1)} Hz, ${s.pipelines} pipelines, ${s.errors} errors, ${s.slotWaits} slot waits (longest ${s.slotWaitMsMax.toFixed(0)} ms), ${s.pokes} pokes`);
}, 10000);
const code = await p.exited;
clearInterval(statTimer);
input?.detach();
if (r) { await r.flush(); const s = r.stats(); log(`[gpu] final: ${JSON.stringify(s)}`); }
if (net) log(`NET ${JSON.stringify(net.stats())}`);
log(`EXIT ${code}`); document.title = 'DONE';
