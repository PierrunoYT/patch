import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  applyChatEvent,
  type ApprovalDecision,
  type ChatEvent,
  type ChatSnapshot,
  type TranscriptItem,
  type UsageTotals,
  type UserMessage,
} from '@shared/chat';
import type { UndoResult } from '@shared/ipc';
import type { ApprovalMode } from '@shared/settings';
import type { CompletionClient, Conversation, SerializedConversation } from '../llm/types';
import { PLAN_MODE_OFF_NOTE, PLAN_MODE_ON_NOTE } from '../tools/plan';
import type { AgentTool, EditUndo, ToolContext } from '../tools/types';
import { appLog } from '../app_log';
import { compactionPrompt } from '../llm/compaction';
import { Agent, type AgentOptions, type DroppedFieldError } from './agent';

export interface SavedChat {
  version: 1;
  id: string;
  title: string;
  projectPath: string | null;
  createdAt: string;
  updatedAt: string;
  system: string;
  transcript: TranscriptItem[];
  usage: UsageTotals;
  conversation: SerializedConversation;
  readFiles: string[];
  pendingNotes?: string[];
  // The last message sent to the model said plan mode is on, so turning it off is told with the next one.
  planModeTold?: boolean;
  agentFile?: string | null;
  resumable?: boolean;
  // False for custom OpenAI-compatible endpoints, whose prices are unknown. Missing in chats saved by older versions.
  officialPricing?: boolean;
}

// The provider keeps a cache entry 5 minutes after the request that last read or wrote it started; a keep-alive a
// minute early leaves room for a slow network. KEEP_ALIVE_MAX of them cover about an hour of idle time.
const KEEP_ALIVE_INTERVAL_MS = 4 * 60_000;
const KEEP_ALIVE_MAX = 14;

export interface ChatSessionOptions {
  id?: string;
  title?: string;
  createdAt?: string;
  projectPath: string | null;
  conversation: Conversation;
  officialPricing?: boolean;
  system: string;
  agentFile: string | null;
  tools: () => AgentTool[];
  transcript?: TranscriptItem[];
  usage?: UsageTotals;
  readFiles?: string[];
  pendingNotes?: string[];
  resumable?: boolean;
  planModeTold?: boolean;
  approvalMode: () => ApprovalMode;
  // Settings → Plan mode. The model is told with each user message (see planNote); the tool list never changes.
  planMode?: () => boolean;
  isPreApproved?: (toolName: string, input: unknown) => boolean;
  decidePermission?: AgentOptions['decidePermission'];
  toolContext: (base: Pick<ToolContext, 'signal' | 'readFiles' | 'onProgress'>) => ToolContext;
  smallModel: (conversation: Conversation) => CompletionClient | null;
  onDroppedFields?: (error: DroppedFieldError) => void;
  // Keeps what is needed to undo an approved edit. Throwing means the edit cannot be undone.
  onEditApplied?: (toolId: string, edit: EditUndo) => void;
  onEvent: (event: ChatEvent) => void;
  // immediate is true when a task just finished, so the chat can be saved right away.
  // checkpoint is true for a crash-resume checkpoint after a tool batch: only the chat file needs writing.
  onChange: (immediate: boolean, checkpoint?: boolean) => void;
  // Settings → Prompt cache: keep the provider's prompt cache alive while the chat is idle.
  keepCacheWarm?: () => boolean;
}

// One chat: its model conversation, transcript, pending approvals and the files read in it.
export class ChatSession {
  readonly id: string;
  readonly createdAt: string;
  title: string;
  private transcript: TranscriptItem[];
  private readonly readFiles: Set<string>;
  private readonly agent: Agent;
  private readonly approvals = new Map<string, (decision: ApprovalDecision) => void>();
  private controller: AbortController | null = null;
  private titleController: AbortController | null = null;
  private disposed = false;
  private resumable: boolean;
  // True from the start of a send or resume until it ends. Saved as resumable, so a chat whose app crashed mid-run
  // (during a model request, or before the tool calls of the last answer were saved) offers Resume when reopened.
  private running = false;
  private stopRequested = false;
  // Keep-alive requests while the chat is idle (Settings → Prompt cache). See scheduleKeepAlive.
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private keepAliveController: AbortController | null = null;
  private keepAlivesLeft = 0;
  private updatedAt: string;
  // Things that happened to the project outside the conversation, for the model's next message.
  private readonly notes: string[];
  private planModeTold: boolean;

