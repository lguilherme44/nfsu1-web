#!/bin/bash
# A worktree of the web repo for a parallel track:
#   web/tools/mkworktree.sh <name>   ->  ../nsfu2-web-wt/<name> (next to this clone), branch track/<name>
# gen/all, gen/server, deps/, .venv and web/node_modules are symlinked from the main clone
# (regenerate gen/ in the worktree only if the track changes the lifter: replace
# the symlinks with directories first, then web/gen.sh).
set -e
MAIN="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="${1:?usage: mkworktree.sh <name> [base]}"; BASE="${2:-web}"
WT="$(dirname "$MAIN")/nsfu2-web-wt/$NAME"
git -C "$MAIN" worktree add -b "track/$NAME" "$WT" "$BASE"
mkdir -p "$WT/gen" "$WT/web"
ln -s "$MAIN/gen/all" "$WT/gen/all"
ln -s "$MAIN/gen/server" "$WT/gen/server"     # server.dll, lifted as a second module
ln -s "$MAIN/deps" "$WT/deps"
ln -s "$MAIN/.venv" "$WT/.venv"
ln -s "$MAIN/web/node_modules" "$WT/web/node_modules"
echo "$WT"
