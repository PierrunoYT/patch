import { existsSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import { changeProjectFiles, readProjectFile } from './file_operations';
import {
  requireUtf8ForEdit,
  detectEol,
  fileSize,
  isBinaryFile,
  MAX_READ_BYTES,
  sha256,
  withLineNumbers,
} from './text_files';
import { isGuardedPath } from './guard';
import { containsRedaction } from './redact';
import { RegexWorker } from './regex_worker';
import { defineTool, MAX_OUTPUT_CHARS, ToolError, type ToolContext } from './types';

const DEFAULT_READ_LINES = 2000;
// Search results stay small enough to read: a few matches per file spread over many files beat one noisy file.
const GREP_MAX_MATCHES = 100;
const GREP_MAX_PER_FILE = 10;
const GREP_MAX_LINE_CHARS = 200;
// A pattern that needs longer than this for one file is backtracking catastrophically; the search stops there.
const GREP_FILE_TIMEOUT_MS = 3000;

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read a text file from the project with line numbers. Pages default to 2,000 lines and contain at most 30,000 characters of numbered text. Use offset and limit for whole-line ranges. If a line exceeds the character budget, follow the returned offset and char_offset to read its remainder without losing text. Read a file before editing or overwriting it.',
  schema: z.object({
    path: z.string().describe('File path, relative to the project root.'),
    offset: z.number().int().min(1).optional().describe('First line to read (1-based).'),
    limit: z.number().int().min(1).optional().describe(`Number of lines to read (default ${DEFAULT_READ_LINES}).`),
    char_offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Zero-based UTF-16 code-unit offset within the first requested line (default 0). Use the returned continuation value for an overlong line; subsequent lines start at 0. Must not split a Unicode surrogate pair.',
      ),
  }),
  requiresApproval: false,
  parallelSafe: true,
  async run({ path, offset = 1, limit = DEFAULT_READ_LINES, char_offset = 0 }, context) {
    const file = context.workspace.resolve(path);
    if (!existsSync(file)) throw new ToolError(`File not found: ${path}`);
    if (statSync(file).isDirectory()) throw new ToolError(`${path} is a directory. Use list_directory.`);
    if (await isBinaryFile(file)) throw new ToolError(`${path} is a binary file.`);
    if ((await fileSize(file)) > MAX_READ_BYTES * 8) throw new ToolError(`${path} is too large to read.`);

    // Hash the bytes read, whatever range is shown, so write_file can tell when the file changed since.
    const bytes = await readProjectFile(context.workspace, path);
    if (bytes === null) throw new ToolError(`File not found: ${path}`);
    const text = bytes.toString('utf8');
    const lines = text === '' ? [] : text.split(/\r?\n/);
    if (text.endsWith('\n')) lines.pop();
    const lineCount = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
    if (offset > Math.max(1, lines.length)) {
      throw new ToolError(`offset ${offset} is past the end (${lineCount})`);
    }
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const first = selected[0] ?? '';
    if (char_offset > first.length || splitsSurrogatePair(first, char_offset)) {
      throw new ToolError(
        'char_offset must be within the first requested line and must not split a Unicode surrogate pair.',
      );
    }
    if (selected.length > 0) selected[0] = first.slice(char_offset);
    context.readFiles.set(file, sha256(bytes));

    const rel = context.workspace.relative(file);
    const page = fitLines(withLineNumbers(selected, offset).split('\n'), MAX_OUTPUT_CHARS);
    const last = offset + page.lines - 1;
    const notes: string[] = [];
    if (page.cutLine) {
      const prefixLength = String(offset + selected.length - 1).length + 1;
      const nextChar = char_offset + page.text.length - prefixLength;
      notes.push(`Line ${offset} continues. Use offset=${offset} and char_offset=${nextChar} to read more.`);
    } else if (last < lines.length) {
      const reason =
        page.lines < selected.length ? ` (cut to fit ${MAX_OUTPUT_CHARS.toLocaleString('en-US')} characters)` : '';
      notes.push(
        `Showing lines ${offset}-${last} of ${lines.length}${reason}. Use offset=${last + 1}${char_offset > 0 ? ' and char_offset=0' : ''} to read more.`,
      );
    }
    return {
      content: page.text + (notes.length > 0 ? `\n\n(${notes.join(' ')})` : ''),
      summary:
        page.cutLine || last < lines.length || offset > 1 || char_offset > 0
          ? `Read ${rel} (lines ${offset}-${last} of ${lines.length})`
          : `Read ${rel} (${lineCount})`,
      path: rel,
    };
  },
});

