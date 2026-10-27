// The saves section of the start page: the profiles in this browser (each can
// be renamed for NFS Underground: ug1save.ts), a backup of the whole save
// overlay as a zip (profiles, registry.txt, settings.ini, screenshots) and
// restoring one, or adding the PC game's profiles beside the ones here
// (readBackup tells them apart), and the F12 screenshots (shots.ts); a keyphrase's saves come in as a
// backup does (readVault, restoreVault: vault-ui.ts).  And the section at the bottom of the page, the game data on
// this PC: how much of it, all of it downloaded ahead (predownload.ts), or
// deleted.  The game data is never part of a backup and never written back:
// it stays on the server.

import { cacheBytes, clearCache, clearSaveDir, filesOf, isScreenshot, listFiles, listProfiles, PROFILES_DIR, readBytes, writeFile, type Profile } from './savefs';
import { type RenameFiles } from './profile';
import { badFile, INDEX, INDEX_PATH, makeIndex, readIndex, ug1File, ug1Profiles } from './ug1save';
import { listZip, unzip, zip, ZipError, type ZipEntry } from './zip';
import { downloadBlob, stamp } from './logs';
import { fmtBytes } from './checks';
import { resolveEnv } from './settings';
import { gameDataKept, type DownloadState, type DownloadStatus, type Predownload } from './predownload';
import { ScreenshotsPart } from './shots';

export interface SavesDeps {
  saveDir: string;
  /** true while a game runs in this tab: no rename, no restore, no cache delete */
  busy(): boolean;
  confirm(title: string, body: Node | string, ok: string, danger?: boolean): Promise<boolean>;
  /** after a restore: settings.ini may have changed */
  onRestored(): void;
  /** the download of the game data (all but the movies) ahead of play */
  download: Predownload;
  /** the saves here changed (a rename, a restore): a keyphrase sends them */
  onChanged?(): void;
}

// Limits for a restore, judged by each entry's declared size before anything is
// inflated, and held while inflating (zip.ts stops an entry at its declared
// size: a 4 MB zip that declares 100 bytes and inflates to 4 GB is refused
// after 100, the audit's PAGE-4).  Screenshots (F12, about 24 MB each at this Mac's native size) have
// their own budget, so however many a backup holds they never crowd out the
// profiles, registry.txt or settings.ini (phase-1 app review, finding 5).
const MAX_ENTRY = 64 << 20, MAX_SHOTS = 512 << 20, MAX_OTHER = 256 << 20;
export { isScreenshot };

/**
 * What a backup's settings.ini would change that a player should know before restoring it: the network
 * (free roam on, the name shown to others), variables set by their own names, and lines the page ignores
 * (files and automation are the page's own).  [] when it holds none of these.
 */
export function settingsWarnings(text: string): string[] {
  const r = resolveEnv(text, {}, {});
  const set = (k: string) => r.source[k] === 'settings.ini';
  const out: string[] = [];
  const net = Object.keys(r.env).filter(k => set(k) && /^NFSU2_(ROAM|NET|LAN)/.test(k)).map(k => `${k}=${r.env[k]}`);
  if (set('NFSU2_ROAM') && parseInt(r.env.NFSU2_ROAM, 10) === 1)
    out.push(`It turns on free-roam multiplayer: your profile name${set('NFSU2_ROAM_NAME') ? ` (shown as "${r.env.NFSU2_ROAM_NAME}")` : ''}, car and position go to the other players on this server.`);
  if (net.length) out.push(`Network settings: ${net.join(', ')}`);
  const raw = r.other.filter(o => !o.refused).map(o => `${o.key} = ${o.value}`);
  if (raw.length) out.push(`Variables set by their own names: ${raw.slice(0, 6).join(', ')}${raw.length > 6 ? ' …' : ''}`);
  const ignored = r.other.filter(o => o.refused === 'only the page sets it').map(o => o.key);
  if (ignored.length) out.push(`Ignored, only the page sets them: ${ignored.join(', ')}`);
  return out;
}

