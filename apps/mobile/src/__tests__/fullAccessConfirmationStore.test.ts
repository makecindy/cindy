import { beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    getAllKeys: vi.fn(async () => [...store.keys()]),
    multiRemove: vi.fn(async (keys: readonly string[]) => {
      for (const key of keys) store.delete(key);
    }),
  },
}));

import {
  __testing,
  clearFullAccessAcknowledgementsForAccount,
  hasFullAccessAcknowledgement,
  rememberFullAccessAcknowledgement,
} from '@/session/fullAccessConfirmationStore';

describe('fullAccessConfirmationStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    __testing.resetMemory();
  });

  it('persists an acknowledgement by account and controlled desktop', async () => {
    await rememberFullAccessAcknowledgement(' account:a ', ' desktop/a ');
    __testing.resetMemory();

    await expect(hasFullAccessAcknowledgement('account:a', 'desktop/a')).resolves.toBe(true);
    await expect(hasFullAccessAcknowledgement('account:a', 'desktop-b')).resolves.toBe(false);
    await expect(hasFullAccessAcknowledgement('account-b', 'desktop/a')).resolves.toBe(false);
  });

  it('clears only the explicitly deleted account', async () => {
    await rememberFullAccessAcknowledgement('account-a', 'desktop-a');
    await rememberFullAccessAcknowledgement('account-a', 'desktop-b');
    await rememberFullAccessAcknowledgement('account-b', 'desktop-a');

    await clearFullAccessAcknowledgementsForAccount('account-a');
    __testing.resetMemory();

    await expect(hasFullAccessAcknowledgement('account-a', 'desktop-a')).resolves.toBe(false);
    await expect(hasFullAccessAcknowledgement('account-a', 'desktop-b')).resolves.toBe(false);
    await expect(hasFullAccessAcknowledgement('account-b', 'desktop-a')).resolves.toBe(true);
  });

  it('does not let an earlier queued read repopulate memory after account deletion', async () => {
    await rememberFullAccessAcknowledgement('account-a', 'desktop-a');
    const persisted = [...store.values()][0] ?? null;
    __testing.resetMemory();

    let resolveRead!: (value: string | null) => void;
    vi.mocked(AsyncStorage.getItem).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    const read = hasFullAccessAcknowledgement('account-a', 'desktop-a');
    await vi.waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledOnce());
    const clear = clearFullAccessAcknowledgementsForAccount('account-a');

    resolveRead(persisted);
    await expect(read).resolves.toBe(true);
    await clear;
    await expect(hasFullAccessAcknowledgement('account-a', 'desktop-a')).resolves.toBe(false);
  });

  it('does not create a global acknowledgement for an incomplete scope', async () => {
    await rememberFullAccessAcknowledgement('', 'desktop-a');
    await rememberFullAccessAcknowledgement('account-a', '');

    expect(store.size).toBe(0);
    await expect(hasFullAccessAcknowledgement('', 'desktop-a')).resolves.toBe(false);
    await expect(hasFullAccessAcknowledgement('account-a', '')).resolves.toBe(false);
  });
});
