/**
 * External-editor behavior adapted from aider/editor.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified to spawn an argv command without a shell and always remove its file.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function discoverEditor(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return (
    environment.VISUAL ??
    environment.EDITOR ??
    (platform === "win32" ? "notepad" : platform === "darwin" ? "vim" : "vi")
  );
}

export function splitEditorCommand(command: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (current !== "") result.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped || quote !== undefined) {
    throw new Error("Editor command contains an unterminated quote or escape");
  }
  if (current !== "") result.push(current);
  if (result.length === 0) throw new Error("Editor command cannot be empty");
  return result;
}

async function runEditor(
  command: readonly string[],
  path: string,
): Promise<void> {
  const [executable, ...args] = command;
  if (executable === undefined)
    throw new Error("Editor command cannot be empty");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [...args, path], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Editor exited with status ${String(code)}`));
    });
  });
}

export async function editInExternalEditor(
  input: string,
  options: { readonly editor?: string; readonly suffix?: string } = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "patch-editor-"));
  const path = join(directory, `input.${options.suffix ?? "md"}`);
  try {
    await writeFile(path, input, { encoding: "utf8", mode: 0o600 });
    await runEditor(
      splitEditorCommand(options.editor ?? discoverEditor()),
      path,
    );
    return (await readFile(path, "utf8")).replace(/\n+$/u, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
