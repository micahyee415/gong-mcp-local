#!/usr/bin/env node
/**
 * Smoke test — verifies 18 tools are registered (11 call + 5 user + 2 tracker).
 *
 * Uses a mock McpServer that captures tool registrations, so this runs
 * without live Gong credentials. A live end-to-end stdio test is covered
 * by manual end-to-end QA with a real admin API key.
 */

import { registerCallTools } from "../dist/tools/calls.js";
import { registerUserTools } from "../dist/tools/users.js";
import { registerTrackerTools } from "../dist/tools/trackers.js";

const EXPECTED_TOOLS = [
  // calls (11)
  "list_calls",
  "get_call",
  "get_call_transcript",
  "get_call_summary",
  "get_call_summaries",
  "search_calls",
  "search_calls_by_title",
  "search_calls_by_keyword",
  "search_calls_by_participant_email",
  "get_account_calls",
  "get_deal_timeline",
  // users (5)
  "list_users",
  "find_user",
  "whoami",
  "get_user_calls",
  "get_rep_scorecard",
  // trackers (2)
  "get_trackers",
  "list_workspaces",
];

function makeMockServer() {
  const tools = [];
  return {
    tools,
    tool(name, _desc, _schema, _handler) {
      tools.push(name);
    },
  };
}

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

const server = makeMockServer();
const fakeClient = {}; // registration doesn't call any client methods

registerCallTools(server, fakeClient);
registerUserTools(server, fakeClient, "user@example.com");
registerTrackerTools(server, fakeClient);

const got = server.tools.slice().sort();
const want = EXPECTED_TOOLS.slice().sort();

if (got.length !== want.length) {
  fail(`expected ${want.length} tools, got ${got.length}: ${JSON.stringify(got)}`);
}

const missing = want.filter((n) => !got.includes(n));
const extra = got.filter((n) => !want.includes(n));
if (missing.length || extra.length) {
  if (missing.length) console.error(`  missing: ${missing.join(", ")}`);
  if (extra.length) console.error(`  extra:   ${extra.join(", ")}`);
  fail("tool set mismatch");
}

console.log(`OK: ${got.length} tools registered`);
for (const name of got) console.log(`  - ${name}`);
