import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runPtyCommand } from "../src/process/pty.js";

const provisioned =
  process.env.PATCH_TEST_PTY === "1" ? describe : describe.skip;

provisioned("explicitly provisioned node-pty", () => {
  it("runs a command through the dynamically loaded native module", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-real-pty-"));
    const result = await runPtyCommand(
      process.execPath,
      ["-e", "process.stdout.write('pty-ready')"],
      { root },
    );

    expect(result).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect(result.output).toContain("pty-ready");
  });
});
