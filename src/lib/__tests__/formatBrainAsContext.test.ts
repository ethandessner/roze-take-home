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
