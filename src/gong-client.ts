/**
 * Gong API client — thin wrapper over the Gong REST API v2.
 * Uses Basic auth with access key + secret.
 *
 * Admin build: cache TTLs bumped (30/15/30 min) to reduce repeat API hits
 * on wide-window queries. Single-user process, so cache size is bounded
 * by query diversity, not user count.
 */

import { TTLCache } from "./cache.js";
import { normalizeDateTime } from "./validation.js";

export interface GongConfig {
  accessKey: string;
  accessKeySecret: string;
  baseUrl: string;
}

export interface GongUser {
  id: string;
  emailAddress: string;
  firstName: string;
  lastName: string;
  title: string;
  phoneNumber?: string;
  active: boolean;
  created: string;
}

export interface GongCallParticipant {
  id?: string;
  emailAddress?: string;
  name?: string;
  speakerId?: string;
  affiliation?: string;
}

export interface GongCallBasic {
  id: string;
  title?: string;
  started?: string;
  duration?: number;
  url?: string;
  direction?: string;
  scope?: string;
  system?: string;
  primaryUserId?: string;
  parties?: GongCallParticipant[];
}

export interface GongCallDetailed extends GongCallBasic {
  media?: string;
  language?: string;
  workspaceId?: string;
  sdrDisposition?: string;
  clientUniqueId?: string;
  customData?: string;
  content?: unknown[];
  interaction?: unknown;
  collaboration?: unknown;
  context?: unknown[];
}

export interface GongTracker {
  trackerId: string;
  trackerName: string;
  trackerPhrases?: { phrase: string }[];
  keywordTrackerAffiliation?: string;
  filterQuery?: string;
}

export interface GongWorkspace {
  id: string;
  name: string;
  description?: string;
}

type GongResponse = {
  requestId: string;
  records: {
    totalRecords: number;
    currentPageSize: number;
    currentPageNumber: number;
    cursor?: string;
  };
  [key: string]: unknown;
};

interface RawExtensiveCall {
  metaData?: {
    id: string;
    title?: string;
    started?: string;
    duration?: number;
    url?: string;
    direction?: string;
    scope?: string;
    system?: string;
    primaryUserId?: string;
    parties?: GongCallParticipant[];
    media?: string;
    language?: string;
    workspaceId?: string;
    sdrDisposition?: string;
    clientUniqueId?: string;
    customData?: string;
  };
  content?: {
    structure?: unknown;
    topics?: { name?: string; duration?: number; mentions?: number }[];
    trackers?: { trackerId?: string; name?: string; count?: number; occurrences?: unknown[] }[];
    pointsOfInterest?: { category?: string; text?: string; description?: string; startTime?: number; speakerId?: string }[];
    brief?: string;
  };
  interaction?: unknown;
  collaboration?: unknown;
  context?: unknown;
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;
const REQUEST_TIMEOUT_MS = 30_000;

// Admin cache TTLs — bumped to cut repeat API hits on wide-window queries.
const USER_CACHE_TTL = 30 * 60 * 1000; // 30 minutes (prod: 5)
const CALL_CACHE_TTL = 15 * 60 * 1000; // 15 minutes (prod: 2)
const TRANSCRIPT_CACHE_TTL = 30 * 60 * 1000; // 30 minutes (prod: 5)

export class GongClient {
  private authHeader: string;
  private baseUrl: string;

  private userCache = new TTLCache<GongUser>(USER_CACHE_TTL);
  private callCache = new TTLCache<GongCallDetailed>(CALL_CACHE_TTL);
  private transcriptCache = new TTLCache<{ transcript: { speakerId: string; topic?: string; sentences: { start: number; end: number; text: string }[] }[] }>(TRANSCRIPT_CACHE_TTL);

  constructor(config: GongConfig) {
    this.authHeader =
      "Basic " +
      Buffer.from(`${config.accessKey}:${config.accessKeySecret}`).toString("base64");
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      "Content-Type": "application/json",
    };

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (RETRYABLE_STATUS_CODES.has(res.status) && attempt < MAX_RETRIES) {
          const retryAfter = res.headers.get("Retry-After");
          if (retryAfter) {
            const waitMs = parseInt(retryAfter, 10) * 1000;
            if (!isNaN(waitMs) && waitMs > 0 && waitMs <= 30000) {
              await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
          }
          lastError = new Error(`Gong API ${method} ${path} returned ${res.status}`);
          continue;
        }

        if (!res.ok) {
          if (res.status === 404) {
            return { requestId: "", records: { totalRecords: 0, currentPageSize: 0, currentPageNumber: 0 } } as T;
          }
          const text = await res.text();
          if (res.status === 401 || res.status === 403) {
            throw new Error(
              `Gong API ${method} ${path} returned ${res.status} (${res.status === 401 ? "authentication" : "permission"} error): ${text}`
            );
          }
          throw new Error(`Gong API ${method} ${path} returned ${res.status}: ${text}`);
        }

        return res.json() as Promise<T>;
      } catch (err) {
        if (err instanceof TypeError && attempt < MAX_RETRIES) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new Error(`Gong API ${method} ${path} failed after ${MAX_RETRIES} retries`);
  }

