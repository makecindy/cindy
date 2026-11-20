import { describe, expect, it, vi } from 'vitest';
import { clearSessionProvider, getSessionProvider, setSessionProvider } from '../../maker-host/session-provider-store.js';
import { PendingCredentialSwitchService } from '../pendingCredentialSwitch.js';

// §3.2, unit. The desktop has no settlement permit. A queue wake or client push
// moving by even a microtask changes which route the next input observes.
// Count both calls and microtask boundaries at the public service entries.
describe('desktop credential settlement without a permit', () => {
  for (const path of ['timer', 'close', 'pi', 'persist', 'applied'] as const) {
    it(`preserves the ${path} sequence`, async () => {
      const id = 'desktop-settle-' + path;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      setSessionProvider(id, 'before');
      const calls: string[] = [];
      let tick = 0;
      const record = (event: string) => calls.push(`${tick} ${event} ${getSessionProvider(id)}`);
      const service = new PendingCredentialSwitchService({
        maker: { listActiveSessions: () => { record('sessions'); return []; }, closeSession: async () => {} },
        ...(path === 'persist' || path === 'pi' ? {
          resolveRoute: async () => { record('resolve'); return { model: 'model', providerId: 'after', degraded: false }; },
          persistRoute: async () => { record('persist'); },
        } : {}),
        applyPiPending: async () => { record('pi'); return 'applied'; },
        onApplied: () => record('wake'),
        broadcastApplied: () => record('applied'),
      });
      try {
        service.register(id, { model: 'model', providerId: 'after', agentKind: path === 'pi' ? 'pi' : 'codex' });
        if (path === 'timer') vi.advanceTimersByTime(10_000);
        else if (path === 'close') service.onSessionClosed(id);
        else void service.onTurnSettled(id);
        for (tick = 1; tick <= 12; tick++) await Promise.resolve();
        const expected = {
          timer: ['0 sessions before', '0 wake after', '0 applied after'],
          close: ['0 wake after', '0 applied after'],
          pi: ['0 sessions before', '0 resolve before', '2 pi before', '3 wake before', '3 applied before'],
          persist: ['0 sessions before', '0 resolve before', '2 persist after', '3 wake after', '3 applied after'],
          applied: ['0 sessions before', '0 wake after', '0 applied after'],
        };
        expect(calls).toEqual(expected[path]);
        expect(service.has(id)).toBe(false);
      } finally {
        service.clear(id);
        clearSessionProvider(id);
        vi.useRealTimers();
      }
    });
  }
});

// §3.2, unit. A hold can start inside Pi's model-window transaction. A thrown
// stale check must preserve the pending choice without initiating desktop rollback.
it('defers an in-flight Pi transaction and discards only its own registration without rollback', async () => {
  let open = true;
  let permittedInsideTransaction: boolean | undefined;
  const events: string[] = [];
  const target = { model: 'model', providerId: 'new', agentKind: 'pi' as const,
    previousRoute: { model: 'old', providerId: 'old-source' } };
  const service = new PendingCredentialSwitchService({
    settlementPermit: { registered() {}, allows: () => open },
    maker: { listActiveSessions: () => [], closeSession: async () => {} },
    applyPiPending: async (_id, _target, _route, isCurrent) => {
      open = false;
      permittedInsideTransaction = isCurrent();
      throw new Error('transaction deferred');
    },
    persistRoute: async () => { events.push('write'); },
    onApplied: () => events.push('wake'),
    broadcastApplied: () => events.push('applied'),
    broadcastFailed: payload => events.push(payload.reason),
  });
  try {
    service.register('pi', target);
    const old = service.get('pi')!;
    await service.onTurnSettled('pi');
    expect(permittedInsideTransaction).toBe(false);
    expect(service.get('pi')).toBe(old);
    expect(events).toEqual([]);
    open = true;
    service.register('pi', target);
    service.discard('pi', old, true);
    expect(service.has('pi')).toBe(true);
    expect(events).toEqual([]);
    service.discard('pi', service.get('pi')!, true);
    expect(service.has('pi')).toBe(false);
    expect(events).toEqual(['apply-failed']);
  } finally {
    service.clear('pi');
  }
});

// §3.2, unit. Entry permission protects the work before the final write check,
// including reading the catalog for an externally closed, already cold task.
it('a closed permit prevents timer and close callbacks from even starting settlement', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const calls: string[] = [];
  const service = new PendingCredentialSwitchService({
    settlementPermit: { registered() {}, allows: () => false },
    maker: { listActiveSessions: () => { calls.push('sessions'); return []; }, closeSession: async () => {} },
    resolveRoute: async () => { calls.push('catalog'); return { model: 'model', providerId: 'provider', degraded: false }; },
    persistRoute: async () => { calls.push('write'); },
    broadcastApplied: () => calls.push('applied'),
  });
  try {
    service.register('held', { model: 'model', providerId: 'provider', agentKind: 'codex' });
    await vi.advanceTimersByTimeAsync(10_000);
    service.onSessionClosed('held');
    expect(calls).toEqual([]);
    expect(service.has('held')).toBe(true);
  } finally {
    service.clear('held');
    vi.useRealTimers();
  }
});
