import { applyChatEvent, type ChatEvent, type ChatSnapshot } from '@shared/chat';
import { indexStatusLabel } from '@shared/index_status';
import type { ImageAttachment, IndexStatus } from '@shared/ipc';
import {
  acceptsImages,
  COMPACT_SUGGESTED_TOKENS,
  contextWindow,
  estimateChatCost,
  formatCost,
  imagesNotSupportedMessage,
  MODEL_OPTIONS,
  providerForModel,
} from '@shared/models';
import type { GitStatus } from '@shared/panels';
import type { ProjectInfo } from '@shared/project';
import { openaiCredentialMissing, type SettingsView } from '@shared/settings';
import { h, icon, setChildren, sym } from './dom';
import { formatTokens, readPreference, writePreference } from './format';
import { Composer } from './views/composer';
import { openHistoryDialog, openProjectSettingsDialog, openSettingsDialog } from './views/dialogs';
import { Panels } from './views/panels';
import { Sidebar } from './views/sidebar';
import { TranscriptView } from './views/transcript';

const api = window.api;

const FEEDBACK_URL = 'https://github.com/PierrunoYT/patch/issues/new';
// While the code index is being built, the status bar asks for its progress this often.
const INDEX_POLL_MS = 1500;

export class App {
  private settings!: SettingsView;
  private project: ProjectInfo | null = null;
  private chat!: ChatSnapshot;
  private pendingEvents: ChatEvent[] = [];
  private frame = 0;
  private welcomeGeneration = 0;
  private projectGeneration = 0;
  private gitGeneration = 0;
  private indexGeneration = 0;
  private indexTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly drafts = new Map<string, ReturnType<Composer['getDraft']>>();
  private readonly projectTabs = h('nav', { class: 'project-tabs', 'aria-label': 'Open projects' });
  private readonly sessionProject = h('span', { class: 'session-project' });
  private readonly sessionTitle = h('span', { class: 'session-title' });
  private readonly sidebarButton = h(
    'button',
    {
      class: 'icon-button',
      title: 'Show or hide the sidebar',
      'aria-expanded': 'true',
      onclick: () => {
        this.sidebar.element.hidden = !this.sidebar.element.hidden;
        this.sidebarButton.setAttribute('aria-expanded', String(!this.sidebar.element.hidden));
      },
    },
    sym('left_panel_close'),
  );

  private readonly transcript = new TranscriptView({
    decide: (id, decision) => void api.invoke('chat:decide', id, decision),
    openFile: (path) => void api.invoke('files:open-in-editor', path).catch((error) => this.toast(error)),
    undoEdit: (id, path) => void this.undoEdit(id, path),
    theme: () => this.settings.theme,
  });
  private readonly composer = new Composer({
    send: (text, images) => this.send(text, images),
    stop: () => void api.invoke('chat:stop'),
    resume: () => void api.invoke('chat:resume').catch((error) => this.toast(error)),
    pickImages: () => api.invoke('files:pick-images').catch((error) => (this.toast(error), [])),
    listFiles: () => (this.project ? api.invoke('files:list').catch(() => []) : Promise.resolve([])),
    notice: (message) => this.toast(message),
  });

