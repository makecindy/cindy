import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createBotReadStateStorage, type BotReadStateStorageDependencies } from './botReadStateStorage.js';

/** app-content also includes detached panels. This feature belongs only to complete app shells. */
export function createBotWindowAccess(deps: {
  mainWindow: () => BrowserWindow | null;
  isSecondary: (window: BrowserWindow) => boolean;
  isTrustedWindow: (window: BrowserWindow) => boolean;
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
  windowFromSender: (sender: WebContents) => BrowserWindow | null;
}) {
  const accepts = (window: BrowserWindow | null): window is BrowserWindow => Boolean(window
    && (window === deps.mainWindow() || deps.isSecondary(window)) && deps.isTrustedWindow(window));
  return {
    accepts,
    assertSender(event: IpcMainInvokeEvent): void {
      deps.assertTrustedSender(event);
      if (!accepts(deps.windowFromSender(event.sender))) throwIpcError('PERMISSION_DENIED', '此操作仅限 Cindy 完整应用窗口');
    },
  };
}

/** Local trusted-app adapter. A sender is checked before any owner path or saved fact is read. */
export function createBotReadStateIpc(deps: BotReadStateStorageDependencies & {
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
}) {
  const storage = createBotReadStateStorage(deps);
  return (event: IpcMainInvokeEvent, input: unknown) => {
    deps.assertTrustedSender(event);
    return storage.access(input);
  };
}
