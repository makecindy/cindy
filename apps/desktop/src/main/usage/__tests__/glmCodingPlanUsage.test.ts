/**
 * glmCodingPlanUsage.test.ts
 * ---------------------------------------------------------------------------
 * GLM Coding Plan 余量的解析纯函数 + quota/limit fetch 层单测:
 *   - parseGlmCodingPlanQuotaLimitResponse: limits[] 已证实形状(官方插件口径)、
 *     data 包裹、未知 type 跳过、同 type 多条整体跳过(不猜)、reset 候选字段
 *   - buildGlmUsageEndpointUrl: host 白名单精确匹配(https / 无 userinfo / 相似域名拒)
 *   - fetchGlmCodingPlanUsageSnapshot: Authorization 原文(无 Bearer)、401/403 →
 *     Unauthorized、429 → RateLimited、无可解析窗口 → 'empty'
 */

import { describe, expect, it, vi } from 'vitest';

import {
  hasAlertingGlmWindow,
  isGlmUsageWindowAlerting,
  parseGlmCodingPlanQuotaLimitResponse,
} from '../../../shared/glmCodingPlanUsage';
import {
  buildGlmUsageEndpointUrl,
  GlmCodingPlanUsageRateLimitedError,
  GlmCodingPlanUsageUnauthorizedError,
  fetchGlmCodingPlanUsageSnapshot,
} from '../glmCodingPlanUsage';

const NOW = 1_800_000_000_000;

/** 官方插件 query-usage.mjs 映射过的 quota/limit 响应形状(TOKENS_LIMIT + TIME_LIMIT)。 */
const LIVE_RESPONSE = {
  limits: [
    { type: 'TOKENS_LIMIT', percentage: 37.5 },
    {
      type: 'TIME_LIMIT',
      percentage: 12,
      currentValue: 3,
      usage: 25,
      usageDetails: [{ name: 'web-search', usage: 25 }],
    },
  ],
};

describe('parseGlmCodingPlanQuotaLimitResponse', () => {
  it('parses TOKENS_LIMIT (5h) and TIME_LIMIT (monthly MCP) windows', () => {
    const snapshot = parseGlmCodingPlanQuotaLimitResponse(LIVE_RESPONSE, NOW, 'zhipu');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.fiveHour?.utilization).toBe(37.5);
    // reset 字段未经 fixture 证实,缺失 = null(不臆造)
    expect(snapshot?.fiveHour?.resetsAt).toBeNull();
    expect(snapshot?.monthlyMcp?.utilization).toBe(12);
    expect(snapshot?.platform).toBe('zhipu');
    expect(snapshot?.source).toBe('monitor-endpoint');
    expect(snapshot?.updatedAt).toBe(NOW);
  });

  it('unwraps a data envelope (official plugin falls back json.data || json)', () => {
    const snapshot = parseGlmCodingPlanQuotaLimitResponse(
      { data: LIVE_RESPONSE },
      NOW,
      'zai',
    );
    expect(snapshot?.fiveHour?.utilization).toBe(37.5);
    expect(snapshot?.platform).toBe('zai');
  });

  it('skips unknown limit types (weekly window unverified — never fabricated)', () => {
    const snapshot = parseGlmCodingPlanQuotaLimitResponse({
      limits: [
        { type: 'WEEKLY_LIMIT', percentage: 40 },
        { type: 'TOKENS_LIMIT', percentage: 10 },
      ],
    }, NOW, 'zhipu');
    expect(snapshot?.fiveHour?.utilization).toBe(10);
    expect(snapshot?.monthlyMcp).toBeNull();
  });

  it('drops a type entirely when multiple entries make it ambiguous', () => {
    // 未来 5h + 周窗同为 TOKENS_LIMIT 时无法区分 —— 全部跳过,不猜第一条。
    const snapshot = parseGlmCodingPlanQuotaLimitResponse({
      limits: [
        { type: 'TOKENS_LIMIT', percentage: 10 },
        { type: 'TOKENS_LIMIT', percentage: 40 },
        { type: 'TIME_LIMIT', percentage: 5 },
      ],
    }, NOW, 'zhipu');
    expect(snapshot?.fiveHour).toBeNull();
    expect(snapshot?.monthlyMcp?.utilization).toBe(5);
  });

  it('parses reset candidates as epoch seconds / ms / ISO when present', () => {
    const snapshot = parseGlmCodingPlanQuotaLimitResponse({
      limits: [
        { type: 'TOKENS_LIMIT', percentage: 10, resetsAt: 1_800_000_100 },
        { type: 'TIME_LIMIT', percentage: 5, resetTime: '2026-09-14T02:17:53Z' },
      ],
    }, NOW, 'zhipu');
    expect(snapshot?.fiveHour?.resetsAt).toBe(1_800_000_100);
    expect(snapshot?.monthlyMcp?.resetsAt)
      .toBe(Math.floor(Date.parse('2026-09-14T02:17:53Z') / 1000));
  });

  it('clamps out-of-range percentage and skips malformed entries', () => {
    const snapshot = parseGlmCodingPlanQuotaLimitResponse({
      limits: [
        { type: 'TOKENS_LIMIT', percentage: 250 },
        { type: 'TIME_LIMIT', percentage: 'not-a-number' },
        'garbage',
        null,
      ],
    }, NOW, 'zhipu');
    expect(snapshot?.fiveHour?.utilization).toBe(100);
    expect(snapshot?.monthlyMcp).toBeNull();
  });

  it('returns null for unparsable / windowless payloads', () => {
    expect(parseGlmCodingPlanQuotaLimitResponse(null, NOW, 'zhipu')).toBeNull();
    expect(parseGlmCodingPlanQuotaLimitResponse('nope', NOW, 'zhipu')).toBeNull();
    expect(parseGlmCodingPlanQuotaLimitResponse({}, NOW, 'zhipu')).toBeNull();
    expect(parseGlmCodingPlanQuotaLimitResponse({ limits: [] }, NOW, 'zhipu')).toBeNull();
    expect(parseGlmCodingPlanQuotaLimitResponse({ data: 'str' }, NOW, 'zhipu')).toBeNull();
  });
});

