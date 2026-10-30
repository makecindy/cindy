import { describe, expect, it, vi } from 'vitest';
import { syncSessionMessageWindow } from '@/session/sessionMessageWindowSync';
import { shouldKeepOlderMessagesAffordance, type MessagePageRetryResult } from '@/session/messagePaging';
import type { RemoteMessage, RemoteSession } from '@/session/types';
import { resolveSessionMessageEmptyState, type MessageHistoryRead, type SessionMessageEmptyStateInput } from '@/session/sessionEmptyState';
import { waitForIndependentSnapshotReads } from '@/device-link/sessionSnapshotSingleFlight';
import zhMessages from '@/i18n/locales/zh-CN/message.json';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const session = { id: 's1', updatedAt: '2026-09-05T00:00:00Z', _count: { messages: 100 } } as RemoteSession;
const page: MessagePageRetryResult = {
  messages: [{ id: 'host-row', clientId: 'host-row', sessionId: 's1' } as RemoteMessage],
  limit: 1,
  reducedByPayloadTooLarge: true,
};

function fixture(isReopen = false) {
  return {
    isReopen,
    storedSession: session,
    readMetadata: vi.fn(async () => session),
    readLatest: vi.fn(async () => page),
    isCurrent: vi.fn(() => true),
    isWindowSynced: vi.fn(() => false),
    commit: vi.fn(),
  };
}

function historyFixture() {
  const state = { historyRead: null as MessageHistoryRead | null };
  const generationRef = { current: 1 };
  const input = {
    ...fixture(),
    historyConfirmation: {
      key: JSON.stringify(['d1', 's1', 1]), generation: 1, generationRef,
      commit: (read: MessageHistoryRead) => { state.historyRead = read; },
    },
  };
  input.readLatest.mockResolvedValue({ ...page, messages: [] });
  const presentation = (overrides: Partial<SessionMessageEmptyStateInput> = {}) => resolveSessionMessageEmptyState({
    subscriptionIdentity: input.historyConfirmation.key, historyRead: state.historyRead,
    historySnapshot: { ready: false, items: [] }, messageCount: 0,
    loading: false, showSyncingShell: false, remoteUnavailableReason: null,
    status: 'online', targetAvailable: true,
    historyNotCachedMessage: zhMessages.renderer.historyNotCached,
    ...overrides,
  });
  return { input, state, presentation };
}

// #6519 / #6527, unit: execute the production history sync entry, including its
// visit fence and success marking, then assert the production presentation.
// Legacy AST callback cases bypassed this import boundary. Empty history plus a
// failed sibling read, reconnect, or late visit is the smallest missing input.
describe('history confirmation and empty presentation', () => {
  it('preserves invalidation across reconnect and a failed history read', async () => {
    const f = historyFixture();
    await syncSessionMessageWindow(f.input);
    f.state.historyRead = { key: f.input.historyConfirmation.key, synced: false };
    f.input.historyConfirmation.key = JSON.stringify(['d1', 's1', 2]);
    const cached = { historySnapshot: { ready: true, items: [] } };
    expect(f.presentation({ ...cached, status: 'connecting', targetAvailable: null }))
      .toEqual({ syncingWhileEmpty: true, emptyMessage: undefined });
    f.input.readLatest.mockRejectedValueOnce(new Error('[INVOKE_TIMEOUT] history'));
    await expect(syncSessionMessageWindow(f.input)).rejects.toThrow('history');
    expect(f.presentation(cached)).toEqual({ syncingWhileEmpty: true, emptyMessage: undefined });
    expect(f.presentation({ ...cached, status: 'stopped' })).toEqual({
      syncingWhileEmpty: false, emptyMessage: '历史消息尚未缓存，连接电脑后同步',
    });
    await syncSessionMessageWindow(f.input);
    expect(f.presentation(cached)).toEqual({ syncingWhileEmpty: false, emptyMessage: undefined });
  });

  it('requires an uncached task to read its own history after a different task synced', async () => {
    const f = historyFixture();
    await syncSessionMessageWindow(f.input);
    expect(f.presentation()).toEqual({ syncingWhileEmpty: false, emptyMessage: undefined });
    f.input.historyConfirmation.key = JSON.stringify(['d1', 's2', 2]);
    expect(f.presentation({ status: 'stopped' })).toEqual({
      syncingWhileEmpty: false, emptyMessage: '历史消息尚未缓存，连接电脑后同步',
    });
    expect(f.presentation()).toEqual({ syncingWhileEmpty: true, emptyMessage: undefined });
    f.input.readMetadata.mockResolvedValue({ ...session, id: 's2' });
    await syncSessionMessageWindow(f.input);
    expect(f.presentation()).toEqual({ syncingWhileEmpty: false, emptyMessage: undefined });
  });

  it.each(['metadata', 'projection'])('recognizes fetched empty history even if %s fails', async (failedRead) => {
    const f = historyFixture();
    const failure = new Error(`[INVOKE_TIMEOUT] ${failedRead}`);
    if (failedRead === 'metadata') f.input.readMetadata.mockRejectedValue(failure);
    await expect(waitForIndependentSnapshotReads([
      syncSessionMessageWindow(f.input),
      failedRead === 'projection' ? Promise.reject(failure) : Promise.resolve(),
    ])).rejects.toThrow(failedRead);
    expect(f.presentation()).toEqual({ syncingWhileEmpty: false, emptyMessage: undefined });
  });

  it.each(['visit', 'connection'])('does not let a late empty read certify a later %s', async (change) => {
    const f = historyFixture();
    const history = deferred<MessagePageRetryResult>();
    f.input.readLatest.mockReturnValueOnce(history.promise);
    const result = syncSessionMessageWindow(f.input);
    if (change === 'visit') f.input.historyConfirmation.generationRef.current += 1;
    else f.input.isCurrent.mockReturnValue(false);
    history.resolve({ ...page, messages: [] });
    await result;
    expect(f.presentation({ status: 'stopped' })).toEqual({
      syncingWhileEmpty: false, emptyMessage: '历史消息尚未缓存，连接电脑后同步',
    });
  });

  it('confirms a verified unchanged cached window without fetching another page', async () => {
    const f = historyFixture();
    const emptySession = { ...session, _count: { messages: 0 } };
    f.input.isReopen = true;
    f.input.storedSession = emptySession;
    f.input.readMetadata.mockResolvedValue(emptySession);
    f.input.isWindowSynced.mockReturnValue(true);
    await syncSessionMessageWindow(f.input);
    expect(f.input.readLatest).not.toHaveBeenCalled();
    expect(f.presentation({ status: 'stopped' })).toEqual({ syncingWhileEmpty: false, emptyMessage: undefined });
  });
});

