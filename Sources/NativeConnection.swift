import Foundation
import Darwin

final class NativeConnection {
    var onMessage: ((BridgeCommand) -> Void)?
    var onDisconnect: (() -> Void)?
    private var input: DispatchSourceRead?
    private var buffer = Data()
    private var closed = false

    init() {
        signal(SIGPIPE, SIG_IGN)
        let flags = fcntl(STDIN_FILENO, F_GETFL)
        _ = fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK)
        let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        source.setEventHandler { [weak self] in self?.readInput() }
        source.resume()
        input = source
    }

    deinit { input?.cancel() }

    func send(_ object: [String: Any]) {
        guard !closed, let body = try? JSONSerialization.data(withJSONObject: object), body.count <= 1_048_576 else { return }
        var length = UInt32(body.count).littleEndian
        var frame = Data(bytes: &length, count: 4)
        frame.append(body)
        let success = frame.withUnsafeBytes { bytes -> Bool in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(STDOUT_FILENO, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { return false }
                offset += count
            }
            return true
        }
        if !success { disconnect() }
    }

    private func readInput() {
        var bytes = [UInt8](repeating: 0, count: 8192)
        while !closed {
            let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
            if count < 0 {
                if errno == EINTR { continue }
                if errno != EAGAIN { disconnect() }
                return
            }
            if count == 0 { disconnect(); return }
            buffer.append(contentsOf: bytes.prefix(count))
            while buffer.count >= 4 {
                let size = buffer.prefix(4).enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << ($1.offset * 8) }
                guard size > 0 && size <= 8192 else { reject(); return }
                guard buffer.count >= Int(size) + 4 else { break }
                let body = Data(buffer.dropFirst(4).prefix(Int(size)))
                buffer.removeFirst(Int(size) + 4)
                do {
                    let command = try JSONDecoder().decode(BridgeCommand.self, from: body).validated()
                    onMessage?(command)
                } catch { reject(); return }
            }
        }
    }

    private func reject() {
        send(["type": "error", "error": "アプリに渡された動画情報が不正です。"])
        disconnect()
    }

    private func disconnect() {
        guard !closed else { return }
        closed = true
        input?.cancel()
        input = nil
        onDisconnect?()
    }
}
