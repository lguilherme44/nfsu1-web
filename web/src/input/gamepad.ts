// Game controllers through the Gamepad API, for the game's one virtual pad
// (runtime/gamepad.h, presented to the game as a DirectInput gamepad by
// runtime/dinput_pad.c).
//
// navigator.getGamepads() exists on the page's main thread only, so the page
// polls it every frame and publishes the pad into the HostMailbox under a
// seqlock; the guest reads it when the game polls its device.  The first
// connected controller with the standard mapping, or a steering wheel
// (wheel.ts: the wheel, its pedals and buttons made the pad's, and the game
// offered a driving device), drives the pad (one that connects later takes
// over only when it goes away), as gamepad.m does; without either the first
// controller is read as if it had the standard mapping, but for an axis
// resting at an end when it showed up (a pedal, a throttle, a trigger),
// which is no stick.  Chrome exposes a controller only after a button press
// on the page.
//
// Rumble goes the other way: runtime/dinput_pad.c plays the game's
// force-feedback effects as two motor levels in the mailbox, updated every
// frame the game polls the pad; this file plays them on the controller's
// vibrationActuator ("dual-rumble") in short overlapping effects, and lets
// the motors stop once the levels stop coming (a paused or parked game, a
// hidden page) or fall to zero.
//
// The page has a share too (PadPage): Home, or both sticks pressed in, opens
// its menu, which F9 opens on a keyboard (the game binds neither), and while
// one of its dialogs is open the controller works the dialog instead of the
// game.
import {
  IM_OFF_PAD_NAME, IM_PAD_AXIS, IM_PAD_BUTTONS, IM_PAD_CONNECTED, IM_PAD_FAMILY, IM_PAD_GEN, IM_PAD_RUMBLE, IM_PAD_SEQ,
  IM_PAD_WHEEL, IM_RUMBLE_SEQ, IM_RUMBLE_STRONG, IM_RUMBLE_WEAK,
  PAD_A, PAD_AXIS_LT, PAD_AXIS_LX, PAD_AXIS_LY, PAD_AXIS_RT, PAD_AXIS_RX, PAD_AXIS_RY, PAD_B, PAD_BACK, PAD_DDOWN,
  PAD_DLEFT, PAD_DRIGHT, PAD_DUP, PAD_HOME, PAD_LB, PAD_LS, PAD_RB, PAD_RS, PAD_START, PAD_X, PAD_Y,
  PADF_GENERIC, PADF_NINTENDO, PADF_PLAYSTATION, PADF_XBOX,
} from './proto';
import {
  describeMap, findHat, guessMap, hatDirs, loadMap, readWheel, usbIds, WHEEL_MAP_EVENT, wheelOf, type WheelInfo, type WheelMap,
} from './wheel';

export interface PadSnapshot { connected: boolean; buttons: number; axes: number[]; family: number; name: string; index: number; wheel?: boolean }

// standard mapping: buttons[i] -> PAD_* (6 and 7 are the analog triggers)
const BUTTON_OF: (number | -1)[] = [PAD_A, PAD_B, PAD_X, PAD_Y, PAD_LB, PAD_RB, -1, -1, PAD_BACK, PAD_START,
  PAD_LS, PAD_RS, PAD_DUP, PAD_DDOWN, PAD_DLEFT, PAD_DRIGHT, PAD_HOME];

/** the controller family and a display name from Gamepad.id: Chrome writes
 *  "Name (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)", Firefox "054c-0ce6-Name"
 *  (on Linux and macOS without the leading zeros: "54c-ce6-Name").
 *  A wheel's family is its buttons' (a G29's are PlayStation's, a G920's Xbox's). */
export function familyOf(id: string): { family: number; name: string } {
  const v = usbIds(id)?.vendor;
  let name = id.replace(/\s*\((?:STANDARD GAMEPAD\s*)?(?:Vendor:[^)]*)?\)\s*$/i, '').replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '').trim();
  if (!name) name = 'Game Controller';
  const s = id.toLowerCase(), w = wheelOf(id)?.layout;
  if (w === 'ps' || w === 'xbox') return { family: w === 'ps' ? PADF_PLAYSTATION : PADF_XBOX, name };
  const family = v === '045e' || /xbox|xinput/.test(s) ? PADF_XBOX
    : v === '054c' || /dualsense|dualshock|playstation/.test(s) ? PADF_PLAYSTATION
    : v === '057e' || /pro controller|joy-con|nintendo/.test(s) ? PADF_NINTENDO : PADF_GENERIC;
  return { family, name };
}

