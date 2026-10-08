import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
  AGENT_BROWSER_PARTITION,
  diffHunks,
  USER_BROWSER_PARTITION,
  type DiffHunk,
  type GitFile,
  type GitStatus,
  type PanelName,
} from '@shared/panels';
import { h, setChildren, sym } from '../dom';
import { readPreference, writePreference } from '../format';

const api = window.api;

// The side panel's width in pixels: 320 by default, as wide as the user drags it, within these bounds.
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 260;
const MAX_WIDTH_SHARE = 0.6;

interface Panel {
  element: HTMLElement;
  // Called each time the tab becomes visible.
  shown(): void;
  projectChanged(): void;
}

// Right-hand side of the window: Terminal, Git and Browser tabs, and a footer with the Git sync state and the app
// version. Each tab is built the first time it is shown.
export class Panels {
  readonly element = h('div', { class: 'panels' });
  private readonly tabBar = h('div', { class: 'panel-tabs', role: 'tablist' });
  private readonly body = h('div', { class: 'panel-body' });
  private readonly gitBadge = h('span', { class: 'panel-badge', hidden: true });
  private readonly syncLabel = h('span', { class: 'panel-sync' });
  private readonly versionLabel = h('span', { class: 'panel-version' });
  private readonly panels = new Map<PanelName, Panel>();
  private active: PanelName | null = null;

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly hasProject: () => boolean,
    // The Git tab read a new status (after a refresh, commit, push or discard).
    private readonly onGitStatus: (status: GitStatus | null) => void,
  ) {
    const tabs: Array<[PanelName, string, string]> = [
      ['terminal', 'Terminal', 'terminal'],
      ['git', 'Git', 'fork_right'],
      ['browser', 'Browser', 'web'],
    ];
    for (const [name, label, iconName] of tabs) {
      this.tabBar.appendChild(
        h(
          'button',
          {
            id: `panel-tab-${name}`,
            class: 'panel-tab',
            role: 'tab',
            'aria-controls': `panel-${name}`,
            tabindex: -1,
            dataset: { panel: name },
            onclick: () => this.show(name),
          },
          sym(iconName),
          h('span', {}, label),
          name === 'git' ? this.gitBadge : null,
        ),
      );
    }
    // Arrow keys move between tabs, as in a native tab strip; only the selected tab is in the Tab order.
    this.tabBar.addEventListener('keydown', (event) => {
      const names = tabs.map(([name]) => name);
      const current = names.indexOf(this.active ?? names[0]!);
      const next =
        event.key === 'ArrowRight'
          ? (current + 1) % names.length
          : event.key === 'ArrowLeft'
            ? (current - 1 + names.length) % names.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? names.length - 1
                : -1;
      if (next < 0) return;
      event.preventDefault();
      const target = names[next]!;
      this.show(target);
      this.tabBar.querySelector<HTMLElement>(`#panel-tab-${target}`)?.focus();
    });
    this.element.append(
      this.resizeHandle(),
      this.tabBar,
      this.body,
      h('div', { class: 'panel-footer' }, this.syncLabel, this.versionLabel),
    );
  }

  show(name: PanelName): void {
    let panel = this.panels.get(name);
    if (!panel) {
      panel = this.create(name);
      panel.element.id = `panel-${name}`;
      panel.element.setAttribute('role', 'tabpanel');
      panel.element.setAttribute('aria-labelledby', `panel-tab-${name}`);
      this.panels.set(name, panel);
      this.body.appendChild(panel.element);
    }
    for (const [other, { element }] of this.panels) element.hidden = other !== name;
    for (const tab of this.tabBar.querySelectorAll<HTMLElement>('.panel-tab')) {
      const selected = tab.dataset.panel === name;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    this.active = name;
    panel.shown();
  }

  projectChanged(): void {
    for (const panel of this.panels.values()) panel.projectChanged();
    if (this.active) this.panels.get(this.active)?.shown();
  }

  // The agent changed files or ran a command; refresh the Git view if it is open.
  filesChanged(): void {
    if (this.active === 'git') this.panels.get('git')?.shown();
  }

  // Uncommitted files, shown as a badge on the Git tab, and the sync state in the footer.
  setChangeCount(count: number): void {
    this.gitBadge.hidden = count === 0;
    this.gitBadge.textContent = String(count);
    this.gitBadge.setAttribute('aria-label', `${count} changed file${count === 1 ? '' : 's'}`);
  }

  setSync(status: GitStatus | null): void {
    this.syncLabel.replaceChildren(h('span', { class: 'dot live' }), syncText(status));
  }

  setVersion(version: string): void {
    this.versionLabel.textContent = `v${version}`;
  }

  private reportGit(status: GitStatus | null): void {
    this.setChangeCount(status?.isRepo ? status.files.length : 0);
    this.setSync(status);
    this.onGitStatus(status);
  }

  private create(name: PanelName): Panel {
    if (name === 'terminal') return new TerminalPanel(this.hasProject);
    if (name === 'browser') return new BrowserPanel();
    return new GitPanel(this.onError, (status) => this.reportGit(status));
  }

  // Dragging the panel's left edge resizes it; the width is remembered.
  private resizeHandle(): HTMLElement {
    const handle = h('div', {
      class: 'panel-resize',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize the side panel',
      tabindex: 0,
    });
    const apply = (width: number) => {
      const host = this.element.parentElement;
      if (!host) return;
      const max = Math.max(MIN_WIDTH, window.innerWidth * MAX_WIDTH_SHARE);
      const clamped = Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
      host.style.width = `${clamped}px`;
      writePreference('panelWidth', String(clamped));
    };
    requestAnimationFrame(() => apply(Number(readPreference('panelWidth')) || DEFAULT_WIDTH));
    handle.addEventListener('pointerdown', (event) => {
      const host = this.element.parentElement;
      if (!host) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const right = host.getBoundingClientRect().right;
      const move = (moved: PointerEvent) => apply(right - moved.clientX);
      const stop = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop);
    });
    handle.addEventListener('keydown', (event) => {
      const host = this.element.parentElement;
      if (!host || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      event.preventDefault();
      apply(host.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 24 : -24));
    });
    return handle;
  }
}

