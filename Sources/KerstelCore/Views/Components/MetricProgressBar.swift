import SwiftUI

struct MetricProgressBar: View {
    let value: Double // 0-100
    let label: String
    let detail: String

    private var barColor: Color {
        if value < 65 { return .green }
        if value < 85 { return .orange }
        return .red
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if !label.isEmpty || !detail.isEmpty {
                HStack {
                    if !label.isEmpty {
                        Text(label)
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                }
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.primary.opacity(0.08))
                        .frame(height: 5)

                    RoundedRectangle(cornerRadius: 3)
                        .fill(barColor)
                        .frame(width: max(0, geo.size.width * min(value, 100) / 100), height: 5)
                }
            }
            .frame(height: 5)
        }
    }
}
