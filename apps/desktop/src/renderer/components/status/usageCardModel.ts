/** Provider snapshots are adapted here; the card renders only this common presentation model. */
import type { TFunction } from 'i18next';
import type { CodexRateLimitResetSummary } from '@cindy/maker-shared/session-controls';
import type { RateLimitSnapshot } from '@/hooks/useAccountUsage';
import type { XaiRateLimitSnapshot } from '@/hooks/useXaiRateLimit';
import type { ClaudeSubscriptionUsageSnapshot } from '../../../shared/claudeSubscriptionUsage';
import type {
  DeepSeekAccountUsageSnapshot,
  ZhipuCodingPlanQuotaSnapshot,
} from '../../../shared/providerAccountUsage';
import {
  isXaiWeeklyUsageCurrent,
  type XaiSubscriptionUsageSnapshot,
} from '../../../shared/xaiSubscriptionUsage';
import { formatCompactTokens } from '@/lib/usageFormat';
import {
  formatClaudeSubscriptionPlanLabel,
  formatCodexPlanLabel,
} from '@/lib/subscriptionPlanLabel';

export interface UsageCardWindow {
  key: string;
  title: string;
  /** Weekly quotas show the available percentage; other windows retain used percentage. */
  showRemaining?: boolean;
  window: {
    utilization: number;
    /** Epoch seconds, matching provider reset timestamps. */
    resetsAt?: number | null;
    severity?: string | null;
  };
  /** Only set when the provider supplies a known duration and observation time. */
  paceWindowMinutes?: number;
  detail?: string;
  /** Composition of this window, not independently enforceable quota windows. */
  breakdown?: ReadonlyArray<{ label: string; value: string }>;
}

export interface UsageCardAccount {
  title?: string;
  identity?: string | null;
  planLabel?: string | null;
  windows: UsageCardWindow[];
  details?: string[];
  notices?: Array<{ text: string; tone: 'warn' | 'crit' }>;
  emptyText?: string;
  updatedAt?: number | null;
}

/** Compact surfaces lead with time remaining; round up to minutes and show
 * at most two units. An elapsed timestamp awaits a new authoritative snapshot. */
export function formatQuotaResetCountdown(
  resetsAt: number | null | undefined,
  nowMs: number,
  t: TFunction,
): string | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  const remainingMs = resetsAt * 1000 - nowMs;
  if (remainingMs <= 0) return t('quotaCard.resetPending');
  const minutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  const parts =
    days > 0
      ? [
          `${days}${t('todaySpend.unit.day')}`,
          ...(hours ? [`${hours}${t('todaySpend.unit.hour')}`] : []),
        ]
      : hours > 0
        ? [
            `${hours}${t('todaySpend.unit.hour')}`,
            ...(remainder ? [`${remainder}${t('todaySpend.unit.minute')}`] : []),
          ]
        : [`${minutes}${t('todaySpend.unit.minute')}`];
  return t('quotaCard.resetIn', { duration: parts.join(' ') });
}

export function formatQuotaResetAt(
  resetsAt: number | null | undefined,
  nowMs: number,
  locale?: string,
): string | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  const date = new Date(resetsAt * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const now = new Date(nowMs);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return sameDay
    ? time
    : `${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date)} ${time}`;
}

export function buildClaudeUsageCard(
  snapshot: ClaudeSubscriptionUsageSnapshot | null,
  t: TFunction,
): UsageCardAccount {
  if (!snapshot) return { title: 'Claude', windows: [], emptyText: t('quotaCard.waiting') };
  const windows: UsageCardWindow[] = [];
  const add = (
    key: string,
    title: string,
    window: UsageCardWindow['window'] | null | undefined,
    paceWindowMinutes?: number,
  ) => {
    if (window && Number.isFinite(window.utilization))
      windows.push({ key, title, window, paceWindowMinutes, showRemaining: true });
  };
  add('five-hour', t('quotaCard.fiveHourLabel'), snapshot.fiveHour);
  add('seven-day', t('quotaCard.weeklyLabel'), snapshot.sevenDay, 10_080);
  for (const [index, scoped] of (Array.isArray(snapshot.scoped) ? snapshot.scoped : []).entries()) {
    if (!scoped) continue;
    add(
      `scoped-${index}`,
      t('quotaCard.modelWeeklyLabel', { model: scoped.modelDisplayName }),
      scoped,
    );
  }
  const rawRateLimitStatus = snapshot.rateLimitStatus;
  const status =
    typeof rawRateLimitStatus === 'string' ? rawRateLimitStatus.trim().toLowerCase() : undefined;
  return {
    title: 'Claude',
    planLabel: formatClaudeSubscriptionPlanLabel(snapshot.subscriptionType),
    windows,
    updatedAt: snapshot.updatedAt,
    emptyText: windows.length ? undefined : t('quotaCard.noWindows'),
    notices:
      status === 'rejected'
        ? [{ text: t('quotaCard.limitRejected'), tone: 'crit' }]
        : status === 'allowed_warning'
          ? [{ text: t('quotaCard.limitWarning'), tone: 'warn' }]
          : [],
    details: snapshot.extraUsage?.isEnabled === true ? [t('quotaCard.extraUsageEnabled')] : [],
  };
}

