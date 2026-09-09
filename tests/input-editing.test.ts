import { describe, expect, it } from "vitest";

import {
  collectInputMessages,
  discoverEditor,
  editInExternalEditor,
  splitEditorCommand,
  terminalKeyBindings,
} from "../src/index.js";

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
