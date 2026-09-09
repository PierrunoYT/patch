import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const metadata = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"));
const checkout = resolve(
  process.env.AIDER_CHECKOUT ?? join(dirname(root), "aider-upstream"),
);

function git(...args) {
  return execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
}

if (!existsSync(checkout)) {
  throw new Error(
    `Aider checkout not found at ${checkout}. Set AIDER_CHECKOUT to the pinned checkout.`,
  );
}

const actualCommit = git("rev-parse", "HEAD");
if (actualCommit !== metadata.commit) {
  throw new Error(
    `Aider checkout is at ${actualCommit}; expected ${metadata.commit}`,
  );
}

const actualRemote = git("remote", "get-url", "origin");
if (actualRemote !== metadata.repository) {
  throw new Error(
    `Aider origin is ${actualRemote}; expected ${metadata.repository}`,
  );
}

const defaultPython =
  process.platform === "win32"
    ? join(checkout, ".venv", "Scripts", "python.exe")
    : join(checkout, ".venv", "bin", "python");
const python = process.env.AIDER_PYTHON ?? defaultPython;

if (!existsSync(python)) {
  throw new Error(
    `Aider Python environment not found at ${python}. Create it with ` +
      "`uv venv .venv && uv pip install --python .venv/bin/python -e .` " +
      "inside the external checkout, or set AIDER_PYTHON.",
  );
}

const output = join(
  root,
  "tests",
  "fixtures",
  "upstream",
  `aider-${metadata.commit.slice(0, 8)}.json`,
);

execFileSync(
  python,
  [
    join(root, "scripts", "upstream-fixture-driver.py"),
    "--aider",
    checkout,
    "--expected-remote",
    metadata.repository,
    "--expected-commit",
    metadata.commit,
    "--output",
    output,
  ],
  { cwd: checkout, stdio: "inherit" },
);