/** A path from a backup that may be written into the save overlay, or null. */
export function safeEntryPath(name: string): string | null {
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return null;
  const parts = n.split('/').filter(p => p !== '' && p !== '.');
  if (!parts.length || parts.some(p => p === '..' || p.length > 255 || /[\x00-\x1f]/.test(p))) return null;
  return parts.join('/');
}

export async function exportSaves(saveDir: string): Promise<{ zip: Uint8Array; files: number; name: string; shotBytes: number }> {
  const files = await listFiles(saveDir);
  const entries: ZipEntry[] = [];
  let shotBytes = 0;
  for (const f of files) {
    if (f.path === 'autotest-script.txt') continue;          // a test run's input script, not a save
    const data = await readBytes(saveDir, f.path);
    if (isScreenshot(f.path)) shotBytes += data.length;
    entries.push({ name: f.path, data, mtime: f.mtime });
  }
  return { zip: zip(entries), files: entries.length, name: `nfsu2-saves-${stamp()}.zip`, shotBytes };
}

export interface Restore {
  /**
   * 'backup': a backup of this page's (registry.txt or settings.ini at its top), which replaces everything here;
   * 'profiles': profiles alone, as the PC game keeps them (its NFS Underground folder zipped in any shape), added
   * beside the ones here (addProfiles)
   */
  kind: 'backup' | 'profiles';
  entries: { path: string; data: Uint8Array; mtime?: number }[];
  profiles: string[];
  /** entries left out: unsafe names, over the size limits, or (profiles) none of a profile's */
  skipped: string[];
  /** profiles with a file the game would not load (ug1save.ts badFile), left out with all of their files */
  refused: { name: string; why: string }[];
  /** profiles with cars a mod added (profile.ts modCars), restored with a warning */
  modded: string[];
  /** profiles a save editor changed (profile.ts profileName's edited): sealed again, restored with a warning */
  edited: string[];
}

type FileIn = { path: string; data: Uint8Array; mtime?: number };
const lower = (s: string) => s.toLowerCase();

/** A zip of this page's backup, or of the PC game's NFS Underground folder (fileName: its name, for the messages). */
export async function readBackup(buf: Uint8Array, fileName = 'the file'): Promise<Restore> {
  void fileName;
  // a backup zipped from a folder ("saves/NFS Underground/...") still restores: strip one common top folder
  const listed = await listZip(buf);
  const names = listed.map(n => safeEntryPath(n)).filter((x): x is string => !!x);
  const top = names.length && names.every(n => n.includes('/') && n.split('/')[0] === names[0].split('/')[0]) &&
    !names.some(n => n.startsWith(PROFILES_DIR + '/')) ? names[0].split('/')[0] + '/' : '';
  const local = (name: string) => { let p = safeEntryPath(name); if (p && top && p.startsWith(top)) p = p.slice(top.length); return p; };
  let shots = 0, other = 0;
  const refused: string[] = [];
  const all = await unzip(buf, (name, size) => {
    const p = local(name);
    if (!p || size > MAX_ENTRY) return false;
    if (isScreenshot(p)) return (shots += size) <= MAX_SHOTS || ((shots -= size), false);
    return (other += size) <= MAX_OTHER || ((other -= size), false);
  }, refused);
  const files = all.map(e => ({ path: local(e.name)!, data: e.data, mtime: e.mtime }));
  return files.some(e => e.path === 'registry.txt' || e.path === 'settings.ini') ? backupIn(files, refused) : profilesIn(files, refused);
}

/**
 * The profiles among files already at their place ("NFS Underground/..."): each whole one (ug1save.ts badFile on
 * all of its files) is kept; one with a file the game would not load is refused, all of its files left out.
 */
