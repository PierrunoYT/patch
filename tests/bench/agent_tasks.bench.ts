// Real-model task benchmark: runs self-checking coding tasks through the built app against the real Anthropic API, in
// Auto mode, and records whether each task was solved, how many tool calls and assistant messages it took, the tokens
// and the estimated cost. Results are recorded in docs/PERFORMANCE.md ("Agent task benchmark").
//
// Two suites: `small` (tiny projects written from scratch) and `large` (tasks on a copy of this repository at a pinned
// commit, see large_tasks.ts). A third, `cache` (cache_tasks.ts), measures prompt caching: a subagent run, and a
// follow-up after a pause with the keep-alive off and on. It waits minutes per run, so it only runs when asked for
// (PATCH_BENCH_SUITE=cache) and is not part of `all`. Opt-in and not part of `npm test` or CI, because it spends API
// credits:
//
//   PATCH_BENCH_PROFILE=<a Patch profile folder with a saved Anthropic key> npm run bench:agent
//
// Only `settings.json` and `Local State` are copied from that profile into a throwaway folder (the key stays encrypted;
// `Local State` holds what decrypts it for the same Windows or macOS user). The copy's MCP servers are cleared so none
// start. The real profile is never written to. Options: PATCH_BENCH_MODEL (default claude-sonnet-5-5),
// PATCH_BENCH_REPS (default 2), PATCH_BENCH_SUITE (small, large, all or cache; default all, which is small and large),
// PATCH_BENCH_TASKS (comma-separated task ids), PATCH_BENCH_PAUSE_SECONDS (cache suite pause, default 360).
//
// PATCH_BENCH_SELFTEST=1 checks every task without the API: its check must fail on the untouched project and pass on
// the reference solution.
//
// The tasks run in Auto mode, so the model runs commands without asking, inside a temporary project folder.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot, UsageTotals } from '../../src/shared/chat';
import { estimateCost } from '../../src/shared/models';
import { delay, launchApp } from '../e2e/app';
import { CACHE_TASKS } from './cache_tasks';
import { cleanupLargeBase, LARGE_TASKS, removeLargeProject } from './large_tasks';
import { changedFiles, hashes, type Task } from './task';

const PROFILE = process.env.PATCH_BENCH_PROFILE;
const SELFTEST = process.env.PATCH_BENCH_SELFTEST === '1';
const MODEL = process.env.PATCH_BENCH_MODEL || 'claude-sonnet-5-5';
const REPS = Number(process.env.PATCH_BENCH_REPS || 2);
const SUITE = process.env.PATCH_BENCH_SUITE || 'all';
const ONLY = process.env.PATCH_BENCH_TASKS?.split(',').map((id) => id.trim());
const RUN_TIMEOUT_MS = 8 * 60_000;

type Files = Record<string, string>;

const PACKAGE = JSON.stringify({ name: 'bench', version: '1.0.0', private: true, scripts: { test: 'node --test' } });

