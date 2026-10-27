// The WebGPU renderer, page side.  attachRenderer() finds the control block the
// game's recorder registered (runtime/web/gpu_web.c, HOST_KIND_GPU), and from
// then on:
//   - drains the resource queue (textures, mirror pool, shaders),
//   - takes each handed-off frame (GwCtl.state), encodes it (encoder.ts) into
//     the back buffer at the game's device size, composites that aspect-fit
//     onto the canvas at the canvas's own resolution, and submits;
//   - publishes a display clock from requestAnimationFrame (HOST_KIND_VSYNC)
//     that the game's frame pacer locks to;
//   - reads frames back for the autotest "dump" command and F12 (dump()), as
//     PNGs made in png-worker.ts.
// Triggers: Atomics.waitAsync on the game's doorbell, every rAF, and every
// finished GPU frame.  The main thread never blocks.
import type { GameProcess } from '../host/process';
import { HostKind } from '../host/abi';
import * as P from './proto';
import { C, F } from './proto';
import { Encoder } from './encoder';
import type { FromPng, ToPng } from './png-worker';

export interface RendererOptions {
  /** where frame dumps go: a URL prefix that accepts PUT <prefix><name>.png (the dev server's /artifacts/) */
  artifacts?: string;
  /** scale factor for dumps (the Mac references are 0.3 of 3600x2196) */
  dumpScale?: number;
  /** log every record of these guest frames, or of every dumped frame ('dumps') */
  trace?: number[] | 'dumps';
  /** diagnostics: with every dumped frame also write these textures (level 0, face 0) */
  dumpTex?: number[];
  /** diagnostics: log every create / upload / free of these texture ids */
  watchTex?: number[];
  /** log the WGSL text of every registered module */
  logShaders?: boolean;
  /** measure GPU time per frame with timestamp queries (first pass begin to composite end) */
  gpuTiming?: boolean;
  /** keep canvas.width/height at the element's size in device pixels (the game resets its device to follow) */
  autoSize?: boolean;
  /** most frames the GPU may have queued (default 2) */
  maxInFlight?: number;
  /** false: always draw into the back buffer and composite it (the path before direct
   *  canvas drawing; A/B and diagnostics) */
  direct?: boolean;
  /** unpack DXT textures on the CPU even when the GPU has texture-compression-bc (tests the
   *  path of PowerVR and Mali phones on a desktop GPU) */
  noBC?: boolean;
  /** while a frame waits for a slot, poll the GPU with empty submits (default: in Firefox, whose
   *  onSubmittedWorkDone otherwise waits for its 100 ms poll timer; see pokeLoop) */
  poke?: boolean;
  /** diagnostics: a slower GPU, from a pass of this many iterations of busy work for each pixel
   *  of a 512x512 target in every frame (tests frame pacing on GPUs slower than this one) */
  gpuBurn?: number;
  onFrame?: (frames: number) => void;
  log?: (s: string) => void;
}

export interface RendererStats {
  frames: number; draws: number; passes: number; pipelines: number; pipelinesWarm: number; errors: number;
  /** milliseconds the encoder spent creating pipelines synchronously (total, worst single) */
  pipelineMs: number; pipelineMsMax: number;
  /** GPU time per frame from timestamp queries (gpuTiming), ms: average and worst; 0 when off */
  gpuMsAvg: number; gpuMsMax: number;
  encodeMsAvg: number; encodeMsLast: number; drawsLast: number; passesLast: number;
  rafHz: number; inFlight: number; dumps: number;
  /** draws dropped or changed: target texture missing, sampled texture = current target (drawn white),
   *  Z surface size differs from the target (Z off), vertex shader module missing */
  missingTarget: number; conflicts: number; zMismatch: number; noVs: number;
  /** frames drawn straight into the canvas texture (no composite), and frames that kept the
   *  back buffer because they copied from the screen before drawing to it */
  direct: number; screenReadFirst: number;
  /** frames that waited over 20 ms for a slot (every one taken by frames the GPU had not reported
   *  done), the longest such wait in ms, and the empty submits sent while frames waited (poke) */
  slotWaits: number; slotWaitMsMax: number; pokes: number;
}

