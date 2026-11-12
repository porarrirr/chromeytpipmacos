import Foundation

@main struct RequestTests {
    static func main() throws {
        let id = UUID().uuidString
        let valid = """
        {"type":"start","sessionID":"\(id)","videoID":"dQw4w9WgXcQ","state":{"seconds":123.5,"paused":false,"volume":0.5,"muted":false,"rate":1.25,"liveOffset":10}}
        """
        let decode = { (raw: String) throws -> BridgeCommand in try JSONDecoder().decode(BridgeCommand.self, from: Data(raw.utf8)).validated() }
        let request = try decode(valid)
        let prepared = try decode(valid.replacingOccurrences(of: "\"start\"", with: "\"prepare\""))
        precondition(prepared.type == "prepare" && prepared.videoID == request.videoID)
        precondition(request.state?.seconds == 123.5)
        precondition(request.watchURL?.absoluteString == "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=123s")
        for bad in [
            valid.replacingOccurrences(of: "dQw4w9WgXcQ", with: "../invalid"),
            valid.replacingOccurrences(of: id, with: "other"),
            valid.replacingOccurrences(of: "123.5", with: "-1"),
            valid.replacingOccurrences(of: "123.5", with: "31536001"),
            valid.replacingOccurrences(of: "123.5", with: "true"),
            valid.replacingOccurrences(of: "0.5", with: "2"),
            valid.replacingOccurrences(of: "1.25", with: "0"),
            valid.replacingOccurrences(of: "\"liveOffset\":10", with: "\"liveOffset\":-1"),
            valid.replacingOccurrences(of: "\"start\"", with: "\"execute\""),
            "{\"type\":\"commit\",\"sessionID\":\"\(id)\"}",
            "{\"type\":\"control\",\"sessionID\":\"\(id)\",\"action\":\"execute\"}"
        ] { precondition((try? decode(bad)) == nil, "Accepted invalid command: \(bad)") }
        let stop = try decode("{\"type\":\"return\",\"sessionID\":\"\(id)\"}")
        precondition(stop.type == "return")
        print("Native command and playback-state validation: passed")
    }
}
