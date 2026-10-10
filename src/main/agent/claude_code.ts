import { randomUUID } from 'node:crypto';
import type { Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalDecision, ChatEvent, UsageTotals } from '@shared/chat';
import { claudeCapabilities, claudeCodeModelId, type Effort } from '@shared/models';
import type { ApprovalMode } from '@shared/settings';
import type { CompactionPlan, Conversation, SerializedConversation, TurnResult, UserInput } from '../llm/types';
import { failureSummary, RESUME_INSTRUCTION } from './agent';
import { describeClaudeCodeTool, toolResultText } from './claude_code_tools';
import type { ChatAgent, ChatAgentHooks } from './session';

// Chats on a "claude-code/…" model run in Claude Code, through the Claude Agent SDK, instead of Patch's own agent
// loop. Claude Code runs the loop, its own tools (Read, Edit, Bash, …), CLAUDE.md, settings and compaction; Patch
// starts it in the project folder, shows what it does as the usual transcript events, and answers its permission
// prompts with approval cards. Each message is one query() that resumes the chat's Claude Code session.

const NOT_A_MODEL_CONVERSATION = 'A Claude Code chat is run by Claude Code, not sent to a model by Patch.';

// The chat's state on Patch's side: which model Claude Code uses and the Claude Code session to resume. Claude Code
// keeps the history itself (~/.claude/projects), so nothing else is stored.
export type SessionUsage = NonNullable<SerializedConversation['sessionUsage']>;

export class ClaudeCodeConversation implements Conversation {
  readonly provider = 'anthropic' as const;

  constructor(
    readonly model: string,
    public sessionId: string | null = null,
    public sessionUsage: SessionUsage | null = null,
  ) {}

  addUserMessage(): void {
    throw new Error(NOT_A_MODEL_CONVERSATION);
  }

  addToolResults(): void {
    throw new Error(NOT_A_MODEL_CONVERSATION);
  }

  discardLastUserMessage(): void {}

  runTurn(): Promise<TurnResult> {
    return Promise.reject(new Error(NOT_A_MODEL_CONVERSATION));
  }

  serialize(): SerializedConversation {
    return {
      provider: this.provider,
      model: this.model,
      messages: [],
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.sessionUsage ? { sessionUsage: { ...this.sessionUsage } } : {}),
    };
  }

  // Claude Code compacts its own history (see ClaudeCodeAgent.compact).
  planCompaction(): CompactionPlan | null {
    return null;
  }

  applyCompaction(): void {
    throw new Error(NOT_A_MODEL_CONVERSATION);
  }

  hasPendingToolCalls(): boolean {
    return false;
  }
}

export type QueryFunction = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export interface ClaudeCodeLaunch {
  // The Claude Code program (see findClaudeCode).
  executable: string;
  env: Record<string, string | undefined>;
}

export interface ClaudeCodeAgentOptions extends ChatAgentHooks {
  conversation: ClaudeCodeConversation;
  // The project folder Claude Code works in.
  cwd: string;
  // Added to Claude Code's own system prompt: the project's instructions in Patch and an AGENTS.md (Claude Code reads
  // CLAUDE.md itself).
  appendSystemPrompt: string;
  approvalMode: () => ApprovalMode;
  planMode: () => boolean;
  effort: () => Effort;
  // Where Claude Code is and the environment to start it with. Throws when it cannot be started (not installed).
  launch: () => ClaudeCodeLaunch;
  // Defaults to the SDK's query(); tests pass a fake.
  query?: QueryFunction;
}

// Loaded on first use: the SDK is only needed once a Claude Code chat runs.
async function sdkQuery(): Promise<QueryFunction> {
  return (await import('@anthropic-ai/claude-agent-sdk')).query as QueryFunction;
}

// Claude Code's session file is gone (deleted, or the chat was copied from another computer).
const MISSING_SESSION = /No conversation found with session ID/i;

export class ClaudeCodeAgent implements ChatAgent {
  readonly handlesPlanMode = true;
  private usage: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  constructor(private readonly options: ClaudeCodeAgentOptions) {}

  get totals(): UsageTotals {
    return { ...this.usage };
  }

  set totals(value: UsageTotals) {
    this.usage = { ...value, cacheWriteTokens: value.cacheWriteTokens ?? 0 };
  }

  forgetContextSize(): void {
    delete this.usage.contextTokens;
    this.options.emit({ type: 'usage', totals: this.totals });
  }

