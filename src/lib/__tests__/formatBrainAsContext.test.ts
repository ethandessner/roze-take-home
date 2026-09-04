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
          owner: "me",
          relatedPeople: [],
          relatedProjectId: null,
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

  it("omits resolved open loops from the rendered context", () => {
    const brain: Brain = {
      people: [],
      projects: [],
      interests: [],
      openLoops: [
        {
          id: 1,
          description: "Old resolved thing",
          status: "resolved",
          owner: null,
          relatedPeople: [],
          relatedProjectId: null,
          dueHint: null,
          sourceThreadId: null,
        },
      ],
      meta: {},
    };

    const text = formatBrainAsContext(brain);
    expect(text).not.toContain("Old resolved thing");
  });
});
