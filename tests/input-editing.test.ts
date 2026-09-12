import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  COMMAND_NAMES,
  collectInputMessages,
  discoverEditor,
  editInExternalEditor,
  parseCommand,
  splitEditorCommand,
  TerminalInput,
  terminalKeyBindings,
  type CompletionSources,
} from "../src/index.js";
import { TerminalHistory } from "../src/io/history.js";

async function* lines(values: readonly string[]): AsyncIterable<string> {
  yield* values;
}

async function collect(values: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const value of values) result.push(value);
  return result;
}

describe("rich input editing", () => {
  it("collects tagged multiline blocks without consuming following input", async () => {
    const messages = await collect(
      collectInputMessages(
        lines(["{task", "first", "", "second", "task}", "next"]),
      ),
    );
    expect(messages).toEqual(["first\n\nsecond", "next"]);
  });

  it("collects multiline mode through EOF as one message", async () => {
    expect(
      await collect(collectInputMessages(lines(["first", "second"]), true)),
    ).toEqual(["first\nsecond"]);
  });

  it("maps Emacs and Vi Enter behavior while retaining editor and history keys", () => {
    expect(terminalKeyBindings("emacs", true)).toContainEqual({
      key: "enter",
      action: "newline",
    });
    expect(terminalKeyBindings("vi", true)).toEqual(
      expect.arrayContaining([
        { key: "enter", action: "newline", when: "insert" },
        { key: "enter", action: "submit", when: "normal" },
        { key: "ctrl-x ctrl-e", action: "external-editor" },
      ]),
    );
  });

  it("discovers and parses configured editor commands", () => {
    expect(
      discoverEditor({ EDITOR: "nano", VISUAL: "code --wait" }, "linux"),
    ).toBe("code --wait");
    expect(splitEditorCommand('code --wait --name "Patch input"')).toEqual([
      "code",
      "--wait",
      "--name",
      "Patch input",
    ]);
    expect(() => splitEditorCommand("editor '")).toThrow(/unterminated/u);
  });

  it("round-trips content through an argv-based external editor", async () => {
    const script =
      "const fs=require('node:fs');const p=process.argv[1];fs.appendFileSync(p,'\\nedited\\n')";
    await expect(
      editInExternalEditor("start", {
        editor: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      }),
    ).resolves.toBe("start\nedited");
  });
});

// Control bytes the terminal sends for these chords, named so the source stays
// readable rather than carrying invisible characters.
const ALT_ENTER = `${String.fromCharCode(0x1b)}\r`;
const CTRL_X = String.fromCharCode(0x18);
const CTRL_E = String.fromCharCode(0x05);
const CTRL_C = String.fromCharCode(0x03);
const CTRL_D = String.fromCharCode(0x04);

