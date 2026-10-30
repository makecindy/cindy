import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayCodexRestartService } from '../gatewayCodexRestart.js';
import { CodexCredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch.js';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

function harness() {
  const busy = new Set<string>();
  const unavailable = new Set<string>();
  const keys = ['gateway-a', 'gateway-b'];
  const applied: string[] = [];
  const wake = vi.fn();
  const restart = vi.fn(async (key: string, stillValid: () => Promise<boolean>) => {
    if (unavailable.has(key)) throw new CodexCredentialModeSwitchBusyError([]);
    if (await stillValid()) applied.push(key);
  });
  const service = new GatewayCodexRestartService({
    listHostKeys: () => keys,
    hasBusySession: key => busy.has(key),
    listSessionIds: key => [`session-${key}`],
    restartHost: restart,
    onQueueGateReleased: wake,
  });
  return { service, busy, unavailable, keys, applied, wake, restart };
}

describe('gateway Codex deferred restart', () => {
  it('refreshes an idle host without waiting for a busy sibling', async () => {
    const h = harness();
    h.busy.add('gateway-a');
    h.service.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.applied).toEqual(['gateway-b']);
    expect(h.service.isSessionRestarting('session-gateway-a')).toBe(false);
    h.busy.clear();
    h.service.onSessionSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.applied).toEqual(['gateway-b', 'gateway-a']);
    expect(h.wake.mock.calls.flat(2)).toEqual(['session-gateway-b', 'session-gateway-a']);
    expect(vi.getTimerCount()).toBe(0);
    h.service.clear();
  });

  it.each(['startup', 'another-credential-change'])('retries after %s without losing the refresh', async () => {
    const h = harness();
    h.unavailable.add('gateway-a');
    h.service.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.applied).toEqual(['gateway-b']);
    h.unavailable.clear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.applied).toEqual(['gateway-b', 'gateway-a']);
    expect(vi.getTimerCount()).toBe(0);
    h.service.clear();
  });

  it('coalesces rotations while busy and refreshes on the next local start', async () => {
    const h = harness();
    h.busy.add('gateway-a');
    h.keys.splice(1);
    h.service.schedule();
    h.service.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.restart).not.toHaveBeenCalled();
    h.busy.clear();
    await h.service.flushBeforeLocalCodexSessionStart();
    expect(h.applied).toEqual(['gateway-a']);
    expect(h.restart).toHaveBeenCalledOnce();
    h.service.clear();
  });

  it('releases only affected queues after a failed restart and retries', async () => {
    const h = harness();
    let finish!: () => void;
    h.restart.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      throw new Error('retirement failed');
    });
    h.keys.splice(1);
    h.service.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.isSessionRestarting('session-gateway-a')).toBe(true);
    expect(h.service.isSessionRestarting('session-oauth')).toBe(false);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.isSessionRestarting('session-gateway-a')).toBe(false);
    expect(h.wake).toHaveBeenCalledWith(['session-gateway-a']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.applied).toEqual(['gateway-a']);
    h.service.clear();
  });

  it('discards a queued old-owner restart before closing any new-owner sessions', async () => {
    const h = harness();
    let finish!: () => void;
    h.restart.mockImplementationOnce(async (key, stillValid) => {
      await new Promise<void>(resolve => { finish = resolve; });
      if (await stillValid()) h.applied.push(key);
    });
    h.keys.splice(1);
    h.service.schedule();
    await vi.advanceTimersByTimeAsync(0);
    h.service.clear();
    finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.applied).toEqual([]);
    expect(h.wake).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a rotation arriving while the previous restart is completing', async () => {
    const h = harness();
    let finish!: () => void;
    h.keys.splice(1);
    h.restart.mockImplementationOnce(async (key, stillValid) => {
      if (!await stillValid()) return;
      await new Promise<void>(resolve => { finish = resolve; });
      h.applied.push(key);
    });
    h.service.schedule();
    await vi.advanceTimersByTimeAsync(0);
    h.service.schedule();
    finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.applied).toEqual(['gateway-a', 'gateway-a']);
    expect(vi.getTimerCount()).toBe(0);
    h.service.clear();
  });
});
