import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AskEditStrategy,
  CoderSession,
  FakeProvider,
  FileSystemAdapter,
  WholeFileEditStrategy,
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
});