function node(project: string, ...args: string[]): { ok: boolean; out: string } {
  const result = spawnSync(process.execPath, args, { cwd: project, encoding: 'utf8', timeout: 60_000 });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` };
}

const testsPass = (project: string) => node(project, '--test').ok;

// Tiny projects written from scratch, one per task.
const SMALL_TASKS: Array<Omit<Task, 'suite' | 'create'> & { files: Files }> = [
  {
    id: 'fix-bugs',
    description: 'Fix two bugs so failing tests pass, without touching the tests',
    files: {
      'package.json': PACKAGE,
      'src/stats.js': `function average(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return sum / (values.length - 1);
}

function median(values) {
  const sorted = [...values].sort();
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

module.exports = { average, median };
`,
      'test/stats.test.js': `const test = require('node:test');
const assert = require('node:assert');
const { average, median } = require('../src/stats');

test('average', () => {
  assert.strictEqual(average([2, 4, 6]), 4);
  assert.strictEqual(average([]), 0);
});

test('median', () => {
  assert.strictEqual(median([10, 2, 33]), 10);
  assert.strictEqual(median([1, 2, 3, 4]), 2.5);
});
`,
    },
    prompt:
      "The tests in this project fail. Find and fix the bugs in src/ so `npm test` passes. Don't change the tests.",
    check(project, _answer, before) {
      if (hashes(project).get('test/stats.test.js') !== before.get('test/stats.test.js'))
        return { ok: false, why: 'changed the tests' };
      return testsPass(project) ? { ok: true, why: 'tests pass' } : { ok: false, why: 'tests still fail' };
    },
  },
  {
    id: 'add-feature',
    description: 'Add a function and tests for it',
    files: {
      'package.json': PACKAGE,
      'src/strings.js': `function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

module.exports = { capitalize };
`,
      'test/strings.test.js': `const test = require('node:test');
const assert = require('node:assert');
const { capitalize } = require('../src/strings');

test('capitalize', () => {
  assert.strictEqual(capitalize('hello'), 'Hello');
});
`,
    },
    prompt:
      'Add a `slugify(text)` function to src/strings.js and export it. It lowercases the text, replaces every run of characters that are not ASCII letters or digits with a single hyphen, and removes hyphens at the start and end. Add tests for it to test/strings.test.js and make sure `npm test` passes.',
    check(project) {
      const hidden = node(
        project,
        '-e',
        `const { slugify } = require('./src/strings');
const cases = [['  Hello, World!  ', 'hello-world'], ['a--b__c', 'a-b-c'], ['---', ''], ['Version 2.0 Release', 'version-2-0-release']];
for (const [input, want] of cases) if (slugify(input) !== want) { console.error(JSON.stringify(input) + ' -> ' + JSON.stringify(slugify(input))); process.exit(1); }`,
      );
      if (!hidden.ok) return { ok: false, why: `hidden tests fail: ${hidden.out.trim().slice(0, 120)}` };
      if (!readFileSync(join(project, 'test/strings.test.js'), 'utf8').includes('slugify'))
        return { ok: false, why: 'no tests for slugify' };
      return testsPass(project)
        ? { ok: true, why: 'hidden tests and npm test pass' }
        : { ok: false, why: 'npm test fails' };
    },
  },
  {
    id: 'rename',
    description: 'Rename a function across four files',
    files: {
      'package.json': PACKAGE,
      'src/user.js': `function getUserName(user) {
  return user.nickname || \`\${user.first} \${user.last}\`;
}

module.exports = { getUserName };
`,
      'src/greeting.js': `const { getUserName } = require('./user');

function greet(user) {
  return \`Hello, \${getUserName(user)}!\`;
}

module.exports = { greet };
`,
      'src/report.js': `const { getUserName } = require('./user');

function report(users) {
  return users.map((user) => \`- \${getUserName(user)}\`).join('\\n');
}

module.exports = { report };
`,
      'test/user.test.js': `const test = require('node:test');
const assert = require('node:assert');
const { getUserName } = require('../src/user');
const { greet } = require('../src/greeting');

test('names', () => {
  assert.strictEqual(getUserName({ first: 'Ada', last: 'Lovelace' }), 'Ada Lovelace');
  assert.strictEqual(greet({ nickname: 'Al' }), 'Hello, Al!');
});
`,
    },
    prompt:
      'Rename the function getUserName to getDisplayName everywhere in this project, including the tests. Keep the behavior the same and make sure `npm test` passes.',
    check(project) {
      const leftovers = [...hashes(project).keys()].filter((file) =>
        readFileSync(join(project, file), 'utf8').includes('getUserName'),
      );
      if (leftovers.length > 0) return { ok: false, why: `old name left in ${leftovers.join(', ')}` };
      const exported = node(
        project,
        '-e',
        "process.exit(typeof require('./src/user').getDisplayName === 'function' ? 0 : 1)",
      );
      if (!exported.ok) return { ok: false, why: 'getDisplayName not exported' };
      return testsPass(project) ? { ok: true, why: 'renamed, tests pass' } : { ok: false, why: 'tests fail' };
    },
  },
  {
    id: 'question',
    description: 'Answer a question about the code without changing files',
    files: {
      'package.json': PACKAGE,
      'README.md': '# fetcher\n\nA tiny HTTP client with retries.\n',
      'src/http.js': `const { delayFor } = require('./retry');

async function fetchWithRetry(url, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetch(url);
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, delayFor(attempt)));
    }
  }
  throw new Error('gave up');
}

module.exports = { fetchWithRetry };
`,
      'src/retry.js': `const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

// Exponential backoff: 500, 1000, 2000, ... capped.
function delayFor(attempt) {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

module.exports = { delayFor };
`,
      'src/log.js': "module.exports = { log: (message) => console.log('[fetcher]', message) };\n",
    },
    prompt:
      'Without changing any files: in which file and function is the retry delay computed, and what is the longest delay in milliseconds?',
    check(project, answer, before) {
      const after = hashes(project);
      const changed = [...before].filter(([file, hash]) => after.get(file) !== hash).map(([file]) => file);
      if (changed.length > 0 || after.size !== before.size) return { ok: false, why: 'changed files' };
      const mentions = /retry\.js/.test(answer) && /delayFor/.test(answer) && /8[,.\s]?000|8 ?s(econds)?/.test(answer);
      return mentions ? { ok: true, why: 'correct answer, no changes' } : { ok: false, why: 'answer incomplete' };
    },
  },
  {
    id: 'cli-fix',
    description: 'Fix a CLI bug and verify it by running the command',
    files: {
      'package.json': PACKAGE,
      'bin/cli.js': `const args = process.argv.slice(2);
const index = args.indexOf('--count');
const count = index === -1 ? 1 : Number(args[index + 1]);

for (let i = 1; i < count; i++) {
  console.log(\`line \${i}\`);
}
`,
    },
    prompt:
      'Running `node bin/cli.js --count 3` should print three lines (line 1, line 2, line 3) but prints only two. Fix it and check the fix by running the command.',
    check(project) {
      const three = node(project, 'bin/cli.js', '--count', '3').out.trim().split(/\r?\n/);
      const one = node(project, 'bin/cli.js').out.trim().split(/\r?\n/);
      const ok = three.join('|') === 'line 1|line 2|line 3' && one.join('|') === 'line 1';
      return ok ? { ok: true, why: 'prints 3 lines and 1 by default' } : { ok: false, why: `got ${three.join('|')}` };
    },
  },
];

