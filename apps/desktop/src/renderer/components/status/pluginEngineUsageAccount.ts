import type { TFunction } from 'i18next';
import type { GhostHarnessUsage } from '@cindy/plugin-protocol';

import type { UsageCardAccount } from './usageCardModel';

/** One line per currency balance the engine's plugin reported, in the reader's number format. */
export function pluginEngineUsageBalances(usage: GhostHarnessUsage, language: string, t: TFunction): string[] {
  return (usage.balances ?? []).map((row) => t('providerAccountUsage.deepSeek.chipBalance', {
    balance: new Intl.NumberFormat(language, { style: 'currency', currency: row.currency, currencyDisplay: 'code' })
      .format(Number(row.amount)),
  }));
}

/**
 * The usage card of a plugin engine's account: every window that has not reset yet as a bar,
 * balances and windows waiting for a new reading as detail lines. Shared by the task's usage chip
 * and the engine's detail in Settings → Model providers.
 */
export function pluginEngineUsageAccount(
  usage: GhostHarnessUsage,
  options: { title: string; now: number; language: string; t: TFunction },
): UsageCardAccount {
  const { title, now, language, t } = options;
  const windows = usage.windows ?? [];
  return {
    title,
    updatedAt: usage.updatedAt,
    windows: windows.filter((row) => !row.resetsAt || row.resetsAt > now).map((row, index) => ({
      key: String(index), title: row.label, showRemaining: true,
      window: { utilization: 100 - row.remainingPercent, resetsAt: row.resetsAt ? row.resetsAt / 1000 : null },
    })),
    details: [...pluginEngineUsageBalances(usage, language, t), ...windows.filter((row) => row.resetsAt && row.resetsAt <= now)
      .map((row) => row.label + ' · ' + t('quotaCard.resetPending'))],
  };
}
