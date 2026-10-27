#!/bin/bash
# tools/texpack/setup.sh -- one-time setup of the texture pack builder.
# Creates a private Python environment and
# downloads the upscaling model; nothing is installed system-wide.
#
#   tools/texpack/setup.sh [--with-dat2]
#
# Where:  <Application Support>/NFSU2/texpack/{venv,models}
#         (NFSU2_TEXPACK_HOME moves it; NFSU2_APPSUPPORT moves Application Support)
# Size:   about 0.7 GB (PyTorch and friends) + 9 MB (SPAN model)
#         [+ 140 MB with --with-dat2, the slow best-quality model]
# Needs:  Python 3.12 to 3.14 (Homebrew: brew install python), macOS 14 or
#         newer on Apple Silicon, and internet access to pypi.org and
#         github.com.  Every package is checked against the SHA-256 in
#         requirements.txt (pip --require-hashes; wheels only), the model
#         against its SHA-256 too.  Remove it all by deleting the texpack folder.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUP="${NFSU2_APPSUPPORT:-$HOME/Library/Application Support/NFSU2}"
TP="${NFSU2_TEXPACK_HOME:-$SUP/texpack}"
DAT2=0
for a in "$@"; do case "$a" in
  --with-dat2) DAT2=1 ;;
  -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
  *) echo "unknown option $a"; exit 1 ;;
esac; done

PY=""
for c in python3.13 python3.12 python3.14 python3 \
         /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  p="$(command -v "$c" 2>/dev/null || true)"; [ -n "$p" ] || continue
  if "$p" -c 'import sys; sys.exit(0 if (3, 12) <= sys.version_info[:2] <= (3, 14) else 1)' 2>/dev/null; then PY="$p"; break; fi
done
[ -n "$PY" ] || { echo "Python 3.12, 3.13 or 3.14 is needed (e.g. brew install python), then run this again."; exit 1; }
[ "$(uname -m)" = arm64 ] || echo "note: not an Apple Silicon Mac; the model runs on the CPU (slow)"

echo "texpack: Python $("$PY" -c 'import sys; print(sys.version.split()[0])') at $PY"
echo "texpack: environment in $TP"
mkdir -p "$TP"
[ -x "$TP/venv/bin/python" ] || "$PY" -m venv "$TP/venv"
"$TP/venv/bin/python" -m pip install --disable-pip-version-check -q \
    --require-hashes --only-binary :all: -r "$HERE/requirements.txt"
NFSU2_TEXPACK_HOME="$TP" "$TP/venv/bin/python" -I "$HERE/texpack.py" fetch-model span
[ "$DAT2" = 1 ] && NFSU2_TEXPACK_HOME="$TP" "$TP/venv/bin/python" -I "$HERE/texpack.py" fetch-model dat2
du -sh "$TP" | awk '{print "texpack: installed, " $1 " in total"}'
echo "next: tools/texpack/build.sh   (options: tools/texpack/build.sh --help)"
