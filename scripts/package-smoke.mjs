import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "patch-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  const packOutput = execFileSync(
    npm,
    ["pack", "--pack-destination", temporaryDirectory, "--json"],
    { cwd: root, encoding: "utf8" },
  );
  const [{ filename }] = JSON.parse(packOutput);
  const consumerDirectory = join(temporaryDirectory, "consumer");
  mkdirSync(consumerDirectory);

  execFileSync(
    npm,
    [
      "install",
      "--prefix",
      consumerDirectory,
      "--no-audit",
      "--no-fund",
      join(temporaryDirectory, filename),
    ],
    { stdio: "inherit" },
  );

  const executable = join(
    consumerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "patch.cmd" : "patch",
  );
  const help = execFileSync(executable, ["--help"], { encoding: "utf8" });

  if (!help.includes("Usage: patch [options]")) {
    throw new Error("The packed executable did not print Patch help");
  }

  process.stdout.write(help);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
