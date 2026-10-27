// Steering wheels (Logitech G29 and the like) through the Gamepad API, for the game's virtual pad (gamepad.ts):
// the wheel becomes the left stick's x, the gas and brake pedals the right and left triggers, the D-pad and buttons
// the pad's, and the game is offered a driving device for it (runtime/dinput_pad.c), whose steering follows the
// wheel's position as the PC game's own wheel support did.
//
// No browser knows a wheel's layout: Chrome and Firefox give it mapping "", its axes and buttons in the order of
// its HID report, which differs by model, by browser and system and by its driver's settings (G HUB's combined
// pedals put gas and brake on one axis).  Chrome on Windows and macOS puts an axis at the index of its HID usage
// (X 0, Y 1, Z 2, Rx 3, Ry 4, Rz 5, Slider 6), and a hat switch (the D-pad) at 9 as one axis: -1 up, then every
// 2/7 an eighth turn clockwise, outside -1..1 when let go.  A pedal rests at one end of its axis (+1 on a G29 under
// Chrome, which reads a released pedal as 255), so read as a stick it held the stick down: the bug this file fixes.
// So a wheel's layout here is a guess from what is known of its model and from where its axes sit when it first
// shows up, and the player can teach the page the right one (WheelLearn, in the Controls sheet: turn the wheel,
// press each pedal), kept in this browser per model.

import { PAD_A, PAD_B, PAD_BACK, PAD_DDOWN, PAD_DLEFT, PAD_DRIGHT, PAD_DUP, PAD_HOME, PAD_LB, PAD_LS, PAD_RB, PAD_RS,
  PAD_START, PAD_X, PAD_Y } from './proto';

/** a pedal: its axis, its value let go and pressed to the floor (gas and brake on one axis: the two halves) */
export interface Pedal { axis: number; rest: number; full: number }
/** how a wheel's axes and buttons make the pad */
export interface WheelMap {
  steer: number;                 // the wheel's axis
  centre: number;                // its value straight ahead
  lock: number;                  // how far from the centre is full lock to the right (negative: the axis runs the other way)
  gas: Pedal | null;
  brake: Pedal | null;
  buttons: number[];             // buttons[i]: the PAD_* button i is (-1: none)
  learned?: boolean;             // set up by the player (WheelLearn), not guessed
}
/** a wheel model: its USB ids, its buttons' layout (G29 family: PlayStation, G920 family: Xbox), its rotation */
export interface WheelInfo { vendor: string; product: string; layout: 'ps' | 'xbox' | 'generic'; degrees: number }

/** the game's full lock, in degrees of a wheel turned from lock to lock, where the model's rotation is known: an
 *  arcade game's steering is quick, and a G29 turned half of its 900 degrees for full lock is a chore */
export const DEFAULT_LOCK_DEGREES = 270;

// the wheels SDL knows (src/joystick/SDL_joystick.c, initial_wheel_devices): vendor:product -> layout, rotation
const LOGI_PS = { layout: 'ps', degrees: 900 } as const, LOGI_XB = { layout: 'xbox', degrees: 900 } as const;
const KNOWN: Record<string, { layout: WheelInfo['layout']; degrees: number }> = {
  '046d:c24f': LOGI_PS, '046d:c260': LOGI_PS,                          // G29 (PS3 mode, PS4 mode)
  '046d:c266': LOGI_PS, '046d:c267': LOGI_PS,                          // G923 for PlayStation and PC
  '046d:c268': { layout: 'ps', degrees: 1080 }, '046d:c269': { layout: 'ps', degrees: 1080 },   // PRO Racing Wheel
  '046d:c261': LOGI_XB, '046d:c262': LOGI_XB,                          // G920
  '046d:c26d': LOGI_XB, '046d:c26e': LOGI_XB,                          // G923 for Xbox
  '046d:c272': { layout: 'xbox', degrees: 1080 },                      // PRO Racing Wheel for Xbox
  '046d:c294': { layout: 'generic', degrees: 0 },                      // a Logitech wheel before its driver switched it
  '046d:c295': { layout: 'generic', degrees: 0 }, '046d:ca03': { layout: 'generic', degrees: 0 },   // MOMO
  '046d:c298': { layout: 'generic', degrees: 900 },                    // Driving Force Pro
  '046d:c299': { layout: 'generic', degrees: 900 }, '046d:c29b': { layout: 'generic', degrees: 900 },   // G25, G27
  '046d:c29a': { layout: 'generic', degrees: 900 },                    // Driving Force GT
};
// whole vendors that make wheels and little else: Thrustmaster's wheel bases, Fanatec, Simagic, Simucube, Moza ...
const WHEEL_IDS = new Set(['044f:b65d', '044f:b65e', '044f:b664', '044f:b669', '044f:b66d', '044f:b66e', '044f:b66f',
  '044f:b677', '044f:b67f', '044f:b691', '044f:b692', '044f:b696', '045e:02a2', '0483:0522', '0483:a355', '0079:1864',
  '11ff:0511', '1209:ffb0', '3416:0301', '3416:0302']);
