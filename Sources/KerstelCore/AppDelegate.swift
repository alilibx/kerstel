import AppKit
import SwiftUI

public final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var refreshTimer: Timer?
    private var aiRefreshTimer: Timer?
    private let metrics = LiveMetrics()
    private let collector = MetricsCollector()
    private let cleanupService = CleanupService()
    private let processManager = ProcessManager()
    private let portManager = PortManager()
    private let aiUsage = AIUsageState()
    private let aiUsageService = AIUsageService()
    private var eventMonitor: Any?

    public override init() {
        super.init()
    }

    public func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if let button = statusItem.button {
            button.image = IconGenerator.makeMenuBarIcon()
            button.action = #selector(togglePopover)
            button.target = self
        }

        // Build popover once — SwiftUI view stays alive and reactive
        let rootView = StatusBarView(
            metrics: metrics,
            aiUsage: aiUsage,
            onKillProcess: { [weak self] pid in
                guard let self else { return }
                let result = self.processManager.kill(pid: pid)
                if case .success = result {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        self.collector.collectAll(into: self.metrics)
                    }
                }
            },
            onCleanup: { [weak self] in
                guard let self else { return }
                self.cleanupService.runCleanup(metrics: self.metrics, collector: self.collector)
            },
            onRefreshPorts: { [weak self] in
                guard let self else { return }
                DispatchQueue.global().async {
                    let ports = self.portManager.collectPorts()
                    DispatchQueue.main.async {
                        self.metrics.openPorts = ports
                    }
                }
            },
            onKillPort: { [weak self] pid in
                guard let self else { return }
                _ = self.portManager.killPort(pid: pid)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    DispatchQueue.global().async {
                        let ports = self.portManager.collectPorts()
                        DispatchQueue.main.async {
                            self.metrics.openPorts = ports
                        }
                    }
                }
            },
            onRefreshAI: { [weak self] in
                guard let self else { return }
                self.aiUsageService.refreshAll(into: self.aiUsage)
            },
            onQuit: {
                NSApp.terminate(nil)
            }
        )

        popover = NSPopover()
        popover.behavior = .transient
        popover.contentSize = NSSize(width: 360, height: 480)
        popover.contentViewController = NSHostingController(rootView: rootView)

        // Initial collection
        collector.collectAll(into: metrics)

        // Initial AI usage fetch
        aiUsageService.refreshAll(into: aiUsage)

        // Refresh system metrics every 4 seconds
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 4.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.collector.collectAll(into: self.metrics)
        }

        // Refresh AI usage every 60 seconds
        aiRefreshTimer = Timer.scheduledTimer(withTimeInterval: 60.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.aiUsageService.refreshAll(into: self.aiUsage)
        }
    }

    @objc private func togglePopover() {
        guard let button = statusItem.button else { return }

        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)

            // Close popover when clicking outside
            eventMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                self?.closePopover()
            }
        }
    }

    private func closePopover() {
        popover.performClose(nil)
        if let monitor = eventMonitor {
            NSEvent.removeMonitor(monitor)
            eventMonitor = nil
        }
    }
}
