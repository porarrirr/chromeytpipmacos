import AppKit
import CoreGraphics

let pid = Int32(CommandLine.arguments[1])!
let number = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2]) : nil
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
var found: [[String: Any]] = []
for window in windows {
    guard window[kCGWindowOwnerPID as String] as? Int32 == pid,
          number == nil || window[kCGWindowNumber as String] as? Int == number,
          let alpha = window[kCGWindowAlpha as String] as? Double, alpha > 0.1,
          let level = window[kCGWindowLayer as String] as? Int, level >= NSWindow.Level.floating.rawValue,
          let bounds = window[kCGWindowBounds as String] as? [String: Any],
          let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width >= 100, rect.height >= 60 else { continue }
    let displays = NSScreen.screens.compactMap { screen -> CGRect? in
        guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else { return nil }
        return CGDisplayBounds(id)
    }
    guard displays.contains(where: { $0.intersects(rect) }) else { continue }
    found.append(["windowNumber": window[kCGWindowNumber as String]!, "alpha": alpha, "level": level,
                  "bounds": NSStringFromRect(rect)])
}
if found.isEmpty {
    fputs("No visible floating PiP window for process \(pid) on the current Space.\n", stderr)
    exit(1)
}
let data = try JSONSerialization.data(withJSONObject: found, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
