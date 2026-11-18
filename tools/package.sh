#!/bin/sh
# Build the .iinaplgz that IINA installs from a GitHub release (plugin files only: no docs or dev tools).
#   tools/package.sh [output.iinaplgz]
cd "$(dirname "$0")/.." || exit 1
OUT=${1:-hanzi-lens.iinaplgz}
rm -f "$OUT"
zip -q -r -X "$OUT" Info.json main.js pref.html ui bin LICENSE THIRD_PARTY.md licenses -x '*.DS_Store'
ls -lh "$OUT"
