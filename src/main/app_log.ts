import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { JsonlLog } from './storage/jsonl_log';

const MAX_MESSAGE = 2000;
const MAX_STACK = 4000;

// Keys and tokens that could end up in an error message, e.g. a provider echoing a request header.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]'],
  [/\b(gsk_|xai-)[A-Za-z0-9_-]{8,}/g, '$1[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza[redacted]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\b(x-api-key|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;}]{6,}/gi, '$1$2[redacted]'],
];

export type LogLevel = 'error' | 'warn' | 'info';

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length - limit} more characters)` : text;
}

// Local log of crashes and other problems (`logs/app.log.jsonl` in the user data folder). Entries hold what went wrong
// and where, never chat history or API keys (messages can still mention a path), and the file is never sent anywhere. Until a file is set
// (the user data folder is only known once the app starts) entries are dropped.
export class AppLog {
  private readonly log = new JsonlLog(null);

  setFile(file: string | null): void {
    this.log.setFile(file);
  }

  error(source: string, problem: unknown, context?: Record<string, string | number | boolean | null>): void {
    this.write('error', source, problem, context);
  }

  warn(source: string, problem: unknown, context?: Record<string, string | number | boolean | null>): void {
    this.write('warn', source, problem, context);
  }

  info(source: string, message: string, context?: Record<string, string | number | boolean | null>): void {
    this.write('info', source, message, context);
  }

  private write(level: LogLevel, source: string, problem: unknown, context?: Record<string, unknown>): void {
    const error = problem instanceof Error ? problem : null;
    const message = error
      ? `${error.name}: ${error.message}`
      : typeof problem === 'string'
        ? problem
        : safeString(problem);
    this.log.append({
      level,
      source,
      message: clip(redact(message), MAX_MESSAGE),
      ...(error?.stack ? { stack: clip(redact(error.stack), MAX_STACK) } : {}),
      ...(context ? { context } : {}),
    });
  }
}

function safeString(value: unknown): string {
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}

export const appLog = new AppLog();

interface NativeCrashDump {
  key: string;
  bytes: number;
  modified: string;
}

// A native main-process failure cannot run JavaScript to log itself. Electron's crash reporter saves a minidump first;
// the next launch calls this function to add one log entry for each dump that has not been reported before.
export function logNativeCrashDumps(log: AppLog, crashDirectory: string, stateFile: string): number {
  const dumps = findCrashDumps(crashDirectory);
  const seen = readSeenCrashDumps(stateFile);
  const newDumps = dumps.filter((dump) => !seen.has(dump.key));

  for (const dump of newDumps) {
    log.error(
      'native-crash',
      'An Electron process crashed natively during an earlier run. A local minidump was saved.',
      {
        dump: dump.key,
        bytes: dump.bytes,
        modified: dump.modified,
      },
    );
  }

  if (newDumps.length > 0) {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify([...new Set([...seen, ...dumps.map((dump) => dump.key)])]), 'utf8');
    } catch {
      // The app log itself is best-effort too. A failed marker write may repeat an entry next launch, but must not
      // prevent Patch from starting.
    }
  }
  return newDumps.length;
}

function findCrashDumps(root: string): NativeCrashDump[] {
  const found: NativeCrashDump[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.dmp')) {
        try {
          const stats = statSync(path);
          found.push({
            // Crashpad can move reports between its internal folders; the UUID-style file name stays stable.
            key: entry.name,
            bytes: stats.size,
            modified: stats.mtime.toISOString(),
          });
        } catch {
          // A report may disappear while Crashpad tidies its database; the next launch can try any remaining dump.
        }
      }
    }
  };
  visit(resolve(root));
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

function readSeenCrashDumps(file: string): Set<string> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}
