#!/bin/bash
# Build the game module for the browser: out/web/nfsu2.wasm (+ nfsu2.json).
#
#   web/build.sh            lifted shards (incremental) + runtime + link
#   FULL=1 web/build.sh     recompile everything
#   OPT=-O2 web/build.sh    another optimisation level (default -O3)
#
# Toolchain: wasi-sdk (clang + wasm-ld), target wasm32-wasip1-threads, run by
# the page's own host (web/src/host): no Emscripten.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
WASI="${WASI:-$(ls -d "$ROOT"/deps/wasi-sdk-*-arm64-macos "$ROOT"/deps/wasi-sdk-*-x86_64-linux 2>/dev/null | tail -1)}"
[ -x "$WASI/bin/clang" ] || { echo "wasi-sdk not found in deps/ (set WASI=...)"; exit 1; }
# guest memory accesses must keep their may_alias types (cpu.h)
WASI="$WASI" web/tools/aliasguard.sh > /dev/null || { WASI="$WASI" web/tools/aliasguard.sh; exit 1; }
[ -f gen/all/fntab.c ] || { echo "gen/all missing: fntab.c not found"; exit 1; }
# The lift must be the one this runtime needs: its _orig declarations, and gen stamp
web/tools/gencheck.sh
LIFT="$(cat gen/all/web-lift.txt 2>/dev/null || echo unknown)"
CC="$WASI/bin/clang"; OBJDUMP="$WASI/bin/llvm-objdump"
J="${J:-$(sysctl -n hw.ncpu 2>/dev/null || nproc)}"
OPT="${OPT:--O3}"
OUT="$ROOT/out/web"; mkdir -p "$OUT/obj" "$OUT/rt"
OBJCACHE="${OBJCACHE:-$ROOT/out/web/objcache}"; mkdir -p "$OBJCACHE"

# The guest owns [0, GUEST_END) of linear memory (runtime/cpu.h); the
# runtime's data starts there.  Initial memory covers the guest span plus room
# for the runtime heap; it can grow to 4 GB.
GUEST_END=671088640   # 0x28000000
INITIAL_MB="${INITIAL_MB:-1024}"
TARGET="--target=wasm32-wasip1-threads -pthread"
FEAT="-msimd128 -mbulk-memory -mnontrapping-fptoint -mtail-call -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false"
DEFS="-D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -DNFSU1=1"
# -fno-delete-null-pointer-checks: guest address 0 is real wasm memory (cpu.h)
CFLAGS="$TARGET $OPT $FEAT $DEFS -fno-delete-null-pointer-checks -include runtime/web/compat/wasm_plat.h -Iruntime/web/compat -Iruntime -Igen/all"
# the lifted shards only: guest memory as an object of its own (cpu.h, NFSU2_GUEST_OBJ)
SHARDFLAGS="-DNFSU2_GUEST_OBJ"
export CC OBJDUMP CFLAGS SHARDFLAGS OUT FULL MEMCHECK OBJCACHE
HDRSUM="$( (cat runtime/cpu.h runtime/web/compat/wasm_plat.h; echo "$CFLAGS $SHARDFLAGS") | shasum | cut -c1-16)"; export HDRSUM

# ---- lifted shards (content-hash incremental, as build.sh) ----
(cd gen/all && ls shard_*.c fntab.c impargs.c $( [ -f stubs.c ] && echo stubs.c ) | sed "s|^|all |") |
  xargs -P "$J" -n 2 sh -c '
  od="$OUT/obj"
  src="gen/$1/$2"; obj="$od/$(basename "$2" .c).o"
  sum=$( (cat "$src" "gen/$1/decls.h"; echo "$HDRSUM") | shasum | cut -c1-40)
  if [ -z "$FULL" ] && [ -f "$obj" ] && [ "$(cat "$obj.sum" 2>/dev/null)" = "$sum" ]; then exit 0; fi
  mc=""; case ",$MEMCHECK," in *",$(basename "$2" .c),"*) mc="-DNFSU2_MEMCHECK" ;; esac
  [ -n "$mc" ] && sum="$sum-memchk"
  if [ -z "$FULL" ] && [ -f "$obj" ] && [ "$(cat "$obj.sum" 2>/dev/null)" = "$sum" ]; then exit 0; fi
  # shared, content-addressed cache: every worktree with the same shard, cpu.h
  # and flags reuses one compile
  if [ -z "$FULL" ] && [ -f "$OBJCACHE/$sum.o" ]; then ln -f "$OBJCACHE/$sum.o" "$obj" 2>/dev/null || cp "$OBJCACHE/$sum.o" "$obj"
    echo "$sum" > "$obj.sum"; exit 0; fi
  o=$($CC $CFLAGS $SHARDFLAGS $mc -I"gen/$1" -Wno-unused-label -Wno-parentheses-equality -c -o "$obj" "$src" 2>&1); r=$?
  [ -z "$o" ] || printf "%s\n" "$o" | head -5
  [ $r -eq 0 ] || { echo "FAILED: $src" >&2; exit $r; }
  # a lookup table of guest addresses (g_guest + K in data) links as zeros
  # (cpu.h): compile the shard again without jump tables, which has none
  guestdata() { "$OBJDUMP" -r "$obj" | awk "/^RELOCATION RECORDS FOR \\[DATA\\]/ { d = 1; next } /^RELOCATION RECORDS/ { d = 0 }
    d && \$3 ~ /^g_guest[+-]/ && \$3 != \"g_guest+0\" { f = 1 } END { exit !f }"; }
  if guestdata; then
    $CC $CFLAGS $SHARDFLAGS $mc -fno-jump-tables -I"gen/$1" -Wno-unused-label -Wno-parentheses-equality -c -o "$obj" "$src" || { echo "FAILED: $src" >&2; exit 1; }
    if guestdata; then echo "FAILED: $src has guest addresses in data, without jump tables too (cpu.h, g_guest)" >&2; exit 1; fi
    echo "  $src: without jump tables (it had a lookup table of guest addresses)"
  fi
  echo "$sum" > "$obj.sum"; ln -f "$obj" "$OBJCACHE/$sum.o" 2>/dev/null || cp "$obj" "$OBJCACHE/$sum.o"
  echo "  compiled $src"' sh

