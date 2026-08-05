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
const quotaHoverCardPath = resolve(__dirname, '..', 'components', 'status', 'QuotaHoverCard.tsx');
const preloadPath = resolve(__dirname, '..', '..', 'preload', 'preload.ts');
const rendererTypesPath = resolve(__dirname, '..', 'vite-env.d.ts');
// Windows CRLF 检出下 \n 字面量断言会失配,统一归一化成 LF 再断言。
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
const quotaHoverCardSource = readFileSync(quotaHoverCardPath, 'utf8').replace(/\r\n/g, '\n');
const preloadSource = readFileSync(preloadPath, 'utf8').replace(/\r\n/g, '\n');
const rendererTypesSource = readFileSync(rendererTypesPath, 'utf8').replace(/\r\n/g, '\n');
const localeSources = ['en', 'zh-CN', 'ja', 'ko'].map((locale) =>
  readFileSync(
    resolve(__dirname, '..', 'i18n', 'locales', locale, 'common.json'),
    'utf8',
  ).replace(/\r\n/g, '\n'),
);

describe('TodaySpendChip dashboard routing', () => {
  it('separates the latest user-round total from final-segment token details', () => {
    expect(source).toContain('message.userTurnMoney?.amount');
    expect(source).toContain('const userTurnCostUsd = typeof message.userTurnCostUsd');
    expect(source).toContain('? { money: userTurnMoney }');
    expect(source).toContain('isUserTurnTotal: Boolean(userTurnMoney || userTurnCostUsd != null)');
    expect(source).toContain("'todaySpend.tooltip.latestUserTurnTitle'");
    expect(source).toContain('segmentMoney: message.turnMoney');
    expect(source).toContain('segmentCostUsd: message.turnCostUsd');
    expect(source).toContain('money: summary.isUserTurnTotal ? summary.segmentMoney : summary.money');
    expect(source).toContain("'chat.messageActionBar.userTurnCostDetailsTitle'");
    expect(source).toContain('inputTokensText: formatCompactTokens(details.inputTokens)');
    expect(source).toContain('outputTokensText: formatCompactTokens(details.outputTokens)');
  });

  it('routes Codex/CC/Pi subscription providers to their account usage pages and keeps gateway routes local', () => {
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
    // 只有实际 Gateway 会话读取 Model Access quota；自定义供应商只保留本会话统计。
    expect(source).toContain('const usesGatewayQuota = isClaudeGateway || isCodexGateway || isPiGateway;');
    expect(source).toContain('useClaudeAccountUsage(usesGatewayQuota)');
  });

  it('treats CC/Pi chatgpt/ and xai/ bridge sessions as subscription usage', () => {
    expect(source).toContain('modelId.startsWith(CHATGPT_MODEL_PREFIX)');
    expect(source).toContain('modelId.startsWith(XAI_MODEL_PREFIX)');
    expect(source).toContain("(vendorKey === 'cc' || vendorKey === 'pi')");
    expect(source).toContain("providerId === 'openai'");
    expect(source).toContain("providerId === 'xai'");
    expect(source).toContain('const isSubscriptionBridge = isChatgptBridge || isXaiBridge;');
    // bridge 只在匹配其内建来源时成立；显式自定义供应商优先于模型前缀。
    expect(source).toContain("(providerId == null || providerId === 'openai')");
    expect(source).toContain("(providerId == null || providerId === 'xai')");
    expect(source).toContain('useClaudeAccountUsage(usesGatewayQuota)');
    // gateway quota 对订阅 bridge 会话关闭;device-link 远程同样不读本机网关配额
    expect(source).toContain('&& !isDeviceLinkRemote');
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
    expect(source).toContain("(providerId == null || providerId === 'openai')");
    expect(source).toContain('modelId.startsWith(XAI_MODEL_PREFIX)');
    expect(source).toContain("providerId === 'xai'");
    expect(source).toContain('const isCodexSubscription = isCodexOauth || isCodexXaiProvider;');
    expect(source).toContain("const isCodexApi = vendorKey === 'codex' && !isCodexSubscription");
    expect(source).not.toContain("codexAuthState.authSource === 'oauth'");
  });

  it('renders device-link remote sessions data-driven without local-account classification', () => {
    // device-link 远程会话:计费形态事实在被控端,本机 route 观察 / 账号状态一律不用。
    expect(source).toContain('const isDeviceLinkRemote = Boolean(deviceLinkDeviceId);');
    // 本机 Codex runtime route 观察对 device-link 关闭(否则按控制端账号形态张冠李戴)
    expect(source).toContain("enabled: vendorKey === 'codex' && !isDeviceLinkRemote,");
    // Claude 默认路由观察(proxy 观察值 / OAuth / 网关 key 启发式)对 device-link 关闭
    expect(source).toContain(
      "vendorKey === 'cc' && !isRemoteClaudeSession && !isDeviceLinkRemote && providerId == null",
    );
    // 订阅形态分类整体排除 device-link(专属分支接管渲染)
    expect(source).toContain("|| (vendorKey === 'pi' && !remoteHostId && providerId === 'anthropic')");
    // 渲染走专属分支:估算价值 / 累计 cost 有哪个显哪个,不显示本机限额窗口
    expect(source).toContain('if (isDeviceLinkRemote) {');
    // 看板链接对 device-link 落 null(额度属于被控端账号,本机浏览器打开的是控制端账号)
    expect(source).toMatch(/usageDashboardUrl: string \| null = isDeviceLinkRemote\s*\?\s*null/);
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

  it('shows the shared mobile Codex reset-credit summary for local Desktop sessions', () => {
    // 主进程已有 authoritative read;Desktop renderer 需补齐 preload + 类型链路。
    expect(preloadSource).toContain(
      'getCodexRateLimits: (): Promise<MobileCodexRateLimitsResult>',
    );
    expect(preloadSource).toContain(
      "ipcRenderer.invoke('maker:usage:codex-rate-limits')",
    );
    expect(rendererTypesSource).toContain(
      'getCodexRateLimits: () => Promise<',
    );
    // 仅本机 Codex OAuth 会话读取本机账号数据;远程 / bridge 不张冠李戴。
    expect(source).toContain(
      'useCodexRateLimits(isCodexOauth && !isAnyRemoteSession)',
    );
    // 复用 Mobile 的中性汇总字段；Desktop 按当前界面语言渲染 label / 次数 / 本地时间。
    expect(source).toContain('summarizeCodexRateLimitReset');
    // 复用 chip 现有 tick 时间基准,跨日时本地时间文案会重新格式化。
    expect(source).toContain(
      'summarizeCodexRateLimitReset(codexRateLimits, windowLabelNowMs)',
    );
    expect(source).toContain('resetSummary?.hasResetCreditCount');
    expect(source).toContain('resetSummary?.earliestExpiryAt');
    expect(source).toContain("t('todaySpend.codex.resetCreditsAvailableLine'");
    expect(source).toContain("t('todaySpend.codex.resetCreditEarliestExpiryLine'");
    expect(source).toContain('i18n.resolvedLanguage ?? i18n.language');
    expect(source).not.toContain('resetSummary?.resetRows');
    for (const localeSource of localeSources) {
      expect(localeSource).toContain('"resetCreditsAvailableLine"');
      expect(localeSource).toContain('"resetCreditEarliestExpiryLine"');
    }
    // 长时间挂载时每次重新悬停都会刷新，首次瞬态失败与外部消费/授予不会永久陈旧。
    expect(source).toContain('onMouseEnter={refreshCodexRateLimits}');
  });

  it('keeps one route-independent session total while provider-specific quota details follow the current model', () => {
    expect(source).not.toContain('CODEX_CREDIT_USD_RATE');
    expect(source).not.toContain('usdFormatted');
    expect(source).not.toContain('function getSessionCostSegment(');
    expect(source).toContain('const cost = formatTurnCostMoney(sessionMoney)');
    expect(source).toContain("tooltipLabel: t('todaySpend.tooltip.sessionUsed'");
    expect(source).toContain('cost: DEFAULT_MONEY_PLACEHOLDER');
    // 会话实际费用与价值估算都无条件读取；当前 provider 只影响配额窗口，
    // 不再决定“本对话”金额取哪一条链路。
    expect(source).toMatch(
      /useSessionUsageMoney\(\s*sessionId,\s*sessionInitialMoney,\s*sessionInitialCostUsd,?\s*\)/,
    );
    expect(source).toContain('const sessionMoney = sessionUsage.totalMoney;');
    expect(source).toContain('const sessionSegment = sessionMoney?.amount');
    expect(source).toContain('pushSessionUsageLines(lines, sessionUsage, sessionTokens, t);');
    expect(source).toContain('function getCodexChipWindows(');
    expect(source).toContain("'todaySpend.codex.windowSegment'");
    expect(source).toContain('if (sessionSegment) chipSegments.push(sessionSegment);');
    expect(source).toContain('tooltipNode = buildCodexTooltipNode(');
    expect(source).toContain('sessionUsage,');
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

  it('formats gateway quota amounts with the gateway-native currency', () => {
    expect(source).toContain(
      'formatCompactMoney(gatewayMoney(claudeQuota.spend, claudeQuota.currency))',
    );
    expect(source).toContain(
      'formatCompactMoney(gatewayMoney(claudeQuota.maxBudget, claudeQuota.currency))',
    );
    expect(source).not.toContain('formatCompactUsd(claudeQuota.');
  });

  it('uses token and explicit empty-state fallbacks for Codex API sessions', () => {
    expect(source).toContain(
      'isCodexApi || isCodexSubscription || isSubscriptionBridge || isDeviceLinkRemote',
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
    // 2026-08 结构化卡片替换纯文本 tooltip(上游 issue 1261),断言迁移至新契约。
    // 方案 B: 第二栏跟随当前模型的 weekly_scoped 窗口, 匹配不到回退总周限
    expect(source).toContain('function getClaudeChipWindows(');
    expect(source).toContain('function resolveClaudeWeeklyWindow(');
    expect(source).toContain('matchScopedWindowForModel(snapshot.scoped, modelId)');
    // bridge 模型形态优先(不消耗 Claude 订阅额度),订阅余量 hook 对 bridge 会话关闭;
    // device-link 远程会话同样不读本机订阅余量
    expect(source).toContain('isClaudeSubscription && !isSubscriptionBridge && !isDeviceLinkRemote');
    expect(source).toContain(
      'const usesClaudeSubscriptionPopover = isClaudeSubscription && !isSubscriptionBridge;',
    );
    expect(source).toContain('open={quotaPopoverOpen}');
    expect(source).toContain('onMouseEnter={handleQuotaPopoverTriggerMouseEnter}');
    expect(source).toContain('onMouseLeave={handleQuotaPopoverMouseLeave}');
    expect(source).toContain(
      'if (quotaPopoverPointerInsideRef.current || quotaPopoverFocusInsideRef.current) return;',
    );
    expect(source).toContain('<QuotaHoverCard');
    expect(source).toContain('snapshot={claudeSubscriptionUsage}');
    expect(source).toContain('sessionUsage={quotaCardSessionUsage}');
    expect(source).toContain('turnUsage={quotaCardTurnUsage}');
    expect(source).toContain("'todaySpend.claude.windowSegment'");
    expect(source).toContain("t('todaySpend.claude.modelWeeklyLabel'");
    expect(source).toContain('todaySpend.claude.weeklyLabel');
    // 窗口详情 / reset 文案已由结构化卡片负责;组件行为另有
    // src/renderer/components/status/__tests__/QuotaHoverCard.test.tsx 直接单测。
    expect(quotaHoverCardSource).toContain("t('quotaCard.usedPercent'");
    expect(quotaHoverCardSource).toContain("t('quotaCard.resetAt'");
    // chip 周限段: scoped 命中时倒计时前带模型名标注口径 (「Fable 7天 剩余 78%」)
    expect(source).toContain('weekly.modelDisplayName ? `${weekly.modelDisplayName} ${countdown}` : countdown');
    expect(source).toContain('if (sessionSegment) chipSegments.push(sessionSegment);');
    expect(quotaHoverCardSource).toContain('const planLabel = formatPlanType(snapshot?.subscriptionType);');
    expect(quotaHoverCardSource).toContain('data-testid="quota-plan-badge"');
    // 告警判定是纯数据判定, 统一收在 shared/claudeSubscriptionUsage.ts (有直接单测:
    // main/usage/__tests__/claudeSubscriptionUsage.test.ts), 组件只消费, 不再本地重写。
    expect(source).toContain('isClaudeSubscriptionAlerting,');
    // rateLimitStatus 可能来自脏快照;卡片先做字符串类型守卫再归一化。
    expect(quotaHoverCardSource).toContain(
      "typeof rawRateLimitStatus === 'string' ? rawRateLimitStatus.trim().toLowerCase() : undefined",
    );
    expect(source).not.toContain('function isClaudeSubscriptionAlerting(');
    expect(source).not.toContain('function hasAlertingClaudeSessionWindow(');
    // chip 变红只看当前会话真受限 (rejected / 影响本会话的窗口告警); headers 的
    // allowed_warning 综合了其它模型的分模型周限, 不得单独染红 —— 否则跑 Opus 的
    // 会话会因 Fable 周限吃紧变红, 而 chip 上根本没有那一段。
    expect(source).not.toContain("status === 'rejected' || status === 'allowed_warning'");
    // 卡片比 chip 宽一档:完整 snapshot 把 rateLimitStatus 交给卡片,
    // allowed_warning 仍在全量窗口列表旁以 warning 状态展示。
    expect(quotaHoverCardSource).toContain("normalizedStatus === 'allowed_warning'");
    expect(quotaHoverCardSource).toContain("{ key: 'quotaCard.limitWarning', tone: 'warn' as const }");
    // Claude 订阅 / bridge 订阅不读 gateway quota (不反映订阅花费); 默认路由 key reconcile
    // 完成前形态未定, 同样不放行网关 quota 读 (避免形态闪切)。这些前置条件收敛到
    // isClaudeGateway 里, 由 usesGatewayQuota 统一放行 quota 读取。
    expect(source).toMatch(
      /const isClaudeGateway =\s*vendorKey === 'cc'\s*&& !isAnyRemoteSession\s*&& !isSubscriptionBridge\s*&& !ccBillingFormPending/,
    );
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
    expect(quotaHoverCardSource).toContain('const showExtraUsage = snapshot?.extraUsage?.isEnabled === true;');
    expect(quotaHoverCardSource).toContain("t('quotaCard.extraUsageEnabled')");
    expect(quotaHoverCardSource).not.toContain('usedCredits');
    expect(quotaHoverCardSource).not.toContain('monthlyLimit');
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
    // 网关账号仍展示 daily/credit/session 指标 + tooltip(仅去掉"打开看板"链接行)。
    // credit 段服务个人租户的三池账本(LiteLLM 语义的 daily/monthly 对它恒不可用)。
    expect(source).toContain("const PRIMARY_GATEWAY_METRICS: readonly MetricKey[] = ['daily', 'credit', 'session']");
    expect(source).toContain('const chipSegments = getGatewayChipSegments(slots)');
    expect(source).toContain("t('todaySpend.dailyLimitLabel'");
    expect(source).toContain('pushSessionUsageLines(tooltipLines, sessionUsage, null, t)');
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
