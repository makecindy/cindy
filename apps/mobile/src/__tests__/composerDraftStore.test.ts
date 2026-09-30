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