  async healthCheck(): Promise<{
    ok: boolean;
    checks: { name: string; status: "pass" | "fail"; detail: string }[];
  }> {
    const checks: { name: string; status: "pass" | "fail"; detail: string }[] = [];

    try {
      const res = await fetch(`${this.baseUrl}/v2/workspaces`, {
        method: "GET",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
        },
      });
      if (res.ok) {
        checks.push({ name: "API credentials", status: "pass", detail: "Authenticated successfully" });
      } else if (res.status === 401 || res.status === 403) {
        checks.push({
          name: "API credentials",
          status: "fail",
          detail: `Authentication failed (HTTP ${res.status}). Check GONG_ACCESS_KEY and GONG_ACCESS_KEY_SECRET.`,
        });
      } else {
        checks.push({
          name: "API credentials",
          status: "fail",
          detail: `Unexpected response (HTTP ${res.status}). Check GONG_BASE_URL.`,
        });
      }
    } catch {
      checks.push({
        name: "API connectivity",
        status: "fail",
        detail: `Cannot reach Gong API at ${this.baseUrl}. Check GONG_BASE_URL and your network connection.`,
      });
    }

    return {
      ok: checks.every((c) => c.status === "pass"),
      checks,
    };
  }

  // ── Users ──

  async listUsers(cursor?: string): Promise<{ users: GongUser[]; cursor?: string }> {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString() ? `?${params}` : "";
    const res = await this.request<GongResponse>("GET", `/v2/users${qs}`);
    return { users: (res.users as GongUser[]) ?? [], cursor: res.records?.cursor };
  }

  async getUserByEmail(email: string): Promise<GongUser | null> {
    const cached = this.userCache.get(`email:${email.toLowerCase()}`);
    if (cached) return cached;

    let cursor: string | undefined;
    do {
      const page = await this.listUsers(cursor);
      for (const u of page.users) {
        this.userCache.set(`email:${u.emailAddress.toLowerCase()}`, u);
        this.userCache.set(`id:${u.id}`, u);
      }
      const match = page.users.find(
        (u) => u.emailAddress.toLowerCase() === email.toLowerCase()
      );
      if (match) return match;
      cursor = page.cursor;
    } while (cursor);
    return null;
  }

  async getUser(userId: string): Promise<GongUser | null> {
    const cached = this.userCache.get(`id:${userId}`);
    if (cached) return cached;

    const body = { filter: { userIds: [userId] } };
    const res = await this.request<GongResponse>("POST", "/v2/users/extensive", body);
    const user = ((res.users as GongUser[]) ?? [])[0] ?? null;
    if (user) {
      this.userCache.set(`id:${user.id}`, user);
      this.userCache.set(`email:${user.emailAddress.toLowerCase()}`, user);
    }
    return user;
  }

  // ── Calls ──

  private static readonly CALL_CONTENT_SELECTOR = {
    contentSelector: {
      exposedFields: {
        metaData: { parties: true },
        content: { structure: true, topics: true, trackers: true, pointsOfInterest: true },
        collaboration: { publicComments: true },
        context: { system: true, company: true, contacts: true },
        interaction: { speakers: true },
      },
    },
  };

  private flattenExtensiveCall(raw: RawExtensiveCall): GongCallDetailed {
    const meta = raw.metaData as NonNullable<RawExtensiveCall["metaData"]>;
    return {
      id: meta.id,
      title: meta.title,
      started: meta.started,
      duration: meta.duration,
      url: meta.url,
      direction: meta.direction,
      scope: meta.scope,
      system: meta.system,
      primaryUserId: meta.primaryUserId,
      parties: meta.parties,
      media: meta.media,
      language: meta.language,
      workspaceId: meta.workspaceId,
      sdrDisposition: meta.sdrDisposition,
      clientUniqueId: meta.clientUniqueId,
      customData: meta.customData,
      content: raw.content ? [raw.content] : undefined,
      interaction: raw.interaction,
      collaboration: raw.collaboration,
      context: raw.context ? [raw.context] : undefined,
    };
  }

  async listCalls(params: {
    fromDateTime?: string;
    toDateTime?: string;
    workspaceId?: string;
    cursor?: string;
  }): Promise<{ calls: GongCallBasic[]; cursor?: string }> {
    const qp = new URLSearchParams();
    if (params.fromDateTime) qp.set("fromDateTime", params.fromDateTime);
    if (params.toDateTime) qp.set("toDateTime", params.toDateTime);
    if (params.workspaceId) qp.set("workspaceId", params.workspaceId);
    if (params.cursor) qp.set("cursor", params.cursor);
    const qs = qp.toString() ? `?${qp}` : "";
    const res = await this.request<GongResponse>("GET", `/v2/calls${qs}`);
    return { calls: (res.calls as GongCallBasic[]) ?? [], cursor: res.records?.cursor };
  }