function checkProfiles(files: FileIn[], out: Restore): Set<string> {
  const gone = new Set<string>();
  const byPath = new Map(files.map(f => [f.path, f]));
  for (const p of ug1Profiles(files.map(f => f.path))) {
    const why = p.files.map(x => { const u = ug1File(x, [p.name])!; return badFile(u.kind, p.name, byPath.get(x)!.data); }).find(w => w);
    if (why) { out.refused.push({ name: p.name, why }); for (const x of p.files) gone.add(x); }
    else out.profiles.push(p.name);
  }
  return gone;
}

/**
 * A backup of this page's: every entry but a profile the game would not load.  Profiles.usr (the game lists only
 * the profiles in it) is made again from what comes in: its names that are here, in its order, then the others.
 */
function backupIn(files: FileIn[], skipped: string[]): Restore {
  const out: Restore = { kind: 'backup', entries: [], profiles: [], skipped, refused: [], modded: [], edited: [] };
  const gone = checkProfiles(files, out);
  const idx = files.find(f => f.path === INDEX_PATH);
  out.entries = files.filter(f => !gone.has(f.path) && f.path !== INDEX_PATH);
  if (out.profiles.length || idx) {
    const listed = (idx && readIndex(idx.data)) ?? [];
    const names = [...listed.filter(n => out.profiles.some(p => lower(p) === lower(n))),
      ...out.profiles.filter(p => !listed.some(n => lower(n) === lower(p)))];
    out.entries.push({ path: INDEX_PATH, data: makeIndex(names), mtime: idx?.mtime });
  }
  return out;
}

/**
 * Profiles from the PC game's NFS Underground folder, zipped in any shape: a profile's files found by their names
 * wherever they are (ug1save.ts ug1File) go to "NFS Underground/"; its Profiles.usr and everything else are left
 * out (addProfiles makes the index here again).  A second file of the same name is skipped.
 */
function profilesIn(files: FileIn[], skipped: string[]): Restore {
  const out: Restore = { kind: 'profiles', entries: [], profiles: [], skipped, refused: [], modded: [], edited: [] };
  const placed: FileIn[] = [], seen = new Set<string>();
  for (const e of files) {
    const base = e.path.split('/').pop()!, at = `${PROFILES_DIR}/${base}`;
    if (base.toLowerCase() === INDEX.toLowerCase()) continue;          // made again here (addProfiles), not "left out"
    if (!ug1File(at) || seen.has(lower(base))) { out.skipped.push(e.path); continue; }
    seen.add(lower(base)); placed.push({ ...e, path: at });
  }
  const gone = checkProfiles(placed, out);
  const kept = new Set(ug1Profiles(placed.map(f => f.path)).flatMap(p => p.files));
  for (const f of placed) {
    if (kept.has(f.path) && !gone.has(f.path)) out.entries.push(f);
    else if (!kept.has(f.path)) out.skipped.push(f.path);       // a .cfg or a save with no .opt: no profile of its own
  }
  return out;
}

export async function restoreSaves(saveDir: string, r: Restore) {
  await clearSaveDir(saveDir);
  for (const e of r.entries) await writeFile(saveDir, e.path, e.data);
}

/**
 * A keyphrase's saves (vault.ts: a zip of the save folder but the screenshots) as a backup of this page's, whatever is
 * at their top: restoreVault puts them in place of everything here.  The same checks as a backup's.
 */
export async function readVault(buf: Uint8Array): Promise<Restore> {
  const refused: string[] = [];
  let other = 0;
  const all = await unzip(buf, (name, size) => {
    const p = safeEntryPath(name);
    return !!p && !isScreenshot(p) && size <= MAX_ENTRY && ((other += size) <= MAX_OTHER || ((other -= size), false));
  }, refused);
  return backupIn(all.map(e => ({ path: safeEntryPath(e.name)!, data: e.data, mtime: e.mtime })), refused);
}

/** readVault's saves in place of the ones here: everything goes but the screenshots (and a test's input script). */
export async function restoreVault(saveDir: string, r: Restore) {
  await clearSaveDir(saveDir, name => isScreenshot(name) || name === 'autotest-script.txt');
  for (const e of r.entries) await writeFile(saveDir, e.path, e.data);
}

