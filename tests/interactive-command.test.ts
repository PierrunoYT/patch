import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  ConcreteApplicationService,
  FakeProvider,
  interactiveShell,
  runInteractiveCommand,
  type PtyModule,
} from "../src/index.js";

/** A PTY that echoes what it is written and exits when told to. */
function fakePty(output: readonly string[] = []): {
  module: PtyModule;
  spawned: Array<[string, string[]]>;
  writes: string[];
  resizes: Array<[number, number]>;
  exit: (code?: number) => void;
} {
  const spawned: Array<[string, string[]]> = [];
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  let finish: (code?: number) => void = () => undefined;
  const module: PtyModule = {
    spawn: (file, args) => {
      spawned.push([file, args]);
      let dataListener: (data: string) => void = () => undefined;
      let exitListener: (event: { exitCode: number }) => void = () => undefined;
      let exited = false;
      finish = (exitCode = 0) => {
        if (exited) return;
        exited = true;
        for (const chunk of output) dataListener(chunk);
        exitListener({ exitCode });
      };
      return {
        onData: (listener) => {
          dataListener = listener;
          return { dispose: () => undefined };
        },
        onExit: (listener) => {
          exitListener = listener;
          return { dispose: () => undefined };
        },
        write: (data) => writes.push(data),
        resize: (columns, rows) => resizes.push([columns, rows]),
        kill: () => finish(1),
      };
    },
  };
  return {
    module,
    spawned,
    writes,
    resizes,
    exit: (code) => finish(code),
  };
}

describe("explicit interactive command dispatch", () => {
  it("chooses the same interpreter the captured path uses", () => {
    expect(interactiveShell("ls -l", "linux", {})).toEqual([
      "/bin/sh",
      ["-c", "ls -l"],
    ]);
    expect(
      interactiveShell("dir", "win32", { ComSpec: "C:\\Windows\\cmd.exe" }),
    ).toEqual(["C:\\Windows\\cmd.exe", ["/d", "/s", "/c", "dir"]]);
    expect(interactiveShell("dir", "win32", {})[0]).toBe("cmd.exe");
  });

  it("forwards keystrokes and resizes, sanitizes output, and releases the terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-interactive-"));
    const pty = fakePty(["ready\u001b]2;owned\u0007> "]);
    const input = new PassThrough() as PassThrough & {
      setRawMode?: (mode: boolean) => void;
    };
    const modes: boolean[] = [];
    input.setRawMode = (mode: boolean) => void modes.push(mode);
    let resize: ((size: { columns: number; rows: number }) => void) | undefined;
    let unsubscribed = false;
    const shown: string[] = [];

    const pending = runInteractiveCommand("sh", {
      root,
      input,
      write: (text) => void shown.push(text),
      platform: "linux",
      environment: {},
      columns: 100,
      rows: 30,
      loadPty: async () => pty.module,
      onResize: (listener) => {
        resize = listener;
        return () => void (unsubscribed = true);
      },
    });

    for (let wait = 0; wait < 200 && pty.spawned.length === 0; wait += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(pty.spawned).toEqual([["/bin/sh", ["-c", "sh"]]]);
    // Raw mode is on, so the child's own line discipline reads the keystrokes.
    expect(modes).toEqual([true]);
    input.write("exit\r");
    resize?.({ columns: 120, rows: 40 });
    await new Promise((done) => setImmediate(done));
    pty.exit(0);

    await expect(pending).resolves.toEqual({
      status: "completed",
      exitCode: 0,
      // The window title escape never reaches the terminal.
      output: "ready> ",
    });
    expect(pty.writes).toEqual(["exit\r"]);
    expect(pty.resizes).toEqual([[120, 40]]);
    expect(shown.join("")).toBe("ready> ");
    expect(modes).toEqual([true, false]);
    expect(unsubscribed).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("rejects an empty command", async () => {
    await expect(
      runInteractiveCommand("  ", {
        root: await mkdtemp(join(tmpdir(), "patch-interactive-empty-")),
        input: new PassThrough(),
        write: () => undefined,
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe("/run --interactive dispatch", () => {
  const service = async (
    root: string,
    dependencies: Record<string, unknown> = {},
  ) =>
    ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o", "--edit-format", "ask"],
      dependencies: { provider: new FakeProvider([]), ...dependencies },
    });

  it("runs an approved command through the injected terminal runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-interactive-run-"));
    await writeFile(join(root, "one.txt"), "one\n");
    const calls: Array<{ command: string; root: string }> = [];
    const application = await service(root, {
      approveCommand: () => true,
      runInteractiveCommand: async (
        command: string,
        options: { root: string },
      ) => {
        calls.push({ command, root: options.root });
        return { status: "completed", exitCode: 0, output: "session output" };
      },
    });
    const session = await application.createSession({
      principal: "test",
      sessionId: "interactive",
    });

    await expect(
      session.submit("/run --interactive sh", {
        signal: new AbortController().signal,
        emit: () => undefined,
      }),
    ).resolves.toMatchObject({
      response: "Interactive command exited with 0",
      commands: [{ status: "completed", stdout: "session output" }],
    });
    expect(calls).toEqual([{ command: "sh", root: application.root }]);
    await application.close();
  });

  it("denies without approval and refuses without a terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-interactive-deny-"));
    let ran = false;
    const denied = await service(root, {
      approveCommand: () => false,
      runInteractiveCommand: async () => {
        ran = true;
        return { status: "completed", exitCode: 0, output: "" };
      },
    });
    const deniedSession = await denied.createSession({
      principal: "test",
      sessionId: "denied",
    });
    await expect(
      deniedSession.submit("/run --interactive sh", {
        signal: new AbortController().signal,
        emit: () => undefined,
      }),
    ).resolves.toMatchObject({ commands: [{ status: "denied" }] });
    expect(ran).toBe(false);
    await denied.close();

    // Without an injected runner the command is refused by name rather than
    // quietly running with no terminal attached.
    const headless = await service(root, { approveCommand: () => true });
    const headlessSession = await headless.createSession({
      principal: "test",
      sessionId: "headless",
    });
    await expect(
      headlessSession.submit("/run --interactive sh", {
        signal: new AbortController().signal,
        emit: () => undefined,
      }),
    ).rejects.toThrow(/needs a terminal/u);
    await headless.close();
  });
});
