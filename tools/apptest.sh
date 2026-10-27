#!/bin/bash
# Test run of the packaged app's binary (out/NFSU2.app/Contents/MacOS/NFSU2),
# exactly as Finder would start it but with a TEST support directory, so the
# user's ~/Library/Application Support/NFSU2 and ~/Library/Logs/NFSU2 are
# never touched, and a fully transparent window (NOFOCUS=2) that never takes
# focus.  Discord presence stays off unless NFSU2_DISCORD_IPC names a mock.
#   tools/apptest.sh <rundir> [VAR=value ...]
# <rundir>/support is the Application Support dir (settings.ini, registry.txt,
# Overlay/, Logs/nfsu2.log); frame dumps go to <rundir>.  The game folder
# comes from NFSU2_DATA or from game_folder in <rundir>/support/settings.ini.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?usage: tools/apptest.sh <rundir> [VAR=value ...]}"; shift
mkdir -p "$OUT/support"; OUT="$(cd "$OUT" && pwd)"
export NFSU2_APPSUPPORT="$OUT/support" NOFOCUS="${NOFOCUS:-2}" NFSU2_TIMEOUT="${NFSU2_TIMEOUT:-120}"
export NFSU2_DUMP_DIR="${NFSU2_DUMP_DIR:-$OUT}"
# no network unless the test selects one; never the real network (tools/autorun.sh)
export NFSU2_NET="${NFSU2_NET:-off}"
# silent speakers (runtime/audio.m); NFSU2_MUTE=0 to listen
export NFSU2_MUTE="${NFSU2_MUTE:-1}"
# windowed: the app keeps the player's Cmd-F choice in the player's own
# preferences (org.nfsu2.nativeport, shared with every copy of the app);
# a test never reads or writes it (runtime/metal.m fs_pref_load also skips
# it in a NOFOCUS run).  NFSFULL=1 for a full-screen test.
export NFSFULL="${NFSFULL:-0}"
for kv in "$@"; do export "$kv"; done
# Discord presence is OFF here unless the run points it at a mock socket
# (NFSU2_DISCORD_IPC, tools/mock_discord.py): the real Discord app may be
# running on this Mac and must never see a test.  With a mock, settings.ini's
# "discord" key (or NFSU2_DISCORD) decides, as in normal play.
if [ -z "$NFSU2_DISCORD_IPC" ]; then
  [ -n "$NFSU2_DISCORD" ] && [ "$NFSU2_DISCORD" != 0 ] && \
    echo "apptest: NFSU2_DISCORD on without NFSU2_DISCORD_IPC (a mock socket); forcing it off" >&2
  export NFSU2_DISCORD=0
fi
# LAN play and free-roam multiplayer can be switched on by the run's
# settings.ini as well as by NFSU2_NET / NFSU2_ROAM, so every app test is the
# harness for both (LAN never on the real network, free roam on loopback
# only, no LAN discovery) and runs inside the loopback-only sandbox profile,
# as tools/autorun.sh does for networked runs (NFSU2_SANDBOX=0 skips it; a
# caller that is already inside it, such as tests/net/vlan_run.sh, sets
# NFSU2_SANDBOXED=1).
export NFSU2_NET_HARNESS=1 NFSU2_ROAM_HARNESS=1
# The rule is "never network = lan in a test": NFSU2_NET above wins over the
# line and the harness would turn lan into loopback, but a run's settings.ini
# that asks for it is refused outright.  It is the
# settings.ini the app will read (NFSU2_APPSUPPORT, which a VAR=value can
# move), and every spelling runtime/bundle.m takes counts: a network line
# with any value but an "off" one (lan, on, yes, true, enabled, 1, quoted or
# not, any case), or an NFSU2_NET line that winsock.c reads as lan.
SETINI="${NFSU2_APPSUPPORT:-$OUT/support}/settings.ini"
if [ -f "$SETINI" ] && awk '
  { line = $0; sub(/\r$/, "", line) }
  line ~ /^[[:space:]]*[#;\[]/ || index(line, "=") == 0 { next }
  { k = substr(line, 1, index(line, "=") - 1); v = substr(line, index(line, "=") + 1)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", k); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
    sub(/[[:space:]]+[#;].*$/, "", v)
    if (length(v) >= 2 && (substr(v, 1, 1) == "\"" || substr(v, 1, 1) == "\047") && substr(v, length(v)) == substr(v, 1, 1))
      v = substr(v, 2, length(v) - 2)
    lk = tolower(k); lv = tolower(v)
    if ((lk == "network" || lk == "nfsu2_net") && lv != "" && lv !~ /^(0|off|no|false|disabled|none|loopback|loop|sandbox|vlan(:.*)?)$/) bad = 1 }
  END { exit bad ? 0 : 1 }' "$SETINI"; then
  echo "apptest: $SETINI asks for the real LAN (network = lan or the like); test runs use off, loopback or vlan" >&2; exit 2
fi
# after the VAR=value arguments, so NFSU2_APP=... works as one of them too
APPBIN="${NFSU2_APP:-$ROOT/out/NFSU2.app}/Contents/MacOS/NFSU2"
[ -x "$APPBIN" ] || { echo "no $APPBIN (./pack.sh)"; exit 1; }
SBX=()
if [ "${NFSU2_SANDBOX:-1}" != 0 ] && [ "${NFSU2_SANDBOXED:-0}" != 1 ] && [ -x /usr/bin/sandbox-exec ]; then
  SBX=(/usr/bin/sandbox-exec -f "$ROOT/tests/net/loopback-only.sb")
fi
# SIP drops DYLD_* variables when sandbox-exec (a system binary) starts, so
# an interposer such as tools/writewatch.c (DYLD_INSERT_LIBRARIES=... as a
# VAR=value argument) reaches the game through env, inside the sandbox
[ ${#SBX[@]} -gt 0 ] && [ -n "${DYLD_INSERT_LIBRARIES:-}" ] && SBX+=(/usr/bin/env "DYLD_INSERT_LIBRARIES=$DYLD_INSERT_LIBRARIES")
start=$(date +%s)
"${SBX[@]}" "$APPBIN" > "$OUT/stdout.txt" 2>&1
rc=$?
echo "exit=$rc wall=$(( $(date +%s) - start ))s log=$OUT/support/Logs/nfsu2.log"
exit $rc