/** DeepSeek 余额卡：余额不是限额窗口，与 Codex credits 同层走 details 行。 */
export function buildDeepSeekUsageCard(
  snapshot: DeepSeekAccountUsageSnapshot | null,
  t: TFunction,
  locale?: string,
): UsageCardAccount {
  if (!snapshot) return { title: 'DeepSeek', windows: [], emptyText: t('quotaCard.waiting') };
  const format = (value: string, currency: string): string => {
    try {
      const fractionLength = value.split('.')[1]?.replace(/0+$/, '').length ?? 0;
      const defaultDigits =
        new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
          .minimumFractionDigits ?? 0;
      const formatter = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        maximumFractionDigits: Math.max(defaultDigits, fractionLength),
      });
      // ECMA-402 允许直接 format 十进制字符串，避免先过 Number 再舍入。
      return (formatter.format as unknown as (input: string) => string)(value);
    } catch {
      return `${value} ${currency}`;
    }
  };
  // isAvailable=false 时上游仍会返回余额明细：保留展示，另用警示条说明账户状态，
  // 不能与输入框积分条（同源数据仍显示余额）互相矛盾。
  const details = snapshot.balances.map((balance) =>
    t('providerAccountUsage.deepSeek.balanceLine', {
      total: format(balance.totalBalance, balance.currency),
      granted: format(balance.grantedBalance, balance.currency),
      toppedUp: format(balance.toppedUpBalance, balance.currency),
    }),
  );
  if (!snapshot.isAvailable || snapshot.balances.length === 0) {
    return {
      title: 'DeepSeek',
      windows: [],
      details: snapshot.balances.length > 0 ? details : undefined,
      notices: snapshot.balances.length > 0
        ? [{ text: t('providerAccountUsage.deepSeek.unavailable'), tone: 'warn' }]
        : undefined,
      updatedAt: snapshot.fetchedAt,
      emptyText: snapshot.balances.length > 0 ? undefined : t('quotaCard.noWindows'),
    };
  }
  return {
    title: 'DeepSeek',
    windows: [],
    details,
    updatedAt: snapshot.fetchedAt,
  };
}

/** 智谱 GLM Coding Plan 额度卡：与 Claude 订阅同构（5 小时 + 每周窗口）。 */
export function buildZhipuUsageCard(
  snapshot: ZhipuCodingPlanQuotaSnapshot | null,
  t: TFunction,
): UsageCardAccount {
  if (!snapshot) return { title: 'GLM Coding Plan', windows: [], emptyText: t('quotaCard.waiting') };
  if (snapshot.noPlan) {
    return {
      title: 'GLM Coding Plan',
      windows: [],
      updatedAt: snapshot.fetchedAt,
      emptyText: t('providerAccountUsage.zhipuCodingPlan.noPlan'),
    };
  }
  const windows: UsageCardWindow[] = [];
  if (snapshot.fiveHour) {
    windows.push({
      key: 'five-hour',
      title: t('quotaCard.fiveHourLabel'),
      showRemaining: true,
      window: {
        utilization: snapshot.fiveHour.usedPercent,
        resetsAt: snapshot.fiveHour.resetsAt != null ? snapshot.fiveHour.resetsAt / 1000 : null,
      },
    });
  }
  if (snapshot.weekly) {
    windows.push({
      key: 'weekly',
      title: t('quotaCard.weeklyLabel'),
      showRemaining: true,
      window: {
        utilization: snapshot.weekly.usedPercent,
        resetsAt: snapshot.weekly.resetsAt != null ? snapshot.weekly.resetsAt / 1000 : null,
      },
    });
  }
  return {
    title: 'GLM Coding Plan',
    planLabel: snapshot.level ? snapshot.level.toUpperCase() : undefined,
    windows,
    updatedAt: snapshot.fetchedAt,
    emptyText: windows.length ? undefined : t('quotaCard.noWindows'),
  };
}

