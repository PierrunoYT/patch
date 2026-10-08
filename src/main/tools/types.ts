import type { z } from 'zod';
import type { ImageData, JsonObjectSchema } from '../llm/types';
import type { BrowserController } from './browser';
import type { ShellRunner } from './shell';
import type { Workspace } from './workspace';

export interface ToolOutput {
  // What the model sees.
  content: string;
  isError?: boolean;
  images?: ImageData[];
  // Short line for the chat transcript, e.g. "Read src/app.ts (120 lines)".
  summary?: string;
  // Project-relative file the tool read or changed, so the UI can offer to open it.
  path?: string;
  // Set by tools that change a file, so the change can be undone. Never shown to the model.
  undo?: EditUndo;
}

// What is needed to put a file back the way it was before a tool changed it.
export interface EditUndo {
  // Project-relative path.
  path: string;
  // The exact bytes the file had before, or null when the tool created it.
  before: Buffer | null;
  // SHA-256 of the bytes the tool wrote. Undoing is only allowed while the file still has exactly these.
  afterHash: string;
}

// Shown to the user before an approval-gated tool runs.
export interface ToolPreview {
  title: string;
  diff?: string;
  command?: string;
  note?: string;
  // Free-form markdown (the plan in plan mode) shown on the approval card instead of a diff or command.
  text?: string;
}

export interface CodeSearch {
  search(
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<Array<{ path: string; startLine: number; endLine: number; text: string }>>;
}

export interface WebSearchConfig {
  googleApiKey: string;
  googleSearchEngineId: string;
}

export interface ToolContext {
  workspace: Workspace;
  signal: AbortSignal;
  // Absolute paths of files the model has read in this chat, with the sha256 of the content it last read or wrote
  // (null: unknown, from a chat saved by an older version). Existing files must be read before they are overwritten
  // or edited, so the model never changes code it has not seen; write_file also refuses when the hash no longer matches.
  readFiles: Map<string, string | null>;
  shell: ShellRunner;
  // The chat this call belongs to. Background commands are scoped to it, so another chat that shares the runner
  // cannot read or stop them. Absent (tests): one shared scope.
  chatId?: string;
  browser: BrowserController | null;
  codeSearch: CodeSearch | null;
  webSearch: WebSearchConfig | null;
  // True when the user listed this URL's host in allowedNetworkHosts. fetch_url and browser then do not ask for a
  // local or private address. Absent (tests, subagents): no host is listed.
  allowsNetworkUrl?(url: string): boolean;
  // Live output for the transcript while a tool runs (e.g. command output).
  onProgress(text: string): void;
}

export interface AgentTool<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  // Built-in tools validate with Zod. MCP tools have no Zod schema; they declare the server's JSON Schema and
  // input is only checked structurally (object with required fields) before being sent to the server.
  schema?: S;
  jsonSchema?: JsonObjectSchema;
  // Ask supporting providers to enforce the input schema; local validation still runs.
  strictInput?: boolean;
  // Tools that change files or run commands wait for approval unless the user chose auto mode.
  requiresApproval: boolean;
  // Still asks in Auto mode. MCP tools run programs the user configured, so they are never pre-approved.
  alwaysAsk?: boolean;
  // True for tools that only read and never ask for approval. Consecutive calls to such tools in one model turn run at
  // the same time; any other call runs alone, in order.
  parallelSafe?: boolean;
  // Per-call safety check (protected files, sandbox escalation, local network addresses): asks even in Auto mode or
  // with an allow rule.
  mustAsk?(input: z.infer<S>, context: ToolContext): boolean | Promise<boolean>;
  preview?(input: z.infer<S>, context: ToolContext): Promise<ToolPreview>;
  run(input: z.infer<S>, context: ToolContext): Promise<ToolOutput>;
}

// Keeps the helper's inference while storing tools with different schemas in one array.
export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(tool: AgentTool<S>): AgentTool {
  return tool as unknown as AgentTool;
}

export class ToolError extends Error {}

export const MAX_OUTPUT_CHARS = 30_000;

// Keeps the start and end of long output, where errors and results usually are.
export function truncateOutput(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  const omitted = text.length - limit;
  return `${text.slice(0, half)}\n\n… (${omitted} characters omitted) …\n\n${text.slice(-half)}`;
}
