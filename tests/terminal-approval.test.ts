import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EOL, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runInput, TerminalInput } from "../src/input.js";
import { createProgram } from "../src/program.js";
import { ConcreteApplicationService, FakeProvider } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const tick = () => new Promise<void>((done) => setImmediate(done));

describe("terminal approval input ownership", () => {
  it("keeps answers out of submitted messages and persistent history", async () => {
    const input = new PassThrough();
    const terminal = new TerminalInput(
      input,
      (text) => {
        if (text.includes("Approve?"))
          queueMicrotask(() => input.write("yes\n"));
      },
      new AbortController().signal,
    );
    const messages: string[] = [];
    const history: string[] = [];
    input.write("request\n");
    await runInput(
      {},
      {
        lines: terminal,
        recordInput: (message) => {
          history.push(message);
        },
        recordChat: (role, message) => {
          history.push(`${role}:${message}`);
        },
        handleMessage: async (message) => {
          messages.push(message);
          expect(await terminal.confirm("Run", "echo $SECRET")).toBe(true);
          return { exit: true, response: "done" };
        },
      },
    );
    expect(messages).toEqual(["request"]);
    expect(history).toEqual(["request", "user:request", "assistant:done"]);
    terminal.close();
  });

  it("does not treat an unterminated yes at EOF as approval", async () => {
    const input = new PassThrough();
    const terminal = new TerminalInput(
      input,
      (text) => {
        if (text.includes("Approve?")) queueMicrotask(() => input.end("yes"));
      },
      new AbortController().signal,
    );
    expect(await terminal.confirm("Run", "echo denied")).toBe(false);
    terminal.close();
  });

  it.each(["y", "yes", "YES", "no", "", " yes", "yes please", "y/n"])(
    "requires an unambiguous answer: %j",
    async (answer) => {
      const input = new PassThrough();
      const terminal = new TerminalInput(
        input,
        (text) => {
          if (text.includes("Approve?"))
            queueMicrotask(() => input.write(`${answer}\n`));
        },
        new AbortController().signal,
      );
      expect(await terminal.confirm("Run", "printf ok")).toBe(
        ["y", "yes", "YES"].includes(answer),
      );
      terminal.close();
    },
  );

  it.each(["yes\nnext\n", "ye"])(
    "preserves queued and partial input rather than approving: %j",
    async (queued) => {
      const input = new PassThrough();
      const terminal = new TerminalInput(
        input,
        () => undefined,
        new AbortController().signal,
      );
      input.write(queued);
      expect(await terminal.confirm("Run", "exit 1")).toBe(false);
      if (queued === "ye") input.write("s\n");
      expect(await terminal[Symbol.asyncIterator]().next()).toEqual({
        done: false,
        value: "yes",
      });
      terminal.close();
    },
  );

  it.each(["abort", "EOF"])(
    "denies pending approval on %s and escapes hostile previews",
    async (action) => {
      const input = new PassThrough();
      const controller = new AbortController();
      let output = "";
      const terminal = new TerminalInput(
        input,
        (text) => {
          output += text;
        },
        controller.signal,
      );
      const result = terminal.confirm("Run", "printf '\u001b\n\u202e' $SECRET");
      await tick();
      if (action === "abort") controller.abort();
      else input.end();
      expect(await result).toBe(false);
      expect(output).toContain("\\u001b\\n\\u202e");
      expect(output).toContain("$SECRET");
      expect(output).not.toContain("\u202e");
      terminal.close();
    },
  );
});

async function run(options: {
  answer?: string;
  cancel?: boolean;
  message: string;
  response?: string;
  argv?: string[];
  tty?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "patch-terminal-approval-"));
  roots.push(root);
  await writeFile(join(root, "existing.txt"), "old\n");
  const input = Object.assign(new PassThrough(), {
    isTTY: options.tty ?? true,
  });
  const controller = new AbortController();
  const provider = new FakeProvider([
    {
      actions: [
        { type: "text-delta", text: options.response ?? "done" },
        { type: "finish", reason: "stop" },
      ],
    },
  ]);
  let output = "";
  let submitted = false;
  const program = createProgram({
    cwd: root,
    environment: {},
    inputStream: input,
    outputIsTTY: true,
    signal: controller.signal,
    ...(options.tty === false
      ? {
          lines: (async function* () {
            yield options.message;
          })(),
        }
      : {}),
    writeOutput: (text) => {
      output += text;
      if (text.includes("Approve?"))
        queueMicrotask(() => {
          if (options.cancel) input.write("\u0003");
          else input.write(`${options.answer ?? ""}\n`);
        });
    },
    createApplication: async (configuration) => {
      const service = await ConcreteApplicationService.create({
        ...configuration,
        home: root,
        dependencies: { ...configuration.dependencies, provider },
      });
      const create = service.createSession.bind(service);
      service.createSession = (context) => {
        const session = create(context);
        const submit = session.submit.bind(session);
        session.submit = async (...args) => {
          try {
            return await submit(...args);
          } finally {
            submitted = true;
            input.end();
          }
        };
        queueMicrotask(() => input.write(`${options.message}\n`));
        return session;
      };
      return service;
    },
  });
  let error: unknown;
  try {
    await program.parseAsync(
      [
        "--no-git",
        "--model",
        "4o",
        "--edit-format",
        "diff",
        ...(options.argv ?? []),
      ],
      { from: "user" },
    );
  } catch (caught) {
    error = caught;
  }
  return { root, output, error, submitted };
}

