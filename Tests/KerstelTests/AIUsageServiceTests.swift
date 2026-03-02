import Testing
@testable import KerstelCore

struct AIUsageServiceTests {

    // MARK: - Claude Tests

    @Test func claude_credentialsFound_apiSuccess() {
        let mock = MockShellExecutor(responses: [
            "which claude": "/usr/local/bin/claude",
            "cat": AIFixtures.claudeCredentials,
            "curl": AIFixtures.claudeUsageSuccess
        ])

        let service = AIUsageService(shell: mock)
        let state = AIUsageState()
        service.refreshAllSync(into: state)

        if case .loaded(let data) = state.statuses[.claude] {
            #expect(data.planName == "Pro")
            #expect(data.usagePercent == 42.0)
            #expect(data.quotaUsed == "42")
            #expect(data.quotaTotal == "100")
        } else {
            Issue.record("Expected .loaded status for Claude, got \(String(describing: state.statuses[.claude]))")
        }
    }

    @Test func claude_noCredentials_notAuthenticated() {
        let mock = MockShellExecutor(responses: [
            "which claude": "/usr/local/bin/claude"
            // No cat response → empty credentials
        ])

        let service = AIUsageService(shell: mock)
        let state = AIUsageState()
        service.refreshAllSync(into: state)

        if case .notAuthenticated = state.statuses[.claude] {
            // Expected
        } else {
            Issue.record("Expected .notAuthenticated for Claude, got \(String(describing: state.statuses[.claude]))")
        }
    }

    @Test func claude_cliNotInstalled_notInstalled() {
        let mock = MockShellExecutor(responses: [:])

        let service = AIUsageService(shell: mock)
        let state = AIUsageState()
        service.refreshAllSync(into: state)

        if case .notInstalled = state.statuses[.claude] {
            // Expected
        } else {
            Issue.record("Expected .notInstalled for Claude, got \(String(describing: state.statuses[.claude]))")
        }
    }

    @Test func claude_apiError_errorStatus() {
        let mock = MockShellExecutor(responses: [
            "which claude": "/usr/local/bin/claude",
            "cat": AIFixtures.claudeCredentials,
            "curl": AIFixtures.claudeUsageError
        ])

        let service = AIUsageService(shell: mock)
        let state = AIUsageState()
        service.refreshAllSync(into: state)

        if case .error(let message) = state.statuses[.claude] {
            #expect(message == "Invalid token")
        } else {
            Issue.record("Expected .error for Claude, got \(String(describing: state.statuses[.claude]))")
        }
    }

    // MARK: - Cursor Tests

    @Test func cursor_appNotFound_notInstalled() {
        let mock = MockShellExecutor(responses: [:])

        let service = AIUsageService(shell: mock)
        let state = AIUsageState()
        service.refreshAllSync(into: state)

        if case .notInstalled = state.statuses[.cursor] {
            // Expected
        } else {
            Issue.record("Expected .notInstalled for Cursor, got \(String(describing: state.statuses[.cursor]))")
        }
    }

    @Test func cursor_apiSuccess_parsedCorrectly() {
        let mock = MockShellExecutor(responses: [
            "ls /Applications/Cursor.app": "/Applications/Cursor.app",
            "cat": AIFixtures.cursorStorage,
            "curl": AIFixtures.cursorUsageSuccess
        ])

        let service = AIUsageService(shell: mock)
        let state = AIUsageState()
        service.refreshAllSync(into: state)

        if case .loaded(let data) = state.statuses[.cursor] {
            #expect(data.planName == "Pro")
            #expect(data.usagePercent == 50.0)
            #expect(data.quotaUsed == "250")
        } else {
            Issue.record("Expected .loaded for Cursor, got \(String(describing: state.statuses[.cursor]))")
        }
    }

    // MARK: - Codex Tests

    @Test func codex_authFound_apiSuccess() {
        let mock = MockShellExecutor(responses: [
            "which codex": "/usr/local/bin/codex",
            "cat": AIFixtures.codexAuth,
            "curl": AIFixtures.codexUsageSuccess
        ])

        let service = AIUsageService(shell: mock)
        let state = AIUsageState()
        service.refreshAllSync(into: state)

        if case .loaded(let data) = state.statuses[.codex] {
            #expect(data.planName == "Plus")
            #expect(data.usagePercent == 30.0)
            #expect(data.quotaUsed == "30")
            #expect(data.quotaTotal == "100")
        } else {
            Issue.record("Expected .loaded for Codex, got \(String(describing: state.statuses[.codex]))")
        }
    }

    @Test func codex_noAuth_notAuthenticated() {
        let mock = MockShellExecutor(responses: [
            "which codex": "/usr/local/bin/codex"
            // No cat response → empty auth file
        ])

        let service = AIUsageService(shell: mock)
        let state = AIUsageState()
        service.refreshAllSync(into: state)

        if case .notAuthenticated = state.statuses[.codex] {
            // Expected
        } else {
            Issue.record("Expected .notAuthenticated for Codex, got \(String(describing: state.statuses[.codex]))")
        }
    }
}
