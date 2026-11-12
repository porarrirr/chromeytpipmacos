#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/YouTube macOS PiP.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
xcrun swiftc -O -target "$(uname -m)-apple-macosx13.0" \
  "$ROOT/Sources/Request.swift" "$ROOT/Sources/NativeConnection.swift" "$ROOT/Sources/WebKitConfig.swift" "$ROOT/Sources/PiPPresentation.swift" "$ROOT/Sources/main.swift" \
  -framework AppKit -framework WebKit -o "$APP/Contents/MacOS/YouTubeMacPiP"
xcrun clang -O2 -Wall -Wextra -Werror -mmacosx-version-min=13.0 \
  "$ROOT/Sources/resident.c" -o "$APP/Contents/MacOS/PiPResident"
xcrun clang -O2 -Wall -Wextra -Werror -fobjc-arc -mmacosx-version-min=13.0 \
  "$ROOT/Sources/host.m" -o "$APP/Contents/MacOS/PiPBridge"
cp "$ROOT/Sources/player.js" "$APP/Contents/Resources/player.js"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>YouTubeMacPiP</string>
<key>CFBundleIdentifier</key><string>com.chromeytpip.player</string>
<key>CFBundleName</key><string>YouTube macOS PiP</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>3.1.3</string>
<key>CFBundleVersion</key><string>9</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>CFBundleURLTypes</key><array><dict>
<key>CFBundleURLName</key><string>com.chromeytpip.player</string>
<key>CFBundleURLSchemes</key><array><string>chromeytpip</string></array>
</dict></array>
</dict></plist>
PLIST
codesign --force --deep --sign - "$APP"
printf 'Built: %s\n' "$APP"
