import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CODEX_DEFAULT_LIMIT_BUCKET,
  codexLimitBucketKey,
  isCodexBucketStale,
  nextCodexBucketStaleAtMs,
  matchCodexBucketForModel,
  mergeCodexAccountUsageSnapshot,
  splitCodexAccountUsagePayload,
} from '@/hooks/useAccountUsage';

describe('mergeCodexAccountUsageSnapshot', () => {
  it('preserves the last known credit balance when a later snapshot omits credits', () => {
    const previous = {
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: '12.5',
      },
      planType: 'pro',
    };

    const merged = mergeCodexAccountUsageSnapshot(previous, {
      primary: { usedPercent: 24 },
    });

    expect(merged.credits).toEqual(previous.credits);
    expect(merged.planType).toBe('pro');
    expect(merged.primary?.usedPercent).toBe(24);
  });

  it('keeps a previous balance for partial positive credit snapshots', () => {
    const merged = mergeCodexAccountUsageSnapshot(
      {
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: '8',
        },
      },
      {
        credits: {
          hasCredits: true,
          unlimited: false,
        },
      },
    );

    expect(merged.credits?.balance).toBe('8');
  });

  it('does not keep a stale balance when credits are explicitly depleted', () => {
    const merged = mergeCodexAccountUsageSnapshot(
      {
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: '8',
        },
      },
      {
        credits: {
          hasCredits: false,
          unlimited: false,
        },
      },
    );

    expect(merged.credits?.balance).toBeUndefined();
    expect(merged.credits?.hasCredits).toBe(false);
  });

  it('keeps OpenAI web usage windows when app-server later reports zero windows', () => {
    const merged = mergeCodexAccountUsageSnapshot(
      {
        source: 'openai-web',
        primary: { usedPercent: 19, windowMinutes: 300, resetsAt: 1781425380 },
        secondary: { usedPercent: 23, windowMinutes: 10080, resetsAt: 1781755297 },
        credits: { hasCredits: true, unlimited: false, balance: '3545' },
        planType: 'pro',
      },
      {
        primary: { usedPercent: 0, resetsAt: 1781434172 },
        secondary: { usedPercent: 0, resetsAt: 1782020972 },
        credits: { hasCredits: false, unlimited: false, balance: null },
        planType: null,
      },
    );

    expect(merged.primary?.usedPercent).toBe(19);
    expect(merged.secondary?.usedPercent).toBe(23);
    expect(merged.credits?.balance).toBe('3545');
    expect(merged.planType).toBe('pro');
    expect(merged.source).toBe('openai-web');
  });

  it('uses fresh app-server windows when a later snapshot reports a reached limit', () => {
    const merged = mergeCodexAccountUsageSnapshot(
      {
        source: 'openai-web',
        primary: { usedPercent: 19, windowMinutes: 300, resetsAt: 1781425380 },
        secondary: { usedPercent: 23, windowMinutes: 10080, resetsAt: 1781755297 },
        credits: { hasCredits: true, unlimited: false, balance: '3545' },
        planType: 'pro',
      },
      {
        primary: { usedPercent: 100, resetsAt: 1781434172 },
        secondary: { usedPercent: 100, resetsAt: 1782020972 },
        rateLimitReachedType: 'rate_limit_reached',
      },
    );

    expect(merged.primary?.usedPercent).toBe(100);
    expect(merged.secondary?.usedPercent).toBe(100);
    expect(merged.rateLimitReachedType).toBe('rate_limit_reached');
  });

  it('uses fresh app-server windows when a later snapshot reports normal usage', () => {
    const merged = mergeCodexAccountUsageSnapshot(
      {
        source: 'openai-web',
        primary: { usedPercent: 19, windowMinutes: 300, resetsAt: 1781425380 },
        secondary: { usedPercent: 23, windowMinutes: 10080, resetsAt: 1781755297 },
        credits: { hasCredits: true, unlimited: false, balance: '3545' },
        planType: 'pro',
      },
      {
        primary: { usedPercent: 27, resetsAt: 1781434172 },
        secondary: { usedPercent: 31, resetsAt: 1782020972 },
      },
    );

    expect(merged.primary?.usedPercent).toBe(27);
    expect(merged.secondary?.usedPercent).toBe(31);
    expect(merged.credits?.balance).toBe('3545');
    expect(merged.source).toBe('codex-app-server');
  });

  it('keeps previous windows when Codex app-server reports a windowless placeholder', () => {
    const merged = mergeCodexAccountUsageSnapshot(
      {
        source: 'codex-app-server',
        limitId: 'codex_bengalfox',
        limitName: 'GPT-5.3-Codex-Spark',
        primary: { usedPercent: 7, windowMinutes: 300, resetsAt: 1782320161 },
        secondary: { usedPercent: 32, windowMinutes: 10080, resetsAt: 1782737603 },
        credits: { hasCredits: false, unlimited: false, balance: null },
      },
      {
        limitId: 'codex',
        limitName: null,
        primary: null,
        secondary: null,
        credits: null,
        planType: null,
        rateLimitReachedType: null,
      },
    );

    expect(merged.primary?.usedPercent).toBe(7);
    expect(merged.secondary?.usedPercent).toBe(32);
    expect(merged.limitId).toBe('codex');
    expect(merged.source).toBe('codex-app-server');
  });

  it('keeps OpenAI web fields when a later app-server placeholder has no windows', () => {
    const merged = mergeCodexAccountUsageSnapshot(
      {
        source: 'openai-web',
        primary: { usedPercent: 19, windowMinutes: 300, resetsAt: 1781425380 },
        secondary: { usedPercent: 23, windowMinutes: 10080, resetsAt: 1781755297 },
        credits: { hasCredits: true, unlimited: false, balance: '3545' },
        planType: 'pro',
      },
      {
        limitId: 'codex',
        primary: null,
        secondary: null,
        credits: { hasCredits: false, unlimited: false, balance: null },
        planType: null,
        rateLimitReachedType: null,
      },
    );

    expect(merged.primary?.usedPercent).toBe(19);
    expect(merged.secondary?.usedPercent).toBe(23);
    expect(merged.credits?.balance).toBe('3545');
    expect(merged.planType).toBe('pro');
    expect(merged.source).toBe('openai-web');
  });

  it('wires refreshed Codex web snapshots through a renderer IPC channel', () => {
    const mainSource = readFileSync(
      new URL('../../main/usageBroadcaster.ts', import.meta.url),
      'utf8',
    );
    const preloadSource = readFileSync(
      new URL('../../preload/preload.ts', import.meta.url),
      'utf8',
    );
    const hookSource = readFileSync(new URL('../hooks/useAccountUsage.ts', import.meta.url), 'utf8');

    expect(mainSource).toContain("USAGE_CODEX_ACCOUNT_CHANGED = 'usage:codex-account-changed'");
    expect(mainSource).toContain('broadcastCodexAccountUsage(payload);');
    expect(mainSource).toContain('isCodexZeroWindowFallback(incoming)');
    expect(mainSource).toContain('isCodexWindowlessFallback(incoming)');
    expect(mainSource).toContain('broadcastCodexAccountUsage(null);');
    expect(preloadSource).toContain("createIpcFanOut('usage:codex-account-changed')");
    expect(preloadSource).toContain('onCodexAccountChanged: fanOutMakerUsageCodexAccount');
    expect(hookSource).toContain('api.onCodexAccountChanged');
    expect(hookSource).toContain('options: { clearOnNull?: boolean } = {}');
    expect(hookSource).toContain('selectCodexSlot(quotaSource');
    // 按来源分槽: 两个数据源不得互相覆盖(main / renderer 双份实现同口径)
    expect(mainSource).toContain('function splitPersistedCodexAccountUsage(');
    expect(mainSource).toContain("incoming.source === 'openai-web'");
    expect(hookSource).toContain('function splitCodexAccountUsagePayload(');
    // CLI turn 事件后不再拉 getAccount 触发 WHAM 刷新 (CLI chip 不显示 web 槽,
    // 白耗后台请求; review 反馈) —— bridge 槽保鲜走 main 的 bridge turn-done
    // 触发 + mount 读 + 悬念期催刷
    expect(hookSource).not.toContain('refreshWebUsage');
    // module 常驻订阅的安装行为由下方 'module subscription install' 行为测试
    // 覆盖 (renderToString 挂真 hook), 不再用脆弱的源码字符串断言 (review 反馈)。
    expect(hookSource).toContain('function ensureModuleSubscription(');
    // web-only 组合 payload 上浮归属字段, WHAM reader 的 accountId 归属判断不失配
    expect(mainSource).toContain('accountId: web.accountId');
  });
});

