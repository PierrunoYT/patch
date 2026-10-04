import { filterChats, type ChatSummary } from '@shared/chat';
import {
  formatCost,
  MODEL_OPTIONS,
  type Effort,
  type SubagentEffortChoice,
  type SubagentModelChoice,
} from '@shared/models';
import { describeIndexStatus } from '@shared/index_status';
import type { IndexStatus, McpStatus } from '@shared/ipc';
import type { ProjectInfo, ProjectSettings } from '@shared/project';
import type { ChatGptAccountView, SecretName, Settings, SettingsView } from '@shared/settings';
import { parseMcpServers, parsePermissionRules, type McpServerView } from '@shared/settings';
import { h, icon } from '../dom';

function dialog(title: string, body: HTMLElement, footer: HTMLElement): HTMLDialogElement {
  const titleId = `dialog-title-${Math.random().toString(36).slice(2)}`;
  const element = h(
    'dialog',
    { class: 'app-dialog', 'aria-labelledby': titleId },
    h(
      'form',
      { method: 'dialog', class: 'dialog-content' },
      h(
        'div',
        { class: 'dialog-header' },
        h('h2', { id: titleId, class: 'h5 m-0' }, title),
        h('button', { class: 'btn-close', type: 'button', 'aria-label': 'Close', onclick: () => element.close() }),
      ),
      h('div', { class: 'dialog-body' }, body),
      h('div', { class: 'dialog-footer' }, footer),
    ),
  );
  element.addEventListener('close', () => element.remove());
  document.body.appendChild(element);
  element.showModal();
  return element;
}

function field(label: string, control: HTMLElement, help?: string): HTMLElement {
  const id = `field-${Math.random().toString(36).slice(2)}`;
  // The label must point at the input itself, which may be wrapped (e.g. in an input group).
  const target = control.matches('input, select, textarea')
    ? control
    : control.querySelector('input, select, textarea');
  (target ?? control).id = id;
  return h(
    'div',
    { class: 'mb-3' },
    h('label', { class: 'form-label', for: id }, label),
    control,
    help ? h('div', { class: 'form-text' }, help) : null,
  );
}

const SECRET_LABELS: Record<SecretName, [string, string]> = {
  anthropicApiKey: ['Anthropic API key', 'Needed for Claude models.'],
  openaiApiKey: [
    'OpenAI API key',
    'Used for official OpenAI models when you are signed out, and for a custom base URL.',
  ],
  openrouterApiKey: [
    'OpenRouter API key',
    'Optional, for semantic code search: project files are embedded with Voyage voyage-code-4 through OpenRouter.',
  ],
  googleApiKey: ['Google API key', 'Optional, for web search. Also set the search engine id below.'],
};

export interface SettingsDialogActions {
  update(patch: Partial<Settings>): Promise<SettingsView>;
  setSecret(name: SecretName, value: string): Promise<SettingsView>;
  signInChatGpt(): Promise<SettingsView>;
  signOutChatGpt(): Promise<SettingsView>;
  indexStatus(): Promise<IndexStatus>;
  rebuildIndex(): Promise<IndexStatus>;
  mcpStatus(): Promise<McpStatus[]>;
}

