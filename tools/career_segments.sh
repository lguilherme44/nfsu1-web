#!/bin/bash
# TEST-ONLY: play the career with the career bot (runtime/career.c) in
# segments, one game launch per segment.  Each segment loads the save the
# previous one left behind, so a crash costs one segment and every boundary
# also exercises save, quit, relaunch and load.
#   tools/career_segments.sh <outdir> <save-seed-dir> <segments> [VAR=value ...]
# Defaults per segment: NFSU2_CAREER_BOT_RACES=3, NFSU2_TIMEOUT=900 and
# NFSU2_CAREER_BOT_VISUAL=10: the bot buys no visual parts, and a DVD cover
# shoot is only offered once the car's visual rating reaches its need, so
# without the rating tweak the stage-5 shoots (KONIG's contract asks for all
# four; S5_URL_9 and then the final S5_CIRCUIT_36 only appear once they are
# done) never open and the career stalls in stage 5
# (NFSU2_CAREER_BOT_VISUAL=0: the car's own rating).  Stops (exit 0) after
# the segment that completes the career ("career complete", stage 6), and
# (exit 1) at the first other segment that does not end with "segment
# done".  Writes
# <outdir>/segNN/ (log, dumps, contact.png, save/) and <outdir>/summary.txt.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?usage: tools/career_segments.sh <outdir> <save-seed-dir> <segments> [VAR=value ...]}"
SEED="${2:?save seed dir}"; N="${3:?number of segments}"; shift 3
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
# game data: NFSU2_DATA, else ../../work/gamedata or ../../gamedata from the checkout
W="$ROOT/../../work"; [ -d "$W/gamedata" ] || W="$ROOT/../.."
export NFSU2_DATA="${NFSU2_DATA:-$W/gamedata}"
export NFSU2_REGFILE_SEED="${NFSU2_REGFILE_SEED:-$ROOT/tests/web/seed/registry_perf4_native.txt}"
[ -f "$NFSU2_REGFILE_SEED" ] || { echo "registry seed not found: $NFSU2_REGFILE_SEED" >&2; exit 1; }
first=1; [ -f "$OUT/next_seg" ] && first=$(cat "$OUT/next_seg")
prev="$SEED"; [ "$first" -gt 1 ] && prev="$OUT/seg$(printf %02d $((first - 1)))/save"
for ((i = first; i < first + N; i++)); do
  d="$OUT/seg$(printf %02d $i)"; rm -rf "$d"
  NFSU2_SAVE_SEED="$prev" "$ROOT/tools/autorun.sh" "$d" NOFOCUS=2 NFSU2_FNG_LOG=1 \
     NFSU2_STATUS_EVERY=1200 NFSU2_DUMP_SCALE=0.3 NFSU2_DUMP_FRAMES=%3600 \
     NFSU2_CAREER_BOT=1 NFSU2_CAREER_BOT_RACES=3 NFSU2_CAREER_BOT_VISUAL=10 NFSU2_TIMEOUT=900 "$@" > "$d.run" 2>&1 < /dev/null
  rc=$?; log="$d/log.txt"
  "$ROOT/.venv/bin/python" "$ROOT/tools/contact_sheet.py" "$d" 5 260 > /dev/null 2>&1
  st=$(LC_ALL=C grep -a "^\[status\]" "$log" | tail -1 | sed 's/^\[status\] //')
  cl=$(LC_ALL=C grep -a "\[career\] f=[0-9]* stage" "$log" | tail -1 | sed 's/^\[career\] //' | cut -c1-160)
  bad=$(LC_ALL=C grep -a -c "FAULT IN GUEST\|GUEST MEMORY FAULT\|HOST SEGV\|TIME LIMIT REACHED\|^\[trap\]\|UNRESOLVED INDIRECT\|UNIMPLEMENTED" "$log")
  printf 'seg%02d rc=%d bad=%s | %s | %s\n' "$i" "$rc" "$bad" "$cl" "$st" | tee -a "$OUT/summary.txt"
  if [ $rc -eq 0 ] && LC_ALL=C grep -aq "career complete" "$log"; then   # stage 6: nothing left
    echo "seg$(printf %02d $i): career complete" | tee -a "$OUT/summary.txt"; echo $((i + 1)) > "$OUT/next_seg"; exit 0
  fi
  if [ $rc -ne 0 ] || ! LC_ALL=C grep -aq "segment done" "$log"; then
    echo "seg$(printf %02d $i): stopped (see $log)" | tee -a "$OUT/summary.txt"; echo "$i" > "$OUT/next_seg"; exit 1
  fi
  prev="$d/save"; echo $((i + 1)) > "$OUT/next_seg"
done