/** Window labels follow the upstream duration, never assume a fixed pair of windows. */
export function quotaWindowLabel(minutes: number | null | undefined, t: TFunction): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0)
    return t('todaySpend.codex.limitWindow');
  if (minutes === 10_080) return t('quotaCard.weeklyLabel');
  if (minutes % 1440 === 0) return t('todaySpend.codex.daysWindow', { days: minutes / 1440 });
  if (minutes === 300) return t('quotaCard.fiveHourLabel');
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.round(minutes)}m`;
}

export function buildCodexUsageCard(
  snapshot: RateLimitSnapshot | null,
  resetSummary: CodexRateLimitResetSummary | null,
  t: TFunction,
  nowMs: number,
  locale?: string,
): UsageCardAccount {
  const windows: UsageCardWindow[] = [];
  for (const key of ['primary', 'secondary'] as const) {
    const window = snapshot?.[key];
    if (!window || !Number.isFinite(window.usedPercent)) continue;
    windows.push({
      key,
      title: quotaWindowLabel(window.windowMinutes, t),
      showRemaining: true,
      window: { utilization: window.usedPercent, resetsAt: window.resetsAt },
      paceWindowMinutes: window.windowMinutes === 10_080 ? 10_080 : undefined,
    });
  }
  const details: string[] = [];
  const credits = snapshot?.credits;
  const balance =
    typeof credits?.balance === 'string' ? credits.balance.trim().replace(/,/g, '') : '';
  const numericBalance = balance ? Number(balance) : NaN;
  const hasBalance = Number.isFinite(numericBalance);
  if (hasBalance)
    details.push(
      t('todaySpend.codex.creditsLine', {
        credits: numericBalance.toLocaleString(locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
      }),
    );
  if (credits?.unlimited) details.push(t('todaySpend.codex.balanceUnlimited'));
  else if (credits && !credits.hasCredits) details.push(t('todaySpend.codex.balanceDepleted'));
  else if (credits?.hasCredits && !hasBalance) details.push(t('todaySpend.codex.balanceAvailable'));
  if (resetSummary?.hasResetCreditCount)
    details.push(
      t('todaySpend.codex.resetCreditsAvailableLine', { count: resetSummary.availableCount }),
    );
  const expiryAt = formatQuotaResetAt(resetSummary?.earliestExpiryAt, nowMs, locale);
  if (expiryAt) details.push(t('todaySpend.codex.resetCreditEarliestExpiryLine', { at: expiryAt }));
  const reason = snapshot?.rateLimitReachedType;
  const exhausted = windows.some(({ window }) => window.utilization >= 99.95);
  return {
    title: 'ChatGPT',
    planLabel: formatCodexPlanLabel(snapshot?.planType),
    windows,
    details,
    updatedAt: snapshot?.updatedAt,
    emptyText: windows.length ? undefined : t('quotaCard.noWindows'),
    notices:
      exhausted && reason && !reason.includes('credits_depleted')
        ? [
            {
              text: t('todaySpend.codex.limitReached', {
                reason: reason
                  .replace(/[_-]+/g, ' ')
                  .replace(/\b\w/g, (char) => char.toUpperCase()),
              }),
              tone: 'crit',
            },
          ]
        : [],
    ...(!snapshot ? { emptyText: t('quotaCard.waiting') } : {}),
  };
}

export function buildXaiUsageCard(
  usage: XaiSubscriptionUsageSnapshot | null,
  rateLimit: XaiRateLimitSnapshot | null,
  t: TFunction,
  nowMs: number,
): UsageCardAccount {
  const weekly = isXaiWeeklyUsageCurrent(usage, nowMs) ? usage : null;
  const windows: UsageCardWindow[] = [];
  const details: string[] = [];
  if (weekly && typeof weekly.creditUsagePercent === 'number') {
    windows.push({
      key: 'weekly',
      title: t('quotaCard.weeklyLabel'),
      showRemaining: true,
      window: { utilization: weekly.creditUsagePercent, resetsAt: weekly.resetsAt },
      paceWindowMinutes: 10_080,
      detail: t('todaySpend.xai.accountWeeklyHint'),
    });
    if (
      typeof weekly.prepaidBalance === 'number' &&
      Number.isFinite(weekly.prepaidBalance) &&
      weekly.prepaidBalance > 0
    ) {
      details.push(
        t('todaySpend.xai.extraCreditsLine', { amount: `US$${weekly.prepaidBalance.toFixed(2)}` }),
      );
    }
  }
  if (
    rateLimit &&
    typeof rateLimit.remainingRequests === 'number' &&
    typeof rateLimit.limitRequests === 'number'
  ) {
    details.push(
      t('todaySpend.xai.requestsLine', {
        remaining: rateLimit.remainingRequests.toLocaleString(),
        limit: rateLimit.limitRequests.toLocaleString(),
      }),
    );
  }
  if (
    rateLimit &&
    typeof rateLimit.remainingTokens === 'number' &&
    typeof rateLimit.limitTokens === 'number'
  ) {
    details.push(
      t('todaySpend.xai.tokensLine', {
        remaining: formatCompactTokens(rateLimit.remainingTokens),
        limit: formatCompactTokens(rateLimit.limitTokens),
      }),
    );
  }
  return {
    title: 'Grok',
    planLabel: usage?.planLabel,
    windows,
    details,
    updatedAt: usage?.updatedAt,
    emptyText: windows.length ? undefined : t('todaySpend.xai.noQuotaDetail'),
  };
}
