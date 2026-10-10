import { platform } from 'node:os';
import type { ApprovalDecision, ChatEvent, ChatSnapshot, UserMessage } from '@shared/chat';
import type { UndoResult } from '@shared/ipc';
import type { UsageTotals } from '@shared/chat';
import {
  acceptsImages,
  effortForSubagent,
  imagesNotSupportedMessage,
  SMALL_MODELS,
  subagentModelId,
} from '@shared/models';
import { mergeAllowLists } from '@shared/project';
import { loadAgentFile } from './agent/agent_file';
import { isCommandAllowed } from './agent/allowed_commands';
import { isNetworkUrlAllowed } from './agent/allowed_network_hosts';
import { decideCallPermission, type PathView } from './agent/permissions';
import type { DroppedFieldError } from './agent/agent';
import { buildSystemPrompt, promptListsSkills } from './agent/system_prompt';
import { ChatSession, type SavedChat } from './agent/session';
import { ClaudeCodeAgent, ClaudeCodeConversation } from './agent/claude_code';
import { CLAUDE_CODE_NOT_FOUND, claudeCodeEnv, findClaudeCode } from './agent/claude_code_launch';
import type { ChatStore } from './chat_store';
import { MissingApiKeyError, type LlmService } from './llm';
import { checkUserImages } from './llm/images';
import type { ProjectStore } from './projects';
import type { SettingsStore } from './settings';
import type { EditBackups } from './tools/edit_backups';
import { availableTools } from './tools/registry';
import { ShellRunner, shellName } from './tools/shell';
import { listSkills } from './tools/skills';
import { createFinderTool, createOracleTool, createTaskTool, subagentConversation } from './tools/task';
import { createTodoTool } from './tools/todo';
import { confineFileUrl, type BrowserController } from './tools/browser';
import type { AgentTool, CodeSearch, ToolContext } from './tools/types';
import type { McpHub } from './tools/mcp';
import { Workspace } from './tools/workspace';

export interface ChatManagerDeps {
  settings: SettingsStore;
  projects: ProjectStore;
  chats: ChatStore;
  llm: LlmService;
  browser: () => BrowserController | null;
  codeSearch: (workspace: Workspace) => { search: CodeSearch; tools: AgentTool[] } | null;
  mcp: McpHub;
  emit: (event: ChatEvent, chatId: string) => void;
  onSnapshot: (snapshot: ChatSnapshot) => void;
  onHistoryChanged: () => void;
  onDroppedFields?: (error: DroppedFieldError) => void;
  // Where backups of approved edits are kept. Without it, edits cannot be undone.
  edits?: EditBackups;
  sandboxSensitivePaths?: () => string[];
}

const SAVE_DELAY_MS = 500;

interface ProjectChat {
  session: ChatSession | null;
  workspace: Workspace | null;
  shell: ShellRunner | null;
}

// Owns the active chat. A chat's model conversation is created on the first message, so the model and project in
// effect at that moment are the ones the chat keeps.
export class ChatManager {
  private session: ChatSession | null = null;
  private workspace: Workspace | null = null;
  private shell: ShellRunner | null = null;
  private projectPath: string | null = null;
  private readonly parked = new Map<string, ProjectChat>();
  private readonly saveTimers = new Map<ChatSession, NodeJS.Timeout>();
  private readonly liveSessions = new Set<ChatSession>();

  constructor(private readonly deps: ChatManagerDeps) {}

  snapshot(): ChatSnapshot {
    return (
      this.session?.snapshot() ?? {
        id: '',
        title: 'New chat',
        projectPath: this.deps.projects.current()?.path ?? null,
        model: this.deps.settings.get().model,
        transcript: [],
        busy: false,
        resumable: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
        agentFile: this.pendingAgentFile(),
      }
    );
  }

  // True while the assistant works, and while an undo is putting a file back: until its note for the model is queued
  // and saved, nothing else may start, or the model would only hear about the undo one message late.
  get busy(): boolean {
    return this.undoing || (this.session?.busy ?? false);
  }

