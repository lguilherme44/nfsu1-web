// The horns of runtime/horn.c on the start page: Settings' Listen button next to "Your horn" (settings-ui.ts) plays
// the one picked, as the player hears their own in the game (in the middle, at its own level), held for a moment (a
// tune once through) and let go.
//
// A port of horn.c's kinds and of its mixer's voice, as settings.ts is of bundle.m's table: the page is built
// without a C compiler (web/server-rs/Dockerfile), so it cannot take horn.c itself.  web/test/horn-preview.test.mjs
// renders every kind with horn.c (built for wasm, tests/horn_render.c) and with renderHorn below, block for block
// as the game drives the mixer, and fails when they differ: a change to a horn goes into both.  What only another
// player's horn has (distance, side, Doppler) and the game's choice of voices are not here, nor the pitch each
// player's name gives their horn: the preview is at the kind's own.
//
// This module is pure but for playHorn (no DOM), so it can be checked under node.

interface Note { st: number; cs: number; vib?: 1 }
interface Kind {
  f: number[]; a: number[]; dly?: number[];
  nh: number; roll: number; form?: number; width: number; lift?: number; top?: number;
  att: number; rel: number; sag?: number; drive: number; hiss?: number;
  res?: number; wah?: number; level: number; swell?: 1;
  tune?: Note[]; gate?: number; nsag?: number; vib?: number;
}
const REST = -99;
const CUCARACHA: Note[] = [
  { st: 0, cs: 13 }, { st: 0, cs: 13 }, { st: 0, cs: 13 }, { st: 5, cs: 36 }, { st: 9, cs: 50 }, { st: REST, cs: 22 },
  { st: 0, cs: 13 }, { st: 0, cs: 13 }, { st: 0, cs: 13 }, { st: 5, cs: 36 }, { st: 9, cs: 50 }, { st: REST, cs: 22 },
  { st: 5, cs: 18 }, { st: 5, cs: 18 }, { st: 4, cs: 18 }, { st: 4, cs: 18 }, { st: 2, cs: 18 }, { st: 2, cs: 18 }, { st: 0, cs: 54 },
  { st: REST, cs: 80 }];
const CLOWN: Note[] = [{ st: 0, cs: 22 }, { st: REST, cs: 9 }, { st: -3, cs: 30 }, { st: REST, cs: 45 }];
const TROMBONE: Note[] = [{ st: 0, cs: 42 }, { st: -1, cs: 42 }, { st: -2, cs: 42 }, { st: -3, cs: 170, vib: 1 }, { st: REST, cs: 90 }];

/** horn.c's KINDS, in its order (the numbers on the wire), by the setting's value */
const KINDS: Record<string, Kind> = {
  dual: { f: [405, 510], a: [1, 0.9], nh: 24, roll: 1, form: 2700, width: 1100, lift: 1.5, att: 0.008, rel: 0.030, drive: 1.2, level: 1 },
  single: { f: [480], a: [1], nh: 20, roll: 1, form: 3000, width: 1000, lift: 2, att: 0.006, rel: 0.025, drive: 1.7, level: 1.035 },
  truck: { f: [185, 222], a: [1, 0.85], dly: [0, 0.025], nh: 40, roll: 0.8, form: 1100, width: 700, lift: 2, top: 6000,
    att: 0.030, rel: 0.050, sag: 0.06, drive: 1.5, hiss: 0.03, level: 1.175 },
  train: { f: [311.1, 370, 415.3, 493.9, 622.3], a: [0.55, 0.5, 0.5, 0.45, 0.4], dly: [0, 0.02, 0.035, 0.05, 0.07],
    nh: 16, roll: 1, form: 1400, width: 900, lift: 1.2, top: 5000, att: 0.050, rel: 0.080, sag: 0.03, drive: 0.9, hiss: 0.02, level: 1.29 },
  klaxon: { f: [380], a: [1], nh: 28, roll: 0.5, width: 1, top: 9000, att: 0.180, rel: 0.150, sag: 0.72, drive: 2.2, res: 750, level: 1.95, swell: 1 },
  cucaracha: { f: [392, 393.6], a: [1, 0.5], nh: 18, roll: 0.8, form: 2000, width: 1000, lift: 1.5, top: 7000,
    att: 0.012, rel: 0.040, sag: 0.02, drive: 1.4, hiss: 0.01, level: 1, tune: CUCARACHA },
  clown: { f: [340], a: [1], nh: 30, roll: 0.6, form: 1600, width: 700, lift: 3, top: 8000, att: 0.010, rel: 0.040, drive: 3,
    level: 1.19, tune: CLOWN, gate: 0.015, nsag: 0.12 },
  trombone: { f: [233.1], a: [1], nh: 36, roll: 1, width: 1, top: 5000, att: 0.020, rel: 0.060, drive: 1.2, res: 350, wah: 1400,
    level: 1.22, tune: TROMBONE, gate: 0.040, vib: 0.02 },
};
export const HORN_NAMES = Object.keys(KINDS);

