import { describe, expect, it } from 'vitest';
import {
  nextCodexBucketStaleAtMs,
  resolveCodexBucketTable,
  selectCodexUsageForModel,
} from '../codexUsageBuckets';
import {
  summarizeAccountRateLimits,
  summarizeCodexRateLimitReset,
  summarizeContextUsage,
  summarizeSessionSpend,
} from '../sessionControls.js';

describe('shared session usage summaries', () => {
  it('summarizes session spend for shared header and controls surfaces', () => {
    expect(summarizeSessionSpend({
      contextTokens: 16000,
      contextWindow: 200000,
      totalCostUsd: 0.024,
      totalTokenUsage: 42000,
    })).toEqual({
      available: true,
      detail: '本会话 $0.02 · 42k tokens · 上下文 16k / 200k · 8%',
      title: 'Session spend',
    });

    expect(summarizeSessionSpend(null)).toEqual({
      available: false,
      detail: '暂无会话用量',
      title: 'Session spend',
    });
  });

  it('summarizes context usage payloads with graceful fallbacks', () => {
    expect(summarizeContextUsage(null)).toEqual({
      title: 'Context usage',
      detail: '暂无上下文数据',
      rows: [],
    });

    expect(summarizeContextUsage({
      totalTokens: 90000,
      rawMaxTokens: 200000,
    })).toMatchObject({
      title: 'Context usage',
      detail: '90,000 / 200,000 tokens · 45%',
    });
  });
});

describe('summarizeCodexRateLimitReset', () => {
  const NOW_MS = Date.UTC(2026, 6, 12, 12, 0, 0);
  const base = {
    account: { email: 'pe***@example.com', accountId: '…456789', planType: 'plus' },
    rateLimits: { primary: { usedPercent: 100, windowMinutes: 300 } },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [{
        status: 'available' as const,
        resetType: 'codexRateLimits' as const,
        grantedAt: Math.floor(NOW_MS / 1000) - 100,
        expiresAt: Math.floor(NOW_MS / 1000) + 3600,
        title: 'Full reset',
        description: null,
      }],
    },
    resetOffer: {
      idempotencyKey: '018f4ec7-c6d8-7f10-8d43-9f8791d33000',
      expiresAt: Math.floor(NOW_MS / 1000) + 3600,
      validUntil: NOW_MS + 60_000,
    },
  };

  it('shows account, workspace, count and expiry when an exhausted window can reset', () => {
    const summary = summarizeCodexRateLimitReset(base, NOW_MS);
    expect(summary).toMatchObject({ availableCount: 2, shouldPrompt: true, canReset: true });
    expect(summary?.rows.slice(0, 3)).toEqual([
      { label: '账号', value: 'pe***@example.com' },
      { label: 'Workspace', value: '…456789' },
      { label: '可用重置', value: '2 次' },
    ]);
    expect(summary?.rows[3]).toMatchObject({ label: '最早过期' });
    expect(summary?.rows[3].value).toMatch(/^\d{2}:\d{2}$/);
    expect(summary).toMatchObject({
      hasResetCreditCount: true,
      earliestExpiryAt: base.resetOffer.expiresAt,
    });
  });

  it('does not offer reset before exhaustion and leaves offer expiry to desktop', () => {
    expect(summarizeCodexRateLimitReset({
      ...base,
      rateLimits: { primary: { usedPercent: 99.9 } },
    }, NOW_MS)).toMatchObject({ shouldPrompt: false, canReset: false });
    expect(summarizeCodexRateLimitReset({
      ...base,
      resetOffer: { ...base.resetOffer, validUntil: NOW_MS },
    }, NOW_MS)).toMatchObject({ shouldPrompt: true, canReset: true });
  });

  it('shows exhausted-without-credit but ignores prepaid-credit depletion', () => {
    expect(summarizeCodexRateLimitReset({
      ...base,
      rateLimitResetCredits: { availableCount: 0, credits: [] },
      resetOffer: null,
    }, NOW_MS)).toMatchObject({ availableCount: 0, shouldPrompt: true, canReset: false });
    expect(summarizeCodexRateLimitReset({
      ...base,
      rateLimits: {
        primary: { usedPercent: 100 },
        rateLimitReachedType: 'workspace_owner_credits_depleted',
      },
    }, NOW_MS)).toMatchObject({ shouldPrompt: false, canReset: false });
  });

  it('omits the reset count when credit availability was not returned', () => {
    const summary = summarizeCodexRateLimitReset({
      ...base,
      rateLimitResetCredits: null,
      resetOffer: null,
    }, NOW_MS);

    expect(summary).toMatchObject({
      availableCount: 0,
      hasResetCreditCount: false,
      earliestExpiryAt: null,
      shouldPrompt: true,
      canReset: false,
    });
    expect(summary?.rows).not.toContainEqual(expect.objectContaining({ label: '可用重置' }));
  });
});

