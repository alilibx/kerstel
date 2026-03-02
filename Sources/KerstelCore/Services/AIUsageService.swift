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

        // Read credentials from macOS Keychain
        let keychainJSON = shell.run("security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null").trimmingCharacters(in: .whitespacesAndNewlines)

        if keychainJSON.isEmpty {
            return .notAuthenticated
        }

        // Parse credentials to get OAuth token and subscription type
        guard let credData = keychainJSON.data(using: .utf8),
              let creds = try? JSONSerialization.jsonObject(with: credData) as? [String: Any],
              let oauthInfo = creds["claudeAiOauth"] as? [String: Any],
              let accessToken = oauthInfo["accessToken"] as? String else {
            return .notAuthenticated
        }

        let subscriptionType = oauthInfo["subscriptionType"] as? String

        // Call usage API with required anthropic-beta header
        let curlCmd = "curl -s -H 'Authorization: Bearer \(accessToken)' -H 'anthropic-beta: oauth-2025-04-20' 'https://api.anthropic.com/api/oauth/usage' 2>/dev/null"
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

        // Parse usage windows from real API response
        let fiveHour = json["five_hour"] as? [String: Any]
        let sevenDay = json["seven_day"] as? [String: Any]

        let resetsAt = fiveHour?["resets_at"] as? String ?? ""

        let sessionPercent = fiveHour?["utilization"] as? Double ?? 0
        let weeklyPercent = sevenDay?["utilization"] as? Double ?? 0

        // Derive plan name from subscription type
        let planName: String
        switch subscriptionType {
        case "claude_pro_2025": planName = "Max"
        case "claude_pro": planName = "Pro"
        default: planName = subscriptionType?.replacingOccurrences(of: "claude_", with: "").capitalized ?? "Claude"
        }

        return .loaded(AIUsageData(
            provider: .claude,
            planName: planName,
            usagePercent: min(sessionPercent, 100),
            usageDescription: String(format: "Session: %.0f%% · Weekly: %.0f%%", sessionPercent, weeklyPercent),
            quotaUsed: String(format: "%.0f%%", sessionPercent),
            quotaTotal: "100%",
            resetDate: formatResetTime(resetsAt),
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

        // Try multiple known key patterns for auth token
        let token = storage["cursorAuth/accessToken"] as? String
            ?? storage["cursorAuth/cachedAccessToken"] as? String
            ?? storage["cursorAuth/refreshToken"] as? String
            ?? storage["accessToken"] as? String

        guard let sessionToken = token, !sessionToken.isEmpty else {
            return .notAuthenticated
        }

        // Call Cursor usage-summary API with both cookie and bearer auth
        let curlCmd = "curl -s -H 'Cookie: WorkosCursorSessionToken=\(sessionToken)' -H 'Authorization: Bearer \(sessionToken)' 'https://www.cursor.com/api/usage-summary' 2>/dev/null"
        let response = shell.run(curlCmd).trimmingCharacters(in: .whitespacesAndNewlines)

        if response.isEmpty {
            return .error("No response from API")
        }

        guard let data = response.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .error("Invalid response")
        }

        // Parse usage-summary response
        let planName = json["planName"] as? String ?? json["plan"] as? String ?? "Cursor"

        // usage-summary may report premium requests usage
        let premiumUsage = json["numRequestsTotal"] as? Double
            ?? json["premiumRequests"] as? Double
            ?? json["gpt-4"] as? Double ?? 0
        let premiumLimit = json["maxRequestUsage"] as? Double
            ?? json["premiumRequestsLimit"] as? Double
            ?? json["gpt-4-max"] as? Double ?? 500

        let usagePercent = premiumLimit > 0 ? (premiumUsage / premiumLimit) * 100 : 0

        let startOfMonth = json["startOfMonth"] as? String
            ?? json["resetDate"] as? String ?? ""

        return .loaded(AIUsageData(
            provider: .cursor,
            planName: planName,
            usagePercent: min(usagePercent, 100),
            usageDescription: String(format: "%.0f / %.0f premium requests", premiumUsage, premiumLimit),
            quotaUsed: String(format: "%.0f", premiumUsage),
            quotaTotal: String(format: "%.0f", premiumLimit),
            resetDate: startOfMonth.isEmpty ? "monthly" : formatResetTime(startOfMonth),
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

        // Read auth token from nested tokens structure
        let authPath = "\(NSHomeDirectory())/.codex/auth.json"
        let authJSON = shell.run("cat '\(authPath)' 2>/dev/null").trimmingCharacters(in: .whitespacesAndNewlines)

        if authJSON.isEmpty {
            return .notAuthenticated
        }

        guard let authData = authJSON.data(using: .utf8),
              let auth = try? JSONSerialization.jsonObject(with: authData) as? [String: Any] else {
            return .notAuthenticated
        }

        // Tokens are nested under "tokens" key
        let tokens = auth["tokens"] as? [String: Any]
        guard let accessToken = tokens?["access_token"] as? String
                ?? auth["access_token"] as? String
                ?? auth["token"] as? String else {
            return .notAuthenticated
        }
        let accountId = tokens?["account_id"] as? String ?? auth["account_id"] as? String ?? ""

        // Call ChatGPT usage API
        var curlCmd = "curl -s -H 'Authorization: Bearer \(accessToken)'"
        if !accountId.isEmpty {
            curlCmd += " -H 'ChatGPT-Account-Id: \(accountId)'"
        }
        curlCmd += " 'https://chatgpt.com/backend-api/wham/usage' 2>/dev/null"
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

        // Parse rate_limit windows from real API response
        let rateLimit = json["rate_limit"] as? [String: Any]
        let primaryWindow = rateLimit?["primary_window"] as? [String: Any]
        let secondaryWindow = rateLimit?["secondary_window"] as? [String: Any]

        let sessionPercent = primaryWindow?["used_percent"] as? Double ?? 0
        let weeklyPercent = secondaryWindow?["used_percent"] as? Double ?? 0
        let resetsAt = primaryWindow?["resets_at"] as? String ?? ""

        let planType = json["plan_type"] as? String ?? "Codex"
        let planName = planType.capitalized

        return .loaded(AIUsageData(
            provider: .codex,
            planName: planName,
            usagePercent: min(sessionPercent, 100),
            usageDescription: String(format: "Session: %.0f%% · Weekly: %.0f%%", sessionPercent, weeklyPercent),
            quotaUsed: String(format: "%.0f%%", sessionPercent),
            quotaTotal: "100%",
            resetDate: formatResetTime(resetsAt),
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