  private readonly sidebar = new Sidebar({
    list: () => api.invoke('history:list'),
    search: (query) => api.invoke('history:search', query),
    open: (id) => void api.invoke('history:open', id).catch((error) => this.toast(error)),
    newChat: () => void this.newChat(),
  });
  // The project menu (open folder, project settings, recent projects), behind the header's "tune" button.
  private readonly projectButton = h('button', {
    class: 'icon-button project-button',
    onclick: () => this.toggleProjectMenu(),
  });
  private readonly projectMenu = h('div', { class: 'dropdown-menu dropdown-menu-end project-menu' });
  private readonly modelSelect = h('select', {
    class: 'model-select',
    'aria-label': 'Model',
    onchange: () => void this.chooseModel(),
  }) as HTMLSelectElement;
  private readonly askButton = h(
    'button',
    { class: 'mode-option', onclick: () => void this.setMode('ask') },
    sym('touch_app'),
    h('span', {}, 'Ask'),
  );
  private readonly autoButton = h(
    'button',
    { class: 'mode-option', onclick: () => void this.setMode('auto') },
    sym('bolt'),
    h('span', {}, 'Auto-Approve'),
  );
  private readonly planSwitch = h('button', {
    class: 'plan-switch',
    role: 'switch',
    'aria-label': 'Plan Mode',
    onclick: () => void this.setPlanMode(),
  });
  private readonly branchLabel = h('span', { class: 'status-item status-branch', hidden: true });
  private readonly agentLabel = h('span', { class: 'status-item', hidden: true });
  private readonly engineLabel = h('span', { class: 'status-item' });
  private readonly contextMeter = h('span', { class: 'context-meter', 'aria-hidden': 'true' }, h('span'));
  private readonly contextText = h('span', { class: 'context-text' });
  private readonly contextLabel = h(
    'span',
    { class: 'status-item context-item' },
    h('span', { class: 'status-muted' }, 'Context:'),
    this.contextMeter,
    this.contextText,
  );
  private readonly indexLabel = h('span', { class: 'status-item', hidden: true });
  private readonly tokensLabel = h('span', { class: 'status-item' });
  private readonly costLabel = h('span', { class: 'status-item status-cost' });
  private readonly chatScroll = h('div', { class: 'chat-scroll' });
  private readonly welcome = h('div', { class: 'welcome' });
  private readonly toastArea = h('div', { class: 'toast-area' });
  private readonly panels = new Panels(
    (error) => this.toast(error),
    () => this.project !== null,
    (status) => {
      // The panel has the newest status: drop an older refresh of the status bar still on its way.
      this.gitGeneration++;
      this.showGitStatus(status);
    },
  );
  private readonly compactButton = h(
    'button',
    { class: 'icon-button', 'aria-label': 'Compact chat', onclick: () => void this.compactChat() },
    sym('view_compact'),
  );
  private readonly exportButton = h(
    'button',
    {
      class: 'icon-button',
      title: 'Export this chat as Markdown',
      'aria-label': 'Export chat',
      onclick: () => void this.exportChat(),
    },
    sym('download'),
  );
  private readonly panelHost = h('div', { class: 'panel-host' }, this.panels.element);
  private readonly panelButton = h(
    'button',
    { class: 'icon-button', title: 'Show or hide the side panel', onclick: () => this.togglePanel() },
    sym('terminal'),
  );

