import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ConcreteApplicationService,
  FakeProvider,
  ModelCatalog,
} from "../src/index.js";
import { createProgram } from "../src/program.js";

describe("application slash commands", () => {
  it("closes replaced and active /model providers under session ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-provider-lifetime-"));
    const closed = [vi.fn(), vi.fn(), vi.fn()];
    let created = 0;
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o"],
      dependencies: {
        createProvider: () => {
          const provider = new FakeProvider([]);
          return {
            stream: provider.stream.bind(provider),
            close: closed[created++]!,
          };
        },
      },
    });
    const session = service.createSession({
      principal: "test",
      sessionId: "provider-lifetime",
    });
    const options = {
      signal: new AbortController().signal,
      emit: () => undefined,
    };

    await session.submit("/model gpt-4o-mini", options);
    await session.submit("/model sonnet", options);
    expect(closed[1]).toHaveBeenCalledOnce();
    expect(closed[0]).not.toHaveBeenCalled();
    expect(closed[2]).not.toHaveBeenCalled();

    await session.close?.();
    expect(closed[2]).toHaveBeenCalledOnce();
    await service.close();
    expect(closed[0]).toHaveBeenCalledOnce();
  });

  it("keeps a completed /model switch when retiring the replaced provider fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-provider-retire-"));
    // The startup provider belongs to the service, so the switch that retires an
    // owned provider is the second one.
    const closed = [
      vi.fn(),
      vi.fn(() => Promise.reject(new Error("socket already gone"))),
      vi.fn(),
    ];
    let created = 0;
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o"],
      dependencies: {
        createProvider: () => {
          const provider = new FakeProvider([]);
          return {
            stream: provider.stream.bind(provider),
            close: closed[created++]!,
          };
        },
      },
    });
    const session = service.createSession({
      principal: "test",
      sessionId: "provider-retire",
    });
    const options = {
      signal: new AbortController().signal,
      emit: () => undefined,
    };

    await session.submit("/model gpt-4o-mini", options);
    // The session has already accepted the new provider by the time the old one
    // is retired, so a rejection there is not a failed switch.
    await expect(
      session.submit("/model sonnet", options),
    ).resolves.toMatchObject({ response: "Model: claude-sonnet-4-6" });
    expect(closed[1]).toHaveBeenCalledOnce();
    expect(closed[2]).not.toHaveBeenCalled();

    // The provider the switch installed is still the live one, and it is torn
    // down exactly once, at close.
    await session.close?.();
    expect(closed[2]).toHaveBeenCalledOnce();
    await service.close();
    // The provider whose close rejected is not closed a second time.
    expect(closed[1]).toHaveBeenCalledOnce();
    expect(closed[0]).toHaveBeenCalledOnce();
  });

  it("does not construct a provider before fallible startup validation finishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-provider-startup-"));
    await writeFile(join(root, "same.txt"), "same\n");
    const createProvider = vi.fn(() => new FakeProvider([]));

    await expect(
      ConcreteApplicationService.create({
        cwd: root,
        home: root,
        environment: {},
        argv: [
          "--no-git",
          "--model",
          "4o",
          "--file",
          "same.txt",
          "--read-only",
          "same.txt",
        ],
        dependencies: { createProvider },
      }),
    ).rejects.toThrow("both editable and read-only");
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("dispatches selected-file, mode, process, clipboard, history, and exit effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-commands-"));
    await writeFile(join(root, "one.txt"), "one\n");
    await writeFile(join(root, "two.txt"), "two\n");
    const provider = new FakeProvider([
      {
        actions: [
          { type: "text-delta", text: "assistant answer" },
          { type: "finish", reason: "stop" },
        ],
      },
      {
        actions: [
          { type: "text-delta", text: "answer about the pasted text" },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    let clipboard = "pasted text";
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: [
        "--no-git",
        "--model",
        "4o",
        "--edit-format",
        "ask",
        "--file",
        "one.txt",
        "--lint-cmd",
        'node -e "process.exit(0)"',
        "--test-cmd",
        'node -e "process.exit(0)"',
      ],
      dependencies: {
        provider,
        approveCommand: () => true,
        readClipboard: async () => clipboard,
        writeClipboard: async (text) => {
          clipboard = text;
        },
      },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "commands",
    });
    const controller = new AbortController();
    const submit = (message: string) =>
      session.submit(message, {
        signal: controller.signal,
        emit: () => undefined,
      });

    await submit("question");
    await submit("/copy");
    expect(clipboard).toBe("assistant answer");
    clipboard = "pasted text";
    await expect(submit("/paste")).resolves.toMatchObject({
      response: "answer about the pasted text",
    });
    expect(provider.requests[1]?.messages).toContainEqual({
      role: "user",
      content: "pasted text",
    });
    await submit("/add two.txt");
    await expect(submit("/ls")).resolves.toMatchObject({
      response: expect.stringContaining("one.txt, two.txt"),
    });
    await submit("/read-only two.txt");
    await expect(submit("/ls")).resolves.toMatchObject({
      response: expect.stringContaining("Read-only: two.txt"),
    });
    await submit("/drop two.txt");
    await submit("/model 4o");
    await submit("/chat-mode ask");
    await expect(
      submit(`/run node -e "require('fs').writeFileSync('ran.txt','yes')"`),
    ).resolves.toMatchObject({ commands: [{ status: "completed" }] });
    expect(await readFile(join(root, "ran.txt"), "utf8")).toBe("yes");
    await expect(submit("/lint")).resolves.toMatchObject({
      response: "lint passed",
    });
    await expect(submit("/test")).resolves.toMatchObject({
      response: "test passed",
    });
    await submit("/clear");
    expect((await session.snapshot()) as { messages: unknown[] }).toMatchObject(
      {
        messages: [],
      },
    );
    await expect(submit("/exit")).resolves.toMatchObject({ exit: true });
    await expect(submit("after exit")).rejects.toThrow(/closed/);
  });

  it("reports both streams, the exit status, and a denial for /run", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-command-output-"));
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o", "--edit-format", "ask"],
      dependencies: {
        provider: new FakeProvider([]),
        approveCommand: (command: string) => !command.includes("refuse"),
      },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "output",
    });
    const submit = (message: string) =>
      session.submit(message, {
        signal: new AbortController().signal,
        emit: () => undefined,
      });

    // Output that went only to stderr, and a non-zero exit, were both invisible.
    const noisy = `/run node -e "process.stdout.write('out');process.stderr.write('err');process.exit(3)"`;
    await expect(submit(noisy)).resolves.toMatchObject({
      response: expect.stringContaining("exit 3"),
      commands: [{ status: "completed", exitCode: 3 }],
    });
    const shown = (await submit(noisy)) as { response: string };
    expect(shown.response).toContain("out");
    expect(shown.response).toContain("stderr:\nerr");

    await expect(submit("/run node -e \"''\" refuse")).resolves.toMatchObject({
      response: expect.stringContaining("denied"),
      commands: [{ status: "denied" }],
    });
    await service.close();
  });

  it("contains command paths and denies unapproved process execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-command-safe-"));
    await writeFile(join(root, "one.txt"), "one\n");
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o", "--edit-format", "ask"],
      dependencies: { provider: new FakeProvider([]) },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "safe",
    });
    const submit = (message: string) =>
      session.submit(message, {
        signal: new AbortController().signal,
        emit: () => undefined,
      });

    await expect(submit("/add ../outside.txt")).rejects.toThrow(/outside/);
    await expect(submit("/run echo denied")).resolves.toMatchObject({
      commands: [{ status: "denied" }],
    });
  });

  it("submits clipboard text as a user turn without reparsing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-command-paste-"));
    const provider = new FakeProvider([
      {
        actions: [
          { type: "text-delta", text: "answered" },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    let clipboard = "   ";
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o", "--edit-format", "ask"],
      dependencies: {
        provider,
        approveCommand: () => true,
        readClipboard: async () => clipboard,
        writeClipboard: async () => undefined,
      },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "paste",
    });
    const submit = (message: string) =>
      session.submit(message, {
        signal: new AbortController().signal,
        emit: () => undefined,
      });

    await expect(submit("/paste")).rejects.toThrow(/clipboard has no text/u);

    // Clipboard content is data, never a command: a crafted clipboard must not
    // reach the process adapter.
    clipboard = `/run node -e "require('fs').writeFileSync('pasted.txt','yes')"`;
    await expect(submit("/paste")).resolves.toMatchObject({
      response: "answered",
      commands: [],
    });
    expect(provider.requests[0]?.messages).toContainEqual({
      role: "user",
      content: clipboard,
    });
    await expect(readFile(join(root, "pasted.txt"), "utf8")).rejects.toThrow();
  });

  it("queues ancillary commands behind a provider turn and cancels a queued draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-command-queue-"));
    const provider = new FakeProvider([
      {
        actions: [
          { type: "delay", milliseconds: 25 },
          { type: "text-delta", text: "turn complete" },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o", "--edit-format", "ask"],
      dependencies: {
        provider,
        reportMetadata: async () => ({
          patchVersion: "0.0.0",
          nodeVersion: "22.1.0",
          platform: "linux",
          release: "6.1.0",
          architecture: "x64",
          gitVersion: "2.51.0",
        }),
      },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "queue",
    });
    const order: string[] = [];
    const options = {
      signal: new AbortController().signal,
      emit: () => undefined,
    };
    const turn = session
      .submit("question", options)
      .then(() => order.push("turn"));
    const help = session
      .submit("/help", options)
      .then(() => order.push("help"));
    const settings = session
      .submit("/settings", options)
      .then(() => order.push("settings"));
    const report = session
      .submit("/report queued", options)
      .then(() => order.push("report"));
    const cancelledController = new AbortController();
    const cancelled = session.submit("/report cancelled", {
      signal: cancelledController.signal,
      emit: () => undefined,
    });
    cancelledController.abort(new Error("cancel queued report"));

    await Promise.all([turn, help, settings, report]);
    await expect(cancelled).rejects.toThrow(/cancel queued report/u);
    expect(order).toEqual(["turn", "help", "settings", "report"]);
  });

  it("dispatches all ancillary commands through the terminal without approvals or controls", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-command-ancillary-cli-"));
    const escape = "\u001b";
    const provider = new FakeProvider([]);
    let output = "";
    let approvalCalls = 0;
    const lines = async function* () {
      yield "/help command";
      yield "/settings";
      yield "/report Terminal review";
      yield "/exit";
    };

    await createProgram({
      cwd: root,
      environment: {},
      lines: lines(),
      outputIsTTY: false,
      writeOutput: (text) => {
        output += text;
      },
      createApplication: (options) =>
        ConcreteApplicationService.create({
          ...options,
          home: root,
          dependencies: {
            provider,
            approvePath: () => {
              approvalCalls += 1;
              return false;
            },
            approveCommand: () => {
              approvalCalls += 1;
              return false;
            },
            authorizeWrite: () => {
              approvalCalls += 1;
              return false;
            },
            reportMetadata: async () => ({
              patchVersion: `0.0.0${escape}[2J`,
              nodeVersion: "22.1.0",
              platform: "linux",
              release: "6.1.0",
              architecture: "x64",
            }),
          },
        }),
    }).parseAsync(["--no-git", "--model", "4o", "--edit-format", "ask"], {
      from: "user",
    });

    expect(output).toContain("commands.md:");
    expect(output).toContain("Effective startup settings:");
    expect(output).toContain(
      'User-supplied title (review carefully): "Terminal review"',
    );
    expect(output).toContain("- Patch: unavailable");
    expect(output).not.toContain(escape);
    expect(approvalCalls).toBe(0);
    expect(provider.requests).toHaveLength(0);
  });

  it("serves local help without calling the provider or changing history", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-command-help-"));
    const provider = new FakeProvider([]);
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o", "--edit-format", "ask"],
      dependencies: { provider },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "help",
    });
    const submit = (message: string) =>
      session.submit(message, {
        signal: new AbortController().signal,
        emit: () => undefined,
      });

    await expect(submit("/help")).resolves.toMatchObject({
      response: expect.stringContaining("/help"),
    });
    await expect(submit("/help command")).resolves.toMatchObject({
      response: expect.stringContaining("commands.md:"),
    });
    expect(provider.requests).toHaveLength(0);
    expect(await session.snapshot()).toMatchObject({ messages: [] });
    await service.close();
  });

  it("renders a local report draft from only allowlisted metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-command-report-"));
    const provider = new FakeProvider([]);
    const secret = "report-secret-3f6ab2";
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: { PRIVATE_TOKEN: secret },
      argv: ["--no-git", "--model", "4o", "--edit-format", "ask"],
      dependencies: {
        provider,
        reportMetadata: async () => ({
          patchVersion: "0.0.0",
          nodeVersion: "22.1.0",
          platform: "linux",
          release: "6.1.0",
          architecture: "x64",
        }),
      },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "report",
    });
    const result = (await session.submit("/report Failure in selected file", {
      signal: new AbortController().signal,
      emit: () => undefined,
    })) as { response: string };

    expect(result.response).toContain(
      'User-supplied title (review carefully): "Failure in selected file"',
    );
    expect(result.response).toContain("- Git: unavailable");
    expect(result.response).toContain(
      "Nothing was uploaded or opened automatically.",
    );
    expect(result.response).not.toContain(root);
    expect(result.response).not.toContain(secret);
    expect(provider.requests).toHaveLength(0);
    expect(await session.snapshot()).toMatchObject({ messages: [] });
  });

  it("cancels report metadata collection without producing a draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-command-report-cancel-"));
    const controller = new AbortController();
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o", "--edit-format", "ask"],
      dependencies: {
        provider: new FakeProvider([]),
        reportMetadata: (signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "report-cancel",
    });
    const pending = session.submit("/report", {
      signal: controller.signal,
      emit: () => undefined,
    });
    controller.abort(new Error("cancel report"));

    await expect(pending).rejects.toThrow(/cancel report/u);
    expect(await session.snapshot()).toMatchObject({ messages: [] });
  });

  it("shows current safe settings after switches without disclosing configuration secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-command-settings-"));
    const apiKey = "settings-api-secret-3e7270";
    const header = "settings-header-secret-8c14b1";
    const endpoint = "https://settings-endpoint-secret.invalid/v1";
    const commandSecret = "settings-command-secret-9d381c";
    const identitySecret = "settings-identity-secret-52f0f1";
    const settingsPath = join(root, "models.yml");
    await writeFile(
      settingsPath,
      [
        "- name: custom-safe",
        "  provider: openai",
        "  editFormat: ask",
        "  extraParameters:",
        `    endpoint: ${JSON.stringify(endpoint)}`,
        "    headers:",
        `      authorization: ${JSON.stringify(header)}`,
      ].join("\n"),
    );
    const catalog = await ModelCatalog.load({ settings: [settingsPath] });
    const provider = new FakeProvider([]);
    const inputHistory = join(root, "input.jsonl");
    const chatHistory = join(root, "chat.md");
    let output = "";
    const lines = async function* () {
      yield "/settings";
      yield "/model 4o";
      yield "/chat-mode whole";
      yield "/settings";
      yield "/exit";
    };

    await createProgram({
      cwd: root,
      environment: {
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: endpoint,
        PATCH_PROVIDER_HEADERS: header,
      },
      outputIsTTY: false,
      writeOutput: (text) => {
        output += text;
      },
      lines: lines(),
      createApplication: (options) =>
        ConcreteApplicationService.create({
          ...options,
          home: root,
          dependencies: { catalog, provider },
        }),
    }).parseAsync(
      [
        "--no-git",
        "--model",
        "custom-safe",
        "--edit-format",
        "ask",
        "--lint-cmd",
        `echo ${commandSecret}`,
        "--test-cmd",
        `echo ${commandSecret}`,
        "--commit-author-name",
        identitySecret,
        "--input-history-file",
        inputHistory,
        "--chat-history-file",
        chatHistory,
      ],
      { from: "user" },
    );

    expect(output).toContain("Model: custom-safe");
    expect(output).toContain("Model: gpt-4o");
    expect(output).toContain("Chat mode: whole");
    expect(output).toContain("Lint command: configured");
    expect(provider.requests).toHaveLength(0);
    const persisted = `${await readFile(inputHistory, "utf8")}\n${await readFile(chatHistory, "utf8")}`;
    for (const secret of [
      apiKey,
      header,
      endpoint,
      commandSecret,
      identitySecret,
    ]) {
      expect(output).not.toContain(secret);
      expect(persisted).not.toContain(secret);
      expect(JSON.stringify(provider.requests)).not.toContain(secret);
      // Do not partially mask credentials: suffixes are omitted too.
      expect(output).not.toContain(secret.slice(-6));
      expect(persisted).not.toContain(secret.slice(-6));
    }
  });
});
