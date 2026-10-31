import { describe, expect, it, vi } from 'vitest';
import { createControlledModelCatalogReader, type ControlledModelCatalogDeps } from '../controlledModelCatalog.js';
import { invokeModelCatalog } from '../../../renderer/lib/invokeModelCatalog';
import { modelCatalogKey } from '../../../shared/controlledModelCatalog';
import { extractIpcError } from '../../../shared/ipcError';

// #8010, unit: real reader must use B's sources (including A and B-only shares),
// restrict reads, and reject late results after revocation/account change.
// Existing location tests only covered local discovery, not remote catalog routing.
function fixture() {
  const locations = vi.fn<ControlledModelCatalogDeps['locations']>(async () => ({ status: 'complete', locations: [
    { agentDeviceId: 'device-a', name: 'A' },
    { agentDeviceId: 'share:b-only', name: 'Provider · Owner' },
  ] }));
  const invoke = vi.fn<ControlledModelCatalogDeps['invoke']>().mockResolvedValue({ ok: true, result: { providers: [{ id: 'a-provider' }] } });
  const assertOwner = vi.fn();
  const assertCaller = vi.fn();
  return { locations, invoke, assertOwner, assertCaller,
    read: createControlledModelCatalogReader({ locations, invoke, assertCaller, captureOwner: () => assertOwner }) };
}
const request = (agentDeviceId = 'device-a') => ({
  op: 'read', agentDeviceId, channel: 'maker:provider:list', args: [],
});

