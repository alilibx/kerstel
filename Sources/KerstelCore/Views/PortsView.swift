import AppKit
import SwiftUI

struct PortsView: View {
    let ports: [PortInfo]
    let onRefresh: () -> Void
    let onKill: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SectionHeader(icon: "network", title: "Listening Ports")
                Spacer()
                Button(action: onRefresh) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .help("Refresh ports")
            }

            if ports.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "network.slash")
                        .font(.system(size: 24))
                        .foregroundStyle(.tertiary)
                    Text("No listening ports")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text("Click refresh to scan")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
            } else {
                VStack(spacing: 2) {
                    ForEach(ports) { port in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 0) {
                                Text(verbatim: ":\(port.port)")
                                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(.blue)
                                    .frame(width: 64, alignment: .leading)

                                Text(port.processName)
                                    .font(.system(size: 11))
                                    .lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)

                                Text(verbatim: "\(port.pid)")
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .frame(width: 52, alignment: .trailing)

                                Button(action: { onKill(port.pid) }) {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.system(size: 12))
                                        .foregroundStyle(.red.opacity(0.6))
                                }
                                .buttonStyle(.plain)
                                .padding(.leading, 6)
                                .help("Kill PID \(port.pid)")
                            }

                            if !port.path.isEmpty {
                                HStack(spacing: 4) {
                                    Text(port.path)
                                        .font(.system(size: 9, design: .monospaced))
                                        .foregroundStyle(.tertiary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)

                                    Button(action: {
                                        NSPasteboard.general.clearContents()
                                        NSPasteboard.general.setString(port.path, forType: .string)
                                    }) {
                                        Image(systemName: "doc.on.doc")
                                            .font(.system(size: 9))
                                            .foregroundStyle(.tertiary)
                                    }
                                    .buttonStyle(.plain)
                                    .help("Copy path")
                                }
                                .padding(.leading, 64)
                            }
                        }
                        .padding(.vertical, 4)
                        .padding(.horizontal, 6)
                        .background(
                            RoundedRectangle(cornerRadius: 4)
                                .fill(Color.primary.opacity(ports.firstIndex(where: { $0.id == port.id })! % 2 == 0 ? 0.03 : 0))
                        )
                    }
                }

                Text("\(ports.count) port\(ports.count == 1 ? "" : "s")")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 2)
            }
        }
    }
}