export function openSettingsDialog(settings: SettingsView, actions: SettingsDialogActions): void {
  const secretInputs = new Map<SecretName, HTMLInputElement>();
  const secretFields = (Object.keys(SECRET_LABELS) as SecretName[]).map((name) => {
    const [label, help] = SECRET_LABELS[name];
    const input = h('input', {
      type: 'password',
      class: 'form-control',
      autocomplete: 'off',
      placeholder: settings.secrets[name] ? 'Saved. Enter a new key to replace it.' : 'Not set',
    });
    secretInputs.set(name, input);
    const remove = settings.secrets[name]
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline-danger',
            onclick: async () => {
              await actions.setSecret(name, '');
              input.placeholder = 'Not set';
              remove?.remove();
            },
          },
          'Remove',
        )
      : null;
    return field(label, h('div', { class: 'input-group' }, input, remove), help);
  });

  const known = MODEL_OPTIONS.some((option) => option.id === settings.model);
  const modelSelect = h(
    'select',
    { class: 'form-select' },
    ...MODEL_OPTIONS.map((option) =>
      h('option', { value: option.id, selected: option.id === settings.model }, option.label),
    ),
    h('option', { value: '__custom', selected: !known }, 'Other model id…'),
  );
  const customModel = h('input', {
    class: 'form-control mt-2',
    value: known ? '' : settings.model,
    placeholder: 'e.g. claude-sonnet-5-5',
    hidden: known,
  });
  modelSelect.addEventListener('change', () => (customModel.hidden = modelSelect.value !== '__custom'));

  const effort = h(
    'select',
    { class: 'form-select' },
    ...(['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((level) =>
      h('option', { value: level, selected: level === settings.effort }, level),
    ),
  );
  const subagentModel = h(
    'select',
    { class: 'form-select' },
    h('option', { value: 'same', selected: settings.subagentModel === 'same' }, 'Same as chat'),
    h('option', { value: 'mid', selected: settings.subagentModel === 'mid' }, 'Mid-size'),
    h('option', { value: 'small', selected: settings.subagentModel === 'small' }, 'Small'),
  );
  const subagentEffort = h(
    'select',
    { class: 'form-select' },
    h('option', { value: 'match', selected: settings.subagentEffort === 'match' }, 'Match chat'),
    h('option', { value: 'scaled', selected: settings.subagentEffort === 'scaled' }, 'Lower for lookups'),
  );
  const approval = h(
    'select',
    { class: 'form-select' },
    h('option', { value: 'ask', selected: settings.approvalMode === 'ask' }, 'Ask before edits and commands'),
    h('option', { value: 'auto', selected: settings.approvalMode === 'auto' }, 'Run edits and commands without asking'),
  );
  const planMode = h('input', { type: 'checkbox', class: 'form-check-input', checked: settings.planMode });
  const keepCacheWarm = h('input', {
    type: 'checkbox',
    class: 'form-check-input',
    checked: settings.keepCacheWarm,
    'aria-label': 'Keep the prompt cache warm while a chat is idle',
  });
  const allowedCommands = h('textarea', {
    class: 'form-control font-monospace',
    rows: 4,
    value: settings.allowedCommands,
    placeholder: 'npm test\nnpm run lint\ngit status',
  });
  const allowedNetworkHosts = h('textarea', {
    class: 'form-control font-monospace',
    rows: 4,
    value: settings.allowedNetworkHosts,
    placeholder: 'api.example.com\nlocalhost',
  });
  const sandboxMode = h(
    'select',
    { class: 'form-select' },
    h('option', { value: 'auto', selected: settings.sandboxMode === 'auto' }, 'Automatic (native OS sandbox)'),
    h(
      'option',
      { value: 'container', selected: settings.sandboxMode === 'container' },
      'Always in a Docker or Podman container',
    ),
    h('option', { value: 'off', selected: settings.sandboxMode === 'off' }, 'Off: commands run with your full rights'),
  );
  const sandboxNetwork = h(
    'select',
    { class: 'form-select' },
    h('option', { value: 'off', selected: settings.sandboxNetwork === 'off' }, 'Off'),
    h(
      'option',
      { value: 'allow-list', selected: settings.sandboxNetwork === 'allow-list' },
      'Ask for network when command URLs match allowed hosts',
    ),
    h('option', { value: 'on', selected: settings.sandboxNetwork === 'on' }, 'On'),
  );
  const sandboxImage = h('input', {
    class: 'form-control font-monospace',
    value: settings.sandboxImage,
    placeholder: 'node:lts',
  });
  const theme = h(
    'select',
    { class: 'form-select' },
    h('option', { value: 'dark', selected: settings.theme === 'dark' }, 'Dark'),
    h('option', { value: 'light', selected: settings.theme === 'light' }, 'Light'),
  );
  const baseUrl = h('input', {
    class: 'form-control',
    value: settings.openaiBaseUrl,
    placeholder: 'https://api.openai.com/v1',
  });
  const anthropicBaseUrl = h('input', {
    class: 'form-control',
    value: settings.anthropicBaseUrl,
    placeholder: 'https://api.anthropic.com',
  });
  const searchEngine = h('input', { class: 'form-control', value: settings.googleSearchEngineId });
  const editor = h('input', { class: 'form-control', value: settings.editorCommand });
  const maxFiles = h('input', {
    class: 'form-control',
    type: 'number',
    min: 1,
    value: String(settings.maxIndexedFiles),
  });
  const error = h('div', { class: 'text-danger me-auto small' });
  const chatgptStatus = h('div', { class: 'd-flex align-items-center gap-2 flex-wrap' });
  // The dialog's settings snapshot is not updated after sign-in or sign-out. Keep the last status the main process returned.
  let chatgptAccount = settings.chatgpt;
  const showChatGpt = (account: ChatGptAccountView) => {
    chatgptAccount = account;
    chatgptStatus.replaceChildren(
      ...(account.signedIn
        ? [
            h('span', {}, account.accountLabel ? `Signed in as ${account.accountLabel}` : 'Signed in with ChatGPT'),
            h(
              'button',
              { type: 'button', class: 'btn btn-outline-danger btn-sm', onclick: () => void signOut() },
              'Sign out',
            ),
          ]
        : [
            h(
              'button',
              { type: 'button', class: 'btn btn-outline-primary btn-sm', onclick: () => void signIn() },
              'Sign in with ChatGPT',
            ),
          ]),
    );
  };
  const signIn = async () => {
    error.textContent = '';
    chatgptStatus.replaceChildren(h('span', { class: 'small text-body-secondary' }, 'Waiting for the browser…'));
    try {
      const next = await actions.signInChatGpt();
      showChatGpt(next.chatgpt);
    } catch (err) {
      showChatGpt(chatgptAccount);
      error.textContent = err instanceof Error ? err.message : String(err);
    }
  };
  const signOut = async () => {
    error.textContent = '';
    try {
      const next = await actions.signOutChatGpt();
      showChatGpt(next.chatgpt);
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
    }
  };
  showChatGpt(settings.chatgpt);

  const indexText = h('span', { class: 'small text-body-secondary flex-grow-1' }, 'Checking…');
  const reindex = h('button', { type: 'button', class: 'btn btn-outline-secondary btn-sm', disabled: true }, 'Reindex');
  // While an update runs (a rebuild, or one started by a code search), poll the status to show its progress.
  let poll: ReturnType<typeof setInterval> | undefined;
  const stopPolling = () => {
    clearInterval(poll);
    poll = undefined;
  };
  const startPolling = () => {
    poll ??= setInterval(() => void actions.indexStatus().then(showIndex, () => {}), 1000);
  };
  const showIndex = (status: IndexStatus) => {
    indexText.textContent = describeIndexStatus(status);
    reindex.disabled = !status.available || status.indexing;
    if (status.indexing) startPolling();
    else stopPolling();
  };
  reindex.addEventListener('click', async () => {
    reindex.disabled = true;
    indexText.textContent = 'Indexing… scanning files';
    startPolling();
    try {
      showIndex(await actions.rebuildIndex());
    } catch (err) {
      stopPolling();
      indexText.textContent = `Indexing failed: ${err instanceof Error ? err.message : String(err)}`;
      reindex.disabled = false;
    }
  });
  actions.indexStatus().then(showIndex, () => (indexText.textContent = 'Status unavailable'));
  const indexSection = h(
    'div',
    { class: 'mb-3' },
    h('div', { class: 'form-label' }, 'Code index (current project)'),
    h('div', { class: 'd-flex align-items-center gap-2' }, indexText, reindex),
  );

  const permissionRules = h('textarea', {
    class: 'form-control font-monospace',
    rows: 4,
    value: settings.permissionRules.length > 0 ? JSON.stringify(settings.permissionRules, null, 2) : '',
    placeholder: '[{"tool":"run_command","matches":{"command":"git push*"},"action":"reject","message":"no pushing"}]',
  });
  const mcpServers = h('textarea', {
    class: 'form-control font-monospace',
    rows: 4,
    value: mcpServersForEditing(settings.mcpServers),
    placeholder: '[{"name":"docs","transport":"http","url":"https://example.com/mcp"}]',
  });
  const mcpStatusText = h('span', { class: 'small text-body-secondary flex-grow-1' }, 'Checking…');
  actions.mcpStatus().then(
    (statuses) => {
      mcpStatusText.textContent = describeMcpStatus(statuses);
    },
    () => {
      mcpStatusText.textContent = 'Status unavailable';
    },
  );
  const mcpSection = h(
    'div',
    { class: 'mb-3' },
    h('div', { class: 'form-label' }, 'MCP servers'),
    mcpServers,
    h('div', { class: 'mt-1' }, mcpStatusText),
  );

  const body = h(
    'div',
    {},
    h('h3', { class: 'h6 text-body-secondary' }, 'API keys'),
    h(
      'div',
      { class: 'mb-3' },
      h('div', { class: 'form-label' }, 'ChatGPT'),
      chatgptStatus,
      h(
        'div',
        { class: 'form-text' },
        'Sign in with ChatGPT to use official OpenAI models on your subscription. Sign out to use the API key instead. A custom base URL always uses the API key. Semantic code search still needs an OpenAI API key.',
      ),
    ),
    !settings.secretsEncrypted
      ? h(
          'div',
          { class: 'alert alert-warning py-2 small' },
          'Keys are stored unencrypted. System encryption may be unavailable or migration may have failed.',
        )
      : null,
    ...secretFields,
    h('h3', { class: 'h6 text-body-secondary mt-4' }, 'Assistant'),
    field('Model', h('div', {}, modelSelect, customModel)),
    field(
      'Effort',
      effort,
      'How much the model thinks before acting (current Claude and OpenAI models). Higher is slower and costs more.',
    ),
    field(
      'Subagent model',
      subagentModel,
      'task uses this model. oracle stays on the chat model. finder stays on the small model. A custom OpenAI base URL keeps the chat model.',
    ),
    field(
      'Subagent effort',
      subagentEffort,
      'Lower for lookups uses low for finder and medium for task. oracle keeps the chat effort.',
    ),
    field('Approvals', approval),
    field(
      'Plan mode',
      h(
        'div',
        { class: 'form-check' },
        planMode,
        h('label', { class: 'form-check-label' }, 'Propose a plan before multi-step changes'),
      ),
      'The assistant shows what it intends to do as an approval card before changing files or running commands. The card still appears in Auto mode. Approving lets the work begin; declining with a note sends that note back, and declining with nothing stops the task.',
    ),
    field(
      'Prompt cache',
      h(
        'div',
        { class: 'form-check' },
        keepCacheWarm,
        h('label', { class: 'form-check-label' }, 'Keep the prompt cache warm while a chat is idle'),
      ),
      'Claude chats only. After an answer, Patch re-sends the chat about every 4 minutes for up to an hour, without generating anything, so a reply after a pause reads the cache instead of writing the whole chat again. Each keep-alive costs a cache read (about $0.02 for a 100k-token chat on Claude Opus 5.5) and counts toward the chat cost.',
    ),
    field(
      'Commands allowed without asking',
      allowedCommands,
      'One per line, used in "Ask" mode. "npm test" also allows "npm test -- foo". Commands with ; & | > < ` $ ( ) { } or a line break are always asked about. File edits are always asked about.',
    ),
    field(
      'Network hosts allowed without asking',
      allowedNetworkHosts,
      'Exact URL hostnames, one per line, used in "Ask" mode. Subdomains must be listed separately.',
    ),
    field(
      'Permission rules (JSON)',
      permissionRules,
      'Rules decide tool calls before the normal approval: action "allow", "reject", "ask" (also in Auto mode) or "delegate" (a program in "to" answers allow, reject or ask). "tool" and the "matches" values are globs on the tool name and its input, e.g. {"tool":"run_command","matches":{"command":"git push*"},"action":"reject"}. The first matching rule wins. Allow and delegate rules ask for confirmation when saved.',
    ),
    h('h3', { class: 'h6 text-body-secondary mt-4' }, 'Command sandbox'),
    field(
      'Run commands in a sandbox',
      sandboxMode,
      'Applies to run_command and background commands. Automatic mode uses AppContainer on Windows (bundled helper), bubblewrap on Linux, or Seatbelt on macOS. Commands do not run when the selected sandbox is unavailable; the agent must request unsandboxed access for one run. Only the project and temporary folders are writable, and private home files are hidden. The terminal panel and MCP servers are not sandboxed.',
    ),
    field(
      'Network in the sandbox',
      sandboxNetwork,
      'Matching command URLs request unrestricted network access, not hostname filtering. You must approve each run, even in Auto mode or with an allow permission rule. Explicit network or unsandboxed requests also require approval each time. On grants unrestricted network access to all sandboxed commands.',
    ),
    field(
      'Container image',
      sandboxImage,
      'Used by the container option. It must contain the tools your commands need.',
    ),
    h('h3', { class: 'h6 text-body-secondary mt-4' }, 'Other'),
    field('Theme', theme),
    field('Editor command', editor, 'Opens files from the chat, e.g. code, cursor, subl.'),
    field('OpenAI-compatible base URL', baseUrl, 'Leave empty for api.openai.com.'),
    field(
      'Claude base URL',
      anthropicBaseUrl,
      'Leave empty for api.anthropic.com. For a proxy or gateway that serves the Anthropic Messages API, including the beta features Patch uses (compaction, refusal fallback, prompt caching). Your Anthropic API key is sent to it, so setting it asks for confirmation. Chats on a custom URL get no official-price estimate.',
    ),
    field('Google search engine id', searchEngine),
    field('Maximum files to index for code search', maxFiles),
    indexSection,
    field(
      'MCP servers (JSON)',
      mcpSection,
      'Model Context Protocol servers whose tools the agent may use (they always ask for approval). Stdio example: {"name":"fs","transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}.',
    ),
  );

  const save = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save');
  const element = dialog(
    'Settings',
    body,
    h(
      'div',
      { class: 'd-flex w-100 align-items-center gap-2' },
      error,
      h('button', { type: 'button', class: 'btn btn-outline-secondary', onclick: () => element.close() }, 'Cancel'),
      save,
    ),
  );
  element.addEventListener('close', stopPolling);

  save.addEventListener('click', async () => {
    try {
      for (const [name, input] of secretInputs) {
        if (input.value.trim()) await actions.setSecret(name, input.value);
      }
      const model = modelSelect.value === '__custom' ? customModel.value.trim() : modelSelect.value;
      await actions.update({
        model,
        effort: effort.value as Effort,
        subagentModel: subagentModel.value as SubagentModelChoice,
        subagentEffort: subagentEffort.value as SubagentEffortChoice,
        approvalMode: approval.value as Settings['approvalMode'],
        planMode: planMode.checked,
        keepCacheWarm: keepCacheWarm.checked,
        allowedCommands: allowedCommands.value.trim(),
        allowedNetworkHosts: allowedNetworkHosts.value.trim(),
        sandboxMode: sandboxMode.value as Settings['sandboxMode'],
        sandboxNetwork: sandboxNetwork.value as Settings['sandboxNetwork'],
        sandboxImage: sandboxImage.value.trim(),
        theme: theme.value as Settings['theme'],
        openaiBaseUrl: baseUrl.value.trim(),
        anthropicBaseUrl: anthropicBaseUrl.value.trim(),
        googleSearchEngineId: searchEngine.value.trim(),
        editorCommand: editor.value.trim(),
        maxIndexedFiles: Number(maxFiles.value),
        mcpServers: parseMcpServers(mcpServers.value),
        permissionRules: parsePermissionRules(permissionRules.value),
      });
      element.close();
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
    }
  });
}

