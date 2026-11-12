# YouTube macOS PiP

[English](README.md) · [日本語](README.ja.md) · **简体中文**

将 Chrome 中的 YouTube 视频切换到 macOS 原生画中画（PiP）窗口。本项目由 Chrome 扩展和一个小型 macOS 应用组成，在浏览器标签页与 WebKit 播放器之间传递播放进度、播放／暂停状态、音量、静音设置和播放速度。

## 主要功能

- 通过视频上的 **macOS PiP** 按钮、扩展工具栏按钮或 **Option+Shift+P** 启动画中画。
- 加载画中画时继续在 Chrome 中观看，确认原生画中画窗口实际显示后才暂停 Chrome。
- 返回原标签页时恢复最新的播放进度和设置；如果此前处于暂停状态，返回后仍保持暂停。
- 画中画播放期间，可从原 Chrome 标签页调整进度、音量、静音和播放速度。

应用和扩展的控件及提示目前主要使用日语。README 提供英语、日语和简体中文版本。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 系统 | macOS 13 或更高版本，以及图形桌面会话 |
| 浏览器 | macOS 版 Google Chrome |
| 构建工具 | 包含 `xcrun swiftc` 和 `xcrun clang` 的 Xcode Command Line Tools |
| 脚本运行环境 | Node.js 22 或更高版本 |
| 可选集成测试 | 支持 H.264 编码的 `ffmpeg`，以及支持测试所用扩展调试 API 的 Chrome 版本 |

