import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PtyUnavailableError,
  runPtyCommand,
  type PtyInput,
  type PtyModule,
} from "../src/process/pty.js";

async function* input(events: readonly PtyInput[]): AsyncIterable<PtyInput> {
  yield* events;
}

function fakePty(
  output: readonly string[] = ["done"],
  options: {
    readonly exitAfterOutput?: boolean;
    readonly exitOnKill?: boolean;
  } = {},
): {
  module: PtyModule;
  writes: string[];
  resizes: Array<[number, number]>;
  kills: string[];
  disposals: string[];
  exit: (exitCode?: number) => void;
} {
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  const kills: string[] = [];
  const disposals: string[] = [];
  let exitProcess: (exitCode?: number) => void = () => undefined;
  const module: PtyModule = {
    spawn: () => {
      let dataListener: (data: string) => void = () => undefined;
      let exitListener: (event: { exitCode: number }) => void = () => undefined;
      let exited = false;
      const exit = (exitCode = 0) => {
        if (exited) return;
        exited = true;
        exitListener({ exitCode });
      };
      exitProcess = exit;
      setTimeout(() => {
        if (exited) return;
        for (const chunk of output) dataListener(chunk);
        if (options.exitAfterOutput ?? true) exit();
      }, 10);
      return {
        onData: (listener) => {
          dataListener = listener;
          return { dispose: () => disposals.push("data") };
        },
        onExit: (listener) => {
          exitListener = listener;
          return { dispose: () => disposals.push("exit") };
        },
        write: (data) => writes.push(data),
        resize: (columns, rows) => resizes.push([columns, rows]),
        kill: (signal) => {
          kills.push(signal ?? "default");
          if (options.exitOnKill ?? true) queueMicrotask(() => exit(1));
        },
      };
    },
  };
  return {
    module,
    writes,
    resizes,
    kills,
    disposals,
    exit: (exitCode) => exitProcess(exitCode),
  };
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "patch-pty-"));
}

describe("optional PTY lifecycle", () => {
  it("forwards Ctrl-C as an interrupt character", async () => {
    const fake = fakePty();
    await runPtyCommand("tool", [], {
      root: await root(),
      input: input([{ type: "interrupt" }]),
      loadPty: async () => fake.module,
    });
    expect(fake.writes).toEqual(["\u0003"]);
  });

  it("forwards EOF using the platform control character", async () => {
    const fake = fakePty();
    await runPtyCommand("tool", [], {
      root: await root(),
      input: input([{ type: "eof" }]),
      loadPty: async () => fake.module,
    });
    expect(fake.writes).toEqual([
      process.platform === "win32" ? "\u001a" : "\u0004",
    ]);
  });

  it("resizes and preserves multiline input exactly", async () => {
    const fake = fakePty();
    await runPtyCommand("tool", [], {
      root: await root(),
      input: input([
        { type: "resize", columns: 132, rows: 43 },
        { type: "data", data: "first\nsecond\n" },
      ]),
      loadPty: async () => fake.module,
    });
    expect(fake.resizes).toEqual([[132, 43]]);
    expect(fake.writes).toEqual(["first\nsecond\n"]);
  });

  it("kills the PTY and removes listeners when cancelled", async () => {
    const fake = fakePty();
    const controller = new AbortController();
    const pending = runPtyCommand("tool", [], {
      root: await root(),
      signal: controller.signal,
      loadPty: async () => fake.module,
    });
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      exitCode: 1,
    });
    expect(fake.kills).toEqual(["default"]);
    expect(fake.disposals).toEqual(["data", "exit"]);
  });

  it("sanitizes hostile child sequences even when split across chunks", async () => {
    const fake = fakePty([
      "safe\u001b]2;ow",
      "ned\u0007\u001b[2J\u001bPpayload\u001b",
      "\\done\u0000",
    ]);
    const streamed: string[] = [];
    const result = await runPtyCommand("tool", [], {
      root: await root(),
      loadPty: async () => fake.module,
      onOutput: (text) => streamed.push(text),
    });
    expect(result.output).toBe("safedone");
    expect(streamed.join("")).toBe("safedone");
  });

  it("streams output while retaining a bounded UTF-8 prefix and draining after overflow", async () => {
    const fake = fakePty(["abc", "éZ"], {
      exitAfterOutput: false,
      exitOnKill: false,
    });
    const streamed: string[] = [];
    let settled = false;
    const pending = runPtyCommand("tool", [], {
      root: await root(),
      maxOutputBytes: 4,
      loadPty: async () => fake.module,
      onOutput: (text) => streamed.push(text),
    });
    void pending.then(
      () => void (settled = true),
      () => void (settled = true),
    );
    for (
      let attempt = 0;
      attempt < 100 && fake.kills.length === 0;
      attempt += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 1));

    expect(fake.kills).toEqual(["default"]);
    expect(settled).toBe(false);
    fake.exit(1);
    const result = await pending;

    expect(result).toMatchObject({ output: "abc", truncated: true });
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(4);
    expect(streamed.join("")).toBe("abcéZ");
    expect(fake.disposals).toEqual(["data", "exit"]);
  });

  it("validates the retained transcript byte limit before starting", async () => {
    const fake = fakePty();
    await expect(
      runPtyCommand("tool", [], {
        root: await root(),
        maxOutputBytes: 0,
        loadPty: async () => fake.module,
      }),
    ).rejects.toThrow(/maxOutputBytes must be a positive integer/);
  });

  it("reports an unavailable optional native dependency", async () => {
    await expect(
      runPtyCommand("tool", [], {
        root: await root(),
        loadPty: async () => {
          throw new PtyUnavailableError("not installed");
        },
      }),
    ).rejects.toThrow(PtyUnavailableError);
  });
});
