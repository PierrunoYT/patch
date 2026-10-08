import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { unifiedDiff } from './files';
import { isGuardedPath } from './guard';
import { containsRedaction } from './redact';
import { requireUtf8ForEdit, isBinaryFile } from './text_files';
import { defineTool, ToolError, type ToolContext } from './types';

// The patch format of OpenAI's Codex CLI:
//
//   *** Begin Patch
//   *** Add File: path          (every following line starts with +)
//   *** Delete File: path
//   *** Update File: path
//   *** Move to: new/path       (optional, right after Update File)
//   @@ optional text found on a line before the change (a function or class header)
//    context line
//   -removed line
//   +added line
//   *** End of File             (optional: the hunk before it sits at the end of the file)
//   *** End Patch

interface HunkLine {
  prefix: ' ' | '-' | '+';
  text: string;
}

interface Hunk {
  anchor: string | null;
  atEnd: boolean;
  lines: HunkLine[];
}

export type PatchOp =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; hunks: Hunk[] };

export function parsePatch(patchText: string): PatchOp[] {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  if (lines[0]?.trim() !== '*** Begin Patch') throw new ToolError("The patch must start with '*** Begin Patch'.");
  if (lines[lines.length - 1]?.trim() !== '*** End Patch')
    throw new ToolError("The patch must end with '*** End Patch'.");

  const ops: PatchOp[] = [];
  let current: PatchOp | null = null;
  for (const line of lines.slice(1, -1)) {
    const add = /^\*\*\* Add File: (.+)$/.exec(line);
    const del = /^\*\*\* Delete File: (.+)$/.exec(line);
    const update = /^\*\*\* Update File: (.+)$/.exec(line);
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (add || del || update) {
      if (add) current = { kind: 'add', path: add[1]!.trim(), lines: [] };
      else if (del) current = { kind: 'delete', path: del[1]!.trim() };
      else current = { kind: 'update', path: update![1]!.trim(), moveTo: null, hunks: [] };
      ops.push(current);
    } else if (move) {
      if (current?.kind !== 'update' || current.hunks.length > 0) {
        throw new ToolError("'*** Move to:' must directly follow '*** Update File:'.");
      }
      current.moveTo = move[1]!.trim();
    } else if (line.trim() === '*** End of File') {
      if (current?.kind !== 'update' || current.hunks.length === 0) {
        throw new ToolError("'*** End of File' must follow the lines of an update hunk.");
      }
      current.hunks[current.hunks.length - 1]!.atEnd = true;
    } else if (!current) {
      throw new ToolError(`Unexpected line before the first file header: ${line.slice(0, 60)}`);
    } else if (current.kind === 'add') {
      if (!line.startsWith('+')) throw new ToolError(`An added file's lines must start with '+': ${line.slice(0, 60)}`);
      current.lines.push(line.slice(1));
    } else if (current.kind === 'delete') {
      if (line.trim() !== '') throw new ToolError(`Unexpected line under Delete File: ${line.slice(0, 60)}`);
    } else if (line.startsWith('@@')) {
      current.hunks.push({ anchor: line.slice(2).trim() || null, atEnd: false, lines: [] });
    } else {
      if (current.hunks.length === 0) current.hunks.push({ anchor: null, atEnd: false, lines: [] });
      const hunk = current.hunks[current.hunks.length - 1]!;
      const prefix = line[0];
      if (prefix === ' ' || prefix === '-' || prefix === '+') hunk.lines.push({ prefix, text: line.slice(1) });
      else if (line === '') hunk.lines.push({ prefix: ' ', text: '' });
      else throw new ToolError(`A hunk line must start with ' ', '-' or '+': ${line.slice(0, 60)}`);
    }
  }
  if (ops.length === 0) throw new ToolError('The patch changes no file.');
  return ops;
}

