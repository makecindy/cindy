/**
 * TodaySpendChip source-level contract tests.
 *
 * The component itself depends on Electron globals and renderer hooks, so this
 * pins the small routing contract in the Node vitest environment.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TFunction } from 'i18next';
import {
  formatClaudeSubscriptionPlanLabel,
  formatCodexPlanLabel,
} from '../lib/subscriptionPlanLabel';
import {
  buildClaudeUsageCard,
  buildCodexUsageCard,
  buildXaiUsageCard,
} from '../components/status/usageCardModel';

const compact = (value: string) => value.replace(/\s+/g, '');
const sourcePath = resolve(__dirname, '..', 'components', 'status', 'TodaySpendChip.tsx');
// Windows CRLF 检出下 \n 字面量断言会失配,统一归一化成 LF 再断言。
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
describe('TodaySpendChip dashboard routing', () => {
  it('routes Codex/CC/Pi subscription providers to their account usage pages and keeps gateway routes local', () => {
    expect(compact(source)).toContain(compact('https://chatgpt.com/codex/settings/usage'));
    expect(compact(source)).toContain(compact('https://grok.com'));
    expect(compact(source)).toContain(compact('https://claude.ai/settings/usage'));
    // 网关 / 托管账号这一路 URL 落到 null(点击无跳转);其余三路指向各自公开看板。
    expect(source).toMatch(
      /usesXaiQuotaForm\s*\?\s*XAI_USAGE_DASHBOARD_URL\s*:\s*isCodexOauth \|\| isChatgptBridge\s*\?\s*CODEX_USAGE_DASHBOARD_URL\s*:\s*isClaudeSubscription\s*\?\s*CLAUDE_USAGE_DASHBOARD_URL\s*:\s*null/,
    );
    expect(compact(source)).toContain(compact('todaySpend.openCodexUsage'));
    expect(compact(source)).toContain(compact('todaySpend.openXaiUsage'));
    expect(compact(source)).toContain(compact('todaySpend.openClaudeUsage'));
    // 只有实际 Gateway 会话读取 Model Access quota；自定义供应商只保留本会话统计。
    expect(compact(source)).toContain(
      compact('const usesGatewayQuota = isClaudeGateway || isCodexGateway || isPiGateway;'),
    );
    expect(compact(source)).toContain(compact('useClaudeAccountUsage(usesGatewayQuota)'));
  });

  it('treats codex/ budget models + explicit XD selection as API usage on an oauth-bearer spawn', () => {
    expect(compact(source)).toContain(compact("modelId.startsWith('codex/')"));
    expect(compact(source)).toContain(compact("codexAuthInjection === 'oauth-bearer'"));
    expect(compact(source)).toContain(compact("vendorKey === 'codex' && !isCodexXaiProvider"));
    expect(compact(source)).toContain(compact('isRemoteCodexSession ||'));
    expect(compact(source)).toContain(compact("(providerId == null || providerId === 'openai')"));
    expect(compact(source)).toContain(compact('modelId.startsWith(XAI_MODEL_PREFIX)'));
    expect(compact(source)).toContain(compact("providerId === 'xai'"));
    expect(compact(source)).toContain(
      compact('const isCodexSubscription = isCodexOauth || isCodexXaiProvider;'),
    );
    expect(compact(source)).toContain(
      compact("const isCodexApi = vendorKey === 'codex' && !isCodexSubscription"),
    );
    expect(compact(source)).not.toContain(compact("codexAuthState.authSource === 'oauth'"));
  });

  it('renders device-link remote sessions data-driven without local-account classification', () => {
    // device-link 远程会话:计费形态事实在被控端,本机 route 观察 / 账号状态一律不用。
    expect(compact(source)).toContain(
      compact('const isDeviceLinkRemote = Boolean(deviceLinkDeviceId);'),
    );
    // 本机 Codex runtime route 观察对 device-link 关闭(否则按控制端账号形态张冠李戴)
    expect(compact(source)).toContain(
      compact("enabled: vendorKey === 'codex' && !isDeviceLinkRemote,"),
    );
    // Claude 默认路由观察(proxy 观察值 / OAuth / 网关 key 启发式)对 device-link 关闭
    expect(compact(source)).toContain(
      compact(
        "vendorKey === 'cc' && !isRemoteClaudeSession && !isDeviceLinkRemote && providerId == null",
      ),
    );
    // 订阅形态分类整体排除 device-link(专属分支接管渲染)
    expect(compact(source)).toContain(
      compact("(vendorKey === 'pi' && !remoteHostId && providerId === 'anthropic')"),
    );
    // 渲染走专属分支:估算价值 / 累计 cost 有哪个显哪个,不显示本机限额窗口
    expect(compact(source)).toContain(compact('if (isDeviceLinkRemote) {'));
    // 看板链接对 device-link 落 null(额度属于被控端账号,本机浏览器打开的是控制端账号)
    expect(source).toMatch(/usageDashboardUrl: string \| null = isDeviceLinkRemote\s*\?\s*null/);
  });

  it('does not classify remote Codex sessions from the local runtime route', () => {
    expect(compact(source)).toContain(compact('remoteHostId?: string | null'));
    expect(compact(source)).toContain(
      compact("const isRemoteCodexSession = vendorKey === 'codex' && Boolean(remoteHostId);"),
    );
    // SSH(remoteHostId)与 device-link(deviceLinkDeviceId)远程会话都抑制本机账户快照读取
    expect(compact(source)).toContain(compact('deviceLinkDeviceId?: string | null'));
    expect(compact(source)).toContain(
      compact('const isAnyRemoteSession = Boolean(remoteHostId) || Boolean(deviceLinkDeviceId);'),
    );
    expect(compact(source)).toContain(
      compact(
        'const shouldReadLocalCodexAccountUsage = usesCodexQuotaForm && !isAnyRemoteSession;',
      ),
    );
    // 按会话形态选配额槽: bridge → WHAM(openai-web)槽, CLI → app-server 槽,
    // 不跨槽回退(账号多限额桶互相污染, 2026-07-24 实报 bug)
    expect(compact(source)).toContain(
      compact("shouldReadLocalCodexAccountUsage ? 'codex' : undefined,"),
    );
    expect(compact(source)).toContain(compact("isChatgptBridge ? 'openai-web' : 'app-server',"));
  });

  it('formats gateway quota amounts with the gateway-native currency', () => {
    expect(compact(source)).toContain(
      compact('formatCompactMoney(gatewayMoney(claudeQuota.spend, claudeQuota.currency))'),
    );
    expect(compact(source)).toContain(
      compact('formatCompactMoney(gatewayMoney(claudeQuota.maxBudget, claudeQuota.currency))'),
    );
    expect(compact(source)).not.toContain(compact('formatCompactUsd(claudeQuota.'));
  });

  it('uses token and explicit empty-state fallbacks for Codex API sessions', () => {
    expect(compact(source)).toContain(
      compact('isCodexApi || isCodexSubscription || isSubscriptionBridge || isDeviceLinkRemote'),
    );
    expect(compact(source)).toContain(
      compact('function hasPositiveSessionTokens(sessionTokens: number | null)'),
    );
    expect(compact(source)).toContain(compact('const codexApiHasTokenFallback = isCodexApi'));
    expect(compact(source)).toContain(compact('const codexApiEmptyState = isCodexApi'));
    expect(source.match(/getCodexApiEmptyState\(latestTurnUsage\)/g)).toHaveLength(1);
    expect(compact(source)).toContain(compact('todaySpend.codex.sessionTokensLine'));
    expect(compact(source)).toContain(compact('todaySpend.codex.noUsageLabel'));
    expect(compact(source)).toContain(compact('todaySpend.codex.unavailableLabel'));
    expect(compact(source)).toContain(compact('todaySpend.codex.noUsageDetail'));
    expect(compact(source)).toContain(compact('todaySpend.codex.unavailableDetail'));
  });

  it('ticks the reset countdown per second in the last minute and rolls remaining % up after a reset', () => {
    // 最后一分钟秒级倒计时: formatCompactTimeUntilReset 落到秒单位, tick 节奏由
    // computeCountdownTickDelayMs 决定 (setTimeout 链, 非固定 interval)
    expect(compact(source)).toContain(compact("t('todaySpend.unit.second')"));
    expect(compact(source)).toContain(
      compact('computeCountdownTickDelayMs(chipResetsAtMsList, Date.now())'),
    );
    expect(compact(source)).toContain(compact('window.setTimeout('));
    expect(compact(source)).not.toContain(compact('window.setInterval('));
    // 重置滚动动画: chip 最多两个窗口段, 固定两个 slot 无条件调 hook (Rules of Hooks);
    // 剩余百分比经 useQuotaResetRollup 后再格式化 (重置时 0% → 100% 快速跳动)
    expect(compact(source)).toContain(compact('const rollupA = useQuotaResetRollup(windowSlotA);'));
    expect(compact(source)).toContain(compact('const rollupB = useQuotaResetRollup(windowSlotB);'));
    // 揭晓仪式: 重置滚动启动的上升沿放一次撒花 (QuotaResetConfetti, DESIGN §14.4
    // 第三类 sanctioned motion); 不再用绿色文字 (2026-07-23 用户反馈效果差已移除)。
    // 锚点 = 正在揭晓的窗口段元素 (粒子沿整段文字宽度散布), 兜底 chip 容器
    expect(compact(source)).toContain(
      compact("import { QuotaResetConfetti } from './QuotaResetConfetti';"),
    );
    expect(compact(source)).toContain(compact('if (celebrating && !prevCelebratingRef.current)'));
    expect(compact(source)).toContain(compact('segmentElsRef.current[window.key] = el;'));
    expect(compact(source)).toContain(compact('?? chipRef.current;'));
    expect(compact(source)).toContain(compact('<QuotaResetConfetti'));
    expect(compact(source)).toContain(compact('onDone={() => setConfettiBurst(null)}'));
    expect(compact(source)).not.toContain(compact('card-status-done'));
    expect(compact(source)).toContain(
      compact('interface ChipWindowSegment extends ChipWindowSlot'),
    );
    // 动画身份 key: 上游窗口策略变化 / 周限口径切换只重置基线, 不误触滚动
    expect(compact(source)).toContain(compact('`codex-${slotKey}:${window.windowMinutes ?? '));
    expect(compact(source)).toContain(compact("'claude-5h'"));
    expect(compact(source)).toContain(compact('claude-weekly:'));
    // tick effect 依赖以值签名 memo 的 reset 时点列表, 动画帧不得重建定时器
    expect(compact(source)).toContain(compact('const resetsAtSignature = chipWindows'));
  });

  it('shows a suspense "resetting…" segment while waiting for the post-reset snapshot', () => {
    // 悬念期: 倒计时归零、新快照未落地 → 段换成「重置中…」(呼吸省略号), 不再
    // 显示已失真的旧百分比; 新快照落地由重置滚动动画揭晓
    expect(compact(source)).toContain(compact('function isResetPending('));
    expect(compact(source)).toContain(compact('resetPending: isResetPending(resetsAtMs, nowMs)'));
    // 悬念期必须有界 (催刷是 best-effort, 离线/登出/退避时拿不到新快照); 超时
    // 回落旧值 + 窗口名。常量在 quotaResetRollup (tick 节奏踩着超时边界调度,
    // 悬念不会因慢 tick 多挂一分钟, Greptile P1 两轮, PR #546)
    expect(compact(source)).toContain(compact('RESET_PENDING_MAX_MS,'));
    // 超时侧严格小于: 排在超时边界上的 tick 必须当场退出悬念, 含等号会再等一轮
    // 慢 tick (Greptile P1 第三轮)
    expect(compact(source)).toContain(compact('&& nowMs - resetsAtMs < RESET_PENDING_MAX_MS'));
    expect(compact(source)).toContain(compact("'todaySpend.resetPendingSegment'"));
    // 省略号动画: HTML span + opacity (animate-pulse), 仅悬念期挂载 (动效红线);
    // motion-safe = 尊重 prefers-reduced-motion (review P1, PR #546)
    expect(compact(source)).toContain(
      compact('<span className="motion-safe:animate-pulse">…</span>'),
    );
    expect(compact(source)).not.toContain(compact('"animate-pulse"'));
    // 悬念期催刷通道必须与 chip 显示的配额槽一致: bridge 形态催 WHAM; Codex CLI
    // 形态显示 app-server 槽, WHAM 刷新帮不上它(靠 turn 事件 / 悬念超时兜底),
    // 不得催 —— WHAM 桶与 CLI 配额可能不同(账号多限额桶, 2026-07-24 实报 bug)
    expect(compact(source)).toContain(
      compact(
        'if (isChatgptBridge) {\n' +
          '      requestCodexAccountRefresh();\n' +
          '    } else if (usesXaiQuotaForm) {\n' +
          '      requestXaiSubscriptionRefresh();\n' +
          '    } else if (isClaudeSubscription && !usesCodexQuotaForm) {\n' +
          '      requestClaudeSubscriptionRefresh();\n' +
          '    }',
      ),
    );
    expect(compact(source)).toContain(
      compact('const hasPendingResetWindow = chipWindows.some((window) => window.resetPending);'),
    );
    expect(compact(source)).toContain(compact('const xaiNeedsWeeklyRefresh = usesXaiQuotaForm'));
    expect(compact(source)).not.toContain(compact('Boolean(xaiSubscriptionUsage)'));
  });

  it('no longer exposes the per-key (curApp) tooltip metric', () => {
    expect(compact(source)).not.toContain(compact('useTodaySpend'));
    // curApp / currentKeyTodaySpend 指标已于 2026-06-21 移除 (口径冗余 + key 取错桶)。
    // regression guard: 防止它被重新引入。
    expect(compact(source)).not.toContain(compact('currentKeyTodaySpend'));
    expect(compact(source)).not.toContain(compact("t('todaySpend.currentKeyLabel'"));
    expect(compact(source)).not.toContain(compact("t('todaySpend.tooltip.currentKeyUnavailable')"));
    expect(compact(source)).not.toContain(compact("'curApp'"));
  });
});

// Presentation contracts use real provider inputs instead of pinning helper names or JSX branches.
const t = ((key: string, values?: Record<string, unknown>) =>
  `${key}${values ? ':' + JSON.stringify(values) : ''}`) as TFunction;
const now = Date.UTC(2026, 8, 5);
describe('shared usage-card provider projections', () => {
  it.each([
    [' ProLite ', 'ProLite', 'Pro Lite'],
    ['custom_plan', 'Custom_plan', 'Custom Plan'],
    ['', null, null],
  ])('keeps settings and usage cards consistent for plan %s', (plan, claudeLabel, codexLabel) => {
    const claude = buildClaudeUsageCard({ subscriptionType: plan, updatedAt: now }, t);
    const codex = buildCodexUsageCard({ planType: plan }, null, t, now);
    expect(claude.planLabel).toBe(claudeLabel);
    expect(codex.planLabel).toBe(codexLabel);
    expect(claude.planLabel).toBe(formatClaudeSubscriptionPlanLabel(plan));
    expect(codex.planLabel).toBe(formatCodexPlanLabel(plan));
  });

  it('treats malformed plan metadata as absent without dropping quota windows', () => {
    const card = buildCodexUsageCard(
      { planType: 123 as unknown as string, primary: { usedPercent: 25 } },
      null,
      t,
      now,
    );
    expect(card.planLabel).toBeNull();
    expect(card.windows[0].window.utilization).toBe(25);
  });

  it.each(['free', 'plus', 'business', 'enterprise', 'custom_plan'])(
    'preserves ChatGPT plan %s without requiring quota windows',
    (planType) => {
      const card = buildCodexUsageCard({ planType }, null, t, now, 'en');
      expect(card.title).toBe('ChatGPT');
      expect(card.planLabel).toBe(
        planType
          .split('_')
          .map((part) => part[0].toUpperCase() + part.slice(1))
          .join(' '),
      );
      expect(card.windows).toEqual([]);
    },
  );

  it('preserves explicit zero reset credits and localizes their expiry', () => {
    const card = buildCodexUsageCard(
      null,
      {
        rows: [],
        hasResetCreditCount: true,
        availableCount: 0,
        earliestExpiryAt: now / 1000 + 3600,
        canReset: false,
        shouldPrompt: false,
      },
      t,
      now,
      'en',
    );
    expect(card.details).toContain('todaySpend.codex.resetCreditsAvailableLine:{"count":0}');
    expect(
      card.details?.some((line) =>
        line.startsWith('todaySpend.codex.resetCreditEarliestExpiryLine'),
      ),
    ).toBe(true);
  });

  it('does not label a thirty-day window as weekly', () => {
    const card = buildCodexUsageCard(
      { primary: { usedPercent: 1, windowMinutes: 43200 } },
      null,
      t,
      now,
    );
    expect(card.windows[0].title).toBe('todaySpend.codex.daysWindow:{"days":30}');
  });

  it('keeps native credits and balance status separate from quota exhaustion', () => {
    const card = buildCodexUsageCard(
      {
        credits: { balance: '1,234.50', hasCredits: false, unlimited: false },
        primary: { usedPercent: 20, windowMinutes: 90 },
        rateLimitReachedType: 'workspace_owner_credits_depleted',
      },
      null,
      t,
      now,
      'en',
    );
    expect(card.details).toContain('todaySpend.codex.creditsLine:{"credits":"1,234.50"}');
    expect(card.details).toContain('todaySpend.codex.balanceDepleted');
    expect(card.notices).toEqual([]);
    expect(card.windows[0].title).toBe('90m');
  });

  it('shows rate-limit reasons only when an observed window is exhausted', () => {
    const snapshot = { primary: { usedPercent: 50 }, rateLimitReachedType: 'rate_limit_reached' };
    expect(buildCodexUsageCard(snapshot, null, t, now).notices).toEqual([]);
    snapshot.primary.usedPercent = 100;
    expect(buildCodexUsageCard(snapshot, null, t, now).notices?.[0].tone).toBe('crit');
  });

  it('handles missing or malformed percentages without inventing zero quota', () => {
    const card = buildCodexUsageCard(
      { primary: { usedPercent: NaN }, secondary: { usedPercent: 12, windowMinutes: 300 } },
      null,
      t,
      now,
    );
    expect(card.windows).toHaveLength(1);
    expect(card.windows[0].window.utilization).toBe(12);
    expect(buildCodexUsageCard(null, null, t, now).emptyText).toBe('quotaCard.waiting');
  });

  it('preserves Grok product, prepaid USD, and instantaneous rate-limit details', () => {
    const card = buildXaiUsageCard(
      {
        planLabel: 'SuperGrok',
        creditUsagePercent: 9,
        updatedAt: now,
        resetsAt: now / 1000 + 3600,
        productUsage: [
          { product: 'GrokBuild', usagePercent: 2 },
          { product: 'OtherProduct', usagePercent: 7 },
          { product: 'InvalidProduct', usagePercent: NaN },
        ],
        prepaidBalance: 12.3,
      },
      {
        remainingRequests: 3,
        limitRequests: 10,
        remainingTokens: 1000,
        limitTokens: 5000,
        updatedAt: now,
      },
      t,
      now,
    );
    expect(card.windows.map((window) => window.window.utilization)).toEqual([9]);
    expect(card.windows[0].breakdown).toEqual([
      {
        label: 'quotaCard.includedLabel:{"name":"Grok Build"}',
        value: 'quotaCard.usedPercent:{"percent":2}',
      },
      {
        label: 'quotaCard.includedLabel:{"name":"Other Product"}',
        value: 'quotaCard.usedPercent:{"percent":7}',
      },
    ]);
    expect(card.windows[0].detail).toBe('todaySpend.xai.accountWeeklyHint');
    expect(card.details).toEqual(
      expect.arrayContaining([
        'todaySpend.xai.extraCreditsLine:{"amount":"US$12.30"}',
        'todaySpend.xai.requestsLine:{"remaining":"3","limit":"10"}',
      ]),
    );
    expect(card.details?.some((line) => line.startsWith('todaySpend.xai.tokensLine'))).toBe(true);
  });

  it('filters expired Grok data without borrowing Claude quota', () => {
    const card = buildXaiUsageCard(
      { planLabel: 'SuperGrok', creditUsagePercent: 9, updatedAt: now - 31 * 60_000 },
      null,
      t,
      now,
    );
    expect(card.planLabel).toBe('SuperGrok');
    expect(card.windows).toEqual([]);
    expect(card.emptyText).toBe('todaySpend.xai.noQuotaDetail');
    expect(buildClaudeUsageCard(null, t).windows).toEqual([]);
  });
});