export const listDirectoryTool = defineTool({
  name: 'list_directory',
  description: 'List files and folders in a project directory, skipping files ignored by .gitignore.',
  schema: z.object({
    path: z.string().optional().describe('Directory, relative to the project root. Defaults to the root.'),
    recursive: z.boolean().optional().describe('List all files below the directory (up to 500).'),
  }),
  requiresApproval: false,
  parallelSafe: true,
  async run({ path = '.', recursive = false }, context) {
    const dir = context.workspace.resolve(path);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ToolError(`Not a directory: ${path}`);
    const rel = context.workspace.relative(dir);

    if (recursive) {
      const files = await context.workspace.listFiles(dir, 501);
      const shown = files.slice(0, 500).map((file) => context.workspace.relative(file));
      const note = files.length > 500 ? '\n(More than 500 files; list a subdirectory to see the rest.)' : '';
      return { content: (shown.join('\n') || '(empty)') + note, summary: `Listed ${rel} (${shown.length} files)` };
    }

    const entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => !context.workspace.isIgnored(join(dir, entry.name), entry.isDirectory()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    return { content: entries.join('\n') || '(empty)', summary: `Listed ${rel}` };
  },
});

export const grepTool = defineTool({
  name: 'grep',
  description:
    'Search file contents in the project with a regular expression. Returns matching lines as path:line: text. Use for exact names and strings; use search_code for questions about behavior.',
  schema: z.object({
    pattern: z.string().describe('JavaScript regular expression.'),
    path: z.string().optional().describe('Directory or file to search, relative to the project root.'),
    ignore_case: z.boolean().optional(),
  }),
  requiresApproval: false,
  parallelSafe: true,
  async run({ pattern, path = '.', ignore_case = false }, context) {
    // Models often write PCRE's leading (?i); JavaScript has no inline flags, so treat it as ignore_case.
    const inlineIgnoreCase = /^\(\?i\)/.exec(pattern);
    if (inlineIgnoreCase) pattern = pattern.slice(inlineIgnoreCase[0].length);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignore_case || inlineIgnoreCase ? 'i' : '');
    } catch (error) {
      throw new ToolError(
        `Invalid regular expression: ${(error as Error).message}. Patterns are JavaScript regular expressions; for case-insensitive search set ignore_case instead of an inline flag.`,
      );
    }
    const target = context.workspace.resolve(path);
    if (!existsSync(target)) throw new ToolError(`Not found: ${path}`);
    const files = statSync(target).isDirectory() ? await context.workspace.listFiles(target) : [target];

    const matches: string[] = [];
    const crowded: string[] = [];
    let slow: string | null = null;
    // The pattern runs in a worker, so a catastrophic one cannot freeze the app and Stop ends it at once.
    const worker = new RegexWorker(regex.source, regex.flags);
    try {
      for (const file of files) {
        if (context.signal.aborted || matches.length >= GREP_MAX_MATCHES) break;
        if ((await fileSize(file)) > MAX_READ_BYTES || (await isBinaryFile(file))) continue;
        const text = await readFile(file, 'utf8');
        const take = Math.min(GREP_MAX_PER_FILE, GREP_MAX_MATCHES - matches.length);
        const result = await worker.match({ text }, { take, timeoutMs: GREP_FILE_TIMEOUT_MS, signal: context.signal });
        if (result.status === 'aborted') break;
        if (result.status === 'timeout') {
          slow = context.workspace.relative(file);
          break;
        }
        const lines = text.split(/\r?\n/);
        for (const index of result.found) {
          const line = lines[index]!.trim();
          const clipped = line.length > GREP_MAX_LINE_CHARS ? `${line.slice(0, GREP_MAX_LINE_CHARS)}…` : line;
          matches.push(`${context.workspace.relative(file)}:${index + 1}: ${clipped}`);
        }
        if (result.more && take === GREP_MAX_PER_FILE) crowded.push(context.workspace.relative(file));
      }
    } finally {
      worker.close();
    }
    const notes: string[] = [];
    if (slow) {
      notes.push(
        `Stopped: the pattern took more than ${GREP_FILE_TIMEOUT_MS / 1000} s on ${slow}, which usually means catastrophic backtracking (nested quantifiers such as (a+)+). Simplify the pattern.`,
      );
    }
    if (matches.length >= GREP_MAX_MATCHES) {
      notes.push(`Stopped at ${GREP_MAX_MATCHES} matches; narrow the pattern or path.`);
    }
    if (crowded.length > 0) {
      notes.push(`Showing the first ${GREP_MAX_PER_FILE} matches per file; more in: ${crowded.join(', ')}.`);
    }
    const note = notes.length > 0 ? `\n(${notes.join(' ')})` : '';
    return {
      content: (matches.join('\n') || 'No matches.') + note,
      summary: `Searched for /${pattern}/ (${matches.length} matches)`,
    };
  },
});

