import { sharedTaskHostPeer } from '@cindy/device-link';
import { sharedTaskGuestPeer } from '@cindy/device-link';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSharedTaskApi, parseSharedTaskSnapshot, type SharedTaskDetail } from '@cindy/device-link';
import type { SharedTaskJournalEntry } from '../../localDb/sharedTasks.js';
import { SharedTaskHost, type SharedTaskHostOptions } from '../sharedTaskHost.js';
import { executeSharedTaskHostCommand } from '../sharedTaskCommands.js';
import { createIpcError } from '../../../shared/ipc-errors.js';

const detail = (revision = 1): SharedTaskDetail => ({
  sharedTaskId: 'sharedTask', sessionId: 'session', ownerAccountId: 'owner', hostDeviceId: 'desktop',
  revision, status: 'active', title: 'Task',
  guests: [
    { memberId: 'member-a', accountId: 'guest-a', deviceIds: ['phone-a'], version: 1 },
    { memberId: 'member-b', accountId: 'guest-b', deviceIds: ['phone-b'], version: 1 },
  ],
  memberLabels: [],
});
const api = {
  create: vi.fn(), list: vi.fn(), get: vi.fn(), invite: vi.fn(), join: vi.fn(),
  remove: vi.fn(), leave: vi.fn(), close: vi.fn(),
};
let records: Map<string, SharedTaskJournalEntry>;
let options: SharedTaskHostOptions;
let host: SharedTaskHost;
let current: boolean;
let serverDetail: SharedTaskDetail;
const canRead = (member = 'a') => host.authorize('sharedTask', { accountId: `guest-${member}`, deviceId: `phone-${member}` }, 'session', 'history.read').allowed;
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  current = true;
  serverDetail = detail();
  records = new Map();
  api.create.mockResolvedValue({ sharedTaskId: 'sharedTask', revision: 1 });
  api.get.mockImplementation(async () => serverDetail);
  api.list.mockImplementation(async () => serverDetail.status === 'active' ? [serverDetail] : []);
  options = {
    api, ownerAccountId: 'owner', hostDeviceId: 'desktop', isCurrent: () => current,
    readSession: vi.fn(async (id) => ({ id, title: 'Task', status: 'active' })),
    revoke: vi.fn(), changed: vi.fn(), journal: {
      async latest() { return structuredClone([...records.values()]); },
      async recordAuthority(snapshot) {
        const previous = records.get(snapshot.sharedTaskId);
        if (previous?.terminal || (previous?.snapshot?.revision ?? 0) >= snapshot.revision) return false;
        records.set(snapshot.sharedTaskId, { sharedTaskId: snapshot.sharedTaskId, sessionId: snapshot.sessionId,
          terminal: snapshot.status === 'closed', snapshot: parseSharedTaskSnapshot(snapshot) });
        return true;
      },
      async close(identity) {
        records.set(identity.sharedTaskId, { sharedTaskId: identity.sharedTaskId, sessionId: identity.sessionId, terminal: true, snapshot: null });
      },
    },
  };
  host = new SharedTaskHost(options);
});
describe('task host sharedTask lifecycle', () => {
  it('consumes another instance closure offline and invalidates captured access without touching another share', async () => {
    await host.open('session');
    const old = host.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-a', 'phone-a'))!;
    const secondDetail = { ...detail(), sharedTaskId: 'other-share', sessionId: 'other-session' };
    api.create.mockResolvedValueOnce({ sharedTaskId: 'other-share', revision: 1 });
    api.get.mockResolvedValueOnce(secondDetail);
    await host.open('other-session');
    const other = host.capturePeer(sharedTaskGuestPeer('other-share', 'member-b', 'phone-b'))!;
    await options.journal.close(detail());
    vi.mocked(options.revoke).mockClear();
    api.list.mockRejectedValue(new Error('offline'));
    await host.restore(false);
    expect(old.isCurrent()).toBe(false);
    expect(canRead()).toBe(false);
    expect(other.isCurrent()).toBe(true);
    expect(options.revoke).toHaveBeenCalledExactlyOnceWith('sharedTask');
    expect(api.list).not.toHaveBeenCalled();
    await expect(host.restore()).rejects.toThrow('offline');
    expect(old.isCurrent()).toBe(false);
  });
  it.each(['archived', 'deleted'])('closes externally %s tasks even when the writing process never notified runtime', async (status) => {
    await host.open('session');
    const old = host.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-a', 'phone-a'))!;
    options.readSession = vi.fn(async (id) => ({ id, title: 'Task', status }));
    await host.restore();
    expect(old.isCurrent()).toBe(false);
    expect(records.get('sharedTask')?.terminal).toBe(true);
    expect(api.close).toHaveBeenCalledWith('sharedTask');
  });
  it('closes a server-side share for a deleted task that was never restored locally', async () => {
    options.readSession = vi.fn(async () => null);
    await host.restore();
    expect(records.get('sharedTask')?.terminal).toBe(true);
    expect(api.close).toHaveBeenCalledWith('sharedTask');
    expect(api.get).not.toHaveBeenCalled();
  });
  it('allows first sharing after an unshared task is archived and restored', async () => {
    await host.closeLocallyForBoundary('session');
    options.readSession = vi.fn(async (id) => ({ id, title: 'Task', status: 'archived' }));
    await expect(host.open('session')).rejects.toThrow('unavailable');
    expect(api.create).not.toHaveBeenCalled();
    options.readSession = vi.fn(async (id) => ({ id, title: 'Task', status: 'active' }));
    await expect(host.open('session')).resolves.toBe('sharedTask');
    expect(canRead()).toBe(true);
  });

  it('waits for archive durability and server closure before creating a fresh share', async () => {
    await host.open('session');
    const oldCapture = host.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-a', 'phone-a'))!;
    let finishRefresh!: (value: SharedTaskDetail) => void;
    api.get.mockImplementationOnce(() => new Promise<SharedTaskDetail>((resolve) => { finishRefresh = resolve; }));
    const refresh = host.refresh('sharedTask');
    const staleRejected = expect(refresh).rejects.toThrow('closed');
    await vi.waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
    const persist = options.journal.close;
    let finishWrite!: () => void;
    options.journal.close = vi.fn(async (identity) => {
      await new Promise<void>((resolve) => { finishWrite = resolve; });
      await persist(identity);
    });
    const archive = host.closeLocallyForBoundary('session');
    await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
    const reopen = host.open('session');
    await Promise.resolve();
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.close).not.toHaveBeenCalled();
    api.close.mockImplementation(async () => {
      expect(records.get('sharedTask')?.terminal).toBe(true);
      serverDetail = { ...detail(), sharedTaskId: 'fresh-sharedTask' };
    });
    api.create.mockImplementation(async () => {
      expect(api.close).toHaveBeenCalledWith('sharedTask');
      return { sharedTaskId: 'fresh-sharedTask', revision: 1 };
    });
    finishWrite();
    await archive;
    await expect(reopen).resolves.toBe('fresh-sharedTask');
    finishRefresh(detail(2));
    await staleRejected;
    expect(oldCapture.isCurrent()).toBe(false);
    expect(records.get('sharedTask')?.terminal).toBe(true);
    expect(records.get('fresh-sharedTask')?.terminal).toBe(false);
    expect(host.capturePeer(sharedTaskGuestPeer('fresh-sharedTask', 'member-a', 'phone-a'))?.isCurrent()).toBe(true);
  });

  it('keeps an old open fenced when the restored task is already sharing again', async () => {
    let release!: () => void;
    vi.mocked(options.readSession).mockImplementationOnce(async (id) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { id, title: 'Task', status: 'active' };
    });
    const oldOpen = host.open('session');
    const rejected = expect(oldOpen).rejects.toThrow('closed');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await host.closeLocallyForBoundary('session');
    await expect(host.open('session')).resolves.toBe('sharedTask');
    release();
    await rejected;
    expect(api.create).toHaveBeenCalledOnce();
  });

  it('preserves an unfinished archive fence across same-profile host replacement', async () => {
    options.creationState = { pending: new Map(), identities: new Map() };
    host = new SharedTaskHost(options);
    await host.open('session');
    const persist = options.journal.close;
    let release!: () => void;
    options.journal.close = vi.fn(async (identity) => {
      await new Promise<void>((resolve) => { release = resolve; });
      await persist(identity);
    });
    const archive = host.closeLocallyForBoundary('session');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const disposing = host.dispose();
    host = new SharedTaskHost(options);
    const opening = host.open('session');
    await Promise.resolve();
    expect(api.create).toHaveBeenCalledOnce();
    api.create.mockResolvedValue({ sharedTaskId: 'fresh', revision: 1 });
    serverDetail = { ...detail(), sharedTaskId: 'fresh' };
    release();
    await archive;
    await disposing;
    await expect(opening).resolves.toBe('fresh');
    expect(records.get('fresh')?.terminal).toBe(false);
  });

  it('retries inherited terminal server closures before re-sharing, without reusing old invitations', async () => {
    await host.open('session');
    await host.closeLocallyForBoundary('session');
    await host.dispose();
    host = new SharedTaskHost(options);
    api.close.mockRejectedValueOnce(new Error('offline'));
    await expect(host.open('session')).rejects.toThrow('offline');
    expect(api.create).toHaveBeenCalledOnce();
    api.create.mockResolvedValue({ sharedTaskId: 'fresh', revision: 1 });
    serverDetail = { ...detail(), sharedTaskId: 'fresh' };
    await expect(host.open('session')).resolves.toBe('fresh');
    expect(api.close).toHaveBeenCalledTimes(2);
    expect(host.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-a', 'phone-a'))).toBeNull();
  });

  it.each([undefined, 'session'])('drains creates from a retired same-profile host at boundary (%s)', async (sessionId) => {
    let reply!: (value: unknown) => void;
    const request = vi.fn(() => new Promise<unknown>((resolve) => { reply = resolve; }));
    options.creationState = { pending: new Map(), identities: new Map() };
    options.api = createSharedTaskApi({ request, captureScope: () => ({ isCurrent: () => current }) });
    host = new SharedTaskHost(options);
    const opening = host.open('session');
    const rejected = expect(opening).rejects.toThrow('account or region changed');
    await vi.waitFor(() => expect(reply).toBeTypeOf('function'));
    current = false;
    await host.dispose();
    const replacement = new SharedTaskHost({ ...options, isCurrent: () => true });
    let finished = false;
    const closing = replacement.closeLocallyForBoundary(sessionId).then((ids) => { finished = true; return ids; });
    await Promise.resolve();
    expect(finished).toBe(false);
    reply({ sharedTaskId: 'late-sharedTask', revision: 1 });
    expect(await closing).toEqual(['late-sharedTask']);
    await rejected;
    expect(records.get('late-sharedTask')?.terminal).toBe(true);
    expect(replacement.capturePeer(sharedTaskGuestPeer('late-shared-task', 'member-a', 'phone-a'))).toBeNull();
  });
  it.each([undefined, 'session'])('drains a late committed create before releasing the outgoing profile (%s)', async (sessionId) => {
    let reply!: (value: unknown) => void;
    const request = vi.fn(() => new Promise<unknown>((resolve) => { reply = resolve; }));
    options.api = createSharedTaskApi({ request, captureScope: () => ({ isCurrent: () => current }) });
    const opening = host.open('session');
    const rejected = expect(opening).rejects.toThrow(sessionId ? 'Shared task was closed' : 'account or region changed');
    await vi.waitFor(() => expect(reply).toBeTypeOf('function'));
    if (!sessionId) current = false;
    let databaseReleased = false;
    const persist = options.journal.close;
    options.journal.close = vi.fn(async (identity) => {
      expect(databaseReleased).toBe(false);
      await persist(identity);
    });
    const boundary = host.closeLocallyForBoundary(sessionId).then((ids) => { databaseReleased = true; return ids; });
    await Promise.resolve();
    expect(databaseReleased).toBe(false);
    reply({ sharedTaskId: 'late-sharedTask', revision: 1 });
    expect(await boundary).toEqual(['late-sharedTask']);
    await rejected;
    expect(records.get('late-sharedTask')?.terminal).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    current = true;
    options.api = api;
    api.list.mockResolvedValue([{ ...detail(), sharedTaskId: 'late-sharedTask' }]);
    await new SharedTaskHost(options).restore();
    expect(api.close).toHaveBeenCalledWith('late-sharedTask');
  });
  it('retains a committed identity while the initial authority fetch is pending', async () => {
    let finish!: () => void;
    api.get.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return detail();
    });
    const opening = host.open('session');
    const rejected = expect(opening).rejects.toThrow('generation');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    current = false;
    expect(await host.closeLocallyForBoundary()).toEqual(['sharedTask']);
    expect(records.get('sharedTask')?.terminal).toBe(true);
    finish();
    await rejected;
  });
  it('does not grant an in-flight restore after the task boundary begins', async () => {
    let release!: () => void;
    options.readSession = vi.fn(async (id) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { id, title: 'Task', status: 'active' };
    });
    const refreshing = host.refresh('sharedTask');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await host.closeLocallyForBoundary('session');
    release();
    await expect(refreshing).rejects.toThrow('closed');
    expect(canRead()).toBe(false);
    expect(host.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-a', 'phone-a'))).toBeNull();
  });
  it('durably closes the outgoing profile after its network generation is fenced', async () => {
    await host.open('session');
    current = false;
    await host.dispose();
    await host.closeLocallyForBoundary();
    expect(records.get('sharedTask')?.terminal).toBe(true);
    expect(api.close).not.toHaveBeenCalled();
    current = true;
    const restored = new SharedTaskHost(options);
    await restored.restore();
    expect(api.close).toHaveBeenCalledWith('sharedTask');
    expect(restored.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-a', 'phone-a'))).toBeNull();
  });

  it('closes only the archived task and propagates a journal failure', async () => {
    await host.open('session');
    await host.closeLocallyForBoundary('another-task');
    expect(canRead()).toBe(true);
    options.journal.close = vi.fn(async () => { throw new Error('disk failed'); });
    await expect(host.closeLocallyForBoundary('session')).rejects.toThrow('disk failed');
    expect(canRead()).toBe(false);
    await expect(host.dispose()).rejects.toThrow('disk failed');
  });
  it('keeps both guests revoked and retries closure after disk failure and relay disposal', async () => {
    await host.open('session');
    const a = host.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-a', 'phone-a'))!;
    const b = host.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-b', 'phone-b'))!;
    const persist = options.journal.close;
    options.journal.close = vi.fn().mockRejectedValueOnce(new Error('disk failed')).mockImplementation(persist);
    await expect(host.closeLocallyForBoundary()).rejects.toThrow('disk failed');
    expect(a.isCurrent()).toBe(false);
    expect(b.isCurrent()).toBe(false);
    expect(canRead('a')).toBe(false);
    expect(canRead('b')).toBe(false);
    await expect(host.dispose()).rejects.toThrow('disk failed');
    // Relay release clears live entries, but the retained old DB still provides
    // the identity needed to retry the failed close record.
    await expect(host.closeLocallyForBoundary()).resolves.toEqual(['sharedTask']);
    expect(records.get('sharedTask')?.terminal).toBe(true);
    await expect(host.dispose()).resolves.toBeUndefined();
    expect(a.isCurrent()).toBe(false);
    expect(b.isCurrent()).toBe(false);
  });
  it('invalidates old captures without revoking existing devices when a member adds a device', async () => {
    await host.open('session');
    expect(host.capturePeer(sharedTaskHostPeer('sharedTask', 'desktop'))).toBeNull();
    expect(host.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-a', 'phone-b'))).toBeNull();
    const a = host.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-a', 'phone-a'))!;
    const b = host.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-b', 'phone-b'))!;
    expect(a.author.accountId).toBe('guest-a');
    expect(a.isCurrent()).toBe(true);
    serverDetail = { ...detail(2), guests: detail().guests.map((member) => member.memberId === 'member-a' ? { ...member, version: 2, deviceIds: [...member.deviceIds, 'second-phone'] } : member) };
    await host.refresh('sharedTask');
    expect(a.isCurrent()).toBe(false);
    expect(b.isCurrent()).toBe(true);
    expect(options.revoke).not.toHaveBeenCalled();
    expect(host.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-a', 'phone-a'))?.isCurrent()).toBe(true);
    expect(host.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-a', 'second-phone'))?.isCurrent()).toBe(true);
    await host.dispose();
    expect(b.isCurrent()).toBe(false);
  });
  it('opens an existing task and requires a server snapshot before granting access', async () => {
    expect(canRead()).toBe(false);
    expect(await host.open('session')).toBe('sharedTask');
    expect(api.create).toHaveBeenCalledWith('session', 'Task', expect.any(Function));
    expect(canRead()).toBe(true);
    expect(records.get('sharedTask')?.snapshot?.revision).toBe(1);
  });
  it('does not authorize from a persisted snapshot while offline', async () => {
    await options.journal.recordAuthority(detail());
    api.list.mockRejectedValue(new Error('offline'));
    await expect(host.restore()).rejects.toThrow('offline');
    expect(canRead()).toBe(false);
  });
  it('restores members without a new join request after the host restarts', async () => {
    await host.open('session');
    await host.dispose();
    host = new SharedTaskHost(options);
    expect(canRead()).toBe(false);
    await host.restore();
    expect(canRead()).toBe(true);
    expect(api.join).not.toHaveBeenCalled();
  });
  it('rejects another host or a different task returned for the create result', async () => {
    serverDetail = { ...detail(), hostDeviceId: 'other-desktop' };
    await expect(host.open('session')).rejects.toThrow('not hosted');
    serverDetail = { ...detail(), sessionId: 'other-session' };
    await expect(host.open('session')).rejects.toThrow('does not match');
    expect(records.size).toBe(0);
    expect(canRead()).toBe(false);
  });
  it('drops late replies after logout or host disposal', async () => {
    api.get.mockImplementation(async () => { current = false; return detail(); });
    await expect(host.open('session')).rejects.toThrow('generation');
    expect(records.size).toBe(0);
    expect(canRead()).toBe(false);
  });
  it('denies a removed member immediately while other peers continue working', async () => {
    await host.open('session');
    let finish!: () => void;
    api.remove.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const removing = host.remove('sharedTask', 'member-a');
    expect(canRead()).toBe(false);
    expect(canRead('b')).toBe(true);
    expect(options.revoke).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(api.remove).toHaveBeenCalled());
    serverDetail = { ...detail(2), guests: [detail().guests[1]] };
    finish();
    await removing;
    expect(options.revoke).toHaveBeenCalledExactlyOnceWith('sharedTask', 'member-a');
    expect(canRead()).toBe(false);
    expect(canRead('b')).toBe(true);
  });
  it('completes removal through the shared command when the guest already left', async () => {
    await host.open('session');
    const oldPeer = host.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-a', 'phone-a'))!;
    api.remove.mockImplementation(async () => {
      serverDetail = { ...detail(2), guests: [detail().guests[1]] };
      throw createIpcError('NOT_FOUND', 'Member no longer joined');
    });
    await expect(executeSharedTaskHostCommand(
      { action: 'remove', sharedTaskId: 'sharedTask', memberId: 'member-a' },
      { available: () => true, host: () => host },
    )).resolves.toEqual({ ok: true });
    expect(host.detail('sharedTask')?.status).toBe('active');
    expect(host.detail('sharedTask')?.guests.map((guest) => guest.memberId)).toEqual(['member-b']);
    expect(oldPeer.isCurrent()).toBe(false);
    expect(canRead()).toBe(false);
    expect(canRead('b')).toBe(true);
    expect(options.revoke).toHaveBeenCalledExactlyOnceWith('sharedTask', 'member-a');
    expect(api.close).not.toHaveBeenCalled();
  });
  it.each(['still-joined', 'closed', 'refresh-failed', 'account-changed'])(
    'does not treat NOT_FOUND as removal success when %s', async (outcome) => {
      await host.open('session');
      api.remove.mockRejectedValue(createIpcError('NOT_FOUND', 'Missing'));
      if (outcome === 'closed') serverDetail = { ...detail(2), status: 'closed', guests: [] };
      if (outcome === 'refresh-failed') api.get.mockRejectedValueOnce(new Error('offline'));
      if (outcome === 'account-changed') api.get.mockImplementationOnce(async () => {
        current = false; return { ...detail(2), guests: [] };
      });
      await expect(host.remove('sharedTask', 'member-a')).rejects.toThrow();
      if (outcome === 'refresh-failed') {
        expect(canRead()).toBe(false);
        expect(canRead('b')).toBe(true);
      }
    },
  );
  it.each(['PERMISSION_DENIED', 'DEVICE_LINK_NOT_CONNECTED'] as const)(
    'preserves %s even if the refreshed member has left', async (code) => {
      await host.open('session');
      const error = createIpcError(code, 'Request failed');
      api.remove.mockRejectedValue(error);
      serverDetail = { ...detail(2), guests: [detail().guests[1]] };
      await expect(host.remove('sharedTask', 'member-a')).rejects.toBe(error);
      expect(canRead('b')).toBe(true);
    },
  );
  it('retains a removal fence on network failure and recovers it only by reconciliation', async () => {
    await host.open('session');
    api.remove.mockRejectedValue(new Error('offline'));
    api.get.mockRejectedValueOnce(new Error('offline'));
    await expect(host.remove('sharedTask', 'member-a')).rejects.toThrow('offline');
    expect(canRead()).toBe(false);
    expect(canRead('b')).toBe(true);
    await host.refresh('sharedTask');
    expect(canRead()).toBe(true);
    expect(options.revoke).not.toHaveBeenCalled();
    expect(host.capturePeer(sharedTaskGuestPeer('sharedTask', 'member-a', 'phone-a'))?.isCurrent()).toBe(true);
  });
  it('closes locally before awaiting the server and retries durable closure after restart', async () => {
    await host.open('session');
    api.close.mockRejectedValueOnce(new Error('offline'));
    const closing = host.close('sharedTask');
    expect(canRead()).toBe(false);
    expect(host.detail('sharedTask')?.status).toBe('closed');
    await expect(closing).rejects.toThrow('offline');
    await host.dispose();
    host = new SharedTaskHost(options);
    api.close.mockResolvedValue({ sharedTaskId: 'sharedTask', status: 'closed' });
    await host.restore();
    expect(api.close).toHaveBeenCalledTimes(2);
    expect(canRead()).toBe(false);
  });
  it('observes sharedTasks closed on another owner device without reviving cached members', async () => {
    await host.open('session');
    serverDetail = { ...detail(2), status: 'closed' };
    await host.restore();
    expect(canRead()).toBe(false);
    expect(records.get('sharedTask')?.terminal).toBe(true);
  });
  it.each(['dispose', 'account-switch'] as const)('persists closure despite a pending refresh and %s', async (boundary) => {
    await host.open('session');
    let finish!: (value: SharedTaskDetail) => void;
    api.get.mockImplementationOnce(() => new Promise<SharedTaskDetail>((resolve) => { finish = resolve; }));
    const refresh = host.refresh('sharedTask');
    await vi.waitFor(() => expect(finish).toBeDefined());
    const refreshFailed = expect(refresh).rejects.toThrow('generation');
    const closing = host.close('sharedTask');
    const closeFailed = expect(closing).rejects.toThrow('generation');
    if (boundary === 'account-switch') current = false;
    else await host.dispose();
    // The close record must not wait for the outstanding HTTP request.
    expect(records.get('sharedTask')?.terminal).toBe(true);
    finish(detail(2));
    await refreshFailed;
    await closeFailed;
    expect(api.close).not.toHaveBeenCalled();
    current = true;
    host = new SharedTaskHost(options);
    await host.restore();
    expect(canRead()).toBe(false);
    expect(api.close).toHaveBeenCalledOnce();
  });
  it('waits for the bound journal on dispose without waiting for network requests', async () => {
    await host.open('session');
    const persist = options.journal.close;
    let finishWrite!: () => void;
    options.journal.close = vi.fn((identity) => new Promise<void>((resolve) => {
      finishWrite = () => { void persist(identity).then(resolve); };
    }));
    const closing = host.close('sharedTask');
    const closeFailed = expect(closing).rejects.toThrow('generation');
    let disposed = false;
    const disposing = Promise.resolve(host.dispose()).then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(canRead()).toBe(false);
    finishWrite();
    await disposing;
    await closeFailed;
    expect(records.get('sharedTask')?.terminal).toBe(true);
    expect(api.close).not.toHaveBeenCalled();
  });
  it('surfaces journal failure during close and disposal instead of claiming durability', async () => {
    await host.open('session');
    options.journal.close = vi.fn().mockRejectedValue(new Error('disk unavailable'));
    await expect(host.close('sharedTask')).rejects.toThrow('disk unavailable');
    expect(canRead()).toBe(false);
    expect(api.close).not.toHaveBeenCalled();
    await expect(Promise.resolve(host.dispose())).rejects.toThrow('disk unavailable');
  });
  it('does not let late refresh revive an explicitly closed sharedTask', async () => {
    await host.open('session');
    let finish!: (value: SharedTaskDetail) => void;
    api.get.mockImplementationOnce(() => new Promise<SharedTaskDetail>((resolve) => { finish = resolve; }));
    const refresh = host.refresh('sharedTask');
    await vi.waitFor(() => expect(finish).toBeDefined());
    const close = host.close('sharedTask');
    finish(detail(2));
    await expect(refresh).rejects.toThrow('closed');
    await close;
    expect(canRead()).toBe(false);
    expect(records.get('sharedTask')?.terminal).toBe(true);
  });
  it('keeps a live sharedTask usable when a background server refresh fails', async () => {
    await host.open('session');
    api.get.mockRejectedValueOnce(new Error('offline'));
    await expect(host.refresh('sharedTask')).rejects.toThrow('offline');
    expect(canRead()).toBe(true);
  });
});
