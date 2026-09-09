import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeModelCommand, executeModelCommands } from "../src/index.js";

const directories: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "patch-command-"));
  directories.push(directory);
  return directory;
}

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("model-suggested command execution", () => {
  it("shows and denies each exact command without executing it", async () => {
    const directory = await root();
    const command = nodeCommand(
      "require('node:fs').writeFileSync('forbidden', '')",
    );
    const events: string[] = [];

    const [result] = await executeModelCommands(
      [command],
      { root: directory },
      {
        show: (shown) => {
          events.push(`show:${shown}`);
        },
        approve: (shown) => {
          events.push(`approve:${shown}`);
          return false;
        },
      },
    );

    expect(events).toEqual([`show:${command}`, `approve:${command}`]);
    expect(result).toMatchObject({ command, status: "denied", exitCode: null });
    await expect(access(join(directory, "forbidden"))).rejects.toThrow();
  });

  it("runs from the canonical repository root", async () => {
    const directory = await root();
    const result = await executeModelCommand(
      nodeCommand("process.stdout.write(process.cwd())"),
      { root: directory },
      { show: () => undefined, approve: () => true },
    );

    expect(result.status).toBe("completed");
    expect(result.stdout).toBe(directory);
  });

  it("caps combined output", async () => {
    const directory = await root();
    const result = await executeModelCommand(
      nodeCommand(
        "process.stdout.write('a'.repeat(100)); process.stderr.write('b'.repeat(100))",
      ),
      { root: directory, maxOutputBytes: 20 },
      { show: () => undefined, approve: () => true },
    );

    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBe(20);
    expect(result.truncated).toBe(true);
  });

  it("terminates timed-out and cancelled commands", async () => {
    const directory = await root();
    const wait = nodeCommand("setTimeout(() => {}, 10_000)");
    const timedOut = await executeModelCommand(
      wait,
      { root: directory, timeoutMs: 20 },
      { show: () => undefined, approve: () => true },
    );
    expect(timedOut.status).toBe("timed-out");

    const controller = new AbortController();
    const pending = executeModelCommand(
      wait,
      { root: directory, timeoutMs: 1_000, signal: controller.signal },
      { show: () => undefined, approve: () => true },
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
  });
});