const WHEEL_VENDORS = new Set(['0eb7', '16d0', '2433', '346e']);

/** the USB vendor and product from Gamepad.id: Chrome writes "Name (... Vendor: 046d Product: c24f)", Firefox
 *  "046d-c24f-Name" */
export function usbIds(id: string): { vendor: string; product: string } | null {
  const c = /Vendor:\s*([0-9a-f]{4})\s*Product:\s*([0-9a-f]{4})/i.exec(id) ?? /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-/i.exec(id);
  return c ? { vendor: c[1].toLowerCase().padStart(4, '0'), product: c[2].toLowerCase().padStart(4, '0') } : null;
}

/** whether Gamepad.id is a steering wheel's, and which (asked every frame: kept per id) */
const seenIds = new Map<string, WheelInfo | null>();
export function wheelOf(id: string): WheelInfo | null {
  let w = seenIds.get(id);
  if (w !== undefined) return w;
  const u = usbIds(id), key = u ? `${u.vendor}:${u.product}` : '';
  const k = KNOWN[key];
  w = k ? { vendor: u!.vendor, product: u!.product, ...k }
    : (u && (WHEEL_IDS.has(key) || WHEEL_VENDORS.has(u.vendor))) || /\bwheel\b|driving force|steering/i.test(id)
    ? { vendor: u?.vendor ?? '', product: u?.product ?? '', layout: 'generic', degrees: 0 } : null;
  if (seenIds.size < 64) seenIds.set(id, w);
  return w;
}

// the buttons in the order the G29 and G923 (PlayStation) report them: Cross, Square, Circle, Triangle, the right
// and left paddles (R1, L1), R2, L2, Share, Options, R3, L3, the shifter's six gears and reverse, plus, minus, the
// red dial clockwise and back, its Enter, PS.  The G920 and G923 (Xbox): A, B, X, Y, the right and left paddles,
// Menu, View, the right and left stick buttons, Xbox.  Plus and minus shift too, the dial and Enter work the menus.
const PS_BUTTONS = [PAD_A, PAD_X, PAD_B, PAD_Y, PAD_RB, PAD_LB, -1, -1, PAD_BACK, PAD_START, PAD_RS, PAD_LS,
  -1, -1, -1, -1, -1, -1, -1, PAD_RB, PAD_LB, PAD_DDOWN, PAD_DUP, PAD_A, PAD_HOME];
const XBOX_BUTTONS = [PAD_A, PAD_B, PAD_X, PAD_Y, PAD_RB, PAD_LB, PAD_START, PAD_BACK, PAD_RS, PAD_LS, PAD_HOME];
// any other wheel: as the standard mapping's order (gamepad.ts BUTTON_OF), its triggers' places left out
const GENERIC_BUTTONS = [PAD_A, PAD_B, PAD_X, PAD_Y, PAD_LB, PAD_RB, -1, -1, PAD_BACK, PAD_START, PAD_LS, PAD_RS,
  PAD_DUP, PAD_DDOWN, PAD_DLEFT, PAD_DRIGHT, PAD_HOME];

/** whether an axis value is Chrome's hat switch let go (it reads outside -1..1 then) */
const hatRest = (v: number) => Math.abs(v) > 1.05;

/**
 * The guess for a wheel nobody set up: axes0 is where its axes sat when it showed up (the browser shows a controller
 * after a button press, so the pedals are let go then).  The wheel is axis 0 (X on every wheel), at full lock
 * DEFAULT_LOCK_DEGREES of its rotation, or all of it where that is unknown.  Pedals are the axes resting at an end:
 * the first is the gas, the brake Rz (5, where Chrome puts axes by usage: G HUB's G29 and G920, Y gas, Rz brake,
 * the slider the clutch) or else the last.  Without one at an end, G HUB's combined pedals: Y, gas up, brake down.
 */
