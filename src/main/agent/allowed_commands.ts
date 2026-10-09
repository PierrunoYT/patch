// Characters that let a shell run something else or redirect output: chaining (; & |), redirection (< >), line
// breaks, and anything that evaluates: backticks, `$` (variables and `$(...)`), parentheses and braces. On Windows,
// commands run in PowerShell, which runs `(...)`, `@(...)` and `{...}` even inside the arguments of a program:
// `npm test (Remove-Item -Recurse src)` deletes src. A command containing any of these is never pre-approved, so an
// allowed prefix such as "npm test" cannot be extended into something else.
const SHELL_OPERATORS = /[;&|`<>\r\n$(){}]/;

// Arguments that make a command that looks read-only write a file or run another program: `git log --output=<file>`
// writes any bytes to any path through `--format` escapes (#233), `git grep -O<program>` and `find -exec` run programs.
// A command with one of these is asked about even when its prefix is allowed. Best-effort: the allow-list still trusts
// the program with every other argument.
const RISKY_ARGUMENTS = [
  /^--(output|output-directory|exec|upload-pack|receive-pack|open-files-in-pager|in-place)(=|$)/i,
  /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/i,
  // -o and -O with or without an attached value: git format-patch -o, git grep -O, curl -o/-O, sort -o.
  /^-[oO]/,
];

function hasRiskyArgument(args: string): boolean {
  // Quotes don't stop a shell from passing `--output=x` through, so they are ignored here.
  return args
    .split(' ')
    .map((arg) => arg.replace(/["']/g, ''))
    .some((arg) => RISKY_ARGUMENTS.some((pattern) => pattern.test(arg)));
}

export function parseAllowedCommands(setting: string): string[] {
  return setting
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line && !line.startsWith('#'));
}

// True when the command is exactly one of the allowed commands, or one of them followed by arguments.
export function isCommandAllowed(command: string, setting: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ');
  if (!normalized || SHELL_OPERATORS.test(command)) return false;
  return parseAllowedCommands(setting).some(
    (entry) =>
      normalized === entry ||
      (normalized.startsWith(`${entry} `) && !hasRiskyArgument(normalized.slice(entry.length + 1))),
  );
}
