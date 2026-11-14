# YouTube macOS PiP

[English](README.md) · **日本語** · [简体中文](README.zh-CN.md)

Chromeで見ているYouTube動画を、macOSのネイティブなピクチャ・イン・ピクチャ（PiP）で開くアプリとChrome拡張です。ブラウザーのタブとWebKitプレイヤーの間で、再生位置・再生／一時停止・音量・ミュート・再生速度を引き継ぎます。

## 主な機能

- 動画の **macOS PiP** ボタン、拡張機能のツールバーボタン、**Option+Shift+P** で開始。
- PiPの読み込み中もChromeで視聴を継続。ネイティブPiPウインドウの実表示を確認してからChromeを一時停止。
- PiPの最新位置と設定を元のタブへ返し、一時停止していた場合は停止状態も維持。
- PiP中も元のChromeタブからシーク・音量・ミュート・再生速度を変更。

アプリと拡張機能の操作表示・メッセージは現在、主に日本語です。READMEは英語・日本語・簡体字中国語で用意しています。

## 必要環境

| 項目 | 要件 |
| --- | --- |
| システム | macOS 13以降、GUIのデスクトップセッション |
| ブラウザー | macOS版Google Chrome |
| ビルドツール | `xcrun swiftc` と `xcrun clang` を含むXcode Command Line Tools |
| スクリプト | Node.js 22以降 |
| 任意の統合テスト | H.264エンコード対応の `ffmpeg`、テストで使用する拡張機能デバッグAPIに対応したChrome |

