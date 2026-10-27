#!/usr/bin/env python3
"""Compare NFSU2_HFR_TRACE runs (runtime/framerate.c).

    tools/hfr_compare.py REF_RUN_DIR RUN_DIR [RUN_DIR...]

Each run dir holds trace.csv (framerate.c, one row per racing frame) and
log.txt.  Everything is compared on game-world time (sim_s), so runs at
different frame rates line up:
  - player launch: speed and distance travelled after GO, time to 10/15 m/s
  - AI cars: path length driven, time to reach given distances along their
    own path, and the distance between the same car in two runs
  - rates from the log's "[hfr] race" line
"""
import csv, math, os, re, sys


def load(run):
    rows = list(csv.DictReader(open(os.path.join(run, 'trace.csv'))))
    out = []
    for r in rows:
        d = {'t': float(r['sim_s']), 'w': float(r['wall_s']), 'v': float(r['speed']),
             'x': float(r['x']), 'z': float(r['z']), 'ticks': int(r['ticks']), 'slots': int(r['slots'])}
        cars = []
        for i in range(4):
            try:
                cars.append((float(r['c%dx' % i]), float(r['c%dy' % i]), float(r['c%dz' % i]), float(r['c%dv' % i])))
            except (KeyError, ValueError):
                cars.append(None)
        d['cars'] = cars
        out.append(d)
    return out


def interp(rows, t, f):
    """value f(row) at world time t (linear between frames)"""
    lo, hi = 0, len(rows) - 1
    if t <= rows[0]['t']:
        return f(rows[0])
    if t >= rows[hi]['t']:
        return f(rows[hi])
    while hi - lo > 1:
        m = (lo + hi) // 2
        if rows[m]['t'] <= t:
            lo = m
        else:
            hi = m
    a, b = rows[lo], rows[hi]
    k = (t - a['t']) / (b['t'] - a['t']) if b['t'] > a['t'] else 0.0
    fa, fb = f(a), f(b)
    if isinstance(fa, tuple):
        return tuple(p + (q - p) * k for p, q in zip(fa, fb))
    return fa + (fb - fa) * k


def go_time(rows):
    """first world time the player moves faster than 0.05 m/s"""
    for r in rows:
        if r['t'] > 5 and r['v'] > 0.05:
            return r['t']
    return None


def path(rows, ci):
    """cumulative path length of car ci over world time: list of (t, s, (x, z))"""
    out, s, last = [], 0.0, None
    for r in rows:
        c = r['cars'][ci]
        if c is None:
            continue
        p = (c[0], c[2])
        if last is not None:
            step = math.hypot(p[0] - last[0], p[1] - last[1])
            if step < 5.0:               # a reset/teleport would otherwise count
                s += step
        last = p
        out.append((r['t'], s, p))
    return out


def time_at(pth, s_want):
    for i in range(1, len(pth)):
        if pth[i][1] >= s_want:
            t0, s0, _ = pth[i - 1]
            t1, s1, _ = pth[i]
            return t0 + (t1 - t0) * (s_want - s0) / (s1 - s0) if s1 > s0 else t1
    return None


def rate_line(run):
    try:
        for l in open(os.path.join(run, 'log.txt'), errors='replace'):
            if l.startswith('[hfr] race') or l.startswith('[hfr] all'):
                return l.strip()
    except OSError:
        pass
    return ''


def main():
    runs = sys.argv[1:]
    if len(runs) < 2:
        print(__doc__)
        sys.exit(1)
    data = {r: load(r) for r in runs}
    ref = runs[0]
    R = data[ref]
    print('reference:', os.path.basename(ref))
    for run in runs:
        rows = data[run]
        n = len(rows)
        wall = rows[-1]['w'] - rows[0]['w']
        sim = rows[-1]['t'] - rows[0]['t']
        from collections import Counter
        tk = Counter(r['ticks'] for r in rows).most_common(4)
        print('\n== %s: %d race frames, %.1f s world, %.1f s wall, ticks/frame %s' %
              (os.path.basename(run), n, sim, wall, tk))
        m = re.search(r'fps=([\d.]+).*sim/wall=([\d.]+).*realtimer/real=([\d.]+) worldtimer/sim=([\d.]+) '
                      r'rtf=([\d.]+)/s wtf=([\d.]+)/s audio=([\d.]+)upd/s,([\d.]+)s/s particles=([\d.]+)s/s',
                      rate_line(run))
        if m:
            print('   fps %s  sim/wall %s  RealTimer/real %s  WorldTimer/sim %s  RealTimeFrames %s/s  '
                  'WorldTimeFrames %s/s  audio %s upd/s %s s/s  particles %s s/s' % m.groups())
        g = go_time(rows)
        gr = go_time(R)
        print('   GO (player starts moving) at world %.3f s (ref %.3f)' % (g or -1, gr or -1))
        if g and gr:
            for dt in (0.5, 1.0, 2.0, 3.0):
                v = interp(rows, g + dt, lambda r: r['v'])
                vr = interp(R, gr + dt, lambda r: r['v'])
                print('   launch +%.1f s: speed %.3f m/s (ref %.3f, diff %+.2f %%)' %
                      (dt, v, vr, 100 * (v - vr) / vr if vr else 0))
            for vw in (5.0, 10.0, 15.0):
                def t_to(rr, g0):
                    for r in rr:
                        if r['t'] > g0 and r['v'] >= vw:
                            return r['t'] - g0
                    return None
                a, b = t_to(rows, g), t_to(R, gr)
                if a and b:
                    print('   time GO -> %.0f m/s: %.3f s (ref %.3f, diff %+.1f ms)' % (vw, a, b, 1e3 * (a - b)))
            pth, pr = path(rows, 0), path(R, 0)
            if pth and pr:
                s3 = interp([{'t': p[0], 's': p[1]} for p in pth], g + 3.0, lambda r: r['s'])
                s3r = interp([{'t': p[0], 's': p[1]} for p in pr], gr + 3.0, lambda r: r['s'])
                print('   player distance GO+3 s: %.3f m (ref %.3f, diff %+.3f m)' % (s3, s3r, s3 - s3r))
        for ci in (1, 2, 3):
            pth, pr = path(rows, ci), path(R, ci)
            if len(pth) < 10 or len(pr) < 10:
                continue
            msg = []
            for sw in (200, 500, 1000, 1500, 2000):
                a, b = time_at(pth, sw), time_at(pr, sw)
                if a and b:
                    msg.append('%dm %.2fs(%+.0fms)' % (sw, a, 1e3 * (a - b)))
            sep = []
            for tw in (20, 40, 60, 80, 99):
                if pth[-1][0] >= tw and pr[-1][0] >= tw:
                    p = interp([{'t': q[0], 'p': q[2]} for q in pth], tw, lambda r: r['p'])
                    q = interp([{'t': q[0], 'p': q[2]} for q in pr], tw, lambda r: r['p'])
                    sep.append('%ds %.1fm' % (tw, math.hypot(p[0] - q[0], p[1] - q[1])))
            print('   AI car %d: path %.0f m; reaches %s; distance to ref car at %s' %
                  (ci, pth[-1][1], ' '.join(msg), ', '.join(sep)))


if __name__ == '__main__':
    main()
