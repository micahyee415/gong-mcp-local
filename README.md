# gong-mcp-admin

> A single-user, local (stdio) Model Context Protocol (MCP) server for the Gong API — an uncapped admin variant for one authorized operator on their own workstation.

![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![TypeScript](https://img.shields.io/badge/language-TypeScript-blue)
![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.x-blueviolet)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

---

## Overview

`gong-mcp-admin` is a local stdio MCP server that gives an AI assistant (Claude Desktop, Claude Code, or any MCP-compatible client) full read access to a Gong workspace. It is designed for **one authorized operator** running on their own machine — not for multi-user or network-facing deployment.

Compared to a typical hosted Gong MCP server, this variant removes the constraints that are appropriate for multi-user environments but unnecessary for a trusted single operator:

| Aspect | Typical hosted server | This admin server |
|---|---|---|
| Transport | HTTP + OAuth | stdio only (local process) |
| User authentication | SSO / OAuth flow | Trusts the local process; credentials in `.env` |
| Call filtering / blacklist | Configurable per-user filters | None — all calls visible |
| Default date windows | 7–90 days | Unbounded — no date default |
| Per-tool result caps | Tight (10–100) | Raised or removed |
| Result limits | Enforced | Configurable; operator-set hard caps |
| In-memory cache TTLs | 2–5 minutes | 15–30 minutes |
| Logging | Cloud logging service | Local JSONL file |
| Deployment | Cloud Run / hosted | `npm start` on your workstation |

This design makes the server appropriate only for a single trusted user who already has Gong admin-level API access and is running it locally. Do not expose the stdio process over a network.

---

## MCP Tools

18 tools total across three categories.

### Calls (11)

| Tool | Description |
|---|---|
| `list_calls` | List calls with optional date filtering. No default date window — returns all calls if no dates are passed. |
| `get_call` | Fetch metadata for a specific call by ID. |
| `get_call_summary` | Human-readable summary: participants, topics, tracked keywords, and key moments. |
| `get_call_transcript` | Full or compact transcript with speaker labels. Supports pagination via `offset`. Default page size 100 KB. |
| `get_call_summaries` | AI-generated summaries for calls in a date range. No default window; configurable `limit` (default 100, no cap). |
| `search_calls` | Search calls by date range and/or workspace ID. No default date window. |
| `search_calls_by_title` | Find calls whose title contains a search term (case-insensitive partial match). No default window; configurable `limit`. |
| `search_calls_by_keyword` | Full-text search across call transcripts. Searches up to 5,000 transcripts (default 200). Warns when API budget is significant. |
| `search_calls_by_participant_email` | Find calls where a specific participant (by email address) was present. No default window; configurable `limit`. |
| `get_account_calls` | All calls associated with a company name (case-insensitive partial match). No default window; configurable `limit`. |
| `get_deal_timeline` | Chronological timeline of all calls with a company, including topics, trackers, and participants. Hard cap: 1,000 calls. |

### Users (5)

| Tool | Description |
|---|---|
| `whoami` | Show the configured operator's Gong profile (name, email, title). |
| `find_user` | Look up any Gong user by email address. |
| `list_users` | List all workspace users (active only by default). |
| `get_user_calls` | Calls for a user by email. Auto-window covers up to 1 year; explicit date range paginates up to 10,000 calls. |
| `get_rep_scorecard` | Performance summary for a rep: call volume, hosted vs. attended, top topics, top tracked keywords, recent highlights. Hard cap: 500 calls. |

### Trackers & Workspaces (2)

| Tool | Description |
|---|---|
| `get_trackers` | List keyword trackers configured in the workspace (optionally filtered by workspace ID). |
| `list_workspaces` | List all Gong workspaces. |

---

## Architecture

```
MCP Client (Claude Desktop / Claude Code)
        │  stdin / stdout (MCP JSON-RPC frames)
        ▼
  gong-mcp-admin (Node.js process)
  ├── src/index.ts          — entry point, startup diagnostics, transport setup
  ├── src/gong-client.ts    — Gong REST API v2 wrapper, retry logic, in-memory TTL cache
  ├── src/tools/
  │   ├── calls.ts          — 11 call tools
  │   ├── users.ts          — 5 user tools
  │   └── trackers.ts       — 2 tracker/workspace tools
  ├── src/cache.ts          — generic TTL cache with insertion-order eviction
  ├── src/validation.ts     — input validation helpers
  └── src/logger.ts         — local JSONL file logger
        │
        ▼
  Gong REST API v2 (HTTPS, Basic auth)
```

**Key design points:**

- **stdio transport only.** All MCP protocol frames flow over stdin/stdout. `console.error` and the JSONL log file handle diagnostic output so stdout is never contaminated.
- **Single-user auth via env.** Credentials (`GONG_ACCESS_KEY`, `GONG_ACCESS_KEY_SECRET`, `GONG_USER_EMAIL`) are loaded from a local `.env` file at startup. No OAuth, no session management.
- **No call filtering.** Unlike a multi-user server that might suppress certain calls for certain users, this server returns all calls the API key has access to.
- **Unbounded queries.** No default date windows are applied. Tools that can return large result sets include explicit `limit` parameters, configurable hard caps, and warnings when result sets are large.
- **In-memory TTL cache.** Users are cached for 30 minutes, call metadata for 15 minutes, and transcripts for 30 minutes. Cache size is capped at 500 entries per type with insertion-order eviction.
- **Parallel fan-out with backpressure.** `search_calls_by_keyword` fetches transcripts in parallel batches. Batch size is controlled by `MAX_CONCURRENCY` (default 3, matching the Gong API rate limit of ~3 req/sec).
- **Startup diagnostics.** On launch the server authenticates against the Gong API and resolves `GONG_USER_EMAIL` to a real user. It exits with a clear error message if either check fails.
- **Retry with exponential backoff.** All API requests retry up to 3 times on transient errors (429, 5xx, network failures), respecting `Retry-After` headers.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ |
| Language | TypeScript 5.6 |
| MCP SDK | `@modelcontextprotocol/sdk` 1.x |
| Schema / validation | Zod 3 |
| Env loading | dotenv 17 |
| HTTP client | Native `fetch` (Node 20 built-in) |
| Build | `tsc` |
| Test | Node.js built-in test runner (smoke test) |

---

## Getting Started

### Prerequisites

- Node.js 20 or later
- A Gong API key pair with admin-level read access. Create a dedicated key for this server — do not reuse a key shared with any other integration.
- Your Gong user email address (used by `whoami` and `get_rep_scorecard`).
- Your Gong API base URL (find it in your Gong workspace settings under API; looks like `https://your-org.api.gong.io`).

### Install

```bash
git clone https://github.com/micahyee415/gong-mcp-local
cd gong-mcp-local
npm install
cp .env.example .env
# edit .env — fill in GONG_ACCESS_KEY, GONG_ACCESS_KEY_SECRET, GONG_BASE_URL, GONG_USER_EMAIL
npm run build
npm run smoke   # sanity check: should report "OK: 18 tools registered"
```

### Configuration

Edit `.env` (never commit this file — it is already in `.gitignore`):

```env
# Required
GONG_ACCESS_KEY=your_access_key_here
GONG_ACCESS_KEY_SECRET=your_access_key_secret_here
GONG_BASE_URL=https://your-org.api.gong.io
GONG_USER_EMAIL=you@example.com

# Optional — controls parallel transcript fetch batch size (default: 3)
# Keep at 3 to stay within Gong's ~3 req/sec rate ceiling
MAX_CONCURRENCY=3
```

| Variable | Required | Description |
|---|---|---|
| `GONG_ACCESS_KEY` | Yes | Gong API access key (Basic auth username) |
| `GONG_ACCESS_KEY_SECRET` | Yes | Gong API access key secret (Basic auth password) |
| `GONG_BASE_URL` | Yes | Your org's Gong API base URL (`https://your-org.api.gong.io`) |
| `GONG_USER_EMAIL` | Yes | The operator's Gong email — used by `whoami` and `get_rep_scorecard` |
| `MAX_CONCURRENCY` | No | Parallel transcript fetch batch size (default: 3) |

### Run via stdio

```bash
npm start
```

The server will run startup diagnostics (API credential check + user resolution) and then wait for MCP protocol input on stdin. All diagnostic output goes to stderr and the local log file — stdout is reserved for MCP frames.

### Add to an MCP client

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gong-admin": {
      "command": "node",
      "args": ["/absolute/path/to/gong-mcp-admin/dist/index.js"]
    }
  }
}
```

**Claude Code** — add under `mcpServers` in your project or global MCP config:

```json
{
  "mcpServers": {
    "gong-admin": {
      "command": "node",
      "args": ["/absolute/path/to/gong-mcp-admin/dist/index.js"]
    }
  }
}
```

Restart the client after adding the config. On first connection you should see startup diagnostics in the MCP logs confirming API authentication and user resolution.

---

## Logs

Structured JSONL logs are written to:

```
~/Library/Logs/gong-mcp-admin/server.log
```

Tail in real time:

```bash
tail -f ~/Library/Logs/gong-mcp-admin/server.log | jq .
```

---

## Security

- Keep `.env` out of git — it is already in `.gitignore`. Double-check before pushing.
- Store the Gong API key pair in a secrets manager (e.g. 1Password, macOS Keychain), not in shell history or plaintext files.
- This is a single-user tool. Do not expose the stdio process over a network socket.
- Rotate the API key immediately if you suspect it has been exposed, and revoke the previous key in Gong settings.

---

## License

MIT