  // Setup problems (no project, missing API key, already busy) throw immediately; the returned promise settles when
  // the agent finishes. Errors during the run are shown in the transcript instead.
  send(message: UserMessage): Promise<void> {
    if (this.busy) throw new Error('The assistant is still working. Stop it or wait for it to finish.');
    // A chat keeps its model; a new chat gets the model in settings.
    const model = this.session?.snapshot().model ?? this.deps.settings.get().model;
    if (message.images?.length && !acceptsImages(model)) throw new Error(imagesNotSupportedMessage(model));
    if (message.images?.length) message = { ...message, images: checkUserImages(message.images) };
    if (!this.session) {
      this.session = this.createSession();
      this.liveSessions.add(this.session);
      this.deps.onSnapshot(this.session.snapshot());
    }
    return this.session.send(message);
  }

  stop(): void {
    this.session?.stop();
    this.shell?.stopAll();
  }

  // Stops the current project's background commands, e.g. before Git metadata is created that a sandboxed command
  // still running would otherwise be able to write (#231). Await commandStopsSettled() for them to have exited.
  stopBackgroundCommands(): void {
    this.requireIdle();
    this.shell?.stopAll();
  }

  resume(): Promise<void> {
    if (this.busy) throw new Error('The assistant is still working. Stop it or wait for it to finish.');
    if (!this.session?.snapshot().resumable) throw new Error('There is no stopped run to resume.');
    return this.session.resume();
  }

  // Summarizes the older turns of the open chat. Setup problems throw at once; the result is shown as a notice.
  compact(): Promise<void> {
    if (this.busy) throw new Error('The assistant is still working. Stop it or wait for it to finish.');
    if (!this.session || this.session.isEmpty) throw new Error('There is no chat to compact yet.');
    return this.session.compact();
  }

  // Puts back the file that an approved edit changed, or removes the file it created, from the edit's card. Only while
  // the assistant is idle, so it cannot be working on the same file, and only if the file is still as the edit left it.
  private undoing = false;

  async undoEdit(toolId: string): Promise<UndoResult> {
    this.requireIdle();
    const session = this.session;
    const edits = this.deps.edits;
    if (!session || !edits) throw new Error('There is no edit to undo.');
    const card = session.snapshot().transcript.find((item) => item.kind === 'tool' && item.id === toolId);
    if (card?.kind !== 'tool' || card.undo !== 'available') throw new Error('This edit cannot be undone.');

    const projectPath = session.snapshot().projectPath;
    if (!projectPath) throw new Error('This chat has no project.');
    this.undoing = true;
    try {
      const {
        absolute: _absolute,
        absolutes,
        ...result
      } = await edits.undo(session.id, toolId, new Workspace(projectPath));
      session.editUndone(toolId, result, absolutes);
      this.save(session);
      return result;
    } finally {
      this.undoing = false;
    }
  }

  decide(approvalId: string, decision: ApprovalDecision): void {
    this.session?.decide(approvalId, decision);
  }

  newChat(): ChatSnapshot {
    this.requireIdle();
    this.closeSession();
    const snapshot = this.snapshot();
    this.deps.onSnapshot(snapshot);
    return snapshot;
  }

  // Reopens a saved chat and its project. The chat keeps the model and system prompt it started with.
  open(id: string): ChatSnapshot {
    this.requireIdle();
    const saved = this.deps.chats.load(id);
    if (!saved) throw new Error('That chat could not be found.');
    if (!saved.projectPath) throw new Error('That chat has no project.');
    const resolved = new Workspace(saved.projectPath);
    const current = resolved.root === this.projectPath;
    const retained = this.parked.get(resolved.root);
    const existing = current ? this.session : retained?.session;
    if (existing?.id === id) {
      this.deps.projects.open(resolved.root);
      this.projectChanged();
      return this.snapshot();
    }
    const workspace = (current ? this.workspace : retained?.workspace) ?? resolved;
    const shell = (current ? this.shell : retained?.shell) ?? this.createShell(workspace);
    // Preparing a restored chat must not mutate the active project, session or workspace-bound resources.
    const next = this.createSession(saved, { workspace, shell });
    try {
      this.deps.projects.open(workspace.root);
    } catch (error) {
      next.dispose();
      throw error;
    }
    this.projectChanged();
    this.closeSession();
    this.workspace = workspace;
    this.shell = shell;
    this.session = next;
    this.liveSessions.add(next);
    const snapshot = this.session.snapshot();
    this.deps.onSnapshot(snapshot);
    return snapshot;
  }

