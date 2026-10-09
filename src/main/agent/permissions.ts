import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import type { PermissionRule } from '@shared/settings';
import { parsePatch } from '../tools/apply_patch';
import { resolveCommand } from '../tools/mcp';

export type PermissionContext = 'thread' | 'subagent';

// What a rule decided. No decision (null) leaves the tool's own approval rules in force.
export interface PermissionDecision {
  action: 'allow' | 'reject' | 'ask';
  message?: string;
}

const DELEGATE_TIMEOUT_MS = 15_000;
const MAX_DELEGATE_OUTPUT = 4096;

// `*` matches any run of characters (also across `/`), `?` one character. Everything else is literal.
export function globMatch(pattern: string, text: string, ignoreCase = false): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`, ignoreCase ? 'si' : 's').test(text);
}

function anyGlob(patterns: string | string[], text: string, ignoreCase = false): boolean {
  return (Array.isArray(patterns) ? patterns : [patterns]).some((pattern) => globMatch(pattern, text, ignoreCase));
}

// How the paths of a call are compared: `path` is matched project-relative with forward slashes, and without regard
// to case where the file system ignores it (Windows, macOS), so `./src/a.ts` or `SRC\a.ts` cannot slip past a rule
// for `src/*` (#237).
export interface PathView {
  relative(path: string): string | null;
  ignoreCase: boolean;
}

export function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  input: Record<string, unknown>,
  context: PermissionContext,
  paths?: PathView,
): boolean {
  if (rule.context && rule.context !== context) return false;
  if (!anyGlob(rule.tool, toolName)) return false;
  for (const [field, patterns] of Object.entries(rule.matches ?? {})) {
    const value = input[field];
    if (value === undefined) return false;
    const ignoreCase = field === 'path' && Boolean(paths?.ignoreCase);
    if (!anyGlob(patterns, typeof value === 'string' ? value : JSON.stringify(value), ignoreCase)) return false;
  }
  return true;
}

// What a call is checked as besides itself: every file an apply_patch touches, as an edit_file of it, and each part of
// a command between shell operators, so an ask or reject rule for `git push*` also sees `cd . && git push`.
interface Candidate {
  tool: string;
  input: Record<string, unknown>;
}

const SHELL_SEPARATOR = /\s*(?:&&|\|\||[;&|\r\n])\s*/;

export function permissionCandidates(
  toolName: string,
  input: Record<string, unknown>,
  paths?: PathView,
): { call: Candidate; parts: Candidate[][] } {
  const normalized: Record<string, unknown> = { ...input };
  if (typeof input.path === 'string' && paths) normalized.path = paths.relative(input.path) ?? input.path;
  // Each part is one or more views of the same thing; a part is allowed when any of its views is.
  const parts: Candidate[][] = [];
  if (toolName === 'run_command' && typeof input.command === 'string') {
    normalized.command = input.command.trim().replace(/[ \t]+/g, ' ');
    const segments = (normalized.command as string).split(SHELL_SEPARATOR).filter(Boolean);
    if (segments.length > 1)
      parts.push(...segments.map((command) => [{ tool: toolName, input: { ...input, command } }]));
  }
  if (toolName === 'apply_patch' && typeof input.patch === 'string') {
    try {
      for (const op of parsePatch(input.patch)) {
        for (const raw of [op.path, op.kind === 'update' ? op.moveTo : null]) {
          if (!raw) continue;
          const path = paths?.relative(raw) ?? raw;
          parts.push([
            { tool: toolName, input: { ...input, path } },
            { tool: 'edit_file', input: { path } },
          ]);
        }
      }
    } catch {
      // A patch that does not parse fails in the tool itself.
    }
  }
  return { call: { tool: toolName, input: normalized }, parts };
}

