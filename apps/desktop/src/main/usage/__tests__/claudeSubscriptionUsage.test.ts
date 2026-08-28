/**
 * claudeSubscriptionUsage.test.ts
 * ---------------------------------------------------------------------------
 * Claude 订阅余量的解析 / 合并 / 模型匹配纯函数 + oauth/usage fetch 层单测:
 *   - parseClaudeOAuthUsageResponse: 新 schema limits[](实测样本)优先,legacy 顶层键兜底
 *   - parseClaudeUnifiedRateLimitHeaders: headers 0.0-1.0 分数 ×100 归一化
 *   - mergeClaudeSubscriptionUsageSnapshot: headers 增量 / endpoint 全量的双源语义
 *   - claudeModelFamily / matchScopedWindowForModel: 方案 B 的模型 → scoped 窗口匹配
 *   - isClaudeSubscriptionAlerting: chip 变红口径(只看影响当前会话的窗口 + rejected)
 *   - fetchClaudeSubscriptionUsageSnapshot: UA / beta 头、401→Unauthorized、429→RateLimited
 */

import { describe, expect, it, vi } from 'vitest';

import {
  claudeModelFamily,
  hasAlertingClaudeSessionWindow,
  isClaudeSubscriptionAlerting,
  isClaudeUsageWindowAlerting,
  matchScopedWindowForModel,
  mergeClaudeSubscriptionUsageSnapshot,
  parseClaudeOAuthUsageResponse,
  parseClaudeUnifiedRateLimitHeaders,
  type ClaudeSubscriptionUsageSnapshot,
} from '../../../shared/claudeSubscriptionUsage';
import {
  ClaudeSubscriptionUsageRateLimitedError,
  ClaudeSubscriptionUsageUnauthorizedError,
  fetchClaudeSubscriptionUsageSnapshot,
} from '../claudeSubscriptionUsage';

const NOW = 1_800_000_000_000;

