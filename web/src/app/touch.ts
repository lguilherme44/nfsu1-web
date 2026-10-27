// Touch controls: the controls on the game while the player drives on a phone or tablet (races and free roam).
//   steering  three ways, switched with the mode button (top right) and kept in this browser:
//               buttons  ◀ ▶ press the arrow keys, so the game's own keyboard steering applies (the default)
//               stick    a thumb stick where the left thumb lands: the controller's left stick
//               tilt     the phone is the wheel, from its motion sensor: the controller's left stick
//   pedals    Gas and Brake press the up and down arrows; Nitro and the handbrake are the controller's LB and RB
//             (Alt, the nitrous key, would turn the other keys into Alt+key).  With tilt, Brake and the handbrake go
//             under the left thumb.
//   gears     with a manual gearbox, gear down and up above the left thumb: the controller's X and A, as on a pad
//             (Ctrl and Shift on the keyboard would be modifiers too)
//   small     pause, camera, look back, reset; in free roam also the map, messages, horn and start an event
//   horizon   while tilt steers, the game's 3D view turns against the phone's tilt from straight ahead, so the road's
//             horizon stays level with the real one (the HUD stays on the phone; runtime/overrides.c sub_005c7ec0).
//             Not in a cutscene (a race's start); faded in and out.  A switch in the Controls sheet's touch tab.
// The controller part is a virtual one the input module merges with a real one (gamepad.ts withTouch).
// They show while the game says the player drives ("drive" in its status block, runtime/web/status_web.c: 1 in a
// race, 2 in free roam, + 4 with a manual gearbox, + 8 in a cutscene), once a finger has touched the game (at once on
// a touch screen), and hide when a keyboard or a controller is used, until the next touch.  The game reads its input
// once a frame, so a key a tap presses stays down HOLD_MS at least.
import { PAD_A, PAD_LB, PAD_RB, PAD_X } from '../input/proto';
import type { GameSession } from './game';
import { touchFirst } from './device';

export type Steering = 'buttons' | 'stick' | 'tilt';
const STEERING: Steering[] = ['buttons', 'stick', 'tilt'];
const NAMES: Record<Steering, string> = { buttons: 'buttons', stick: 'thumb stick', tilt: 'tilt' };
const STORE = 'nfsu2-touch-steering';
const HOLD_MS = 150;
/** the thumb stick: px from its centre to full lock; tilt: degrees of roll to full lock */
const STICK_PX = 64, TILT_DEG = 30;
/** the level horizon: the most it turns the view (degrees), how long it takes to come and go (ms) */
const LEVEL_MAX_DEG = 60, LEVEL_FADE_MS = 400;

const LEVEL_STORE = 'nfsu2-touch-level', LEVEL_EVENT = 'nfsu2-touch-level';
let levelOn = (() => { try { return localStorage.getItem(LEVEL_STORE) !== 'off'; } catch { return true; } })();
/** the level horizon's switch (the Controls sheet): on unless turned off in this browser */
export function levelHorizon(): boolean { return levelOn; }
export function setLevelHorizon(on: boolean) {
  levelOn = on;
  try { localStorage.setItem(LEVEL_STORE, on ? 'on' : 'off'); } catch { /* not kept: a private window */ }
  dispatchEvent(new Event(LEVEL_EVENT));
}
/** fn runs when the switch changes */
export function onLevelHorizon(fn: () => void) { addEventListener(LEVEL_EVENT, fn); }

interface Ctl {
  id: string; el: HTMLElement;
  key?: string; bit?: number; act?: () => void;
  /** a finger slides between the controls of a group */
  group?: 'steer' | 'pedal';
  fingers: Set<number>; downAt: number; upTimer: number;
}

