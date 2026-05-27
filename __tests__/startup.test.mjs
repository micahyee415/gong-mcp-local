#!/usr/bin/env node
/**
 * Live startup test — spawns the compiled server, exercises the real
 * Gong API health check + user resolution, then sends a `tools/list`
 * JSON-RPC request over stdio. Requires valid `.env` with Gong creds.
 *
 * NOT a unit test — intended for manual QA only. Not part of CI.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, "..", "dist", "index.js");

const child = spawn("node", [entry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let stderrBuf = "";
let stdoutBuf = "";
let sawReady = false;
let sentRequest = false;
let gotResponse = false;
const toolNames = [];

const timeout = setTimeout(() => {
  console.error("TIMEOUT: server did not respond within 30s");
  console.error("--- stderr ---\n" + stderrBuf);
  console.error("--- stdout ---\n" + stdoutBuf);
  child.kill("SIGKILL");
  process.exit(1);
}, 30_000);

child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  stderrBuf += text;
  process.stderr.write(text);
  if (!sawReady && text.includes("ready (stdio transport)")) {
    sawReady = true;
    // send tools/list
    const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n";
    child.stdin.write(req);
    sentRequest = true;
  }
});

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  // try to parse a JSON-RPC response per line
  const lines = stdoutBuf.split("\n");
  stdoutBuf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1 && msg.result?.tools) {
        gotResponse = true;
        for (const t of msg.result.tools) toolNames.push(t.name);
      }
    } catch {
      // not JSON — ignore
    }
  }
  if (gotResponse) {
    clearTimeout(timeout);
    console.log(`\nOK: startup succeeded, ${toolNames.length} tools listed:`);
    for (const n of toolNames.sort()) console.log(`  - ${n}`);
    child.kill("SIGTERM");
    process.exit(toolNames.length === 18 ? 0 : 2);
  }
});

child.on("exit", (code, signal) => {
  if (!gotResponse) {
    console.error(`\nFAIL: server exited early (code=${code}, signal=${signal})`);
    console.error(`  sawReady=${sawReady}, sentRequest=${sentRequest}`);
    process.exit(1);
  }
});