describe('summarizeAccountRateLimits', () => {
  // 2026-07-12 12:00:00 UTC 固定基准,避免用例受运行时钟影响。
  const NOW_MS = Date.UTC(2026, 6, 12, 12, 0, 0);

  it('renders window rows with labels derived from upstream windowMinutes (5h + weekly)', () => {
    const sameDayReset = Math.floor(NOW_MS / 1000) + 2 * 60 * 60;
    const summary = summarizeAccountRateLimits({
      planType: 'plus',
      primary: { usedPercent: 40, windowMinutes: 300, resetsAt: sameDayReset },
      secondary: { usedPercent: 12.5, windowMinutes: 10080 },
      rateLimitReachedType: null,
    }, NOW_MS);
    expect(summary).not.toBeNull();
    expect(summary!.rows[0]).toEqual({ label: '套餐', value: 'Plus' });
    expect(summary!.rows[1].label).toBe('5h');
    expect(summary!.rows[1].value).toContain('剩余 60%');
    expect(summary!.rows[1].value).toContain('已用 40%');
    expect(summary!.rows[1].value).toContain('重置');
    expect(summary!.rows[2]).toEqual({ label: '周', value: '剩余 87.5% · 已用 12.5%' });
  });

  it('follows upstream window composition instead of assuming 5h exists (weekly-only)', () => {
    const summary = summarizeAccountRateLimits({
      primary: { usedPercent: 30, windowMinutes: 10080 },
      secondary: null,
    }, NOW_MS);
    expect(summary!.rows).toEqual([{ label: '周', value: '剩余 70% · 已用 30%' }]);
  });

  it('falls back to a neutral window label when upstream omits duration and reset', () => {
    const summary = summarizeAccountRateLimits({
      primary: { usedPercent: 99.5 },
    }, NOW_MS);
    expect(summary!.rows).toEqual([{ label: '限额', value: '剩余 0.5% · 已用 99.5%' }]);
  });

  it('derives day-scale labels and flags non-credit limit-reached states', () => {
    const summary = summarizeAccountRateLimits({
      primary: { usedPercent: 100, windowMinutes: 3 * 24 * 60 },
      rateLimitReachedType: 'rate_limit_reached',
    }, NOW_MS);
    expect(summary!.rows[0].label).toBe('3天');
    expect(summary!.rows[1]).toEqual({ label: '状态', value: '已触发账号限额' });

    const creditsOnly = summarizeAccountRateLimits({
      primary: { usedPercent: 10, windowMinutes: 300 },
      rateLimitReachedType: 'workspace_owner_credits_depleted',
    }, NOW_MS);
    expect(creditsOnly!.rows.some((row) => row.label === '状态')).toBe(false);
  });

  it('returns null for unusable payloads so callers can hide the section', () => {
    expect(summarizeAccountRateLimits(null, NOW_MS)).toBeNull();
    expect(summarizeAccountRateLimits('nope', NOW_MS)).toBeNull();
    expect(summarizeAccountRateLimits({}, NOW_MS)).toBeNull();
    expect(summarizeAccountRateLimits({ primary: { windowMinutes: 300 } }, NOW_MS)).toBeNull();
  });
});

