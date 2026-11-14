import { describe, expect, it, vi } from 'vitest';
import { readLiveSubscriptionActivity, confirmedLiveOpenaiProvider, createLiveSubscriptionAccountResolver } from '../liveActivity.js';
import { unleasedSubscriptionActivity } from '../activity.js';
import { reconcileLegacySubscriptionAccount } from '../reconcile.js';

// Unit regression: pre-pool reused roots never registered leases. Test real live-reader entry,
// excluding remote/API/closed roots and late location results; no rollout/credential scanning.
function root(id = 'old') {
  return { id, agentKind: 'codex', requestSessionId: 'native-' + id, remoteHostId: null as string | null,
    agentDeviceId: null as string | null, getStatus: () => 'active', isTurnRunning: () => true,
    hasBackgroundWork: () => false,
    listBackgroundTasks: () => [] as unknown[] };
}
describe('live subscription root provenance', () => {
  it('includes root background work but excludes remote, API and closed sessions before history lookup', async () => {
    const old = root(); old.isTurnRunning = () => false; old.hasBackgroundWork = () => true;
    const remote = root('remote'); remote.agentDeviceId = 'device';
    const ssh = root('ssh'); ssh.remoteHostId = 'ssh';
    const api = root('api'); const closed = root('closed'); closed.getStatus = () => 'closed';
    const lookup = vi.fn(async () => 'second');
    const result = await readLiveSubscriptionActivity({ roots: () => [old, remote, ssh, api, closed],
      usesOpenai: id => id !== 'api', accountForRoot: lookup });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject([{ sessionId: 'old', nativeId: 'native-old', provider: 'openai', accountId: 'second', running: true }]);
    const copy = { ...result[0], nativeId: 'stale-native' };
    expect(unleasedSubscriptionActivity([...result, copy, { ...result[0], sessionId: 'alias' }], () => false).get('openai:second')).toBe(1);
    expect(unleasedSubscriptionActivity(result, () => true).size).toBe(0);
    expect(unleasedSubscriptionActivity([...result, { ...result[0], sessionId: 'alias' }], id => id === 'old').size).toBe(0);
    old.hasBackgroundWork = () => false;
    expect(unleasedSubscriptionActivity(result, () => false).size).toBe(0);
  });
  it('does not infer an unknown account or publish a location lookup after native replacement', async () => {
    const old = root();
    expect(await readLiveSubscriptionActivity({ roots: () => [old], usesOpenai: () => true,
      accountForRoot: async () => undefined })).toEqual([]);
    const lookup = async () => { old.requestSessionId = 'replacement'; return 'default'; };
    expect(await readLiveSubscriptionActivity({ roots: () => [old], usesOpenai: () => true,
      accountForRoot: lookup })).toEqual([]);
  });
});

// Unit regression: pre-pool reuse lacked durable task/native provenance. Existing load tests
// do not test persistence or races. Minimal input is one proven history home with no bindings.
describe('legacy provenance reconciliation', () => {
  function fixture() {
    let owner = 'owner';
    let row = { nativeId: 'native', providerId: null as string | null, eligible: true };
    const bindings = new Map<string, string>();
    const deps = { owner: () => owner, read: async () => row, provider: () => 'openai',
      binding: (key: string) => bindings.get(key), account: vi.fn(async () => 'second' as string | undefined),
      available: () => true, normalize: vi.fn(async (providerId: string) => { row.providerId = providerId; }),
      record: vi.fn(async (_provider: string, account: string, native: string) => { bindings.set('task', account); bindings.set(native, account); }) };
    return { deps, bindings, setOwner: () => { owner = 'next-owner'; },
      changeNative: () => { row = { ...row, nativeId: 'new-native' }; } };
  }
  it('persists proven task and native ownership and remains idempotent after restart', async () => {
    const { deps, bindings } = fixture();
    await reconcileLegacySubscriptionAccount(deps);
    expect(bindings).toEqual(new Map([['task', 'second'], ['native', 'second']]));
    await reconcileLegacySubscriptionAccount({ ...deps });
    expect(deps.record).toHaveBeenCalledOnce();
    expect(deps.normalize).toHaveBeenCalledOnce();
    expect(deps.account).toHaveBeenCalledOnce();
  });
  it.each(['unknown', 'conflict', 'owner', 'native'] as const)('never guesses default or writes after %s provenance', async reason => {
    const { deps, bindings, setOwner, changeNative } = fixture();
    if (reason === 'unknown') deps.account.mockResolvedValue(undefined);
    if (reason === 'conflict') { bindings.set('task', 'default'); bindings.set('native', 'second'); }
    if (reason === 'owner') deps.account.mockImplementation(async () => { setOwner(); return 'second'; });
    if (reason === 'native') deps.account.mockImplementation(async () => { changeNative(); return 'second'; });
    const attempt = reconcileLegacySubscriptionAccount(deps);
    if (reason === 'unknown') await attempt; else await expect(attempt).rejects.toThrow();
    expect(deps.record).not.toHaveBeenCalled();
    expect(deps.normalize).not.toHaveBeenCalled();
  });
});

describe('implicit and unreadable live history', () => {
  it('uses actual OAuth host proof for a null provider and never treats an API host as subscription', () => {
    const kind = (id: string) => id === 'openai' ? 'openai' : undefined;
    expect(confirmedLiveOpenaiProvider(null, 'legacy-live', ['legacy-live'], kind)).toBe('openai');
    expect(confirmedLiveOpenaiProvider(null, 'api-host', ['legacy-live'], kind)).toBeUndefined();
    expect(confirmedLiveOpenaiProvider('api', 'legacy-live', ['legacy-live'], kind)).toBeUndefined();
  });
  it('omits one damaged index while preserving known roots, but rejects an owner transition', async () => {
    let owner = 'a'; const roots = [root('bad'), root('good')];
    const deps = { roots: () => roots, usesOpenai: () => true, owner: () => owner,
      accountForRoot: async (id: string) => { if (id === 'bad') throw new Error('ambiguous home'); return 'second'; } };
    expect((await readLiveSubscriptionActivity(deps)).map(x => x.accountId)).toEqual(['second']);
    deps.accountForRoot = async () => { owner = 'b'; throw new Error('owner changed'); };
    await expect(readLiveSubscriptionActivity(deps)).rejects.toThrow('owner changed');
  });
  it('shares immutable history provenance while reading current binding, load and placement each time', async () => {
    const history = vi.fn(async () => '/native/home'); let account = 'default'; let binding: string | undefined;
    const resolve = createLiveSubscriptionAccountResolver({ owner: () => 'owner', binding: () => binding,
      historyHome: history, accountForHome: () => account });
    const instance = {};
    expect(await Promise.all([resolve('old', 'native', instance), resolve('old', 'native', instance)])).toEqual(['default', 'default']);
    expect(history).toHaveBeenCalledOnce();
    account = 'moved';
    expect(await resolve('old', 'native', instance)).toBe('moved');
    binding = 'explicit';
    expect(await resolve('old', 'native', instance)).toBe('explicit');
    expect(history).toHaveBeenCalledOnce();
  });
});
