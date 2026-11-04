import { describe, expect, it, vi } from 'vitest';
import { migrateGhostSecretAliases } from '../ghostSecretAliasMigration.js';
import { ghostSecretStorageKey, providerSecretStorageKey } from '../../../shared/providerSecrets.js';

function fixture() {
  const store = new Map<string, string>();
  const io = {
    isAvailable: () => true,
    read: (key: string) => store.get(key) ?? null,
    write: (key: string, value: string) => { store.set(key, value); return true; },
  };
  return { store, io };
}
const original = { instanceKey: 'cindy-web-search', ghostId: 'cindy-web-search', eligible: true };

describe('historical credential alias migration', () => {
  it('copies only to the verified original instance and leaves a new local copy empty', () => {
    const { store, io } = fixture();
    store.set(providerSecretStorageKey('brave'), 'legacy-brave-secret');
    expect(migrateGhostSecretAliases(original, io)).toBe(true);
    expect(store.get(ghostSecretStorageKey(original.instanceKey, 'brave_api_key'))).toBe('legacy-brave-secret');
    expect(store.has(ghostSecretStorageKey('_ns__local__cindy-web-search', 'brave_api_key'))).toBe(false);
  });
  it.each([false, true])('never grants aliases to a namespaced copy (eligible=%s)', eligible => {
    const { store, io } = fixture();
    store.set(providerSecretStorageKey('brave'), 'legacy-brave-secret');
    migrateGhostSecretAliases({ ...original, instanceKey: '_ns__local__cindy-web-search', eligible }, io);
    migrateGhostSecretAliases({ ...original, eligible: false }, io);
    expect(store.size).toBe(1);
  });
  it('does not overwrite a newer value or refill a deleted key after completion', () => {
    const { store, io } = fixture();
    const key = ghostSecretStorageKey(original.instanceKey, 'brave_api_key');
    store.set(providerSecretStorageKey('brave'), 'old-secret');
    store.set(key, 'new-user-secret');
    migrateGhostSecretAliases(original, io);
    expect(store.get(key)).toBe('new-user-secret');
    store.delete(key);
    migrateGhostSecretAliases(original, io);
    expect(store.has(key)).toBe(false);
  });
  it('retries a partial write without overwriting an intervening user value', () => {
    const { store, io } = fixture();
    store.set(providerSecretStorageKey('brave'), 'brave-secret');
    store.set(providerSecretStorageKey('tavily'), 'tavily-secret');
    const write = vi.spyOn(io, 'write').mockImplementationOnce((key, value) => { store.set(key, value); return true; })
      .mockReturnValueOnce(false);
    expect(() => migrateGhostSecretAliases(original, io)).toThrow();
    write.mockRestore();
    const key = ghostSecretStorageKey(original.instanceKey, 'brave_api_key');
    store.set(key, 'changed-user-secret');
    migrateGhostSecretAliases(original, io);
    expect(store.get(key)).toBe('changed-user-secret');
    expect(store.get(ghostSecretStorageKey(original.instanceKey, 'tavily_api_key'))).toBe('tavily-secret');
  });
  it('does not mark complete while encrypted storage is unavailable', () => {
    const { store, io } = fixture();
    expect(migrateGhostSecretAliases(original, { ...io, isAvailable: () => false })).toBe(false);
    expect(store.size).toBe(0);
  });
});
