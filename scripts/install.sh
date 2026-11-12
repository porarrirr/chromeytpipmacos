#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/build.sh"
DEST="$HOME/Applications/YouTube macOS PiP.app"
HOSTS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
node "$ROOT/scripts/login-item.mjs" disable
"$ROOT/build/YouTube macOS PiP.app/Contents/MacOS/YouTubeMacPiP" --quit-running --target-app "$DEST"
mkdir -p "$HOME/Applications" "$HOSTS"
ditto "$ROOT/build/YouTube macOS PiP.app" "$DEST"
node "$ROOT/scripts/host-manifest.mjs" "$DEST/Contents/MacOS/PiPBridge" "$HOSTS/com.chromeytpip.bridge.json"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST"
printf '\nmacOS PiPのインストール完了。Chromeの拡張機能画面で既存の拡張機能を再読み込みし、バージョン3.1.3を確認してください。\n開いているYouTubeタブのボタンは自動で再接続します。反映されない場合はYouTubeのタブも再読み込みしてください。\n新規の場合は「パッケージ化されていない拡張機能を読み込む」で次を指定してください:\n%s\n' "$ROOT/Extension"
