import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const PersonSchema = z.object({
  name: z.string(),
  email: z.string().nullable(),
  relationship_context: z.string().nullable(),
  notes: z.string().nullable(),
  evidence_snippet: z
    .string()
    .nullable()
    .describe(
      "A short, specific, concrete detail from the actual email(s) about this person - e.g. what they said, asked for, or were told, in their own or the user's words. Not a generic restatement."
    ),
});

const ProjectSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  status: z
    .enum(["active", "completed", "stalled", "cancelled"])
    .describe(
      "The state of this project AS OF THE NEWEST MESSAGE about it. 'completed' = reached its intended end. 'cancelled' = ended without completing (rejected, called off, decided against, superseded). 'stalled' = went quiet with no resolution. 'active' = genuinely still in motion."
    ),
  outcome: z
    .string()
    .nullable()
    .describe(
      "If the project has ENDED (completed or cancelled), state plainly how and why it ended, quoting or closely paraphrasing the deciding message - e.g. 'July decided to move forward with other candidates (Wells, Aug 25)'. Leave null only if the project is genuinely still active or stalled."
    ),
  participants: z.array(z.string()),
  evidence_snippet: z
    .string()
    .nullable()
    .describe(
      "A short, specific, concrete detail about the current state of this project from the actual email(s) - e.g. a specific decision, blocker, or next step mentioned."
    ),
});

const InterestSchema = z.object({
  topic: z.string(),
  category: z.enum(["organization", "tool", "hobby", "subject", "other"]),
  evidence_snippet: z.string().nullable(),
});

const OpenLoopSchema = z.object({
  description: z.string(),
  status: z
    .enum(["open", "resolved"])
    .describe(
      "Whether this is STILL outstanding as of the newest message in the thread. If anything later in the thread completed it, answered it, cancelled it, or made it moot, this is 'resolved' - not 'open'."
    ),
  resolution_reason: z
    .string()
    .nullable()
    .describe(
      "If status is 'resolved', why it is no longer outstanding - e.g. 'moot: July rejected the candidacy on Aug 25, so the submission is no longer needed'. Null when status is 'open'."
    ),
  owner: z.string().nullable(),
  related_people: z.array(z.string()),
  due_hint: z.string().nullable(),
});

export const ExtractionSchema = z.object({
  people: z.array(PersonSchema),
  projects: z.array(ProjectSchema),
  interests: z.array(InterestSchema),
  open_loops: z.array(OpenLoopSchema),
});

export type ExtractionResult = z.infer<typeof ExtractionSchema>;

function buildSystemPrompt(accountOwnerEmail?: string | null): string {
  return `You are analyzing a batch of a person's email threads to build a durable personal memory ("brain") for an AI assistant.

${
  accountOwnerEmail
    ? `The account owner is ${accountOwnerEmail} - this is the user themselves, NOT a contact. Never include the account owner as an entry in "people".`
    : ""
}

Extract ONLY durable, meaningful information. Explicitly SKIP newsletters, marketing, automated notifications, receipts, and spam - they carry no memory value.

FIRST, BEFORE EXTRACTING ANYTHING: for each thread, read it to the very END and determine how it actually turned out. Messages are given in chronological order, so the LAST messages are the current reality and they OVERRIDE anything promised or planned earlier in the thread.

Look specifically for terminal events that settle a thread:
- a rejection or decline ("we decided to move forward with other candidates", "we're going a different direction", "the position has been filled")
- a cancellation, or a decision not to proceed
- a question being answered, or a request being fulfilled
- an event or deadline having already passed
- an explicit handoff, withdrawal, or "no longer needed"

A terminal event INVALIDATES the commitments that preceded it. If someone promised to send work and was then rejected, that promise is NOT an open loop - it is moot. This is the single most common mistake: do not report an earlier promise as still-outstanding when a later message in the same thread has already settled the matter. Judge every candidate open loop as of the NEWEST message, never as of the moment it was made.

Extract these four categories:
- people: durable context about specific individuals the user personally communicates with (colleagues, friends, clients, family) - never the user themselves. Skip generic "support@" or "no-reply" senders.
- projects: outcome-oriented efforts with a clear endpoint (work initiatives, planning something, building something). Not recurring background activities. Set "status" to reflect how the effort actually stands as of its newest message, and whenever it has ended, fill in "outcome" with how and why.
- interests: recurring topics, organizations, tools, hobbies, or subjects the user cares about or engages with repeatedly.
- open_loops: SPECIFICALLY commitments, follow-ups, pending decisions, or promised actions that are STILL outstanding as of the newest message. If a loop was settled or made moot by something later in the thread, either omit it or include it with status "resolved" and a "resolution_reason" explaining what settled it - never as "open".

Be conservative: only extract something if there is real evidence for it in the emails. It's fine to return empty arrays for a category if nothing qualifies.

Be SPECIFIC, not generic. For every person and project, fill in "evidence_snippet" with a concrete, specific detail pulled from the actual email text (a real thing that was said, asked, decided, or promised) - not a vague restatement like "discussed work matters". If you genuinely can't find a specific detail, leave it null rather than inventing one.`;
}

// Extraction and reconciliation both require multi-hop reasoning over long
// threads (spotting that a late rejection invalidates an earlier promise),
// which gpt-4o-mini is unreliable at. Overridable so a full run on a large
// mailbox can be done more cheaply if needed.
const MODEL = process.env.ROZE_MODEL || "gpt-4o";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing OPENAI_API_KEY. Copy .env.example to .env and fill in your OpenAI API key."
    );
  }
  client = new OpenAI({ apiKey });
  return client;
}

