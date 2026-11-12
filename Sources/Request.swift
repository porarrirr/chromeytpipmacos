import Foundation

struct PlaybackState: Codable {
    var seconds: Double
    var paused: Bool
    var volume: Double
    var muted: Bool
    var rate: Double
    var liveOffset: Double?

    func validated() throws -> PlaybackState {
        guard seconds.isFinite, (0...31_536_000).contains(seconds),
              volume.isFinite, (0...1).contains(volume), rate.isFinite, (0.0625...16).contains(rate),
              liveOffset == nil || (liveOffset!.isFinite && (0...31_536_000).contains(liveOffset!)) else {
            throw NSError(domain: "PiP", code: 1, userInfo: [NSLocalizedDescriptionKey: "再生状態が不正です。"])
        }
        return self
    }
}

struct BridgeCommand: Decodable {
    let type: String
    let sessionID: String
    let videoID: String?
    let state: PlaybackState?
    let action: String?

    func validated() throws -> BridgeCommand {
        guard UUID(uuidString: sessionID) != nil, ["prepare", "start", "commit", "return", "cancel", "control"].contains(type) else {
            throw NSError(domain: "PiP", code: 2)
        }
        if type == "start" || type == "prepare" {
            guard let videoID, videoID.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil, state != nil else {
                throw NSError(domain: "PiP", code: 3)
            }
        }
        if type == "commit" && state == nil { throw NSError(domain: "PiP", code: 4) }
        if type == "control" && (state == nil || !["seek", "settings"].contains(action ?? "")) { throw NSError(domain: "PiP", code: 5) }
        if let state { _ = try state.validated() }
        return self
    }

    var watchURL: URL? {
        guard let videoID, let state else { return nil }
        return URL(string: "https://www.youtube.com/watch?v=\(videoID)&t=\(Int(state.seconds))s")
    }
}