/** 2026-07 实测 oauth/usage 响应形态(新 schema:limits[] + 顶层 legacy 键均在)。 */
const LIVE_RESPONSE = {
  five_hour: { utilization: 55.0, resets_at: '2026-07-02T13:00:00.539734+00:00' },
  seven_day: { utilization: 11.0, resets_at: '2026-07-09T08:00:00.539755+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  tangelo: null,
  extra_usage: {
    is_enabled: false, monthly_limit: null, used_credits: null, utilization: null,
  },
  limits: [
    {
      kind: 'session', group: 'session', percent: 55, severity: 'normal',
      resets_at: '2026-07-02T13:00:00.539734+00:00', scope: null, is_active: true,
    },
    {
      kind: 'weekly_all', group: 'weekly', percent: 11, severity: 'normal',
      resets_at: '2026-07-09T08:00:00.539755+00:00', scope: null, is_active: false,
    },
    {
      kind: 'weekly_scoped', group: 'weekly', percent: 22, severity: 'normal',
      resets_at: '2026-07-09T08:00:00.540080+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false,
    },
  ],
};

describe('parseClaudeOAuthUsageResponse', () => {
  it('parses the live limits[] schema (session / weekly_all / weekly_scoped)', () => {
    const snapshot = parseClaudeOAuthUsageResponse(LIVE_RESPONSE, NOW);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.fiveHour?.utilization).toBe(55);
    expect(snapshot?.fiveHour?.severity).toBe('normal');
    expect(snapshot?.fiveHour?.resetsAt).toBe(Math.floor(Date.parse('2026-07-02T13:00:00.539734+00:00') / 1000));
    expect(snapshot?.sevenDay?.utilization).toBe(11);
    expect(snapshot?.scoped).toHaveLength(1);
    expect(snapshot?.scoped?.[0]).toMatchObject({ modelDisplayName: 'Fable', utilization: 22 });
    expect(snapshot?.source).toBe('oauth-endpoint');
    expect(snapshot?.updatedAt).toBe(NOW);
    // extra_usage 未启用且无数值 → null
    expect(snapshot?.extraUsage).toBeNull();
  });

  it('falls back to legacy top-level keys when limits[] is absent', () => {
    const snapshot = parseClaudeOAuthUsageResponse({
      five_hour: { utilization: 33.5, resets_at: '2026-04-11T07:00:00Z' },
      seven_day: { utilization: 13.0, resets_at: '2026-04-14T07:00:00Z' },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 1.0, resets_at: '2026-04-14T07:00:00Z' },
    }, NOW);
    expect(snapshot?.fiveHour?.utilization).toBe(33.5);
    expect(snapshot?.sevenDay?.utilization).toBe(13);
    expect(snapshot?.scoped).toEqual([
      expect.objectContaining({ modelDisplayName: 'Sonnet', utilization: 1 }),
    ]);
  });

  it('parses legacy seven_day_fable top-level key into a Fable scoped window (#3244)', () => {
    // 旧 schema 兜底原先只列了 Opus/Sonnet,漏了 Fable,导致走旧端点或降级
    // 快照时 Fable 周限不显示(同环境 Opus/Sonnet 正常)。
    const snapshot = parseClaudeOAuthUsageResponse({
      five_hour: { utilization: 10, resets_at: '2026-04-11T07:00:00Z' },
      seven_day: { utilization: 13, resets_at: '2026-04-14T07:00:00Z' },
      seven_day_opus: { utilization: 5, resets_at: '2026-04-14T07:00:00Z' },
      seven_day_sonnet: { utilization: 1, resets_at: '2026-04-14T07:00:00Z' },
      seven_day_fable: { utilization: 87, resets_at: '2026-04-14T07:00:00Z' },
    }, NOW);
    expect(snapshot?.scoped).toEqual([
      expect.objectContaining({ modelDisplayName: 'Opus', utilization: 5 }),
      expect.objectContaining({ modelDisplayName: 'Sonnet', utilization: 1 }),
      expect.objectContaining({ modelDisplayName: 'Fable', utilization: 87 }),
    ]);
    // 匹配器也能命中这个 legacy Fable 窗口
    expect(
      matchScopedWindowForModel(snapshot?.scoped, 'claude-fable-5')?.utilization,
    ).toBe(87);
  });

  it('merges legacy per-family fallback when limits[] only covers some families (#3244 Codex P1)', () => {
    // 混合/降级响应:limits[] 的 weekly_scoped 只给了 Opus,Fable 仅通过顶层
    // seven_day_fable 下发。旧逻辑用 `scoped.length === 0` 整体门控,有 Opus 时整个
    // legacy 兜底被跳过,Fable 周限丢失。修复后按家族补(归属判定走共享 helper):
    // Opus 以 limits[] 为准(utilization 5、保留 severity),缺失的 Fable 从顶层键补入。
    const snapshot = parseClaudeOAuthUsageResponse({
      five_hour: { utilization: 10, resets_at: '2026-04-11T07:00:00Z' },
      seven_day: { utilization: 13, resets_at: '2026-04-14T07:00:00Z' },
      seven_day_fable: { utilization: 87, resets_at: '2026-04-14T07:00:00Z' },
      seven_day_opus: { utilization: 5, resets_at: '2026-04-14T07:00:00Z' },
      limits: [
        {
          kind: 'weekly_scoped', percent: 5, severity: 'normal',
          resets_at: '2026-04-14T07:00:00Z',
          scope: { model: { id: null, display_name: 'Opus' } },
        },
      ],
    }, NOW);
    expect(snapshot?.scoped).toEqual([
      expect.objectContaining({ modelDisplayName: 'Opus', utilization: 5, severity: 'normal' }),
      expect.objectContaining({ modelDisplayName: 'Fable', utilization: 87 }),
    ]);
    expect(
      matchScopedWindowForModel(snapshot?.scoped, 'claude-fable-5')?.utilization,
    ).toBe(87);
  });

  it('does not let a same-family legacy window override the limits[] scoped window', () => {
    // 去重以家族为单位:limits[] 已给 Fable(带 severity)时,顶层 seven_day_fable
    // 即使存在也不覆盖——limits[] 是权威全集。这里 Fable 的 limits[] 值 22、legacy 87,
    // 解析后必须保留 22 且只有一个 Fable 窗口。
    const snapshot = parseClaudeOAuthUsageResponse({
      five_hour: { utilization: 10, resets_at: '2026-04-11T07:00:00Z' },
      seven_day_fable: { utilization: 87, resets_at: '2026-04-14T07:00:00Z' },
      limits: [
        {
          kind: 'weekly_scoped', percent: 22, severity: 'warning',
          resets_at: '2026-04-14T07:00:00Z',
          scope: { model: { id: null, display_name: 'Claude Fable' } },
        },
      ],
    }, NOW);
    expect(snapshot?.scoped).toEqual([
      expect.objectContaining({ modelDisplayName: 'Claude Fable', utilization: 22, severity: 'warning' }),
    ]);
  });

  it('parses enabled extra usage', () => {
    const snapshot = parseClaudeOAuthUsageResponse({
      five_hour: { utilization: 10 },
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, utilization: 24.7 },
    }, NOW);
    expect(snapshot?.extraUsage).toEqual({
      isEnabled: true, utilization: 24.7, usedCredits: 1234, monthlyLimit: 5000,
    });
  });

  it('returns null for unparsable / windowless payloads', () => {
    expect(parseClaudeOAuthUsageResponse(null, NOW)).toBeNull();
    expect(parseClaudeOAuthUsageResponse('nope', NOW)).toBeNull();
    expect(parseClaudeOAuthUsageResponse({}, NOW)).toBeNull();
    // 教育版 / 组织托管订阅可能只有订阅通知、无数字配额 → 无窗口按无数据处理
    expect(parseClaudeOAuthUsageResponse({ five_hour: null, seven_day: null, limits: [] }, NOW)).toBeNull();
  });

  it('clamps out-of-range percent and skips malformed limit entries', () => {
    const snapshot = parseClaudeOAuthUsageResponse({
      limits: [
        { kind: 'session', percent: 250 },
        { kind: 'weekly_all', percent: 'not-a-number' },
        { kind: 'weekly_scoped', percent: 10, scope: { model: {} } },  // 无 display_name → 跳过
        'garbage',
      ],
    }, NOW);
    expect(snapshot?.fiveHour?.utilization).toBe(100);
    expect(snapshot?.sevenDay).toBeNull();
    expect(snapshot?.scoped).toEqual([]);
  });
});

