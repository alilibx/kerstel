import Testing
@testable import KerstelCore

struct MetricsParsingTests {

    // MARK: - parseVMStat

    @Test func parseVMStat() {
        let collector = MetricsCollector(shell: MockShellExecutor())
        let result = collector.parseVMStat(Fixtures.vmStatOutput)

        #expect(result["Pages free"] == 72463)
        #expect(result["Pages active"] == 389928)
        #expect(result["Pages wired down"] == 120832)
        #expect(result["Pages occupied by compressor"] == 62893)
        #expect(result["Pages speculative"] == 4747)
        #expect(result["Pages purgeable"] == 30217)
        #expect(result["File-backed pages"] == 185302)
    }

    @Test func parseVMStatEmptyInput() {
        let collector = MetricsCollector(shell: MockShellExecutor())
        let result = collector.parseVMStat("")
        #expect(result.isEmpty)
    }

    // MARK: - parsePercent

    @Test func parsePercent() {
        let collector = MetricsCollector(shell: MockShellExecutor())
        #expect(collector.parsePercent("5.26% user") == 5.26)
    }

    @Test func parsePercentNoValue() {
        let collector = MetricsCollector(shell: MockShellExecutor())
        #expect(collector.parsePercent("% user") == 0.0)
    }

    // MARK: - parseSizeGB

    @Test func parseSizeGB_gigabytes() {
        let collector = MetricsCollector(shell: MockShellExecutor())
        #expect(collector.parseSizeGB("494G") == 494.0)
    }

    @Test func parseSizeGB_terabytes() {
        let collector = MetricsCollector(shell: MockShellExecutor())
        #expect(collector.parseSizeGB("1.5T") == 1500.0)
    }

    @Test func parseSizeGB_megabytes() {
        let collector = MetricsCollector(shell: MockShellExecutor())
        #expect(collector.parseSizeGB("500M") == 0.5)
    }

    // MARK: - collectMemory

    @Test func collectMemory() {
        let mock = MockShellExecutor(responses: [
            "sysctl -n hw.memsize": Fixtures.sysctlMemsize,
            "vm_stat": Fixtures.vmStatOutput
        ])
        let collector = MetricsCollector(shell: mock)
        let mem = collector.collectMemory()

        #expect(abs(mem.total - 24.0) < 0.1)
        #expect(mem.used > 0)
        #expect(mem.wired > 0)
        #expect(mem.compressed > 0)
        #expect(abs((mem.used + mem.free) - mem.total) < 0.01)
    }

    // MARK: - collectCPU

    @Test func collectCPU() {
        let mock = MockShellExecutor(responses: [
            "machdep.cpu.brand_string": Fixtures.cpuBrand,
            "top": Fixtures.topOutput
        ])
        let collector = MetricsCollector(shell: mock)
        let cpu = collector.collectCPU()

        #expect(cpu.brandString == "Apple M2 Pro")
        #expect(cpu.userPercent == 5.26)
        #expect(cpu.systemPercent == 10.75)
        #expect(cpu.idlePercent == 83.98)
        #expect(cpu.loadAvg1 == 2.45)
        #expect(cpu.loadAvg5 == 2.18)
        #expect(cpu.loadAvg15 == 2.07)
    }

    // MARK: - collectDisk

    @Test func collectDisk() {
        let mock = MockShellExecutor(responses: [
            "df": Fixtures.dfOutput
        ])
        let collector = MetricsCollector(shell: mock)
        let disk = collector.collectDisk()

        #expect(disk.totalGB == 494.0)
        #expect(disk.usedGB == 215.0)
        #expect(disk.freeGB == 252.0)
        #expect(disk.usedPercent == 47.0)
    }

    // MARK: - collectBattery

    @Test func collectBattery_charging() {
        let mock = MockShellExecutor(responses: [
            "pmset": Fixtures.pmsetCharging
        ])
        let collector = MetricsCollector(shell: mock)
        let battery = collector.collectBattery()

        #expect(battery.hasBattery == true)
        #expect(battery.percent == 78)
        #expect(battery.isCharging == true)
        #expect(battery.timeRemaining == "1:23")
        #expect(battery.powerSource == "AC Power")
    }

    @Test func collectBattery_discharging() {
        let mock = MockShellExecutor(responses: [
            "pmset": Fixtures.pmsetDischarging
        ])
        let collector = MetricsCollector(shell: mock)
        let battery = collector.collectBattery()

        #expect(battery.hasBattery == true)
        #expect(battery.percent == 45)
        #expect(battery.isCharging == false)
        #expect(battery.timeRemaining == "3:47")
        #expect(battery.powerSource == "Battery")
    }

    @Test func collectBattery_noBattery() {
        let mock = MockShellExecutor(responses: [
            "pmset": Fixtures.pmsetNoBattery
        ])
        let collector = MetricsCollector(shell: mock)
        let battery = collector.collectBattery()

        #expect(battery.hasBattery == false)
    }

    // MARK: - collectGPU

    @Test func collectGPU() {
        let mock = MockShellExecutor(responses: [
            "system_profiler": Fixtures.systemProfilerGPU
        ])
        let collector = MetricsCollector(shell: mock)
        let gpu = collector.collectGPU()

        #expect(gpu.name == "Apple M2 Pro")
        #expect(gpu.cores == "19")
        #expect(gpu.metalVersion == "Metal 3")
    }

    // MARK: - collectTopProcesses

    @Test func collectTopProcesses() {
        let mock = MockShellExecutor(responses: [
            "ps": Fixtures.psOutput
        ])
        let collector = MetricsCollector(shell: mock)
        let processes = collector.collectTopProcesses(sortBy: .cpu)

        #expect(processes.count == 5)
        #expect(processes[0].pid == 12345)
        #expect(processes[0].cpu == 25.3)
        #expect(processes[0].memory == 4.2)
        #expect(processes[0].name == "Safari")
        #expect(processes[1].name == "Xcode")
        #expect(processes[4].name == "rapportd")
    }
}