  async start(root: HTMLElement): Promise<void> {
    [this.settings, this.project, this.chat] = await Promise.all([
      api.invoke('settings:get'),
      api.invoke('project:current'),
      api.invoke('chat:snapshot'),
    ]);

    root.replaceChildren(this.layout());
    this.applyTheme();
    this.renderAll();
    void this.renderProjects();
    void this.sidebar.refresh();
    void this.refreshGit();
    void this.refreshIndex();
    void api.invoke('app:info').then(
      (info) => this.panels.setVersion(info.version),
      () => {},
    );

    api.on('history:changed', (chats) => this.sidebar.update(chats));
    api.on('settings:changed', (settings) => {
      const themeChanged = settings.theme !== this.settings.theme;
      this.settings = settings;
      this.applyTheme();
      // Diffs already shown keep the colors of the old theme until they are drawn again.
      if (themeChanged) this.transcript.redraw(this.chat.transcript);
      this.renderHeader();
      void this.renderWelcome();
      void this.refreshIndex();
    });
    api.on('project:changed', (project) => {
      const changed = project?.path !== this.project?.path;
      if (changed) {
        if (this.project) this.drafts.set(this.project.path, this.composer.getDraft());
        this.composer.setDraft(this.drafts.get(project?.path ?? '') ?? { text: '', images: [], mentions: [] });
      }
      this.project = project;
      if (changed) this.panels.projectChanged();
      void this.refreshGit();
      void this.refreshIndex();
      this.renderHeader();
      void this.renderWelcome();
      void this.renderProjects();
    });
    api.on('chat:snapshot', (snapshot) => {
      this.chat = snapshot;
      this.pendingEvents = [];
      this.transcript.reset();
      this.renderAll();
    });
    api.on('chat:event', ({ chatId, event }) => {
      if (chatId !== this.chat.id) return;
      this.pendingEvents.push(event);
      if (event.type === 'tool-end') {
        this.panels.filesChanged();
        this.composer.filesChanged();
        // search_code builds the index on its first call.
        if (event.status === 'done') void this.refreshIndex();
      }
      // Stream deltas arrive quickly; apply them in batches once per frame.
      this.frame ||= requestAnimationFrame(() => this.flushEvents());
    });
    // Notices from the main process (MCP servers reconnected, a saved key that can no longer be read).
    api.on('app:notice', (text) => this.toast(text, 'warning'));
    api.on('menu:command', (command) => {
      if (command === 'open-project') void this.chooseProject();
      else if (command === 'new-chat') void this.newChat();
      else if (command === 'stop') void api.invoke('chat:stop');
      else if (command === 'settings') this.openSettings();
    });
    api.on('panel:show', (name) => {
      this.setPanelVisible(true);
      this.panels.show(name);
    });
    this.setPanelVisible(readPreference('panelVisible') !== 'false');
    this.panels.show('terminal');
    document.addEventListener('click', (event) => {
      if (!this.projectMenu.contains(event.target as Node) && !this.projectButton.contains(event.target as Node)) {
        this.projectMenu.classList.remove('show');
      }
      // Links in rendered markdown: http(s) opens in the system browser via the main process; others do nothing.
      const link = (event.target as HTMLElement).closest('a');
      if (link && !/^https?:/i.test(link.getAttribute('href') ?? '')) event.preventDefault();
    });

    this.composer.focus();
  }

  private layout(): HTMLElement {
    this.composer.controls.replaceChildren(this.chatControls());
    this.sidebar.element.prepend(
      h(
        'div',
        { class: 'workspace-navigation' },
        h('span', { class: 'workspace-label' }, 'Projects'),
        this.projectTabs,
      ),
    );
    return h(
      'div',
      { class: 'app' },
      h(
        'header',
        { class: 'app-header' },
        h(
          'div',
          { class: 'header-left' },
          h(
            'span',
            { class: 'brand' },
            h('span', { class: 'brand-mark', 'aria-hidden': 'true' }),
            h('span', { class: 'brand-name', role: 'img', 'aria-label': 'Patch' }, 'patch'),
          ),
          this.sidebarButton,
        ),
        h('div', { class: 'session-heading' }, this.sessionProject, sym('chevron_right'), this.sessionTitle),
        h(
          'div',
          { class: 'header-actions' },
          this.compactButton,
          this.exportButton,
          h(
            'a',
            {
              class: 'icon-button',
              href: FEEDBACK_URL,
              target: '_blank',
              rel: 'noreferrer',
              title: 'Send feedback (opens a new GitHub issue in your browser)',
              'aria-label': 'Send feedback',
            },
            sym('feedback'),
          ),
          h('span', { class: 'header-divider', 'aria-hidden': 'true' }),
          h(
            'button',
            { class: 'icon-button', title: 'Chat history', onclick: () => void this.openHistory() },
            sym('model_training'),
          ),
          this.panelButton,
          h('div', { class: 'project-picker' }, this.projectButton, this.projectMenu),
          h(
            'button',
            { class: 'icon-button', title: 'Settings (Ctrl+,)', onclick: () => this.openSettings() },
            sym('settings'),
          ),
        ),
      ),
      h(
        'main',
        { class: 'app-main' },
        this.sidebar.element,
        h(
          'section',
          { class: 'chat-pane' },
          h('div', { class: 'chat-scroll-wrap' }, this.chatScroll),
          this.composer.element,
        ),
        this.panelHost,
      ),
      h(
        'footer',
        { class: 'app-footer' },
        h('div', { class: 'status-group' }, this.branchLabel, this.agentLabel, this.engineLabel),
        h('div', { class: 'status-group status-center' }, this.contextLabel),
        h('div', { class: 'status-group status-right' }, this.indexLabel, this.tokensLabel, this.costLabel),
      ),
      this.toastArea,
    );
  }

