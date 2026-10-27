#!/bin/bash
# Generate the lifted C of NFS Underground (SPEED.EXE 1.4, 2004-01-15) for the
# web build: gen/all (the game) and a stub gen/server (NFSU1 has no server.dll).
#
#   web/gen.sh <path/to/SPEED.EXE>       writes gen/all, gen/server, out/argcount.log
#
# What differs from NFSU2's generator (the tree's root gen.sh, not in this repo):
#   - no relocations: SPEED.EXE 1.4 has none (base 0x400000), so the functions
#     the code only reaches through pointers (vtables, callbacks) come from
#     tools/nfsu1/seeds.txt, the function entries of the lift this port was
#     made with (30,866; regenerated from them, gen/all came out byte for byte
#     the same, 2026-10-24)
#   - overrides and hooks: runtime/overrides.c only (tools/genstamp.sh); the
#     rest of runtime/ still names SPEED2.EXE addresses
#   - X87PC off, 64 shards, none of NFSU2's web lift options (FLAGABI, X87OPT,
#     JTSWITCH, LREGS ...): the plain lift the game was tested with
# The stamp (gen/all/stamp.txt, tools/genstamp.sh sources) is what web/build.sh's
# web/tools/gencheck.sh checks against the checkout.
set -e -o pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
EXE="${1:-}"
[ -f "$EXE" ] || { echo "usage: web/gen.sh path/to/SPEED.EXE"; exit 1; }
PY="$ROOT/.venv/bin/python"
[ -x "$PY" ] || { echo "web/gen.sh: no $PY (python3 -m venv .venv && .venv/bin/pip install pefile capstone)"; exit 1; }
# the build this port knows: another SPEED.EXE has other addresses for every override and hook
WANT=1.4
TS=$("$PY" -I -c 'import sys,struct; d=open(sys.argv[1],"rb").read(); p=struct.unpack_from("<I",d,0x3c)[0]; print(hex(struct.unpack_from("<I",d,p+8)[0]))' "$EXE")
[ "$TS" = 0x40072965 ] || [ "${NFSU1_ANY_EXE:-}" = 1 ] || {
  echo "web/gen.sh: $EXE is not SPEED.EXE $WANT (PE timestamp $TS, want 0x40072965); NFSU1_ANY_EXE=1 lifts it anyway"; exit 1; }
NSHARD="${NSHARD:-64}"
mkdir -p out gen/all gen/server
rm -f gen/all/web-lift.txt
echo "incomplete: web/gen.sh has not finished (or failed)" > gen/all/stamp.txt
STAMP_SOURCES="$(tools/genstamp.sh sources)"
OV=$(tools/genstamp.sh overrides); HK=$(tools/genstamp.sh hooks)
echo "OVERRIDE: $OV"
echo "HOOKS: $HK"
: > out/relocs.txt                     # none in SPEED.EXE 1.4
export X87PC=0
RELOCS=out/relocs.txt SEEDS=tools/nfsu1/seeds.txt OVERRIDE="$OV" HOOKS="$HK" \
  "$PY" tools/genall.py "$EXE" "$NSHARD" > out/genall.log
grep -E "functions  *:|traps \(|truncated|MISSING" out/genall.log || true
RELOCS=out/relocs.txt "$PY" tools/argcount.py "$EXE" > out/argcount.log
# a lift that failed function by function still writes every shard: refuse that
BAD=$(cat gen/all/shard_*.c | grep -c '"lift-error"' || true)
[ "$BAD" -le 64 ] || { echo "web/gen.sh: $BAD functions failed to lift: not a usable lift"; rm -f gen/all/fntab.c
                       echo "incomplete: web/gen.sh found $BAD functions that failed to lift" > gen/all/stamp.txt; exit 1; }
find gen/server/ -mindepth 1 -delete
printf '#include "module.h"\nconst ModInfo g_srv_modinfo = { "server.dll", "", 0x00a00000u, 0, 0, 0, 0, 0, 0 };\n' > gen/server/modinfo.c
printf '#include "cpu.h"\ntypedef void(*guest_fn)(CPU*);\nconst uint32_t g_srv_fn_count = 0;\nconst uint32_t g_srv_fn_addr[1] = {0};\nconst guest_fn g_srv_fn_ptr[1] = {0};\n' > gen/server/fntab.c
printf '#include <stdint.h>\ntypedef struct { uint32_t iat; const char*dll; const char*name; int nargs; } ImpEnt;\nconst uint32_t g_srv_imp_count = 0;\nconst ImpEnt g_srv_imp[1] = {{0}};\n' > gen/server/impargs.c
printf '#ifndef DECLS_H\n#define DECLS_H\n#include "cpu.h"\n#endif\n' > gen/server/decls.h
h16(){ shasum -a 256 | cut -c1-16; }
STAMP="$(echo "# web/gen.sh $(date -u +%Y-%m-%dT%H:%M:%SZ): what gen/all and gen/server were lifted from"
  echo "$STAMP_SOURCES"
  echo "exe $(h16 < "$EXE") seeds $(h16 < tools/nfsu1/seeds.txt)"
  echo "options X87PC=0 NSHARD=$NSHARD")"
echo "$STAMP" > gen/server/stamp.txt
echo "$STAMP" > gen/all/stamp.txt
echo plain > gen/all/web-lift.txt
echo "gen OK -> gen/all ($(ls gen/all/shard_*.c | wc -l | tr -d ' ') shards, $BAD lift-error stubs)"
