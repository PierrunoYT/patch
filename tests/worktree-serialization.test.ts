import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AiWatchMode,
  ConcreteApplicationService,
  LocalWebServer,
  RepositoryMap,
  WorktreeMutationLock,
  worktreeMutationLock,
  type CompletionEvent,
  type CompletionRequest,
  type ModelProvider,
} from "../src/index.js";

const executeFile = promisify(execFile);
const directories: string[] = [];
const services: ConcreteApplicationService[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const tick = (milliseconds = 5) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "patch-worktree-"));
  directories.push(root);
  await executeFile("git", ["init", "--quiet", root]);
  await executeFile("git", ["-C", root, "config", "user.name", "Patch Test"]);
  await executeFile("git", [
    "-C",
    root,
    "config",
    "user.email",
    "patch@test.invalid",
  ]);
  await executeFile("git", ["-C", root, "config", "commit.gpgsign", "false"]);
  await executeFile("git", ["-C", root, "config", "core.autocrlf", "false"]);
  await writeFile(join(root, "shared.txt"), "base\n");
  await executeFile("git", ["-C", root, "add", "."]);
  await executeFile("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
  return root;
}

const edit = (path: string, before: string, after: string) =>
  `${path}\n\`\`\`txt\n<<<<<<< SEARCH\n${before}\n=======\n${after}\n>>>>>>> REPLACE\n\`\`\`\n`;

/** Answers by the last user message so concurrent sessions stay deterministic. */
function routedProvider(replies: Record<string, string>): ModelProvider {
  return {
    async *stream(
      request: CompletionRequest,
      signal?: AbortSignal,
    ): AsyncIterable<CompletionEvent> {
      const asked = [...request.messages]
        .reverse()
        .find((message) => message.role === "user")?.content;
      const key = Object.keys(replies).find(
        (candidate) =>
          typeof asked === "string" && asked.includes(`ask:${candidate}`),
      );
      if (key === undefined) throw new Error("No scripted reply for request");
      // Yield so both sessions stream before either reaches its mutation phase.
      await tick();
      if (signal?.aborted) {
        yield { type: "finish", reason: "cancelled" };
        return;
      }
      yield { type: "text-delta", text: replies[key] as string };
      yield { type: "finish", reason: "stop" };
    },
  };
}

async function service(
  root: string,
  provider: ModelProvider,
  argv: readonly string[],
  authorizeWrite: () => boolean | Promise<boolean>,
) {
  vi.spyOn(RepositoryMap.prototype, "getMap").mockResolvedValue("");
  const created = await ConcreteApplicationService.create({
    cwd: root,
    home: root,
    environment: {},
    argv: ["--model", "4o", ...argv],
    dependencies: { provider, authorizeWrite, approvePath: () => true },
  });
  services.push(created);
  return created;
}

const submitOptions = () => ({
  signal: new AbortController().signal,
  emit: () => undefined,
});

