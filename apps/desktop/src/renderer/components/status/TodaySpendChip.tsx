/**
 * TodaySpendChip — 与 ContextCapacityRing 同行的极简用量指示器。
 *
 * 设计意图（用户拍板的方向）：
 *   - 不在 desktop 重做完整看板（点击 chip 跳到对应供应商的 web 用量看板）
 *   - 仅在右下角与 Context 同行显示区域币种的今日 / 本会话金额
 *   - 点击 → 在系统默认浏览器打开对应 vendor 的用量看板
 *     (XD 网关 / 托管账号暂无看板可跳,点击无反应,详见 usageDashboardUrl)
 *
 * Claude / gateway 形态: 主 chip 固定显示 daily + session, monthly 进 tooltip。
 *   - daily: 今日跨客户端已用 / 软日限额 (maxBudget/30*4.5, 与 web 看板同公式)
 *   - monthly: 本月度周期已用 / 月度上限 (LiteLLM /v2/user/info 原值)
 *   - session: 当前会话终身累计 (跨 resume 持久化, 有 sessionId 才显示)
 *
 * Codex 订阅形态主 chip 显示服务端下发的各限额窗口剩余 / 当前会话区域金额。
 * 窗口构成不做任何假设,完全以上游接口返回为准 —— OpenAI 会调整窗口策略
 * (典型:5h + 周双窗;2026-07 曾一度取消 5h 窗口,且可能随时恢复)。
 * 订阅模式下金额是 token 价值，API / codex/ 折扣 GPT 下是 gateway API 单价折算 cost。
 * credits / token 明细只放 tooltip,不占主 chip。
 *
 * Codex tooltip 按当前会话实际 runtime route + 当前模型分两种:
 *   - oauth 模式 + 当前 app-server 以 OAuth bearer 启动 + 普通模型: 显示各限额窗口
 *     剩余额度、当前会话 token 累计、credits 明细。订阅没有单一 per-token 余额。
 *   - api 模式、app-server 以 gateway key 启动、或当前模型是 codex/ 折扣 GPT:
 *     与 cc 同一把 XD key、同一套 LiteLLM 计费,直接复用 cc 的 daily/monthly/key
 *     cost 形态（session 显示当前 region 的累计金额）。
 *
 * 数据可用性:
 *   - daily / monthly 依赖 claudeQuota (LiteLLM 在线): 拉不到时这俩 metric 都隐藏,
 *     tooltip 顶部加 ⚠️ 提示降级
 *   - session 需实际费用或价值估算大于 0（没跑过 turn 时隐藏）
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  summarizeCodexRateLimitReset,
  type CodexRateLimitResetSummary,
} from '@cindy/maker-shared/session-controls';

import { cn } from '@/lib/utils';
import {
  DAILY_SOFT_LIMIT_FACTOR,
  formatCompactMoney,
  formatCompactTokens,
  formatTurnCostMoney,
  formatTurnCostUsd,
} from '@/lib/usageFormat';
import { Tip } from '@/components/ui/tooltip';
import { useApiKey } from '@/hooks/useApiKey';
import { useClaudeOAuthConnected } from '@/hooks/useClaudeOAuthConnected';
import { useClaudeSessionRoute } from '@/hooks/useClaudeSessionRoute';
import {
  useSessionUsageMoney,
  type SessionUsageMoney,
} from '@/hooks/useSessionUsageMoney';
import { useSessionTokens } from '@/hooks/useSessionTokens';
import { useChatDisplaySnapshot } from '@/components/chat/ChatDisplaySnapshotContext';
import {
  requestCodexAccountRefresh,
  useAccountUsage,
  type RateLimitSnapshot,
} from '@/hooks/useAccountUsage';
import {
  useClaudeAccountUsage,
  type ClaudeAccountUsageSnapshot,
} from '@/hooks/useClaudeAccountUsage';
import { useModelAccessCreditUsage } from '@/hooks/useModelAccessCreditUsage';
import { resolveCreditTotals, type CreditTotals } from '@/lib/creditPoolTotals';
import {
  requestClaudeSubscriptionRefresh,
  useClaudeSubscriptionUsage,
  type ClaudeSubscriptionUsageSnapshot,
} from '@/hooks/useClaudeSubscriptionUsage';
import {
  hasAlertingClaudeSessionWindow,
  isClaudeSubscriptionAlerting,
  matchScopedWindowForModel,
  type ClaudeUsageWindow,
} from '../../../shared/claudeSubscriptionUsage';
import { useCodexRuntimeRoute } from '@/hooks/useCodexRuntimeRoute';
import { useCodexRateLimits } from '@/hooks/useCodexRateLimits';
import { useXaiRateLimit, type XaiRateLimitSnapshot } from '@/hooks/useXaiRateLimit';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import { buildTurnUsageTooltipLines } from '@/lib/turnUsageTooltip';
import type { TurnUsageDetails } from '../../../shared/turnUsageDetails';
import {
  DEFAULT_USAGE_CURRENCY,
  gatewayMoney,
  type RegionalMoney,
} from '../../../shared/regionalMoney';
import { CHATGPT_MODEL_PREFIX, XAI_MODEL_PREFIX } from '../../../shared/subscriptionModels';
import {
  RESET_PENDING_MAX_MS,
  computeCountdownTickDelayMs,
  useQuotaResetRollup,
  type ChipWindowSlot,
} from './quotaResetRollup';
import { QuotaResetConfetti } from './QuotaResetConfetti';

// XD 网关 / 托管账号之前会跳到内部用量看板(内部域名)—— 开源前移除该硬编码。
// 登录随凭据只下发 { endpoint, apiKey }(见 main/model-access/credentialsSync.ts),不含
// 看板地址;推理 endpoint 与看板 console 不同源、无法从中推导。故网关账号暂无看板可跳
// (点击无反应)。
// TODO(后续): 若 model-access-server 在下发凭据时附带看板地址(按个人 / 企业租户区分的
// usageDashboardUrl / consoleUrl),据此恢复网关账号的跳转 + tooltip 链接行
// (i18n 文案 todaySpend.openProxyUsage 已保留待复用,勿当死 key 删)。
const CODEX_USAGE_DASHBOARD_URL = 'https://chatgpt.com/codex/settings/usage';
const XAI_ACCOUNT_URL = 'https://accounts.x.ai';
const CLAUDE_USAGE_DASHBOARD_URL = 'https://claude.ai/settings/usage';

const METRIC_KEYS = ['daily', 'monthly', 'credit', 'session'] as const;
type MetricKey = (typeof METRIC_KEYS)[number];
// credit 排在 session 左边 —— 账号额度是"还能用多少"的前提, 本对话花费是它的增量。
// daily / monthly 与 credit 来自服务端两种不同的额度语义(周期配额 vs 额度池账本),
// 按账号所属租户二选一下发, 两组互斥, 同一形态下不会都占位。
const PRIMARY_GATEWAY_METRICS: readonly MetricKey[] = ['daily', 'credit', 'session'];
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MONEY_SYMBOL = DEFAULT_USAGE_CURRENCY === 'CNY' ? '¥' : '$';
const DEFAULT_MONEY_PLACEHOLDER = `${DEFAULT_MONEY_SYMBOL}—`;

const PLAN_TYPE_LABELS: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  team: 'Team',
  self_serve_business_usage_based: 'Self Serve Business Usage Based',
  business: 'Business',
  enterprise_cbp_usage_based: 'Enterprise CBP Usage Based',
  enterprise: 'Enterprise',
  edu: 'Edu',
  unknown: 'Unknown',
};

// 软日限额系数 + 紧凑金额格式化已抽到 lib/usageFormat.ts (与首页仪表盘共用同口径)。

/** chip / tooltip 共用: 一个 metric 的最终展示形态。 */
interface MetricSlot {
  /** "今日 $47/$300" / "本会话 $3.03" 这种成品字符串, 可用直接 render。 */
  label: string;
  /** tooltip 里使用的解释文案;不填则复用 label。 */
  tooltipLabel?: string;
  /** 是否有数据 — false 时不参与渲染 (无论 chip 还是 tooltip), 由调用方过滤。 */
  available: boolean;
}

/**
 * 把候选 metric 一次性算好 (label + 是否可用)。
 *   - daily / monthly: 需 claudeQuota 在线 (LiteLLM 语义租户); 否则 available=false
 *   - credit: 需三池账本汇总出非零总额 (个人租户); 否则 available=false
 *   - session: 需 sessionCostUsd > 0; 否则 available=false
 *
 * chip 段 / tooltip 段都从这里拿, 主显指标固定, 其它可用指标进 tooltip。
 */