describe('parseClaudeUnifiedRateLimitHeaders', () => {
  it('normalizes 0.0-1.0 fractional utilization to 0-100 percent', () => {
    const snapshot = parseClaudeUnifiedRateLimitHeaders({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.018416969696969696',
      'anthropic-ratelimit-unified-5h-reset': '1764554400',
      'anthropic-ratelimit-unified-7d-utilization': '0.7370692663445869',
      'anthropic-ratelimit-unified-7d-reset': '1764986400',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    }, NOW);
    expect(snapshot?.fiveHour?.utilization).toBeCloseTo(1.8417, 3);
    expect(snapshot?.fiveHour?.resetsAt).toBe(1764554400);
    expect(snapshot?.sevenDay?.utilization).toBeCloseTo(73.7069, 3);
    expect(snapshot?.rateLimitStatus).toBe('allowed');
    expect(snapshot?.representativeClaim).toBe('five_hour');
    expect(snapshot?.source).toBe('unified-headers');
  });

  it('returns null when no unified headers are present (gateway responses)', () => {
    expect(parseClaudeUnifiedRateLimitHeaders({ 'content-type': 'application/json' }, NOW)).toBeNull();
  });
});

describe('mergeClaudeSubscriptionUsageSnapshot', () => {
  const endpointSnapshot: ClaudeSubscriptionUsageSnapshot = {
    fiveHour: { utilization: 55, resetsAt: 1, severity: 'normal' },
    sevenDay: { utilization: 11, resetsAt: 2, severity: 'normal' },
    scoped: [{ utilization: 22, modelDisplayName: 'Fable', resetsAt: 2 }],
    subscriptionType: 'max',
    extraUsage: { isEnabled: false },
    source: 'oauth-endpoint',
    updatedAt: 100,
  };

  it('headers merge keeps endpoint-only fields (scoped / plan / extraUsage)', () => {
    const merged = mergeClaudeSubscriptionUsageSnapshot(endpointSnapshot, {
      fiveHour: { utilization: 60, resetsAt: 3 },
      sevenDay: null,
      rateLimitStatus: 'allowed_warning',
      source: 'unified-headers',
      updatedAt: 200,
    });
    expect(merged.fiveHour?.utilization).toBe(60);
    // headers 没给 7d → 保留 endpoint 的
    expect(merged.sevenDay?.utilization).toBe(11);
    expect(merged.scoped).toHaveLength(1);
    expect(merged.subscriptionType).toBe('max');
    expect(merged.extraUsage).toEqual({ isEnabled: false });
    expect(merged.rateLimitStatus).toBe('allowed_warning');
    expect(merged.updatedAt).toBe(200);
  });

  it('endpoint refresh replaces windows and drops stale headers-only status', () => {
    const withHeaders = mergeClaudeSubscriptionUsageSnapshot(endpointSnapshot, {
      fiveHour: { utilization: 99.99 },
      rateLimitStatus: 'rejected',
      source: 'unified-headers',
      updatedAt: 200,
    });
    const refreshed = mergeClaudeSubscriptionUsageSnapshot(withHeaders, {
      fiveHour: { utilization: 70, severity: 'warning' },
      sevenDay: { utilization: 15 },
      scoped: [],
      source: 'oauth-endpoint',
      updatedAt: 300,
    });
    expect(refreshed.fiveHour).toEqual({ utilization: 70, severity: 'warning' });
    expect(refreshed.scoped).toEqual([]);
    expect(refreshed.subscriptionType).toBe('max');
    // headers 的 rejected 是瞬时信号 —— 限额重置后无新直连响应时不得永久挂警示;
    // 真实限流会由下一次直连响应的 headers 重新带回。
    expect(refreshed.rateLimitStatus).toBeUndefined();
    expect(refreshed.updatedAt).toBe(300);
  });

  it('returns incoming as-is when there is no previous snapshot', () => {
    expect(mergeClaudeSubscriptionUsageSnapshot(null, endpointSnapshot)).toBe(endpointSnapshot);
  });

  it('discards all previous fields when account fingerprints conflict (account switch)', () => {
    // 换号窗口: prev 是账号 A 的全量快照, headers incoming 带账号 B 指纹 —— 不得把
    // A 的 scoped / subscriptionType / extraUsage 串给 B, incoming 即新起点。
    const prevA = { ...endpointSnapshot, accountFingerprint: 'fp-a' };
    const headersB: ClaudeSubscriptionUsageSnapshot = {
      fiveHour: { utilization: 5 },
      rateLimitStatus: 'allowed',
      source: 'unified-headers',
      accountFingerprint: 'fp-b',
      updatedAt: 500,
    };
    expect(mergeClaudeSubscriptionUsageSnapshot(prevA, headersB)).toBe(headersB);

    // endpoint incoming 指纹冲突同理: 不沿用 prev 的 subscriptionType 等兜底字段。
    const endpointB: ClaudeSubscriptionUsageSnapshot = {
      fiveHour: { utilization: 1 },
      scoped: [],
      source: 'oauth-endpoint',
      accountFingerprint: 'fp-b',
      updatedAt: 600,
    };
    const merged = mergeClaudeSubscriptionUsageSnapshot(prevA, endpointB);
    expect(merged).toBe(endpointB);
    expect(merged.subscriptionType).toBeUndefined();
  });
});

