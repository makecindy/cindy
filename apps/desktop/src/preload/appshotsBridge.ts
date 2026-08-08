import type { AppshotCaptureResult } from '../shared/appshots.js';
import type {
  AppshotShortcutPreferences,
} from '../shared/appshots.js';
import type { AppshotShortcutState } from '../main/appshots/shortcutService.js';

type AppshotsListener = (event: unknown, payload: unknown) => void;

interface AppshotsBridgeDeps {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: AppshotsListener) => unknown;
  removeListener: (channel: string, listener: AppshotsListener) => unknown;
}

export interface AppshotsBridge {
  capture: () => Promise<{ accepted: true }>;
  listPending: () => Promise<AppshotCaptureResult[]>;
  ack: (captureId: string) => Promise<{ acknowledged: boolean }>;
  onCaptured: (callback: (result: AppshotCaptureResult) => void) => () => void;
  getShortcutState: () => Promise<AppshotShortcutState>;
  setShortcutPreferences: (value: AppshotShortcutPreferences) => Promise<AppshotShortcutState>;
  resetShortcutPreferences: () => Promise<AppshotShortcutState>;
  onShortcutStateChanged: (callback: (state: AppshotShortcutState) => void) => () => void;
}

export function createAppshotsBridge(deps: AppshotsBridgeDeps): AppshotsBridge {
  return {
    capture: () => deps.invoke('appshots:capture') as Promise<{ accepted: true }>,
    listPending: () => deps.invoke('appshots:list-pending') as Promise<AppshotCaptureResult[]>,
    ack: (captureId) => deps.invoke('appshots:ack', captureId) as Promise<{ acknowledged: boolean }>,
    onCaptured: (callback) => {
      const listener: AppshotsListener = (_event, result) => callback(result as AppshotCaptureResult);
      deps.on('appshots:captured', listener);
      return () => { deps.removeListener('appshots:captured', listener); };
    },
    getShortcutState: () => deps.invoke('appshots:shortcut-state') as Promise<AppshotShortcutState>,
    setShortcutPreferences: (value) => deps.invoke(
      'appshots:shortcut-preferences:set',
      value,
    ) as Promise<AppshotShortcutState>,
    resetShortcutPreferences: () => deps.invoke(
      'appshots:shortcut-preferences:reset',
    ) as Promise<AppshotShortcutState>,
    onShortcutStateChanged: (callback) => {
      const listener: AppshotsListener = (_event, state) => callback(state as AppshotShortcutState);
      deps.on('appshots:shortcut-state-changed', listener);
      return () => { deps.removeListener('appshots:shortcut-state-changed', listener); };
    },
  };
}
