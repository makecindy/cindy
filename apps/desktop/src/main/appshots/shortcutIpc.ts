import type { AppshotShortcutState } from './shortcutService.js';
import { AppshotShortcutValidationError } from './shortcutStore.js';
import { throwIpcError } from '../utils/ipcValidate.js';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

export interface AppshotShortcutIpcMain {
  handle(channel: string, handler: IpcHandler): void;
}

export interface AppshotShortcutIpcService {
  state(): AppshotShortcutState;
  setPreferences(value: unknown): Promise<AppshotShortcutState>;
  reset(): Promise<AppshotShortcutState>;
}

export function registerAppshotShortcutIpc(deps: {
  ipcMain: AppshotShortcutIpcMain;
  service: AppshotShortcutIpcService;
  assertTrustedSender: (event: unknown) => void;
}): void {
  deps.ipcMain.handle('appshots:shortcut-state', async (event, ...args) => {
    deps.assertTrustedSender(event);
    if (args.length !== 0) throwIpcError('INVALID_PARAMS', 'appshot shortcut state does not accept parameters');
    return deps.service.state();
  });
  deps.ipcMain.handle('appshots:shortcut-preferences:set', async (event, ...args) => {
    deps.assertTrustedSender(event);
    if (args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) {
      throwIpcError('INVALID_PARAMS', 'appshot shortcut preferences must be an object');
    }
    try {
      return await deps.service.setPreferences(args[0]);
    } catch (error) {
      if (error instanceof AppshotShortcutValidationError) {
        throwIpcError('INVALID_PARAMS', 'appshot shortcut preferences are invalid');
      }
      throwIpcError('INTERNAL', 'could not save appshot shortcut preferences');
    }
  });
  deps.ipcMain.handle('appshots:shortcut-preferences:reset', async (event, ...args) => {
    deps.assertTrustedSender(event);
    if (args.length !== 0) throwIpcError('INVALID_PARAMS', 'appshot shortcut reset does not accept parameters');
    try {
      return await deps.service.reset();
    } catch {
      throwIpcError('INTERNAL', 'could not reset appshot shortcut preferences');
    }
  });
}

interface ShortcutWindow {
  isDestroyed(): boolean;
}

/** Sends shortcut state only to live, trusted Cindy top-level windows. */
export function broadcastAppshotShortcutState<TWindow extends ShortcutWindow>(deps: {
  windows: readonly TWindow[];
  isTrustedWindow: (window: TWindow) => boolean;
  send: (window: TWindow, channel: 'appshots:shortcut-state-changed', state: AppshotShortcutState) => void;
}, state: AppshotShortcutState): void {
  for (const window of deps.windows) {
    if (window.isDestroyed() || !deps.isTrustedWindow(window)) continue;
    deps.send(window, 'appshots:shortcut-state-changed', state);
  }
}
