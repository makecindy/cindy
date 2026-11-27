import { describe, expect, it, vi } from 'vitest';
import { createRemoteUtilityHost, type RemoteUtilityHostDeps } from '../host.js';

// Unit: no prior coverage for this handler; exercise permission and cancellation races
// through the production entry, including a stale outbox result and a changed owner.
const route = { providerId: 'openai', agentKind: 'codex' as const, model: 'model' };
const request = { version: 1, op: 'run', hostEpoch: 'epoch', requestId: 'id', prompt: 'private', options: {}, route };
const success = { ok: true as const, text: 'answer', providerId: 'openai', model: 'model', transport: 'codex-responses' as const };
function fixture() {
  let snapshot = { owner: 'owner-a', hostEpoch: 'epoch', authorizationEpoch: '1' };
  let routes = [route];
  const execute = vi.fn<RemoteUtilityHostDeps['execute']>(async (_prompt, opts) => await opts.beforeDispatch(route) ? success : { ok: false, reason: 'no_candidate', attempts: [] });
  const host = createRemoteUtilityHost({ current: (_caller, target) => target && !routes.some((item) => item.providerId === target.providerId && item.agentKind === target.agentKind && item.model === target.model) ? null : snapshot, allowedRoutes: async () => routes, execute });
  return { host, execute, setSnapshot: (value: typeof snapshot) => { snapshot = value; }, setRoutes: (value: typeof routes) => { routes = value; } };
}
describe('remote utility host', () => {
  it('runs the exact authorized route, returning the structured result and checking outbox permission', async () => {
    const f = fixture();
    expect(await f.host.handle('caller', { version: 1, op: 'caps' })).toMatchObject({ op: 'caps', allowedRoutes: [route] });
    const response = await f.host.handle('caller', request);
    expect(response).toMatchObject({ op: 'run', result: success });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(await f.host.resultIsCurrent('caller', response)).toBe(true);
    f.setRoutes([]);
    expect(await f.host.resultIsCurrent('caller', response)).toBe(false);
  });
  it('never executes a cancelled-before-run operation or one from a stale host epoch', async () => {
    const f = fixture();
    await f.host.handle('caller', { version: 1, op: 'cancel', hostEpoch: 'epoch', requestId: 'id' });
    expect(await f.host.handle('caller', request)).toMatchObject({ code: 'CANCELLED' });
    expect(await f.host.handle('caller', { ...request, hostEpoch: 'old' })).toMatchObject({ code: 'STALE_HOST' });
    expect(f.execute).not.toHaveBeenCalled();
    f.host.abortAll();
  });
  it('isolates old-owner cancellation from a new owner with the same caller and request id', async () => {
    const f = fixture();
    const oldScope = { owner: 'owner-a', hostEpoch: 'epoch' };
    await f.host.handle('caller', { version: 1, op: 'cancel', hostEpoch: 'epoch', requestId: 'id' });
    f.setSnapshot({ owner: 'owner-b', hostEpoch: 'epoch', authorizationEpoch: '2' });
    f.host.abortController('caller', oldScope);
    expect(await f.host.handle('caller', request)).toMatchObject({ op: 'run', result: success });
    f.host.abortAll();
  });
  it('revocation during authentication stops the dispatch guard and discards the outbox result', async () => {
    const f = fixture();
    f.execute.mockImplementationOnce(async (_prompt, opts) => {
      f.setSnapshot({ owner: 'owner-a', hostEpoch: 'epoch', authorizationEpoch: '2' });
      expect(await opts.beforeDispatch(route)).toBe(false);
      return success;
    });
    const result = await f.host.handle('caller', request);
    expect(result).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await f.host.resultIsCurrent('caller', result)).toBe(false);
  });
  it('rejects a different route at the final dispatch guard', async () => {
    const f = fixture();
    f.execute.mockImplementationOnce(async (_prompt, opts) => {
      expect(await opts.beforeDispatch({ ...route, model: 'other' })).toBe(false);
      return { ok: false, reason: 'no_candidate', attempts: [] };
    });
    expect(await f.host.handle('caller', request)).toMatchObject({ op: 'run', result: { ok: false, reason: 'no_candidate' } });
  });
});