# ---- runtime ----
RT="mem dispatch genexec heap watchdog win32 win32_ext com debug res fileio overrides vsemu autotest lifecycle widescreen framerate dinput_pad dikeys keyboard dinput_kbd winsock enhance module modheap headlights nfsu1_stubs"
WEB="audio_web gcpu gpu_web input_web main_web memchk memcmp null_platform sha256 shader_dump stackprobe status_web texrep_web thread_exit tz net_lan"
pids=""
for f in $RT; do
  src="runtime/$f.c"; [ -f "$src" ] || src="runtime/web/$f.c"
  [ -f "$src" ] || continue
  $CC $CFLAGS -DNFS_ENHANCED=0 -c -o "$OUT/rt/$f.o" "$src" & pids="$pids $!"
done
for f in $WEB; do
  case "$f" in thread_exit) fl="$TARGET $OPT $FEAT" ;; *) fl="$CFLAGS -DNFS_ENHANCED=0" ;; esac
  $CC $fl -c -o "$OUT/rt/web_$f.o" "runtime/web/$f.c" & pids="$pids $!"
done
for p in $pids; do wait "$p" || { echo "runtime compile failed"; exit 1; }; done

# ---- link ----
OBJS="$(ls "$OUT"/obj/*.o) $(ls "$OUT"/rt/*.o)"
PAGES=$(( INITIAL_MB * 16 ))
rm -f "$OUT/nfsu1.wasm" "$OUT/nfsu2.wasm" "$OUT/nfsu1.json" "$OUT/nfsu2.json"
$CC $TARGET $OPT $FEAT -o "$OUT/nfsu1.wasm" $OBJS \
  -Wl,--import-memory,--export-memory,--shared-memory,--max-memory=4294967296 \
  -Wl,--initial-memory=$(( INITIAL_MB * 1048576 )),--global-base=$GUEST_END \
  -Wl,-z,stack-size=$(( 8 * 1048576 )) -Wl,--no-stack-first \
  -lsetjmp -lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks 2>&1 | \
  { grep -v "^$" || true; } > "$OUT/link.log"
if [ ! -f "$OUT/nfsu1.wasm" ]; then
  echo "link FAILED ($(grep -c "undefined symbol" "$OUT/link.log" 2>/dev/null || echo 0) undefined symbols):"; grep -E "error" "$OUT/link.log" | head -80; exit 1; fi
REV="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo +)"
SIZE=$(wc -c < "$OUT/nfsu1.wasm" | tr -d ' ')
printf '{"pages":%d,"maxPages":65536,"guestEnd":%d,"rev":"%s","size":%d,"opt":"%s","lift":"%s"}\n' \
  "$PAGES" "$GUEST_END" "$REV" "$SIZE" "$OPT" "$LIFT" > "$OUT/nfsu1.json"
cp -f "$OUT/nfsu1.wasm" "$OUT/nfsu2.wasm"
cp -f "$OUT/nfsu1.json" "$OUT/nfsu2.json"
echo "link OK: out/web/nfsu1.wasm ($(( SIZE / 1048576 )) MB, $PAGES initial pages, rev $REV, lift $LIFT)"
if grep -q "signature mismatch" "$OUT/link.log"; then
  echo "WARNING: function signature mismatches (they trap when called):"; grep -A2 "signature mismatch" "$OUT/link.log"; fi