  // Keep idle chats and their workspace-bound shell runners separate while switching the active project.
  projectChanged(): void {
    this.requireIdle();
    const next = this.deps.projects.current()?.path ?? null;
    if (next === this.projectPath) {
      // Closing the last project already discarded its session; publish the empty chat in that case.
      if (next === null) this.deps.onSnapshot(this.snapshot());
      return;
    }
    if (this.projectPath) {
      if (this.session) this.save(this.session);
      this.parked.set(this.projectPath, { session: this.session, workspace: this.workspace, shell: this.shell });
    }
    const retained = next ? this.parked.get(next) : undefined;
    if (next) this.parked.delete(next);
    this.session = retained?.session ?? null;
    this.workspace = retained?.workspace ?? null;
    this.shell = retained?.shell ?? null;
    this.projectPath = next;
    this.deps.onSnapshot(this.snapshot());
  }

  requireIdle(): void {
    if (this.busy)
      throw new Error('Stop the current task and wait for it to finish before switching chats or projects.');
  }

  // `path` may be a linked spelling of a project (macOS /var for /private/var); sessions are keyed by the stored path.
  closeProject(requested: string): void {
    const path = this.deps.projects.get(requested)?.path ?? requested;
    if (path === this.projectPath) {
      this.requireIdle();
      this.closeSession();
      this.shell?.stopAll();
      this.shell = null;
      this.workspace = null;
      this.projectPath = null;
    } else {
      const retained = this.parked.get(path);
      if (retained?.session) {
        this.save(retained.session);
        this.drop(retained.session);
      }
      retained?.shell?.stopAll();
      this.parked.delete(path);
    }
  }

  dispose(): void {
    this.closeSession();
    this.shell?.stopAll();
    for (const path of [...this.parked.keys()]) this.closeProject(path);
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
  }

