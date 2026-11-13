/**
 * 组所在电脑这一侧(provider-groups.md §4–§6)：同账号其他电脑来问该用哪台、报告冷却与运行中的任务；
 * 目录只给同账号电脑补组摘要。
 */
import { describe, expect, it, vi } from 'vitest';
import { encodeReliableFrames, MAX_FRAME_BYTES, MAX_TRANSPORT_MESSAGE_BYTES, PROVIDER_GROUP_REMOTE_CHANNEL, type Envelope } from '@cindy/device-link';

import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import type { ProviderView } from '@cindy/model-providers';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc';
import {
  normalizeProviderGroupConfig,
  parseProviderGroupRemoteRequest,
  parseProviderGroupRemoteView,
  parseProviderGroupRemoteSessionGroup,
  providerGroupUsageRowsForWire,
  PROVIDER_GROUP_REMOTE_MAX_USAGE_ROWS,
  PROVIDER_GROUP_REMOTE_MAX_USAGE_REPORT_ROWS,
  type ProviderGroupRemoteUsageRow,
} from '../../../shared/providerGroup';
import { createProviderGroupRemoteClient, PROVIDER_GROUP_USAGE_REQUEST_MAX_BYTES, ProviderGroupRemoteUnsupportedError, type ProviderGroupRemoteInvoke } from '../remoteClient';
import {
  createProviderGroupExternalLoad,
  PROVIDER_GROUP_LEASE_TTL_MS,
  PROVIDER_GROUP_PROVISIONAL_MS,
} from '../externalLoad';
import {
  decorateProviderListWithGroups,
  handleProviderGroupRemote,
  PROVIDER_GROUP_MAX_REMOTE_COOLDOWN_MS,
  PROVIDER_GROUP_USAGE_PART_TTL_MS,
  sharedProviderGroupSize,
  type ProviderGroupRemoteHandlerDeps,
} from '../remoteHandler';
import { createProviderGroupDirectory, type ProviderGroupDirectory } from '../directory';
import { readDeviceProviderCatalog } from '../../remote-agent/controller/deviceCatalog';
import { captureProviderMetadataContinuityScope, invokeProviderMetadataContinuity } from '../../device-link/providerMetadataContinuity';
import {
  createProviderGroupRouter,
  PROVIDER_GROUP_DEFAULT_COOLDOWN_MS,
  PROVIDER_GROUP_FAILURE_COOLDOWN_MS,
  type ProviderGroupPickInput,
  type ProviderGroupRouter,
} from '../router';
import { createGroupContinuityClient } from '../continuityClient';
import { createGroupContinuityExecutor } from '../continuityExecutor';

vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://fixture.invalid' }));

// Load only the five real SDK submodules this file's production chain uses. The SDK
// root index unconditionally assembles client/routedClient/direct runtime unrelated to
// these tests; this facade re-exports the real values and keeps wire encoding/reader real.
vi.mock('@cindy/device-link', async () => {
  const [protocol, transport, metadata, group, share] = await Promise.all([
    import('../../../../../../packages/device-link/src/protocol.js'),
    import('../../../../../../packages/device-link/src/transport.js'),
    import('../../../../../../packages/device-link/src/metadataContinuity.js'),
    import('../../../../../../packages/device-link/src/providerGroup.js'),
    import('../../../../../../packages/device-link/src/providerShareCatalog.js'),
  ]);
  return {
    CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2: protocol.CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2,
    MAX_FRAME_BYTES: protocol.MAX_FRAME_BYTES,
    MAX_TRANSPORT_MESSAGE_BYTES: transport.MAX_TRANSPORT_MESSAGE_BYTES,
    MetadataContinuityReader: metadata.MetadataContinuityReader,
    PROVIDER_GROUP_REMOTE_CHANNEL: group.PROVIDER_GROUP_REMOTE_CHANNEL,
    PROVIDER_METADATA_TRUST_MS: metadata.PROVIDER_METADATA_TRUST_MS,
    PROVIDER_RUNNING_TURNS_FIELD: group.PROVIDER_RUNNING_TURNS_FIELD,
    encodeReliableFrames: transport.encodeReliableFrames,
    isProviderAccessDeniedError: metadata.isProviderAccessDeniedError,
    isScopedPeer: protocol.isScopedPeer,
    readProviderMetadataContinuity: metadata.readProviderMetadataContinuity,
    readProviderRunningTurns: group.readProviderRunningTurns,
    readProviderShareGuestRunning: share.readProviderShareGuestRunning,
    scrubSharedProvider: share.scrubSharedProvider,
  };
});

const MINI: ProviderGroupMember = {
  key: 'device:mini:anthropic-1a2b3c4d',
  kind: 'device',
  agentDeviceId: 'mini',
  providerId: 'anthropic-1a2b3c4d',
  label: 'Mini',
  limit: 4,
  weight: 1,
  paused: false,
};
const CONFIG: ProviderGroupConfig = {
  strategy: 'least',
  autoSwitch: true,
  members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false }, MINI],
};

function deps(overrides: Partial<ProviderGroupRemoteHandlerDeps> = {}) {
  let now = 10_000;
  let ownerCurrent = true;
  const externalLoad = createProviderGroupExternalLoad({ now: () => now });
  const router = {
    pick: vi.fn(async (input: ProviderGroupPickInput) => {
      input.onPicked?.(MINI.key);
      return { kind: 'member' as const, member: MINI, label: 'Mini', resolved: [] };
    }),
    view: vi.fn(async () => ({ providerId: 'anthropic', config: CONFIG, members: [] })),
    running: vi.fn(() => 0),
    markCooling: vi.fn(),
    coolingUntil: vi.fn(() => null),
    markTried: vi.fn(() => new Set<string>()),
    triedThisTurn: vi.fn(() => new Set<string>()),
    resetTurn: vi.fn(),
    rebalanceCandidates: vi.fn(() => []),
  } satisfies ProviderGroupRouter;
  const value = {
    scope: () => ({ router, externalLoad, isCurrent: () => ownerCurrent }),
    readGroup: (id: string) => (id === 'anthropic' ? CONFIG : null),
    isRemoteAllowed: () => true,
    now: () => now,
    replaceReportedUsage: vi.fn(),
    sessionGroup: vi.fn(async () => null),
    ...overrides,
  } satisfies ProviderGroupRemoteHandlerDeps;
  return {
    ...value,
    router,
    externalLoad,
    advance: (ms: number) => { now += ms; },
    switchAccount: () => { ownerCurrent = false; },
  };
}

const PICK = { action: 'pick', sessionId: 's1', providerId: 'anthropic', agentKind: 'claude-code', model: 'opus', exclude: ['local'] };

