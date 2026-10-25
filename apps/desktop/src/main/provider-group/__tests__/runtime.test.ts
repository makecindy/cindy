/**
 * 运行期单例按账号隔离：换账号后冷却、目录缓存不沿用上一个账号的。
 */
import type { ProviderView } from '@cindy/model-providers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeProviderGroupConfig, type ProviderGroupConfig } from '../../../shared/providerGroup.js';
import { PROVIDER_GROUP_PICK_QUICK_MS } from '../router.js';
import { PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS, providerGroupMemberUsageState } from '../usage.js';

let owner = 'owner-a';
const io = vi.hoisted(() => ({
  local: vi.fn(async () => [] as ProviderView[]),
  devices: vi.fn(),
  catalog: vi.fn(),
  invoke: vi.fn(),
  group: vi.fn(() => null as ProviderGroupConfig | null),
}));

vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => owner }));
vi.mock('../../device-link/providerShareGuest.js', () => ({ getReceivedShares: vi.fn(() => []) }));
vi.mock('../../device-link/ipc.js', () => ({ handleListDevices: io.devices, defaultDeps: vi.fn() }));
vi.mock('../../device-link/index.js', () => ({ remoteBackgroundInvoke: io.invoke }));
vi.mock('../../device-link/controllerPlatform.js', () => ({ isMobilePlatform: () => false }));
vi.mock('../../device-link/deviceName.js', () => ({ deviceName: () => 'This computer' }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: io.local }),
}));
vi.mock('../../remote-agent/controller/deviceCatalog.js', () => ({ readDeviceProviderViews: io.catalog }));
vi.mock('../bindings.js', () => ({ listProviderGroupBindings: () => ({}) }));
vi.mock('../store.js', () => ({ readProviderGroup: io.group }));
vi.mock('../coolingStore.js', () => ({ readProviderGroupCooling: () => ({}), writeProviderGroupCooling: vi.fn() }));

const { getProviderGroupDirectory, getProviderGroupOwnerScope, getProviderGroupRouter, setProviderGroupClaudeUsageReader, setProviderGroupCodexUsageReader } = await import('../runtime.js');

afterEach(() => { setProviderGroupClaudeUsageReader(null); setProviderGroupCodexUsageReader(null); io.group.mockReset(); vi.useRealTimers(); });

describe('provider group runtime', () => {
  it('keeps the affected model through the runtime facade', () => {
    owner = 'model-cooldown-owner';
    const router = getProviderGroupRouter();
    const until = Date.now() + 86_400_000;
    router.markCooling('anthropic', 'local', until, 'claude-fable-5');
    expect(router.coolingUntil('anthropic', 'local', 'fable')).toBe(until);
    expect(router.coolingUntil('anthropic', 'local', 'opus')).toBeNull();
    expect(router.coolingUntil('anthropic', 'local')).toBeNull();
  });
  it('does not return the previous owner’s details after an account change', async () => {
    owner = 'detail-owner';
    const scope = getProviderGroupOwnerScope();
    const read = vi.spyOn(scope.router, 'view').mockImplementationOnce(async (providerId) => {
      owner = 'next-detail-owner';
      return {
        providerId, config: { strategy: 'least', autoSwitch: true, members: [] },
        members: [{ key: 'local', kind: 'local', label: 'private', state: 'available', running: 0, limit: 4, weight: 1, paused: false }],
      };
    });
    expect(await getProviderGroupRouter().view('anthropic', { includeGuestSupport: true }))
      .toEqual({ providerId: 'anthropic', config: null, members: [] });
    read.mockRestore();
  });

  it('keeps cooling and round state per account behind stable handles', () => {
    const router = getProviderGroupRouter();
    expect(getProviderGroupRouter()).toBe(router);
    expect(getProviderGroupDirectory()).toBe(getProviderGroupDirectory());

    router.markCooling('anthropic', 'local', Date.now() + 60_000);
    router.markTried('s1', 'local');
    expect(router.coolingUntil('anthropic', 'local')).not.toBeNull();

    owner = 'owner-b';
    expect(router.coolingUntil('anthropic', 'local')).toBeNull();
    expect(router.triedThisTurn('s1').size).toBe(0);
  });

  it('keeps an assignment on the account it started with, even after switching accounts', () => {
    owner = 'owner-c';
    const scope = getProviderGroupOwnerScope();
    expect(scope.isCurrent()).toBe(true);
    owner = 'owner-d';
    expect(scope.isCurrent()).toBe(false);
    // 换账号之后才记上的占用落在 owner-c 那份里，owner-d 看不到。
    scope.externalLoad.recordPick('laptop', 's1', 'anthropic', 'local');
    expect(scope.externalLoad.running('anthropic', 'local')).toBe(1);
    expect(getProviderGroupOwnerScope().externalLoad.running('anthropic', 'local')).toBe(0);
  });
});

