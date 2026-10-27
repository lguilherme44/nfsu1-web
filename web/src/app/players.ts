// How many play on this server now, for the start page's Multiplayer settings: the server's /players (three
// counts, whether it is full, how many wait in line for a place and whether free roam is busy, nothing else; with a Room setting, how many are in
// free roam in that room too).  Asked every 15 s, and only while the start page is visible and no game runs; a
// server without the route shows nothing.  Whether the server answered at all goes to reached() (offline mode).

/** roam: driving in free roam or paused there (null, or missing from an older server: not shown);
 *  roamBusy: free roam gives fewer cars a player now (the server's hub cut its links), so the first Play does not ask about it;
 *  room: of roam, those in the room asked for (/players?room=, missing without one or from an older server) */
export interface PlayerCounts {
  players: number; online: number | null; roam?: number | null; full?: boolean; roamBusy?: boolean; room?: number;
  /** pages waiting in line for a place (missing from an older server) */
  queue?: number;
}

const EVERY_MS = 15_000;
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** The Room setting's hash, as roam_core.c rc_room_hash makes it (FNV-1a of the name's UTF-8 without its spaces and
 *  with its capitals A to Z small; 0: no room), for /players?room= */
export function roomHash(name: string): number {
  let h = 0x811c9dc5, kept = 0;
  for (let b of new TextEncoder().encode(name)) {
    if (b === 0x20 || (b >= 0x09 && b <= 0x0d)) continue;
    if (b >= 0x41 && b <= 0x5a) b += 0x20;
    h = Math.imul(h ^ b, 0x01000193) >>> 0; kept++;
  }
  return !kept ? 0 : h || 1;
}

/** The line the page shows ('' for an answer it cannot read); room: the player's Room setting, when free roam is on
 *  ('' for none): free roam shows only that room's players, which the line says, with how many are there. */
export function playersText(c: PlayerCounts, room = ''): string {
  if (!Number.isInteger(c.players) || c.players < 0) return '';
  if (c.players === 0) return 'On this server now: nobody is playing.';
  const count = (k: number | null | undefined, what: string) => Number.isInteger(k) && k! >= 0 ? `, ${k} ${what}` : '';
  const on = count(c.online, 'in Online mode') + count(c.roam, 'in free roam');
  room = room.trim();
  const inRoom = !room ? '' : Number.isInteger(c.room) && c.room! >= 0
    ? ` You are in room "${room}": ${c.room === 0 ? 'nobody' : c.room} in free roam there.` : ` You are in room "${room}".`;
  const waiting = Number.isInteger(c.queue) && c.queue! > 0 ? c.queue! : 0;
  const full = c.full !== true ? ''
    : waiting ? ` The server is full and ${waiting} ${waiting === 1 ? 'is' : 'are'} waiting in line for a place. At Play you can wait in line, playing alone until it is your turn, or play offline.`
    : ' The server is full: playing with others waits until a place frees up.';
  return `On this server now: ${n(c.players, 'player', 'players')}${on}.${inRoom}${full}`;
}

/** 1st, 2nd, 3rd, 4th, ..., 11th, 12th, 13th, ..., 21st */
function ordinal(k: number): string {
  const t = k % 100, u = k % 10;
  return `${k}${t >= 11 && t <= 13 ? 'th' : u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th'}`;
}

/** The line over the game while it waits in line for a place on a full server (net's NetQueue): where it is, and
 *  about how long that is (once the server can tell). */
export function queueText(q: { pos: number; of: number; eta?: number }): string {
  const e = q.eta;
  const wait = e === undefined ? '' : e < 60 ? ' (less than a minute)' : e < 90 * 60 ? ` (about ${Math.round(e / 60)} min)` : ` (about ${Math.round(e / 3600)} h)`;
  return q.pos <= 1 ? `The server is full. In line for a place: next${wait}.` : `The server is full. In line for a place: ${ordinal(q.pos)} of ${q.of}${wait}.`;
}

/** Whether the server answers (any answer but a 5xx from a proxy in front of it), within ms. */
export async function serverAnswers(ms: number): Promise<boolean> {
  try { return (await fetch('/players', { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(ms) })).status < 500; }
  catch { return false; }
}

/** show(line) at once and every 15 s while idle() and the page is visible; reached(whether the server answered);
 *  room(): the Room setting while free roam is on ('' for none); last(): the newest answer (null before the first,
 *  or from a server without the route); fresh(ms): asked now, whatever the page does (Play: whether the server is
 *  full), within ms, then the newest answer */
export function watchPlayers(show: (line: string) => void, idle: () => boolean, reached?: (ok: boolean) => void, room: () => string = () => '') {
  let gone = false, last: PlayerCounts | null = null;
  const get = async (ms: number) => {
    if (gone) return;
    try {
      const name = room(), hash = roomHash(name);
      const r = await fetch(hash ? `/players?room=${hash}` : '/players', { cache: 'no-store', signal: AbortSignal.timeout(ms) });
      reached?.(r.status < 500);
      if (r.status === 404) { gone = true; last = null; show(''); return; }
      if (r.ok) { last = await r.json() as PlayerCounts; show(playersText(last, hash ? name : '')); }
    } catch { reached?.(false); }
  };
  const ask = async () => { if (document.visibilityState === 'visible' && idle()) await get(5000); };
  window.setInterval(() => void ask(), EVERY_MS);
  document.addEventListener('visibilitychange', () => void ask());
  void ask();
  return { now: () => void ask(), last: () => last, fresh: async (ms: number) => { await get(ms); return last; } };
}