/** Per-frame distributions since the last reset (the perf benchmark's race window). */
export interface RendererWindow {
  frames: number;
  /** page-thread encode time per frame, ms: p50, p95, p99, max */
  encodeMs: number[];
  /** GPU time per frame (gpuTiming), ms: p50, p95, p99, max; empty when off */
  gpuMs: number[];
  drawsAvg: number; passesAvg: number;
  /** WebGPU calls per frame by kind (Encoder.calls) */
  callsAvg: Record<string, number>;
}

export interface Renderer {
  readonly device: GPUDevice;
  stats(): RendererStats;
  /** read the back buffer of the next encoded frame as PNG; with opts.artifacts it is also
   *  uploaded as <name>.png (an autotest dump falling on the same frame keeps its own name) */
  dump(name: string): Promise<Blob>;
  /** distributions of the frames since the last call with reset (or since attach) */
  window(reset?: boolean): RendererWindow;
  /** each frame's time from its submit until the GPU had done it (onSubmittedWorkDone, so every
   *  browser has it, timestamp queries or not), ms, since the last call; at most 4096 */
  doneMs(): number[];
  /** wait for pending dumps */
  flush(): Promise<void>;
  /** where the game's image was last composited in the canvas, in canvas pixels
   *  (aspect-fit: the rest is black); the whole canvas before the first frame */
  imageRect(): { x: number; y: number; w: number; h: number };
  /** Stop for good: the loops end, the GPU device is destroyed and the game drops back to
   *  the null renderer at its next present (no wait).  The control block never takes a
   *  renderer again: a new one would lack every texture and shader queued before it, so
   *  showing the game again needs a new game process. */
  detach(): void;
}