  private chatControls(): HTMLElement {
    return h(
      'div',
      { class: 'header-controls' },
      h(
        'label',
        { class: 'model-pill', title: 'Model for this chat' },
        this.modelSelect,
        sym('expand_more', 'model-caret'),
      ),
      h('div', { class: 'mode-toggle', role: 'group', 'aria-label': 'Approval mode' }, this.askButton, this.autoButton),
      h(
        'div',
        {
          class: 'plan-pill',
          title: 'Plan mode: before multi-step changes, the assistant shows its plan for approval',
          onclick: (event: Event) => {
            if (event.target !== this.planSwitch) this.planSwitch.click();
          },
        },
        h('span', { 'aria-hidden': 'true' }, 'Plan Mode'),
        this.planSwitch,
      ),
    );
  }

  private renderAll(): void {
    this.chatScroll.replaceChildren(this.welcome, this.transcript.element, this.transcript.announcer);
    this.transcript.render(this.chat.transcript);
    this.composer.setState(this.chat.busy, this.chat.resumable);
    this.renderHeader();
    void this.renderWelcome();
  }

  private flushEvents(): void {
    this.frame = 0;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    let transcript = this.chat.transcript;
    for (const event of events) {
      transcript = applyChatEvent(transcript, event);
      if (event.type === 'busy') {
        this.chat.busy = event.busy;
        if (!event.busy) void this.refreshGit();
      }
      if (event.type === 'resumable') this.chat.resumable = event.resumable;
      if (event.type === 'usage') this.chat.usage = event.totals;
      if (event.type === 'title') this.chat.title = event.title;
    }
    this.chat = { ...this.chat, transcript };
    this.transcript.render(transcript);
    this.composer.setState(this.chat.busy, this.chat.resumable);
    this.renderHeader();
    this.welcome.hidden = transcript.length > 0;
  }