const LEVEL = 0.55, SELF = 0.7, TBL = 2048, GAP_S = 0.035;
const f32 = Math.fround;
const tables = new Map<string, Float32Array>();
/** horn.c's tbl_init: one cycle at f[0] */
function table(name: string): Float32Array {
  let tb = tables.get(name);
  if (tb) return tb;
  const K = KINDS[name], f0 = f32(K.f[0]), form = f32(K.form ?? 0), width = f32(K.width), lift = f32(K.lift ?? 0), top = f32(K.top ?? 0);
  const roll = f32(K.roll), s = new Float64Array(TBL);
  let peak = 0;
  for (let i = 0; i < TBL; i++) {
    const x = 2 * Math.PI * i / TBL;
    let v = 0;
    for (let k = 1; k <= K.nh; k++) {
      const d = (f0 * k - form) / width, t = top > 0 ? f0 * k / top : 0;
      v += Math.sin(k * x) / Math.pow(k, roll) * (1 + lift * Math.exp(-d * d)) * (t > 1 ? Math.exp(1 - t * t) : 1);
    }
    s[i] = f32(v);
    peak = Math.max(peak, Math.abs(v));
  }
  tb = new Float32Array(TBL + 1);
  for (let i = 0; i < TBL; i++) tb[i] = s[i] / peak;
  tb[TBL] = tb[0];
  tables.set(name, tb);
  return tb;
}

/** How long renderHorn holds a horn by default: a moment, a tune once through (twice, a short one), to its last rest. */
export function previewHold(name: string): number {
  const K = KINDS[name] ?? KINDS.dual;
  if (!K.tune) return 1.0;
  const len = K.tune.reduce((n, x) => n + x.cs / 100, 0), last = K.tune[K.tune.length - 1];
  return (len < 1.5 ? 2 * len : len) - (last.st === REST ? last.cs / 100 : 0) + 0.05;
}

/**
 * The player's own horn of this kind (dual for a name horn.c does not have), held for `held` s and let go, until it
 * is silent: one channel at `rate`, as horn.c's mixer renders it in blocks of 10 ms.  Its arithmetic is horn.c's in
 * single precision, operation for operation (f32 after each: exactly the float result for + - * / and sqrt), so the
 * two stay together for seconds of phase; only expf, sinf, cosf and exp2f may differ in a last bit.
 */