describe('claudeModelFamily / matchScopedWindowForModel', () => {
  it('extracts the family from model ids with routing suffixes', () => {
    expect(claudeModelFamily('claude-fable-5[1m]')).toBe('fable');
    expect(claudeModelFamily('claude-opus-4-8')).toBe('opus');
    expect(claudeModelFamily('sonnet')).toBe('sonnet');
    expect(claudeModelFamily('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(claudeModelFamily('gpt-5.5')).toBeNull();
    expect(claudeModelFamily(null)).toBeNull();
  });

  it('matches the scoped window for the current model and falls back to null', () => {
    const scoped = [
      { utilization: 22, modelDisplayName: 'Fable' },
      { utilization: 5, modelDisplayName: 'Opus' },
    ];
    expect(matchScopedWindowForModel(scoped, 'claude-fable-5[1m]')?.utilization).toBe(22);
    expect(matchScopedWindowForModel(scoped, 'claude-opus-4-8')?.utilization).toBe(5);
    expect(matchScopedWindowForModel(scoped, 'claude-sonnet-4-6')).toBeNull();
    expect(matchScopedWindowForModel(undefined, 'claude-fable-5')).toBeNull();
  });

  it('matches Fable scoped window across display_name variants (#3244)', () => {
    // 端点对 display_name 的口径历史上有 "Fable" / "Claude Fable" / "Fable 5"
    // 等形态;精确等于会把变体漏掉,导致 Fable 周限不显示而 Opus/Sonnet 正常。
    const scoped = [
      { utilization: 30, modelDisplayName: 'Claude Fable' },
      { utilization: 5, modelDisplayName: 'Opus' },
    ];
    expect(matchScopedWindowForModel(scoped, 'claude-fable-5')?.utilization).toBe(30);
    const scoped2 = [
      { utilization: 41, modelDisplayName: 'Fable 5' },
    ];
    expect(matchScopedWindowForModel(scoped2, 'claude-fable-5-20250101')?.utilization).toBe(41);
  });

  it('classifies a scoped window by its modelId when present (authoritative over displayName)', () => {
    // window.modelId 能经 claudeModelFamily 归类时优先用它:即使 displayName 不含家族名
    // 也能命中。
    const scoped = [
      { utilization: 30, modelDisplayName: 'Internal Label', modelId: 'claude-fable-5-20250101' },
    ];
    expect(matchScopedWindowForModel(scoped, 'claude-fable-5')?.utilization).toBe(30);
    // modelId 指向另一家族时以 modelId 为准,不回退 displayName(即使后者含子串也不跨家族误命中)
    const cross = [
      { utilization: 99, modelDisplayName: 'Fable-ish', modelId: 'claude-opus-4-8' },
    ];
    expect(matchScopedWindowForModel(cross, 'claude-fable-5')).toBeNull();
  });

  it('falls back to displayName variant matching when modelId is null or unrecognized', () => {
    // modelId 为 null → 回退 displayName 变体包含
    const noId = [
      { utilization: 30, modelDisplayName: 'Claude Fable', modelId: null },
    ];
    expect(matchScopedWindowForModel(noId, 'claude-fable-5')?.utilization).toBe(30);
    // modelId 存在但无法归类(不在已知家族表)→ 同样回退 displayName 变体
    const unknownId = [
      { utilization: 41, modelDisplayName: 'Fable 5', modelId: 'internal-fable-foo' },
    ];
    expect(matchScopedWindowForModel(unknownId, 'claude-fable-5')?.utilization).toBe(41);
  });
});

describe('isClaudeSubscriptionAlerting', () => {
  /**
   * 2026-07-25 实测快照:5h / 总周限都很宽裕,只有 Fable 的分模型周限 87% 且服务端
   * 给了 severity=warning。chip 上只显示 5h + 周限两段,所以这份数据只该让 Fable
   * 会话变红。
   */
  const SNAPSHOT: ClaudeSubscriptionUsageSnapshot = {
    fiveHour: { utilization: 10 },
    sevenDay: { utilization: 44 },
    scoped: [{ utilization: 87, severity: 'warning', modelDisplayName: 'Fable' }],
    rateLimitStatus: 'allowed',
    subscriptionType: 'max',
  };

  it('only alerts the model whose scoped weekly window is warning', () => {
    expect(isClaudeSubscriptionAlerting(SNAPSHOT, 'claude-fable-5[1m]')).toBe(true);
    // 跑 Opus / Sonnet 的会话不受 Fable 周限影响 —— chip 上也没有那一段, 不能染红
    expect(isClaudeSubscriptionAlerting(SNAPSHOT, 'claude-opus-5[1m]')).toBe(false);
    expect(isClaudeSubscriptionAlerting(SNAPSHOT, 'claude-sonnet-5')).toBe(false);
    // 家族识别不出来时回退总周限(44%,不告警)
    expect(isClaudeSubscriptionAlerting(SNAPSHOT, null)).toBe(false);
    expect(isClaudeSubscriptionAlerting(null, 'claude-fable-5')).toBe(false);
  });

  it('ignores allowed_warning but honors rejected', () => {
    // allowed_warning 是服务端综合全部窗口(含其它模型周限)的模糊信号:chip 只显示
    // 5h + 周限, 拿它染红会出现「剩余 91% / 56% 却是红的」
    expect(isClaudeSubscriptionAlerting(
      { ...SNAPSHOT, rateLimitStatus: 'allowed_warning' },
      'claude-opus-5[1m]',
    )).toBe(false);
    // 真限流(请求已被拒)与当前模型无关, 一律告警
    expect(isClaudeSubscriptionAlerting(
      { ...SNAPSHOT, rateLimitStatus: 'rejected' },
      'claude-opus-5[1m]',
    )).toBe(true);
    expect(isClaudeSubscriptionAlerting(
      { ...SNAPSHOT, rateLimitStatus: 'REJECTED ' },
      'claude-opus-5[1m]',
    )).toBe(true);
  });

  it('alerts on exhausted or non-normal session-scope windows', () => {
    // 打满(headers 源不带 severity, 只能靠 utilization)
    expect(isClaudeSubscriptionAlerting(
      { fiveHour: { utilization: 100 } },
      'claude-opus-5',
    )).toBe(true);
    // 总周限 severity 非 normal —— 所有模型共用, 与当前模型无关
    expect(isClaudeSubscriptionAlerting(
      { sevenDay: { utilization: 80, severity: 'warning' } },
      'claude-opus-5',
    )).toBe(true);
    // 水位远未见底且 severity=normal → 不告警
    expect(isClaudeSubscriptionAlerting(
      { fiveHour: { utilization: 60, severity: 'normal' }, sevenDay: { utilization: 44 } },
      'claude-opus-5',
    )).toBe(false);
  });

  it('alerts when a displayed window runs down to the last 10%', () => {
    // unified-headers 源不带 per-window severity, 只有 utilization: 光靠「打满」会让
    // chip 一直到 99.95% 才变红。剩余 ≤10% 即告警, 判据是 chip 上正在显示的那个数字。
    expect(isClaudeSubscriptionAlerting({ fiveHour: { utilization: 90 } }, 'claude-opus-5'))
      .toBe(true);
    expect(isClaudeSubscriptionAlerting({ sevenDay: { utilization: 92 } }, 'claude-opus-5'))
      .toBe(true);
    // 水位判定优先于服务端 severity: 只剩 5% 时说 normal 也照样提醒
    expect(isClaudeSubscriptionAlerting(
      { fiveHour: { utilization: 95, severity: 'normal' } },
      'claude-opus-5',
    )).toBe(true);
    // 阈值下方不告警(89% 已用 = 剩余 11%)
    expect(isClaudeSubscriptionAlerting({ fiveHour: { utilization: 89 } }, 'claude-opus-5'))
      .toBe(false);
    // 其它模型的 scoped 窗口即使见底也不染红当前会话 —— 与阈值无关
    expect(isClaudeSubscriptionAlerting(
      { fiveHour: { utilization: 10 }, scoped: [{ utilization: 99, modelDisplayName: 'Fable' }] },
      'claude-opus-5',
    )).toBe(false);
  });

  it('hasAlertingClaudeSessionWindow excludes the overall status signal', () => {
    // tooltip 用它 + status 分流, chip 用 isClaudeSubscriptionAlerting; 窗口维度本身
    // 不看 status(rejected 也不例外)
    expect(hasAlertingClaudeSessionWindow(
      { ...SNAPSHOT, rateLimitStatus: 'rejected' },
      'claude-opus-5[1m]',
    )).toBe(false);
    expect(hasAlertingClaudeSessionWindow(SNAPSHOT, 'claude-fable-5[1m]')).toBe(true);
    expect(isClaudeUsageWindowAlerting(undefined)).toBe(false);
    expect(isClaudeUsageWindowAlerting({ utilization: 87, severity: 'warning' })).toBe(true);
  });

  it('ignores non-finite utilization instead of treating it as exhausted', () => {
    // 持久化快照是 JSON.parse 后直接断言的, 不重新校验字段: 脏值不能被 clampPercent
    // 夹成 100 而误判额度耗尽。severity 缺失时一律不告警。
    expect(isClaudeUsageWindowAlerting({ utilization: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isClaudeUsageWindowAlerting({ utilization: Number.NaN })).toBe(false);
    expect(isClaudeSubscriptionAlerting(
      { fiveHour: { utilization: Number.POSITIVE_INFINITY } },
      'claude-opus-5',
    )).toBe(false);
    // 脏 utilization 不影响 severity 这条独立判据
    expect(isClaudeUsageWindowAlerting({ utilization: Number.NaN, severity: 'warning' }))
      .toBe(true);
  });
});

describe('fetchClaudeSubscriptionUsageSnapshot', () => {
  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }

  it('sends bearer + oauth beta + claude-code UA and returns a parsed snapshot', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, LIVE_RESPONSE));
    const result = await fetchClaudeSubscriptionUsageSnapshot({
      accessToken: 'sk-ant-oat01-test',
      subscriptionType: 'max',
      claudeCodeVersion: '2.1.186',
      fetchFn,
      now: NOW,
    });
    const snapshot = typeof result === 'object' ? result : null;
    expect(snapshot).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-ant-oat01-test',
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/2.1.186',
        }),
      }),
    );
    expect(snapshot?.fiveHour?.utilization).toBe(55);
    expect(snapshot?.subscriptionType).toBe('max');
  });

  it('throws Unauthorized on 401 and RateLimited on 429', async () => {
    await expect(fetchClaudeSubscriptionUsageSnapshot({
      accessToken: 't', fetchFn: vi.fn().mockResolvedValue(jsonResponse(401, {})),
    })).rejects.toBeInstanceOf(ClaudeSubscriptionUsageUnauthorizedError);
    await expect(fetchClaudeSubscriptionUsageSnapshot({
      accessToken: 't', fetchFn: vi.fn().mockResolvedValue(jsonResponse(429, {})),
    })).rejects.toBeInstanceOf(ClaudeSubscriptionUsageRateLimitedError);
  });

  it('returns null on transport failures but explicit empty on parsable-window-less 2xx', async () => {
    // 网络失败 → null (保留缓存下轮再试)
    await expect(fetchClaudeSubscriptionUsageSnapshot({
      accessToken: 't', fetchFn: vi.fn().mockResolvedValue(jsonResponse(500, {})),
    })).resolves.toBeNull();
    await expect(fetchClaudeSubscriptionUsageSnapshot({
      accessToken: 't', fetchFn: vi.fn().mockRejectedValue(new Error('offline')),
    })).resolves.toBeNull();
    // 端点成功但无可解析窗口 (教育版 / schema 变化) → 'empty' (调用方清缓存降级)
    await expect(fetchClaudeSubscriptionUsageSnapshot({
      accessToken: 't', fetchFn: vi.fn().mockResolvedValue(jsonResponse(200, { limits: [] })),
    })).resolves.toBe('empty');
  });
});
