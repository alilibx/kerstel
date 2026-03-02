import Foundation

final class CleanupService {
    func runCleanup(metrics: LiveMetrics, collector: MetricsCollector) {
        DispatchQueue.main.async {
            metrics.cleanupInProgress = true
        }

        DispatchQueue.global().async {
            let memBefore = metrics.memory.used
            var cacheSize = ""
            var dnsCleared = false

            // 1. Purge memory (requires admin)
            self.runAdminShell("purge")

            // 2. Clear user caches
            cacheSize = self.clearUserCaches()

            // 3. Flush DNS
            dnsCleared = self.flushDNS()

            // Re-collect memory after cleanup
            Thread.sleep(forTimeInterval: 1.0)
            collector.collectAll(into: metrics)

            // Wait for collection to finish
            Thread.sleep(forTimeInterval: 1.5)

            DispatchQueue.main.async {
                metrics.lastCleanup = CleanupResult(
                    memoryBefore: memBefore,
                    memoryAfter: metrics.memory.used,
                    cacheCleared: cacheSize,
                    dnsCleared: dnsCleared,
                    timestamp: Date()
                )
                metrics.cleanupInProgress = false
            }
        }
    }

    private func clearUserCaches() -> String {
        let cachesURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        var totalSize: UInt64 = 0

        if let enumerator = FileManager.default.enumerator(at: cachesURL, includingPropertiesForKeys: [.fileSizeKey]) {
            for case let fileURL as URL in enumerator {
                if let size = try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                    totalSize += UInt64(size)
                }
            }
        }

        // Remove cache contents
        if let contents = try? FileManager.default.contentsOfDirectory(at: cachesURL, includingPropertiesForKeys: nil) {
            for item in contents {
                try? FileManager.default.removeItem(at: item)
            }
        }

        return formatBytes(totalSize)
    }

    private func flushDNS() -> Bool {
        let result = runAdminShell("dscacheutil -flushcache && killall -HUP mDNSResponder")
        return result
    }

    @discardableResult
    private func runAdminShell(_ command: String) -> Bool {
        let script = "do shell script \"\(command)\" with administrator privileges"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        process.standardOutput = Pipe()
        process.standardError = Pipe()

        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    func formatBytes(_ bytes: UInt64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}