const TASKS: Task[] = [
  ...SMALL_TASKS.map(({ files, ...task }): Task => ({ ...task, suite: 'small', create: () => writeProject(files) })),
  ...LARGE_TASKS,
  ...CACHE_TASKS,
].filter(
  (task) => (SUITE === 'all' ? task.suite !== 'cache' : task.suite === SUITE) && (!ONLY || ONLY.includes(task.id)),
);

const removeProject = (task: Task, project: string) =>
  task.suite === 'small' ? rmSync(project, { recursive: true, force: true }) : removeLargeProject(project);

interface Result {
  task: string;
  suite: Task['suite'];
  rep: number;
  solved: boolean;
  why: string;
  seconds: number;
  // Assistant messages with text. A turn that only calls tools adds none, so this is not the number of requests.
  // `requests` is the model-call count.
  messages: number;
  requests: number;
  toolCalls: number;
  toolErrors: number;
  // Name and card summary of each failed tool call, e.g. a test run that fails before the fix.
  failedTools: string[];
  // Tool calls by tool name, e.g. { read_file: 4, edit_file: 2 }.
  toolsByName: Record<string, number>;
  // Project files changed although no edit_file or write_file call was made: the model edited through run_command,
  // which skips the diff preview and Undo (issue #45).
  editedWithoutEditTools: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  // Usage per phase for runs with a follow-up: the first turn, the pause (keep-alive requests only) and the follow-up.
  phases?: Phase[];
  error?: string;
}

interface Phase {
  phase: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}
const results: Result[] = [];

