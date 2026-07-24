import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
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
    expect(hookSource).toContain('() => setSnapshot(selectCodexSlot(quotaSource))');
    // 按来源分槽: 两个数据源不得互相覆盖(main / renderer 双份实现同口径)
    expect(mainSource).toContain('function splitPersistedCodexAccountUsage(');
    expect(mainSource).toContain("incoming.source === 'openai-web'");
    expect(hookSource).toContain('function splitCodexAccountUsagePayload(');
    // CLI turn 事件后不再拉 getAccount 触发 WHAM 刷新 (CLI chip 不显示 web 槽,
    // 白耗后台请求; review 反馈) —— bridge 槽保鲜走 main 的 bridge turn-done
    // 触发 + mount 读 + 悬念期催刷
    expect(hookSource).not.toContain('refreshWebUsage');
    // module 常驻订阅: chip 全部卸载期间的换号清空广播不丢 (与 claude hook 同语义)
    expect(hookSource).toContain('function ensureModuleSubscription(');
    expect(hookSource).toContain('ensureModuleSubscription();');
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
