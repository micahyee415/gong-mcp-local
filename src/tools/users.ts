import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GongClient, GongCallBasic, GongCallDetailed } from "../gong-client.js";
import {
  ValidationError,
  validateEmail,
  validateDateParam,
  validatePositiveInt,
} from "../validation.js";

function isUserOnCall(call: GongCallBasic, userId: string, userEmail: string): boolean {
  if (call.primaryUserId === userId) return true;
  if (call.parties) {
    for (const p of call.parties) {
      if (p.id === userId) return true;
      if (p.emailAddress && p.emailAddress.toLowerCase() === userEmail.toLowerCase()) return true;
    }
  }
  return false;
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function registerUserTools(server: McpServer, client: GongClient, callerEmail: string) {
  // ── whoami ──
  server.tool(
    "whoami",
    "Show your Gong user profile (name, email, title).",
    {},
    async () => {
      const user = await client.getUserByEmail(callerEmail);
      if (!user) return toolError("Could not resolve current user. Check GONG_USER_EMAIL in .env.");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            id: user.id,
            name: `${user.firstName} ${user.lastName}`,
            email: user.emailAddress,
            title: user.title,
            active: user.active,
          }, null, 2),
        }],
      };
    }
  );

  // ── find_user ──
  server.tool(
    "find_user",
    "Look up a Gong user by email address.",
    { email: z.string().describe("Email address of the user to find") },
    async (params: { email: string }) => {
      let email: string;
      try {
        email = validateEmail(params.email, "email");
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }
      const user = await client.getUserByEmail(email);
      if (!user) return toolError(`No Gong user found with email "${email}".`);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            id: user.id,
            name: `${user.firstName} ${user.lastName}`,
            email: user.emailAddress,
            title: user.title,
            active: user.active,
          }, null, 2),
        }],
      };
    }
  );

  // ── get_user_calls ──
  server.tool(
    "get_user_calls",
    "Admin: Get calls for a user by email. Wider auto-window (up to 1 year) and deeper page caps (10/20/30, or 100 with explicit date range).",
    {
      email: z.string().describe("Email address of the user whose calls to retrieve"),
      fromDateTime: z.string().optional().describe('Start date filter (ISO 8601)'),
      toDateTime: z.string().optional().describe("End date filter (ISO 8601)"),
      limit: z.number().optional().describe("Max number of calls to return (default 100)"),
    },
    async (params: { email: string; fromDateTime?: string; toDateTime?: string; limit?: number }) => {
      let email: string;
      let limit: number;
      try {
        email = validateEmail(params.email, "email");
        validateDateParam(params.fromDateTime, "fromDateTime");
        validateDateParam(params.toDateTime, "toDateTime");
        limit = validatePositiveInt(params.limit, "limit", 100);
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }

      const targetUser = await client.getUserByEmail(email);
      if (!targetUser) return toolError(`No Gong user found with email "${email}".`);

      const allCalls: { id: string; title: string; date: string; duration: string; url?: string }[] = [];

      if (params.fromDateTime) {
        // Explicit date range: paginate up to 100 pages (~10,000 calls)
        let cursor: string | undefined;
        const MAX_PAGES = 100;
        let pages = 0;
        do {
          const result = await client.searchCalls({
            fromDateTime: params.fromDateTime,
            toDateTime: params.toDateTime,
            cursor,
          });
          pages++;
          const userCalls = result.calls.filter((c) => isUserOnCall(c, targetUser.id, targetUser.emailAddress));
          for (const c of userCalls) {
            allCalls.push({
              id: c.id,
              title: c.title ?? "Untitled",
              date: c.started ?? "Unknown",
              duration: c.duration ? `${Math.round(c.duration / 60)}min` : "Unknown",
              url: c.url ?? undefined,
            });
          }
          cursor = result.cursor;
        } while (cursor && pages < MAX_PAGES);
      } else {
        // Auto mode: wider windows with deeper page caps (admin-tuned)
        // Window edges in days-ago: [0, 30, 90, 365]
        // Window 0: now-30d  → now        (30 days, cap 10 pages)
        // Window 1: now-90d  → now-30d    (60 days, cap 20 pages)
        // Window 2: now-365d → now-90d    (275 days, cap 30 pages)
        const WINDOW_EDGES_DAYS = [0, 30, 90, 365];
        const MAX_PAGES_PER_WINDOW = [10, 20, 30];
        const now = Date.now();
        const MS_PER_DAY = 24 * 60 * 60 * 1000;
        const toIso = (ms: number) => new Date(ms).toISOString();

        for (let w = 0; w < WINDOW_EDGES_DAYS.length - 1; w++) {
          const windowFrom = toIso(now - WINDOW_EDGES_DAYS[w + 1] * MS_PER_DAY);
          const windowTo = w === 0 ? undefined : toIso(now - WINDOW_EDGES_DAYS[w] * MS_PER_DAY);
          let cursor: string | undefined;
          let windowPages = 0;
          do {
            const result = await client.searchCalls({
              fromDateTime: windowFrom,
              toDateTime: windowTo,
              cursor,
            });
            windowPages++;
            const userCalls = result.calls.filter((c) => isUserOnCall(c, targetUser.id, targetUser.emailAddress));
            for (const c of userCalls) {
              allCalls.push({
                id: c.id,
                title: c.title ?? "Untitled",
                date: c.started ?? "Unknown",
                duration: c.duration ? `${Math.round(c.duration / 60)}min` : "Unknown",
                url: c.url ?? undefined,
              });
            }
            cursor = result.cursor;
          } while (cursor && windowPages < MAX_PAGES_PER_WINDOW[w]);
          if (allCalls.length >= limit) break;
        }
      }

      if (allCalls.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No calls found for ${targetUser.firstName} ${targetUser.lastName} (${targetUser.emailAddress}). Try adjusting the date range.`,
          }],
        };
      }

      allCalls.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      const trimmed = allCalls.slice(0, limit);
      const hasMore = allCalls.length > limit;
      const note = hasMore ? `Note: Results capped at ${limit} calls. Pass a wider limit or narrow with fromDateTime/toDateTime.` : undefined;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            user: `${targetUser.firstName} ${targetUser.lastName} (${targetUser.emailAddress})`,
            totalCalls: allCalls.length,
            showing: trimmed.length,
            hasMore,
            ...(note && { note }),
            calls: trimmed,
          }, null, 2),
        }],
      };
    }
  );

  // ── list_users ──
  server.tool(
    "list_users",
    "List all users in the Gong workspace.",
    {
      activeOnly: z.boolean().optional().describe("If true (default), only return active users."),
    },
    async (params: { activeOnly?: boolean }) => {
      const activeOnly = params.activeOnly !== false;
      const allUsers: { name: string; email: string; title: string; active: boolean }[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listUsers(cursor);
        for (const u of page.users) {
          if (activeOnly && !u.active) continue;
          allUsers.push({
            name: `${u.firstName} ${u.lastName}`,
            email: u.emailAddress,
            title: u.title ?? "",
            active: u.active,
          });
        }
        cursor = page.cursor;
      } while (cursor);
      allUsers.sort((a, b) => a.name.localeCompare(b.name));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            totalUsers: allUsers.length,
            activeOnly,
            users: allUsers,
          }, null, 2),
        }],
      };
    }
  );

  // ── get_rep_scorecard ──
  server.tool(
    "get_rep_scorecard",
    "Admin: Performance scorecard for a rep. Hard cap 500 calls (was 50 in prod). No default date window.",
    {
      email: z.string().describe("Email address of the rep to analyze"),
      fromDateTime: z.string().optional().describe('Start date (ISO 8601). If omitted, searches ALL calls.'),
      toDateTime: z.string().optional().describe("End date (ISO 8601). Defaults to now."),
    },
    async (params: { email: string; fromDateTime?: string; toDateTime?: string }) => {
      let email: string;
      try {
        email = validateEmail(params.email, "email");
        validateDateParam(params.fromDateTime, "fromDateTime");
        validateDateParam(params.toDateTime, "toDateTime");
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        throw err;
      }

      const rep = await client.getUserByEmail(email);
      if (!rep) return toolError(`No Gong user found with email "${email}".`);

      const MAX_CALLS = 500;
      const repCalls: GongCallDetailed[] = [];
      let cursor: string | undefined;

      do {
        const page = await client.searchCallsDetailed({
          primaryUserIds: [rep.id],
          fromDateTime: params.fromDateTime,
          toDateTime: params.toDateTime,
          cursor,
        });
        const onCall = page.calls.filter((c) => isUserOnCall(c, rep.id, rep.emailAddress));
        repCalls.push(...onCall);
        cursor = page.cursor;
      } while (cursor && repCalls.length < MAX_CALLS);

      repCalls.sort((a, b) => new Date(b.started ?? 0).getTime() - new Date(a.started ?? 0).getTime());
      const calls = repCalls.slice(0, MAX_CALLS);

      if (calls.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No calls found for ${rep.firstName} ${rep.lastName} in the requested period. Try a wider date range.`,
          }],
        };
      }

      const hosted = calls.filter((c) => c.primaryUserId === rep.id).length;
      const attended = calls.length - hosted;
      const totalSeconds = calls.reduce((sum, c) => sum + (c.duration ?? 0), 0);
      const totalHours = (totalSeconds / 3600).toFixed(1);
      const avgMins = calls.length > 0 ? Math.round(totalSeconds / 60 / calls.length) : 0;

      const topicCallCount = new Map<string, number>();
      const topicTotalMins = new Map<string, number>();
      for (const call of calls) {
        const contentBlock = (call.content as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown> | undefined;
        const topics = (contentBlock?.topics as { name?: string; duration?: number }[] | undefined) ?? [];
        const seenThisCall = new Set<string>();
        for (const t of topics) {
          if (!t.name) continue;
          if (!seenThisCall.has(t.name)) {
            topicCallCount.set(t.name, (topicCallCount.get(t.name) ?? 0) + 1);
            seenThisCall.add(t.name);
          }
          topicTotalMins.set(t.name, (topicTotalMins.get(t.name) ?? 0) + Math.round((t.duration ?? 0) / 60));
        }
      }
      const topTopics = [...topicCallCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([name, callCount]) => ({
          topic: name,
          appearedIn: `${callCount}/${calls.length} calls`,
          totalMins: topicTotalMins.get(name) ?? 0,
        }));

      const trackerMentions = new Map<string, number>();
      const trackerCallCount = new Map<string, number>();
      for (const call of calls) {
        const contentBlock = (call.content as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown> | undefined;
        const trackers = (contentBlock?.trackers as { name?: string; count?: number }[] | undefined) ?? [];
        const seenThisCall = new Set<string>();
        for (const t of trackers) {
          if (!t.name || !t.count) continue;
          trackerMentions.set(t.name, (trackerMentions.get(t.name) ?? 0) + t.count);
          if (!seenThisCall.has(t.name)) {
            trackerCallCount.set(t.name, (trackerCallCount.get(t.name) ?? 0) + 1);
            seenThisCall.add(t.name);
          }
        }
      }
      const topTrackers = [...trackerMentions.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([name, totalMentions]) => ({
          tracker: name,
          totalMentions,
          appearedIn: `${trackerCallCount.get(name) ?? 0}/${calls.length} calls`,
        }));

      const recentHighlights = calls.slice(0, 5).map((call) => {
        const contentBlock = (call.content as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown> | undefined;
        const brief = (contentBlock?.brief as string | undefined) ?? null;
        const shortBrief = brief ? (brief.split(/[.!?]/)[0] ?? "").trim().slice(0, 120) : null;
        return {
          date: call.started ? call.started.split("T")[0] : "Unknown",
          title: call.title ?? "Untitled",
          duration: call.duration ? `${Math.round(call.duration / 60)}min` : "Unknown",
          brief: shortBrief,
          url: call.url,
        };
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            rep: {
              name: `${rep.firstName} ${rep.lastName}`,
              email: rep.emailAddress,
              title: rep.title ?? null,
            },
            period: {
              from: params.fromDateTime ?? "all-time",
              to: (params.toDateTime ?? new Date().toISOString()).split("T")[0],
            },
            callsAnalyzed: calls.length,
            volume: {
              total: calls.length,
              hosted,
              attended,
              totalTalkTime: `${totalHours}hr`,
              avgCallDuration: `${avgMins}min`,
            },
            topTopics,
            topTrackers,
            recentHighlights,
          }, null, 2),
        }],
      };
    }
  );
}
