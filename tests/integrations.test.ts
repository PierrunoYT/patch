import { describe, expect, it } from "vitest";

import {
  ClipboardUnavailableError,
  generateShellCompletion,
  isBrokenPipe,
  notifyUser,
  readClipboardText,
  writeClipboardText,
} from "../src/io/integrations.js";

describe("terminal integrations", () => {
  it("identifies only broken-pipe output errors", () => {
    expect(
      isBrokenPipe(Object.assign(new Error("closed"), { code: "EPIPE" })),
    ).toBe(true);
    expect(
      isBrokenPipe(Object.assign(new Error("denied"), { code: "EACCES" })),
    ).toBe(false);
    expect(isBrokenPipe("EPIPE")).toBe(false);
  });

  it("generates deterministic Bash, Zsh, and Fish completions", () => {
    const inventory = ["--message-file", "--notifications-command", "--help"];
    expect(generateShellCompletion("bash", inventory)).toContain(
      "complete -F _patch patch",
    );
    expect(generateShellCompletion("zsh", inventory)).toMatch(
      /^#compdef patch/u,
    );
    expect(generateShellCompletion("fish", inventory)).toContain(
      "complete -c patch -l message-file",
    );
    for (const shell of ["bash", "zsh", "fish"] as const) {
      expect(generateShellCompletion(shell, inventory)).toContain(
        shell === "fish" ? "notifications-command" : "--notifications-command",
      );
    }
  });

  it("completes only well-formed flags and refuses an empty inventory", () => {
    // Commander reports a value placeholder and repeats; neither belongs in a
    // completion word list.
    expect(
      generateShellCompletion("fish", [
        "--model",
        "--model",
        "<name>",
        "",
        "-m",
      ]),
    ).toBe("complete -c patch -l model\n");
    expect(() => generateShellCompletion("bash", [])).toThrow(
      /at least one option/u,
    );
  });

  it("uses a bell by default and argv for an explicit notification command", async () => {
    let bell = "";
    await notifyUser({}, { write: (text) => (bell += text) });
    expect(bell).toBe("\u0007");

    const calls: unknown[] = [];
    await notifyUser(
      { command: 'notify --title "Patch done"' },
      {
        run: async (...args) => {
          calls.push(args);
          return { stdout: "" };
        },
      },
    );
    expect(calls).toEqual([["notify", ["--title", "Patch done"]]]);
  });

  it("writes and reads text using optional platform clipboard utilities", async () => {
    const calls: unknown[] = [];
    const run = async (...args: [string, readonly string[], string?]) => {
      calls.push(args);
      return { stdout: "pasted text" };
    };
    await writeClipboardText("copied text", { platform: "darwin", run });
    await expect(readClipboardText({ platform: "darwin", run })).resolves.toBe(
      "pasted text",
    );
    expect(calls).toEqual([
      ["pbcopy", [], "copied text"],
      ["pbpaste", [], undefined],
    ]);
  });

  it("selects Wayland utilities and reports missing native integration", async () => {
    let executable = "";
    await writeClipboardText("text", {
      platform: "linux",
      environment: { WAYLAND_DISPLAY: "wayland-0" },
      run: async (command) => {
        executable = command;
        return { stdout: "" };
      },
    });
    expect(executable).toBe("wl-copy");
    await expect(
      readClipboardText({
        platform: "linux",
        environment: {},
        run: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toThrow(ClipboardUnavailableError);
  });
});