describe('splitCodexAccountUsagePayload', () => {
  it('routes combined payloads into per-source slots', () => {
    const parts = splitCodexAccountUsagePayload({
      limitId: 'codex',
      primary: { usedPercent: 82 },
      source: 'codex-app-server',
      webSnapshot: { primary: { usedPercent: 0 }, source: 'openai-web' },
    } as never);
    expect(parts.appServer?.primary?.usedPercent).toBe(82);
    expect((parts.appServer as { webSnapshot?: unknown } | undefined)?.webSnapshot)
      .toBeUndefined();
    expect(parts.web?.primary?.usedPercent).toBe(0);
  });

  it('routes bare snapshots by their source field (per-turn events vs WHAM)', () => {
    expect(splitCodexAccountUsagePayload({
      primary: { usedPercent: 40 },
      source: 'codex-app-server',
    }).appServer?.primary?.usedPercent).toBe(40);
    expect(splitCodexAccountUsagePayload({
      primary: { usedPercent: 5 },
      source: 'openai-web',
    }).web?.primary?.usedPercent).toBe(5);
  });

  it('treats combined payloads as authoritative: empty slots clear explicitly', () => {
    // web-only 组合 payload: app 槽显式清空(null), 不是「未携带」—— 否则换号 /
    // 切形态后旧 app 槽数据一直挂着 (review 反馈)
    const webOnly = splitCodexAccountUsagePayload({
      accountId: 'acc-2',
      webSnapshot: { primary: { usedPercent: 5 }, source: 'openai-web' },
    } as never);
    expect(webOnly.appServer).toBeNull();
    expect(webOnly.web?.primary?.usedPercent).toBe(5);
    // app-only 组合 payload (webSnapshot: null): web 槽显式清空
    const appOnly = splitCodexAccountUsagePayload({
      primary: { usedPercent: 82 },
      source: 'codex-app-server',
      webSnapshot: null,
    } as never);
    expect(appOnly.appServer?.primary?.usedPercent).toBe(82);
    expect(appOnly.web).toBeNull();
    // 裸快照是增量: 只携带自己的槽, 另一个槽键缺失(保留现值)
    const bare = splitCodexAccountUsagePayload({
      primary: { usedPercent: 40 },
      source: 'codex-app-server',
    });
    expect('web' in bare).toBe(false);
  });
});

