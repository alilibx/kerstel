import SwiftUI

struct StatusBarView: View {
    let metrics: LiveMetrics
    let onKillProcess: (Int) -> Void
    let onCleanup: () -> Void
    let onRefreshPorts: () -> Void
    let onKillPort: (Int) -> Void
    let onQuit: () -> Void

    @State private var selectedTab = 0
    @State private var showDetails = false

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Kerstel")
                    .font(.system(size: 13, weight: .bold))
                Spacer()
                Button(action: { withAnimation(.easeInOut(duration: 0.2)) { showDetails.toggle() } }) {
                    Text(showDetails ? "Simple" : "Details")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.blue)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 6)

            // Tab picker
            Picker("", selection: $selectedTab) {
                Text("Monitor").tag(0)
                Text("Ports").tag(1)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 14)
            .padding(.bottom, 8)
            .onChange(of: selectedTab) { _, newValue in
                if newValue == 1 { onRefreshPorts() }
            }

            Divider()

            // Content
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if selectedTab == 0 {
                        monitorContent
                    } else {
                        PortsView(
                            ports: metrics.openPorts,
                            onRefresh: onRefreshPorts,
                            onKill: onKillPort
                        )
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }

            Divider()

            // Footer
            HStack {
                Button("Quit") { onQuit() }
                    .buttonStyle(.plain)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
        }
        .frame(width: 360, height: showDetails ? 620 : 420)
        .animation(.easeInOut(duration: 0.2), value: showDetails)
    }

    @ViewBuilder
    private var monitorContent: some View {
        CPUView(cpu: metrics.cpu, showDetails: showDetails)
        Divider()
        MemoryView(memory: metrics.memory, showDetails: showDetails)
        Divider()
        DiskView(disk: metrics.disk)
        Divider()
        GPUInfoView(gpu: metrics.gpu, showDetails: showDetails)

        if metrics.battery.hasBattery {
            Divider()
            BatteryView(battery: metrics.battery, showDetails: showDetails)
        }

        Divider()

        ProcessListView(
            cpuProcesses: metrics.topCPUProcesses,
            memoryProcesses: metrics.topMemoryProcesses,
            onKill: onKillProcess
        )

        Divider()

        CleanupView(metrics: metrics, onCleanup: onCleanup)
    }
}