// The usage between two snapshots of the chat totals.
function phase(name: string, from: UsageTotals, to: UsageTotals): Phase {
  const diff: UsageTotals = {
    requests: (to.requests ?? 0) - (from.requests ?? 0),
    inputTokens: to.inputTokens - from.inputTokens,
    outputTokens: to.outputTokens - from.outputTokens,
    cacheReadTokens: to.cacheReadTokens - from.cacheReadTokens,
    cacheWriteTokens: (to.cacheWriteTokens ?? 0) - (from.cacheWriteTokens ?? 0),
  };
  return {
    phase: name,
    requests: diff.requests ?? 0,
    inputTokens: diff.inputTokens,
    outputTokens: diff.outputTokens,
    cacheReadTokens: diff.cacheReadTokens,
    cacheWriteTokens: diff.cacheWriteTokens ?? 0,
    costUsd: estimateCost(MODEL, diff, true),
  };
}

// A throwaway profile holding only the saved settings and the key's decryption material.
function copyProfile(): string {
  const profile = mkdtempSync(join(tmpdir(), 'patch-bench-profile-'));
  for (const file of ['settings.json', 'Local State']) copyFileSync(join(PROFILE!, file), join(profile, file));
  return profile;
}

function writeProject(files: Files): string {
  const project = mkdtempSync(join(tmpdir(), 'patch-bench-project-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), content);
  }
  return project;
}

async function runTask(task: Task, rep: number): Promise<Result> {
  const project = task.create();
  const before = hashes(project);
  const profile = copyProfile();
  const running = await launchApp({}, { userData: profile });
  const started = Date.now();
  try {
    const page = running.page;
    await page.evaluate(
      ({ model, extra }) =>
        window.api.invoke('settings:update', {
          model,
          approvalMode: 'auto',
          planMode: false,
          mcpServers: [],
          ...extra,
        }),
      { model: MODEL, extra: task.settings ?? {} },
    );
    await page.evaluate((path) => window.api.invoke('project:open', path), project);
    await page.evaluate(() => window.api.invoke('chat:new'));

    const snapshot = () => page.evaluate(() => window.api.invoke('chat:snapshot'));
    // Sends one message and waits until the assistant has answered it.
    const ask = async (text: string): Promise<ChatSnapshot> => {
      const answersBefore = (await snapshot()).transcript.filter((item) => item.kind === 'assistant').length;
      const askedAt = Date.now();
      await page.evaluate((message) => window.api.invoke('chat:send', { text: message }), text);
      for (;;) {
        await delay(1000);
        const current = await snapshot();
        const answers = current.transcript.filter((item) => item.kind === 'assistant').length;
        if (!current.busy && answers > answersBefore) return current;
        if (Date.now() - askedAt > (task.timeoutMs ?? RUN_TIMEOUT_MS)) {
          await page.evaluate(() => window.api.invoke('chat:stop'));
          throw new Error('timed out');
        }
      }
    };

    const start = (await snapshot()).usage;
    let chat = await ask(task.prompt);
    let phases: Phase[] | undefined;
    if (task.followUp) {
      const afterFirst = chat.usage;
      // The app stays open and idle, as a user would leave it; keep-alives (if on) run in the main process.
      await delay(task.followUp.pauseSeconds * 1000);
      const afterPause = (await snapshot()).usage;
      chat = await ask(task.followUp.prompt);
      phases = [
        phase('first turn', start, afterFirst),
        phase('pause', afterFirst, afterPause),
        phase('follow-up', afterPause, chat.usage),
      ];
    }
    const seconds = (Date.now() - started) / 1000;
    const assistants = chat.transcript.filter((item) => item.kind === 'assistant');
    const tools = chat.transcript.filter((item) => item.kind === 'tool');
    const toolsByName: Record<string, number> = {};
    for (const item of tools) if (item.kind === 'tool') toolsByName[item.name] = (toolsByName[item.name] ?? 0) + 1;
    const answer = assistants.map((item) => (item.kind === 'assistant' ? item.text : '')).join('\n');
    const errors = chat.transcript.filter((item) => item.kind === 'error');
    const missingTools = (task.requireTools ?? []).filter((name) => !toolsByName[name]);
    const verdict =
      errors.length > 0
        ? { ok: false, why: `chat error: ${errors[0]!.kind === 'error' ? errors[0]!.text.slice(0, 100) : ''}` }
        : missingTools.length > 0
          ? { ok: false, why: `did not use ${missingTools.join(', ')}` }
          : task.check(project, answer, before);
    return {
      task: task.id,
      suite: task.suite,
      rep,
      solved: verdict.ok,
      why: verdict.why,
      seconds: Math.round(seconds),
      messages: assistants.length,
      requests: chat.usage.requests ?? 0,
      toolCalls: tools.length,
      toolErrors: tools.filter((item) => item.kind === 'tool' && item.status === 'error').length,
      failedTools: tools.flatMap((item) =>
        item.kind === 'tool' && item.status === 'error' ? [`${item.name}: ${item.summary ?? ''}`.slice(0, 120)] : [],
      ),
      toolsByName,
      editedWithoutEditTools:
        !(toolsByName.edit_file || toolsByName.write_file) && changedFiles(project, before).length > 0,
      inputTokens: chat.usage.inputTokens,
      outputTokens: chat.usage.outputTokens,
      cacheReadTokens: chat.usage.cacheReadTokens,
      cacheWriteTokens: chat.usage.cacheWriteTokens ?? 0,
      costUsd: estimateCost(MODEL, chat.usage, true),
      ...(phases ? { phases } : {}),
    };
  } catch (error) {
    return {
      task: task.id,
      suite: task.suite,
      rep,
      solved: false,
      why: 'run failed',
      seconds: Math.round((Date.now() - started) / 1000),
      messages: 0,
      requests: 0,
      toolCalls: 0,
      toolErrors: 0,
      failedTools: [],
      toolsByName: {},
      editedWithoutEditTools: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await running.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
    removeProject(task, project);
  }
}

describe.skipIf(!PROFILE || SELFTEST)('agent task benchmark (real API)', () => {
  afterAll(() => {
    console.log(`\nAgent task benchmark: ${MODEL}, ${REPS} run(s) per task, suite ${SUITE}\n`);
    console.table(results.map(({ error: _error, phases: _phases, ...row }) => row));
    const phased = results.flatMap((result) =>
      (result.phases ?? []).map((row) => ({ task: result.task, rep: result.rep, ...row })),
    );
    if (phased.length > 0) console.table(phased);
    mkdirSync(join(__dirname, '../../out'), { recursive: true });
    writeFileSync(
      join(__dirname, `../../out/bench-agent-tasks-${SUITE}.json`),
      JSON.stringify({ model: MODEL, reps: REPS, suite: SUITE, date: new Date().toISOString(), results }, null, 2),
    );
    cleanupLargeBase();
  });

  it('has a profile with a saved Anthropic key', () => {
    expect(existsSync(join(PROFILE!, 'settings.json'))).toBe(true);
    const saved = JSON.parse(readFileSync(join(PROFILE!, 'settings.json'), 'utf8'));
    expect(Boolean(saved.secrets?.anthropicApiKey)).toBe(true);
  });

  for (const task of TASKS) {
    for (let rep = 1; rep <= REPS; rep++) {
      it(`${task.id} #${rep}: ${task.description}`, async () => {
        results.push(await runTask(task, rep));
      });
    }
  }
});

// No API: every check must reject the untouched project and accept the reference solution, so a task can be neither
// solved by doing nothing nor impossible to solve. The small tasks have no reference solution; for them only the first
// half is checked.
describe.skipIf(!SELFTEST)('agent task benchmark: self-test of the checks', () => {
  afterAll(() => cleanupLargeBase());

  for (const task of TASKS) {
    it(`${task.id}: the check fails before and passes on the reference solution`, () => {
      const project = task.create();
      try {
        const before = hashes(project);
        expect(task.check(project, '', before).ok, 'check accepts the unsolved project').toBe(false);
        if (!task.solve && task.referenceAnswer === undefined) return;
        if (task.solve) task.solve(project);
        const verdict = task.check(project, task.referenceAnswer ?? '', before);
        expect(verdict.ok, `reference solution rejected: ${verdict.why}`).toBe(true);
      } finally {
        removeProject(task, project);
      }
    }, 600_000);
  }
});
