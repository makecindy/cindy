/**
 * 组所在电脑这一侧(provider-groups.md §4–§6)：同账号其他电脑来问该用哪台、报告冷却与运行中的任务；
 * 目录只给同账号电脑补组摘要。
 */
import { describe, expect, it, vi } from 'vitest';
import { encodeReliableFrames, MAX_FRAME_BYTES, MAX_TRANSPORT_MESSAGE_BYTES, PROVIDER_GROUP_REMOTE_CHANNEL, type Envelope } from '@cindy/device-link';

import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import {
  parseProviderGroupRemoteRequest,
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
import type { ProviderGroupDirectory } from '../directory';
import {
  createProviderGroupRouter,
  PROVIDER_GROUP_DEFAULT_COOLDOWN_MS,
  PROVIDER_GROUP_FAILURE_COOLDOWN_MS,
  type ProviderGroupPickInput,
  type ProviderGroupRouter,
} from '../router';

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
