/** Unit: production query gate and host recheck scheduler, fake time and HTTP boundary.
 * Regression: initial grants and periodic peers could burst into one account's write bucket.
 * Existing delegated-access tests cover permissions, not query counts/cooldown/scope scheduling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderShareDelegationChecks, startProviderShareDelegationRechecks,
  type DelegationCheckResult } from '../providerShareDelegationChecks';
import { checkProviderShareDelegation, clearProviderShareDelegationChecks,
  grantProviderShareDelegation, revokeProviderShareDelegation } from '../providerShareApi';

const api = vi.hoisted(() => ({ scope: 'account-a', endpoint: 'https://api.example.invalid', fetch: vi.fn() }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => api.scope,
  isAppSessionBoundaryPending: () => false, getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: api.scope }) }));
vi.mock('../../authManager.js', () => ({ getAuthState: () => ({ isAuthenticated: true }) }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => api.endpoint }));
vi.mock('../../serverApiClient.desktop.js', () => ({ serverApiFetch: api.fetch }));
vi.mock('../../utils/ipcValidate.js', () => ({ throwIpcError: (code: string) => { throw new Error(code); } }));
vi.mock('../agentNetSharing.js', () => ({ checkAgentNetProviderExecutor: async () => null,
  grantAgentNetProviderExecutor: async () => null, revokeAgentNetProviderExecutor: async () => false }));

const input = { shareId: 'share', memberId: 'member', guestDeviceId: 'guest', executorDeviceId: 'executor' };
const approved = { active: true, ownerDeviceId: 'owner', generation: 'generation-1', expiresAt: 1_800_000 };
function deferred() {
  let resolve!: (value: DelegationCheckResult) => void;
  const promise = new Promise<DelegationCheckResult>(yes => { resolve = yes; });
  return { promise, resolve };
}
function harness() {
  let scope = 'account-a:cn';
  const request = vi.fn<Parameters<typeof createProviderShareDelegationChecks>[0]['request']>(async () => approved);
  const checks = createProviderShareDelegationChecks({
    captureScope: () => { const key = scope; return { key, isCurrent: () => key === scope }; },
    scopeChanged: () => new Error('scope changed'), request, random: () => 0,
  });
  return { request, checks, setScope: (value: string) => { scope = value; } };
}

let apiTestEpoch = 0;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  api.scope = 'account-' + ++apiTestEpoch; api.endpoint = 'https://api.example.invalid'; api.fetch.mockReset();
});
afterEach(() => { clearProviderShareDelegationChecks(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('authenticated delegation API', () => {
  it('stops a mixed multi-executor batch after one 429 instead of amplifying rollback writes', async () => {
    api.fetch.mockRejectedValue(Object.assign(Error('limited'), { statusCode: 429, retryAt: 120_000 }));
    const work = Promise.allSettled(Array.from({ length: 32 }, (_, i) => {
      const target = { ...input, executorDeviceId: `executor-${i}` };
      return i % 3 === 0 ? grantProviderShareDelegation(target, { background: true })
        : i % 3 === 1 ? revokeProviderShareDelegation({ ...target, generation: 'old-generation' }, { background: true })
          : checkProviderShareDelegation(target);
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect((await work).every(outcome => outcome.status === 'rejected')).toBe(true);
    for (let i = 0; i < 10; i++) {
      await expect(grantProviderShareDelegation(input)).rejects.toHaveProperty('retryAt', 120_000);
    }
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });
  // Unit / real API entry, synthetic HTTP. Previously checks alone used the gate:
  // two identical grants and generation-specific rollbacks could flood the endpoint.
  it('joins identical writes while keeping distinct revoke generations separate', async () => {
    const generation = '11111111-1111-4111-8111-111111111111';
    api.fetch.mockResolvedValue({ expiresAt: 1_800_000, generation });
    const grants = Promise.all([grantProviderShareDelegation(input), grantProviderShareDelegation(input)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await grants).toEqual([{ expiresAt: 1_800_000, generation }, { expiresAt: 1_800_000, generation }]);
    expect(api.fetch).toHaveBeenCalledTimes(1);
    const revokes = Promise.all([
      revokeProviderShareDelegation({ ...input, generation }),
      revokeProviderShareDelegation({ ...input, generation }),
      revokeProviderShareDelegation({ ...input, generation: '22222222-2222-4222-8222-222222222222' }),
    ]);
    await vi.advanceTimersByTimeAsync(2_500); await revokes;
    expect(api.fetch.mock.calls.map(call => call[1].body.generation)).toEqual([
      undefined, generation, '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('shares Retry-After across grant, revoke and check and resumes after host rebuild', async () => {
    api.fetch.mockRejectedValueOnce(Object.assign(new Error('limited'), { statusCode: 429, retryAt: 90_000 }));
    const failed = expect(grantProviderShareDelegation(input)).rejects.toThrow('limited');
    await vi.advanceTimersByTimeAsync(0); await failed;
    clearProviderShareDelegationChecks();
    await expect(revokeProviderShareDelegation({ ...input, generation: 'old' })).rejects.toMatchObject({ retryAt: 90_000 });
    await expect(checkProviderShareDelegation(input)).rejects.toMatchObject({ retryAt: 90_000 });
    await expect(grantProviderShareDelegation({ ...input, executorDeviceId: 'another' })).rejects.toMatchObject({ retryAt: 90_000 });
    expect(api.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);
    api.fetch.mockResolvedValue({ expiresAt: 1_800_000, generation: '11111111-1111-4111-8111-111111111111' });
    const recovered = grantProviderShareDelegation(input);
    await vi.advanceTimersByTimeAsync(0);
    await expect(recovered).resolves.toHaveProperty('expiresAt', 1_800_000);
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });
  it('coalesces actual grant/recheck HTTP calls and keeps local generation out of the wire body', async () => {
    const value = { ...approved, generation: '11111111-1111-4111-8111-111111111111' };
    api.fetch.mockResolvedValue(value);
    const first = checkProviderShareDelegation(input, value.generation);
    const joined = checkProviderShareDelegation(input, value.generation);
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toEqual(value);
    await expect(joined).resolves.toEqual(value);
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(api.fetch).toHaveBeenCalledWith('/api/device-link/provider-shares/delegations/check',
      expect.objectContaining({ method: 'POST', body: input, cache: 'no-store' }));
  });

  it('stops actual HTTP calls for other peers after a legacy 429', async () => {
    api.fetch.mockRejectedValue(Object.assign(new Error('rate limited'), { statusCode: 429 }));
    const first = expect(checkProviderShareDelegation(input)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    await first;
    await expect(checkProviderShareDelegation({ ...input, guestDeviceId: 'other' })).rejects.toThrow();
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('provider-share delegation checks', () => {
  it('gives foreground the first turn and alternates with queued repairs', async () => {
    const h = harness();
    const order: string[] = [];
    const submit = (key: string, background: boolean) => h.checks.run(key, async () => { order.push(key); }, { background });
    const work = Promise.all([submit('repair-a', true), submit('repair-b', true), submit('task-a', false), submit('task-b', false)]);
    await vi.advanceTimersByTimeAsync(3_000); await work;
    expect(order).toEqual(['task-a', 'repair-a', 'task-b', 'repair-b']);
    h.checks.clear();
  });

  it('admits a normal task even when queued background work fills the pending budget', async () => {
    const h = harness(), request = vi.fn(async () => approved);
    const repairs = Promise.allSettled(Array.from({ length: 128 }, (_, i) =>
      h.checks.run(`repair-${i}`, request, { background: true })));
    const foreground = h.checks.run('normal-task', request);
    await vi.advanceTimersByTimeAsync(0);
    await expect(foreground).resolves.toEqual(approved);
    h.checks.clear();
    const results = await repairs;
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('cancels unsent writes but keeps a shared write needed by another caller', async () => {
    const h = harness(), first = new AbortController(), second = new AbortController();
    const request = vi.fn(async () => approved);
    const canceled = expect(h.checks.run('canceled', request, { signal: first.signal })).rejects.toThrow('stop');
    first.abort(Error('stop'));
    const detached = expect(h.checks.run('shared', request, { signal: second.signal })).rejects.toThrow('stop');
    const kept = h.checks.run('shared', request);
    second.abort(Error('stop'));
    await vi.advanceTimersByTimeAsync(0); await canceled; await detached;
    await expect(kept).resolves.toEqual(approved);
    expect(request).toHaveBeenCalledTimes(1);
    h.checks.clear();
  });

  it('does not reset an account cooldown by switching away and back', async () => {
    const h = harness();
    h.request.mockRejectedValueOnce(Object.assign(Error('limited'), { statusCode: 429, retryAt: 90_000 }));
    const failed = expect(h.checks.check(input)).rejects.toThrow('limited');
    await vi.advanceTimersByTimeAsync(0); await failed;
    h.setScope('account-b:cn');
    const other = h.checks.check(input);
    await vi.advanceTimersByTimeAsync(0); await expect(other).resolves.toEqual(approved);
    h.setScope('account-a:cn');
    await expect(h.checks.check(input)).rejects.toMatchObject({ retryAt: 90_000 });
    expect(h.request).toHaveBeenCalledTimes(2);
    h.checks.clear();
  });

  it('retains a late old-account 429 without cooling or authorizing the replacement account', async () => {
    const h = harness();
    let reject!: (error: unknown) => void;
    h.request.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
    const old = expect(h.checks.check(input)).rejects.toThrow('scope changed');
    await vi.advanceTimersByTimeAsync(0);
    h.setScope('account-b:cn');
    const replacement = h.checks.check(input);
    await vi.advanceTimersByTimeAsync(0); await old;
    await expect(replacement).resolves.toEqual(approved);
    reject(Object.assign(Error('limited'), { statusCode: 429, retryAt: 90_000 }));
    await vi.advanceTimersByTimeAsync(0);
    h.setScope('account-a:cn');
    await expect(h.checks.check(input)).rejects.toMatchObject({ retryAt: 90_000 });
    expect(h.request).toHaveBeenCalledTimes(2);
    h.checks.clear();
  });
  // Unit review regressions: the former deadline left HTTP/refresh occupying the gate;
  // disposal dropped the same account's physical tail and Retry-After budget.
  it('aborts an expired running query and lets a newer peer use the released gate', async () => {
    const h = harness();
    let signal: AbortSignal | undefined;
    h.request.mockImplementationOnce((_input, _scope, _timeout, currentSignal) => new Promise((_yes, no) => {
      signal = currentSignal;
      currentSignal.addEventListener('abort', () => no(currentSignal.reason), { once: true });
    }));
    const old = expect(h.checks.check(input)).rejects.toHaveProperty('code', 'RATE_LIMITED');
    await vi.advanceTimersByTimeAsync(14_999);
    const fresh = h.checks.check({ ...input, guestDeviceId: 'fresh' });
    await vi.advanceTimersByTimeAsync(1);
    await old;
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(750);
    await expect(fresh).resolves.toEqual(approved);
    expect(h.request).toHaveBeenCalledTimes(2);
    h.checks.clear();
  });

  it('keeps a canceled same-scope physical tail serialized across host disposal', async () => {
    const h = harness(), pending = deferred();
    h.request.mockImplementationOnce(() => pending.promise);
    const old = expect(h.checks.check(input)).rejects.toThrow('scope changed');
    await vi.advanceTimersByTimeAsync(0);
    h.checks.clear();
    await old;
    const fresh = h.checks.check(input);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request).toHaveBeenCalledTimes(1);
    pending.resolve(approved);
    await vi.advanceTimersByTimeAsync(750);
    await expect(fresh).resolves.toEqual(approved);
    expect(h.request).toHaveBeenCalledTimes(2);
    h.checks.clear();
  });

  it('preserves Retry-After and repeated-429 backoff through same-scope host disposal', async () => {
    const h = harness();
    h.request.mockRejectedValue(Object.assign(new Error('rate limited'), { statusCode: 429 }));
    const first = expect(h.checks.check(input)).rejects.toThrow('rate limited');
    await vi.advanceTimersByTimeAsync(0); await first;
    h.checks.clear();
    const duringFirstCooldown = expect(h.checks.check(input)).rejects.toMatchObject({ retryAt: 60_000 });
    await vi.advanceTimersByTimeAsync(0); await duringFirstCooldown;
    expect(h.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    const second = expect(h.checks.check(input)).rejects.toThrow('rate limited');
    await vi.advanceTimersByTimeAsync(0); await second;
    h.checks.clear();
    const duringSecondCooldown = expect(h.checks.check(input)).rejects.toMatchObject({ retryAt: 180_000 });
    await vi.advanceTimersByTimeAsync(0); await duringSecondCooldown;
    h.checks.clear();
  });

  it('joins only in-flight identical generations and never caches an authorization result', async () => {
    const h = harness(), pending = deferred();
    h.request.mockImplementationOnce(() => pending.promise);
    const first = h.checks.check(input, 'generation-1');
    const joined = h.checks.check(input, 'generation-1');
    const newer = h.checks.check(input, 'generation-2');
    expect(joined).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).toHaveBeenCalledTimes(1);
    pending.resolve(approved);
    await expect(first).resolves.toEqual(approved);
    await vi.advanceTimersByTimeAsync(750);
    await newer;
    expect(h.request).toHaveBeenCalledTimes(2);
    const fresh = h.checks.check(input, 'generation-1');
    await vi.advanceTimersByTimeAsync(750);
    await fresh;
    expect(h.request).toHaveBeenCalledTimes(3);
    h.checks.clear();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 0, 120_000])('stops the whole queued batch on 429 and obeys retryAt=%s', async retryAt => {
    const h = harness();
    h.request.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { statusCode: 429, retryAt }));
    const outcomes = Promise.allSettled([
      h.checks.check(input), h.checks.check({ ...input, guestDeviceId: 'guest-b' }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect((await outcomes).map(x => x.status)).toEqual(['rejected', 'rejected']);
    expect(h.request).toHaveBeenCalledTimes(1);
    const delay = retryAt || 60_000;
    await vi.advanceTimersByTimeAsync(delay - 1);
    await expect(h.checks.check(input)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAt: delay });
    expect(h.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const recovered = h.checks.check(input);
    await vi.advanceTimersByTimeAsync(0);
    await expect(recovered).resolves.toEqual(approved);
    h.checks.clear();
  });

  it('backs off repeated legacy 429 responses without retrying them automatically', async () => {
    const h = harness();
    h.request.mockRejectedValue(Object.assign(new Error('rate limited'), { statusCode: 429 }));
    for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      const now = Date.now();
      const rejected = expect(h.checks.check(input)).rejects.toThrow('rate limited');
      await vi.advanceTimersByTimeAsync(0);
      await rejected;
      await expect(h.checks.check(input)).rejects.toMatchObject({ retryAt: now + delay });
      const calls = h.request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay);
      expect(h.request).toHaveBeenCalledTimes(calls);
    }
    h.checks.clear();
  });

  it.each(['account-b:cn', 'account-a:global'])('discards queued/late old-scope results and isolates %s', async scope => {
    const h = harness(), late = deferred();
    h.request.mockImplementationOnce(() => late.promise);
    const old = Promise.allSettled([h.checks.check(input), h.checks.check({ ...input, guestDeviceId: 'old-queued' })]);
    await vi.advanceTimersByTimeAsync(0);
    h.setScope(scope);
    const fresh = h.checks.check(input);
    await vi.advanceTimersByTimeAsync(0);
    await expect(fresh).resolves.toEqual(approved);
    expect((await old).map(x => x.status)).toEqual(['rejected', 'rejected']);
    late.resolve({ active: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.request).toHaveBeenCalledTimes(2);
    h.checks.clear();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires waiting checks without sending them or installing a late result', async () => {
    const h = harness(), late = deferred();
    h.request.mockImplementationOnce(() => late.promise);
    const outcomes = Promise.allSettled([h.checks.check(input), h.checks.check({ ...input, guestDeviceId: 'waiting' })]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await outcomes).every(x => x.status === 'rejected')).toBe(true);
    late.resolve(approved);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.request).toHaveBeenCalledTimes(1);
    h.checks.clear();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds pending checks and cancels all of them on host disposal', async () => {
    const h = harness(), late = deferred();
    h.request.mockImplementation(() => late.promise);
    const jobs = Promise.allSettled(Array.from({ length: 128 }, (_, i) => h.checks.check({ ...input, guestDeviceId: `guest-${i}` })));
    await expect(h.checks.check(input)).rejects.toHaveProperty('code', 'RATE_LIMITED');
    h.checks.clear();
    expect((await jobs).every(x => x.status === 'rejected')).toBe(true);
    expect(h.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('periodic delegation rechecks', () => {
  const lease = (peer: string, sessionId: string) => ({ peer, sessionId,
    lease: { ownerDeviceId: 'owner', nonce: sessionId, generation: 'generation-1' } });

  it('spreads peers, checks same-peer tasks once, and invalidates only the rejected peer', async () => {
    const a = lease('a', 'one'), b = lease('a', 'two'), healthy = lease('healthy', 'three');
    const check = vi.fn(async (item: typeof a) => ({ active: item.peer !== 'a', ownerDeviceId: 'owner' }));
    const invalidate = vi.fn();
    const stop = startProviderShareDelegationRechecks({ leases: () => [a, b, healthy], check, invalidate,
      random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0.99) });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.calls.map(([item]) => item.sessionId)).toEqual(['one', 'two']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenLastCalledWith(healthy);
    expect(invalidate).toHaveBeenCalledTimes(2);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never overlaps slow checks; disposal ignores their late rejection result', async () => {
    const pending = deferred();
    const check = vi.fn(() => pending.promise), invalidate = vi.fn();
    const stop = startProviderShareDelegationRechecks({ leases: () => [lease('a', 'one'), lease('b', 'two')],
      check, invalidate, random: () => 0 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(check).toHaveBeenCalledTimes(1);
    stop();
    pending.resolve({ active: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(invalidate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