const path = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICONS = {
  left: '<path class="fill" d="M16 5L7 12l9 7z"/>',
  right: '<path class="fill" d="M8 5l9 7-9 7z"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  camera: '<path d="M4 8h3l2-2h6l2 2h3v10H4z"/><circle cx="12" cy="13" r="3"/>',
  look: '<path d="M19 12H6M11 7l-5 5 5 5"/>',
  reset: '<path d="M6 13a6 6 0 1 0 2-5.2"/><path d="M5 4v4h4"/>',
  map: '<path d="M4 6l5-2 6 2 5-2v14l-5 2-6-2-5 2z"/><path d="M9 4v14M15 6v14"/>',
  msgs: '<path d="M4 6h16v12H4z"/><path d="M4 7l8 6 8-6"/>',
  horn: '<path d="M4 10v4h3l6 4V6l-6 4z"/><path d="M17 9a4 4 0 0 1 0 6"/>',
  center: '<circle cx="12" cy="12" r="6"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  buttons: '<path d="M10 7l-5 5 5 5M14 7l5 5-5 5"/>',
  stick: '<circle cx="12" cy="12" r="8"/><circle class="fill" cx="12" cy="12" r="3"/>',
  tilt: '<rect x="4" y="8" width="16" height="9" rx="2" transform="rotate(-18 12 12)"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
};

/** the roll of the phone in the screen's plane, radians, 0 = upright, + = turned clockwise (a wheel turned right);
 *  null when it lies too flat to tell.  Gravity in the device's frame from beta and gamma (W3C device orientation:
 *  x right, y up, z out of the screen in the natural orientation), then turned into the screen's frame. */
export function rollOf(beta: number, gamma: number, screenAngle: number): number | null {
  const rad = Math.PI / 180, b = beta * rad, g = gamma * rad, a = screenAngle * rad;
  const gx = Math.cos(b) * Math.sin(g), gy = -Math.sin(b);
  const sx = gx * Math.cos(a) - gy * Math.sin(a), sy = gx * Math.sin(a) + gy * Math.cos(a);
  if (Math.hypot(sx, sy) < 0.3) return null;
  return Math.atan2(sx, -sy);
}

export interface TouchDeps {
  toast(msg: string, ms: number): void;
  log(s: string): void;
}

export class TouchControls {
  private root: HTMLElement;
  private ctls = new Map<string, Ctl>();
  private byFinger = new Map<number, Ctl>();
  private steering: Steering;
  private session: GameSession | null = null;
  private raf = 0;
  private drive = 0;
  private statusAt = 0;
  /** a finger touched the game; a keyboard or controller was used after the last touch */
  private seen = touchFirst();
  private away = false;
  private touchedAt = 0;
  private shown = false;
  private padButtons = 0;
  private lx = 0;
  // the thumb stick: its finger and where it landed
  private stickEl: HTMLElement;
  private baseEl: HTMLElement;
  private knobEl: HTMLElement;
  private stickFinger = -1;
  private stickX0 = 0;
  // tilt: the roll that counts as straight ahead (null: the next reading), whether the sensor answered
  private center: number | null = null;
  private lastRoll: number | null = null;
  private tiltHeard = false;
  private tiltCheck = 0;
  // the level horizon: the tilt from straight ahead (radians, unsmoothed), how far it is faded in, what the game has
  private tilt = 0;
  private levelK = 0;
  private levelAt = 0;
  private sentRoll = 0;

