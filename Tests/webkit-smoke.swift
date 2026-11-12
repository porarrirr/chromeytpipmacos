import AppKit
import WebKit

final class Smoke: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.isElementFullscreenEnabled = true
        guard enableNativePiP(config.preferences) else { print("WebKit PiP preference unavailable"); exit(1) }
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 400), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "WebKit PiP integration test"
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let file = URL(fileURLWithPath: CommandLine.arguments[1])
        web.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { print("WebKit PiP: timeout"); exit(1) }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        web.callAsyncJavaScript("""
          const v = document.querySelector('video');
          await v.play();
          if (!v.webkitSupportsPresentationMode?.('picture-in-picture')) throw new Error('PiP unsupported');
          v.webkitSetPresentationMode('picture-in-picture');
          await new Promise(resolve => setTimeout(resolve, 1500));
          const mode = v.webkitPresentationMode;
          v.webkitSetPresentationMode('inline');
          v.pause();
          return mode;
        """, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let mode):
                print("WebKit presentation mode: \(mode)")
                exit((mode as? String) == "picture-in-picture" ? 0 : 1)
            case .failure(let error): print("WebKit PiP failed: \(error)"); exit(1)
            }
        }
    }
}
@main struct SmokeMain {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = Smoke()
        app.delegate = delegate
        app.run()
    }
}
