import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConcreteApplicationService, FakeProvider } from "../src/index.js";

describe("application slash commands", () => {
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

  it("queues a command submitted during an active provider turn", async () => {
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
      dependencies: { provider },
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
    const command = session
      .submit("/ls", options)
      .then(() => order.push("command"));

    await Promise.all([turn, command]);
    expect(order).toEqual(["turn", "command"]);
  });
});
