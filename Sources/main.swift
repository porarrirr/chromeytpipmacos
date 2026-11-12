import AppKit
import WebKit
import Darwin

let processStartedAt = ProcessInfo.processInfo.systemUptime

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSWindowDelegate {
    var window: NSWindow?
    var webView: WKWebView?
    var statusItem: NSStatusItem?
    var connection: NativeConnection?
    var request: BridgeCommand?
    var startupTimer: DispatchWorkItem?
    var latestState: [String: Any]?
    var finishing = false
    var activationRequested = false
    var documentReady = false
    var enteringPresentation = false
    var terminationSignal: DispatchSourceSignal?
    let presentation = PiPPresentation()
    let world = WKContentWorld.world(name: "YouTubeMacPiP")
    let native = CommandLine.arguments.contains("--native-host")
    func trace(_ stage: String) {
        guard CommandLine.arguments.contains("--trace-startup") else { return }
        let value: [String: Any] = ["startup": stage, "ms": (ProcessInfo.processInfo.systemUptime - processStartedAt) * 1000]
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8) {
            fputs(line + "\n", stderr)
        }
    }
    var testPage: URL? {
        guard let index = CommandLine.arguments.firstIndex(of: "--test-page"), index + 1 < CommandLine.arguments.count else { return nil }
        return URL(fileURLWithPath: CommandLine.arguments[index + 1])
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        trace("application-ready")
        if CommandLine.arguments.contains("--test-lifecycle") { testLifecycle(); return }
        if native {
            signal(SIGTERM, SIG_IGN)
            let signalSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
            signalSource.setEventHandler { [weak self] in self?.finish(nil, notify: false) }
            signalSource.resume()
            terminationSignal = signalSource
            connection = NativeConnection()
            connection?.onMessage = { [weak self] command in self?.receive(command) }
            connection?.onDisconnect = { [weak self] in self?.finish(nil, notify: false) }
        } else {
            let alert = NSAlert()
            alert.messageText = "YouTube macOS PiP"
            alert.informativeText = "ChromeのYouTubeで「macOS PiP」を押すと、このアプリのPiPが直接開きます。アプリを先に開いておく必要はありません。"
            alert.addButton(withTitle: "閉じる")
            alert.runModal()
            NSApp.terminate(nil)
        }
    }

    func receive(_ command: BridgeCommand) {
        if command.type == "start" || command.type == "prepare" {
            if let current = request {
                guard current.sessionID == command.sessionID, current.videoID == command.videoID, !finishing, !activationRequested else { return }
                request = command
                activationRequested = command.type == "start"
                if activationRequested { armStartupTimeout() }
                if documentReady { startDocument(update: true) }
                return
            }
            trace("request-received")
            request = command
            activationRequested = command.type == "start"
            guard makePlayer(), let webView else { fail("このmacOSではWebKitのPiPを有効にできません。"); return }
            armStartupTimeout()
            send(["type": "loading", "message": "macOS PiPを準備中…"])
            if let testPage { webView.loadFileURL(testPage, allowingReadAccessTo: testPage.deletingLastPathComponent()) }
            else if let url = command.watchURL { webView.load(URLRequest(url: url)) }
            return
        }
        guard command.sessionID == request?.sessionID, !finishing else { return }
        switch command.type {
        case "commit":
            guard let state = command.state, let data = try? JSONEncoder().encode(state), let value = try? JSONSerialization.jsonObject(with: data) else { return }
            call("await globalThis.macPiP.commit(state);", arguments: ["state": value])
        case "return", "cancel":
            call("if (globalThis.macPiP) globalThis.macPiP.finish(); else return null;", completion: { [weak self] in
                guard let self, !self.finishing else { return }
                self.finish(self.latestState)
            })
        case "control":
            guard let state = command.state, let data = try? JSONEncoder().encode(state), let value = try? JSONSerialization.jsonObject(with: data) else { return }
            call("globalThis.macPiP.control(action, state);", arguments: ["action": command.action ?? "", "state": value])
        default: break
        }
    }

    func armStartupTimeout() {
        startupTimer?.cancel()
        let timeout = DispatchWorkItem { [weak self] in self?.fail("動画の読み込みまたはPiP開始が完了しませんでした。Chromeでの再生を続けてください。") }
        startupTimer = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: timeout)
    }

    func startDocument(update: Bool = false) {
        guard let state = request?.state, let data = try? JSONEncoder().encode(state),
              let value = try? JSONSerialization.jsonObject(with: data) else { return }
        if update {
            call(activationRequested ? "globalThis.macPiP.activate(state);" : "globalThis.macPiP.prepare(state);", arguments: ["state": value])
        } else {
            call("globalThis.macPiP.start(state, videoID, warm);", arguments: ["state": value, "videoID": request?.videoID ?? "", "warm": !activationRequested])
        }
    }

    @discardableResult func makePlayer() -> Bool {
        guard webView == nil else { return true }
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.isElementFullscreenEnabled = true
        guard enableNativePiP(config.preferences) else { return false }
        let controller = config.userContentController
        controller.add(self, contentWorld: world, name: "pipStatus")
        guard let url = Bundle.main.url(forResource: "player", withExtension: "js"), let script = try? String(contentsOf: url, encoding: .utf8) else { return false }
        let startupScript = script + "\nwindow.webkit.messageHandlers.pipStatus.postMessage({type:'script-ready'});"
        controller.addUserScript(WKUserScript(source: startupScript, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world))
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 960, height: 540), configuration: config)
        view.navigationDelegate = self
        let host = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        host.title = "YouTube macOS PiP — rendering host"
        host.isReleasedWhenClosed = false
        host.alphaValue = 0
        host.ignoresMouseEvents = true
        host.delegate = self
        host.contentView = view
        host.orderBack(nil)
        window = host
        webView = view
        trace("webview-created")
        return true
    }

    func showStatusItem() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "pip", accessibilityDescription: "YouTube macOS PiP")
        item.button?.toolTip = "macOS PiPで再生中"
        let menu = NSMenu()
        let back = NSMenuItem(title: "Chromeに戻す", action: #selector(returnToChrome), keyEquivalent: "")
        back.target = self
        menu.addItem(back)
        item.menu = menu
        statusItem = item
    }

    func confirmPresentation(_ event: [String: Any], active: Bool) {
        presentation.show { [weak self] result in
            guard let self, !self.finishing else { return }
            switch result {
            case .success(let proof):
                var confirmed = event
                confirmed["presentation"] = proof
                if active {
                    self.startupTimer?.cancel(); self.startupTimer = nil
                    self.showStatusItem()
                }
                self.trace(active ? "handoff-active" : "pip-visible")
                self.send(confirmed)
            case .failure(let error): self.trace("pip-failed"); self.fail(error.localizedDescription)
            }
        }
    }

    @objc func returnToChrome() { call("globalThis.macPiP.finish();") }
    func windowWillClose(_ notification: Notification) { if !finishing { returnToChrome() } }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if finishing && webView != nil { return .terminateCancel }
        if !finishing && request != nil && webView != nil {
            call("globalThis.macPiP.finish();", completion: { [weak self] in if let self, !self.finishing { self.finish(self.latestState) } })
            return .terminateCancel
        }
        return .terminateNow
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if native && enteringPresentation { returnToChrome() }
        return false
    }

    func call(_ script: String, arguments: [String: Any] = [:], completion: (() -> Void)? = nil) {
        guard let webView else { completion?(); return }
        webView.callAsyncJavaScript(script, arguments: arguments, in: nil, in: world) { [weak self] result in
            if case .failure(let error) = result, let self, !self.finishing { self.fail("macOS PiPの操作に失敗しました: \(error.localizedDescription)") }
            completion?()
        }
    }

    func send(_ message: [String: Any]) {
        var event = message
        if let request { event["sessionID"] = request.sessionID; event["videoID"] = request.videoID }
        connection?.send(event)
    }

    func fail(_ message: String) {
        guard !finishing else { return }
        finish(latestState, notify: false, error: message)
    }

    func finish(_ state: [String: Any]?, notify: Bool = true, error: String? = nil) {
        guard !finishing else { return }
        finishing = true
        dispose { [self] in
            if let error { send(["type": "error", "error": error]) }
            else if notify {
                var event: [String: Any] = ["type": "returned"]
                if let state { event["state"] = state }
                send(event)
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    func dispose(completion: @escaping () -> Void) {
        finishing = true
        presentation.cancel()
        startupTimer?.cancel(); startupTimer = nil
        guard let view = webView else { releasePlayer(); completion(); return }
        var completed = false
        let finishClose = { [self] in
            guard !completed else { return }
            completed = true
            releasePlayer()
            trace("media-closed")
            completion()
        }
        view.pauseAllMediaPlayback {
            view.closeAllMediaPresentations(completionHandler: finishClose)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: finishClose)
    }

    func releasePlayer() {
        webView?.stopLoading()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "pipStatus", contentWorld: world)
        webView?.configuration.userContentController.removeAllUserScripts()
        webView?.navigationDelegate = nil
        window?.delegate = nil
        window?.contentView = nil
        window?.close()
        window = nil
        webView = nil
        documentReady = false
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        trace("page-loaded")
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { trace("document-committed") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("動画を読み込めませんでした: \(error.localizedDescription)") }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail("動画の読み込みが中断されました: \(error.localizedDescription)") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("macOSの動画プロセスが終了しました。Chromeへ戻します。") }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard navigationAction.targetFrame?.isMainFrame != false, let url = navigationAction.request.url else { decisionHandler(.allow); return }
        let allowed = (testPage != nil && url.isFileURL) || (url.scheme == "https" && ["www.youtube.com", "m.youtube.com", "consent.youtube.com"].contains(url.host ?? "")) || url.absoluteString == "about:blank"
        decisionHandler(allowed ? .allow : .cancel)
        if !allowed { fail("YouTubeのログイン・再生制限により動画を開けませんでした。Chromeでの再生を続けてください。") }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let localTest = testPage != nil && message.frameInfo.request.url?.isFileURL == true
        guard message.frameInfo.isMainFrame, localTest || ["www.youtube.com", "m.youtube.com"].contains(message.frameInfo.securityOrigin.host),
              var event = message.body as? [String: Any], let type = event["type"] as? String, !finishing else { return }
        if let state = event["state"] as? [String: Any],
           let data = try? JSONSerialization.data(withJSONObject: state),
           let decoded = try? JSONDecoder().decode(PlaybackState.self, from: data).validated(),
           let clean = try? JSONEncoder().encode(decoded), let value = try? JSONSerialization.jsonObject(with: clean) as? [String: Any] {
            latestState = value
            event["state"] = value
        } else { event.removeValue(forKey: "state") }
        switch type {
        case "script-ready":
            trace("document-script-ready")
            documentReady = true
            startDocument()
        case "prepared":
            guard !activationRequested else { return }
            trace("media-prepared")
            startupTimer?.cancel(); startupTimer = nil
            send(event)
        case "can-enter":
            trace("media-ready")
            presentation.begin()
            call("await globalThis.macPiP.enter();")
        case "ready":
            guard event["mode"] as? String == "picture-in-picture", !enteringPresentation else { return }
            enteringPresentation = true
            confirmPresentation(event, active: false)
        case "active":
            confirmPresentation(event, active: true)
        case "state", "loading": send(event)
        case "returned": finish(event["state"] as? [String: Any])
        case "error": fail((event["error"] as? String) ?? "macOS PiPを開始できませんでした。")
        default: break
        }
    }

    func testLifecycle() {
        struct WeakView { weak var value: WKWebView? }
        var released: [WeakView] = []
        precondition(webView == nil && window == nil)
        func cycle(_ remaining: Int) {
            guard remaining > 0 else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    precondition(NSApp.activationPolicy() == .accessory)
                    precondition(released.allSatisfy { $0.value == nil })
                    print("Three transparent rendering-host create/release cycles: passed")
                    NSApp.terminate(nil)
                }
                return
            }
            precondition(makePlayer())
            released.append(WeakView(value: webView))
            dispose {
                self.finishing = false
                precondition(self.webView == nil && self.window == nil)
                cycle(remaining - 1)
            }
        }
        cycle(3)
    }
}

if CommandLine.arguments.contains("--quit-running") {
    let target = CommandLine.arguments.firstIndex(of: "--target-app").flatMap { index in
        index + 1 < CommandLine.arguments.count ? URL(fileURLWithPath: CommandLine.arguments[index + 1]) : nil
    }
    let bundle = (target ?? Bundle.main.bundleURL).standardizedFileURL
    for running in NSRunningApplication.runningApplications(withBundleIdentifier: "com.chromeytpip.player")
        where running.processIdentifier != ProcessInfo.processInfo.processIdentifier && running.bundleURL?.standardizedFileURL == bundle {
        running.terminate()
        let deadline = Date().addingTimeInterval(5)
        let isRunning = { Darwin.kill(running.processIdentifier, 0) == 0 || errno == EPERM }
        while isRunning() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        if isRunning() { fputs("実行中のアプリを終了してから再実行してください。\n", stderr); exit(1) }
    }
} else {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