  private renderHeader(): void {
    this.sessionProject.textContent = this.project?.name ?? 'Workspace';
    this.sessionTitle.textContent = this.chat.transcript.length > 0 ? this.chat.title : 'New session';
    // The project menu's button names the open project for screen readers (its tab shows the name on screen).
    this.projectButton.replaceChildren(
      sym('tune'),
      h('span', { class: 'visually-hidden' }, this.project ? `Project ${this.project.name}` : 'Open project'),
    );
    this.projectButton.title = this.project ? `Project: ${this.project.path}` : 'Open a project folder';
    this.sidebar.setActive(this.chat.id);
    this.exportButton.disabled = this.chat.transcript.length === 0;

    // How full the context is: the size of the last request's prompt, against the model's context window. Nudge
    // towards compacting once it is large.
    const started = this.chat.transcript.length > 0;
    const model = started ? this.chat.model : this.settings.model;
    const window = contextWindow(model);
    const contextTokens = this.chat.usage.contextTokens;
    const nearLimit = contextTokens !== undefined && contextTokens >= COMPACT_SUGGESTED_TOKENS;
    this.compactButton.disabled = this.chat.transcript.length === 0 || this.chat.busy;
    this.compactButton.classList.toggle('warn', nearLimit);
    this.compactButton.title = nearLimit
      ? `The prompt is about ${formatTokens(contextTokens)} tokens. Summarize the older messages to free up context.`
      : 'Compact chat: summarize the older messages to free up context';
    // Unknown before the first request and after a compaction, until the next request reports the new size.
    const used = contextTokens === undefined ? '—' : formatTokens(contextTokens);
    this.contextText.textContent = `${used}${window ? ` / ${formatTokens(window)}` : ''}${nearLimit ? ' · consider compacting' : ''}`;
    const fill = Math.min(1, (contextTokens ?? 0) / (window ?? COMPACT_SUGGESTED_TOKENS));
    (this.contextMeter.firstElementChild as HTMLElement).style.width = `${(fill * 100).toFixed(1)}%`;
    this.contextLabel.title = window
      ? `Size of the latest prompt, of the model's ${formatTokens(window)}-token context window. Compacting is suggested from ${formatTokens(COMPACT_SUGGESTED_TOKENS)}.`
      : `Size of the latest prompt. Compacting is suggested from ${formatTokens(COMPACT_SUGGESTED_TOKENS)} tokens.`;
    this.contextLabel.classList.toggle('near-limit', nearLimit);

    const auto = this.settings.approvalMode === 'auto';
    this.askButton.classList.toggle('active', !auto);
    this.askButton.setAttribute('aria-pressed', String(!auto));
    this.askButton.title = 'Ask first: edits and commands wait for your approval.';
    this.autoButton.classList.toggle('active', auto);
    this.autoButton.setAttribute('aria-pressed', String(auto));
    this.autoButton.title = 'Auto: edits and commands run without asking. MCP tools and plans still ask.';
    this.planSwitch.setAttribute('aria-checked', String(this.settings.planMode));
    this.planSwitch.classList.toggle('on', this.settings.planMode);

    // A chat keeps its model; the picker sets the model for new chats, so it is locked once the chat has started.
    const options: Array<{ id: string; label: string }> = MODEL_OPTIONS.some((option) => option.id === model)
      ? MODEL_OPTIONS
      : [...MODEL_OPTIONS, { id: model, label: model }];
    // Rebuilt only when the model changes: the header is rendered on every streamed frame, and a rebuilt list would
    // close the picker while it is open.
    if (this.modelSelect.value !== model || this.modelSelect.options.length !== options.length) {
      this.modelSelect.replaceChildren(...options.map((option) => h('option', { value: option.id }, option.label)));
      this.modelSelect.value = model;
    }
    this.modelSelect.disabled = started || this.chat.busy;
    this.modelSelect.title = started
      ? 'A chat keeps its model. Start a new chat to use another one.'
      : 'Model for this chat';
    this.composer.setImagesBlocked(acceptsImages(model) ? null : imagesNotSupportedMessage(model));
    const label = options.find((option) => option.id === model)?.label ?? model;
    this.engineLabel.replaceChildren(h('span', { class: 'status-muted' }, 'Engine:'), ` ${label}`);

    const agentFile = this.chat.agentFile;
    this.agentLabel.hidden = !agentFile;
    this.agentLabel.title = agentFile ? `${agentFile} from the project is included in this chat's instructions` : '';
    this.agentLabel.replaceChildren(...(agentFile ? [h('span', { class: 'dot' }), agentFile] : []));
    this.sidebar.setAgentFile(agentFile);

    const { inputTokens, outputTokens, cacheReadTokens } = this.chat.usage;
    const cacheWriteTokens = this.chat.usage.cacheWriteTokens ?? 0;
    const total = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    const officialProvider =
      this.chat.officialPricing ??
      (providerForModel(model) === 'anthropic'
        ? !this.settings.anthropicBaseUrl.trim()
        : !this.settings.openaiBaseUrl.trim());
    const cost = estimateChatCost(model, this.chat.usage, officialProvider);
    this.tokensLabel.replaceChildren(sym('toll'), `Tokens: ${formatTokens(total)}`);
    this.tokensLabel.title = `${formatTokens(inputTokens)} in · ${formatTokens(cacheReadTokens)} cache read · ${formatTokens(cacheWriteTokens)} cache written · ${formatTokens(outputTokens)} out`;
    this.costLabel.hidden = cost === null;
    this.costLabel.textContent = cost === null ? '' : `Cost: ${total === 0 ? '$0.00' : formatCost(cost)}`;
    this.costLabel.title = cost === null ? '' : 'Estimated from official list prices.';
  }

