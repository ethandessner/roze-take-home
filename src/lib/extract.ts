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
    .enum(["active", "completed", "stalled", "cancelled", "rejected"])
    .describe(
      "The state of this project AS OF THE NEWEST MESSAGE about it. 'completed' = the user's side succeeded and was accepted/achieved its goal. 'rejected' = the user did their part (applied, submitted, pitched, proposed) and the OTHER PARTY reviewed it and said no - a job application, take-home, or proposal that was turned down. 'cancelled' = the effort was called off or abandoned BEFORE being carried through - by either side, for reasons other than a review-and-reject. 'stalled' = went quiet with no resolution. 'active' = genuinely still in motion. Do not use 'cancelled' for a rejection after review - that is 'rejected'."
    ),
  outcome: z
    .string()
    .nullable()
    .describe(
      "If the project has ENDED, state plainly how and why, quoting or closely paraphrasing the deciding message - e.g. 'July decided to move forward with other candidates (Wells, Aug 25)'. Leave null only if the project is genuinely still active or stalled."
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
    // Extraction and reconciliation are auditing tasks, not creative ones -
    // the same mailbox should yield the same brain. At default sampling the
    // reconciliation pass flip-flopped between marking a rejected project
    // 'completed' and 'cancelled' across otherwise identical runs.
    temperature: 0,
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
      status: z.enum(["completed", "cancelled", "rejected", "stalled"]),
      outcome: z
        .string()
        .describe("How and why this project ended, citing the deciding evidence."),
    })
  ),
});

export type ReconciliationResult = z.infer<typeof ReconciliationSchema>;

const RECONCILE_SYSTEM_PROMPT = `You are auditing a personal memory "brain" that was assembled from someone's email history in independent batches. Because each batch was analyzed in isolation, the brain can contain stale entries: an open loop created from an early email may already have been settled by evidence that lived in a different batch, and a project may still be marked active even though it has clearly ended.

Your job is to find those contradictions by looking at the WHOLE brain at once.

CRITICAL - THE SAME THING OFTEN APPEARS MORE THAN ONCE UNDER DIFFERENT WORDING. Entries were created by independent batches that could not see each other and did not agree on names, so one real-world effort is frequently split across several projects, and one real commitment across several loops. Entries are matched by exact text, so near-duplicates were never merged. Treat entries that clearly describe the same underlying effort, job, application, event, or commitment as THE SAME THING even when the names differ (for example "Assignment Project for X", "Job Application with X", and a repository named after that same take-home are all one effort).

This matters most for propagating endings: if ANY entry for an effort shows it ended - a rejection, cancellation, or decision - then EVERY other entry describing that same effort has also ended, and every loop that only existed to serve it is moot. Close all of them, not just the one that happens to carry the outcome text. A loop about finishing, submitting, or following up on work is moot once the effort it served was rejected or called off, even if the loop's wording never mentions the rejection.

Close an open loop when other entries in the brain show it is no longer outstanding - most importantly when it was made MOOT rather than actually done.

APPLY YOUR OWN CONCLUSIONS BEFORE JUDGING LOOPS. The statuses you are shown are the stale "before" picture. Decide which projects you are closing first, then evaluate every loop against that UPDATED picture - not the stale one. If you are closing a project in this same response, then any loop that existed only to serve that project is moot and must be closed in this same response too. Do not leave a loop open on the grounds that its project "is still active" when you yourself are about to cancel that project. Work the consequences all the way through: closing an effort closes the work items that fed it.

Close a project when the evidence shows it reached a terminal state: 'completed' if the user's side succeeded and was accepted, 'rejected' if the user did their part (applied, submitted, pitched) and the other party reviewed it and said no, 'cancelled' if it was called off or abandoned before being carried through (not a review-and-reject), 'stalled' if it clearly went dormant with no resolution.

When more than one candidate ending exists, choose the LATEST and most DECISIVE one. An outside decision outranks the user's own progress: the user finishing their part of the work is NOT the ending if the other party subsequently rejected it. That is 'rejected', not 'completed' and not 'cancelled' - the user didn't cancel anything, they were turned down after review. The outcome must name the rejection rather than the work the user finished. Delivering your side of something that was then turned down is not success, and describing it as 'completed' or 'cancelled' would misrepresent what actually happened.

RESOLVING IS NOT DEDUPLICATING. Never close a loop merely because another entry describes the same thing - "resolved" means the commitment is genuinely settled or moot, not that it is redundant. Recognizing duplicates only helps you see that an ENDING recorded on one entry applies to its twins; it is never a reason to close a duplicate on its own. So: if duplicates describe something still outstanding, leave ALL of them open. If they describe something settled, close ALL of them. Closing one copy while leaving its twin open is always wrong - it makes the memory contradict itself, and it misreports live work as finished.

Be evidence-driven: the justification must come from the brain itself, and never close something merely because it is old. But do NOT hide behind caution when the brain plainly contains the answer - failing to close a commitment that has obviously been settled is just as wrong as inventing one. Cite the specific evidence, including which other entry settles it, in your reason/outcome text. If nothing needs changing, return empty arrays.`;

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
    temperature: 0,
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

Pay close attention to whether things have ENDED. A project marked [completed], [cancelled], or [rejected] is over, and its "outcome" field says how it ended - if asked what's left to do on such a project, the correct answer is that nothing is, and you should say why, citing the outcome exactly. These three statuses mean different things and the answer must reflect which one it actually is: 'rejected' means the user did their part and the other side reviewed it and said no - do not call this "cancelled" (which means called off, not turned down after review) or "completed" (which means it succeeded). Getting this word wrong misrepresents what happened to the user. Likewise, loops listed under "Resolved" are settled, not pending; never present a resolved loop as something the user still owes. Do not invent remaining work for an effort the memory shows is finished.

Be as SPECIFIC as the memory allows: name the actual person/project/topic, cite the actual date(s) and evidence snippets given below verbatim rather than paraphrasing them away, and prefer concrete details over vague summaries (e.g. instead of "you discussed a meeting", say what the meeting was about and when, if that detail is present below). Do not hedge with phrases like "likely" or "probably" about facts that are directly stated in the memory (e.g. names are given exactly - don't guess who someone is).

If the question requires information this memory doesn't contain (e.g. the literal most recent email in the entire inbox, or something with no matching entry below), do NOT guess. Instead: (1) state briefly and plainly that this memory holds distilled facts rather than individual emails, and (2) immediately offer the closest relevant thing you DO have from the memory below - for example, if asked about a specific email with someone, give what you know about that person and the most recent interaction date you have for them; if asked about an unknown topic, name the closest related interests or projects that are present. Always end up somewhere useful rather than just declining.\n\n${brainContext}`,
      },
      { role: "user", content: query },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() ?? "(no answer returned)";
}
