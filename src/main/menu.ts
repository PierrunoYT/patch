import { mkdirSync } from 'node:fs';
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '@shared/ipc';
import { appLog } from './app_log';
import { send } from './ipc';

// Opens the folder holding the crash and error logs in the system file manager.
function showLogFolder(folder: string): void {
  try {
    mkdirSync(folder, { recursive: true });
  } catch {
    // openPath below reports the problem.
  }
  void shell.openPath(folder).then((problem) => {
    if (problem) appLog.warn('menu', `Could not open the log folder: ${problem}`);
  });
}

export function buildMenu(getWindow: () => BrowserWindow | null, logFolder: string): void {
  const command = (name: MenuCommand) => () => send(getWindow(), 'menu:command', name);
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: command('open-project') },
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: command('new-chat') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: command('settings') },
        { type: 'separator' },
        { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: command('stop') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', click: () => app.quit() },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        // A console on the app page has the whole window.api: only in development.
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Show Log Folder', click: () => showLogFolder(logFolder) }] },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
