/**
 * claudeSubscriptionUsageRefresh —— CLI get_usage 余量 reader 的节流、失败退避与换号清理。
 */
import { describe, expect, it, vi } from 'vitest';

import type { ClaudeSubscriptionUsageSnapshot } from '../../../shared/claudeSubscriptionUsage.js';
import { createClaudeSubscriptionUsageReader } from '../claudeSubscriptionUsageRefresh.js';

const SNAPSHOT: ClaudeSubscriptionUsageSnapshot = {
  fiveHour: { utilization: 5, resetsAt: 1 },
  sevenDay: { utilization: 2, resetsAt: 2 },
  scoped: [],
  source: 'oauth-endpoint',
  updatedAt: 0,
};

function setup(options: { account?: string | null; cached?: ClaudeSubscriptionUsageSnapshot | null } = {}) {
  const state = {
    account: options.account === undefined ? 'acct-a' : options.account,
    cached: options.cached ?? null,
    now: 1_000_000,
  };
  const deps = {
    readAccount: vi.fn(() => state.account),
    fetchSnapshot: vi.fn(async (): Promise<ClaudeSubscriptionUsageSnapshot | 'empty'> => SNAPSHOT),
    recordSnapshot: vi.fn(async (snapshot: ClaudeSubscriptionUsageSnapshot) => {
      state.cached = snapshot;
    }),
    clearSnapshot: vi.fn(async () => {
      state.cached = null;
    }),
    readCachedSnapshot: vi.fn(async () => state.cached),
    now: () => state.now,
    onRefreshError: vi.fn(),
  };
  const reader = createClaudeSubscriptionUsageReader(deps, {
    throttleMs: 1_000,
    failureBackoffInitialMs: 10_000,
    failureBackoffMaxMs: 40_000,
  });
  return { state, deps, reader };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createClaudeSubscriptionUsageReader', () => {
  it('cached-first:读立即返回缓存,后台拉取并附上账号指纹', async () => {
    const { deps, reader, state } = setup({ cached: { ...SNAPSHOT, source: 'unified-headers' } });
    await expect(reader.read()).resolves.toMatchObject({ source: 'unified-headers' });
    await flush();
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(state.cached).toMatchObject({ source: 'oauth-endpoint', accountFingerprint: 'acct-a' });
  });

  it('节流窗口内不重复拉起 CLI,过了窗口再拉', async () => {
    const { deps, reader, state } = setup();
    await reader.read();
    await flush();
    reader.triggerRefresh();
    await reader.read();
    await flush();
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(1);
    state.now += 1_001;
    reader.triggerRefresh();
    await flush();
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('失败指数退避,成功后复位', async () => {
    const { deps, reader, state } = setup();
    deps.fetchSnapshot.mockRejectedValue(new Error('claude get_usage timed out'));
    reader.triggerRefresh();
    await flush();
    expect(deps.onRefreshError).toHaveBeenCalledTimes(1);

    state.now += 5_000; // 过了节流,仍在 10s 退避内
    reader.triggerRefresh();
    await flush();
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(1);

    state.now += 6_000;
    reader.triggerRefresh();
    await flush();
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2);

    state.now += 15_000; // 第二次失败退避翻倍到 20s
    reader.triggerRefresh();
    await flush();
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2);

    deps.fetchSnapshot.mockResolvedValue(SNAPSHOT);
    state.now += 6_000;
    reader.triggerRefresh();
    await flush();
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(3);
    expect(state.cached).toMatchObject({ accountFingerprint: 'acct-a' });
  });

  it("CLI 报账号没有套餐余量('empty')→ 清缓存", async () => {
    const { deps, reader, state } = setup({ cached: SNAPSHOT });
    deps.fetchSnapshot.mockResolvedValue('empty');
    reader.triggerRefresh();
    await flush();
    expect(state.cached).toBeNull();
  });

  it('未连接:读返回 null 且不拉起 CLI;syncForCredentialChange 无条件清快照', async () => {
    const { deps, reader } = setup({ account: null, cached: SNAPSHOT });
    await expect(reader.read()).resolves.toBeNull();
    reader.triggerRefresh();
    await flush();
    expect(deps.fetchSnapshot).not.toHaveBeenCalled();
    await reader.syncForCredentialChange();
    expect(deps.clearSnapshot).toHaveBeenCalledTimes(1);
  });

  it('换号:缓存属于别的账号时立即清除并为新账号拉取', async () => {
    const { deps, reader, state } = setup({ account: 'acct-b', cached: { ...SNAPSHOT, accountFingerprint: 'acct-a' } });
    await expect(reader.read()).resolves.toBeNull();
    await flush();
    expect(deps.clearSnapshot).toHaveBeenCalled();
    expect(state.cached).toMatchObject({ accountFingerprint: 'acct-b' });
  });

  it('拉取失败(含返回形状无法识别)保留已有缓存,不当成没有余量', async () => {
    const cached = { ...SNAPSHOT, source: 'unified-headers' as const };
    const { deps, reader, state } = setup({ cached });
    deps.fetchSnapshot.mockRejectedValue(new Error('claude get_usage returned unrecognized rate_limits'));
    reader.triggerRefresh();
    await flush();
    expect(deps.clearSnapshot).not.toHaveBeenCalled();
    expect(state.cached).toBe(cached);
  });

  it('读缓存期间换号:不返回也不清理,避免把旧账号余量给新账号或误删新账号快照', async () => {
    const { deps, reader, state } = setup({ cached: { ...SNAPSHOT, accountFingerprint: 'acct-a' } });
    deps.readCachedSnapshot.mockImplementationOnce(async () => {
      const snapshot = state.cached;
      state.account = 'acct-b';
      return snapshot;
    });
    await expect(reader.read()).resolves.toBeNull();
    expect(deps.clearSnapshot).not.toHaveBeenCalled();
    expect(deps.fetchSnapshot).not.toHaveBeenCalled();
  });

  it('syncForCredentialChange 读缓存期间又换号:交给新账号那次同步,本次不清理', async () => {
    const { deps, reader, state } = setup({ account: 'acct-b', cached: { ...SNAPSHOT, accountFingerprint: 'acct-b' } });
    deps.readCachedSnapshot.mockImplementationOnce(async () => {
      state.account = 'acct-c';
      return { ...SNAPSHOT, accountFingerprint: 'acct-a' };
    });
    await reader.syncForCredentialChange();
    expect(deps.clearSnapshot).not.toHaveBeenCalled();
    expect(deps.fetchSnapshot).not.toHaveBeenCalled();
  });

  it('拉取期间换号:旧账号的结果被丢弃,收尾后为新账号补拉', async () => {
    const { deps, reader, state } = setup();
    let release: (value: ClaudeSubscriptionUsageSnapshot) => void = () => {};
    deps.fetchSnapshot.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    reader.triggerRefresh();
    state.account = 'acct-b';
    const synced = reader.syncForCredentialChange();
    release(SNAPSHOT);
    await synced;
    await flush();
    await flush();
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(state.cached).toMatchObject({ accountFingerprint: 'acct-b' });
  });
});
