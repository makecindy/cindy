import { describe, expect, it, vi } from 'vitest';

import { createDatabaseSizeWarningSettingsWatcher } from '../database-size-warning-settings-watcher.js';

describe('database size warning settings watcher', () => {
  it('rebinds and forwards changes from a shared settings file', () => {
    const listeners = new Map<string, () => void>();
    const deps = {
      watchFile: vi.fn(
        (
          file: string,
          _options: { persistent: boolean; interval: number },
          listener: () => void,
        ) => listeners.set(file, listener),
      ),
      unwatchFile: vi.fn((file: string) => listeners.delete(file)),
    };
    const onChange = vi.fn();
    const watcher = createDatabaseSizeWarningSettingsWatcher(onChange, deps);

    watcher.rebind('profile-a/database-size-warning-settings.json');
    expect(deps.watchFile).toHaveBeenCalledWith(
      'profile-a/database-size-warning-settings.json',
      { persistent: false, interval: 750 },
      expect.any(Function),
    );
    listeners.get('profile-a/database-size-warning-settings.json')?.();
    expect(onChange).toHaveBeenCalledTimes(1);

    watcher.rebind('profile-b/database-size-warning-settings.json');
    expect(deps.unwatchFile).toHaveBeenCalledWith(
      'profile-a/database-size-warning-settings.json',
      expect.any(Function),
    );
    listeners.get('profile-b/database-size-warning-settings.json')?.();
    expect(onChange).toHaveBeenCalledTimes(2);

    watcher.dispose();
    expect(deps.unwatchFile).toHaveBeenLastCalledWith(
      'profile-b/database-size-warning-settings.json',
      expect.any(Function),
    );
  });
});
