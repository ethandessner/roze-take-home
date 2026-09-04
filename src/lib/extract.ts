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
  status: z.enum(["active", "completed", "stalled"]),
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
  status: z.enum(["open", "resolved"]),
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

Extract these four categories:
- people: durable context about specific individuals the user personally communicates with (colleagues, friends, clients, family) - never the user themselves. Skip generic "support@" or "no-reply" senders.
- projects: outcome-oriented efforts with a clear endpoint (work initiatives, planning something, building something). Not recurring background activities.
- interests: recurring topics, organizations, tools, hobbies, or subjects the user cares about or engages with repeatedly.
- open_loops: SPECIFICALLY unresolved commitments, follow-ups, pending decisions, or promised actions - things that are still open, not things already resolved. Only include loops that appear genuinely unresolved based on the available evidence.

Be conservative: only extract something if there is real evidence for it in the emails. It's fine to return empty arrays for a category if nothing qualifies.

Be SPECIFIC, not generic. For every person and project, fill in "evidence_snippet" with a concrete, specific detail pulled from the actual email text (a real thing that was said, asked, decided, or promised) - not a vague restatement like "discussed work matters". If you genuinely can't find a specific detail, leave it null rather than inventing one.`;
}

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
    model: "gpt-4o-mini",
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

/**
 * Answers a single query against the formatted brain context in one trip.
 */
export async function answerQuery(
  brainContext: string,
  query: string
): Promise<string> {
  const openai = getClient();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are the user's personal memory assistant. Answer the user's question using ONLY the structured memory below about people, projects, interests, and open loops. This memory is a distilled summary of the user's email history, not a full email log or index - it does not contain every individual message, subject line, or exact send time, only durable facts extracted from batches of emails. For a person, "last email evidence" is the latest date they genuinely appeared as a sender/recipient of an email - a real interaction date. For a project, "last email evidence" is only an approximate date (the newest email seen in the batch of threads that project was extracted from), since projects aren't tied to a single counterparty; don't state it with the same confidence as a person's interaction date. Neither is necessarily the single most recent email in the whole mailbox.

Be as SPECIFIC as the memory allows: name the actual person/project/topic, cite the actual date(s) and evidence snippets given below verbatim rather than paraphrasing them away, and prefer concrete details over vague summaries (e.g. instead of "you discussed a meeting", say what the meeting was about and when, if that detail is present below). Do not hedge with phrases like "likely" or "probably" about facts that are directly stated in the memory (e.g. names are given exactly - don't guess who someone is).

If the question requires information this memory doesn't contain (e.g. the literal most recent email in the entire inbox, or something with no matching entry below), do NOT guess. Instead: (1) state briefly and plainly that this memory holds distilled facts rather than individual emails, and (2) immediately offer the closest relevant thing you DO have from the memory below - for example, if asked about a specific email with someone, give what you know about that person and the most recent interaction date you have for them; if asked about an unknown topic, name the closest related interests or projects that are present. Always end up somewhere useful rather than just declining.\n\n${brainContext}`,
      },
      { role: "user", content: query },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() ?? "(no answer returned)";
}