describe('selectCodexUsageForModel (per-model bucket selection)', () => {
  // 与 desktop 同源的问题: 账号同时有主配额桶与模型专属促销桶时, 手机端的
  // 用量详情不能显示别的模型的桶(PR #379 / issue #382)。
  const NOW = 1_785_000_000_000;
  const future = Math.floor((NOW + 3 * 24 * 60 * 60 * 1000) / 1000);
  const MAIN = { limitId: 'codex', primary: { usedPercent: 63, resetsAt: future } };
  const SPARK = {
    limitId: 'codex_bengalfox',
    limitName: 'GPT-5.3-Codex-Spark',
    primary: { usedPercent: 0, windowMinutes: 10_080, resetsAt: future },
  };

  it('picks the generic bucket for an unrelated model', () => {
    const picked = selectCodexUsageForModel({
      fallback: SPARK,
      byLimitId: { codex: MAIN, codex_bengalfox: SPARK },
      modelId: 'gpt-5.6-sol',
      nowMs: NOW,
    });
    expect(picked).toBe(MAIN);
  });

  it('picks the model-scoped bucket when the model matches', () => {
    const picked = selectCodexUsageForModel({
      fallback: MAIN,
      byLimitId: { codex: MAIN, codex_bengalfox: SPARK },
      modelId: 'gpt-5.3-codex-spark',
      nowMs: NOW,
    });
    expect(picked).toBe(SPARK);
  });

  it('falls back to appServerBuckets when the authoritative table is absent', () => {
    const picked = selectCodexUsageForModel({
      fallback: SPARK,
      byLimitId: null,
      appServerBuckets: { codex: MAIN, codex_bengalfox: SPARK },
      modelId: 'gpt-5.6-sol',
      nowMs: NOW,
    });
    expect(picked).toBe(MAIN);
  });

  it('returns null instead of another model bucket when nothing matches', () => {
    const picked = selectCodexUsageForModel({
      fallback: SPARK,
      byLimitId: { codex_bengalfox: SPARK },
      modelId: 'gpt-5.6-sol',
      nowMs: NOW,
    });
    expect(picked).toBeNull();
  });

  it('keeps the legacy top-level snapshot when no bucket table is available', () => {
    const picked = selectCodexUsageForModel({
      fallback: MAIN,
      modelId: 'gpt-5.6-sol',
      nowMs: NOW,
    });
    expect(picked).toBe(MAIN);
  });
});

describe('generic bucket alias priority', () => {
  const NOW = 1_785_000_000_000;
  const future = Math.floor((NOW + 3 * 24 * 60 * 60 * 1000) / 1000);

  it('prefers the explicit codex bucket over the legacy __default__ alias', () => {
    // 旧快照没带 limitId → 落到 __default__; 之后真正的 codex 通知新建第二个通用桶。
    // 按插入序查找会一直返回旧的缺省桶(review 反馈)。
    const legacyDefault = { primary: { usedPercent: 5, resetsAt: future } };
    const currentCodex = { limitId: 'codex', primary: { usedPercent: 71, resetsAt: future } };
    const picked = selectCodexUsageForModel({
      byLimitId: { __default__: legacyDefault, codex: currentCodex },
      modelId: 'gpt-5.6-sol',
      nowMs: NOW,
    });
    expect(picked).toBe(currentCodex);
  });

  it('still uses the default alias when no explicit codex bucket exists', () => {
    const legacyDefault = { primary: { usedPercent: 5, resetsAt: future } };
    const picked = selectCodexUsageForModel({
      byLimitId: { __default__: legacyDefault },
      modelId: 'gpt-5.6-sol',
      nowMs: NOW,
    });
    expect(picked).toBe(legacyDefault);
  });

  it('computes the next stale moment from an unknown-shaped bucket table', () => {
    const table = { codex: { limitId: 'codex', primary: { usedPercent: 10, resetsAt: future } } };
    expect(nextCodexBucketStaleAtMs(table, NOW)).toBe(future * 1000 + 24 * 60 * 60 * 1000);
    expect(nextCodexBucketStaleAtMs(null, NOW)).toBeNull();
    expect(nextCodexBucketStaleAtMs({}, NOW)).toBeNull();
  });
});