function computeMetricSlots(
  claudeQuota: ClaudeAccountUsageSnapshot | null,
  creditTotals: CreditTotals | null,
  sessionMoney: RegionalMoney | null,
  t: TFunction,
): Record<MetricKey, MetricSlot> {
  const slots: Record<MetricKey, MetricSlot> = {
    daily: { label: t('todaySpend.dailyLimitLabel', { spend: DEFAULT_MONEY_PLACEHOLDER, limit: DEFAULT_MONEY_PLACEHOLDER }), available: false },
    monthly: { label: t('todaySpend.monthlyLimitLabel', { spend: DEFAULT_MONEY_PLACEHOLDER, limit: DEFAULT_MONEY_PLACEHOLDER }), available: false },
    credit: { label: t('todaySpend.creditLabel', { used: DEFAULT_MONEY_PLACEHOLDER, total: DEFAULT_MONEY_PLACEHOLDER }), available: false },
    session: { label: t('todaySpend.sessionCostLabel', { cost: DEFAULT_MONEY_PLACEHOLDER }), available: false },
  };

  // 额度池账本没有周期概念(订阅发放 + 充值 + 赠送), 所以不派生日均软限额。
  // 账本历史缺失的池按余额兜底(见 resolveCreditTotals), 保证「总额 − 已用」恒等于
  // 设置页那个可用余额, chip 上永远是两个数、不退化成单值。
  //
  // 币种走 gatewayMoney 的默认值(DEFAULT_USAGE_CURRENCY = 按发行区域)。这三池是
  // Cindy 自己的计费账本, 与账单页 BILLING_CURRENCY 同一笔钱、必须同口径 —— 不能
  // 改用 Gateway 目录下发的币种, 否则同一笔余额在两个界面显示成不同货币。
  if (creditTotals) {
    const used = formatCompactMoney(gatewayMoney(creditTotals.used));
    const total = formatCompactMoney(gatewayMoney(creditTotals.total));
    slots.credit = {
      label: t('todaySpend.creditLabel', { used, total }),
      tooltipLabel: t('todaySpend.tooltip.creditUsed', { used, total }),
      available: true,
    };
  }

  if (claudeQuota && claudeQuota.maxBudget > 0) {
    // monthly 永远跟 cycle 一起拿到; daily 走单独 endpoint 可能拉不到 (todaySpend=null) → 隐藏
    slots.monthly = {
      label: t('todaySpend.monthlyLimitLabel', {
        spend: formatCompactMoney(gatewayMoney(claudeQuota.spend, claudeQuota.currency)),
        limit: formatCompactMoney(gatewayMoney(claudeQuota.maxBudget, claudeQuota.currency)),
      }),
      available: true,
    };
    if (typeof claudeQuota.todaySpend === 'number') {
      const softLimit = (claudeQuota.maxBudget / 30) * DAILY_SOFT_LIMIT_FACTOR;
      slots.daily = {
        label: t('todaySpend.dailyLimitLabel', {
          spend: formatCompactMoney(
            gatewayMoney(claudeQuota.todaySpend, claudeQuota.currency),
          ),
          limit: formatCompactMoney(gatewayMoney(softLimit, claudeQuota.currency)),
        }),
        available: true,
      };
    }
  }

  if (sessionMoney && sessionMoney.amount > 0) {
    const cost = formatTurnCostMoney(sessionMoney);
    slots.session = {
      label: t('todaySpend.sessionCostLabel', { cost }),
      tooltipLabel: t('todaySpend.tooltip.sessionUsed', { cost }),
      available: true,
    };
  }

  return slots;
}

function parseCreditBalance(balance: string | null | undefined): {
  formatted: string;
} | null {
  const trimmed = balance?.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed.replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return null;
  const formatted = numeric.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return { formatted };
}

function formatPlanType(planType: string | null | undefined): string | null {
  const trimmed = planType?.trim();
  if (!trimmed) return null;
  const knownLabel = PLAN_TYPE_LABELS[trimmed];
  if (knownLabel) return knownLabel;
  return trimmed
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function formatPercent(value: number): string {
  const clamped = clampPercent(value);
  if (Math.abs(clamped - Math.round(clamped)) < 0.05) return `${Math.round(clamped)}%`;
  return `${clamped.toFixed(1).replace(/\.0$/, '')}%`;
}

/** tooltip 用的精确 reset 时间点(当天只显时分, 跨天带月日)。 */
function formatResetAt(epochSeconds: number | null | undefined): string | null {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return null;
  }
  const date = new Date(epochSeconds * 1000);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(
    undefined,
    sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  ).format(date);
}

/** Codex 重置卡到期时间：沿用产品的“当天时分、跨天月日+时分”，按界面语言本地化。 */
function formatResetCreditExpiryAt(
  epochSeconds: number | null | undefined,
  nowMs: number,
  locale: string,
): string | null {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return null;
  }
  const date = new Date(epochSeconds * 1000);
  const now = new Date(nowMs);
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(
    locale,
    sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  ).format(date);
}

/**
 * chip 主体用的紧凑剩余时长(距 reset 还有多久): 单级精度 + 向上取整 ——
 * 「7天」/「3小时」/「45分钟」/「41秒」。Codex 与 Claude 订阅两种形态统一用它当窗口
 * label(所有限额窗口都算给用户);无数据 / 已过期 → null, 调用方回退窗口名。
 * 天级向上取整与 Codex 既有 getDaysUntilReset 口径一致(剩 6天10小时 → 7天)。
 * 最后一分钟降到秒级, 配合秒级 tick(computeCountdownTickDelayMs)逐秒走动。
 */
function formatCompactTimeUntilReset(
  epochSeconds: number | null | undefined,
  nowMs: number,
  t: TFunction,
): string | null {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return null;
  }
  const remainMs = epochSeconds * 1000 - nowMs;
  if (remainMs <= 0) return null;
  if (remainMs >= DAY_MS) {
    return `${Math.ceil(remainMs / DAY_MS)}${t('todaySpend.unit.day')}`;
  }
  if (remainMs >= 60 * 60 * 1000) {
    return `${Math.ceil(remainMs / (60 * 60 * 1000))}${t('todaySpend.unit.hour')}`;
  }
  if (remainMs >= 60_000) {
    return `${Math.ceil(remainMs / 60_000)}${t('todaySpend.unit.minute')}`;
  }
  return `${Math.max(1, Math.ceil(remainMs / 1000))}${t('todaySpend.unit.second')}`;
}

/** epoch 秒 → ms;无效值 → null(重置滚动动画与 tick 节奏都以 ms 为准)。 */
function toEpochMs(epochSeconds: number | null | undefined): number | null {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return null;
  }
  return epochSeconds * 1000;
}

/**
 * chip 上一个限额窗口段的素材: 倒计时 label + 数值化剩余百分比 + 窗口身份/reset
 * 时点(useQuotaResetRollup 检测重置并驱动 0% → 100% 滚动动画的输入)。
 * Codex 订阅与 Claude 订阅两种形态共用, 成品字符串在组件里统一格式化。
 */
interface ChipWindowSegment extends ChipWindowSlot {
  label: string;
  /**
   * 倒计时已过点、快照还停在上个周期 —— 悬念期: 段显示「重置中…」(呼吸省略号)
   * 而不是僵住的旧百分比, 新快照落地时由重置滚动动画揭晓。
   */
  resetPending: boolean;
}

// 悬念期上限常量在 quotaResetRollup.ts(tick 节奏要踩着超时边界调度, 判定与
// 调度共用同一 RESET_PENDING_MAX_MS)。超时回落旧值 + 窗口名展示后, 新快照
// 到达时重置滚动动画照常触发。

/**
 * 悬念期判定: 有 reset 时点且已过(未超时), 快照仍是过点前的旧周期数据。
 * 超时侧用严格小于 —— tick 调度会把一跳精确排在超时边界上
 * (computeCountdownTickDelayMs), 边界 tick 必须判定为「已超时」当场退出悬念,
 * 含等号会让它再等一轮慢 tick(多挂最长一分钟)。
 */
function isResetPending(resetsAtMs: number | null, nowMs: number): boolean {
  return typeof resetsAtMs === 'number'
    && resetsAtMs <= nowMs
    && nowMs - resetsAtMs < RESET_PENDING_MAX_MS;
}

function formatWindowLabel(
  window: RateLimitSnapshot['primary'],
  fallback: string,
  t: TFunction,
  nowMs: number,
  options?: { preferResetCountdown?: boolean },
): string {
  // chip 模式: label 直接用距 reset 的剩余时长(所有限额窗口都算给用户);
  // 无 reset 数据时回退下面的窗口名派生链。tooltip 模式不进这个分支(窗口名 + 精确时间)。
  if (options?.preferResetCountdown) {
    const countdown = formatCompactTimeUntilReset(window?.resetsAt, nowMs, t);
    if (countdown !== null) return countdown;
  }

  const minutes = window?.windowMinutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    return fallback;
  }
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    if (options?.preferResetCountdown || days < 7) {
      return t('todaySpend.codex.daysWindow', { days });
    }
  }
  if (minutes >= 7 * 24 * 60) return t('todaySpend.codex.weekWindow');
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

interface CodexWindowUsage {
  label: string;
  used: string;
  remaining: string;
  /** tooltip 用的精确 reset 时间点;无数据 → null。 */
  resetAt: string | null;
}

function toCodexWindowUsage(
  label: string,
  window: RateLimitSnapshot['primary'],
): CodexWindowUsage | null {
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) {
    return null;
  }
  const usedPercent = clampPercent(window.usedPercent);
  return {
    label,
    used: formatPercent(usedPercent),
    remaining: formatPercent(100 - usedPercent),
    resetAt: formatResetAt(window.resetsAt),
  };
}

