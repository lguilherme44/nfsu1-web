#!/usr/bin/env python3
"""Compare the per-frame drift traces of two or more runs.

    tools/drift_compare.py <run_dir_or_log> <run_dir_or_log> [...]  [--fields x,y,z,...]

Each log must contain "[trace] f=.. t=.. w=.. name=value ..." lines from the
autotest "trace" command (tests/scripts/drift_traj.txt).  Rows are matched by
world time since the run's first trace line (the scripts start the trace at
GO).  The traced w is world ms since the process started, front end
included (framerate.c hfr_sim_ms), so it differs between runs by seconds;
only the offset from the first line is compared, to 0.1 ms.  Runs with a
fixed world step (NFSU2_FIXED_DT) then line up frame by frame even if the
menus and loading took a different number of frames.  The printed w values
are those offsets.  For every run after the first it prints the first world
time where any traced value differs from the first run, the largest
difference per field, the drift summary (drifts, banked points, best pending)
and the final scores.
"""
import sys, os, re, math

def load(path):
    if os.path.isdir(path):
        path = os.path.join(path, 'log.txt')
    rows = {}
    rx = re.compile(r'\[trace\] f=(\d+) t=(\d+) w=([-0-9.]+) (.*)')
    w0 = None
    with open(path, errors='replace') as f:
        for line in f:
            m = rx.search(line)
            if not m:
                continue
            if w0 is None:
                w0 = float(m.group(3))
            w = round(float(m.group(3)) - w0, 1)
            vals = {}
            for kv in m.group(4).split():
                k, _, v = kv.partition('=')
                try:
                    vals[k] = float(v) if v not in ('?', '') else None
                except ValueError:
                    vals[k] = None
            rows[w] = vals
    return rows

def summary(rows):
    ws = sorted(rows)
    drifts, best, starts = 0, 0.0, 0
    last_st = None
    for w in ws:
        r = rows[w]
        st = r.get('st')
        if st is not None and last_st is not None and st != last_st and st == 0:
            drifts += 1
        if st == 1 and last_st != 1:
            starts += 1
        last_st = st
        if r.get('pend') is not None:
            best = max(best, r['pend'])
    fin = rows[ws[-1]] if ws else {}
    return dict(frames=len(ws), drifts=drifts, starts=starts, best_pending=best,
                total=fin.get('tot'), ai=[fin.get('a%d' % i) for i in range(4)],
                w_end=ws[-1] if ws else 0)

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    fields = None
    for a in sys.argv[1:]:
        if a.startswith('--fields='):
            fields = a.split('=', 1)[1].split(',')
    runs = [(a, load(a)) for a in args]
    base_name, base = runs[0]
    for name, rows in runs:
        s = summary(rows)
        print(f"{name}: {s['frames']} frames to w={s['w_end']:.0f} ms; drifts counted {s['drifts']}, "
              f"started {s['starts']}, best pending {s['best_pending']:.1f}, banked total {s['total']}, "
              f"AI totals {s['ai']}")
    for name, rows in runs[1:]:
        common = sorted(set(base) & set(rows))
        if not common:
            print(f"{name}: no common world times with {base_name}"); continue
        keys = fields or [k for k in base[common[0]] if k in rows[common[0]]]
        first = None; maxd = {k: 0.0 for k in keys}; maxw = {k: None for k in keys}
        for w in common:
            a, b = base[w], rows[w]
            for k in keys:
                x, y = a.get(k), b.get(k)
                if x is None or y is None:
                    continue
                d = abs(x - y)
                if d > 0 and first is None:
                    first = (w, k, x, y)
                if d > maxd[k]:
                    maxd[k] = d; maxw[k] = w
        print(f"\n{name} vs {base_name}: {len(common)} common frames")
        if first is None:
            print("  identical on every traced value")
        else:
            print(f"  first difference at w={first[0]:.3f} ms: {first[1]} {first[2]!r} vs {first[3]!r}")
            for k in keys:
                if maxd[k] > 0:
                    print(f"  max |d{k}| = {maxd[k]:.6g} (at w={maxw[k]:.0f} ms)")

if __name__ == '__main__':
    main()
