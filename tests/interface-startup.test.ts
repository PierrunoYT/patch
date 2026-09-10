import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConcreteApplicationService,
  FakeProvider,
  AiWatchMode,
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
});
