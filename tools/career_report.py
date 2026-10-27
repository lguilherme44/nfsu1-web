#!/usr/bin/env python3
"""Summarise career-bot segment runs (tools/career_segments.sh output); TEST-ONLY tooling.

    tools/career_report.py <rundir> [<rundir> ...]

For every segment (segNN/log.txt): races won (name, type, stage), stage and
bank at the end, cover shoots, fps (min/median of the [status] lines), guest
heap and max RSS at the end, and the first-occurrence diagnostics ([trap],
[hle] UNIMPLEMENTED, unresolved indirect calls, faults, timeouts).  Prints a
Markdown table plus a per-stage x event-type count of races won.
"""
import re, sys, glob, os, statistics, collections

TYPES = {"CIRCUIT": "circuit", "SPRINT": "sprint", "STREET": "streetx", "SHORT": "streetx", "DRAG": "drag",
         "DRIFT": "drift", "URL": "url", "SUV": "suv"}

def race_kind(name):
    # S2_SPON_DRAG_1 -> (2, "sponsor drag"); STAGE_1_DRIFT_1 -> (1, "drift")
    m = re.match(r"(?:S|STAGE_)(\d)_(.*)", name)
    if not m:
        return None, name
    st, rest = int(m.group(1)), m.group(2).split("_")
    spon = "SPON" in rest
    t = next((TYPES[p] for p in rest if p in TYPES), "?")
    return st, ("sponsor " if spon else "") + t

def seg_report(log):
    txt = open(log, "r", errors="replace").read()
    races = []
    order = re.findall(r"\[career\] f=\d+ (\S+): teleport to marker type 13|racewin: player \(racer \d+ of \d+, "
                       r"was \d+\.\) finished, position (\d+)|\[bot\] f=\d+ (\S+) was lost", txt)
    cur = None
    for tgt, pos, lost in order:
        if tgt:
            cur = tgt
        elif pos and cur:
            races.append([cur, int(pos)])
            cur = None
        elif lost:
            for r in reversed(races):     # drift on points: finished first, lost the event
                if r[0] == lost:
                    r[1] = "lost"
                    break
    fps = [float(x) for x in re.findall(r"^\[status\] .* fps=([\d.]+)", txt, re.M)]
    st = re.findall(r"\[career\] f=\d+ stage (\d+) bank \$(\d+)", txt)
    # "heap N MB live, VA M MB" since round 2's integration review; before it
    # "heap N MB" was the reserved VA (the bump pointer before the heap track)
    done = re.search(r"segment done: (\d+) (?:races|events) won this launch, heap (\d+) MB(?: live, VA (\d+) MB)?, "
                     r"max rss (\d+) MB", txt)
    rss = re.findall(r"rss=(\d+)MB", txt)
    diag = sorted(set(re.findall(r"^(\[trap\].*|\[hle\] UNIMPLEMENTED.*|.*UNRESOLVED INDIRECT.*|\*\*\* FAULT IN GUEST.*|"
                                 r".*GUEST MEMORY FAULT.*|.*HOST SEGV.*|.*TIME LIMIT REACHED.*)$", txt, re.M)))
    # a cover shoot is reached by a jump onto its marker or, with NFSU2_CAREER_BOT_DRIVE=1, by driving
    shows = list(dict.fromkeys(re.findall(r"\[career\] f=\d+ showcase (\S+): (?:teleport|drive onto)", txt)))
    skipped = re.findall(r"\[bot\] f=\d+ (\S+): no engage dialog, skipped", txt)
    skipped += [f"{s} (not offered: visual rating)" for s in re.findall(r"\[bot\] f=\d+ (\S+) not offered", txt)]
    complete = "career complete" in txt
    return dict(races=races, fps=fps, stage=st[-1] if st else None, done=done, rss=rss[-1] if rss else "?",
                diag=diag, shows=shows, skipped=skipped, complete=complete)

def main():
    segs = []
    for d in sys.argv[1:]:
        segs += sorted(glob.glob(os.path.join(d, "seg*/log.txt")))
    grid = collections.Counter()
    print("| segment | races (finish position, or lost on points) | stage, bank at end | fps min / median | heap at end | max RSS | diagnostics |")
    print("|---|---|---|---|---|---|---|")
    for log in segs:
        r = seg_report(log)
        name = os.path.relpath(os.path.dirname(log), os.path.dirname(os.path.dirname(os.path.dirname(log))))
        for rn, pos in r["races"]:
            s, k = race_kind(rn)
            if pos == 1:
                grid[(s, k)] += 1
            elif pos == "lost":
                grid[(s, k + " (lost)")] += 1
        races = ", ".join(f"{rn} ({p})" for rn, p in r["races"]) or "-"
        fps = f"{min(r['fps']):.0f} / {statistics.median(r['fps']):.0f}" if r["fps"] else "-"
        stage = f"{r['stage'][0]}, ${r['stage'][1]}" if r["stage"] else "-"
        if not r["done"]:
            heap = "(career complete)" if r["complete"] else "(no clean end)"
        elif r["done"].group(3):
            heap = f"{r['done'].group(2)} MB (VA {r['done'].group(3)} MB)"
        else:
            heap = f"VA {r['done'].group(2)} MB"
        rss = f"{r['done'].group(4)} MB" if r["done"] else f"{r['rss']} MB"
        diag = "; ".join(x.strip()[:80] for x in r["diag"]) or "none"
        if r["skipped"]:
            diag += "; skipped: " + ", ".join(r["skipped"])
        print(f"| {name} | {races} | {stage} | {fps} | {heap} | {rss} | {diag} |")
    print()
    kinds = sorted({k for _, k in grid})
    stages = sorted({s for s, _ in grid if s is not None})
    print("| stage | " + " | ".join(kinds) + " |")
    print("|---|" + "---|" * len(kinds))
    for s in stages:
        print(f"| {s} | " + " | ".join(str(grid.get((s, k), "")) for k in kinds) + " |")

if __name__ == "__main__":
    main()
