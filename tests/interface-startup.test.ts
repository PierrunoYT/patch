import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AiWatchMode,
  ConcreteApplicationService,
  FakeProvider,
  LocalWebServer,
} from "../src/index.js";
import { createProgram } from "../src/program.js";

const roots: string[] = [];
const token = "startup-test-token-not-a-real-secret-12345";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "patch-startup-"));
  roots.push(root);
  await writeFile(join(root, "token"), token);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function turn(text: string) {
  return {
    actions: [
      { type: "text-delta", text },
      { type: "finish", reason: "stop" },
    ],
  };
}

describe("application interface startup", () => {
  it("starts real filesystem watching with Git ignores and shares terminal history; AI? cannot write", async () => {
    const root = await fixture();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, ".gitignore"), "ignored.ts\n");
    await writeFile(join(root, ".aiderignore"), "private.ts\n");
    await writeFile(join(root, "selected.ts"), "const keep = 7;\n");
    await writeFile(join(root, "private.ts"), "private startup secret\n");
    execFileSync("git", ["add", "--force", "selected.ts", "private.ts"], {
      cwd: root,
    });
    const provider = new FakeProvider([
      turn("terminal first"),
      turn("selected.ts\n```ts\nconst keep = 999;\n```\n"),
      turn("terminal last"),
    ]);
    let output = "";
    let application!: ConcreteApplicationService;
    const lines = (async function* () {
      yield "first";
      await writeFile(join(root, "ignored.ts"), "// AI! ignored secret\n");
      await writeFile(join(root, "private.ts"), "// AI! private secret\n");
      await writeFile(
        join(root, "selected.ts"),
        "const keep = 7; // AI? explain\n",
      );
      await vi.waitFor(() => expect(provider.requests).toHaveLength(2), {
        timeout: 5000,
      });
      yield "follow-up";
    })();
    await createProgram({
      cwd: root,
      environment: {},
      lines,
      writeOutput: (text) => {
        output += text;
      },
      createApplication: async (options) => {
        application = await ConcreteApplicationService.create({
          ...options,
          home: root,
          dependencies: { provider },
        });
        return application;
      },
    }).parseAsync(
      [
        "--watch-files",
        "--model",
        "4o",
        "--edit-format",
        "whole",
        "selected.ts",
      ],
      { from: "user" },
    );
    expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
      "AI? explain",
    );
    expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain(
      "ignored secret",
    );
    expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain(
      "private secret",
    );
    expect(JSON.stringify(provider.requests)).not.toContain(
      "private startup secret",
    );
    expect(provider.requests[2]?.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("999"),
      }),
    );
    expect(await readFile(join(root, "selected.ts"), "utf8")).toBe(
      "const keep = 7; // AI? explain\n",
    );
    expect(output).toContain("terminal last");
    expect(() =>
      application.createSession({ principal: "late", sessionId: "late" }),
    ).toThrow(/closed/);
    await writeFile(join(root, "selected.ts"), "// AI! after shutdown\n");
    await new Promise((done) => setTimeout(done, 150));
    expect(provider.requests).toHaveLength(3);
  });

  it("rejects an explicitly selected ignored file before provider use", async () => {
    const root = await fixture();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, ".aiderignore"), "private.ts\n");
    await writeFile(join(root, "private.ts"), "private secret\n");
    execFileSync("git", ["add", "--force", "private.ts"], { cwd: root });
    const provider = new FakeProvider([]);

    await expect(
      ConcreteApplicationService.create({
        cwd: root,
        home: root,
        environment: {},
        argv: ["--model", "4o", "--edit-format", "ask", "private.ts"],
        dependencies: { provider },
      }),
    ).rejects.toThrow(/ignored and cannot enter model context/);
    expect(provider.requests).toHaveLength(0);
  });

  it("keeps a globally excluded file out of selection and provider context", async () => {
    const root = await fixture();
    // The ordinary Git exclusion policy a user carries between repositories.
    // `.aiderignore` exists as well, because Patch used to pass it as
    // `core.excludesFile` and so replaced this policy instead of composing
    // with it.
    const excludes = join(await fixture(), "excludes");
    await writeFile(excludes, "global-only.ts\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "core.excludesFile", excludes], {
      cwd: root,
    });
    await writeFile(join(root, ".aiderignore"), "aider-only.ts\n");
    await writeFile(join(root, "global-only.ts"), "global secret\n");
    await writeFile(join(root, "selected.ts"), "const keep = 7;\n");
    execFileSync("git", ["add", "--force", "global-only.ts", "selected.ts"], {
      cwd: root,
    });
    const provider = new FakeProvider([turn("nothing to change")]);

    await expect(
      ConcreteApplicationService.create({
        cwd: root,
        home: root,
        environment: {},
        argv: ["--model", "4o", "--edit-format", "ask", "global-only.ts"],
        dependencies: { provider },
      }),
    ).rejects.toThrow(/ignored and cannot enter model context/);

    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--model", "4o", "--edit-format", "ask", "selected.ts"],
      dependencies: { provider },
    });
    const session = service.createSession({
      principal: "global-ignore",
      sessionId: "global-ignore",
    });
    await session.submit("summarize", {
      signal: new AbortController().signal,
      emit: () => undefined,
    });

    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(provider.requests)).not.toContain("global secret");
    expect(JSON.stringify(provider.requests)).not.toContain("global-only.ts");
  });

  it("rejects a model edit to an ignored tracked file before reading it", async () => {
    const root = await fixture();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, ".aiderignore"), "private.ts\n");
    await writeFile(join(root, "private.ts"), "private model secret\n");
    await writeFile(join(root, "selected.ts"), "selected\n");
    execFileSync("git", ["add", "--force", "private.ts", "selected.ts"], {
      cwd: root,
    });
    const provider = new FakeProvider([
      turn("private.ts\n```ts\nchanged\n```\n"),
    ]);
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--model", "4o", "--edit-format", "whole", "selected.ts"],
      dependencies: { provider, authorizeWrite: () => true },
    });
    const session = service.createSession({
      principal: "ignored-model-edit",
      sessionId: "ignored-model-edit",
    });

    await expect(
      session.submit("change private.ts", {
        signal: new AbortController().signal,
        emit: () => undefined,
      }),
    ).rejects.toThrow(/ignored and cannot enter model context/);
    expect(JSON.stringify(provider.requests)).not.toContain(
      "private model secret",
    );
    await expect(readFile(join(root, "private.ts"), "utf8")).resolves.toBe(
      "private model secret\n",
    );
    service.close();
  });

  it("budgets a turn against the bundled model's advertised input limit", async () => {
    const root = await fixture();
    // Roughly 150k tokens by the estimator, over gpt-4o's 128k input limit and
    // under claude-sonnet-4-6's one million. Without bundled metadata neither
    // model had a limit at all, so an oversized prompt was sent to the
    // provider instead of being refused.
    await writeFile(join(root, "huge.ts"), `const x = 1;\n`.repeat(46_000));
    const submit = async (model: string) => {
      const provider = new FakeProvider([turn("answered")]);
      const service = await ConcreteApplicationService.create({
        cwd: root,
        home: root,
        environment: {},
        argv: ["--no-git", "--model", model, "--edit-format", "ask", "huge.ts"],
        dependencies: { provider },
      });
      const session = service.createSession({
        principal: "budget",
        sessionId: `budget-${model}`,
      });
      try {
        return await session
          .submit("summarize", {
            signal: new AbortController().signal,
            emit: () => undefined,
          })
          .then(
            () => ({ requests: provider.requests.length, error: undefined }),
            (error: unknown) => ({
              requests: provider.requests.length,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      } finally {
        service.close();
      }
    };

    await expect(submit("4o")).resolves.toMatchObject({
      requests: 0,
      error: expect.stringMatching(/tokens but the model limit is 128000/u),
    });
    await expect(submit("sonnet")).resolves.toMatchObject({
      requests: 1,
      error: undefined,
    });
  });

  it("applies AI! edits only to authorized selections and rejects question-only commands", async () => {
    const root = await fixture();
    await writeFile(join(root, "selected.ts"), "// AI! replace this\n");
    await writeFile(join(root, "other.ts"), "// AI! not selected\n");
    const provider = new FakeProvider([
      turn("selected.ts\n```ts\nconst answer = 42;\n```\n"),
      turn("other.ts\n```ts\nconst unauthorized = 1;\n```\n"),
    ]);
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: [
        "--no-git",
        "--model",
        "4o",
        "--edit-format",
        "whole",
        "selected.ts",
      ],
      dependencies: { provider },
    });
    const session = service.createSession({
      principal: "test",
      sessionId: "test",
    });
    const watcher = new AiWatchMode({ root: service.root, session });
    try {
      watcher.notify("selected.ts");
      await watcher.flush();
      expect(await readFile(join(root, "selected.ts"), "utf8")).toBe(
        "const answer = 42;\n",
      );
      watcher.notify("other.ts");
      await expect(watcher.flush()).rejects.toThrow(
        "Write authorization denied for other.ts",
      );
      expect(await readFile(join(root, "other.ts"), "utf8")).toBe(
        "// AI! not selected\n",
      );
      await expect(
        session.submit("/run touch forbidden", {
          signal: new AbortController().signal,
          readOnly: true,
          emit: () => undefined,
        }),
      ).rejects.toThrow(/Question-only/);
    } finally {
      watcher.close();
      await service.close();
    }
    await expect(watcher.start()).rejects.toThrow(/stopped/);
  });

  it("starts authenticated HTTP sessions through the concrete service and cancels active work on shutdown", async () => {
    const root = await fixture();
    const provider = new FakeProvider([
      turn("web reply"),
      {
        actions: [
          { type: "delay", milliseconds: 30000 },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const stop = new AbortController();
    let output = "";
    let application!: ConcreteApplicationService;
    const running = createProgram({
      cwd: root,
      environment: {},
      signal: stop.signal,
      writeOutput: (text) => {
        output += text;
      },
      createApplication: async (options) => {
        application = await ConcreteApplicationService.create({
          ...options,
          home: root,
          dependencies: { provider },
        });
        return application;
      },
    }).parseAsync(
      [
        "--web",
        "--web-token-file",
        "token",
        "--no-git",
        "--model",
        "4o",
        "--edit-format",
        "ask",
      ],
      { from: "user" },
    );
    try {
      await vi.waitFor(() => expect(output).toContain("listening"));
      const base = /http:\/\/127\.0\.0\.1:\d+/u.exec(output)![0];
      expect(output).not.toContain(token);
      const headers = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };
      expect((await fetch(`${base}/sessions`, { method: "POST" })).status).toBe(
        401,
      );
      const created = await fetch(`${base}/sessions`, {
        method: "POST",
        headers,
      });
      expect(created.status).toBe(201);
      const { sessionId } = (await created.json()) as { sessionId: string };
      const path = `${base}/sessions/${sessionId}/messages`;
      for (const body of [
        "{",
        '{"message":0}',
        '{"message":"ok","extra":true}',
      ]) {
        expect(
          (await fetch(path, { method: "POST", headers, body })).status,
        ).toBe(400);
      }
      expect(provider.requests).toHaveLength(0);
      const response = await fetch(path, {
        method: "POST",
        headers,
        body: JSON.stringify({ message: "hello web" }),
      });
      expect(await response.json()).toMatchObject({
        result: { response: "web reply", changedPaths: [] },
      });
      const active = fetch(path, {
        method: "POST",
        headers,
        body: JSON.stringify({ message: "wait" }),
      }).catch(() => undefined);
      await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
      stop.abort();
      await running;
      await active;
      expect(() =>
        application.createSession({ principal: "late", sessionId: "late" }),
      ).toThrow(/closed/);
      await expect(fetch(`${base}/sessions`)).rejects.toThrow();
    } finally {
      stop.abort();
      await running;
    }
  });

  it("reports structured recovery after a concrete web turn fails post-write", async () => {
    const root = await fixture();
    await writeFile(join(root, "selected.txt"), "zero\n");
    const provider = new FakeProvider(
      ["one", "two", "three", "four"].map((content) =>
        turn(`selected.txt\n\`\`\`txt\n${content}\n\`\`\``),
      ),
    );
    const application = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: [
        "--no-git",
        "--model",
        "4o",
        "--edit-format",
        "whole",
        "--file",
        "selected.txt",
        "--test-cmd",
        'node -e "process.exit(9)"',
      ],
      dependencies: { provider },
    });
    const server = new LocalWebServer({
      service: application,
      tokens: { [token]: "local" },
    });
    const { port } = await server.start();
    try {
      const base = `http://127.0.0.1:${port}`;
      const headers = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };
      const created = await fetch(`${base}/sessions`, {
        method: "POST",
        headers,
      });
      const { sessionId } = (await created.json()) as { sessionId: string };
      const response = await fetch(`${base}/sessions/${sessionId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ message: "change it" }),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Turn partially applied",
        code: "turn_partially_applied",
        partial: {
          changedPaths: ["selected.txt"],
          commit: null,
          commands: [],
        },
      });
      expect(await readFile(join(root, "selected.txt"), "utf8")).toBe("four\n");
      expect(provider.requests).toHaveLength(4);
    } finally {
      await server.close();
      await application.close();
    }
  });

  it.each([
    ["--web"],
    ["--web-port", "10"],
    ["--web", "--web-port", "65536"],
    ["--web", "--web-port", "1.2"],
    ["--web", "--watch-files"],
    ["--watch-files", "--message", "hello"],
    ["--web", "--web-token-file", "missing"],
  ])(
    "rejects invalid startup arguments before constructing providers: %j",
    async (...argv) => {
      const createApplication = vi.fn();
      await expect(
        createProgram({ createApplication }).parseAsync(argv, { from: "user" }),
      ).rejects.toThrow();
      expect(createApplication).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed token content without printing it", async () => {
    const root = await fixture();
    await writeFile(join(root, "token"), "sensitive malformed value");
    await expect(
      createProgram({ cwd: root }).parseAsync(
        ["--web", "--web-token-file", "token"],
        { from: "user" },
      ),
    ).rejects.toThrow(/^Web token must contain/);
  });

  it("closes the concrete service when the web port is occupied or watch startup fails", async () => {
    const root = await fixture();
    const socket = createServer();
    await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
    const address = socket.address() as { port: number };
    const applications: ConcreteApplicationService[] = [];
    const createApplication = async () => {
      const app = await ConcreteApplicationService.create({
        cwd: root,
        home: root,
        environment: {},
        argv: ["--no-git", "--model", "4o"],
        dependencies: { provider: new FakeProvider([]) },
      });
      applications.push(app);
      return app;
    };
    const listeners = process.listenerCount("SIGTERM");
    try {
      await expect(
        createProgram({ cwd: root, createApplication }).parseAsync(
          [
            "--web",
            "--web-port",
            String(address.port),
            "--web-token-file",
            "token",
          ],
          { from: "user" },
        ),
      ).rejects.toThrow(/EADDRINUSE/);
      vi.spyOn(AiWatchMode.prototype, "start").mockRejectedValueOnce(
        new Error("watch unavailable"),
      );
      await expect(
        createProgram({ createApplication }).parseAsync(["--watch-files"], {
          from: "user",
        }),
      ).rejects.toThrow("watch unavailable");
      for (const app of applications)
        expect(() =>
          app.createSession({ principal: "late", sessionId: "late" }),
        ).toThrow(/closed/);
      expect(process.listenerCount("SIGTERM")).toBe(listeners);
    } finally {
      await new Promise<void>((done) => socket.close(() => done()));
    }
  });

  it("prints token and cost accounting after a turn", async () => {
    const root = await fixture();
    await writeFile(join(root, "selected.ts"), "const value = 1;\n");
    const provider = new FakeProvider([
      {
        actions: [
          { type: "text-delta", text: "answered" },
          { type: "finish", reason: "stop" },
          { type: "usage", inputTokens: 1500, outputTokens: 320 },
        ],
      },
    ]);
    let output = "";
    await createProgram({
      cwd: root,
      environment: {},
      writeOutput: (text) => {
        output += text;
      },
      createApplication: async (options) =>
        ConcreteApplicationService.create({
          ...options,
          home: root,
          dependencies: { provider },
        }),
    }).parseAsync(
      [
        "--message",
        "question",
        "--no-git",
        "--model",
        "deepseek",
        "--edit-format",
        "ask",
        "--no-color",
        "selected.ts",
      ],
      { from: "user" },
    );

    // Catalog metadata supplies DeepSeek's prices, so the turn has a cost.
    expect(output).toContain("tokens: 1.5k sent, 320 received");
    expect(output).toMatch(/\$[\d.]+ turn, \$[\d.]+ session/u);
  });

  it("rejects default startup outside a worktree and names the escape", async () => {
    const root = await fixture();

    await expect(
      ConcreteApplicationService.create({
        cwd: root,
        home: root,
        environment: {},
        argv: ["--model", "4o"],
        dependencies: { provider: new FakeProvider([]) },
      }),
    ).rejects.toThrow(/could not open a Git worktree.*--no-git/su);

    // The documented workflow for a directory that is not a worktree.
    await expect(
      ConcreteApplicationService.create({
        cwd: root,
        home: root,
        environment: {},
        argv: ["--no-git", "--model", "4o"],
        dependencies: { provider: new FakeProvider([]) },
      }),
    ).resolves.toBeInstanceOf(ConcreteApplicationService);
  });

  it("expands a directory or glob target at startup and through /add", async () => {
    const root = await fixture();
    await mkdir(join(root, "pkg", "deep"), { recursive: true });
    await writeFile(join(root, "pkg", "one.txt"), "one\n");
    await writeFile(join(root, "pkg", "two.md"), "two\n");
    await writeFile(join(root, "pkg", "deep", "three.txt"), "three\n");

    const started = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o", "--file", "pkg"],
      dependencies: { provider: new FakeProvider([]) },
    });
    expect(
      (
        (await started
          .createSession({ principal: "test", sessionId: "startup" })
          .snapshot()) as { editablePaths: readonly string[] }
      ).editablePaths,
    ).toEqual(["pkg/deep/three.txt", "pkg/one.txt", "pkg/two.md"]);
    await started.close();

    await writeFile(join(root, "pkg", "[ot].txt"), "literal\n");
    await writeFile(join(root, "pkg", "o.txt"), "pattern match\n");
    await writeFile(join(root, "pkg", "t.txt"), "pattern match\n");

    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o", "--edit-format", "ask"],
      dependencies: { provider: new FakeProvider([]) },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "directory",
    });
    const submit = (message: string) =>
      session.submit(message, {
        signal: new AbortController().signal,
        emit: () => undefined,
      });

    // A glob stays inside one segment unless it says otherwise.
    await expect(submit("/add pkg/*.txt")).resolves.toMatchObject({
      response: "Added: pkg/[ot].txt, pkg/o.txt, pkg/one.txt, pkg/t.txt",
    });
    await expect(submit("/drop pkg")).resolves.toMatchObject({
      response:
        "Dropped: pkg/[ot].txt, pkg/deep/three.txt, pkg/o.txt, pkg/one.txt, pkg/t.txt, pkg/two.md",
    });
    await expect(submit("/add pkg/[ot].txt")).resolves.toMatchObject({
      response: "Added: pkg/[ot].txt",
    });
    await expect(submit("/read-only pkg/**/*.txt")).resolves.toMatchObject({
      response:
        "Read-only: pkg/[ot].txt, pkg/deep/three.txt, pkg/o.txt, pkg/one.txt, pkg/t.txt",
    });
    await expect(submit("/drop pkg")).resolves.toMatchObject({
      response:
        "Dropped: pkg/[ot].txt, pkg/deep/three.txt, pkg/o.txt, pkg/one.txt, pkg/t.txt, pkg/two.md",
    });
    // A pattern that matches nothing says so instead of selecting nothing.
    await expect(submit("/add pkg/*.rs")).rejects.toThrow(
      /No file .* matches/u,
    );
    // A file inside it is still selectable, and so is a path that does not exist
    // yet.
    await expect(submit("/add pkg/one.txt")).resolves.toMatchObject({
      response: "Added: pkg/one.txt",
    });
    await expect(submit("/add pkg/new.txt")).resolves.toMatchObject({
      response: "Added: pkg/new.txt",
    });
    await service.close();
  });

  it("production-wires opt-in prompt cache keepalive and cleans it up", async () => {
    const root = await fixture();
    const provider = new FakeProvider([turn("answer"), turn("")]);
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: [
        "--no-git",
        "--model",
        "sonnet",
        "--edit-format",
        "ask",
        "--cache-keepalive-pings",
        "1",
      ],
      dependencies: { provider },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "cache-keepalive",
    });
    vi.useFakeTimers();
    await session.submit("private user turn", {
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(295_000);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.maxOutputTokens).toBe(1);
    expect(JSON.stringify(provider.requests[1])).not.toContain(
      "private user turn",
    );
    await service.close();
    await vi.advanceTimersByTimeAsync(295_000);
    expect(provider.requests).toHaveLength(2);
    vi.useRealTimers();
  });
});