function formatRateLimitReason(reason: string): string {
  return reason
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getCodexWindowUsages(
  snapshot: RateLimitSnapshot | null,
  t: TFunction,
  nowMs: number,
): CodexWindowUsage[] {
  if (!snapshot) return [];
  // tooltip 形态: 窗口名 + resetAt 精确时间(chip 段见 getCodexChipWindows)。
  // 窗口名一律由服务端下发的 windowMinutes / resetsAt 动态派生,不对窗口构成做
  // 任何假设(OpenAI 会调整策略:2026-07 曾一度取消 5h 窗口,且可能随时恢复)。
  // 两项数据都缺时兜底中性「限额」,不猜具体窗口名。
  return [
    toCodexWindowUsage(
      formatWindowLabel(snapshot.primary, t('todaySpend.codex.limitWindow'), t, nowMs),
      snapshot.primary,
    ),
    toCodexWindowUsage(
      formatWindowLabel(snapshot.secondary, t('todaySpend.codex.limitWindow'), t, nowMs),
      snapshot.secondary,
    ),
  ].filter((v): v is CodexWindowUsage => Boolean(v));
}

/** Codex 订阅 chip 的单个窗口段素材;窗口缺失 / 百分比不可解析 → null。 */
function toCodexChipWindow(
  slotKey: 'primary' | 'secondary',
  window: RateLimitSnapshot['primary'],
  t: TFunction,
  nowMs: number,
): ChipWindowSegment | null {
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) {
    return null;
  }
  const resetsAtMs = toEpochMs(window.resetsAt);
  return {
    // 身份 key 带 windowMinutes: 上游调整窗口策略(如换掉 5h 窗)时视为新窗口,
    // 只重置动画基线, 不误触重置滚动。
    key: `codex-${slotKey}:${window.windowMinutes ?? 'na'}`,
    label: formatWindowLabel(window, t('todaySpend.codex.limitWindow'), t, nowMs, {
      preferResetCountdown: true,
    }),
    remainingPercent: 100 - clampPercent(window.usedPercent),
    resetsAtMs,
    resetPending: isResetPending(resetsAtMs, nowMs),
  };
}

/** chip 段素材 (Codex 订阅): label 是距 reset 的倒计时(最后一分钟逐秒走动)。 */
function getCodexChipWindows(
  snapshot: RateLimitSnapshot | null,
  t: TFunction,
  nowMs: number,
): ChipWindowSegment[] {
  if (!snapshot) return [];
  return [
    toCodexChipWindow('primary', snapshot.primary, t, nowMs),
    toCodexChipWindow('secondary', snapshot.secondary, t, nowMs),
  ].filter((v): v is ChipWindowSegment => Boolean(v));
}

function isCodexWindowExhausted(window: RateLimitSnapshot['primary']): boolean {
  return Boolean(window && clampPercent(window.usedPercent) >= 99.95);
}

function shouldShowCodexLimitReachedReason(snapshot: RateLimitSnapshot): boolean {
  if (!snapshot.rateLimitReachedType) return false;
  if (snapshot.rateLimitReachedType.includes('credits_depleted')) return false;
  return isCodexWindowExhausted(snapshot.primary) || isCodexWindowExhausted(snapshot.secondary);
}

function getGatewayChipSegments(slots: Record<MetricKey, MetricSlot>): string[] {
  return PRIMARY_GATEWAY_METRICS
    .filter((key) => slots[key].available)
    .map((key) => slots[key].label);
}

function hasPositiveSessionTokens(sessionTokens: number | null): boolean {
  return typeof sessionTokens === 'number'
    && Number.isFinite(sessionTokens)
    && sessionTokens > 0;
}

function getCodexApiEmptyState(
  latestTurnUsage: LatestTurnUsageSummary | null,
): 'no-usage' | 'unavailable' {
  // A completed assistant turn without a persisted USD/token value means the
  // session has usage data, but the billing data has not been recovered yet.
  return latestTurnUsage ? 'unavailable' : 'no-usage';
}

function buildCodexTooltipNode(
  snapshot: RateLimitSnapshot | null,
  sessionTokens: number | null,
  sessionUsage: SessionUsageMoney,
  resetSummary: CodexRateLimitResetSummary | null,
  t: TFunction,
  locale: string,
  usageDashboardLabel: string | null,
  nowMs: number,
  latestTurnUsage: LatestTurnUsageSummary | null,
): React.ReactNode {
  const lines: string[] = [];
  pushSessionUsageLines(lines, sessionUsage, sessionTokens, t);
  if (!snapshot) {
    lines.push(t('todaySpend.codex.waitingDetail'));
    pushCodexResetCreditLines(lines, resetSummary, t, locale, nowMs);
    appendLatestTurnUsageLines(lines, latestTurnUsage, t);
    pushDashboardLinkLine(lines, usageDashboardLabel);
    return buildTooltipNode(lines);
  }

  const planLabel = formatPlanType(snapshot.planType);
  const credits = snapshot.credits;
  const parsedCredits = parseCreditBalance(credits?.balance);

  if (planLabel && parsedCredits) {
    lines.push(t('todaySpend.codex.planCreditsLine', {
      plan: planLabel,
      credits: parsedCredits.formatted,
    }));
  } else if (planLabel) {
    lines.push(t('todaySpend.codex.planLine', { plan: planLabel }));
  } else if (parsedCredits) {
    lines.push(t('todaySpend.codex.creditsLine', {
      credits: parsedCredits.formatted,
    }));
  }

  if (credits?.unlimited) {
    lines.push(t('todaySpend.codex.balanceUnlimited'));
  } else if (credits && !credits.hasCredits) {
    lines.push(t('todaySpend.codex.balanceDepleted'));
  } else if (credits?.hasCredits && !parsedCredits) {
    lines.push(t('todaySpend.codex.balanceAvailable'));
  }
  pushCodexResetCreditLines(lines, resetSummary, t, locale, nowMs);

  for (const window of getCodexWindowUsages(snapshot, t, nowMs)) {
    const base = t('todaySpend.codex.windowLine', {
      label: window.label,
      remaining: window.remaining,
      used: window.used,
    });
    lines.push(window.resetAt
      ? `${base} · ${t('todaySpend.codex.resetAt', { at: window.resetAt })}`
      : base,
    );
  }

  const limitReachedReason = shouldShowCodexLimitReachedReason(snapshot)
    ? snapshot.rateLimitReachedType
    : null;
  if (limitReachedReason) {
    lines.push(t('todaySpend.codex.limitReached', {
      reason: formatRateLimitReason(limitReachedReason),
    }));
  }

  if (lines.length === 0) {
    lines.push(t('todaySpend.codex.waitingDetail'));
  }
  appendLatestTurnUsageLines(lines, latestTurnUsage, t);
  pushDashboardLinkLine(lines, usageDashboardLabel);
  return buildTooltipNode(lines);
}

// ── Claude 订阅 (Anthropic OAuth) 形态 ───────────────────────────────────────
// 主 chip 方案 B: 5h 剩余% · 当前模型周限剩余% (weekly_scoped 按模型家族匹配, 匹配
// 不到回退总周限并标注口径) · 本会话价值 $。tooltip 列全量窗口 (含非当前模型的
// scoped 条目) + 套餐 + extra usage。utilization 语义 = 已用百分比 (0-100)。

/**
 * Claude 窗口 → tooltip 行素材;窗口缺失 / 数据不可解析 → null (调用方过滤)。
 * tooltip 的窗口行不做逐行高亮 (纯文本 tooltip), 告警只体现在 chip 配色与末尾的
 * 「接近限额」行 —— 故这里不带 alerting 标记。
 */
interface ClaudeWindowUsage {
  label: string;
  used: string;
  remaining: string;
  /** tooltip 用的精确 reset 时间点;无数据 → null。 */
  resetAt: string | null;
}

function toClaudeWindowUsage(
  label: string,
  window: ClaudeUsageWindow | null | undefined,
): ClaudeWindowUsage | null {
  if (!window || typeof window.utilization !== 'number' || !Number.isFinite(window.utilization)) {
    return null;
  }
  const usedPercent = clampPercent(window.utilization);
  return {
    label,
    used: formatPercent(usedPercent),
    remaining: formatPercent(100 - usedPercent),
    resetAt: formatResetAt(window.resetsAt),
  };
}

/**
 * 当前会话生效的周限窗口: 命中当前模型的 weekly_scoped 条目优先 (label 带模型名,
 * 如 "Fable 周限"), 否则回退总周限 —— 两种 label 口径可区分, 绝不臆造数字。
 * modelDisplayName 仅 scoped 命中时有, chip 倒计时 label 用它拼「Fable 7天」。
 */
function resolveClaudeWeeklyWindow(
  snapshot: ClaudeSubscriptionUsageSnapshot,
  modelId: string | null | undefined,
  t: TFunction,
): { label: string; window: ClaudeUsageWindow; modelDisplayName?: string } | null {
  const scoped = matchScopedWindowForModel(snapshot.scoped, modelId);
  if (scoped) {
    return {
      label: t('todaySpend.claude.modelWeeklyLabel', { model: scoped.modelDisplayName }),
      window: scoped,
      modelDisplayName: scoped.modelDisplayName,
    };
  }
  if (snapshot.sevenDay) {
    return { label: t('todaySpend.claude.weeklyLabel'), window: snapshot.sevenDay };
  }
  return null;
}

