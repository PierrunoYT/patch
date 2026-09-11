import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AskEditStrategy,
  ChatSummary,
  CoderSession,
  FakeProvider,
  type ChatMessage,
} from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "patch-summary-"));
  directories.push(directory);
  return directory;
}

/** One token per word keeps the split arithmetic readable in assertions. */
const countTokens = (messages: readonly ChatMessage[]): number =>
  messages.reduce(
    (total, message) =>
      total +
      (typeof message.content === "string"
        ? message.content.split(/\s+/u).filter(Boolean).length
        : 0),
    0,
  );

function conversation(pairs: number): ChatMessage[] {
  return Array.from({ length: pairs }, (_unused, index) => index).flatMap(
    (index): ChatMessage[] => [
      { role: "user", content: `question ${index} ${"word ".repeat(9)}` },
      { role: "assistant", content: `answer ${index} ${"word ".repeat(9)}` },
    ],
  );
}

describe("ChatSummary", () => {
  it("leaves history alone until it exceeds the budget", async () => {
    let calls = 0;
    const summary = new ChatSummary({
      maxTokens: 100,
      countTokens,
      send: async () => {
        calls += 1;
        return "a summary";
      },
    });
    const short = conversation(2);

    expect(summary.tooBig(short)).toBe(false);
    expect(await summary.summarize(short)).toEqual(short);
    expect(calls).toBe(0);
  });

  it("summarizes the older half and keeps recent messages verbatim", async () => {
    const sent: ChatMessage[][] = [];
    const summary = new ChatSummary({
      maxTokens: 60,
      countTokens,
      send: async (messages) => {
        sent.push([...messages]);
        return "you asked about earlier things";
      },
    });
    const long = conversation(6);

    expect(summary.tooBig(long)).toBe(true);
    const result = await summary.summarize(long);

    // The summary replaces the head and the recent tail survives unchanged.
    expect(result[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("you asked about earlier things"),
    });
    expect(result.at(-2)).toEqual(long.at(-2));
    expect(result.at(-1)).toEqual(long.at(-1));
    expect(result.length).toBeLessThan(long.length);
    // What was summarized was rendered as a labelled transcript.
    const asked = sent[0]?.at(-1);
    expect(asked?.content).toContain("# USER");
    expect(asked?.content).toContain("# ASSISTANT");
    expect(asked?.content).toContain("question 0");
  });

  it("ends on an assistant message so the next user turn is not doubled", async () => {
    const summary = new ChatSummary({
      maxTokens: 1,
      countTokens,
      send: async () => "a summary",
    });

    const result = await summary.summarize(conversation(1));

    expect(result.at(-1)).toEqual({ role: "assistant", content: "Ok." });
  });
});

describe("a session with long completed history", () => {
  it("summarizes before the turn and survives a failing summarizer", async () => {
    const root = await temporaryDirectory();
    const history = conversation(6);
    const build = (summarize: () => Promise<readonly ChatMessage[]>) =>
      new CoderSession({
        config: {
          root,
          model: {
            name: "test/model",
            provider: "fake",
            editFormat: "ask",
            maxChatHistoryTokens: 20,
          },
        },
        provider: new FakeProvider([
          {
            actions: [
              { type: "text-delta", text: "answered" },
              { type: "finish", reason: "stop" },
            ],
          },
        ]),
        strategy: new AskEditStrategy(),
        messages: history,
        summarizeHistory: summarize,
      });

    const summarized = build(async () => [
      { role: "user", content: "I spoke to you previously." },
      { role: "assistant", content: "Ok." },
    ]);
    await summarized.runTurn("next question");
    expect(summarized.snapshot().messages.slice(0, 2)).toEqual([
      { role: "user", content: "I spoke to you previously." },
      { role: "assistant", content: "Ok." },
    ]);

    // Losing a summary is recoverable; failing the turn over it is not.
    const failed = build(async () => {
      throw new Error("weak model unavailable");
    });
    await expect(failed.runTurn("next question")).resolves.toMatchObject({
      response: "answered",
    });
    expect(failed.snapshot().messages.slice(0, 2)).toEqual(history.slice(0, 2));
  });
});
