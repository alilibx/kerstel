import Foundation

final class PortManager {
    let shell: ShellExecutor

    init(shell: ShellExecutor = RealShellExecutor()) {
        self.shell = shell
    }

    // MARK: - Dev Port Filtering

    static let devProcessNames: Set<String> = [
        "node", "python", "python3", "ruby", "java", "go", "cargo", "rustc",
        "php", "deno", "bun", "dotnet", "nginx", "httpd", "mongod", "mysqld",
        "postgres", "redis-server", "docker-proxy", "vite", "webpack",
        "esbuild", "uvicorn", "gunicorn", "next-server", "tsx", "npx",
        "rails", "flask", "django", "caddy", "traefik"
    ]

    static let devPortRanges: [ClosedRange<Int>] = [
        80...80, 443...443, 1433...1433,
        3000...3999, 4000...4999, 5000...5999,
        5432...5432, 6379...6379,
        8000...8999, 9000...9999,
        27017...27017
    ]

    static func isDevPort(_ port: PortInfo) -> Bool {
        let name = port.processName.lowercased()
        if devProcessNames.contains(name) { return true }
        for range in devPortRanges {
            if range.contains(port.port) { return true }
        }
        return false
    }

    static func filterDevPorts(_ ports: [PortInfo]) -> [PortInfo] {
        ports.filter { isDevPort($0) }
    }

    func collectPorts() -> [PortInfo] {
        let raw = shell.run("lsof -iTCP -sTCP:LISTEN -P -n")
        var ports = parsePorts(raw)

        // Fetch full paths for all PIDs in one call
        let pids = Array(Set(ports.map { $0.pid }))
        if !pids.isEmpty {
            let pidArg = pids.map(String.init).joined(separator: ",")
            let psRaw = shell.run("ps -p \(pidArg) -o pid=,comm=")
            var pathByPID: [Int: String] = [:]
            for line in psRaw.components(separatedBy: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard !trimmed.isEmpty else { continue }
                let parts = trimmed.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true).map(String.init)
                guard parts.count == 2, let pid = Int(parts[0]) else { continue }
                pathByPID[pid] = parts[1]
            }
            for i in ports.indices {
                ports[i].path = pathByPID[ports[i].pid] ?? ""
            }
        }

        return ports
    }

    func parsePorts(_ raw: String) -> [PortInfo] {
        var ports: [PortInfo] = []
        var seen = Set<String>() // Deduplicate by pid+port

        let lines = raw.components(separatedBy: "\n").dropFirst() // skip header
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }

            let cols = trimmed.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            guard cols.count >= 9 else { continue }

            let command = cols[0]
            let pid = Int(cols[1]) ?? 0
            let user = cols[2]
            // NAME is second-to-last: "*:7000 (LISTEN)" splits into ["*:7000", "(LISTEN)"]
            let name = cols[cols.count - 2]

            // Extract port from name like "*:3000" or "127.0.0.1:8080" or "[::1]:3000"
            var port = 0
            if let lastColon = name.lastIndex(of: ":") {
                let portStr = name[name.index(after: lastColon)...]
                port = Int(portStr) ?? 0
            }

            guard port > 0 else { continue }

            let key = "\(pid):\(port)"
            guard !seen.contains(key) else { continue }
            seen.insert(key)

            ports.append(PortInfo(pid: pid, port: port, processName: command, user: user))
        }

        return ports.sorted { $0.port < $1.port }
    }

    func killPort(pid: Int) -> ProcessManager.KillResult {
        return ProcessManager().kill(pid: pid)
    }
}
