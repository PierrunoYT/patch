import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TerminalHistory } from "../src/io/history.js";

describe("terminal history", () => {
  it("writes multiline input as JSONL and chat as readable Markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-history-"));
    const input = join(root, "private", "input.jsonl");
    const chat = join(root, "private", "chat.md");
    const history = new TerminalHistory({ input, chat });

    await history.appendInput("first\nsecond");
    await history.appendInput("next");
    await history.appendChat("user", "Explain `x`.\nPlease.");
    await history.appendChat("assistant", "Done.");

    expect(
      (await readFile(input, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(["first\nsecond", "next"]);
    expect(await readFile(chat, "utf8")).toBe(
      "## User\n\nExplain `x`.\nPlease.\n\n## Assistant\n\nDone.\n\n",
    );
    if (process.platform !== "win32") {
      expect((await stat(input)).mode & 0o777).toBe(0o600);
      expect((await stat(chat)).mode & 0o777).toBe(0o600);
    }
  });

  it("creates no history unless a path is explicitly configured", async () => {
    const history = new TerminalHistory();
    await expect(history.appendInput("secret")).resolves.toBeUndefined();
    await expect(history.appendChat("user", "secret")).resolves.toBeUndefined();
  });
});
