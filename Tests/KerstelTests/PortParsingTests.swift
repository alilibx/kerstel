import Testing
@testable import KerstelCore

struct PortParsingTests {

    private func makePortManager() -> PortManager {
        return PortManager(shell: MockShellExecutor())
    }

    // MARK: - parsePorts

    @Test func parsePorts() {
        let pm = makePortManager()
        let ports = pm.parsePorts(Fixtures.lsofOutput)

        #expect(ports.count == 5)
        // Should be sorted by port
        #expect(ports[0].port == 443)
        #expect(ports[0].processName == "nginx")
        #expect(ports[1].port == 3000)
        #expect(ports[1].processName == "node")
        #expect(ports[2].port == 5432)
        #expect(ports[2].processName == "postgres")
    }

    @Test func parsePortsIPv6() {
        let pm = makePortManager()
        let ports = pm.parsePorts(Fixtures.lsofOutput)

        // [::1]:7679 should parse correctly
        let pythonPort = ports.first { $0.processName == "Python" }
        #expect(pythonPort != nil)
        #expect(pythonPort?.port == 7679)
    }

    @Test func parsePortsWildcard() {
        let pm = makePortManager()
        let input = """
        COMMAND     PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
        node      12345    ali   23u  IPv4 0x1234567890abcdef      0t0  TCP *:3000 (LISTEN)
        """
        let ports = pm.parsePorts(input)

        #expect(ports.count == 1)
        #expect(ports[0].port == 3000)
    }

    @Test func parsePortsLocalhost() {
        let pm = makePortManager()
        let input = """
        COMMAND     PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
        ruby      67890    ali   11u  IPv4 0xabcdef1234567890      0t0  TCP 127.0.0.1:8080 (LISTEN)
        """
        let ports = pm.parsePorts(input)

        #expect(ports.count == 1)
        #expect(ports[0].port == 8080)
    }

    @Test func parsePortsDeduplication() {
        let pm = makePortManager()
        let ports = pm.parsePorts(Fixtures.lsofDuplicates)

        // Same PID:port should only appear once
        #expect(ports.count == 1)
        #expect(ports[0].port == 3000)
        #expect(ports[0].pid == 12345)
    }

    @Test func parsePortsSorted() {
        let pm = makePortManager()
        let ports = pm.parsePorts(Fixtures.lsofOutput)

        // Verify sorted by port ascending
        for i in 0..<(ports.count - 1) {
            #expect(ports[i].port <= ports[i + 1].port)
        }
    }

    @Test func parsePortsEmpty() {
        let pm = makePortManager()
        let ports = pm.parsePorts("")

        #expect(ports.isEmpty)
    }
}
