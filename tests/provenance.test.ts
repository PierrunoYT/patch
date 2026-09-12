import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const checker = join(root, "scripts/check-provenance.mjs");
const ledgerPath = join(root, "docs/direct-derivations.json");

function runChecker(path?: string): string {
  return execFileSync(
    process.execPath,
    path === undefined ? [checker] : [checker, "--ledger", path],
    { cwd: root, encoding: "utf8" },
  );
}

describe("direct-derivation provenance", () => {
  it("verifies every direct Aider derivation and its per-file evidence", () => {
    expect(runChecker()).toMatch(/^Verified \d+ direct derivations\.$/m);
  });

  it("rejects ledger drift instead of trusting package-level attribution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "patch-provenance-"));
    const temporaryLedger = join(directory, "ledger.json");
    try {
      const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
        entries: Array<{
          localPath: string;
          revision: string;
        }>;
      };
      const first = ledger.entries[0];
      if (first === undefined) throw new Error("provenance ledger is empty");
      first.revision = "0000000000000000000000000000000000000000";
      ledger.entries.push({ ...first, localPath: "src/unlisted-port.ts" });
      await writeFile(temporaryLedger, JSON.stringify(ledger));

      expect(() => runChecker(temporaryLedger)).toThrow(
        /revision does not match upstream\.json[\s\S]*listed file does not exist/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
