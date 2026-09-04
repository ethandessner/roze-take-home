#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";
import { Command } from "commander";
import { runAuth } from "./commands/auth.js";
import { runGenerate } from "./commands/generate.js";
import { runPrompt } from "./commands/prompt.js";

// Load .env from the project root (next to package.json), not from the
// current working directory — so `roze` works the same whether it's run
// from the project root, a subdirectory, or as a globally linked command.
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", ".env") });

const program = new Command();

program
  .name("roze")
  .description(
    "Personal Memory System: turn your Gmail history into a queryable brain."
  )
  .version("0.1.0");

program
  .command("auth")
  .description("Sign in with Google and grant Gmail readonly access.")
  .action(async () => {
    await runAuth();
  });

program
  .command("generate")
  .description(
    "Read your email history and generate the memory brain (people, projects, interests, open loops)."
  )
  .action(async () => {
    await runGenerate();
  });

program
  .command("prompt")
  .argument("<query>", "A single question to ask your memory brain")
  .description("Answer a single query using the generated brain.")
  .action(async (query: string) => {
    await runPrompt(query);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
