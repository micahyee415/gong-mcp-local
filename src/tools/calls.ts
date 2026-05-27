import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GongClient, GongCallBasic, GongCallDetailed } from "../gong-client.js";
import {
  ValidationError,
  validateDateParam,
  validateCallId,
  validateNonNegativeInt,
  validatePositiveInt,
} from "../validation.js";

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function formatCallForDisplay(c: GongCallBasic) {
  return {
    id: c.id,
    title: c.title ?? "Untitled",
    date: c.started ?? "Unknown",
    duration: c.duration ? `${Math.round(c.duration / 60)}min` : "Unknown",
    url: c.url,
  };
}

function formatCallDetail(call: GongCallDetailed) {
  return {
    id: call.id,
    title: call.title ?? "Untitled",
    date: call.started ?? "Unknown",
    duration: call.duration ? `${Math.round(call.duration / 60)}min` : "Unknown",
    url: call.url,
    direction: call.direction,
    scope: call.scope,
    participants: call.parties?.map((p) => ({
      name: p.name,
      email: p.emailAddress,
      affiliation: p.affiliation,
    })),
    content: call.content,
    context: call.context,
  };
}

function formatCallSummary(call: GongCallDetailed): string {
  const lines: string[] = [];
  lines.push(`## ${call.title ?? "Untitled Call"}`);
  const durationStr = call.duration ? `${Math.round(call.duration / 60)} min` : "Unknown duration";
  lines.push(`Date: ${call.started ?? "Unknown"} | Duration: ${durationStr}`);
  if (call.url) lines.push(`Recording: ${call.url}`);
  lines.push("");

  const parties = call.parties ?? [];
  if (parties.length > 0) {
    lines.push("### Participants");
    for (const p of parties) {
      const who = p.name ?? p.emailAddress ?? "Unknown";
      const side = p.affiliation === "Internal" ? "(internal)" : p.affiliation === "External" ? "(external)" : "";
      lines.push(`• ${who}${side ? " " + side : ""}`);
    }
    lines.push("");
  }

  const contentBlock = (call.content as any[])?.[0] as Record<string, any> | undefined;
  if (contentBlock) {
    const topics = contentBlock.topics as { name?: string; duration?: number }[] | undefined;
    if (topics && topics.length > 0) {
      lines.push("### Topics");
      for (const t of topics) {
        const dur = t.duration ? ` (${Math.round(t.duration / 60)}min)` : "";
        lines.push(`• ${t.name ?? "Unknown topic"}${dur}`);
      }
      lines.push("");
    }
    const trackers = contentBlock.trackers as { name?: string; count?: number }[] | undefined;
    if (trackers && trackers.length > 0) {
      lines.push("### Tracked Keywords");
      for (const tr of trackers) {
        const count = tr.count != null ? ` — ${tr.count} mention${tr.count !== 1 ? "s" : ""}` : "";
        lines.push(`• ${tr.name ?? "Unknown tracker"}${count}`);
      }
      lines.push("");
    }
    const poi = contentBlock.pointsOfInterest as { category?: string; text?: string; description?: string }[] | undefined;
    if (poi && poi.length > 0) {
      lines.push("### Key Moments");
      for (const p of poi) {
        const label = p.category ?? "Note";
        const text = p.text ?? p.description ?? "";
        lines.push(`• [${label}]${text ? " " + text : ""}`);
      }
      lines.push("");
    }
    if (contentBlock.brief) {
      lines.push("### Overview");
      lines.push(String(contentBlock.brief));
      lines.push("");
    }
  }

  if (!contentBlock || Object.keys(contentBlock).length === 0) {
    lines.push("_(No AI-analyzed content available — the call may still be processing.)_");
  }

  return lines.join("\n");
}

