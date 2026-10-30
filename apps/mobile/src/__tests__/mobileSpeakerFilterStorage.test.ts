import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  prefs: new Map<string, string>(),
  secure: new Map<string, string>(),
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  getAllKeys: vi.fn(),
  deleteSecureItem: vi.fn(),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: store }));
vi.mock('@/auth/secureStorage', () => ({ deleteSecureItem: store.deleteSecureItem }));

let storage: typeof import('@/session/mobileSpeakerFilterStorage');
const account = 'global:fixture-a';
const marker = `cindy.mobile.voice-speaker-filter.cleanup.v1.${account}`;

beforeEach(async () => {
  vi.resetModules();
  store.prefs.clear();
  store.secure.clear();
  store.getItem.mockReset().mockImplementation(async key => store.prefs.get(key) ?? null);
  store.setItem.mockReset().mockImplementation(async (key, value) => { store.prefs.set(key, value); });
  store.removeItem.mockReset().mockImplementation(async key => { store.prefs.delete(key); });
  store.getAllKeys.mockReset().mockImplementation(async () => [...store.prefs.keys()]);
  store.deleteSecureItem.mockReset().mockImplementation(async key => { store.secure.delete(key); });
  storage = await import('@/session/mobileSpeakerFilterStorage');
});

function seed(key = account): void {
  store.prefs.set(storage.speakerFilterPrefsKey(key), 'fixture preferences');
  store.secure.set(storage.speakerProfileKey(key), 'fixture voiceprint');
}

describe('speaker filter logout cleanup', () => {
  it.each(['secure', 'prefs', 'both'] as const)('retries a failed %s deletion after a process restart without an auth owner', async failure => {
    seed();
    seed('cn:fixture-b');
    if (failure !== 'prefs') store.deleteSecureItem.mockRejectedValueOnce(new Error('keychain unavailable'));
    if (failure !== 'secure') store.removeItem.mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(storage.clearMobileSpeakerFilterForAccount(account)).rejects.toThrow('cleanup pending');
    expect(store.deleteSecureItem).toHaveBeenCalledWith(storage.speakerProfileKey(account));
    expect(store.removeItem).toHaveBeenCalledWith(storage.speakerFilterPrefsKey(account));
    expect(store.prefs.get(marker)).toBe('1');

    vi.resetModules();
    storage = await import('@/session/mobileSpeakerFilterStorage');
    await storage.retryPendingMobileSpeakerFilterCleanup();
    expect(store.secure.has(storage.speakerProfileKey(account))).toBe(false);
    expect(store.prefs.has(storage.speakerFilterPrefsKey(account))).toBe(false);
    expect(store.prefs.has(marker)).toBe(false);
    expect(store.secure.get(storage.speakerProfileKey('cn:fixture-b'))).toBe('fixture voiceprint');
    expect(store.prefs.get(storage.speakerFilterPrefsKey('cn:fixture-b'))).toBe('fixture preferences');
  });

  it('does not read or overwrite a voiceprint while logout cleanup is still failing', async () => {
    seed();
    store.deleteSecureItem.mockRejectedValue(new Error('keychain unavailable'));
    await expect(storage.clearMobileSpeakerFilterForAccount(account)).rejects.toThrow();
    const access = vi.fn(async () => 'old profile');
    await expect(storage.serializeSpeakerFilterStorage(account, access)).rejects.toThrow();
    expect(access).not.toHaveBeenCalled();

    store.deleteSecureItem.mockImplementation(async key => { store.secure.delete(key); });
    await storage.serializeSpeakerFilterStorage(account, async () => {
      expect(store.secure.has(storage.speakerProfileKey(account))).toBe(false);
      store.secure.set(storage.speakerProfileKey(account), 'new profile');
    });
    await storage.retryPendingMobileSpeakerFilterCleanup();
    expect(store.secure.get(storage.speakerProfileKey(account))).toBe('new profile');
  });

  it('retains an in-memory retry if persisting the marker and enumerating storage fail', async () => {
    seed();
    store.setItem.mockRejectedValueOnce(new Error('disk full'));
    store.deleteSecureItem.mockRejectedValueOnce(new Error('keychain unavailable'));
    await expect(storage.clearMobileSpeakerFilterForAccount(account)).rejects.toThrow();
    expect(store.prefs.has(marker)).toBe(false);
    store.getAllKeys.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(storage.retryPendingMobileSpeakerFilterCleanup()).rejects.toThrow();
    expect(store.secure.has(storage.speakerProfileKey(account))).toBe(false);
    await storage.retryPendingMobileSpeakerFilterCleanup();
  });

  it('still removes both account stores if writing the retry marker fails', async () => {
    seed();
    store.setItem.mockRejectedValueOnce(new Error('disk full'));
    await storage.clearMobileSpeakerFilterForAccount(account);
    expect(store.secure.size).toBe(0);
    expect(store.prefs.size).toBe(0);
  });

  it('retries removing the marker before allowing a new profile to be saved', async () => {
    seed();
    store.removeItem.mockImplementationOnce(async key => { store.prefs.delete(key); })
      .mockRejectedValueOnce(new Error('marker removal failed'));
    await expect(storage.clearMobileSpeakerFilterForAccount(account)).rejects.toThrow('marker removal failed');
    expect(store.secure.size).toBe(0);
    expect(store.prefs.has(marker)).toBe(true);
    await storage.serializeSpeakerFilterStorage(account, async () => {
      expect(store.prefs.has(marker)).toBe(false);
      store.secure.set(storage.speakerProfileKey(account), 'new profile');
    });
    await storage.retryPendingMobileSpeakerFilterCleanup();
    expect(store.secure.get(storage.speakerProfileKey(account))).toBe('new profile');
  });

  it('rechecks stale retry enumeration before deleting a newly enrolled voiceprint', async () => {
    seed();
    store.deleteSecureItem.mockRejectedValueOnce(new Error('keychain unavailable'));
    await expect(storage.clearMobileSpeakerFilterForAccount(account)).rejects.toThrow();
    let release!: (keys: string[]) => void;
    store.getAllKeys.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const retry = storage.retryPendingMobileSpeakerFilterCleanup();
    await storage.serializeSpeakerFilterStorage(account, async () => {
      store.secure.set(storage.speakerProfileKey(account), 'new profile');
    });
    release([marker]);
    await retry;
    expect(store.secure.get(storage.speakerProfileKey(account))).toBe('new profile');
  });

  it('attempts all pending accounts even when one remains unavailable', async () => {
    seed();
    seed('cn:fixture-b');
    store.prefs.set(marker, '1');
    store.prefs.set('cindy.mobile.voice-speaker-filter.cleanup.v1.cn:fixture-b', '1');
    store.deleteSecureItem.mockImplementation(async key => {
      if (key === storage.speakerProfileKey(account)) throw new Error('keychain unavailable');
      store.secure.delete(key);
    });
    await expect(storage.retryPendingMobileSpeakerFilterCleanup()).rejects.toThrow();
    expect(store.secure.has(storage.speakerProfileKey('cn:fixture-b'))).toBe(false);
    expect(store.prefs.has('cindy.mobile.voice-speaker-filter.cleanup.v1.cn:fixture-b')).toBe(false);
    expect(store.prefs.has(marker)).toBe(true);
  });

  it('does not interpret an unreadable marker as permission to read an old profile', async () => {
    const access = vi.fn();
    store.getItem.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(storage.serializeSpeakerFilterStorage(account, access)).rejects.toThrow('storage unavailable');
    expect(access).not.toHaveBeenCalled();
  });
});
