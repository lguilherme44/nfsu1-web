#!/usr/bin/env python3
"""Drift scoring rules over a per-frame "[trace]" log (tests/scripts/drift_score.txt):
the accrual law, banking and the crash loss, checked wherever they occur.

The vanilla rule (Style::Update 0x56E920 via 0x56C740): while the human racer's first style is starting or drifting
(state 1 or 0), every frame adds 120 * rate * multiplier * dt to the pending
points, where rate and multiplier are those of the previous frame's report and
dt is this frame's world step -- but only if 2 * dt > age, age being the
WorldTimer time (1/4000 s ticks) since that report (style +0x34).

Checks every pair of consecutive traced frames in which the drift continues
(state 0/1 in both).  The WorldTimer of the later frame's update is its traced
value wt (read at Present, before the timer advances; it equals the stamp of
every report made in that frame), so the gate is known exactly: the law must
hold if it is open, nothing may be added if it is shut.  Without a wt field
the stamp of a report in the later frame stands in for it; a frame without
report then only has to follow the law or add nothing.  One more vanilla case:
a starting drift (state 1) whose last report is older than the 0.3 s timeout
fails back to idle in Style::Update (0x56D5C0: pending 0, state 2), and a
report later in the same frame starts it again (0x56EAB0: state 1, stamp =
wt), so the pair reads 1 -> 1 with the pending points back at 0.  Fails on
any other frame, or when fewer than --min frames accrued (the check would be
vacuous).
Needs the trace fields pend, srate, mult, st, dtw, stamp (and wt).

Banking and loss (0x56E920, 0x56D500, 0x56D5C0, DriftCar::Update 0x56ED40),
checked on every occurrence when the fields tot and crash are traced:
  - the first style's total changes only when a drift banks (state 0 -> 3),
    by (int) of the pending points, and only once its last report is older
    than the 0.3 s timeout;
  - a drift lost to a crash (state 0 -> 4) has the crash flag set, and the
    pending points are gone (0) when the style leaves state 4.
An open-loop scenario does not always crash, so no loss is required.
Usage: drift_accrual.py LOG [--min N]"""
import re, struct, sys

def f32(x):
    return struct.unpack('<f', struct.pack('<f', x))[0]

def main():
    args = sys.argv[1:]
    need = 20
    if '--min' in args:
        k = args.index('--min'); need = int(args[k + 1]); del args[k:k + 2]
    rows = []
    for line in open(args[0], errors='replace'):
        m = re.search(r'\[trace\] f=(\d+) t=\d+ w=([-0-9.]+) (.*)', line)
        if not m:
            continue
        d = {'f': int(m.group(1))}
        for kv in m.group(3).split():
            k, _, v = kv.partition('=')
            try:
                d[k] = float(v)
            except ValueError:
                d[k] = None
        rows.append(d)
    keys = ('pend', 'srate', 'mult', 'st', 'dtw', 'stamp')
    if not rows or any(k not in rows[0] for k in keys):
        print(f"[accrual] FAIL: no trace with the fields {keys}")
        return 1
    law = gated = idle = restart = bad = 0
    for a, b in zip(rows, rows[1:]):
        if b['f'] != a['f'] + 1 or any(a.get(k) is None or b.get(k) is None for k in keys):
            continue
        if a['st'] not in (0, 1) or b['st'] not in (0, 1):
            continue
        exp = 120.0 * a['srate'] * a['mult'] * b['dtw']
        dp = b['pend'] - a['pend']
        if exp <= 0:
            continue
        tol = 1e-3 + 2e-6 * abs(b['pend'])            # pending is a float32
        holds = abs(dp - exp) <= tol + 1e-4 * exp
        zero = abs(dp) <= tol
        now = b.get('wt') if b.get('wt') is not None else (b['stamp'] if b['stamp'] != a['stamp'] else None)
        if now is not None:
            # the gate, in the game's single precision: age = ticks * 0.00025f
            age = f32((now - a['stamp']) * f32(0.00025))
            two_dt = 2.0 * f32(b['dtw'])
            if a['st'] == 1 and b['st'] == 1 and age > f32(0.3) and b['stamp'] == now \
                    and abs(b['pend']) <= 1e-3:
                restart += 1; continue        # timed out, then started again by this frame's report
            if two_dt > age and holds:
                law += 1; continue
            if two_dt <= age and zero:
                gated += 1; continue
            what = f"2*dt {1000 * two_dt:.3f} ms vs age {1000 * age:.3f} ms"
        else:
            if holds:
                law += 1; continue
            if zero:
                idle += 1; continue
            what = "no report in this frame"
        bad += 1
        if bad <= 10:
            print(f"[accrual] f={b['f']}: pending +{dp:.6g}, expected +{exp:.6g} ({what})")
    ok = bad == 0 and law >= need
    print(f"[accrual] {'PASS' if ok else 'FAIL'}: {law} frames follow 120*rate*mult*dt, "
          f"{gated} shut by the 2*dt > age gate, {idle} without accrual or report, "
          f"{restart} starts timed out and restarted, {bad} violations (need >= {need} accruing frames)")
    rok, banks, losses = rules(rows)
    print(f"[drift] {'PASS' if ok and rok else 'FAIL'}: accrual {'ok' if ok else 'FAILED'} "
          f"({law} frames), {banks} banks and {losses} crash losses "
          f"{'follow the rules' if rok else 'BREAK the rules'}")
    return 0 if ok and rok else 1

def rules(rows):
    """Banking and crash-loss checks; returns (ok, banks, losses)."""
    if not rows or any(k not in rows[0] for k in ('tot', 'crash', 'wt')):
        print("[rules] FAIL: the trace lacks tot, crash or wt")
        return False, 0, 0
    banks = losses = bad = 0
    def fail(f, msg):
        nonlocal bad
        bad += 1
        if bad <= 10:
            print(f"[rules] f={f}: {msg}")
    for a, b in zip(rows, rows[1:]):
        if b['f'] != a['f'] + 1 or any(r.get(k) is None for r in (a, b)
                                       for k in ('st', 'pend', 'tot', 'crash', 'stamp', 'wt')):
            continue
        dtot = b['tot'] - a['tot']
        if a['st'] == 0 and b['st'] == 3:
            banks += 1
            age = f32((b['wt'] - a['stamp']) * f32(0.00025))
            if dtot != int(a['pend']):
                fail(b['f'], f"banked {dtot:g}, pending was {a['pend']:.6g}")
            if age <= 0.29:
                fail(b['f'], f"banked {1000 * age:.1f} ms after the last report (timeout 300 ms)")
        elif dtot != 0:
            fail(b['f'], f"total changed by {dtot:g} without a bank (state {a['st']:g} -> {b['st']:g})")
        if a['st'] == 0 and b['st'] == 4:
            losses += 1
            if not b['crash']:
                fail(b['f'], "drift lost (state 4) without the crash flag")
        if a['st'] == 4 and b['st'] != 4 and abs(b['pend']) > 1e-3:
            fail(b['f'], f"left the lost state with {b['pend']:.6g} points pending")
    print(f"[rules] {'PASS' if not bad else 'FAIL'}: {banks} banks, {losses} crash losses, {bad} violations")
    return bad == 0, banks, losses

if __name__ == '__main__':
    sys.exit(main())