export function syncText(status: GitStatus | null): string {
  if (!status) return 'Git: no project';
  if (!status.isRepo) return 'Git: not a repository';
  if (status.ahead || status.behind) return `Git sync: ↑${status.ahead} ↓${status.behind}`;
  if (status.files.length) return `Git sync: ${status.files.length} uncommitted`;
  return status.tracking ? 'Git sync: clean' : 'Git sync: clean (no upstream)';
}

class TerminalPanel implements Panel {
  readonly element = h('div', { class: 'terminal-panel' });
  private readonly terminal = new Terminal({
    fontFamily: "'JetBrains Mono Variable', 'Cascadia Mono', Consolas, Menlo, monospace",
    fontSize: 12,
    cursorBlink: true,
    theme: { background: '#0a0e13' },
  });
  private readonly fit = new FitAddon();
  private started = false;
  private noProjectShown = false;

  constructor(private readonly hasProject: () => boolean) {
    this.terminal.loadAddon(this.fit);
    this.terminal.open(this.element);
    this.terminal.onData((data) => {
      if (this.started) void api.invoke('terminal:write', data);
      else if (data === '\r') this.start();
    });
    api.on('terminal:data', (data) => this.terminal.write(data));
    api.on('terminal:exit', () => {
      this.started = false;
      this.terminal.write('\r\n[shell exited — press Enter to restart]\r\n');
    });
    new ResizeObserver(() => this.resize()).observe(this.element);
  }

  shown(): void {
    requestAnimationFrame(() => {
      this.resize();
      if (!this.started) this.start();
      this.terminal.focus();
    });
  }

  projectChanged(): void {
    this.started = false;
    this.noProjectShown = false;
    this.terminal.reset();
  }

  private start(): void {
    // Without a project the main process would reject the call (and log an error), so do not ask.
    if (!this.hasProject()) {
      if (!this.noProjectShown) this.terminal.write('Open a project to use the terminal.\r\n');
      this.noProjectShown = true;
      return;
    }
    this.fit.fit();
    api.invoke('terminal:start', this.terminal.cols, this.terminal.rows).then(
      () => (this.started = true),
      // Shown in the terminal rather than as an error toast.
      (error) => this.terminal.write(`${error instanceof Error ? error.message.replace(/^.*Error: /, '') : error}\r\n`),
    );
  }

  private resize(): void {
    if (this.element.hidden || this.element.clientWidth === 0) return;
    this.fit.fit();
    if (this.started) void api.invoke('terminal:resize', this.terminal.cols, this.terminal.rows);
  }
}

