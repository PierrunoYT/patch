import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConcreteApplicationService,
  ContextSelectionConvergenceError,
  FakeProvider,
  ModelCatalog,
  RepositoryMap,
  type RepositoryMapRequest,
  type SessionState,
} from "../src/index.js";

const executeFile = promisify(execFile);
const roots: string[] = [];
const catalog = ModelCatalog.load({
  settings: [new URL("./fixtures/switch-models.yml", import.meta.url)],
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const response = (text: string) => ({
  actions: [
    { type: "text-delta" as const, text },
    { type: "usage" as const, inputTokens: 10, outputTokens: 5 },
    { type: "finish" as const, reason: "stop" as const },
  ],
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patch-context-"));
  roots.push(root);
  await executeFile("git", ["init", "--quiet", root]);
  await executeFile("git", ["-C", root, "config", "user.name", "Test"]);
  await executeFile("git", [
    "-C",
    root,
    "config",
    "user.email",
    "test@example.com",
  ]);
  await executeFile("git", ["-C", root, "config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "a.ts"), "export const oldValue = 1;\n");
  await writeFile(join(root, "b.ts"), "export class RequestWidget {}\n");
  await writeFile(join(root, "reference.ts"), "export type Reference = 1;\n");
  await executeFile("git", ["-C", root, "add", "."]);
  await executeFile("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
  return root;
}

async function application(
  provider: FakeProvider,
  approvePath?: (path: string) => boolean,
) {
  const root = await repository();
  const service = await ConcreteApplicationService.create({
    cwd: root,
    home: root,
    environment: {},
    argv: [
      "--model",
      "test/diff-model",
      "--file",
      "a.ts",
      "--read-only",
      "reference.ts",
    ],
    dependencies: {
      catalog: await catalog,
      provider,
      ...(approvePath === undefined ? {} : { approvePath }),
    },
  });
  return service.createSession({ principal: "test", sessionId: "context" });
}

describe("production context selection", () => {
  it("refreshes an expanded map with original identifier hints and replaces the complete selection", async () => {
    const maps: Array<{
      readonly budget: number;
      readonly request: RepositoryMapRequest;
    }> = [];
    vi.spyOn(RepositoryMap.prototype, "getMap").mockImplementation(function (
      this: RepositoryMap,
      request: RepositoryMapRequest,
    ) {
      maps.push({ budget: this.maxTokens, request });
      return Promise.resolve(`map pass ${String(maps.length)}`);
    });
    const provider = new FakeProvider([
      response("- b.ts — `RequestWidget`"),
      response("- b.ts — `RequestWidget`"),
    ]);
    const approvePath = vi.fn(() => true);
    const session = await application(provider, approvePath);

    await expect(
      session.selectContext?.("Update RequestWidget safely", {
        signal: new AbortController().signal,
        emit: () => undefined,
      }),
    ).resolves.toEqual({ paths: ["b.ts"], iterations: 2 });

    expect(approvePath).toHaveBeenCalledTimes(1);
    expect(approvePath).toHaveBeenCalledWith("b.ts");
    expect(((await session.snapshot()) as SessionState).editablePaths).toEqual([
      "b.ts",
    ]);
    expect(((await session.snapshot()) as SessionState).readOnlyPaths).toEqual([
      "reference.ts",
    ]);
    expect(maps).toHaveLength(2);
    expect(maps.map(({ budget }) => budget)).toEqual([8192, 8192]);
    expect(maps.map(({ request }) => request.forceRefresh)).toEqual([
      true,
      true,
    ]);
    expect(
      maps.every(({ request }) =>
        request.mentionedIdentifiers?.includes("RequestWidget"),
      ),
    ).toBe(true);
    expect(maps.map(({ request }) => request.chatPaths)).toEqual([
      ["a.ts", "reference.ts"],
      ["b.ts", "reference.ts"],
    ]);
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain(
      "Act as an expert code analyst",
    );
    expect(provider.requests[1]?.messages.at(-2)?.content).toContain(
      "updated the set of files",
    );
  });

  it("keeps the parent selection atomic when a newly selected path is denied", async () => {
    vi.spyOn(RepositoryMap.prototype, "getMap").mockResolvedValue("map");
    const approvePath = vi.fn(() => false);
    const provider = new FakeProvider([response("b.ts"), response("b.ts")]);
    const session = await application(provider, approvePath);

    await expect(
      session.selectContext?.("Update RequestWidget", {
        signal: new AbortController().signal,
        emit: () => undefined,
      }),
    ).rejects.toThrow("Context selection was not approved: b.ts");
    expect(((await session.snapshot()) as SessionState).editablePaths).toEqual([
      "a.ts",
    ]);
    // The denial lands before the pass that would have sent the file, so its
    // contents never reach the provider.
    expect(JSON.stringify(provider.requests)).not.toContain(
      "export class RequestWidget",
    );
  });

  it("fails deterministically without changing the parent when the set does not converge", async () => {
    vi.spyOn(RepositoryMap.prototype, "getMap").mockResolvedValue("map");
    const approvePath = vi.fn(() => true);
    const session = await application(
      new FakeProvider([response("b.ts"), response("a.ts")]),
      approvePath,
    );

    await expect(
      session.selectContext?.("Update RequestWidget", {
        signal: new AbortController().signal,
        emit: () => undefined,
        maxIterations: 2,
      }),
    ).rejects.toBeInstanceOf(ContextSelectionConvergenceError);
    // Approval is asked for before a pass may disclose the file, so a run that
    // never converges has still approved what it read. "a.ts" was already in
    // the parent selection, so only "b.ts" is asked about.
    expect(approvePath.mock.calls).toEqual([["b.ts"]]);
    expect(((await session.snapshot()) as SessionState).editablePaths).toEqual([
      "a.ts",
    ]);
  });

  it("propagates cancellation without changing the parent selection", async () => {
    vi.spyOn(RepositoryMap.prototype, "getMap").mockResolvedValue("map");
    const controller = new AbortController();
    const session = await application(
      new FakeProvider([
        { actions: [{ type: "delay" as const, milliseconds: 50 }] },
      ]),
    );
    setTimeout(() => controller.abort(), 1);

    await expect(
      session.selectContext?.("Update RequestWidget", {
        signal: controller.signal,
        emit: () => undefined,
      }),
    ).rejects.toThrow();
    expect(((await session.snapshot()) as SessionState).editablePaths).toEqual([
      "a.ts",
    ]);
  });
});