describe('module subscription install (behavior)', () => {
  // 真行为测试 (review 反馈: 源码字符串断言验不出等价重构 / 回归):
  // ensureModuleSubscription 在 hook render 阶段安装, renderToString 即可驱动
  // (不需要 effects / jsdom)。stub window.electronAPI 统计注册次数。
  it('installs the codex usage listener once, and only for codex sessions', async () => {
    const listeners: unknown[] = [];
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        maker: {
          usage: {
            onCodexAccountChanged: (cb: unknown) => {
              listeners.push(cb);
              return () => {};
            },
          },
        },
      },
    };
    try {
      const { resetModules } = await import('vitest').then((m) => ({ resetModules: m.vi.resetModules }));
      resetModules();
      const [{ useAccountUsage: freshUseAccountUsage }, { renderToString }, React] =
        await Promise.all([
          import('@/hooks/useAccountUsage'),
          import('react-dom/server'),
          import('react'),
        ]);
      function Probe({ vendor }: { vendor?: 'cc' | 'codex' }) {
        freshUseAccountUsage(undefined, vendor);
        return null;
      }
      // 非 codex 会话: 不注册
      renderToString(React.createElement(Probe, { vendor: 'cc' }));
      renderToString(React.createElement(Probe, {}));
      expect(listeners.length).toBe(0);
      // 首个 codex 会话: 注册一次
      renderToString(React.createElement(Probe, { vendor: 'codex' }));
      expect(listeners.length).toBe(1);
      // 幂等: 再挂 codex 实例不重复注册
      renderToString(React.createElement(Probe, { vendor: 'codex' }));
      expect(listeners.length).toBe(1);
    } finally {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
  });
});