/** a list of names: "a, b and c" */
const listOf = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];

/** What a restore's question says of its profiles' state: changed by a save editor, mod cars, left out, skipped. */
function restoreNotes(r: Restore): string[] {
  const items: string[] = [];
  const refused = r.refused.map(x => `${x.name}: ${x.why}`).join('; ');
  if (r.edited.length) items.push(`${listOf(r.edited)} ${r.edited.length > 1 ? 'were' : 'was'} changed outside the game, by a save editor (the checksums no longer matched): ` +
    'a value the game would not make itself may crash it or break the career.');
  if (r.modded.length) items.push(`${listOf(r.modded)} ${r.modded.length > 1 ? 'have' : 'has'} cars a mod added, which this game does not have: the game may crash or show them wrong when it loads them.`);
  if (refused) items.push(`Left out, as the game would not load ${r.refused.length > 1 ? 'them' : 'it'}: ${refused}.`);
  if (r.skipped.length) items.push(`${r.skipped.length} ${r.kind === 'profiles' ? 'other files are left out' : 'entries are skipped (unsafe names, or over the size limits)'}: ${r.skipped.slice(0, 3).join(', ')}${r.skipped.length > 3 ? ' …' : ''}`);
  return items;
}

/** What a backup's restore brings (or a keyphrase's, vault-ui.ts): its profiles, the game's options, settings.ini, restoreNotes. */
export function backupItems(r: Restore): string[] {
  const ini = r.entries.find(e => e.path === 'settings.ini');
  const warn = ini ? settingsWarnings(new TextDecoder().decode(ini.data)) : [];
  return [
    r.profiles.length ? `Profiles: ${r.profiles.join(', ')}` : 'No profiles',
    r.entries.some(e => e.path === 'registry.txt') ? 'The game\'s options (registry.txt)' : 'No registry.txt: the next launch starts with fresh game options',
    ini ? (warn.length ? `settings.ini. ${warn.join(' ')}` : 'settings.ini') : 'No settings.ini: the defaults apply',
    ...restoreNotes(r),
  ];
}

/**
 * Add the profiles of a Restore of kind 'profiles'.  A profile of the same name here (in any case: the I/O
 * worker finds names so) goes first, all of its files; nothing else changes.  Profiles.usr then lists the
 * profiles here as before, plus the new ones (the game loads only the profiles in it).
 */
export async function addProfiles(fs: RenameFiles, r: Restore) {
  const names = new Set(r.profiles.map(lower));
  const here = (await fs.listFiles()).map(f => f.path);
  const writing = new Set(r.entries.map(e => lower(e.path)));
  const old = ug1Profiles(here).filter(p => names.has(lower(p.name))).flatMap(p => p.files).filter(x => !writing.has(lower(x)));
  let listed: string[] | null = null;
  if (here.includes(INDEX_PATH)) listed = readIndex(await fs.readBytes(INDEX_PATH));
  listed ??= ug1Profiles(here).map(p => p.name);
  for (const e of r.entries) await fs.writeFile(e.path, e.data);
  for (const x of old) await fs.remove(x);
  await fs.writeFile(INDEX_PATH, makeIndex([...listed.filter(n => !names.has(lower(n))), ...r.profiles]));
}

/** "about 3 min left" */
function eta(s: number): string {
  if (!isFinite(s)) return '';
  if (s < 60) return 'less than a minute left';
  if (s < 3600) return `about ${Math.round(s / 60)} min left`;
  return `about ${(s / 3600).toFixed(1)} h left`;
}

export class SavesPanel {
  /** root: the Saves section; dataPanel: Game data on this PC */
  constructor(private root: HTMLElement, private dataPanel: HTMLElement, private deps: SavesDeps) {
    root.querySelector<HTMLButtonElement>('#export')!.onclick = () => void this.doExport();
    const inp = root.querySelector<HTMLInputElement>('#import')!;
    inp.onchange = () => { const f = inp.files?.[0]; inp.value = ''; if (f) void this.doImport(f); };
    dataPanel.querySelector<HTMLButtonElement>('#clear-cache')!.onclick = () => void this.doClearCache();
    dataPanel.querySelector<HTMLButtonElement>('#fetch-all')!.onclick = () => void this.doDownload();
    this.shots = new ScreenshotsPart(root, { saveDir: deps.saveDir, confirm: deps.confirm, changed: () => void this.refresh() });
  }