export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Create a new file or replace an entire file. Existing files must be read first. Prefer edit_file for changes to existing files.',
  schema: z.object({
    path: z.string().describe('File path, relative to the project root.'),
    content: z.string().describe('The complete file content.'),
  }),
  requiresApproval: true,
  mustAsk: ({ path }, context) => isProtected(path, context),
  async preview({ path, content }, context) {
    refuseRedacted(content);
    const file = context.workspace.resolve(path);
    let before = '';
    if (existsSync(file)) {
      requireRead(file, path, context);
      const bytes = await readProjectFile(context.workspace, path);
      if (bytes === null) throw new ToolError(`File not found: ${path}`);
      requireUnchanged(file, path, bytes, context);
      before = requireUtf8ForEdit(bytes, path).toString('utf8');
    }
    const rel = context.workspace.relative(file);
    return { title: existsSync(file) ? `Overwrite ${rel}` : `Create ${rel}`, diff: unifiedDiff(rel, before, content) };
  },
  async run({ path, content }, context) {
    refuseRedacted(content);
    const file = context.workspace.resolve(path);
    const rel = context.workspace.relative(file);
    const previous = await readProjectFile(context.workspace, path);
    const exists = previous !== null;
    if (exists) requireRead(file, path, context);
    // Keep the exact previous bytes for Undo.
    if (previous !== null) {
      // Checked again here: the user may have edited the file while the approval card was open.
      requireUnchanged(file, path, previous, context);
      requireUtf8ForEdit(previous, path);
    }
    await changeProjectFiles(context.workspace, [{ path, before: previous, after: Buffer.from(content) }]);
    context.readFiles.set(file, sha256(content));
    if (path.endsWith('.gitignore')) context.workspace.invalidateIgnoreRules();
    return {
      content: `${exists ? 'Updated' : 'Created'} ${rel}.`,
      summary: `${exists ? 'Wrote' : 'Created'} ${rel}`,
      path: rel,
      undo: { path: rel, before: previous, afterHash: sha256(content) },
    };
  },
});

// The bytes each edit_file call's preview diffed, by call input: preview and run get the same input object. The edit
// is refused when the file changed in between, so what runs is what the approved diff showed (#255).
const previewedEdits = new WeakMap<object, string>();

export const editFileTool = defineTool({
  name: 'edit_file',
  strictInput: true,
  description:
    'Replace an exact string in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first with read_file (in an earlier step, not in the same batch as the edit). Always send path, old_string and new_string. Include enough surrounding lines to make old_string unique.',
  schema: z.object({
    path: z.string().describe('File path, relative to the project root.'),
    old_string: z.string().min(1).describe('Exact text to replace.'),
    new_string: z.string().describe('Replacement text.'),
    replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring a unique match.'),
  }),
  requiresApproval: true,
  mustAsk: ({ path }, context) => isProtected(path, context),
  async preview(input, context) {
    const file = context.workspace.resolve(input.path);
    const rel = context.workspace.relative(file);
    // Fail before asking for approval, not after the user has approved a diff that cannot be applied.
    requireRead(file, input.path, context);
    const bytes = await readProjectFile(context.workspace, input.path);
    if (bytes === null) throw new ToolError(`File not found: ${input.path}`);
    const before = requireUtf8ForEdit(bytes, input.path).toString('utf8');
    previewedEdits.set(input, sha256(bytes));
    return { title: `Edit ${rel}`, diff: unifiedDiff(rel, before, applyEdit(before, input)) };
  },
  async run(input, context) {
    const file = context.workspace.resolve(input.path);
    if (!existsSync(file)) throw new ToolError(`File not found: ${input.path}`);
    requireRead(file, input.path, context);
    const rel = context.workspace.relative(file);
    const bytes = await readProjectFile(context.workspace, input.path);
    if (bytes === null) throw new ToolError(`File not found: ${input.path}`);
    const previewed = previewedEdits.get(input);
    if (previewed !== undefined && previewed !== sha256(bytes)) {
      throw new ToolError(
        `${input.path} changed after the edit was shown for approval. Read it again and redo the edit.`,
      );
    }
    const before = requireUtf8ForEdit(bytes, input.path).toString('utf8');
    const after = applyEdit(before, input);
    await changeProjectFiles(context.workspace, [{ path: input.path, before: bytes, after: Buffer.from(after) }]);
    // The model knows what it wrote, so a later write_file needs no new read.
    context.readFiles.set(file, sha256(after));
    return {
      content: `Edited ${rel}.\n${unifiedDiff(rel, before, after)}`,
      summary: `Edited ${rel}`,
      path: rel,
      undo: { path: rel, before: bytes, afterHash: sha256(after) },
    };
  },
});

