import { describe, expect, it, vi } from 'vitest';
import type { SessionControllerSnapshot } from '@cindy/maker-shared/session-controller';
import { createSessionSubscription } from '../subscription.js';
import { withSessionCaller, requireSessionCaller } from '../callerContext.js';

const target = { deviceId: 'device-a', sessionId: 'task' };
function snapshot(connection: 'online' | 'offline' = 'online'): SessionControllerSnapshot {
  return { target, remoteHostId: null, ownerEpoch: 'owner', observedAtMs: 1, connection,
    freshness: connection === 'online' ? 'current' : 'stale', runtimeLoaded: true,
    execution: { instanceId: 'native', generation: 1 }, queue: { paused: false, pendingCount: 0, restoring: false },
    interactions: [], runtimeSelection: null,
    activity: { currentTurnActive: true, phase: 'running' } as SessionControllerSnapshot['activity'],
  };
}
describe('Session subscription read fencing', () => {
  it('finishes an old read normally, then reads fresh after an intervening event', async () => {
    let resolveOld!: (s: SessionControllerSnapshot) => void;
    const oldRead = new Promise<SessionControllerSnapshot>(r => { resolveOld = r; });
    let invalidate!: () => void;
    const emit = vi.fn();
    const read = vi.fn().mockImplementationOnce(() => oldRead).mockResolvedValue(snapshot());
    const sub = createSessionSubscription({ target, authorize: async () => {}, read, emit,
      listen: cb => { invalidate = cb; return () => {}; } });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    invalidate(); resolveOld(snapshot('offline'));
    expect((await oldRead).connection).toBe('offline');
    await sub.ready();
    expect(read).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0].snapshot.connection).toBe('online');
    sub.close();
  });
  it('does not publish an in-flight snapshot after unsubscribe or authorization loss', async () => {
    for (const action of ['unsubscribe', 'revoke']) {
      let resolve!: (s: SessionControllerSnapshot) => void;
      const pending = new Promise<SessionControllerSnapshot>(r => { resolve = r; });
      let allowed = true;
      const emit = vi.fn(), unlisten = vi.fn(), read = vi.fn(() => pending);
      const sub = createSessionSubscription({ target, read, emit, listen: () => unlisten,
        authorize: async () => { if (!allowed) throw new Error('revoked'); } });
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      if (action === 'unsubscribe') sub.close(); else allowed = false;
      resolve(snapshot()); await sub.ready();
      expect(emit.mock.calls.some(([update]) => 'snapshot' in update)).toBe(false);
      sub.close(); expect(unlisten).toHaveBeenCalledOnce();
    }
  });
  it('keeps independent device subscriptions separate', async () => {
    const a = vi.fn(), b = vi.fn();
    const other = { deviceId: 'device-b', sessionId: 'task' };
    const first = createSessionSubscription({ target, read: async () => snapshot(), emit: a, authorize: async () => {}, listen: () => () => {} });
    const second = createSessionSubscription({ target: other, read: async () => ({ ...snapshot(), target: other }), emit: b, authorize: async () => {}, listen: () => () => {} });
    await Promise.all([first.ready(), second.ready()]); first.resync(); await first.ready();
    expect(a).toHaveBeenCalledTimes(2); expect(b).toHaveBeenCalledOnce();
    first.close(); second.close();
  });
  it('reports offline mirrors as stale and restores a fresh snapshot after reconnect', async () => {
    const emit = vi.fn();
    const read = vi.fn().mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'DEVICE_OFFLINE' }))
      .mockResolvedValue(snapshot());
    const sub = createSessionSubscription({ target, read, emit, authorize: async () => {}, listen: () => () => {} });
    await sub.ready(); sub.resync(); await sub.ready();
    expect(emit.mock.calls[1][0]).toMatchObject({ event: { connection: 'offline', freshness: 'stale', kind: 'connection-invalidated' } });
    expect(emit.mock.calls[1][0]).not.toHaveProperty('snapshot');
    sub.resync(); await sub.ready();
    expect(emit.mock.calls[2][0].snapshot.connection).toBe('online'); sub.close();
  });
  it.each(['NOT_AUTHORIZED', 'OWNER_SCOPE_CHANGED', 'CONTROL_DISABLED'])('closes and releases subscriptions on %s', async code => {
    const emit = vi.fn(), unlisten = vi.fn(), onClose = vi.fn();
    let allowed = true;
    const sub = createSessionSubscription({ target, emit, read: async () => snapshot(), listen: () => unlisten, onClose,
      authorize: async () => { if (!allowed) throw Object.assign(new Error('revoked'), { code }); } });
    await sub.ready(); allowed = false; sub.resync(); await sub.ready();
    expect(emit.mock.calls[1][0].error.code).toBe(code);
    sub.resync(); sub.close(); expect(emit).toHaveBeenCalledTimes(2);
    expect(unlisten).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
  });
  it('discards an old connection failure after a newer signal and carries input correlation', async () => {
    let fail!: (error: unknown) => void;
    let invalidate!: (kind?: 'input-dispatched', inputId?: string) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; })).mockResolvedValue(snapshot());
    const emit = vi.fn();
    const sub = createSessionSubscription({ target, emit, read, authorize: async () => {}, listen: cb => { invalidate = cb; return () => {}; } });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    invalidate('input-dispatched', 'accepted-input'); fail(Object.assign(new Error('old failure'), { code: 'DEVICE_OFFLINE' }));
    await sub.ready(); expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0].event).toMatchObject({ kind: 'input-dispatched', inputId: 'accepted-input', connection: 'online' }); sub.close();
  });
  it('does not retain a completed caller lease in an inherited timer', async () => {
    let later!: Promise<unknown>;
    await withSessionCaller({ source: 'plugin', authorize: async () => {} }, async () => {
      later = new Promise(resolve => setTimeout(() => {
        try { requireSessionCaller(); resolve('incorrectly authorized'); }
        catch (error) { resolve(error); }
      }, 0));
    });
    expect(await later).toMatchObject({ code: 'NOT_AUTHORIZED' });
  });
});