export async function attachRenderer(proc: GameProcess, canvas: HTMLCanvasElement, opts: RendererOptions = {}): Promise<Renderer> {
  const log = opts.log ?? ((s: string) => console.log(s));
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter');
  // without BC the encoder unpacks the DXT textures as they upload (dxt.ts)
  const bc = adapter.features.has('texture-compression-bc') && !opts.noBC;
  if (!bc) log(`[gpu] ${opts.noBC ? 'noBC' : 'no texture-compression-bc'}: DXT textures are unpacked to BGRA8 as they upload`);
  const want: GPUFeatureName[] = bc ? ['texture-compression-bc'] : [];
  for (const f of ['texture-component-swizzle', 'texture-compression-unaligned', 'timestamp-query'])
    if (adapter.features.has(f as GPUFeatureName)) want.push(f as GPUFeatureName);
  const device = await adapter.requestDevice({ requiredFeatures: want, requiredLimits: {
    maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } });
  let errors = 0;
  const onError = (e: Event) => {
    errors++;
    if (errors <= 20) log(`[gpu] WebGPU error: ${(e as GPUUncapturedErrorEvent).error.message}`);
  };
  device.addEventListener('uncapturederror', onError);
  device.lost.then(i => { if (i.reason !== 'destroyed') log(`[gpu] device lost: ${i.reason} ${i.message}`); });
  // Until the renderer holds the control block, every way out gives the device
  // and the canvas back (a game stopped before it registered its blocks included).
  let configured: GPUCanvasContext | null = null;
  const giveUp: (e: unknown) => never = (e) => {
    try { configured?.unconfigure(); } catch { /* not configured */ }
    device.removeEventListener('uncapturederror', onError);
    device.destroy();
    throw e;
  };

  const ctx = canvas.getContext('webgpu') ?? giveUp(new Error('no webgpu canvas context'));
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  // in the encoder's format the game draws its screen straight into the canvas
  // texture whenever the sizes match (Encoder.encodeFrame), so the canvas texture
  // takes every use the back buffer has
  const direct = canvasFormat === 'bgra8unorm' && opts.direct !== false;
  const canvasUsage = GPUTextureUsage.RENDER_ATTACHMENT
    | (direct ? GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST : 0);
  try { ctx.configure({ device, format: canvasFormat, alphaMode: 'opaque', usage: canvasUsage }); }
  catch (e) { giveUp(e); }
  configured = ctx;

  // a game that ends (exit, crash, Stop) before it registers its blocks never
  // will: the wait ends with it
  const untilExit = <T>(p: Promise<T>) => Promise.race([p,
    proc.exited.then((code): never => { throw new Error(`the game ended (code ${code}) before it registered its graphics`); })]);
  const [reg, vreg] = await Promise.all([untilExit(proc.registered(HostKind.Gpu)), untilExit(proc.registered(HostKind.Vsync))]).catch(giveUp);
  const mem = proc.memory;
  const i32 = () => new Int32Array(mem.buffer), u32 = () => new Uint32Array(mem.buffer);
  const cw = reg.ptr >> 2;
  {
    const u = u32();
    if (u[cw + C.magic] !== P.GW_MAGIC || u[cw + C.layout] !== P.LAYOUT)
      giveUp(new Error(`GPU control block mismatch: magic ${u[cw + C.magic].toString(16)} layout ${u[cw + C.layout].toString(16)} (page ${P.LAYOUT.toString(16)})`));
    // one renderer per control block, ever: a second one (or one after a detach) would
    // not have the textures and shaders queued before it.  The game marks the block
    // detached itself when it stopped waiting for a renderer (30 s, gpu_web.c)
    const was = Atomics.load(i32(), cw + C.attached);
    if (was !== 0)
      giveUp(new Error(`this game process ${was === P.DETACHED ? 'takes no renderer any more (one detached, or the game stopped waiting for one)' : 'already has a renderer'}: start a new game to show it again`));
  }
  let enc: Encoder;
  try { enc = new Encoder(device, mem, reg.ptr, log); } catch (e) { giveUp(e); }
  enc.logShaders = !!opts.logShaders;
  for (const id of opts.watchTex ?? []) enc.watchTex.add(id);
  if (opts.trace === 'dumps') enc.traceDumps = true; else for (const f of opts.trace ?? []) enc.traceSeq.add(f);
  // pipelines of earlier sessions, created asynchronously as their shaders arrive
  const WARM_KEY = 'nfsu2.gpu.pipelines.v1';
  try { const j = localStorage.getItem(WARM_KEY); if (j) enc.loadWarm(JSON.parse(j)); } catch { /* storage off: no warm-up */ }
  const vw = vreg.ptr >> 2, vf = vreg.ptr >> 3;

  // page -> game: view size, pixel ratio, features
  const publishView = () => {
    const u = u32();
    u[cw + C.viewW] = canvas.width; u[cw + C.viewH] = canvas.height;
    u[cw + C.dpr1000] = Math.round(devicePixelRatio * 1000);
    u[cw + C.features] = P.FEAT_BC | (device.features.has('texture-component-swizzle') ? P.FEAT_SWIZZLE : 0);
  };
  publishView();
  const won = Atomics.compareExchange(i32(), cw + C.attached, 0, P.ATTACHED);
  if (won !== 0)
    giveUp(new Error(won === P.DETACHED ? 'the game stopped waiting for a renderer just now: start a new game to show it'
      : 'another renderer attached to this game process first'));
  Atomics.notify(i32(), cw + C.attached);
  const warmTimer = setInterval(() => {
    if (!enc.warmDirty) return;
    try { localStorage.setItem(WARM_KEY, JSON.stringify(enc.warmEntries().slice(-4000))); } catch { /* full or off */ }
  }, 5000);
  const maxInFlight = opts.maxInFlight ?? 2;
  let imgRect: { x: number; y: number; w: number; h: number } | null = null;
  let inFlight = 0, alive = true, pumping = false;
  let frames = 0, encMsTotal = 0, encMsLast = 0, drawsLast = 0, passesLast = 0, directFrames = 0;
  // the benchmark window (Renderer.window): per-frame samples, bounded
  const WIN_MAX = 1 << 17;
  let winEnc: number[] = [], winGpu: number[] = [], winDraws = 0, winPasses = 0, winCalls = { ...enc.calls };
  let done: number[] = [];
  const dumpWaiters: { name: string; resolve: (b: Blob) => void }[] = [];
  const pending = new Set<Promise<unknown>>();
  const waitAsync = (Atomics as unknown as { waitAsync(a: Int32Array, i: number, v: number, t?: number):
    { async: boolean; value: Promise<string> | string } }).waitAsync;

  // A frame waiting for a slot.  Firefox runs onSubmittedWorkDone callbacks only when its GPU
  // process polls the device: in every queue submit, and otherwise on a 100 ms timer
  // (WebGPUParent POLL_TIME_MS).  A frame submitted while the one before it was still on the GPU
  // leaves that one unreported, and the next frame then waits for the timer: two frames per
  // 100 ms.  The game, late from then on, hands its frames over back to back, so it stays at
  // 20-30 fps until the queue empties (a minimized window).  An empty submit polls as well
  // (wgpu-core's Queue::submit runs Device::maintain), so while a frame waits the pump sends one
  // at once and then every 1-2 ms (Firefox's Atomics.waitAsync times out that finely; its
  // setTimeout takes 4.5 ms).  Chrome reports done work on its own: no pokes there.
  const poke = opts.poke ?? /\bFirefox\//.test(navigator.userAgent);
  const pokeCell = new Int32Array(new SharedArrayBuffer(4));
  let waitingSince = 0, poking = false, slotWaits = 0, slotWaitMsMax = 0, pokes = 0;
  let winWaits = 0, winWaitMax = 0, winWaitT = performance.now();
  // Firefox names no adapter (the start page's GPU check names its graphics)
  const named = [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(' ') || 'adapter not named';
  log(`[gpu] renderer attached: ${named}, canvas ${canvas.width}x${canvas.height} ${canvasFormat}, features ${want.join(' ')}${poke ? ', poke' : ''}`);
  const pokeLoop = async () => {
    if (poking) return;
    poking = true;
    try {
      while (alive && waitingSince) {
        device.queue.submit([]); pokes++;
        const w = waitAsync(pokeCell, 0, 0, 1);
        if (w.async) await w.value;
      }
    } finally { poking = false; }
  };
  const waiting = (on: boolean) => {
    const now = performance.now();
    if (on && !waitingSince) { waitingSince = now; if (poke) void pokeLoop(); }
    else if (!on && waitingSince) {
      const ms = now - waitingSince;
      waitingSince = 0;
      if (ms > 20) { slotWaits++; winWaits++; if (ms > slotWaitMsMax) slotWaitMsMax = ms; if (ms > winWaitMax) winWaitMax = ms; }
    }
    // frames held up for the GPU go to the log, at most every 30 s
    if (winWaits && now - winWaitT > 30_000) {
      log(`[gpu] ${winWaits} frame(s) waited over 20 ms for the GPU in the last ${((now - winWaitT) / 1000).toFixed(0)} s, ` +
          `the longest ${winWaitMax.toFixed(0)} ms (${frames} frames, ${pokes} pokes${poke ? '' : ', poke off'})`);
      winWaits = 0; winWaitMax = 0; winWaitT = now;
    } else if (!winWaits) winWaitT = now;
  };

  const pump = () => {
    if (!alive || pumping) return;
    pumping = true;
    try {
      for (;;) {
        enc.views();
        const I = i32(), U = u32();
        // the queue head before the state: a frame published after this read has
        // rq_end >= head, so draining to head never applies a later frame's uploads
        const head = Atomics.load(I, cw + C.rqHead) >>> 0;
        const s = Atomics.load(I, cw + C.state), r = s & 3, e = (s >> 2) & 3;
        // a pending frame: its resources first, nothing recorded after it
        const limit = r && !e ? U[cw + C.frame + (r - 1) * (P.FRAME_BYTES >> 2) + F.rqEnd] : head;
        enc.drain(limit);
        waiting(!!r && !e && inFlight >= maxInFlight);
        if (!r || e || inFlight >= maxInFlight) break;
        if (Atomics.compareExchange(I, cw + C.state, s, s | (r << 2)) !== s) continue;
        try { encodeAndSubmit(r - 1); }
        catch (x) { errors++; log(`[gpu] encode failed: ${(x as Error).stack ?? x}`); }
        Atomics.store(I, cw + C.state, 0); Atomics.notify(I, cw + C.state);
      }
    } finally { pumping = false; }
  };

  // gpuBurn: busy work in every frame's command buffer
  let burn: ((ce: GPUCommandEncoder) => void) | null = null;
  if (opts.gpuBurn) {
    const m = device.createShaderModule({ code: `override N: u32 = 1u;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  var x = p.x * 0.001 + p.y;
  for (var k = 0u; k < N; k++) { x = fract(sin(x) * 43758.5453 + 0.37); }
  return vec4f(x, 0.0, 0.0, 1.0);
}` });
    const pipe = device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' },
      fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }], constants: { N: opts.gpuBurn } } });
    const view = device.createTexture({ size: [512, 512], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT }).createView();
    burn = ce => {
      const p = ce.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
      p.setPipeline(pipe); p.draw(3); p.end();
    };
    log(`[gpu] gpuBurn ${opts.gpuBurn}: busy work in every frame`);
  }

  // GPU timing: a ring of query pairs, each resolved into its own mappable buffer
  const timing = opts.gpuTiming && device.features.has('timestamp-query');
  const TQ = 8;
  const qs = timing ? device.createQuerySet({ type: 'timestamp', count: 2 * TQ }) : null;
  const qResolve = timing ? device.createBuffer({ size: 256 * TQ, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
  const qRead: GPUBuffer[] = [], qBusy: boolean[] = [];
  for (let i = 0; timing && i < TQ; i++) { qRead.push(device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })); qBusy.push(false); }
  let qNext = 0, gpuMsTotal = 0, gpuMsN = 0, gpuMsMax = 0;
  let tsTarget: GPUTextureView | null = null;
  const tsView = () => tsTarget ??= device.createTexture({ size: [1, 1], format: 'bgra8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT }).createView();

  const encodeAndSubmit = (b: number) => {
    const t0 = performance.now();
    const ce = device.createCommandEncoder();
    const slot = timing && !qBusy[qNext] ? qNext : -1;
    if (slot >= 0) { qNext = (qNext + 1) % TQ; enc.firstPassTs = { querySet: qs!, beginningOfPassWriteIndex: 2 * slot }; }
    const cur = ctx.getCurrentTexture();
    const st = enc.encodeFrame(b, ce, direct ? cur : undefined);
    burn?.(ce);
    const scr = enc.screen!;   // the canvas texture itself, or the back buffer
    const tsEnd: GPURenderPassTimestampWrites | undefined = slot >= 0 ? { querySet: qs!, endOfPassWriteIndex: 2 * slot + 1 } : undefined;
    if (slot >= 0 && enc.firstPassTs) {   // the frame had no render pass: time the composite alone
      enc.firstPassTs = undefined; tsEnd!.beginningOfPassWriteIndex = 2 * slot;
    }
    if (st.direct) {
      // the screen is already in the canvas texture
      directFrames++;
      imgRect = { x: 0, y: 0, w: cur.width, h: cur.height };
      // GPU timing ends with a pass of its own that reads one texel of the screen, so it
      // waits for every pass that drew there (a pass without that dependency may run early)
      if (tsEnd) enc.copyQuad(ce, cur.createView(), tsView(), 'bgra8unorm', nearest, undefined, true, tsEnd);
    } else {
      // composite: the back buffer aspect-fit into the canvas at its own resolution
      const cvw = cur.width, cvh = cur.height;
      const sc = Math.min(cvw / scr.width, cvh / scr.height);
      const w = Math.round(scr.width * sc), h = Math.round(scr.height * sc);
      const one = w === scr.width && h === scr.height;
      const rect: [number, number, number, number] = [Math.floor((cvw - w) / 2), Math.floor((cvh - h) / 2), w, h];
      imgRect = { x: rect[0], y: rect[1], w, h };
      enc.copyQuad(ce, scr.createView(), cur.createView(), canvasFormat, one ? nearest : linear, rect, true, tsEnd);
    }
    if (slot >= 0) {
      ce.resolveQuerySet(qs!, 2 * slot, 2, qResolve!, 256 * slot);     // resolve offsets are 256-aligned
      ce.copyBufferToBuffer(qResolve!, 256 * slot, qRead[slot], 0, 16);
    }
    // autotest dump or a dump() request: read this frame's back buffer
    const U = u32(), fw = cw + C.frame + b * (P.FRAME_BYTES >> 2);
    let dumpName: string | null = null;
    if (U[fw + F.dump]) {
      const lab = new TextDecoder().decode(new Uint8Array(mem.buffer).slice((fw + F.dumpLabel) * 4, (fw + F.dumpLabel) * 4 + 64)).replace(/\0.*$/s, '');
      dumpName = `nfsu2_g${String(U[fw + F.dumpFrame]).padStart(6, '0')}_${lab}`;
    }
    const waiter = dumpWaiters.shift();
    const reads: { name: string | null; rb: Readback; waiter?: (b: Blob) => void }[] = [];
    // an autotest dump keeps its frame-numbered name; a dump(name) request names its own
    if (dumpName || waiter) reads.push({ name: dumpName ?? waiter!.name, rb: copyOut(ce, scr), waiter: waiter?.resolve });
    if (dumpName) for (const id of opts.dumpTex ?? []) {
      const sn = enc.snapshot(ce, id);
      if (sn) { log(`[gpu] dump texture ${id}: ${sn.info}`); reads.push({ name: `${dumpName}_tex${id}`, rb: copyOut(ce, sn.tex) }); }
    }
    device.queue.submit([ce.finish()]);
    enc.afterSubmit();
    if (slot >= 0) {
      qBusy[slot] = true;
      qRead[slot].mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigUint64Array(qRead[slot].getMappedRange());
        const ms = Number(t[1] - t[0]) / 1e6;
        qRead[slot].unmap(); qBusy[slot] = false;
        if (ms > 0 && ms < 1000) { gpuMsTotal += ms; gpuMsN++; if (ms > gpuMsMax) gpuMsMax = ms; if (winGpu.length < WIN_MAX) winGpu.push(ms); }
      }).catch(() => { qBusy[slot] = false; });
    }
    inFlight++;
    const tSub = performance.now();
    device.queue.onSubmittedWorkDone().then(() => {
      inFlight--;
      if (done.length < 4096) done.push(performance.now() - tSub);
      pump();
    });
    const ms = performance.now() - t0;
    frames++; encMsTotal += ms; encMsLast = ms; drawsLast = st.draws; passesLast = st.passes;
    opts.onFrame?.(frames);
    if (winEnc.length < WIN_MAX) { winEnc.push(ms); winDraws += st.draws; winPasses += st.passes; }
    const C2 = u32();
    C2[cw + C.framesDone] = frames; C2[cw + C.stDraws] = enc.totalDraws >>> 0; C2[cw + C.stPasses] = enc.totalPasses >>> 0;
    C2[cw + C.stEncUs] = Math.round(encMsTotal * 1000) >>> 0; C2[cw + C.stErrors] = errors; C2[cw + C.stPipelines] = enc.pipelinesMade;
    for (const r of reads) {
      const job = readback(r.rb).then(async png => {
        r.waiter?.(png);
        if (!r.name) return;
        let where = '';
        if (opts.artifacts) {
          const res = await fetch(`${opts.artifacts}${r.name}.png`, { method: 'PUT', body: png });
          where = res.ok ? ` -> ${opts.artifacts}${r.name}.png` : ` (upload failed: ${res.status})`;
        }
        log(`[gpu] dump ${r.name}.png ${r.rb.w}x${r.rb.h}${where}`);
        if (r.name === dumpName) { const C3 = u32(); C3[cw + C.dumpsDone]++; }
      }).catch(x => log(`[gpu] dump failed: ${x}`));
      pending.add(job); job.finally(() => pending.delete(job));
    }
  };

  type Readback = { buf: GPUBuffer; w: number; h: number; bpr: number };
  const copyOut = (ce: GPUCommandEncoder, t: GPUTexture): Readback => {
    const bpr = Math.ceil(t.width * 4 / 256) * 256;
    const buf = device.createBuffer({ size: bpr * t.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    ce.copyTextureToBuffer({ texture: t }, { buffer: buf, bytesPerRow: bpr }, [t.width, t.height, 1]);
    return { buf, w: t.width, h: t.height, bpr };
  };

  const linear = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const nearest = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' });

  // the PNG is made in a worker (png-worker.ts), started at the first dump: here the frame is only copied out
  let pngWorker: Worker | null = null, pngNext = 0;
  const pngWaiting = new Map<number, { resolve: (b: Blob) => void; reject: (e: Error) => void }>();
  async function readback(rb: Readback): Promise<Blob> {
    await rb.buf.mapAsync(GPUMapMode.READ);
    const px = rb.buf.getMappedRange().slice(0);
    rb.buf.unmap(); rb.buf.destroy();
    if (!pngWorker) {
      const w = pngWorker = new Worker(new URL('/gpu/png-worker.js', import.meta.url), { type: 'module', name: 'png' });
      w.onmessage = (e: MessageEvent<FromPng>) => {
        const p = pngWaiting.get(e.data.id);
        pngWaiting.delete(e.data.id);
        if ('png' in e.data) p?.resolve(e.data.png); else p?.reject(new Error(e.data.error));
      };
      w.onerror = e => { for (const p of pngWaiting.values()) p.reject(new Error(e.message || 'the PNG worker failed')); pngWaiting.clear(); };
    }
    const id = pngNext++, msg: ToPng = { id, px, w: rb.w, h: rb.h, bpr: rb.bpr, scale: opts.dumpScale ?? 1 };
    return new Promise((resolve, reject) => {
      pngWaiting.set(id, { resolve, reject });
      pngWorker!.postMessage(msg, [px]);
    });
  }

  // ---- display clock (rAF) ----
  // The refresh rate is the median rAF interval, snapped to a standard rate
  // (rAF timestamps jitter by a few tenths of a millisecond) and changed only
  // after holding for half a second, as metal.m does with the display link.
  const RATES = [24, 30, 48, 50, 60, 72, 75, 90, 96, 100, 120, 144, 165, 180, 240, 360];
  const snap = (hzRaw: number) => { for (const r of RATES) if (Math.abs(hzRaw / r - 1) < 0.025) return r; return Math.round(hzRaw); };
  const iv: number[] = [];
  let lastT = 0, hz = 0, cand = 0, candSince = 0, rafHz = 0, rafId = 0;
  const raf = (t: number) => {
    if (!alive) return;
    if (lastT) {
      const d = t - lastT;
      if (d > 2 && d < 100) { iv.push(d); if (iv.length > 120) iv.shift(); }
    }
    lastT = t;
    if (iv.length >= 30) {
      const sorted = iv.slice().sort((a, b) => a - b), med = sorted[sorted.length >> 1];
      rafHz = 1000 / med;
      const h = snap(rafHz);
      if (h !== cand) { cand = h; candSince = t; }
      if (cand !== hz && (hz === 0 || t - candSince >= 500)) {
        log(`[gpu] display ${cand} Hz (rAF median ${med.toFixed(3)} ms)`);
        hz = cand; Atomics.store(i32(), vw + P.V.hz, hz);
      }
      // nominal period of the snapped rate, like CADisplayLink.duration;
      // the game measures the real period from the timestamps itself
      const per = RATES.includes(hz) ? 1000 / hz : med;
      const I = i32(), Fv = new Float64Array(mem.buffer);
      Atomics.add(I, vw + P.V.seq, 1);
      Fv[vf + P.V.tsF64] = performance.timeOrigin + t; Fv[vf + P.V.periodF64] = per;
      Atomics.add(I, vw + P.V.seq, 1);
      Atomics.store(I, vw + P.V.visible, document.visibilityState === 'visible' ? 1 : 0);
      Atomics.add(I, vw + P.V.tick, 1); Atomics.notify(I, vw + P.V.tick);
    }
    pump();
    rafId = requestAnimationFrame(raf);
  };
  rafId = requestAnimationFrame(raf);

  // ---- doorbell: the game rings it on every handoff and queue flush ----
  (async () => {
    while (alive) {
      const I = i32(), b = Atomics.load(I, cw + C.bell);
      pump();
      const w = waitAsync(I, cw + C.bell, b, 500);
      if (w.async) await w.value;
    }
  })();

  // canvas size: the page's choice, or with autoSize the element's size in
  // device pixels (devicePixelContentBoxSize: exact, follows zoom and screens)
  const ro = new ResizeObserver(entries => {
    if (opts.autoSize) for (const e of entries) {
      const d = e.devicePixelContentBoxSize?.[0];
      const w = d ? d.inlineSize : Math.round(e.contentRect.width * devicePixelRatio);
      const h = d ? d.blockSize : Math.round(e.contentRect.height * devicePixelRatio);
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; }
    }
    publishView();
  });
  try { ro.observe(canvas, { box: 'device-pixel-content-box' }); } catch { ro.observe(canvas); }

  return {
    device,
    stats: () => ({ frames, draws: enc.totalDraws, passes: enc.totalPasses, pipelines: enc.pipelinesMade, pipelinesWarm: enc.pipelinesAsync, errors,
      pipelineMs: enc.pipeMs, pipelineMsMax: enc.pipeMsMax, gpuMsAvg: gpuMsN ? gpuMsTotal / gpuMsN : 0, gpuMsMax,
      encodeMsAvg: frames ? encMsTotal / frames : 0, encodeMsLast: encMsLast, drawsLast, passesLast, rafHz, inFlight,
      dumps: u32()[cw + C.dumpsDone], missingTarget: enc.missingTarget, conflicts: enc.conflicts, zMismatch: enc.zMismatch, noVs: enc.noVs,
      direct: directFrames, screenReadFirst: enc.screenReadFirst, slotWaits, slotWaitMsMax, pokes }),
    window: (reset = false) => {
      const pct = (a: number[]) => {
        if (!a.length) return [];
        const s = a.slice().sort((x, y) => x - y), q = (p: number) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
        return [q(0.5), q(0.95), q(0.99), s[s.length - 1]];
      };
      const n = winEnc.length;
      const callsAvg: Record<string, number> = {};
      for (const [k, v] of Object.entries(enc.calls)) callsAvg[k] = n ? +((v - winCalls[k as keyof typeof winCalls]) / n).toFixed(1) : 0;
      const w: RendererWindow = { frames: n, encodeMs: pct(winEnc), gpuMs: pct(winGpu), drawsAvg: n ? winDraws / n : 0, passesAvg: n ? winPasses / n : 0, callsAvg };
      if (reset) { winEnc = []; winGpu = []; winDraws = 0; winPasses = 0; winCalls = { ...enc.calls }; }
      return w;
    },
    doneMs: () => { const d = done; done = []; return d; },
    dump: (name: string) => new Promise<Blob>(resolve => dumpWaiters.push({ name, resolve })),
    imageRect: () => imgRect ?? { x: 0, y: 0, w: canvas.width, h: canvas.height },
    flush: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      if (enc.warmDirty) try { localStorage.setItem(WARM_KEY, JSON.stringify(enc.warmEntries().slice(-4000))); } catch { /* full or off */ }
    },
    detach: () => {
      if (!alive) return;
      alive = false; cancelAnimationFrame(rafId); clearInterval(warmTimer); ro.disconnect();
      if (enc.warmDirty) try { localStorage.setItem(WARM_KEY, JSON.stringify(enc.warmEntries().slice(-4000))); } catch { /* full or off */ }
      // the game stops recording at its next present instead of waiting for a page
      // that is gone; a waiting present or a full resource queue wakes now
      const I = i32();
      Atomics.store(I, cw + C.attached, P.DETACHED);
      for (const w of [C.attached, C.state, C.rqTail, C.bell]) Atomics.notify(I, cw + w);
      for (const d of dumpWaiters.splice(0)) d.resolve(new Blob([], { type: 'image/png' }));
      // a PNG the worker is making still comes (a screenshot taken just before the game ended)
      void Promise.allSettled([...pending]).then(() => pngWorker?.terminate());
      try { ctx.unconfigure(); } catch { /* already gone */ }
      device.removeEventListener('uncapturederror', onError);
      device.destroy();
      log(`[gpu] renderer detached after ${frames} frames`);
    },
  };
}