/**
 * chip 段素材 (方案 B + 倒计时 label): 窗口 label 直接用距 reset 的剩余时长 ——
 * 「3小时 剩余 45% · Fable 7天 剩余 78%」;scoped 命中时时长前带模型名标注口径。
 * 无 reset 数据回退窗口名 (5h / Fable 周限 / 周限), 绝不显示算不出的时间。
 * 剩余百分比留数值形态, 由组件经 useQuotaResetRollup(重置滚动动画)后再格式化。
 */
function getClaudeChipWindows(
  snapshot: ClaudeSubscriptionUsageSnapshot | null,
  modelId: string | null | undefined,
  t: TFunction,
  nowMs: number,
): ChipWindowSegment[] {
  if (!snapshot) return [];
  const windows: ChipWindowSegment[] = [];
  const fiveHour = snapshot.fiveHour;
  if (fiveHour && typeof fiveHour.utilization === 'number' && Number.isFinite(fiveHour.utilization)) {
    const countdown = formatCompactTimeUntilReset(fiveHour.resetsAt, nowMs, t);
    const resetsAtMs = toEpochMs(fiveHour.resetsAt);
    windows.push({
      key: 'claude-5h',
      label: countdown ?? '5h',
      remainingPercent: 100 - clampPercent(fiveHour.utilization),
      resetsAtMs,
      resetPending: isResetPending(resetsAtMs, nowMs),
    });
  }
  const weekly = resolveClaudeWeeklyWindow(snapshot, modelId, t);
  if (
    weekly
    && typeof weekly.window.utilization === 'number'
    && Number.isFinite(weekly.window.utilization)
  ) {
    const countdown = formatCompactTimeUntilReset(weekly.window.resetsAt, nowMs, t);
    const label = countdown
      ? (weekly.modelDisplayName ? `${weekly.modelDisplayName} ${countdown}` : countdown)
      : weekly.label;
    const resetsAtMs = toEpochMs(weekly.window.resetsAt);
    windows.push({
      // 身份 key 区分总周限与各 scoped 周限: 切模型导致窗口切换时只重置动画基线。
      key: weekly.modelDisplayName ? `claude-weekly:${weekly.modelDisplayName}` : 'claude-weekly:total',
      label,
      remainingPercent: 100 - clampPercent(weekly.window.utilization),
      resetsAtMs,
      resetPending: isResetPending(resetsAtMs, nowMs),
    });
  }
  return windows;
}

// 告警判定 (chip 变红的口径 + allowed_warning 为何不染红、为何不用 representativeClaim
// 的取舍) 已收进 shared/claudeSubscriptionUsage.ts: isClaudeUsageWindowAlerting /
// hasAlertingClaudeSessionWindow / isClaudeSubscriptionAlerting (纯数据判定, 有直接单测)。
// tooltip 不逐行高亮, 它比 chip 宽一档的那一档在 buildClaudeSubscriptionTooltipNode 里
// (整体 status 的 allowed_warning 也出「接近限额」行)。

function buildClaudeSubscriptionTooltipNode(
  snapshot: ClaudeSubscriptionUsageSnapshot | null,
  modelId: string | null | undefined,
  sessionUsage: SessionUsageMoney,
  t: TFunction,
  usageDashboardLabel: string | null,
  latestTurnUsage: LatestTurnUsageSummary | null,
): React.ReactNode {
  const lines: string[] = [];
  pushSessionUsageLines(lines, sessionUsage, null, t);
  if (!snapshot) {
    lines.push(t('todaySpend.claude.waitingDetail'));
    appendLatestTurnUsageLines(lines, latestTurnUsage, t);
    pushDashboardLinkLine(lines, usageDashboardLabel);
    return buildTooltipNode(lines);
  }

  const planLabel = formatPlanType(snapshot.subscriptionType);
  if (planLabel) {
    lines.push(t('todaySpend.claude.planLine', { plan: planLabel }));
  }
  // 窗口明细: 5h → 总周限 → 全部分模型周限 (含非当前模型, 用户能看到谁先见底)。
  // tooltip 保留精确 reset 时间点 (chip 上是倒计时, 两层信息互补)。
  const windows: ClaudeWindowUsage[] = [];
  const fiveHour = toClaudeWindowUsage('5h', snapshot.fiveHour);
  if (fiveHour) windows.push(fiveHour);
  const sevenDay = toClaudeWindowUsage(t('todaySpend.claude.weeklyLabel'), snapshot.sevenDay);
  if (sevenDay) windows.push(sevenDay);
  for (const scoped of snapshot.scoped ?? []) {
    const usage = toClaudeWindowUsage(
      t('todaySpend.claude.modelWeeklyLabel', { model: scoped.modelDisplayName }),
      scoped,
    );
    if (usage) windows.push(usage);
  }
  for (const window of windows) {
    const base = t('todaySpend.claude.windowLine', {
      label: window.label,
      remaining: window.remaining,
      used: window.used,
    });
    lines.push(window.resetAt
      ? `${base} · ${t('todaySpend.claude.resetAt', { at: window.resetAt })}`
      : base,
    );
  }

  // tooltip 比 chip 宽一档: allowed_warning (服务端综合全部窗口的模糊信号) 也提示 ——
  // 上面刚列完全量窗口, 用户能自己看出是哪个窗口吃紧; chip 颜色不吃这个信号 (见
  // isClaudeSubscriptionAlerting)。
  const status = snapshot.rateLimitStatus?.trim().toLowerCase();
  if (status === 'rejected') {
    lines.push(t('todaySpend.claude.limitRejected'));
  } else if (status === 'allowed_warning' || hasAlertingClaudeSessionWindow(snapshot, modelId)) {
    lines.push(t('todaySpend.claude.limitWarning'));
  }

  if (snapshot.extraUsage?.isEnabled) {
    // extra_usage 的 used_credits / monthly_limit 单位未文档化且本地暂无实样账号,
    // 不能假设 cents 并渲染美元金额。这里只展示启用状态;数值原样保留在 snapshot,
    // 等拿到 live response 后再补准确单位展示。
    lines.push(t('todaySpend.claude.extraUsageEnabledLine'));
  }

  if (lines.length === 0) {
    lines.push(t('todaySpend.claude.waitingDetail'));
  }
  appendLatestTurnUsageLines(lines, latestTurnUsage, t);
  pushDashboardLinkLine(lines, usageDashboardLabel);
  return buildTooltipNode(lines);
}

/** 最近一轮 tooltip 使用的 assistant 消息明细。 */
interface LatestTurnUsageSummary {
  money?: RegionalMoney;
  costUsd?: number;
  isEstimate?: boolean;
  segmentMoney?: RegionalMoney;
  segmentCostUsd?: number;
  segmentIsEstimate?: boolean;
  isUserTurnTotal: boolean;
  details: TurnUsageDetails;
}

function findLatestTurnUsageSummary(messages: ChatMessage[]): LatestTurnUsageSummary | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant' || !message.turnUsageDetails) continue;
    const userTurnMoney =
      message.userTurnMoney?.amount
        ? message.userTurnMoney
        : undefined;
    const userTurnCostUsd = typeof message.userTurnCostUsd === 'number' && message.userTurnCostUsd > 0
      ? message.userTurnCostUsd
      : undefined;
    return {
      ...(userTurnMoney
        ? { money: userTurnMoney }
        : userTurnCostUsd != null
          ? { costUsd: userTurnCostUsd }
          : message.turnMoney?.amount
            ? { money: message.turnMoney }
        : typeof message.turnCostUsd === 'number' && message.turnCostUsd > 0
          ? { costUsd: message.turnCostUsd }
        : {}),
      ...((userTurnMoney || userTurnCostUsd != null
        ? message.userTurnCostIsEstimate
        : message.turnCostIsEstimate) === true ? { isEstimate: true } : {}),
      ...((userTurnMoney || userTurnCostUsd != null) && message.turnMoney?.amount
        ? {
            segmentMoney: message.turnMoney,
            segmentIsEstimate: message.turnCostIsEstimate === true,
          }
        : userTurnCostUsd != null && typeof message.turnCostUsd === 'number' && message.turnCostUsd > 0
        ? {
            segmentCostUsd: message.turnCostUsd,
            segmentIsEstimate: message.turnCostIsEstimate === true,
          }
        : {}),
      isUserTurnTotal: Boolean(userTurnMoney || userTurnCostUsd != null),
      details: message.turnUsageDetails,
    };
  }
  return null;
}

function useLatestTurnUsageSummary(sessionId: string | undefined): LatestTurnUsageSummary | null {
  const displaySnapshot = useChatDisplaySnapshot(sessionId);
  const displaySummary = React.useMemo(
    () => displaySnapshot ? findLatestTurnUsageSummary(displaySnapshot.messages) : null,
    [displaySnapshot],
  );
  const [summary, setSummary] = React.useState<LatestTurnUsageSummary | null>(() => {
    if (!sessionId) return null;
    return findLatestTurnUsageSummary(makerChatStore.getSnapshot(sessionId).messages);
  });

  React.useEffect(() => {
    if (displaySnapshot) return undefined;
    if (!sessionId) {
      setSummary(null);
      return undefined;
    }
    const update = () => {
      setSummary(findLatestTurnUsageSummary(makerChatStore.getSnapshot(sessionId).messages));
    };
    update();
    return makerChatStore.subscribe(sessionId, update);
  }, [displaySnapshot, sessionId]);

  return displaySnapshot ? displaySummary : summary;
}

