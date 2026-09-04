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
