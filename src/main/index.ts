import { app, BrowserWindow, crashReporter, dialog, safeStorage, session, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT_BROWSER_PARTITION, BROWSER_PARTITIONS } from '@shared/panels';
import { SECRET_NAMES } from '@shared/settings';
import { ToolErrorLog } from './agent/tool_error_log';
import { EditBackups } from './tools/edit_backups';
import { appLog, logNativeCrashDumps } from './app_log';
import { ChatManager } from './chat_manager';
import { ChatStore } from './chat_store';
import { chatToMarkdown, exportFileName } from '@shared/export';
import { openInEditor, pickImages, saveTextFile } from './files';
import { handle, send } from './ipc';
import { LlmService } from './llm';
import { signInWithChatGpt, signOutChatGpt } from './llm/codex_auth';
import { setPackagedBuild } from './llm/endpoints';
import {
  CodeIndex,
  embeddingSettingsKey,
  openRouterEmbedder,
  openRouterReranker,
  searchCodeTool,
} from './search/code_index';
import { buildMenu } from './menu';
import { ProjectStore } from './projects';
import { RendererErrorReporter } from './renderer_errors';
import { SettingsStore } from './settings';
import { removeStaleTempFiles } from './storage/json_file';
import { changesToConfirm, projectChangesToConfirm } from './settings_confirm';
import { launchConfig, McpHub, resolveCommand } from './tools/mcp';
import { releaseProjectGrant } from './tools/sandbox_windows';
import { commandStopsSettled } from './tools/shell';
import { Workspace } from './tools/workspace';
import type { IndexStatus } from '@shared/ipc';
import { BrowserService } from './panels/browser';
import { suggestCommitMessage } from './panels/commit_message';
import { GitService } from './panels/git';
import { TerminalService } from './panels/terminal';
import { createMainWindow } from './window';
import { hardenExecutableSearch } from './exec_search';

// Before anything is spawned: bare program names (git, powershell.exe, docker) must never resolve to a file in the
// project folder (#141).
const droppedPathEntries = hardenExecutableSearch();

// Files offered for @-mentions in the composer; a larger project lists the first ones, breadth first.
const MAX_MENTION_FILES = 20_000;

app.setName('Patch');

// Test hooks for API endpoints (PATCH_TEST_*) work in development builds only (#64).
setPackagedBuild(app.isPackaged);

app.setPath('userData', process.env.PATCH_USER_DATA || join(app.getPath('appData'), 'Patch'));

// Crashes and other problems go to a local log (never sent anywhere). Set up before anything else can fail.
const userDataPath = app.getPath('userData');
const logsPath = join(userDataPath, 'logs');
appLog.setFile(join(logsPath, 'app.log.jsonl'));
// JavaScript cannot handle a native main-process exception such as a Chromium assertion. Crashpad writes a local
// minidump before the process exits; a later launch records it in the ordinary log. Reports never leave the machine.
crashReporter.start({ productName: 'Patch', uploadToServer: false });
logNativeCrashDumps(appLog, app.getPath('crashDumps'), join(logsPath, 'native-crashes.json'));
if (droppedPathEntries > 0) {
  appLog.warn('exec', 'Ignored PATH entries that depend on the working directory.', { count: droppedPathEntries });
}
process.on('uncaughtException', (error) => {
  appLog.error('uncaught-exception', error);
  // A listener replaces Electron's own error dialog, so keep telling the user.
  dialog.showErrorBox('Patch hit an unexpected error', error instanceof Error ? error.message : String(error));
});
process.on('unhandledRejection', (reason) => appLog.error('unhandled-rejection', reason));
app.on('render-process-gone', (_event, _contents, details) =>
  appLog.error('render-process-gone', `The UI process ended: ${details.reason}`, { exitCode: details.exitCode }),
);
app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'clean-exit') {
    appLog.error('child-process-gone', `A ${details.type} process ended: ${details.reason}`, {
      exitCode: details.exitCode,
    });
  }
});