/** a Gamepad in the standard mapping -> the virtual pad (sticks -1..1 with
 *  +y down, which is already the Gamepad API's direction; triggers 0..1).
 *  notStick: axes read as 0 (a controller without the standard mapping: those
 *  that rested at an end when it showed up) */
export function mapStandard(g: Gamepad, notStick?: ReadonlySet<number>): PadSnapshot {
  let buttons = 0;
  for (let i = 0; i < BUTTON_OF.length && i < g.buttons.length; i++) {
    const b = BUTTON_OF[i], bt = g.buttons[i];
    if (b >= 0 && bt && (bt.pressed || bt.value > 0.5)) buttons |= 1 << b;
  }
  const ax = (i: number) => {
    const v = g.axes[i];
    return typeof v === 'number' && isFinite(v) && !notStick?.has(i) ? Math.max(-1, Math.min(1, v)) : 0;
  };
  const tr = (i: number) => { const b = g.buttons[i]; return b ? Math.max(0, Math.min(1, b.value || (b.pressed ? 1 : 0))) : 0; };
  const axes = [0, 0, 0, 0, 0, 0];
  axes[PAD_AXIS_LX] = ax(0); axes[PAD_AXIS_LY] = ax(1); axes[PAD_AXIS_RX] = ax(2); axes[PAD_AXIS_RY] = ax(3);
  axes[PAD_AXIS_LT] = tr(6); axes[PAD_AXIS_RT] = tr(7);
  const { family, name } = familyOf(g.id);
  return { connected: true, buttons, axes, family, name, index: g.index };
}

/** a steering wheel -> the virtual pad (wheel.ts): the wheel on LX, the brake and gas pedals on LT and RT */
export function mapWheel(g: Gamepad, m: WheelMap, hat: number): PadSnapshot {
  const pressed = g.buttons.map(b => !!b && (b.pressed || b.value > 0.5));
  const { buttons, axes } = readWheel(g.axes, pressed, m, hat);
  const { family, name } = familyOf(g.id);
  return { connected: true, buttons, axes, family, name, index: g.index, wheel: true };
}

/** what the poller knows of the controller driving the pad: its axes when it showed up, and if it is a wheel, the
 *  model, how it makes the pad and the axis of its D-pad */
interface Seen { index: number; id: string; axes0: number[]; ends: Set<number>; wheel: WheelInfo | null; map: WheelMap | null; hat: number }

/** what the page itself does with the controller */
export interface PadPage {
  /** Home, or both sticks pressed in: the page's menu (open or close it) */
  menu(): void;
  /** whether a dialog of the page is open: it has the controller, the game gets it at rest */
  dialog(): boolean;
  /** a button went down while dialog() (a PAD_* number; the left stick's directions come as the D-pad's) */
  press(button: number): void;
}

/** the touch controls' share of the pad (web/src/app/touch.ts): PAD_* button bits and the left stick's x */
export interface TouchPad { buttons: number; lx: number }

/** a real controller's snapshot with the touch controls' added (their buttons too, the stick further out of the
 *  two); without a real one, the touch controls are the controller */
function withTouch(s: PadSnapshot, t: TouchPad): PadSnapshot {
  const axes = [...s.axes];
  if (Math.abs(t.lx) > Math.abs(axes[PAD_AXIS_LX])) axes[PAD_AXIS_LX] = t.lx;
  return s.connected ? { ...s, buttons: s.buttons | t.buttons, axes }
    : { connected: true, buttons: t.buttons, axes, family: PADF_GENERIC, name: 'Touch controls', index: -2 };
}

/** a stick pressed in alone waits this long (ms) for the other, the menu's shortcut, before the game gets it (the horn,
 *  a car's hydraulics); let go before, the game gets it this long */
const CHORD_MS = 120, TAP_MS = 80;

/** the left stick as four directions, PAD_D* bits: on past 0.55, off below 0.40 (runtime/dinput_pad.c's hat) */
function stickDirs(x: number, y: number, prev: number): number {
  const on = (bit: number, v: number) => v > 0.55 || (v > 0.40 && (prev & 1 << bit) !== 0) ? 1 << bit : 0;
  return on(PAD_DUP, -y) | on(PAD_DDOWN, y) | on(PAD_DLEFT, -x) | on(PAD_DRIGHT, x);
}