  private createSession(saved?: SavedChat, resources?: { workspace: Workspace; shell: ShellRunner }): ChatSession {
    const path = resources?.workspace.root ?? this.deps.projects.current()?.path;
    if (!path) throw new Error('Open a project folder first (File → Open Project).');
    const workspace = resources?.workspace ?? this.currentWorkspace(path);
    const shell = resources?.shell ?? this.currentShell(workspace);
    // Read again on every turn: keys and panels can change while a chat is open.
    const capabilities = () => {
      const settings = this.deps.settings.get();
      const googleApiKey = this.deps.settings.getSecret('googleApiKey');
      return {
        codeSearch: this.deps.codeSearch(workspace),
        browser: this.deps.browser(),
        webSearch:
          googleApiKey && settings.googleSearchEngineId
            ? { googleApiKey, googleSearchEngineId: settings.googleSearchEngineId }
            : null,
      };
    };
    const conversation = saved
      ? this.deps.llm.restoreConversation(saved.conversation)
      : this.deps.llm.createConversation();
    // A saved chat keeps the system prompt it started with, including the agent file as it was then.
    const agentFile = saved ? null : loadAgentFile(workspace);
    const system =
      saved?.system ??
      buildSystemPrompt({
        workspace,
        shell: shellName(this.deps.settings.get().sandboxMode === 'container'),
        platform: platform(),
        date: new Date().toISOString().slice(0, 10),
        customInstructions: this.deps.projects.get(workspace.root)?.instructions ?? '',
        agentFile,
        skills: listSkills(workspace),
      });
    // Read from the prompt the chat actually has (a saved chat keeps its own), not from the folder on every turn.
    const offersSkills = promptListsSkills(system);

    // The subagent tool closes over the chat's conversation factory and system prompt; the nested agent shares
    // the tool list (minus itself, via the read-only filter).
    const sessionTools = () => {
      const { codeSearch, browser, webSearch } = capabilities();
      return availableTools(
        { browser, codeSearch: codeSearch?.search ?? null, webSearch },
        [...(codeSearch?.tools ?? []), ...this.deps.mcp.tools(), taskTool, finderTool, oracleTool, todoTool],
        { skills: offersSkills },
      );
    };
    // The checklist lives and dies with this chat; subagents do not get it (they only read).
    const todoTool = createTodoTool();
    // A custom OpenAI-compatible endpoint may not serve any model but the chat's. Subagents stay on this provider.
    const customOpenAIChat = (): boolean =>
      conversation.provider === 'openai' &&
      conversation.serialize().api === 'chat' &&
      Boolean(this.deps.settings.get().openaiBaseUrl.trim());
    // Permission rules see the paths a call names as project-relative and, where the file system ignores case,
    // without regard to it (#237). A path outside the project stays as written.
    const paths: PathView = {
      ignoreCase: process.platform === 'win32' || process.platform === 'darwin',
      relative: (path) => {
        try {
          return workspace.relative(workspace.resolve(path)).replace(/\\/g, '/');
        } catch {
          return null;
        }
      },
    };
    const subagents = {
      createConversation: () => {
        const settings = this.deps.settings.get();
        const effort = effortForSubagent('task', settings.effort, settings.subagentEffort);
        const model = customOpenAIChat()
          ? conversation.model
          : subagentModelId(conversation.provider, conversation.model, settings.subagentModel);
        return model === conversation.model
          ? subagentConversation(conversation, (saved) => this.deps.llm.restoreConversation(saved, effort))
          : this.deps.llm.createConversation(model, effort);
      },
      // The finder runs on the provider's small model, except on a custom endpoint, which may not serve it.
      createFinderConversation: () => {
        const settings = this.deps.settings.get();
        const effort = effortForSubagent('finder', settings.effort, settings.subagentEffort);
        const customEndpoint =
          customOpenAIChat() || (conversation.provider === 'anthropic' && Boolean(settings.anthropicBaseUrl.trim()));
        return customEndpoint
          ? subagentConversation(conversation, (saved) => this.deps.llm.restoreConversation(saved, effort))
          : this.deps.llm.createConversation(SMALL_MODELS[conversation.provider], effort);
      },
      // Oracle stays on the chat model and the chat effort, not the scaled task effort.
      createOracleConversation: () =>
        subagentConversation(conversation, (saved) =>
          this.deps.llm.restoreConversation(saved, this.deps.settings.get().effort),
        ),
      system,
      tools: sessionTools,
      chatModel: conversation.model,
      recordUsage: (usage: UsageTotals, model: string) => session.recordUsage(usage, model),
      decidePermission: (name: string, input: Record<string, unknown>) =>
        decideCallPermission(this.deps.settings.get().permissionRules, name, input, 'subagent', paths),
    };
    const taskTool = createTaskTool(subagents);
    const finderTool = createFinderTool(subagents);
    const oracleTool = createOracleTool(subagents);

    // The global network allow-list plus this project's own, read on every call so a change applies at once.
    const allowsNetworkUrl = (url: string): boolean => {
      const settings = this.deps.settings.get();
      const own = this.deps.projects.get(workspace.root);
      return isNetworkUrlAllowed(url, mergeAllowLists(settings.allowedNetworkHosts, own?.allowedNetworkHosts));
    };
    // Claude Code chats run in Claude Code (agent/claude_code.ts). It reads CLAUDE.md itself; the project's
    // instructions in Patch and an AGENTS.md are added to its system prompt.
    const claudeCode =
      conversation instanceof ClaudeCodeConversation
        ? (() => {
            const instructions = this.deps.projects.get(workspace.root)?.instructions?.trim() ?? '';
            const agentsMd = loadAgentFile(workspace);
            const append = [
              instructions ? `Instructions for this project from the user:\n${instructions}` : '',
              agentsMd && agentsMd.name !== 'CLAUDE.md' ? `Contents of ${agentsMd.name}:\n${agentsMd.content}` : '',
            ]
              .filter(Boolean)
              .join('\n\n');
            return { conversation, append };
          })()
        : null;
    const session: ChatSession = new ChatSession({
      id: saved?.id,
      title: saved?.title,
      createdAt: saved?.createdAt,
      projectPath: workspace.root,
      conversation,
      officialPricing:
        saved?.officialPricing ??
        (conversation.provider === 'anthropic'
          ? !this.deps.settings.get().anthropicBaseUrl.trim()
          : !this.deps.settings.get().openaiBaseUrl.trim()),
      system,
      agentFile: saved ? (saved.agentFile ?? null) : (agentFile?.name ?? null),
      tools: sessionTools,
      transcript: saved?.transcript,
      usage: saved?.usage,
      readFiles: saved?.readFiles,
      pendingNotes: saved?.pendingNotes,
      resumable: saved?.resumable,
      planModeTold: saved?.planModeTold,
      approvalMode: () => this.deps.settings.get().approvalMode,
      planMode: () => this.deps.settings.get().planMode,
      decidePermission: (name, input) =>
        decideCallPermission(this.deps.settings.get().permissionRules, name, input, 'thread', paths),
      isPreApproved: (toolName, input) => {
        // The global lists plus this project's own, read on every call so a change applies at once.
        const settings = this.deps.settings.get();
        const own = this.deps.projects.get(workspace.root);
        if (toolName === 'run_command' && typeof (input as { command?: unknown })?.command === 'string') {
          return isCommandAllowed(
            (input as { command: string }).command,
            mergeAllowLists(settings.allowedCommands, own?.allowedCommands),
          );
        }
        if (
          (toolName === 'fetch_url' || toolName === 'browser') &&
          typeof (input as { url?: unknown })?.url === 'string'
        ) {
          const url = (input as { url: string }).url;
          if (toolName === 'browser' && /^file:/i.test(url)) {
            try {
              confineFileUrl(url, workspace);
              return true;
            } catch {
              return false;
            }
          }
          return allowsNetworkUrl(url);
        }
        return false;
      },
      toolContext: (base): ToolContext => {
        const { codeSearch, browser, webSearch } = capabilities();
        return {
          ...base,
          workspace,
          shell,
          chatId: session.id,
          browser,
          codeSearch: codeSearch?.search ?? null,
          webSearch,
          allowsNetworkUrl,
        };
      },
      smallModel: (conversation) => this.deps.llm.smallModel(conversation),
      keepCacheWarm: () => this.deps.settings.get().keepCacheWarm,
      onDroppedFields: this.deps.onDroppedFields,
      onEditApplied: this.deps.edits ? (toolId, edit) => this.deps.edits!.record(session.id, toolId, edit) : undefined,
      onEvent: (event) => this.deps.emit(event, session.id),
      onChange: (immediate, checkpoint) => (immediate ? this.save(session, checkpoint) : this.scheduleSave(session)),
      createAgent: claudeCode
        ? (hooks) =>
            new ClaudeCodeAgent({
              ...hooks,
              conversation: claudeCode.conversation,
              cwd: workspace.root,
              appendSystemPrompt: claudeCode.append,
              approvalMode: () => this.deps.settings.get().approvalMode,
              planMode: () => this.deps.settings.get().planMode,
              effort: () => this.deps.settings.get().effort,
              launch: () => this.claudeCodeLaunch(),
            })
        : undefined,
    });
    return session;
  }

