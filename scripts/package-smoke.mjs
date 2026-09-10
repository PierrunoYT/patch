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
  const help = execFileSync(executable, ["--help"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (!help.includes("Usage: patch [options]")) {
    throw new Error("The packed executable did not print Patch help");
  }

  const packageRoot = join(
    consumerDirectory,
    "node_modules",
    "@pierrunoyt",
    "patch",
  );
  // Exercise the installed bin entry point, not just its help/parser. /exit
  // must construct and close a watcher without making a provider request.
  execFileSync(
    executable,
    ["--watch-files", "--no-git", "--model", "4o", "--edit-format", "ask"],
    {
      cwd: consumerDirectory,
      env: {
        ...process.env,
        HOME: consumerDirectory,
        USERPROFILE: consumerDirectory,
        OPENAI_API_KEY: "package-smoke-not-a-real-key",
      },
      input: "/exit\n",
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 15000,
    },
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

  const startup = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
      import assert from 'node:assert/strict';
      import { mkdir, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { createProgram } from './dist/program.js';
      import { ConcreteApplicationService, FakeProvider } from './dist/index.js';
      const root = join(process.cwd(), '.startup-smoke');
      await mkdir(root);
      await writeFile(join(root, '.patch.conf.yml'), 'model: 4o\\ngit: false\\nedit-format: ask\\n');
      const token = 'package-smoke-not-a-real-secret-123456';
      await writeFile(join(root, 'token'), token);
      const provider = new FakeProvider(['one-shot', 'interactive', 'web'].map(text => ({
        actions: [{ type: 'text-delta', text }, { type: 'finish', reason: 'stop' }]
      })));
      let output = '';
      const dependencies = {
        cwd: root, environment: {}, writeOutput: text => { output += text; },
        createApplication: options => ConcreteApplicationService.create({ ...options, home: root, dependencies: { provider } })
      };
      await createProgram(dependencies).parseAsync(['--message', 'first'], { from: 'user' });
      await createProgram({ ...dependencies, lines: (async function* () { yield 'second'; })() })
        .parseAsync(['--watch-files'], { from: 'user' });
      assert.match(output, /one-shot/);
      assert.match(output, /interactive/);
      output = '';
      const controller = new AbortController();
      let ready;
      const listening = new Promise(resolve => { ready = resolve; });
      const running = createProgram({ ...dependencies, signal: controller.signal,
        writeOutput: text => { output += text; if (output.includes('listening')) ready(); }
      }).parseAsync(['--web', '--web-token-file', 'token'], { from: 'user' });
      try {
        await Promise.race([listening, running]);
        const base = output.match(/http:\\/\\/127\\.0\\.0\\.1:\\d+/)[0];
        const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
        const created = await fetch(base + '/sessions', { method: 'POST', headers });
        assert.equal(created.status, 201);
        const { sessionId } = await created.json();
        const result = await fetch(base + '/sessions/' + sessionId + '/messages', {
          method: 'POST', headers, body: JSON.stringify({ message: 'third' })
        });
        assert.equal((await result.json()).result.response, 'web');
        assert.equal(provider.requests.length, 3);
        assert(!output.includes(token));
      } finally { controller.abort(); await running; }
      process.stdout.write('application-startup-ok');
    `,
    ],
    { cwd: packageRoot, encoding: "utf8", timeout: 30000 },
  );
  if (startup !== "application-startup-ok") {
    throw new Error("Packed application interface startup failed");
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
