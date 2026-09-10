import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "patch-package-"));
const npmCli = process.env.npm_execpath;
const npm = npmCli === undefined ? "npm" : process.execPath;
const npmArguments = (args) =>
  npmCli === undefined ? args : [npmCli, ...args];

try {
  const packOutput = execFileSync(
    npm,
    npmArguments(["pack", "--pack-destination", temporaryDirectory, "--json"]),
    { cwd: root, encoding: "utf8" },
  );
  const [{ filename }] = JSON.parse(packOutput);
  const consumerDirectory = join(temporaryDirectory, "consumer");
  mkdirSync(consumerDirectory);

  execFileSync(
    npm,
    npmArguments([
      "install",
      "--prefix",
      consumerDirectory,
      "--no-audit",
      "--no-fund",
      join(temporaryDirectory, filename),
    ]),
    { stdio: "inherit" },
  );

  const executable = join(
    consumerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "patch.cmd" : "patch",
  );
  const help =
    process.platform === "win32"
      ? execFileSync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", `"${executable}" --help`],
          { encoding: "utf8" },
        )
      : execFileSync(executable, ["--help"], { encoding: "utf8" });

  if (!help.includes("Usage: patch [options]")) {
    throw new Error("The packed executable did not print Patch help");
  }

  const packageRoot = join(
    consumerDirectory,
    "node_modules",
    "@pierrunoyt",
    "patch",
  );
  const model = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { ModelCatalog } from './dist/index.js'; " +
        "const model = (await ModelCatalog.load()).resolve('4o'); " +
        "process.stdout.write(model.canonicalName);",
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );
  if (model !== "gpt-4o") {
    throw new Error("The packed model catalog could not load its resources");
  }

  const repoMap = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { mkdir, writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        import { TagExtractor } from './dist/index.js';
        const root = join(process.cwd(), '.repomap-smoke');
        await mkdir(root);
        const fixtures = {
          'sample.js': 'function javascriptName() {}\\njavascriptName();\\n',
          'sample.ts': 'function typescriptName(): void {}\\ntypescriptName();\\n',
          'sample.py': 'def python_name():\\n    pass\\n\\npython_name()\\n',
          'sample.go': 'package main\\nfunc goName() {}\\nfunc main() { goName() }\\n',
          'sample.rs': 'fn rust_name() {}\\nfn main() { rust_name(); }\\n',
        };
        for (const [path, source] of Object.entries(fixtures)) {
          await writeFile(join(root, path), source);
        }
        const extractor = await TagExtractor.create(root);
        for (const path of Object.keys(fixtures)) {
          const tags = await extractor.extract(path);
          if (!tags.some((tag) => tag.kind === 'definition')) {
            throw new Error('Packed repository-map extraction failed for ' + path);
          }
        }
        process.stdout.write('repository-map-ok');
      `,
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );
  if (repoMap !== "repository-map-ok") {
    throw new Error("The packed repository-map resources could not be used");
  }

  const voice = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import('@pierrunoyt/patch/voice').then(({ VoiceInput }) => process.stdout.write(VoiceInput.name));",
    ],
    { cwd: consumerDirectory, encoding: "utf8" },
  );
  if (voice !== "VoiceInput") {
    throw new Error("The optional packed voice entry point could not load");
  }
  for (const optionalPackage of [
    "node-pty",
    "playwright",
    "playwright-core",
    "@playwright/test",
    "puppeteer",
    "ffmpeg-static",
    "fluent-ffmpeg",
    "naudiodon",
    "node-record-lpcm16",
  ]) {
    if (existsSync(join(consumerDirectory, "node_modules", optionalPackage))) {
      throw new Error(
        `Default install unexpectedly included ${optionalPackage}`,
      );
    }
  }

  process.stdout.write(help);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
