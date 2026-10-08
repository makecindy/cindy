import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providers: [] as Array<{ id: string; auth: { native?: string } }>,
  codex: vi.fn(),
  claude: vi.fn(),
  xai: vi.fn(),
  accountUsage: vi.fn(),
}));

vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => ({ providers: mocks.providers }),
}));
vi.mock('../../usageBroadcaster.js', () => ({
  readCodexAccountUsageSnapshot: mocks.codex,
  readClaudeSubscriptionUsageSnapshot: mocks.claude,
  readXaiSubscriptionUsageSnapshot: mocks.xai,
}));
vi.mock('../subscriptionAccountUsage.js', () => ({
  readSubscriptionAccountUsage: mocks.accountUsage,
}));

import {
  claudeAccountUsageLimit,
  codexAccountUsageLimit,
  readAccountUsageLimit,
  subscriptionFamilyOf,
  xaiAccountUsageLimit,
} from '../accountUsageLimit';

// 必须在未来:过期窗口的 app-server 桶会被选桶逻辑当作陈旧桶跳过。
const NOW_SEC = Math.floor(Date.now() / 1000);
const RESET_5H = NOW_SEC + 3 * 60 * 60;
const RESET_WEEK = NOW_SEC + 5 * 24 * 60 * 60;

beforeEach(() => {
  mocks.providers = [];
  mocks.codex.mockReset();
  mocks.claude.mockReset();
  mocks.xai.mockReset();
  mocks.accountUsage.mockReset();
});

describe('codexAccountUsageLimit', () => {
  const buckets = {
    codex: { limitId: 'codex', primary: { usedPercent: 40, resetsAt: RESET_5H } },
    spark: {
      limitId: 'spark',
      limitName: 'GPT-5.3-Codex-Spark',
      primary: { usedPercent: 100, resetsAt: RESET_WEEK },
    },
  };

  it('only looks at the bucket matching the Codex session model', () => {
    expect(
      codexAccountUsageLimit(
        { appServerBuckets: buckets },
        { agentKind: 'codex', modelId: 'gpt-5.5' },
      ),
    ).toEqual({ limited: false, resetAtMs: null });
    expect(
      codexAccountUsageLimit(
        { appServerBuckets: buckets },
        { agentKind: 'codex', modelId: 'gpt-5.3-codex-spark' },
      ),
    ).toEqual({ limited: true, resetAtMs: RESET_WEEK * 1000 });
  });

  it('reads the ChatGPT web slot for bridge / Pi sessions', () => {
    expect(
      codexAccountUsageLimit(
        {
          appServerBuckets: buckets,
          webSnapshot: { secondary: { usedPercent: 100, resetsAt: RESET_WEEK } },
        },
        { agentKind: 'claude-code', modelId: 'gpt-5.5' },
      ),
    ).toEqual({ limited: true, resetAtMs: RESET_WEEK * 1000 });
    expect(codexAccountUsageLimit({ appServerBuckets: buckets }, { agentKind: 'pi' })).toBeNull();
  });

  it('ignores snapshot-level reached flags (stale or credits depleted) without an exhausted window', () => {
    for (const rateLimitReachedType of ['primary', 'credits_depleted']) {
      expect(
        codexAccountUsageLimit(
          {
            rateLimitReachedType,
            primary: { usedPercent: 100, resetsAt: NOW_SEC - 60 },
            secondary: { usedPercent: 40, resetsAt: RESET_WEEK },
          },
          { agentKind: 'codex' },
        ),
      ).toEqual({ limited: false, resetAtMs: null });
    }
  });

  it('falls back to the top-level snapshot without a bucket table', () => {
    expect(
      codexAccountUsageLimit(
        { primary: { usedPercent: 100, resetsAt: RESET_5H } },
        { agentKind: 'codex' },
      ),
    ).toEqual({ limited: true, resetAtMs: RESET_5H * 1000 });
  });
});