  // Where Claude Code is and what it starts with, read from the settings on every message.
  private claudeCodeLaunch() {
    const settings = this.deps.settings.get();
    const executable = findClaudeCode(settings.claudeCodePath);
    if (!executable) {
      throw new Error(
        settings.claudeCodePath
          ? `Claude Code was not found at ${settings.claudeCodePath}. Check its path in Settings → Claude Code.`
          : CLAUDE_CODE_NOT_FOUND,
      );
    }
    let apiKey: { key: string; baseUrl: string } | null = null;
    if (settings.claudeCodeUsesApiKey) {
      const key = this.deps.settings.getSecret('anthropicApiKey');
      if (!key) throw new MissingApiKeyError('anthropic');
      apiKey = { key, baseUrl: settings.anthropicBaseUrl.trim() };
    }
    return { executable, env: claudeCodeEnv(process.env, apiKey) };
  }

  // The agent file a new chat in the current project would start with, shown before the first message.
  private pendingAgentFile(): string | null {
    const project = this.deps.projects.current();
    if (!project) return null;
    try {
      return loadAgentFile(new Workspace(project.path))?.name ?? null;
    } catch {
      return null;
    }
  }

  private currentWorkspace(path: string): Workspace {
    if (!this.workspace || this.workspace.root !== new Workspace(path).root) {
      this.workspace = new Workspace(path);
      this.shell?.stopAll();
      this.shell = null;
    }
    return this.workspace;
  }

