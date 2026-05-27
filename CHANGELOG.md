# Changelog

All notable changes to this project will be documented here.

## [1.0.0] — 2026-04-27

### Added

- Initial release: 18 MCP tools across three categories (calls, users, trackers/workspaces)
- stdio transport only — no HTTP server, no OAuth, designed for a single local operator
- No call filtering and no default date windows — unbounded queries allowed
- Raised per-tool result caps vs. a typical production MCP server (100–5,000 depending on tool, with configurable hard caps)
- In-memory TTL cache with longer TTLs (15–30 min) suited to wide-window admin queries
- Parallel transcript fan-out controlled by `MAX_CONCURRENCY` env var (default 3)
- Startup diagnostics: API credential check + `GONG_USER_EMAIL` resolution; exits with clear error on failure
- Retry with exponential backoff on transient errors (429, 5xx, network); respects `Retry-After` headers
- Local JSONL file logger at `~/Library/Logs/gong-mcp-admin/server.log`
- Smoke test verifying all 18 tools register correctly (no live credentials required)
- Input validation helpers with actionable error messages for all tool parameters
