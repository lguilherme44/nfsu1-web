#!/bin/bash
# Automated test run (no env scrubbing, unlike run.sh).
#   tools/autorun.sh <outdir> [VAR=value ...]
# Runs out/nfsu2_boot windowed (background window, no focus steal) against
# $NFSU2_DATA (default: ../../work/gamedata), with run.sh's required
# defaults (FIXMAT, NOMOVIES, SNDSYNC, GPUVS).  Everything goes to <outdir>:
# log.txt (stdout+stderr), frame dumps, registry file (copied from
# $NFSU2_REGFILE_SEED if given).  Extra VAR=value args are exported first,
# so they count like the environment for everything below (the defaults,
# NFSU2_SAVE_SEED, NFSU2_REGFILE_SEED, NFSU2_SAVEDIR, NFSU2_BIN ...).
# Network: off unless the test selects NFSU2_NET=loopback or vlan:<hub>, or
# NFSU2_ROAM=1; a test run can never use the real network (NFSU2_NET_HARNESS=1
# makes the Winsock HLE refuse it, NFSU2_ROAM_HARNESS=1 keeps free roam on
# loopback), and a run with any network mode is wrapped in the loopback-only
# sandbox profile tests/net/loopback-only.sb (NFSU2_SANDBOX=0 skips the
# wrapper; a caller already inside it sets NFSU2_SANDBOXED=1).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?usage: tools/autorun.sh <outdir> [VAR=value ...]}"; shift
for kv in "$@"; do export "$kv"; done
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
DATA="${NFSU2_DATA:-$ROOT/../../work/gamedata}"
export FIXMAT="${FIXMAT:-0}" FIXMAT_MODE="${FIXMAT_MODE:-3}" NOMOVIES="${NOMOVIES:-1}"   # FIXMAT: see run.sh
export SNDSYNC="${SNDSYNC:-1}" GPUVS="${GPUVS:-1}"
export WINDOW="${WINDOW-1}" NOFOCUS="${NOFOCUS-1}" ALARM="${ALARM:-120}"
# Discord presence is OFF in test runs: the real Discord app may be running on
# this Mac and must never see a test.  A test that wants it sets
# NFSU2_DISCORD=1 together with NFSU2_DISCORD_IPC=<mock socket>
# (tools/mock_discord.py); without the override path it stays off.
export NFSU2_DISCORD="${NFSU2_DISCORD:-0}"
# Test runs are silent (the mixer still runs, see audio.m); NFSU2_MUTE=0 to listen.
export NFSU2_MUTE="${NFSU2_MUTE:-1}"
# windowed, whatever the player last chose with Cmd-F (tools/apptest.sh)
export NFSFULL="${NFSFULL:-0}"
export DUMPDIR="${DUMPDIR:-$OUT}" NFSU2_DUMP_DIR="${NFSU2_DUMP_DIR:-$OUT}"
export NFSU2_REGFILE="${NFSU2_REGFILE:-$OUT/registry.txt}"
# Application Support (texture packs, the texture dump: texrep.m) is the
# run's own, never the player's ~/Library/Application Support/NFSU2; a test
# that wants a pack passes NFSU2_APPSUPPORT=<dir with Textures/> or NFSU2_TEXPACK.
export NFSU2_APPSUPPORT="${NFSU2_APPSUPPORT:-$OUT/support}"
# Saves/profiles go to a per-run overlay (reads fall back to the data dir).
# NFSU2_SAVE_SEED=<dir>: copy an existing save tree in first.
export NFSU2_SAVEDIR="${NFSU2_SAVEDIR:-$OUT/save}"
mkdir -p "$NFSU2_SAVEDIR"
[ -n "$NFSU2_SAVE_SEED" ] && cp -R "$NFSU2_SAVE_SEED"/. "$NFSU2_SAVEDIR"/
[ -n "$NFSU2_REGFILE_SEED" ] && [ ! -f "$NFSU2_REGFILE" ] && cp "$NFSU2_REGFILE_SEED" "$NFSU2_REGFILE"
if [ "$NFSU2_DISCORD" != 0 ] && [ -z "$NFSU2_DISCORD_IPC" ]; then
  echo "autorun: NFSU2_DISCORD on without NFSU2_DISCORD_IPC (a mock socket); forcing it off" >&2
  export NFSU2_DISCORD=0
fi
# Network: LAN play (winsock.c) and free-roam multiplayer (roam_bsd.c).  A
# test run is always the harness for both: LAN off unless the test selects
# loopback or the virtual LAN, never the real LAN; free roam on loopback only,
# no LAN discovery.  Any networked run is inside the one loopback-only
# sandbox profile (IP beyond 127.0.0.1 refused by the kernel; AF_UNIX, the
# vlan hub, allowed).
export NFSU2_NET="${NFSU2_NET:-off}"
export NFSU2_NET_HARNESS=1 NFSU2_ROAM_HARNESS=1
SBX=()
if { [ "$NFSU2_NET" != off ] || [ "${NFSU2_ROAM:-0}" != 0 ]; } && [ "${NFSU2_SANDBOX:-1}" != 0 ] \
   && [ "${NFSU2_SANDBOXED:-0}" != 1 ] && [ -x /usr/bin/sandbox-exec ]; then
  SBX=(/usr/bin/sandbox-exec -f "$ROOT/tests/net/loopback-only.sb")
fi
# SIP drops DYLD_* variables when sandbox-exec (a system binary) starts, so
# an interposer such as tools/writewatch.c (DYLD_INSERT_LIBRARIES=... as a
# VAR=value argument) reaches the game through env, inside the sandbox
[ ${#SBX[@]} -gt 0 ] && [ -n "${DYLD_INSERT_LIBRARIES:-}" ] && SBX+=(/usr/bin/env "DYLD_INSERT_LIBRARIES=$DYLD_INSERT_LIBRARIES")
cd "$OUT"
start=$(date +%s)
"${SBX[@]}" "$ROOT/out/${NFSU2_BIN:-nfsu2_boot}" "$DATA/SPEED2.EXE" > "$OUT/log.txt" 2>&1
rc=$?
echo "exit=$rc wall=$(( $(date +%s) - start ))s log=$OUT/log.txt"
exit $rc
