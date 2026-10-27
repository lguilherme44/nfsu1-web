// The Controls sheet's steering wheel (controls.ts, the Controller tab): while a wheel is connected, what its controls
// do in the game (runtime/dinput_pad.c g_prof_wheel, the buttons as web/src/input/wheel.ts puts them), and its
// set-up, for a wheel the page reads wrong: let go, turn the wheel to full lock, press each pedal (WheelLearn).  The
// set-up is kept in this browser for that model, and the game's controller follows it at once (gamepad.ts).

import { familyOf } from '../input/gamepad';
import { guessMap, loadMap, saveMap, WheelLearn, wheelOf, type LearnStep } from '../input/wheel';

const STEPS: Record<LearnStep, string> = {
  rest: 'Centre the wheel, then let go of it and of the pedals.',
  steer: 'Turn the wheel right to where the car should steer all the way, and hold it there. A quarter turn suits this game.',
  gas: 'Let go of the wheel. Press the gas pedal all the way down and hold it.',
  brake: 'Let go of the gas. Press the brake pedal all the way down and hold it.',
  done: 'Done: the wheel is set up in this browser.',
};

/** the wheel the sheet is about: the first connected one the browser has no standard mapping for, or null */
function connectedWheel(): Gamepad | null {
  try { return navigator.getGamepads?.().find(g => !!g?.connected && g.mapping !== 'standard' && !!wheelOf(g.id)) ?? null; }
  catch { return null; }
}

/**
 * The wheel's part of the Controller tab, after the drawing (hidden with no wheel; the drawing hides while one is
 * there).  cap: a key cap with a button's Xbox and PlayStation names (the sheet shows its family's).
 */
export function wheelSection(pad: HTMLElement, cap: (xb: string, ps: string) => string) {
  const box = document.createElement('div');
  box.className = 'wheel';
  box.hidden = true;
  box.innerHTML = `<p class="wheel-name"></p>
    <dl class="keys">
      <div><dt>Wheel and pedals</dt><dd>Steer, throttle, brake and reverse</dd></div>
      <div><dt>Left and right paddles</dt><dd>Shift down, shift up</dd></div>
      <div><dt>${cap('A', 'cross')} ${cap('X', 'square')}</dt><dd>Nitrous, handbrake</dd></div>
      <div><dt>${cap('B', 'circle')} ${cap('Y', 'triangle')}</dt><dd>Look back, camera</dd></div>
      <div><dt>${cap('view', 'Share')} ${cap('menu', 'Options')}</dt><dd>Respawn, pause</dd></div>
      <div><dt>${cap('up', 'up')} ${cap('left', 'left')} ${cap('right', 'right')}</dt><dd>Start event, map, messages</dd></div>
    </dl>
    <div class="pad-foot">
      <p class="hint wheel-state"></p>
      <div class="row">
        <button type="button" class="text-btn" data-wheel="guess" hidden>Use the guess</button>
        <button type="button" class="btn" data-wheel="learn">Set up the wheel</button>
      </div>
    </div>
    <div class="wheel-learn" hidden>
      <p class="wheel-step" aria-live="polite"></p>
      <div class="bar"><div class="bar-fill"></div></div>
      <button type="button" class="text-btn" data-wheel="cancel">Cancel</button>
    </div>`;
  pad.append(box);
  const $ = <T extends HTMLElement>(s: string) => box.querySelector<T>(s)!;
  const learnBox = $('.wheel-learn'), step = $('.wheel-step'), fill = $('.bar-fill');
  const learnBtn = $<HTMLButtonElement>('[data-wheel="learn"]'), guessBtn = $<HTMLButtonElement>('[data-wheel="guess"]');

  let id = '', learn: WheelLearn | null = null, raf = 0;

  /** show the wheel connected now (or none), unless a set-up is going on */
  function refresh() {
    if (learn) return;
    const g = connectedWheel();
    id = g?.id ?? '';
    box.hidden = !g;
    for (const el of pad.children) if (el !== box) (el as HTMLElement | SVGElement).style.display = g ? 'none' : '';
    if (!g) return;
    $('.wheel-name').textContent = familyOf(g.id).name;
    const kept = !!loadMap(g.id);
    $('.wheel-state').textContent = kept ? 'Set up in this browser.'
      : 'How it steers and brakes is a guess from how the browser reports it. Wrong? Set it up.';
    guessBtn.hidden = !kept;
    learnBtn.textContent = kept ? 'Set up again' : 'Set up the wheel';
  }

  function stop(msg?: string) {
    cancelAnimationFrame(raf);
    learn = null;
    learnBox.hidden = true;
    learnBtn.disabled = false;
    refresh();
    if (msg) $('.wheel-state').textContent = msg;
  }

  function tick() {
    // the tab or the dialog closed: no set-up behind the player's back
    if (!learn || !(box.checkVisibility?.() ?? box.offsetParent !== null)) { stop(); return; }
    const g = navigator.getGamepads?.().find(p => !!p?.connected && p.id === id);
    if (!g) { stop('The wheel went away before its set-up was done.'); return; }
    if (learn.feed(Array.from(g.axes), performance.now())) step.textContent = STEPS[learn.step];
    fill.style.width = `${Math.round(learn.progress * 100)}%`;
    if (learn.step === 'done') {
      saveMap(id, learn.map());
      stop(STEPS.done);
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  learnBtn.onclick = () => {
    const g = connectedWheel();
    if (!g) { refresh(); return; }
    id = g.id;
    const info = wheelOf(g.id)!;
    learn = new WheelLearn(loadMap(g.id) ?? guessMap(info, Array.from(g.axes), g.buttons.length));
    step.textContent = STEPS.rest;
    fill.style.width = '0%';
    learnBox.hidden = false;
    learnBtn.disabled = true;
    raf = requestAnimationFrame(tick);
  };
  $<HTMLButtonElement>('[data-wheel="cancel"]').onclick = () => stop();
  guessBtn.onclick = () => { saveMap(id, null); refresh(); };

  addEventListener('gamepadconnected', refresh);
  addEventListener('gamepaddisconnected', refresh);
  refresh();
  return { refresh };
}