macOS 13はビルドで指定する最低対象バージョンです。PiPの互換性はWebKitのバージョンにも依存します。詳しくは[制約](#制約)を参照してください。ビルド対象のCPUアーキテクチャは、スクリプトを実行したMacに合わせます。`npm install` は不要です。

## インストール

1. リポジトリをcloneするか、ZIPをダウンロードして、今後も保持するフォルダへ展開します。
2. そのフォルダをターミナルで開き、次を実行します。

```sh
./scripts/install.sh
```

3. Chromeで `chrome://extensions` を開き、**デベロッパーモード**を有効にします。
4. **パッケージ化されていない拡張機能を読み込む**を選び、リポジトリの `Extension` フォルダを指定します。
5. YouTubeの動画を開き、操作バーの **macOS PiP** を押します。アプリを先に起動する必要はありません。

Chromeは `Extension` フォルダから拡張機能を読み込みます。導入後もフォルダを保持してください。移動した場合は古い拡張機能の登録を削除し、新しい場所から読み込み直します。

インストーラーはアプリをビルド・ローカル署名して `~/Applications` へコピーし、Native Messagingホストを登録します。このプロジェクトの旧版のログイン時起動設定があれば解除し、新しいログイン項目は登録しません。署名はアドホック署名で、Developer ID署名・公証は行いません。

| インストールするもの | 保存先 |
| --- | --- |
| macOSアプリ | `~/Applications/YouTube macOS PiP.app` |
| Native Messaging設定 | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromeytpip.bridge.json` |

## 使い方

| 操作 | 方法 |
| --- | --- |
| PiPを開く | **macOS PiP**、拡張機能のツールバーボタン、または **Option+Shift+P** を押します。 |
| 準備をキャンセル | 動画のボタンが **準備中…** の間に、もう一度押します。 |
| Chromeへ戻す | 元のタブやアプリのメニューバーメニューの **Chromeに戻す**、またはPiPの戻る操作を使います。 |
| 再生設定を変更 | 元のタブでシーク・音量・ミュート・再生速度を変更するとPiPへ送られます。 |
| Chromeで再生を再開 | 元の動画の再生ボタンを押すと、PiPから戻してからChromeで再開します。 |

元のYouTubeタブは開いたままにしてください。別の動画へ移動すると以前のPiPを終了します。別タブからPiPを開始すると、以前の動画は一時停止した状態で返します。ショートカットが競合する場合は `chrome://extensions/shortcuts` で変更できます。

## 更新

PiPを閉じてソースを更新し、`./scripts/install.sh` を再実行します。その後 `chrome://extensions` で拡張機能を再読み込みしてください。開いているYouTubeタブには通常、自動で再接続します。操作表示が更新されない場合は動画タブも再読み込みします。

アプリ **3.1.4** では、PiP表示前の余分な待ち時間を減らしました。準備済みのフレームがChromeの再生位置から5秒以内なら、再シークせず表示開始に利用します。フレームが利用できる状態では、再生開始処理のバッファ待ち完了を待たずにPiP表示を要求します。実ウインドウの表示確認後にChromeの最新位置・再生設定を適用します。初回読み込みや広告による待ち時間は残ります。

この変更はmacOSアプリ側のため、拡張機能は **3.1.3** のままです。拡張機能のバージョンが変わっていなくても、インストーラーを実行してアプリを更新してください。

## 仕組みとデータの扱い

**Chrome拡張 → Native Messaging → macOSアプリ／WKWebView**

拡張機能は、動画IDと再生状態を同じMac上のアプリへ渡します。アプリはWebKitで動画を独立して開き、macOSのPiPとして表示します。動画はYouTubeから再度読み込みます。Chromeの動画画面をキャプチャする方式ではありません。

YouTube動画が表示され、フォーカスがある間は、開始待ち時間を減らすため、最大1つのWebKitプレイヤーを無音で事前準備する場合があります。PiPを開く前にもメモリとネットワーク通信を使用します。送信元が非アクティブになった場合や接続の有効期限が切れた場合は準備を解放します。

ChromeのCookieやログイン状態はコピーしません。WebKitは独自のサイトデータを持ち、YouTubeとの通信にはYouTube側のデータの取り扱いが適用されます。本プロジェクト独自の分析・テレメトリー送信処理は含みません。

| 拡張機能の権限 | 用途 |
| --- | --- |
| `nativeMessaging` | ローカルのmacOSアプリとの通信。 |
| `activeTab` | 拡張機能の操作を実行したタブへのアクセス。 |
| `scripting` | 必要に応じた操作ボタン・接続の再構築。 |
| `https://www.youtube.com/*`、`https://m.youtube.com/*` | 動画の操作と、拡張機能の再読み込み後のYouTubeタブへの再接続。 |

`Extension/manifest.json` の `key` は、拡張機能のIDを固定するための**公開鍵**です。インストーラーは、この鍵からNative Messagingの接続を許可するオリジンを生成します。

## 制約

- WebKitの非公開API `_setAllowsPictureInPictureMediaPlayback:` を、存在確認付きで使用します。macOSやWebKitの更新で動作が変わる可能性があります。
- ログイン・年齢確認・地域制限・DRMなどのある動画は、別のWebKitセッションでは再生できない場合があります。引き継ぎ前に起動が失敗した場合はChromeの再生を続けます。
- WebKit側でもYouTubeの広告が表示される場合があります。Chrome側の広告中は引き継ぎの開始を待ちます。広告をブロックする機能はありません。
- 通常動画・Shorts・ライブのURLを認識します。ライブDVRはライブ端からの距離で位置を同期し、利用できる範囲は配信のシーク可能範囲に依存します。
- 字幕・画質・プレイリスト・YouTubeアカウントの状態は同期しません。
- 現在のインストーラーはGoogle Chromeの標準のユーザー用Native Messaging保存先を使用します。他のブラウザーや独自構成では別途設定が必要です。

## 困ったときは

| 症状 | 確認・対処 |
| --- | --- |
| `xcrun`、`swiftc`、`clang` が見つからない | `xcode-select --install` でXcode Command Line Toolsを導入し、ターミナルを開き直します。 |
| `node` が見つからない | Node.js 22以降を導入し、ターミナルで `node --version` を確認します。 |
| **macOS PiP** ボタンが出ない | 拡張機能が有効でYouTubeへのアクセスが許可されているか確認し、拡張機能と動画タブを再読み込みします。ツールバーボタンも試してください。 |
| アプリに接続できない | 現在のソースから `./scripts/install.sh` を再実行し、拡張機能を再読み込みします。インストールしたアプリは上記の保存先に置いてください。 |
| 読み込みに失敗する・PiPが出ない | ログイン不要の公開動画で試し、通信状態と上記のWebKitの制約を確認します。 |
| ショートカットが反応しない | `chrome://extensions/shortcuts` で割り当てを確認します。 |

アプリを直接開くと使い方の案内が出ます。通常の再生はChromeから開始します。

## アンインストール

1. PiPを閉じ、`chrome://extensions` から拡張機能を削除します。
2. 「インストール」に記載した2か所のアプリとNative Messaging設定を削除します。
3. 不要であれば取得したソースのフォルダも削除します。

アプリの削除後も、ユーザーのLibrary内にWebKitのサイトデータが残る場合があります。

## ビルドとテスト

コマンドはリポジトリのルートで実行します。インストールせずにビルドする場合：

```sh
./scripts/build.sh
```

出力先は `build/YouTube macOS PiP.app` です。通常テストではビルドに加え、WebKitの生成・解放やNative Messagingも確認します。macOSのGUIセッションで実行してください。

```sh
./scripts/test.sh
```

JavaScriptテストのみを実行する場合：

```sh
node --test Tests/extension.test.mjs Tests/player.test.mjs
```

任意の統合テストは、ローカルで生成した動画と一時的なChromeプロファイルを使用します。`ffmpeg` を導入し、ほかのPiPを閉じた状態で順番に実行してください。

```sh
./scripts/test.sh --integration
```

通常テストでアプリとテスト用ヘルパーをビルドした後は、次の確認も実行できます。WebKit単体の確認には `ffmpeg`、YouTube実サイトの確認にはインターネット接続が必要です。Chrome経由の確認ではChromeと `ffmpeg` も使用します。

```sh
./scripts/test-webkit.sh
node Tests/youtube-smoke.mjs
node Tests/chrome-smoke.mjs --youtube
node Tests/chrome-smoke.mjs --youtube --warm
node Tests/chrome-smoke.mjs --cold
```

Chrome統合テストの既定の実行ファイルは `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` です。別のChromeを使う場合は `CHROME_PATH` を指定します。生成物は `build/` またはテスト用の一時フォルダに保存されます。

## コントリビューション

不具合の報告には、macOS・Chrome・アプリ／拡張機能のバージョン、再現手順、エラーメッセージを添えてください。公開動画でも起きるか、制限のある動画だけで起きるかも記載すると調査に役立ちます。共有するログからは個人のパス、アカウント情報、Cookie、トークンを除いてください。コード変更では、変わる動作と実行した確認内容を説明してください。

## ライセンス

[MIT License](LICENSE)。本プロジェクトは独立したものであり、YouTube・Google・Appleとの提携や各社による承認を示すものではありません。
