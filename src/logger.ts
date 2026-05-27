/**
 * Local file logger — writes JSONL to ~/Library/Logs/gong-mcp-admin/server.log.
 * No Cloud Logging, no stdout (stdio transport forbids stdout pollution).
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

const LOG_DIR = resolve(homedir(), "Library", "Logs", "gong-mcp-admin");
const LOG_FILE = resolve(LOG_DIR, "server.log");

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

type Level = "info" | "warn" | "error";

function write(level: Level, message: string, meta?: Record<string, unknown>): void {
  try {
    ensureLogDir();
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(meta && { meta }),
    };
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Never throw from the logger — a failed log write must not kill the server.
  }
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
  logFile: LOG_FILE,
};