export function renderHorn(name: string, held = previewHold(name), rate = 48000): Float32Array<ArrayBuffer> {
  if (!KINDS[name]) name = 'dual';
  const K = KINDS[name], tb = table(name), fs = f32(rate), blk = Math.floor(rate / 100);
  const n = K.f.length, tune = K.tune, wahHz = f32(K.wah ?? 0);
  const sag = f32(K.sag ?? 0), nsag = f32(K.nsag ?? 0), hiss = f32(K.hiss ?? 0), vib = f32(K.vib ?? 0), drive = f32(K.drive);
  const level = f32(K.level), a = K.a.map(f32), PI = f32(Math.PI);
  const out: number[] = [];
  // the voice (horn.c's g_v), at the kind's own pitch (detune 1)
  const f = K.f.map(x => f32(f32(x) / fs)), ph = new Array<number>(n).fill(0);
  const on = K.f.map((_, t) => Math.floor(f32(f32(K.dly?.[t] ?? 0) * fs)));
  let env = 0, gl = 0, hx = 0, hy = 0, lp = 0, lo = 0, bd = 0, age = 0, note = -1, left = 0, inN = 0, ratio = 1, gate = 0, gs = 0, vph = 0;
  let rng = 0x9e3779b9;
  const k = (tau: number) => f32(1 - f32(Math.exp(f32(-1 / f32(f32(tau) * fs)))));
  const kSmooth = k(0.020), kHp = f32(1 / f32(1 + f32(f32(f32(2 * PI) * 180) / fs))), rise = f32(1 / f32(f32(0.030) * fs));
  const gap = Math.floor(f32(f32(GAP_S) * fs)), vibIn = Math.floor(f32(f32(0.25) * fs));
  const kAtt = k(K.att), kRel = k(K.rel), kGate = k(K.gate ?? 0.004), dvib = f32(5 / fs);
  const svf = K.res ? f32(2 * f32(Math.sin(f32(f32(PI * f32(K.res)) / fs)))) : 0, wah = f32(f32(f32(2 * PI) * wahHz) / fs);
  const th = f32(f32(1 * PI) * 0.25), lvl = f32(LEVEL);     // in the middle
  for (let b = 0; b < 60 * 100; b++) {
    const gain = b * blk < held * rate ? f32(SELF) : 0;
    const tgl = f32(gain * f32(Math.cos(th))), te = gain > 0 ? 1 : 0;
    const kLp = f32(f32(0.15) + f32(f32(0.85) * (f32(gain * f32(1.7)) > 1 ? 1 : f32(gain * f32(1.7)))));
    for (let i = 0; i < blk; i++, age++) {
      let bend = 1, amp = 1;                         // (the pitch: 1, no Doppler)
      if (sag > 0) bend = f32(bend * f32(1 - f32(sag * f32(1 - env))));
      if (tune) {
        if (!left) {
          note = (note + 1) % tune.length;
          const nt = tune[note];
          left = Math.floor(f32(f32(nt.cs * f32(0.01)) * fs)); inN = 0;
          gate = nt.st !== REST ? 1 : 0;
          if (gate > 0) ratio = f32(Math.pow(2, f32(nt.st / 12)));
        }
        if (left-- <= gap) gate = 0;
        gs = f32(gs + f32(f32(gate - gs) * kGate));
        bend = f32(bend * f32(ratio * f32(1 - f32(nsag * f32(1 - gs))))); amp = gs;
        if (tune[note].vib && inN++ > vibIn) {      // the shake comes in over 0.3 s
          const d = f32(f32(inN - vibIn) / f32(f32(0.3) * fs));
          if ((vph = f32(vph + dvib)) >= 1) vph = f32(vph - 1);
          bend = f32(bend * f32(1 + f32(f32(vib * (d < 1 ? d : 1)) * f32(Math.sin(f32(f32(2 * PI) * vph))))));
        }
      }
      let s = 0;
      for (let t = 0; t < n; t++) {
        if (age < on[t]) continue;
        ph[t] = f32(ph[t] + f32(f[t] * bend)); if (ph[t] >= 1) ph[t] = f32(ph[t] - 1);
        const x = f32(ph[t] * TBL), j = Math.trunc(x);
        let w = f32(f32(tb[j] + f32(f32(tb[j + 1] - tb[j]) * f32(x - j))) * a[t]);
        const r = f32(f32(age - on[t]) * rise);
        if (on[t] && r < 1) w = f32(w * r);          // a later trumpet speaks over 30 ms
        s = f32(s + w);
      }
      if (hiss > 0) {
        rng = (rng ^ (rng << 13)) >>> 0; rng = (rng ^ (rng >>> 17)) >>> 0; rng = (rng ^ (rng << 5)) >>> 0;
        s = f32(s + f32(hiss * f32(f32(rng | 0) / 2147483648)));
      }
      s = f32(s * drive);
      s = f32(s / f32(1 + Math.abs(s)));
      if (svf > 0) {
        const fc = f32(svf + f32(wah * amp));        // the mute opens with the note
        lo = f32(lo + f32(fc * bd)); const hi = f32(f32(s - lo) - f32(0.5 * bd)); bd = f32(bd + f32(fc * hi));
        s = wahHz > 0 ? lo : f32(f32(f32(0.3) * s) + f32(0.5 * bd));
      }
      hy = f32(kHp * f32(f32(hy + s) - hx)); hx = s;
      lp = f32(lp + f32(f32(hy - lp) * kLp));
      env = f32(env + f32(f32(te - env) * (te > env ? kAtt : kRel)));
      gl = f32(gl + f32(f32(tgl - gl) * kSmooth));
      const e = K.swell ? f32(env * f32(Math.sqrt(env))) : env;
      out.push(f32(f32(f32(f32(f32(lp * e) * amp) * lvl) * level) * gl));
    }
    if (!te && env < 1e-4) { out.length -= blk; break; }   // silent: horn.c lets the voice go after this block
  }
  return Float32Array.from(out);
}

let ctx: AudioContext | null = null, playing: AudioBufferSourceNode | null = null;
/** Plays a horn as renderHorn makes it (stopping one still playing); the promise ends when it has played. */
export async function playHorn(name: string): Promise<void> {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  stopHorn();
  const pcm = renderHorn(name, previewHold(name), ctx.sampleRate);
  const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
  buf.copyToChannel(pcm, 0);
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
  playing = src;
  await new Promise<void>(res => { src.onended = () => res(); src.start(); });
  if (playing === src) playing = null;
}
/** Stops the horn playHorn plays, if any. */
export function stopHorn(): void {
  try { playing?.stop(); } catch { /* not started */ }
  playing = null;
}
