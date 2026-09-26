import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceLinkError } from '@cindy/device-link';
import type { DeviceLinkIpcDeps } from '../ipc';
import { createDeviceLinkIpcDiagnostics } from '../ipcDiagnostics';
import { createDeviceUnresponsiveError } from '../responsivenessTracker';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function harness() {
  const emit = vi.fn();
  const diagnostics = createDeviceLinkIpcDiagnostics(emit);
  const invoke = vi.fn<DeviceLinkIpcDeps['invoke']>().mockResolvedValue({ ok: true, result: [] });
  const subscribe = vi
    .fn<DeviceLinkIpcDeps['subscribe']>()
    .mockResolvedValue({ ok: true, result: null });
  const unsubscribe = vi
    .fn<DeviceLinkIpcDeps['unsubscribe']>()
    .mockResolvedValue({ ok: true, result: null });
  const openLink = vi.fn<DeviceLinkIpcDeps['openLink']>();
  const deps = { invoke, subscribe, unsubscribe, openLink } as unknown as DeviceLinkIpcDeps;
  return {
    emit,
    diagnostics,
    invoke,
    subscribe,
    unsubscribe,
    openLink,
    deps,
    observed: diagnostics.forWindow(deps, 10),
  };
}

const CHANNEL = 'local-db:sessions:list';

