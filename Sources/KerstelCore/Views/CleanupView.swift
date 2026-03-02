import SwiftUI

struct CleanupView: View {
    let metrics: LiveMetrics
    let onCleanup: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionHeader(icon: "sparkles", title: "Cleanup")

            Button(action: onCleanup) {
                HStack {
                    if metrics.cleanupInProgress {
                        ProgressView()
                            .controlSize(.small)
                            .scaleEffect(0.7)
                        Text("Cleaning...")
                            .font(.system(size: 11))
                    } else {
                        Image(systemName: "wand.and.stars")
                            .font(.system(size: 11))
                        Text("Run Cleanup")
                            .font(.system(size: 11, weight: .medium))
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(metrics.cleanupInProgress ? Color.gray.opacity(0.15) : Color.blue.opacity(0.15))
                )
            }
            .buttonStyle(.plain)
            .disabled(metrics.cleanupInProgress)

            if let result = metrics.lastCleanup {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        resultItem("Memory freed", String(format: "%.2f GB", result.memoryFreed))
                        resultItem("Cache cleared", result.cacheCleared)
                    }
                    HStack(spacing: 8) {
                        resultItem("DNS flushed", result.dnsCleared ? "Yes" : "No")
                        resultItem("Time", timeAgo(result.timestamp))
                    }
                }
                .padding(6)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.green.opacity(0.06)))
            }

            Text("Purges memory, clears user caches, flushes DNS. Requires admin password.")
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
        }
    }

    private func resultItem(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 10, weight: .medium))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func timeAgo(_ date: Date) -> String {
        let seconds = Int(-date.timeIntervalSinceNow)
        if seconds < 60 { return "Just now" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        return "\(seconds / 3600)h ago"
    }
}
