import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AskEditStrategy,
  CoderSession,
  FakeProvider,
  ReasoningTagSplitter,
  removeReasoningContent,
  type CompletionEvent,
} from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "patch-reasoning-"));
  directories.push(directory);
  return directory;
}

function split(chunks: readonly string[]) {
  const splitter = new ReasoningTagSplitter("think");
  let reasoning = "";
  let content = "";
  for (const chunk of chunks) {
    const part = splitter.write(chunk);
    reasoning += part.reasoning;
    content += part.content;
  }
  const rest = splitter.flush();
  return {
    reasoning: reasoning + rest.reasoning,
    content: content + rest.content,
  };
}

describe("ReasoningTagSplitter", () => {
  it("separates a tagged span from the answer", () => {
    expect(split(["<think>weighing options</think>the answer"])).toEqual({
      reasoning: "weighing options",
      content: "the answer",
    });
  });

  it("recognizes a tag broken across deltas", () => {
    // Providers split deltas anywhere, including mid-tag.
    expect(
      split(["<thi", "nk>weighing", " options</th", "ink>the answer"]),
    ).toEqual({ reasoning: "weighing options", content: "the answer" });
  });

  it("holds back only text that could still start a tag", () => {
    const splitter = new ReasoningTagSplitter("think");
    // "a<" could begin the tag, so "<" waits while "a" is released.
    expect(splitter.write("a<")).toEqual({ reasoning: "", content: "a" });
    expect(splitter.write("b")).toEqual({ reasoning: "", content: "<b" });
    expect(splitter.flush()).toEqual({ reasoning: "", content: "" });
  });

  it("treats text with no tag as answer text", () => {
    expect(split(["just an answer"])).toEqual({
      reasoning: "",
      content: "just an answer",
    });
  });
});

describe("removeReasoningContent", () => {
  it("drops a complete span and everything before an unmatched close", () => {
    expect(removeReasoningContent("<think>a</think>answer", "think")).toBe(
      "answer",
    );
    // A model that began reasoning before the first delta emits no opening tag.
    expect(
      removeReasoningContent("stray thoughts</think>answer", "think"),
    ).toBe("answer");
    expect(removeReasoningContent("plain answer", "think")).toBe(
      "plain answer",
    );
  });
});

describe("a session whose model reasons in the content stream", () => {
  it("keeps the tagged text out of display, history, and parsing", async () => {
    const root = await temporaryDirectory();
    const session = new CoderSession({
      config: {
        root,
        model: {
          name: "test/reasoner",
          provider: "fake",
          editFormat: "ask",
          reasoningTag: "think",
        },
      },
      provider: new FakeProvider([
        {
          actions: [
            { type: "text-delta", text: "<thi" },
            { type: "text-delta", text: "nk>I should check the parser" },
            { type: "text-delta", text: "</think>The parser is in " },
            { type: "text-delta", text: "src/edits." },
            { type: "finish", reason: "stop" },
          ],
        },
      ]),
      strategy: new AskEditStrategy(),
    });
    const shown: CompletionEvent[] = [];

    const completed = await session.runTurn("where is the parser", {
      onEvent: (event) => shown.push(event),
    });

    expect(completed.response).toBe("The parser is in src/edits.");
    expect(completed.reasoning).toBe("I should check the parser");
    // Nothing tagged reaches the terminal, and the thought arrives as reasoning.
    const text = shown
      .filter((event) => event.type === "text-delta")
      .map((event) => (event.type === "text-delta" ? event.text : ""))
      .join("");
    expect(text).toBe("The parser is in src/edits.");
    expect(text).not.toContain("<think>");
    expect(
      shown.some(
        (event) =>
          event.type === "reasoning-delta" &&
          event.text === "I should check the parser",
      ),
    ).toBe(true);
    // History records the answer alone.
    expect(session.snapshot().messages).toContainEqual({
      role: "assistant",
      content: "The parser is in src/edits.",
      reasoning: "I should check the parser",
    });
  });
});