macOS 13 是构建时设置的最低部署版本。画中画兼容性还取决于 WebKit 版本，详见[限制](#限制)。构建目标架构与运行脚本的 Mac 相同。无需执行 `npm install`。

## 安装

1. 克隆本仓库，或下载 ZIP 并解压到准备长期保留的文件夹中。
2. 在终端中进入该文件夹，执行：

```sh
./scripts/install.sh
```

3. 在 Chrome 中打开 `chrome://extensions`，启用**开发者模式**。
4. 选择**加载已解压的扩展程序**，指定仓库中的 `Extension` 文件夹。
5. 打开一个 YouTube 视频，点击视频控制栏中的 **macOS PiP**。无需提前启动 macOS 应用。

Chrome 会从 `Extension` 文件夹加载扩展，请在安装后保留该文件夹。如果移动了文件夹，请先移除旧的扩展注册，再从新位置重新加载。

安装脚本会构建应用、进行本地签名、将其复制到 `~/Applications`，并注册 Native Messaging 主机。如果存在本项目旧版的登录启动配置，脚本会将其移除，不会注册新的登录项。构建使用 ad hoc 签名，不包含 Developer ID 签名或公证。

| 安装内容 | 位置 |
| --- | --- |
| macOS 应用 | `~/Applications/YouTube macOS PiP.app` |
| Native Messaging 配置 | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromeytpip.bridge.json` |

## 使用方法

| 操作 | 方法 |
| --- | --- |
| 打开画中画 | 点击 **macOS PiP**、扩展工具栏按钮，或按 **Option+Shift+P**。 |
| 取消准备 | 视频按钮显示 **準備中…**（准备中）时，再次点击该按钮。 |
| 返回 Chrome | 点击原标签页或应用菜单栏菜单中的 **Chromeに戻す**（返回 Chrome），或使用画中画窗口的返回操作。 |
| 调整播放设置 | 在原标签页中调整进度、音量、静音或播放速度，变更会发送到画中画播放器。 |
| 在 Chrome 中继续播放 | 点击原视频的播放按钮；应用会先从画中画返回，再恢复 Chrome 播放。 |

请保持原 YouTube 标签页打开。跳转到其他视频会结束此前的画中画会话。从另一标签页启动画中画时，之前的视频会以暂停状态返回。如快捷键冲突，可在 `chrome://extensions/shortcuts` 中修改。

## 更新

关闭画中画，更新源代码，然后再次执行 `./scripts/install.sh`。接着在 `chrome://extensions` 中重新加载扩展。已打开的 YouTube 标签页通常会自动重新连接；如果控件没有更新，请刷新视频标签页。

## 工作原理与数据处理

**Chrome 扩展 → Native Messaging → macOS 应用／WKWebView**

扩展将视频 ID 和播放状态发送到同一台 Mac 上的应用。应用在独立的 WebKit 环境中打开视频，并使用 macOS 画中画显示。视频会从 YouTube 重新加载，并非捕获 Chrome 中的视频画面。

当 YouTube 视频可见且页面获得焦点时，扩展可能会静音预加载最多一个 WebKit 播放器，以缩短启动等待时间。因此，即使尚未打开画中画，也可能产生内存占用和网络流量。原页面不再处于活动状态或连接过期后，会释放预加载的播放器。

Chrome 的 Cookie 和登录状态不会被复制。WebKit 使用独立的网站数据；与 YouTube 的通信受 YouTube 自身的数据处理规则约束。本项目不包含自定义分析或遥测上传代码。

| 扩展权限 | 用途 |
| --- | --- |
| `nativeMessaging` | 与本地 macOS 应用通信。 |
| `activeTab` | 在用户调用扩展操作时访问当前标签页。 |
| `scripting` | 按需重新挂载扩展控件及连接。 |
| `https://www.youtube.com/*`、`https://m.youtube.com/*` | 提供视频控制，并在扩展重新加载后连接已打开的 YouTube 标签页。 |

`Extension/manifest.json` 中的 `key` 是用于固定扩展 ID 的**公钥**。安装脚本据此生成 Native Messaging 允许连接的来源。

## 限制

- 应用在检查可用性后使用 WebKit 私有 API `_setAllowsPictureInPictureMediaPlayback:`。macOS 或 WebKit 更新可能改变其行为。
- 需要登录、年龄验证、地区访问权限或 DRM 的视频，可能无法在独立的 WebKit 会话中播放。如果在交接前启动失败，Chrome 会继续播放。
- WebKit 中也可能显示 YouTube 广告。Chrome 中正在播放广告时，扩展会等待广告结束后再开始交接；本项目不提供广告拦截功能。
- 支持识别普通视频、Shorts 和直播 URL。直播 DVR 通过距直播最新位置的时间差同步进度，可用范围取决于直播的可拖动区间。
- 不同步字幕、画质、播放列表和 YouTube 账号状态。
- 当前安装脚本使用 Google Chrome 标准的用户级 Native Messaging 路径。其他浏览器及自定义浏览器配置需要另行设置。

## 常见问题

| 问题 | 检查与处理 |
| --- | --- |
| 找不到 `xcrun`、`swiftc` 或 `clang` | 执行 `xcode-select --install` 安装 Xcode Command Line Tools，然后重新打开终端。 |
| 找不到 `node` | 安装 Node.js 22 或更高版本，并在终端中确认 `node --version` 可执行。 |
| 没有 **macOS PiP** 按钮 | 确认扩展已启用并获准访问 YouTube，然后重新加载扩展和视频标签页。也可尝试工具栏按钮。 |
| 无法连接应用 | 从当前源代码文件夹重新执行 `./scripts/install.sh`，然后重新加载扩展。请将已安装应用保留在上表所示位置。 |
| 加载失败或没有画中画窗口 | 尝试无需登录的公开视频，并检查网络连接及上述 WebKit 限制。 |
| 快捷键没有反应 | 在 `chrome://extensions/shortcuts` 中检查快捷键分配。 |

直接打开应用会显示使用说明。正常播放应从 Chrome 中启动。

## 卸载

1. 关闭画中画，在 `chrome://extensions` 中移除扩展。
2. 删除“安装”一节所列两个位置中的应用和 Native Messaging 配置文件。
3. 如果不再需要，也可删除源代码文件夹。

删除应用后，用户 Library 中仍可能保留 WebKit 网站数据。

## 构建与测试

请在仓库根目录执行命令。仅构建、不安装：

```sh
./scripts/build.sh
```

输出为 `build/YouTube macOS PiP.app`。标准测试还会构建应用，并检查 WebKit 的创建与释放以及 Native Messaging。请在 macOS 图形会话中运行：

```sh
./scripts/test.sh
```

仅运行 JavaScript 测试：

```sh
node --test Tests/extension.test.mjs Tests/player.test.mjs
```

可选集成测试使用本地生成的视频和临时 Chrome 配置文件。请先安装 `ffmpeg`，关闭其他画中画窗口，并依次运行测试：

```sh
./scripts/test.sh --integration
```

标准测试构建应用和测试辅助程序后，还可执行以下检查。WebKit 单独测试需要 `ffmpeg`；YouTube 实站测试需要互联网连接，其中 Chrome 测试还需要 Chrome 和 `ffmpeg`：

```sh
./scripts/test-webkit.sh
node Tests/youtube-smoke.mjs
node Tests/chrome-smoke.mjs --youtube
```

Chrome 集成测试默认使用 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。如需使用其他 Chrome 可执行文件，可设置 `CHROME_PATH`。生成文件保存在 `build/` 或测试临时目录中。

## 参与贡献

报告问题时，请提供 macOS、Chrome、应用／扩展的版本、复现步骤和错误信息，并说明问题是否也发生在公开视频上，还是仅影响受限内容。共享日志前，请移除个人路径、账号信息、Cookie 和令牌。提交代码变更时，请说明行为变化及已执行的检查。

## 许可证

[MIT License](LICENSE)。本项目独立开发，与 YouTube、Google 或 Apple 无隶属关系，也未获得其背书。