  private async renderWelcome(): Promise<void> {
    // Several updates can arrive together (new chat + project change); only the latest render may finish.
    const generation = ++this.welcomeGeneration;
    this.welcome.hidden = this.chat.transcript.length > 0;
    if (this.welcome.hidden) return;

    if (!this.project) {
      const projects = await api.invoke('project:list');
      if (generation !== this.welcomeGeneration) return;
      setChildren(
        this.welcome,
        h('div', { class: 'welcome-wordmark', 'aria-hidden': 'true' }, 'patch'),
        h('h1', { class: 'h4' }, 'Open a project to start'),
        h('p', { class: 'text-body-secondary' }, 'Your next idea starts here. Choose a folder to work in.'),
        h(
          'button',
          { class: 'btn btn-primary', onclick: () => void this.chooseProject() },
          icon('folder-plus'),
          ' Open folder…',
        ),
        projects.length > 0 ? h('h2', { class: 'h6 mt-4 text-body-secondary' }, 'Recent') : null,
        h(
          'div',
          { class: 'list-group recent-projects' },
          ...projects.map((project) => this.recentProjectItem(project)),
        ),
      );
      return;
    }

    const provider = providerForModel(this.settings.model);
    const missingKey =
      provider === 'anthropic' ? !this.settings.secrets.anthropicApiKey : openaiCredentialMissing(this.settings);
    const credentialHint =
      provider === 'anthropic'
        ? 'Add your Anthropic API key to start.'
        : this.settings.openaiBaseUrl.trim()
          ? 'Add your OpenAI API key to start.'
          : 'Add your OpenAI API key or sign in with ChatGPT to start.';
    setChildren(
      this.welcome,
      h('div', { class: 'welcome-wordmark', 'aria-hidden': 'true' }, 'patch'),
      h('h1', { class: 'h4' }, this.project.name),
      h('p', { class: 'text-body-secondary small font-monospace' }, this.project.path),
      missingKey
        ? h(
            'div',
            { class: 'alert alert-warning' },
            `${credentialHint} `,
            h('button', { class: 'btn btn-sm btn-warning ms-2', onclick: () => this.openSettings() }, 'Open settings'),
          )
        : null,
      h(
        'ul',
        { class: 'text-body-secondary tips' },
        h('li', {}, 'Describe a task: "Add input validation to the signup form and a test for it."'),
        h('li', {}, 'Ask about the code: "How does authentication work here?" Type @ to mention a file.'),
        h(
          'li',
          {},
          this.settings.approvalMode === 'ask'
            ? 'Ask mode · Review changes and commands before they run.'
            : 'Auto mode · Changes and commands run without asking.',
        ),
        !this.settings.secrets.openrouterApiKey
          ? h('li', {}, 'Add an OpenRouter key in settings to enable semantic code search.')
          : null,
      ),
      h(
        'button',
        { class: 'btn btn-sm btn-outline-secondary', onclick: () => this.editProjectSettings() },
        icon('journal-text'),
        this.project.instructions ? ' Edit project instructions' : ' Add project instructions',
      ),
    );
  }

  private recentProjectItem(project: ProjectInfo): HTMLElement {
    return h(
      'div',
      { class: 'list-group-item d-flex align-items-center gap-2' },
      h(
        'button',
        {
          class: 'btn btn-link text-start text-decoration-none flex-grow-1 p-0 text-body',
          onclick: () => void this.openProject(project.path),
        },
        h('div', { class: 'fw-semibold' }, project.name),
        h('div', { class: 'small text-body-secondary text-truncate' }, project.path),
      ),
      h(
        'button',
        {
          class: 'btn btn-sm btn-outline-secondary',
          title: 'Remove from recent',
          onclick: async () => {
            await api.invoke('project:remove', project.path);
            void this.renderWelcome();
          },
        },
        icon('x-lg'),
      ),
    );
  }

  private async toggleProjectMenu(): Promise<void> {
    if (this.projectMenu.classList.toggle('show')) {
      const projects = await api.invoke('project:list');
      const item = (label: HTMLElement | string, action: () => void, disabled = false) =>
        h(
          'button',
          { class: 'dropdown-item', disabled, onclick: () => (this.projectMenu.classList.remove('show'), action()) },
          label,
        );
      setChildren(
        this.projectMenu,
        item(h('span', {}, icon('folder-plus'), ' Open folder…'), () => void this.chooseProject()),
        item(
          h('span', {}, icon('journal-text'), ' Project settings…'),
          () => this.editProjectSettings(),
          !this.project,
        ),
        projects.length > 0 ? h('div', { class: 'dropdown-divider' }) : null,
        ...projects.map((project) =>
          item(
            h('span', {}, project.path === this.project?.path ? icon('check2') : icon('folder2'), ` ${project.name}`),
            () => void this.openProject(project.path),
          ),
        ),
      );
    }
  }

