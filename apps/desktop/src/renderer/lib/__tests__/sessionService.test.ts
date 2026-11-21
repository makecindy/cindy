import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from '@/lib/sessionService';
import { dialogueWorkspaceUnavailableI18nKey } from '@/utils/ipcError';

vi.mock('@/lib/makerTransport', () => ({
  makerApiFor: vi.fn(),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: vi.fn(),
}));
const stickyOrigin = vi.hoisted(() => ({ get: vi.fn((): string | null => null) }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: stickyOrigin.get,
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

// #10323: exercise the real create adapter with Electron's serialized rejection.
// The main allocator coverage cannot catch a dropped or misclassified recovery reason.
// Unit input: one failed folderless dialogue create; no Electron or engine process needed.
it('keeps the dialogue workspace recovery reason through the session create IPC adapter', async () => {
  const rejectCreate = vi.fn().mockRejectedValueOnce(new Error(
    "Error invoking remote method 'local-db:sessions:create': Error: [PRECONDITION_FAILED] DIALOGUE_WORKSPACE_UNAVAILABLE",
  )).mockRejectedValueOnce(new Error(
    "Error invoking remote method 'local-db:sessions:create': Error: [PRECONDITION_FAILED] Account changed",
  ));
  vi.stubGlobal('window', { electronAPI: { localDb: { sessions: { create: rejectCreate } } } });
  try {
    const input = { workspaceKind: 'dialogue' } as const;
    expect(await create(input).catch(dialogueWorkspaceUnavailableI18nKey)).toBe(
      'settings.about.storage.dialogueDirectoryUnavailable',
    );
    expect(await create(input).catch(dialogueWorkspaceUnavailableI18nKey)).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

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

describe('sessionService.patchMeta routing', () => {
  beforeEach(() => {
    stickyOrigin.get.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    stickyOrigin.get.mockReturnValue(null);
  });

  function stub(update: ReturnType<typeof vi.fn>) {
    const invoke = vi.fn(async () => ({ id: 'session-1' }));
    vi.stubGlobal('window', {
      electronAPI: { localDb: { sessions: { update } }, deviceLink: { invoke } },
    });
    return { invoke };
  }

  it('writes notificationsMuted locally even when the session has a sticky remote origin', async () => {
    const update = vi.fn(async () => ({ id: 'session-1' }));
    const { invoke } = stub(update);
    stickyOrigin.get.mockReturnValue('device-a');
    const service = await loadSessionService();

    await service.patchMeta('session-1', { notificationsMuted: true });

    expect(update).toHaveBeenCalledWith('session-1', { notificationsMuted: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('still tunnels the other metadata writes for a sticky remote session', async () => {
    const update = vi.fn(async () => ({ id: 'session-1' }));
    const { invoke } = stub(update);
    stickyOrigin.get.mockReturnValue('device-a');
    const service = await loadSessionService();

    await service.patchMeta('session-1', { status: 'archived' });

    expect(invoke).toHaveBeenCalledWith('device-a', 'local-db:sessions:patch-meta', [
      'session-1',
      { status: 'archived' },
    ]);
    expect(update).not.toHaveBeenCalled();
  });
});
