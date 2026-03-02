import Foundation

final class MetricsCollector {
    private var cachedCPUBrand: String?
    private var cachedGPU: GPUMetrics?
    let shell: ShellExecutor

    init(shell: ShellExecutor = RealShellExecutor()) {
        self.shell = shell
    }

    func collectAll(into metrics: LiveMetrics) {
        let group = DispatchGroup()
        var mem = MemoryMetrics()
        var cpu = CPUMetrics()
        var disk = DiskMetrics()
        var battery = BatteryMetrics()
        var topCPU: [ProcessInfo] = []
        var topMem: [ProcessInfo] = []

        // Memory
        group.enter()
        DispatchQueue.global().async {
            mem = self.collectMemory()
            group.leave()
        }

        // CPU
        group.enter()
        DispatchQueue.global().async {
            cpu = self.collectCPU()
            group.leave()
        }

        // Disk
        group.enter()
        DispatchQueue.global().async {
            disk = self.collectDisk()
            group.leave()
        }

        // Battery
        group.enter()
        DispatchQueue.global().async {
            battery = self.collectBattery()
            group.leave()
        }

        // Processes
        group.enter()
        DispatchQueue.global().async {
            topCPU = self.collectTopProcesses(sortBy: .cpu)
            topMem = self.collectTopProcesses(sortBy: .memory)
            group.leave()
        }

        // GPU (cached)
        if cachedGPU == nil {
            group.enter()
            DispatchQueue.global().async {
                self.cachedGPU = self.collectGPU()
                group.leave()
            }
        }

        group.notify(queue: .main) {
            metrics.memory = mem
            metrics.cpu = cpu
            metrics.disk = disk
            metrics.battery = battery
            metrics.topCPUProcesses = topCPU
            metrics.topMemoryProcesses = topMem
            if let gpu = self.cachedGPU {
                metrics.gpu = gpu
            }
        }
    }

    // MARK: - Memory

    func collectMemory() -> MemoryMetrics {
        var m = MemoryMetrics()

        let totalBytes = shell.run("sysctl -n hw.memsize").trimmingCharacters(in: .whitespacesAndNewlines)
        m.total = (Double(totalBytes) ?? 0) / 1_073_741_824

        let vmstat = shell.run("vm_stat")
        let pageSize: Double = 16384
        let values = parseVMStat(vmstat)

        let free = values["Pages free"] ?? 0
        let active = values["Pages active"] ?? 0
        let inactive = values["Pages inactive"] ?? 0
        let speculative = values["Pages speculative"] ?? 0
        let wired = values["Pages wired down"] ?? 0
        let compressed = values["Pages occupied by compressor"] ?? 0
        let purgeable = values["Pages purgeable"] ?? 0
        let external = values["File-backed pages"] ?? 0

        m.active = (active * pageSize) / 1_073_741_824
        m.inactive = (inactive * pageSize) / 1_073_741_824
        m.wired = (wired * pageSize) / 1_073_741_824
        m.compressed = (compressed * pageSize) / 1_073_741_824
        m.free = (free * pageSize) / 1_073_741_824
        m.cached = ((purgeable + external) * pageSize) / 1_073_741_824

        let usedPages = active + wired + compressed + speculative - purgeable
        m.used = (usedPages * pageSize) / 1_073_741_824
        m.appMemory = ((active - purgeable) * pageSize) / 1_073_741_824

        // Clamp values
        m.used = min(m.used, m.total)
        m.free = m.total - m.used

        return m
    }