  private async send(text: string, images: ImageAttachment[]): Promise<boolean> {
    try {
      await api.invoke('chat:send', { text, images: images.map(({ mediaType, base64 }) => ({ mediaType, base64 })) });
      return true;
    } catch (error) {
      this.toast(error);
      return false;
    }
  }

  private async chooseProject(): Promise<void> {
    try {
      await api.invoke('project:choose');
    } catch (error) {
      this.toast(error);
    }
  }

  private async openProject(path: string): Promise<void> {
    try {
      await api.invoke('project:open', path);
    } catch (error) {
      this.toast(error);
    }
  }

  private async newChat(): Promise<void> {
    try {
      await api.invoke('chat:new');
      this.composer.focus();
    } catch (error) {
      this.toast(error);
    }
  }

  private async renderProjects(): Promise<void> {
    const generation = ++this.projectGeneration;
    const projects = await api.invoke('project:opened');
    if (generation !== this.projectGeneration) return;
    for (const path of this.drafts.keys()) {
      if (!projects.some((project) => project.path === path)) this.drafts.delete(path);
    }
    this.projectTabs.replaceChildren(
      ...projects.map((project) => {
        const active = project.path === this.project?.path;
        return h(
          'div',
          { class: `project-tab${active ? ' active' : ''}` },
          h(
            'button',
            {
              title: project.path,
              'aria-pressed': String(active),
              onclick: () => void this.openProject(project.path),
            },
            sym(active ? 'folder_open' : 'folder'),
            h('span', {}, project.name),
          ),
          h(
            'button',
            {
              class: 'project-tab-close',
              'aria-label': `Close project ${project.name}`,
              onclick: () => void api.invoke('project:close', project.path).catch((error) => this.toast(error)),
            },
            sym('close'),
          ),
        );
      }),
      h(
        'button',
        { class: 'icon-button project-tab-add', title: 'Open Repository', onclick: () => void this.chooseProject() },
        sym('add'),
        h('span', {}, 'Open project'),
      ),
    );
  }

  private async setMode(mode: 'ask' | 'auto'): Promise<void> {
    if (mode === this.settings.approvalMode) return;
    // Switching to Auto asks for confirmation in the main process; cancelling it rejects and leaves the mode as it was.
    await api.invoke('settings:update', { approvalMode: mode }).catch((error) => this.toast(error));
  }

  private async setPlanMode(): Promise<void> {
    await api.invoke('settings:update', { planMode: !this.settings.planMode }).catch((error) => this.toast(error));
  }

  private async chooseModel(): Promise<void> {
    const model = this.modelSelect.value;
    await api.invoke('settings:update', { model }).catch((error) => {
      this.modelSelect.value = this.settings.model;
      this.toast(error);
    });
  }

  // Git state for the status bar and the Git tab's badge; refreshed when the project changes and after each run.
  private async refreshGit(): Promise<void> {
    const generation = ++this.gitGeneration;
    // Without a project the main process would reject the call (and log an error), so do not ask.
    const status = this.project ? await api.invoke('git:status').catch(() => null) : null;
    if (generation !== this.gitGeneration) return;
    this.showGitStatus(status);
  }

  private showGitStatus(status: GitStatus | null): void {
    const branch = status?.isRepo ? (status.branch ?? 'detached') : null;
    const changed = status?.files.length ?? 0;
    this.branchLabel.hidden = branch === null;
    this.branchLabel.title = changed ? `${changed} uncommitted file(s)` : '';
    this.branchLabel.replaceChildren(...(branch ? [sym('fork_right'), `Git: ${branch}${changed ? '*' : ''}`] : []));
    this.panels.setChangeCount(status?.isRepo ? changed : 0);
    this.panels.setSync(status);
  }

