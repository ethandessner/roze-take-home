import cliProgress from "cli-progress";
import ora from "ora";
import { getAuthedClient } from "../lib/auth.js";
import { getGmailClient, listAllMessageIds, getMessages, groupByThread } from "../lib/gmail.js";
import { chunkThreads, renderThreadsForExtraction } from "../lib/batching.js";
import { extractFromBatch } from "../lib/extract.js";
import {
  upsertPerson,
  upsertProject,
  upsertInterest,
  insertOpenLoop,
  setMeta,
  loadFullBrain,
} from "../lib/brainRepo.js";

const THREADS_PER_BATCH = 15;

export async function runGenerate(): Promise<void> {
  const authClient = getAuthedClient();
  const gmail = getGmailClient(authClient);

  console.log("Reading your email history...");

  const ids = await listAllMessageIds(gmail);
  if (ids.length === 0) {
    console.log("No messages found in this Gmail account. Nothing to generate.");
    return;
  }

  const fetchBar = new cliProgress.SingleBar({
    format: "Fetching emails  [{bar}] {value}/{total}",
    hideCursor: true,
  });
  fetchBar.start(ids.length, 0);

  const messages = await getMessages(gmail, ids, (done) => {
    fetchBar.update(done);
  });
  fetchBar.stop();

  const threadMap = groupByThread(messages);
  const threads = Array.from(threadMap.values());
  const batches = chunkThreads(threads, THREADS_PER_BATCH);

  const spinner = ora(`Analyzing batch 0/${batches.length}...`).start();

  const totals = { people: 0, projects: 0, interests: 0, openLoops: 0 };

  for (let i = 0; i < batches.length; i++) {
    spinner.text = `Analyzing batch ${i + 1}/${batches.length}...`;

    const batchText = renderThreadsForExtraction(batches[i]);
    try {
      const extraction = await extractFromBatch(batchText);

      for (const person of extraction.people) {
        upsertPerson(person);
        totals.people++;
      }
      for (const project of extraction.projects) {
        upsertProject(project);
        totals.projects++;
      }
      for (const interest of extraction.interests) {
        upsertInterest(interest);
        totals.interests++;
      }
      for (const loop of extraction.open_loops) {
        insertOpenLoop(loop);
        totals.openLoops++;
      }
    } catch (err) {
      spinner.warn(
        `Batch ${i + 1} failed, skipping: ${err instanceof Error ? err.message : String(err)}`
      );
      spinner.start();
    }
  }

  spinner.succeed(`Analyzed ${batches.length} batch(es) covering ${threads.length} threads.`);

  setMeta("last_generated_at", new Date().toISOString());
  setMeta("total_emails_processed", String(messages.length));

  const brain = loadFullBrain();
  console.log("\nBrain generated successfully:");
  console.log(`  People:      ${brain.people.length}`);
  console.log(`  Projects:    ${brain.projects.length}`);
  console.log(`  Interests:   ${brain.interests.length}`);
  console.log(`  Open loops:  ${brain.openLoops.filter((o) => o.status === "open").length} open`);
  console.log(`  Emails processed: ${messages.length}`);
  console.log("\nRun `roze prompt \"<your question>\"` to query it.");
}