  constructor(private readonly options: ChatSessionOptions) {
    this.id = options.id ?? randomUUID();
    this.createdAt = options.createdAt ?? new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.title = options.title ?? 'New chat';
    this.transcript = options.transcript ? closeStaleRows(options.transcript) : [];
    this.readFiles = new Set(options.readFiles ?? []);
    this.notes = [...(options.pendingNotes ?? [])];
    this.planModeTold = options.planModeTold ?? false;
    // A chat saved mid-run (see `running`), or whose saved history ends in unanswered tool calls, was interrupted by a
    // crash; it resumes like a user-stopped run.
    this.resumable = (options.resumable ?? false) || options.conversation.hasPendingToolCalls();
    this.agent = new Agent({
      conversation: options.conversation,
      system: options.system,
      tools: options.tools,
      approvalMode: options.approvalMode,
      planMode: () => options.planMode?.() ?? false,
      isPreApproved: options.isPreApproved,
      decidePermission: options.decidePermission,
      requestApproval: (id, signal) => this.waitForApproval(id, signal),
      toolContext: (signal, onProgress) => options.toolContext({ signal, onProgress, readFiles: this.readFiles }),
      onCheckpoint: () => this.options.onChange(true, true),
      emit: (event) => this.emit(event),
      onDroppedFields: options.onDroppedFields,
      onEditApplied: options.onEditApplied,
    });
    if (options.usage) {
      const usage = { ...options.usage };
      // Older OpenAI totals included cache reads in input. Normalize once when loading the old shape.
      if (options.conversation.provider === 'openai' && usage.cacheWriteTokens === undefined) {
        usage.inputTokens = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
      }
      this.agent.totals = usage;
    }
  }

  get busy(): boolean {
    return this.controller !== null;
  }

  get isEmpty(): boolean {
    return this.transcript.length === 0;
  }