  constructor(stage: HTMLElement, private deps: TouchDeps) {
    this.steering = (() => { try { const s = localStorage.getItem(STORE) as Steering; return STEERING.includes(s) ? s : 'buttons'; } catch { return 'buttons'; } })();
    const root = this.root = document.createElement('div');
    root.className = 'touch'; root.hidden = true; root.dataset.nfsu2Ui = '';
    root.dataset.steering = this.steering;
    // the stick's zone first: the buttons above it take their own touches
    this.stickEl = document.createElement('div'); this.stickEl.className = 'stick';
    this.baseEl = document.createElement('div'); this.baseEl.className = 'stick-base';
    this.knobEl = document.createElement('div'); this.knobEl.className = 'stick-knob';
    this.baseEl.append(this.knobEl); this.stickEl.append(this.baseEl);
    root.append(this.stickEl);
    const add = (id: string, label: string, inner: string, c: Partial<Ctl>, cls = '') => {
      const el = document.createElement('div');
      el.className = `tc ${cls}`.trim(); el.dataset.ctl = id;
      el.setAttribute('role', 'button'); el.setAttribute('aria-label', label);
      el.innerHTML = inner;
      root.append(el);
      this.ctls.set(id, { id, el, fingers: new Set(), downAt: 0, upTimer: 0, ...c });
    };
    add('pause', 'Pause', path(ICONS.pause), { key: 'Escape' }, 'small');
    add('camera', 'Camera', path(ICONS.camera), { key: 'KeyC' }, 'small');
    add('look', 'Look back', path(ICONS.look), { key: 'KeyB' }, 'small');
    add('reset', 'Reset', path(ICONS.reset), { key: 'KeyR' }, 'small');
    add('map', 'Map', path(ICONS.map), { key: 'KeyM' }, 'small roam');
    add('msgs', 'Messages', path(ICONS.msgs), { key: 'Tab' }, 'small roam');
    add('horn', 'Horn', path(ICONS.horn), { key: 'KeyN' }, 'small roam');
    add('mode', 'Steering', path(ICONS[this.steering]), { act: () => this.nextSteering() }, 'small');
    add('center', 'Straight ahead', path(ICONS.center), { act: () => this.recenter() }, 'small');
    add('start', 'Start an event', 'Start', { key: 'Enter' }, 'pill roam');
    add('left', 'Steer left', path(ICONS.left), { key: 'ArrowLeft', group: 'steer' }, 'big');
    add('right', 'Steer right', path(ICONS.right), { key: 'ArrowRight', group: 'steer' }, 'big');
    add('brake', 'Brake', 'Brake', { key: 'ArrowDown', group: 'pedal' }, 'big');
    add('gas', 'Gas', 'Gas', { key: 'ArrowUp', group: 'pedal' }, 'big');
    add('nitro', 'Nitrous', 'Nitro', { bit: 1 << PAD_LB }, 'round');
    add('hb', 'Handbrake', '<span>Hand<br>brake</span>', { bit: 1 << PAD_RB }, 'round');
    add('down', 'Gear down', path(ICONS.down), { bit: 1 << PAD_X }, 'gear');
    add('up', 'Gear up', path(ICONS.up), { bit: 1 << PAD_A }, 'gear');
    stage.append(root);

    root.addEventListener('pointerdown', this.onDown);
    root.addEventListener('pointermove', this.onMove);
    root.addEventListener('pointerup', this.onUp);
    root.addEventListener('pointercancel', this.onUp);
    root.addEventListener('contextmenu', e => e.preventDefault());
    // a finger on the game brings the controls (back); a keyboard or controller sends them away
    stage.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      this.seen = true; this.away = false; this.touchedAt = performance.now(); this.update();
      // while driving, a finger beside the controls is no mouse for the game (it would draw its cursor in the race)
      if (this.shown && e.target instanceof HTMLCanvasElement) e.stopPropagation();
    }, { capture: true });
    addEventListener('keydown', e => { if (e.isTrusted && this.session) { this.away = true; this.update(); } }, { capture: true });
  }

  /** a game started: the controls follow its state until stop() */
  start(s: GameSession) {
    this.session = s;
    this.drive = 0;
    const tick = () => { this.frame(); this.raf = requestAnimationFrame(tick); };
    this.raf = requestAnimationFrame(tick);
  }

  /** for tests and logs: what the controls do now */
  state() { return { shown: this.shown, drive: this.drive, steering: this.steering, lx: this.lx, buttons: this.padButtons, roll: this.sentRoll }; }

  /** the game ended: everything let go, nothing of it kept */
  stop() {
    cancelAnimationFrame(this.raf);
    this.hide();
    this.levelK = this.tilt = 0;
    if (this.sentRoll) { this.sentRoll = 0; this.session?.input?.viewRoll?.(0); }
    this.session = null;
  }

  private frame() {
    const s = this.session;
    if (!s) return;
    const now = performance.now();
    if (now - this.statusAt > 100) {
      this.statusAt = now;
      const st = s.status?.read();                // null while the game writes it: the last state stands
      if (st) this.drive = st.get('drive') ?? 0;
    }
    if (!this.away && (s.input?.padPressed?.() ?? 0) > this.touchedAt) this.away = true;
    this.update();
    this.level(now);
  }

  /** the level horizon: the view turned against the tilt while tilt steers outside a cutscene, faded in and out
   *  (smoothstep) as that starts and ends, the tilt itself as the sensor gives it (a smoothed one would lag) */
  private level(now: number) {
    const on = this.shown && this.steering === 'tilt' && levelOn && (this.drive & 8) === 0;
    const dt = Math.min(100, now - this.levelAt);
    this.levelAt = now;
    this.levelK = Math.max(0, Math.min(1, this.levelK + (on ? dt : -dt) / LEVEL_FADE_MS));
    const k = this.levelK, roll = k * k * (3 - 2 * k) * this.tilt;
    if (roll === this.sentRoll) return;
    this.sentRoll = roll;
    this.session?.input?.viewRoll?.(roll);
  }

  private update() {
    const show = !!this.session && this.seen && !this.away && (this.drive & 3) > 0;
    this.root.toggleAttribute('data-roam', (this.drive & 3) === 2);
    this.root.toggleAttribute('data-gears', (this.drive & 4) !== 0);
    if (show === this.shown) return;
    if (show) {
      this.shown = true; this.root.hidden = false;
      if (this.steering === 'tilt') this.tiltOn();
      this.sendPad();
    } else this.hide();
  }

  /** hidden: every control let go, the stick and tilt at rest */
  private hide() {
    this.root.hidden = true;
    for (const c of this.ctls.values()) { c.fingers.clear(); this.up(c, true); }
    this.byFinger.clear();
    this.stickUp();
    this.tiltOff();
    this.lx = 0; this.padButtons = 0;
    if (this.shown) this.sendPad();
    this.shown = false;
  }

  private sendPad() {
    this.session?.input?.touchPad?.({ buttons: this.padButtons, lx: this.steering === 'buttons' ? 0 : this.lx });
  }

  // ---- fingers on the controls --------------------------------------------------------------
  private ctlAt(x: number, y: number): Ctl | undefined {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-ctl]');
    return el ? this.ctls.get(el.dataset.ctl!) : undefined;
  }
  private onDown = (e: PointerEvent) => {
    e.preventDefault();                       // the game's canvas keeps the focus, no mouse events follow
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-ctl]');
    const c = el ? this.ctls.get(el.dataset.ctl!) : undefined;
    if (c) { this.byFinger.set(e.pointerId, c); this.press(c, e.pointerId); return; }
    if ((e.target as HTMLElement).closest('.stick')) this.stickDown(e);
  };
  private onMove = (e: PointerEvent) => {
    if (e.pointerId === this.stickFinger) { this.stickMove(e); return; }
    const c = this.byFinger.get(e.pointerId);
    if (!c?.group) return;
    const to = this.ctlAt(e.clientX, e.clientY);
    if (!to || to === c || to.group !== c.group) return;
    this.release(c, e.pointerId);
    this.byFinger.set(e.pointerId, to);
    this.press(to, e.pointerId);
  };
  private onUp = (e: PointerEvent) => {
    if (e.pointerId === this.stickFinger) { this.stickUp(); this.sendPad(); return; }
    const c = this.byFinger.get(e.pointerId);
    if (!c) return;
    this.byFinger.delete(e.pointerId);
    this.release(c, e.pointerId);
    if (c.act && e.type === 'pointerup') c.act();       // the release is a user activation (tilt's permission)
  };

  private press(c: Ctl, finger: number) {
    c.fingers.add(finger);
    if (c.fingers.size > 1) return;
    c.el.classList.add('on');
    if (c.act) return;
    navigator.vibrate?.(8);
    if (c.upTimer) { clearTimeout(c.upTimer); c.upTimer = 0; return; }   // still down from the last tap
    c.downAt = performance.now();
    if (c.key) this.session?.input?.key?.(c.key, true);
    if (c.bit) { this.padButtons |= c.bit; this.sendPad(); }
  }
  private release(c: Ctl, finger: number) {
    c.fingers.delete(finger);
    if (c.fingers.size) return;
    c.el.classList.remove('on');
    if (c.act) return;
    // down HOLD_MS at least: the game reads its input once a frame, and a shorter tap could fall between two frames
    const wait = c.downAt + HOLD_MS - performance.now();
    if (wait > 0) c.upTimer = setTimeout(() => { c.upTimer = 0; if (!c.fingers.size) this.up(c); }, wait) as unknown as number;
    else this.up(c);
  }
  /** the control's key or button up (now: also one waiting for its HOLD_MS) */
  private up(c: Ctl, now = false) {
    if (now) { c.el.classList.remove('on'); if (!c.upTimer && !c.downAt) return; }
    clearTimeout(c.upTimer); c.upTimer = 0;
    if (!c.downAt) return;
    c.downAt = 0;
    if (c.key) this.session?.input?.key?.(c.key, false);
    if (c.bit) { this.padButtons &= ~c.bit; this.sendPad(); }
  }

  // ---- the thumb stick ---------------------------------------------------------------------
  private stickDown(e: PointerEvent) {
    if (this.stickFinger !== -1) return;
    this.stickFinger = e.pointerId; this.stickX0 = e.clientX;
    const rc = this.stickEl.getBoundingClientRect();
    this.baseEl.style.left = `${e.clientX - rc.left}px`; this.baseEl.style.top = `${e.clientY - rc.top}px`;
    this.baseEl.classList.add('on');
    navigator.vibrate?.(8);
  }
  private stickMove(e: PointerEvent) {
    const dx = Math.max(-STICK_PX, Math.min(STICK_PX, e.clientX - this.stickX0));
    this.knobEl.style.setProperty('--dx', `${dx}px`);
    this.lx = dx / STICK_PX;
    this.sendPad();
  }
  private stickUp() {
    this.stickFinger = -1;
    this.baseEl.classList.remove('on');
    this.baseEl.style.left = this.baseEl.style.top = ''; this.knobEl.style.removeProperty('--dx');
    if (this.steering === 'stick') this.lx = 0;
  }

  // ---- tilt ----------------------------------------------------------------------------------
  private onOrient = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    this.tiltHeard = true;
    const r = rollOf(e.beta, e.gamma, screen.orientation?.angle ?? 0);
    if (r === null) return;
    this.lastRoll = r;
    if (this.center === null) this.center = r;
    let d = r - this.center;
    if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
    const max = LEVEL_MAX_DEG * Math.PI / 180;
    this.tilt = Math.max(-max, Math.min(max, d));
    const v = Math.max(-1, Math.min(1, d / (TILT_DEG * Math.PI / 180)));
    this.lx = this.lx * 0.4 + v * 0.6;                  // a little smoothing of the sensor's jitter
    this.sendPad();
  };
  private tiltOn() {
    removeEventListener('deviceorientation', this.onOrient);
    addEventListener('deviceorientation', this.onOrient);
    this.center = null; this.tiltHeard = false;
    clearTimeout(this.tiltCheck);
    this.tiltCheck = setTimeout(() => {
      if (!this.tiltHeard && this.shown && this.steering === 'tilt')
        this.deps.toast('Tilt has no motion sensor to read in this browser. The steering button (top right) switches to buttons.', 6000);
    }, 2000) as unknown as number;
  }
  private tiltOff() {
    removeEventListener('deviceorientation', this.onOrient);
    clearTimeout(this.tiltCheck);
  }
  private recenter() {
    this.center = this.lastRoll;
    this.deps.toast('Straight ahead is where the phone is now.', 2000);
  }

  // ---- the steering button -------------------------------------------------------------------
  private nextSteering() {
    const to = STEERING[(STEERING.indexOf(this.steering) + 1) % STEERING.length];
    // iOS asks once whether the page may read the motion sensor, from a tap
    const ask = (DeviceOrientationEvent as unknown as { requestPermission?(): Promise<string> }).requestPermission;
    if (to === 'tilt' && typeof ask === 'function')
      void ask().then(r => { if (r !== 'granted') this.deps.toast('Tilt needs the motion sensor, which was not allowed.', 5000); }, () => {});
    this.setSteering(to);
    this.deps.toast(`Steering: ${NAMES[to]}${to === 'tilt' ? '. Hold the phone like a wheel; the button beside this one sets straight ahead.' : ''}`, to === 'tilt' ? 5000 : 2000);
  }
  private setSteering(to: Steering) {
    for (const c of this.ctls.values()) if (c.group) { c.fingers.clear(); this.up(c, true); }
    this.stickUp(); this.tiltOff();
    this.steering = to; this.lx = 0;
    this.root.dataset.steering = to;
    this.ctls.get('mode')!.el.innerHTML = path(ICONS[to]);
    try { localStorage.setItem(STORE, to); } catch { /* not kept: a private window */ }
    if (to === 'tilt' && this.shown) this.tiltOn();
    this.sendPad();
    this.deps.log(`[app] touch controls: steering with ${NAMES[to]}`);
  }
}
