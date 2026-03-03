import SwiftUI

struct OverviewView: View {
    let metrics: LiveMetrics
    let aiUsage: AIUsageState
    var onSelectTab: ((AppTab) -> Void)? = nil

    private let columns = [
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8)
    ]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 8) {
            cardButton(.system) {
                OverviewCard(
                    icon: "cpu",
                    title: "CPU",
                    value: String(format: "%.0f%%", metrics.cpu.usagePercent),
                    progress: metrics.cpu.usagePercent,
                    subtitle: metrics.cpu.brandString
                )
            }

            cardButton(.system) {
                OverviewCard(
                    icon: "memorychip",
                    title: "Memory",
                    value: String(format: "%.1f / %.0f GB", metrics.memory.used, metrics.memory.total),
                    progress: metrics.memory.usedPercent,
                    subtitle: String(format: "%.1f GB free", metrics.memory.free)
                )
            }

            cardButton(.system) {
                OverviewCard(
                    icon: "internaldrive",
                    title: "Disk",
                    value: String(format: "%.0f%%", metrics.disk.usedPercent),
                    progress: metrics.disk.usedPercent,
                    subtitle: String(format: "%.0f GB free", metrics.disk.freeGB)
                )
            }

            if metrics.battery.hasBattery {
                cardButton(.system) {
                    OverviewCard(
                        icon: metrics.battery.isCharging ? "battery.100.bolt" : "battery.50",
                        title: "Battery",
                        value: "\(metrics.battery.percent)%",
                        progress: Double(metrics.battery.percent),
                        subtitle: metrics.battery.isCharging ? "Charging" : metrics.battery.timeRemaining
                    )
                }
            } else {
                cardButton(.system) {
                    OverviewCard(
                        icon: "gpu",
                        title: "GPU",
                        value: metrics.gpu.name,
                        subtitle: "\(metrics.gpu.cores) cores"
                    )
                }
            }

            cardButton(.ports) {
                OverviewCard(
                    icon: "network",
                    title: "Ports",
                    value: "\(devPortCount) dev",
                    subtitle: "\(metrics.openPorts.count) total listening"
                )
            }

            cardButton(.ai) {
                OverviewCard(
                    icon: "brain",
                    title: "AI",
                    value: aiCardValue,
                    progress: highestUsagePercent,
                    subtitle: aiCardSubtitle
                )
            }
        }
    }

    // MARK: - Card Button Helper

    private func cardButton<Content: View>(_ tab: AppTab, @ViewBuilder content: () -> Content) -> some View {
        Button { onSelectTab?(tab) } label: { content() }
            .buttonStyle(.plain)
    }

    // MARK: - Dev Ports

    private var devPortCount: Int {
        PortManager.filterDevPorts(metrics.openPorts).count
    }

    // MARK: - AI Summary

    private var loadedProviders: [(AIProvider, AIUsageData)] {
        AIProvider.allCases.compactMap { provider in
            if case .loaded(let data) = aiUsage.statuses[provider] {
                return (provider, data)
            }
            return nil
        }
    }

    private var highestUsagePercent: Double? {
        let percents = loadedProviders.map { $0.1.usagePercent }
        return percents.max()
    }

    private var aiCardValue: String {
        if let highest = highestUsagePercent {
            return String(format: "%.0f%%", highest)
        }
        return "\(activeProviderCount)"
    }

    private var aiCardSubtitle: String {
        if loadedProviders.isEmpty {
            return activeProviderSummary
        }
        var parts: [String] = []
        let summary = loadedProviders
            .map { "\($0.0.label) \(String(format: "%.0f%%", $0.1.usagePercent))" }
            .joined(separator: " · ")
        parts.append(summary)
        if let reset = soonestResetDate {
            parts.append("Resets \(reset)")
        }
        return parts.joined(separator: "\n")
    }

    private var soonestResetDate: String? {
        let dates = loadedProviders.map { $0.1.resetDate }.filter { !$0.isEmpty }
        return dates.first
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