export class PadPoller {
  private order: number[] = [];            // controller indices in connection order
  private last: PadSnapshot | null = null;
  private f32 = new Float32Array(1);
  private i32 = new Int32Array(this.f32.buffer);
  private pressedBefore = 0;
  // the sticks and triggers where they last counted as the player's use (a drifting stick does not)
  private usedAxes = [0, 0, 0, 0, 0, 0];
  // rumble: the last mailbox update seen and when, what is playing
  private rumbleSeq = 0;
  private rumbleSeen = 0;
  private rumbleSent = 0;
  private rumbleNow: [number, number] = [0, 0];
  private rumblePad: Gamepad | null = null;
  // the page's share: buttons kept from the game until let go, the left stick's directions; a stick pressed in alone,
  // kept from the game while the other may follow (the menu): its bit and since when, and a tap's until when
  private held = 0;
  private stick = 0;
  private alone = 0;
  private aloneAt = 0;
  private tap = 0;
  private tapUntil = 0;
  // the touch controls' virtual controller (touch.ts), and the phone's vibration for the game's rumble without a
  // controller: when it last buzzed
  private touch: TouchPad | null = null;
  private buzzAt = 0;
  // the controller driving the pad as it showed up (a wheel's layout comes from it)
  private seen: Seen | null = null;
  /** performance.now() of a real controller's last button press (0: none yet) */
  lastPress = 0;
  // views of the game's memory: dropped by dispose(), so nothing keeps an ended
  // process's (1 GB+) shared memory reachable or writes into its mailbox
  private h: Int32Array | null;
  private u8: Uint8Array | null;
  private onConnect = (e: GamepadEvent) => {
    this.log(`[pad] connected: ${e.gamepad.id} (index ${e.gamepad.index}, mapping "${e.gamepad.mapping}")`);
    this.poll();
  };
  private onDisconnect = (e: GamepadEvent) => {
    this.log(`[pad] disconnected: ${e.gamepad.id}`);
    this.poll();
  };
  // the player set up a wheel (or went back to the guess): read its layout again
  private onWheelMap = () => {
    if (this.seen) this.seen.map = null;
    this.poll();
  };

  /** onPress: a button went down; onUse: that, or a stick or trigger moved a quarter of its range; page: the page's
   *  menu and dialogs */
  constructor(h: Int32Array, u8: Uint8Array, private base: number,
              private onPress: () => void, private log: (s: string) => void, private onUse?: () => void,
              private page?: PadPage) {
    this.h = h; this.u8 = u8;
    addEventListener('gamepadconnected', this.onConnect);
    addEventListener('gamepaddisconnected', this.onDisconnect);
    addEventListener(WHEEL_MAP_EVENT, this.onWheelMap);
  }

  /** stop for good: listeners removed, the mailbox views dropped */
  dispose() {
    removeEventListener('gamepadconnected', this.onConnect);
    removeEventListener('gamepaddisconnected', this.onDisconnect);
    removeEventListener(WHEEL_MAP_EVENT, this.onWheelMap);
    this.rumble(null);
    this.h = null; this.u8 = null;
  }

  /** the controller driving the pad, or null */
  current(): string | null { return this.last?.connected ? this.last.name : null; }

  /** the touch controls' virtual controller, merged with a real one (null: none) */
  setTouch(t: TouchPad | null) { this.touch = t; this.poll(); }

  poll() {
    if (!this.h) return;
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const live = new Set<number>();
    for (const g of pads) if (g && g.connected) { live.add(g.index); if (!this.order.includes(g.index)) this.order.push(g.index); }
    this.order = this.order.filter(i => live.has(i));
    const byIndex = (i: number) => pads[i] ?? null;
    let pick = this.order.find(i => { const p = byIndex(i); return !!p && (p.mapping === 'standard' || !!wheelOf(p.id)); });
    if (pick === undefined) pick = this.order[0];
    const g = pick === undefined ? null : byIndex(pick);
    const s: PadSnapshot = g ? this.read(g) : { connected: false, buttons: 0, axes: [0, 0, 0, 0, 0, 0], family: PADF_GENERIC, name: '', index: -1 };
    this.rumble(g);
    const pressed = s.buttons & ~this.pressedBefore;
    this.pressedBefore = s.buttons;
    if (pressed) { this.onPress(); this.lastPress = performance.now(); }
    if (pressed || s.axes.some((v, i) => Math.abs(v - this.usedAxes[i]) > 0.25)) { this.usedAxes = s.axes; this.onUse?.(); }
    const both = this.touch ? withTouch(s, this.touch) : s;
    if (this.touch && !g) this.buzz();
    const out = this.page ? this.forPage(both, pressed) : both;
    if (this.same(out)) return;
    this.publish(out, !this.last || this.last.connected !== out.connected || this.last.index !== out.index || this.last.name !== out.name);
    this.last = out;
  }