function appendLatestTurnUsageLines(
  lines: string[],
  summary: LatestTurnUsageSummary | null,
  t: TFunction,
): void {
  if (!summary) return;
  if (lines.length > 0) lines.push('');
  if (
    summary.isUserTurnTotal &&
    (summary.money?.amount || summary.costUsd != null)
  ) {
    lines.push(t('todaySpend.tooltip.latestUserTurnTitle'));
    lines.push(t(summary.isEstimate ? 'usageDetails.valueLine' : 'usageDetails.costLine', {
      cost: summary.money
        ? formatTurnCostMoney(summary.money)
        : formatTurnCostUsd(summary.costUsd ?? 0),
    }));
  }
  lines.push(...buildTurnUsageTooltipLines({
    details: summary.details,
    t,
    // Token / model detail remains scoped to the final SDK segment. Keep its
    // cost line separate from the user-turn total shown above.
    money: summary.isUserTurnTotal ? summary.segmentMoney : summary.money,
    costUsd: summary.isUserTurnTotal ? summary.segmentCostUsd : summary.costUsd,
    isEstimate: summary.isUserTurnTotal ? summary.segmentIsEstimate : summary.isEstimate,
    title: t(summary.isUserTurnTotal
      ? 'chat.messageActionBar.userTurnCostDetailsTitle'
      : 'todaySpend.tooltip.latestTurnTitle'),
  }));
}

function buildTooltipNode(lines: string[]): React.ReactNode {
  return <span className="whitespace-pre-line">{lines.join('\n')}</span>;
}

/**
 * 在 tooltip 末尾追加"打开看板"链接行(前置空行与正文隔开)。
 * label 为 null(如 XD 网关账号暂无看板可跳)时不追加任何内容。
 */
function pushDashboardLinkLine(lines: string[], label: string | null): void {
  if (!label) return;
  if (lines.length > 0) lines.push('');
  lines.push(label);
}

/**
 * 会话金额 tooltip 的统一投影：纯实际费用或纯价值估算各显示自己的语义；
 * 两者并存时先显示合计，再列出构成，避免把估算值伪装成真实扣费。
 */
function pushSessionUsageLines(
  lines: string[],
  sessionUsage: SessionUsageMoney,
  sessionTokens: number | null,
  t: TFunction,
): void {
  const { actualMoney, estimatedValueMoney, totalMoney } = sessionUsage;
  if (actualMoney?.amount && estimatedValueMoney?.amount && totalMoney?.amount) {
    lines.push(t('todaySpend.sessionCostLabel', {
      cost: formatTurnCostMoney(totalMoney),
    }));
  }
  if (actualMoney?.amount) {
    lines.push(t('todaySpend.tooltip.sessionUsed', {
      cost: formatTurnCostMoney(actualMoney),
    }));
  }
  if (estimatedValueMoney?.amount) {
    lines.push(t('todaySpend.codex.sessionValueLabel', {
      cost: formatTurnCostMoney(estimatedValueMoney),
    }));
  }
  if (typeof sessionTokens === 'number' && Number.isFinite(sessionTokens) && sessionTokens > 0) {
    lines.push(t('todaySpend.codex.sessionTokensLine', {
      tokens: formatCompactTokens(Math.floor(sessionTokens)),
    }));
  }
}

/** 与 Mobile 共用中性汇总字段；Desktop label、次数和时间按当前界面语言展示。 */
function pushCodexResetCreditLines(
  lines: string[],
  resetSummary: CodexRateLimitResetSummary | null,
  t: TFunction,
  locale: string,
  nowMs: number,
): void {
  if (resetSummary?.hasResetCreditCount) {
    lines.push(t('todaySpend.codex.resetCreditsAvailableLine', {
      count: resetSummary.availableCount,
    }));
  }
  const expiryAt = formatResetCreditExpiryAt(
    resetSummary?.earliestExpiryAt,
    nowMs,
    locale,
  );
  if (expiryAt) {
    lines.push(t('todaySpend.codex.resetCreditEarliestExpiryLine', { at: expiryAt }));
  }
}

/**
 * xAI(SuperGrok bridge)tooltip —— 尽力档:有限流快照(bridge 抓到 x-ratelimit-* 头)就
 * 显示剩余请求/tokens,拿不到诚实标注「无订阅额度明细」,只显示价值估算 + token 累计。
 */
function buildXaiTooltipNode(
  rateLimit: XaiRateLimitSnapshot | null,
  sessionTokens: number | null,
  sessionUsage: SessionUsageMoney,
  t: TFunction,
  usageDashboardLabel: string | null,
  latestTurnUsage: LatestTurnUsageSummary | null,
): React.ReactNode {
  const lines: string[] = [];
  pushSessionUsageLines(lines, sessionUsage, sessionTokens, t);
  if (rateLimit && typeof rateLimit.remainingRequests === 'number' && typeof rateLimit.limitRequests === 'number') {
    lines.push(t('todaySpend.xai.requestsLine', {
      remaining: rateLimit.remainingRequests.toLocaleString(),
      limit: rateLimit.limitRequests.toLocaleString(),
    }));
  }
  if (rateLimit && typeof rateLimit.remainingTokens === 'number' && typeof rateLimit.limitTokens === 'number') {
    lines.push(t('todaySpend.xai.tokensLine', {
      remaining: formatCompactTokens(rateLimit.remainingTokens),
      limit: formatCompactTokens(rateLimit.limitTokens),
    }));
  }
  if (!rateLimit) {
    lines.push(t('todaySpend.xai.noQuotaDetail'));
  }
  appendLatestTurnUsageLines(lines, latestTurnUsage, t);
  pushDashboardLinkLine(lines, usageDashboardLabel);
  return buildTooltipNode(lines);
}

function renderSegmentedLabel(segments: React.ReactNode[]): React.ReactNode {
  return segments.map((seg, i) => (
    <React.Fragment key={i}>
      {i > 0 && (
        <span
          aria-hidden="true"
          className="mx-2 inline-block h-3 w-px bg-current opacity-30"
        />
      )}
      <span className="tabular-nums">{seg}</span>
    </React.Fragment>
  ));
}

interface TodaySpendChipProps {
  vendorKey?: 'cc' | 'codex';
  /** 当前会话模型;codex/ 折扣 GPT 恒走 gateway API, 即使 oauth-bearer spawn 也按 API 形态显示。 */
  modelId?: string | null;
  /**
   * 本会话显式选定的供应商('anthropic' / 'openai' / 'xd' / null=默认路由)。
   * 决定计费形态:cc 选了 'anthropic' = 走订阅(抑制网关 quota);cc 默认路由的形态由
   * 本机有无网关 key 决定(无 key → proxy 直连 Anthropic, 同为订阅);codex 选了 'xd'
   * = 走网关（显示当前 region 币种）。与 register.ts 的
   * isClaudeSubscriptionSession / isSubscriptionValue 同口径。
   */
  providerId?: string | null;
  /** session 金额初值；展示层会与消息中的价值估算合并，不依赖当前 provider。 */
  sessionId?: string;
  /** 来自 session.totalCostUsd（sessionService.get 拿到）— mount 后由 IPC push 更新。 */
  sessionInitialMoney?: RegionalMoney | null;
  sessionInitialCostUsd?: number | null;
  /** 来自 session.totalTokenUsage（sessionService.get 拿到）— mount 后由 IPC push 更新。 */
  sessionInitialTokens?: number | null;
  /** 远端 Codex 由远端 daemon 路由,本机不能拿本地 app-server route / 账号快照来归类。 */
  remoteHostId?: string | null;
  /**
   * device-link 远程会话所属被控端 id(与 SSH remoteHostId 互斥)。非空 = turn 实际跑在
   * 被控端、消耗**被控端**账号的额度 —— 本机的 ChatGPT 账户快照 / xAI 限流快照与之无关,
   * 必须抑制本地账号读取(否则 chip 显示的是控制端账号的用量,张冠李戴)。
   */
  deviceLinkDeviceId?: string | null;
}

