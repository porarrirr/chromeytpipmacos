#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/build/smoke"
ffmpeg -hide_banner -loglevel error -f lavfi -i 'color=c=blue:s=640x360:r=24' -t 5 -c:v libx264 -pix_fmt yuv420p -y "$ROOT/build/smoke/video.mp4"
printf '<!doctype html><video src="video.mp4" controls muted loop style="width:100%%"></video>\n' > "$ROOT/build/smoke/index.html"
xcrun swiftc "$ROOT/Sources/WebKitConfig.swift" "$ROOT/Tests/webkit-smoke.swift" -framework AppKit -framework WebKit -o "$ROOT/build/webkit-smoke"
"$ROOT/build/webkit-smoke" "$ROOT/build/smoke/index.html"
