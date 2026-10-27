#!/bin/bash
# Quick Race coverage: every mode from the main menu to the race, 20 s on the throttle (shifting up with E,
# for Drag), a frame-rate line, then out of the race (pause or post-race menu) back to the menus.  One boot per mode
# (web/tools/fe-walk.mjs), so a mode that hangs does not hide the others.
#
#   web/tools/coverage.sh [outDir] [modes]       modes: 0..5 (default all): Circuit Sprint Drag Drift Knockout FreeRun
#
# Needs the server on :8080 (./run.sh).  Screenshots and each walk's console are in <outDir>/<mode>/.
set -o pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/out/coverage}"; MODES="${2:-0 1 2 3 4 5}"
NAMES=(circuit sprint drag drift knockout freerun)
mkdir -p "$OUT"
pass=0; fail=0; summary=""
for m in $MODES; do
  n=${NAMES[$m]}; down=""; [ "$m" -gt 0 ] && down="ArrowDown*$m,"
  drive="down:w,sleep:4000,shot:drive_4s"
  for k in 1 2 3 4 5 6 7 8; do drive="$drive,e,sleep:1500"; done
  drive="$drive,shot:drive_20s,up:w,gpu"
  steps="profile,Enter,sleep:800,${down}shot:mode,until:PC_Loading|HUD_:Enter:10,wait:HUD_:120,sleep:12000,shot:start,$drive"
  steps="$steps,shot:end,leave,sleep:1500,shot:back"
  echo "== $n"
  if node "$ROOT/web/tools/fe-walk.mjs" "$OUT/$n" "$steps" > "$OUT/$n.txt" 2>&1; then
    pass=$((pass+1)); r=PASS
  else
    fail=$((fail+1)); r=FAIL
  fi
  rg -N "FAIL|gpu:|complaint" "$OUT/$n.txt" | sed 's/^/   /'
  summary="$summary$r $n\n"
done
printf "\n%b%d passed, %d failed  (%s)\n" "$summary" "$pass" "$fail" "$OUT"
[ "$fail" = 0 ]
