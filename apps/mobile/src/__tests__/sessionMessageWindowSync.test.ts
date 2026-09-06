import { describe, expect, it, vi } from 'vitest';
import { syncSessionMessageWindow } from '@/session/sessionMessageWindowSync';
import { shouldKeepOlderMessagesAffordance, type MessagePageRetryResult } from '@/session/messagePaging';
import type { RemoteMessage, RemoteSession } from '@/session/types';

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