describe('isGlmUsageWindowAlerting / hasAlertingGlmWindow', () => {
  it('alerts when a displayed window runs down to the last 10%', () => {
    expect(isGlmUsageWindowAlerting({ utilization: 90 })).toBe(true);
    expect(isGlmUsageWindowAlerting({ utilization: 89 })).toBe(false);
    expect(isGlmUsageWindowAlerting(undefined)).toBe(false);
    // 脏值(持久化快照不重校验)不得被夹成 100 误判耗尽
    expect(isGlmUsageWindowAlerting({ utilization: Number.POSITIVE_INFINITY })).toBe(false);
    expect(hasAlertingGlmWindow({
      fiveHour: { utilization: 10 },
      monthlyMcp: { utilization: 95 },
      platform: 'zhipu',
    })).toBe(true);
    expect(hasAlertingGlmWindow(null)).toBe(false);
  });
});

describe('buildGlmUsageEndpointUrl', () => {
  it('derives the endpoint origin from allowlisted runtime base URLs', () => {
    expect(buildGlmUsageEndpointUrl('https://open.bigmodel.cn/api/anthropic'))
      .toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit');
    expect(buildGlmUsageEndpointUrl('https://api.z.ai/api/coding/paas/v4'))
      .toBe('https://api.z.ai/api/monitor/usage/quota/limit');
    expect(buildGlmUsageEndpointUrl('https://dev.bigmodel.cn/api/anthropic'))
      .toBe('https://dev.bigmodel.cn/api/monitor/usage/quota/limit');
  });

  it('rejects non-https, userinfo, lookalike hosts and arbitrary hosts', () => {
    // 订阅 key 只发给第一方白名单 host —— 精确匹配,不做子串包含。
    expect(buildGlmUsageEndpointUrl('http://open.bigmodel.cn/api/anthropic')).toBeNull();
    expect(buildGlmUsageEndpointUrl('https://user:pw@open.bigmodel.cn/api/anthropic')).toBeNull();
    expect(buildGlmUsageEndpointUrl('https://evil.bigmodel.cn.example.com/api')).toBeNull();
    expect(buildGlmUsageEndpointUrl('https://open.bigmodel.cn.evil.com/api')).toBeNull();
    expect(buildGlmUsageEndpointUrl('https://api.example.com/api/anthropic')).toBeNull();
    expect(buildGlmUsageEndpointUrl('not-a-url')).toBeNull();
  });
});

describe('fetchGlmCodingPlanUsageSnapshot', () => {
  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }

  it('sends the raw API key in Authorization (no Bearer) and returns a parsed snapshot', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, LIVE_RESPONSE));
    const result = await fetchGlmCodingPlanUsageSnapshot({
      runtimeBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'sk-test-glm-key',
      platform: 'zhipu',
      fetchFn,
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result).not.toBe('empty');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'sk-test-glm-key',
        }),
      }),
    );
  });

  it('refuses to send the key when the runtime base URL is not allowlisted', async () => {
    const fetchFn = vi.fn();
    await expect(fetchGlmCodingPlanUsageSnapshot({
      runtimeBaseUrl: 'https://api.example.com/api/anthropic',
      apiKey: 'sk-test-glm-key',
      platform: 'zhipu',
      fetchFn,
    })).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws Unauthorized on 401/403 and RateLimited on 429', async () => {
    await expect(fetchGlmCodingPlanUsageSnapshot({
      runtimeBaseUrl: 'https://api.z.ai/api/anthropic',
      apiKey: 'k', platform: 'zai',
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(401, {})),
    })).rejects.toBeInstanceOf(GlmCodingPlanUsageUnauthorizedError);
    await expect(fetchGlmCodingPlanUsageSnapshot({
      runtimeBaseUrl: 'https://api.z.ai/api/anthropic',
      apiKey: 'k', platform: 'zai',
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(403, {})),
    })).rejects.toBeInstanceOf(GlmCodingPlanUsageUnauthorizedError);
    await expect(fetchGlmCodingPlanUsageSnapshot({
      runtimeBaseUrl: 'https://api.z.ai/api/anthropic',
      apiKey: 'k', platform: 'zai',
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(429, {})),
    })).rejects.toBeInstanceOf(GlmCodingPlanUsageRateLimitedError);
  });

  it('returns null on transport failures but explicit empty on windowless 2xx', async () => {
    await expect(fetchGlmCodingPlanUsageSnapshot({
      runtimeBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'k', platform: 'zhipu',
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(500, {})),
    })).resolves.toBeNull();
    await expect(fetchGlmCodingPlanUsageSnapshot({
      runtimeBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'k', platform: 'zhipu',
      fetchFn: vi.fn().mockRejectedValue(new Error('offline')),
    })).resolves.toBeNull();
    await expect(fetchGlmCodingPlanUsageSnapshot({
      runtimeBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'k', platform: 'zhipu',
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(200, { limits: [] })),
    })).resolves.toBe('empty');
  });
});