export function guessMap(info: WheelInfo, axes0: readonly number[], nbuttons: number): WheelMap {
  const ends: number[] = [];
  axes0.forEach((v, i) => { if (i > 0 && !hatRest(v) && Math.abs(v) >= 0.9) ends.push(i); });
  const pedal = (i: number): Pedal => ({ axis: i, rest: Math.sign(axes0[i]), full: -Math.sign(axes0[i]) });
  let gas: Pedal | null = null, brake: Pedal | null = null;
  if (ends.length >= 2) {
    const b = ends.includes(5) && ends[0] !== 5 ? 5 : ends[ends.length - 1];
    gas = pedal(ends[0]); brake = pedal(b);
  } else if (ends.length === 1) gas = pedal(ends[0]);
  else if (axes0.length > 1) { gas = { axis: 1, rest: 0, full: -1 }; brake = { axis: 1, rest: 0, full: 1 }; }
  const table = info.layout === 'ps' ? PS_BUTTONS : info.layout === 'xbox' ? XBOX_BUTTONS : GENERIC_BUTTONS;
  return {
    steer: 0, centre: 0, lock: info.degrees > DEFAULT_LOCK_DEGREES ? DEFAULT_LOCK_DEGREES / info.degrees : 1, gas, brake,
    buttons: Array.from({ length: nbuttons }, (_, i) => table[i] ?? -1),
  };
}

/** Chrome's hat switch axis as PAD_D* bits: positions 0 (up) to 7 (up-left) at 2/7 apart from -1; anything else
 *  (let go, or 0 before the first report) is none */
export function hatDirs(v: number): number {
  if (!(v >= -1.01 && v <= 1.01)) return 0;
  const pos = Math.round((v + 1) * 3.5);
  if (Math.abs(v - (pos / 3.5 - 1)) > 0.05) return 0;
  const U = 1 << PAD_DUP, D = 1 << PAD_DDOWN, L = 1 << PAD_DLEFT, R = 1 << PAD_DRIGHT;
  return [U, U | R, R, D | R, D, D | L, L, U | L][pos];
}

const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v;
/** a pedal's travel, 0 let go to 1 on the floor */
export function pedalValue(p: Pedal | null, axes: readonly number[]): number {
  const v = p ? axes[p.axis] : undefined;
  if (p === null || typeof v !== 'number' || !isFinite(v) || p.full === p.rest) return 0;
  return clamp((v - p.rest) / (p.full - p.rest), 0, 1);
}

/** a wheel's state as the pad's: buttons (1 << PAD_*), and axes LX (the wheel, -1 .. 1 at full lock), LY, RX, RY
 *  (0), LT (the brake), RT (the gas).  hat: the axis Chrome put its D-pad on (-1: none seen) */
export function readWheel(axes: readonly number[], pressed: readonly boolean[], m: WheelMap, hat: number): { buttons: number; axes: number[] } {
  let buttons = 0;
  for (let i = 0; i < pressed.length && i < m.buttons.length; i++) if (pressed[i] && m.buttons[i] >= 0) buttons |= 1 << m.buttons[i];
  if (hat >= 0 && hat !== m.steer) buttons |= hatDirs(axes[hat]);
  const w = axes[m.steer];
  const lx = typeof w === 'number' && isFinite(w) && m.lock ? clamp((w - m.centre) / m.lock, -1, 1) : 0;
  return { buttons, axes: [lx, 0, 0, 0, pedalValue(m.brake, axes), pedalValue(m.gas, axes)] };
}

/** the axis carrying Chrome's hat switch: one that reads outside -1..1 (let go), or -1 */
export function findHat(axes: readonly number[]): number {
  return axes.findIndex(hatRest);
}

/** a short line for the log: what drives what */
export function describeMap(m: WheelMap, hat: number): string {
  const p = (x: Pedal | null) => x ? `axis ${x.axis} (${x.rest.toFixed(2)} to ${x.full.toFixed(2)})` : 'none';
  return `wheel axis ${m.steer} (centre ${m.centre.toFixed(2)}, full lock ${m.lock >= 0 ? '+' : ''}${m.lock.toFixed(2)}), ` +
    `gas ${p(m.gas)}, brake ${p(m.brake)}, D-pad ${hat >= 0 ? `axis ${hat}` : 'none seen'}, ${m.learned ? 'set up by the player' : 'guessed'}`;
}