describe('independent session history sync', () => {
  it.each([false, true])('commits history and preserves pagination when projection fails (reopen=%s)', async (isReopen) => {
    const input = fixture(isReopen);
    const history = deferred<MessagePageRetryResult>();
    input.readLatest.mockReturnValue(history.promise);
    const projectionError = new Error('[INVOKE_TIMEOUT] projection');
    const result = Promise.allSettled([
      syncSessionMessageWindow(input),
      Promise.reject(projectionError),
    ]);
    await Promise.resolve();
    expect(input.commit).not.toHaveBeenCalled();
    history.resolve(page);
    const outcomes = await result;
    expect(input.commit).toHaveBeenCalledWith(session, page);
    expect(shouldKeepOlderMessagesAffordance(input.commit.mock.calls[0][1])).toBe(true);
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1]).toEqual({ status: 'rejected', reason: projectionError });
  });

  it('starts cold metadata and history concurrently', async () => {
    const input = fixture();
    const metadata = deferred<RemoteSession>();
    input.readMetadata.mockReturnValue(metadata.promise);
    const result = syncSessionMessageWindow(input);
    expect(input.readLatest).toHaveBeenCalledOnce();
    expect(input.commit).not.toHaveBeenCalled();
    metadata.resolve(session);
    await result;
    expect(input.commit).toHaveBeenCalledWith(session, page);
  });

  it('reconciles cached pagination without refetching unchanged, synced history', async () => {
    const input = fixture(true);
    input.isWindowSynced.mockReturnValue(true);
    await syncSessionMessageWindow(input);
    expect(input.readLatest).not.toHaveBeenCalled();
    expect(input.commit).toHaveBeenCalledWith(session, null);
  });

  it('refreshes running history when the host metadata changes', async () => {
    const input = fixture(true);
    const updated = { ...session, updatedAt: '2026-09-05T00:01:00Z' };
    input.isWindowSynced.mockReturnValue(true);
    input.readMetadata.mockResolvedValue(updated);
    await syncSessionMessageWindow(input);
    expect(input.commit).toHaveBeenCalledWith(updated, page);
  });

  it.each([false, true])('does not commit a late page after authority or page identity changes (reopen=%s)', async (isReopen) => {
    const input = fixture(isReopen);
    const history = deferred<MessagePageRetryResult>();
    input.readLatest.mockReturnValue(history.promise);
    const result = syncSessionMessageWindow(input);
    await Promise.resolve();
    input.isCurrent.mockReturnValue(false);
    history.resolve(page);
    await result;
    expect(input.commit).not.toHaveBeenCalled();
  });

  it('does not start a reopened history request after metadata loses authority', async () => {
    const input = fixture(true);
    input.isCurrent.mockReturnValue(false);
    await syncSessionMessageWindow(input);
    expect(input.readLatest).not.toHaveBeenCalled();
    expect(input.commit).not.toHaveBeenCalled();
  });

  it('keeps a real history failure visible without marking the window synced', async () => {
    const input = fixture();
    const error = new Error('[INVOKE_TIMEOUT] history');
    input.readLatest.mockRejectedValue(error);
    await expect(syncSessionMessageWindow(input)).rejects.toBe(error);
    expect(input.commit).not.toHaveBeenCalled();
  });
});
