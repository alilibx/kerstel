import Foundation

final class ProcessManager {
    enum KillResult {
        case success
        case error(String)
    }

    func kill(pid: Int) -> KillResult {
        let process = Process()
        let errorPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/kill")
        process.arguments = ["\(pid)"]
        process.standardOutput = Pipe()
        process.standardError = errorPipe

        do {
            try process.run()
            process.waitUntilExit()

            if process.terminationStatus == 0 {
                return .success
            } else {
                let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
                let errorMsg = String(data: errorData, encoding: .utf8) ?? "Permission denied"
                return .error(errorMsg.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        } catch {
            return .error(error.localizedDescription)
        }
    }
}