// Instructions and the project's own allow-lists. The lists add to the global ones in Settings.
export function openProjectSettingsDialog(
  project: ProjectInfo,
  save: (settings: ProjectSettings) => Promise<unknown>,
): void {
  const instructions = h('textarea', { class: 'form-control font-monospace', rows: 8, value: project.instructions });
  const allowedCommands = h('textarea', {
    class: 'form-control font-monospace',
    rows: 3,
    value: project.allowedCommands ?? '',
    placeholder: 'npm test\ncargo check',
  });
  const allowedNetworkHosts = h('textarea', {
    class: 'form-control font-monospace',
    rows: 3,
    value: project.allowedNetworkHosts ?? '',
    placeholder: 'localhost\napi.example.com',
  });
  const error = h('div', { class: 'text-danger me-auto small' });
  const button = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save');
  const element = dialog(
    `Project settings for ${project.name}`,
    h(
      'div',
      {},
      field(
        'Instructions',
        instructions,
        'Added to every new chat in this project, e.g. commands to run tests, coding conventions or things to avoid.',
      ),
      h(
        'p',
        { class: 'small text-body-secondary mt-3 mb-2' },
        'For this project only, in addition to the lists in Settings. Same rules: one per line, used in "Ask" mode. These are kept with your app data, not in the project, so a repository cannot allow its own commands.',
      ),
      field(
        'Commands allowed without asking',
        allowedCommands,
        '"npm test" also allows "npm test -- foo". Commands with ; & | > < ` $ ( ) { } or a line break are always asked about.',
      ),
      field(
        'Network hosts allowed without asking',
        allowedNetworkHosts,
        'Exact URL hostnames. Subdomains must be listed separately.',
      ),
    ),
    h('div', { class: 'd-flex w-100 align-items-center gap-2' }, error, button),
  );
  button.addEventListener('click', async () => {
    try {
      await save({
        instructions: instructions.value,
        allowedCommands: allowedCommands.value.trim(),
        allowedNetworkHosts: allowedNetworkHosts.value.trim(),
      });
      element.close();
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
    }
  });
}

