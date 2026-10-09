import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { EventChannel, EventMap, InvokeApi, InvokeChannel } from '@shared/ipc';
import { appLog } from './app_log';
import { parseIpcArgs } from './ipc_schemas';
import { isAppPageUrl } from './renderer_url';

type Handler<K extends InvokeChannel> = (
  ...args: Parameters<InvokeApi[K]>
) => ReturnType<InvokeApi[K]> | Promise<Awaited<ReturnType<InvokeApi[K]>>>;

// Only the app page's top frame may call the handlers. Today it is the only frame with the preload (pages in the
// browser panel get none), so this guards against a future iframe, second window or wrongly loaded page.
function fromAppPage(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return frame !== null && frame.parent === null && isAppPageUrl(frame.url, app.isPackaged, process.env);
}

export function handle<K extends InvokeChannel>(channel: K, handler: Handler<K>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromAppPage(event)) {
      // The frame's URL is not logged: it is whatever page made the call.
      appLog.warn('ipc', 'Blocked a call from a frame that is not the app page.', { channel });
      throw new Error('Blocked IPC call from a frame that is not the app page.');
    }
    try {
      // Arguments come from the renderer as untyped data: refuse anything the channel does not take (#32).
      return await handler(...(parseIpcArgs(channel, args) as Parameters<InvokeApi[K]>));
    } catch (error) {
      // Only the channel is logged, not the arguments, which can hold messages and file contents.
      appLog.error('ipc', error, { channel });
      throw error;
    }
  });
}

export function send<K extends EventChannel>(window: BrowserWindow | null, channel: K, payload: EventMap[K]): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}
