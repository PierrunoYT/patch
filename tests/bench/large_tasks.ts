// Tasks on a larger codebase: a copy of this repository at a pinned commit (about 10k lines of TypeScript, its unit
// tests, and its AGENTS.md, which the app adds to the model's instructions). Each run gets a fresh copy with no git
// remote, so nothing can be pushed anywhere, and a shared copy of node_modules (not this checkout's), so a model that
// runs `npm install` cannot change the developer's dependencies.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { changedFiles, node, type Task, type Verdict } from './task';

// The commit the tasks are written against. Tasks inject their bugs by exact text replacement, so a newer commit may
// need the replacements updated; `PATCH_BENCH_SELFTEST=1` proves them without spending anything.
export const LARGE_BASE = '8b0d536';

const REPO = resolve(__dirname, '../..');
const SUFFIX =
  " Don't commit or push. Check your work with `npm run typecheck` and `npm run test:unit`; don't run the end-to-end tests.";

let base: string | null = null;
let modules: string | null = null;

// Exports the pinned commit (with a temporary index, so this checkout's index and HEAD are untouched) and copies
// node_modules once per benchmark run.
export function prepareLargeBase(): void {
  if (base) return;
  base = mkdtempSync(join(tmpdir(), 'patch-bench-base-'));
  const index = join(base, '..', `${base.split(/[\\/]/).pop()}.index`);
  const exported = spawnSync('git', [`--work-tree=${base}`, 'checkout', LARGE_BASE, '--', '.'], {
    cwd: REPO,
    env: { ...process.env, GIT_INDEX_FILE: index },
    encoding: 'utf8',
  });
  rmSync(index, { force: true });
  if (exported.status !== 0) throw new Error(`Could not export ${LARGE_BASE}: ${exported.stderr}`);
  modules = mkdtempSync(join(tmpdir(), 'patch-bench-modules-'));
  cpSync(join(REPO, 'node_modules'), join(modules, 'node_modules'), { recursive: true });
}

export function cleanupLargeBase(): void {
  if (base) rmSync(base, { recursive: true, force: true });
  if (modules) rmSync(modules, { recursive: true, force: true });
  base = modules = null;
}

function git(project: string, ...args: string[]): void {
  spawnSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.test', ...args], {
    cwd: project,
    windowsHide: true,
  });
}

// A fresh copy of the pinned commit with `mutate` applied, committed as the starting point so `git diff` shows only
// what the model changes.
export function createLargeProject(mutate?: (project: string) => void): string {
  prepareLargeBase();
  const project = mkdtempSync(join(tmpdir(), 'patch-bench-large-'));
  cpSync(base!, project, { recursive: true });
  symlinkSync(join(modules!, 'node_modules'), join(project, 'node_modules'), 'junction');
  mutate?.(project);
  git(project, 'init', '-q');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'Benchmark starting point');
  return project;
}

// Removes a project made by createLargeProject without following its node_modules link into the shared copy.
export function removeLargeProject(project: string): void {
  const link = join(project, 'node_modules');
  if (existsSync(link)) {
    try {
      unlinkSync(link);
    } catch {
      rmdirSync(link);
    }
  }
  rmSync(project, { recursive: true, force: true });
}

function replaceIn(project: string, file: string, from: string, to: string): void {
  const path = join(project, file);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`${file} does not contain ${JSON.stringify(from)} (stale LARGE_BASE?)`);
  writeFileSync(path, text.split(from).join(to));
}

const vitest = (project: string, files: string[]) =>
  node(project, ['node_modules/vitest/vitest.mjs', 'run', '--project', 'unit', ...files]);

function typecheck(project: string): boolean {
  return (
    node(project, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.node.json']).ok &&
    node(project, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.web.json']).ok
  );
}

// Runs a test the model never saw, then removes it.
function hiddenTest(project: string, file: string, content: string): boolean {
  const path = join(project, file);
  writeFileSync(path, content);
  try {
    return vitest(project, [file]).ok;
  } finally {
    rmSync(path, { force: true });
  }
}

const unchanged = (project: string, before: Map<string, string>, file: string) =>
  !changedFiles(project, before).includes(file);

function textFiles(project: string, roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(join(project, dir))) return;
    for (const entry of readdirSync(join(project, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|md|mjs|json|css|html)$/.test(entry.name)) out.push(path);
    }
  };
  for (const root of roots) {
    if (root.includes('.')) {
      if (existsSync(join(project, root))) out.push(root);
    } else walk(root);
  }
  return out;
}

const fail = (why: string): Verdict => ({ ok: false, why });
const pass = (why: string): Verdict => ({ ok: true, why });