  private shots: ScreenshotsPart;

  private msg(s: string) { this.root.querySelector('#saves-msg')!.textContent = s; }
  private dataMsg(s: string, warn = false) { const m = this.dataPanel.querySelector('#data-msg')!; m.textContent = s; m.classList.toggle('warn', warn); }

  /** the game data in this browser: of the server's files (null: their list did not load), and all that is kept */
  private data: { have: number; total: number } | null = null;
  private kept = { bytes: 0, files: 0 };
  private counted = 0;                     // the latest count wins (one may start while the data is deleted)
  private shownState: DownloadState = 'idle';
  private profiles: Profile[] = [];
  /** what the section is writing into the saves (a rename, a restore): settled() waits for it */
  private writing: Promise<unknown> = Promise.resolve();

  /** Resolves when the section writes nothing into the saves: a game starts after that. */
  settled(): Promise<void> { return this.writing.then(() => {}, () => {}); }
  private write<T>(job: Promise<T>): Promise<T> { this.writing = job; return job; }

  /** Show the profiles, the screenshots and the downloaded game data as they are now. */
  async refresh() {
    const files = await listFiles(this.deps.saveDir);
    this.profiles = await listProfiles(this.deps.saveDir, files);
    this.shots.show(files.filter(f => isScreenshot(f.path)));
    const busy = this.deps.busy();
    this.showProfiles();
    this.root.querySelector<HTMLLabelElement>('.file-btn')!.toggleAttribute('aria-disabled', busy);
    this.root.querySelector<HTMLInputElement>('#import')!.disabled = busy;
    this.dataPanel.querySelector<HTMLButtonElement>('#clear-cache')!.disabled = busy;
    const waiting = /^Quit the game \(or close/;
    if (busy) { this.msg('Quit the game (or close the other tab that runs it) to rename a profile or restore a backup.'); this.dataMsg('Quit the game (or close the other tab that runs it) to change the game data.'); }
    else {
      if (waiting.test(this.root.querySelector('#saves-msg')!.textContent ?? '')) this.msg('');
      if (waiting.test(this.dataPanel.querySelector('#data-msg')!.textContent ?? '')) this.dataMsg('');
    }
    this.root.dataset.files = String(files.length);
    if (this.deps.download.running) { this.showData(); return; }     // it counts as it goes
    const n = ++this.counted;
    const [kept, data] = await Promise.all([cacheBytes(), gameDataKept(this.deps.download.language(), this.deps.download.texpack()).catch(() => null)]);
    if (n !== this.counted) return;
    this.kept = kept; this.data = data;
    this.showData();
  }

  /** The download's progress (Predownload's onChange), or what is kept when none runs. */
  showData(st: DownloadStatus = this.deps.download.status) {
    const active = st.state === 'running' || st.state === 'paused';
    if (active && st.total) this.data = { have: st.have, total: st.total };
    if (st.state !== this.shownState) {
      this.shownState = st.state;
      if (st.state === 'done') { this.data = { have: st.have, total: st.total }; this.dataMsg('The game data is on this PC now.'); }
      if (st.state === 'error') this.dataMsg(`Preloading stopped: ${st.error}. What it preloaded is kept.`, true);
      if (!active) void this.refresh();                         // counted again; shown now with what is known
    }
    const info = this.dataPanel.querySelector('#cache-info')!, bar = this.dataPanel.querySelector<HTMLElement>('#data-bar')!;
    const fetchBtn = this.dataPanel.querySelector<HTMLButtonElement>('#fetch-all')!;
    const d = this.data, rest = d ? d.total - d.have : 0;
    bar.hidden = !active;
    fetchBtn.disabled = this.deps.busy() && !active;
    if (active) {
      const f = d?.total ? d.have / d.total : 0;
      (bar.firstElementChild as HTMLElement).style.width = `${(f * 100).toFixed(1)}%`;
      bar.setAttribute('aria-valuenow', String(Math.floor(f * 100)));
      fetchBtn.hidden = false;
      fetchBtn.textContent = 'Stop preloading';
      fetchBtn.disabled = st.state === 'paused';
      info.textContent = st.state === 'paused' ? `Preloading paused while the game runs: ${d ? `${fmtBytes(d.have)} of ${fmtBytes(d.total)}` : 'counting'}. It goes on when the game ends.`
        : !d ? 'Preloading the game data: counting what is here already.'
        : `Preloading the game data: ${fmtBytes(d.have)} of ${fmtBytes(d.total)} (${Math.floor(f * 100)} %)${st.rate ? `, ${fmtBytes(st.rate)}/s, ${eta(rest / st.rate)}` : ''}. ` +
          'Play whenever you like: preloading pauses while the game runs and goes on after it.';
      return;
    }
    fetchBtn.textContent = d && d.have ? `Preload the rest (${fmtBytes(rest)})` : `Preload the game data${d ? ` (${fmtBytes(d.total)})` : ''}`;
    fetchBtn.hidden = !!d && rest <= 0;
    if (d && rest <= 0)
      info.textContent = `The game data (${fmtBytes(d.total)}) is kept in this browser: the game loads it from this PC, not the network. Only the movies stream from the server, as they play` +
        `${'serviceWorker' in navigator ? ', and the game starts without the server too (offline, with the movies off)' : ''}. Deleting it only means loading it from the server again.`;
    else if (d ? d.have : this.kept.bytes)
      info.textContent = `${d ? `${fmtBytes(d.have)} of the game's ${fmtBytes(d.total)} (without the movies)` : fmtBytes(this.kept.bytes)} is kept in this browser, so the game loads that from this PC instead of the network. ` +
        'Preload the rest too, and no loading screen waits on the network. Deleting it only means loading it from the server again.';
    else
      info.textContent = 'Nothing here yet. The game streams its data from the server as it needs it and keeps it here. Preload it now (all but the movies, compressed on the way) and no loading screen waits on the network.';
  }

  /** The profiles.  No Rename: an NFS Underground profile's name is inside files the page does not change (ug1save.ts). */
  private showProfiles() {
    const ul = this.root.querySelector('#profiles')!;
    ul.replaceChildren();
    if (!this.profiles.length) {
      const li = document.createElement('li'); li.className = 'empty';
      li.textContent = 'No profiles yet. Create one in the game: it is saved in this browser.';
      ul.append(li);
    }
    for (const p of this.profiles) {
      const li = document.createElement('li');
      const n = document.createElement('span'); n.className = 'name'; n.textContent = p.name;
      const m = document.createElement('span'); m.className = 'meta';
      m.textContent = `saved ${new Date(p.mtime).toLocaleString()}, ${fmtBytes(p.size)}`;
      li.append(n, m); ul.append(li);
    }
  }

  private async doDownload() {
    const dl = this.deps.download;
    if (dl.running) { await dl.stop(); this.dataMsg('Preloading stopped. What it preloaded is kept: Preload the rest goes on from there.'); return; }
    if (this.deps.busy()) return;
    this.dataMsg('');
    dl.start();
  }

  private async doExport() {
    try {
      const e = await exportSaves(this.deps.saveDir);
      downloadBlob(e.zip as BlobPart, e.name, 'application/zip');
      this.msg(`Downloaded ${e.name}: ${e.files} files, ${fmtBytes(e.zip.length)}.` + (e.shotBytes > MAX_SHOTS
        ? ` It holds ${fmtBytes(e.shotBytes)} of screenshots: a restore keeps the saves and settings and only the first ${fmtBytes(MAX_SHOTS)} of screenshots.` : ''));
    } catch (err) { this.msg(`The backup failed: ${err}`); }
  }

  private async doImport(file: File) {
    if (this.deps.busy()) { this.msg('Quit the game first: restoring replaces the saves it is using.'); return; }
    let r: Restore;
    try { r = await readBackup(new Uint8Array(await file.arrayBuffer()), file.name); }
    catch (err) {
      this.msg(err instanceof ZipError ? `${file.name} cannot be restored: ${err.message === 'not a zip file' ? 'it is not a zip (a backup, or the PC game\'s NFS Underground folder zipped)' : err.message}.`
        : `${file.name} cannot be read: ${err}`);
      return;
    }
    const refused = r.refused.map(x => `${x.name}: ${x.why}`).join('; ');
    if (!r.profiles.length && (r.kind === 'profiles' || !r.entries.length)) {
      const one = r.refused.length === 1 ? r.refused[0] : null;
      this.msg(one ? `${one.name === file.name ? file.name : `The profile ${one.name} in ${file.name}`} cannot be restored: ${one.why}.`
        : refused ? `${file.name} has no profile the game can load: ${refused}.`
        : `${file.name} has no save files.`);
      return;
    }
    const list = listOf;
    const body = document.createElement('div');
    const p = document.createElement('p');
    const items: string[] = [];
    const here = new Map(this.profiles.map(x => [x.name.toLowerCase(), x.name]));
    const replaced = r.profiles.map(n => here.get(n.toLowerCase())).filter((x): x is string => !!x);
    if (r.kind === 'profiles') {
      p.textContent = `Adds the ${r.profiles.length > 1 ? 'profiles' : 'profile'} in ${file.name} to this browser. The other profiles here, the game's options and settings.ini stay as they are.`;
      items.push(`Profiles: ${r.profiles.join(', ')}`);
      if (replaced.length) items.push(replaced.length > 1 ? `Replaces the profiles ${list(replaced)} in this browser, their careers too`
        : `Replaces the profile ${replaced[0]} in this browser, its career too`);
      items.push(...restoreNotes(r));
    } else {
      p.textContent = `Restoring replaces every profile, the game's options and settings.ini in this browser with the ${r.entries.length} files in ${file.name}.`;
      items.push(...backupItems(r));
    }
    const ul = document.createElement('ul');
    for (const t of items) { const li = document.createElement('li'); li.textContent = t; ul.append(li); }
    body.append(p, ul);
    const adding = r.kind === 'profiles';
    if (!await this.deps.confirm(adding ? `Add ${r.profiles.length > 1 ? 'these profiles' : 'this profile'}?` : 'Restore this backup?', body,
      adding ? `Add ${r.profiles.length > 1 ? 'profiles' : 'profile'}` : 'Restore backup', !adding || replaced.length > 0)) { this.msg('Nothing changed.'); return; }
    try {
      if (adding) {
        await this.write(addProfiles(filesOf(this.deps.saveDir), r));
        this.msg(`Added ${list(r.profiles)} from ${file.name}.`);
      } else {
        await this.write(restoreSaves(this.deps.saveDir, r));
        this.msg(`Restored ${r.entries.length} files from ${file.name}.`);
        this.deps.onRestored();
      }
    } catch (err) { this.msg(`${adding ? 'Adding' : 'Restoring'} stopped halfway: ${err}. ${adding ? 'Add the profiles' : 'Restore the backup'} again before playing.`); }
    this.deps.onChanged?.();
    await this.refresh();
  }

  private async doClearCache() {
    if (this.deps.busy()) return;
    const dl = this.deps.download;
    if (!await this.deps.confirm('Delete the game data on this PC?', `${dl.running ? 'This stops preloading. ' : ''}The game will stream it from the server again the next time, which is slower once. Your saves are not touched.`, 'Delete game data', true)) return;
    await dl.stop();
    await clearCache();
    await this.refresh();
    this.dataMsg('Game data on this PC deleted.');
  }
}
