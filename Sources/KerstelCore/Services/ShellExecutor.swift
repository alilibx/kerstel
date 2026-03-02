import Foundation

public protocol ShellExecutor {
    func run(_ command: String) -> String
}

public final class RealShellExecutor: ShellExecutor {
    public init() {}

    public func run(_ command: String) -> String {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-c", command]
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            return ""
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }
}

public final class MockShellExecutor: ShellExecutor {
    public var responses: [String: String] = [:]
    public private(set) var commandsRun: [String] = []

    public init(responses: [String: String] = [:]) {
        self.responses = responses
    }

    public func run(_ command: String) -> String {
        commandsRun.append(command)
        // Match by prefix/contains for flexibility
        for (key, value) in responses {
            if command.contains(key) {
                return value
            }
        }
        return ""
    }
}