const EXPORT_REGEX = String.raw`/[<>:"/\\|?*\u0000-\u001f]/g`;
const EXPORT_BROKEN = String.raw`/[<>:"/|*\u0000-\u001f]/g`;
const NETWORK_SOURCE = 'src/main/agent/allowed_network_hosts.ts';
const NETWORK_TEST = 'src/main/agent/allowed_network_hosts.test.ts';

// Changes to the network allow-list that good tests should catch.
const NETWORK_MUTANTS: Array<[string, string]> = [
  // No trailing newline in the search text: the export may use CRLF line endings.
  ["if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;", ''],
  [
    'return allowed.has(url.hostname.toLowerCase());',
    'return [...allowed].some((host) => url.hostname.toLowerCase().endsWith(host));',
  ],
  ['.map((line) => line.trim().toLowerCase())', '.map((line) => line.toLowerCase())'],
];

const TASKS: Task[] = [
  {
    id: 'export-bug',
    suite: 'large',
    description: 'Find a bug from a user-visible symptom, without a file hint',
    create: () =>
      createLargeProject((project) => replaceIn(project, 'src/shared/export.ts', EXPORT_REGEX, EXPORT_BROKEN)),
    prompt:
      "When a chat whose title contains a question mark or a backslash is exported, the suggested Markdown file name keeps those characters, and Windows refuses to save the file. Find the cause and fix it. Don't change the tests." +
      SUFFIX,
    check(project, _answer, before) {
      if (!unchanged(project, before, 'src/shared/export.test.ts')) return fail('changed the tests');
      if (!vitest(project, ['src/shared/export.test.ts']).ok) return fail('export tests fail');
      const hidden = hiddenTest(
        project,
        'src/shared/zz_bench_hidden.test.ts',
        `import { expect, it } from 'vitest';
import { exportFileName } from './export';
it('strips characters Windows rejects', () => {
  expect(exportFileName('Why? a\\\\b')).toBe('Why a b.md');
  expect(exportFileName('C:/x|y*z')).toBe('C x y z.md');
});
`,
      );
      return hidden ? pass('fixed; hidden cases pass') : fail('hidden cases fail');
    },
    solve: (project) => replaceIn(project, 'src/shared/export.ts', EXPORT_BROKEN, EXPORT_REGEX),
  },
  {
    id: 'retry-limit',
    suite: 'large',
    description: 'Fix an off-by-one that contradicts the documented behavior',
    create: () =>
      createLargeProject((project) =>
        replaceIn(project, 'src/main/agent/retry.ts', 'if (attempt >= MAX_RETRIES ||', 'if (attempt > MAX_RETRIES ||'),
      ),
    prompt:
      "A request that keeps failing with HTTP 503 is retried five times, but the README promises at most four retries. Find the cause and fix the code so it matches the documented behavior. Don't change the tests or the docs." +
      SUFFIX,
    check(project, _answer, before) {
      if (!unchanged(project, before, 'src/main/agent/retry.test.ts')) return fail('changed the tests');
      if (!unchanged(project, before, 'README.md')) return fail('changed the README');
      if (!readFileSync(join(project, 'src/main/agent/retry.ts'), 'utf8').includes('MAX_RETRIES = 4'))
        return fail('changed MAX_RETRIES instead of the check');
      return vitest(project, ['src/main/agent/retry.test.ts']).ok ? pass('retry tests pass') : fail('retry tests fail');
    },
    solve: (project) =>
      replaceIn(project, 'src/main/agent/retry.ts', 'if (attempt > MAX_RETRIES ||', 'if (attempt >= MAX_RETRIES ||'),
  },
  {
    id: 'ipc-channel',
    suite: 'large',
    description: "Add an IPC channel across layers, following the repo's rules",
    create: () => createLargeProject(),
    prompt:
      "Add an IPC channel `history:count` that returns how many chats are saved in the history. Follow this repository's rules for adding IPC channels. No UI is needed." +
      SUFFIX,
    check(project) {
      const ipc = readFileSync(join(project, 'src/shared/ipc.ts'), 'utf8');
      const index = readFileSync(join(project, 'src/main/index.ts'), 'utf8');
      if (!/'history:count':\s*\(\)\s*=>\s*(number|Promise<number>)/.test(ipc)) return fail('not in the InvokeApi map');
      if (!/'history:count':\s*true/.test(ipc)) return fail('not in the INVOKE list');
      if (!/handle\(\s*'history:count'/.test(index)) return fail('no handler in index.ts');
      return typecheck(project) ? pass('map, list, handler; typecheck passes') : fail('typecheck fails');
    },
    solve(project) {
      replaceIn(
        project,
        'src/shared/ipc.ts',
        "'history:search': (query: string) => ChatSummary[];",
        "'history:search': (query: string) => ChatSummary[];\n  'history:count': () => number;",
      );
      replaceIn(
        project,
        'src/shared/ipc.ts',
        "'history:search': true,",
        "'history:search': true,\n  'history:count': true,",
      );
      replaceIn(
        project,
        'src/main/index.ts',
        "  handle('history:clear', () => {",
        "  handle('history:count', () => chats.list().length);\n  handle('history:clear', () => {",
      );
    },
  },
  {
    id: 'rename-constant',
    suite: 'large',
    description: 'Rename a constant across code, tests and docs',
    create: () => createLargeProject(),
    prompt: 'Rename the constant `TRANSCRIPT_LIMITS` to `TRANSCRIPT_CAPS` everywhere: code, tests and docs.' + SUFFIX,
    check(project) {
      const left = textFiles(project, ['src', 'tests', 'docs', 'README.md', 'AGENTS.md']).filter((file) =>
        readFileSync(join(project, file), 'utf8').includes('TRANSCRIPT_LIMITS'),
      );
      if (left.length > 0) return fail(`old name left in ${left.join(', ')}`);
      if (!readFileSync(join(project, 'src/shared/chat.ts'), 'utf8').includes('export const TRANSCRIPT_CAPS'))
        return fail('TRANSCRIPT_CAPS not exported');
      if (!typecheck(project)) return fail('typecheck fails');
      return vitest(project, ['src/shared/chat.test.ts']).ok
        ? pass('renamed everywhere; checks pass')
        : fail('chat tests fail');
    },
    solve(project) {
      for (const file of textFiles(project, ['src', 'tests', 'docs', 'README.md', 'AGENTS.md'])) {
        const path = join(project, file);
        const text = readFileSync(path, 'utf8');
        if (text.includes('TRANSCRIPT_LIMITS'))
          writeFileSync(path, text.split('TRANSCRIPT_LIMITS').join('TRANSCRIPT_CAPS'));
      }
    },
  },
  {
    id: 'write-tests',
    suite: 'large',
    description: 'Write tests that catch real bugs (scored by mutants)',
    create: () => createLargeProject((project) => rmSync(join(project, NETWORK_TEST))),
    prompt:
      "Write thorough unit tests for `isNetworkUrlAllowed` in src/main/agent/allowed_network_hosts.ts, in a new test file next to it. Cover the cases that matter for security. Don't change the source file." +
      SUFFIX,
    check(project, _answer, before) {
      if (!unchanged(project, before, NETWORK_SOURCE)) return fail('changed the source');
      const tests = readdirSync(join(project, 'src/main/agent'))
        .filter((name) => /network.*\.test\.ts$/.test(name))
        .map((name) => `src/main/agent/${name}`);
      if (tests.length === 0) return fail('no test file');
      if (!vitest(project, tests).ok) return fail('the new tests fail');
      const source = readFileSync(join(project, NETWORK_SOURCE), 'utf8');
      let killed = 0;
      try {
        for (const [from, to] of NETWORK_MUTANTS) {
          if (!source.includes(from)) throw new Error(`mutant does not apply: ${from}`);
          writeFileSync(join(project, NETWORK_SOURCE), source.split(from).join(to));
          if (!vitest(project, tests).ok) killed++;
        }
      } finally {
        writeFileSync(join(project, NETWORK_SOURCE), source);
      }
      const score = `${killed}/${NETWORK_MUTANTS.length} mutants caught`;
      return killed >= 2 ? pass(score) : fail(score);
    },
    // The repository's own tests at LARGE_BASE catch only 1 of the 3 mutants (no non-HTTP URL with a host, no padded
    // list entry), so the reference is a stronger file.
    solve(project) {
      writeFileSync(
        join(project, 'src/main/agent/network_hosts_reference.test.ts'),
        `import { describe, expect, it } from 'vitest';
import { isNetworkUrlAllowed } from './allowed_network_hosts';

describe('isNetworkUrlAllowed', () => {
  const allowed = '  Example.COM  \\nlocalhost\\n';
  it('matches exact hostnames, ignoring case and padding', () => {
    expect(isNetworkUrlAllowed('https://example.com/path', allowed)).toBe(true);
    expect(isNetworkUrlAllowed('http://localhost:3000/', allowed)).toBe(true);
  });
  it('rejects other hosts, subdomains and look-alikes', () => {
    expect(isNetworkUrlAllowed('https://sub.example.com', allowed)).toBe(false);
    expect(isNetworkUrlAllowed('https://notexample.com', allowed)).toBe(false);
    expect(isNetworkUrlAllowed('https://example.com.evil.test', allowed)).toBe(false);
  });
  it('rejects non-HTTP protocols for an allowed host', () => {
    expect(isNetworkUrlAllowed('ftp://example.com/file', allowed)).toBe(false);
    expect(isNetworkUrlAllowed('ws://example.com/socket', allowed)).toBe(false);
  });
});
`,
      );
    },
  },
  {
    id: 'question-decline',
    suite: 'large',
    description: 'Answer an architecture question without editing',
    create: () => createLargeProject(),
    prompt:
      'Without changing any files: when the agent gets a batch of several tool calls and the user declines one of them without giving feedback, what happens to the remaining calls in that batch, and in which file and function is that decided?',
    check(project, answer, before) {
      const changed = changedFiles(project, before);
      if (changed.length > 0) return fail(`changed ${changed.slice(0, 3).join(', ')}`);
      const right =
        /agent\.ts/.test(answer) &&
        /runTools/.test(answer) &&
        /(not run|aren't run|are not run|skip|won't run|will not run|never run|not execut)/i.test(answer);
      return right ? pass('correct answer, no changes') : fail('answer incomplete');
    },
    referenceAnswer:
      'In src/main/agent/agent.ts, Agent.runTools: a decline without feedback sets `stop`, and the remaining calls in the batch are not run; each gets "Not run: the user declined an earlier action."',
  },
  {
    id: 'settings-cap',
    suite: 'large',
    description: 'Add validation to settings, with a test',
    create: () => createLargeProject(),
    prompt:
      'The `maxIndexedFiles` setting has no upper limit, so a typo like 2000000 makes code indexing try to embed a huge number of files. Cap it at 50,000 wherever settings are loaded or saved, and add a unit test for it.' +
      SUFFIX,
    check(project, _answer, before) {
      const hidden = hiddenTest(
        project,
        'src/main/zz_bench_hidden.test.ts',
        `import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SettingsStore } from './settings';
const cipher = { isAvailable: () => false, encrypt: (text: string) => text, decrypt: (text: string) => text };
it('caps maxIndexedFiles at 50,000 on load and save', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'bench-settings-')), 'settings.json');
  writeFileSync(file, JSON.stringify({ settings: { maxIndexedFiles: 2000000 }, secrets: {} }));
  expect(new SettingsStore(file, cipher).get().maxIndexedFiles).toBe(50000);
  writeFileSync(file, JSON.stringify({ settings: { maxIndexedFiles: 10 }, secrets: {} }));
  const store = new SettingsStore(file, cipher);
  expect(store.get().maxIndexedFiles).toBe(10);
  store.update({ maxIndexedFiles: 999999 });
  expect(store.get().maxIndexedFiles).toBe(50000);
});
`,
      );
      if (!hidden) return fail('hidden test fails');
      const newTests = changedFiles(project, before).filter(
        (file) => file.endsWith('.test.ts') && /50[_,]?000/.test(readFileSync(join(project, file), 'utf8')),
      );
      if (newTests.length === 0) return fail('no test for the cap');
      if (!vitest(project, newTests).ok) return fail('its test fails');
      return typecheck(project) ? pass('capped; its test and the hidden test pass') : fail('typecheck fails');
    },
    solve(project) {
      replaceIn(
        project,
        'src/main/settings.ts',
        'result.maxIndexedFiles = Math.max(1, Math.floor(result.maxIndexedFiles));',
        'result.maxIndexedFiles = Math.min(50_000, Math.max(1, Math.floor(result.maxIndexedFiles)));',
      );
      writeFileSync(
        join(project, 'src/main/settings_cap.test.ts'),
        `import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SettingsStore } from './settings';
it('caps maxIndexedFiles at 50_000', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cap-')), 'settings.json');
  writeFileSync(file, JSON.stringify({ settings: { maxIndexedFiles: 1e9 }, secrets: {} }));
  const store = new SettingsStore(file, { isAvailable: () => false, encrypt: (t: string) => t, decrypt: (t: string) => t });
  expect(store.get().maxIndexedFiles).toBe(50_000);
});
`,
      );
    },
  },
];

// Larger tasks can take several minutes: typecheck and unit tests of the whole repository run in them.
export const LARGE_TASKS: Task[] = TASKS.map((task) => ({ timeoutMs: 12 * 60_000, ...task }));