  async searchCalls(params: {
    primaryUserIds?: string[];
    callIds?: string[];
    fromDateTime?: string;
    toDateTime?: string;
    workspaceId?: string;
    cursor?: string;
  }): Promise<{ calls: GongCallBasic[]; cursor?: string }> {
    const body: Record<string, unknown> = {
      filter: {
        ...(params.primaryUserIds && { primaryUserIds: params.primaryUserIds }),
        ...(params.callIds && { callIds: params.callIds }),
        ...(params.fromDateTime && { fromDateTime: normalizeDateTime(params.fromDateTime) }),
        ...(params.toDateTime && { toDateTime: normalizeDateTime(params.toDateTime) }),
        ...(params.workspaceId && { workspaceId: params.workspaceId }),
      },
      ...GongClient.CALL_CONTENT_SELECTOR,
      ...(params.cursor && { cursor: params.cursor }),
    };
    const res = await this.request<GongResponse>("POST", "/v2/calls/extensive", body);
    const rawCalls = (res.calls as RawExtensiveCall[]) ?? [];
    const calls = rawCalls.map((c) => this.flattenExtensiveCall(c) as GongCallBasic);
    return { calls, cursor: res.records?.cursor };
  }

  async searchCallsDetailed(params: {
    primaryUserIds?: string[];
    fromDateTime?: string;
    toDateTime?: string;
    workspaceId?: string;
    cursor?: string;
  }): Promise<{ calls: GongCallDetailed[]; cursor?: string }> {
    const body: Record<string, unknown> = {
      filter: {
        ...(params.primaryUserIds && { primaryUserIds: params.primaryUserIds }),
        ...(params.fromDateTime && { fromDateTime: normalizeDateTime(params.fromDateTime) }),
        ...(params.toDateTime && { toDateTime: normalizeDateTime(params.toDateTime) }),
        ...(params.workspaceId && { workspaceId: params.workspaceId }),
      },
      ...GongClient.CALL_CONTENT_SELECTOR,
      ...(params.cursor && { cursor: params.cursor }),
    };
    const res = await this.request<GongResponse>("POST", "/v2/calls/extensive", body);
    const rawCalls = (res.calls as RawExtensiveCall[]) ?? [];
    return { calls: rawCalls.map((c) => this.flattenExtensiveCall(c)), cursor: res.records?.cursor };
  }

  async getCall(callId: string): Promise<GongCallDetailed | null> {
    const cached = this.callCache.get(callId);
    if (cached) return cached;

    const body = { filter: { callIds: [callId] }, ...GongClient.CALL_CONTENT_SELECTOR };
    const res = await this.request<GongResponse>("POST", "/v2/calls/extensive", body);
    const rawCalls = (res.calls as RawExtensiveCall[]) ?? [];
    const call = rawCalls.length > 0 ? this.flattenExtensiveCall(rawCalls[0]) : null;
    if (call) {
      this.callCache.set(callId, call);
    }
    return call;
  }

  async getCallTranscript(
    callId: string
  ): Promise<{ transcript: { speakerId: string; topic?: string; sentences: { start: number; end: number; text: string }[] }[] } | null> {
    const cached = this.transcriptCache.get(callId);
    if (cached) return cached;

    const body = { filter: { callIds: [callId] } };
    const res = await this.request<GongResponse>("POST", "/v2/calls/transcript", body);
    type TranscriptSentence = { start: number; end: number; text: string };
    type TranscriptSegment = { speakerId: string; topic?: string; sentences: TranscriptSentence[] };
    type CallTranscriptEntry = { callId: string; transcript: TranscriptSegment[] };
    const transcripts = (res as { callTranscripts?: CallTranscriptEntry[] }).callTranscripts;
    const entry = transcripts?.find((t) => t.callId === callId);
    const result = entry ? { transcript: entry.transcript } : null;
    if (result) {
      this.transcriptCache.set(callId, result);
    }
    return result;
  }

  // ── Trackers ──

  async getTrackers(workspaceId?: string): Promise<GongTracker[]> {
    const params = new URLSearchParams();
    if (workspaceId) params.set("workspaceId", workspaceId);
    const qs = params.toString() ? `?${params}` : "";
    const res = await this.request<GongResponse>("GET", `/v2/settings/trackers${qs}`);
    return (res.trackers as GongTracker[]) ?? [];
  }

  // ── Workspaces ──

  async listWorkspaces(): Promise<GongWorkspace[]> {
    const res = await this.request<GongResponse>("GET", "/v2/workspaces");
    return (res.workspaces as GongWorkspace[]) ?? [];
  }
}