export function TodaySpendChip({
  vendorKey = 'cc',
  modelId,
  providerId,
  sessionId,
  sessionInitialMoney,
  sessionInitialCostUsd,
  sessionInitialTokens,
  remoteHostId,
  deviceLinkDeviceId,
}: TodaySpendChipProps) {
  const { t, i18n } = useTranslation();
  const formatterLocale = i18n.resolvedLanguage ?? i18n.language;
  // device-link 远程会话:turn 跑在被控端、消耗被控端账号,计费形态(订阅/网关)与账号
  // 余量的事实都在被控端 —— 本机的 route 观察 / 账号快照与之无关,一律不读、不据此分类。
  const isDeviceLinkRemote = Boolean(deviceLinkDeviceId);
  const { authInjection: codexAuthInjection } = useCodexRuntimeRoute({
    enabled: vendorKey === 'codex' && !isDeviceLinkRemote,
    refreshKey: sessionId,
  });
  // cc 订阅判定对齐 main 的 isClaudeSubscriptionSession(register.ts)+ proxy 实际路由:
  //   - 显式选 Anthropic 供应商 → 订阅直连(Claude 模型直连 api.anthropic.com,
  //     LiteLLM 看不到, gateway quota 不代表真实花费, 抑制 daily/monthly 展示);
  //   - 默认路由(providerId=null)→ **优先用 proxy 观察到的会话生效路由**
  //     (claude-session-route-registry, 每请求真值):cc 子进程凭证在 spawn 时冻结,
  //     用全局活性凭证状态重算会与实际路由发散(典型:gateway-spawn 会话跑着时
  //     连上 OAuth 并清掉网关 key, child 仍拿冻结的 x-api-key 走网关)。
  //   - 会话尚未发过请求(无观察值)→ 回落活性启发式「无网关 key 且连了 Claude
  //     OAuth = 订阅」:此时下一次 spawn 恰按当前凭证决定, 启发式即正确预测
  //     (main 计费侧不需要观察值: SDK 网关轮自报 costUsd>0, 天然不会误打订阅行)。
  // 网关 key 存在性经 useApiKey 读(与 main readClaudeApiKey 同一 safeStorage key,
  // 自带跨实例广播 + auth-change 刷新)。无观察值且 key reconcile / OAuth 首查未完成
  // 时默认路由形态未定 —— 不判订阅也不放行网关 quota 读, 避免 chip 先按一种形态
  // 渲染再闪切(规则 7)。
  // 远端 Claude 会话的额度事实在远端，本机订阅 / Gateway 快照都不能用于展示。
  const isRemoteClaudeSession = vendorKey === 'cc' && Boolean(remoteHostId);
  // device-link 远程会话不参与默认路由观察:本机 proxy 永远看不到被控端会话的请求,
  // 用本机 OAuth / 网关 key 状态推断只会张冠李戴(形态由下方 device-link 专属分支接管)。
  const isDefaultRouteClaudeSession =
    vendorKey === 'cc' && !isRemoteClaudeSession && !isDeviceLinkRemote && providerId == null;
  const { hasSavedKey: hasGatewayKey, isReconciling: gatewayKeyReconciling } = useApiKey();
  const claudeOAuthConnected = useClaudeOAuthConnected(isDefaultRouteClaudeSession);
  const observedClaudeRoute = useClaudeSessionRoute(sessionId, isDefaultRouteClaudeSession);
  const ccBillingFormPending = isDefaultRouteClaudeSession && observedClaudeRoute == null
    && (gatewayKeyReconciling || (!hasGatewayKey && claudeOAuthConnected == null));
  const isClaudeSubscription = vendorKey === 'cc' && !isRemoteClaudeSession && !isDeviceLinkRemote && (
    providerId === 'anthropic'
    || (providerId == null && (
      observedClaudeRoute != null
        ? observedClaudeRoute === 'subscription'
        : !gatewayKeyReconciling && !hasGatewayKey && claudeOAuthConnected === true
    ))
  );
  // cc 走「订阅直连 bridge」= model 带 chatgpt/ / xai/ 前缀(经本地 responses-bridge 打用户个人
  // 订阅额度,真实计费恒 0,gateway quota 与之无关):
  //   - chatgpt/ → 与 codex 同一 ChatGPT 账户,复用 codex 订阅 chip 形态(限额窗口 + 价值估算);
  //   - xai/    → SuperGrok 无订阅窗口端点,尽力显示 bridge 抓到的限流头,否则仅价值估算。
  // 优先级高于 Claude 订阅形态(model 前缀决定实际消耗的额度)。
  const isChatgptBridge =
    vendorKey === 'cc'
    && (providerId == null || providerId === 'openai')
    && typeof modelId === 'string'
    && modelId.startsWith(CHATGPT_MODEL_PREFIX);
  const isXaiBridge =
    vendorKey === 'cc'
    && (providerId == null || providerId === 'xai')
    && typeof modelId === 'string'
    && modelId.startsWith(XAI_MODEL_PREFIX);
  const isSubscriptionBridge = isChatgptBridge || isXaiBridge;
  const isRemoteCodexSession = vendorKey === 'codex' && Boolean(remoteHostId);
  const isCodexBudgetModel = typeof modelId === 'string' && modelId.startsWith('codex/');
  const isCodexGatewayBudgetModel =
    isCodexBudgetModel && (providerId == null || providerId === 'xd');
  const isCodexXaiProvider =
    vendorKey === 'codex'
    && (providerId == null || providerId === 'xai')
    && typeof modelId === 'string'
    && modelId.startsWith(XAI_MODEL_PREFIX);
  // codex 走订阅价值估算:ChatGPT 订阅需要 oauth-bearer + OpenAI 来源;xAI 由 proxy 注入
  // SuperGrok OAuth。显式自定义供应商优先于共享 host 的 authInjection 和模型名前缀。
  // 远端 Codex 的事实在远端 daemon 上,本机只记录 token 价值估算,不写本地 gateway cost。
  const isCodexOauth = vendorKey === 'codex' && !isCodexXaiProvider && (
    isRemoteCodexSession ||
    (
      codexAuthInjection === 'oauth-bearer'
      && !isCodexGatewayBudgetModel
      && (providerId == null || providerId === 'openai')
    )
  );
  const isCodexSubscription = isCodexOauth || isCodexXaiProvider;
  const isCodexApi = vendorKey === 'codex' && !isCodexSubscription;
  // codex-oauth 与 cc+chatgpt/ bridge 共用同一 ChatGPT 账户 → 同一套限额窗口 chip 渲染。
  const usesCodexQuotaForm = isCodexOauth || isChatgptBridge;
  const usesXaiQuotaForm = isCodexXaiProvider || isXaiBridge;
  // 远程会话不读本机账户快照 —— 额度事实在远端:SSH 用 remoteHostId 判,device-link 用
  // deviceLinkDeviceId 判(两者互斥,任一非空即远程,turn 消耗的是远端账号的额度)。
  const isAnyRemoteSession = Boolean(remoteHostId) || Boolean(deviceLinkDeviceId);
  // Model Access 配额只属于实际走 XD/Cindy AI Gateway 的本地会话。显式自定义供应商即使
  // 复用了 env-key / oauth-bearer host，也不能据 host 的启动凭证把 /v2/user/info 串进来。
  const isClaudeGateway =
    vendorKey === 'cc'
    && !isAnyRemoteSession
    && !isSubscriptionBridge
    && !ccBillingFormPending
    && (
      providerId === 'xd'
      || (
        providerId == null
        && (
          observedClaudeRoute != null
            ? observedClaudeRoute === 'gateway'
            : !gatewayKeyReconciling && hasGatewayKey
        )
      )
    );
  const isCodexGateway =
    vendorKey === 'codex'
    && !isAnyRemoteSession
    && !isCodexSubscription
    && (
      providerId === 'xd'
      || (
        providerId == null
        && (
          codexAuthInjection === 'env-key'
          || isCodexGatewayBudgetModel
          || (codexAuthInjection === 'provider-oauth' && hasGatewayKey)
        )
      )
    );
  const usesGatewayQuota = isClaudeGateway || isCodexGateway;
  const shouldReadLocalCodexAccountUsage = usesCodexQuotaForm && !isAnyRemoteSession;
  // 会话金额只由已发生的 turn 决定，不由当前选中的 provider/模型决定。实际费用从
  // session ledger 读取，订阅价值从消息明细重建，再统一汇总成“本对话”投影。
  const sessionUsage = useSessionUsageMoney(
    sessionId,
    sessionInitialMoney,
    sessionInitialCostUsd,
  );
  const sessionMoney = sessionUsage.totalMoney;
  const sessionTokens = useSessionTokens(
    isCodexApi || isCodexSubscription || isSubscriptionBridge || isDeviceLinkRemote
      ? sessionId
      : undefined,
    sessionInitialTokens,
  );
  // 按会话形态选配额槽: chatgpt/ bridge 消耗 WHAM(openai-web)报告的配额,
  // Codex CLI 会话消耗 app-server 报告的配额 —— 不跨槽回退, 绝不显示不是这个
  // 会话在消耗的配额(账号多限额桶会互相污染, 见 useAccountUsage 头注释)。
  const accountUsage = useAccountUsage(
    sessionId,
    shouldReadLocalCodexAccountUsage ? 'codex' : undefined,
    isChatgptBridge ? 'openai-web' : 'app-server',
    // app-server 形态下据当前模型匹配限额桶(账号可能同时有主配额桶与模型专属
    // 促销桶, 见 useAccountUsage.matchCodexBucketForModel)。
    modelId,
  );
  const {
    snapshot: codexRateLimits,
    refresh: refreshCodexRateLimits,
  } = useCodexRateLimits(isCodexOauth && !isAnyRemoteSession);
  // xAI 限流快照同为本机 main 抓的 —— 远程会话(SSH / device-link)同样抑制,回落价值估算。
  const xaiRateLimit = useXaiRateLimit(usesXaiQuotaForm && !isAnyRemoteSession);
  // 只有实际 Gateway 会话读取同一把 XD key 的 LiteLLM quota。订阅与自定义供应商
  // 均只展示各自的额度/本地会话统计，不读取 Model Access 账号配额。
  const claudeQuota = useClaudeAccountUsage(usesGatewayQuota);
  // 个人租户的额度事实在 Gateway 三池账本里(推理入口不提供管理面接口), 与上面的
  // LiteLLM quota 是两种租户的两种语义, 各自拿不到就各自隐藏 —— 不互相兜底。
  const creditUsage = useModelAccessCreditUsage(usesGatewayQuota);
  const creditTotals = React.useMemo(() => resolveCreditTotals(creditUsage), [creditUsage]);
  // Claude 订阅账号余量 (5h/周/分模型窗口, 端点 + proxy 旁路 headers 双源)。bridge 模型形态
  // 优先(不消耗 Claude 订阅额度),此时不读。
  const claudeSubscriptionUsage = useClaudeSubscriptionUsage(
    isClaudeSubscription && !isSubscriptionBridge && !isDeviceLinkRemote,
  );
  const latestTurnUsage = useLatestTurnUsageSummary(sessionId);
  const sessionSegment = sessionMoney?.amount
    ? t('todaySpend.sessionCostLabel', {
        cost: formatTurnCostMoney(sessionMoney),
      })
    : null;
  // codex-oauth / cc+chatgpt bridge → ChatGPT 用量看板; cc+xai bridge → xAI 账户页;
  // cc Claude 订阅 → claude.ai 用量页; 其余(cc 网关 / codex-api)→ 暂无看板(null,见文件头 TODO)。
  // device-link 远程会话额度属于被控端账号,本机浏览器打开的看板是控制端自己的账号 → 不跳。
  const usageDashboardUrl: string | null = isDeviceLinkRemote
    ? null
    : usesXaiQuotaForm
      ? XAI_ACCOUNT_URL
      : isCodexOauth || isChatgptBridge
        ? CODEX_USAGE_DASHBOARD_URL
        : isClaudeSubscription
          ? CLAUDE_USAGE_DASHBOARD_URL
          : null;
  // 看板链接行文案:与 usageDashboardUrl 一一对应;网关账号无看板 → null
  // (tooltip 不显示"打开看板"行,chip 也不可点)。
  const usageDashboardLabel: string | null = isDeviceLinkRemote
    ? null
    : usesXaiQuotaForm
      ? t('todaySpend.openXaiUsage')
      : isCodexOauth || isChatgptBridge
        ? t('todaySpend.openCodexUsage')
        : isClaudeSubscription
          ? t('todaySpend.openClaudeUsage')
          : null;
  const [windowLabelNowMs, setWindowLabelNowMs] = React.useState(() => Date.now());
  const codexResetSummary = React.useMemo(
    () => summarizeCodexRateLimitReset(codexRateLimits, windowLabelNowMs),
    [codexRateLimits, windowLabelNowMs],
  );

  // 当前形态下 chip 展示的限额窗口段 (Codex 订阅 / Claude 订阅共用结构);
  // 其它形态为空数组, 两个 rollup slot 空转。
  const chipWindows: ChipWindowSegment[] = usesCodexQuotaForm
    ? getCodexChipWindows(accountUsage, t, windowLabelNowMs)
    : isClaudeSubscription
      ? getClaudeChipWindows(claudeSubscriptionUsage, modelId, t, windowLabelNowMs)
      : [];
  // chip 最多两个窗口段, 固定两个 slot 无条件调 hook(Rules of Hooks)。
  // 重置滚动: 快照刷新中同窗口剩余百分比大幅回升(典型: 窗口到点重置 0% → 100%)
  // 时, 显示值从 0% 快速滚动到新值。
  const windowSlotA = chipWindows[0] ?? null;
  const windowSlotB = chipWindows[1] ?? null;
  const rollupA = useQuotaResetRollup(windowSlotA);
  const rollupB = useQuotaResetRollup(windowSlotB);
  // 窗口段元素登记表(key → span): 撒花锚点用, 段消失时由 ref 回调置 null。
  const segmentElsRef = React.useRef<Record<string, HTMLSpanElement | null>>({});
  const windowSegments: React.ReactNode[] = chipWindows.map((window, index) => {
    if (window.resetPending) {
      // 悬念期: 倒计时已归零、新快照未落地 —— 旧百分比已失真, 换成「重置中…」,
      // 呼吸省略号 (HTML span + opacity, 仅悬念期挂载; motion-safe = 尊重
      // prefers-reduced-motion, 降级为静态省略号)。新快照落地时由重置滚动
      // 动画从 0% 跳到新值揭晓。
      return (
        <React.Fragment key={window.key}>
          {t('todaySpend.resetPendingSegment', { label: window.label })}
          <span className="motion-safe:animate-pulse">…</span>
        </React.Fragment>
      );
    }
    const rollup = index === 0 ? rollupA : rollupB;
    const text = t(
      usesCodexQuotaForm ? 'todaySpend.codex.windowSegment' : 'todaySpend.claude.windowSegment',
      {
        label: window.label,
        remaining: formatPercent(rollup?.percent ?? window.remainingPercent),
      },
    );
    // 段落包一层 span 并登记元素: 撒花以「正在揭晓的这一段」的矩形为迸发范围
    // (粒子沿整段文字宽度散布, 而非集中在 chip 中心一点)。
    return (
      <span
        key={window.key}
        ref={(el) => {
          segmentElsRef.current[window.key] = el;
        }}
      >
        {text}
      </span>
    );
  });

  // 揭晓仪式: 重置滚动动画启动的上升沿放一次撒花粒子(QuotaResetConfetti,
  // DESIGN §14.4 sanctioned 豁免) —— 与 0%→100% 数字滚动同一瞬间开始,
  // 锚点取正在揭晓的窗口段元素(兜底 chip 容器)。
  const chipRef = React.useRef<HTMLDivElement | null>(null);
  const celebratingKey = rollupA?.celebrating
    ? windowSlotA?.key ?? null
    : rollupB?.celebrating
      ? windowSlotB?.key ?? null
      : null;
  const prevCelebratingRef = React.useRef(false);
  const [confettiBurst, setConfettiBurst] = React.useState<
    { nonce: number; anchor: HTMLElement } | null
  >(null);
  React.useEffect(() => {
    const celebrating = celebratingKey !== null;
    if (celebrating && !prevCelebratingRef.current) {
      const anchor = (celebratingKey ? segmentElsRef.current[celebratingKey] : null)
        ?? chipRef.current;
      if (anchor) {
        setConfettiBurst((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, anchor }));
      }
    }
    prevCelebratingRef.current = celebrating;
  }, [celebratingKey]);

  // 窗口 reset 时点列表以值签名 memo —— chipWindows 数组身份每次渲染都变
  // (含滚动动画的每一帧), 直接进 tick effect 依赖会让定时器反复重建。
  const resetsAtSignature = chipWindows.map((window) => window.resetsAtMs ?? 'na').join(',');
  const chipResetsAtMsList = React.useMemo(
    () => chipWindows.map((window) => window.resetsAtMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetsAtSignature 是 chipWindows reset 时点的值签名
    [resetsAtSignature],
  );

  React.useEffect(() => {
    // 订阅形态 (codex-oauth / cc+chatgpt bridge / claude 订阅) 的 reset 倒计时文案
    // 需要随时间走动: 常态分钟级 tick 足够; 任一窗口进入最后一分钟切秒级 tick,
    // 让「59秒 → 1秒」逐秒跳动。setTimeout 链每次 tick 后按最新窗口重估下一次延迟。
    if (!usesCodexQuotaForm && !isClaudeSubscription) return undefined;
    const delay = computeCountdownTickDelayMs(chipResetsAtMsList, Date.now());
    const timer = window.setTimeout(() => {
      setWindowLabelNowMs(Date.now());
    }, delay);
    return () => window.clearTimeout(timer);
  }, [usesCodexQuotaForm, isClaudeSubscription, windowLabelNowMs, chipResetsAtMsList]);

  // 悬念期主动催一次余量刷新, 让「重置揭晓」尽快到来 —— main read 都是
  // cached-first + 节流(Claude 订阅端点 180s + 退避; Codex WHAM 10s + in-flight
  // 去重), 每个 tick 重试一次是安全的; 新快照落地即结束悬念期。
  // 催刷通道必须与 chip 实际显示的配额槽一致:
  //   - chatgpt/ bridge 形态显示 WHAM(openai-web)槽 → 催 WHAM;
  //   - Codex CLI 形态显示 app-server 槽 —— WHAM 刷新只落 web 槽、帮不上它,
  //     且无空闲期 app-server 催刷通道, 靠下一个 turn 事件或悬念超时回落兜底;
  //   - Claude 订阅形态催订阅端点。
  const hasPendingResetWindow = chipWindows.some((window) => window.resetPending);
  React.useEffect(() => {
    if (!hasPendingResetWindow) return;
    if (isChatgptBridge) {
      requestCodexAccountRefresh();
    } else if (isClaudeSubscription && !usesCodexQuotaForm) {
      requestClaudeSubscriptionRefresh();
    }
  }, [hasPendingResetWindow, isChatgptBridge, isClaudeSubscription, usesCodexQuotaForm, windowLabelNowMs]);

  const isDashboardClickable = usageDashboardUrl !== null;
  const handleClick = () => {
    if (!usageDashboardUrl) return; // 网关账号暂无看板:点击无反应
    void window.electronAPI.openExternal(usageDashboardUrl);
  };

  let labelNode: React.ReactNode;
  let tooltipNode: React.ReactNode = usageDashboardLabel;
  if (isDeviceLinkRemote) {
    // device-link 远程会话不读取本机账号形态；金额仍使用同一个会话合计投影。
    const chipSegments = sessionSegment ? [sessionSegment] : [];
    labelNode = chipSegments.length > 0
      ? renderSegmentedLabel(chipSegments)
      : <span className="tabular-nums opacity-60">{DEFAULT_MONEY_SYMBOL}</span>;
    const tooltipLines: string[] = [];
    pushSessionUsageLines(tooltipLines, sessionUsage, sessionTokens, t);
    appendLatestTurnUsageLines(tooltipLines, latestTurnUsage, t);
    tooltipNode = tooltipLines.length > 0 ? buildTooltipNode(tooltipLines) : null;
  } else if (usesCodexQuotaForm) {
    // 配额窗口跟随当前渠道；会话金额独立汇总历史上所有已发生的 turn。
    const chipSegments = [...windowSegments];
    if (sessionSegment) chipSegments.push(sessionSegment);
    labelNode = chipSegments.length > 0
      ? renderSegmentedLabel(chipSegments)
      : <span className="tabular-nums opacity-60">{DEFAULT_MONEY_SYMBOL}</span>;
    tooltipNode = buildCodexTooltipNode(
      accountUsage,
      sessionTokens,
      sessionUsage,
      codexResetSummary,
      t,
      formatterLocale,
      usageDashboardLabel,
      windowLabelNowMs,
      latestTurnUsage,
    );
  } else if (usesXaiQuotaForm) {
    // xAI 无订阅窗口数据源；限流细节进 tooltip，会话金额仍走统一合计。
    const chipSegments = sessionSegment ? [sessionSegment] : [];
    labelNode = chipSegments.length > 0
      ? renderSegmentedLabel(chipSegments)
      : <span className="tabular-nums opacity-60">{DEFAULT_MONEY_SYMBOL}</span>;
    tooltipNode = buildXaiTooltipNode(
      xaiRateLimit,
      sessionTokens,
      sessionUsage,
      t,
      usageDashboardLabel,
      latestTurnUsage,
    );
  } else if (isClaudeSubscription) {
    // Claude 订阅形态 (方案 B): chip 显示「剩余时长 剩余%」倒计时段 + 本会话合计,
    // 倒计时由 windowLabelNowMs 驱动 (常态 60s tick, 最后一分钟逐秒); tooltip 保留精确时间。
    const chipSegments = [...windowSegments];
    if (sessionSegment) chipSegments.push(sessionSegment);
    labelNode = chipSegments.length > 0
      ? renderSegmentedLabel(chipSegments)
      : <span className="tabular-nums opacity-60">{DEFAULT_MONEY_SYMBOL}</span>;
    tooltipNode = buildClaudeSubscriptionTooltipNode(
      claudeSubscriptionUsage,
      modelId,
      sessionUsage,
      t,
      usageDashboardLabel,
      latestTurnUsage,
    );
  } else {
    const slots = computeMetricSlots(claudeQuota, creditTotals, sessionMoney, t);
    const chipSegments = getGatewayChipSegments(slots);
    const codexApiHasTokenFallback = isCodexApi
      && !slots.session.available
      && hasPositiveSessionTokens(sessionTokens);
    const codexApiEmptyState = isCodexApi
      && !slots.session.available
      && !hasPositiveSessionTokens(sessionTokens)
      ? getCodexApiEmptyState(latestTurnUsage)
      : null;
    if (codexApiHasTokenFallback) {
      chipSegments.push(t('todaySpend.codex.sessionTokensLine', {
        tokens: formatCompactTokens(Math.floor(sessionTokens ?? 0)),
      }));
    }
    // tooltip 主体: 主 chip 未显示且可用的 metric, 同样按固定顺序
    const tooltipMetricLines = METRIC_KEYS.filter(
      (k) => !PRIMARY_GATEWAY_METRICS.includes(k) && slots[k].available,
    ).map((k) => slots[k].tooltipLabel ?? slots[k].label);

    const tooltipLines: string[] = [];
    // server-side endpoint 独立可能失败, 各自挂掉时都加一行 ⚠️ 提示, 让用户知道
    // 那段是端点降级而非数据为 0
    // 个人租户没有"月度配额"这回事(三池账本是买断 + 赠送制), 拿到 credit 就不该再
    // 提示月度降级 —— 只有两种语义都拿不到(未开户 / 网关不可用)才是真降级。
    if (usesGatewayQuota && !claudeQuota && !creditTotals) {
      tooltipLines.push(t('todaySpend.tooltip.monthlyUnavailable'));
    } else if (claudeQuota?.todaySpend === null) {
      tooltipLines.push(t('todaySpend.tooltip.dailyUnavailable'));
    }
    if (slots.session.available) {
      pushSessionUsageLines(tooltipLines, sessionUsage, null, t);
    }
    if (codexApiHasTokenFallback) {
      tooltipLines.push(t('todaySpend.codex.sessionTokensLine', {
        tokens: formatCompactTokens(Math.floor(sessionTokens ?? 0)),
      }));
    }
    tooltipLines.push(...tooltipMetricLines);
    appendLatestTurnUsageLines(tooltipLines, latestTurnUsage, t);
    if (codexApiEmptyState) {
      tooltipLines.unshift(t(
        codexApiEmptyState === 'no-usage'
          ? 'todaySpend.codex.noUsageDetail'
          : 'todaySpend.codex.unavailableDetail',
      ));
    }
    // 链接行在最底(用空行隔开);网关账号 label 为 null → 不追加(见 usageDashboardUrl)。
    pushDashboardLinkLine(tooltipLines, usageDashboardLabel);
    tooltipNode = buildTooltipNode(tooltipLines);

    if (chipSegments.length === 0) {
      if (codexApiEmptyState) {
        labelNode = (
          <span className="tabular-nums opacity-60">
            {t(codexApiEmptyState === 'no-usage'
              ? 'todaySpend.codex.noUsageLabel'
              : 'todaySpend.codex.unavailableLabel')}
          </span>
        );
      } else {
        labelNode = <span className="tabular-nums opacity-60">{DEFAULT_MONEY_SYMBOL}</span>;
      }
    } else {
      // 之前用纯字符串 ".join(' · ')" — middle dot · 落在 x-height, 周围混着 cap-height
      // 大写字母 + 数字 + $/k, 视觉上文字"高低不齐"。改成结构化渲染:
      //   - 段间用 CSS 横线 (border-l h-3) 当分隔符 — 高度与字号绑定, 视觉上像条直线
      //   - 文字段内统一加 tabular-nums + slashed-zero, 数字等宽对齐
      labelNode = renderSegmentedLabel(chipSegments);
    }
  }

  // Claude 订阅告警态: 影响当前会话的窗口 (5h / 总周限 / 当前模型 scoped) 任一逼近 /
  // 打满, 或 headers 报 rejected → chip 变 error 色 (语义豁免色, 跨主题一致)。
  // 其它模型的周限吃紧不染红 —— chip 上没有那一段, 红了也无从解释 (见
  // isClaudeSubscriptionAlerting 对 allowed_warning 的取舍)。
  const claudeSubscriptionAlerting = isClaudeSubscription
    && isClaudeSubscriptionAlerting(claudeSubscriptionUsage, modelId);

  // 与 ContextCapacityRing 视觉对齐 (h-5 = 20px) + reset button UA 默认 padding/border。
  // tabular-nums 让 "$306 / $1.2k" 这类数字段的字符宽度等宽, 段间数字落点对齐。
  const buttonClass = cn(
    'inline-flex h-5 shrink-0 items-center',
    'text-[12px] font-medium leading-none tabular-nums',
    claudeSubscriptionAlerting
      ? 'text-[var(--error-fg)] hover:text-[var(--error-fg-strong)]'
      // 不可点(网关账号)时不加 hover 变色,避免暗示可交互。
      : cn('text-[var(--msg-tool-card-chevron)]', isDashboardClickable && 'hover:text-foreground'),
    'border-0 bg-transparent p-0 m-0',
    'transition-colors',
    'focus:outline-none',
  );

  return (
    <div
      ref={chipRef}
      className="inline-flex h-5 shrink-0 items-center gap-3"
      onMouseEnter={refreshCodexRateLimits}
      onFocusCapture={refreshCodexRateLimits}
    >
      <Tip text={tooltipNode}>
        {isDashboardClickable ? (
          <button
            type="button"
            onClick={handleClick}
            className={buttonClass}
            aria-label={usageDashboardLabel ?? undefined}
          >
            {labelNode}
          </button>
        ) : (
          // 网关 / 托管账号暂无看板可跳(见 usageDashboardUrl):渲染为非交互文本,
          // 点击无反应、不显示手型 / hover 态;用量指标与 tooltip 仍照常展示。
          <span className={cn(buttonClass, 'cursor-default')}>{labelNode}</span>
        )}
      </Tip>
      {confettiBurst && (
        <QuotaResetConfetti
          key={confettiBurst.nonce}
          anchor={confettiBurst.anchor}
          onDone={() => setConfettiBurst(null)}
        />
      )}
    </div>
  );
}
