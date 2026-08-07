import { describe, expect, it, vi } from 'vitest';

import { projectInteractionRequestForRemote } from '../../cindy-brain/ghostSetupInteractionBridge.js';
import { MAKER_PUSH } from '../channels.js';
import { OrcaWorkerPermissionConfirmBridge } from '../orcaWorkerPermissionConfirmBridge.js';

describe('OrcaWorkerPermissionConfirmBridge', () => {
  it('requires a real permission decision before confirming Full access', async () => {
    const broadcast = vi.fn();
    const bridge = new OrcaWorkerPermissionConfirmBridge({ broadcast, timeoutMs: 1000 });
    const pending = bridge.request('lead-1', {
      title: '开启 Full access？',
      description: 'Worker 将跳过常规审批。',
    });
    const payload = broadcast.mock.calls[0]?.[1] as {
      request: { requestId: string; kind: string; input: Record<string, unknown> };
    };

    expect(broadcast).toHaveBeenCalledWith(
      MAKER_PUSH.INTERACTION_REQUEST,
      expect.objectContaining({
        sessionId: 'lead-1',
        request: expect.objectContaining({
          kind: 'permission',
          input: { worker_permission_mode: 'bypassPermissions' },
        }),
      }),
    );
    expect(
      bridge.resolve(payload.request.requestId, {
        kind: 'permission',
        behavior: 'allow',
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({ confirmed: true });
  });

  it('keeps one pending confirmation per Lead session', async () => {
    const broadcast = vi.fn();
    const bridge = new OrcaWorkerPermissionConfirmBridge({ broadcast, timeoutMs: 1000 });

    const first = bridge.request('lead-1', { title: 'confirm', description: 'risk' });
    const second = bridge.request('lead-1', { title: 'confirm again', description: 'risk again' });
    const payload = broadcast.mock.calls[0]?.[1] as { request: { requestId: string } };

    expect(second).toBe(first);
    expect(broadcast).toHaveBeenCalledTimes(1);
    bridge.resolve(payload.request.requestId, { kind: 'permission', behavior: 'deny' });
    await expect(first).resolves.toEqual({ confirmed: false, reason: 'cancelled' });
  });

  it('rejects an untrusted local reply without settling the pending confirmation', async () => {
    const broadcast = vi.fn();
    const bridge = new OrcaWorkerPermissionConfirmBridge({ broadcast, timeoutMs: 1000 });
    const pending = bridge.request('lead-1', { title: 'confirm', description: 'risk' });
    const payload = broadcast.mock.calls[0]?.[1] as { request: { requestId: string } };
    const denied = new Error('[PERMISSION_DENIED] untrusted renderer');

    expect(() =>
      bridge.resolveFromIpc(
        payload.request.requestId,
        { kind: 'permission', behavior: 'allow' },
        {
          isDeviceLink: false,
          assertTrustedSender: () => {
            throw denied;
          },
        },
      ),
    ).toThrow(denied);
    expect(bridge.hasPending(payload.request.requestId)).toBe(true);

    bridge.cleanupForSession('lead-1', 'session_aborted');
    await expect(pending).resolves.toEqual({ confirmed: false, reason: 'session_aborted' });
  });

  it('allows an authenticated device-link reply and keeps the request in remote projection', async () => {
    const broadcast = vi.fn();
    const assertTrustedSender = vi.fn();
    const bridge = new OrcaWorkerPermissionConfirmBridge({ broadcast, timeoutMs: 1000 });
    const pending = bridge.request('lead-1', { title: 'confirm', description: 'risk' });
    const payload = broadcast.mock.calls[0]?.[1] as {
      request: { requestId: string; metadata: Record<string, unknown> };
    };

    expect(projectInteractionRequestForRemote(payload.request)).toEqual(payload.request);
    expect(
      bridge.resolveFromIpc(
        payload.request.requestId,
        { kind: 'permission', behavior: 'allow' },
        { isDeviceLink: true, assertTrustedSender },
      ),
    ).toBe(true);
    expect(assertTrustedSender).not.toHaveBeenCalled();
    await expect(pending).resolves.toEqual({ confirmed: true });
  });

  it('fails closed on malformed replies and never treats them as approval', async () => {
    const broadcast = vi.fn();
    const warn = vi.fn();
    const bridge = new OrcaWorkerPermissionConfirmBridge({
      broadcast,
      logger: { warn },
      timeoutMs: 1000,
    });
    const pending = bridge.request('lead-1', { title: 'confirm', description: 'risk' });
    const payload = broadcast.mock.calls[0]?.[1] as { request: { requestId: string } };

    expect(bridge.resolve(payload.request.requestId, { behavior: 'allow' })).toBe(true);
    await expect(pending).resolves.toEqual({ confirmed: false, reason: 'cancelled' });
    expect(warn).toHaveBeenCalled();
  });

  it('times out as denied and removes the pending snapshot', async () => {
    vi.useFakeTimers();
    try {
      const broadcast = vi.fn();
      const bridge = new OrcaWorkerPermissionConfirmBridge({ broadcast, timeoutMs: 50 });
      const pending = bridge.request('lead-1', { title: 'confirm', description: 'risk' });

      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toEqual({ confirmed: false, reason: 'timeout' });
      expect(bridge.pendingSnapshots('lead-1')).toEqual([]);
      expect(broadcast).toHaveBeenLastCalledWith(
        MAKER_PUSH.INTERACTION_DISMISSED,
        expect.objectContaining({ resolvedAs: 'deny', reason: 'timeout' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['session_closed', 'session_aborted'] as const)(
    'fails closed when the Lead session ends as %s',
    async (reason) => {
      const broadcast = vi.fn();
      const bridge = new OrcaWorkerPermissionConfirmBridge({ broadcast, timeoutMs: 1000 });
      const pending = bridge.request('lead-1', { title: 'confirm', description: 'risk' });

      bridge.cleanupForSession('lead-1', reason);

      await expect(pending).resolves.toEqual({ confirmed: false, reason });
      expect(bridge.pendingSnapshots('lead-1')).toEqual([]);
    },
  );
});
