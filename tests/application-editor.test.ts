import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConcreteApplicationService,
  FakeProvider,
  ModelCatalog,
  type ModelSettings,
} from "../src/index.js";

const roots: string[] = [];
const catalog = ModelCatalog.load({
  settings: [new URL("./fixtures/switch-models.yml", import.meta.url)],
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "patch-editor-"));
  roots.push(value);
  await writeFile(join(value, "value.txt"), "old\n");
  return value;
}

const response = (text: string) => ({
  actions: [
    { type: "text-delta" as const, text },
    { type: "finish" as const, reason: "stop" as const },
  ],
});

describe("production editor role", () => {
  it("uses its model, distinct prompt, fresh history, no map, and no shell", async () => {
    const directory = await root();
    const editor = new FakeProvider([
      response(
        "value.txt\n```bash\necho unsafe\n```\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n",
      ),
      response(
        "value.txt\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n",
      ),
    ]);
    const main = new FakeProvider([response("prior answer")]);
    const service = await ConcreteApplicationService.create({
      cwd: directory,
      home: directory,
      environment: {},
      argv: ["--no-git", "--model", "test/diff-model", "--file", "value.txt"],
      dependencies: {
        catalog: await catalog,
        createProvider: (model: ModelSettings) =>
          model.name === "test/editor-model" ? editor : main,
      },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "editor",
    });
    await session.submit("prior architect history", {
      signal: new AbortController().signal,
      emit: () => undefined,
    });

    const result = await session.runEditor?.("apply the accepted plan", {
      signal: new AbortController().signal,
      emit: () => undefined,
    });

    expect(result).toMatchObject({ changedPaths: ["value.txt"] });
    expect(await readFile(join(directory, "value.txt"), "utf8")).toBe("new\n");
    expect(editor.requests).toHaveLength(2);
    expect(editor.requests[0]?.model).toBe("test/editor-model");
    const request = JSON.stringify(editor.requests[0]?.messages);
    expect(request).toContain("developer who edits source code");
    expect(request).not.toContain("Shell commands may be suggested");
    expect(request).not.toContain("prior architect history");
    expect(request).not.toContain("Here are summaries of some files");
    expect(main.requests).toHaveLength(1);
  });

  it("honors cancellation before the editor provider call", async () => {
    const directory = await root();
    const editor = new FakeProvider([response("unused")]);
    const service = await ConcreteApplicationService.create({
      cwd: directory,
      home: directory,
      environment: {},
      argv: ["--no-git", "--model", "test/diff-model", "--file", "value.txt"],
      dependencies: {
        catalog: await catalog,
        createProvider: (model: ModelSettings) =>
          model.name === "test/editor-model" ? editor : new FakeProvider([]),
      },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "cancel-editor",
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      session.runEditor?.("plan", {
        signal: controller.signal,
        emit: () => undefined,
      }),
    ).rejects.toThrow("cancelled");
    expect(editor.requests).toHaveLength(0);
    expect(await readFile(join(directory, "value.txt"), "utf8")).toBe("old\n");
  });

  it("leaves files and the parent session reusable after editor failure", async () => {
    const directory = await root();
    const editor = new FakeProvider([
      {
        actions: [
          {
            type: "error",
            kind: "provider",
            message: "editor unavailable",
            retryable: false,
          },
        ],
      },
    ]);
    const main = new FakeProvider([response("parent still works")]);
    const service = await ConcreteApplicationService.create({
      cwd: directory,
      home: directory,
      environment: {},
      argv: ["--no-git", "--model", "test/diff-model", "--file", "value.txt"],
      dependencies: {
        catalog: await catalog,
        createProvider: (model: ModelSettings) =>
          model.name === "test/editor-model" ? editor : main,
      },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "failed-editor",
    });
    await expect(
      session.runEditor?.("plan", {
        signal: new AbortController().signal,
        emit: () => undefined,
      }),
    ).rejects.toThrow("editor unavailable");
    await expect(
      session.submit("continue", {
        signal: new AbortController().signal,
        emit: () => undefined,
      }),
    ).resolves.toMatchObject({ response: "parent still works" });
    expect(await readFile(join(directory, "value.txt"), "utf8")).toBe("old\n");
  });
});
