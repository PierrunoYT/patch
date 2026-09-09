import { describe, expect, it } from "vitest";

import {
  ChatMessageSchema,
  CommandEffectSchema,
  CompletionEventSchema,
  CompletionRequestSchema,
  EditBatchSchema,
  EditSchema,
  ModelSettingsSchema,
  RepositoryStatusSchema,
  SessionStateSchema,
} from "../src/index.js";

const model = {
  name: "openai/example",
  provider: "openai",
  editFormat: "diff",
};

function sessionState() {
  return {
    config: {
      root: "/project",
      model,
      maxReflections: 3,
    },
    phase: "waiting",
    messages: [{ role: "user", content: "Make a focused change" }],
    editablePaths: ["src/editable.ts"],
    readOnlyPaths: ["README.md"],
    pendingEdits: [],
    partialResponse: "",
    reflectionCount: 0,
    inputTokens: 10,
    outputTokens: 0,
    totalCost: 0,
    lastPatchCommit: null,
  };
}

describe("domain schemas", () => {
  it("keeps message roles structurally distinct", () => {
    expect(
      ChatMessageSchema.parse({
        role: "tool",
        toolCallId: "call-1",
        content: "result",
      }),
    ).toEqual({ role: "tool", toolCallId: "call-1", content: "result" });

    expect(() =>
      ChatMessageSchema.parse({ role: "tool", content: "missing call id" }),
    ).toThrow();
    expect(() =>
      ChatMessageSchema.parse({ role: "assistant", content: null }),
    ).toThrow("content or a tool call");
  });

  it("validates provider requests and each streamed event by its discriminator", () => {
    expect(
      CompletionRequestSchema.parse({
        model: "openai/example",
        messages: [{ role: "user", content: "Hello" }],
      }).extraParameters,
    ).toEqual({});
    expect(
      CompletionEventSchema.parse({
        type: "tool-call-delta",
        index: 0,
        argumentsDelta: '{"path":',
      }),
    ).toMatchObject({ type: "tool-call-delta", index: 0 });
    expect(() =>
      CompletionEventSchema.parse({
        type: "usage",
        inputTokens: -1,
        outputTokens: 2,
      }),
    ).toThrow();
  });

  it("represents edits without allowing a no-op move", () => {
    expect(
      EditSchema.parse({
        kind: "replace",
        path: "src/app.ts",
        search: "before",
        replacement: "after",
      }),
    ).toMatchObject({ kind: "replace", path: "src/app.ts" });
    expect(EditBatchSchema.parse({ edits: [] }).shellCommands).toEqual([]);
    expect(() =>
      EditSchema.parse({
        kind: "move",
        fromPath: "src/app.ts",
        path: "src/app.ts",
      }),
    ).toThrow("distinct source and destination");
  });

  it("supports unborn repository state and rejects unknown result fields", () => {
    const status = {
      root: "/project",
      head: null,
      branch: null,
      trackedPaths: [],
      stagedPaths: ["new.txt"],
      modifiedPaths: [],
      untrackedPaths: [],
    };

    expect(RepositoryStatusSchema.parse(status).head).toBeNull();
    expect(() =>
      RepositoryStatusSchema.parse({ ...status, ignoredUnexpectedly: true }),
    ).toThrow();
  });

  it("requires meaningful, bounded command effects", () => {
    expect(
      CommandEffectSchema.parse({
        type: "switch",
        config: { editFormat: "ask" },
      }),
    ).toMatchObject({ type: "switch", config: { editFormat: "ask" } });
    expect(() =>
      CommandEffectSchema.parse({ type: "switch", config: {} }),
    ).toThrow("cannot be empty");
    expect(() =>
      CommandEffectSchema.parse({ type: "exit", code: 256 }),
    ).toThrow();
  });

  it("applies model defaults at the validation boundary", () => {
    expect(ModelSettingsSchema.parse(model)).toMatchObject({
      useRepoMap: false,
      capabilities: {
        streaming: true,
        systemRole: true,
        tools: false,
      },
      extraParameters: {},
    });
  });

  it("rejects contradictory session state", () => {
    expect(SessionStateSchema.parse(sessionState()).phase).toBe("waiting");
    expect(() =>
      SessionStateSchema.parse({
        ...sessionState(),
        readOnlyPaths: ["src/editable.ts"],
      }),
    ).toThrow("both editable and read-only");
    expect(() =>
      SessionStateSchema.parse({
        ...sessionState(),
        editablePaths: ["src/editable.ts", "src/editable.ts"],
      }),
    ).toThrow("duplicate paths");
    expect(() =>
      SessionStateSchema.parse({ ...sessionState(), reflectionCount: 4 }),
    ).toThrow("exceeds the configured maximum");
  });
});
