#!/bin/bash
# tools/texpack/build.sh -- build (or complete) an upscaled texture pack from
# your own game files.  Options: tools/texpack/build.sh --help
# (texpack.py build).  Run setup.sh once first.
HERE="$(cd "$(dirname "$0")" && pwd)"
SUP="${NFSU2_APPSUPPORT:-$HOME/Library/Application Support/NFSU2}"
TP="${NFSU2_TEXPACK_HOME:-$SUP/texpack}"
[ -x "$TP/venv/bin/python" ] || { echo "run tools/texpack/setup.sh first"; exit 1; }
cmd=build
case "${1:-}" in build|scan|info|fetch-model) cmd="$1"; shift ;; esac
NFSU2_TEXPACK_HOME="$TP" exec "$TP/venv/bin/python" -I "$HERE/texpack.py" "$cmd" "$@"
