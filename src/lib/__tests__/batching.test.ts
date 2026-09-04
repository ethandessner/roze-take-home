import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "../gmail.js";
import { computeLastInteractionByEmail, latestDateInThreads } from "../batching.js";

function msg(overrides: Partial<ParsedMessage>): ParsedMessage {
  return {
    id: "id",
    threadId: "t",
    from: "someone@example.com",
    to: "me@example.com",
    subject: "subject",
    date: "2024-01-01T00:00:00Z",
    bodyText: "",
    ...overrides,
  };
}

describe("computeLastInteractionByEmail", () => {
  it("only credits a person with the latest date they actually appear as sender/recipient, not the whole batch max", () => {
    const threads: ParsedMessage[][] = [
      // Thread involving Wells - older
      [msg({ threadId: "t1", from: "Wells Douraghy <wells@withjuly.com>", to: "me@example.com", date: "2024-01-01T00:00:00Z" })],
      // Unrelated thread in the same batch - much newer, doesn't involve Wells
      [msg({ threadId: "t2", from: "someone-else@example.com", to: "me@example.com", date: "2024-06-01T00:00:00Z" })],
    ];

    const result = computeLastInteractionByEmail(threads);
    expect(result.get("wells@withjuly.com")).toBe(new Date("2024-01-01T00:00:00Z").toISOString());
    expect(result.get("wells@withjuly.com")).not.toBe(
      new Date("2024-06-01T00:00:00Z").toISOString()
    );
  });

  it("takes the max date across multiple messages involving the same person", () => {
    const threads: ParsedMessage[][] = [
      [
        msg({ threadId: "t1", from: "a@example.com", to: "me@example.com", date: "2024-01-01T00:00:00Z" }),
        msg({ threadId: "t1", from: "me@example.com", to: "a@example.com", date: "2024-02-01T00:00:00Z" }),
      ],
    ];

    const result = computeLastInteractionByEmail(threads);
    expect(result.get("a@example.com")).toBe(new Date("2024-02-01T00:00:00Z").toISOString());
  });
});

describe("latestDateInThreads", () => {
  it("returns the overall max date across the whole batch (coarse, batch-level signal)", () => {
    const threads: ParsedMessage[][] = [
      [msg({ date: "2024-01-01T00:00:00Z" })],
      [msg({ date: "2024-06-01T00:00:00Z" })],
    ];

    expect(latestDateInThreads(threads)).toBe(new Date("2024-06-01T00:00:00Z").toISOString());
  });
});