    func parseVMStat(_ output: String) -> [String: Double] {
        var result: [String: Double] = [:]
        for line in output.components(separatedBy: "\n") {
            let parts = line.components(separatedBy: ":")
            guard parts.count == 2 else { continue }
            let key = parts[0].trimmingCharacters(in: .whitespaces)
            let valStr = parts[1].trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ".", with: "")
            if let val = Double(valStr) {
                result[key] = val
            }
        }
        return result
    }

    // MARK: - CPU

    func collectCPU() -> CPUMetrics {
        var c = CPUMetrics()

        if cachedCPUBrand == nil {
            cachedCPUBrand = shell.run("sysctl -n machdep.cpu.brand_string").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        c.brandString = cachedCPUBrand ?? "Unknown"

        let top = shell.run("top -l 1 -n 0 -s 0")
        for line in top.components(separatedBy: "\n") {
            if line.contains("CPU usage:") {
                // "CPU usage: 5.26% user, 10.75% sys, 83.98% idle"
                let cleaned = line.replacingOccurrences(of: "CPU usage:", with: "").trimmingCharacters(in: .whitespaces)
                let parts = cleaned.components(separatedBy: ",")
                for part in parts {
                    let trimmed = part.trimmingCharacters(in: .whitespaces)
                    if trimmed.contains("user") {
                        c.userPercent = parsePercent(trimmed)
                    } else if trimmed.contains("sys") {
                        c.systemPercent = parsePercent(trimmed)
                    } else if trimmed.contains("idle") {
                        c.idlePercent = parsePercent(trimmed)
                    }
                }
            }
            if line.contains("Load Avg:") {
                // "Load Avg: 2.45, 2.18, 2.07"
                let cleaned = line.replacingOccurrences(of: "Load Avg:", with: "").trimmingCharacters(in: .whitespaces)
                let parts = cleaned.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                if parts.count >= 3 {
                    c.loadAvg1 = Double(parts[0]) ?? 0
                    c.loadAvg5 = Double(parts[1]) ?? 0
                    c.loadAvg15 = Double(parts[2]) ?? 0
                }
            }
        }

        return c
    }

    func parsePercent(_ str: String) -> Double {
        let digits = str.components(separatedBy: "%")[0].trimmingCharacters(in: .whitespaces)
        return Double(digits) ?? 0
    }

    // MARK: - Disk

    func collectDisk() -> DiskMetrics {
        var d = DiskMetrics()
        let df = shell.run("df -H /")
        let lines = df.components(separatedBy: "\n").filter { !$0.starts(with: "Filesystem") && !$0.isEmpty }
        guard let line = lines.first else { return d }

        let cols = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard cols.count >= 5 else { return d }

        d.totalGB = parseSizeGB(cols[1])
        d.usedGB = parseSizeGB(cols[2])
        d.freeGB = parseSizeGB(cols[3])

        let pctStr = cols[4].replacingOccurrences(of: "%", with: "")
        d.usedPercent = Double(pctStr) ?? 0

        return d
    }

    func parseSizeGB(_ str: String) -> Double {
        let cleaned = str.trimmingCharacters(in: .whitespaces)
        if cleaned.hasSuffix("T") || cleaned.hasSuffix("Ti") {
            return (Double(cleaned.filter { $0.isNumber || $0 == "." }) ?? 0) * 1000
        } else if cleaned.hasSuffix("G") || cleaned.hasSuffix("Gi") {
            return Double(cleaned.filter { $0.isNumber || $0 == "." }) ?? 0
        } else if cleaned.hasSuffix("M") || cleaned.hasSuffix("Mi") {
            return (Double(cleaned.filter { $0.isNumber || $0 == "." }) ?? 0) / 1000
        }
        return Double(cleaned.filter { $0.isNumber || $0 == "." }) ?? 0
    }

    // MARK: - GPU

    func collectGPU() -> GPUMetrics {
        var g = GPUMetrics()
        let sp = shell.run("system_profiler SPDisplaysDataType")

        for line in sp.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("Chipset Model:") {
                g.name = trimmed.replacingOccurrences(of: "Chipset Model:", with: "").trimmingCharacters(in: .whitespaces)
            } else if trimmed.hasPrefix("Total Number of Cores:") {
                g.cores = trimmed.replacingOccurrences(of: "Total Number of Cores:", with: "").trimmingCharacters(in: .whitespaces)
            } else if trimmed.hasPrefix("Metal Support:") || trimmed.hasPrefix("Metal Family:") {
                let val = trimmed.components(separatedBy: ":").dropFirst().joined(separator: ":").trimmingCharacters(in: .whitespaces)
                g.metalVersion = val
            } else if trimmed.hasPrefix("VRAM") {
                let val = trimmed.components(separatedBy: ":").dropFirst().joined(separator: ":").trimmingCharacters(in: .whitespaces)
                g.vram = val
            }
        }

        return g
    }

    // MARK: - Battery

    func collectBattery() -> BatteryMetrics {
        var b = BatteryMetrics()
        let pmset = shell.run("pmset -g batt")

        if pmset.contains("InternalBattery") {
            b.hasBattery = true
        } else {
            b.hasBattery = false
            return b
        }

        // Parse: "Now drawing from 'Battery Power'" or "'AC Power'"
        if pmset.contains("AC Power") {
            b.powerSource = "AC Power"
        } else {
            b.powerSource = "Battery"
        }

        // Parse: "-InternalBattery-0 (id=...)  78%; charging; 1:23 remaining"
        for line in pmset.components(separatedBy: "\n") {
            if line.contains("InternalBattery") {
                // Extract percentage
                if let range = line.range(of: #"\d+%"#, options: .regularExpression) {
                    let pctStr = line[range].replacingOccurrences(of: "%", with: "")
                    b.percent = Int(pctStr) ?? 0
                }
                b.isCharging = line.contains("charging") && !line.contains("discharging") && !line.contains("not charging")

                // Time remaining
                if let range = line.range(of: #"\d+:\d+"#, options: .regularExpression) {
                    b.timeRemaining = String(line[range])
                } else if line.contains("(no estimate)") {
                    b.timeRemaining = "Calculating..."
                } else if line.contains("not charging") {
                    b.timeRemaining = "Not charging"
                }
            }
        }

        return b
    }

    // MARK: - Processes

    enum ProcessSort {
        case cpu, memory
    }

    func collectTopProcesses(sortBy: ProcessSort) -> [ProcessInfo] {
        let flag = sortBy == .cpu ? "-r" : "-m"
        let raw = shell.run("ps -eo pid,pcpu,pmem,rss,comm \(flag)")
        var processes: [ProcessInfo] = []

        let lines = raw.components(separatedBy: "\n").dropFirst() // skip header
        for line in lines.prefix(5) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }
            let cols = trimmed.split(separator: " ", maxSplits: 4, omittingEmptySubsequences: true).map(String.init)
            guard cols.count >= 5 else { continue }

            let pid = Int(cols[0]) ?? 0
            let cpu = Double(cols[1]) ?? 0
            let mem = Double(cols[2]) ?? 0
            let rss = (Double(cols[3]) ?? 0) / 1024 // KB -> MB
            let name = URL(fileURLWithPath: cols[4]).lastPathComponent

            processes.append(ProcessInfo(pid: pid, name: name, cpu: cpu, memory: mem, rss: rss))
        }

        return processes
    }
}