export interface HistoryDialogActions {
  open(id: string): Promise<void>;
  delete(id: string): Promise<ChatSummary[]>;
  clear(): Promise<ChatSummary[]>;
  // Also searches the messages, not only titles and projects.
  search(query: string): Promise<ChatSummary[]>;
}

const SEARCH_DELAY_MS = 250;

export function openHistoryDialog(chats: ChatSummary[], actions: HistoryDialogActions): void {
  const list = h('div', { class: 'list-group history-list' });
  const search = h('input', {
    type: 'search',
    class: 'form-control mb-2',
    placeholder: 'Search chats by title, project or message',
    'aria-label': 'Search chats',
  }) as HTMLInputElement;
  let all = chats;
  // Result of the last message search for the current query; until it arrives, titles and projects are filtered here.
  let found: ChatSummary[] | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchGeneration = 0;
  const render = (items: ChatSummary[]) => {
    all = items;
    const query = search.value.trim();
    const shown = query && found ? found : filterChats(items, query);
    list.replaceChildren(
      ...(shown.length === 0
        ? [
            h(
              'div',
              { class: 'text-body-secondary p-3' },
              items.length === 0 ? 'No saved chats yet.' : 'No chats match your search.',
            ),
          ]
        : shown.map((chat) =>
            h(
              'div',
              { class: 'list-group-item list-group-item-action d-flex align-items-center gap-2' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-link text-start text-decoration-none flex-grow-1 p-0 text-body',
                  onclick: async () => {
                    await actions.open(chat.id);
                    element.close();
                  },
                },
                h('div', { class: 'fw-semibold text-truncate' }, chat.title),
                h(
                  'div',
                  { class: 'small text-body-secondary text-truncate' },
                  `${new Date(chat.updatedAt).toLocaleString()}${chat.projectPath ? ` · ${chat.projectPath}` : ''}`,
                ),
                typeof chat.cost === 'number'
                  ? h(
                      'div',
                      { class: 'small text-body-secondary', title: 'Estimated from official list prices.' },
                      `≈ ${formatCost(chat.cost)}`,
                    )
                  : null,
                chat.snippet
                  ? h('div', { class: 'small fst-italic text-body-secondary text-truncate' }, chat.snippet)
                  : null,
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-sm btn-outline-secondary',
                  title: 'Delete',
                  onclick: async () => {
                    found = null;
                    render(await actions.delete(chat.id));
                    scheduleSearch();
                  },
                },
                icon('trash'),
              ),
            ),
          )),
    );
  };
  const scheduleSearch = () => {
    clearTimeout(searchTimer);
    const query = search.value.trim();
    if (!query) return;
    const generation = ++searchGeneration;
    searchTimer = setTimeout(async () => {
      try {
        const results = await actions.search(query);
        // Ignore an answer for a query the user has already changed.
        if (generation !== searchGeneration) return;
        found = results;
        render(all);
      } catch {
        // Keep the title and project filter if the message search fails.
      }
    }, SEARCH_DELAY_MS);
  };
  search.addEventListener('input', () => {
    found = null;
    searchGeneration++;
    render(all);
    scheduleSearch();
  });
  // The dialog is a form: Enter in the search box must not submit it and close the dialog.
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.preventDefault();
  });
  render(chats);
  const clearButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-danger',
      onclick: async () => {
        if (!confirm('Delete all saved chats?')) return;
        found = null;
        render(await actions.clear());
      },
    },
    icon('trash'),
    ' Delete all',
  );
  const element = dialog('Chat history', h('div', {}, search, list), clearButton);
  element.addEventListener('close', () => clearTimeout(searchTimer));
  search.focus();
}

// The renderer never sees secret values, only their names. Show each stored key with an empty value so saving keeps
// it; a key the user deletes is removed, and a value they type replaces the stored one.
function mcpServersForEditing(servers: McpServerView[]): string {
  const editable = servers.map((server) => ({
    name: server.name,
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args ? { args: server.args } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.envKeys.length > 0 ? { env: Object.fromEntries(server.envKeys.map((key) => [key, ''])) } : {}),
    ...(server.headerKeys.length > 0 ? { headers: Object.fromEntries(server.headerKeys.map((key) => [key, ''])) } : {}),
  }));
  return JSON.stringify(editable, null, 2);
}

// One line per server for the settings dialog: "docs: connected — 3 tools" or the error.
function describeMcpStatus(statuses: McpStatus[]): string {
  if (statuses.length === 0) return 'No MCP servers configured.';
  return statuses
    .map((server) => {
      const state =
        server.state === 'connected'
          ? `connected — ${server.tools.length} tool(s)`
          : server.state === 'connecting'
            ? 'connecting…'
            : server.state === 'disabled'
              ? 'disabled'
              : `error: ${server.error ?? 'unknown'}`;
      return `${server.name}: ${state}`;
    })
    .join(' | ');
}