describe('provider-group:remote', () => {
  // Unit/protocol, §6.2：手机/远控写任务所在电脑；未装配与坏请求不可伪报成功。
  it('saves a task balancing preference on its host and rejects invalid requests', async () => {
    const rebalancePreference = vi.fn(async () => true);
    const d = deps({ rebalancePreference });
    const request = { action: 'rebalance-preference', sessionId: 's1', enabled: false };
    expect(await handleProviderGroupRemote(d, 'laptop', request)).toEqual({ ok: true });
    expect(rebalancePreference).toHaveBeenCalledWith('s1', false);
    expect(await handleProviderGroupRemote(deps(), 'laptop', request)).toEqual({ ok: false });
    await expect(handleProviderGroupRemote(d, 'laptop', { ...request, enabled: 'false' })).rejects.toThrow('invalid enabled');
  });
  it('prepares continuity only after the original Fast binding and preserves a legacy pick without an optional acknowledgement', async () => {
    const order: string[] = [];
    const d = deps({ bindFastPolicy: async () => { order.push('fast'); }, prepareContinuity: async () => {
      order.push('prepare'); return { id: 'grant', remainingMs: 1000, config: CONFIG };
    } });
    const request = { action: 'pick', providerId: 'anthropic', sessionId: 'task', agentKind: 'claude-code', model: 'model' };
    expect(await handleProviderGroupRemote(d, 'C', request)).toMatchObject({ kind: 'member', continuity: { id: 'grant' } });
    expect(order).toEqual(['fast', 'prepare']);
    d.prepareContinuity = async () => { throw new Error('[INVALID_PARAMS] legacy endpoint'); };
    const legacy = await handleProviderGroupRemote(d, 'C', request);
    expect(legacy).toMatchObject({ kind: 'member' });
    expect(legacy).not.toHaveProperty('continuity');
  });
  it('does not return a prepared route if the group was edited while its optional acknowledgement was pending', async () => {
    let config: ProviderGroupConfig = CONFIG;
    let finish!: () => void;
    const d = deps({ readGroup: () => config, prepareContinuity: async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { id: 'grant', remainingMs: 1000, config: CONFIG };
    } });
    const pending = handleProviderGroupRemote(d, 'C', { action: 'pick', providerId: 'anthropic', sessionId: 'task', agentKind: 'claude-code', model: 'model' });
    await Promise.resolve(); await Promise.resolve();
    config = { ...CONFIG, autoSwitch: !CONFIG.autoSwitch }; finish();
    expect(await pending).toEqual({ kind: 'unavailable' });
  });
  it('tries another member when the selected executor cannot acknowledge a prohibited Fast policy', async () => {
    const bind = vi.fn().mockRejectedValueOnce(Error('[REMOTE_AGENT_PEER_TOO_OLD] update')).mockResolvedValue(undefined);
    const d = deps({ bindFastPolicy: bind });
    d.router.pick.mockResolvedValueOnce({ kind: 'member', member: MINI, label: 'Mini', resolved: [] })
      .mockResolvedValueOnce({ kind: 'member', member: CONFIG.members[0], label: 'Local', resolved: [] });
    expect(await handleProviderGroupRemote(d, 'laptop', { ...PICK, exclude: [] })).toMatchObject({ kind: 'member', member: { key: 'local' } });
    expect(d.router.pick.mock.calls[1][0].exclude?.has(MINI.key)).toBe(true);
    expect(bind).toHaveBeenLastCalledWith({ group: 'anthropic', deviceId: null, sessionId: 's1', controllerDeviceId: 'laptop' });
  });
  // Unit/protocol: old owners ignored the final rebalance constraints. Verify the real wire and acknowledgement.
  it('requires the owner to acknowledge the rebalance constraint before accepting its pick', async () => {
    const d = deps();
    let legacy = false;
    const client = createProviderGroupRemoteClient(async (_device, _channel, args) => {
      const result = await handleProviderGroupRemote(d, 'laptop', args[0]);
      if (legacy && result && typeof result === 'object') delete (result as { quotaRebalance?: unknown }).quotaRebalance;
      return { ok: true, result };
    });
    const input = { ...PICK, agentKind: 'claude-code' as const, quotaRebalance: 'local' };
    expect(await client.pick('mini', input)).toMatchObject({ kind: 'member', member: { key: MINI.key } });
    expect(d.router.pick).toHaveBeenLastCalledWith(expect.objectContaining({ quotaRebalance: 'local' }));
    legacy = true;
    expect(await client.pick('mini', input)).toEqual({ kind: 'none' });
    expect(await client.pick('mini', { ...PICK, agentKind: 'claude-code' })).toMatchObject({ kind: 'member' });
  });

  it('carries the confirmed message id to the task host', async () => {
    const rebalanceDecision = vi.fn(async () => true);
    const d = deps({ rebalanceDecision });
    await handleProviderGroupRemote(d, 'laptop', { action: 'rebalance-decision', sessionId: 's1', memberKey: MINI.key, remember: false, clientId: 'message-a' });
    expect(rebalanceDecision).toHaveBeenCalledWith('s1', MINI.key, false, 'message-a');
  });

  // Unit protocol regression: the real host/client used to discard the reset at both boundaries.
  it.each([null, 5_000_000])('preserves verified quota exhaustion across computers (reset=%s)', async (resetAtMs) => {
    const d = deps();
    d.router.pick.mockResolvedValueOnce({ kind: 'unavailable', resolved: [], usageLimit: { resetAtMs } } as never);
    const client = createProviderGroupRemoteClient(async (_device, _channel, args) => ({
      ok: true, result: await handleProviderGroupRemote(d, 'laptop', args[0]),
    }));
    expect(await client.pick('mini', { ...PICK, agentKind: 'claude-code' })).toEqual({ kind: 'unavailable', usageLimit: { resetAtMs } });
  });

  it('stamps a group view with the host first-hop budget', async () => {
    const view = await handleProviderGroupRemote(deps(), 'laptop', { action: 'view', providerId: 'anthropic' });
    expect(view).toMatchObject({ providerContinuity: { stale: false, remainingMs: 30 * 60_000 } });
  });

  it.each([
    { stale: true, remainingMs: 60_000 },
    { stale: false, remainingMs: 45_000 },
  ])('inherits the directory source budget (stale=$stale) instead of renewing it', async (source) => {
    const target = 'device-mini';
    const provider = {
      id: 'openai', name: 'OpenAI', agents: ['codex'], connected: true, remoteInvocationEnabled: true,
      models: { codex: [] }, routing: { codex: {} },
    } as unknown as ProviderView;
    const config = normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true,
      members: [{ kind: 'device', agentDeviceId: target, providerId: 'openai' }] }, 'openai')!;
    const device: DeviceLinkDeviceView = {
      deviceId: target, name: 'Mini', platform: 'darwin', appVersion: '1.0.0', lastSeenAt: null,
      online: true, busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false,
    };
    const invoke = async (deviceId: string, channel: string, args: unknown[]) => {
      if (deviceId !== target || channel !== 'maker:provider:list') throw new Error('unexpected invoke');
      return invokeProviderMetadataContinuity(deviceId, channel, args, async () => ({
        ok: true, result: { providers: [provider], providerContinuity: source },
      }));
    };
    const now = 1_000;
    const directory = createProviderGroupDirectory({
      listLocalProviders: async () => [], localDeviceName: () => 'O', listDevices: async () => [device],
      readDeviceProviders: async () => { throw new Error('array reader should not be used'); },
      readDeviceProviderCatalog: (id, options) => readDeviceProviderCatalog(
        invoke as Parameters<typeof readDeviceProviderCatalog>[0], id, { groupMember: true, ...options }),
      listReceivedShares: () => [], isMobilePlatform: () => false, now: () => now, mono: () => 0,
    });
    const router = createProviderGroupRouter({ directory, readGroup: () => config, listBindings: () => ({}),
      isTurnRunning: () => false, now: () => now, random: () => 0 });
    const externalLoad = createProviderGroupExternalLoad({ now: () => now });
    const handler = await handleProviderGroupRemote({
      scope: () => ({ router, externalLoad, isCurrent: () => true }),
      readGroup: () => config, isRemoteAllowed: () => true, now: () => now,
      replaceReportedUsage: vi.fn(), sessionGroup: async () => null,
    }, 'C', { action: 'view', providerId: 'openai' });
    const client = createProviderGroupRemoteClient(async () => ({ ok: true, result: handler }));
    const view = await client.view('owner', 'openai');
    expect(view.providerContinuity).toMatchObject({ stale: source.stale });
    expect(view.providerContinuity!.remainingMs).toBeGreaterThan(0);
    expect(view.providerContinuity!.remainingMs).toBeLessThanOrEqual(source.remainingMs);
    expect(view.providerContinuity!.remainingMs).toBeLessThan(30 * 60_000);
  });
  it('carries the optional detail request across the same-account client and host without probing on ordinary reads', async () => {
    const d = deps();
    const invoke = vi.fn<ProviderGroupRemoteInvoke>(async (_device, _channel, args) => ({
      ok: true, result: await handleProviderGroupRemote(d, 'laptop', args[0]),
    }));
    const client = createProviderGroupRemoteClient(invoke);
    await client.view('mini', 'anthropic', { includeGuestSupport: true });
    expect(d.router.view).toHaveBeenLastCalledWith('anthropic', { includeGuestSupport: true });
    await client.view('mini', 'anthropic');
    expect(d.router.view).toHaveBeenLastCalledWith('anthropic', { includeGuestSupport: false });
  });

  // Unit/protocol: a bridge/Pi pre-send read must reach the owner with its harness to select WHAM.
  // Legacy model-only reads remain valid; invalid harness values cannot become quota selectors.
  it('carries the optional quota harness through the real client/parser/host path', async () => {
    const d = deps();
    const client = createProviderGroupRemoteClient(async (_device, _channel, args) => ({
      ok: true, result: await handleProviderGroupRemote(d, 'laptop', args[0]),
    }));
    await client.view('mini', 'anthropic', { model: 'gpt-5.3-codex', agentKind: 'pi' });
    expect(d.router.view).toHaveBeenLastCalledWith('anthropic', { model: 'gpt-5.3-codex', agentKind: 'pi', includeGuestSupport: false });
    expect(() => parseProviderGroupRemoteRequest({ action: 'view', providerId: 'openai', agentKind: 'unknown' }))
      .toThrow();
  });

  it('only requests compatibility diagnostics when asked and discards a late reply after switching accounts', async () => {
    const d = deps();
    await handleProviderGroupRemote(d, 'laptop', { action: 'view', providerId: 'anthropic' });
    expect(d.router.view).toHaveBeenLastCalledWith('anthropic', { includeGuestSupport: false });
    d.router.view.mockImplementationOnce(async () => {
      d.switchAccount();
      return { providerId: 'anthropic', config: CONFIG, members: [] };
    });
    expect(await handleProviderGroupRemote(d, 'laptop', { action: 'view', providerId: 'anthropic', includeGuestSupport: true }))
      .toEqual({ providerId: 'anthropic', config: null, members: [] });
    expect(d.router.view).toHaveBeenLastCalledWith('anthropic', { includeGuestSupport: true });
  });

  it('does not let a remote request claim the local-task preference', async () => {
    const d = deps();
    await handleProviderGroupRemote(d, 'laptop', { ...PICK, localTask: true });
    expect(d.router.pick.mock.calls[0][0].localTask).toBeUndefined();
  });

  it('picks a computer, honouring what the caller already tried, and holds it briefly', async () => {
    const d = deps();
    const result = await handleProviderGroupRemote(d, 'laptop', PICK);
    expect(d.router.pick).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'anthropic', agentKind: 'claude-code', model: 'opus', exclude: new Set(['local']),
    }));
    expect(result).toEqual({
      kind: 'member',
      member: { key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d' },
      label: 'Mini',
    });
    expect(d.externalLoad.running('anthropic', MINI.key)).toBe(1);
    d.advance(PROVIDER_GROUP_PROVISIONAL_MS + 1);
    expect(d.externalLoad.running('anthropic', MINI.key)).toBe(0);
  });

  it('reads the latest state when a computer asks again after trying some', async () => {
    const d = deps();
    await handleProviderGroupRemote(d, 'laptop', { ...PICK, exclude: [] });
    expect(d.router.pick.mock.calls[0][0].fresh).toBeUndefined();
    await handleProviderGroupRemote(d, 'laptop', PICK);
    expect(d.router.pick.mock.calls[1][0]).toMatchObject({ fresh: true });
  });

  it('answers that there is no group for providers without one or no longer open to other computers', async () => {
    expect(await handleProviderGroupRemote(deps(), 'laptop', { ...PICK, providerId: 'openai' })).toEqual({ kind: 'none' });
    expect(await handleProviderGroupRemote(deps({ isRemoteAllowed: () => false }), 'laptop', PICK)).toEqual({ kind: 'none' });
  });

  it('reports that no computer can take the task', async () => {
    const d = deps();
    d.router.pick.mockResolvedValueOnce({ kind: 'unavailable', resolved: [] } as never);
    expect(await handleProviderGroupRemote(d, 'laptop', PICK)).toEqual({ kind: 'unavailable' });
  });

  it('passes the optional model through the remote state query', async () => {
    const d = deps();
    await handleProviderGroupRemote(d, 'laptop', { action: 'view', providerId: 'anthropic', model: 'opus' });
    expect(d.router.view).toHaveBeenCalledWith('anthropic', 'opus');
  });

  it('cools computers for usage limits up to a bounded reset time, and briefly for other causes', async () => {
    const d = deps();
    const client = createProviderGroupRemoteClient(async (_device, _channel, args) => ({
      ok: true, result: await handleProviderGroupRemote(d, 'laptop', args[0]),
    }));
    const input = { providerId: 'anthropic', memberKey: MINI.key, cause: 'usage-limit' as const, model: 'claude-fable-5' };
    await client.cool('owner', { ...input, resetAt: 50_000 });
    expect(d.router.markCooling).toHaveBeenLastCalledWith('anthropic', MINI.key, 50_000, input.model);
    await client.cool('owner', { ...input, resetAt: 10_000 + 365 * 86_400_000 });
    expect(d.router.markCooling).toHaveBeenLastCalledWith('anthropic', MINI.key, 10_000 + PROVIDER_GROUP_MAX_REMOTE_COOLDOWN_MS, input.model);
    await client.cool('owner', input);
    expect(d.router.markCooling).toHaveBeenLastCalledWith('anthropic', MINI.key, 10_000 + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS, input.model);
    await handleProviderGroupRemote(d, 'laptop', { action: 'cool', providerId: 'anthropic', memberKey: MINI.key, cause: 'usage-limit' });
    expect(d.router.markCooling).toHaveBeenLastCalledWith('anthropic', MINI.key, 10_000 + PROVIDER_GROUP_FAILURE_COOLDOWN_MS, undefined);
    await handleProviderGroupRemote(d, 'laptop', { action: 'cool', providerId: 'anthropic', memberKey: MINI.key, cause: 'auth' });
    expect(d.router.markCooling).toHaveBeenLastCalledWith('anthropic', MINI.key, 10_000 + PROVIDER_GROUP_FAILURE_COOLDOWN_MS, undefined);
  });

  it('only falls back to a short cooldown when an old owner rejects model-scoped reports', async () => {
    const invoke = vi.fn<ProviderGroupRemoteInvoke>()
      .mockResolvedValueOnce({ ok: false, error: { code: 'INVALID_PARAMS', message: 'unknown provider group action' } })
      .mockResolvedValueOnce({ ok: true, result: {} });
    const now = Date.now();
    await createProviderGroupRemoteClient(invoke).cool('owner', {
      providerId: 'anthropic', memberKey: MINI.key, cause: 'usage-limit', model: 'fable', resetAt: now + 86_400_000,
    });
    expect(invoke.mock.calls[0][2][0]).toMatchObject({ action: 'cool-model', model: 'fable' });
    const fallback = invoke.mock.calls[1][2][0] as { action: string; resetAt: number };
    expect(fallback.action).toBe('cool');
    expect(fallback.resetAt).toBeGreaterThanOrEqual(now);
    expect(fallback.resetAt).toBeLessThanOrEqual(Date.now() + PROVIDER_GROUP_FAILURE_COOLDOWN_MS);
    invoke.mockReset().mockResolvedValue({ ok: false, error: { message: 'offline' } });
    await expect(createProviderGroupRemoteClient(invoke).cool('owner', {
      providerId: 'anthropic', memberKey: MINI.key, cause: 'usage-limit', model: 'fable',
    })).rejects.toThrow('offline');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('refuses to cool computers outside the group and rejects causes it does not cool for', async () => {
    const d = deps();
    await handleProviderGroupRemote(d, 'laptop', { action: 'cool', providerId: 'anthropic', memberKey: 'device:x:y', cause: 'auth' });
    expect(d.router.markCooling).not.toHaveBeenCalled();
    await expect(handleProviderGroupRemote(d, 'laptop', { action: 'cool', providerId: 'anthropic', memberKey: MINI.key, cause: 'unavailable' }))
      .rejects.toThrow('[INVALID_PARAMS]');
  });

  it('counts the running tasks each computer reports and drops stale or out-of-order reports', async () => {
    const d = deps();
    const lease = { sessionId: 's1', providerId: 'anthropic', memberKey: MINI.key };
    await handleProviderGroupRemote(d, 'laptop', { action: 'leases', seq: 5, entries: [lease, { ...lease, sessionId: 's2' }] });
    await handleProviderGroupRemote(d, 'desktop', { action: 'leases', seq: 1, entries: [{ ...lease, sessionId: 's9' }] });
    expect(d.externalLoad.running('anthropic', MINI.key)).toBe(3);
    // 乱序到达的旧报告不能盖掉新的。
    await handleProviderGroupRemote(d, 'laptop', { action: 'leases', seq: 4, entries: [] });
    expect(d.externalLoad.running('anthropic', MINI.key)).toBe(3);
    await handleProviderGroupRemote(d, 'laptop', { action: 'leases', seq: 6, entries: [] });
    expect(d.externalLoad.running('anthropic', MINI.key)).toBe(1);
    d.advance(PROVIDER_GROUP_LEASE_TTL_MS + 1);
    expect(d.externalLoad.running('anthropic', MINI.key)).toBe(0);
  });

  it('keeps the usage other computers report through its groups, except what ran here or out of order', async () => {
    const replaceReportedUsage = vi.fn();
    const d = deps({ replaceReportedUsage });
    // [day, providerId, memberKey, kind, model, turns, input, output, cacheRead, cacheCreate, costUsd, lastAt]
    const row = (providerId: string, memberKey: string) => ['2026-10-11', providerId, memberKey, 'claude-code', 'opus', 2, 30, 4, 0, 0, 0, 9_000];
    await handleProviderGroupRemote(d, 'laptop', {
      action: 'usage',
      seq: 7,
      sinceDay: '2026-10-10',
      // 分到本机这台的本机自己记过；此刻没有组的供应商照收(组删了又建时历史不丢)。
      rows: [row('anthropic', MINI.key), row('anthropic', 'local'), row('openai', 'device:x:openai')],
    });
    expect(replaceReportedUsage).toHaveBeenCalledTimes(1);
    expect(replaceReportedUsage).toHaveBeenCalledWith('laptop', '2026-10-10', [
      {
        day: '2026-10-11', providerId: 'anthropic', memberKey: MINI.key, kind: 'claude-code', model: 'opus',
        turns: 2, inputTokens: 30, outputTokens: 4, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0, lastAt: 9_000,
      },
      expect.objectContaining({ providerId: 'openai', memberKey: 'device:x:openai' }),
    ]);
    // 乱序到达的旧报告丢弃；换了账号之后的也不收。
    await handleProviderGroupRemote(d, 'laptop', { action: 'usage', seq: 6, sinceDay: null, rows: [] });
    expect(replaceReportedUsage).toHaveBeenCalledTimes(1);
    d.switchAccount();
    await handleProviderGroupRemote(d, 'laptop', { action: 'usage', seq: 8, sinceDay: null, rows: [] });
    expect(replaceReportedUsage).toHaveBeenCalledTimes(1);
    await expect(handleProviderGroupRemote(d, 'laptop', { action: 'usage', seq: 9, sinceDay: null, rows: [['bad']] }))
      .rejects.toThrow('[INVALID_PARAMS]');
  });

  it('does not double count a picked task once it is reported', async () => {
    const d = deps();
    await handleProviderGroupRemote(d, 'laptop', PICK);
    await handleProviderGroupRemote(d, 'laptop', { action: 'leases', seq: 1, entries: [{ sessionId: 's1', providerId: 'anthropic', memberKey: MINI.key }] });
    expect(d.externalLoad.running('anthropic', MINI.key)).toBe(1);
  });

  it('spreads requests that arrive together instead of sending them all to the same computer', async () => {
    const now = 10_000;
    const externalLoad = createProviderGroupExternalLoad({ now: () => now });
    const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [MINI, { ...MINI, key: 'device:studio:anthropic', agentDeviceId: 'studio', providerId: 'anthropic', label: 'Studio' }] };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const directory: ProviderGroupDirectory = {
      // 两个请求都在等目录时，读负载与选电脑要在目录回来后的同一步里完成。
      resolveMembers: async (_providerId, cfg) => {
        await gate;
        return cfg.members.map((m) => ({
          member: m,
          label: m.label ?? m.key,
          state: 'ok' as const,
          view: {
            id: m.providerId,
            name: m.providerId,
            agents: ['claude-code'],
            connected: true,
            models: { 'claude-code': [{ id: 'opus', name: 'opus', efforts: [], defaultEffort: null }] },
            routing: { 'claude-code': {} },
          } as never,
        }));
      },
      listCandidates: async () => [],
      readDeviceCatalog: async () => [],
      probe: async () => 'ok' as const,
      memberLabel: (m) => m.label ?? m.key,
      invalidate: vi.fn(),
    };
    const router = createProviderGroupRouter({
      directory,
      readGroup: () => config,
      listBindings: () => ({}),
      isTurnRunning: () => false,
      externalRunning: (p, m) => externalLoad.running(p, m),
      now: () => now,
      random: () => 0,
    });
    const d = {
      scope: () => ({ router, externalLoad, isCurrent: () => true }),
      readGroup: () => config,
      isRemoteAllowed: () => true,
      now: () => now,
      replaceReportedUsage: vi.fn(),
      sessionGroup: async () => null,
    } satisfies ProviderGroupRemoteHandlerDeps;
    const first = handleProviderGroupRemote(d, 'laptop', { ...PICK, exclude: [] });
    const second = handleProviderGroupRemote(d, 'desktop', { ...PICK, sessionId: 's2', exclude: [] });
    release();
    const picked = (await Promise.all([first, second])).map((r) => (r as { member?: { key: string } }).member?.key);
    expect(new Set(picked).size).toBe(2);
  });

  it('answers which group a task on this computer belongs to, read-only', async () => {
    const sessionGroup = vi.fn(async (sessionId: string) =>
      (sessionId === 's1' ? { groupDeviceId: 'studio', providerId: 'anthropic' } : null));
    const d = deps({ sessionGroup });
    expect(await handleProviderGroupRemote(d, 'phone', { action: 'session-group', sessionId: 's1' }))
      .toEqual({ group: { groupDeviceId: 'studio', providerId: 'anthropic' } });
    expect(await handleProviderGroupRemote(d, 'phone', { action: 'session-group', sessionId: 's2' }))
      .toEqual({ group: null });
    // 只读：不碰分配器与负载，也不看这台有没有组。
    expect(d.router.pick).not.toHaveBeenCalled();
    expect(d.router.markCooling).not.toHaveBeenCalled();
    await expect(handleProviderGroupRemote(d, 'phone', { action: 'session-group', sessionId: '../x' }))
      .rejects.toThrow('[INVALID_PARAMS]');
    // 问的一方读回包：格式不对一律按没归组。
    expect(parseProviderGroupRemoteSessionGroup({ group: { groupDeviceId: null, providerId: 'anthropic' } }))
      .toEqual({ groupDeviceId: null, providerId: 'anthropic' });
    expect(parseProviderGroupRemoteSessionGroup({ group: { providerId: 'anthropic' } }))
      .toEqual({ groupDeviceId: null, providerId: 'anthropic' });
    for (const bad of [null, {}, { group: null }, { group: { groupDeviceId: 'share:x', providerId: 'a' } },
      { group: { groupDeviceId: 'studio', providerId: '../a' } }, { group: { groupDeviceId: 3, providerId: 'a' } }]) {
      expect(parseProviderGroupRemoteSessionGroup(bad)).toBeNull();
    }
  });

  it('drops a pick when the account changed while it waited for the directory', async () => {
    const d = deps();
    d.router.pick.mockImplementationOnce(async (input: ProviderGroupPickInput) => {
      d.switchAccount();
      input.onPicked?.(MINI.key);
      return { kind: 'member' as const, member: MINI, label: 'Mini', resolved: [] };
    });
    expect(await handleProviderGroupRemote(d, 'laptop', PICK)).toEqual({ kind: 'none' });
  });

  it('rejects malformed requests', async () => {
    for (const raw of [null, { action: 'nope' }, { ...PICK, agentKind: 'x' }, { ...PICK, sessionId: '../x' }, { action: 'leases', seq: -1, entries: [] }]) {
      await expect(handleProviderGroupRemote(deps(), 'laptop', raw)).rejects.toThrow('[INVALID_PARAMS]');
    }
  });
});