describe("executable program approvals with the concrete application", () => {
  it.each([
    "watch",
    "web",
    "multiline",
    "message-file",
    "redirected-output",
    "injected-lines",
  ])("does not install terminal approvers for %s", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "patch-approval-gating-"));
    roots.push(root);
    const tokenPath = join(root, "token");
    await writeFile(tokenPath, "a".repeat(32));
    const argv =
      mode === "watch"
        ? ["--watch-files"]
        : mode === "web"
          ? ["--web", "--web-token-file", tokenPath]
          : mode === "multiline"
            ? ["--multiline"]
            : mode === "message-file"
              ? ["--message-file", "task.txt"]
              : [];
    const stopped = new Error("construction inspected");
    await expect(
      createProgram({
        inputStream: Object.assign(new PassThrough(), { isTTY: true }),
        outputIsTTY: mode !== "redirected-output",
        ...(mode === "injected-lines"
          ? {
              lines: (async function* () {
                yield "yes";
              })(),
            }
          : {}),
        createApplication: async (options) => {
          expect(options.dependencies?.authorizeWrite).toBeUndefined();
          expect(options.dependencies?.approveCommand).toBeUndefined();
          throw stopped;
        },
      }).parseAsync(argv, { from: "user" }),
    ).rejects.toBe(stopped);
  });

  it("denies model commands without changing unrelated files", async () => {
    const result = await run({
      answer: "no",
      message: "suggest a command",
      response: "```bash\necho denied > model.txt\n```\n",
    });
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('"echo denied > model.txt\\n"');
    await expect(readFile(join(result.root, "model.txt"))).rejects.toThrow();
  });

  it.each(["yes", "no", "", "yes please"])(
    "gates /run with %j",
    async (answer) => {
      const result = await run({
        answer,
        message: "/run echo approved > command.txt",
      });
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('"echo approved > command.txt"');
      if (answer === "yes")
        expect(
          (await readFile(join(result.root, "command.txt"), "utf8")).trim(),
        ).toBe("approved");
      else
        await expect(
          readFile(join(result.root, "command.txt")),
        ).rejects.toThrow();
    },
  );

  it.each(["new.txt", "existing.txt"])(
    "authorizes exact %s writes and a suggested command",
    async (path) => {
      const result = await run({
        answer: "yes",
        message: "make the change",
        response: `${path}\n\`\`\`text\n<<<<<<< SEARCH\n${path === "existing.txt" ? "old\n" : ""}=======\nchanged\n>>>>>>> REPLACE\n\`\`\`\n\n\`\`\`bash\necho model > model.txt\n\`\`\`\n`,
      });
      expect(result.error).toBeUndefined();
      expect(await readFile(join(result.root, path), "utf8")).toBe(
        path === "new.txt" ? `changed${EOL}` : "changed\n",
      );
      expect(
        (await readFile(join(result.root, "model.txt"), "utf8")).trim(),
      ).toBe("model");
      expect(result.output).toContain(
        path === "new.txt" ? "new-file" : "out-of-chat",
      );
    },
  );

  it.each([false, true])(
    "denies new writes on rejection/cancellation (%s)",
    async (cancel) => {
      const result = await run({
        answer: "no",
        cancel,
        message: "change",
        response:
          "new.txt\n```text\n<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE\n```\n",
      });
      expect(result.submitted).toBe(true);
      await expect(readFile(join(result.root, "new.txt"))).rejects.toThrow();
      expect(await readFile(join(result.root, "existing.txt"), "utf8")).toBe(
        "old\n",
      );
    },
  );

  it.each(["one-shot", "non-TTY", "cancel"])(
    "never executes commands in %s",
    async (mode) => {
      const message = "/run echo unsafe > denied.txt";
      const result = await run({
        message,
        answer: "yes",
        cancel: mode === "cancel",
        ...(mode === "one-shot" ? { argv: ["--message", message] } : {}),
        ...(mode === "non-TTY" ? { tty: false } : {}),
      });
      await expect(readFile(join(result.root, "denied.txt"))).rejects.toThrow();
      if (mode !== "cancel") expect(result.output).not.toContain("Approve?");
    },
  );
});
