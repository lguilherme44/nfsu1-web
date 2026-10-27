#!/bin/bash
# Play NFS Underground in the browser: does whatever is missing, then serves the game.
#
#   ./run.sh "<game folder>"     the first time (the folder with SPEED.EXE 1.4; remembered in out/game-dir)
#   ./run.sh                     afterwards
#   ./run.sh --docker            the same through web/deploy/compose.local.yml (HTTPS, https://localhost:8443/)
#   ./run.sh --no-open           do not open the browser
#   PORT=8081 ./run.sh           another port (the Node server; default 8080)
#   HTTPS_PORT=8443 ./run.sh     also HTTPS for a phone or PC on the LAN (needs out/cert/{key,cert}.pem)
#
# Each step is skipped when it is already done: the Python venv, the lift (web/gen.sh, when
# web/tools/gencheck.sh says gen/ is missing or stale), npm install, the module (web/build.sh is
# incremental, ~4 s when nothing changed) and the page (web/build.mjs).
set -e -o pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
DOCKER=0; OPEN=1; GAME=""
for a in "$@"; do
  case "$a" in
    --docker) DOCKER=1 ;;
    --no-open) OPEN=0 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "run.sh: unknown option $a (--help)"; exit 1 ;;
    *) GAME="$a" ;;
  esac
done
step(){ printf '\n\033[1m== %s\033[0m\n' "$*"; }
die(){ printf '\033[31mrun.sh: %s\033[0m\n' "$*"; exit 1; }

# ---- the game folder ----
mkdir -p out
GAME="${GAME:-${NFSU_DATA:-$(cat out/game-dir 2>/dev/null || true)}}"
[ -n "$GAME" ] || die 'which game folder? ./run.sh "<folder with SPEED.EXE>"'
[ -d "$GAME" ] || die "not a folder: $GAME"
GAME="$(cd "$GAME" && pwd)"
EXE=""; for f in "$GAME"/*; do [ "$(basename "$f" | tr A-Z a-z)" = speed.exe ] && EXE="$f"; done
[ -n "$EXE" ] || die "no SPEED.EXE in $GAME"
echo "$GAME" > out/game-dir
echo "game: $GAME"

# ---- tools ----
command -v node >/dev/null || die "Node.js is missing (https://nodejs.org, 20 or newer)"
command -v python3 >/dev/null || die "python3 is missing"
ls -d deps/wasi-sdk-* >/dev/null 2>&1 || [ -n "${WASI:-}" ] ||
  die "wasi-sdk is missing: unpack it into deps/ (https://github.com/WebAssembly/wasi-sdk/releases), or WASI=<its folder>"

if [ ! -x .venv/bin/python ]; then
  step "Python tools (.venv: pefile, capstone)"
  python3 -m venv .venv && .venv/bin/pip install -q pefile capstone
fi

# ---- the lift: SPEED.EXE -> gen/ ----
if ! web/tools/gencheck.sh > out/gencheck.txt 2>&1; then
  step "Translating SPEED.EXE to C (gen/, ~30 s): $(head -1 out/gencheck.txt)"
  web/gen.sh "$EXE"
fi

# ---- the module and the page ----
if [ ! -d web/node_modules ]; then step "npm install (web/)"; (cd web && npm ci --no-audit --no-fund); fi
step "Building the game module (out/web/nfsu1.wasm)"
web/build.sh > out/build.txt 2>&1 || { tail -30 out/build.txt; die "web/build.sh failed (whole log: out/build.txt)"; }
tail -1 out/build.txt
step "Building the page (web/dist)"
(cd web && node build.mjs > ../out/page-build.txt 2>&1) || { cat out/page-build.txt; die "web/build.mjs failed"; }

open_browser(){
  [ "$OPEN" = 1 ] || return 0
  # WebGPU and the cross-origin isolated page want Chrome
  if [ "$(uname)" = Darwin ]; then
    open -a "Google Chrome" "$1" 2>/dev/null || open "$1"
  else
    xdg-open "$1" >/dev/null 2>&1 || true
  fi
}

# ---- serve ----
if [ "$DOCKER" = 1 ]; then
  command -v docker >/dev/null || die "Docker is missing"
  step "Docker (web/deploy/compose.local.yml)"
  (cd web/deploy && NFSU2_DATA="$GAME" NFSU2_MODULE=../../out/web \
     docker compose -f compose.local.yml up -d --build --force-recreate)
  URL="https://localhost:${NFSU2_HTTPS_PORT:-8443}/"
  for _ in $(seq 60); do curl -ksf -o /dev/null "$URL" && break; sleep 1; done
  echo; echo "playing at $URL  (stop: cd web/deploy && docker compose -f compose.local.yml down)"
  open_browser "$URL"
  exit 0
fi

PORT="${PORT:-8080}"
PID="$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [ -n "$PID" ]; then
  # this repo's own server from an earlier run: replace it; anything else: leave it alone
  if ps -o command= -p "$PID" | grep -q 'server.mjs' && [ "$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$ROOT/web" ]; then
    echo "stopping the earlier server (pid $PID)"; kill "$PID"; sleep 1
  else
    die "port $PORT is taken by: $(ps -o command= -p "$PID") (PORT=8081 ./run.sh uses another)"
  fi
fi
URL="http://localhost:$PORT/"
step "Serving $URL  (Ctrl+C stops)"
( for _ in $(seq 30); do curl -sf -o /dev/null "$URL" && break; sleep 0.5; done; open_browser "$URL" ) &
cd web && NFSU_DATA="$GAME" PORT="$PORT" exec node server.mjs
