import { statSync } from 'node:fs';
import { z } from 'zod';
import { RegexWorker } from './regex_worker';
import { defineTool, ToolError } from './types';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
// Matching every project path takes milliseconds; longer means the pattern backtracks catastrophically.
const GLOB_TIMEOUT_MS = 5000;

// Turns a glob into a regular expression over project-relative paths with forward slashes: `*` is any text inside one
// folder name, `**` any number of folders, `?` one character, `{a,b}` alternatives. A pattern without a `/` matches the
// file name at any depth, like a .gitignore line.
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.includes('/') ? glob.replace(/^\.\//, '').replace(/^\//, '') : `**/${glob}`;
  let source = '';
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      depth++;
      source += '(?:';
    } else if (char === '}' && depth > 0) {
      depth--;
      source += ')';
    } else if (char === ',' && depth > 0) {
      source += '|';
    } else {
      source += char.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
    }
  }
  if (depth > 0) throw new ToolError(`Unbalanced { in the pattern: ${glob}`);
  return new RegExp(`^${source}$`);
}

export const globTool = defineTool({
  name: 'glob',
  description:
    'Find files by name pattern, skipping files ignored by .gitignore. Patterns: * (inside one folder name), ** (any folders), ? (one character), {a,b} (alternatives); a pattern without a / matches the file name at any depth. Examples: "**/*.test.ts", "src/**/index.{ts,tsx}", "package.json". Use it to locate files by name; use grep for file contents.',
  schema: z.object({
    pattern: z.string().min(1).describe('Glob pattern, matched against project-relative paths.'),
    path: z.string().optional().describe('Folder to search in, relative to the project root. Defaults to the root.'),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Files to return (default ${DEFAULT_LIMIT}).`),
    offset: z.number().int().min(0).optional().describe('Files to skip, to page through a long result.'),
  }),
  requiresApproval: false,
  parallelSafe: true,
  async run({ pattern, path = '.', limit = DEFAULT_LIMIT, offset = 0 }, context) {
    const base = context.workspace.resolve(path);
    if (!statSync(base).isDirectory()) throw new ToolError(`Not a directory: ${path}`);
    const baseRel = context.workspace.relative(base);
    const regex = globToRegExp(pattern);

    const files = (await context.workspace.listFiles(base)).map((file) => context.workspace.relative(file));
    // Many wildcards (**a**a**a…) backtrack badly; the match runs in a worker so it cannot freeze the app (#122).
    const worker = new RegexWorker(regex.source, regex.flags);
    let result;
    try {
      result = await worker.match(
        { items: files.map((rel) => (baseRel === '.' ? rel : rel.slice(baseRel.length + 1))) },
        { timeoutMs: GLOB_TIMEOUT_MS, signal: context.signal },
      );
    } finally {
      worker.close();
    }
    if (result.status === 'timeout') {
      throw new ToolError(
        `The pattern took more than ${GLOB_TIMEOUT_MS / 1000} s to match the project's paths. Use fewer wildcards.`,
      );
    }
    if (result.status === 'aborted') throw new ToolError('The search was stopped.');
    const matches = result.found.map((index) => files[index]!);

    const page = matches.slice(offset, offset + limit);
    const end = offset + page.length;
    const note =
      end < matches.length
        ? `\n(Showing ${offset + 1}-${end} of ${matches.length}. Use offset=${end} to see more.)`
        : '';
    return {
      content: (page.join('\n') || 'No files match.') + note,
      summary: `Found ${matches.length} file${matches.length === 1 ? '' : 's'} for ${pattern}`,
    };
  },
});
