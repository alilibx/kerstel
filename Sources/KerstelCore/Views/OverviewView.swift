import SwiftUI

struct OverviewView: View {
    let metrics: LiveMetrics
    let aiUsage: AIUsageState

    private let columns = [
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8)
    ]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 8) {
            OverviewCard(
                icon: "cpu",
                title: "CPU",
                value: String(format: "%.0f%%", metrics.cpu.usagePercent),
                progress: metrics.cpu.usagePercent,
                subtitle: metrics.cpu.brandString
            )

            OverviewCard(
                icon: "memorychip",
                title: "Memory",
                value: String(format: "%.1f / %.0f GB", metrics.memory.used, metrics.memory.total),
                progress: metrics.memory.usedPercent,
                subtitle: String(format: "%.1f GB free", metrics.memory.free)
            )

            OverviewCard(
                icon: "internaldrive",
                title: "Disk",
                value: String(format: "%.0f%%", metrics.disk.usedPercent),
                progress: metrics.disk.usedPercent,
                subtitle: String(format: "%.0f GB free", metrics.disk.freeGB)
            )

            if metrics.battery.hasBattery {
                OverviewCard(
                    icon: metrics.battery.isCharging ? "battery.100.bolt" : "battery.50",
                    title: "Battery",
                    value: "\(metrics.battery.percent)%",
                    progress: Double(metrics.battery.percent),
                    subtitle: metrics.battery.isCharging ? "Charging" : metrics.battery.timeRemaining
                )
            } else {
                OverviewCard(
                    icon: "gpu",
                    title: "GPU",
                    value: metrics.gpu.name,
                    subtitle: "\(metrics.gpu.cores) cores"
                )
            }

            OverviewCard(
                icon: "network",
                title: "Ports",
                value: "\(metrics.openPorts.count)",
                subtitle: metrics.openPorts.count == 1 ? "listening port" : "listening ports"
            )

            OverviewCard(
                icon: "brain",
                title: "AI",
                value: "\(activeProviderCount)",
                subtitle: activeProviderSummary
            )
        }
    }

    private var activeProviderCount: Int {
        aiUsage.statuses.values.filter { status in
            if case .loaded = status { return true }
            return false
        }.count
    }

    private var activeProviderSummary: String {
        let active = AIProvider.allCases.filter { provider in
            if case .loaded = aiUsage.statuses[provider] { return true }
            return false
        }.map(\.label)
        if active.isEmpty { return "no providers" }
        return active.joined(separator: ", ")
    }
}
