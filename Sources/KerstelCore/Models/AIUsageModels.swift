import Foundation

enum AIProvider: String, CaseIterable, Identifiable {
    case claude, cursor, codex

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .claude: return "sparkle"
        case .cursor: return "cursorarrow.rays"
        case .codex: return "terminal"
        }
    }

    var label: String {
        switch self {
        case .claude: return "Claude"
        case .cursor: return "Cursor"
        case .codex: return "Codex"
        }
    }

    var color: String {
        switch self {
        case .claude: return "orange"
        case .cursor: return "blue"
        case .codex: return "green"
        }
    }
}

enum AIProviderStatus {
    case notInstalled
    case notAuthenticated
    case loading
    case loaded(AIUsageData)
    case error(String)
}

struct AIUsageData {
    let provider: AIProvider
    let planName: String
    let usagePercent: Double
    let usageDescription: String
    let quotaUsed: String
    let quotaTotal: String
    let resetDate: String
    let lastUpdated: Date
}

@Observable
final class AIUsageState {
    var statuses: [AIProvider: AIProviderStatus] = [:]
    var isRefreshing: Bool = false
    var lastRefresh: Date? = nil

    init() {
        for provider in AIProvider.allCases {
            statuses[provider] = .notInstalled
        }
    }
}