// Keep whole lines when possible. An overlong first line is split at a Unicode-safe boundary and continued explicitly.
export function fitLines(lines: string[], budget: number): { text: string; lines: number; cutLine: boolean } {
  let size = 0;
  let count = 0;
  for (const line of lines) {
    const next = size + line.length + (count > 0 ? 1 : 0);
    if (next > budget) break;
    size = next;
    count++;
  }
  if (count === 0 && lines.length > 0) {
    const line = lines[0] ?? '';
    const end = splitsSurrogatePair(line, budget) ? budget - 1 : budget;
    return { text: line.slice(0, end), lines: 1, cutLine: true };
  }
  return { text: lines.slice(0, count).join('\n'), lines: count, cutLine: false };
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

// Protected files (keys, .env, .git, editor and shell config) are asked about even in Auto mode.
function isProtected(path: string, context: ToolContext): boolean {
  return isGuardedPath(context.workspace.relative(context.workspace.resolve(path)));
}

// Tool results hide secrets behind a placeholder. Writing it back would replace the real value with the placeholder.
function refuseRedacted(...texts: string[]): void {
  if (texts.some(containsRedaction)) {
    throw new ToolError(
      'The text contains a [REDACTED:_____] placeholder: a secret was hidden from you. Do not write the placeholder into a file; leave that part unchanged or ask the user for the value.',
    );
  }
}

function requireRead(file: string, path: string, context: ToolContext): void {
  if (!context.readFiles.has(file)) {
    throw new ToolError(
      `${path} has not been read in this chat. Call read_file on it first, and wait for the result before editing (do not send the read and the edit in the same batch).`,
    );
  }
}

// write_file replaces the whole file, so it must not be built from a read that is out of date: that would silently
// drop a change the user made since. A file read in a chat saved by an older version has no known hash.
function requireUnchanged(file: string, path: string, bytes: Buffer, context: ToolContext): void {
  // An unknown (null) hash never matches.
  if (context.readFiles.get(file) !== sha256(bytes)) {
    throw new ToolError(`${path} changed since you read it. Read it again first.`);
  }
}

// Exported for tests. Matching tolerates the file using CRLF while the model sends LF.
export function applyEdit(
  content: string,
  { old_string, new_string, replace_all = false }: { old_string: string; new_string: string; replace_all?: boolean },
): string {
  refuseRedacted(old_string, new_string);
  const eol = detectEol(content);
  // The literal text first, so an edit inside the LF part of a file that mixes CRLF and LF still matches; then the
  // text with CRLF endings. The replacement takes the line ending of the text that matched.
  const candidates = [old_string];
  if (eol === '\r\n') candidates.push(old_string.replace(/\r?\n/g, '\r\n'));
  const find = candidates.find((candidate) => content.includes(candidate)) ?? old_string;
  const matchedEol = find.includes('\r\n') ? '\r\n' : find.includes('\n') ? '\n' : eol;
  const replacement = new_string.replace(/\r?\n/g, matchedEol);

  const count = content.split(find).length - 1;
  if (count === 0) {
    throw new ToolError('old_string was not found in the file. Read the file again and copy the text exactly.');
  }
  if (count > 1 && !replace_all) {
    throw new ToolError(
      `old_string appears ${count} times. Add surrounding lines to make it unique, or set replace_all.`,
    );
  }
  return replace_all ? content.split(find).join(replacement) : content.replace(find, () => replacement);
}

export function unifiedDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3 });
}
