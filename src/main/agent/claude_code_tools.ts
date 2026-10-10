import { isAbsolute, relative } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { ToolPreviewView } from '@shared/chat';

// How a Claude Code tool call is shown in Patch's transcript: the card's preview (also used on its approval card),
// the file it is about, and whether its result is shown on the card. Claude Code's tool names and inputs are its own
// (Bash, Read, Edit, …); a tool this file does not know is shown with its input as JSON, like an MCP tool.

export interface ClaudeCodeToolView {
  preview: ToolPreviewView;
  // Project-relative path of the file the call reads or changes; the card opens it.
  path?: string;
  // The tool's result goes on the card (commands, checklists). Other results only show when the call failed.
  showsOutput: boolean;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

// A path as the card shows it: relative to the project when it is inside it, else as Claude Code wrote it.
function displayPath(path: string, cwd: string): string {
  if (!path) return '';
  if (!isAbsolute(path)) return path.replace(/\\/g, '/');
  const inside = relative(cwd, path);
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside.replace(/\\/g, '/') : path;
}

function editDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3 });
}

function checklist(todos: unknown): string {
  if (!Array.isArray(todos)) return '';
  return todos
    .map((todo: { content?: unknown; status?: unknown }) => {
      const mark = todo?.status === 'completed' ? 'x' : ' ';
      const doing = todo?.status === 'in_progress' ? ' (in progress)' : '';
      return `- [${mark}] ${str(todo?.content)}${doing}`;
    })
    .join('\n');
}

export function alwaysAsks(name: string, input: Record<string, unknown>): boolean {
  return (
    name.startsWith('mcp__') || name === 'ExitPlanMode' || (name === 'Bash' && input.dangerouslyDisableSandbox === true)
  );
}

function bashNote(platform: NodeJS.Platform, outsideSandbox: boolean): string {
  const where =
    platform === 'win32'
      ? 'Claude Code runs this command unsandboxed, with your rights: Windows has no sandbox for its commands, and Patch’s command sandbox does not apply.'
      : 'Claude Code runs this command under its own permissions and sandbox settings, not Patch’s command sandbox.';
  return outsideSandbox ? `${where} It asks to run outside the sandbox.` : where;
}

export function describeClaudeCodeTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): ClaudeCodeToolView {
  const filePath = displayPath(str(input.file_path) || str(input.notebook_path), cwd);
  switch (name) {
    case 'Bash':
      return {
        preview: {
          title: str(input.description) || 'Run command',
          command: str(input.command),
          note: bashNote(platform, input.dangerouslyDisableSandbox === true),
        },
        showsOutput: true,
      };
    case 'Read':
      return { preview: { title: `Read ${filePath}` }, path: filePath, showsOutput: false };
    case 'Edit':
      return {
        preview: {
          title: `Edit ${filePath}`,
          diff: editDiff(filePath, str(input.old_string), str(input.new_string)),
        },
        path: filePath,
        showsOutput: false,
      };
    case 'Write':
      return {
        preview: { title: `Write ${filePath}`, diff: editDiff(filePath, '', str(input.content)) },
        path: filePath,
        showsOutput: false,
      };
    case 'Glob':
      return { preview: { title: `Find files ${str(input.pattern)}` }, showsOutput: false };
    case 'Grep':
      return { preview: { title: `Search for ${str(input.pattern)}` }, showsOutput: false };
    case 'WebFetch':
      return { preview: { title: `Fetch ${str(input.url)}` }, showsOutput: false };
    case 'WebSearch':
      return { preview: { title: `Search the web for ${str(input.query)}` }, showsOutput: false };
    case 'Agent':
    case 'Task':
      return {
        preview: { title: `Subagent: ${str(input.description) || 'task'}`, text: str(input.prompt) },
        showsOutput: false,
      };
    case 'TodoWrite':
      return { preview: { title: 'Update checklist', text: checklist(input.todos) }, showsOutput: false };
    case 'ToolSearch':
      return { preview: { title: 'Load tools' }, showsOutput: false };
    case 'ExitPlanMode':
      return {
        preview: {
          title: 'Plan',
          text: str(input.plan) || 'Claude Code is ready to leave plan mode and start working.',
        },
        showsOutput: false,
      };
    default:
      return { preview: { title: name, arguments: JSON.stringify(input, null, 2) }, showsOutput: false };
  }
}

// The text of a tool_result block's content: a string, or text blocks (images and other blocks are left out).
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: { type?: unknown; text?: unknown }) => (block?.type === 'text' ? str(block.text) : ''))
    .filter(Boolean)
    .join('\n');
}
