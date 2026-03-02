import SwiftUI

struct BatteryView: View {
    let battery: BatteryMetrics
    let showDetails: Bool

    var body: some View {
        if battery.hasBattery {
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline) {
                    SectionHeader(icon: "battery.75percent", title: "Battery")
                    Spacer()
                    Text("\(battery.percent)%")
                        .font(.system(size: 20, weight: .semibold, design: .rounded))
                        .foregroundStyle(batteryColor)
                    if battery.isCharging {
                        Image(systemName: "bolt.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(.yellow)
                    }
                }

                MetricProgressBar(
                    value: Double(battery.percent),
                    label: "",
                    detail: !battery.timeRemaining.isEmpty ? "\(battery.timeRemaining) remaining" : ""
                )

                if showDetails {
                    HStack(spacing: 0) {
                        detailPill("Source", battery.powerSource)
                        detailPill("State", battery.isCharging ? "Charging" : "Discharging")
                        if !battery.timeRemaining.isEmpty {
                            detailPill("Time", battery.timeRemaining)
                        }
                    }
                }
            }
        }
    }

    private var batteryColor: Color {
        if battery.percent > 50 { return .green }
        if battery.percent > 20 { return .orange }
        return .red
    }

    private func detailPill(_ label: String, _ value: String) -> some View {
        VStack(spacing: 1) {
            Text(value)
                .font(.system(size: 10, weight: .medium))
                .lineLimit(1)
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
    }
}