// End-to-end tests run in an invisible window (see window.ts). Chromium would treat it as hidden or covered and slow
// its timers and rendering, which makes tests time out, so that is switched off for test runs only.
if (process.env.PATCH_E2E_QUIET === '1') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

let mainWindow: BrowserWindow | null = null;

function createSettings(): SettingsStore {
  return new SettingsStore(join(app.getPath('userData'), 'settings.json'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64')),
  });
}

let quitting = false;

// Closing or removing a project ends its lasting Windows sandbox grant (#103); quitting keeps it for next time.
function revokeSandboxGrant(project: string): void {
  void releaseProjectGrant(project).then((released) => {
    if (!released) appLog.warn('sandbox', 'A closed project kept its sandbox grant.');
  });
}

function start(): void {
  appLog.info('app', 'Started.', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
  });
  const userData = app.getPath('userData');
  // Temporary files that a crash left between writing a JSON file and moving it into place (#124).
  for (const dir of [userData, join(userData, 'chats'), join(userData, 'indexes')]) removeStaleTempFiles(dir);
  const settings = createSettings();
  const projects = new ProjectStore(join(userData, 'projects.json'));
  const chats = new ChatStore(join(userData, 'chats'));
  const editBackups = new EditBackups(join(userData, 'edit-backups'));
  const toolErrorLog = new ToolErrorLog(join(userData, 'logs', 'tool-input-errors.jsonl'));
  const llm = new LlmService(settings);
  // The agent browses in its own in-memory session, never the user's persistent one (#148).
  const agentBrowserSession = session.fromPartition(AGENT_BROWSER_PARTITION);
  const browser = new BrowserService(
    () => send(mainWindow, 'panel:show', 'browser'),
    async () => {
      await agentBrowserSession.clearStorageData();
      await agentBrowserSession.clearCache();
      await agentBrowserSession.clearAuthCache();
    },
  );
  // Both panel sessions filter requests the same way.
  for (const name of BROWSER_PARTITIONS) {
    session
      .fromPartition(name)
      .webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) =>
        callback({ cancel: !browser.allowsRequest(details.url) }),
      );
  }
  // A new chat or project gets an empty agent browser. The app starts with one anyway: its session is not saved.
  const resetAgentBrowser = () => void browser.reset().catch((error: unknown) => appLog.warn('browser', error));
  const terminal = new TerminalService(
    (data) => send(mainWindow, 'terminal:data', data),
    () => send(mainWindow, 'terminal:exit', null),
  );
  // One service per project, so its filter-driver list is read once rather than on every panel call (#199).
  const gitServices = new Map<string, GitService>();
  const git = () => {
    const project = projects.current();
    if (!project) throw new Error('No project is open.');
    let service = gitServices.get(project.path);
    if (!service) {
      service = new GitService(project.path);
      gitServices.set(project.path, service);
    }
    return service;
  };
  const forgetClosedGitServices = () => {
    const open = new Set(projects.opened().map((project) => project.path));
    for (const path of gitServices.keys()) if (!open.has(path)) gitServices.delete(path);
  };
  const codeIndexes = new Map<string, CodeIndex>();
  // A changed key means a new embedding client; drop cached indexes so they are rebuilt with it. Other changes keep
  // them, so a running update is not orphaned and duplicated by a second index of the same project.
  let embeddingKey = embeddingSettingsKey(settings);
  settings.on('change', () => {
    const next = embeddingSettingsKey(settings);
    if (next === embeddingKey) return;
    embeddingKey = next;
    codeIndexes.clear();
  });

  const mcpDir = join(userData, 'mcp');
  mkdirSync(mcpDir, { recursive: true });
  const mcpServers = () =>
    settings.mcpServers().map((server) => launchConfig(server, projects.current()?.path, mcpDir));
  let appliedMcpConfig = '';
  const mcp = new McpHub(mcpServers, () => send(mainWindow, 'app:notice', 'MCP servers updated'));
  // Not awaited: connections happen in the background and the tool list refreshes when they settle.
  const refreshMcp = () => {
    const next = JSON.stringify(mcpServers());
    if (next === appliedMcpConfig) return;
    appliedMcpConfig = next;
    mcp.start();
  };
  refreshMcp();
  // Only a real change reconnects and notifies. A theme toggle or an API key edit does not, and a project switch
  // reconnects only the servers whose args or env use ${project}.
  settings.on('change', refreshMcp);

  const indexFor = (workspace: Workspace): CodeIndex | null => {
    // Embeddings go through OpenRouter, so semantic search is offered only when that key is set.
    const key = settings.getSecret('openrouterApiKey');
    if (!key) return null;
    let index = codeIndexes.get(workspace.root);
    if (!index) {
      const embedder = openRouterEmbedder(key);
      index = new CodeIndex(
        workspace,
        embedder,
        join(userData, 'indexes'),
        () => settings.get().maxIndexedFiles,
        openRouterReranker(key),
      );
      codeIndexes.set(workspace.root, index);
    }
    return index;
  };
  const indexStatus = (index: CodeIndex | null, reason?: string): IndexStatus =>
    index
      ? {
          available: true,
          indexed: index.fileCount > 0,
          indexing: index.isUpdating,
          progress: index.updateProgress,
          files: index.fileCount,
          chunks: index.chunkCount,
        }
      : { available: false, reason, indexed: false, indexing: false, progress: null, files: 0, chunks: 0 };
  const currentIndex = (): { index: CodeIndex | null; reason?: string } => {
    const project = projects.current();
    if (!project) return { index: null, reason: 'Open a project first.' };
    const index = indexFor(new Workspace(project.path));
    return index ? { index } : { index: null, reason: 'Set an OpenRouter API key to enable code indexing.' };
  };

  const manager = new ChatManager({
    settings,
    projects,
    chats,
    llm,
    browser: () => browser,
    codeSearch: (workspace) => {
      const index = indexFor(workspace);
      return index ? { search: index, tools: [searchCodeTool(index)] } : null;
    },
    mcp,
    emit: (event, chatId) => {
      // Model and provider failures shown in the chat (the error text, not the conversation).
      if (event.type === 'error') appLog.error('chat', event.text);
      send(mainWindow, 'chat:event', { chatId, event });
    },
    onSnapshot: (snapshot) => send(mainWindow, 'chat:snapshot', snapshot),
    onHistoryChanged: () => send(mainWindow, 'history:changed', chats.list()),
    onDroppedFields: (error) => toolErrorLog.record(error),
    edits: editBackups,
    sandboxSensitivePaths: () => [
      app.getPath('appData'),
      app.getPath('userData'),
      ...(app.isPackaged ? [dirname(process.resourcesPath)] : []),
    ],
  });

  const openProject = (path: string) => {
    manager.requireIdle();
    const before = projects.current()?.path;
    const project = projects.open(path);
    if (project.path !== before) {
      manager.projectChanged();
      refreshMcp();
      terminal.stop();
      resetAgentBrowser();
    }
    send(mainWindow, 'project:changed', project);
    return project;
  };

  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));
  const rendererErrors = new RendererErrorReporter(appLog);
  handle('log:renderer-error', (report) => rendererErrors.report(report));

  handle('settings:get', () => settings.view());
  // Switching to Auto mode is confirmed once per app session; MCP and editor commands every time they change.
  let autoConfirmed = false;
  // A native dialog for sensitive settings changes (settings_confirm.ts). Throws when the user cancels.
  const confirmChanges = async (changes: string[]): Promise<void> => {
    if (changes.length === 0) return;
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: 'Confirm settings',
      message: 'Apply these settings?',
      detail: changes.map((change) => `• ${change}`).join('\n'),
      buttons: ['Apply', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const { response } = await (mainWindow
      ? dialog.showMessageBox(mainWindow, options)
      : dialog.showMessageBox(options));
    if (response !== 0) throw new Error('Settings not changed: the change was cancelled.');
  };

  handle('settings:update', async (patch) => {
    const mcpProgram = (command: string) => {
      try {
        return resolveCommand(command, process.env.PATH ?? '', process.env.PATHEXT);
      } catch {
        return null;
      }
    };
    await confirmChanges(changesToConfirm(settings.get(), patch, autoConfirmed, settings.mcpHeaderNames(), mcpProgram));
    const view = settings.update(patch);
    if (patch.approvalMode === 'auto') autoConfirmed = true;
    return view;
  });
  handle('settings:set-secret', (name, value) => {
    if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret: ${name}`);
    return settings.setSecret(name, value);
  });
  handle('chatgpt:sign-in', () => signInWithChatGpt(settings, { openUrl: (url) => shell.openExternal(url) }));
  handle('chatgpt:sign-out', () => signOutChatGpt(settings));
  settings.on('change', (view) => send(mainWindow, 'settings:changed', view));

  handle('index:status', () => {
    const { index, reason } = currentIndex();
    return indexStatus(index, reason);
  });

  handle('mcp:status', () => mcp.status());
  handle('index:rebuild', async () => {
    const { index, reason } = currentIndex();
    if (!index) throw new Error(reason);
    await index.rebuild();
    return indexStatus(index);
  });

  handle('project:choose', async () => {
    const options = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled || !result.filePaths[0] ? null : openProject(result.filePaths[0]);
  });
  handle('project:open', (path) => openProject(path));
  handle('project:current', () => projects.current());
  handle('project:list', () => projects.list());
  handle('project:opened', () => projects.opened());
  handle('project:close', (path) => {
    manager.requireIdle();
    const before = projects.current()?.path;
    manager.closeProject(path);
    revokeSandboxGrant(path);
    projects.close(path);
    forgetClosedGitServices();
    if (projects.current()?.path !== before) {
      manager.projectChanged();
      refreshMcp();
      terminal.stop();
      resetAgentBrowser();
    }
    send(mainWindow, 'project:changed', projects.current());
  });
  handle('project:set-instructions', (path, instructions) => projects.setInstructions(path, instructions));
  handle('project:update-settings', async (path, projectSettings) => {
    await confirmChanges(projectChangesToConfirm(projects.get(path), projectSettings));
    return projects.updateSettings(path, projectSettings);
  });
  handle('project:remove', (path) => {
    manager.requireIdle();
    const before = projects.current()?.path;
    manager.closeProject(path);
    revokeSandboxGrant(path);
    projects.remove(path);
    forgetClosedGitServices();
    if (projects.current()?.path !== before) {
      manager.projectChanged();
      refreshMcp();
      terminal.stop();
      resetAgentBrowser();
    }
    send(mainWindow, 'project:changed', projects.current());
    return projects.list();
  });

  handle('chat:snapshot', () => manager.snapshot());
  handle('chat:send', (message) => {
    // Returns once the chat has started; progress arrives as chat:event messages.
    manager.send(message).catch(() => {});
  });
  handle('chat:stop', () => manager.stop());
  handle('chat:resume', () => {
    manager.resume().catch(() => {});
  });
  // Awaited, unlike send and resume, so a setup problem (no summarizing model, nothing to compact) reaches the UI.
  handle('chat:compact', () => manager.compact());
  handle('edit:undo', (toolId) => manager.undoEdit(typeof toolId === 'string' ? toolId : ''));
  handle('chat:new', () => {
    const snapshot = manager.newChat();
    resetAgentBrowser();
    return snapshot;
  });
  handle('chat:decide', (approvalId, decision) => manager.decide(approvalId, decision));
  handle('chat:export', () => {
    const chat = manager.snapshot();
    if (chat.transcript.length === 0) throw new Error('This chat is empty; there is nothing to export.');
    return saveTextFile(mainWindow, exportFileName(chat.title), chatToMarkdown(chat));
  });

  handle('history:list', () => chats.list());
  handle('history:open', (id) => {
    const before = projects.current()?.path;
    try {
      const snapshot = manager.open(id);
      resetAgentBrowser();
      return snapshot;
    } finally {
      if (projects.current()?.path !== before) terminal.stop();
      send(mainWindow, 'project:changed', projects.current());
    }
  });
  handle('history:delete', (id) => {
    manager.forget([id]);
    chats.delete(id);
    // The backups of a chat's edits go with the chat.
    editBackups.deleteChat(id);
    return chats.list();
  });
  handle('history:search', (query) => chats.search(typeof query === 'string' ? query.slice(0, 200) : ''));
  handle('history:clear', () => {
    manager.forget('all');
    chats.deleteAll();
    editBackups.deleteAll();
    return chats.list();
  });

  handle('files:pick-images', () => pickImages(mainWindow));
  handle('files:open-in-editor', (path) => {
    const project = projects.current();
    if (!project) throw new Error('No project is open.');
    openInEditor(settings.get().editorCommand, project.path, path);
  });
  handle('files:list', async () => {
    const project = projects.current();
    if (!project) return [];
    const workspace = new Workspace(project.path);
    return (await workspace.listFiles(workspace.root, MAX_MENTION_FILES)).map((file) => workspace.relative(file));
  });

  handle('terminal:start', (cols, rows) => {
    const project = projects.current();
    if (!project) throw new Error('Open a project to use the terminal.');
    terminal.start(project.path, cols, rows);
  });
  handle('terminal:write', (data) => terminal.write(data));
  handle('terminal:resize', (cols, rows) => terminal.resize(cols, rows));

  handle('git:status', () => git().status());
  handle('git:diff', (path) => git().diff(path));
  handle('git:commit', (message) => git().commit(message));
  handle('git:discard', (path) => git().discard(path));
  handle('git:discard-all', () => git().discardAll());
  handle('git:init', () => git().init());
  handle('git:push', () => git().push());
  handle('git:suggest-message', async () => {
    const service = git();
    const [status, diff] = await Promise.all([service.status(), service.diff(null)]);
    return suggestCommitMessage(
      llm.smallModelForSettings(),
      diff,
      status.files.map((file) => file.path),
    );
  });

  const openWindow = () => {
    const window = createMainWindow((guest) => browser.attach(guest));
    window.on('closed', () => {
      if (mainWindow === window) mainWindow = null;
    });
    return window;
  };
  buildMenu(() => mainWindow, join(userData, 'logs'));
  mainWindow = openWindow();
  // Tell the user once the page can show it, instead of only asking for the key as if it was never entered.
  const unreadable = settings.unreadableSecrets();
  if (unreadable.length > 0) {
    const labels: Record<string, string> = {
      anthropicApiKey: 'Anthropic API key',
      openaiApiKey: 'OpenAI API key',
      openrouterApiKey: 'OpenRouter API key',
      googleApiKey: 'Google API key',
    };
    const names = unreadable.map((name) => labels[name] ?? name).join(', ');
    mainWindow.webContents.once('did-finish-load', () =>
      send(
        mainWindow,
        'app:notice',
        `Your saved ${names} could not be read, likely because Patch was closed right after it was saved. Enter it again in Settings.`,
      ),
    );
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = openWindow();
    }
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    manager.dispose();
    terminal.stop();
    // The chats were saved by dispose; a checkpoint it replaced may still be cleaning up its temporary file.
    // Stopping commands runs in the background (container removal, taskkill); quitting waits for it as it did before.
    void Promise.allSettled([mcp.stop(), chats.flush(), commandStopsSettled()]).finally(() => app.quit());
  });
}

// One instance per profile. Two would each keep settings, projects and the chat index in memory and overwrite each
// other's files on save. The lock is tied to the userData folder set above, so different profiles (PATCH_USER_DATA)
// can still run side by side. A second start on the same profile brings the running window forward instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(start);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