  /** the controller driving the pad as the pad: a wheel through its layout (the player's, or the guess from how it
   *  showed up), one in the standard mapping as it is, any other as if it were, but for the axes that rested at an
   *  end when it showed up, and with Chrome's hat switch as its D-pad */
  private read(g: Gamepad): PadSnapshot {
    let k = this.seen;
    if (!k || k.index !== g.index || k.id !== g.id) {
      const axes0 = Array.from(g.axes, v => typeof v === 'number' && isFinite(v) ? v : 0);
      const ends = new Set<number>();
      axes0.forEach((v, i) => { if (Math.abs(v) >= 0.9 && Math.abs(v) <= 1.05) ends.add(i); });
      k = this.seen = { index: g.index, id: g.id, axes0, ends, wheel: wheelOf(g.id), map: null, hat: findHat(axes0) };
      if (g.mapping !== 'standard') {
        this.log(`[pad] ${g.id}: no standard mapping in this browser; ${g.axes.length} axes at ` +
          `[${axes0.map(v => v.toFixed(2)).join(' ')}], ${g.buttons.length} buttons`);
        if (!k.wheel) this.log(`[pad] read as if it had one${ends.size ? `, but for axes ${[...ends].join(', ')} (at an end: no stick)` : ''}` +
          `${k.hat >= 0 ? `, the D-pad on axis ${k.hat}` : ''}`);
      }
    }
    if (k.hat < 0 && g.mapping !== 'standard') {
      k.hat = findHat(g.axes);
      if (k.hat >= 0) this.log(`[pad] ${g.id}: the D-pad on axis ${k.hat}`);
    }
    if (k.wheel && g.mapping === 'standard') return { ...mapStandard(g), wheel: true };
    if (k.wheel) {
      if (!k.map) {
        k.map = loadMap(g.id) ?? guessMap(k.wheel, k.axes0, g.buttons.length);
        this.log(`[pad] ${g.id}: a steering wheel, ${describeMap(k.map, k.hat)}`);
      }
      return mapWheel(g, k.map, k.hat);
    }
    const s = mapStandard(g, g.mapping === 'standard' ? undefined : k.ends);
    if (g.mapping !== 'standard' && k.hat >= 0) s.buttons |= hatDirs(g.axes[k.hat]);
    return s;
  }

  /** The page's share of the controller: Home, or the second stick pressed in while the other is, opens or closes its
   *  menu.  While a dialog of the page is open, the buttons and the left stick work it and the game gets the
   *  controller at rest.  A button held then (or the shortcut's) stays away from the game until it is let go, so the
   *  A that closed the menu does not press A in the game too.  A stick pressed in alone (the horn, horn.c; a car's
   *  hydraulics) reaches the game once CHORD_MS passed without the other, or for TAP_MS when let go before, so the
   *  shortcut does not sound the horn or bounce the car. */
  private forPage(s: PadSnapshot, pressed: number): PadSnapshot {
    const page = this.page!, sticks = 1 << PAD_LS | 1 << PAD_RS, home = 1 << PAD_HOME, now = performance.now();
    const menu = (pressed & home) !== 0 || ((pressed & sticks) !== 0 && (s.buttons & sticks) === sticks);
    if (menu) { page.menu(); this.held |= s.buttons & (sticks | home); }
    if (pressed & sticks && (s.buttons & sticks) !== sticks) { this.alone = s.buttons & sticks; this.aloneAt = now; }
    let wait = 0;
    if (menu) this.alone = 0;
    else if (this.alone && !(s.buttons & this.alone)) { this.tap = this.alone; this.tapUntil = now + TAP_MS; this.alone = 0; }
    else if (this.alone && now - this.aloneAt < CHORD_MS) wait = this.alone;
    else this.alone = 0;
    const tap = now < this.tapUntil ? this.tap : 0;
    const dirs = stickDirs(s.axes[PAD_AXIS_LX], s.axes[PAD_AXIS_LY], this.stick), turned = dirs & ~this.stick;
    this.stick = dirs;
    if (!page.dialog()) {
      this.held &= s.buttons;
      const buttons = (s.buttons & ~this.held & ~wait) | tap;
      return buttons === s.buttons ? s : { ...s, buttons };
    }
    this.held = s.buttons;
    if (!menu) for (let b = 0; b < 16; b++) if ((pressed | turned) & 1 << b) page.press(b);
    return { ...s, buttons: 0, axes: [0, 0, 0, 0, 0, 0] };
  }

  private same(s: PadSnapshot) {
    const l = this.last;
    return !!l && l.connected === s.connected && l.buttons === s.buttons && l.index === s.index && !!l.wheel === !!s.wheel &&
      l.axes.every((v, i) => v === s.axes[i]);
  }