describe("terminal completion and recall", () => {
  const reader = (sources: CompletionSources) => {
    const input = new PassThrough();
    const terminal = new TerminalInput(
      input,
      () => undefined,
      new AbortController().signal,
      () => undefined,
      { completionSources: () => sources },
    );
    return terminal;
  };

  it("completes commands, selected files, and nothing else", async () => {
    const terminal = reader({
      commands: COMMAND_NAMES,
      files: ["src/one.ts", "src/two.ts"],
    });

    // A leading slash completes command names.
    await expect(terminal.complete("/ch")).resolves.toEqual([
      ["/chat-mode"],
      "/ch",
    ]);
    // A file command completes from the selected files.
    await expect(terminal.complete("/add src/o")).resolves.toEqual([
      ["src/one.ts"],
      "src/o",
    ]);
    // Ordinary prose is left alone rather than being rewritten.
    await expect(terminal.complete("no")).resolves.toEqual([[], "no"]);
    terminal.close();
  });

  it("offers no completion without configured sources", async () => {
    const input = new PassThrough();
    const terminal = new TerminalInput(
      input,
      () => undefined,
      new AbortController().signal,
      () => undefined,
    );

    await expect(terminal.complete("/ch")).resolves.toEqual([[], "/ch"]);
    terminal.close();
  });

  it("reads recallable history and tolerates a damaged file", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-recall-"));
    const path = join(root, "input.jsonl");
    try {
      const history = new TerminalHistory({ input: path });
      await history.appendInput("first question");
      await history.appendInput("second question");
      // Another session can truncate a line mid-write.
      await appendFile(path, '"third question"\n{"not":"a string"}\nbroken\n');

      // Oldest first; unreadable lines are skipped, not fatal.
      await expect(history.readInput()).resolves.toEqual([
        "first question",
        "second question",
        "third question",
      ]);
      await expect(new TerminalHistory().readInput()).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues a message on alt-enter and submits it on enter", async () => {
    const input = new PassThrough();
    const terminal = new TerminalInput(
      input,
      () => undefined,
      new AbortController().signal,
      () => undefined,
    );
    const messages: string[] = [];
    const reading = (async () => {
      for await (const message of terminal) messages.push(message);
    })();

    input.write("first line");
    // Alt-Enter holds the line instead of submitting it.
    input.write(ALT_ENTER);
    await new Promise((resolve) => setImmediate(resolve));
    input.write("second line\r");
    await new Promise((resolve) => setImmediate(resolve));
    terminal.close();
    await reading;

    expect(messages).toEqual(["first line\nsecond line"]);
  });

  it("edits the whole draft externally and waits for enter to submit", async () => {
    const input = new PassThrough();
    const script =
      "const fs=require('node:fs');const p=process.argv[1];fs.writeFileSync(p,'edited one\\nedited two')";
    const terminal = new TerminalInput(
      input,
      () => undefined,
      new AbortController().signal,
      () => undefined,
      {
        editor: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      },
    );
    const messages: string[] = [];
    const reading = (async () => {
      for await (const message of terminal) messages.push(message);
    })();

    input.write("draft");
    // Ctrl-X Ctrl-E hands the draft over and puts the result back.
    input.write(CTRL_X);
    input.write(CTRL_E);
    for (let wait = 0; wait < 200 && messages.length === 0; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (terminal.draft === "edited two") break;
    }
    expect(terminal.draft).toBe("edited two");
    // Nothing is submitted until the user presses enter.
    expect(messages).toEqual([]);

    input.write("\r");
    await new Promise((resolve) => setImmediate(resolve));
    terminal.close();
    await reading;

    expect(messages).toEqual(["edited one\nedited two"]);
  });

  it("hands the terminal to an interactive child and takes it back", async () => {
    const input = new PassThrough();
    const terminal = new TerminalInput(
      input,
      () => undefined,
      new AbortController().signal,
      () => undefined,
      { history: ["earlier question"] },
    );
    const messages: string[] = [];
    const reading = (async () => {
      for await (const message of terminal) messages.push(message);
    })();

    input.write("half-typed");
    await new Promise((resolve) => setImmediate(resolve));
    const raw: string[] = [];
    await terminal.suspend(async (released) => {
      const listener = (chunk: Buffer) => void raw.push(chunk.toString("utf8"));
      released.on("data", listener);
      released.resume();
      // Keystrokes belong to the child, including the Enter that would
      // otherwise submit the message being typed.
      input.write("child input\r");
      await new Promise((resolve) => setImmediate(resolve));
      released.off("data", listener);
      released.pause();
    });
    expect(raw).toEqual(["child input\r"]);
    expect(messages).toEqual([]);
    // The draft survives the handover and the next Enter submits it.
    expect(terminal.draft).toBe("half-typed");

    input.write(" and the rest\r");
    await new Promise((resolve) => setImmediate(resolve));
    terminal.close();
    await reading;

    expect(messages).toEqual(["half-typed and the rest"]);
  });

  it("recovers from Ctrl-C and ends the iterator on EOF", async () => {
    const input = new PassThrough();
    const interrupts: number[] = [];
    const terminal = new TerminalInput(
      input,
      () => undefined,
      new AbortController().signal,
      () => void interrupts.push(1),
    );
    const messages: string[] = [];
    const reading = (async () => {
      for await (const message of terminal) messages.push(message);
    })();

    input.write("abandoned");
    await new Promise((resolve) => setImmediate(resolve));
    input.write(CTRL_C);
    await new Promise((resolve) => setImmediate(resolve));
    expect(interrupts).toHaveLength(1);

    // The session continues: the next line is a message, not a continuation of
    // the abandoned one.
    input.write("kept\r");
    await new Promise((resolve) => setImmediate(resolve));
    expect(messages).toEqual(["kept"]);

    // Ctrl-D on an empty line ends input rather than leaving the loop hanging.
    input.write(CTRL_D);
    await reading;
    expect(messages).toEqual(["kept"]);
  });

  it("denies a waiting approval on Ctrl-C without closing the reader", async () => {
    const input = new PassThrough();
    let interrupts = 0;
    const terminal = new TerminalInput(
      input,
      () => undefined,
      new AbortController().signal,
      // An interrupt that keeps the reader open, unlike the default, which
      // closes it and denies through the close handler.
      () => {
        interrupts += 1;
      },
    );

    const approval = terminal.confirm("Run", "rm -rf /");
    await new Promise((resolve) => setImmediate(resolve));
    input.write(CTRL_C);

    await expect(approval).resolves.toBe(false);
    expect(interrupts).toBe(1);
    terminal.close();
  });

  it("removes the editor's temporary file even when the editor fails", async () => {
    // The editor is handed the temporary file as its last argument, so it can
    // record which one this call made. Comparing listings of the system
    // temporary directory instead made the test fail whenever another test
    // happened to be running an editor at the same moment.
    const record = join(
      await mkdtemp(join(tmpdir(), "patch-editor-record-")),
      "path.txt",
    );
    const script = `require("fs").writeFileSync(${JSON.stringify(record)}, process.argv[1]); process.exit(3)`;

    await expect(
      editInExternalEditor("draft", {
        editor: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      }),
    ).rejects.toThrow(/status 3/u);

    const used = await readFile(record, "utf8");
    expect(used).toContain("patch-editor-");
    expect(existsSync(used)).toBe(false);
    expect(existsSync(dirname(used))).toBe(false);
  });

  it("names every command the parser accepts", () => {
    // Keeps completion from drifting behind a newly added command. A command
    // may still reject this particular argument; what must not happen is the
    // parser not recognizing the name at all.
    for (const name of COMMAND_NAMES) {
      let thrown: unknown;
      try {
        parseCommand(`/${name} argument`);
      } catch (error) {
        thrown = error;
      }
      expect(String(thrown ?? "")).not.toContain("Unknown command");
    }
    expect(() => parseCommand("/not-a-command")).toThrow(/Unknown command/u);
  });
});