// Applies the hunks of one file in order and returns the new content. Each hunk is searched for after the previous
// one, so repeated lines are resolved by position; an @@ anchor moves the search start to the line holding that text.
export function applyHunks(content: string, hunks: Hunk[], label: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const endsWithNewline = lines[lines.length - 1] === '';
  if (endsWithNewline) lines.pop();

  let cursor = 0;
  for (const hunk of hunks) {
    const before = hunk.lines.filter((line) => line.prefix !== '+').map((line) => line.text);
    const after = hunk.lines.filter((line) => line.prefix !== '-').map((line) => line.text);

    let from = cursor;
    if (hunk.anchor) {
      const index = lines.findIndex((line, i) => i >= cursor && line.includes(hunk.anchor!));
      if (index < 0) throw new ToolError(`${label}: the anchor '@@ ${hunk.anchor}' was not found.`);
      from = index;
    }

    let start = -1;
    if (hunk.atEnd) {
      const at = lines.length - before.length;
      if (at >= from && matchesAt(lines, before, at, normalizeExact)) start = at;
      else if (at >= from && matchesAt(lines, before, at, normalizeLoose)) start = at;
      if (start < 0) throw new ToolError(`${label}: the end-of-file hunk does not match the end of the file.`);
    } else if (before.length === 0) {
      // Nothing to look for: insert after the anchor line or, without one, append at the end.
      start = hunk.anchor ? from + 1 : lines.length;
    } else {
      for (const normalize of [normalizeExact, normalizeTrailing, normalizeLoose]) {
        const found = positions(lines, before, from, normalize);
        if (found.length === 0) continue;
        if (found.length > 1 && !hunk.anchor) {
          throw new ToolError(
            `${label}: a hunk matches ${found.length} places. Add more context lines or an @@ anchor.`,
          );
        }
        start = found[0]!;
        break;
      }
      if (start < 0) {
        throw new ToolError(
          `${label}: a hunk does not match the file (it starts with: ${(before[0] ?? '').trim().slice(0, 60) || '(blank line)'}). Read the file again and copy the lines exactly.`,
        );
      }
    }
    lines.splice(start, before.length, ...after);
    cursor = start + after.length;
  }
  const text = lines.join(eol);
  return lines.length > 0 && endsWithNewline ? text + eol : text;
}

const normalizeExact = (line: string) => line;
const normalizeTrailing = (line: string) => line.trimEnd();
const normalizeLoose = (line: string) => line.trim();

function matchesAt(lines: string[], block: string[], at: number, normalize: (line: string) => string): boolean {
  return block.every((line, i) => lines[at + i] !== undefined && normalize(lines[at + i]!) === normalize(line));
}

function positions(lines: string[], block: string[], from: number, normalize: (line: string) => string): number[] {
  const found: number[] = [];
  for (let at = from; at + block.length <= lines.length; at++) {
    if (matchesAt(lines, block, at, normalize)) found.push(at);
  }
  return found;
}

// One file's change, fully computed in memory.
export interface PlannedChange {
  rel: string;
  absolute: string;
  before: string | null;
  after: string | null;
  // For a move: where the content used to be.
  fromAbsolute?: string;
  fromRel?: string;
}

