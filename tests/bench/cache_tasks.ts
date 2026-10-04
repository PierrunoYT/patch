// Prompt cache suite of the agent task benchmark (agent_tasks.bench.ts, PATCH_BENCH_SUITE=cache). Opt-in and not part of
// `all`: the pause tasks wait several minutes between two messages. Both tasks run on a copy of this repository
// (createLargeProject), so the chat is large enough for cache writes to matter.
//
// - `subagent-question` asks the model to delegate to the `task` subagent, to measure what a subagent run costs and
//   whether it reads the chat's cached prompt (#77).
// - `pause-followup` and `pause-followup-warm` ask a question, wait PATCH_BENCH_PAUSE_SECONDS (default 360, longer than
//   the 5-minute cache), then ask a follow-up. They differ only in Settings → Prompt cache: off, then on. The run's
//   `phases` show what the follow-up wrote to the cache and what the keep-alives during the pause cost.
import { createLargeProject } from './large_tasks';
import { changedFiles, type Task, type Verdict } from './task';

const fail = (why: string): Verdict => ({ ok: false, why });
const pass = (why: string): Verdict => ({ ok: true, why });

export const PAUSE_SECONDS = Number(process.env.PATCH_BENCH_PAUSE_SECONDS || 360);

const DECLINE_QUESTION =
  'Without changing any files: when the agent gets a batch of several tool calls and the user declines one of them without giving feedback, what happens to the remaining calls in that batch, and in which file and function is that decided?';
const DECLINE_FOLLOW_UP =
  'Still without changing files: in that same function, what exact text does each remaining call get as its result?';

// The first answer must name the place and the outcome; the follow-up must quote the result text.
function checkPause(project: string, answer: string, before: Map<string, string>): Verdict {
  const changed = changedFiles(project, before);
  if (changed.length > 0) return fail(`changed ${changed.slice(0, 3).join(', ')}`);
  if (!/agent\.ts/.test(answer) || !/runTools/.test(answer)) return fail('first answer incomplete');
  if (!/Not run: the user declined an earlier action/i.test(answer)) return fail('follow-up answer incomplete');
  return pass('both answers correct, no changes');
}

const PAUSE_TASK = {
  suite: 'cache' as const,
  create: () => createLargeProject(),
  prompt: DECLINE_QUESTION,
  followUp: { prompt: DECLINE_FOLLOW_UP, pauseSeconds: PAUSE_SECONDS },
  check: checkPause,
  referenceAnswer:
    'In src/main/agent/agent.ts, Agent.runTools: the remaining calls are not run. Each gets "Not run: the user declined an earlier action."',
  timeoutMs: 12 * 60_000,
};

export const CACHE_TASKS: Task[] = [
  {
    id: 'subagent-question',
    suite: 'cache',
    description: 'Answer a question through the task subagent',
    create: () => createLargeProject(),
    prompt:
      'Use the task tool to delegate this question to a subagent, then answer from its report, without changing any files: in which file and function does the agent decide whether a failed model request is retried, and how many retries are allowed at most?',
    requireTools: ['task'],
    check(project, answer, before) {
      const changed = changedFiles(project, before);
      if (changed.length > 0) return fail(`changed ${changed.slice(0, 3).join(', ')}`);
      const right = /retry\.ts/.test(answer) && /retryDecision/.test(answer) && /\b4\b|four/i.test(answer);
      return right ? pass('correct answer through the subagent') : fail('answer incomplete');
    },
    referenceAnswer: 'src/main/agent/retry.ts, retryDecision: at most 4 retries (MAX_RETRIES).',
    timeoutMs: 12 * 60_000,
  },
  {
    ...PAUSE_TASK,
    id: 'pause-followup',
    description: `Question, ${PAUSE_SECONDS} s pause, follow-up; keep-alive off`,
    settings: { keepCacheWarm: false },
  },
  {
    ...PAUSE_TASK,
    id: 'pause-followup-warm',
    description: `Question, ${PAUSE_SECONDS} s pause, follow-up; keep-alive on`,
    settings: { keepCacheWarm: true },
  },
];
