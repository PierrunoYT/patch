import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ClipboardUnavailableError,
  generateShellCompletion,
  isBrokenPipe,
  notifyUser,
  readClipboardText,
  runIntegration,
  writeClipboardText,
} from "../src/io/integrations.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

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
      ["pbcopy", [], "copied text", { maxOutputBytes: 1024 * 1024 }],
      ["pbpaste", [], undefined, { maxOutputBytes: 1024 * 1024 }],
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

  it("enforces clipboard input and output byte limits around injected runners", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      return { stdout: "12345" };
    };

    await expect(
      writeClipboardText("oversized", { platform: "darwin", maxBytes: 4, run }),
    ).rejects.toThrow(/exceeds 4 bytes/u);
    expect(calls).toBe(0);
    await expect(
      readClipboardText({ platform: "darwin", maxBytes: 4, run }),
    ).rejects.toThrow(ClipboardUnavailableError);
    expect(calls).toBe(1);
  });

  it("kills and drains timed-out, cancelled, and overproducing utilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-integration-process-"));
    directories.push(root);
    const marker = join(root, "survived.txt");
    const delayedWrite = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 250); setInterval(() => {}, 1000)`;

    await expect(
      runIntegration(process.execPath, ["-e", delayedWrite], undefined, {
        timeoutMs: 20,
        maxOutputBytes: 64,
      }),
    ).rejects.toThrow(/timed out/u);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const controller = new AbortController();
    const cancellation = setTimeout(() => controller.abort(), 20);
    try {
      await expect(
        runIntegration(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          undefined,
          {
            timeoutMs: 1_000,
            maxOutputBytes: 64,
            signal: controller.signal,
          },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(cancellation);
    }

    await expect(
      runIntegration(
        process.execPath,
        ["-e", 'process.stdout.write("x".repeat(4096))'],
        undefined,
        { timeoutMs: 1_000, maxOutputBytes: 64 },
      ),
    ).rejects.toThrow(/output exceeded 64 bytes/u);
  });
});
