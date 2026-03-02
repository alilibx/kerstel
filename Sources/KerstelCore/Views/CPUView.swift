import SwiftUI

struct CPUView: View {
    let cpu: CPUMetrics
    let showDetails: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                SectionHeader(icon: "cpu", title: "CPU")
                Spacer()
                Text(String(format: "%.0f%%", cpu.usagePercent))
                    .font(.system(size: 20, weight: .semibold, design: .rounded))
                    .foregroundStyle(colorForPercent(cpu.usagePercent))
            }

            MetricProgressBar(
                value: cpu.usagePercent,
                label: "",
                detail: ""
            )

            if showDetails {
                Text(cpu.brandString)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)

                HStack(spacing: 0) {
                    detailPill("User", String(format: "%.1f%%", cpu.userPercent))
                    detailPill("System", String(format: "%.1f%%", cpu.systemPercent))
                    detailPill("Load 1m", String(format: "%.2f", cpu.loadAvg1))
                    detailPill("Load 5m", String(format: "%.2f", cpu.loadAvg5))
                }
            }
        }
    }

    private func detailPill(_ label: String, _ value: String) -> some View {
        VStack(spacing: 1) {
            Text(value)
                .font(.system(size: 10, weight: .medium, design: .monospaced))
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
    }
}

private func colorForPercent(_ pct: Double) -> Color {
    if pct < 65 { return .green }
    if pct < 85 { return .orange }
    return .red
}
