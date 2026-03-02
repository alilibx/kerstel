import SwiftUI

struct DiskView: View {
    let disk: DiskMetrics

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                SectionHeader(icon: "internaldrive", title: "Disk")
                Spacer()
                Text(String(format: "%.0f%%", disk.usedPercent))
                    .font(.system(size: 20, weight: .semibold, design: .rounded))
                    .foregroundStyle(colorForPercent(disk.usedPercent))
            }

            MetricProgressBar(
                value: disk.usedPercent,
                label: "",
                detail: String(format: "%.0fG used / %.0fG free", disk.usedGB, disk.freeGB)
            )
        }
    }
}

private func colorForPercent(_ pct: Double) -> Color {
    if pct < 65 { return .green }
    if pct < 85 { return .orange }
    return .red
}
