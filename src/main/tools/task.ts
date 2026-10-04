import { z } from 'zod';
import type { ChatEvent, UsageTotals } from '@shared/chat';
import type { Conversation, SerializedConversation, UserInput } from '../llm/types';
import { Agent, SUBAGENT_MAX_TURNS, type AgentOptions } from '../agent/agent';
import { defineTool, ToolError, truncateOutput, type AgentTool, type ToolContext } from './types';

export interface TaskToolOptions {
  // A fresh conversation per subagent run. Callers choose the model; it stays on the chat's provider.
  createConversation: () => Conversation;
  // For finder: a fresh conversation on a cheaper, faster model. Without it, finder uses createConversation.
  createFinderConversation?: () => Conversation;
  // For oracle: the chat's own model and effort. Without it, oracle uses createConversation.
  createOracleConversation?: () => Conversation;
  // The chat's system prompt. The subagent's role (read-only research, search or advice) is added to it.
  system: string;
  // The parent's tool list; only the read-only subset can run in the subagent.
  tools: () => AgentTool[];
  // The chat's own model. A subagent on the same model sends the chat's exact system prompt and tool list, so its
  // requests start with the prefix the chat already cached instead of writing a new one (#77).
  chatModel?: string;
  // Adds the subagent's token usage to the chat totals, so the status bar and cost estimate include delegated work.
  recordUsage?: (usage: UsageTotals) => void;
  // Permission rules for the subagent's own tool calls (rules with context "subagent" apply).
  decidePermission?: AgentOptions['decidePermission'];
}

// An empty conversation on the parent chat's own model and API, for one subagent run. The parent's compaction state
// is not carried over: requests are built from `messages.slice(keepFrom)`, which would drop the subagent's own first
// messages (its question) and send the parent's summary instead.
export function subagentConversation(
  parent: Conversation,
  restore: (saved: SerializedConversation) => Conversation,
): Conversation {
  const { compaction: _compaction, ...saved } = parent.serialize();
  return restore({ ...saved, messages: [] });
}

// load_skill only reads project skill files, and the subagent gets the parent's prompt, which lists the skills.
const READ_ONLY_TOOLS = new Set(['read_file', 'list_directory', 'grep', 'glob', 'search_code', 'load_skill']);

// Shown to a subagent that sees the chat's full tool list (same model, shared prompt cache).
const SHARED_TOOLS_NOTE = `- Your tool list is the main agent's. Only ${[...READ_ONLY_TOOLS].join(', ')} work for you; every other tool returns an error without doing anything.`;

// Stands in for a tool the subagent may not use. Name, description and schema stay byte-identical to the chat's
// tool, so the request keeps the chat's cached prefix; the real tool is never reachable from the subagent.
function readOnlyStandIn(tool: AgentTool): AgentTool {
  return {
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    jsonSchema: tool.jsonSchema,
    strictInput: tool.strictInput,
    requiresApproval: false,
    parallelSafe: true,
    run: async () => {
      throw new ToolError(
        `${tool.name} is not available to a read-only subagent. Use ${[...READ_ONLY_TOOLS].join(', ')}, or answer with what you found.`,
      );
    },
  };
}

const SUBAGENT_PREAMBLE = `You are a read-only research subagent. Another agent delegated one question to you.
- You can only read files, list directories, find files by name, grep and use semantic code search. You cannot edit files, run commands, use the browser or fetch pages, and you have no web access.
- Use only the read-only tools above; if a task needs anything else, you cannot do that, so answer from what you can read.
- Answer the delegated question directly. Your last message, the one with no tool call, is the only thing the other agent receives, so include the paths and line numbers it needs.
- Do not start the work yourself and do not propose a plan for it. Report what you found.`;

const FINDER_PREAMBLE = `You are a fast codebase-search subagent. Another agent asked you where something is.
- Search broadly with glob, grep and search_code, open only what you need to confirm a hit, and stop as soon as you can answer.
- Answer with a short list of paths with line numbers and one line each saying what is there. No long explanations.`;

const ORACLE_PREAMBLE = `You are a senior advisor. Another agent asks you for a second opinion: a diagnosis of a bug, a review of a design or a plan, or advice on a hard decision.
- Read the code you need to be sure, then think carefully before answering.
- Give a clear recommendation first, then the reasons, the risks and what you would check. If you are unsure, say what would settle it.
- You cannot change anything, and you should not write the implementation; advise.`;

// Runs a read-only subagent: a nested agent that can inspect the project (read files, grep, semantic search) but
// cannot change anything, run commands or reach the network. Its answer comes back as the tool result; its
// progress streams into the parent transcript while it works. Read-only scope means no approval cards are needed
// inside the subagent, and no nesting: the task tool is not part of its tool list. Its reads go into its own set,
// so a file it read does not count as read by the parent (the parent still has to read a file before editing it).
export function createTaskTool(options: TaskToolOptions): AgentTool {
  return defineTool({
    name: 'task',
    description:
      'Delegate a research question to a read-only subagent that has its own context window. It can read files, list directories, find files by name, grep and use semantic code search in the current project, but cannot edit files, run commands or use the web. Give it a self-contained question and the paths or symbols to start from; its answer arrives as your tool result. A file it reads does not count as read by you: read it yourself before editing it. Use it for broad surveys (find every caller, summarize a subsystem) so your own context stays small.',
    schema: z.object({
      task: z.string().describe('A self-contained research question, with concrete starting points (paths, symbols).'),
    }),
    requiresApproval: false,
    parallelSafe: true,
    run: async ({ task }, context) => runSubagent(options, task, context),
  });
}

