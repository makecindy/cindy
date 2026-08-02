import { describe, expect, it, vi } from 'vitest';
import { DL_SESSION_REFERENCE_CAPABILITY_CHANNEL } from '@cindy/device-link';

import { handleInvoke, type DeviceLinkIpcDeps } from '../ipc.js';

function depsForInvoke(
  invoke: DeviceLinkIpcDeps['invoke'],
  rewrite = vi.fn(async (_channel: string, args: unknown[]) => args),
): DeviceLinkIpcDeps {
  return {
    getState: () => ({ disabledControlDeviceIds: [] }) as never,
    invoke,
    rewriteOutboundSessionReferences: rewrite,
  } as unknown as DeviceLinkIpcDeps;
}

function queuedWithReference() {
  return {
    text: 'compare cindy://session/source',
    sessionRefs: [{ sessionId: 'source', deviceId: 'source-device' }],
  };
}

describe('device-link target session-reference capability gate', () => {
  it('sends raw link text when an old target cannot consume trusted reference fields', async () => {
    const invoke = vi
      .fn<DeviceLinkIpcDeps['invoke']>()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'CHANNEL_NOT_ALLOWED', message: 'unknown channel' },
      })
      .mockResolvedValueOnce({ ok: true, result: { accepted: true } });
    const rewrite = vi.fn(async (_channel: string, args: unknown[]) => args);

    await expect(
      handleInvoke(depsForInvoke(invoke, rewrite), 'target-device', 'maker:input:enqueue', [
        'target-session',
        queuedWithReference(),
      ]),
    ).resolves.toEqual({ accepted: true });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      'target-device',
      DL_SESSION_REFERENCE_CAPABILITY_CHANNEL,
      [],
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'target-device',
      'maker:input:enqueue',
      [
        'target-session',
        { text: 'compare cindy://session/source' },
      ],
    );
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  it('rewrites before probing a new target and sending the message', async () => {
    const invoke = vi
      .fn<DeviceLinkIpcDeps['invoke']>()
      .mockResolvedValueOnce({ ok: true, result: { supported: true, version: 1 } })
      .mockResolvedValueOnce({ ok: true, result: { accepted: true } });
    const rewrite = vi.fn(async (_channel: string, args: unknown[]) => [
      args[0],
      { ...(args[1] as object), trustedSessionReferenceContexts: [{ sessionId: 'source' }] },
    ]);

    await expect(
      handleInvoke(depsForInvoke(invoke, rewrite), 'target-device', 'maker:input:enqueue', [
        'target-session',
        queuedWithReference(),
      ]),
    ).resolves.toEqual({ accepted: true });

    expect(invoke.mock.calls.map((call) => call[1])).toEqual([
      DL_SESSION_REFERENCE_CAPABILITY_CHANNEL,
      'maker:input:enqueue',
    ]);
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  it('sends a raw foreign link without probing reference support', async () => {
    const invoke = vi
      .fn<DeviceLinkIpcDeps['invoke']>()
      .mockResolvedValueOnce({ ok: true, result: { accepted: true } });
    const rewrite = vi.fn(async (_channel: string, args: unknown[]) => [
      args[0],
      { ...(args[1] as object), sessionRefs: undefined },
    ]);

    await expect(
      handleInvoke(depsForInvoke(invoke, rewrite), 'target-device', 'maker:input:enqueue', [
        'target-session',
        queuedWithReference(),
      ]),
    ).resolves.toEqual({ accepted: true });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'target-device',
      'maker:input:enqueue',
      [
        'target-session',
        expect.objectContaining({ text: 'compare cindy://session/source' }),
      ],
    );
  });

  it('accepts newer compatible capability versions', async () => {
    const invoke = vi
      .fn<DeviceLinkIpcDeps['invoke']>()
      .mockResolvedValueOnce({ ok: true, result: { supported: true, version: 2 } })
      .mockResolvedValueOnce({ ok: true, result: { accepted: true } });
    const rewrite = vi.fn(async (_channel: string, args: unknown[]) => args);

    await expect(
      handleInvoke(depsForInvoke(invoke, rewrite), 'target-device', 'maker:input:enqueue', [
        'target-session',
        queuedWithReference(),
      ]),
    ).resolves.toEqual({ accepted: true });
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  it('does not add a capability roundtrip for ordinary queued messages', async () => {
    const invoke = vi
      .fn<DeviceLinkIpcDeps['invoke']>()
      .mockResolvedValue({ ok: true, result: { accepted: true } });

    await expect(
      handleInvoke(depsForInvoke(invoke), 'target-device', 'maker:input:enqueue', [
        'target-session',
        { text: 'ordinary message' },
      ]),
    ).resolves.toEqual({ accepted: true });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('target-device', 'maker:input:enqueue', [
      'target-session',
      { text: 'ordinary message' },
    ]);
  });

  it('preserves target authorization errors instead of misreporting them as version skew', async () => {
    const invoke = vi.fn<DeviceLinkIpcDeps['invoke']>().mockResolvedValue({
      ok: false,
      error: { code: 'ACCESS_REVOKED', message: 'revoked by target' },
    });

    await expect(
      handleInvoke(depsForInvoke(invoke), 'target-device', 'maker:input:update-text', [
        'target-session',
        'client-1',
        'linked',
        [{ sessionId: 'source' }],
      ]),
    ).rejects.toThrow('[DEVICE_LINK_ACCESS_REVOKED]');
  });

  it('treats a registered-channel startup race as temporarily unavailable', async () => {
    const invoke = vi.fn<DeviceLinkIpcDeps['invoke']>().mockResolvedValue({
      ok: false,
      error: { code: 'IPC_ERROR', message: '[NOT_FOUND] handler not registered yet' },
    });

    await expect(
      handleInvoke(depsForInvoke(invoke), 'target-device', 'maker:input:enqueue', [
        'target-session',
        queuedWithReference(),
      ]),
    ).rejects.toThrow('[SESSION_REFERENCE_UNAVAILABLE]');
  });
});
