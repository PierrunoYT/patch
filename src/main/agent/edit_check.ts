import { redactSecrets } from '../tools/redact';
import { stripAnsi, type CommandResult } from '../tools/shell';

// The most diagnostic lines put into a tool result, and how long the check may run.
export const MAX_CHECK_LINES = 30;
export const CHECK_TIMEOUT_SECONDS = 120;

const normalize = (text: string) => text.replaceAll('\\', '/').toLowerCase();

// A line that reports a problem, as opposed to a summary or progress line ("Checking foo", "Found 2 errors").
function looksLikeDiagnostic(line: string): boolean {
  return /\b(error|warning)\b/i.test(line) && /[:(]\d+/.test(line);
}

// Lines of a check's output that matter after an edit (#81): those that name an edited file, with the indented lines
// that continue them (compiler notes, code excerpts), and, when an earlier check gives a baseline, new lines about
// other files too (an edit that broke an importer). Lines the earlier check already printed are old news.
export function relevantDiagnostics(output: string, edited: string[], previous: ReadonlySet<string> | null): string[] {
  const files = edited.map(normalize);
  const kept: string[] = [];
  let inEdited = false;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const continuation = /^\s/.test(line);
    const about: boolean = continuation ? inEdited : files.some((file) => normalize(line).includes(file));
    if (!continuation) inEdited = about;
    const fresh = !previous?.has(line.trim());
    if (continuation ? about && fresh : (about && fresh) || (previous !== null && fresh && looksLikeDiagnostic(line))) {
      kept.push(line);
    }
  }
  return kept;
}

// Runs the project's check command after a turn's edits and tells the model what the edits broke. One per chat: it
// remembers the lines of the last run, so a later run reports only what is new.
export class EditChecker {
  private previous: Set<string> | null = null;

  constructor(
    private readonly run: (command: string, timeoutSeconds: number, signal: AbortSignal) => Promise<CommandResult>,
  ) {}

  // The note for the model, or null when there is nothing to say (no command, a stop, a failure to start). Never
  // throws: a check must not get in the way of the edit itself.
  async check(command: string, edited: string[], signal: AbortSignal): Promise<string | null> {
    const trimmed = command.trim();
    if (!trimmed || edited.length === 0 || signal.aborted) return null;
    let result: CommandResult;
    try {
      result = await this.run(trimmed, CHECK_TIMEOUT_SECONDS, signal);
    } catch {
      return null;
    }
    if (result.aborted || signal.aborted) return null;
    const label = `Check after your edits (\`${trimmed}\`)`;
    if (result.timedOut) return `${label}: stopped after ${CHECK_TIMEOUT_SECONDS} s, so no result.`;
    const output = redactSecrets(stripAnsi(result.output));
    const found = relevantDiagnostics(output, edited, this.previous);
    this.previous = new Set(output.split(/\r?\n/).map((line) => line.trim()));
    if (result.exitCode === 0 && found.length === 0) return `${label}: no errors.`;
    if (found.length === 0) {
      return result.exitCode === null
        ? `${label}: could not run.`
        : `${label}: exit code ${result.exitCode}, but nothing new about the files you edited. Run it yourself to see the rest.`;
    }
    const shown = found.slice(0, MAX_CHECK_LINES).join('\n');
    const more = found.length - MAX_CHECK_LINES;
    return `${label}, exit code ${result.exitCode ?? 'unknown'}, new output about the edited files:\n${shown}${more > 0 ? `\n… and ${more} more lines` : ''}`;
  }
}
