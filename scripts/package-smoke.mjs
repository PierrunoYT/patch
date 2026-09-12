import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

// `.cmd` shims force `shell: true` on Windows, and a shell command line is one
// string: anything holding a space would otherwise split into two. Node does not
// quote the file either, and the installed shim sits under a temporary directory
// that inherits the user's profile name, so the executable needs the same
// treatment as the arguments.
const useShell = process.platform === "win32";
const quoteForShell = (value) =>
  useShell && /[\s"^&|<>()]/u.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
const shellArguments = (values) =>
  useShell ? values.map(quoteForShell) : values;

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
  const [{ filename, files }] = JSON.parse(packOutput);
  if (files.some(({ path }) => path.startsWith("dist/tests/"))) {
    throw new Error("The packed tarball unexpectedly included compiled tests");
  }
  // `prepack` rebuilds dist from a clean directory, so the tarball must carry
  // the entry points and every runtime resource the build copies. A missing
  // resource only fails at runtime, long after publication.
  const packed = new Set(files.map(({ path }) => path));
  for (const required of [
    "dist/cli.js",
    "dist/index.js",
    "dist/resources/model-aliases.json5",
    "dist/resources/model-settings.yml",
    "dist/resources/model-metadata.json5",
  ]) {
    if (!packed.has(required)) {
      throw new Error(`The packed tarball is missing ${required}`);
    }
  }
  if (!files.some(({ path }) => path.startsWith("dist/resources/repomap/"))) {
    throw new Error(
      "The packed tarball is missing the repository-map resources",
    );
  }
  // An installed copy must carry the documents its own README and help text
  // point at, so the policies a user has to read are not GitHub-only.
  for (const document of [
    "README.md",
    "LICENSE",
    "NOTICE",
    "CHANGELOG.md",
    "docs/commands.md",
    "docs/terminal.md",
    "docs/filesystem-safety.md",
    "docs/url-fetching.md",
    "docs/turn-lifecycle.md",
    "docs/configuration-bootstrap.md",
    "docs/direct-derivations.json",
    "docs/upstream-attribution.md",
  ]) {
    if (!packed.has(document)) {
      throw new Error(`The packed tarball is missing ${document}`);
    }
  }
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

  const executable = quoteForShell(
    join(
      consumerDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "patch.cmd" : "patch",
    ),
  );
  const help = execFileSync(executable, shellArguments(["--help"]), {
    encoding: "utf8",
    shell: useShell,
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
  // Present in the tarball is not present after install; npm can filter, and a
  // documentation-only package change would otherwise go unverified.
  for (const document of ["README.md", "LICENSE", "docs/commands.md"]) {
    if (!existsSync(join(packageRoot, document))) {
      throw new Error(`The installed package is missing ${document}`);
    }
  }
  execFileSync(
    process.execPath,
    [
      join(root, "scripts/lifecycle-smoke.mjs"),
      join(packageRoot, "dist/index.js"),
    ],
    {
      cwd: consumerDirectory,
      stdio: "inherit",
      timeout: 30000,
    },
  );
  // Exercise the installed bin entry point, not just its help/parser. Local
  // All ancillary commands must work from the installed package, then /exit
  // must close the watcher; no provider request is needed for these commands.
  const interactive = execFileSync(
    executable,
    shellArguments([
      "--watch-files",
      "--no-git",
      "--model",
      "4o",
      "--edit-format",
      "ask",
    ]),
    {
      cwd: consumerDirectory,
      env: {
        ...process.env,
        HOME: consumerDirectory,
        USERPROFILE: consumerDirectory,
        OPENAI_API_KEY: "package-smoke-not-a-real-key",
      },
      input: "/help command\n/settings\n/report Packed installation\n/exit\n",
      encoding: "utf8",
      shell: useShell,
      timeout: 15000,
    },
  );
  if (!interactive.includes("commands.md:")) {
    throw new Error("The packed executable could not search installed help");
  }
  if (!interactive.includes("Effective startup settings:")) {
    throw new Error("The packed executable could not display safe settings");
  }
  if (
    !interactive.includes(
      'User-supplied title (review carefully): "Packed installation"',
    ) ||
    !interactive.includes("Nothing was uploaded or opened automatically.")
  ) {
    throw new Error("The packed executable could not render a local report");
  }

  // Prove configuration precedence through the installed bin itself. These
  // runs stop at /settings, so the placeholder key is never sent anywhere.
  const precedenceRoot = join(consumerDirectory, "precedence");
  mkdirSync(precedenceRoot);
  const configuration = join(precedenceRoot, "explicit.patch.yml");
  const dotenv = join(precedenceRoot, "explicit.env");
  execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { writeFileSync } from 'node:fs';
       writeFileSync(${JSON.stringify(configuration)}, 'model: gpt-4o-mini\\nedit-format: ask\\ngit: false\\nencoding: utf-8\\n');
       writeFileSync(${JSON.stringify(dotenv)}, 'PATCH_MODEL=gpt-4o-mini\\nPATCH_EDIT_FORMAT=whole\\nPATCH_ENCODING=utf-16le\\n');`,
  ]);
  const precedenceEnvironment = {
    ...process.env,
    HOME: precedenceRoot,
    USERPROFILE: precedenceRoot,
    OPENAI_API_KEY: "packed-precedence-not-a-real-key",
    PATCH_MODEL: "4o",
    PATCH_EDIT_FORMAT: "diff",
    PATCH_ENCODING: "latin1",
    STARTUP_SECRET: "packed-startup-secret-42c913",
  };
  const runSettings = (args, environment = precedenceEnvironment) =>
    execFileSync(executable, shellArguments(["--watch-files", ...args]), {
      cwd: precedenceRoot,
      env: environment,
      input: "/settings\n/exit\n",
      encoding: "utf8",
      shell: useShell,
      timeout: 15000,
    });
  const configOnly = runSettings(["--config", configuration], {
    ...precedenceEnvironment,
    PATCH_MODEL: undefined,
    PATCH_EDIT_FORMAT: undefined,
    PATCH_ENCODING: undefined,
  });
  if (
    !configOnly.includes("Model: gpt-4o-mini") ||
    !configOnly.includes("Chat mode: ask") ||
    !configOnly.includes("Encoding: utf-8")
  ) {
    throw new Error("Packed CLI did not apply explicit YAML configuration");
  }
  const environmentOnly = runSettings(["--config", configuration]);
  if (
    !environmentOnly.includes("Model: gpt-4o") ||
    !environmentOnly.includes("Chat mode: diff") ||
    !environmentOnly.includes("Encoding: latin1")
  ) {
    throw new Error("Packed CLI environment did not override YAML");
  }
  const dotenvOverEnvironment = runSettings([
    "--config",
    configuration,
    "--env-file",
    dotenv,
  ]);
  if (
    !dotenvOverEnvironment.includes("Model: gpt-4o-mini") ||
    !dotenvOverEnvironment.includes("Chat mode: whole") ||
    !dotenvOverEnvironment.includes("Encoding: utf-16le")
  ) {
    throw new Error(
      "Packed CLI dotenv did not override the initial environment",
    );
  }
  const cliOverDotenv = runSettings([
    "--config",
    configuration,
    "--env-file",
    dotenv,
    "--model",
    "4o",
    "--edit-format",
    "ask",
    "--encoding",
    "utf-8",
  ]);
  if (
    !cliOverDotenv.includes("Model: gpt-4o") ||
    !cliOverDotenv.includes("Chat mode: ask") ||
    !cliOverDotenv.includes("Encoding: utf-8")
  ) {
    throw new Error("Packed CLI arguments did not override dotenv");
  }
  for (const output of [
    configOnly,
    environmentOnly,
    dotenvOverEnvironment,
    cliOverDotenv,
  ]) {
    if (output.includes("packed-startup-secret-42c913")) {
      throw new Error(
        "Packed CLI startup disclosed an unrelated environment value",
      );
    }
  }

  // Run real installed-bin provider turns without a socket or live credential.
  // The preloaded fetch is a deterministic in-process fake at the provider wire
  // boundary and verifies that the second request contains the first exchange.
  const fakeProvider = join(temporaryDirectory, "fake-provider.mjs");
  writeFileSync(
    fakeProvider,
    `
      const secret = 'fake-wire-secret-must-not-render';
      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        const messages = body.messages;
        const users = messages.filter(message => message.role === 'user');
        const last = users.at(-1)?.content;
        if (typeof last !== 'string') throw new Error('fake provider expected text');
        if (last.includes('malformed wire')) {
          return new Response('data: {"choices":[{"delta":{"content":42}}]}\\n\\ndata: [DONE]\\n\\n', {
            headers: { 'content-type': 'text/event-stream' }
          });
        }
        let text;
        if (last.includes('repository map turn')) {
          const context = JSON.stringify(messages);
          if (!context.includes('target.ts') || !context.includes('uncommonTarget')) {
            throw new Error('repository map context was absent: ' + secret);
          }
          if (context.includes('hidden.ts') || context.includes('hiddenSecret')) {
            throw new Error('ignored repository context leaked: ' + secret);
          }
          text = 'deterministic repository-map answer';
        } else if (last.includes('unified recovery turn')) {
          const fence = String.fromCharCode(96).repeat(3);
          text = [
            fence + 'diff',
            '--- a/recovery.ts',
            '+++ b/recovery.ts',
            '@@ -1,3 +1,3 @@',
            ' stale start',
            '-unique old value',
            '+unique new value',
            ' stale end',
            fence,
          ].join('\\n');
        } else if (last.includes('one shot')) {
          text = 'deterministic one-shot answer';
        } else if (last.includes('first turn')) {
          text = 'deterministic first answer';
        } else if (last.includes('second turn')) {
          const retained = messages.some(message =>
            message.role === 'assistant' && message.content === 'deterministic first answer'
          );
          if (!retained || users.length < 2) {
            throw new Error('multi-turn history was not retained: ' + secret);
          }
          text = 'deterministic second answer with retained history';
        } else {
          throw new Error('unexpected fake-provider request: ' + secret);
        }
        const chunks = [
          { choices: [{ delta: { content: text }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: {
            prompt_tokens: 7, completion_tokens: 3
          } }
        ];
        return new Response(
          chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\\n\\n').join('') + 'data: [DONE]\\n\\n',
          { headers: { 'content-type': 'text/event-stream' } }
        );
      };
    `,
  );
  const fakeEnvironment = {
    ...process.env,
    HOME: precedenceRoot,
    USERPROFILE: precedenceRoot,
    OPENAI_API_KEY: "not-a-credential",
    NODE_OPTIONS:
      `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(fakeProvider).href}`.trim(),
  };
  const oneShot = execFileSync(
    executable,
    shellArguments([
      "--no-git",
      "--model",
      "4o",
      "--edit-format",
      "ask",
      "--message",
      "one shot",
    ]),
    {
      cwd: precedenceRoot,
      env: fakeEnvironment,
      encoding: "utf8",
      shell: useShell,
      timeout: 15000,
    },
  );
  if (!oneShot.includes("deterministic one-shot answer")) {
    throw new Error(
      "Packed actual bin did not complete the fake-provider one-shot",
    );
  }
  const multiTurn = execFileSync(
    executable,
    shellArguments([
      "--watch-files",
      "--no-git",
      "--model",
      "4o",
      "--edit-format",
      "ask",
    ]),
    {
      cwd: precedenceRoot,
      env: fakeEnvironment,
      input: "first turn\nsecond turn\n/exit\n",
      encoding: "utf8",
      shell: useShell,
      timeout: 15000,
    },
  );
  if (
    !multiTurn.includes("deterministic first answer") ||
    !multiTurn.includes("deterministic second answer with retained history")
  ) {
    throw new Error("Packed actual bin did not retain fake-provider history");
  }
  const providerMapRoot = join(consumerDirectory, "provider-map");
  mkdirSync(providerMapRoot);
  writeFileSync(
    join(providerMapRoot, "chat.ts"),
    "export const requested = uncommonTarget;\n",
  );
  writeFileSync(
    join(providerMapRoot, "target.ts"),
    "export function uncommonTarget(): number { return 1; }\n",
  );
  writeFileSync(
    join(providerMapRoot, "hidden.ts"),
    "export const hiddenSecret = 'must-not-reach-provider';\n",
  );
  writeFileSync(join(providerMapRoot, ".aiderignore"), "hidden.ts\n");
  execFileSync("git", ["init", "--quiet", providerMapRoot]);
  for (const [key, value] of [
    ["user.name", "Patch Package Smoke"],
    ["user.email", "patch-package-smoke@test.invalid"],
    ["commit.gpgsign", "false"],
  ]) {
    execFileSync("git", ["-C", providerMapRoot, "config", key, value]);
  }
  execFileSync("git", ["-C", providerMapRoot, "add", "."]);
  execFileSync("git", [
    "-C",
    providerMapRoot,
    "commit",
    "--quiet",
    "-m",
    "base",
  ]);
  const repositoryMap = execFileSync(
    executable,
    shellArguments([
      "--model",
      "4o",
      "--edit-format",
      "ask",
      "--file",
      "chat.ts",
      "--message",
      "repository map turn",
    ]),
    {
      cwd: providerMapRoot,
      env: fakeEnvironment,
      encoding: "utf8",
      shell: useShell,
      timeout: 15000,
    },
  );
  if (!repositoryMap.includes("deterministic repository-map answer")) {
    throw new Error("Packed actual bin did not send repository-map context");
  }
  const recoveryRoot = join(consumerDirectory, "unified-recovery");
  mkdirSync(recoveryRoot);
  writeFileSync(
    join(recoveryRoot, "recovery.ts"),
    "actual start\nunique old value\nactual end\n",
  );
  execFileSync(
    executable,
    shellArguments([
      "--no-git",
      "--model",
      "4o",
      "--edit-format",
      "udiff",
      "--file",
      "recovery.ts",
      "--message",
      "unified recovery turn",
    ]),
    {
      cwd: recoveryRoot,
      env: fakeEnvironment,
      encoding: "utf8",
      shell: useShell,
      timeout: 15000,
    },
  );
  if (
    readFileSync(join(recoveryRoot, "recovery.ts"), "utf8") !==
    "actual start\nunique new value\nactual end\n"
  ) {
    throw new Error("Packed actual bin did not apply partial-context recovery");
  }
  const malformed = spawnSync(
    executable,
    shellArguments([
      "--no-git",
      "--model",
      "4o",
      "--edit-format",
      "ask",
      "--message",
      "malformed wire",
    ]),
    {
      cwd: precedenceRoot,
      env: fakeEnvironment,
      encoding: "utf8",
      shell: useShell,
      timeout: 15000,
    },
  );
  if (
    malformed.status === 0 ||
    !malformed.stderr.includes("could not read") ||
    malformed.stderr.includes("fake-wire-secret-must-not-render")
  ) {
    throw new Error(
      "Packed actual bin did not safely reject malformed provider data",
    );
  }
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
        // Every language the packed map ships: a grammar or query that failed to
        // pack only shows up when a real file of that language is extracted.
        const fixtures = {
          'sample.js': 'function javascriptName() {}\\njavascriptName();\\n',
          'sample.ts': 'function typescriptName(): void {}\\ntypescriptName();\\n',
          'sample.tsx': 'export function TsxName() {\\n  return null;\\n}\\nconst used = TsxName;\\n',
          'sample.py': 'def python_name():\\n    pass\\n\\npython_name()\\n',
          'sample.go': 'package main\\nfunc goName() {}\\nfunc main() { goName() }\\n',
          'sample.rs': 'fn rust_name() {}\\nfn main() { rust_name(); }\\n',
          'sample.sh': 'bash_name() {\\n  echo hi\\n}\\nbash_name\\n',
          'sample.cpp': 'int cppName() { return 0; }\\nint main() { return cppName(); }\\n',
          'sample.cs': 'class CsharpName {\\n  public CsharpName Make() { return new CsharpName(); }\\n}\\n',
          'sample.java': 'class JavaName {\\n  void run() {}\\n}\\n',
          'sample.rb': 'def ruby_name\\n  1\\nend\\nruby_name\\n',
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
