import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_APPSHOT_SHORTCUT_PREFERENCES } from '../../../shared/appshots.js';
import { AppshotShortcutValidationError } from '../shortcutStore.js';
import {
  broadcastAppshotShortcutState,
  registerAppshotShortcutIpc,
} from '../shortcutIpc.js';

const state = {
  preferences: DEFAULT_APPSHOT_SHORTCUT_PREFERENCES,
  configured: DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.preferred,
  active: DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.preferred,
};

describe('Appshot shortcut IPC', () => {
  it('broadcasts to every live trusted Cindy top-level window', () => {
    const main = { name: 'main', isDestroyed: () => false };
    const secondary = { name: 'secondary', isDestroyed: () => false };
    const untrusted = { name: 'untrusted', isDestroyed: () => false };
    const destroyed = { name: 'destroyed', isDestroyed: () => true };
    const send = vi.fn();

    broadcastAppshotShortcutState({
      windows: [main, secondary, untrusted, destroyed],
      isTrustedWindow: (window) => window !== untrusted,
      send,
    }, state);

    expect(send.mock.calls).toEqual([
      [main, 'appshots:shortcut-state-changed', state],
      [secondary, 'appshots:shortcut-state-changed', state],
    ]);
  });

  it('maps validation errors to INVALID_PARAMS and storage failures to a sanitized INTERNAL error', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const setPreferences = vi.fn();
    registerAppshotShortcutIpc({
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); } },
      service: {
        state: () => state,
        setPreferences,
        reset: async () => state,
      },
      assertTrustedSender: vi.fn(),
    });
    const set = handlers.get('appshots:shortcut-preferences:set') as (...args: unknown[]) => Promise<unknown>;

    setPreferences.mockRejectedValueOnce(new AppshotShortcutValidationError('duplicate'));
    await expect(set('trusted', {})).rejects.toThrow('[INVALID_PARAMS]');

    setPreferences.mockRejectedValueOnce(new Error('/private/userData/appshots-shortcuts.v1.json EIO'));
    const storageFailure = set('trusted', {}).catch((error) => error as Error);
    await expect(storageFailure).resolves.toMatchObject({ message: expect.stringContaining('[INTERNAL]') });
    await expect(storageFailure).resolves.not.toMatchObject({ message: expect.stringContaining('/private/userData') });
  });
});
