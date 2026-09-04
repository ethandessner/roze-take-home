import type { ParsedMessage } from "./gmail.js";

const MAX_BODY_CHARS_PER_MESSAGE = 1500;
const MAX_MESSAGES_PER_THREAD = 6;

/** Splits an array of threads into fixed-size batches for extraction calls. */
export function chunkThreads<T>(threads: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < threads.length; i += batchSize) {
    batches.push(threads.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Renders a batch of threads into a single text blob suitable for sending
 * to the extraction model. Trims very long threads/bodies to keep token
 * usage bounded.
 */
export function renderThreadsForExtraction(threads: ParsedMessage[][]): string {
  const sections = threads.map((thread, idx) => {
    const subject = thread[0]?.subject || "(no subject)";
    const trimmed = thread.slice(-MAX_MESSAGES_PER_THREAD);
    const messages = trimmed
      .map((m) => {
        const body = m.bodyText.slice(0, MAX_BODY_CHARS_PER_MESSAGE);
        return `  From: ${m.from}\n  To: ${m.to}\n  Date: ${m.date}\n  Body: ${body}`;
      })
      .join("\n  ---\n");
    return `### Thread ${idx + 1}: ${subject}\n${messages}`;
  });

  return sections.join("\n\n");
}

/**
 * The most recent message date found anywhere in a batch of threads, as an
 * ISO string. Used as a coarse, batch-level fallback "last activity"
 * timestamp for entities (like projects) that can't be reliably tied back
 * to a specific counterparty's messages.
 */
export function latestDateInThreads(threads: ParsedMessage[][]): string | null {
  let latest: number | null = null;
  for (const thread of threads) {
    for (const msg of thread) {
      const t = Date.parse(msg.date || "");
      if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
    }
  }
  return latest === null ? null : new Date(latest).toISOString();
}

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function extractEmails(headerValue: string): string[] {
  return (headerValue.match(EMAIL_PATTERN) ?? []).map((e) => e.toLowerCase());
}

/**
 * Maps each email address seen in From/To headers within this batch to the
 * latest message date on which they actually appear as a sender or
 * recipient - i.e. a genuine "interaction", not just co-occurrence in the
 * same batch of threads.
 */
export function computeLastInteractionByEmail(
  threads: ParsedMessage[][]
): Map<string, string> {
  const lastByEmail = new Map<string, number>();

  for (const thread of threads) {
    for (const msg of thread) {
      const t = Date.parse(msg.date || "");
      if (Number.isNaN(t)) continue;
      const participants = new Set([...extractEmails(msg.from), ...extractEmails(msg.to)]);
      for (const email of participants) {
        const prev = lastByEmail.get(email);
        if (prev === undefined || t > prev) lastByEmail.set(email, t);
      }
    }
  }

  return new Map(
    Array.from(lastByEmail.entries()).map(([email, t]) => [email, new Date(t).toISOString()])
  );
}
