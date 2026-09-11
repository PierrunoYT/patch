import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("completes commands, selected files, and nothing else", () => {
    const terminal = reader({
      commands: COMMAND_NAMES,
      files: ["src/one.ts", "src/two.ts"],
    });

    // A leading slash completes command names.
    expect(terminal.complete("/ch")).toEqual([["/chat-mode"], "/ch"]);
    // A file command completes from the selected files.
    expect(terminal.complete("/add src/o")).toEqual([["src/one.ts"], "src/o"]);
    // Ordinary prose is left alone rather than being rewritten.
    expect(terminal.complete("no")).toEqual([[], "no"]);
    terminal.close();
  });

  it("offers no completion without configured sources", () => {
    const input = new PassThrough();
    const terminal = new TerminalInput(
      input,
      () => undefined,
      new AbortController().signal,
      () => undefined,
    );

    expect(terminal.complete("/ch")).toEqual([[], "/ch"]);
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