  // Adds token usage that happened outside the chat's own turns (a subagent's requests) to the totals the status bar
  // and the cost estimate show. The context size stays the chat's own: a subagent's prompt does not fill this chat.
  recordUsage(usage: UsageTotals): void {
    const totals = this.agent.totals;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheWriteTokens = (totals.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    totals.requests = (totals.requests ?? 0) + (usage.requests ?? 0);
    if (usage.longContext) {
      const long = totals.longContext ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      long.inputTokens += usage.longContext.inputTokens;
      long.outputTokens += usage.longContext.outputTokens;
      long.cacheReadTokens += usage.longContext.cacheReadTokens;
      long.cacheWriteTokens += usage.longContext.cacheWriteTokens;
      totals.longContext = long;
    }
    this.agent.totals = totals;
    this.emit({ type: 'usage', totals: this.agent.totals });
  }

  snapshot(): ChatSnapshot {
    return {
      id: this.id,
      title: this.title,
      projectPath: this.options.projectPath,
      model: this.options.conversation.model,
      officialPricing: this.options.officialPricing ?? this.options.conversation.provider === 'anthropic',
      transcript: this.transcript,
      busy: this.busy,
      resumable: this.resumable,
      usage: this.agent.totals,
      agentFile: this.options.agentFile,
    };
  }

  async send(message: UserMessage): Promise<void> {
    if (this.busy) throw new Error('The assistant is still working. Stop it or wait for it to finish.');
    const text = message.text.trim();
    if (!text && !message.images?.length) return;

    const isFirst = !this.transcript.some((item) => item.kind === 'user');
    this.setResumable(false);
    this.emit({ type: 'user', id: randomUUID(), text, imageCount: message.images?.length ?? 0 });
    if (isFirst) void this.generateTitle(text);

    // What the user did to the project since the last message (undone edits) and whether plan mode is on are told to
    // the model with this one.
    const note = this.takeNotes();
    const modelText = `${note}${text || '(see attached images)'}`;
    return this.run((signal) => this.agent.send({ text: modelText, images: message.images }, signal));
  }

  async resume(): Promise<void> {
    if (this.busy) throw new Error('The assistant is still working. Stop it or wait for it to finish.');
    if (!this.resumable) throw new Error('There is no stopped run to resume.');
    this.setResumable(false);
    const note = this.takeNotes().trim();
    return this.run((signal) => this.agent.resume(signal, note));
  }

  // The edit of a tool card was undone by the user (the file has already been put back). The model is told with the
  // next message, and must read the file again before it edits it: what it last read is no longer what is on disk.
  editUndone(toolId: string, result: UndoResult, absolutePath: string): void {
    this.readFiles.delete(absolutePath);
    this.notes.push(
      result.action === 'deleted'
        ? `The user undid your creation of ${result.path}: the file was deleted.`
        : `The user undid your edit to ${result.path}: the file is back to how it was before that edit. Read it again before editing it.`,
    );
    this.emit({ type: 'tool-undone', id: toolId });
  }

  private takeNotes(): string {
    const notes = [...this.notes, ...this.planNote()];
    this.notes.length = 0;
    return notes.length > 0 ? `[Note from the app: ${notes.join(' ')}]\n\n` : '';
  }

  // Plan mode reaches the model as message text, not as a change to the tool list, so toggling it keeps the prompt
  // cache. The note is repeated on every message while plan mode is on (a compacted history may no longer hold an
  // earlier one); turning it off is said once.
  private planNote(): string[] {
    const on = this.options.planMode?.() ?? false;
    const wasOn = this.planModeTold;
    this.planModeTold = on;
    if (on) return [PLAN_MODE_ON_NOTE];
    return wasOn ? [PLAN_MODE_OFF_NOTE] : [];
  }

  private async run(work: (signal: AbortSignal) => Promise<boolean>): Promise<void> {
    this.stopKeepAlive();
    const controller = new AbortController();
    this.controller = controller;
    this.stopRequested = false;
    this.running = true;
    let interrupted = false;
    this.emit({ type: 'busy', busy: true });
    try {
      interrupted = await work(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        interrupted = true;
        this.emit({ type: 'notice', id: randomUUID(), text: 'Stopped.' });
      } else {
        this.emit({ type: 'error', id: randomUUID(), text: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      // A stop that arrives as the run finishes on its own leaves nothing to resume.
      const stopped = this.stopRequested && interrupted;
      this.controller = null;
      this.running = false;
      this.rejectPendingApprovals();
      if (stopped) this.setResumable(true);
      this.emit({ type: 'busy', busy: false });
      this.keepAlivesLeft = KEEP_ALIVE_MAX;
      this.scheduleKeepAlive();
    }
  }

  // While the chat is idle, re-send its last request (no output) shortly before the provider's 5-minute cache entry
  // expires, so a reply after a pause reads the cache instead of writing the whole chat again. At most KEEP_ALIVE_MAX
  // times after an answer (about an hour). Stops for good on the next run, compaction, a failure or dispose.
  private scheduleKeepAlive(): void {
    const conversation = this.options.conversation;
    if (this.disposed || this.busy || this.keepAlivesLeft <= 0) return;
    if (!this.options.keepCacheWarm?.() || !conversation.keepCacheWarm || !conversation.lastRequestStartedAt) return;
    const due = conversation.lastRequestStartedAt + KEEP_ALIVE_INTERVAL_MS - Date.now();
    this.keepAliveTimer = setTimeout(() => void this.keepAlive(), Math.max(0, due));
    this.keepAliveTimer.unref?.();
  }

  private async keepAlive(): Promise<void> {
    this.keepAliveTimer = null;
    if (this.disposed || this.busy || !this.options.keepCacheWarm?.()) return;
    this.keepAlivesLeft--;
    const controller = new AbortController();
    this.keepAliveController = controller;
    try {
      const usage = await this.options.conversation.keepCacheWarm?.(controller.signal);
      if (!usage || controller.signal.aborted) return;
      this.recordUsage({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        requests: 1,
      });
      this.options.onChange(false);
      this.scheduleKeepAlive();
    } catch {
      // No retries: a failed keep-alive only means the next reply may write the cache again.
      if (!controller.signal.aborted)
        appLog.warn('chat', 'A prompt cache keep-alive failed; stopping them for this chat.');
    } finally {
      if (this.keepAliveController === controller) this.keepAliveController = null;
    }
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = null;
    this.keepAliveController?.abort();
    this.keepAliveController = null;
    this.keepAlivesLeft = 0;
  }

  // Replaces the older turns, in what is sent to the model, by a summary written by the small model. The stored
  // history is not changed. Nothing is done when there is too little history to be worth it.
  async compact(): Promise<void> {
    if (this.busy) throw new Error('The assistant is still working. Stop it or wait for it to finish.');
    // What is sent changes, so the entry being kept warm is no longer the one the next request needs.
    this.stopKeepAlive();
    const { conversation } = this.options;
    const plan = conversation.planCompaction();
    if (!plan) {
      this.emit({ type: 'notice', id: randomUUID(), text: 'There is not enough older history to compact yet.' });
      return;
    }
    const summarizer = this.options.smallModel(this.options.conversation);
    if (!summarizer) throw new Error('Compacting needs an API key for the summarizing model. Add one in Settings.');

    const controller = new AbortController();
    this.controller = controller;
    this.stopRequested = false;
    this.emit({ type: 'busy', busy: true });
    try {
      const { summary } = await summarizer.complete(
        compactionPrompt(plan.text),
        z.object({ summary: z.string() }),
        controller.signal,
      );
      // A stop that came in while the answer was being written wins: nothing is applied.
      if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError');
      conversation.applyCompaction(summary, plan.keepFrom);
      this.agent.forgetContextSize();
      this.emit({
        type: 'notice',
        id: randomUUID(),
        text: `Compacted ${plan.messages} earlier messages into a summary. The next request re-reads the whole prompt once; the full history stays saved with this chat.`,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        this.emit({ type: 'notice', id: randomUUID(), text: 'Compacting stopped. The chat is unchanged.' });
      } else {
        this.emit({
          type: 'error',
          id: randomUUID(),
          text: `Compacting failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } finally {
      this.controller = null;
      this.emit({ type: 'busy', busy: false });
    }
  }

  stop(): void {
    if (!this.controller) return;
    this.stopRequested = true;
    this.controller?.abort();
    this.rejectPendingApprovals();
  }

  dispose(): void {
    this.disposed = true;
    this.stopKeepAlive();
    this.titleController?.abort();
    this.stop();
  }

  decide(approvalId: string, decision: ApprovalDecision): void {
    this.approvals.get(approvalId)?.(decision);
  }

  serialize(): SavedChat {
    return {
      version: 1,
      id: this.id,
      title: this.title,
      projectPath: this.options.projectPath,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      system: this.options.system,
      transcript: this.transcript,
      usage: this.agent.totals,
      conversation: this.options.conversation.serialize(),
      readFiles: [...this.readFiles],
      pendingNotes: [...this.notes],
      ...(this.planModeTold ? { planModeTold: true } : {}),
      agentFile: this.options.agentFile,
      resumable: this.resumable || this.running,
      officialPricing: this.options.officialPricing ?? this.options.conversation.provider === 'anthropic',
    };
  }

  private emit(event: ChatEvent): void {
    if (this.disposed) return;
    this.transcript = applyChatEvent(this.transcript, event);
    this.updatedAt = new Date().toISOString();
    this.options.onEvent(event);
    if (event.type !== 'assistant-delta' && event.type !== 'thinking-delta' && event.type !== 'tool-progress') {
      this.options.onChange(event.type === 'busy' && !event.busy);
    }
  }

  private setResumable(resumable: boolean): void {
    if (this.resumable === resumable) return;
    this.resumable = resumable;
    this.emit({ type: 'resumable', resumable });
  }

  private waitForApproval(id: string, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) return Promise.resolve({ approved: false });
    return new Promise((resolve) => {
      this.approvals.set(id, (decision) => {
        this.approvals.delete(id);
        resolve(decision);
      });
    });
  }

  private rejectPendingApprovals(): void {
    for (const resolve of [...this.approvals.values()]) resolve({ approved: false });
  }

  private async generateTitle(firstMessage: string): Promise<void> {
    const fallback =
      firstMessage.split(/\s+/).slice(0, 6).join(' ') + (firstMessage.split(/\s+/).length > 6 ? '…' : '');
    let title = fallback || 'New chat';
    const model = this.options.smallModel(this.options.conversation);
    if (model) {
      try {
        const controller = new AbortController();
        this.titleController = controller;
        const result = await model.complete(
          `Write a short title (2 to 5 words, no quotes or punctuation at the end) for a coding chat that starts with this request:\n\n${firstMessage.slice(0, 2000)}`,
          z.object({ title: z.string() }),
          controller.signal,
        );
        title = result.title.trim().slice(0, 80) || title;
      } catch {
        // Keep the fallback title; a missing title is not worth an error in the chat.
      } finally {
        this.titleController = null;
      }
    }
    if (this.disposed) return;
    this.title = title;
    this.emit({ type: 'title', title });
  }
}

// A chat saved while a crash interrupted it can hold tool rows that never finished (the crash happened before
// their end event was saved). No session is running while a chat is being loaded, so such rows are stale; mark
// them failed so they do not render as running forever.
function closeStaleRows(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((item) => {
    // A crash while an answer streams saves the row still marked streaming; nothing will finish it on load.
    if (item.kind === 'assistant' && item.streaming) return { ...item, streaming: false };
    if (item.kind !== 'tool' || (item.status !== 'running' && item.status !== 'awaiting-approval')) return item;
    return {
      ...item,
      status: 'error' as const,
      summary: `${item.name} was interrupted`,
      output: item.output ?? 'Interrupted by an app restart before this action finished.',
    };
  });
}
