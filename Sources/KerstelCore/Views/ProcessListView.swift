import SwiftUI

struct ProcessListView: View {
    let cpuProcesses: [ProcessInfo]
    let memoryProcesses: [ProcessInfo]
    let onKill: (Int) -> Void

    @State private var sortBy = 0 // 0 = CPU, 1 = Memory

    private var processes: [ProcessInfo] {
        sortBy == 0 ? cpuProcesses : memoryProcesses
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                SectionHeader(icon: "flame", title: "Processes")
                Spacer()
                Picker("", selection: $sortBy) {
                    Text("CPU").tag(0)
                    Text("Mem").tag(1)
                }
                .pickerStyle(.segmented)
                .frame(width: 100)
            }

            ForEach(processes) { proc in
                HStack(spacing: 6) {
                    Text(proc.name)
                        .font(.system(size: 10))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    Text(sortBy == 0
                         ? String(format: "%.1f%%", proc.cpu)
                         : String(format: "%.1f%%", proc.memory))
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .frame(width: 50, alignment: .trailing)

                    Text(String(format: "%.0fM", proc.rss))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .frame(width: 45, alignment: .trailing)

                    Button(action: { onKill(proc.pid) }) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(.red.opacity(0.7))
                    }
                    .buttonStyle(.plain)
                    .help("Kill process \(proc.pid)")
                }
                .padding(.vertical, 1)
            }

            if processes.isEmpty {
                Text("No processes")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
        }
    }
}