// How a delegate's `to` reads in messages: the program, then its arguments.
export function delegateLabel(to: string | string[]): string {
  if (!Array.isArray(to)) return to;
  return to.map((part) => (part === '' || /[\s"]/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

// The first matching rule wins. A delegate rule asks an external program, and any failure of that program rejects.
export async function decidePermission(
  rules: PermissionRule[],
  toolName: string,
  input: Record<string, unknown>,
  context: PermissionContext,
  delegate: (to: string | string[], payload: string) => Promise<string> = runDelegate,
  paths?: PathView,
): Promise<PermissionDecision | null> {
  const rule = rules.find((candidate) => ruleMatches(candidate, toolName, input, context, paths));
  if (!rule) return null;
  if (rule.action !== 'delegate') return { action: rule.action, message: rule.message };

  const to = rule.to ?? '';
  const program = delegateLabel(to);
  try {
    const answer = (await delegate(to, JSON.stringify({ tool: toolName, input, context }))).trim().toLowerCase();
    if (answer === 'allow' || answer === 'ask') return { action: answer };
    if (answer === 'reject') return { action: 'reject', message: rule.message };
    return { action: 'reject', message: `The permission program "${program}" gave an unusable answer.` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { action: 'reject', message: `The permission program "${program}" failed: ${reason}` };
  }
}

// The decision for a whole call: the call with its paths normalized, and each of its parts (permissionCandidates).
// The strictest wins: any reject, then any ask. A call is allowed when it is allowed itself, or when every one of its
// parts is, so an allow rule for one file does not let a patch that also touches another run without asking.
export async function decideCallPermission(
  rules: PermissionRule[],
  toolName: string,
  input: Record<string, unknown>,
  context: PermissionContext,
  paths?: PathView,
  delegate: (to: string | string[], payload: string) => Promise<string> = runDelegate,
): Promise<PermissionDecision | null> {
  const { call, parts } = permissionCandidates(toolName, input, paths);
  const main = await decidePermission(rules, call.tool, call.input, context, delegate, paths);
  const derived = await Promise.all(
    parts.map((views) =>
      Promise.all(views.map((view) => decidePermission(rules, view.tool, view.input, context, delegate, paths))),
    ),
  );
  const all = [main, ...derived.flat()];
  const strictest = all.find((decision) => decision?.action === 'reject') ?? all.find((d) => d?.action === 'ask');
  if (strictest) return strictest;
  if (main?.action === 'allow') return main;
  const allowed = derived.map((views) => views.find((decision) => decision?.action === 'allow'));
  if (allowed.length > 0 && allowed.every(Boolean)) return allowed[0]!;
  return null;
}

export interface DelegateCommand {
  file: string;
  args: string[];
  options: SpawnOptions;
}

// Inside double quotes cmd.exe still expands %VAR% and (with delayed expansion) !VAR!, and a quote would end the
// quoting, so arguments with these characters cannot be passed safely. Everything else (& | < > ^ spaces) is literal.
const CMD_UNSAFE = /["%!\r\n\0]/;

// What to spawn for a delegate's `to`: a single program (string, never split, so paths with spaces work) or
// [program, ...args]. No shell is involved, except that Windows cannot start .cmd/.bat files without cmd.exe
// (Node refuses since CVE-2024-27980); those run through `cmd.exe /d /s /c` with every part quoted. `resolve` finds a
// bare name on PATH, so `npx` is recognised as `npx.cmd`.
export function delegateCommand(
  to: string | string[],
  platform: NodeJS.Platform = process.platform,
  resolve: (program: string) => string = (program) => program,
  env: NodeJS.ProcessEnv = process.env,
): DelegateCommand {
  const [program = '', ...args] = Array.isArray(to) ? to : [to];
  if (!program.trim()) throw new Error('no program is set');
  const options: SpawnOptions = { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true };
  if (platform !== 'win32') return { file: program, args, options };
  const resolved = resolve(program);
  if (!/\.(cmd|bat)$/i.test(resolved)) return { file: program, args, options };
  const parts = [resolved, ...args];
  const unsafe = parts.find((part) => CMD_UNSAFE.test(part));
  if (unsafe !== undefined) {
    throw new Error(
      `"${unsafe}" contains characters (" % ! or a line break) that cmd.exe cannot pass to a .cmd/.bat program`,
    );
  }
  // With /s cmd.exe strips the outer quotes and runs the rest as written; verbatim keeps Node from re-quoting it.
  const line = parts.map((part) => `"${part}"`).join(' ');
  return {
    file: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { ...options, windowsVerbatimArguments: true },
  };
}

// Finds a bare program name on PATH (Windows only, to recognise .cmd/.bat); anything else stays as given.
function resolveDelegateProgram(program: string): string {
  try {
    return resolveCommand(program, process.env.PATH ?? '', process.env.PATHEXT);
  } catch {
    return program;
  }
}

// Runs the program without a shell, writes the call as JSON to its stdin and returns what it prints.
function runDelegate(to: string | string[], payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { file, args, options } = delegateCommand(to, process.platform, resolveDelegateProgram);
    const child = spawn(file, args, options) as ChildProcessWithoutNullStreams;
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('it did not answer within 15 seconds'));
    }, DELEGATE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < MAX_DELEGATE_OUTPUT) output += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`it exited with code ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}
