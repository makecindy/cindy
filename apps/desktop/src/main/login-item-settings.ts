import path from 'node:path';
import type { App } from 'electron';

import type { LoginItemState } from '../shared/loginItem.js';
import { requireBoolean, throwIpcError } from './utils/ipcValidate.js';

/** Injectable OS adapter: tests never register real login items. */
interface LoginItemDependencies {
  app: Pick<App, 'isPackaged' | 'getLoginItemSettings' | 'setLoginItemSettings'>;
  platform: NodeJS.Platform;
  execPath: string;
}

/**
 * The OS owns this preference, including changes made in System Settings.
 * No registration on startup, no mirrored defaults and no automatic re-enabling.
 * Absence of our login item is the default (off); disabling removes that override.
 * Windows NSIS installs use a stable executable path, not Squirrel's Update.exe.
 */
export function createLoginItemSettings({ app, platform, execPath }: LoginItemDependencies) {
  const windows = platform === 'win32';
  const name = path.win32.basename(execPath, '.exe');
  const target = windows ? { path: execPath, args: [] as string[] } : {};
  // Electron 41 parses the lookup path as a command line. Quote only the
  // query; setLoginItemSettings already quotes the executable when writing.
  const query = windows ? { path: `"${execPath}"`, args: [] as string[] } : {};

  function read(): LoginItemState {
    const unavailableReason =
      platform !== 'win32' && platform !== 'darwin'
        ? 'platform'
        : !app.isPackaged
          ? 'development'
          : undefined;
    if (unavailableReason) {
      return { available: false, unavailableReason, enabled: false, requiresApproval: false };
    }
    try {
      const settings = app.getLoginItemSettings(query);
      // Windows openAtLogin reads the AppUserModelID entry, not our explicit
      // name. launchItems includes StartupApproved and all entries for this
      // executable, so match our own user entry and arguments here.
      const enabled = windows
        ? settings.launchItems.some(
            (item) =>
              item.name === name &&
              item.scope === 'user' &&
              item.args.length === 0 &&
              item.enabled,
          )
        : settings.openAtLogin;
      return {
        available: true,
        enabled,
        requiresApproval: !windows && settings.status === 'requires-approval',
      };
    } catch {
      throwIpcError('INTERNAL', 'Unable to read login startup settings');
    }
  }

  function set(rawEnabled: unknown): LoginItemState {
    const enabled = requireBoolean(rawEnabled, 'enabled');
    if (!read().available) {
      throwIpcError(
        'UNSUPPORTED_CAPABILITY',
        'Login startup requires an installed Windows or macOS app',
      );
    }
    try {
      app.setLoginItemSettings({
        ...target,
        openAtLogin: enabled,
        ...(windows ? { name, enabled } : {}),
      });
    } catch {
      throwIpcError('INTERNAL', 'Unable to update login startup settings');
    }
    const state = read();
    if (
      enabled ? !state.enabled && !state.requiresApproval : state.enabled || state.requiresApproval
    ) {
      throwIpcError('PRECONDITION_FAILED', 'The system did not apply the login startup setting');
    }
    return state;
  }

  return { read, set };
}
