import { describe, expect, it } from "vitest";
import type { gmail_v1 } from "googleapis";
import { groupByThread, parseMessage, type ParsedMessage } from "../gmail.js";

function b64url(text: string): string {
  return Buffer.from(text, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

describe("parseMessage", () => {
  it("decodes headers and a text/plain body", () => {
    const msg: gmail_v1.Schema$Message = {
      id: "m1",
      threadId: "t1",
      payload: {
        headers: [
          { name: "From", value: "alice@example.com" },
          { name: "To", value: "me@example.com" },
          { name: "Subject", value: "Hello" },
          { name: "Date", value: "2024-01-01T00:00:00Z" },
        ],
        mimeType: "text/plain",
        body: { data: b64url("Hi there, let's sync tomorrow.") },
      },
    };

    const parsed = parseMessage(msg);
    expect(parsed.from).toBe("alice@example.com");
    expect(parsed.subject).toBe("Hello");
    expect(parsed.bodyText).toContain("let's sync tomorrow");
  });

  it("prefers text/plain over text/html in a multipart message", () => {
    const msg: gmail_v1.Schema$Message = {
      id: "m2",
      threadId: "t1",
      payload: {
        headers: [{ name: "Subject", value: "Multi" }],
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/html", body: { data: b64url("<p>Hi <b>there</b></p>") } },
          { mimeType: "text/plain", body: { data: b64url("Plain body text") } },
        ],
      },
    };

    const parsed = parseMessage(msg);
    expect(parsed.bodyText).toBe("Plain body text");
  });

  it("falls back to stripped HTML when only text/html is present", () => {
    const msg: gmail_v1.Schema$Message = {
      id: "m3",
      threadId: "t1",
      payload: {
        headers: [],
        mimeType: "text/html",
        body: { data: b64url("<div>Hello <strong>World</strong></div>") },
      },
    };

    const parsed = parseMessage(msg);
    expect(parsed.bodyText).toBe("Hello World");
  });
});

describe("groupByThread", () => {
  it("groups messages by threadId and sorts each thread chronologically", () => {
    const messages: ParsedMessage[] = [
      { id: "1", threadId: "t1", from: "a", to: "b", subject: "s", date: "2024-01-02T00:00:00Z", bodyText: "" },
      { id: "2", threadId: "t1", from: "a", to: "b", subject: "s", date: "2024-01-01T00:00:00Z", bodyText: "" },
      { id: "3", threadId: "t2", from: "a", to: "b", subject: "s2", date: "2024-01-01T00:00:00Z", bodyText: "" },
    ];

    const threads = groupByThread(messages);
    expect(threads.size).toBe(2);
    expect(threads.get("t1")?.map((m) => m.id)).toEqual(["2", "1"]);
    expect(threads.get("t2")?.map((m) => m.id)).toEqual(["3"]);
  });
});