describe('codex limit bucket isolation', () => {
  // 2026-07-25 用户实报: gpt-5.6-sol 会话的 chip 显示 codex_bengalfox /
  // GPT-5.3-Codex-Spark 桶的「8天 剩余 100%」。app-server 每次只推一个桶,
  // 不按 limitId 隔离就会串桶。
  const SPARK_BUCKET = {
    limitId: 'codex_bengalfox',
    limitName: 'GPT-5.3-Codex-Spark',
    primary: { usedPercent: 0, windowMinutes: 10080, resetsAt: 1785548762 },
    source: 'codex-app-server',
  };
  const MAIN_BUCKET = {
    limitId: 'codex',
    primary: { usedPercent: 63, windowMinutes: 300, resetsAt: 1785440000 },
    secondary: { usedPercent: 41, windowMinutes: 10080, resetsAt: 1785900000 },
    source: 'codex-app-server',
  };

  it('derives a stable bucket key, defaulting when limitId is absent', () => {
    expect(codexLimitBucketKey(SPARK_BUCKET)).toBe('codex_bengalfox');
    expect(codexLimitBucketKey(MAIN_BUCKET)).toBe('codex');
    expect(codexLimitBucketKey({ primary: { usedPercent: 3 } })).toBe(CODEX_DEFAULT_LIMIT_BUCKET);
    expect(codexLimitBucketKey(null)).toBe(CODEX_DEFAULT_LIMIT_BUCKET);
    expect(codexLimitBucketKey({ limitId: '' })).toBe(CODEX_DEFAULT_LIMIT_BUCKET);
  });

  it('keeps a combined payload bucket table separate from the top-level slot', () => {
    const parts = splitCodexAccountUsagePayload({
      ...MAIN_BUCKET,
      appServerBuckets: {
        codex: MAIN_BUCKET,
        codex_bengalfox: SPARK_BUCKET,
      },
      webSnapshot: null,
    } as never);
    expect(parts.appServer?.limitId).toBe('codex');
    expect(Object.keys(parts.appServerBuckets ?? {}).sort()).toEqual(['codex', 'codex_bengalfox']);
    // Spark 桶原样保留在表里, 不与主桶合并成杂交体
    expect(parts.appServerBuckets?.codex_bengalfox?.primary?.usedPercent).toBe(0);
    expect(parts.appServerBuckets?.codex?.primary?.usedPercent).toBe(63);
  });

  it('drops malformed bucket entries instead of caching them', () => {
    const parts = splitCodexAccountUsagePayload({
      ...MAIN_BUCKET,
      appServerBuckets: { codex: MAIN_BUCKET, broken: [], alsoBroken: 'nope' },
      webSnapshot: null,
    } as never);
    const table = parts.appServerBuckets ?? {};
    expect(Object.keys(table)).toEqual(['codex']);
    // Object.keys 看不到原型污染 —— 显式断言注入值没经原型链泄漏出来。
    // sanitize 用 null 原型对象兜底, 顺带断言全局 Object.prototype 未被污染。
    expect((table as Record<string, unknown>).limitId).toBeUndefined();
    expect(Object.getPrototypeOf(table)).toBeNull();
    expect(({} as Record<string, unknown>).limitId).toBeUndefined();
  });
});

describe('matchCodexBucketForModel', () => {
  // 会话归属**不能**用 account_usage 事件判定(账号级 fan-out, 见 hook 注释),
  // 必须按当前会话模型匹配桶。
  const MAIN = { limitId: 'codex', primary: { usedPercent: 63 } };
  const SPARK = {
    limitId: 'codex_bengalfox',
    limitName: 'GPT-5.3-Codex-Spark',
    primary: { usedPercent: 0 },
  };
  const buckets = { codex: MAIN, codex_bengalfox: SPARK };

  it('matches a model-scoped bucket by its limitName', () => {
    expect(matchCodexBucketForModel(buckets, 'gpt-5.3-codex-spark')).toBe(SPARK);
    expect(matchCodexBucketForModel(buckets, 'GPT-5.3-Codex-Spark')).toBe(SPARK);
  });

  it('falls back to the generic bucket for unrelated models', () => {
    // 用户实报场景: gpt-5.6-sol 绝不能拿到 Spark 桶
    expect(matchCodexBucketForModel(buckets, 'gpt-5.6-sol')).toBe(MAIN);
    expect(matchCodexBucketForModel(buckets, 'gpt-5.4')).toBe(MAIN);
    expect(matchCodexBucketForModel(buckets, null)).toBe(MAIN);
  });

  it('returns null when no generic bucket exists (caller falls back)', () => {
    expect(matchCodexBucketForModel({ codex_bengalfox: SPARK }, 'gpt-5.6-sol')).toBeNull();
    expect(matchCodexBucketForModel({}, 'gpt-5.6-sol')).toBeNull();
  });
});

