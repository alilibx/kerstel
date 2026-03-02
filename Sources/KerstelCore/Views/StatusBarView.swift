import SwiftUI

struct StatusBarView: View {
    let metrics: LiveMetrics
    let aiUsage: AIUsageState
    let onKillProcess: (Int) -> Void
    let onCleanup: () -> Void
    let onRefreshPorts: () -> Void
    let onKillPort: (Int) -> Void
    let onRefreshAI: () -> Void
    let onQuit: () -> Void

    @State private var selectedTab: AppTab = .overview
    @State private var showDetails = false

    private var popoverHeight: CGFloat {
        switch selectedTab {
        case .system where showDetails: return 620
        default: return 480
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Kerstel")
                    .font(.system(size: 13, weight: .bold))
                Spacer()
                if selectedTab == .system {
                    Button(action: { withAnimation(.easeInOut(duration: 0.2)) { showDetails.toggle() } }) {
                        Text(showDetails ? "Simple" : "Details")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.blue)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 6)

            // Tab bar
            TabBarView(selectedTab: $selectedTab)
                .padding(.bottom, 6)
                .onChange(of: selectedTab) { _, newValue in
                    if newValue == .ports { onRefreshPorts() }
                    if newValue == .ai { onRefreshAI() }
                }

            Divider()

            // Dynamic content
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    switch selectedTab {
                    case .overview:
                        OverviewView(metrics: metrics, aiUsage: aiUsage)
                    case .system:
                        monitorContent
                    case .ports:
                        PortsView(
                            ports: metrics.openPorts,
                            onRefresh: onRefreshPorts,
                            onKill: onKillPort
                        )
                    case .ai:
                        AIUsageView(aiUsage: aiUsage, onRefresh: onRefreshAI)
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
        .frame(width: 360, height: popoverHeight)
        .animation(.easeInOut(duration: 0.2), value: showDetails)
        .animation(.easeInOut(duration: 0.2), value: selectedTab)
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
