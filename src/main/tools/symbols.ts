import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { fileSize, isBinaryFile, isHardLinked, MAX_READ_BYTES } from './text_files';
import { defineTool, ToolError, type ToolContext } from './types';

const MAX_DEFINITIONS = 20;
const DEFINITION_CONTEXT_LINES = 4;
const MAX_REFERENCES = 100;
const MAX_REFERENCES_PER_FILE = 20;
const MAX_LINE_CHARS = 200;
// Minified or generated lines are skipped instead of scanned.
const MAX_SCANNED_LINE = 2000;

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const QUALIFIED = /^[A-Za-z_$][\w$]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*$/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*(?:\s|\/|$)|#(?!\[|!)|--|;;|<!--)/;
const MODIFIERS = '(?:(?:public|private|protected|internal|static|readonly|async|override|abstract|get|set)\\s+)';

function escapeName(name: string): string {
  return name.replace(/\$/g, '\\$');
}

// Name-based, language-agnostic declaration shapes: a declaration keyword followed by the name (TypeScript, JavaScript,
// Python, Go, Rust, Java, C#, Kotlin, Swift, Ruby, PHP), a variable after `const`/`let`/`var` or at the start of a line,
// and a method or modifier-led class member. They find where a name is declared, not which declaration a call reaches.
export function definitionPatterns(name: string): RegExp[] {
  const n = escapeName(name);
  const end = '(?![\\w$])';
  return [
    new RegExp(
      `\\b(?:function\\*?|class|interface|enum|struct|record|trait|object|protocol|namespace|module|def|func|fun|fn|type|mod|union|typealias)\\s+${n}${end}`,
    ),
    new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var|static|val)\\s+${n}${end}`),
    new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:static|const)\\s+(?:mut\\s+)?${n}${end}`),
    new RegExp(`^func\\s+\\([^)]*\\)\\s*${n}${end}`),
    new RegExp(`^${n}\\s*(?::[^=]+)?=(?!=)`),
    new RegExp(`^\\s*${MODIFIERS}+\\*?${n}\\s*[<(?!:=]`),
    new RegExp(`^\\s*${MODIFIERS}*\\*?${n}\\s*(?:<[^>]*>)?\\([^;]*\\)\\s*(?::[^{;=]+)?\\{\\s*$`),
  ];
}

