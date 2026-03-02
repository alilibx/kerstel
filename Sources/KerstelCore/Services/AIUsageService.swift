import Foundation

final class AIUsageService {
    private let shell: ShellExecutor

    init(shell: ShellExecutor = RealShellExecutor()) {
        self.shell = shell
    }

    func refreshAll(into state: AIUsageState) {
        guard !state.isRefreshing else { return }
        state.isRefreshing = true

        // Set all to loading
        for provider in AIProvider.allCases {
            state.statuses[provider] = .loading
        }

        DispatchQueue.global().async { [weak self] in
            guard let self else { return }

            let group = DispatchGroup()
            var results: [AIProvider: AIProviderStatus] = [:]
            let lock = NSLock()

            for provider in AIProvider.allCases {
                group.enter()
                DispatchQueue.global().async {
                    let status: AIProviderStatus
                    switch provider {
                    case .claude: status = self.fetchClaude()
                    case .cursor: status = self.fetchCursor()
                    case .codex: status = self.fetchCodex()
                    }
                    lock.lock()
                    results[provider] = status
                    lock.unlock()
                    group.leave()
                }
            }

            group.wait()

            DispatchQueue.main.async {
                for (provider, status) in results {
                    state.statuses[provider] = status
                }
                state.isRefreshing = false
                state.lastRefresh = Date()
            }
        }
    }

    /// Synchronous refresh — used for testing
    func refreshAllSync(into state: AIUsageState) {
        for provider in AIProvider.allCases {
            let status: AIProviderStatus
            switch provider {
            case .claude: status = fetchClaude()
            case .cursor: status = fetchCursor()
            case .codex: status = fetchCodex()
            }
            state.statuses[provider] = status
        }
        state.isRefreshing = false
        state.lastRefresh = Date()
    }

    // MARK: - Claude

    func fetchClaude() -> AIProviderStatus {
        // Check if Claude CLI is installed
        let whichResult = shell.run("which claude 2>/dev/null").trimmingCharacters(in: .whitespacesAndNewlines)
        if whichResult.isEmpty {
            return .notInstalled
        }

        // Look for credentials
        let credentialsPath = "\(NSHomeDirectory())/.claude/.credentials.json"
        let credentialsJSON = shell.run("cat '\(credentialsPath)' 2>/dev/null").trimmingCharacters(in: .whitespacesAndNewlines)

        if credentialsJSON.isEmpty {
            return .notAuthenticated
        }

        // Parse credentials to get OAuth token
        guard let credData = credentialsJSON.data(using: .utf8),
              let creds = try? JSONSerialization.jsonObject(with: credData) as? [String: Any],
              let token = creds["claudeAiOauth"] as? [String: Any],
              let accessToken = token["accessToken"] as? String else {
            return .notAuthenticated
        }

        // Call usage API
        let curlCmd = "curl -s -H 'Authorization: Bearer \(accessToken)' 'https://api.anthropic.com/api/oauth/usage' 2>/dev/null"
        let response = shell.run(curlCmd).trimmingCharacters(in: .whitespacesAndNewlines)

        if response.isEmpty {
            return .error("No response from API")
        }

        guard let data = response.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .error("Invalid response")
        }

        // Check for error
        if let error = json["error"] as? [String: Any],
           let message = error["message"] as? String {
            return .error(message)
        }

        // Parse usage data
        let planName = json["planName"] as? String ?? "Claude"
        let dailyLimit = json["dailyLimit"] as? Double ?? 0
        let dailyUsage = json["dailyUsage"] as? Double ?? 0
        let resetTime = json["resetTime"] as? String ?? ""

        let usagePercent = dailyLimit > 0 ? (dailyUsage / dailyLimit) * 100 : 0

