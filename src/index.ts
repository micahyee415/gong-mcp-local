#!/usr/bin/env node

/**
 * gong-mcp-admin entry point — stdio transport only.
 *
 * This is the admin build of the Gong MCP server. It has:
 *   • No HTTP mode (local Claude Desktop / Claude Code only)
 *   • No OAuth, no user auth — trusts the local process
 *   • No rate limiters — single user, Gong API backpressure is enough
 *   • No blacklist — all calls visible including e-staff
 *   • No default date windows — unbounded queries allowed
 *
 * Single-user, local (stdio) admin variant of a Gong MCP server.
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Suppress dotenv v17 stdout banner — it would contaminate the MCP stdio transport
process.env.DOTENV_CONFIG_QUIET = "true";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectEnv = resolve(__dirname, "..", ".env");
config({ path: projectEnv });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GongClient } from "./gong-client.js";
import { registerCallTools } from "./tools/calls.js";
import { registerUserTools } from "./tools/users.js";
import { registerTrackerTools } from "./tools/trackers.js";
import { logger } from "./logger.js";

function getEnv(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (!val) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
  return val;
}

function startupTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Startup timed out after ${ms / 1000}s — check GONG_BASE_URL and your network connection.`)),
      ms
    )
  );
}

async function main() {
  const accessKey = getEnv("GONG_ACCESS_KEY");
  const accessKeySecret = getEnv("GONG_ACCESS_KEY_SECRET");
  const baseUrl = getEnv("GONG_BASE_URL", "https://your-org.api.gong.io");
  const userEmail = getEnv("GONG_USER_EMAIL");

  const client = new GongClient({ accessKey, accessKeySecret, baseUrl });

  console.error("gong-mcp-admin: running startup diagnostics...");

  let healthOk = false;
  try {
    const health = await Promise.race([client.healthCheck(), startupTimeout(15_000)]);
    for (const check of health.checks) {
      const icon = check.status === "pass" ? "✓" : "✗";
      console.error(`  ${icon} ${check.name}: ${check.detail}`);
    }
    healthOk = health.ok;
  } catch (err) {
    console.error(`  ✗ ${err instanceof Error ? err.message : err}`);
  }

  if (!healthOk) {
    console.error("\nStartup diagnostics FAILED. Fix the issues above and restart.");
    process.exit(1);
  }

  try {
    const user = await Promise.race([client.getUserByEmail(userEmail), startupTimeout(15_000)]);
    if (!user) throw new Error("User not found");
    console.error(`  ✓ User resolved: ${user.firstName} ${user.lastName} (${user.emailAddress})`);
  } catch (err) {
    console.error(`  ✗ User resolution: ${err instanceof Error ? err.message : err}`);
    if (err instanceof Error && !err.message.includes("timed out")) {
      console.error(
        `\n    GONG_USER_EMAIL="${userEmail}" was not found in your Gong workspace.` +
        `\n    Double-check the email address in your .env file.`
      );
    }
    process.exit(1);
  }

  console.error("  All checks passed.");
  console.error(`  Logs: ${logger.logFile}\n`);

  const server = new McpServer({ name: "gong-admin", version: "1.0.0" });
  registerCallTools(server, client);
  registerUserTools(server, client, userEmail);
  registerTrackerTools(server, client);

  logger.info("Server starting", { transport: "stdio", version: "1.0.0", user: userEmail });
  console.error("gong-mcp-admin ready (stdio transport). Waiting for MCP client.");

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  logger.error("Fatal error in main", { error: String(err) });
  process.exit(1);
});
