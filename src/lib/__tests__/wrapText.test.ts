import { describe, expect, it } from "vitest";
import { wrapText } from "../../commands/prompt.js";

describe("wrapText", () => {
  it("leaves lines shorter than the width untouched", () => {
    expect(wrapText("short line", 40)).toBe("short line");
  });

  it("wraps a long line so no output line exceeds the width", () => {
    const long =
      "A website aimed at showcasing awarded projects or achievements. Participants include Mia Tilly. Last email evidence: 2026-08-25.";

    const wrapped = wrapText(long, 60);

    expect(wrapped.split("\n").length).toBeGreaterThan(1);
    for (const line of wrapped.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it("preserves all words when wrapping", () => {
    const long = "one two three four five six seven eight nine ten eleven twelve";
    const wrapped = wrapText(long, 20);
    expect(wrapped.replace(/\s+/g, " ").trim()).toBe(long);
  });

  it("indents continuation lines of numbered list items to align under the text", () => {
    const item =
      "1. **Job Search [active]**: You are looking for a new engineering role, with participants including Ethan Dessner.";

    const lines = wrapText(item, 50).split("\n");

    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].startsWith("1. ")).toBe(true);
    // Continuation lines are indented, not flush against the left margin.
    expect(lines[1].startsWith("   ")).toBe(true);
  });

  it("preserves existing blank lines and paragraph structure", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    expect(wrapText(text, 80)).toBe(text);
  });
});
