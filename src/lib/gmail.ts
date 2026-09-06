import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { google, gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import pLimit from "p-limit";
import { GMAIL_CACHE_PATH, ensureRozeDir } from "./paths.js";

export interface ParsedMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  bodyText: string;
}

export type ThreadMap = Map<string, ParsedMessage[]>;

export function getGmailClient(authClient: OAuth2Client): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth: authClient });
}

/**
 * Returns the authenticated account's own email address, so extraction can
 * exclude the user from being treated as one of their own "contacts".
 */
export async function getMyEmailAddress(gmail: gmail_v1.Gmail): Promise<string | null> {
  const res = await withRetry(() => gmail.users.getProfile({ userId: "me" }));
  return res.data.emailAddress?.toLowerCase() ?? null;
}

/**
 * Paginates through gmail.users.messages.list until there are no more
 * pages, returning every message id for the authenticated user.
 */
export async function listAllMessageIds(
  gmail: gmail_v1.Gmail
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const res = await withRetry(() =>
      gmail.users.messages.list({
        userId: "me",
        maxResults: 500,
        pageToken,
      })
    );

    for (const msg of res.data.messages ?? []) {
      if (msg.id) ids.push(msg.id);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return ids;
}

/**
 * Fetches a single message in "full" format and parses it into a clean,
 * plain-text representation. Results are cached on disk by message id so
 * re-running `generate` doesn't re-fetch messages already fetched before.
 */
export async function getMessage(
  gmail: gmail_v1.Gmail,
  id: string
): Promise<ParsedMessage> {
  const cache = getCache();
  const cached = cache[id];
  if (cached) return cached;

  const res = await withRetry(() =>
    gmail.users.messages.get({ userId: "me", id, format: "full" })
  );

  const parsed = parseMessage(res.data);
  cache[id] = parsed;
  markCacheDirty();
  return parsed;
}

/**
 * Fetches many messages concurrently (bounded) with retry/backoff on
 * rate-limit or transient server errors.
 */
export async function getMessages(
  gmail: gmail_v1.Gmail,
  ids: string[],
  onProgress?: (done: number, total: number) => void
): Promise<ParsedMessage[]> {
  const concurrencyLimit = pLimit(3);
  let done = 0;
  try {
    const results = await Promise.all(
      ids.map((id) =>
        concurrencyLimit(async () => {
          const msg = await getMessage(gmail, id);
          done += 1;
          onProgress?.(done, ids.length);
          return msg;
        })
      )
    );
    return results;
  } finally {
    // Persist whatever was fetched, including on failure or interruption, so
    // a re-run doesn't have to re-download it.
    flushCache();
  }
}

export function groupByThread(messages: ParsedMessage[]): ThreadMap {
  const threads: ThreadMap = new Map();
  for (const msg of messages) {
    const list = threads.get(msg.threadId) ?? [];
    list.push(msg);
    threads.set(msg.threadId, list);
  }
  for (const list of threads.values()) {
    list.sort((a, b) => Date.parse(a.date || "0") - Date.parse(b.date || "0"));
  }
  return threads;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export function parseMessage(message: gmail_v1.Schema$Message): ParsedMessage {
  const headers = message.payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ??
    "";

  const bodyText = extractBodyText(message.payload);

  return {
    id: message.id ?? "",
    threadId: message.threadId ?? "",
    from: header("From"),
    to: header("To"),
    subject: header("Subject"),
    date: header("Date"),
    bodyText: bodyText.trim().slice(0, 20_000), // guard against pathological sizes
  };
}

function extractBodyText(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";

  const collected: { plain: string[]; html: string[] } = { plain: [], html: [] };
  walkParts(part, collected);

  if (collected.plain.length > 0) return collected.plain.join("\n");
  if (collected.html.length > 0) return stripHtml(collected.html.join("\n"));
  return "";
}

function walkParts(
  part: gmail_v1.Schema$MessagePart,
  out: { plain: string[]; html: string[] }
): void {
  const mimeType = part.mimeType ?? "";
  const data = part.body?.data;

  if (data && mimeType === "text/plain") {
    out.plain.push(decodeBase64Url(data));
  } else if (data && mimeType === "text/html") {
    out.html.push(decodeBase64Url(data));
  }

  for (const child of part.parts ?? []) {
    walkParts(child, out);
  }
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Simple on-disk cache
// ---------------------------------------------------------------------------

type Cache = Record<string, ParsedMessage>;

function loadCache(): Cache {
  if (!existsSync(GMAIL_CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(GMAIL_CACHE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveCache(cache: Cache): void {
  ensureRozeDir();
  writeFileSync(GMAIL_CACHE_PATH, JSON.stringify(cache));
}

// The cache is held in memory for the life of the process. It used to be
// re-read and re-written from disk on every single message, which meant each
// fetch paid a full parse + serialize of the entire (multi-megabyte and
// growing) cache file - O(n^2) I/O that dominated the runtime of a full
// mailbox fetch and completely swamped the actual network time.
let cacheRef: Cache | null = null;
let dirtyEntries = 0;

/** Flush after this many new messages, bounding work lost to an interrupt. */
const CACHE_FLUSH_INTERVAL = 50;

function getCache(): Cache {
  if (!cacheRef) cacheRef = loadCache();
  return cacheRef;
}

function markCacheDirty(): void {
  dirtyEntries += 1;
  if (dirtyEntries >= CACHE_FLUSH_INTERVAL) flushCache();
}

function flushCache(): void {
  if (!cacheRef || dirtyEntries === 0) return;
  saveCache(cacheRef);
  dirtyEntries = 0;
}

// ---------------------------------------------------------------------------
// Proactive rate limiter
// ---------------------------------------------------------------------------

/**
 * A simple sliding-window limiter shared across all Gmail API calls, so we
 * self-throttle *before* hitting Google's per-user quota rather than only
 * reacting to 429s after the fact. Conservative default (8 requests/sec =
 * 480/min) stays comfortably under Gmail's default per-user budget even if
 * each call costs several quota units; override with ROZE_GMAIL_RPS if you
 * have a higher quota (e.g. after requesting an increase).
 */
function createRateLimiter(maxPerWindow: number, windowMs: number) {
  const timestamps: number[] = [];
  return async function acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      while (timestamps.length && now - timestamps[0] >= windowMs) timestamps.shift();
      if (timestamps.length < maxPerWindow) {
        timestamps.push(now);
        return;
      }
      const waitMs = windowMs - (now - timestamps[0]) + 5;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  };
}

const acquireRateLimitSlot = createRateLimiter(
  Number(process.env.ROZE_GMAIL_RPS ?? 8),
  1000
);

// ---------------------------------------------------------------------------
// Retry with exponential backoff on 429/403 rate-limit/quota errors and 5xx
// ---------------------------------------------------------------------------

interface GoogleApiErrorLike {
  code?: number | string;
  status?: number;
  response?: { status?: number; headers?: Record<string, string> };
  errors?: { reason?: string }[];
  message?: string;
}

function isRetryable(err: unknown): boolean {
  const e = err as GoogleApiErrorLike;
  const status =
    e?.response?.status ?? (typeof e?.code === "number" ? e.code : undefined) ?? e?.status;

  if (status === 429 || (typeof status === "number" && status >= 500)) return true;

  // Gmail/Google API quota and rate-limit errors are sometimes surfaced as
  // 403s with a specific reason, or without a clean numeric status at all -
  // fall back to matching on the reason/message text.
  const reasons = (e?.errors ?? []).map((x) => x.reason ?? "").join(" ");
  const text = `${reasons} ${e?.message ?? ""}`.toLowerCase();
  return /quota|rate limit|rateLimitExceeded|resource_exhausted/i.test(text);
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 8
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      await acquireRateLimitSlot();
      return await fn();
    } catch (err) {
      attempt += 1;
      if (!isRetryable(err) || attempt >= maxAttempts) throw err;

      const retryAfterHeader = (err as GoogleApiErrorLike)?.response?.headers?.[
        "retry-after"
      ];
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
      const backoffMs = Math.min(2000 * 2 ** attempt, 60_000);
      const delayMs = retryAfterMs && !Number.isNaN(retryAfterMs) ? retryAfterMs : backoffMs;

      console.warn(
        `\nGmail API rate/quota limit hit, waiting ${Math.round(delayMs / 1000)}s before retrying (attempt ${attempt}/${maxAttempts})...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