  async send(input: UserInput, signal: AbortSignal): Promise<boolean> {
    const content: Exclude<SDKUserMessage['message']['content'], string> = [
      ...(input.images ?? []).map((image) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: image.mediaType, data: image.base64 },
      })),
      { type: 'text' as const, text: input.text },
    ];
    return this.run(content, signal);
  }

  async resume(signal: AbortSignal, note = ''): Promise<boolean> {
    return this.run([{ type: 'text', text: note ? `${note}\n\n${RESUME_INSTRUCTION}` : RESUME_INSTRUCTION }], signal);
  }

  // Claude Code's /compact: it summarizes its own history. A stop leaves the chat as it was, with nothing to resume.
  async compact(signal: AbortSignal): Promise<void> {
    if (!this.options.conversation.sessionId) {
      this.options.emit({ type: 'notice', id: randomUUID(), text: 'There is nothing to compact yet.' });
      return;
    }
    try {
      await this.run([{ type: 'text', text: '/compact' }], signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      this.options.emit({ type: 'notice', id: randomUUID(), text: 'Compacting stopped.' });
    }
  }

  private async run(content: Exclude<SDKUserMessage['message']['content'], string>, signal: AbortSignal) {
    const { conversation } = this.options;
    const launch = this.options.launch();
    const query = this.options.query ?? (await sdkQuery());
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    const turn = new TurnView(this.options, signal);
    const model = claudeCodeModelId(conversation.model);
    // Thinking is shown as it streams; models without adaptive thinking get Claude Code's default.
    const adaptive = model === undefined || claudeCapabilities(model).adaptiveThinking;
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
    };
    const q = query({
      prompt: (async function* () {
        yield message;
      })(),
      options: {
        abortController: abort,
        cwd: this.options.cwd,
        ...(model ? { model } : {}),
        ...(adaptive ? { thinking: { type: 'adaptive', display: 'summarized' }, effort: this.options.effort() } : {}),
        ...(conversation.sessionId ? { resume: conversation.sessionId } : {}),
        // Plan mode is Claude Code's own: it only reads until it leaves plan mode with ExitPlanMode, which asks.
        permissionMode: this.options.planMode() ? 'plan' : 'default',
        canUseTool: (name, input, details) => turn.canUseTool(name, input, details),
        // Patch has no UI for Claude Code's multiple-choice questions; Claude Code asks in its answer instead.
        disallowedTools: ['AskUserQuestion'],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          ...(this.options.appendSystemPrompt ? { append: this.options.appendSystemPrompt } : {}),
        },
        // The user's and the project's Claude Code settings, CLAUDE.md files and MCP servers, as in a terminal.
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        pathToClaudeCodeExecutable: launch.executable,
        env: launch.env,
      },
    });

    let failure: string | null = null;
    try {
      for await (const event of q) {
        if (event.type === 'system' && event.subtype === 'init' && event.session_id !== conversation.sessionId) {
          conversation.sessionId = event.session_id;
          this.options.onCheckpoint();
        }
        if (event.type === 'result') {
          this.addUsage(event, turn.contextTokens, turn.takeRequests());
          if (event.subtype !== 'success') failure = event.errors.join('\n') || 'Claude Code stopped with an error.';
          else if (event.is_error) failure = event.result || 'Claude Code stopped with an error.';
        }
        turn.handle(event);
      }
    } catch (error) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
      turn.close();
    }
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (failure && MISSING_SESSION.test(failure) && conversation.sessionId) {
      conversation.sessionId = null;
      this.options.onCheckpoint();
      throw new Error(
        'Claude Code no longer has this chat’s session (it may have been deleted). Your next message starts a new Claude Code session without the earlier history.',
      );
    }
    if (failure) throw new Error(failure);
    return false;
  }

  // Adds the tokens of every model the session used (subagents and Claude Code's own small-model calls too). A result
  // reports the session's totals so far, also across resumed runs, so what they grew by since the last report is
  // added. Totals that went down (Claude Code started counting again) count as new.
  private addUsage(result: Extract<SDKMessage, { type: 'result' }>, contextTokens: number | null, requests: number) {
    const { conversation } = this.options;
    const now: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const model of Object.values(result.modelUsage ?? {})) {
      now.inputTokens += model.inputTokens;
      now.outputTokens += model.outputTokens;
      now.cacheReadTokens += model.cacheReadInputTokens;
      now.cacheWriteTokens += model.cacheCreationInputTokens;
    }
    const before = conversation.sessionUsage;
    const grew = (key: keyof SessionUsage) => (before && now[key] >= before[key] ? now[key] - before[key] : now[key]);
    conversation.sessionUsage = now;
    const usage = this.usage;
    usage.inputTokens += grew('inputTokens');
    usage.outputTokens += grew('outputTokens');
    usage.cacheReadTokens += grew('cacheReadTokens');
    usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + grew('cacheWriteTokens');
    usage.requests = (usage.requests ?? 0) + requests;
    if (contextTokens !== null) usage.contextTokens = contextTokens;
    this.options.emit({ type: 'usage', totals: this.totals });
  }
}

