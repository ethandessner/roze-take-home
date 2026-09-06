import cliProgress from "cli-progress";
import ora from "ora";
import { getAuthedClient } from "../lib/auth.js";
import {
  getGmailClient,
  getMyEmailAddress,
  listAllMessageIds,
  getMessages,
  groupByThread,
} from "../lib/gmail.js";
import {
  chunkThreads,
  renderThreadsForExtraction,
  latestDateInThreads,
  computeLastInteractionByEmail,
} from "../lib/batching.js";
import { extractFromBatch, reconcileBrain } from "../lib/extract.js";
import {
  upsertPerson,
  upsertProject,
  upsertInterest,
  upsertOpenLoop,
  setMeta,
  loadFullBrain,
  renderBrainForReconciliation,
  resolveOpenLoopById,
  closeProjectById,
} from "../lib/brainRepo.js";

const THREADS_PER_BATCH = 15;

export interface GenerateOptions {
  /** Only process the N most recent messages (Gmail returns newest first). */
  limit?: number;
}

export async function runGenerate(options: GenerateOptions = {}): Promise<void> {
  const authClient = getAuthedClient();
  const gmail = getGmailClient(authClient);

  console.log("Reading your email history...");

  const myEmail = await getMyEmailAddress(gmail).catch(() => null);

  let ids = await listAllMessageIds(gmail);
  if (ids.length === 0) {
    console.log("No messages found in this Gmail account. Nothing to generate.");
    return;
  }

  if (options.limit && options.limit < ids.length) {
    console.log(
      `Limiting to the ${options.limit} most recent messages (of ${ids.length} total) as requested via --limit.`
    );
    ids = ids.slice(0, options.limit);
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
    const batchDate = latestDateInThreads(batches[i]);
    const lastInteractionByEmail = computeLastInteractionByEmail(batches[i]);
    try {
      const extraction = await extractFromBatch(batchText, myEmail);

      for (const person of extraction.people) {
        // Safety net in case the model still includes the account owner
        // themselves despite the system prompt telling it not to.
        if (myEmail && person.email?.trim().toLowerCase() === myEmail) continue;

        // A real "interaction" date: the latest message where this person
        // actually appears as a sender/recipient, not just the newest email
        // anywhere in the batch. Falls back to the batch date only if we
        // don't have their email to match against.
        const personDate = person.email
          ? lastInteractionByEmail.get(person.email.trim().toLowerCase()) ?? batchDate
          : batchDate;

        upsertPerson(person, personDate);
        totals.people++;
      }
      for (const project of extraction.projects) {
        upsertProject(project, batchDate);
        totals.projects++;
      }
      for (const interest of extraction.interests) {
        upsertInterest(interest);
        totals.interests++;
      }
      for (const loop of extraction.open_loops) {
        upsertOpenLoop(loop);
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

  await runReconciliation();

  setMeta("last_generated_at", new Date().toISOString());
  setMeta("total_emails_processed", String(messages.length));

  const brain = loadFullBrain();
  console.log("\nBrain generated successfully:");
  const closedProjects = brain.projects.filter(
    (p) => p.status === "completed" || p.status === "cancelled"
  ).length;
  console.log(`  People:      ${brain.people.length}`);
  console.log(
    `  Projects:    ${brain.projects.length} (${closedProjects} finished/cancelled)`
  );
  console.log(`  Interests:   ${brain.interests.length}`);
  console.log(
    `  Open loops:  ${brain.openLoops.filter((o) => o.status === "open").length} open, ${
      brain.openLoops.filter((o) => o.status === "resolved").length
    } resolved`
  );
  console.log(`  Emails processed: ${messages.length}`);
  console.log("\nRun `roze prompt \"<your question>\"` to query it.");
}

/**
 * Each extraction batch is analyzed in isolation, so a commitment recorded
 * from one thread is never closed by a resolution that showed up in a
 * different batch. This second pass looks at the assembled brain as a whole
 * and closes the contradictions it finds.
 */
async function runReconciliation(): Promise<void> {
  const spinner = ora("Reconciling the brain for stale open loops...").start();

  try {
    const brain = loadFullBrain();
    if (brain.openLoops.length === 0 && brain.projects.length === 0) {
      spinner.info("Nothing to reconcile.");
      return;
    }

    const result = await reconcileBrain(renderBrainForReconciliation(brain));

    let loopsClosed = 0;
    for (const loop of result.loops_to_resolve) {
      if (resolveOpenLoopById(loop.id, loop.reason)) loopsClosed++;
    }

    let projectsClosed = 0;
    for (const project of result.projects_to_close) {
      if (closeProjectById(project.id, project.status, project.outcome)) {
        projectsClosed++;
      }
    }

    if (loopsClosed === 0 && projectsClosed === 0) {
      spinner.succeed("Reconciled: nothing stale found.");
    } else {
      spinner.succeed(
        `Reconciled: closed ${loopsClosed} stale open loop(s) and ${projectsClosed} finished project(s).`
      );
    }
  } catch (err) {
    // A failed reconciliation shouldn't throw away a successful extraction.
    spinner.warn(
      `Reconciliation pass failed, keeping unreconciled brain: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