describe('claudeAccountUsageLimit', () => {
  it('treats the rejected headers window as exhausted', () => {
    expect(
      claudeAccountUsageLimit({
        fiveHour: { utilization: 92, resetsAt: RESET_5H },
        sevenDay: { utilization: 40, resetsAt: RESET_WEEK },
        rateLimitStatus: 'rejected',
        representativeClaim: 'five_hour',
      }),
    ).toEqual({ limited: true, resetAtMs: RESET_5H * 1000 });
  });

  it('only counts the model-scoped window of the session model', () => {
    const snapshot = {
      fiveHour: { utilization: 10, resetsAt: RESET_5H },
      scoped: [{ utilization: 100, resetsAt: RESET_WEEK, modelDisplayName: 'Opus' }],
    };
    expect(claudeAccountUsageLimit(snapshot, 'claude-opus-5-5')).toEqual({
      limited: true,
      resetAtMs: RESET_WEEK * 1000,
    });
    expect(claudeAccountUsageLimit(snapshot, 'claude-sonnet-5')?.limited).toBe(false);
  });

  it('gives no reset time when an exhausted window lacks one instead of borrowing another window', () => {
    expect(
      claudeAccountUsageLimit({
        fiveHour: { utilization: 20, resetsAt: RESET_5H },
        sevenDay: { utilization: 100, resetsAt: null },
      }),
    ).toEqual({ limited: true, resetAtMs: null });
  });

  it('ignores windows whose reset already passed (the snapshot predates the rollover)', () => {
    expect(
      claudeAccountUsageLimit({
        fiveHour: { utilization: 100, resetsAt: NOW_SEC - 60 },
        sevenDay: { utilization: 40, resetsAt: RESET_WEEK },
      }),
    ).toEqual({ limited: false, resetAtMs: null });
  });
});

describe('xaiAccountUsageLimit', () => {
  it('reads the weekly window', () => {
    expect(
      xaiAccountUsageLimit({
        creditUsagePercent: 100,
        resetsAt: RESET_WEEK,
        updatedAt: Date.now(),
      }),
    ).toEqual({ limited: true, resetAtMs: RESET_WEEK * 1000 });
    expect(xaiAccountUsageLimit({ planLabel: 'SuperGrok' })).toBeNull();
  });

  it('ignores a cached snapshot past its freshness window', () => {
    expect(
      xaiAccountUsageLimit({
        creditUsagePercent: 100,
        resetsAt: RESET_WEEK,
        updatedAt: Date.now() - 2 * 60 * 60 * 1000,
      }),
    ).toBeNull();
  });
});

describe('subscriptionFamilyOf / readAccountUsageLimit', () => {
  it('maps a provider to its subscription family, independent of the agent', () => {
    // 内置默认账号目录里不带 auth.native。
    mocks.providers = [
      { id: 'openai', auth: {} },
      { id: 'anthropic', auth: {} },
      { id: 'xai', auth: {} },
      { id: 'codex-work', auth: { native: 'codex' } },
      { id: 'kimi-coding', auth: {} },
    ];
    expect(subscriptionFamilyOf('claude-code', 'openai')).toBe('codex');
    expect(subscriptionFamilyOf('pi', 'openai')).toBe('codex');
    expect(subscriptionFamilyOf('claude-code', 'anthropic')).toBe('claude');
    expect(subscriptionFamilyOf('pi', 'xai')).toBe('xai');
    expect(subscriptionFamilyOf('codex', 'codex-work')).toBe('codex');
    expect(subscriptionFamilyOf('claude-code', 'kimi-coding')).toBeNull();
    // 旧会话缺省 provider:只有 Codex 能确定是 ChatGPT 默认账号。
    expect(subscriptionFamilyOf('codex', null)).toBe('codex');
    expect(subscriptionFamilyOf('claude-code', null)).toBeNull();
  });

  it('returns undefined for non-subscription providers so callers can use another source', async () => {
    mocks.providers = [{ id: 'kimi-coding', auth: {} }];
    await expect(readAccountUsageLimit('claude-code', 'kimi-coding')).resolves.toBeUndefined();
    expect(mocks.codex).not.toHaveBeenCalled();
  });

  it('reads the ChatGPT snapshot of the session provider', async () => {
    mocks.providers = [{ id: 'codex-work', auth: { native: 'codex' } }];
    mocks.codex.mockResolvedValue({ primary: { usedPercent: 100, resetsAt: RESET_5H } });
    await expect(readAccountUsageLimit('codex', 'codex-work', 'gpt-5.5')).resolves.toEqual({
      limited: true,
      resetAtMs: RESET_5H * 1000,
    });
    expect(mocks.codex).toHaveBeenCalledWith('codex-work');
  });

  it('reads independent SuperGrok accounts through the account reader', async () => {
    mocks.providers = [{ id: 'xai-2', auth: { native: 'xai' } }];
    mocks.accountUsage.mockResolvedValue({
      creditUsagePercent: 100,
      resetsAt: RESET_WEEK,
      updatedAt: Date.now(),
    });
    await expect(readAccountUsageLimit('pi', 'xai-2')).resolves.toEqual({
      limited: true,
      resetAtMs: RESET_WEEK * 1000,
    });
    expect(mocks.xai).not.toHaveBeenCalled();
  });
});
