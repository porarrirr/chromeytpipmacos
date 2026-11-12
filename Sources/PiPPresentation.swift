import AppKit
import CoreGraphics

final class PiPPresentation {
    private var generation = 0
    private var previousWindows = Set<Int>()
    private var presentedWindow: Int?

    func begin() {
        previousWindows = Set(visibleWindows().compactMap { $0[kCGWindowNumber as String] as? Int })
        presentedWindow = nil
    }

    func cancel() {
        generation += 1
    }

    func show(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        generation += 1
        let attemptID = generation
        let deadline = ProcessInfo.processInfo.systemUptime + 4
        func attempt() {
            guard attemptID == self.generation else { return }
            if let proof = self.visiblePresentation() {
                self.presentedWindow = proof["windowNumber"] as? Int
                completion(.success(proof))
                return
            }
            if ProcessInfo.processInfo.systemUptime >= deadline {
                completion(.failure(NSError(domain: "PiP", code: 6, userInfo: [NSLocalizedDescriptionKey:
                    "macOSのPiPウインドウを表示できませんでした。Chromeでの再生を続けます。時間を置いて再度お試しください。"])))
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.025, execute: attempt)
        }
        attempt()
    }

    private func visibleWindows() -> [[String: Any]] {
        CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    }

    private func visiblePresentation() -> [String: Any]? {
        let agentIDs = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.PIPAgent").map { $0.processIdentifier })
        let appID = ProcessInfo.processInfo.processIdentifier
        let legacyClass: AnyClass? = NSClassFromString("PIPPanel")
        let legacyNumbers = Set(NSApp.windows.filter { window in
            legacyClass.map { window.isKind(of: $0) } == true
        }.map { $0.windowNumber })
        for window in visibleWindows() {
            guard let owner = window[kCGWindowOwnerPID as String] as? Int32,
                  let number = window[kCGWindowNumber as String] as? Int,
                  let alpha = window[kCGWindowAlpha as String] as? Double, alpha > 0.1,
                  let level = window[kCGWindowLayer as String] as? Int,
                  let bounds = window[kCGWindowBounds as String] as? [String: Any],
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  frame.width >= 100, frame.height >= 60 else { continue }
            let agent = agentIDs.contains(owner)
            let legacy = owner == appID && legacyNumbers.contains(number)
            guard agent || legacy else { continue }
            guard number == presentedWindow || !previousWindows.contains(number) else { continue }
            let onDisplay = NSScreen.screens.contains { screen in
                guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else { return false }
                let part = CGDisplayBounds(id).intersection(frame)
                return part.width >= 80 && part.height >= 60
            }
            guard onDisplay, level >= NSWindow.Level.floating.rawValue else { continue }
            return ["visible": true, "onActiveSpace": true, "windowNumber": number,
                    "ownerPID": owner, "level": level, "backend": agent ? "system-agent" : "application"]
        }
        return nil
    }
}
