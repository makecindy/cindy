import { describe, expect, it, vi } from 'vitest';

import { createChatEmbeddingSettingsWatcher } from '../chat-embedding-settings-watcher.js';

describe('chat embedding settings watcher', () => {
  it('rebinds across owners and forwards external file changes', () => {
    const listeners = new Map<string, () => void>();
    const deps = {
      watchFile: vi.fn(
        (
          file: string,
          _options: { persistent: boolean; interval: number },
          listener: () => void,
        ) => {
          listeners.set(file, listener);
        },
      ),
      unwatchFile: vi.fn((file: string) => {
        listeners.delete(file);
      }),
    };
    const onChange = vi.fn();
    const watcher = createChatEmbeddingSettingsWatcher(onChange, deps);

    watcher.rebind('owner-a/chat-embedding-settings.json');
    expect(deps.watchFile).toHaveBeenCalledWith(
      'owner-a/chat-embedding-settings.json',
      { persistent: false, interval: 750 },
      expect.any(Function),
    );
    listeners.get('owner-a/chat-embedding-settings.json')?.();
    expect(onChange).toHaveBeenCalledTimes(1);

    watcher.rebind('owner-b/chat-embedding-settings.json');
    expect(deps.unwatchFile).toHaveBeenCalledWith(
      'owner-a/chat-embedding-settings.json',
      expect.any(Function),
    );
    expect(listeners.has('owner-a/chat-embedding-settings.json')).toBe(false);
    listeners.get('owner-b/chat-embedding-settings.json')?.();
    expect(onChange).toHaveBeenCalledTimes(2);

    watcher.rebind('owner-b/chat-embedding-settings.json');
    expect(deps.watchFile).toHaveBeenCalledTimes(2);
    watcher.dispose();
    expect(deps.unwatchFile).toHaveBeenLastCalledWith(
      'owner-b/chat-embedding-settings.json',
      expect.any(Function),
    );
  });
});
