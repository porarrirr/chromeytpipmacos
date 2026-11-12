# YouTube macOS PiP

**English** · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)

Open YouTube videos from Chrome in macOS’s native Picture in Picture window. A Chrome extension and a small macOS app transfer playback between the browser tab and a WebKit player, keeping your position, play/pause state, volume, mute setting, and playback speed.

## Features

- Start from the video’s **macOS PiP** button, the extension toolbar button, or **Option+Shift+P**.
- Keep watching in Chrome while PiP loads. Chrome pauses only after the native PiP window is confirmed visible.
- Return to the original tab with the latest playback state, including whether the video was paused.
- Seek or change volume, mute, and playback speed from the original Chrome tab while PiP is active.

The app and extension currently display most controls and messages in Japanese. These README files provide English, Japanese, and Simplified Chinese instructions.

## Requirements

| Component | Requirement |
| --- | --- |
| System | macOS 13 or later; a graphical desktop session |
| Browser | Google Chrome for macOS |
| Build tools | Xcode Command Line Tools with `xcrun swiftc` and `xcrun clang` |
| Scripts | Node.js 22 or later |
| Optional integration tests | `ffmpeg` with H.264 encoding support and a Chrome version supporting the test’s extension debugging APIs |

macOS 13 is the build’s minimum deployment target. PiP compatibility also depends on the installed WebKit version; see [limitations](#limitations). The build targets the architecture of the Mac running the script. No `npm install` step is required.

## Installation

1. Clone this repository or download and extract its ZIP into a folder you intend to keep.
2. Open Terminal in that folder and run:

```sh
./scripts/install.sh
```

3. In Chrome, open `chrome://extensions` and enable **Developer mode**.
4. Choose **Load unpacked** and select the repository’s `Extension` folder.
5. Open a YouTube video and press **macOS PiP** in the video controls. You do not need to launch the app separately.

Keep the `Extension` folder in place: Chrome loads the extension from it. If you move it, remove the old extension entry and load it again from its new location.

The installer builds and locally signs the app, copies it to `~/Applications`, and registers the Native Messaging host. It also removes this project’s older login-time helper registration if present; it does not register a new login item. The build uses an ad hoc signature, without Developer ID signing or notarization.

| Installed item | Location |
| --- | --- |
| macOS app | `~/Applications/YouTube macOS PiP.app` |
| Native Messaging configuration | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromeytpip.bridge.json` |

## Usage

| Action | How |
| --- | --- |
| Open PiP | Press **macOS PiP**, the extension toolbar button, or **Option+Shift+P**. |
| Cancel loading | Press the video button again while it shows **準備中…** (“Preparing…”). |
| Return to Chrome | Press **Chromeに戻す** (“Return to Chrome”) in the original tab or the app’s menu bar menu, or use PiP’s return control. |
| Adjust playback | Seek or change volume, mute, or playback speed in the original tab. Changes are sent to PiP. |
| Resume in Chrome | Press Play on the original video; playback returns from PiP before Chrome resumes. |

Keep the original YouTube tab open. Navigating to another video ends the previous PiP session. Starting PiP from another tab returns the previous video paused. Change the shortcut at `chrome://extensions/shortcuts` if it conflicts with another shortcut.

## Updating

Close PiP, obtain the updated source, and run `./scripts/install.sh` again. Then reload the extension at `chrome://extensions`. Open YouTube tabs normally reconnect automatically; reload the tab if the controls do not update.

## How it works and data handling

**Chrome extension → Native Messaging → macOS app / WKWebView**

The extension sends the video ID and playback state to an app on the same Mac. The app opens the video independently in WebKit and presents it using macOS PiP. Video playback is loaded from YouTube again; it is not a capture of the Chrome video.

While a YouTube video is visible and focused, the extension may prepare one WebKit player silently to reduce startup delay. This uses memory and network traffic even before you open PiP. Preparation is released when the source becomes inactive or its connection expires.

Chrome cookies and login sessions are not copied. WebKit has its own site data, and requests to YouTube are subject to YouTube’s data handling. The project contains no custom analytics or telemetry upload code.

| Extension permission | Purpose |
| --- | --- |
| `nativeMessaging` | Communicate with the local macOS app. |
| `activeTab` | Access the tab when you invoke the extension action. |
| `scripting` | Reattach extension controls when needed. |
| `https://www.youtube.com/*`, `https://m.youtube.com/*` | Run video controls and reconnect open YouTube tabs after extension reloads. |

The `key` in `Extension/manifest.json` is a **public key** that fixes the extension ID. The installer derives the Native Messaging allowed origin from it.

## Limitations

- PiP uses a private WebKit API, `_setAllowsPictureInPictureMediaPlayback:`, after checking its availability. macOS or WebKit updates can change its behavior.
- Videos requiring login, age verification, regional access, or DRM may fail in the separate WebKit session. If startup fails before handoff, Chrome keeps playing.
- YouTube ads may appear in WebKit. The extension waits for Chrome-side ads to finish before starting a handoff; it does not block ads.
- Watch, Shorts, and live video URLs are recognized. Live DVR synchronization uses distance from the live edge; availability depends on the stream’s seekable range.
- Subtitles, quality settings, playlists, and YouTube account state are not synchronized.
- The current installer targets Google Chrome’s standard per-user Native Messaging location. Other browsers and custom browser setups require separate configuration.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `xcrun`, `swiftc`, or `clang` is missing | Install Xcode Command Line Tools with `xcode-select --install`, then reopen Terminal. |
| `node` is not found | Install Node.js 22 or later and confirm `node --version` works in Terminal. |
| No **macOS PiP** button | Check that the extension is enabled and allowed on YouTube, then reload the extension and video tab. Try the toolbar button. |
| The app cannot be reached | Run `./scripts/install.sh` from the current source folder and reload the extension. Keep the installed app at the path shown above. |
| Loading fails or no PiP window appears | Try a public video without login restrictions. Check network access and the WebKit limitations above. |
| The shortcut does nothing | Check its assignment at `chrome://extensions/shortcuts`. |

Opening the app directly shows a usage message. Normal playback starts from Chrome.

## Uninstalling

1. Close PiP and remove the extension at `chrome://extensions`.
2. Delete the app and Native Messaging configuration at the two locations listed under Installation.
3. Delete the source folder if you no longer need it.

WebKit site data may remain in your user Library after the app is deleted.

## Building and testing

Run commands from the repository root. To build without installing:

```sh
./scripts/build.sh
```

The output is `build/YouTube macOS PiP.app`. To run the standard suite, which also builds the app and checks WebKit creation/cleanup and Native Messaging, use a macOS graphical session:

```sh
./scripts/test.sh
```

For the JavaScript tests alone:

```sh
node --test Tests/extension.test.mjs Tests/player.test.mjs
```

The optional integration suite uses generated local video and a temporary Chrome profile. Install `ffmpeg` first, close other PiP windows, and run tests sequentially:

```sh
./scripts/test.sh --integration
```

After the standard suite has built the app and test helpers, these optional checks are also available. The WebKit check requires `ffmpeg`; the YouTube checks require internet access, and the Chrome check also requires Chrome and `ffmpeg`:

```sh
./scripts/test-webkit.sh
node Tests/youtube-smoke.mjs
node Tests/chrome-smoke.mjs --youtube
```

Chrome integration tests use `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` by default; set `CHROME_PATH` to use another Chrome executable. Generated files stay under `build/` or temporary test directories.

## Contributing

For a bug report, include macOS and Chrome versions, the app/extension version, reproduction steps, and any error message. Describe whether the issue affects public videos or only restricted content. Remove personal paths, account details, cookies, and tokens from shared logs. For code changes, describe the behavior change and the checks you ran.

## License

[MIT License](LICENSE). This is an independent project and is not affiliated with or endorsed by YouTube, Google, or Apple.