        return .loaded(AIUsageData(
            provider: .claude,
            planName: planName,
            usagePercent: min(usagePercent, 100),
            usageDescription: String(format: "%.0f / %.0f requests", dailyUsage, dailyLimit),
            quotaUsed: String(format: "%.0f", dailyUsage),
            quotaTotal: String(format: "%.0f", dailyLimit),
            resetDate: formatResetTime(resetTime),
            lastUpdated: Date()
        ))
    }

    // MARK: - Cursor

    func fetchCursor() -> AIProviderStatus {
        // Check if Cursor is installed
        let appExists = shell.run("ls /Applications/Cursor.app 2>/dev/null").trimmingCharacters(in: .whitespacesAndNewlines)
        if appExists.isEmpty {
            return .notInstalled
        }

        // Read session token from Cursor storage
        let storagePath = "\(NSHomeDirectory())/Library/Application Support/Cursor/User/globalStorage/storage.json"
        let storageJSON = shell.run("cat '\(storagePath)' 2>/dev/null").trimmingCharacters(in: .whitespacesAndNewlines)

        if storageJSON.isEmpty {
            return .notAuthenticated
        }

        guard let storageData = storageJSON.data(using: .utf8),
              let storage = try? JSONSerialization.jsonObject(with: storageData) as? [String: Any] else {
            return .notAuthenticated
        }

        // Try different known key patterns for auth token
        let token = storage["cursorAuth/accessToken"] as? String
            ?? storage["cursorAuth/cachedAccessToken"] as? String

        guard let sessionToken = token, !sessionToken.isEmpty else {
            return .notAuthenticated
        }

        // Call Cursor usage API
        let curlCmd = "curl -s -H 'Cookie: WorkosCursorSessionToken=\(sessionToken)' 'https://www.cursor.com/api/usage' 2>/dev/null"
        let response = shell.run(curlCmd).trimmingCharacters(in: .whitespacesAndNewlines)

        if response.isEmpty {
            return .error("No response from API")
        }

        guard let data = response.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .error("Invalid response")
        }

        // Parse Cursor usage (format varies by plan)
        let planName = json["planName"] as? String ?? json["plan"] as? String ?? "Cursor"

        // Cursor reports usage in different formats
        let premiumUsage = json["numRequestsTotal"] as? Double
            ?? json["gpt-4"] as? Double ?? 0
        let premiumLimit = json["maxRequestUsage"] as? Double
            ?? json["gpt-4-max"] as? Double ?? 500

        let usagePercent = premiumLimit > 0 ? (premiumUsage / premiumLimit) * 100 : 0

        let startOfMonth = json["startOfMonth"] as? String ?? ""

        return .loaded(AIUsageData(
            provider: .cursor,
            planName: planName,
            usagePercent: min(usagePercent, 100),
            usageDescription: String(format: "%.0f / %.0f requests", premiumUsage, premiumLimit),
            quotaUsed: String(format: "%.0f", premiumUsage),
            quotaTotal: String(format: "%.0f", premiumLimit),
            resetDate: startOfMonth.isEmpty ? "monthly" : "resets \(startOfMonth)",
            lastUpdated: Date()
        ))
    }

    // MARK: - Codex

    func fetchCodex() -> AIProviderStatus {
        // Check if Codex CLI is installed
        let whichResult = shell.run("which codex 2>/dev/null").trimmingCharacters(in: .whitespacesAndNewlines)
        if whichResult.isEmpty {
            return .notInstalled
        }

        // Read auth token
        let authPath = "\(NSHomeDirectory())/.codex/auth.json"
        let authJSON = shell.run("cat '\(authPath)' 2>/dev/null").trimmingCharacters(in: .whitespacesAndNewlines)

        if authJSON.isEmpty {
            return .notAuthenticated
        }

        guard let authData = authJSON.data(using: .utf8),
              let auth = try? JSONSerialization.jsonObject(with: authData) as? [String: Any],
              let accessToken = auth["access_token"] as? String ?? auth["token"] as? String else {
            return .notAuthenticated
        }

        // Call OpenAI usage API
        let curlCmd = "curl -s -H 'Authorization: Bearer \(accessToken)' 'https://api.openai.com/v1/usage' 2>/dev/null"
        let response = shell.run(curlCmd).trimmingCharacters(in: .whitespacesAndNewlines)

        if response.isEmpty {
            return .error("No response from API")
        }

        guard let data = response.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .error("Invalid response")
        }

        if let error = json["error"] as? [String: Any],
           let message = error["message"] as? String {
            return .error(message)
        }

        let planName = json["plan"] as? String ?? "Codex"
        let used = json["usage"] as? Double ?? json["requests"] as? Double ?? 0
        let limit = json["limit"] as? Double ?? json["max_requests"] as? Double ?? 0

        let usagePercent = limit > 0 ? (used / limit) * 100 : 0

        return .loaded(AIUsageData(
            provider: .codex,
            planName: planName,
            usagePercent: min(usagePercent, 100),
            usageDescription: limit > 0
                ? String(format: "%.0f / %.0f requests", used, limit)
                : String(format: "%.0f requests", used),
            quotaUsed: String(format: "%.0f", used),
            quotaTotal: limit > 0 ? String(format: "%.0f", limit) : "unlimited",
            resetDate: "monthly",
            lastUpdated: Date()
        ))
    }

    // MARK: - Helpers

    private func formatResetTime(_ isoString: String) -> String {
        if isoString.isEmpty { return "" }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        if let date = formatter.date(from: isoString) {
            let displayFormatter = DateFormatter()
            displayFormatter.dateFormat = "MMM d, h:mm a"
            return "resets \(displayFormatter.string(from: date))"
        }

        // Try without fractional seconds
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: isoString) {
            let displayFormatter = DateFormatter()
            displayFormatter.dateFormat = "MMM d, h:mm a"
            return "resets \(displayFormatter.string(from: date))"
        }

        return "resets \(isoString)"
    }
}
