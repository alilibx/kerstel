import SwiftUI

struct AIProviderCard: View {
    let provider: AIProvider
    let status: AIProviderStatus

    private var providerColor: Color {
        switch provider {
        case .claude: return .orange
        case .cursor: return .blue
        case .codex: return .green
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Header: icon + name + status badge
            HStack {
                Image(systemName: provider.icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(providerColor)
                Text(provider.label)
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                statusBadge
            }

            // Content based on status
            switch status {
            case .notInstalled:
                Text("Not installed")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)

            case .notAuthenticated:
                Text("Not authenticated")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)

            case .loading:
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading...")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }

            case .loaded(let data):
                loadedContent(data)

            case .error(let message):
                Text(message)
                    .font(.system(size: 10))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.primary.opacity(0.03))
        )
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch status {
        case .notInstalled:
            Text("N/A")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.primary.opacity(0.05)))
        case .notAuthenticated:
            Text("No Auth")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.orange)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.orange.opacity(0.1)))
        case .loading:
            EmptyView()
        case .loaded(let data):
            Text(data.planName)
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(providerColor)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(providerColor.opacity(0.1)))
        case .error:
            Text("Error")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.red)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.red.opacity(0.1)))
        }
    }

    @ViewBuilder
    private func loadedContent(_ data: AIUsageData) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // Usage percentage
            HStack(alignment: .firstTextBaseline) {
                Text(String(format: "%.0f%%", data.usagePercent))
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(usageColor(data.usagePercent))
                Spacer()
                Text(data.usageDescription)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            // Progress bar
            MetricProgressBar(
                value: data.usagePercent,
                label: "",
                detail: ""
            )

            // Reset date
            if !data.resetDate.isEmpty {
                Text(data.resetDate)
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func usageColor(_ percent: Double) -> Color {
        if percent < 65 { return .green }
        if percent < 85 { return .orange }
        return .red
    }
}
