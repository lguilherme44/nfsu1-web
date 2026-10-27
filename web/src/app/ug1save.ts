// NFS Underground (2003)'s save folder as far as the page reads or writes it.
// Whole files only: the page never changes a byte inside one, as it does for
// NFSU2's profiles (profile.ts).  Read from SPEED.EXE 1.4 and the files it wrote
// in the browser (2026-10-24):
//
//   NFS Underground/Profiles.usr        the index: u32 count, then 32 bytes per profile, its name and a NUL
//                                       (0x41d58a copies the name into a stack buffer it never clears, so the
//                                       rest of each slot is whatever was there).  The game lists ONLY the
//                                       profiles in it: with the other files there and no index, LOAD DRIVER
//                                       PROFILE was empty.
//   NFS Underground/<NAME>.opt          u32 0x13, u32 0, the name (NUL-terminated), the options
//   NFS Underground/<NAME>.cfg          text: "BPP: 32", "RES: 0" ... (the video options)
//   NFS Underground/<NAME>_<slot>.ugd   the career: u32 0x13, the slot's name ("auto" for <NAME>_autosave),
//                                       then the time the game stamps (GetTimeFormatA, GetDateFormatA)
//
// Pure (no DOM, no OPFS), so it can be checked under node.

export const PROFILES_DIR = 'NFS Underground';
export const INDEX = 'Profiles.usr';
export const INDEX_PATH = `${PROFILES_DIR}/${INDEX}`;
export const VERSION = 0x13;
const SLOT = 32;

export type Ug1Kind = 'opt' | 'cfg' | 'save';
const lower = (s: string) => s.toLowerCase();
const u32 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(at, true);

/**
 * What a file of the save folder is to a profile: "NFS Underground/<NAME>.opt" and so on.  A save's
 * <NAME> is the part before the slot's "_"; names: the profiles known (by their .opt), so a name with
 * a "_" of its own still finds its saves (the longest known name that fits wins).
 */
export function ug1File(path: string, names: string[] = []): { name: string; kind: Ug1Kind } | null {
  const p = path.split('/');
  if (p.length !== 2 || p[0] !== PROFILES_DIR) return null;
  const f = p[1];
  const m = /^(.+)\.(opt|cfg)$/i.exec(f);
  if (m) return { name: m[1], kind: lower(m[2]) as Ug1Kind };
  if (!/\.ugd$/i.test(f)) return null;
  const stem = f.slice(0, -4);
  const known = names.filter(n => lower(stem).startsWith(lower(n) + '_')).sort((a, b) => b.length - a.length)[0];
  if (known) return { name: stem.slice(0, known.length), kind: 'save' };
  const u = stem.indexOf('_');
  return u > 0 ? { name: stem.slice(0, u), kind: 'save' } : null;
}

/** The names in Profiles.usr, or null if it is not one (size, count). */
export function readIndex(d: Uint8Array): string[] | null {
  if (d.length < 4) return null;
  const n = u32(d, 0);
  if (n > 1000 || d.length !== 4 + n * SLOT) return null;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let s = '';
    for (let k = 4 + i * SLOT; k < 4 + (i + 1) * SLOT && d[k]; k++) s += String.fromCharCode(d[k]);
    if (!s) return null;
    out.push(s);
  }
  return out;
}

/** Profiles.usr for these names, as the game writes it but with the rest of each slot zeroed. */
export function makeIndex(names: string[]): Uint8Array {
  const d = new Uint8Array(4 + names.length * SLOT);
  new DataView(d.buffer).setUint32(0, names.length, true);
  names.forEach((n, i) => { for (let k = 0; k < n.length && k < SLOT - 1; k++) d[4 + i * SLOT + k] = n.charCodeAt(k) & 0xff; });
  return d;
}

/** The name inside a .opt, or null if it is not one of SPEED.EXE 1.4's (its version). */
export function optName(d: Uint8Array): string | null {
  if (d.length < 12 || u32(d, 0) !== VERSION) return null;
  let s = '';
  for (let k = 8; k < 8 + SLOT && k < d.length && d[k]; k++) s += String.fromCharCode(d[k]);
  return s || null;
}

/**
 * Why a file of a profile is not one the game would load, or null: a .opt of another version or
 * with another name inside, a .ugd of another version, an empty .cfg.  Whole files are all the
 * page checks; it has no checksum of these to check.
 */
export function badFile(kind: Ug1Kind, name: string, d: Uint8Array): string | null {
  if (kind === 'opt') {
    const inside = optName(d);
    if (inside === null) return `${name}.opt is not a profile of this version of the game`;
    return lower(inside) === lower(name) ? null : `${name}.opt holds the profile "${inside}"`;
  }
  if (kind === 'save') return d.length >= 16 && u32(d, 0) === VERSION ? null : `a career save of ${name} is not one of this version of the game`;
  return d.length ? null : `${name}.cfg is empty`;
}

export interface Ug1Profile { name: string; files: string[] }

/** The profiles among these paths: one per .opt, with its .cfg and saves. */
export function ug1Profiles(paths: string[]): Ug1Profile[] {
  const names = paths.map(p => ug1File(p)).filter(f => f?.kind === 'opt').map(f => f!.name);
  const by = new Map(names.map(n => [lower(n), { name: n, files: [] as string[] }]));
  for (const p of paths) {
    const f = ug1File(p, names);
    if (f) by.get(lower(f.name))?.files.push(p);
  }
  return [...by.values()];
}
