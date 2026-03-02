import Testing
@testable import KerstelCore

struct ModelTests {

    // MARK: - MemoryMetrics

    @Test func memoryUsedPercent() {
        var m = MemoryMetrics()
        m.total = 24
        m.used = 12
        #expect(m.usedPercent == 50.0)
    }

    @Test func memoryUsedPercentZeroTotal() {
        let m = MemoryMetrics()
        #expect(m.usedPercent == 0.0)
    }

    // MARK: - CPUMetrics

    @Test func cpuUsagePercent() {
        var c = CPUMetrics()
        c.userPercent = 5
        c.systemPercent = 10
        #expect(c.usagePercent == 15.0)
    }

    // MARK: - CleanupResult

    @Test func cleanupMemoryFreed() {
        let r = CleanupResult(memoryBefore: 12, memoryAfter: 10)
        #expect(r.memoryFreed == 2.0)
    }

    @Test func cleanupMemoryFreedNegative() {
        let r = CleanupResult(memoryBefore: 10, memoryAfter: 12)
        #expect(r.memoryFreed == 0.0)
    }

    // MARK: - formatBytes

    @Test func formatBytes() {
        let service = CleanupService()

        // 0 bytes
        let zero = service.formatBytes(0)
        #expect(zero.contains("0") || zero == "Zero KB")

        // ~500 MB
        let mb500 = service.formatBytes(500_000_000)
        #expect(mb500.contains("MB") || mb500.contains("500"))

        // ~2 GB
        let gb2 = service.formatBytes(2_000_000_000)
        #expect(gb2.contains("GB") || gb2.contains("2"))
    }
}
