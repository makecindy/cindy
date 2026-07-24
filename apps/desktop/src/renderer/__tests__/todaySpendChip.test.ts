/**
 * TodaySpendChip source-level contract tests.
 *
 * The component itself depends on Electron globals and renderer hooks, so this
 * pins the small routing contract in the Node vitest environment.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve(__dirname, '..', 'components', 'status', 'TodaySpendChip.tsx');
// Windows CRLF 检出下 \n 字面量断言会失配,统一归一化成 LF 再断言。
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');

describe('TodaySpendChip dashboard routing', () => {
  it('separates the latest user-round total from final-segment token details', () => {
    expect(source).toContain('const userTurnCostUsd = typeof message.userTurnCostUsd');
    expect(source).toContain('? { costUsd: userTurnCostUsd }');
    expect(source).toContain('isUserTurnTotal: userTurnCostUsd != null');
    expect(source).toContain("'todaySpend.tooltip.latestUserTurnTitle'");
    expect(source).toContain('segmentCostUsd: message.turnCostUsd');
    expect(source).toContain('costUsd: summary.isUserTurnTotal ? summary.segmentCostUsd : summary.costUsd');
    expect(source).toContain("'chat.messageActionBar.userTurnCostDetailsTitle'");
  });

  it('routes codex-oauth / cc+chatgpt bridge to OpenAI usage, xai provider/bridge to xAI, claude subscription to claude.ai, and gateway / codex-api to no dashboard (internal console removed pre-OSS)', () => {
    expect(source).toContain('https://chatgpt.com/codex/settings/usage');
    expect(source).toContain('https://accounts.x.ai');
    expect(source).toContain('https://claude.ai/settings/usage');
    // 网关 / 托管账号这一路 URL 落到 null(点击无跳转);其余三路指向各自公开看板。
    expect(source).toMatch(
      /usesXaiQuotaForm\s*\?\s*XAI_ACCOUNT_URL\s*:\s*isCodexOauth \|\| isChatgptBridge\s*\?\s*CODEX_USAGE_DASHBOARD_URL\s*:\s*isClaudeSubscription\s*\?\s*CLAUDE_USAGE_DASHBOARD_URL\s*:\s*null/,
    );
    expect(source).toContain('todaySpend.openCodexUsage');
    expect(source).toContain('todaySpend.openXaiUsage');
    expect(source).toContain('todaySpend.openClaudeUsage');
    // codex 'api' 模式走 AI Gateway: 与 cc(非订阅 bridge)同用 cost metric, 复用同一把 XD key 的 quota
    expect(source).toContain("(vendorKey === 'cc' && !isSubscriptionBridge) || isCodexApi");
  });

  it('treats cc + chatgpt/ / xai/ bridge sessions as subscription usage (no gateway quota / spend)', () => {
    expect(source).toContain('modelId.startsWith(CHATGPT_MODEL_PREFIX)');
    expect(source).toContain('modelId.startsWith(XAI_MODEL_PREFIX)');
    expect(source).toContain('const isSubscriptionBridge = isChatgptBridge || isXaiBridge;');
    // gateway quota 对订阅 bridge 会话关闭;device-link 远程同样不读本机网关配额
    expect(source).toContain(
      "(((vendorKey === 'cc' && !isClaudeSubscription && !isSubscriptionBridge && !ccBillingFormPending) || isCodexApi)",
    );
    expect(source).toContain('&& !isDeviceLinkRemote),');
    // chatgpt bridge 复用 codex 订阅 chip 形态;xai bridge / codex xai model 走价值估算 + 尽力限流 tooltip
    expect(source).toContain('const usesCodexQuotaForm = isCodexOauth || isChatgptBridge;');
    expect(source).toContain('const usesXaiQuotaForm = isCodexXaiProvider || isXaiBridge;');
    expect(source).toContain('tooltipNode = buildXaiTooltipNode(');
    // 远程会话(SSH / device-link)抑制本机 xAI 限流快照读取
    expect(source).toContain('useXaiRateLimit(usesXaiQuotaForm && !isAnyRemoteSession)');
    expect(source).toContain('todaySpend.xai.noQuotaDetail');
    // bridge 形态优先于 Claude 订阅形态(model 前缀决定实际消耗的额度);device-link 远程不读本机订阅余量
    expect(source).toContain('isClaudeSubscription && !isSubscriptionBridge && !isDeviceLinkRemote');

  });

  it('treats codex/ budget models + explicit XD selection as API usage on an oauth-bearer spawn', () => {
    expect(source).toContain("modelId.startsWith('codex/')");
    expect(source).toContain("codexAuthInjection === 'oauth-bearer'");
    expect(source).toContain("vendorKey === 'codex' && !isCodexXaiProvider");
    expect(source).toContain("isRemoteCodexSession ||");
    expect(source).toContain("(codexAuthInjection === 'oauth-bearer' && !isCodexBudgetModel && providerId !== 'xd')");
    expect(source).toContain("vendorKey === 'codex' && typeof modelId === 'string' && modelId.startsWith(XAI_MODEL_PREFIX)");
    expect(source).not.toContain("providerId === 'xai'");
    expect(source).toContain('const isCodexSubscription = isCodexOauth || isCodexXaiProvider;');
    expect(source).toContain("const isCodexApi = vendorKey === 'codex' && !isCodexSubscription");
    expect(source).not.toContain("codexAuthState.authSource === 'oauth'");
  });

  it('does not classify remote Codex sessions from the local runtime route', () => {
    expect(source).toContain('remoteHostId?: string | null');
    expect(source).toContain("const isRemoteCodexSession = vendorKey === 'codex' && Boolean(remoteHostId);");
    // SSH(remoteHostId)与 device-link(deviceLinkDeviceId)远程会话都抑制本机账户快照读取
    expect(source).toContain('deviceLinkDeviceId?: string | null');
    expect(source).toContain('const isAnyRemoteSession = Boolean(remoteHostId) || Boolean(deviceLinkDeviceId);');
    expect(source).toContain(
      'const shouldReadLocalCodexAccountUsage = usesCodexQuotaForm && !isAnyRemoteSession;',
    );
    // 按会话形态选配额槽: bridge → WHAM(openai-web)槽, CLI → app-server 槽,
    // 不跨槽回退(账号多限额桶互相污染, 2026-07-24 实报 bug)
    expect(source).toContain("shouldReadLocalCodexAccountUsage ? 'codex' : undefined,");
    expect(source).toContain("isChatgptBridge ? 'openai-web' : 'app-server',");
  });

  it('keeps Codex OAuth subscription details in the chip and tooltip', () => {
    expect(source).not.toContain('CODEX_CREDIT_USD_RATE');
    expect(source).not.toContain('usdFormatted');
    expect(source).not.toContain('function getSessionCostSegment(');
    expect(source).toContain("t('todaySpend.sessionCostLabel', { cost: `$${sessionCostUsd.toFixed(2)}` })");
    expect(source).toContain("tooltipLabel: t('todaySpend.tooltip.sessionUsed'");
    expect(source).toContain("session: { label: t('todaySpend.sessionCostLabel', { cost: '$—' })");
    expect(source).toContain("(vendorKey === 'cc' && !isSubscriptionBridge) || isCodexApi ? sessionId : undefined");
    expect(source).toContain("(vendorKey === 'cc' && !isSubscriptionBridge) || isCodexApi ? sessionInitialCostUsd : null");
    // 订阅"本会话价值"估算: Codex OAuth / Claude 订阅 / bridge 订阅共用同一管道
    expect(source).toMatch(
      /useSessionEstimatedValue\(\s*sessionId,\s*isCodexSubscription \|\| isClaudeSubscription \|\| isSubscriptionBridge,?\s*\)/,
    );
    expect(source).toContain('function getCodexChipWindows(');
    expect(source).toContain("'todaySpend.codex.windowSegment'");
    expect(source).toContain(
      "chipSegments.push(t('todaySpend.codex.sessionValueLabel'",
    );
    expect(source).toContain('tooltipNode = buildCodexTooltipNode(');
    expect(source).toContain('sessionEstimatedValueUsd,');
    expect(source).toContain("t('todaySpend.codex.sessionValueLabel'");
    expect(source).toContain('getCodexWindowUsages(snapshot, t, nowMs)');
    expect(source).toContain('todaySpend.codex.planCreditsLine');
    expect(source).toContain('todaySpend.codex.windowLine');
    // chip 主体 label 统一为距 reset 的剩余时长倒计时 (Claude / Codex 同一函数),
    // tooltip 保留窗口名 + 精确 reset 时间点
    expect(source).toContain('function formatCompactTimeUntilReset(');
    expect(source).toContain('function toCodexChipWindow(');
    expect(source).toContain('todaySpend.codex.resetAt');
    expect(source).toContain('todaySpend.codex.balanceDepleted');
    expect(source).not.toContain('todaySpend.codex.remainingSegment');
    expect(source).not.toContain('todaySpend.codex.sessionTokensSegment');
    expect(source).not.toContain('todaySpend.codex.creditsShort');
  });

  it('uses token and explicit empty-state fallbacks for Codex API sessions', () => {
    expect(source).toContain(
      'isCodexApi || isCodexSubscription || isSubscriptionBridge ? sessionId : undefined',
    );
    expect(source).toContain('function hasPositiveSessionTokens(sessionTokens: number | null)');
    expect(source).toContain('const codexApiHasTokenFallback = isCodexApi');
    expect(source).toContain('const codexApiEmptyState = isCodexApi');
    expect(source.match(/getCodexApiEmptyState\(latestTurnUsage\)/g)).toHaveLength(1);
    expect(source).toContain("todaySpend.codex.sessionTokensLine");
    expect(source).toContain("todaySpend.codex.noUsageLabel");
    expect(source).toContain("todaySpend.codex.unavailableLabel");
    expect(source).toContain("todaySpend.codex.noUsageDetail");
    expect(source).toContain("todaySpend.codex.unavailableDetail");
  });

  it('keeps Claude subscription details in the chip and tooltip (plan B: follows current model)', () => {
    // 方案 B: 第二栏跟随当前模型的 weekly_scoped 窗口, 匹配不到回退总周限
    expect(source).toContain('function getClaudeChipWindows(');
    expect(source).toContain('function resolveClaudeWeeklyWindow(');
    expect(source).toContain('matchScopedWindowForModel(snapshot.scoped, modelId)');
    // bridge 模型形态优先(不消耗 Claude 订阅额度),订阅余量 hook 对 bridge 会话关闭;
    // device-link 远程会话同样不读本机订阅余量
    expect(source).toContain('isClaudeSubscription && !isSubscriptionBridge && !isDeviceLinkRemote');
    expect(source).toContain('tooltipNode = buildClaudeSubscriptionTooltipNode(');
    expect(source).toContain("'todaySpend.claude.windowSegment'");
    expect(source).toContain("t('todaySpend.claude.modelWeeklyLabel'");
    expect(source).toContain('todaySpend.claude.weeklyLabel');
    expect(source).toContain('todaySpend.claude.windowLine');
    expect(source).toContain('todaySpend.claude.resetAt');
    // chip 周限段: scoped 命中时倒计时前带模型名标注口径 (「Fable 7天 剩余 78%」)
    expect(source).toContain('weekly.modelDisplayName ? `${weekly.modelDisplayName} ${countdown}` : countdown');
    expect(source).toContain('todaySpend.claude.sessionValueLabel');
    expect(source).toContain('todaySpend.claude.planLine');
    // 告警只看影响当前会话的窗口 (5h / 总周限 / 当前模型 scoped);headers 的
    // allowed_warning 是 turn 内唯一的「接近限额」实时信号, 必须纳入告警态
    expect(source).toContain('isClaudeSubscriptionAlerting(');
    expect(source).toContain("status === 'rejected' || status === 'allowed_warning'");
    // Claude 订阅 / bridge 订阅不读 gateway quota (不反映订阅花费); 默认路由 key reconcile
    // 完成前形态未定, 同样不放行网关 quota 读 (避免形态闪切)
    expect(source).toContain("vendorKey === 'cc' && !isClaudeSubscription && !isSubscriptionBridge && !ccBillingFormPending");
    // 远端 Claude 会话恒走网关, 不显示本机订阅余量 (与 Codex 远端口径一致)
    expect(source).toContain("const isRemoteClaudeSession = vendorKey === 'cc' && Boolean(remoteHostId);");
    // 订阅判定: 显式选 Anthropic; 默认路由优先用 proxy 观察到的会话生效路由
    // (spawn 凭证冻结, 活性重算会发散), 无观察值回落「无网关 key 且连了 Claude
    // OAuth」启发式 (新会话下一次 spawn 恰按当前凭证决定)
    expect(source).toContain('useClaudeSessionRoute(sessionId, isDefaultRouteClaudeSession)');
    expect(source).toMatch(
      /observedClaudeRoute != null\s*\? observedClaudeRoute === 'subscription'\s*: !gatewayKeyReconciling && !hasGatewayKey && claudeOAuthConnected === true/,
    );
    expect(source).toContain('const { hasSavedKey: hasGatewayKey, isReconciling: gatewayKeyReconciling } = useApiKey()');
    expect(source).toContain('useClaudeOAuthConnected(isDefaultRouteClaudeSession)');
    // 无观察值且 key reconcile / OAuth 首查未完成时形态未定, 两侧 hook 都不启用
    // (避免形态闪切)
    expect(source).toContain('observedClaudeRoute == null');
    expect(source).toContain('(gatewayKeyReconciling || (!hasGatewayKey && claudeOAuthConnected == null))');
    // extra_usage credits 单位未验证,不得假设 cents 并渲染美元金额
    expect(source).not.toContain('formatExtraUsageCredits');
    expect(source).toContain('不能假设 cents 并渲染美元金额');
  });

  it('labels the Codex chip windows by time until reset while tooltip keeps the window name', () => {
    expect(source).toContain('const DAY_MS = 24 * 60 * 60 * 1000');
    // chip label = 紧凑倒计时 (天级向上取整, 与旧 getDaysUntilReset 口径一致; <1 天
    // 降到小时/分钟, 最后一分钟降到秒)
    expect(source).toContain('Math.ceil(remainMs / DAY_MS)');
    expect(source).toContain('preferResetCountdown: true');
    // 窗口构成不写死, 以上游接口返回为准 (OpenAI 会调整窗口策略, 如 2026-07 曾一度
    // 取消 5h 窗口): 窗口名由 windowMinutes/resetsAt 动态派生, primary/secondary
    // 兜底统一中性「限额」, 不猜 5h / 周等具体窗口名 (Claude 段的 '5h' 是 Anthropic
    // 订阅窗口, 不在此约束内)
    expect(source).not.toContain("formatWindowLabel(snapshot.primary, '5h'");
    expect(source).not.toContain("t('todaySpend.codex.daysWindow', { days: 7 })");
    expect(source).toContain(
      "formatWindowLabel(snapshot.primary, t('todaySpend.codex.limitWindow'), t, nowMs)",
    );
    expect(source).toContain(
      "formatWindowLabel(snapshot.secondary, t('todaySpend.codex.limitWindow'), t, nowMs)",
    );
    expect(source).toContain("t('todaySpend.codex.weekWindow')");
  });

  it('ticks the reset countdown per second in the last minute and rolls remaining % up after a reset', () => {
    // 最后一分钟秒级倒计时: formatCompactTimeUntilReset 落到秒单位, tick 节奏由
    // computeCountdownTickDelayMs 决定 (setTimeout 链, 非固定 interval)
    expect(source).toContain("t('todaySpend.unit.second')");
    expect(source).toContain('computeCountdownTickDelayMs(chipResetsAtMsList, Date.now())');
    expect(source).toContain('window.setTimeout(');
    expect(source).not.toContain('window.setInterval(');
    // 重置滚动动画: chip 最多两个窗口段, 固定两个 slot 无条件调 hook (Rules of Hooks);
    // 剩余百分比经 useQuotaResetRollup 后再格式化 (重置时 0% → 100% 快速跳动)
    expect(source).toContain('const rollupA = useQuotaResetRollup(windowSlotA);');
    expect(source).toContain('const rollupB = useQuotaResetRollup(windowSlotB);');
    // 揭晓仪式: 重置滚动启动的上升沿放一次撒花 (QuotaResetConfetti, DESIGN §14.4
    // 第三类 sanctioned motion); 不再用绿色文字 (2026-07-23 用户反馈效果差已移除)。
    // 锚点 = 正在揭晓的窗口段元素 (粒子沿整段文字宽度散布), 兜底 chip 容器
    expect(source).toContain("import { QuotaResetConfetti } from './QuotaResetConfetti';");
    expect(source).toContain('if (celebrating && !prevCelebratingRef.current)');
    expect(source).toContain('segmentElsRef.current[window.key] = el;');
    expect(source).toContain('?? chipRef.current;');
    expect(source).toContain('<QuotaResetConfetti');
    expect(source).toContain('onDone={() => setConfettiBurst(null)}');
    expect(source).not.toContain('card-status-done');
    expect(source).toContain('interface ChipWindowSegment extends ChipWindowSlot');
    // 动画身份 key: 上游窗口策略变化 / 周限口径切换只重置基线, 不误触滚动
    expect(source).toContain('`codex-${slotKey}:${window.windowMinutes ?? ');
    expect(source).toContain("'claude-5h'");
    expect(source).toContain('claude-weekly:');
    // tick effect 依赖以值签名 memo 的 reset 时点列表, 动画帧不得重建定时器
    expect(source).toContain('const resetsAtSignature = chipWindows');
  });

  it('shows a suspense "resetting…" segment while waiting for the post-reset snapshot', () => {
    // 悬念期: 倒计时归零、新快照未落地 → 段换成「重置中…」(呼吸省略号), 不再
    // 显示已失真的旧百分比; 新快照落地由重置滚动动画揭晓
    expect(source).toContain('function isResetPending(');
    expect(source).toContain('resetPending: isResetPending(resetsAtMs, nowMs)');
    // 悬念期必须有界 (催刷是 best-effort, 离线/登出/退避时拿不到新快照); 超时
    // 回落旧值 + 窗口名。常量在 quotaResetRollup (tick 节奏踩着超时边界调度,
    // 悬念不会因慢 tick 多挂一分钟, Greptile P1 两轮, PR #546)
    expect(source).toContain('RESET_PENDING_MAX_MS,');
    // 超时侧严格小于: 排在超时边界上的 tick 必须当场退出悬念, 含等号会再等一轮
    // 慢 tick (Greptile P1 第三轮)
    expect(source).toContain('&& nowMs - resetsAtMs < RESET_PENDING_MAX_MS');
    expect(source).toContain("'todaySpend.resetPendingSegment'");
    // 省略号动画: HTML span + opacity (animate-pulse), 仅悬念期挂载 (动效红线);
    // motion-safe = 尊重 prefers-reduced-motion (review P1, PR #546)
    expect(source).toContain('<span className="motion-safe:animate-pulse">…</span>');
    expect(source).not.toContain('"animate-pulse"');
    // 悬念期催刷通道必须与 chip 显示的配额槽一致: bridge 形态催 WHAM; Codex CLI
    // 形态显示 app-server 槽, WHAM 刷新帮不上它(靠 turn 事件 / 悬念超时兜底),
    // 不得催 —— WHAM 桶与 CLI 配额可能不同(账号多限额桶, 2026-07-24 实报 bug)
    expect(source).toContain(
      'if (isChatgptBridge) {\n'
      + '      requestCodexAccountRefresh();\n'
      + '    } else if (isClaudeSubscription && !usesCodexQuotaForm) {\n'
      + '      requestClaudeSubscriptionRefresh();\n'
      + '    }',
    );
    expect(source).toContain('const hasPendingResetWindow = chipWindows.some((window) => window.resetPending);');
  });

  it('does not treat missing subscription credits as exhausted usage', () => {
    expect(source).toContain('function shouldShowCodexLimitReachedReason(snapshot: RateLimitSnapshot): boolean');
    expect(source).toContain("snapshot.rateLimitReachedType.includes('credits_depleted')");
    expect(source).not.toContain('if (snapshot.rateLimitReachedType) return t');
    expect(source).not.toContain('credits.hasCredits\\n      ? t');
  });

  it('formats Codex plan labels for display', () => {
    expect(source).toContain("business: 'Business'");
    expect(source).toContain('formatPlanType(snapshot.planType)');
  });

  it('drops the internal usage-dashboard domain pre-OSS: gateway / XD accounts get no link and stay non-clickable, other metrics unchanged', () => {
    // 内部用量看板 URL 只活在 PROXY_USAGE_DASHBOARD_URL 常量里 —— 断言该常量已消失
    // + 三元结尾落 null(见上一个用例的正则),即等价于"内部域名已从源码移除";
    // 这里不重新写出被禁的内部域名字面量,否则它又会 grep 命中公开仓。
    expect(source).not.toContain('PROXY_USAGE_DASHBOARD_URL');
    // 网关账号无看板 → url/label 落 null,chip 不可点(点击无跳转)。
    expect(source).toContain('const isDashboardClickable = usageDashboardUrl !== null');
    expect(source).toContain('if (!usageDashboardUrl) return;');
    // tooltip "打开看板" 行经 helper 统一追加,label 为 null(网关账号)时不追加。
    expect(source).toContain('function pushDashboardLinkLine(lines: string[], label: string | null)');
    // 网关账号仍展示 daily/session 指标 + tooltip(仅去掉"打开看板"链接行)。
    expect(source).toContain("const PRIMARY_GATEWAY_METRICS: readonly MetricKey[] = ['daily', 'session']");
    expect(source).toContain('const chipSegments = getGatewayChipSegments(slots)');
    expect(source).toContain("t('todaySpend.dailyLimitLabel'");
    expect(source).toContain('tooltipLines.push(slots.session.tooltipLabel ?? slots.session.label)');
  });

  it('no longer exposes the per-key (curApp) tooltip metric', () => {
    expect(source).not.toContain("useTodaySpend");
    // curApp / currentKeyTodaySpend 指标已于 2026-06-21 移除 (口径冗余 + key 取错桶)。
    // regression guard: 防止它被重新引入。
    expect(source).not.toContain('currentKeyTodaySpend');
    expect(source).not.toContain("t('todaySpend.currentKeyLabel'");
    expect(source).not.toContain("t('todaySpend.tooltip.currentKeyUnavailable')");
    expect(source).not.toContain("'curApp'");
  });
});