describe('provider group runtime quota account selection', () => {
  let sequence = 0;
  const usage = () => ({
    updatedAt: Date.now(), fiveHour: { utilization: 25, resetsAt: Date.now() / 1000 + 3600 },
    sevenDay: { utilization: 45, resetsAt: Date.now() / 1000 + 86400 },
  });

  function harness(providerId = 'anthropic-second', native = 'claude') {
    owner = `quota-owner-${++sequence}`;
    const localId = native === 'codex' ? 'openai-local' : 'anthropic-local';
    const provider = (id: string) => ({ id, connected: true, auth: { method: 'oauth', native } }) as ProviderView;
    io.local.mockResolvedValue([provider(localId)]);
    io.catalog.mockResolvedValue([provider(providerId)]);
    io.devices.mockResolvedValue({ devices: [{ deviceId: 'mini', name: 'mini', online: true,
      remoteControlEnabled: true, controlEnabled: true, isSelf: false, platform: 'darwin' }] });
    io.invoke.mockReset();
    const config = normalizeProviderGroupConfig({ members: [{ kind: 'local' },
      { kind: 'device', agentDeviceId: 'mini', providerId }] }, localId)!;
    const read = () => getProviderGroupDirectory().resolveMembers(localId, config);
    return { read, config, localId };
  }

  it('uses each member’s provider ID through the injected reader and existing same-account channel', async () => {
    const h = harness();
    const local = vi.fn(async () => usage());
    setProviderGroupClaudeUsageReader(local);
    io.invoke.mockResolvedValue({ ok: true, result: { ...usage(), providerId: 'anthropic-second' } });
    const resolved = await h.read();
    expect(local).toHaveBeenCalledExactlyOnceWith('anthropic-local');
    expect(io.invoke).toHaveBeenCalledExactlyOnceWith('mini', 'maker:usage:claude-subscription', ['anthropic-second'],
      { preSend: expect.any(Function) });
    expect(resolved.map((r) => r.claudeUsage?.sevenDay?.utilization)).toEqual([45, 45]);
  });

  it.each([
    ['anthropic-second', undefined, false],
    ['anthropic-second', 'anthropic', false],
    ['anthropic', undefined, true],
  ])('does not use an old peer’s default quota for %s (echo %s)', async (providerId, echoed, accepted) => {
    const h = harness(providerId);
    io.invoke.mockResolvedValue({ ok: true, result: { ...usage(), ...(echoed ? { providerId: echoed } : {}) } });
    const resolved = await h.read();
    expect(resolved[1].claudeUsage !== null).toBe(accepted);
  });

  it('guards the outgoing request and discards the reply when the owner account changes', async () => {
    const h = harness();
    let preSend!: () => void;
    io.invoke.mockImplementation(async (_device, _channel, _args, options) => {
      preSend = options.preSend;
      preSend();
      owner = 'next-owner';
      return { ok: true, result: { ...usage(), providerId: 'anthropic-second' } };
    });
    const resolved = await h.read();
    expect(resolved[1].claudeUsage).toBeNull();
    expect(() => preSend()).toThrow('provider group account changed');
  });

  // Unit: real runtime/directory reads must select each OpenAI connection, including legacy peers.
  // Claude's channel/echo cases cannot detect wrong arguments or accidental default-account reuse here.
  it.each([
    ['openai-second', 'openai-second', true], ['openai-second', undefined, false],
    ['openai-second', 'openai', false], ['openai', undefined, true],
  ])('reads OpenAI member accounts and rejects unscoped named-account replies (%s, %s)', async (id, echo, accepted) => {
    const h = harness(id, 'codex');
    const raw = { updatedAt: Date.now(), primary: { usedPercent: 30, windowMinutes: 300, resetsAt: Date.now() / 1000 + 3600 } };
    const local = vi.fn(async () => raw);
    const localLimits = vi.fn(async () => ({ rateLimits: raw }));
    setProviderGroupCodexUsageReader(local, localLimits);
    io.invoke.mockImplementation(async (_device, channel) => ({ ok: true, result: {
      ...(channel === 'maker:usage:codex-rate-limits' ? { rateLimits: raw } : raw),
      ...(echo ? { providerId: echo } : {}),
    } }));
    const resolved = await h.read();
    expect(local).toHaveBeenCalledExactlyOnceWith('openai-local');
    expect(localLimits).toHaveBeenCalledExactlyOnceWith('openai-local');
    expect(io.invoke).toHaveBeenCalledWith('mini', 'maker:usage:account', ['codex', id], { preSend: expect.any(Function) });
    expect(io.invoke).toHaveBeenCalledWith('mini', 'maker:usage:codex-rate-limits', [id], { preSend: expect.any(Function) });
    expect(resolved[0].codexUsage?.appServerBuckets?.__default__?.primary?.usedPercent).toBe(30);
    expect(resolved[1].codexUsage !== null).toBe(accepted);
    await h.read();
    expect(io.invoke).toHaveBeenCalledTimes(2);
    expect(local).toHaveBeenCalledTimes(1);
    expect(localLimits).toHaveBeenCalledTimes(1);
  });

  it('discards OpenAI replies and blocks outgoing requests after an owner change', async () => {
    const h = harness('openai-second', 'codex');
    let preSend!: () => void;
    io.invoke.mockImplementation(async (_device, _channel, _args, options) => {
      preSend = options.preSend;
      preSend();
      owner = 'next-openai-owner';
      return { ok: true, result: { providerId: 'openai-second', updatedAt: Date.now(), primary: { usedPercent: 100 } } };
    });
    expect((await h.read())[1].codexUsage).toBeNull();
    expect(() => preSend()).toThrow('provider group account changed');
  });

  it.each([true, false])('keeps the available OpenAI quota source when the other channel is unsupported (native=%s)', async (native) => {
    const h = harness('openai-second', 'codex');
    const raw = { updatedAt: Date.now(), primary: { usedPercent: 45 } };
    io.invoke.mockImplementation(async (_device, channel) => {
      if ((channel === 'maker:usage:codex-rate-limits') !== native) return { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED' } };
      return { ok: true, result: { providerId: 'openai-second', ...(native ? { rateLimits: raw } : raw) } };
    });
    const resolved = await h.read();
    expect(resolved[1].codexUsage?.appServerBuckets?.__default__?.primary?.usedPercent).toBe(45);
  });

  // Unit: real runtime/directory quota eligibility must retain a completed source after the other times out.
  // P1 regression: immediate unsupported-channel cases miss a fast exhausted quota plus a pending sibling read.
  // Minimal input: native or WHAM at 100%, the other source deferred beyond 1.5s; cover local and same-account peers.
  // Standalone runtime.test.ts: 1.51s Vitest / 3.21s command wall time (including quick-pick regressions below).
  it.each([true, false])('keeps completed OpenAI quota while the other source is pending and merges its late result (native=%s)', async (native) => {
    vi.useFakeTimers();
    const h = harness('openai-second', 'codex');
    const startedAt = Date.now();
    const quota = (usedPercent: number) => ({
      updatedAt: Date.now(), primary: { usedPercent, windowMinutes: 300, resetsAt: startedAt / 1000 + 3600 },
    });
    const completed = native ? { rateLimits: quota(100) } : { source: 'openai-web', ...quota(100) };
    let complete!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { complete = resolve; });
    const account = vi.fn(async () => native ? pending : completed);
    const limits = vi.fn(async () => native ? completed : pending);
    setProviderGroupCodexUsageReader(account, limits);
    io.invoke.mockImplementation(async (_device, channel) => ({ ok: true, result: {
      ...await (channel === 'maker:usage:codex-rate-limits' ? limits() : account()) as object,
      providerId: 'openai-second',
    } }));

    const fastKind = native ? 'codex' : 'pi';
    const slowKind = native ? 'pi' : 'codex';
    const firstRead = h.read();
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS);
    for (const member of await firstRead) {
      expect(providerGroupMemberUsageState(member, 'gpt-5.3-codex', Date.now(), fastKind))
        .toMatchObject({ limited: true, urgency: 0 });
      expect(providerGroupMemberUsageState(member, 'gpt-5.3-codex', Date.now(), slowKind).urgency).toBeNull();
    }
    const secondRead = h.read();
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS);
    for (const member of await secondRead) {
      expect(providerGroupMemberUsageState(member, 'gpt-5.3-codex', Date.now(), fastKind).limited).toBe(true);
    }
    expect(account).toHaveBeenCalledTimes(2);
    expect(limits).toHaveBeenCalledTimes(2);
    expect(io.invoke).toHaveBeenCalledTimes(2);

    const completedAt = Date.now();
    complete(native ? { source: 'openai-web', ...quota(25) } : { rateLimits: quota(25) });
    await vi.advanceTimersByTimeAsync(0);
    for (const member of await h.read()) {
      expect(providerGroupMemberUsageState(member, 'gpt-5.3-codex', Date.now(), fastKind).limited).toBe(true);
      expect(providerGroupMemberUsageState(member, 'gpt-5.3-codex', Date.now(), slowKind))
        .toMatchObject({ limited: false, urgency: expect.any(Number) });
      expect(member.codexUsage?.appServerBuckets?.__default__?.updatedAt).toBe(native ? startedAt : completedAt);
      expect(member.codexUsage?.webSnapshot?.updatedAt).toBe(native ? completedAt : startedAt);
    }
    expect(io.invoke).toHaveBeenCalledTimes(2);
    getProviderGroupDirectory().invalidate();
    await h.read();
    expect(io.invoke).toHaveBeenCalledTimes(4);
  });

  // Unit / PR #6562 P1: runtime → directory → router must retain quota at the outer quick-pick deadline.
  // Existing source-timeout cases start with an immediate catalog and never cross that deadline.
  // Minimal input: the first member's catalog takes 2s, one quota is 100%, its sibling never returns;
  // the second member is usable with unknown quota. Both source directions must pick the second at 3s.
  it.each([true, false])('avoids an exhausted member at the quick-pick deadline after a slow catalog (native=%s)', async (native) => {
    vi.useFakeTimers();
    const h = harness('openai-second', 'codex');
    const model = 'gpt-5.3-codex';
    const provider = (id: string) => ({
      id, connected: true, auth: { method: 'oauth', native: 'codex' }, agents: ['codex', 'pi'],
      models: Object.fromEntries(['codex', 'pi'].map((agent) => [agent,
        [{ id: model, name: model, efforts: [], defaultEffort: null }]])), routing: { codex: {}, pi: {} },
    }) as unknown as ProviderView;
    io.local.mockResolvedValue([provider(h.localId)]);
    io.catalog.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve([provider('openai-second')]), 2_000);
    }));
    h.config.strategy = 'order';
    h.config.members.reverse();
    io.group.mockReturnValue(h.config);
    setProviderGroupCodexUsageReader(async () => null, async () => null);
    const raw = { updatedAt: Date.now(), primary: {
      usedPercent: 100, windowMinutes: 300, resetsAt: Date.now() / 1000 + 3600,
    } };
    io.invoke.mockImplementation(async (_device, channel) => {
      if ((channel === 'maker:usage:codex-rate-limits') !== native) return new Promise(() => {});
      return { ok: true, result: { providerId: 'openai-second',
        ...(native ? { rateLimits: raw } : { source: 'openai-web', ...raw }) } };
    });
    const picked = getProviderGroupRouter().pick({ providerId: h.localId, model, agentKind: native ? 'codex' : 'pi' });
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_PICK_QUICK_MS);
    const result = await picked;
    expect(result).toMatchObject({ kind: 'member', member: { key: 'local' } });
    if (result.kind === 'member') {
      expect(providerGroupMemberUsageState(result.resolved[0], model, Date.now(), native ? 'codex' : 'pi'))
        .toMatchObject({ limited: true, urgency: 0 });
    }
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS);
  });

  it('discards completed OpenAI quota if the owner changes while its sibling source is pending', async () => {
    vi.useFakeTimers();
    const h = harness('openai-second', 'codex');
    const account = { source: 'openai-web', updatedAt: Date.now(), primary: { usedPercent: 100 } };
    let complete!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { complete = resolve; });
    setProviderGroupCodexUsageReader(async () => account, () => pending);
    io.invoke.mockImplementation(async (_device, channel) => ({ ok: true, result: {
      ...await (channel === 'maker:usage:account' ? account : pending) as object,
      providerId: 'openai-second',
    } }));
    const read = h.read();
    await vi.advanceTimersByTimeAsync(0);
    owner = 'owner-after-partial-openai-read';
    complete({ rateLimits: { primary: { usedPercent: 25 } } });
    for (const member of await read) expect(member.codexUsage).toBeNull();
  });
});
