import type { ToolSpec } from '../llm/types';
import { applyPatchTool } from './apply_patch';
import { browserTool } from './browser';
import { globTool } from './glob';
import { editFileTool, grepTool, listDirectoryTool, readFileTool, writeFileTool } from './files';
import { proposePlanTool } from './plan';
import { commandOutputTool, runCommandTool } from './shell';
import { loadSkillTool } from './skills';
import type { AgentTool, ToolContext } from './types';
import { fetchUrlTool, webSearchTool } from './web';

const CORE_TOOLS: AgentTool[] = [
  readFileTool,
  listDirectoryTool,
  grepTool,
  globTool,
  editFileTool,
  writeFileTool,
  applyPatchTool,
  runCommandTool,
  commandOutputTool,
  fetchUrlTool,
];

// Tools offered to the model depend on what is configured, so it never calls one that cannot work. propose_plan is
// the exception: it is always offered, and the user message says whether plan mode is on, so turning plan mode on or
// off never changes a chat's tool list (and with it the cached prompt prefix).
export function availableTools(
  context: Pick<ToolContext, 'browser' | 'codeSearch' | 'webSearch'>,
  extra: AgentTool[] = [],
  { skills = false }: { skills?: boolean } = {},
): AgentTool[] {
  const extras = [...extra].sort((a, b) => a.name.localeCompare(b.name));
  return [
    ...CORE_TOOLS,
    ...(context.webSearch ? [webSearchTool] : []),
    ...(context.browser ? [browserTool] : []),
    proposePlanTool,
    ...(skills ? [loadSkillTool] : []),
    ...extras,
  ];
}

export function toToolSpecs(tools: AgentTool[]): ToolSpec[] {
  return tools.map(({ name, description, schema, jsonSchema, strictInput }) => ({
    name,
    description,
    schema,
    jsonSchema,
    strictInput,
  }));
}
