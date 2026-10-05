// Shared types and helpers for the agent task benchmark (agent_tasks.bench.ts).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Verdict {
  ok: boolean;
  why: string;
}

export interface Task {
  id: string;
  // `small`: a tiny project written from `files`. `large`: a copy of this repository at a pinned commit. `cache`: prompt
  // cache measurements on such a copy (cache_tasks.ts), run only when asked for. `plan`: small tasks with plan mode on
  // or off, scored on whether the model proposed a plan when it should (run only when asked for).
  suite: 'small' | 'large' | 'cache' | 'plan';
  description: string;
  // Creates the task's project folder and returns its path.
  create(): string;
  prompt: string;
  // A second message, sent `pauseSeconds` after the first answer (cache suite). The run reports usage per phase.
  followUp?: { prompt: string; pauseSeconds: number };
  // Settings applied before the run, on top of the model, Auto mode and no plan mode or MCP servers.
  settings?: Record<string, unknown>;
  // Tools the run must have called, e.g. the subagent task tool; otherwise it does not count as solved.
  requireTools?: string[];
  // Plan suite: true when the run must call propose_plan before its first edit or command, false when it must not
  // call propose_plan at all. Otherwise it does not count as solved.
  planExpected?: boolean;
  // Whether the task was solved, judged from the project folder and the chat after the run.
  check(project: string, answer: string, before: Map<string, string>): Verdict;
  // A reference solution, for the self-test that proves `check` fails before and passes after (no API).
  solve?(project: string): void;
  // For question tasks: an answer `check` must accept, used by the self-test.
  referenceAnswer?: string;
  // How long one run may take before it is stopped.
  timeoutMs?: number;
}

// Runs `node <args>` in the project; `ok` is a zero exit status.
export function node(project: string, args: string[], timeout = 180_000): { ok: boolean; out: string } {
  const result = spawnSync(process.execPath, args, { cwd: project, encoding: 'utf8', timeout, windowsHide: true });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// A hash of every file outside node_modules and .git, keyed by its project-relative path with forward slashes.
export function hashes(project: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'out') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile())
        result.set(
          path.slice(project.length + 1).replace(/\\/g, '/'),
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        );
    }
  };
  walk(project);
  return result;
}

// Files whose content changed, appeared or disappeared since `before`.
export function changedFiles(project: string, before: Map<string, string>): string[] {
  const after = hashes(project);
  const changed = [...after].filter(([file, hash]) => before.get(file) !== hash).map(([file]) => file);
  const removed = [...before.keys()].filter((file) => !after.has(file));
  return [...changed, ...removed];
}