// Works out every change before any file is touched, so a patch that fails in its third file leaves the first two alone.
export async function planPatch(ops: PatchOp[], context: ToolContext): Promise<PlannedChange[]> {
  const { workspace } = context;
  const changes: PlannedChange[] = [];
  const touched = new Set<string>();
  const claim = (absolute: string, rel: string) => {
    if (touched.has(absolute))
      throw new ToolError(`${rel} appears twice in the patch. Put all changes to a file in one block.`);
    touched.add(absolute);
  };

  for (const op of ops) {
    const absolute = workspace.resolve(op.path);
    const rel = workspace.relative(absolute);
    claim(absolute, rel);
    if (op.kind === 'add') {
      if (existsSync(absolute)) throw new ToolError(`${rel} already exists. Use Update File to change it.`);
      const after = op.lines.length > 0 ? op.lines.join('\n') + '\n' : '';
      if (containsRedaction(after)) throw redactedError();
      changes.push({ rel, absolute, before: null, after });
      continue;
    }

    if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new ToolError(`File not found: ${op.path}`);
    if (!context.readFiles.has(absolute)) {
      throw new ToolError(
        `${rel} has not been read in this chat. Call read_file on it first, and wait for the result before patching it.`,
      );
    }
    if (await isBinaryFile(absolute)) throw new ToolError(`${rel} is a binary file.`);
    const bytes = await readFile(absolute);
    if (op.kind === 'update') requireUtf8ForEdit(bytes, rel);
    const before = bytes.toString('utf8');
    if (op.kind === 'delete') {
      changes.push({ rel, absolute, before, after: null });
      continue;
    }
    if (op.hunks.some((hunk) => hunk.lines.some((line) => containsRedaction(line.text)))) throw redactedError();
    const after = applyHunks(before, op.hunks, rel);
    if (op.moveTo) {
      const target = workspace.resolve(op.moveTo);
      const targetRel = workspace.relative(target);
      if (target !== absolute && existsSync(target))
        throw new ToolError(`${targetRel} already exists; cannot move ${rel} there.`);
      if (target === absolute) {
        changes.push({ rel, absolute, before, after });
      } else {
        claim(target, targetRel);
        changes.push({ rel: targetRel, absolute: target, before, after, fromAbsolute: absolute, fromRel: rel });
      }
    } else {
      changes.push({ rel, absolute, before, after });
    }
  }
  return changes;
}

function redactedError(): ToolError {
  return new ToolError(
    'The patch contains a [REDACTED:_____] placeholder: a secret was hidden from you. Do not write the placeholder into a file.',
  );
}

function describeChange(change: PlannedChange): string {
  if (change.fromRel) return `Moved ${change.fromRel} to ${change.rel}`;
  if (change.before === null) return `Added ${change.rel}`;
  if (change.after === null) return `Deleted ${change.rel}`;
  return `Updated ${change.rel}`;
}

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  description:
    "Change several files in one call with a patch in the Codex format: '*** Begin Patch', then any number of '*** Add File: path' (every line prefixed with +), '*** Delete File: path' and '*** Update File: path' (optionally followed by '*** Move to: new/path') blocks, then '*** End Patch'. An update has hunks that start with '@@' (optionally followed by text from a line before the change, such as a function header); inside a hunk, context lines start with a space, removed lines with - and added lines with +. Include about three lines of context around every change, and '*** End of File' after a hunk that sits at the end of the file. Existing files must be read first. All changes are checked before any file is written, so a failing patch changes nothing. Use edit_file for a single small change.",
  schema: z.object({
    patch: z.string().describe('The whole patch, from *** Begin Patch to *** End Patch.'),
  }),
  requiresApproval: true,
  mustAsk: ({ patch }, context) =>
    parsePatch(patch).some((op) =>
      [op.path, op.kind === 'update' ? op.moveTo : null].some(
        (path) => path && isGuardedPath(context.workspace.relative(context.workspace.resolve(path))),
      ),
    ),
  async preview({ patch }, context) {
    const changes = await planPatch(parsePatch(patch), context);
    const diff = changes.map((change) => unifiedDiff(change.rel, change.before ?? '', change.after ?? '')).join('\n');
    return {
      title: changes.length === 1 ? describeChange(changes[0]!) : `Apply a patch to ${changes.length} files`,
      diff,
    };
  },
  async run({ patch }, context) {
    const changes = await planPatch(parsePatch(patch), context);
    for (const change of changes) {
      if (change.after === null) {
        await rm(change.absolute, { force: true });
        continue;
      }
      await mkdir(dirname(change.absolute), { recursive: true });
      await writeFile(change.absolute, change.after, 'utf8');
      if (change.fromAbsolute && change.fromAbsolute !== change.absolute)
        await rm(change.fromAbsolute, { force: true });
      context.readFiles.add(change.absolute);
      if (change.rel.endsWith('.gitignore')) context.workspace.invalidateIgnoreRules();
    }
    const lines = changes.map(describeChange);
    return {
      content: `Applied the patch:\n${lines.join('\n')}`,
      summary: changes.length === 1 ? lines[0]! : `Patched ${changes.length} files`,
      path: changes.length === 1 && changes[0]!.after !== null ? changes[0]!.rel : undefined,
    };
  },
});
