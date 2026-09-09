import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AskEditStrategy,
  CoderSession,
  ContextWindowExceededError,
  FakeProvider,
  FileSystemAdapter,
  PathApprovalDeniedError,
  ReflectionLimitError,
  WholeFileEditStrategy,
  TruncatedResponseError,
  TurnCancelledError,
  type EditBatch,
  type EditStrategy,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "patch-session-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function config(root: string, editFormat: "ask" | "whole") {
  return {
    root,
    model: { name: "test/model", provider: "fake", editFormat },
  };
}

describe("CoderSession", () => {
  it("uses injected strategies without coder subclasses", async () => {
    const root = await temporaryDirectory();
    const provider = new FakeProvider([]);
    const ask = new CoderSession({
      config: config(root, "ask"),
      provider,
      strategy: new AskEditStrategy(),
      editablePaths: ["file.ts"],
    });
    const whole = new CoderSession({
      config: config(root, "whole"),
      provider,
      strategy: new WholeFileEditStrategy(),
      editablePaths: ["file.ts"],
    });

    expect(ask.resolveResponse("anything", []).operations).toEqual([]);
    expect(
      whole.resolveResponse("file.ts\n```ts\nafter\n```", [
        { path: "file.ts", content: "before\n" },
      ]).operations,
    ).toEqual([
      {
        kind: "update",
        path: "file.ts",
        before: "before\n",
        content: "after\n",
      },
    ]);
    expect(ask.provider).toBe(provider);
    expect(whole.provider).toBe(provider);
  });

  it("stages an injected strategy result without committing it", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "file.ts"), "before\n");
    const files = await FileSystemAdapter.create(root);
    const session = new CoderSession({
      config: config(root, "whole"),
      provider: new FakeProvider([]),
      strategy: new WholeFileEditStrategy(),
      editablePaths: ["file.ts"],
    });

    const transaction = await session.stageResponse(
      "file.ts\n```ts\nafter\n```",
      [{ path: "file.ts", content: "before\n" }],
      files,
    );

    expect(transaction.operations).toHaveLength(1);
    expect(await readFile(join(root, "file.ts"), "utf8")).toBe("before\n");
  });

  it("validates injected strategy output at the session boundary", async () => {
    const root = await temporaryDirectory();
    const malformed: EditStrategy = {
      format: "ask",
      parse: () => ({ edits: [{ kind: "unknown" }] }) as unknown as EditBatch,
    };
    const session = new CoderSession({
      config: config(root, "ask"),
      provider: new FakeProvider([]),
      strategy: malformed,
    });

    expect(() => session.parseResponse("ignored")).toThrow();
  });

  it("validates initial state and returns defensive snapshots", async () => {
    const root = await temporaryDirectory();
    const session = new CoderSession({
      config: config(root, "ask"),
      provider: new FakeProvider([]),
      strategy: new AskEditStrategy(),
      messages: [{ role: "user", content: "question" }],
      editablePaths: ["file.ts"],
    });

    const snapshot = session.snapshot();
    snapshot.messages.push({ role: "assistant", content: "mutated" });
    snapshot.editablePaths.push("other.ts");

    expect(session.snapshot()).toMatchObject({
      phase: "waiting",
      messages: [{ role: "user", content: "question" }],
      editablePaths: ["file.ts"],
      pendingEdits: [],
    });

    expect(
      () =>
        new CoderSession({
          config: config(root, "ask"),
          provider: new FakeProvider([]),
          strategy: new AskEditStrategy(),
          editablePaths: ["same.ts"],
          readOnlyPaths: ["same.ts"],
        }),
    ).toThrow();
  });

  it("composes ordered prompts and transitions completed turns into history", async () => {
    const root = await temporaryDirectory();
    const session = new CoderSession({
      config: config(root, "ask"),
      provider: new FakeProvider([]),
      strategy: new AskEditStrategy(),
      messages: [{ role: "user", content: "old" }],
    });
    const turn = session.prepareTurn("current", {
      system: [{ role: "system", content: "system" }],
      examples: [{ role: "user", content: "example" }],
      readOnlyFiles: [{ role: "user", content: "readonly" }],
      repository: [{ role: "user", content: "repo" }],
      editableFiles: [{ role: "user", content: "editable" }],
      reminder: [{ role: "user", content: "reminder" }],
    });

    expect(turn.request.messages.map((message) => message.content)).toEqual([
      "system",
      "example",
      "readonly",
      "repo",
      "old",
      "editable",
      "current",
      "reminder",
    ]);
    expect(session.snapshot()).toMatchObject({
      phase: "streaming",
      inputTokens: turn.inputTokens,
      partialResponse: "",
    });

    expect(session.finalizeTurn(turn, "answer")).toEqual({
      edits: [],
      shellCommands: [],
    });
    expect(session.snapshot()).toMatchObject({
      phase: "waiting",
      messages: [
        { role: "user", content: "old" },
        { role: "user", content: "current" },
        { role: "assistant", content: "answer" },
      ],
      partialResponse: "answer",
    });
  });

  it("rejects over-budget prompts before activating a turn", async () => {
    const root = await temporaryDirectory();
    const session = new CoderSession({
      config: {
        ...config(root, "ask"),
        model: {
          name: "tiny/model",
          provider: "fake",
          editFormat: "ask",
          maxInputTokens: 5,
        },
      },
      provider: new FakeProvider([]),
      strategy: new AskEditStrategy(),
    });

    expect(() => session.prepareTurn("a prompt beyond five tokens")).toThrow(
      /model limit is 5/,
    );
    expect(session.snapshot().phase).toBe("waiting");
  });

  it("supports abandoning a prepared turn without adding history", async () => {
    const root = await temporaryDirectory();
    const session = new CoderSession({
      config: config(root, "ask"),
      provider: new FakeProvider([]),
      strategy: new AskEditStrategy(),
    });
    const turn = session.prepareTurn("temporary");

    session.abandonTurn(turn);

    expect(session.snapshot()).toMatchObject({
      phase: "waiting",
      messages: [],
      partialResponse: "",
    });
    expect(() => session.finalizeTurn(turn, "late")).toThrow(/inactive/);
  });

  it("assembles streamed text and reasoning while retrying transient failures", async () => {
    const root = await temporaryDirectory();
    const delays: number[] = [];
    const provider = new FakeProvider([
      {
        actions: [
          {
            type: "error",
            kind: "rate-limit",
            message: "slow down",
            retryable: true,
          },
        ],
      },
      {
        actions: [
          { type: "reasoning-delta", text: "think" },
          { type: "text-delta", text: "ans" },
          { type: "text-delta", text: "wer" },
          { type: "usage", inputTokens: 12, outputTokens: 3, cost: 0.25 },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const session = new CoderSession({
      config: config(root, "ask"),
      provider,
      strategy: new AskEditStrategy(),
      retry: {
        initialDelayMs: 10,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
    });
    const observed: string[] = [];

    const result = await session.runTurn("question", {
      onEvent: (event) => observed.push(event.type),
    });

    expect(result).toMatchObject({ response: "answer", reasoning: "think" });
    expect(delays).toEqual([10]);
    expect(provider.requests).toHaveLength(2);
    expect(observed).toEqual([
      "error",
      "reasoning-delta",
      "text-delta",
      "text-delta",
      "usage",
      "finish",
    ]);
    expect(session.snapshot()).toMatchObject({
      phase: "waiting",
      inputTokens: 12,
      outputTokens: 3,
      totalCost: 0.25,
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer", reasoning: "think" },
      ],
    });
  });

  it("classifies context overflow and output truncation without adding history", async () => {
    const root = await temporaryDirectory();
    const overflow = new CoderSession({
      config: config(root, "ask"),
      provider: new FakeProvider([
        {
          actions: [
            {
              type: "error",
              kind: "context-window",
              message: "too large",
              retryable: false,
            },
          ],
        },
      ]),
      strategy: new AskEditStrategy(),
    });
    await expect(overflow.runTurn("question")).rejects.toBeInstanceOf(
      ContextWindowExceededError,
    );
    expect(overflow.snapshot()).toMatchObject({
      phase: "interrupted",
      messages: [],
    });

    const truncated = new CoderSession({
      config: config(root, "ask"),
      provider: new FakeProvider([
        {
          actions: [
            { type: "text-delta", text: "partial" },
            { type: "finish", reason: "length" },
          ],
        },
      ]),
      strategy: new AskEditStrategy(),
    });
    await expect(truncated.runTurn("question")).rejects.toMatchObject({
      constructor: TruncatedResponseError,
      partialResponse: "partial",
    });
    expect(truncated.snapshot().messages).toEqual([]);
  });

  it("cancels a stream without finalizing partial output", async () => {
    const root = await temporaryDirectory();
    const controller = new AbortController();
    const session = new CoderSession({
      config: config(root, "ask"),
      provider: new FakeProvider([
        {
          actions: [
            { type: "text-delta", text: "partial" },
            { type: "delay", milliseconds: 1_000 },
            { type: "text-delta", text: "forbidden" },
          ],
        },
      ]),
      strategy: new AskEditStrategy(),
    });

    await expect(
      session.runTurn("question", {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "text-delta") {
            controller.abort();
          }
        },
      }),
    ).rejects.toBeInstanceOf(TurnCancelledError);
    expect(session.snapshot()).toMatchObject({
      phase: "interrupted",
      partialResponse: "partial",
      messages: [],
    });
  });

  it("reflects malformed edit output and preserves the correction context", async () => {
    const root = await temporaryDirectory();
    const strategy: EditStrategy = {
      format: "ask",
      parse: (response) => {
        if (response === "malformed") {
          throw new Error("missing required edit markers");
        }
        return { edits: [], shellCommands: [] };
      },
    };
    const provider = new FakeProvider([
      {
        actions: [
          { type: "text-delta", text: "malformed" },
          { type: "finish", reason: "stop" },
        ],
      },
      {
        actions: [
          { type: "text-delta", text: "corrected" },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const session = new CoderSession({
      config: config(root, "ask"),
      provider,
      strategy,
    });

    await expect(session.runTurn("edit this")).resolves.toMatchObject({
      response: "corrected",
    });

    expect(provider.requests[1]?.messages.slice(-2)).toMatchObject([
      { role: "assistant", content: "malformed" },
      { role: "user", content: expect.stringContaining("edit format") },
    ]);
    expect(session.snapshot()).toMatchObject({
      reflectionCount: 1,
      messages: [
        { role: "user", content: "edit this" },
        { role: "assistant", content: "malformed" },
        { role: "user", content: expect.stringContaining("edit format") },
        { role: "assistant", content: "corrected" },
      ],
    });
  });

  it("reflects injected lint and test diagnostics in order", async () => {
    const root = await temporaryDirectory();
    const provider = new FakeProvider(
      ["first", "second", "third"].map((text) => ({
        actions: [
          { type: "text-delta" as const, text },
          { type: "finish" as const, reason: "stop" as const },
        ],
      })),
    );
    const session = new CoderSession({
      config: { ...config(root, "ask"), autoTest: true },
      provider,
      strategy: new AskEditStrategy(),
    });
    let lintRuns = 0;
    let testRuns = 0;

    const result = await session.runTurn("fix checks", {
      checks: {
        lint: () => (++lintRuns === 1 ? "lint failed" : undefined),
        test: () => (++testRuns === 1 ? "tests failed" : undefined),
      },
    });

    expect(result.response).toBe("third");
    expect({ lintRuns, testRuns }).toEqual({ lintRuns: 3, testRuns: 2 });
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain(
      "lint failed",
    );
    expect(provider.requests[2]?.messages.at(-1)?.content).toContain(
      "tests failed",
    );
    expect(session.snapshot().reflectionCount).toBe(2);
  });

  it("stops after the configured reflection limit", async () => {
    const root = await temporaryDirectory();
    const session = new CoderSession({
      config: { ...config(root, "ask"), maxReflections: 1 },
      provider: new FakeProvider([
        {
          actions: [
            { type: "text-delta", text: "first" },
            { type: "finish", reason: "stop" },
          ],
        },
        {
          actions: [
            { type: "text-delta", text: "second" },
            { type: "finish", reason: "stop" },
          ],
        },
      ]),
      strategy: new AskEditStrategy(),
    });

    await expect(
      session.runTurn("question", {
        checks: { lint: () => "still broken" },
      }),
    ).rejects.toMatchObject({
      constructor: ReflectionLimitError,
      diagnostic: "still broken",
    });
    expect(session.snapshot()).toMatchObject({
      phase: "interrupted",
      reflectionCount: 1,
      messages: [],
    });
  });

  it("requires explicit approval for mentioned and model-selected paths", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "mentioned.ts"), "before\n");
    const approvals: string[] = [];
    const session = new CoderSession({
      config: config(root, "whole"),
      provider: new FakeProvider([
        {
          actions: [
            { type: "text-delta", text: "new.ts\n```ts\nnew\n```" },
            { type: "finish", reason: "stop" },
          ],
        },
      ]),
      strategy: new WholeFileEditStrategy(),
      availablePaths: ["mentioned.ts"],
      approvePath: ({ path, reason }) => {
        approvals.push(`${reason}:${path}`);
        return true;
      },
    });

    await session.runTurn("Compare mentioned.ts and create the requested file");

    expect(approvals).toEqual([
      "user-mention:mentioned.ts",
      "model-edit:new.ts",
    ]);
    expect(session.snapshot().editablePaths).toEqual([
      "mentioned.ts",
      "new.ts",
    ]);
  });

  it("cannot stage an unselected edit without approval", async () => {
    const root = await temporaryDirectory();
    const files = await FileSystemAdapter.create(root);
    const session = new CoderSession({
      config: config(root, "whole"),
      provider: new FakeProvider([]),
      strategy: new WholeFileEditStrategy(),
    });

    await expect(
      session.stageResponse(
        "new.ts\n```ts\nnew\n```",
        [{ path: "new.ts", content: null }],
        files,
      ),
    ).rejects.toBeInstanceOf(PathApprovalDeniedError);
    await expect(readFile(join(root, "new.ts"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
