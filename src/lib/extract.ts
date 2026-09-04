import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const PersonSchema = z.object({
  name: z.string(),
  email: z.string().nullable(),
  relationship_context: z.string().nullable(),
  notes: z.string().nullable(),
});

const ProjectSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(["active", "completed", "stalled"]),
  participants: z.array(z.string()),
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

const SYSTEM_PROMPT = `You are analyzing a batch of a person's email threads to build a durable personal memory ("brain") for an AI assistant.

Extract ONLY durable, meaningful information. Explicitly SKIP newsletters, marketing, automated notifications, receipts, and spam - they carry no memory value.

Extract these four categories:
- people: durable context about specific individuals the user personally communicates with (colleagues, friends, clients, family). Skip generic "support@" or "no-reply" senders.
- projects: outcome-oriented efforts with a clear endpoint (work initiatives, planning something, building something). Not recurring background activities.
- interests: recurring topics, organizations, tools, hobbies, or subjects the user cares about or engages with repeatedly.
- open_loops: SPECIFICALLY unresolved commitments, follow-ups, pending decisions, or promised actions - things that are still open, not things already resolved. Only include loops that appear genuinely unresolved based on the available evidence.

Be conservative: only extract something if there is real evidence for it in the emails. It's fine to return empty arrays for a category if nothing qualifies.`;

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
  batchText: string
): Promise<ExtractionResult> {
  const openai = getClient();

  const completion = await openai.beta.chat.completions.parse({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
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
        content: `You are the user's personal memory assistant. Answer the user's question using ONLY the structured memory below about people, projects, interests, and open loops. Be concise and specific. If the answer isn't in the memory, say so plainly rather than guessing.\n\n${brainContext}`,
      },
      { role: "user", content: query },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() ?? "(no answer returned)";
}