type Webview = HTMLElement & {
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  openDevTools(): void;
  getURL(): string;
};

// Two pages in two sessions: the user's own browsing keeps its cookies and sign-ins, and the agent's browser tool loads
// pages in a separate in-memory session that never sees them. The panel shows the agent's page while the agent drives
// it, labelled so the user can tell which session they are looking at, and the user's again when they navigate.
class BrowserPanel implements Panel {
  readonly element = h('div', { class: 'browser-panel' });
  private readonly user = createWebview(USER_BROWSER_PARTITION, 'user');
  private readonly agent = createWebview(AGENT_BROWSER_PARTITION, 'agent');
  private showingAgent = false;
  private readonly address = h('input', {
    class: 'form-control form-control-sm',
    placeholder: 'http://localhost:3000',
    'aria-label': 'Address',
  });
  private readonly sessionButton = h('button', {
    class: 'icon-button',
    onclick: () => this.showSession(!this.showingAgent),
  });
  // Shown above the agent's page so it is never mistaken for the user's own browsing.
  private readonly agentBanner = h(
    'div',
    { class: 'browser-agent-banner', hidden: true },
    sym('smart_toy'),
    h('span', {}, h('strong', {}, 'Agent browser'), ': a separate session without your cookies or sign-ins'),
  );

  constructor() {
    for (const webview of [this.user, this.agent]) {
      const update = () => {
        if (webview === this.active()) this.address.value = this.url();
      };
      webview.addEventListener('did-navigate', update);
      webview.addEventListener('did-navigate-in-page', update);
    }
    // Only the main process navigates the agent's page: show it when the agent opens something, and go back to the
    // user's page when a new chat or project empties it.
    this.agent.addEventListener('did-start-navigation', (event) => {
      const { url, isMainFrame } = event as Event & { url: string; isMainFrame: boolean };
      if (isMainFrame) this.showSession(url !== 'about:blank');
    });

    this.address.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      let url = this.address.value.trim();
      if (!url) return;
      if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
      // Typing an address is the user browsing, in their own session.
      this.showSession(false);
      void this.user.loadURL(url).catch(() => {});
    });

    const button = (name: string, title: string, action: () => void) =>
      h('button', { class: 'icon-button', title, onclick: action }, sym(name));

    this.element.append(
      h(
        'div',
        { class: 'browser-toolbar' },
        button('arrow_back', 'Back', () => this.active().goBack()),
        button('arrow_forward', 'Forward', () => this.active().goForward()),
        button('refresh', 'Reload', () => this.active().reload()),
        this.address,
        this.sessionButton,
        button('bug_report', 'Developer tools', () => this.active().openDevTools()),
      ),
      this.agentBanner,
      h('div', { class: 'browser-views' }, this.user, this.agent),
    );
    this.showSession(false);
  }

  shown(): void {}

  projectChanged(): void {}

  private active(): Webview {
    return this.showingAgent ? this.agent : this.user;
  }

  private showSession(agent: boolean): void {
    this.showingAgent = agent;
    this.user.classList.toggle('inactive', agent);
    this.agent.classList.toggle('inactive', !agent);
    this.agentBanner.hidden = !agent;
    this.sessionButton.title = agent ? 'Show your browser' : "Show the agent's browser";
    this.sessionButton.replaceChildren(sym(agent ? 'person' : 'smart_toy'));
    this.address.value = this.url();
  }

  private url(): string {
    try {
      const url = this.active().getURL();
      return url === 'about:blank' ? '' : url;
    } catch {
      return '';
    }
  }
}

// Created with an isolated session partition. The main process strips Node access from the guest.
function createWebview(partition: string, name: string): Webview {
  const webview = document.createElement('webview') as Webview;
  webview.setAttribute('partition', partition);
  webview.setAttribute('src', 'about:blank');
  webview.className = 'browser-view';
  webview.dataset.session = name;
  return webview;
}

const STATUS_LETTERS: Record<GitFile['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C',
};

