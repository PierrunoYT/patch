import { spawn } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import type { ImageAttachment } from '@shared/ipc';
import { Workspace } from './tools/workspace';

const IMAGE_TYPES: Record<string, ImageAttachment['mediaType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// The API limit for a single image is 5 MB; larger files are rejected here with a clear message.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function pickImages(window: BrowserWindow | null): Promise<ImageAttachment[]> {
  const options = {
    properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  if (result.canceled) return [];

  return result.filePaths.map((path) => {
    const mediaType = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!mediaType) throw new Error(`Unsupported image type: ${basename(path)}`);
    if (statSync(path).size > MAX_IMAGE_BYTES) throw new Error(`${basename(path)} is larger than 5 MB.`);
    return { name: basename(path), mediaType, base64: readFileSync(path).toString('base64') };
  });
}

// Asks where to save a text file and writes it. Returns the chosen path, or null when the user cancels.
export async function saveTextFile(
  window: BrowserWindow | null,
  defaultName: string,
  text: string,
): Promise<string | null> {
  const options = { defaultPath: defaultName, filters: [{ name: 'Markdown', extensions: ['md'] }] };
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  writeFileSync(result.filePath, text, 'utf8');
  return result.filePath;
}

// Splits a command line into words like a shell would for plain words: whitespace separates, single or double quotes
// group. There is no expansion, no escapes and no operators, so `code; id` is the program `code;` with the argument `id`.
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote) throw new Error('The editor command has an unclosed quote.');
  if (inWord) words.push(word);
  return words;
}

// Opens a project file with the user's editor command (e.g. "code --reuse-window"). The path must be inside the
// project. The command is split into a program and arguments and started without a shell.
export function openInEditor(editorCommand: string, projectRoot: string, path: string): void {
  const file = new Workspace(projectRoot).resolve(path);
  const windows = process.platform === 'win32';
  // A quote or line break in the path is refused everywhere; cmd.exe on Windows only expands %VAR% inside double
  // quotes, which runs nothing. The other characters stay refused on macOS and Linux as before.
  const unsafe = windows ? /["\r\n]/ : /["\r\n$`\\]/;
  if (unsafe.test(file)) throw new Error('Unsupported characters in file path.');
  const [program, ...args] = splitCommand(editorCommand.trim() || 'code');
  if (!program) throw new Error('The editor command is empty.');
  const options = { detached: true, stdio: 'ignore', windowsHide: true } as const;
  let child;
  if (windows) {
    // Launchers such as code.cmd cannot be started without cmd.exe (Node.js refuses .cmd files without a shell), so
    // cmd.exe runs one quoted program and its quoted arguments. Its own operators cannot appear inside the quotes.
    const words = [program, ...args, file];
    if (words.some((word) => /["&|<>^%\r\n]/.test(word) && word !== file)) {
      throw new Error('Unsupported characters in the editor command.');
    }
    child = spawn('cmd.exe', ['/d', '/s', '/c', `"${words.map((word) => `"${word}"`).join(' ')}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  } else {
    child = spawn(program, [...args, file], options);
  }
  child.on('error', () => {});
  child.unref();
}