describe("worktree mutation lock", () => {
  it("gives one lock per resolved root and different locks per worktree", () => {
    expect(worktreeMutationLock("/tmp/one")).toBe(
      worktreeMutationLock("/tmp/one"),
    );
    expect(worktreeMutationLock("/tmp/one")).not.toBe(
      worktreeMutationLock("/tmp/two"),
    );
  });

  it("retains a live root's lock across failure, cancellation, and idle periods", async () => {
    const root = "/tmp/live-worktree-lock";
    const lock = worktreeMutationLock(root);
    await expect(
      lock.run(async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(
      lock.run(
        async () => undefined,
        AbortSignal.abort(new Error("cancelled")),
      ),
    ).rejects.toThrow("cancelled");
    await lock.idle();
    expect(worktreeMutationLock(root)).toBe(lock);
    await lock.run(async () => {
      expect(worktreeMutationLock(root)).toBe(lock);
      await worktreeMutationLock(root).run(async () => undefined);
    });
  });

  it("registers weak locks for cleanup without letting stale finalizers remove replacements", async () => {
    type Entry = { root: string; reference: WeakRef<WorktreeMutationLock> };
    const entries: Entry[] = [];
    let cleanup!: (entry: Entry) => void;
    vi.stubGlobal(
      "FinalizationRegistry",
      class {
        constructor(callback: (entry: Entry) => void) {
          cleanup = callback;
        }
        register(_target: object, entry: Entry) {
          entries.push(entry);
        }
      },
    );
    vi.resetModules();
    try {
      const { worktreeMutationLock: lookup } =
        await import("../src/core/worktree-lock.js");
      const root = "/tmp/collected-worktree-lock";
      const first = lookup(root);
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      if (entry === undefined)
        throw new Error("Missing finalizer registration");
      expect(entry.reference).toBeInstanceOf(WeakRef);
      expect(entry.reference.deref()).toBe(first);
      expect(lookup(root)).toBe(first);
      vi.spyOn(entry.reference, "deref").mockReturnValue(undefined);
      const replacement = lookup(root);
      expect(replacement).not.toBe(first);
      const deletion = vi.spyOn(Map.prototype, "delete");
      cleanup(entry);
      expect(deletion).not.toHaveBeenCalledWith(root);
      expect(lookup(root)).toBe(replacement);
      const replacementEntry = entries[1];
      if (replacementEntry === undefined)
        throw new Error("Missing replacement registration");
      vi.spyOn(replacementEntry.reference, "deref").mockReturnValue(undefined);
      cleanup(replacementEntry);
      expect(deletion).toHaveBeenCalledWith(root);
      expect(lookup(root)).not.toBe(replacement);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("runs regions one at a time in acquisition order", async () => {
    const lock = new WorktreeMutationLock();
    const log: string[] = [];
    const region = async (name: string) => {
      log.push(`${name}:enter`);
      await tick();
      log.push(`${name}:exit`);
    };
    await Promise.all([
      lock.run(() => region("first")),
      lock.run(() => region("second")),
    ]);
    expect(log).toEqual([
      "first:enter",
      "first:exit",
      "second:enter",
      "second:exit",
    ]);
  });

  it("re-enters from within a held region instead of deadlocking", async () => {
    const lock = new WorktreeMutationLock();
    await expect(
      lock.run(async () => {
        const inner = await lock.run(async () => "nested");
        return `${inner}:outer`;
      }),
    ).resolves.toBe("nested:outer");
    // The lock is released for later regions.
    await expect(lock.run(async () => "after")).resolves.toBe("after");
  });

  it("rejects a queued region whose signal aborts before it starts", async () => {
    const lock = new WorktreeMutationLock();
    const controller = new AbortController();
    let ran = false;
    const blocking = lock.run(async () => {
      controller.abort(new Error("cancelled while queued"));
      await tick();
    });
    const queued = lock.run(async () => {
      ran = true;
    }, controller.signal);
    await blocking;
    await expect(queued).rejects.toThrow("cancelled while queued");
    expect(ran).toBe(false);
  });

  it("keeps running after a region rejects", async () => {
    const lock = new WorktreeMutationLock();
    await expect(
      lock.run(() => Promise.reject(new Error("region failed"))),
    ).rejects.toThrow("region failed");
    await expect(lock.run(async () => "next")).resolves.toBe("next");
    await lock.idle();
  });
});

describe("concurrent application sessions on one worktree", () => {
  it("orders simultaneous terminal, watch, and HTTP work through the shared lock", async () => {
    const root = await repository();
    await writeFile(join(root, "watch.txt"), "// AI! ask:watch\n");
    let active = 0;
    let maximum = 0;
    const provider = routedProvider({
      terminal: edit("terminal.txt", "", "terminal"),
      web: edit("web.txt", "", "web"),
      watch: edit("watch-result.txt", "", "watched"),
    });
    const application = await service(
      root,
      provider,
      ["--no-git", "--file", "watch.txt"],
      async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await tick(15);
        active -= 1;
        return true;
      },
    );
    const terminal = application.createSession({
      principal: "terminal",
      sessionId: "terminal",
    });
    const watched = application.createSession({
      principal: "watch",
      sessionId: "watch",
    });
    const watcher = new AiWatchMode({
      root,
      session: watched,
      debounceMs: 0,
      selectedPaths: () => ["watch.txt"],
    });
    const server = new LocalWebServer({
      service: application,
      tokens: { integrationToken: "web" },
    });
    const { port } = await server.start();
    try {
      const base = `http://127.0.0.1:${port}`;
      const headers = {
        authorization: "Bearer integrationToken",
        "content-type": "application/json",
      };
      const { sessionId } = (await (
        await fetch(`${base}/sessions`, { method: "POST", headers })
      ).json()) as { sessionId: string };
      watcher.notify("watch.txt");
      const web = fetch(`${base}/sessions/${sessionId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ message: "ask:web" }),
      });
      const direct = terminal.submit("ask:terminal", submitOptions());
      await Promise.all([watcher.flush(), web, direct]);

      expect(maximum).toBe(1);
      // Each of these files is created by its edit, and a new file takes the
      // platform line ending by documented policy, so the assertion is about
      // the line that was written rather than the separator that ends it.
      const written = async (path: string) =>
        (await readFile(join(root, path), "utf8")).replaceAll("\r\n", "\n");
      await expect(written("terminal.txt")).resolves.toBe("terminal\n");
      await expect(written("web.txt")).resolves.toBe("web\n");
      await expect(written("watch-result.txt")).resolves.toBe("watched\n");
    } finally {
      watcher.close();
      await server.close();
    }
  });

  it("never interleaves the mutation phases of two sessions", async () => {
    const root = await repository();
    const log: string[] = [];
    const provider = routedProvider({
      first: edit("first.txt", "", "first\n"),
      second: edit("second.txt", "", "second\n"),
    });
    const application = await service(root, provider, [], async () => {
      const name = log.length === 0 ? "first" : "second";
      log.push(`${name}:authorize`);
      // A mutation phase that yields must still exclude the other session.
      await tick(20);
      log.push(`${name}:authorized`);
      return true;
    });
    const [one, two] = await Promise.all([
      application.createSession({ principal: "terminal", sessionId: "one" }),
      application.createSession({ principal: "web", sessionId: "two" }),
    ]);
    const [first, second] = await Promise.all([
      one.submit("ask:first", submitOptions()),
      two.submit("ask:second", submitOptions()),
    ]);

    expect(log).toEqual([
      "first:authorize",
      "first:authorized",
      "second:authorize",
      "second:authorized",
    ]);
    expect(await readFile(join(root, "first.txt"), "utf8")).toContain("first");
    expect(await readFile(join(root, "second.txt"), "utf8")).toContain(
      "second",
    );
    expect(first).toMatchObject({ changedPaths: ["first.txt"] });
    expect(second).toMatchObject({ changedPaths: ["second.txt"] });
    const log2 = await executeFile("git", [
      "-C",
      root,
      "log",
      "--format=%s",
      "--name-only",
    ]);
    // Each session committed only its own path.
    expect(log2.stdout).toContain("first.txt");
    expect(log2.stdout).toContain("second.txt");
    expect(
      (await executeFile("git", ["-C", root, "status", "--porcelain"])).stdout,
    ).toBe("");
  });

  it("fails the losing session instead of clobbering a concurrent write", async () => {
    const root = await repository();
    const provider = routedProvider({
      first: edit("shared.txt", "base", "first"),
      second: edit("shared.txt", "base", "second"),
    });
    const application = await service(
      root,
      provider,
      ["--file", "shared.txt"],
      () => true,
    );
    const [one, two] = await Promise.all([
      application.createSession({ principal: "terminal", sessionId: "one" }),
      application.createSession({ principal: "web", sessionId: "two" }),
    ]);
    const results = await Promise.allSettled([
      one.submit("ask:first", submitOptions()),
      two.submit("ask:second", submitOptions()),
    ]);

    const applied = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(applied).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The winning content survives whole; nothing is half-written or lost.
    expect(await readFile(join(root, "shared.txt"), "utf8")).toMatch(
      /^(first|second)\n$/,
    );
    expect(
      (await executeFile("git", ["-C", root, "status", "--porcelain"])).stdout,
    ).toBe("");
  });
});
