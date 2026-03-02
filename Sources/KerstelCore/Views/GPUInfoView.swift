import SwiftUI

struct GPUInfoView: View {
    let gpu: GPUMetrics
    let showDetails: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                SectionHeader(icon: "gpu", title: "GPU")
                Spacer()
                Text(gpu.name)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
            }

            if showDetails {
                HStack(spacing: 0) {
                    if !gpu.cores.isEmpty {
                        detailPill("Cores", gpu.cores)
                    }
                    if !gpu.metalVersion.isEmpty {
                        detailPill("Metal", gpu.metalVersion)
                    }
                    if !gpu.vram.isEmpty {
                        detailPill("VRAM", gpu.vram)
                    }
                }
            }
        }
    }

    private func detailPill(_ label: String, _ value: String) -> some View {
        VStack(spacing: 1) {
            Text(value)
                .font(.system(size: 10, weight: .medium))
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
    }
}
