import SwiftUI

struct AIUsageView: View {
    let aiUsage: AIUsageState
    let onRefresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header
            HStack {
                Text("AI Usage")
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                if aiUsage.isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Button(action: onRefresh) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.blue)
                    }
                    .buttonStyle(.plain)
                }
            }

            // Provider cards
            ForEach(AIProvider.allCases) { provider in
                AIProviderCard(
                    provider: provider,
                    status: aiUsage.statuses[provider] ?? .notInstalled
                )
            }

            // Last updated
            if let lastRefresh = aiUsage.lastRefresh {
                Text("Last updated \(lastRefresh.formatted(.relative(presentation: .named)))")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
        }
    }
}