// ---- the player's set-up, kept in this browser per model ------------------------------------------------------
const KEY = 'nfsu2.wheel.';
/** the key a wheel's set-up is kept under: its USB ids, or its name where the browser gives none */
export function wheelKey(id: string): string {
  const u = usbIds(id);
  return KEY + (u ? `${u.vendor}:${u.product}` : id.slice(0, 80));
}
export function loadMap(id: string): WheelMap | null {
  try {
    const m = JSON.parse(localStorage.getItem(wheelKey(id)) ?? 'null') as WheelMap | null;
    const ok = (p: Pedal | null) => p === null || (Number.isInteger(p.axis) && isFinite(p.rest) && isFinite(p.full));
    return m && Number.isInteger(m.steer) && isFinite(m.centre) && isFinite(m.lock) && m.lock !== 0 && ok(m.gas) && ok(m.brake) &&
      Array.isArray(m.buttons) ? m : null;
  } catch { return null; }
}
/** keep the player's set-up (null: back to the guess); gamepad.ts reads it again on the event */
export function saveMap(id: string, m: WheelMap | null) {
  try { if (m) localStorage.setItem(wheelKey(id), JSON.stringify(m)); else localStorage.removeItem(wheelKey(id)); }
  catch { /* storage off: the guess stays */ }
  dispatchEvent(new Event(WHEEL_MAP_EVENT));
}
export const WHEEL_MAP_EVENT = 'nfsu2-wheel-map';

// ---- teaching the page the wheel's axes -------------------------------------------------------------------------
export type LearnStep = 'rest' | 'steer' | 'gas' | 'brake' | 'done';
/** how long (ms) a control has to be held still where it is for its step to take it */
const HOLD_MS = 700;

/**
 * The set-up's steps, fed the wheel's axes every frame (feed): let go of everything (rest: where every axis sits),
 * turn the wheel right to where full lock should be (steer: the axis that moved most, its centre and the lock, held
 * there HOLD_MS), press the gas pedal down (gas: the axis that moved most but the wheel's), the brake (brake: the
 * same, or the gas's axis the other way: combined pedals).  Each step takes a control once it has moved far enough
 * and held still; then map() is the wheel's set-up, with base's buttons.
 */
export class WheelLearn {
  step: LearnStep = 'rest';
  /** 0..1: how far the step is (the hold) */
  progress = 0;
  private rest: number[] = [];
  private last: number[] = [];
  private still = 0;
  private steer = -1;
  private centre = 0;
  private lock = 0;
  private gas: Pedal | null = null;
  private brake: Pedal | null = null;

  constructor(private base: WheelMap) {}

  /** the axes now, at time now (ms); true when the step changed */
  feed(axes: readonly number[], now: number): boolean {
    const moved = this.last.length !== axes.length || axes.some((v, i) => Math.abs(v - this.last[i]) > 0.01);
    if (moved) this.still = now;
    this.last = axes.slice();
    const held = Math.min(1, (now - this.still) / HOLD_MS);
    const before = this.step;
    switch (this.step) {
      case 'rest':
        this.progress = held;
        if (held >= 1) { this.rest = axes.slice(); this.step = 'steer'; }
        break;
      case 'steer': {
        const i = this.most(axes, [], 0.08);
        this.progress = i < 0 ? 0 : held;
        if (i >= 0 && held >= 1) { this.steer = i; this.centre = this.rest[i]; this.lock = axes[i] - this.rest[i]; this.step = 'gas'; }
        break;
      }
      case 'gas': {
        const i = this.most(axes, [this.steer], 0.3);
        this.progress = i < 0 ? 0 : held;
        if (i >= 0 && held >= 1) { this.gas = { axis: i, rest: this.rest[i], full: axes[i] }; this.step = 'brake'; }
        break;
      }
      case 'brake': {
        const g = this.gas!;
        // the gas's axis only the other way from its rest (combined pedals)
        const i = this.most(axes, [this.steer], 0.3, j => j !== g.axis || Math.sign(axes[j] - g.rest) === -Math.sign(g.full - g.rest));
        this.progress = i < 0 ? 0 : held;
        if (i >= 0 && held >= 1) { this.brake = { axis: i, rest: this.rest[i], full: axes[i] }; this.step = 'done'; }
        break;
      }
    }
    if (this.step !== before) { this.progress = 0; this.still = now; }
    return this.step !== before;
  }

  /** the axis furthest from its rest (at least min, a hat switch's never), not one of skip, or -1 */
  private most(axes: readonly number[], skip: number[], min: number, ok: (i: number) => boolean = () => true): number {
    let best = -1, far = min;
    axes.forEach((v, i) => {
      const r = this.rest[i];
      if (skip.includes(i) || hatRest(v) || hatRest(r ?? 0) || typeof r !== 'number' || !ok(i)) return;
      const d = Math.abs(v - r);
      if (d >= far) { far = d; best = i; }
    });
    return best;
  }

  /** the set-up, once done */
  map(): WheelMap | null {
    if (this.step !== 'done') return null;
    return { ...this.base, steer: this.steer, centre: this.centre, lock: this.lock, gas: this.gas, brake: this.brake, learned: true };
  }
}