function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export function registerCallTools(server: McpServer, client: GongClient) {
  // ── list_calls ──
  server.tool(
    "list_calls",
    "List calls in the workspace, with optional date filtering. No default date window — returns ALL calls if no dates passed (may be very large).",
    {
      fromDateTime: z.string().optional().describe('Start date filter (ISO 8601). If omitted, returns ALL calls.'),
      toDateTime: z.string().optional().describe("End date filter (ISO 8601)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response"),
    },
    async (params: { fromDateTime?: string; toDateTime?: string; cursor?: string }) => {
      try {
        validateDateParam(params.fromDateTime, "fromDateTime");
        validateDateParam(params.toDateTime, "toDateTime");
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }

      const result = await client.searchCalls({
        fromDateTime: params.fromDateTime,
        toDateTime: params.toDateTime,
        cursor: params.cursor,
      });

      const sorted = [...result.calls].sort((a, b) =>
        new Date(b.started ?? 0).getTime() - new Date(a.started ?? 0).getTime()
      );
      const formatted = sorted.map((c) => formatCallForDisplay(c));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ calls: formatted, cursor: result.cursor }, null, 2),
        }],
      };
    }
  );

  // ── search_calls ──
  server.tool(
    "search_calls",
    "Search calls with filters. No default date window — returns ALL calls if no dates passed.",
    {
      fromDateTime: z.string().optional().describe('Start date filter (ISO 8601). If omitted, searches ALL calls.'),
      toDateTime: z.string().optional().describe("End date filter (ISO 8601)"),
      workspaceId: z.string().optional().describe("Filter by workspace ID"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async (params: { fromDateTime?: string; toDateTime?: string; workspaceId?: string; cursor?: string }) => {
      try {
        validateDateParam(params.fromDateTime, "fromDateTime");
        validateDateParam(params.toDateTime, "toDateTime");
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }

      const result = await client.searchCalls({
        fromDateTime: params.fromDateTime,
        toDateTime: params.toDateTime,
        workspaceId: params.workspaceId,
        cursor: params.cursor,
      });

      const sorted = [...result.calls].sort((a, b) =>
        new Date(b.started ?? 0).getTime() - new Date(a.started ?? 0).getTime()
      );
      const formatted = sorted.map((c) => formatCallForDisplay(c));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ calls: formatted, cursor: result.cursor }, null, 2),
        }],
      };
    }
  );

  // ── get_call_summaries ──
  server.tool(
    "get_call_summaries",
    'Admin: Get AI-generated summaries for calls in a date range. No default date window, default limit 100, no max cap.',
    {
      fromDateTime: z.string().optional().describe('Start date (ISO 8601). If omitted, searches ALL calls.'),
      toDateTime:   z.string().optional().describe("End date (ISO 8601). Defaults to now."),
      workspaceId:  z.string().optional().describe("Filter by workspace ID."),
      direction:    z.string().optional().describe('Filter by call direction: "inbound", "outbound", or "conference".'),
      limit:        z.number().optional().describe("Max calls to return (default 100, no max cap)."),
    },
    async (params: { fromDateTime?: string; toDateTime?: string; workspaceId?: string; direction?: string; limit?: number }) => {
      try {
        validateDateParam(params.fromDateTime, "fromDateTime");
        validateDateParam(params.toDateTime, "toDateTime");
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }

      let limit: number;
      try {
        limit = validatePositiveInt(params.limit, "limit", 100);
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }

      const direction = params.direction?.toLowerCase();
      if (direction && !["inbound", "outbound", "conference"].includes(direction)) {
        return toolError('Invalid direction. Use "inbound", "outbound", or "conference".');
      }

      const collected: GongCallDetailed[] = [];
      let cursor: string | undefined;

      do {
        const page = await client.searchCallsDetailed({
          fromDateTime: params.fromDateTime,
          toDateTime: params.toDateTime,
          workspaceId: params.workspaceId,
          cursor,
        });

        const directionFiltered = direction
          ? page.calls.filter((c) => c.direction?.toLowerCase() === direction)
          : page.calls;

        collected.push(...directionFiltered);
        cursor = page.cursor;
      } while (cursor && collected.length < limit);

      const trimmed = collected
        .sort((a, b) => new Date(b.started ?? 0).getTime() - new Date(a.started ?? 0).getTime())
        .slice(0, limit);

      const summaries = trimmed.map((call) => {
        const contentBlock = (call.content as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown> | undefined;
        const externalParticipants = (call.parties ?? [])
          .filter((p) => p.affiliation !== "Internal")
          .map((p) => ({
            name: p.name ?? p.emailAddress ?? "Unknown",
            email: p.emailAddress ?? null,
            speakerId: p.speakerId ?? null,
          }));

        return {
          id: call.id,
          title: call.title ?? "Untitled",
          date: call.started ? call.started.split("T")[0] : "Unknown",
          duration: call.duration ? `${Math.round(call.duration / 60)}min` : "Unknown",
          direction: call.direction ?? "Unknown",
          url: call.url,
          externalParticipants,
          topics: ((contentBlock?.topics as { name?: string }[] | undefined) ?? [])
            .map((t) => t.name).filter(Boolean),
          trackers: ((contentBlock?.trackers as { name?: string; count?: number }[] | undefined) ?? [])
            .filter((t) => t.name).map((t) => ({ name: t.name, mentions: t.count ?? 0 })),
          brief: (contentBlock?.brief as string | undefined) ?? null,
        };
      });

      const hasMore = collected.length >= limit && !!cursor;
      const warning = summaries.length > 1000 ? `⚠ Large result set (${summaries.length} calls). Consider narrowing the date range.` : undefined;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            totalCallsAnalyzed: summaries.length,
            dateRange: { from: params.fromDateTime ?? "all-time", to: params.toDateTime ?? "now" },
            ...(direction && { directionFilter: direction }),
            ...(warning && { warning }),
            hasMore,
            calls: summaries,
          }, null, 2),
        }],
      };
    }
  );

  // ── get_call ──
  server.tool(
    "get_call",
    "Get metadata for a specific call.",
    { callId: z.string().describe("Gong call ID") },
    async (params: { callId: string }) => {
      let callId: string;
      try {
        callId = validateCallId(params.callId);
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }
      const call = await client.getCall(callId);
      if (!call) return toolError(`Call ${callId} not found.`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(formatCallDetail(call), null, 2) }],
      };
    }
  );

  // ── get_call_summary ──
  server.tool(
    "get_call_summary",
    "Get a human-readable summary of a call: participants, topics, tracked keywords, and key moments.",
    { callId: z.string().describe("Gong call ID") },
    async (params: { callId: string }) => {
      let callId: string;
      try {
        callId = validateCallId(params.callId);
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }
      const call = await client.getCall(callId);
      if (!call) return toolError(`Call ${callId} not found.`);
      return {
        content: [{ type: "text" as const, text: formatCallSummary(call) }],
      };
    }
  );

  // ── get_call_transcript ──
  server.tool(
    "get_call_transcript",
    'Admin: Get the transcript of a call. Default page size 100KB (was 10KB in production).',
    {
      callId: z.string().describe("Gong call ID"),
      mode: z.string().optional().describe('"compact" = condensed turns (~2KB). "full" = complete transcript (default).'),
      maxLength: z.number().optional().describe("Max chars per page in full mode (default 100000)."),
      offset: z.number().optional().describe("Character offset to start from in full mode (default 0)"),
    },
    async (params: { callId: string; mode?: string; maxLength?: number; offset?: number }) => {
      let callId: string;
      let maxLen: number;
      let offset: number;
      try {
        callId = validateCallId(params.callId);
        maxLen = validatePositiveInt(params.maxLength, "maxLength", 100_000);
        offset = validateNonNegativeInt(params.offset, "offset", 0);
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }

      const mode = (params.mode ?? "full").toLowerCase();
      if (mode !== "compact" && mode !== "full") {
        return toolError('Invalid mode. Use "compact" or "full".');
      }

      const [result, callMeta] = await Promise.all([
        client.getCallTranscript(callId),
        client.getCall(callId),
      ]);

      if (!result) {
        return { content: [{ type: "text" as const, text: "No transcript available for this call." }] };
      }

      const speakerMap = new Map<string, string>();
      for (const p of callMeta?.parties ?? []) {
        if (p.speakerId != null) {
          const label = p.name ?? p.emailAddress ?? (p.affiliation === "Internal" ? "Internal" : "External");
          speakerMap.set(String(p.speakerId), label);
        }
      }

      const speakerLegendLines: string[] = [];
      if (speakerMap.size > 0) {
        speakerLegendLines.push("--- Speaker Map ---");
        for (const [id, name] of speakerMap.entries()) {
          speakerLegendLines.push(`Speaker ${id}: ${name}`);
        }
        speakerLegendLines.push("-------------------");
        speakerLegendLines.push("");
      }
      const speakerLegend = speakerLegendLines.join("\n");

      function resolveSpeaker(speakerId: string): string {
        return speakerMap.has(speakerId) ? speakerMap.get(speakerId)! : `Speaker ${speakerId}`;
      }

      if (mode === "compact") {
        const TURN_MAX_CHARS = 200;
        const compactLines: string[] = [];
        for (const segment of result.transcript) {
          const fullSegment = segment.sentences.map((s) => s.text).join(" ");
          const timestamp = segment.sentences[0] ? formatTimestamp(segment.sentences[0].start) : "";
          const display = fullSegment.length > TURN_MAX_CHARS ? fullSegment.slice(0, TURN_MAX_CHARS) + "..." : fullSegment;
          compactLines.push(`[${timestamp}] ${resolveSpeaker(segment.speakerId)}: ${display}`);
        }
        const compactText = compactLines.join("\n");
        const fullLength = result.transcript.reduce(
          (sum, seg) => sum + seg.sentences.reduce((s, sent) => s + sent.text.length, 0), 0
        );
        return {
          content: [{
            type: "text" as const,
            text: `${speakerLegend}--- Compact transcript (${compactLines.length} speaker turns, ${fullLength} chars full) ---\n\n${compactText}\n\n--- Use mode="full" for the complete transcript ---`,
          }],
        };
      }

      const lines: string[] = [];
      for (const segment of result.transcript) {
        for (const sentence of segment.sentences) {
          lines.push(`[${resolveSpeaker(segment.speakerId)}] ${sentence.text}`);
        }
      }
      const fullText = lines.join("\n");
      const totalLength = fullText.length;
      const truncated = totalLength > offset + maxLen;
      const page = fullText.slice(offset, offset + maxLen);
      const legendPrefix = offset === 0 ? speakerLegend : "";

      return {
        content: [{
          type: "text" as const,
          text: truncated
            ? `${legendPrefix}${page}\n\n--- Page ${Math.floor(offset / maxLen) + 1} | Showing ${offset}–${offset + maxLen} of ${totalLength} chars | Use offset=${offset + maxLen} to continue ---`
            : `${legendPrefix}${page}\n\n--- Complete transcript | ${totalLength} chars total ---`,
        }],
      };
    }
  );

  // ── get_account_calls ──
  server.tool(
    "get_account_calls",
    "Admin: Get all calls associated with a company. No default date window, default 100, no max cap.",
    {
      accountName: z.string().describe('Company or account name (case-insensitive partial match).'),
      fromDateTime: z.string().optional().describe('Start date (ISO 8601). If omitted, searches ALL calls.'),
      toDateTime: z.string().optional().describe("End date (ISO 8601). Defaults to now."),
      limit: z.number().optional().describe("Max calls to return (default 100, no max cap)."),
    },
    async (params: { accountName: string; fromDateTime?: string; toDateTime?: string; limit?: number }) => {
      try {
        validateDateParam(params.fromDateTime, "fromDateTime");
        validateDateParam(params.toDateTime, "toDateTime");
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }
      if (!params.accountName.trim()) return toolError("accountName cannot be empty.");

      let limit: number;
      try {
        limit = validatePositiveInt(params.limit, "limit", 100);
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }

      const query = params.accountName.toLowerCase().trim();
      const collected: GongCallDetailed[] = [];
      let cursor: string | undefined;

      do {
        const page = await client.searchCallsDetailed({
          fromDateTime: params.fromDateTime,
          toDateTime: params.toDateTime,
          cursor,
        });
        const matched = page.calls.filter((call) => {
          if ((call.title ?? "").toLowerCase().includes(query)) return true;
          if (call.context) return JSON.stringify(call.context).toLowerCase().includes(query);
          return false;
        });
        collected.push(...matched);
        cursor = page.cursor;
      } while (cursor && collected.length < limit);

      const trimmed = collected
        .sort((a, b) => new Date(b.started ?? 0).getTime() - new Date(a.started ?? 0).getTime())
        .slice(0, limit);

      if (trimmed.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              message: `No calls found matching account name "${params.accountName}" in the date range.`,
              hint: "Try a shorter partial name or expand the date range.",
              dateRange: { from: params.fromDateTime ?? "all-time", to: params.toDateTime ?? "now" },
            }, null, 2),
          }],
        };
      }

      const summaries = trimmed.map((call) => {
        const contentBlock = (call.content as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown> | undefined;
        const externalParticipants = (call.parties ?? [])
          .filter((p) => p.affiliation !== "Internal")
          .map((p) => ({
            name: p.name ?? p.emailAddress ?? "Unknown",
            email: p.emailAddress ?? null,
            speakerId: p.speakerId ?? null,
          }));
        return {
          id: call.id,
          title: call.title ?? "Untitled",
          date: call.started ? call.started.split("T")[0] : "Unknown",
          duration: call.duration ? `${Math.round(call.duration / 60)}min` : "Unknown",
          direction: call.direction ?? "Unknown",
          url: call.url,
          externalParticipants,
          topics: ((contentBlock?.topics as { name?: string }[] | undefined) ?? []).map((t) => t.name).filter(Boolean),
          trackers: ((contentBlock?.trackers as { name?: string; count?: number }[] | undefined) ?? [])
            .filter((t) => t.name).map((t) => ({ name: t.name, mentions: t.count ?? 0 })),
          brief: (contentBlock?.brief as string | undefined) ?? null,
        };
      });

      const warning = summaries.length > 1000 ? `⚠ Large result set (${summaries.length} calls). Consider narrowing the date range.` : undefined;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            accountName: params.accountName,
            totalCallsFound: summaries.length,
            dateRange: { from: params.fromDateTime ?? "all-time", to: params.toDateTime ?? "now" },
            ...(warning && { warning }),
            calls: summaries,
          }, null, 2),
        }],
      };
    }
  );

  // ── search_calls_by_participant_email ──
  server.tool(
    "search_calls_by_participant_email",
    "Admin: Find calls where a specific external participant (by email) was present. No default date window, default 100, no max cap.",
    {
      participantEmail: z.string().describe("Email address of the participant to search for"),
      fromDateTime: z.string().optional().describe('Start date (ISO 8601). If omitted, searches ALL calls.'),
      toDateTime: z.string().optional().describe("End date (ISO 8601). Defaults to now."),
      limit: z.number().optional().describe("Max results to return (default 100, no max cap)."),
    },
    async (params: { participantEmail: string; fromDateTime?: string; toDateTime?: string; limit?: number }) => {
      try {
        validateDateParam(params.fromDateTime, "fromDateTime");
        validateDateParam(params.toDateTime, "toDateTime");
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }
      if (!params.participantEmail.trim()) return toolError("participantEmail cannot be empty.");

      let limit: number;
      try {
        limit = validatePositiveInt(params.limit, "limit", 100);
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }

      const emailQuery = params.participantEmail.toLowerCase().trim();
      const matched: { id: string; title: string; started: string; duration: string; url?: string; matchingParticipant: string }[] = [];
      let cursor: string | undefined;

      do {
        const page = await client.searchCalls({
          fromDateTime: params.fromDateTime,
          toDateTime: params.toDateTime,
          cursor,
        });
        for (const call of page.calls) {
          if (!call.parties) continue;
          const matchingParty = call.parties.find((p) => p.emailAddress?.toLowerCase() === emailQuery);
          if (matchingParty) {
            matched.push({
              id: call.id,
              title: call.title ?? "Untitled",
              started: call.started ?? "Unknown",
              duration: call.duration ? `${Math.round(call.duration / 60)}min` : "Unknown",
              url: call.url,
              matchingParticipant: matchingParty.name ?? matchingParty.emailAddress ?? emailQuery,
            });
          }
        }
        cursor = page.cursor;
      } while (cursor && matched.length < limit);

      const trimmed = matched
        .sort((a, b) => new Date(b.started).getTime() - new Date(a.started).getTime())
        .slice(0, limit);

      if (trimmed.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              message: `No calls found with participant "${params.participantEmail}".`,
              hint: "Check the email address or expand the date range.",
              dateRange: { from: params.fromDateTime ?? "all-time", to: params.toDateTime ?? "now" },
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            participantEmail: params.participantEmail,
            totalCallsFound: trimmed.length,
            dateRange: { from: params.fromDateTime ?? "all-time", to: params.toDateTime ?? "now" },
            calls: trimmed,
          }, null, 2),
        }],
      };
    }
  );

  // ── get_deal_timeline ──
  server.tool(
    "get_deal_timeline",
    "Admin: Chronological timeline of all calls with a company. No default date window, hard cap 1,000 (was 100 in prod).",
    {
      accountName: z.string().describe('Company or account name (case-insensitive partial match).'),
      fromDateTime: z.string().optional().describe('Start date (ISO 8601). If omitted, searches ALL calls.'),
      toDateTime: z.string().optional().describe("End date (ISO 8601). Defaults to now."),
    },
    async (params: { accountName: string; fromDateTime?: string; toDateTime?: string }) => {
      try {
        validateDateParam(params.fromDateTime, "fromDateTime");
        validateDateParam(params.toDateTime, "toDateTime");
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }
      if (!params.accountName.trim()) return toolError("accountName cannot be empty.");

      const HARD_CAP = 1000;
      const query = params.accountName.toLowerCase().trim();
      const collected: GongCallDetailed[] = [];
      let cursor: string | undefined;

      do {
        const page = await client.searchCallsDetailed({
          fromDateTime: params.fromDateTime,
          toDateTime: params.toDateTime,
          cursor,
        });
        const matched = page.calls.filter((call) => {
          if ((call.title ?? "").toLowerCase().includes(query)) return true;
          if (call.context) return JSON.stringify(call.context).toLowerCase().includes(query);
          return false;
        });
        collected.push(...matched);
        cursor = page.cursor;
      } while (cursor && collected.length < HARD_CAP);

      if (collected.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              message: `No calls found matching account name "${params.accountName}" in the date range.`,
              hint: "Try a shorter partial name or expand the date range.",
              dateRange: { from: params.fromDateTime ?? "all-time", to: params.toDateTime ?? "now" },
            }, null, 2),
          }],
        };
      }

      collected.sort((a, b) => new Date(a.started ?? 0).getTime() - new Date(b.started ?? 0).getTime());

      const uniqueExternalEmails = new Set<string>();
      for (const call of collected) {
        for (const p of call.parties ?? []) {
          if (p.affiliation !== "Internal" && p.emailAddress) {
            uniqueExternalEmails.add(p.emailAddress.toLowerCase());
          }
        }
      }

      const timeline = collected.map((call) => {
        const contentBlock = (call.content as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown> | undefined;
        const internalParticipants = (call.parties ?? [])
          .filter((p) => p.affiliation === "Internal")
          .map((p) => p.name ?? p.emailAddress ?? "Unknown");
        const externalParticipants = (call.parties ?? [])
          .filter((p) => p.affiliation !== "Internal")
          .map((p) => p.name ?? p.emailAddress ?? "Unknown");
        const topTopics = ((contentBlock?.topics as { name?: string; duration?: number }[] | undefined) ?? [])
          .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
          .slice(0, 3).map((t) => t.name).filter(Boolean);
        const trackers = ((contentBlock?.trackers as { name?: string; count?: number }[] | undefined) ?? [])
          .filter((t) => t.name && t.count).map((t) => ({ name: t.name!, mentions: t.count! }));
        return {
          date: call.started ? call.started.split("T")[0] : "Unknown",
          title: call.title ?? "Untitled",
          duration: call.duration ? `${Math.round(call.duration / 60)}min` : "Unknown",
          url: call.url,
          participants: { internal: internalParticipants, external: externalParticipants },
          topTopics,
          trackers,
        };
      });

      const firstDate = collected[0]?.started?.split("T")[0] ?? "Unknown";
      const lastDate = collected[collected.length - 1]?.started?.split("T")[0] ?? "now";
      const warning = collected.length >= HARD_CAP ? `⚠ Hit hard cap of ${HARD_CAP} calls. Narrow the date range to see more.` : undefined;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            summary: {
              accountName: params.accountName,
              totalCalls: collected.length,
              dateRange: { from: firstDate, to: lastDate },
              uniqueExternalParticipants: uniqueExternalEmails.size,
            },
            ...(warning && { warning }),
            timeline,
          }, null, 2),
        }],
      };
    }
  );

  // ── search_calls_by_keyword ──
  server.tool(
    "search_calls_by_keyword",
    "Admin: Search call transcripts for a keyword. No default date window. Max 5,000 transcripts (was 100 in prod). Default 200. WARNING: a single broad query can burn a large chunk of the 10k/day Gong API budget.",
    {
      keyword: z.string().describe("Word or phrase to search for (case-insensitive)."),
      fromDateTime: z.string().optional().describe("Start date (ISO 8601). If omitted, searches ALL calls."),
      toDateTime: z.string().optional().describe("End date (ISO 8601). Defaults to now."),
      maxCalls: z.number().optional().describe("Max transcripts to search (1–5000, default 200)."),
    },
    async (params: { keyword: string; fromDateTime?: string; toDateTime?: string; maxCalls?: number }) => {
      try {
        validateDateParam(params.fromDateTime, "fromDateTime");
        validateDateParam(params.toDateTime, "toDateTime");
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }
      if (!params.keyword.trim()) return toolError("keyword cannot be empty.");

      const HARD_CAP = 5000;
      let maxCalls: number;
      try {
        maxCalls = validatePositiveInt(params.maxCalls, "maxCalls", 200);
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }
      maxCalls = Math.min(maxCalls, HARD_CAP);

      const callIds: string[] = [];
      const callMeta = new Map<string, GongCallBasic>();
      let cursor: string | undefined;
      let totalCallsInRange = 0;

      do {
        const page = await client.listCalls({
          fromDateTime: params.fromDateTime,
          toDateTime: params.toDateTime,
          cursor,
        });
        for (const call of page.calls) {
          totalCallsInRange++;
          if (callIds.length < maxCalls) {
            callIds.push(call.id);
            callMeta.set(call.id, call);
          }
        }
        cursor = page.cursor;
      } while (cursor && callIds.length < maxCalls);

      const capped = !!cursor || totalCallsInRange > maxCalls;
      const keywordLower = params.keyword.toLowerCase();

      interface KeywordResult {
        callId: string;
        title: string;
        started: string;
        url?: string;
        matchesInCall: number;
        snippets: string[];
      }
      const results: KeywordResult[] = [];

      // Parallel fan-out with MAX_CONCURRENCY (defaults to 3 to respect Gong's 3 req/sec ceiling)
      const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY ?? "3", 10);
      for (let i = 0; i < callIds.length; i += MAX_CONCURRENCY) {
        const batch = callIds.slice(i, i + MAX_CONCURRENCY);
        const transcripts = await Promise.all(
          batch.map(async (id) => ({ id, data: await client.getCallTranscript(id) }))
        );
        for (const { id: callId, data: transcriptData } of transcripts) {
          if (!transcriptData) continue;
          let matchCount = 0;
          const snippets: string[] = [];
          for (const segment of transcriptData.transcript) {
            const sentences = segment.sentences;
            for (let si = 0; si < sentences.length; si++) {
              const sentence = sentences[si];
              if (!sentence.text.toLowerCase().includes(keywordLower)) continue;
              matchCount++;
              if (snippets.length < 3) {
                const before = si > 0 ? sentences[si - 1].text : null;
                const after = si < sentences.length - 1 ? sentences[si + 1].text : null;
                const contextParts: string[] = [];
                if (before) contextParts.push(before);
                contextParts.push(sentence.text);
                if (after) contextParts.push(after);
                snippets.push(`[Speaker ${segment.speakerId}]: ${contextParts.join(" ")}`);
              }
            }
          }
          if (matchCount === 0) continue;
          const meta = callMeta.get(callId);
          const result: KeywordResult = {
            callId,
            title: meta?.title ?? "Untitled",
            started: meta?.started ?? "Unknown",
            url: meta?.url,
            matchesInCall: matchCount,
            snippets,
          };
          if (matchCount > 3) result.snippets.push(`(+${matchCount - 3} more matches)`);
          results.push(result);
        }
      }

      const callsSearched = callIds.length;
      const matchCount = results.length;
      let summary: string;
      const searchTips: string[] = [];

      if (callsSearched === 0) {
        summary = "No calls found in this date range.";
        searchTips.push("Try expanding your date range with an earlier fromDateTime.");
      } else if (matchCount === 0) {
        summary = `Searched ${callsSearched} call(s) — no matches found for "${params.keyword}".`;
        searchTips.push("Gong transcribes spoken words — try phonetic forms (e.g. 'net revenue retention' not 'NRR').");
        if (capped) searchTips.push(`Only ${callsSearched} of ${totalCallsInRange} calls were searched. Narrow the date range.`);
      } else {
        summary = `Searched ${callsSearched} of ${totalCallsInRange} call(s)${capped ? " (cap hit)" : ""}. Found "${params.keyword}" in ${matchCount} call(s).`;
        if (capped) searchTips.push(`${totalCallsInRange} calls exist but only ${callsSearched} were searched. Narrow the range to cover the rest.`);
      }
      if (callsSearched > 1000) searchTips.push(`⚠ This query scanned >1,000 transcripts (~${callsSearched} Gong API calls). The daily cap is 10,000 calls.`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            summary,
            ...(searchTips.length > 0 && { searchTips }),
            capped,
            totalCallsInRange,
            callsSearched,
            matchCount,
            results,
          }, null, 2),
        }],
      };
    }
  );

  // ── search_calls_by_title ──
  server.tool(
    "search_calls_by_title",
    'Admin: Find calls whose title matches a search term. No default date window, default 100, no max cap.',
    {
      query: z.string().describe('Text to search for in call titles (case-insensitive partial match).'),
      fromDateTime: z.string().optional().describe('Start date (ISO 8601). If omitted, searches ALL calls.'),
      toDateTime: z.string().optional().describe("End date (ISO 8601). Defaults to now."),
      limit: z.number().optional().describe("Max results to return (default 100, no max cap)."),
    },
    async (params: { query: string; fromDateTime?: string; toDateTime?: string; limit?: number }) => {
      try {
        validateDateParam(params.fromDateTime, "fromDateTime");
        validateDateParam(params.toDateTime, "toDateTime");
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }
      if (!params.query.trim()) return toolError("query cannot be empty.");

      let limit: number;
      try {
        limit = validatePositiveInt(params.limit, "limit", 100);
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }

      const query = params.query.toLowerCase().trim();
      const matched: GongCallBasic[] = [];
      let cursor: string | undefined;

      do {
        const page = await client.searchCalls({
          fromDateTime: params.fromDateTime,
          toDateTime: params.toDateTime,
          cursor,
        });
        const hits = page.calls.filter((call) => (call.title ?? "").toLowerCase().includes(query));
        matched.push(...hits);
        cursor = page.cursor;
      } while (cursor && matched.length < limit);

      const trimmed = matched
        .sort((a, b) => new Date(b.started ?? 0).getTime() - new Date(a.started ?? 0).getTime())
        .slice(0, limit);

      if (trimmed.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              message: `No calls found with "${params.query}" in the title.`,
              hint: "Try a shorter search term or expand the date range.",
              dateRange: { from: params.fromDateTime ?? "all-time", to: params.toDateTime ?? "now" },
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            query: params.query,
            totalCallsFound: trimmed.length,
            dateRange: { from: params.fromDateTime ?? "all-time", to: params.toDateTime ?? "now" },
            calls: trimmed.map((c) => formatCallForDisplay(c)),
          }, null, 2),
        }],
      };
    }
  );
}
