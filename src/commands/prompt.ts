import { loadFullBrain, formatBrainAsContext } from "../lib/brainRepo.js";
import { answerQuery } from "../lib/extract.js";

export async function runPrompt(query: string): Promise<void> {
  if (!query?.trim()) {
    throw new Error("Please provide a non-empty query, e.g. `roze prompt \"What is Alex working on?\"`.");
  }

  const brain = loadFullBrain();
  if (!brain.meta.last_generated_at) {
    throw new Error("No brain has been generated yet. Run `roze generate` first.");
  }

  const context = formatBrainAsContext(brain);
  const answer = await answerQuery(context, query.trim());
  console.log(answer);
}
