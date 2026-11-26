import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    getAllKeys: vi.fn(async () => [...store.keys()]),
    multiRemove: vi.fn(async (keys: readonly string[]) => {
      for (const key of keys) store.delete(key);
    }),
  },
}));

const vault = vi.hoisted(() => ({
  epochs: null as Record<string, string> | null,
  listener: null as null | ((invalidated: readonly { accountKey: string; epoch: string }[]) => void),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
/** Stands in for the account record that AuthContext connects in the app. */
const fakeEpochSource = () => ({
  ensure: async () => null,
  read: async () => vault.epochs,
  subscribe: (listener: NonNullable<typeof vault.listener>) => { vault.listener = listener; return () => { vault.listener = null; }; },
});

describe('composerDraftStore', () => {
  it.each(['both', 'text-only', 'new-draft'] as const)('reconciles a committed send after a crash with %s remaining', async (state) => {
    const { __testing, reconcileCommittedComposerDraft, readComposerDraft, readComposerDocumentDraft } = await import('@/session/composerDraftStore');
    const { textComposerDocument, emptyComposerDocument } = await import('@/session/composerDocument');
    const before = textComposerDocument('already sent');
    const after = emptyComposerDocument();
    store.set(__testing.storageKeyForSession('s1'), state === 'new-draft' ? 'later edit' : 'already sent');
    if (state !== 'text-only') store.set(__testing.documentStorageKeyForSession('s1'), JSON.stringify(state === 'new-draft' ? textComposerDocument('later edit') : before));
    await reconcileCommittedComposerDraft('s1', { before, after }, () => {});
    expect(await readComposerDraft('s1')).toBe(state === 'new-draft' ? 'later edit' : null);
    expect(await readComposerDocumentDraft('s1')).toEqual(state === 'new-draft' ? textComposerDocument('later edit') : state === 'text-only' ? null : after);
  });
  it('propagates draft handoff storage failure and retries the unmodified disk proof', async () => {
    const { __testing, reconcileCommittedComposerDraft } = await import('@/session/composerDraftStore');
    const { textComposerDocument, emptyComposerDocument } = await import('@/session/composerDocument');
    const storage = (await import('@react-native-async-storage/async-storage')).default;
    const before = textComposerDocument('sent');
    store.set(__testing.documentStorageKeyForSession('s1'), JSON.stringify(before));
    store.set(__testing.storageKeyForSession('s1'), 'sent');
    vi.mocked(storage.setItem).mockRejectedValueOnce(new Error('disk busy'));
    await expect(reconcileCommittedComposerDraft('s1', { before, after: emptyComposerDocument() }, () => {})).rejects.toThrow('disk busy');
    await reconcileCommittedComposerDraft('s1', { before, after: emptyComposerDocument() }, () => {});
    expect(store.get(__testing.storageKeyForSession('s1'))).toBe('');
  });
  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    const { clearComposerDrafts } = await import('@/session/composerDraftStore');
    await clearComposerDrafts();
    store.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { clearComposerDrafts } = await import('@/session/composerDraftStore');
    await clearComposerDrafts();
    store.clear();
  });

  it('stores a draft in memory and persistent storage until the target session consumes it', async () => {
    const {
      __testing,
      consumeComposerDraft,
      flushComposerDraftWrites,
      readComposerDraft,
      readComposerDraftSync,
      saveComposerDraft,
    } = await import('@/session/composerDraftStore');

    saveComposerDraft('s1', 'rewrite this');

    expect(readComposerDraftSync('s1')).toBe('rewrite this');
    await expect(readComposerDraft('s1')).resolves.toBe('rewrite this');
    expect(store.get(__testing.storageKeyForSession('s1'))).toBeUndefined();
    await flushComposerDraftWrites('s1');
    expect(store.get(__testing.storageKeyForSession('s1'))).toBe('rewrite this');
    await expect(consumeComposerDraft('s1')).resolves.toBe('rewrite this');
    expect(readComposerDraftSync('s1')).toBeNull();
    await expect(readComposerDraft('s1')).resolves.toBeNull();
  });

  it('restores a draft from persistent storage when memory is empty', async () => {
    const {
      __testing,
      clearComposerDrafts,
      readComposerDraft,
      readComposerDraftSync,
    } = await import('@/session/composerDraftStore');

    store.set(__testing.storageKeyForSession('s1'), 'from disk');
    expect(readComposerDraftSync('s1')).toBeNull();
    await expect(readComposerDraft('s1')).resolves.toBe('from disk');
    expect(readComposerDraftSync('s1')).toBe('from disk');

    await clearComposerDrafts();
  });

  it('persists the semantic document so atom order survives remounts', async () => {
    const {
      __testing,
      flushComposerDraftWrites,
      readComposerDocumentDraft,
      readComposerDocumentDraftSync,
      saveComposerDocumentDraft,
    } = await import('@/session/composerDraftStore');
    const document = {
      version: 1 as const,
      nodes: [
        { type: 'quote' as const, quote: { text: 'selected' } },
        { type: 'text' as const, text: 'reply' },
      ],
    };

    saveComposerDocumentDraft('s1', document);
    expect(readComposerDocumentDraftSync('s1')).toEqual(document);
    await flushComposerDraftWrites('s1');
    expect(JSON.parse(store.get(__testing.documentStorageKeyForSession('s1')) ?? '')).toEqual(document);
    await expect(readComposerDocumentDraft('s1')).resolves.toEqual(document);
  });

  it('does not let a stale document read replace a newer semantic draft', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const {
      readComposerDocumentDraft,
      readComposerDocumentDraftSync,
      saveComposerDocumentDraft,
    } = await import('@/session/composerDraftStore');
    let resolveGetItem!: (value: string | null) => void;
    vi.mocked(asyncStorage.getItem).mockImplementationOnce(() => new Promise((resolve) => {
      resolveGetItem = resolve;
    }));
    const oldDocument = { version: 1, nodes: [{ type: 'text', text: 'old' }] };
    const newDocument = { version: 1 as const, nodes: [{ type: 'text' as const, text: 'new' }] };

    const readPromise = readComposerDocumentDraft('s1');
    saveComposerDocumentDraft('s1', newDocument);
    resolveGetItem(JSON.stringify(oldDocument));

    await expect(readPromise).resolves.toEqual(newDocument);
    expect(readComposerDocumentDraftSync('s1')).toEqual(newDocument);
  });

  it('clears empty drafts and ignores missing session ids', async () => {
    const {
      consumeComposerDraft,
      readComposerDraft,
      saveComposerDraft,
    } = await import('@/session/composerDraftStore');

    saveComposerDraft('', 'missing session');
    saveComposerDraft('s1', 'old text');
    saveComposerDraft('s1', '');

    await expect(consumeComposerDraft('')).resolves.toBeNull();
    await expect(readComposerDraft('s1')).resolves.toBeNull();
  });

  it('debounces persistent writes while keeping memory current', async () => {
    vi.useFakeTimers();
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const {
      __testing,
      readComposerDraftSync,
      saveComposerDraft,
    } = await import('@/session/composerDraftStore');

    saveComposerDraft('s1', 'r');
    saveComposerDraft('s1', 'rewrite');

    expect(readComposerDraftSync('s1')).toBe('rewrite');
    expect(vi.mocked(asyncStorage.setItem)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(__testing.persistDebounceMs - 1);
    expect(vi.mocked(asyncStorage.setItem)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(vi.mocked(asyncStorage.setItem)).toHaveBeenCalledTimes(1);
    expect(store.get(__testing.storageKeyForSession('s1'))).toBe('rewrite');
  });

  it('debounces semantic document writes while keeping memory current', async () => {
    vi.useFakeTimers();
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const {
      __testing,
      readComposerDocumentDraftSync,
      saveComposerDocumentDraft,
    } = await import('@/session/composerDraftStore');
    const first = { version: 1 as const, nodes: [{ type: 'text' as const, text: 'r' }] };
    const latest = { version: 1 as const, nodes: [{ type: 'text' as const, text: 'rewrite' }] };

    saveComposerDocumentDraft('s1', first);
    saveComposerDocumentDraft('s1', latest);

    expect(readComposerDocumentDraftSync('s1')).toEqual(latest);
    expect(vi.mocked(asyncStorage.setItem)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(__testing.persistDebounceMs);

    expect(vi.mocked(asyncStorage.setItem)).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.get(__testing.documentStorageKeyForSession('s1')) ?? '')).toEqual(latest);
  });

  it('does not let a stale async read overwrite a newer memory draft', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const {
      __testing,
      flushComposerDraftWrites,
      readComposerDraft,
      readComposerDraftSync,
      saveComposerDraft,
    } = await import('@/session/composerDraftStore');
    let resolveGetItem!: (value: string | null) => void;
    vi.mocked(asyncStorage.getItem).mockImplementationOnce(() => new Promise((resolve) => {
      resolveGetItem = resolve;
    }));

    const readPromise = readComposerDraft('s1');
    saveComposerDraft('s1', 'new draft');
    resolveGetItem('old draft');

    await expect(readPromise).resolves.toBe('new draft');
    expect(readComposerDraftSync('s1')).toBe('new draft');
    await flushComposerDraftWrites('s1');
    expect(store.get(__testing.storageKeyForSession('s1'))).toBe('new draft');
  });

  it('cancels pending persistent writes when a draft is cleared', async () => {
    vi.useFakeTimers();
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const {
      __testing,
      readComposerDraftSync,
      saveComposerDraft,
    } = await import('@/session/composerDraftStore');

    saveComposerDraft('s1', 'old draft');
    saveComposerDraft('s1', '');

    expect(readComposerDraftSync('s1')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(__testing.persistDebounceMs);
    expect(vi.mocked(asyncStorage.setItem)).not.toHaveBeenCalled();
    expect(store.get(__testing.storageKeyForSession('s1'))).toBeUndefined();
  });

  it('flushes pending clears before reporting durable draft state', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const {
      __testing,
      flushComposerDraftWrites,
      saveComposerDraft,
    } = await import('@/session/composerDraftStore');
    const key = __testing.storageKeyForSession('s1');
    let resolveRemove!: () => void;
    vi.mocked(asyncStorage.removeItem).mockImplementationOnce((removeKey: string) => new Promise((resolve) => {
      resolveRemove = () => {
        store.delete(removeKey);
        resolve();
      };
    }));
    store.set(key, 'old draft');

    saveComposerDraft('s1', '');
    let flushed = false;
    const flushPromise = flushComposerDraftWrites('s1').then(() => {
      flushed = true;
    });
    await flushMicrotasks();

    expect(flushed).toBe(false);
    expect(store.get(key)).toBe('old draft');
    expect(vi.mocked(asyncStorage.removeItem)).toHaveBeenCalledWith(key);

    resolveRemove();
    await flushPromise;

    expect(flushed).toBe(true);
    expect(store.get(key)).toBeUndefined();
  });

  // Unit regression: signing out clears group chat drafts. Pending and stored group drafts must go,
  // including one only on disk from an earlier launch, while task drafts stay untouched.
  it('clears only drafts under a prefix, in memory, pending and on disk', async () => {
    vi.useFakeTimers();
    const { __testing, clearComposerDraftsWithPrefix, flushComposerDraftWrites, readComposerDraft, readComposerDraftSync, saveComposerDraft } = await import('@/session/composerDraftStore');
    saveComposerDraft('s1', 'task draft');
    saveComposerDraft('bot-group:a:mac:g1:', 'stored group draft');
    await flushComposerDraftWrites();
    saveComposerDraft('bot-group:a:mac:g2:', 'pending group draft');
    store.set(__testing.storageKeyForSession('bot-group:a:mac:g3:'), 'earlier launch');

    await clearComposerDraftsWithPrefix('bot-group:');
    await vi.advanceTimersByTimeAsync(__testing.persistDebounceMs);

    expect([...store.keys()]).toEqual([__testing.storageKeyForSession('s1')]);
    expect(readComposerDraftSync('bot-group:a:mac:g1:')).toBeNull();
    expect(await readComposerDraft('bot-group:a:mac:g3:')).toBeNull();
    expect(readComposerDraftSync('s1')).toBe('task draft');
  });

  // Unit regression (review of #13286): a disk read already waiting when the prefix clear ran used to
  // put the cleared draft back into memory, so signing in again in the same run showed it.
  it('does not let a read that started before a prefix clear bring the draft back', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const { __testing, clearComposerDraftsWithPrefix, readComposerDraft, readComposerDraftSync } = await import('@/session/composerDraftStore');
    const id = 'bot-group:a:mac:g1:';
    store.set(__testing.storageKeyForSession(id), 'before sign-out');
    let release!: () => void;
    vi.mocked(asyncStorage.getItem).mockImplementationOnce((key: string) => new Promise((resolve) => {
      release = () => resolve(store.get(key) ?? null);
    }));
    const reading = readComposerDraft(id);
    await flushMicrotasks();
    const value = store.get(__testing.storageKeyForSession(id));
    await clearComposerDraftsWithPrefix('bot-group:');
    store.set(__testing.storageKeyForSession(id), value!);
    release();
    expect(await reading).toBeNull();
    expect(readComposerDraftSync(id)).toBeNull();
  });

  // Unit regression (review of #13286): a read of a disk-only draft that starts while the prefix clear is
  // still listing keys must not keep the old text in memory after the clear removes it.
  it('does not let a read that starts during a prefix clear keep the draft', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const { __testing, clearComposerDraftsWithPrefix, readComposerDraft, readComposerDraftSync } = await import('@/session/composerDraftStore');
    const id = 'bot-group:a:mac:g1:';
    store.set(__testing.storageKeyForSession(id), 'on disk only');
    let releaseKeys!: () => void;
    vi.mocked(asyncStorage.getAllKeys).mockImplementationOnce(() => new Promise((resolve) => {
      releaseKeys = () => resolve([...store.keys()]);
    }));
    const clearing = clearComposerDraftsWithPrefix('bot-group:');
    await flushMicrotasks();
    const reading = readComposerDraft(id);
    releaseKeys();
    await clearing;
    expect(await reading).toBeNull();
    expect(readComposerDraftSync(id)).toBeNull();
    expect(store.has(__testing.storageKeyForSession(id))).toBe(false);
  });

  // Unit regression (review of #13286): voiding one account's draft generation drops only that generation's drafts,
  // after the account record committed; the same account's newer generation and another realm keep theirs.
  it('drops exactly the voided generation of one account, across realms and generations', async () => {
    const { accountVaultKey } = await import('@cindy/auth-client');
    const { botGroupComposerDraftId, connectBotGroupDraftEpochs } = await import('@/session/botGroupComposerDraft');
    connectBotGroupDraftEpochs(fakeEpochSource());
    const { __testing, flushComposerDraftWrites, readComposerDraft, readComposerDraftSync, saveComposerDraft } = await import('@/session/composerDraftStore');
    const cnKey = accountVaultKey('cn', 'same');
    const id = (accountKey: string, epoch: string) => botGroupComposerDraftId({ accountKey, epoch, deviceId: 'mac', groupId: 'g1' })!;
    const voided = id(cnKey, 'old');
    const newer = id(cnKey, 'new');
    const global = id(accountVaultKey('global', 'same'), 'old');
    expect(new Set([voided, newer, global]).size).toBe(3);
    expect(botGroupComposerDraftId({ accountKey: cnKey, epoch: null, deviceId: 'mac', groupId: 'g1' })).toBeNull();
    saveComposerDraft(voided, 'voided draft');
    saveComposerDraft(newer, 'newer draft');
    saveComposerDraft(global, 'global draft');
    await flushComposerDraftWrites();
    vault.listener!([{ accountKey: cnKey, epoch: 'old' }]);
    await vi.waitFor(() => expect(store.has(__testing.storageKeyForSession(voided))).toBe(false));
    expect(readComposerDraftSync(voided)).toBeNull();
    expect(await readComposerDraft(voided)).toBeNull();
    expect(store.get(__testing.storageKeyForSession(newer))).toBe('newer draft');
    expect(store.get(__testing.storageKeyForSession(global))).toBe('global draft');
  });

  it('sweeps stored group drafts whose generation is no longer current, and skips when the record is unreadable', async () => {
    const { accountVaultKey } = await import('@cindy/auth-client');
    const { botGroupComposerDraftId, connectBotGroupDraftEpochs, sweepStaleBotGroupDrafts, __testing: draftTesting } = await import('@/session/botGroupComposerDraft');
    connectBotGroupDraftEpochs(fakeEpochSource());
    const { __testing } = await import('@/session/composerDraftStore');
    const key = accountVaultKey('cn', 'sweep');
    const current = botGroupComposerDraftId({ accountKey: key, epoch: 'current', deviceId: 'mac', groupId: 'g1' })!;
    const stale = botGroupComposerDraftId({ accountKey: key, epoch: 'voided', deviceId: 'mac', groupId: 'g1' })!;
    // Written before generations existed: account, computer, group, topic.
    const legacy = `bot-group:${[key, 'mac', 'g1', ''].map(encodeURIComponent).join(':')}`;
    const task = 'session-1';
    for (const draftId of [current, stale, legacy, task]) store.set(__testing.storageKeyForSession(draftId), draftId);
    vault.epochs = null;
    draftTesting.resetStaleSweep();
    await sweepStaleBotGroupDrafts();
    expect(store.size).toBe(4);
    vault.epochs = { [key]: 'current' };
    await sweepStaleBotGroupDrafts();
    await vi.waitFor(() => expect(store.has(__testing.storageKeyForSession(stale))).toBe(false));
    expect(store.has(__testing.storageKeyForSession(legacy))).toBe(false);
    expect(store.get(__testing.storageKeyForSession(current))).toBe(current);
    expect(store.get(__testing.storageKeyForSession(task))).toBe(task);
  });

  it('orders a new persistent write after an in-flight clear', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const {
      __testing,
      flushComposerDraftWrites,
      saveComposerDraft,
    } = await import('@/session/composerDraftStore');
    const key = __testing.storageKeyForSession('s1');
    let resolveRemove!: () => void;
    vi.mocked(asyncStorage.removeItem).mockImplementationOnce((removeKey: string) => new Promise((resolve) => {
      resolveRemove = () => {
        store.delete(removeKey);
        resolve();
      };
    }));
    store.set(key, 'old draft');

    saveComposerDraft('s1', '');
    saveComposerDraft('s1', 'new draft');
    const flushPromise = flushComposerDraftWrites('s1');
    await flushMicrotasks();

    expect(store.get(key)).toBe('old draft');
    expect(vi.mocked(asyncStorage.removeItem)).toHaveBeenCalledWith(key);

    resolveRemove();
    await flushPromise;

    expect(store.get(key)).toBe('new draft');
  });
});