  // The code index's state for the status bar and the chat list. Polled while an index is being built.
  private async refreshIndex(): Promise<void> {
    clearTimeout(this.indexTimer);
    const generation = ++this.indexGeneration;
    const status: IndexStatus | null = this.project ? await api.invoke('index:status').catch(() => null) : null;
    if (generation !== this.indexGeneration) return;
    const label = status ? indexStatusLabel(status) : null;
    this.indexLabel.hidden = label === null;
    this.indexLabel.title = status?.reason ?? '';
    this.indexLabel.replaceChildren(
      ...(label ? [h('span', { class: `dot${label.ready ? ' live' : ''}` }), label.bar] : []),
    );
    this.sidebar.setIndexStatus(label?.short ?? null, label?.ready ?? false);
    if (status?.indexing) this.indexTimer = setTimeout(() => void this.refreshIndex(), INDEX_POLL_MS);
  }

  private openSettings(): void {
    openSettingsDialog(this.settings, {
      update: (patch) => api.invoke('settings:update', patch),
      setSecret: (name, value) => api.invoke('settings:set-secret', name, value),
      signInChatGpt: () => api.invoke('chatgpt:sign-in'),
      signOutChatGpt: () => api.invoke('chatgpt:sign-out'),
      indexStatus: () => api.invoke('index:status'),
      rebuildIndex: async () => {
        const status = await api.invoke('index:rebuild');
        void this.refreshIndex();
        return status;
      },
      mcpStatus: () => api.invoke('mcp:status'),
    });
  }

  private async undoEdit(id: string, path: string | undefined): Promise<void> {
    // Said before asking, not after the user has confirmed.
    if (this.chat.busy) {
      this.toast('Stop the current task, or wait for it to finish, before undoing an edit.');
      return;
    }
    if (!confirm(`Undo this change to ${path ?? 'the file'}? The file goes back to how it was before the edit.`))
      return;
    try {
      const result = await api.invoke('edit:undo', id);
      this.toast(result.action === 'deleted' ? `Deleted ${result.path}` : `Restored ${result.path}`, 'success');
      // Files changed outside a tool call, so the Git view has to be refreshed here.
      this.panels.filesChanged();
      void this.refreshGit();
    } catch (error) {
      this.toast(error);
    }
  }

  private async compactChat(): Promise<void> {
    try {
      await api.invoke('chat:compact');
    } catch (error) {
      this.toast(error);
    }
  }

  private async exportChat(): Promise<void> {
    try {
      const path = await api.invoke('chat:export');
      if (path) this.toast(`Saved ${path}`, 'success');
    } catch (error) {
      this.toast(error);
    }
  }

  private async openHistory(): Promise<void> {
    openHistoryDialog(await api.invoke('history:list'), {
      open: async (id) => {
        try {
          await api.invoke('history:open', id);
        } catch (error) {
          this.toast(error);
        }
      },
      delete: (id) => api.invoke('history:delete', id),
      clear: () => api.invoke('history:clear'),
      search: (query) => api.invoke('history:search', query),
    });
  }

  private editProjectSettings(): void {
    const project = this.project;
    if (!project) return;
    openProjectSettingsDialog(project, async (settings) => {
      const updated = await api.invoke('project:update-settings', project.path, settings);
      // The user may have switched projects while the dialog was open.
      if (this.project?.path === updated.path) this.project = updated;
      void this.renderWelcome();
    });
  }

  private togglePanel(): void {
    this.setPanelVisible(this.panelHost.hidden);
  }

  private setPanelVisible(visible: boolean): void {
    this.panelHost.hidden = !visible;
    this.panelButton.classList.toggle('active', visible);
    writePreference('panelVisible', String(visible));
  }

  private applyTheme(): void {
    document.documentElement.dataset.bsTheme = this.settings.theme;
  }

  toast(error: unknown, kind: 'danger' | 'success' | 'warning' = 'danger'): void {
    const message =
      error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        : String(error);
    const toast = h('div', { class: `app-toast alert alert-${kind} shadow`, role: 'alert' }, message);
    this.toastArea.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
  }
}