describe('controlled model catalogs', () => {
  // #8010 review / unit: missing devices in a failed directory lookup are unknown,
  // not revoked. Exercise both admission and the post-read authorization recheck.
  it.each(['before read', 'after read'] as const)('keeps a degraded directory retryable %s', async phase => {
    const f = fixture();
    if (phase === 'before read') f.locations.mockResolvedValue({ status: 'degraded', locations: [] });
    else f.invoke.mockImplementation(async () => {
      f.locations.mockResolvedValue({ status: 'degraded', locations: [] });
      return { ok: true, result: { providers: [{ id: 'a-provider' }] } };
    });
    await expect(f.read(request())).rejects.toThrow('MODEL_VISIBILITY_NOT_READY');
    expect(f.invoke).toHaveBeenCalledTimes(phase === 'before read' ? 0 : 1);
    f.locations.mockResolvedValue({ status: 'complete', locations: [{ agentDeviceId: 'device-a', name: 'A' }] });
    f.invoke.mockResolvedValue({ ok: true, result: { providers: [{ id: 'a-provider' }] } });
    await expect(f.read(request())).resolves.toEqual({ providers: [{ id: 'a-provider' }] });
  });
  it('still reads an explicitly confirmed share during a degraded device lookup', async () => {
    const f = fixture();
    f.locations.mockResolvedValue({ status: 'degraded', locations: [{ agentDeviceId: 'share:b-only', name: 'Share' }] });
    await expect(f.read(request('share:b-only'))).resolves.toEqual({ providers: [{ id: 'a-provider' }] });
  });
  // #8010 review / unit: the real host reader must preserve nested source errors;
  // success-only transport fixtures missed retry and old-source fallback semantics.
  it.each([
    { code: 'IPC_ERROR', message: '[MODEL_VISIBILITY_NOT_READY] preparing', expected: 'MODEL_VISIBILITY_NOT_READY' },
    { code: 'CHANNEL_NOT_ALLOWED', message: 'old source', expected: 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' },
  ] as const)('preserves $expected across the task host', async ({ code, message, expected }) => {
    const f = fixture();
    f.invoke.mockResolvedValue({ ok: false, error: { code, message } });
    const error = await f.read(request()).catch(error => error);
    expect(extractIpcError(error)?.code).toBe(expected);
  });
  // #8010 / unit: exercise both sides of the transport contract. Provider-only
  // fixtures cannot detect lost runtime rosters or reasoning/context metadata.
  it.each([
    { channel: 'maker:get-capabilities', args: ['pi'], value: { availableModels: [{ id: 'custom', contextWindow: 128000 }], effortLevels: ['high'] } },
    { channel: 'maker:list-available-agents', args: [], value: ['pi', 'codex'] },
  ])('preserves the source response for $channel through the renderer and host readers', async ({ channel, args, value }) => {
    const f = fixture();
    f.invoke.mockResolvedValue({ ok: true, result: value });
    const link = { invoke: vi.fn(async (host: string, endpoint: string, payload: unknown[]) => {
      if (host !== 'device-b' || endpoint !== 'maker:model-catalog:read') throw new Error('wrong task host');
      return f.read(payload[0]);
    }) };
    await expect(invokeModelCatalog(link, modelCatalogKey('device-a', 'device-b')!, channel, args)).resolves.toEqual(value);
    expect(f.invoke).toHaveBeenCalledWith('device-a', channel, args, f.assertOwner);
  });

  it.each([
    { channel: 'maker:model-catalog:read', args: [{ op: 'locations' }] },
    { channel: 'maker:agent:status', args: ['cc'] },
    { channel: 'maker:get-capabilities', args: ['pi', { sessionId: 'other-task' }] },
    { channel: 'maker:list-available-agents', args: [{ deviceId: 'other-account' }] },
  ])('refuses recursive forwarding or unexpected arguments for $channel', async ({ channel, args }) => {
    const f = fixture();
    await expect(f.read({ ...request(), channel, args })).rejects.toThrow('INVALID_PARAMS');
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.locations).not.toHaveBeenCalled();
  });

  it('lists B sources including the controller and shares not received on A', async () => {
    const f = fixture();
    expect(await f.read({ op: 'locations' })).toEqual(await f.locations());
  });
  it.each(['device-a', 'share:b-only'])('reads %s through B without changing the execution identity', async id => {
    const f = fixture();
    expect(await f.read(request(id))).toEqual({ providers: [{ id: 'a-provider' }] });
    expect(f.invoke).toHaveBeenCalledWith(id, 'maker:provider:list', [], f.assertOwner);
  });
  it('rejects mutations and unknown sources without forwarding', async () => {
    const f = fixture();
    await expect(f.read({ ...request(), channel: 'maker:send' })).rejects.toThrow('INVALID_PARAMS');
    await expect(f.read({ ...request(), args: [{ remoteInvocationEnabled: true }] })).rejects.toThrow('INVALID_PARAMS');
    await expect(f.read(request('unknown'))).rejects.toThrow('PRECONDITION_FAILED');
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('preserves provider capability negotiation through the read-only gateway', async () => {
    const f = fixture();
    const args = [{ capabilities: ['provider-logo-kinds-v2'] }];
    await f.read({ ...request(), args });
    expect(f.invoke).toHaveBeenCalledWith('device-a', 'maker:provider:list', args, f.assertOwner);
  });
  it('discards results after source revocation', async () => {
    const f = fixture();
    f.invoke.mockImplementation(async () => {
      f.locations.mockResolvedValue({ status: 'complete', locations: [] });
      return { ok: true, result: { providers: [{ id: 'a-provider' }] } };
    });
    await expect(f.read(request())).rejects.toThrow('PRECONDITION_FAILED');
  });
  it('discards results after account change and rejects guest callers', async () => {
    const f = fixture();
    f.invoke.mockImplementation(async () => {
      f.assertOwner.mockImplementation(() => { throw new Error('account changed'); });
      return { ok: true, result: { providers: [{ id: 'a-provider' }] } };
    });
    await expect(f.read(request())).rejects.toThrow('account changed');
    f.assertCaller.mockImplementation(() => { throw new Error('guest denied'); });
    await expect(f.read({ op: 'locations' })).rejects.toThrow('guest denied');
  });
});
