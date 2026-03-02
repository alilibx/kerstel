@testable import KerstelCore

// MARK: - Claude Fixtures

enum AIFixtures {

    // Claude credentials file
    static let claudeCredentials = """
    {
        "claudeAiOauth": {
            "accessToken": "test-token-12345",
            "refreshToken": "refresh-token-67890",
            "expiresAt": 9999999999
        }
    }
    """

    static let claudeCredentialsInvalid = """
    { "something": "else" }
    """

    // Claude API success response
    static let claudeUsageSuccess = """
    {
        "planName": "Pro",
        "dailyLimit": 100,
        "dailyUsage": 42,
        "resetTime": "2026-03-03T00:00:00Z"
    }
    """

    // Claude API error response
    static let claudeUsageError = """
    {
        "error": {
            "type": "authentication_error",
            "message": "Invalid token"
        }
    }
    """

    // MARK: - Cursor Fixtures

    // Cursor storage file
    static let cursorStorage = """
    {
        "cursorAuth/accessToken": "cursor-session-token-abc123"
    }
    """

    static let cursorStorageEmpty = """
    {
        "someOtherKey": "value"
    }
    """

    // Cursor API success response
    static let cursorUsageSuccess = """
    {
        "planName": "Pro",
        "numRequestsTotal": 250,
        "maxRequestUsage": 500,
        "startOfMonth": "Mar 1"
    }
    """

    // MARK: - Codex Fixtures

    // Codex auth file
    static let codexAuth = """
    {
        "access_token": "codex-token-xyz789"
    }
    """

    static let codexAuthInvalid = """
    { "no_token": true }
    """

    // Codex API success response
    static let codexUsageSuccess = """
    {
        "plan": "Plus",
        "usage": 30,
        "limit": 100
    }
    """

    // Codex API error response
    static let codexUsageError = """
    {
        "error": {
            "message": "Unauthorized"
        }
    }
    """
}
