/** Unit: real Main metadata admission used by UI, worker/scheduled reads and regional routes.
 * Bug: cloud/signaling failures erased verified directories; stale data must never become a grant.
 * Minimal input: successful catalog, transient failure, then denial/account change. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_AGENT_CHANNEL, PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';
const identity = vi.hoisted(() => ({ owner: 'owner-a:1', endpoint: 'https://a.invalid', pending: false }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => identity.owner, isAppSessionBoundaryPending: () => identity.pending }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => identity.endpoint }));
import { invokeProviderMetadataContinuity as read, invalidateProviderMetadataContinuity as invalidate,
  readProviderDirectoryContinuity } from '../providerMetadataContinuity.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  identity.owner = 'owner-a:1'; identity.endpoint = 'https://a.invalid'; identity.pending = false; invalidate();
});
afterEach(() => vi.useRealTimers());
const failure = (code = 'NOT_CONNECTED') => Object.assign(new Error(`[${code}] unavailable`), { code });
const catalog = () => Promise.resolve({ ok: true as const, result: { providers: [{ id: 'a' }] } });

describe('Main provider metadata continuity', () => {
  it('retains a catalog for a short outage and bounds both forwarding and a hung refresh', async () => {
    await read('M', 'maker:provider:list', [], catalog);
    const request = vi.fn(() => new Promise<never>(() => {}));
    const result = read('M', 'maker:provider:list', [], request);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toMatchObject({ ok: true, result: { providers: [{ id: 'a' }], providerContinuity: { stale: true } } });
    const sibling = read('M', 'maker:provider:list', [], request);
    await vi.advanceTimersByTimeAsync(2000); await sibling;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([REMOTE_AGENT_CHANNEL, PROVIDER_GROUP_REMOTE_CHANNEL])('never caches authorization, Agent caps or group picks through %s', async channel => {
    const args = channel === REMOTE_AGENT_CHANNEL ? [{ op: 'caps' }] : [{ action: 'pick' }];
    const request = vi.fn(catalog);
    await read('M', channel, args, request); request.mockRejectedValueOnce(failure());
    await expect(read('M', channel, args, request)).rejects.toThrow('NOT_CONNECTED');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps failure envelopes and erases the target on an authoritative denial without erasing another target', async () => {
    await read('M', 'maker:provider:list', [], catalog); await read('N', 'maker:provider:list', [], catalog);
    const denial = { ok: false as const, error: { code: 'ACCESS_REVOKED' as const, message: 'revoked' } };
    expect(await read('M', 'maker:provider:list', [], async () => denial)).toBe(denial);
    await expect(read('M', 'maker:provider:list', [], async () => { throw failure(); })).rejects.toThrow('NOT_CONNECTED');
    expect(await read('N', 'maker:provider:list', [], async () => { throw failure(); })).toMatchObject({ ok: true });
  });

  it('rejects owner/realm transitions, explicit closes and local permission loss instead of using an old catalog', async () => {
    await read('M', 'maker:provider:list', [], catalog);
    identity.owner = 'owner-b:2';
    await expect(read('M', 'maker:provider:list', [], async () => { throw failure(); })).rejects.toThrow('NOT_CONNECTED');
    identity.owner = 'owner-a:1'; identity.endpoint = 'https://b.invalid';
    await expect(read('M', 'maker:provider:list', [], async () => { throw failure(); })).rejects.toThrow('NOT_CONNECTED');
    identity.endpoint = 'https://a.invalid'; invalidate('M');
    await expect(read('M', 'maker:provider:list', [], async () => { throw failure(); })).rejects.toThrow('NOT_CONNECTED');
    await read('M', 'maker:provider:list', [], catalog);
    const request = vi.fn(catalog);
    await expect(read('M', 'maker:provider:list', [], request, () => false)).rejects.toThrow('scope changed');
    expect(request).not.toHaveBeenCalled();
  });

  it('does not reset the 30-minute budget when another computer returns a stale directory', async () => {
    await read('M', 'maker:provider:list', [], async () => ({ ok: true, result: {
      providers: [{ id: 'a' }], providerContinuity: { stale: true, remainingMs: 1000 },
    } }));
    await vi.advanceTimersByTimeAsync(1001);
    await expect(read('M', 'maker:provider:list', [], async () => { throw failure(); })).rejects.toThrow('NOT_CONNECTED');
  });

  it('retains a device directory on actual HTTP 503/429 errors, but never on 403', async () => {
    await readProviderDirectoryContinuity(async () => ({ devices: ['M'] }));
    for (const statusCode of [503, 429]) {
      expect(await readProviderDirectoryContinuity(async () => { throw { statusCode, code: 'SERVER_ERROR' }; }))
        .toMatchObject({ value: { devices: ['M'] }, stale: true });
    }
    await expect(readProviderDirectoryContinuity(async () => { throw { statusCode: 403, code: 'PERMISSION_DENIED' }; }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(readProviderDirectoryContinuity(async () => { throw { statusCode: 503 }; })).rejects.toMatchObject({ statusCode: 503 });
  });
});
