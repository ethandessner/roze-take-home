import { loadFullBrain, formatBrainAsContext } from "../lib/brainRepo.js";
import { answerQuery } from "../lib/extract.js";

const MAX_WRAP_WIDTH = 100;

/**
 * Wraps text to the terminal width so long answers stay readable in narrow
 * panes. Only applied when writing to a TTY - piped/redirected output stays
 * unwrapped so it can be processed by other tools.
 */
export function wrapText(text: string, width: number): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= width) return line;

      const indentMatch = line.match(/^(\s*(?:\d+\.|[-*])?\s*)/);
      const indent = " ".repeat(indentMatch?.[1].length ?? 0);

      const wrapped: string[] = [];
      let current = "";
      for (const word of line.split(" ")) {
        const prefix = wrapped.length === 0 ? "" : indent;
        if (current && (prefix + current + " " + word).length > width) {
          wrapped.push(current);
          current = word;
        } else {
          current = current ? `${current} ${word}` : word;
        }
      }
      if (current) wrapped.push(current);

      return wrapped
        .map((l, i) => (i === 0 ? l : indent + l))
        .join("\n");
    })
    .join("\n");
}

function wrapForTerminal(text: string): string {
  if (!process.stdout.isTTY) return text;
  return wrapText(text, Math.min(process.stdout.columns || 80, MAX_WRAP_WIDTH));
}

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
  console.log(wrapForTerminal(answer));
}