describe('device-link IPC diagnostics', () => {
  it('aggregates a failure storm and successes without changing transport calls or errors', async () => {
    const h = harness();
    const error = new DeviceLinkError('BACKPRESSURE', 'private error');
    h.invoke.mockRejectedValue(error);
    for (let i = 0; i < 1000; i++) {
      await expect(h.observed.invoke('private-peer', CHANNEL, [])).rejects.toBe(error);
    }
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledWith(
      'transport first failure',
      expect.objectContaining({ code: 'BACKPRESSURE', completed: 1 }),
    );
    const result = { ok: true as const, result: ['private response'] };
    h.invoke.mockResolvedValue(result);
    await expect(h.observed.invoke('private-peer', CHANNEL, ['private argument'])).resolves.toBe(
      result,
    );
    expect(h.invoke).toHaveBeenCalledTimes(1001);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.emit).toHaveBeenCalledTimes(3);
    expect(h.emit).toHaveBeenCalledWith(
      'transport summary',
      expect.objectContaining({ code: 'BACKPRESSURE', completed: 1000, elapsedMs: 30_000 }),
    );
    expect(h.emit).toHaveBeenCalledWith(
      'transport summary',
      expect.objectContaining({ code: 'OK', completed: 1 }),
    );
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain('private');
    expect(vi.getTimerCount()).toBe(0);
    h.invoke.mockRejectedValue(error);
    await expect(h.observed.invoke('private-peer', CHANNEL, [])).rejects.toBe(error);
    expect(h.emit).toHaveBeenCalledTimes(4);
    h.diagnostics.flush();
  });

  it('distinguishes raw causes, peers, windows and subscription operations', async () => {
    const h = harness();
    for (const code of ['NOT_CONNECTED', 'LINK_NOT_OPEN', 'PEER_RESET', 'BACKPRESSURE'] as const) {
      h.invoke.mockRejectedValueOnce(new DeviceLinkError(code, 'private'));
      await expect(h.observed.invoke('peer-a', CHANNEL, [])).rejects.toMatchObject({ code });
    }
    h.subscribe.mockResolvedValue({
      ok: false,
      error: { code: 'DEVICE_OFFLINE', message: 'private' },
    });
    await h.observed.subscribe('peer-a', ['private-topic']);
    await h.diagnostics.forWindow(h.deps, 20).subscribe('peer-a', ['private-topic']);
    await h.observed.unsubscribe('peer-b', ['private-topic']);
    h.openLink.mockRejectedValue(new DeviceLinkError('REMOTE_DISABLED', 'private'));
    await expect(h.observed.openLink('peer-a')).rejects.toMatchObject({ code: 'REMOTE_DISABLED' });
    h.diagnostics.flush();
    const rows = h.emit.mock.calls
      .filter(([event]) => event === 'transport summary')
      .map(([, row]) => row);
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((row) => row.peer)).size).toBe(2);
    expect(rows.filter((row) => row.operation === 'subscribe').map((row) => row.windowId)).toEqual([
      10, 20,
    ]);
    expect(rows.filter((row) => row.operation === 'invoke').map((row) => row.code)).toEqual([
      'NOT_CONNECTED',
      'LINK_NOT_OPEN',
      'PEER_RESET',
      'BACKPRESSURE',
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/private|peer-a|peer-b/);
  });

  it.each(['invoke', 'subscribe'] as const)(
    'records %s circuit-breaker rejection under its actual local code',
    async (operation) => {
      const h = harness();
      const error = createDeviceUnresponsiveError('private-peer');
      h[operation].mockRejectedValue(error);
      const run = () =>
        operation === 'invoke'
          ? h.observed.invoke('private-peer', CHANNEL, [])
          : h.observed.subscribe('private-peer', ['private-topic']);
      await expect(run()).rejects.toBe(error);
      await expect(run()).rejects.toBe(error);
      expect(h.emit).toHaveBeenCalledTimes(1);
      expect(h.emit).toHaveBeenCalledWith(
        'transport first failure',
        expect.objectContaining({
          operation,
          code: 'DEVICE_UNRESPONSIVE',
          completed: 1,
        }),
      );
      h.diagnostics.flush();
      expect(h.emit).toHaveBeenCalledWith(
        'transport summary',
        expect.objectContaining({
          operation,
          code: 'DEVICE_UNRESPONSIVE',
          completed: 2,
        }),
      );
      expect(JSON.stringify(h.emit.mock.calls)).not.toMatch(/private|circuit open|UNKNOWN/);
    },
  );

  it('preserves unknown failures while redacting unknown channels and codes', async () => {
    const h = harness();
    const unknown = Object.assign(new Error('private body'), { code: 'private-code' });
    h.invoke.mockRejectedValueOnce(unknown);
    await expect(h.observed.invoke('private-peer', 'private-channel', [])).rejects.toBe(unknown);
    expect(h.emit).toHaveBeenCalledWith(
      'transport first failure',
      expect.objectContaining({ code: 'UNKNOWN', channel: 'UNKNOWN' }),
    );
    h.invoke.mockRejectedValueOnce(new Error('[DEVICE_LINK_NOT_CONNECTED] client not initialized'));
    await expect(h.observed.invoke('private-peer', CHANNEL, [])).rejects.toThrow(
      'client not initialized',
    );
    expect(h.emit).toHaveBeenCalledWith(
      'transport first failure',
      expect.objectContaining({ code: 'MAPPED_NOT_CONNECTED' }),
    );
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain('private');
    h.diagnostics.flush();
  });

  it('bounds cardinality and reports overflow without flooding first-failure logs', async () => {
    const h = harness();
    h.invoke.mockRejectedValue(new DeviceLinkError('NOT_CONNECTED', 'private'));
    for (let i = 0; i < 1000; i++) {
      await expect(h.observed.invoke(`peer-${i}`, CHANNEL, [])).rejects.toMatchObject({
        code: 'NOT_CONNECTED',
      });
    }
    expect(h.emit).toHaveBeenCalledTimes(64);
    h.diagnostics.flush();
    expect(h.emit).toHaveBeenCalledTimes(129);
    expect(h.emit).toHaveBeenLastCalledWith(
      'transport summary overflow',
      expect.objectContaining({ overflowCompleted: 936, overflowFailures: 936 }),
    );
  });

  it('does not let a logging failure alter the result or thrown error', async () => {
    const h = harness();
    h.emit.mockImplementation(() => {
      throw new Error('log unavailable');
    });
    const error = new DeviceLinkError('NOT_CONNECTED', 'original');
    h.invoke.mockRejectedValueOnce(error);
    await expect(h.observed.invoke('peer', CHANNEL, [])).rejects.toBe(error);
    await expect(h.observed.invoke('peer', CHANNEL, [])).resolves.toEqual({ ok: true, result: [] });
    expect(() => h.diagnostics.flush()).not.toThrow();
  });
});
