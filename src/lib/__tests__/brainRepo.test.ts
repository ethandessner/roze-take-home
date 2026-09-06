import { beforeEach, describe, expect, it } from "vitest";
import { _resetDbForTests } from "../db.js";
import {
  upsertOpenLoop,
  loadFullBrain,
  upsertInterest,
  upsertPerson,
  upsertProject,
  resolveOpenLoopById,
  closeProjectById,
} from "../brainRepo.js";

beforeEach(() => {
  _resetDbForTests();
});

describe("upsertPerson", () => {
  it("dedupes by case-insensitive email and merges notes/context", () => {
    upsertPerson({
      name: "Alice",
      email: "alice@example.com",
      relationship_context: "Coworker",
      notes: "Works on backend",
    });
    upsertPerson({
      name: "Alice Smith",
      email: "Alice@Example.com",
      notes: "Likes hiking",
    });

    const brain = loadFullBrain();
    expect(brain.people).toHaveLength(1);
    expect(brain.people[0].notes).toContain("Works on backend");
    expect(brain.people[0].notes).toContain("Likes hiking");
  });

  it("dedupes by case-insensitive name when no email is given", () => {
    upsertPerson({ name: "Bob", email: null, relationship_context: "Friend" });
    upsertPerson({ name: "bob", email: null, notes: "Plays guitar" });

    const brain = loadFullBrain();
    expect(brain.people).toHaveLength(1);
  });
});

describe("upsertProject", () => {
  it("merges participants across calls for the same project name", () => {
    upsertProject({
      name: "Website Redesign",
      description: "Revamp marketing site",
      status: "active",
      participants: ["alice@example.com"],
    });
    upsertProject({ name: "website redesign", participants: ["bob@example.com"] });

    const brain = loadFullBrain();
    expect(brain.projects).toHaveLength(1);
    expect([...brain.projects[0].participants].sort()).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
  });

  it("records the outcome when a project ends", () => {
    upsertProject({ name: "July Take Home", status: "active" });
    upsertProject({
      name: "july take home",
      status: "rejected",
      outcome: "July moved forward with other candidates (Wells, Aug 25)",
    });

    const brain = loadFullBrain();
    expect(brain.projects[0].status).toBe("rejected");
    expect(brain.projects[0].outcome).toContain("other candidates");
  });

  it("does not revive a terminal project when an out-of-order batch still sees it active", () => {
    upsertProject({
      name: "July Take Home",
      status: "rejected",
      outcome: "Rejected on Aug 25",
    });
    upsertProject({ name: "july take home", status: "active" });

    const brain = loadFullBrain();
    expect(brain.projects[0].status).toBe("rejected");
    expect(brain.projects[0].outcome).toBe("Rejected on Aug 25");
  });

  // The whole point of this status: submitting and being turned down after
  // review is a materially different outcome from cancelling something
  // outright, and reporting the wrong one to the user misrepresents what
  // actually happened (this is the bug the user caught in practice).
  it("distinguishes 'rejected' (submitted, then turned down) from 'cancelled' (called off)", () => {
    upsertProject({
      name: "July Take Home",
      status: "rejected",
      outcome: "Submitted the assignment; Wells decided not to move forward after review.",
    });
    upsertProject({ name: "Side Project", status: "cancelled", outcome: "Never got started." });

    const brain = loadFullBrain();
    const july = brain.projects.find((p) => p.name === "July Take Home");
    const side = brain.projects.find((p) => p.name === "Side Project");
    expect(july?.status).toBe("rejected");
    expect(side?.status).toBe("cancelled");
  });
});

describe("upsertInterest", () => {
  it("increments frequency score on repeated topic", () => {
    upsertInterest({ topic: "Kubernetes", category: "tool", evidence_snippet: "discussed k8s migration" });
    upsertInterest({ topic: "kubernetes", category: "tool" });

    const brain = loadFullBrain();
    expect(brain.interests).toHaveLength(1);
    expect(brain.interests[0].frequencyScore).toBe(2);
  });
});

describe("upsertOpenLoop", () => {
  it("does not duplicate an identical open loop description", () => {
    upsertOpenLoop({ description: "Send contract redline to legal", status: "open", owner: "me" });
    upsertOpenLoop({ description: "send contract redline to legal", status: "open" });

    const brain = loadFullBrain();
    expect(brain.openLoops).toHaveLength(1);
  });

  it("closes an existing open loop when a later batch reports it resolved", () => {
    upsertOpenLoop({ description: "Send contract redline to legal", status: "open" });
    upsertOpenLoop({ description: "send contract redline to legal", status: "resolved" });

    const brain = loadFullBrain();
    expect(brain.openLoops).toHaveLength(1);
    expect(brain.openLoops[0].status).toBe("resolved");
  });

  it("does not reopen a resolved loop when an out-of-order batch still sees it as open", () => {
    upsertOpenLoop({ description: "Send contract redline to legal", status: "resolved" });
    upsertOpenLoop({ description: "send contract redline to legal", status: "open" });

    const brain = loadFullBrain();
    expect(brain.openLoops).toHaveLength(1);
    expect(brain.openLoops[0].status).toBe("resolved");
  });

  it("stores why a loop was resolved", () => {
    upsertOpenLoop({ description: "Push final changes", status: "open" });
    upsertOpenLoop({
      description: "push final changes",
      status: "resolved",
      resolution_reason: "moot: candidacy rejected Aug 25",
    });

    const brain = loadFullBrain();
    expect(brain.openLoops[0].resolutionReason).toBe("moot: candidacy rejected Aug 25");
  });
});

// The reconciliation pass exists because each extraction batch is analyzed in
// isolation, so a loop created from one thread is never closed by a
// resolution that appeared in a different batch.
describe("reconciliation writes", () => {
  it("closes a stale open loop and reports that it changed something", () => {
    upsertOpenLoop({ description: "Push final changes", status: "open" });
    const id = loadFullBrain().openLoops[0].id;

    expect(resolveOpenLoopById(id, "moot: candidacy rejected")).toBe(true);

    const brain = loadFullBrain();
    expect(brain.openLoops[0].status).toBe("resolved");
    expect(brain.openLoops[0].resolutionReason).toBe("moot: candidacy rejected");
  });

  it("reports no change when the loop was already resolved", () => {
    upsertOpenLoop({ description: "Push final changes", status: "resolved" });
    const id = loadFullBrain().openLoops[0].id;

    expect(resolveOpenLoopById(id, "some other reason")).toBe(false);
  });

  it("closes an active project with an outcome", () => {
    upsertProject({ name: "July Take Home", status: "active" });
    const id = loadFullBrain().projects[0].id;

    expect(closeProjectById(id, "rejected", "Rejected Aug 25")).toBe(true);

    const brain = loadFullBrain();
    expect(brain.projects[0].status).toBe("rejected");
    expect(brain.projects[0].outcome).toBe("Rejected Aug 25");
  });

  it("won't overwrite a project that already reached a terminal state", () => {
    upsertProject({
      name: "July Take Home",
      status: "completed",
      outcome: "Shipped it",
    });
    const id = loadFullBrain().projects[0].id;

    expect(closeProjectById(id, "rejected", "Rejected Aug 25")).toBe(false);
    expect(loadFullBrain().projects[0].outcome).toBe("Shipped it");
  });
});
