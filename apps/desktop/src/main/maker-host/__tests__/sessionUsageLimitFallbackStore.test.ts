/**
 * 策略与回切 episode 存在同一份文件里，行为必须一起验证：
 *  - 清策略 → episode 一起作废；
 *  - 用户选模清 episode → 策略保留；
 *  - 磁盘上残留的「有 episode 没策略」在读取时被丢掉；
 *  - 没有 episode 的任务清 episode 不碰磁盘（选模热路径不抢文件锁）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  raw: null as unknown,
  updateCalls: 0,
  normalize: null as null | ((raw: unknown) => unknown),
}));

vi.mock('../override-settings-file.js', () => ({
  createOverrideSettingsFile: (options: { normalize: (raw: unknown) => unknown }) => {
    mocks.normalize = options.normalize;
    const current = () => options.normalize(mocks.raw) as { policies: object; episodes: object };
    return {
      invalidateIfChanged: vi.fn(),
      read: current,
      updateAtomic: async (
        updater: (state: { value: { policies: object; episodes: object } }) => object,
      ) => {
        mocks.updateCalls += 1;
        const value = current();
        const next = { ...value, ...updater({ value }) };
        mocks.raw = next;
        return next;
      },
    };
  },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: () => 'unused',
  activeOwnerScopeKey: () => 'owner-a',
}));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

import {
  claimSessionUsageLimitFallbackEpisodeAttempt,
  readAllSessionUsageLimitFallbackEpisodes,
  readAllSessionUsageLimitFallbacks,
  readSessionUsageLimitFallback,
  readSessionUsageLimitFallbackEpisode,
  writeSessionUsageLimitFallback,
  writeSessionUsageLimitFallbackEpisode,
} from '../session-usage-limit-fallback-store.js';

const policy = {
  source: {
    agentKind: 'codex' as const,
    model: 'gpt-6.1-sol',
    providerId: 'openai',
    effort: 'medium' as const,
    fastMode: false as const,
    agentDeviceId: null,
  },
  target: { providerId: 'xd', model: 'deepseek-v4-flash' },
};

const episode = {
  failedAtMs: 1_700_000_000_000,
  knownResetAtMs: 1_700_000_180_000,
  targetRoute: { providerId: 'xd', model: 'deepseek-v4-flash' },
  attempts: 0,
  nextEligibleAtMs: 1_700_000_180_000,
};

beforeEach(() => {
  mocks.raw = { policies: {}, episodes: {} };
  mocks.updateCalls = 0;
});

describe('session usage-limit fallback store: episodes', () => {
  it('有策略的任务可以记 episode，并按 session 读回', async () => {
    await writeSessionUsageLimitFallback('s1', policy);
    await writeSessionUsageLimitFallbackEpisode('s1', episode);

    expect(readSessionUsageLimitFallbackEpisode('s1')).toEqual(episode);
    expect(readAllSessionUsageLimitFallbackEpisodes()).toEqual([{ sessionId: 's1', episode }]);
    expect(readAllSessionUsageLimitFallbacks()).toEqual([{ sessionId: 's1', policy }]);
  });

  it('清除策略同时清掉 episode', async () => {
    await writeSessionUsageLimitFallback('s1', policy);
    await writeSessionUsageLimitFallbackEpisode('s1', episode);
    await writeSessionUsageLimitFallback('s1', null);

    expect(readSessionUsageLimitFallback('s1')).toBeNull();
    expect(readSessionUsageLimitFallbackEpisode('s1')).toBeNull();
  });

  it('用户选模只清 episode，策略保留（同值重选也走这条）', async () => {
    await writeSessionUsageLimitFallback('s1', policy);
    await writeSessionUsageLimitFallbackEpisode('s1', episode);
    await writeSessionUsageLimitFallbackEpisode('s1', null);

    expect(readSessionUsageLimitFallbackEpisode('s1')).toBeNull();
    expect(readSessionUsageLimitFallback('s1')).toEqual(policy);
  });

  it('没有 episode 时清 episode 不写盘（选模热路径不抢文件锁）', async () => {
    await writeSessionUsageLimitFallback('s1', policy);
    const before = mocks.updateCalls;

    await writeSessionUsageLimitFallbackEpisode('s1', null);

    expect(mocks.updateCalls).toBe(before);
  });

  it('认领尝试：episode 没被换过才写得进去', async () => {
    await writeSessionUsageLimitFallback('s1', policy);
    await writeSessionUsageLimitFallbackEpisode('s1', episode);

    const claimed = await claimSessionUsageLimitFallbackEpisodeAttempt(
      's1',
      { failedAtMs: episode.failedAtMs, attempts: episode.attempts },
      { ...episode, attempts: 1, nextEligibleAtMs: episode.nextEligibleAtMs + 120_000 },
    );

    expect(claimed).toBe(true);
    expect(readSessionUsageLimitFallbackEpisode('s1')?.attempts).toBe(1);
  });

  it('认领尝试：期间被用户选模清掉 → 不认领、也不复活', async () => {
    await writeSessionUsageLimitFallback('s1', policy);
    await writeSessionUsageLimitFallbackEpisode('s1', episode);
    await writeSessionUsageLimitFallbackEpisode('s1', null);

    const claimed = await claimSessionUsageLimitFallbackEpisodeAttempt(
      's1',
      { failedAtMs: episode.failedAtMs, attempts: episode.attempts },
      { ...episode, attempts: 1, nextEligibleAtMs: episode.nextEligibleAtMs + 120_000 },
    );

    expect(claimed).toBe(false);
    expect(readSessionUsageLimitFallbackEpisode('s1')).toBeNull();
  });

  it('磁盘上「有 episode 没策略」的残留读取时被丢掉', () => {
    mocks.raw = { policies: {}, episodes: { orphan: episode } };

    expect(readAllSessionUsageLimitFallbackEpisodes()).toEqual([]);
  });

  it('读不懂的 episode 直接丢弃，不影响其它任务', async () => {
    await writeSessionUsageLimitFallback('s1', policy);
    mocks.raw = {
      policies: { s1: policy },
      episodes: {
        s1: { ...episode, attempts: -1 },
        s2: { ...episode, targetRoute: { providerId: '', model: 'x' } },
      },
    };

    expect(readAllSessionUsageLimitFallbackEpisodes()).toEqual([]);
  });
});
