import { describe, expect, it } from 'vitest';
import {
  canCoalesceRemoteListing,
  isControllerCoalescibleListingChannel,
  isPeerResetRetryableReadChannel,
  isCompletedInvokeRetryableReadChannel,
  normalizeRemoteListingArgsKey,
  resolveRemoteInvokeTimeoutMs,
  TASK_MIGRATION_CHANNEL,
  resolveInvokePriority,
} from '../index.js';

describe('remote invoke policy boundaries', () => {
  // Group display hints cannot alter task/permission RPC priority or retry safety.
  it('demotes only explicit group display reads without changing live routing and mutation semantics', () => {
    for (const request of [
      { action: 'view', display: 'roster' }, { action: 'view', display: { memberKey: 'member', details: true } },
      { action: 'manage-share', command: { action: 'quota-account' } },
    ]) {
      expect(resolveInvokePriority('provider-group:remote', undefined, [request])).toBe('background');
      expect(canCoalesceRemoteListing({ channel: 'provider-group:remote', args: [request] })).toBe(false);
    }
    for (const request of [
      { action: 'view' }, { action: 'pick', display: 'roster' }, { action: 'leases' },
      { action: 'manage-share', command: { action: 'set-visibility' } },
    ]) expect(resolveInvokePriority('provider-group:remote', undefined, [request])).toBe('foreground');
    expect(isPeerResetRetryableReadChannel('provider-share:insights:v1')).toBe(false);
  });

  it.each(['desktop', 'mobile'] as const)('allows a repository clone to finish on %s without replaying project creation', (platform) => {
    const channel = 'sidebar-settings:set-project-info';
    expect(resolveRemoteInvokeTimeoutMs(channel, [{ create: true, repositoryUrl: 'https://gitlab.com/a/b' }], platform)).toBe(360_000);
    expect(resolveRemoteInvokeTimeoutMs(channel, [{ create: true }], platform)).toBeUndefined();
    expect(resolveRemoteInvokeTimeoutMs(channel, [{ repositoryUrl: 'https://gitlab.com/a/b' }], platform)).toBeUndefined();
    expect(isPeerResetRetryableReadChannel(channel)).toBe(false);
    expect(isCompletedInvokeRetryableReadChannel(channel)).toBe(false);
  });
  it.each(['desktop', 'mobile'] as const)('budgets MCP App loading on %s without replaying any operation', (platform) => {
    const channel = 'maker:mcp-apps:v1';
    expect(resolveRemoteInvokeTimeoutMs(channel, ['task', { op: 'open' }], platform)).toBe(120_000);
    for (const op of ['poll', 'message', 'cancel-open', 'teardown'])
      expect(resolveRemoteInvokeTimeoutMs(channel, ['task', { op }], platform)).toBeUndefined();
    expect(isPeerResetRetryableReadChannel(channel)).toBe(false);
    expect(isCompletedInvokeRetryableReadChannel(channel)).toBe(false);
    expect(canCoalesceRemoteListing({ channel, args: ['task', { op: 'open' }] })).toBe(false);
  });
  it('keeps mobile history recovery within the fork budget without retrying writes', () => {
    const channel = 'maker:fork-strip-encrypted';
    expect(resolveRemoteInvokeTimeoutMs(channel, ['source'], 'mobile')).toBe(30_000);
    expect(resolveRemoteInvokeTimeoutMs(channel, ['source'], 'desktop')).toBeUndefined();
    expect(resolveRemoteInvokeTimeoutMs('maker:list-active', [], 'mobile')).toBeUndefined();
    expect(isPeerResetRetryableReadChannel(channel)).toBe(false);
    expect(isCompletedInvokeRetryableReadChannel(channel)).toBe(false);
    expect(canCoalesceRemoteListing({ channel, args: ['source'] })).toBe(false);
  });

  it.each(['desktop', 'mobile'] as const)('waits for group sends only on %s without replaying writes', (platform) => {
    const channel = 'maker:remote-resources:invoke';
    expect(resolveRemoteInvokeTimeoutMs(channel, [{ collectionId: 'bot-groups', actionId: 'send' }], platform)).toBe(180_000);
    expect(resolveRemoteInvokeTimeoutMs(channel, [{ collectionId: 'bot-groups', actionId: 'update' }], platform)).not.toBe(180_000);
    expect(resolveRemoteInvokeTimeoutMs(channel, [{ collectionId: 'teammates', actionId: 'send' }], platform)).not.toBe(180_000);
    expect(isPeerResetRetryableReadChannel(channel)).toBe(false);
    expect(isCompletedInvokeRetryableReadChannel(channel)).toBe(false);
  });

  it('gives predictions the host budget on both controllers without automatic link retries', () => {
    expect(resolveRemoteInvokeTimeoutMs('maker:predict-prompt', [], 'mobile')).toBe(45_000);
    expect(resolveRemoteInvokeTimeoutMs('maker:predict-prompt', [], 'desktop')).toBe(45_000);
    expect(isPeerResetRetryableReadChannel('maker:predict-prompt')).toBe(false);
    expect(isCompletedInvokeRetryableReadChannel('maker:predict-prompt')).toBe(false);
  });

  // 2026-11-18: two Codex create-session calls took 41.6s/42.4s on the host and both
  // controllers gave up at 30s while the host was still creating the task.
  it('waits for a slow agent start on both controllers instead of timing out at 30s', () => {
    expect(resolveRemoteInvokeTimeoutMs('maker:create-session', [{}], 'desktop')).toBe(120_000);
    expect(resolveRemoteInvokeTimeoutMs('maker:create-session', [{}], 'mobile')).toBe(120_000);
    expect(isPeerResetRetryableReadChannel('maker:create-session')).toBe(false);
  });
  it.each(['local-db:sessions:list', 'local-db:sessions:get', 'local-db:sessions:get-many', 'local-db:sessions:interrupted-pending', 'maker:list-active'])(
    'explicitly permits retrying completed %s reads', (channel) => {
      expect(isCompletedInvokeRetryableReadChannel(channel)).toBe(true);
    },
  );

  it.each([
    'maker:remote-resources:list', 'maker:remote-resources:get',
    'local-db:bots:list', 'local-db:bots:get',
    'maker:send', 'maker:input:enqueue',
    'maker:get-capabilities', 'maker:provider:list', 'maker:git-safety:get',
    'maker:schedule:list-sidebar-index-runs', 'unknown:list', undefined,
  ])('does not infer completed retry safety for %s from listing, peer-reset or background classification', (channel) => {
    expect(isCompletedInvokeRetryableReadChannel(channel)).toBe(false);
  });

  it('allows retrying a read without sharing a snapshot from before a write', () => {
    expect(isPeerResetRetryableReadChannel('local-db:sessions:get')).toBe(true);
    expect(isPeerResetRetryableReadChannel('local-db:sessions:get-many')).toBe(true);
    expect(canCoalesceRemoteListing({ channel: 'local-db:sessions:get-many', args: [['id']] })).toBe(false);
    expect(canCoalesceRemoteListing({ channel: 'local-db:sessions:get', args: ['id'] })).toBe(false);
    expect(isPeerResetRetryableReadChannel('local-db:sessions:list')).toBe(true);
    expect(canCoalesceRemoteListing({ channel: 'local-db:sessions:list', args: [] })).toBe(true);
    expect(canCoalesceRemoteListing({ channel: 'local-db:sessions:list', args: [null, null, { fresh: true }] })).toBe(false);
  });

  it.each(['maker:send', 'maker:create-session', 'maker:schedule:mark-run-read', 'unknown:read'])(
    'does not infer retry or coalescing permission from %s', (channel) => {
      expect(isPeerResetRetryableReadChannel(channel)).toBe(false);
      expect(canCoalesceRemoteListing({ channel, args: [] })).toBe(false);
    },
  );

  it('preserves schedule index coalescing without enabling peer-reset retries', () => {
    const channel = 'maker:schedule:list-sidebar-index-runs';
    expect(canCoalesceRemoteListing({ channel, args: [] })).toBe(true);
    expect(isPeerResetRetryableReadChannel(channel)).toBe(false);
  });

  it('keeps mobile execution budgets and desktop defaults separate', () => {
    expect(resolveRemoteInvokeTimeoutMs('maker:send', [], 'mobile')).toBe(30_000);
    expect(resolveRemoteInvokeTimeoutMs('maker:send', [], 'desktop')).toBeUndefined();
    expect(resolveRemoteInvokeTimeoutMs('maker:schedule:list', [], 'mobile')).toBe(40_000);
    expect(resolveRemoteInvokeTimeoutMs('device-link:remote-desktop:v1', [{ op: 'heartbeat' }], 'mobile')).toBe(5_000);
    expect(resolveRemoteInvokeTimeoutMs('device-link:remote-desktop:v1', [{ op: 'heartbeat' }], 'desktop')).toBe(59_000);
    expect(resolveRemoteInvokeTimeoutMs('unknown:read', [], 'mobile')).toBeUndefined();
  });
  it('gives the read-only task copy estimate a longer budget than other copy requests', () => {
    const budget = (action: string) =>
      resolveRemoteInvokeTimeoutMs(TASK_MIGRATION_CHANNEL, [{ action, sessionId: 's' }], 'desktop');
    expect(budget('estimate')).toBe(3 * 60_000);
    expect(budget('receive')).toBe(30 * 60_000);
    expect(budget('status')).toBe(30_000);
    expect(budget('caps')).toBe(30_000);
  });

  // 测试价值
  // - 生产入口与可观察结果：normalizeRemoteListingArgsKey / isControllerCoalescibleListingChannel / resolveMaxControllerInvokeWaitMs。
  //   同义默认参数合并为同一键、fresh 标记单独提取而不拆裂缓存键，不同 limit / status / includePinned / tagCatalog / 未知选项严格隔离。
  // - Bug／规则依据：64 帧可靠窗口积压事故（6 条重复 sessions:list 大结果占 1385 KiB）；protocol-compatibility.md 与参数语义隔离。
  // - 现有覆盖缺口：旧测试只测布尔 canCoalesceRemoteListing，未覆盖参数规范化、wire 编码位隔离与跨平台最大等待上限。
  // - 最小失败输入：等价默认参数 [20,'all',{includePinned:false}] vs []，以及仅差 includePinned / status / limit / tagCatalog 的参数对。
  // - tier：unit（纯函数表驱动，<5ms）。
  it('normalizes equivalent session listing args while isolating distinct filters and wire flags', () => {
    expect(isControllerCoalescibleListingChannel('local-db:sessions:list')).toBe(true);
    expect(isControllerCoalescibleListingChannel('maker:schedule:list-sidebar-index-runs')).toBe(true);
    expect(isControllerCoalescibleListingChannel('maker:provider:list')).toBe(false);

    const base = normalizeRemoteListingArgsKey('local-db:sessions:list', []);
    expect(base).toEqual({ key: 'local-db:sessions:list\u0000[20,"all",false]', fresh: false });
    expect(normalizeRemoteListingArgsKey('local-db:sessions:list', [20, 'all', { includePinned: false }])).toEqual(base);
    expect(normalizeRemoteListingArgsKey('local-db:sessions:list', [null, null, { tagCatalog: 1 }])).toEqual(base);
    expect(normalizeRemoteListingArgsKey('local-db:sessions:list', [20, 'all', { fresh: true }])).toEqual({
      key: base!.key,
      fresh: true,
    });

    const withWire = normalizeRemoteListingArgsKey(
      'local-db:sessions:list',
      [20, 'all', { tagCatalog: 1, fresh: true }],
      { preserveWireEncodingFlags: true },
    );
    const withWireNonFresh = normalizeRemoteListingArgsKey(
      'local-db:sessions:list',
      [undefined, undefined, { tagCatalog: 1 }],
      { preserveWireEncodingFlags: true },
    );
    expect(withWire).toEqual({ key: withWireNonFresh!.key, fresh: true });
    expect(withWire!.key).not.toBe(base!.key);

    const distinctCases: unknown[][] = [
      [50, 'all', { includePinned: false }],
      [20, 'active', { includePinned: false }],
      [20, 'archived', { includePinned: false }],
      [20, 'all', { includePinned: true }],
      [20, 'all', { includePinned: false, workdir: '/repo-a' }],
    ];
    const keys = new Set(distinctCases.map((args) => normalizeRemoteListingArgsKey('local-db:sessions:list', args)?.key));
    expect(keys.size).toBe(distinctCases.length);
    expect(keys.has(base!.key)).toBe(false);
  });
});
