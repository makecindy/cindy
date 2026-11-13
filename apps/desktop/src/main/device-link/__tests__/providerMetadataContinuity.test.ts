/** Unit: real Main metadata admission used by UI, worker/scheduled reads and regional routes.
 * Bug: cloud/signaling failures erased verified directories; stale data must never become a grant.
 * Minimal input: successful catalog, transient failure, then denial/account change. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PROVIDER_GROUP_IPC } from '../../../shared/providerGroup.js';
import { REMOTE_AGENT_CHANNEL, PROVIDER_GROUP_REMOTE_CHANNEL, type Envelope, type InvokeResultPayload } from '@cindy/device-link';
const identity = vi.hoisted(() => ({ owner: 'owner-a:1', endpoint: 'https://a.invalid', pending: false }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => identity.owner, isAppSessionBoundaryPending: () => identity.pending }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => identity.endpoint }));
// Load only the real SDK submodules this Main metadata chain uses. The SDK root
// index also assembles client/routedClient/direct/remoteDesktop runtime that these
// tests never execute; this facade keeps reader/error/constants real.
vi.mock('@cindy/device-link', async () => {
  const [metadata, group, remoteAgent] = await Promise.all([
    import('../../../../../../packages/device-link/src/metadataContinuity.js'),
    import('../../../../../../packages/device-link/src/providerGroup.js'),
    import('../../../../../../packages/device-link/src/remoteAgent.js'),
  ]);
  return {
    MetadataContinuityReader: metadata.MetadataContinuityReader,
    readProviderMetadataContinuity: metadata.readProviderMetadataContinuity,
    isProviderAccessDeniedError: metadata.isProviderAccessDeniedError,
    PROVIDER_GROUP_REMOTE_CHANNEL: group.PROVIDER_GROUP_REMOTE_CHANNEL,
    REMOTE_AGENT_CHANNEL: remoteAgent.REMOTE_AGENT_CHANNEL,
  };
});
import { invokeProviderMetadataContinuity as read, invalidateProviderMetadataContinuity as invalidate,
  invalidateProviderDirectoryContinuity, isTemporaryProviderMetadataFailure,
  readProviderDirectoryContinuity, captureProviderMetadataContinuityScope, onProviderDirectoryDenied, onProviderMetadataDenied,
  providerDirectoryGeneration, handleProviderMetadataSourcePush } from '../providerMetadataContinuity.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  identity.owner = 'owner-a:1'; identity.endpoint = 'https://a.invalid'; identity.pending = false; invalidate();
});
afterEach(() => vi.useRealTimers());
const failure = (code = 'NOT_CONNECTED') => Object.assign(new Error(`[${code}] unavailable`), { code });
const catalog = () => Promise.resolve({ ok: true as const, result: {
  providers: [{ id: 'a' }], providerContinuity: { stale: false, remainingMs: 30 * 60_000 },
} });
const oldHostCatalog = () => Promise.resolve({ ok: true as const, result: { providers: [{ id: 'a' }] } });
const emptyCatalog = () => Promise.resolve({ ok: true as const, result: { providers: [], providerContinuity: { stale: false, remainingMs: 30 * 60_000 } } });
const hexTarget = (label: string): string => createHash('sha256').update(label).digest('hex');

// Unit regression: successful replies invalidated by a source push must recover
// without a renderer subscription. Existing tests only covered rejecting the old reply.
describe('source refresh during metadata admission', () => {
  const push = (): Envelope => ({ v: 1, kind: 'push', src: 'A', payload: { channel: 'maker:provider:changed' } });
  it.each(['maker:provider:list', 'maker:get-capabilities'])('rereads %s once after a source change', async (channel) => {
    let finish!: (value: InvokeResultPayload) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockImplementationOnce(emptyCatalog);
    const pending = read('A', channel, [], request);
    handleProviderMetadataSourcePush(push());
    finish(await catalog());
    await expect(pending).resolves.toMatchObject({ ok: true, result: { providers: [] } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['owner', 'permission', 'denial', 'endpoint', 'retirement'])('does not retry a source refresh across %s changes', async (boundary) => {
    let finish!: (value: InvokeResultPayload) => void;
    const request = vi.fn(() => new Promise<InvokeResultPayload>(resolve => { finish = resolve; }));
    let allowed = true;
    const pending = read('A', 'maker:provider:list', [], request, () => allowed);
    handleProviderMetadataSourcePush(push());
    if (boundary === 'owner') identity.owner = 'owner-b:1';
    if (boundary === 'endpoint') identity.endpoint = 'https://b.invalid';
    if (boundary === 'permission') allowed = false;
    if (boundary === 'denial') invalidate('A');
    if (boundary === 'retirement') handleProviderMetadataSourcePush({ ...push(),
      payload: { channel: 'maker:provider:changed', payload: { providerContinuity: { stale: true, remainingMs: 0 } } } });
    finish(await catalog());
    await expect(pending).rejects.toThrow('Metadata scope changed');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('bounds repeated source changes to one replacement read', async () => {
    const request = vi.fn(async () => {
      handleProviderMetadataSourcePush(push());
      return catalog();
    });
    await expect(read('A', 'maker:provider:list', [], request)).rejects.toThrow('Metadata scope changed');
    expect(request).toHaveBeenCalledTimes(2);
  });
});

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

  // The reader already tests one late-denied entry. Main must invalidate sibling
  // metadata and captured routing scopes after its 2s fallback has returned.
  it.each(['envelope', 'rejection', 'http403'])('retires the whole current target after a late %s denial without retiring another target', async form => {
    const notified = vi.fn(); const off = onProviderMetadataDenied(notified);
    try {
      await read('M', 'maker:provider:list', [], catalog);
      await read('M', 'maker:get-capabilities', [], catalog);
      await read('N', 'maker:provider:list', [], catalog);
      const current = captureProviderMetadataContinuityScope('M');
      let settle!: () => void;
      const refresh = read('M', 'maker:provider:list', [], () => new Promise((resolve, reject) => {
        settle = () => form === 'envelope' ? resolve({ ok: false, error: { code: 'ACCESS_REVOKED', message: 'revoked' } })
          : reject(form === 'http403' ? Object.assign(new Error('denied'), { statusCode: 403 }) : failure('ACCESS_REVOKED'));
      }));
      await vi.advanceTimersByTimeAsync(2000);
      expect(await refresh).toMatchObject({ ok: true });
      settle(); await vi.advanceTimersByTimeAsync(0);
      expect(current()).toBe(false);
      expect(notified).toHaveBeenCalledExactlyOnceWith('M');
      await expect(read('M', 'maker:get-capabilities', [], async () => { throw failure(); })).rejects.toThrow('NOT_CONNECTED');
      expect(await read('N', 'maker:provider:list', [], async () => { throw failure(); })).toMatchObject({ ok: true });
    } finally { off(); }
  });

  it.each(['REMOTE_AGENT_SHARE_UNAVAILABLE', 'REMOTE_AGENT_PROVIDER_NOT_ALLOWED'])(
    'treats explicit %s as a target denial without clearing a neighbour',
    async (code) => {
      const notified = vi.fn();
      const off = onProviderMetadataDenied(notified);
      try {
        await read('M', 'maker:provider:list', [], catalog);
        await read('N', 'maker:provider:list', [], catalog);
        await expect(read('M', 'maker:provider:list', [], async () => {
          throw Object.assign(new Error(`[${code}] refused`), { code: 'IPC_ERROR' });
        })).rejects.toThrow(code);
        expect(notified).toHaveBeenCalledExactlyOnceWith('M');
        expect(await read('N', 'maker:provider:list', [], async () => { throw failure(); }))
          .toMatchObject({ ok: true });
      } finally { off(); }
    },
  );

  it('does not notify or invalidate the new owner when the old owner receives a late denial', async () => {
    await read('M', 'maker:provider:list', [], catalog);
    let deny!: () => void;
    const old = read('M', 'maker:provider:list', [], () => new Promise((_resolve, reject) => { deny = () => reject(failure('ACCESS_REVOKED')); }));
    await vi.advanceTimersByTimeAsync(2000); await old;
    identity.owner = 'owner-b:2'; await read('M', 'maker:provider:list', [], catalog);
    const current = captureProviderMetadataContinuityScope('M'), notified = vi.fn(); const off = onProviderMetadataDenied(notified);
    try {
      deny(); await vi.advanceTimersByTimeAsync(0);
      expect(current()).toBe(true); expect(notified).not.toHaveBeenCalled();
      expect(await read('M', 'maker:provider:list', [], async () => { throw failure(); })).toMatchObject({ ok: true });
    } finally { off(); }
  });

  it('does not reset the 30-minute budget when another computer returns a stale directory', async () => {
    await read('M', 'maker:provider:list', [], async () => ({ ok: true, result: {
      providers: [{ id: 'a' }], providerContinuity: { stale: true, remainingMs: 1000 },
    } }));
    await vi.advanceTimersByTimeAsync(1001);
    await expect(read('M', 'maker:provider:list', [], async () => { throw failure(); })).rejects.toThrow('NOT_CONNECTED');
  });

  it('retires only the directory snapshot when a device is renamed or deleted', async () => {
    await readProviderDirectoryContinuity(async () => ({ devices: ['M'] }));
    await read('M', 'maker:provider:list', [], catalog);
    invalidateProviderDirectoryContinuity();
    await expect(readProviderDirectoryContinuity(async () => { throw Object.assign(new Error('down'), { statusCode: 503 }); }))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(await read('M', 'maker:provider:list', [], async () => { throw failure(); }))
      .toMatchObject({ ok: true });
  });

  it('fences an in-flight directory response after a rename/delete mutation', async () => {
    let resolve!: (value: { devices: string[] }) => void;
    const pending = readProviderDirectoryContinuity(() => new Promise<{ devices: string[] }>(yes => { resolve = yes; }));
    invalidateProviderDirectoryContinuity();
    resolve({ devices: ['old'] });
    await expect(pending).rejects.toThrow('scope changed');
  });

  // Main integration: a late denial must retire the shared directory incarnation,
  // including a newer pending refresh that inherited the pre-denial snapshot.
  it('does not resurrect an older directory fallback from a concurrent refresh after a late 403', async () => {
    await read('N', 'maker:provider:list', [], catalog);
    await readProviderDirectoryContinuity(async () => ({ devices: ['old'] }));
    let rejectFirst!: (error: unknown) => void;
    const first = readProviderDirectoryContinuity(() => new Promise((_, reject) => { rejectFirst = reject; }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await first).toMatchObject({ stale: true });
    let resolveSecond!: (value: { devices: string[] }) => void;
    const presented: string[][] = [];
    const second = readProviderDirectoryContinuity(() => new Promise<{ devices: string[] }>(resolve => { resolveSecond = resolve; }))
      .then(value => { presented.push(value.value.devices); return { value }; }, error => ({ error }));
    rejectFirst(Object.assign(new Error('directory denied'), { statusCode: 403 }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(presented).not.toContainEqual(['old']);
    resolveSecond({ devices: ['fresh'] });
    await vi.advanceTimersByTimeAsync(0);
    const outcome = await second;
    if ('value' in outcome) expect(outcome.value).toMatchObject({ value: { devices: ['fresh'] }, stale: false });
    const later = await readProviderDirectoryContinuity<{ devices: string[] }>(async () => { throw failure(); })
      .then(value => value.value.devices, () => null);
    expect(later).not.toEqual(['old']);
    expect(await read('N', 'maker:provider:list', [], async () => { throw failure(); })).toMatchObject({ ok: true });
  });

  // Integration: a full bounded registry must not erase an unrelated verified
  // provider, and a brand-new target must still reach the live authority. Only
  // the continuity cache is unavailable at capacity; the read itself is not.
  it('serves a live read without a continuity stamp when a brand-new target crosses the registry capacity', async () => {
    await read('neighbour', 'maker:provider:list', [], catalog);
    const current = captureProviderMetadataContinuityScope('neighbour');
    for (let i = 0; i < 1024; i++) {
      captureProviderMetadataContinuityScope(`capacity-target-${i}`);
      invalidate(`capacity-target-${i}`);
    }
    invalidate('brand-new-target');
    // This fixture is an old host: no stamp, so capacity live fallback must
    // pass it through raw instead of minting a continuity stamp.
    const request = vi.fn(oldHostCatalog);
    const result = await read('brand-new-target', 'maker:provider:list', [], request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, result: { providers: [{ id: 'a' }] } });
    expect((result as { result?: Record<string, unknown> }).result).not.toHaveProperty('providerContinuity');
    // Routing captures stay fail-closed: capacity does not mint a new route scope.
    expect(captureProviderMetadataContinuityScope('brand-new-target')()).toBe(false);
    // The live fallback still honors the caller's current permission fence.
    const deniedRequest = vi.fn(catalog);
    await expect(read('another-new-target', 'maker:provider:list', [], deniedRequest, () => false))
      .rejects.toThrow('Metadata scope changed');
    expect(deniedRequest).not.toHaveBeenCalled();
    const expired = vi.fn(async () => ({ ok: true as const, result: {
      providers: [], providerContinuity: { stale: true, remainingMs: 0 },
    } }));
    await expect(read('expired-new-target', 'maker:provider:list', [], expired))
      .rejects.toThrow('MODEL_VISIBILITY_NOT_READY');
    expect(current()).toBe(true);
    expect(await read('neighbour', 'maker:provider:list', [], async () => { throw failure(); }))
      .toMatchObject({ ok: true });
  });

  async function fillCapacity(): Promise<void> {
    await read('neighbour', 'maker:provider:list', [], catalog);
    for (let i = 0; i < 1024; i++) captureProviderMetadataContinuityScope(`capacity-${i}`);
  }

  it.each(['allowed', 'owner', 'endpoint'] as const)(
    'fences an in-flight live capacity read when %s changes before it resolves',
    async boundary => {
      await fillCapacity();
      let allowed = true;
      let resolveRequest!: (value: InvokeResultPayload) => void;
      const request = vi.fn(() => new Promise<InvokeResultPayload>(resolve => { resolveRequest = resolve; }));
      const pending = read('new-target', 'maker:provider:list', [], request, () => allowed);
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      if (boundary === 'allowed') allowed = false;
      if (boundary === 'owner') identity.owner = 'owner-b:2';
      if (boundary === 'endpoint') identity.endpoint = 'https://b.invalid';
      resolveRequest({ ok: true, result: { providers: [{ id: 'old' }] } });
      await expect(pending).rejects.toThrow('Metadata scope changed');
    },
  );

  it('fences a sibling live capacity read after one explicit refusal', async () => {
    await fillCapacity();
    const denied = vi.fn(); const off = onProviderMetadataDenied(denied);
    try {
      let resolveDenied!: (value: InvokeResultPayload) => void;
      let resolveLate!: (value: InvokeResultPayload) => void;
      const deniedRequest = vi.fn(() => new Promise<InvokeResultPayload>(resolve => { resolveDenied = resolve; }));
      const lateRequest = vi.fn(() => new Promise<InvokeResultPayload>(resolve => { resolveLate = resolve; }));
      const first = read('race-target', 'maker:provider:list', [], deniedRequest);
      const second = read('race-target', 'maker:provider:list', [], lateRequest);
      await vi.advanceTimersByTimeAsync(0);
      expect(deniedRequest).toHaveBeenCalledTimes(1);
      expect(lateRequest).toHaveBeenCalledTimes(1);
      resolveDenied({ ok: false, error: { code: 'ACCESS_REVOKED', message: 'revoked' } });
      await expect(first).resolves.toMatchObject({ ok: false });
      expect(denied).toHaveBeenCalledExactlyOnceWith('race-target');
      resolveLate({ ok: true, result: { providers: [{ id: 'old' }] } });
      await expect(second).rejects.toThrow('Metadata scope changed');
      const after = vi.fn(catalog);
      await expect(read('race-target', 'maker:provider:list', [], after)).resolves.toMatchObject({ ok: true });
      expect(after).toHaveBeenCalledTimes(1);
      await expect(read('neighbour', 'maker:provider:list', [], async () => { throw failure(); }))
        .resolves.toMatchObject({ ok: true });
    } finally { off(); }
  });

  it('fences all in-flight live reads of one unregistered target on explicit invalidation', async () => {
    await fillCapacity();
    const denied = vi.fn(); const off = onProviderMetadataDenied(denied);
    try {
      let resolveA!: (value: InvokeResultPayload) => void;
      let resolveB!: (value: InvokeResultPayload) => void;
      const requestA = vi.fn(() => new Promise<InvokeResultPayload>(resolve => { resolveA = resolve; }));
      const requestB = vi.fn(() => new Promise<InvokeResultPayload>(resolve => { resolveB = resolve; }));
      const first = read('invalidate-target', 'maker:provider:list', [], requestA);
      const second = read('invalidate-target', 'maker:provider:list', [], requestB);
      await vi.advanceTimersByTimeAsync(0);
      invalidate('invalidate-target');
      resolveA({ ok: true, result: { providers: [{ id: 'old-a' }] } });
      resolveB({ ok: true, result: { providers: [{ id: 'old-b' }] } });
      const outcomes = await Promise.allSettled([first, second]);
      expect(outcomes.every(outcome => outcome.status === 'rejected')).toBe(true);
      expect(denied).not.toHaveBeenCalled();
      const after = vi.fn(catalog);
      await expect(read('invalidate-target', 'maker:provider:list', [], after)).resolves.toMatchObject({ ok: true });
      expect(after).toHaveBeenCalledTimes(1);
    } finally { off(); }
  });

  it('notifies and fences siblings after a thrown explicit live-read denial', async () => {
    await fillCapacity();
    const denied = vi.fn(); const off = onProviderMetadataDenied(denied);
    try {
      let resolveLate!: (value: InvokeResultPayload) => void;
      const late = read('throw-target', 'maker:provider:list', [], () => new Promise<InvokeResultPayload>(resolve => { resolveLate = resolve; }));
      const thrown = read('throw-target', 'maker:provider:list', [], async () => {
        throw Object.assign(new Error('[ACCESS_REVOKED] revoked'), { code: 'ACCESS_REVOKED' });
      });
      await expect(thrown).rejects.toThrow('ACCESS_REVOKED');
      expect(denied).toHaveBeenCalledExactlyOnceWith('throw-target');
      resolveLate({ ok: true, result: { providers: [{ id: 'old' }] } });
      await expect(late).rejects.toThrow('Metadata scope changed');
    } finally { off(); }
  });

  it('returns a transient live-read failure without fencing a successful sibling', async () => {
    await fillCapacity();
    const denied = vi.fn(); const off = onProviderMetadataDenied(denied);
    try {
      let resolveSuccess!: (value: InvokeResultPayload) => void;
      const success = read('transient-target', 'maker:provider:list', [], () => new Promise<InvokeResultPayload>(resolve => { resolveSuccess = resolve; }));
      const failed = read('transient-target', 'maker:provider:list', [], async () => ({ ok: false, error: { code: 'NOT_CONNECTED', message: 'down' } }));
      await expect(failed).resolves.toMatchObject({ ok: false });
      expect(denied).not.toHaveBeenCalled();
     resolveSuccess({ ok: true, result: { providers: [{ id: 'ok' }] } });
     await expect(success).resolves.toMatchObject({ ok: true });
   } finally { off(); }
 });

  it('fences siblings after a non-temporary live-read failure', async () => {
    await fillCapacity();
    const denied = vi.fn(); const off = onProviderMetadataDenied(denied);
    try {
      let resolveLate!: (value: InvokeResultPayload) => void;
      const late = read('expired-target', 'maker:provider:list', [], () => new Promise<InvokeResultPayload>(resolve => { resolveLate = resolve; }));
      const expired = read('expired-target', 'maker:provider:list', [], async () => ({ ok: true, result: {
        providers: [], providerContinuity: { stale: true, remainingMs: 0 },
      } }));
      await expect(expired).rejects.toThrow('MODEL_VISIBILITY_NOT_READY');
      expect(denied).not.toHaveBeenCalled();
      resolveLate({ ok: true, result: { providers: [{ id: 'old' }] } });
      await expect(late).rejects.toThrow('Metadata scope changed');
    } finally { off(); }
  });

 it('bounds the live-read fence and cleans it after all requests settle', async () => {
    await fillCapacity();
    const resolvers: Array<(value: InvokeResultPayload) => void> = [];
    const requests = Array.from({ length: 256 }, (_, index) => vi.fn(() =>
      new Promise<InvokeResultPayload>(resolve => { resolvers[index] = resolve; })));
    const pending = requests.map((request, index) => read(`flood-${index}`, 'maker:provider:list', [], request));
    await vi.advanceTimersByTimeAsync(0);
    await expect(read('flood-overflow', 'maker:provider:list', [], catalog)).rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
    for (const resolve of resolvers) resolve({ ok: true, result: { providers: [] } });
    await Promise.all(pending);
    const after = vi.fn(catalog);
    await expect(read('flood-after', 'maker:provider:list', [], after)).resolves.toMatchObject({ ok: true });
  });

  it.each(['wall', 'mono'] as const)(
    'does not bypass a positive upstream budget when the %s clock expires first',
    async boundary => {
      vi.useRealTimers();
      const wallBase = 1_000_000, monoBase = 2_000_000;
      const wallNow = vi.spyOn(Date, 'now').mockReturnValue(wallBase);
      const monoNow = vi.spyOn(performance, 'now').mockReturnValue(monoBase);
      try {
        await fillCapacity();
        let resolveRequest!: (value: InvokeResultPayload) => void;
        const request = vi.fn(() => new Promise<InvokeResultPayload>(resolve => { resolveRequest = resolve; }));
        const pending = read('budget-expired', 'maker:provider:list', [], request);
        if (boundary === 'wall') wallNow.mockReturnValue(wallBase + 1_001);
        else monoNow.mockReturnValue(monoBase + 1_001);
        resolveRequest({ ok: true, result: { providers: [], providerContinuity: {
          stale: true, remainingMs: 1_000,
        } } });
        await expect(pending).rejects.toThrow('MODEL_VISIBILITY_NOT_READY');
      } finally {
        wallNow.mockRestore(); monoNow.mockRestore(); vi.useRealTimers();
      }
    },
  );

  it('decrements an existing positive stamp and preserves stale; an unstamped result stays raw', async () => {
    vi.useRealTimers();
    const wallBase = 1_000_000, monoBase = 2_000_000;
    const wallNow = vi.spyOn(Date, 'now').mockReturnValue(wallBase);
    const monoNow = vi.spyOn(performance, 'now').mockReturnValue(monoBase);
    try {
      await fillCapacity();
      let resolveRequest!: (value: InvokeResultPayload) => void;
      const request = vi.fn(() => new Promise<InvokeResultPayload>(resolve => { resolveRequest = resolve; }));
      const pending = read('budget-unexpired', 'maker:provider:list', [], request);
      wallNow.mockReturnValue(wallBase + 400);
      monoNow.mockReturnValue(monoBase + 200);
      resolveRequest({ ok: true, result: { providers: [], providerContinuity: {
        stale: true, remainingMs: 1_000,
      } } });
      const result = await pending;
      expect(result).toMatchObject({ ok: true, result: { providers: [],
        providerContinuity: { stale: true, remainingMs: 600 } } });
      const noStamp = await read('budget-no-stamp', 'maker:provider:list', [], async () => ({
        ok: true, result: { providers: [] },
      }));
      expect(noStamp).toMatchObject({ ok: true, result: { providers: [] } });
      expect((noStamp as { result?: Record<string, unknown> }).result).not.toHaveProperty('providerContinuity');
    } finally {
      wallNow.mockRestore(); monoNow.mockRestore(); vi.useRealTimers();
    }
  });

  it('does not register never-read targets from invalidation at capacity', async () => {
    invalidate();
    const neighbour = captureProviderMetadataContinuityScope('neighbour');
    await read('neighbour', 'maker:provider:list', [], catalog);
    for (let index = 0; index < 1024; index += 1) invalidate('unregistered-' + index);
    expect(await read('brand-new-target', 'maker:provider:list', [], catalog)).toMatchObject({ ok: true });
    expect(neighbour()).toBe(true);
    expect(await read('neighbour', 'maker:provider:list', [], async () => { throw failure(); })).toMatchObject({ ok: true });
  });


  it('passes an old-host object through without synthesizing a stamp and does not cache it', async () => {
    const old = { ok: true as const, result: { providers: [{ id: 'old' }] } };
    expect(await read('old-host', 'maker:provider:list', [], async () => old)).toEqual(old);
    await expect(read('old-host', 'maker:provider:list', [], async () => { throw failure(); }))
      .rejects.toThrow('NOT_CONNECTED');
  });

  it('does not resurrect a prior stamped snapshot when the next old-host reply has no stamp', async () => {
    await read('downgrade', 'maker:provider:list', [], catalog);
    const old = await read('downgrade', 'maker:provider:list', [], oldHostCatalog);
    expect(old).toEqual({ ok: true, result: { providers: [{ id: 'a' }] } });
    await expect(read('downgrade', 'maker:provider:list', [], async () => { throw failure(); }))
      .rejects.toThrow('NOT_CONNECTED');
  });

  it('notifies once per denial episode and re-arms only on fresh same-resource success or permission change', async () => {
    const notified = vi.fn();
    const off = onProviderMetadataDenied(notified);
    try {
      const denial = { ok: false as const, error: { code: 'ACCESS_REVOKED' as const, message: 'revoked' } };
      await read('M', 'maker:provider:list', [], async () => denial);
      await read('M', 'maker:provider:list', [], async () => denial);
      expect(notified).toHaveBeenCalledTimes(1);
      // The provider-share refusal path invalidates the target again; that must
      // not re-arm the notification for the same resource.
      invalidate('M', { keepDenialNotifications: true });
      await read('M', 'maker:provider:list', [], async () => denial);
      expect(notified).toHaveBeenCalledTimes(1);
      // A non-visible different-resource success is not proof that this one
      // recovered; a visible provider/group result is covered separately.
      await read('M', 'maker:get-capabilities', [], async () => ({ ok: true as const, result: {} }));
      await read('M', 'maker:provider:list', [], async () => denial);
      expect(notified).toHaveBeenCalledTimes(1);
      // An explicit permission transition re-arms the episode.
      invalidate('M');
      await read('M', 'maker:provider:list', [], async () => denial);
      expect(notified).toHaveBeenCalledTimes(2);
      // A fresh success on this exact resource re-arms the next denial.
      await read('M', 'maker:provider:list', [], catalog);
      await read('M', 'maker:provider:list', [], async () => denial);
      expect(notified).toHaveBeenCalledTimes(3);
    } finally {
      off();
    }
  });

  it('does not re-arm a denial episode from a stale forwarded snapshot', async () => {
    const notified = vi.fn();
    const off = onProviderMetadataDenied(notified);
    try {
      const denial = { ok: false as const, error: { code: 'ACCESS_REVOKED' as const, message: 'revoked' } };
      await read('M', 'maker:provider:list', [], async () => denial);
      expect(notified).toHaveBeenCalledTimes(1);
      // A host can answer with a bounded stale snapshot. It is a cache success,
      // not proof that the same resource is readable again.
      await read('M', 'maker:provider:list', [], async () => ({ ok: true as const, result: {
        providers: [{ id: 'a' }], providerContinuity: { stale: true, remainingMs: 60_000 },
      } }));
      await read('M', 'maker:provider:list', [], async () => denial);
      expect(notified).toHaveBeenCalledTimes(1);
      // A genuinely fresh response re-arms the next denial.
      await read('M', 'maker:provider:list', [], catalog);
      await read('M', 'maker:provider:list', [], async () => denial);
      expect(notified).toHaveBeenCalledTimes(2);
    } finally {
      off();
    }
  });
  it('propagates a registered neighbour first denial after many live-only target episodes', async () => {
    const b = hexTarget('registered-b');
    const cId = hexTarget('registered-c');
    await read(b, 'maker:provider:list', [], catalog);
    await read(cId, 'maker:provider:list', [], catalog);
    await fillCapacity();
    const notified: string[] = [];
    const off = onProviderMetadataDenied(target => notified.push(target));
    try {
      const denial = { ok: false as const, error: { code: 'ACCESS_REVOKED' as const, message: 'revoked' } };
      const liveExtra = hexTarget('live-extra');
      // Sequential live-only reads, max concurrency 1. The live-only episode
      // ring is bounded independently from the registered target registry.
      for (let i = 0; i < 1280; i++) {
        await read(hexTarget('live-denied-' + i), 'maker:provider:list', [], async () => denial);
      }
      expect(notified.filter(target => target === b)).toHaveLength(0);
      await read(b, 'maker:agent:status', ['codex'], async () => denial);
      expect(notified.filter(target => target === b)).toHaveLength(1);
      await expect(read(b, 'maker:provider:list', [], async () => { throw failure(); }))
        .rejects.toThrow('NOT_CONNECTED');
      await read(b, 'maker:agent:status', ['codex'], async () => denial);
      expect(notified.filter(target => target === b)).toHaveLength(1);
      expect(await read(cId, 'maker:provider:list', [], async () => { throw failure(); }))
        .toMatchObject({ ok: true });
      // A new live-only target still gets its first-denial notification even
      // after the live ring is full; the oldest inactive episode is retired.
      await read(liveExtra, 'maker:provider:list', [], async () => denial);
      expect(notified.filter(target => target === liveExtra)).toHaveLength(1);
      await read(liveExtra, 'maker:provider:list', [], async () => denial);
      expect(notified.filter(target => target === liveExtra)).toHaveLength(1);
    } finally {
      off();
    }
  });
  it.each([false, true])('does not rearm overflow denials from an unrelated fresh success (liveOnly=%s)', async liveOnly => {
    if (liveOnly) await fillCapacity();
    const targetId = liveOnly ? 'overflow-live' : 'overflow-registered';
    const notifications: string[] = [];
    const off = onProviderMetadataDenied(target => notifications.push(target));
    try {
      const denial = { ok: false as const, error: { code: 'ACCESS_REVOKED' as const, message: 'revoked' } };
      for (let i = 0; i < 64; i++) {
        await read(targetId, PROVIDER_GROUP_REMOTE_CHANNEL,
          [{ action: 'view', providerId: 'openai', model: 'm' + i }], async () => denial);
      }
      await read(targetId, 'maker:get-capabilities', ['codex'], async () => denial);
      const afterFirst = notifications.filter(target => target === targetId).length;
      expect(afterFirst).toBe(65);
      // A non-visible provider-list success must not re-arm the overflowed
      // capabilities denial; empty provider rows are the control.
      for (let i = 0; i < 4; i++) {
        await read(targetId, 'maker:provider:list', [], emptyCatalog);
        await read(targetId, 'maker:get-capabilities', ['codex'], async () => denial);
      }
      expect(notifications.filter(target => target === targetId)).toHaveLength(afterFirst);
      // Only a fresh success on the same resource re-arms exactly one denial.
      await read(targetId, 'maker:get-capabilities', ['codex'], catalog);
      await read(targetId, 'maker:get-capabilities', ['codex'], async () => denial);
      expect(notifications.filter(target => target === targetId)).toHaveLength(afterFirst + 1);
    } finally {
      off();
    }
  });
  it.each([false, true])('keeps a fresh provider-list rearm across unrelated group-view successes (liveOnly=%s)', async liveOnly => {
    if (liveOnly) await fillCapacity();
    const targetId = liveOnly ? 'rearm-live' : 'rearm-registered';
    const notifications: string[] = [];
    const off = onProviderMetadataDenied(target => notifications.push(target));
    try {
      const denial = { ok: false as const, error: { code: 'ACCESS_REVOKED' as const, message: 'revoked' } };
      for (let i = 0; i < 64; i++) {
        await read(targetId, PROVIDER_GROUP_REMOTE_CHANNEL,
          [{ action: 'view', providerId: 'openai', model: 'denied-' + i }], async () => denial);
      }
      await read(targetId, 'maker:get-capabilities', ['codex'], async () => denial);
      expect(notifications.filter(target => target === targetId)).toHaveLength(65);
      expect(await read(targetId, 'maker:provider:list', [], catalog)).toMatchObject({ ok: true });
      const groupSuccess = async () => ({ ok: true as const, result: {
        members: [], providerContinuity: { stale: false, remainingMs: 60_000 },
      } });
      for (let i = 0; i < 64; i++) {
        await read(targetId, PROVIDER_GROUP_REMOTE_CHANNEL,
          [{ action: 'view', providerId: 'openai', model: 'fresh-' + i }], groupSuccess);
      }
      const before = notifications.filter(target => target === targetId).length;
      await read(targetId, 'maker:provider:list', [], async () => denial);
      expect(notifications.filter(target => target === targetId)).toHaveLength(before + 1);
      await read(targetId, PROVIDER_GROUP_REMOTE_CHANNEL,
        [{ action: 'view', providerId: 'openai', model: 'fresh-0' }], async () => denial);
      expect(notifications.filter(target => target === targetId)).toHaveLength(before + 2);
      await read(targetId, PROVIDER_GROUP_REMOTE_CHANNEL,
        [{ action: 'view', providerId: 'openai', model: 'fresh-0' }], async () => denial);
      expect(notifications.filter(target => target === targetId)).toHaveLength(before + 2);
    } finally {
      off();
    }
  });
  it.each([false, true])('retires a visible target after more group successes than the dedup budget (liveOnly=%s)', async liveOnly => {
    if (liveOnly) await fillCapacity();
    const targetId = liveOnly ? 'visible-live' : 'visible-registered';
    const notifications: string[] = [];
    const off = onProviderMetadataDenied(target => notifications.push(target));
    try {
      const denial = { ok: false as const, error: { code: 'ACCESS_REVOKED' as const, message: 'revoked' } };
      for (let i = 0; i < 64; i++) {
        await read(targetId, PROVIDER_GROUP_REMOTE_CHANNEL,
          [{ action: 'view', providerId: 'openai', model: 'denied-' + i }], async () => denial);
      }
      await read(targetId, 'maker:get-capabilities', ['codex'], async () => denial);
      await read(targetId, 'maker:provider:list', [], catalog);
      const groupSuccess = async () => ({ ok: true as const, result: {
        members: [], providerContinuity: { stale: false, remainingMs: 60_000 },
      } });
      for (let i = 0; i < 65; i++) {
        await read(targetId, PROVIDER_GROUP_REMOTE_CHANNEL,
          [{ action: 'view', providerId: 'openai', model: 'fresh-' + i }], groupSuccess);
      }
      const before = notifications.filter(target => target === targetId).length;
      await read(targetId, PROVIDER_GROUP_REMOTE_CHANNEL,
        [{ action: 'view', providerId: 'openai', model: 'fresh-0' }], async () => denial);
      expect(notifications.filter(target => target === targetId)).toHaveLength(before + 1);
    } finally {
      off();
    }
  });
  it('does not let one target resource flood suppress a neighbour first denial', async () => {
    const notified: string[] = [];
    const off = onProviderMetadataDenied(target => notified.push(target));
    try {
      await read('healthy-b', 'maker:provider:list', [], catalog);
      await read('healthy-c', 'maker:provider:list', [], catalog);
      const denial = { ok: false as const, error: { code: 'ACCESS_REVOKED' as const, message: 'revoked' } };
      for (let i = 0; i < 16_384; i++) {
        await read('flood-a', PROVIDER_GROUP_REMOTE_CHANNEL,
          [{ action: 'view', providerId: 'p', model: `m${i}` }], async () => denial);
      }
      expect(notified.filter(target => target === 'healthy-b')).toHaveLength(0);
      await read('healthy-b', 'maker:agent:status', ['codex'], async () => denial);
      expect(notified.filter(target => target === 'healthy-b')).toHaveLength(1);
      await expect(read('healthy-b', 'maker:provider:list', [], async () => { throw failure(); }))
        .rejects.toThrow('NOT_CONNECTED');
      await read('healthy-b', 'maker:agent:status', ['codex'], async () => denial);
      expect(notified.filter(target => target === 'healthy-b')).toHaveLength(1);
      expect(await read('healthy-c', 'maker:provider:list', [], async () => { throw failure(); }))
        .toMatchObject({ ok: true });
      // The same bounded registry must also isolate a live-only overflow
      // target: filling the target registry must not let flood-a suppress it.
      await fillCapacity();
      await read('live-healthy-b', 'maker:provider:list', [], async () => denial);
      expect(notified.filter(target => target === 'live-healthy-b')).toHaveLength(1);
      await read('live-healthy-b', 'maker:provider:list', [], async () => denial);
      expect(notified.filter(target => target === 'live-healthy-b')).toHaveLength(1);
      expect(await read('neighbour', 'maker:provider:list', [], async () => { throw failure(); }))
        .toMatchObject({ ok: true });
    } finally {
      off();
    }
  });
  it('fences live capacity denials without a repeat notification loop and re-arms after success', async () => {
    await fillCapacity();
    const notified = vi.fn();
    const off = onProviderMetadataDenied(notified);
    try {
      const denial = { ok: false as const, error: { code: 'ACCESS_REVOKED' as const, message: 'revoked' } };
      await read('live-target', 'maker:provider:list', [], async () => denial);
      await read('live-target', 'maker:provider:list', [], async () => denial);
      expect(notified).toHaveBeenCalledTimes(1);
      await read('live-target', 'maker:provider:list', [], catalog);
      await read('live-target', 'maker:provider:list', [], async () => denial);
      expect(notified).toHaveBeenCalledTimes(2);
    } finally {
      off();
    }
  });




  it('keeps production Fast-policy failures terminal while treating group-handler UNAVAILABLE as temporary', () => {
    expect(isTemporaryProviderMetadataFailure(Object.assign(
      new Error('[REMOTE_AGENT_UNAVAILABLE] Subscription Fast policy executor is unreachable'),
      { code: 'IPC_ERROR' },
    ))).toBe(false);
    expect(isTemporaryProviderMetadataFailure(Object.assign(
      new Error('[UNAVAILABLE] provider groups are not ready yet'),
      { code: 'IPC_ERROR' },
    ))).toBe(true);
  });

  it('keeps array-form allowed reads raw and uncached', async () => {
    const agents = ['claude-code', 'codex'];
    expect(await read('A', 'maker:list-available-agents', [], async () => ({ ok: true, result: agents })))
      .toEqual({ ok: true, result: agents });
    await expect(read('A', 'maker:list-available-agents', [], async () => { throw failure(); }))
      .rejects.toThrow('NOT_CONNECTED');
  });

  it('treats the dispatch group-handler startup [UNAVAILABLE] as temporary without clearing the target', async () => {
    const groupView = { providerId: 'openai', config: null, members: [],
      providerContinuity: { stale: false, remainingMs: 30 * 60_000 } };
    const notReady = { ok: false as const, error: { code: 'IPC_ERROR' as const,
      message: '[UNAVAILABLE] provider groups are not ready yet' } };
    await read('M', 'maker:provider:list', [], catalog);
    await expect(read('M', PROVIDER_GROUP_REMOTE_CHANNEL,
      [{ action: 'view', providerId: 'openai' }], async () => notReady)).resolves.toBe(notReady);
    // A startup not-ready answer must not retire an unrelated provider catalog.
    expect(await read('M', 'maker:provider:list', [], async () => { throw failure(); }))
      .toMatchObject({ ok: true, result: { providers: [{ id: 'a' }] } });
    // With a cached view it is a bounded stale fallback, not an authoritative clear.
    await read('M', PROVIDER_GROUP_REMOTE_CHANNEL,
      [{ action: 'view', providerId: 'openai' }], async () => ({ ok: true, result: groupView }));
    expect(await read('M', PROVIDER_GROUP_REMOTE_CHANNEL,
      [{ action: 'view', providerId: 'openai' }], async () => notReady))
      .toMatchObject({ ok: true, result: { providerContinuity: { stale: true } } });
  });

  it('notifies mounted directory consumers only for an authoritative late 403', async () => {
    const directoryEpoch = providerDirectoryGeneration();
    const denied = vi.fn();
    const off = onProviderDirectoryDenied(denied);
    try {
      await readProviderDirectoryContinuity(async () => ({ devices: [{ deviceId: 'M' }] }));
      let reject!: (error: unknown) => void;
      const pending = readProviderDirectoryContinuity(() => new Promise((_, fail) => { reject = fail; }));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await pending).toMatchObject({ stale: true });
      reject(Object.assign(new Error('denied'), { statusCode: 403 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(denied).toHaveBeenCalledTimes(1);
      expect(providerDirectoryGeneration()).toBe(directoryEpoch);

      await readProviderDirectoryContinuity(async () => ({ devices: [{ deviceId: 'M' }] }));
      const transient = readProviderDirectoryContinuity(() => new Promise((_, fail) => { reject = fail; }));
      await vi.advanceTimersByTimeAsync(2_000);
      await transient;
      reject(Object.assign(new Error('busy'), { statusCode: 503 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(denied).toHaveBeenCalledTimes(1);
      expect(providerDirectoryGeneration()).toBe(directoryEpoch);
    } finally { off(); }
  });

  it('does not notify the new owner for an old-owner directory denial', async () => {
    const denied = vi.fn();
    const off = onProviderDirectoryDenied(denied);
    try {
      await readProviderDirectoryContinuity(async () => ({ devices: ['old-owner'] }));
      let reject!: (error: unknown) => void;
      const pending = readProviderDirectoryContinuity(() => new Promise((_, fail) => { reject = fail; }));
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
      identity.owner = 'owner-b:2';
      reject(Object.assign(new Error('denied'), { statusCode: 403 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(denied).not.toHaveBeenCalled();
    } finally { off(); }
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
  // Actual Main index.ts registers handleProviderMetadataSourcePush on client.onFrame.
  // This test supplies a fake frame transport, but uses the real production push
  // handler and the real Main metadata reader; no direct invalidate call.
  it('retires only the agent-status target on a real agents-changed push and keeps a healthy neighbour', async () => {
    const handlers: Array<(env: Envelope) => void> = [];
    const handledResults: boolean[] = [];
    const transport = { onFrame: (callback: (env: Envelope) => void) => { handlers.push(callback); return () => undefined; } };
    transport.onFrame((env) => { handledResults.push(handleProviderMetadataSourcePush(env)); });
    const deliver = (env: Envelope): boolean => {
      const start = handledResults.length;
      for (const callback of handlers) callback(env);
      return handledResults[start] ?? false;
    };
    const agentStatus = (binaryReady: boolean, remainingMs: number): InvokeResultPayload => ({
      ok: true, result: { binaryReady, authReady: true, providerContinuity: { stale: false, remainingMs } },
    });
    const push = (src: string, channel: string): Envelope => ({ v: 1, kind: 'push', src, payload: { channel } });

    await read('A', 'maker:agent:status', ['codex'], async () => agentStatus(false, 20 * 60_000));
    await read('B', 'maker:agent:status', ['codex'], async () => agentStatus(true, 10 * 60_000));
    const bScope = captureProviderMetadataContinuityScope('B');
    const aScope = captureProviderMetadataContinuityScope('A');
    const bBefore = await read('B', 'maker:agent:status', ['codex'], async () => { throw failure(); });
    expect(bBefore).toMatchObject({ ok: true, result: { binaryReady: true, providerContinuity: { stale: true } } });

    let resolveLate!: (value: InvokeResultPayload) => void;
    const lateRequest = vi.fn().mockImplementationOnce(() => new Promise<InvokeResultPayload>(resolve => { resolveLate = resolve; }))
      .mockRejectedValue(failure());
    const late = read('A', 'maker:agent:status', ['codex'], lateRequest);
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver(push('A', 'maker:agents:changed'))).toBe(true);
    expect(aScope()).toBe(false);
    resolveLate(agentStatus(false, 20 * 60_000));
    await expect(late).rejects.toThrow('NOT_CONNECTED');
    expect(lateRequest).toHaveBeenCalledTimes(2);

    await expect(read('A', 'maker:agent:status', ['codex'], async () => { throw failure(); }))
      .rejects.toThrow('NOT_CONNECTED');
    const bAfter = await read('B', 'maker:agent:status', ['codex'], async () => { throw failure(); });
    expect(bAfter).toMatchObject({ ok: true, result: { binaryReady: true, providerContinuity: { stale: true } } });
    expect(bScope()).toBe(true);
    const bBeforeRemaining = (bBefore as { result?: { providerContinuity?: { remainingMs?: number } } }).result?.providerContinuity?.remainingMs ?? 0;
    const bAfterRemaining = (bAfter as { result?: { providerContinuity?: { remainingMs?: number } } }).result?.providerContinuity?.remainingMs ?? 0;
    expect(bAfterRemaining).toBeLessThanOrEqual(bBeforeRemaining);

    const fresh = await read('A', 'maker:agent:status', ['codex'], async () => agentStatus(true, 20 * 60_000));
    expect(fresh).toMatchObject({ ok: true, result: { binaryReady: true, providerContinuity: { stale: false } } });
    expect(handleProviderMetadataSourcePush(push('A', 'maker:agent:status'))).toBe(false);
    expect(await read('A', 'maker:agent:status', ['codex'], async () => { throw failure(); }))
      .toMatchObject({ ok: true, result: { binaryReady: true, providerContinuity: { stale: true } } });

    await read('A', 'maker:agent:status', ['codex'], async () => agentStatus(true, 20 * 60_000));
    expect(handleProviderMetadataSourcePush(push('A', 'maker:provider:changed'))).toBe(true);
    await expect(read('A', 'maker:agent:status', ['codex'], async () => { throw failure(); }))
      .rejects.toThrow('NOT_CONNECTED');

    await read('A', 'maker:agent:status', ['codex'], async () => agentStatus(true, 20 * 60_000));
    expect(handleProviderMetadataSourcePush(push('A', PROVIDER_GROUP_IPC.CHANGED))).toBe(true);
    await expect(read('A', 'maker:agent:status', ['codex'], async () => { throw failure(); }))
      .rejects.toThrow('NOT_CONNECTED');

    await read('A', 'maker:agent:status', ['codex'], async () => agentStatus(true, 20 * 60_000));
    const rpcScope = captureProviderMetadataContinuityScope('A');
    expect(handleProviderMetadataSourcePush(push('A', PROVIDER_GROUP_REMOTE_CHANNEL))).toBe(false);
    expect(rpcScope()).toBe(true);
    expect(await read('A', 'maker:agent:status', ['codex'], async () => { throw failure(); }))
      .toMatchObject({ ok: true, result: { binaryReady: true, providerContinuity: { stale: true } } });
  });
});