/**
 * Sends one batch of rendered email-thread text to the model and returns
 * the structured extraction (people/projects/interests/open_loops).
 */
export async function extractFromBatch(
  batchText: string,
  accountOwnerEmail?: string | null
): Promise<ExtractionResult> {
  const openai = getClient();

  const completion = await openai.beta.chat.completions.parse({
    model: MODEL,
    messages: [
      { role: "system", content: buildSystemPrompt(accountOwnerEmail) },
      { role: "user", content: batchText },
    ],
    response_format: zodResponseFormat(ExtractionSchema, "email_extraction"),
  });

  const parsed = completion.choices[0]?.message?.parsed;
  if (!parsed) {
    throw new Error("OpenAI returned no parsed extraction for this batch.");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Reconciliation pass
// ---------------------------------------------------------------------------

const ReconciliationSchema = z.object({
  loops_to_resolve: z.array(
    z.object({
      id: z.number().describe("The numeric id of the open loop to close."),
      reason: z
        .string()
        .describe(
          "Why this loop is no longer outstanding, referencing the specific evidence elsewhere in the memory that settles it."
        ),
    })
  ),
  projects_to_close: z.array(
    z.object({
      id: z.number().describe("The numeric id of the project to close."),
      status: z.enum(["completed", "cancelled", "stalled"]),
      outcome: z
        .string()
        .describe("How and why this project ended, citing the deciding evidence."),
    })
  ),
});

export type ReconciliationResult = z.infer<typeof ReconciliationSchema>;

const RECONCILE_SYSTEM_PROMPT = `You are auditing a personal memory "brain" that was assembled from someone's email history in independent batches. Because each batch was analyzed in isolation, the brain can contain stale entries: an open loop created from an early email may already have been settled by evidence that lived in a different batch, and a project may still be marked active even though it has clearly ended.

Your job is to find those contradictions by looking at the WHOLE brain at once.

Close an open loop when other entries in the brain show it is no longer outstanding - most importantly when it was made MOOT rather than actually done. For example: if a loop says the user owes someone a submission, and a project or another entry shows that effort was rejected, cancelled, or otherwise ended, then that loop is moot and must be closed.

Close a project when the evidence shows it reached a terminal state: 'completed' if it achieved its endpoint, 'cancelled' if it ended without completing (rejection, called off, decided against), 'stalled' if it clearly went dormant with no resolution.

Be conservative and evidence-driven. Only act when the brain itself contains the justification - never speculate, and never close something merely because it is old. Cite the specific evidence in your reason/outcome text. If nothing needs changing, return empty arrays.`;

/**
 * Second pass over the fully assembled brain. Individual extraction batches
 * can't see each other, so a commitment recorded from one thread is never
 * closed by a resolution that appeared in a different batch. This pass looks
 * at the whole brain at once and reports the contradictions to fix.
 */
export async function reconcileBrain(
  brainContext: string
): Promise<ReconciliationResult> {
  const openai = getClient();

  const completion = await openai.beta.chat.completions.parse({
    model: MODEL,
    messages: [
      { role: "system", content: RECONCILE_SYSTEM_PROMPT },
      { role: "user", content: brainContext },
    ],
    response_format: zodResponseFormat(ReconciliationSchema, "brain_reconciliation"),
  });

  const parsed = completion.choices[0]?.message?.parsed;
  if (!parsed) {
    throw new Error("OpenAI returned no parsed reconciliation result.");
  }
  return parsed;
}

/**
 * Answers a single query against the formatted brain context in one trip.
 */
export async function answerQuery(
  brainContext: string,
  query: string
): Promise<string> {
  const openai = getClient();

  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content: `You are the user's personal memory assistant. Answer the user's question using ONLY the structured memory below about people, projects, interests, and open loops. This memory is a distilled summary of the user's email history, not a full email log or index - it does not contain every individual message, subject line, or exact send time, only durable facts extracted from batches of emails. For a person, "last email evidence" is the latest date they genuinely appeared as a sender/recipient of an email - a real interaction date. For a project, "last email evidence" is only an approximate date (the newest email seen in the batch of threads that project was extracted from), since projects aren't tied to a single counterparty; don't state it with the same confidence as a person's interaction date. Neither is necessarily the single most recent email in the whole mailbox.

Pay close attention to whether things have ENDED. A project marked [completed] or [cancelled] is over, and its "outcome" field says how it ended - if asked what's left to do on such a project, the correct answer is that nothing is, and you should say why, citing the outcome. Likewise, loops listed under "Resolved" are settled, not pending; never present a resolved loop as something the user still owes. Do not invent remaining work for an effort the memory shows is finished.

Be as SPECIFIC as the memory allows: name the actual person/project/topic, cite the actual date(s) and evidence snippets given below verbatim rather than paraphrasing them away, and prefer concrete details over vague summaries (e.g. instead of "you discussed a meeting", say what the meeting was about and when, if that detail is present below). Do not hedge with phrases like "likely" or "probably" about facts that are directly stated in the memory (e.g. names are given exactly - don't guess who someone is).

If the question requires information this memory doesn't contain (e.g. the literal most recent email in the entire inbox, or something with no matching entry below), do NOT guess. Instead: (1) state briefly and plainly that this memory holds distilled facts rather than individual emails, and (2) immediately offer the closest relevant thing you DO have from the memory below - for example, if asked about a specific email with someone, give what you know about that person and the most recent interaction date you have for them; if asked about an unknown topic, name the closest related interests or projects that are present. Always end up somewhere useful rather than just declining.\n\n${brainContext}`,
      },
      { role: "user", content: query },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() ?? "(no answer returned)";
}
