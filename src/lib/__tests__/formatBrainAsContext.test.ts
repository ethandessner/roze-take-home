import { describe, expect, it } from "vitest";
import { formatBrainAsContext, type Brain } from "../brainRepo.js";

describe("formatBrainAsContext", () => {
  it("renders all four labeled sections with their entries", () => {
    const brain: Brain = {
      people: [
        {
          id: 1,
          name: "Alice",
          email: "alice@example.com",
          relationshipContext: "Coworker",
          lastInteractedAt: null,
          notes: null,
          evidenceSnippet: null,
        },
      ],
      projects: [
        {
          id: 1,
          name: "Redesign",
          description: "New site",
          status: "active",
          participants: ["Alice"],
          lastActivityAt: null,
          evidenceSnippet: null,
          outcome: null,
        },
      ],
      interests: [
        {
          id: 1,
          topic: "Kubernetes",
          category: "tool",
          evidenceSnippet: null,
          frequencyScore: 3,
        },
      ],
      openLoops: [
        {
          id: 1,
          description: "Send redline",
          status: "open",
          resolutionReason: null,
          owner: "me",
          relatedPeople: [],
          dueHint: null,
          sourceThreadId: null,
        },
      ],
      meta: {},
    };

    const text = formatBrainAsContext(brain);
    expect(text).toContain("## People");
    expect(text).toContain("Alice <alice@example.com>");
    expect(text).toContain("## Projects");
    expect(text).toContain("Redesign [active]");
    expect(text).toContain("## Interests");
    expect(text).toContain("Kubernetes (tool, mentioned 3x)");
    expect(text).toContain("## Open Loops");
    expect(text).toContain("Send redline");
  });

  it("renders a real last-interacted date when present, as a plain date (not the generate run time)", () => {
    const brain: Brain = {
      people: [
        {
          id: 1,
          name: "Bob",
          email: null,
          relationshipContext: null,
          lastInteractedAt: "2024-03-15T10:00:00.000Z",
          notes: null,
          evidenceSnippet: null,
        },
      ],
      projects: [],
      interests: [],
      openLoops: [],
      meta: {},
    };

    const text = formatBrainAsContext(brain);
    expect(text).toContain("last email evidence: 2024-03-15");
  });

  it("renders concrete evidence snippets for people and projects when present", () => {
    const brain: Brain = {
      people: [
        {
          id: 1,
          name: "Carol",
          email: null,
          relationshipContext: "Client",
          lastInteractedAt: null,
          notes: null,
          evidenceSnippet: "asked to move the kickoff to Thursday",
        },
      ],
      projects: [
        {
          id: 1,
          name: "Contract Renewal",
          description: null,
          status: "active",
          participants: [],
          lastActivityAt: null,
          evidenceSnippet: "waiting on legal's redline before signing",
          outcome: null,
        },
      ],
      interests: [],
      openLoops: [],
      meta: {},
    };

    const text = formatBrainAsContext(brain);
    expect(text).toContain('evidence: "asked to move the kickoff to Thursday"');
    expect(text).toContain('evidence: "waiting on legal\'s redline before signing"');
  });

  it("separates resolved loops from outstanding ones, with the reason they closed", () => {
    const brain: Brain = {
      people: [],
      projects: [],
      interests: [],
      openLoops: [
        {
          id: 1,
          description: "Send the take-home submission",
          status: "resolved",
          resolutionReason: "moot: July rejected the candidacy on Aug 25",
          owner: null,
          relatedPeople: [],
          dueHint: null,
          sourceThreadId: null,
        },
        {
          id: 2,
          description: "Reply to Arijit about the role",
          status: "open",
          resolutionReason: null,
          owner: null,
          relatedPeople: [],
          dueHint: null,
          sourceThreadId: null,
        },
      ],
      meta: {},
    };

    const text = formatBrainAsContext(brain);
    const outstanding = text.indexOf("Open Loops (still outstanding)");
    const resolvedSection = text.indexOf("Resolved (NOT outstanding");

    // The open loop must appear under "outstanding" and the resolved one
    // after it, so the answering model can't mistake a settled commitment
    // for something the user still owes.
    expect(outstanding).toBeGreaterThan(-1);
    expect(resolvedSection).toBeGreaterThan(outstanding);
    expect(text.indexOf("Reply to Arijit about the role")).toBeLessThan(resolvedSection);
    expect(text.indexOf("Send the take-home submission")).toBeGreaterThan(resolvedSection);
    expect(text).toContain("resolved because: moot: July rejected the candidacy on Aug 25");
  });
});
