import SwiftUI

struct SectionHeader: View {
    let icon: String
    let title: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.blue)
                .frame(width: 16)

            Text(title)
                .font(.system(size: 12, weight: .semibold))

            Spacer()
        }
        .padding(.top, 4)
    }
}
