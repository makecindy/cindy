import type { TFunction } from 'i18next';
import type { GhostHarnessUsage } from '@cindy/plugin-protocol';
import {
  PLUGIN_FIVE_HOUR_WINDOW_MINUTES,
  PLUGIN_WEEKLY_WINDOW_MINUTES,
  clampPluginQuotaPercent,
  effectivePluginWindowMinutes,
  orderPluginUsageCardWindows,
  parsePluginQuotaWindowLabel,
  type PluginQuotaModelRef,
  type PluginQuotaWindow,
} from '@cindy/maker-shared/plugin-engine-quota';

import type { UsageCardAccount } from './usageCardModel';

/** One line per currency balance the engine's plugin reported, in the reader's number format. */
export function pluginEngineUsageBalances(usage: GhostHarnessUsage, language: string, t: TFunction): string[] {
  return (usage.balances ?? []).map((row) => t('providerAccountUsage.deepSeek.chipBalance', {
    balance: new Intl.NumberFormat(language, { style: 'currency', currency: row.currency, currencyDisplay: 'code' })
      .format(Number(row.amount)),
  }));
}

/**
 * Fallback window name when no future reset countdown is available, matching
 * TodaySpendChip `formatWindowLabel` (5h / Weekly / Nd / Nh / Nm, else raw label).
 */
export function formatPluginWindowFallbackLabel(
  window: Pick<PluginQuotaWindow, 'label' | 'windowMinutes'>,
  t: TFunction,
): string {
  const minutes = effectivePluginWindowMinutes(window);
  if (minutes === null) return window.label;
  if (minutes === PLUGIN_FIVE_HOUR_WINDOW_MINUTES) return '5h';
  if (minutes >= PLUGIN_WEEKLY_WINDOW_MINUTES && minutes % PLUGIN_WEEKLY_WINDOW_MINUTES === 0) {
    return t('quotaCard.weeklyLabel');
  }
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    if (days < 7) return t('todaySpend.codex.daysWindow', { days });
  }
  if (minutes >= PLUGIN_WEEKLY_WINDOW_MINUTES) return t('todaySpend.codex.weekWindow');
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

/**
 * Localizes standard 5h / weekly suffixes inside a hover-card window heading while preserving
 * any group prefix (e.g. "Gemini Models · 5h" -> "Gemini Models · 5 小时限额").
 */
export function formatPluginUsageCardWindowTitle(
  window: Pick<PluginQuotaWindow, 'label' | 'windowMinutes'>,
  t: TFunction,
): string {
  const parsed = parsePluginQuotaWindowLabel(window.label);
  const minutes = effectivePluginWindowMinutes(window);
  const localizedPeriod =
    minutes === PLUGIN_FIVE_HOUR_WINDOW_MINUTES
      ? t('quotaCard.fiveHourLabel')
      : minutes === PLUGIN_WEEKLY_WINDOW_MINUTES
        ? t('quotaCard.weeklyLabel')
        : null;
  if (!localizedPeriod) return window.label;
  if (parsed.groupName) return `${parsed.groupName} · ${localizedPeriod}`;
  if (parsed.periodText) return localizedPeriod;
  return window.label;
}

/**
 * The usage card of a plugin engine's account: live windows as bars (with pace when window length
 * is known), balances and elapsed/resetting windows as detail lines so stale percentages are never
 * presented as fresh quota. Shared by the task's usage chip and Settings → Model providers.
 */
export function pluginEngineUsageAccount(
  usage: GhostHarnessUsage,
  options: {
    title: string;
    now: number;
    language: string;
    t: TFunction;
    model?: PluginQuotaModelRef | null;
    identity?: string | null;
    planLabel?: string | null;
  },
): UsageCardAccount {
  const { title, now, language, t, model, identity, planLabel } = options;
  const ordered = orderPluginUsageCardWindows(usage.windows, model);
  const liveWindows = ordered.filter((row) => !row.resetsAt || row.resetsAt > now);
  const expiredWindows = ordered.filter(
    (row) => typeof row.resetsAt === 'number' && row.resetsAt <= now,
  );
  return {
    title,
    ...(identity ? { identity } : {}),
    ...(planLabel ? { planLabel } : {}),
    updatedAt: usage.updatedAt,
    windows: liveWindows.map((row, index) => {
      const minutes = effectivePluginWindowMinutes(row);
      return {
        key: `${row.label}:${minutes ?? index}`,
        title: formatPluginUsageCardWindowTitle(row, t),
        showRemaining: true,
        ...(minutes !== null ? { paceWindowMinutes: minutes } : {}),
        window: {
          utilization: 100 - clampPluginQuotaPercent(row.remainingPercent),
          resetsAt: row.resetsAt ? row.resetsAt / 1000 : null,
        },
      };
    }),
    details: [
      ...pluginEngineUsageBalances(usage, language, t),
      ...expiredWindows.map((row) => `${formatPluginUsageCardWindowTitle(row, t)} · ${t('quotaCard.resetPending')}`),
    ],
  };
}