class GitPanel implements Panel {
  readonly element = h('div', { class: 'git-panel' });
  private readonly content = h('div', { class: 'git-content' });
  private readonly message = h('textarea', {
    class: 'git-message',
    rows: 3,
    placeholder: 'Commit message',
    'aria-label': 'Commit message',
  }) as HTMLTextAreaElement;
  private readonly generateButton = h(
    'button',
    {
      class: 'git-generate',
      title: 'Write a commit message for these changes with the small model',
      onclick: () => void this.generate(),
    },
    sym('auto_fix_high'),
    h('span', {}, 'Generate'),
  );
  private readonly commitButton = h('button', { class: 'git-commit', onclick: () => void this.commit() });
  private selected: string | null = null;
  private status: GitStatus | null = null;
  private hunks: DiffHunk[] = [];
  private hunk = 0;
  private refreshGeneration = 0;

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly onStatus: (status: GitStatus | null) => void,
  ) {
    this.message.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.commit();
      }
    });
    this.element.append(this.content);
  }

  shown(): void {
    void this.refresh();
  }

  projectChanged(): void {
    this.selected = null;
    this.message.value = '';
  }

  private async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    let status: GitStatus;
    try {
      status = await api.invoke('git:status');
    } catch {
      if (generation !== this.refreshGeneration) return;
      this.status = null;
      this.onStatus(null);
      setChildren(this.content, h('div', { class: 'git-empty' }, 'Open a project to see its changes.'));
      return;
    }
    if (generation !== this.refreshGeneration) return;
    this.status = status;
    this.onStatus(status);
    if (!status.isRepo) {
      setChildren(
        this.content,
        h(
          'div',
          { class: 'git-empty' },
          h('p', {}, 'This project is not a Git repository.'),
          h(
            'button',
            { class: 'btn btn-sm btn-outline-secondary', onclick: () => this.run(() => api.invoke('git:init')) },
            'Initialize repository',
          ),
        ),
      );
      return;
    }

    if (this.selected && !status.files.some((file) => file.path === this.selected)) this.selected = null;
    const diff = status.files.length ? await api.invoke('git:diff', this.selected).catch(() => '') : '';
    if (generation !== this.refreshGeneration) return;
    this.hunks = diffHunks(diff);
    this.hunk = Math.min(this.hunk, Math.max(0, this.hunks.length - 1));

    const changed = status.files.length;
    const pushOnly = changed === 0 && status.canPush && status.ahead > 0;
    this.commitButton.disabled = changed === 0 && !pushOnly;
    this.commitButton.replaceChildren(
      sym(status.canPush ? 'cloud_upload' : 'check'),
      h(
        'span',
        {},
        pushOnly
          ? `Push ${status.ahead} commit${status.ahead === 1 ? '' : 's'}`
          : status.canPush
            ? 'Commit & Push'
            : 'Commit all',
      ),
    );
    this.commitButton.title = status.canPush
      ? `Commit every change, then push to ${status.tracking ?? 'origin'} (Ctrl+Enter in the message)`
      : 'Commit every change (Ctrl+Enter in the message). The repository has no remote to push to.';
    this.generateButton.disabled = changed === 0;

    setChildren(
      this.content,
      h(
        'section',
        {},
        h(
          'div',
          { class: 'git-section-title' },
          h('span', {}, `CHANGED FILES (${changed})`),
          changed
            ? h(
                'button',
                {
                  class: 'git-link',
                  onclick: () => {
                    if (confirm(`Discard all ${changed} changes? New files are deleted. This cannot be undone.`))
                      this.run(() => api.invoke('git:discard-all'));
                  },
                },
                'Discard All',
              )
            : null,
        ),
        changed === 0
          ? h('div', { class: 'git-empty' }, 'No changes.')
          : h('div', { class: 'git-files' }, ...status.files.map((file) => this.fileRow(file))),
      ),
      changed ? this.diffPreview() : null,
      h(
        'section',
        { class: 'git-commit-box' },
        h('div', { class: 'git-section-title' }, h('span', {}, 'COMMIT MESSAGE'), this.generateButton),
        this.message,
        this.commitButton,
        h(
          'div',
          { class: 'git-branch' },
          h('span', {}, sym('fork_right', 'accent'), ` Branch: ${status.branch ?? 'detached'}`),
          changed
            ? h('span', { class: 'git-uncommitted' }, `● ${changed} uncommitted`)
            : h('span', {}, status.ahead ? `↑${status.ahead} to push` : 'clean'),
        ),
      ),
    );
  }

  private fileRow(file: GitFile): HTMLElement {
    const counts =
      file.added === undefined
        ? ''
        : `+${file.added}${file.removed ? ` -${file.removed}` : file.status === 'modified' ? ' -0' : ''}`;
    return h(
      'div',
      { class: `git-file${file.path === this.selected ? ' active' : ''}` },
      h(
        'button',
        {
          class: 'git-file-name',
          title: file.path,
          'aria-pressed': String(file.path === this.selected),
          onclick: () => this.select(file.path),
        },
        h(
          'span',
          { class: `git-status git-${file.status}`, title: file.status, 'aria-label': file.status },
          STATUS_LETTERS[file.status],
        ),
        h('span', { class: 'git-path' }, file.path),
      ),
      counts
        ? h('span', { class: 'git-counts', 'aria-label': `${file.added} added, ${file.removed} removed` }, counts)
        : null,
      h(
        'button',
        {
          class: 'git-discard',
          title: file.status === 'untracked' ? 'Delete new file' : 'Discard changes',
          onclick: () => {
            const verb = file.status === 'untracked' ? 'Delete the new file' : 'Discard all changes to';
            if (confirm(`${verb} ${file.path}?`)) this.run(() => api.invoke('git:discard', file.path));
          },
        },
        sym('undo'),
      ),
    );
  }

  // One hunk at a time, of the selected file or of all changes.
  private diffPreview(): HTMLElement {
    const hunk = this.hunks[this.hunk];
    const step = (by: number) => {
      this.hunk = (this.hunk + by + this.hunks.length) % this.hunks.length;
      const preview = this.content.querySelector('.git-diff');
      preview?.replaceWith(this.diffPreview());
    };
    return h(
      'section',
      { class: 'git-diff' },
      h('div', { class: 'git-section-title' }, h('span', {}, 'DIFF PREVIEW')),
      h(
        'div',
        { class: 'git-diff-box' },
        hunk
          ? h(
              'div',
              { class: 'git-diff-header' },
              h('span', { class: 'git-diff-file', title: hunk.file }, hunk.file.split('/').pop() ?? hunk.file),
              h(
                'span',
                { class: 'git-hunks' },
                this.hunks.length > 1
                  ? h(
                      'button',
                      { class: 'git-link', 'aria-label': 'Previous hunk', onclick: () => step(-1) },
                      sym('chevron_left'),
                    )
                  : null,
                `Hunk ${this.hunk + 1}/${this.hunks.length}`,
                this.hunks.length > 1
                  ? h(
                      'button',
                      { class: 'git-link', 'aria-label': 'Next hunk', onclick: () => step(1) },
                      sym('chevron_right'),
                    )
                  : null,
              ),
            )
          : h('div', { class: 'git-diff-header' }, h('span', {}, 'No textual changes.')),
        hunk
          ? h(
              'div',
              { class: 'git-diff-lines' },
              ...hunk.lines.map((line) =>
                h(
                  'div',
                  {
                    class: `git-diff-line${line.startsWith('+') ? ' add' : line.startsWith('-') ? ' del' : ''}`,
                    title: line,
                  },
                  line || ' ',
                ),
              ),
            )
          : null,
      ),
    );
  }

  private select(path: string): void {
    this.selected = this.selected === path ? null : path;
    this.hunk = 0;
    void this.refresh();
  }

  private async generate(): Promise<void> {
    this.generateButton.disabled = true;
    this.generateButton.classList.add('busy');
    try {
      this.message.value = await api.invoke('git:suggest-message');
      this.message.focus();
    } catch (error) {
      this.onError(error);
    } finally {
      this.generateButton.classList.remove('busy');
      this.generateButton.disabled = !this.status?.files.length;
    }
  }

  private async commit(): Promise<void> {
    const status = this.status;
    if (!status?.isRepo) return;
    const pushOnly = status.files.length === 0 && status.canPush && status.ahead > 0;
    const message = this.message.value.trim();
    if (!pushOnly && !message) {
      this.message.focus();
      return;
    }
    this.commitButton.disabled = true;
    try {
      if (!pushOnly) {
        await api.invoke('git:commit', message);
        this.message.value = '';
      }
      if (status.canPush) {
        try {
          await api.invoke('git:push');
        } catch (error) {
          const reason =
            error instanceof Error
              ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
              : String(error);
          this.onError(pushOnly ? `Push failed: ${reason}` : `Committed, but the push failed: ${reason}`);
        }
      }
    } catch (error) {
      this.onError(error);
    }
    void this.refresh();
  }

  private run(action: () => Promise<unknown>): void {
    action().then(
      () => void this.refresh(),
      (error) => this.onError(error),
    );
  }
}