describe('bucket key safety and authoritative top-level slot', () => {
  it('never returns prototype-polluting bucket keys', () => {
    expect(codexLimitBucketKey({ limitId: '__proto__' })).toBe(CODEX_DEFAULT_LIMIT_BUCKET);
    expect(codexLimitBucketKey({ limitId: 'constructor' })).toBe(CODEX_DEFAULT_LIMIT_BUCKET);
    expect(codexLimitBucketKey({ limitId: 'prototype' })).toBe(CODEX_DEFAULT_LIMIT_BUCKET);
  });

  it('marks combined payloads authoritative so the top-level slot is replaced, not merged', () => {
    // 跨桶 merge 会造出「B 的 limitId + A 的窗口」杂交体(windowless 兜底保留旧窗口),
    // 冷启动会话回退顶层时显示错桶数据(review 反馈)。组合 payload 必须直接替换。
    const hookSource = readFileSync(new URL('../hooks/useAccountUsage.ts', import.meta.url), 'utf8');
    expect(hookSource).toContain("const isAuthoritative = 'appServerBuckets' in parts;");
    expect(hookSource).toContain('? parts.appServer');
  });

  it('drops prototype-polluting keys from a combined payload bucket table', () => {
    const parts = splitCodexAccountUsagePayload({
      limitId: 'codex',
      primary: { usedPercent: 5 },
      appServerBuckets: { codex: { limitId: 'codex' }, __proto__: { limitId: 'evil' } },
      webSnapshot: null,
    } as never);
    expect(Object.keys(parts.appServerBuckets ?? {})).toEqual(['codex']);
  });
});

describe('bucket selection safety (review follow-up)', () => {
  const SPARK = {
    limitId: 'codex_bengalfox',
    limitName: 'GPT-5.3-Codex-Spark',
    primary: { usedPercent: 0, windowMinutes: 10_080, resetsAt: 4_100_000_000 },
  };
  const MAIN = {
    limitId: 'codex',
    primary: { usedPercent: 63, windowMinutes: 300, resetsAt: 4_100_000_000 },
  };
  const NOW = 1_785_000_000_000;

  it('returns null rather than a mismatched model bucket', () => {
    // 旧格式水合只有 Spark 桶时, gpt-5.6-sol 必须什么都不显示, 而不是显示 Spark
    expect(matchCodexBucketForModel({ codex_bengalfox: SPARK }, 'gpt-5.6-sol', NOW)).toBeNull();
  });

  it('identifies the generic bucket by its stable key, not by a missing limitName', () => {
    // 同桶 merge 遇到省略 limitName 的部分通知 → 名字丢了, 但它仍是 Spark 桶
    const namelessSpark = { ...SPARK, limitName: undefined };
    const buckets = { codex_bengalfox: namelessSpark, codex: MAIN };
    expect(matchCodexBucketForModel(buckets, 'gpt-5.6-sol', NOW)).toBe(MAIN);
  });

  it('skips stale buckets whose windows all expired long ago', () => {
    const expiredSpark = {
      ...SPARK,
      primary: { usedPercent: 0, windowMinutes: 10_080, resetsAt: 1_700_000_000 },
    };
    expect(isCodexBucketStale(expiredSpark, NOW)).toBe(true);
    expect(isCodexBucketStale(MAIN, NOW)).toBe(false);
    // 促销结束后的过期 Spark 桶不再被同名模型选中
    expect(matchCodexBucketForModel({ codex_bengalfox: expiredSpark }, 'gpt-5.3-codex-spark', NOW))
      .toBeNull();
  });

  it('does not treat window-less or reset-less buckets as stale', () => {
    const windowless = { limitId: 'codex' };
    const resetless = { limitId: 'codex', primary: { usedPercent: 5 } };
    expect(isCodexBucketStale(windowless, NOW)).toBe(false);
    expect(isCodexBucketStale(resetless, NOW)).toBe(false);
    // 只有部分窗口带 resetsAt 时不得判陈旧(review 反馈): 缺时间戳的周窗口可能仍有效
    const partialTimestamps = {
      limitId: 'codex_bengalfox',
      primary: { usedPercent: 100, resetsAt: 1_700_000_000 },
      secondary: { usedPercent: 40 },
    };
    expect(isCodexBucketStale(partialTimestamps, NOW)).toBe(false);
  });

  it('keeps identity metadata when a later partial snapshot omits it', () => {
    const merged = mergeCodexAccountUsageSnapshot(SPARK, {
      primary: { usedPercent: 12, windowMinutes: 10_080, resetsAt: 4_100_000_000 },
    });
    expect(merged.limitId).toBe('codex_bengalfox');
    expect(merged.limitName).toBe('GPT-5.3-Codex-Spark');
  });
});