// A faster, cheaper read-only subagent for "where is X" questions.
export function createFinderTool(options: TaskToolOptions): AgentTool {
  return defineTool({
    name: 'finder',
    description:
      'Locate things in the codebase with a fast read-only subagent on a cheaper model: where a function is defined, which files handle a feature, every place that uses a name. Describe what you are looking for in plain words; it answers with paths and line numbers. Use task instead for questions that need explaining or summarizing.',
    schema: z.object({
      query: z.string().describe('What to find, in plain words, with any names you already know.'),
    }),
    requiresApproval: false,
    parallelSafe: true,
    run: async ({ query }, context) =>
      runSubagent(options, query, context, {
        preamble: FINDER_PREAMBLE,
        conversation: options.createFinderConversation ?? options.createConversation,
        label: 'Finder',
      }),
  });
}

// A read-only advisor for hard problems; it reasons on the chat's own model.
export function createOracleTool(options: TaskToolOptions): AgentTool {
  return defineTool({
    name: 'oracle',
    description:
      'Ask a read-only advisor for a second opinion on something hard: why a bug happens, whether a plan or design holds up, which of two approaches is better. It can read the project but cannot change it. Give it the problem, what you already tried and the paths that matter; it answers with a recommendation and reasons. Slower and costlier than task, so use it sparingly.',
    schema: z.object({
      question: z.string().describe('The problem or decision, with what you tried and the relevant paths.'),
    }),
    requiresApproval: false,
    parallelSafe: true,
    run: async ({ question }, context) =>
      runSubagent(options, question, context, {
        preamble: ORACLE_PREAMBLE,
        conversation: options.createOracleConversation ?? options.createConversation,
        label: 'Oracle',
      }),
  });
}

interface SubagentRole {
  preamble: string;
  conversation: () => Conversation;
  label: string;
}

async function runSubagent(
  options: TaskToolOptions,
  task: string,
  context: ToolContext,
  role: SubagentRole = { preamble: SUBAGENT_PREAMBLE, conversation: options.createConversation, label: 'Subagent' },
) {
  let partial = '';
  const conversation = role.conversation();
  // Caches are per model: only a subagent on the chat's model can reuse the chat's cached tools and system prompt.
  // It then gets them unchanged, its role goes into its first message, and the tools it may not use are stand-ins.
  // On another model it keeps the shorter prompt with only the read-only tools.
  const shared = options.chatModel !== undefined && conversation.model === options.chatModel;
  const agent = new Agent({
    conversation,
    system: shared ? options.system : `${role.preamble}\n\n${options.system}`,
    tools: shared
      ? () => options.tools().map((tool) => (READ_ONLY_TOOLS.has(tool.name) ? tool : readOnlyStandIn(tool)))
      : () => options.tools().filter((tool) => READ_ONLY_TOOLS.has(tool.name)),
    // Read-only tools never ask for approval; the subagent cannot escalate. The fallback declines, so even an
    // unexpected approval request cannot turn into a silent side effect.
    approvalMode: () => 'auto' as const,
    decidePermission: options.decidePermission,
    requestApproval: () => Promise.resolve({ approved: false }),
    // Own read set: a file the subagent read is not a file the parent has read, so the read-before-edit guard holds.
    toolContext: (signal, onProgress) => ({ ...context, signal, onProgress, readFiles: new Set() }),
    maxTurns: SUBAGENT_MAX_TURNS,
    emit: (event) => {
      // Interim text (a turn that also called tools) is only progress. The answer is taken from the outcome below.
      // Every turn replaces it, so a final turn without text is not answered with an earlier turn's text.
      if (event.type === 'assistant-end') partial = event.text ?? '';
      forwardProgress(event, context.onProgress);
    },
  });

  const input: UserInput = {
    text: shared ? `${role.preamble}\n${SHARED_TOOLS_NOTE}\n\n# Delegated question\n${task}` : task,
  };
  let outcome: ReturnType<Agent['outcome']>;
  try {
    outcome = (await agent.send(input, context.signal)) ? 'stopped' : agent.outcome();
  } catch (error) {
    if (context.signal.aborted) throw new ToolError('The subagent was stopped.');
    throw new ToolError(`The subagent failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Also after a failure: the turns that did run were billed.
    options.recordUsage?.(agent.totals);
  }
  const usage = agent.totals;
  const usageLine = `(Subagent token usage: ${usage.inputTokens} in / ${usage.outputTokens} out.)`;
  if (outcome === 'answer' && partial.trim()) {
    return {
      content: `${truncateOutput(partial.trim())}\n\n${usageLine}`,
      summary: `${role.label}: ${truncate(task, 60)}`,
    };
  }

  const why = unfinishedReason(outcome);
  const excerpt = partial.trim() ? `\n\nLast text before it stopped:\n${truncateOutput(partial.trim())}` : '';
  return {
    content: `The subagent did not finish: ${why}.${excerpt}\n\n${usageLine}`,
    summary: `${role.label} stopped: ${truncate(task, 60)}`,
    isError: true,
  };
}

function unfinishedReason(outcome: ReturnType<Agent['outcome']>): string {
  switch (outcome) {
    case 'turn-cap':
      return `it reached the ${SUBAGENT_MAX_TURNS}-step limit`;
    case 'context':
      return 'its context window filled up';
    case 'max-tokens':
      return 'its last response was cut off at the output limit';
    case 'refusal':
      return 'the model declined the question';
    case 'stopped':
      return 'it was stopped';
    default:
      return 'it ended without an answer';
  }
}

// The nested events are not transcript items in the parent; the interesting parts stream as progress lines.
function forwardProgress(event: ChatEvent, onProgress: (text: string) => void): void {
  if (event.type === 'tool-end') onProgress(`[${event.status}] ${event.summary}\n`);
  if (event.type === 'assistant-end' && event.text) onProgress(`${truncate(event.text, 500)}\n`);
  if (event.type === 'notice') onProgress(`${event.text}\n`);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