  private currentShell(workspace: Workspace): ShellRunner {
    this.shell ??= this.createShell(workspace);
    return this.shell;
  }

  private createShell(workspace: Workspace): ShellRunner {
    return new ShellRunner(
      () => workspace.root,
      () => {
        const settings = this.deps.settings.get();
        const own = this.deps.projects.get(workspace.root);
        return {
          mode: settings.sandboxMode,
          network: settings.sandboxNetwork,
          image: settings.sandboxImage,
          allowedHosts: mergeAllowLists(settings.allowedNetworkHosts, own?.allowedNetworkHosts),
          envAllowList: settings.sandboxEnvAllowList,
          path: settings.sandboxPath,
        };
      },
      undefined,
      undefined,
      this.deps.sandboxSensitivePaths,
    );
  }

  private scheduleSave(session: ChatSession): void {
    if (!this.liveSessions.has(session) || session.isEmpty) return;
    clearTimeout(this.saveTimers.get(session));
    this.saveTimers.set(
      session,
      setTimeout(() => this.save(session), SAVE_DELAY_MS),
    );
  }

  private save(session: ChatSession, checkpoint = false): void {
    clearTimeout(this.saveTimers.get(session));
    this.saveTimers.delete(session);
    if (!this.liveSessions.has(session) || session.isEmpty) return;
    if (this.deps.chats.save(session.serialize(), checkpoint)) this.deps.onHistoryChanged();
  }

  // Called before chats are deleted from the history: an open or parked session of a deleted chat is dropped without
  // being saved, or it would be written back later (on a project switch, a pending save, or quit). Deleting the chat
  // that is running is refused until it is stopped.
  forget(ids: string[] | 'all'): void {
    const deleted = (session: ChatSession) => ids === 'all' || ids.includes(session.id);
    if (this.session && deleted(this.session)) {
      if (this.busy) throw new Error('Stop the current task and wait for it to finish before deleting its chat.');
      this.drop(this.session);
      this.session = null;
      this.deps.onSnapshot(this.snapshot());
    }
    for (const parked of this.parked.values()) {
      if (parked.session && deleted(parked.session)) {
        this.drop(parked.session);
        parked.session = null;
      }
    }
  }

  private drop(session: ChatSession): void {
    clearTimeout(this.saveTimers.get(session));
    this.saveTimers.delete(session);
    this.liveSessions.delete(session);
    session.dispose();
  }

  private closeSession(): void {
    if (!this.session) return;
    this.session.stop();
    this.save(this.session);
    this.drop(this.session);
    this.session = null;
    this.shell?.stopAll();
  }
}
