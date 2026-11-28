/**
 * 测试价值
 * - 生产入口与可观察结果：调用 PrMergedAutoSync.observe / reset，验证 PR 从非合并态变为 merged 时触发本地主分支快进，冷启动已合并 PR 不误触发，且同仓库并发/冷却期去重。
 * - Bug／规则依据：PR 合并后零 Token 自动快进本地默认分支的边界契约（不惊动历史已合并 PR，不并发重复 fetch）。
 * - 现有覆盖缺口：相邻 prFollowWatch 测试只覆盖调度任务触发，未覆盖本地分支自动快进编排。
 * - 最小失败输入：冷启动直接观察到 status='merged'；或 open→merged 连续观察两次。
 * - tier：unit（纯内存依赖注入，无真实 Git/子进程）。
 */
import { describe, expect, it, vi } from 'vitest';
import { PrMergedAutoSync } from '../prMergedAutoSync.js';
import type { PrStatusQuery, PrStatusResult } from '../prStatusService.js';

const query: PrStatusQuery = {
  provider: 'github',
  host: 'github.com',
  owner: 'xindong',
  repo: 'cindy',
  prNumber: 42,
};

function okStatus(status: 'open' | 'closed' | 'draft' | 'merged'): PrStatusResult {
  return {
    ...query,
    ok: true,
    status,
    title: 'Sync branch cleanly',
    htmlUrl: 'https://github.com/xindong/cindy/pull/42',
    unresolvedCount: 0,
    branch: 'feat/sync',
    observedAt: 1_000,
  };
}

describe('PrMergedAutoSync', () => {
  it('does not trigger fast-forward on initial cold-start observation of an already-merged PR', async () => {
    const findLocalBaseReposForPr = vi.fn(async () => ['/repo/cindy']);
    const fastForwardDefaultBranch = vi.fn(async () => ({
      status: 'updated' as const,
      branch: 'main',
      updated: 1,
    }));
    const sync = new PrMergedAutoSync({
      findLocalBaseReposForPr,
      fastForwardDefaultBranch,
    });

    sync.observe(query, okStatus('merged'));
    await Promise.resolve();

    expect(findLocalBaseReposForPr).not.toHaveBeenCalled();
    expect(fastForwardDefaultBranch).not.toHaveBeenCalled();
  });

  it('fast-forwards each unique local baseRepo once when a PR transitions from open to merged', async () => {
    const onUpdated = vi.fn();
    const findLocalBaseReposForPr = vi.fn(async () => ['/repo/cindy', '/repo/cindy']);
    const fastForwardDefaultBranch = vi.fn(async () => ({
      status: 'updated' as const,
      branch: 'main',
      updated: 2,
    }));
    const sync = new PrMergedAutoSync({
      findLocalBaseReposForPr,
      fastForwardDefaultBranch,
      onUpdated,
    });

    sync.observe(query, okStatus('open'));
    sync.observe(query, okStatus('merged'));
    await vi.waitFor(() => expect(fastForwardDefaultBranch).toHaveBeenCalledTimes(1));

    expect(fastForwardDefaultBranch).toHaveBeenCalledWith('/repo/cindy');
    expect(onUpdated).toHaveBeenCalledWith('/repo/cindy', 'main', 2);

    // Repeating merged observation does not re-trigger.
    sync.observe(query, okStatus('merged'));
    await Promise.resolve();
    expect(fastForwardDefaultBranch).toHaveBeenCalledTimes(1);
  });

  it('respects per-repo cooldown across simultaneous merges and clears state on reset()', async () => {
    let clock = 10_000;
    const fastForwardDefaultBranch = vi.fn(async () => ({
      status: 'updated' as const,
      branch: 'main',
      updated: 1,
    }));
    const sync = new PrMergedAutoSync({
      findLocalBaseReposForPr: async () => ['/repo/cindy'],
      fastForwardDefaultBranch,
      cooldownMs: 10_000,
      now: () => clock,
    });
    const pr2: PrStatusQuery = { ...query, prNumber: 43 };

    sync.observe(query, okStatus('open'));
    sync.observe(pr2, { ...okStatus('open'), prNumber: 43 });
    sync.observe(query, okStatus('merged'));
    await vi.waitFor(() => expect(fastForwardDefaultBranch).toHaveBeenCalledTimes(1));

    // Second merge within cooldown window coalesces.
    clock += 2_000;
    sync.observe(pr2, { ...okStatus('merged'), prNumber: 43 });
    await Promise.resolve();
    expect(fastForwardDefaultBranch).toHaveBeenCalledTimes(1);

    // After reset (e.g. account switch), cold-start merged observation again stays quiet.
    sync.reset();
    clock += 20_000;
    sync.observe(query, okStatus('merged'));
    await Promise.resolve();
    expect(fastForwardDefaultBranch).toHaveBeenCalledTimes(1);
  });
});