type CanUseToolDetails = Parameters<NonNullable<Options['canUseTool']>>[2];

// The transcript side of one query: turns Claude Code's messages into chat events and its permission prompts into
// approval cards.
class TurnView {
  // The assistant bubble being streamed, if any.
  private bubble: string | null = null;
  // Tool cards already shown, and the ones the user declined (their error result is shown as declined).
  private readonly shown = new Map<string, { name: string; input: Record<string, unknown> }>();
  private readonly declined = new Set<string>();
  private readonly startedAt = new Map<string, number>();
  private readonly requestIds = new Set<string>();
  // Ids already counted, so an assistant message split over several SDK messages counts once.
  private readonly countedIds = new Set<string>();
  // Agent (subagent) cards: their subagent's tool calls are added to them as progress, also after the card finished
  // (a background subagent keeps working after its call returned).
  private readonly agentCards = new Set<string>();
  contextTokens: number | null = null;

  constructor(
    private readonly options: ClaudeCodeAgentOptions,
    private readonly signal: AbortSignal,
  ) {}

  // Model requests seen since the last call (one per assistant message id, subagents' too).
  takeRequests(): number {
    const count = this.requestIds.size;
    this.requestIds.clear();
    return count;
  }

  private emit(event: ChatEvent): void {
    this.options.emit(event);
  }

