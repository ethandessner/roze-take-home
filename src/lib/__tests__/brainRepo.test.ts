import { beforeEach, describe, expect, it } from "vitest";
import { _resetDbForTests } from "../db.js";
import {
  insertOpenLoop,
  loadFullBrain,
  upsertInterest,
  upsertPerson,
  upsertProject,
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

describe("insertOpenLoop", () => {
  it("does not duplicate an identical open loop description", () => {
    insertOpenLoop({ description: "Send contract redline to legal", status: "open", owner: "me" });
    insertOpenLoop({ description: "send contract redline to legal", status: "open" });

    const brain = loadFullBrain();
    expect(brain.openLoops).toHaveLength(1);
  });
});