  // the seqlock: odd while writing; every word is an atomic store so the
  // guest never sees a half-written pad
  private publish(s: PadSnapshot, newPad: boolean) {
    const h = this.h, u8 = this.u8;
    if (!h || !u8) return;
    const seq = Atomics.load(h, IM_PAD_SEQ);
    Atomics.store(h, IM_PAD_SEQ, (seq + 1) | 0);
    Atomics.store(h, IM_PAD_CONNECTED, s.connected ? 1 : 0);
    Atomics.store(h, IM_PAD_FAMILY, s.family);
    Atomics.store(h, IM_PAD_BUTTONS, s.buttons);
    Atomics.store(h, IM_PAD_WHEEL, s.connected && s.wheel ? 1 : 0);
    for (let i = 0; i < 6; i++) { this.f32[0] = s.axes[i]; Atomics.store(h, IM_PAD_AXIS + i, this.i32[0]); }
    if (newPad) {
      const name = s.name.replace(/[^\x20-\x7e]/g, '?').slice(0, 63);
      for (let i = 0; i < 64; i++) Atomics.store(u8, this.base + IM_OFF_PAD_NAME + i, i < name.length ? name.charCodeAt(i) : 0);
    }
    Atomics.store(h, IM_PAD_SEQ, (seq + 2) | 0);
    if (newPad) Atomics.add(h, IM_PAD_GEN, 1);
  }

  /** Without a controller, the touch controls' rumble: the phone's vibration (Android; on or off, no strength), a
   *  pulse as long as the game's strongest motor is strong, at most every 150 ms. */
  private buzz() {
    const h = this.h, now = performance.now();
    if (!h || typeof navigator.vibrate !== 'function' || now - this.buzzAt < 150) return;
    const seq = Atomics.load(h, IM_RUMBLE_SEQ);
    if (seq !== this.rumbleSeq) { this.rumbleSeq = seq; this.rumbleSeen = now; }
    if (now - this.rumbleSeen > 150 || document.visibilityState !== 'visible') return;
    const level = Math.max(Atomics.load(h, IM_RUMBLE_STRONG), Atomics.load(h, IM_RUMBLE_WEAK) * 0.6) / 65535;
    if (level < 0.25) return;
    this.buzzAt = now;
    navigator.vibrate(Math.round(30 + 90 * level));
  }

  /** the game's motor levels onto this controller (every frame, from poll) */
  private rumble(g: Gamepad | null) {
    const h = this.h;
    const va = g?.vibrationActuator;
    const can = !!va && typeof va.playEffect === 'function';
    // the touch controls rumble through the phone's vibration instead (buzz)
    const phone = !g && !!this.touch && typeof navigator.vibrate === 'function';
    if (h && Atomics.load(h, IM_PAD_RUMBLE) !== (can || phone ? 1 : 0)) Atomics.store(h, IM_PAD_RUMBLE, can || phone ? 1 : 0);
    const now = performance.now();
    let strong = 0, weak = 0;
    if (h && can) {
      const seq = Atomics.load(h, IM_RUMBLE_SEQ);
      if (seq !== this.rumbleSeq) { this.rumbleSeq = seq; this.rumbleSeen = now; }
      // levels the game still sends: it polls the pad every frame while it runs
      if (now - this.rumbleSeen < 150 && document.visibilityState === 'visible') {
        strong = Atomics.load(h, IM_RUMBLE_STRONG) / 65535; weak = Atomics.load(h, IM_RUMBLE_WEAK) / 65535;
      }
    }
    const [ps, pw] = this.rumbleNow, playing = ps > 0 || pw > 0;
    if (strong < 0.02 && weak < 0.02) {
      if (playing || (this.rumblePad && this.rumblePad !== g)) {
        const p = this.rumblePad?.vibrationActuator;
        if (p && typeof p.reset === 'function') void p.reset().catch(() => {});
        this.rumbleNow = [0, 0]; this.rumblePad = null;
      }
      return;
    }
    // overlapping 120 ms effects: renewed every 60 ms, every 30 ms while the
    // levels move (a hit fading), and at once for a new hit
    const since = now - this.rumbleSent;
    const hit = strong > ps + 0.2 || weak > pw + 0.2;
    const moved = Math.abs(strong - ps) >= 0.05 || Math.abs(weak - pw) >= 0.05;
    if (playing && this.rumblePad === g && !hit && (since < 30 || (since < 60 && !moved))) return;
    this.rumbleSent = now; this.rumbleNow = [strong, weak]; this.rumblePad = g;
    void va!.playEffect('dual-rumble', { duration: 120, startDelay: 0, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
  }
}