describe('overlapping bucket names', () => {
  const NOW = 1_785_000_000_000;
  const future = Math.floor((NOW + 3 * 24 * 60 * 60 * 1000) / 1000);
  const BASE = { limitId: 'codex_base', limitName: 'GPT-5.3-Codex', primary: { usedPercent: 20, resetsAt: future } };
  const SPARK = { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', primary: { usedPercent: 0, resetsAt: future } };

  it('prefers the longest matching bucket name over insertion order', () => {
    // 'GPT-5.3-Codex' 先插入时不得抢走 Spark 会话(review 反馈)
    const picked = selectCodexUsageForModel({
      byLimitId: { codex_base: BASE, codex_bengalfox: SPARK },
      modelId: 'gpt-5.3-codex-spark',
      nowMs: NOW,
    });
    expect(picked).toBe(SPARK);
  });

  it('prefers an exact name match even when a longer name also matches', () => {
    const picked = selectCodexUsageForModel({
      byLimitId: { codex_bengalfox: SPARK, codex_base: BASE },
      modelId: 'gpt-5.3-codex',
      nowMs: NOW,
    });
    expect(picked).toBe(BASE);
  });

  it('does not let a broad name capture unrelated specialized models', () => {
    const broad = { limitId: 'codex_broad', limitName: 'Codex', primary: { usedPercent: 12, resetsAt: future } };
    const picked = selectCodexUsageForModel({
      byLimitId: { codex_broad: broad, codex_bengalfox: SPARK },
      modelId: 'gpt-5.3-codex-spark',
      nowMs: NOW,
    });
    expect(picked).toBe(SPARK);
  });
});

describe('resolveCodexBucketTable (selector / timer must agree)', () => {
  const NOW = 1_785_000_000_000;
  const future = Math.floor((NOW + 3 * 24 * 60 * 60 * 1000) / 1000);
  const MAIN = { limitId: 'codex', primary: { usedPercent: 40, resetsAt: future } };

  it('falls back past an empty authoritative table (not just null/undefined)', () => {
    // `a ?? b` 会把 {} 当有效表 —— 选桶与定时器就此漂移(review 反馈)
    const table = resolveCodexBucketTable({ byLimitId: {}, appServerBuckets: { codex: MAIN } });
    expect(table).not.toBeNull();
    expect(Object.keys(table ?? {})).toEqual(['codex']);
  });

  it('keeps selector and expiry timer consistent for an empty authoritative table', () => {
    const input = { byLimitId: {}, appServerBuckets: { codex: MAIN } };
    const picked = selectCodexUsageForModel({ ...input, modelId: 'gpt-5.6-sol', nowMs: NOW });
    const staleAt = nextCodexBucketStaleAtMs(resolveCodexBucketTable(input), NOW);
    expect(picked).toBe(MAIN);
    expect(staleAt).toBe(future * 1000 + 24 * 60 * 60 * 1000);
  });

  it('returns null when neither table is usable', () => {
    expect(resolveCodexBucketTable({ byLimitId: {}, appServerBuckets: {} })).toBeNull();
    expect(resolveCodexBucketTable({ byLimitId: null, appServerBuckets: undefined })).toBeNull();
    expect(resolveCodexBucketTable({ byLimitId: [], appServerBuckets: 'nope' })).toBeNull();
  });
});