  handle(message: SDKMessage): void {
    switch (message.type) {
      case 'stream_event':
        if (message.parent_tool_use_id === null) this.stream(message.event);
        return;
      case 'assistant':
        this.countRequest(message.message.id);
        if (message.parent_tool_use_id === null) this.assistant(message.message);
        else this.subagentStep(message.parent_tool_use_id, message.message.content);
        return;
      case 'user':
        if (message.parent_tool_use_id === null && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type === 'tool_result')
              this.finishTool(block.tool_use_id, toolResultText(block.content), block.is_error);
          }
        }
        return;
      case 'system':
        if (message.subtype === 'api_retry') {
          const status = message.error_status ? ` (${message.error_status})` : '';
          this.emit({
            type: 'notice',
            id: randomUUID(),
            text: `Claude Code request failed${status}. Retrying in ${Math.ceil(message.retry_delay_ms / 1000)} s (retry ${message.attempt} of ${message.max_retries})…`,
          });
        } else if (message.subtype === 'compact_boundary') {
          this.emit({
            type: 'notice',
            id: randomUUID(),
            text: `Claude Code compacted the conversation (${message.compact_metadata.pre_tokens.toLocaleString('en-US')} tokens before).`,
          });
          this.contextTokens = message.compact_metadata.post_tokens ?? null;
        }
        return;
      default:
        return;
    }
  }

  private stream(event: Extract<SDKMessage, { type: 'stream_event' }>['event']): void {
    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'text' || event.content_block.type === 'thinking') this.openBubble();
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta')
        this.emit({ type: 'assistant-delta', id: this.openBubble(), text: event.delta.text });
      else if (event.delta.type === 'thinking_delta')
        this.emit({ type: 'thinking-delta', id: this.openBubble(), text: event.delta.thinking });
    }
  }

  private openBubble(): string {
    if (!this.bubble) {
      this.bubble = randomUUID();
      this.emit({ type: 'assistant-start', id: this.bubble });
    }
    return this.bubble;
  }

  private closeBubble(text?: string): void {
    if (!this.bubble) return;
    this.emit({ type: 'assistant-end', id: this.bubble, ...(text !== undefined ? { text } : {}) });
    this.bubble = null;
  }

  // A complete assistant message. Claude Code sends one per content block; text and thinking have already streamed.
  private countRequest(id: string | undefined): void {
    if (!id || this.countedIds.has(id)) return;
    this.countedIds.add(id);
    this.requestIds.add(id);
  }

  private assistant(message: Extract<SDKMessage, { type: 'assistant' }>['message']): void {
    const usage = message.usage;
    if (usage) {
      this.contextTokens =
        (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    }
    for (const block of message.content) {
      if (block.type === 'text') {
        // Text that did not stream (no partial messages, e.g. an error Claude Code reports as its answer).
        if (!this.bubble) this.openBubble();
        this.closeBubble(block.text);
      } else if (block.type === 'tool_use') {
        this.closeBubble();
        this.showTool(block.id, block.name, (block.input ?? {}) as Record<string, unknown>, false);
      }
    }
  }

  // A subagent's tool call goes on its Agent card as a line of progress.
  private subagentStep(parentId: string, content: Extract<SDKMessage, { type: 'assistant' }>['message']['content']) {
    if (!this.agentCards.has(parentId)) return;
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const view = describeClaudeCodeTool(block.name, (block.input ?? {}) as Record<string, unknown>, this.options.cwd);
      this.emit({ type: 'tool-progress', id: parentId, text: `${view.preview.command ?? view.preview.title}\n` });
    }
  }

  private showTool(id: string, name: string, input: Record<string, unknown>, awaitingApproval: boolean): void {
    if (this.shown.has(id) && !awaitingApproval) return;
    this.shown.set(id, { name, input });
    if (name === 'Agent' || name === 'Task') this.agentCards.add(id);
    if (!this.startedAt.has(id)) this.startedAt.set(id, Date.now());
    const view = describeClaudeCodeTool(name, input, this.options.cwd);
    this.emit({ type: 'tool-start', id, name, preview: view.preview, awaitingApproval });
  }

  private finishTool(id: string, output: string, isError: boolean | undefined): void {
    const call = this.shown.get(id);
    if (!call) return;
    this.shown.delete(id);
    const view = describeClaudeCodeTool(call.name, call.input, this.options.cwd);
    const started = this.startedAt.get(id);
    const durationMs = started === undefined ? undefined : Date.now() - started;
    if (this.declined.has(id)) {
      this.emit({ type: 'tool-end', id, status: 'declined', summary: 'Declined' });
    } else if (isError) {
      this.emit({
        type: 'tool-end',
        id,
        status: 'error',
        summary: failureSummary(view.preview.title, output),
        output,
        path: view.path,
        durationMs,
      });
    } else {
      this.emit({
        type: 'tool-end',
        id,
        status: 'done',
        summary: view.preview.title,
        ...(view.showsOutput ? { output } : {}),
        path: view.path,
        durationMs,
      });
    }
  }

  // Claude Code asks before a call its own rules do not already allow. In Auto mode Patch allows it, except MCP tools
  // and leaving plan mode, which always ask (as in Patch's own agent). Otherwise the call's card asks the user.
  async canUseTool(
    name: string,
    input: Record<string, unknown>,
    details: CanUseToolDetails,
  ): Promise<PermissionResult> {
    const id = details.toolUseID;
    const alwaysAsks = name.startsWith('mcp__') || name === 'ExitPlanMode';
    if (this.options.approvalMode() === 'auto' && !alwaysAsks) {
      this.showTool(id, name, input, false);
      return { behavior: 'allow', updatedInput: input };
    }
    this.showTool(id, name, input, true);
    const decision: ApprovalDecision = await this.options.requestApproval(id, details.signal ?? this.signal);
    if (decision.approved) {
      this.emit({ type: 'tool-running', id });
      // Approving the plan takes Claude Code out of plan mode, as Claude Code suggests; other suggestions ("always
      // allow" rules written to the project's settings) are not applied.
      const leavePlan = name === 'ExitPlanMode' ? (details.suggestions ?? []).filter((s) => s.type === 'setMode') : [];
      return { behavior: 'allow', updatedInput: input, ...(leavePlan.length ? { updatedPermissions: leavePlan } : {}) };
    }
    this.declined.add(id);
    const feedback = decision.feedback?.trim();
    return feedback
      ? { behavior: 'deny', message: `The user declined this action and said: ${feedback}` }
      : { behavior: 'deny', message: 'The user declined this action. Wait for further instructions.', interrupt: true };
  }

  // The query ended: an answer still streaming is complete, and a card whose result never came (the run was stopped,
  // or Claude Code ended the turn after a decline) is closed.
  close(): void {
    this.closeBubble();
    for (const [id, call] of this.shown) {
      if (this.declined.has(id)) {
        this.emit({ type: 'tool-end', id, status: 'declined', summary: 'Declined' });
      } else {
        const title = describeClaudeCodeTool(call.name, call.input, this.options.cwd).preview.title;
        this.emit({ type: 'tool-end', id, status: 'error', summary: `${title} (stopped)` });
      }
    }
    this.shown.clear();
  }
}
