import Foundation

enum AppTab: Int, CaseIterable {
    case overview, system, ports, ai

    var icon: String {
        switch self {
        case .overview: return "square.grid.2x2"
        case .system: return "cpu"
        case .ports: return "network"
        case .ai: return "brain"
        }
    }

    var label: String {
        switch self {
        case .overview: return "Overview"
        case .system: return "System"
        case .ports: return "Ports"
        case .ai: return "AI"
        }
    }
}

struct MemoryMetrics {
    var total: Double = 0        // GB
    var used: Double = 0         // GB
    var free: Double = 0         // GB
    var active: Double = 0       // GB
    var inactive: Double = 0     // GB
    var wired: Double = 0        // GB
    var compressed: Double = 0   // GB
    var appMemory: Double = 0    // GB
    var cached: Double = 0       // GB

    var usedPercent: Double {
        guard total > 0 else { return 0 }
        return (used / total) * 100
    }
}

struct CPUMetrics {
    var brandString: String = "Unknown"
    var userPercent: Double = 0
    var systemPercent: Double = 0
    var idlePercent: Double = 100
    var loadAvg1: Double = 0
    var loadAvg5: Double = 0
    var loadAvg15: Double = 0

    var usagePercent: Double {
        return userPercent + systemPercent
    }
}

struct DiskMetrics {
    var totalGB: Double = 0
    var usedGB: Double = 0
    var freeGB: Double = 0
    var usedPercent: Double = 0
}

struct GPUMetrics {
    var name: String = "Unknown"
    var cores: String = ""
    var metalVersion: String = ""
    var vram: String = ""
}

struct BatteryMetrics {
    var percent: Int = 0
    var isCharging: Bool = false
    var timeRemaining: String = ""
    var powerSource: String = ""
    var hasBattery: Bool = false
}

struct ProcessInfo: Identifiable {
    let id = UUID()
    var pid: Int
    var name: String
    var cpu: Double
    var memory: Double
    var rss: Double  // MB
}

struct PortInfo: Identifiable {
    let id = UUID()
    var pid: Int
    var port: Int
    var processName: String
    var user: String
    var path: String = ""
}

struct CleanupResult {
    var memoryBefore: Double = 0
    var memoryAfter: Double = 0
    var cacheCleared: String = ""
    var dnsCleared: Bool = false
    var timestamp: Date = Date()

    var memoryFreed: Double {
        return max(0, memoryBefore - memoryAfter)
    }
}

@Observable
final class LiveMetrics {
    var memory = MemoryMetrics()
    var cpu = CPUMetrics()
    var disk = DiskMetrics()
    var gpu = GPUMetrics()
    var battery = BatteryMetrics()
    var topCPUProcesses: [ProcessInfo] = []
    var topMemoryProcesses: [ProcessInfo] = []
    var openPorts: [PortInfo] = []
    var lastCleanup: CleanupResult?
    var isCollecting: Bool = false
    var cleanupInProgress: Bool = false
}
