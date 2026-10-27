// Free roam's race lobby over the game (roam_game.c mp_panel, NET_KIND_LOBBY): at a race's start what Enter does
// there, a lobby's six places with its players and its countdown; during the trip to the race and back a cover over
// the game's menus (the race and its results stay the game's own).  The game sends its state as JSON when it
// changes, "{}" for nothing to show.

/** what the game sends (roam_game.c mp_panel) */
interface LobbyState {
  /** spot: a multiplayer-only spot, Enter opens a lobby; join: a lobby here to join; full: the lobby here is full,
   *  Enter opens another; lobby: ours, or the one we are in; trip: the way to the race and back; note: a message */
  v?: 'spot' | 'join' | 'full' | 'lobby' | 'trip' | 'note';
  /** lobby: host (ours), asked (joining), in (joined), count (the countdown, t seconds) */
  st?: 'host' | 'asked' | 'in' | 'count';
  kind?: string; track?: string; laps?: number;
  /** the lobby's players, the host first; me: our place in it (-1: none); max: its places; t: the countdown's
   *  seconds; closes: the seconds left of a lobby nobody joined (its last minute); fee: what quitting the race costs;
   *  even: the race evens out the cars (their engines) */
  names?: string[]; me?: number; max?: number; t?: number; closes?: number; fee?: number; even?: number;
  why?: string; step?: string; text?: string;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class LobbyPanel {
  private last = '';
  constructor(private panel: HTMLElement, private cover: HTMLElement, private log?: (s: string) => void) {}

  /** the game's state (JSON); a bad one shows nothing */
  show(json: string) {
    if (json === this.last) return;
    this.last = json;
    let s: LobbyState = {};
    try { s = JSON.parse(json) as LobbyState; } catch { this.log?.(`[lobby] not JSON: ${json.slice(0, 80)}`); }
    const was = !this.cover.hidden;
    this.cover.hidden = s.v !== 'trip';
    if (s.v === 'trip') this.drawCover(s);
    else if (was) this.cover.replaceChildren();
    this.panel.hidden = !s.v || s.v === 'trip';
    if (!this.panel.hidden) this.drawPanel(s);
    if (was !== !this.cover.hidden) this.log?.(`[lobby] cover ${this.cover.hidden ? 'off' : 'on'}`);
  }

  /** gone with the game */
  clear() { this.show('{}'); }

  /** the panel's place: under the game's Bank box, its right edge on the box's (x 299, y -198 to -168 in the HUD's
   *  units from the middle of the picture; one unit is u px), out to the edge of a wide HUD with hud = wide, as the
   *  radar's side (shell.ts placeNotices); v: the game's picture on the page */
  place(v: { x: number; y: number; w: number; h: number }, wide: boolean) {
    const u = Math.min(v.w / 640, v.h / 480), e169 = 320 * (16 / 9 * 0.75 - 1);
    const out = wide ? Math.min(Math.max(320 * (v.w / v.h * 0.75 - 1), 0), e169) * 109 / e169 : 0;
    const s = this.panel.style;
    s.left = `${v.x + v.w / 2 + (299 + out) * u}px`;
    s.top = `${v.y + v.h / 2 - 158 * u}px`;
    s.setProperty('--u', `${u}px`);
    this.cover.style.setProperty('--u', `${u}px`);
  }

  private title(s: LobbyState, host?: string) {
    const k = s.kind ?? 'race';
    const head = el('div', 'lobby-title', host ? `${host}'s ${k}` : `Multiplayer ${k}`);
    const sub = [s.track, s.laps ? `${s.laps} laps` : ''].filter(Boolean).join(' · ');
    return sub ? [head, el('div', 'lobby-sub', sub)] : [head];
  }

  /** the lobby's places: its players (the host marked, ours "you"), the rest open */
  private places(s: LobbyState, dim = false) {
    const ol = el('ol', 'lobby-places' + (dim ? ' dim' : ''));
    const names = s.names ?? [], n = Math.max(2, Math.min(6, s.max ?? 6));
    for (let i = 0; i < n; i++) {
      const li = el('li', i < names.length ? 'taken' : 'open');
      li.append(el('span', 'lobby-n', String(i + 1)));
      li.append(el('span', 'lobby-name', i < names.length ? names[i] : 'open'));
      if (i < names.length && (i === 0 || i === s.me)) li.append(el('span', 'lobby-tag', i === 0 ? 'host' : 'you'));
      ol.append(li);
    }
    return ol;
  }

  /** a key and what it does */
  private act(key: string | null, what: string) {
    const d = el('div', 'lobby-act');
    if (key) d.append(el('kbd', '', key));
    d.append(el('span', '', what));
    return d;
  }

  private drawPanel(s: LobbyState) {
    const p = this.panel, names = s.names ?? [], host = names[0] ?? 'A player';
    const kids: HTMLElement[] = [];
    p.dataset.v = s.v ?? '';
    switch (s.v) {
      case 'spot':
        kids.push(...this.title(s), el('div', 'lobby-why', `Multiplayer only here: ${s.why ?? 'not open in your career'}`),
          this.act('Enter', 'Open a lobby'));
        break;
      case 'join':
        kids.push(...this.title(s, host), this.places(s), this.act('Enter', 'Join'));
        break;
      case 'full':
        kids.push(...this.title(s, host), this.places(s), el('div', 'lobby-why', 'This lobby is full.'), this.act('Enter', 'Open another'));
        break;
      case 'lobby': {
        const mine = s.me === 0;
        kids.push(...this.title(s, mine ? undefined : host), this.places(s, s.st === 'asked'));
        if (s.st === 'count') kids.push(el('div', 'lobby-count', `Starting in ${s.t ?? 0}`));
        else if (s.st === 'asked') kids.push(this.act(null, `Joining ${host}'s ${s.kind ?? 'race'}…`));
        else if (mine && names.length >= 2) kids.push(this.act('Enter', 'Start the race'), el('div', 'lobby-hint', 'Drive away to call it off'));
        else if (mine) kids.push(this.act(null, 'Waiting for players to drive up and join…'),
          el('div', 'lobby-hint', s.closes !== undefined ? `Closes in ${s.closes} s if nobody joins` : 'Drive away to call it off'));
        else kids.push(this.act(null, `Waiting for ${host} to start`), el('div', 'lobby-hint', 'Drive away to leave'));
        break;
      }
      case 'note':
        kids.push(el('div', 'lobby-note', s.text ?? ''));
        break;
    }
    if (s.v === 'join' && s.even) kids.push(el('div', 'lobby-hint', 'The cars are evened out: slower ones get more engine power, faster ones a little less'));
    if (s.v === 'join' && s.fee) kids.push(el('div', 'lobby-hint', `Quitting the race costs $${s.fee}`));
    p.replaceChildren(...kids);
  }

  private drawCover(s: LobbyState) {
    const card = el('div', 'lobby-card');
    card.append(...this.title(s, undefined), this.places(s));
    const step = el('div', 'lobby-step');
    step.append(el('span', 'lobby-spin'), el('span', '', `${s.step || 'Loading'}…`));
    card.append(step);
    this.cover.replaceChildren(card);
  }
}
