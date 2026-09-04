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
  const cache = loadCache();
  const cached = cache[id];
  if (cached) return cached;

  const res = await withRetry(() =>
    gmail.users.messages.get({ userId: "me", id, format: "full" })
  );

  const parsed = parseMessage(res.data);
  cache[id] = parsed;
  saveCache(cache);
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
  const limit = pLimit(3);
  let done = 0;
  const results = await Promise.all(
    ids.map((id) =>
      limit(async () => {
        const msg = await getMessage(gmail, id);
        done += 1;
        onProgress?.(done, ids.length);
        return msg;
      })
    )
  );
  return results;
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
