// The game's output (stdout/stderr of every thread) kept in memory, the last
// few megabytes of it, for "Download log" (the Mac app's ~/Library/Logs/NFSU2).
// Lines also go to the console, where test runners read them.
//
// Players send the log after a crash, so a full log keeps what triage needs:
//  - its opening lines (the page's and the first game's start: the build, the
//    session line, settings, browser, renderer) and the lines given to keep()
//    (each later game's session lines) are never dropped, only what came between;
//  - a line, or a short group of lines, repeated back to back is kept once with
//    a count: a game error printed every frame (the force-feedback errors of
//    2026-10-21, tens of thousands of lines) no longer pushes out the history.

/** the longest group of lines folded (the force-feedback errors were two lines, each after an empty one) */
const FOLD_MAX = 4;
/** a group seen this many times in a row is folded */
const FOLD_MIN = 3;

export class LogRing {
  // the lines that may be dropped, oldest first from head; `total` counts every one ever added
  private lines: string[] = [];
  private head = 0;
  private bytes = 0;
  private total = 0;
  // the lines that stay: `at` = how many droppable lines came before
  private kept: { at: number; s: string }[] = [];
  private keptBytes = 0;
  private seen = 0;
  // a repeating group being folded: the next line expected (phase) and the repeats after the first
  private group: string[] | null = null;
  private phase = 0;
  private reps = 0;
  dropped = 0;
  constructor(private budget = 8 << 20, private echo = true, private headLines = 300, private keepBudget = 256 << 10) {}

  add(s: string) {
    if (this.echo) console.log(s);
    if (this.group) {
      if (s === this.group[this.phase]) {
        if (++this.phase === this.group.length) { this.phase = 0; this.reps++; }
        return;
      }
      this.endFold();
    }
    this.push(s, false);
    this.fold();
  }
  /** a line that stays when the log is trimmed (a game's session lines) */
  keep(s: string) {
    if (this.echo) console.log(s);
    if (this.group) this.endFold();
    this.push(s, true);
  }

  private push(s: string, keep: boolean) {
    const n = s.length + 1;
    if ((keep || this.seen++ < this.headLines) && this.keptBytes + n <= this.keepBudget) {
      this.kept.push({ at: this.total, s }); this.keptBytes += n;
      return;
    }
    this.lines.push(s); this.total++;
    this.bytes += n;
    while (this.bytes > this.budget && this.head < this.lines.length) {
      this.bytes -= this.lines[this.head].length + 1; this.head++; this.dropped++;
    }
    if (this.head > 4096 && this.head * 2 > this.lines.length) { this.lines = this.lines.slice(this.head); this.head = 0; }
  }
  /** the newest lines: the same group of k lines FOLD_MIN times in a row, after the last kept line, starts a fold */
  private fold() {
    const n = this.lines.length, last = this.kept.length ? this.kept[this.kept.length - 1].at : 0;
    const from = Math.max(this.head, n - (this.total - last));
    for (let k = 1; k <= FOLD_MAX; k++) {
      if (n - FOLD_MIN * k < from) return;
      let i = 1;
      while (i <= (FOLD_MIN - 1) * k && this.lines[n - i] === this.lines[n - i - k]) i++;
      if (i <= (FOLD_MIN - 1) * k) continue;
      this.group = this.lines.slice(n - k);
      this.phase = 0; this.reps = FOLD_MIN - 1;
      for (const l of this.lines.splice(n - (FOLD_MIN - 1) * k)) this.bytes -= l.length + 1;
      this.total -= (FOLD_MIN - 1) * k;
      return;
    }
  }
  private foldNote(more = ''): string {
    const k = this.group!.length;
    return `[log] ${k === 1 ? 'the line' : `the ${k} lines`} above repeated ${this.reps} more times${more}`;
  }
  private endFold() {
    const g = this.group!, phase = this.phase, note = this.foldNote();
    this.group = null;
    this.push(note, false);
    for (let i = 0; i < phase; i++) this.push(g[i], false);    // a group cut short
  }

  text(): string {
    const out: string[] = [];
    const first = this.total - (this.lines.length - this.head);  // the oldest droppable line still here
    let pos = 0;
    const upTo = (end: number) => {
      if (pos < first && end > pos) {
        const d = Math.min(end, first) - pos;
        out.push(`[... ${d} lines dropped: the log keeps its opening lines and the last ${(this.budget / 1048576).toFixed(0)} MB]`);
        pos += d;
      }
      for (; pos < end; pos++) out.push(this.lines[this.head + pos - first]);
    };
    for (const k of this.kept) { upTo(k.at); out.push(k.s); }
    upTo(this.total);
    if (this.group) out.push(this.foldNote(' (so far)'));
    return out.join('\n') + '\n';
  }
  /** the newest n lines, kept ones included (the test tools read it: window.__nfsu2.log) */
  tail(n: number): string[] {
    const out: string[] = [];
    if (this.group) out.push(this.foldNote(' (so far)'));
    let j = this.lines.length - 1, k = this.kept.length - 1, abs = this.total - 1;   // abs: lines[j]'s place
    while (out.length < n && (j >= this.head || k >= 0)) {
      if (k >= 0 && (j < this.head || this.kept[k].at > abs)) out.push(this.kept[k--].s);
      else { out.push(this.lines[j--]); abs--; }
    }
    return out.reverse();
  }
  get size() { return this.bytes + this.keptBytes; }
  get count() { return this.lines.length - this.head + this.kept.length; }
  clear() {
    this.lines = []; this.head = 0; this.bytes = 0; this.total = 0; this.dropped = 0;
    this.kept = []; this.keptBytes = 0; this.seen = 0; this.group = null;
  }
}

export function downloadBlob(data: BlobPart, name: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
