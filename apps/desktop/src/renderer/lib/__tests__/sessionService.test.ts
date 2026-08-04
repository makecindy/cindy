import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/makerTransport', () => ({
  makerApiFor: vi.fn(),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: vi.fn(),
}));

type SessionLike = { id: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadSessionService() {
  vi.resetModules();
  return import('@/lib/sessionService');
}

describe('sessionService.get in-flight deduplication', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shares one IPC request for concurrent reads of the same session', async () => {
    const pending = deferred<SessionLike>();
    const get = vi.fn(() => pending.promise);
    vi.stubGlobal('window', { electronAPI: { localDb: { sessions: { get } } } });
    const service = await loadSessionService();

    const first = service.get('session-1');
    const second = service.get('session-1');
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('session-1');
    expect(first).toBe(second);

    const session = { id: 'session-1' };
    pending.resolve(session);
    await expect(first).resolves.toBe(session);
    await expect(second).resolves.toBe(session);
  });

  it('keeps different session ids independent', async () => {
    const requests = new Map<string, ReturnType<typeof deferred<SessionLike>>>();
    const get = vi.fn((id: string) => {
      const request = deferred<SessionLike>();
      requests.set(id, request);
      return request.promise;
    });
    vi.stubGlobal('window', { electronAPI: { localDb: { sessions: { get } } } });
    const service = await loadSessionService();

    const first = service.get('session-a');
    const second = service.get('session-b');
    expect(get).toHaveBeenCalledTimes(2);

    requests.get('session-a')?.resolve({ id: 'session-a' });
    requests.get('session-b')?.resolve({ id: 'session-b' });
    await expect(first).resolves.toMatchObject({ id: 'session-a' });
    await expect(second).resolves.toMatchObject({ id: 'session-b' });
  });

  it('removes settled requests instead of retaining stale metadata', async () => {
    const get = vi.fn(async (id: string) => ({ id }));
    vi.stubGlobal('window', { electronAPI: { localDb: { sessions: { get } } } });
    const service = await loadSessionService();

    await service.get('session-1');
    await service.get('session-1');

    expect(get).toHaveBeenCalledTimes(2);
  });

  it('clears rejected requests so the next read can retry', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error('[NOT_FOUND] missing'))
      .mockResolvedValueOnce({ id: 'session-1' });
    vi.stubGlobal('window', { electronAPI: { localDb: { sessions: { get } } } });
    const service = await loadSessionService();

    const first = service.get('session-1');
    const second = service.get('session-1');
    expect(first).toBe(second);
    await expect(first).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(second).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(service.get('session-1')).resolves.toMatchObject({ id: 'session-1' });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