export function referencePattern(name: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeName(name)}(?![\\w$])`);
}

// `ShellRunner.spawn` is looked up as `spawn`, preferring files that mention `ShellRunner`.
function splitSymbol(symbol: string): { name: string; qualifier: string | null } {
  if (!QUALIFIED.test(symbol)) {
    throw new ToolError(`Not a symbol name: ${symbol}. Give an identifier such as "parse" or "Parser.parse".`);
  }
  const parts = symbol.split(/\.|::|#/);
  return { name: parts[parts.length - 1]!, qualifier: parts.length > 1 ? parts[parts.length - 2]! : null };
}

function clip(text: string): string {
  const line = text.trim();
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

async function searchableFiles(path: string, context: ToolContext): Promise<string[]> {
  const target = context.workspace.resolve(path);
  if (!existsSync(target)) throw new ToolError(`Not found: ${path}`);
  return statSync(target).isDirectory() ? await context.workspace.listFiles(target) : [target];
}

async function readText(file: string): Promise<string | null> {
  try {
    if ((await fileSize(file)) > MAX_READ_BYTES || (await isBinaryFile(file)) || (await isHardLinked(file)))
      return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

interface Definition {
  path: string;
  line: number;
  lines: string[];
  qualified: boolean;
}

export const findDefinitionTool = defineTool({
  name: 'find_definition',
  description:
    'Find where a symbol (function, class, type, interface, enum, method, constant) is defined, with its signature and the lines after it. Matches declarations only, not comments, strings or calls, so it is cheaper and more precise than grep for "where is X defined". It is name-based, not type-aware: same-named symbols in other files all show. "Class.method" prefers files that mention the class.',
  schema: z.object({
    symbol: z.string().min(1).describe('Name of the symbol, or "Class.method".'),
    path: z.string().optional().describe('File or folder to search, relative to the project root. Defaults to all.'),
  }),
  requiresApproval: false,
  parallelSafe: true,
  async run({ symbol, path = '.' }, context) {
    const { name, qualifier } = splitSymbol(symbol);
    const patterns = definitionPatterns(name);
    const qualifierPattern = qualifier ? referencePattern(qualifier) : null;
    const found: Definition[] = [];
    for (const file of await searchableFiles(path, context)) {
      if (context.signal.aborted) break;
      const text = await readText(file);
      if (text === null || !text.includes(name)) continue;
      const lines = text.split(/\r?\n/);
      const qualified = qualifierPattern ? qualifierPattern.test(text) : true;
      lines.forEach((line, index) => {
        if (COMMENT_LINE.test(line) || line.length > MAX_SCANNED_LINE) return;
        if (patterns.some((pattern) => pattern.test(line))) {
          found.push({
            path: context.workspace.relative(file),
            line: index + 1,
            lines: lines.slice(index, index + 1 + DEFINITION_CONTEXT_LINES),
            qualified,
          });
        }
      });
    }
    const preferred = found.filter((definition) => definition.qualified);
    const pool = preferred.length > 0 ? preferred : found;
    const shown = pool.slice(0, MAX_DEFINITIONS);
    if (shown.length === 0) {
      return {
        content: `No definition of ${symbol} found. Try grep or search_code.`,
        summary: `No definition of ${symbol}`,
      };
    }
    const blocks = shown.map((definition) =>
      [
        `${definition.path}:${definition.line}`,
        ...definition.lines.map((text, i) => `  ${definition.line + i}: ${clip(text)}`),
      ].join('\n'),
    );
    const note =
      pool.length > shown.length ? `\n(Showing ${shown.length} of ${pool.length}; give a path to narrow.)` : '';
    return {
      content: blocks.join('\n\n') + note,
      summary: `Found ${pool.length} definition${pool.length === 1 ? '' : 's'} of ${symbol}`,
    };
  },
});

// The identifier at a 1-based column, or the longest identifier on the line.
export function symbolAt(lineText: string, column?: number): string | null {
  const words = [...lineText.matchAll(IDENTIFIER)];
  if (words.length === 0) return null;
  if (column !== undefined) {
    const at = column - 1;
    const hit = words.find((word) => at >= word.index! && at <= word.index! + word[0].length);
    return hit ? hit[0] : null;
  }
  return words.reduce((best, word) => (word[0].length > best[0].length ? word : best))[0];
}

export const findReferencesTool = defineTool({
  name: 'find_references',
  description:
    'Find every use of a symbol as whole-word matches, as path:line: text, skipping comment-only lines and marking declarations. Give the symbol, or path and line (and optionally column) of a place where it appears. Name-based: same-named symbols in unrelated code also match, and a re-export or alias shows as its own import line, so look up the alias too. Capped like grep.',
  schema: z.object({
    symbol: z.string().min(1).optional().describe('Name of the symbol, or "Class.method" (the last part is searched).'),
    path: z
      .string()
      .optional()
      .describe('With symbol: file or folder to search. With line: the file that has the symbol.'),
    line: z.number().int().min(1).optional().describe('1-based line in path where the symbol appears.'),
    column: z.number().int().min(1).optional().describe('1-based column to pick one symbol on that line.'),
  }),
  requiresApproval: false,
  parallelSafe: true,
  async run({ symbol, path, line, column }, context) {
    let scope = '.';
    if (symbol === undefined) {
      if (path === undefined || line === undefined) throw new ToolError('Give either symbol, or path and line.');
      const file = context.workspace.resolve(path);
      if (!existsSync(file) || !statSync(file).isFile()) throw new ToolError(`File not found: ${path}`);
      const lineText = (await readText(file))?.split(/\r?\n/)[line - 1];
      if (lineText === undefined) throw new ToolError(`${path} has no line ${line}.`);
      const picked = symbolAt(lineText, column);
      if (!picked) throw new ToolError(`No symbol at ${path}:${line}${column ? `:${column}` : ''}.`);
      symbol = picked;
    } else if (path !== undefined) {
      scope = path;
    }
    const { name } = splitSymbol(symbol);
    const pattern = referencePattern(name);
    const declaration = definitionPatterns(name);

    const results: string[] = [];
    const crowded: string[] = [];
    for (const file of await searchableFiles(scope, context)) {
      if (context.signal.aborted || results.length >= MAX_REFERENCES) break;
      const text = await readText(file);
      if (text === null || !text.includes(name)) continue;
      const rel = context.workspace.relative(file);
      const lines = text.split(/\r?\n/);
      let inFile = 0;
      for (let index = 0; index < lines.length; index++) {
        const lineText = lines[index]!;
        if (lineText.length > MAX_SCANNED_LINE || COMMENT_LINE.test(lineText) || !pattern.test(lineText)) continue;
        if (inFile >= MAX_REFERENCES_PER_FILE) {
          crowded.push(rel);
          break;
        }
        if (results.length >= MAX_REFERENCES) break;
        const mark = declaration.some((candidate) => candidate.test(lineText)) ? ' [definition]' : '';
        results.push(`${rel}:${index + 1}: ${clip(lineText)}${mark}`);
        inFile++;
      }
    }
    const notes: string[] = [];
    if (results.length >= MAX_REFERENCES) notes.push(`Stopped at ${MAX_REFERENCES} references; give a path to narrow.`);
    if (crowded.length > 0) {
      notes.push(`Showing the first ${MAX_REFERENCES_PER_FILE} per file; more in: ${crowded.join(', ')}.`);
    }
    const note = notes.length > 0 ? `\n(${notes.join(' ')})` : '';
    const count = results.length;
    return {
      content: (results.join('\n') || `No references to ${name} found.`) + note,
      summary: `Found ${count} reference${count === 1 ? '' : 's'} to ${name}`,
    };
  },
});
