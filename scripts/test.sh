#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node --test "$ROOT/Tests/extension.test.mjs" "$ROOT/Tests/player.test.mjs"
"$ROOT/scripts/build.sh"
xcrun swiftc "$ROOT/Sources/Request.swift" "$ROOT/Tests/request-main.swift" -o "$ROOT/build/request-tests"
"$ROOT/build/request-tests"
xcrun swiftc "$ROOT/Tests/window-check.swift" -framework AppKit -o "$ROOT/build/window-check"
"$ROOT/build/YouTube macOS PiP.app/Contents/MacOS/YouTubeMacPiP" --test-lifecycle
node --test "$ROOT/Tests/native-protocol.test.mjs"
if [ "${1:-}" = '--integration' ]; then
  node "$ROOT/Tests/native-smoke.mjs"
  node "$ROOT/Tests/chrome-smoke.mjs"
fi
