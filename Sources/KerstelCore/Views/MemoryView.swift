import SwiftUI

struct MemoryView: View {
    let memory: MemoryMetrics
    let showDetails: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                SectionHeader(icon: "memorychip", title: "Memory")
                Spacer()
                Text(String(format: "%.1f", memory.used))
                    .font(.system(size: 20, weight: .semibold, design: .rounded))
                    .foregroundStyle(colorForPercent(memory.usedPercent))
                + Text(String(format: " / %.0fG", memory.total))
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(.secondary)
            }

            MetricProgressBar(
                value: memory.usedPercent,
                label: "",
                detail: ""
            )

            if showDetails {
                HStack(spacing: 0) {
                    detailPill("App", String(format: "%.1fG", memory.appMemory))
                    detailPill("Wired", String(format: "%.1fG", memory.wired))
                    detailPill("Compressed", String(format: "%.1fG", memory.compressed))
                    detailPill("Free", String(format: "%.1fG", memory.free))
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