describe('完整用量报告分批传输', () => {
  const usageRow = (i: number): ProviderGroupRemoteUsageRow => ({
    day: i === 0 ? '2026-10-10' : '2026-10-11', providerId: 'anthropic', memberKey: MINI.key,
    kind: 'claude-code', model: `model-${i}`, turns: 1, inputTokens: i + 1, outputTokens: 1,
    cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0, lastAt: 1,
  });
  const rows = Array.from({ length: PROVIDER_GROUP_REMOTE_MAX_USAGE_ROWS + 2 }, (_, i) => usageRow(i));
  const part = (seq: number, offset: number, sinceDay: string | null = null) => ({
    action: 'usage-part', seq, sinceDay, offset, total: rows.length,
    rows: providerGroupUsageRowsForWire(rows.slice(offset, offset + PROVIDER_GROUP_REMOTE_MAX_USAGE_ROWS)),
  });

  it('单日超过 3000 行时每帧仍受上限约束，收齐前保留旧记录，最后完整替换一次', async () => {
    let received = [usageRow(9000)];
    const replace = vi.fn<ProviderGroupRemoteHandlerDeps['replaceReportedUsage']>((_controller, _sinceDay, incoming) => { received = incoming; });
    const d = deps({ replaceReportedUsage: replace });
    const invoke = vi.fn<ProviderGroupRemoteInvoke>(async (_device, _channel, args) => {
      const request = args[0] as { rows: unknown[]; offset: number };
      expect(request.rows.length).toBeLessThanOrEqual(PROVIDER_GROUP_REMOTE_MAX_USAGE_ROWS);
      if (request.offset > 0) {
        expect(replace).not.toHaveBeenCalled();
        expect(received).toEqual([usageRow(9000)]);
      }
      return { ok: true, result: await handleProviderGroupRemote(d, 'laptop', request) };
    });
    await createProviderGroupRemoteClient(invoke).usage('mini', { seq: 1, sinceDay: null, rows });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(received).toEqual(rows);
    // 完成后的旧份重送不再次记账。
    expect(await handleProviderGroupRemote(d, 'laptop', part(1, 0))).toMatchObject({ committed: true });
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('中途断开不改旧账本，新序号从头重报可完整恢复', async () => {
    const d = deps();
    let failLastPart = true;
    const client = createProviderGroupRemoteClient(async (_device, _channel, args) => {
      if (failLastPart && (args[0] as { offset: number }).offset > 0) throw new Error('offline');
      return { ok: true, result: await handleProviderGroupRemote(d, 'laptop', args[0]) };
    });
    await expect(client.usage('mini', { seq: 1, sinceDay: null, rows })).rejects.toThrow('offline');
    expect(d.replaceReportedUsage).not.toHaveBeenCalled();
    failLastPart = false;
    await client.usage('mini', { seq: 2, sinceDay: null, rows });
    expect(d.replaceReportedUsage).toHaveBeenCalledWith('laptop', null, rows);
  });

  it.each([
    { count: 2000, modelPrefix: '\u0000'.repeat(504), label: '行数未超限但转义后超限' },
    { count: PROVIDER_GROUP_REMOTE_MAX_USAGE_ROWS + 2, modelPrefix: '模'.repeat(504), label: 'UTF-8 多字节长字段' },
  ])('$label 按字节切批，真实传输帧合法，收齐后完整替换一次', async ({ count, modelPrefix }) => {
    const longRows = Array.from({ length: count }, (_, i) => ({
      ...usageRow(i), day: '2026-10-11', providerId: 'p'.repeat(128),
      memberKey: `device:${'d'.repeat(164)}:${'p'.repeat(128)}`,
      model: modelPrefix + String(i).padStart(8, '0'),
    }));
    const d = deps();
    let received = 0;
    const invoke = vi.fn<ProviderGroupRemoteInvoke>(async (_device, channel, args) => {
      const request = args[0] as { action: string; offset: number; rows: unknown[] };
      expect(request.action).toBe('usage-part');
      expect(request.offset).toBe(received);
      expect(request.rows.length).toBeLessThanOrEqual(PROVIDER_GROUP_REMOTE_MAX_USAGE_ROWS);
      expect(Buffer.byteLength(JSON.stringify(request), 'utf8')).toBeLessThanOrEqual(PROVIDER_GROUP_USAGE_REQUEST_MAX_BYTES);
      const env: Envelope = { v: 1, kind: 'invoke', dst: 'mini', id: 'request-id', payload: { channel, args } };
      expect(channel).toBe(PROVIDER_GROUP_REMOTE_CHANNEL);
      expect(Buffer.byteLength(JSON.stringify(env.payload), 'utf8')).toBeLessThan(MAX_TRANSPORT_MESSAGE_BYTES);
      expect(Buffer.byteLength(JSON.stringify(env), 'utf8')).toBeLessThan(MAX_FRAME_BYTES);
      for (const frame of encodeReliableFrames(env, 'usage-test', received + 1)) {
        expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeLessThan(MAX_FRAME_BYTES);
      }
      expect(d.replaceReportedUsage).not.toHaveBeenCalled();
      received += request.rows.length;
      return { ok: true, result: await handleProviderGroupRemote(d, 'laptop', request) };
    });
    await createProviderGroupRemoteClient(invoke).usage('mini', { seq: 1, sinceDay: '2026-10-10', rows: longRows });
    expect(invoke.mock.calls.length).toBeGreaterThan(1);
    expect(received).toBe(count);
    expect(d.replaceReportedUsage).toHaveBeenCalledTimes(1);
    expect(d.replaceReportedUsage).toHaveBeenCalledWith('laptop', '2026-10-10', longRows);
  });

  it('旧端拒绝新动作，发送方按不支持处理，不回退到部分替换', async () => {
    const invoke = vi.fn<ProviderGroupRemoteInvoke>(async () => ({ ok: false, error: { message: '[INVALID_PARAMS] unknown provider group action' } }));
    await expect(createProviderGroupRemoteClient(invoke).usage('mini', { seq: 1, sinceDay: null, rows }))
      .rejects.toBeInstanceOf(ProviderGroupRemoteUnsupportedError);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![2][0]).toMatchObject({ action: 'usage-part' });
  });

  it('小报告继续使用旧端可识别的 usage 动作', async () => {
    const invoke = vi.fn<ProviderGroupRemoteInvoke>(async (_device, _channel, args) => {
      expect(args[0]).toMatchObject({ action: 'usage', sinceDay: '2026-10-11' });
      return { ok: true, result: {} };
    });
    await createProviderGroupRemoteClient(invoke).usage('mini', { seq: 1, sinceDay: '2026-10-11', rows: [usageRow(1)] });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('缺批、乱序、改起始日及超限参数都不更新账本', async () => {
    const d = deps();
    await expect(handleProviderGroupRemote(d, 'laptop', part(1, 3000))).rejects.toThrow('PRECONDITION_FAILED');
    await handleProviderGroupRemote(d, 'laptop', part(1, 0));
    await expect(handleProviderGroupRemote(d, 'laptop', part(1, 3000, '2026-10-11'))).rejects.toThrow('PRECONDITION_FAILED');
    for (const invalid of [
      { ...part(1, 0), total: PROVIDER_GROUP_REMOTE_MAX_USAGE_REPORT_ROWS + 1 },
      { ...part(1, 0), offset: -1 },
      { ...part(1, 0), offset: 0.5 },
      { ...part(1, 0), rows: [] },
      { ...part(1, 0), rows: providerGroupUsageRowsForWire(rows) },
    ]) expect(() => parseProviderGroupRemoteRequest(invalid)).toThrow('INVALID_PARAMS');
    expect(d.replaceReportedUsage).not.toHaveBeenCalled();
  });

  it('暂存过期或接收端重启后不能用尾批覆盖整份，要求重新开始', async () => {
    const d = deps();
    await handleProviderGroupRemote(d, 'laptop', part(1, 0));
    d.advance(PROVIDER_GROUP_USAGE_PART_TTL_MS);
    await expect(handleProviderGroupRemote(d, 'laptop', part(1, 3000))).rejects.toThrow('PRECONDITION_FAILED');
    const restarted = deps();
    await expect(handleProviderGroupRemote(restarted, 'laptop', part(1, 3000))).rejects.toThrow('PRECONDITION_FAILED');
    expect(d.replaceReportedUsage).not.toHaveBeenCalled();
    expect(restarted.replaceReportedUsage).not.toHaveBeenCalled();
  });

  it('两台报告电脑的暂存独立，新的整份报告使旧分批报告作废', async () => {
    const d = deps();
    await handleProviderGroupRemote(d, 'laptop', part(1, 0));
    await handleProviderGroupRemote(d, 'phone-controller', part(1, 0));
    await handleProviderGroupRemote(d, 'phone-controller', part(1, 3000));
    expect(d.replaceReportedUsage).toHaveBeenCalledWith('phone-controller', null, rows);
    await handleProviderGroupRemote(d, 'laptop', { action: 'usage', seq: 2, sinceDay: null, rows: [] });
    await handleProviderGroupRemote(d, 'laptop', part(1, 3000));
    expect(d.replaceReportedUsage).toHaveBeenCalledTimes(2);
    expect(d.replaceReportedUsage).toHaveBeenLastCalledWith('laptop', null, []);
  });

  it('换账号或账号已失效时不继续发送、不提交旧账号的暂存', async () => {
    const d = deps();
    let current = true;
    const invoke = vi.fn<ProviderGroupRemoteInvoke>(async (_device, _channel, args) => {
      const result = await handleProviderGroupRemote(d, 'laptop', args[0]);
      current = false;
      return { ok: true, result };
    });
    await expect(createProviderGroupRemoteClient(invoke).usage('mini', { seq: 1, sinceDay: null, rows }, () => {
      if (!current) throw new Error('account changed');
    })).rejects.toThrow('account changed');
    expect(invoke).toHaveBeenCalledTimes(1);
    d.switchAccount();
    await handleProviderGroupRemote(d, 'laptop', part(1, 3000));
    expect(d.replaceReportedUsage).not.toHaveBeenCalled();
    // 新账号是另一份 scope，不会承接旧账号首批。
    await expect(handleProviderGroupRemote(deps(), 'laptop', part(1, 3000))).rejects.toThrow('PRECONDITION_FAILED');
  });

  it('接收端没有确认收齐时，发送方不会假报成功', async () => {
    const client = createProviderGroupRemoteClient(async () => ({ ok: true, result: {} }));
    await expect(client.usage('mini', { seq: 1, sinceDay: null, rows })).rejects.toThrow('PRECONDITION_FAILED');
  });

  it('每批账号复验传到 invoke 的真实发送边界，等待建链期间换账号保留旧账本', async () => {
    const d = deps();
    let current = true;
    const invoke = vi.fn<ProviderGroupRemoteInvoke>(async (_device, _channel, args, options) => {
      // 模拟实际后台 invoke 在发送前的异步建链/排队；调用入口的检查此时已经通过。
      await Promise.resolve();
      current = false;
      options?.preSend?.();
      return { ok: true, result: await handleProviderGroupRemote(d, 'laptop', args[0]) };
    });
    await expect(createProviderGroupRemoteClient(invoke).usage('mini', { seq: 1, sinceDay: null, rows }, () => {
      if (!current) throw new Error('account changed before dispatch');
    })).rejects.toThrow('account changed before dispatch');
    expect(d.replaceReportedUsage).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('账本替换抛错不记已提交序号，同一个尾批可以重试', async () => {
    const d = deps();
    await handleProviderGroupRemote(d, 'laptop', part(1, 0));
    vi.mocked(d.replaceReportedUsage).mockImplementationOnce(() => { throw new Error('store failure'); });
    await expect(handleProviderGroupRemote(d, 'laptop', part(1, 3000))).rejects.toThrow('store failure');
    await expect(handleProviderGroupRemote(d, 'laptop', part(1, 3000))).resolves.toMatchObject({ committed: true });
    expect(d.replaceReportedUsage).toHaveBeenLastCalledWith('laptop', null, rows);
  });
});

describe('decorateProviderListWithGroups', () => {
  it('adds group summaries even when remote use is closed, while keeping running counts restricted', () => {
    const result = decorateProviderListWithGroups({
      providers: [
        { id: 'anthropic', remoteInvocationEnabled: true },
        { id: 'openai', remoteInvocationEnabled: true, group: { forged: true } },
        { id: 'anthropic', remoteInvocationEnabled: false },
      ],
      other: 1,
    }, (id) => (id === 'anthropic' ? CONFIG : null)) as { providers: Array<Record<string, unknown>>; other: number };
    expect(result.other).toBe(1);
    expect(result.providers[0].group).toEqual({
      strategy: 'least',
      autoSwitch: true,
      members: [
        { key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', paused: false },
        { key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mini', paused: false },
      ],
    });
    // 只有本机设置能产生组摘要；关闭远程调用的组仍需保留管理入口。
    expect(result.providers[1]).not.toHaveProperty('group');
    expect(result.providers[2].group).toEqual(result.providers[0].group);
  });

  it('leaves the sharer’s computer name out of shared members', () => {
    const shared: ProviderGroupMember = {
      key: 'share:s1:anthropic', kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic',
      label: "Magi's Mac Mini", limit: 4, weight: 1, paused: false,
    };
    const result = decorateProviderListWithGroups(
      { providers: [{ id: 'anthropic', remoteInvocationEnabled: true }] },
      () => ({ ...CONFIG, members: [...CONFIG.members, shared] }),
    ) as { providers: Array<{ group: { members: Array<Record<string, unknown>> } }> };
    expect(result.providers[0].group.members[2]).toEqual({
      key: shared.key, kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic', paused: false,
    });
    expect(JSON.stringify(result)).not.toContain('Mac Mini');
  });

  it('adds this computer’s running count to every provider open for remote use', () => {
    const providers = [
      { id: 'anthropic', remoteInvocationEnabled: true },
      { id: 'openai', remoteInvocationEnabled: true, runningTurns: 9 },
      { id: 'deepseek', remoteInvocationEnabled: false, runningTurns: 9 },
    ];
    const result = decorateProviderListWithGroups(
      { providers },
      () => null,
      new Map([['anthropic', 3], ['deepseek', 1]]),
    ) as { providers: Array<Record<string, unknown>> };
    // 没在跑的为 0；结果里原有的值不认；没开放的不带。
    expect(result.providers.map((p) => p.runningTurns ?? null)).toEqual([3, 0, null]);
    // 读不到运行数时都不带，组所在电脑照旧只算经组的。
    const unknown = decorateProviderListWithGroups({ providers }, () => null) as { providers: Array<Record<string, unknown>> };
    expect(unknown.providers.every((p) => !('runningTurns' in p))).toBe(true);
  });
});

describe('sharedProviderGroupSize', () => {
  it('gives guests only the number of computers, and only while the provider stays open', () => {
    const readGroup = (id: string) => (id === 'anthropic' ? CONFIG : null);
    expect(sharedProviderGroupSize({ readGroup, isRemoteAllowed: () => true }, 'anthropic')).toBe(2);
    expect(sharedProviderGroupSize({ readGroup, isRemoteAllowed: () => true }, 'openai')).toBeNull();
    expect(sharedProviderGroupSize({ readGroup, isRemoteAllowed: () => false }, 'anthropic')).toBeNull();
  });

  it('counts computers, not accounts: several accounts on one computer are one computer for guests', () => {
    const share = (id: string, providerId: string): ProviderGroupMember => ({
      key: `share:${id}:${providerId}`, kind: 'share', agentDeviceId: `share:${id}`, providerId,
      hostDeviceId: 'kai-pc', limit: 4, weight: 1, paused: false,
    });
    const config: ProviderGroupConfig = {
      ...CONFIG,
      members: [
        ...CONFIG.members,
        { ...MINI, key: 'device:mini:anthropic-b', providerId: 'anthropic-b' },
        share('s1', 'anthropic'),
        share('s2', 'anthropic-x'),
      ],
    };
    // 本机 + Mini(两个账号) + Kai 的那台(两个分享) = 3 台。
    expect(sharedProviderGroupSize({ readGroup: () => config, isRemoteAllowed: () => true }, 'anthropic')).toBe(3);
  });
});


describe('O1 directory budget expiry stays resource-local', () => {
  function o1Provider(): ProviderView {
    return { id: 'openai', name: 'OpenAI', agents: ['codex'], connected: true,
      remoteInvocationEnabled: true, models: { codex: [] }, routing: { codex: {} } } as unknown as ProviderView;
  }

  function o1Member(agentDeviceId: string) {
    return { key: 'device:' + agentDeviceId + ':openai', kind: 'device' as const,
      agentDeviceId, providerId: 'openai' };
  }

  function o1Config(...ids: string[]): ProviderGroupConfig {
    return normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true, allowFast: false,
      members: ids.map(id => ({ kind: 'device', agentDeviceId: id, providerId: 'openai' })) }, 'openai')!;
  }

  function o1Device(agentDeviceId: string): DeviceLinkDeviceView {
    return { deviceId: agentDeviceId, name: agentDeviceId, platform: 'darwin', appVersion: '1.0.0',
      lastSeenAt: null, online: true, busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false };
  }

  function o1Directory(a: string, b: string, config: ProviderGroupConfig) {
    const clock = { wall: 0, mono: 0 };
    const now = () => clock.wall;
    const mono = () => clock.mono;
    const reads = new Map<string, number>();
    const transport = vi.fn(async (deviceId: string, channel: string) => {
      if (channel !== 'maker:provider:list') throw new Error('unexpected channel ' + channel);
      reads.set(deviceId, (reads.get(deviceId) ?? 0) + 1);
      const remainingMs = deviceId === a ? 1_000 : 2_000;
      return { ok: true as const, result: { providers: [o1Provider()],
        providerContinuity: { stale: false, remainingMs } } };
    });
    const directoryInvoke = (deviceId: string, channel: string, args: unknown[]) =>
      invokeProviderMetadataContinuity(deviceId, channel, args, () => transport(deviceId, channel), () => true);
    const directory = createProviderGroupDirectory({
      listLocalProviders: async () => [], localDeviceName: () => 'O', localAppVersion: () => '1.0.0',
      listDevices: async () => [o1Device(a), o1Device(b)],
      readDeviceProviders: async () => { throw new Error('array reader should not be used'); },
      readDeviceProviderCatalog: (agentDeviceId, options) => readDeviceProviderCatalog(
        directoryInvoke, agentDeviceId, { groupMember: true, ...options }),
      listReceivedShares: () => [], isMobilePlatform: () => false, now, mono,
    });
    const router = createProviderGroupRouter({ directory, readGroup: () => config,
      listBindings: () => ({}), isTurnRunning: () => false, now, random: () => 0 });
    const externalLoad = createProviderGroupExternalLoad({ now });
    const view = async () => handleProviderGroupRemote({ scope: () => ({ router, externalLoad, isCurrent: () => true }),
      readGroup: () => config, isRemoteAllowed: () => true, now,
      replaceReportedUsage: () => undefined, sessionGroup: async () => null }, 'C', { action: 'view', providerId: 'openai' });
    return { clock, reads, directory, view };
  }

  async function o1Client(owner: string, executor: string, config: ProviderGroupConfig) {
    const grant = { id: 'grant-' + executor, group: 'openai', controller: 'C', providerId: 'openai',
      agentKind: 'codex' as const, model: 'model', fastPolicyRequired: false, remainingMs: 1_500 };
    const m = createGroupContinuityExecutor({
      capture: (origin, controller) => {
        const o = captureProviderMetadataContinuityScope(origin);
        const c = captureProviderMetadataContinuityScope(controller);
        return () => o() && c();
      },
      inspect: async () => ({ running: 0, fastPolicyRequired: false }),
      bindFast: async () => undefined, wall: () => 0, mono: () => 0,
    });
    const ack = await m.handle(owner, { action: 'continuity-prepare', grant });
    if (!('remainingMs' in ack)) throw new Error('fixture prepare did not ack');
    let ownerMayRespond = true;
    let ownerOnline = true;
    const inspectAdmit = vi.fn<ProviderGroupRemoteInvoke>(async (_deviceId, channel, args, options) => {
      options?.preSend?.();
      if (channel !== PROVIDER_GROUP_REMOTE_CHANNEL) throw new Error('unexpected channel');
      return { ok: true, result: await m.handle('C', args[0]) };
    });
    const pick = createGroupContinuityClient({
      livePick: async () => {
        if (!ownerOnline) throw Object.assign(new Error('[NOT_CONNECTED] owner offline'), { code: 'NOT_CONNECTED' });
        return { kind: 'member', member: o1Member(executor), label: executor,
          continuity: { id: ack.id, remainingMs: ack.remainingMs, config } };
      },
      invoke: inspectAdmit,
      capture: (ownerDeviceId, executorDeviceId) => {
        const ownerScope = captureProviderMetadataContinuityScope(ownerDeviceId);
        const executorScope = executorDeviceId ? captureProviderMetadataContinuityScope(executorDeviceId) : () => false;
        return () => ownerScope() && executorScope();
      },
      scopeKey: () => 'o1-scope:' + owner,
      ownerMayRespond: () => ownerMayRespond,
      retryable: error => (error as { code?: string }).code === 'NOT_CONNECTED',
      wall: () => 0, mono: () => 0,
    });
    const input = { providerId: 'openai', agentKind: 'codex' as const, model: 'model', exclude: [] as string[] };
    return { pick, inspectAdmit, config, owner, executor, grant,
      setOwnerMayRespond: (value: boolean) => { ownerMayRespond = value; },
      setOwnerOnline: (value: boolean) => { ownerOnline = value; },
      task: (sessionId: string) => pick.pick(owner, { ...input, sessionId, allowOffline: true }) };
  }

  function o1PositiveBudget(entry: { providerContinuity?: { stale?: boolean; remainingMs?: number } } | undefined) {
    return entry?.providerContinuity?.stale === false && (entry.providerContinuity.remainingMs ?? 0) > 900;
  }

  it('expires A without invalidating O or the healthy B ACK and offline fallback', async () => {
    const A = 'o1-a', B = 'o1-b', O = 'o1-o', D = 'o1-d';
    const config = o1Config(A, B);
    const f = o1Directory(A, B, config);
    await f.directory.resolveMembers('openai', config);
    const first = await f.directory.resolveMembers('openai', config);
    expect(f.reads.get(A)).toBe(1); expect(f.reads.get(B)).toBe(1);
    expect(o1PositiveBudget(first.find(x => x.member.agentDeviceId === A))).toBe(true);
    expect(o1PositiveBudget(first.find(x => x.member.agentDeviceId === B))).toBe(true);

    f.clock.wall = 1_001; f.clock.mono = 1_001;
    const second = await f.directory.resolveMembers('openai', config);
    expect(f.reads.get(A)).toBe(1); expect(f.reads.get(B)).toBe(1);
    expect(second.find(x => x.member.agentDeviceId === A)?.providerContinuity)
      .toMatchObject({ stale: true, remainingMs: 0 });
    expect(o1PositiveBudget(second.find(x => x.member.agentDeviceId === B))).toBe(true);

    const view = parseProviderGroupRemoteView(await f.view(), 'openai');
    expect(view.providerContinuity).toEqual({ stale: true, remainingMs: 0 });
    const oScope = captureProviderMetadataContinuityScope(O);
    const bScope = captureProviderMetadataContinuityScope(B);
    const dScope = captureProviderMetadataContinuityScope(D);
    expect(oScope()).toBe(true); expect(bScope()).toBe(true); expect(dScope()).toBe(true);

    const c = await o1Client(O, B, config);
    await c.task('ack');
    expect(c.pick.readConfig(O, 'openai')).toEqual(config);
    c.setOwnerMayRespond(false); c.setOwnerOnline(false);
    await expect(c.task('fallback-before')).resolves.toMatchObject({ kind: 'member', member: { agentDeviceId: B } });
    const before = c.inspectAdmit.mock.calls.length;

    await expect(invokeProviderMetadataContinuity(O, PROVIDER_GROUP_REMOTE_CHANNEL,
      [{ action: 'view', providerId: 'openai' }], async () => ({ ok: true, result: view })))
      .rejects.toThrow('MODEL_VISIBILITY_NOT_READY');
    expect(oScope()).toBe(true);
    expect(bScope()).toBe(true); expect(dScope()).toBe(true);
    expect(c.pick.readConfig(O, 'openai')).toEqual(config);
    await expect(c.task('fallback-after')).resolves.toMatchObject({ kind: 'member', member: { agentDeviceId: B } });
    expect(c.inspectAdmit.mock.calls.length).toBe(before + 2);
  });

  it('still fences O and its ACK for an explicit permission denial, leaving neighbours independent', async () => {
    const B = 'o1-b2', O = 'o1-o2', D = 'o1-d2';
    const config = o1Config(B);
    const c = await o1Client(O, B, config);
    await c.task('ack');
    const oScope = captureProviderMetadataContinuityScope(O);
    const bScope = captureProviderMetadataContinuityScope(B);
    const dScope = captureProviderMetadataContinuityScope(D);
    expect(oScope()).toBe(true); expect(bScope()).toBe(true); expect(dScope()).toBe(true);
    await expect(invokeProviderMetadataContinuity(O, PROVIDER_GROUP_REMOTE_CHANNEL,
      [{ action: 'view', providerId: 'openai' }], async () => ({ ok: false,
        error: { code: 'ACCESS_REVOKED', message: 'revoked' } })))
      .resolves.toMatchObject({ ok: false, error: { code: 'ACCESS_REVOKED' } });
    expect(oScope()).toBe(false);
    expect(bScope()).toBe(true); expect(dScope()).toBe(true);
    expect(c.pick.readConfig(O, 'openai')).toBeNull();
  });
});