describe('nextCodexBucketStaleAtMs', () => {
  const NOW = 1_785_000_000_000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const resetsAtSec = (offsetMs: number) => Math.floor((NOW + offsetMs) / 1000);

  it('returns the soonest upcoming stale moment (reset + 24h grace)', () => {
    const soon = { limitId: 'codex_bengalfox', primary: { usedPercent: 0, resetsAt: resetsAtSec(60_000) } };
    const later = { limitId: 'codex', primary: { usedPercent: 30, resetsAt: resetsAtSec(10 * 60_000) } };
    const staleAt = nextCodexBucketStaleAtMs({ a: soon, b: later }, NOW);
    expect(staleAt).toBe(resetsAtSec(60_000) * 1000 + DAY_MS);
  });

  it('ignores already-stale buckets and reset-less windows', () => {
    const alreadyStale = { limitId: 'x', primary: { usedPercent: 0, resetsAt: resetsAtSec(-3 * DAY_MS) } };
    const resetless = { limitId: 'y', primary: { usedPercent: 10 } };
    expect(nextCodexBucketStaleAtMs({ a: alreadyStale }, NOW)).toBeNull();
    expect(nextCodexBucketStaleAtMs({ b: resetless }, NOW)).toBeNull();
    expect(nextCodexBucketStaleAtMs({}, NOW)).toBeNull();
  });

  it('skips buckets where only some windows carry a timestamp', () => {
    // 与 isCodexBucketStale 同口径: 这类桶永不进入陈旧, 不需要定时重选
    const partial = {
      limitId: 'z',
      primary: { usedPercent: 10, resetsAt: resetsAtSec(60_000) },
      secondary: { usedPercent: 20 },
    };
    expect(nextCodexBucketStaleAtMs({ z: partial }, NOW)).toBeNull();
  });
});

describe('bucket table keeps a null prototype across incremental updates', () => {
  it('never re-attaches Object.prototype when merging a turn event bucket', () => {
    // sanitize 建立 null 原型后, 增量写入若用对象字面量 spread 会把原型换回来,
    // 削弱防御(review 反馈)。这里用源码断言锁定实现选择。
    const hookSource = readFileSync(new URL('../hooks/useAccountUsage.ts', import.meta.url), 'utf8');
    expect(hookSource).toContain('function emptyBucketTable(');
    expect(hookSource).toContain('function withCodexBucket(');
    // 增量分支不得再出现桶表字面量 spread
    expect(hookSource).not.toContain('...lastCodexAccountUsage.appServerBuckets,');
    expect(hookSource).not.toContain('appServerBuckets: {}');
  });
});

describe('renderer sparse update bucket routing', () => {
  it('routes id-less sparse updates to the latest bucket, mirroring main', () => {
    // main 侧已按 app-server 契约把缺 limitId 的稀疏更新并入最近观察到的桶;
    // renderer 增量路径若仍按缺省桶归类, 模型专属窗口会被当通用桶暴露给其它
    // 会话(review 反馈)。这里锁定实现选择。
    const hookSource = readFileSync(new URL('../hooks/useAccountUsage.ts', import.meta.url), 'utf8');
    expect(hookSource).toContain('let lastCodexAppServerBucketKey: string | null = null;');
    expect(hookSource).toContain('function resolveIncrementalBucketKey(');
    expect(hookSource).toContain('return lastCodexAppServerBucketKey ?? codexLimitBucketKey(incoming);');
    // 增量分支必须走 resolveIncrementalBucketKey, 不能直接用 codexLimitBucketKey
    expect(hookSource).toContain('resolveIncrementalBucketKey(parts.appServer),');
    expect(hookSource).not.toContain('codexLimitBucketKey(parts.appServer),\n              parts.appServer,');
  });
});
