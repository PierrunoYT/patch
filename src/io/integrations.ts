/**
 * Shell integration behavior adapted from aider/args.py, aider/io.py, and
 * aider/commands.py at revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to keep desktop commands and clipboard utilities optional.
 * Licensed under the Apache License, Version 2.0.
 */

import { spawn } from "node:child_process";

import { splitEditorCommand } from "./editor.js";

export type CompletionShell = "bash" | "zsh" | "fish";

export function isBrokenPipe(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EPIPE"
  );
}

/**
 * Prints a completion script for the options it is given.
 *
 * The inventory is a parameter rather than a list kept here, because a list kept
 * here drifts: it silently omitted several active options while claiming to
 * complete the executable. The caller passes the flags the parser actually
 * registered.
 */
export function generateShellCompletion(
  shell: CompletionShell,
  cliOptions: readonly string[],
): string {
  const unique = [...new Set(cliOptions)].filter((option) =>
    /^--[a-z0-9][a-z0-9-]*$/u.test(option),
  );
  if (unique.length === 0) {
    throw new Error("Shell completion needs at least one option to complete");
  }
  const options = unique.join(" ");
  if (shell === "bash") {
    return `_patch() { COMPREPLY=( $(compgen -W '${options}' -- "${"${COMP_WORDS[COMP_CWORD]}"}") ); }\ncomplete -F _patch patch\n`;
  }
  if (shell === "zsh") {
    return `#compdef patch\n_arguments '*:option:(${options})'\n`;
  }
  return unique
    .map((option) => `complete -c patch -l ${option.slice(2)}\n`)
    .join("");
}

export interface IntegrationResult {
  readonly stdout: string;
}

export type IntegrationRunner = (
  executable: string,
  args: readonly string[],
  input?: string,
) => Promise<IntegrationResult>;

async function runIntegration(
  executable: string,
  args: readonly string[],
  input?: string,
): Promise<IntegrationResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0)
        resolve({ stdout: Buffer.concat(output).toString("utf8") });
      else
        reject(new Error(`${executable} exited with status ${String(code)}`));
    });
    child.stdin.end(input);
  });
}

export async function notifyUser(
  options: { readonly command?: string } = {},
  dependencies: {
    readonly write?: (text: string) => void;
    readonly run?: IntegrationRunner;
  } = {},
): Promise<void> {
  if (options.command === undefined) {
    (dependencies.write ?? ((text) => process.stdout.write(text)))("\u0007");
    return;
  }
  const [executable, ...args] = splitEditorCommand(options.command);
  if (executable === undefined)
    throw new Error("Notification command cannot be empty");
  await (dependencies.run ?? runIntegration)(executable, args);
}

export class ClipboardUnavailableError extends Error {
  override readonly name = "ClipboardUnavailableError";
}

function clipboardCommand(
  operation: "read" | "write",
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): [string, string[]] {
  if (platform === "darwin")
    return [operation === "read" ? "pbpaste" : "pbcopy", []];
  if (platform === "win32") {
    return operation === "read"
      ? ["powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]]
      : ["clip.exe", []];
  }
  if (environment.WAYLAND_DISPLAY !== undefined) {
    return [operation === "read" ? "wl-paste" : "wl-copy", []];
  }
  return operation === "read"
    ? ["xclip", ["-selection", "clipboard", "-o"]]
    : ["xclip", ["-selection", "clipboard", "-i"]];
}

async function clipboard(
  operation: "read" | "write",
  text: string | undefined,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
    readonly run?: IntegrationRunner;
  },
): Promise<string> {
  const [executable, args] = clipboardCommand(
    operation,
    options.platform ?? process.platform,
    options.environment ?? process.env,
  );
  try {
    return (await (options.run ?? runIntegration)(executable, args, text))
      .stdout;
  } catch (error) {
    throw new ClipboardUnavailableError(
      `Clipboard text requires the optional ${executable} system utility`,
      { cause: error },
    );
  }
}

export async function writeClipboardText(
  text: string,
  options: Parameters<typeof clipboard>[2] = {},
): Promise<void> {
  await clipboard("write", text, options);
}

export function readClipboardText(
  options: Parameters<typeof clipboard>[2] = {},
): Promise<string> {
  return clipboard("read", undefined, options);
}
