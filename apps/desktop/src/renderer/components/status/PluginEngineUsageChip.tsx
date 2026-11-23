import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PLUGIN_USAGE_READ_INTERVAL_MS, type GhostHarnessUsage } from '@cindy/plugin-protocol';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { readPluginEngineUsage } from '@/hooks/pluginEngineUsage';
import { cn } from '@/lib/utils';
import { useHoverOpenMenu } from '@/components/sidebar/useHoverOpenMenu';
import { quotaLevelFromRemaining } from '@cindy/maker-shared/quota-level';
import { QUOTA_TEXT_COLOR_CLASSES } from './QuotaBar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { QuotaHoverCard } from './QuotaHoverCard';
import { pluginEngineUsageAccount, pluginEngineUsageBalances } from './pluginEngineUsageAccount';
import { formatQuotaResetDuration } from './usageCardModel';

/** Mounted only for the visible task. Its React key includes the account device and engine. */
export function PluginEngineUsageChip({ engineKey, name, deviceId, running }: {
  engineKey: string;
  name?: string;
  deviceId: string | null;
  running: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [usage, setUsage] = useState<GhostHarnessUsage | null>(null);
  const [now, setNow] = useState(Date.now);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    const owner = getDataOwnerGeneration();
    let active = true;
    let pending = false;
    let nextRead = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (!active || document.hidden || pending || !isDataOwnerGenerationCurrent(owner)) return;
      clearTimeout(timer);
      const delay = nextRead - Date.now();
      if (delay > 0) {
        timer = setTimeout(check, delay);
        return;
      }
      pending = true;
      const read = readPluginEngineUsage(owner, deviceId, engineKey);
      const snapshot = await read.result;
      nextRead = read.freshUntil;
      pending = false;
      if (!active || !isDataOwnerGenerationCurrent(owner)) return;
      setNow(Date.now());
      setUsage(snapshot);
      // One read after the nearest reset. An already elapsed window waits for a new user event.
      const resets = snapshot?.windows?.flatMap(row => row.resetsAt && row.resetsAt > Date.now() ? [row.resetsAt] : []) ?? [];
      if (resets.length) timer = setTimeout(check, Math.min(2_147_483_647, Math.max(nextRead, Math.min(...resets)) - Date.now() + 1));
    };
    refresh.current = check;
    void check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      active = false;
      clearTimeout(timer);
      refresh.current = () => {};
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [engineKey, deviceId]);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) refresh.current();
    wasRunning.current = running;
  }, [running]);
  useEffect(() => {
    if (!usage?.windows?.some(row => row.resetsAt)) return;
    const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, PLUGIN_USAGE_READ_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [usage]);

  const menu = useHoverOpenMenu({ onOpenChange: open => { if (open) refresh.current(); } });
  if (!usage) return null;
  const windows = usage.windows ?? [];
  const current = windows.filter(row => !row.resetsAt || row.resetsAt > now);
  const balances = pluginEngineUsageBalances(usage, i18n.language, t);
  // The compact row names the most constrained group. The full card shows every group.
  const first = current.reduce<typeof current[number] | undefined>((lowest, row) =>
    !lowest || row.remainingPercent < lowest.remainingPercent ? row : lowest, undefined);
  const reset = formatQuotaResetDuration(first?.resetsAt ? first.resetsAt / 1000 : null, now, t);
  const value = first ? t('quotaCard.remainingPercent', { percent: Math.round(first.remainingPercent) })
    : balances[0] ?? t('quotaCard.resetPending');
  const level = first ? quotaLevelFromRemaining(first.remainingPercent)
    : usage.balances?.[0] && Number(usage.balances[0].amount) <= 0 ? 'crit' : 'normal';
  const title = name || t('quotaCard.usageTitle');
  const account = pluginEngineUsageAccount(usage, { title, now, language: i18n.language, t });
  return (
    <Popover open={menu.open} onOpenChange={menu.onOpenChange} modal={false}>
      <PopoverTrigger asChild>
        <button type="button" {...menu.triggerProps} onClick={event => { if (menu.open) event.preventDefault(); }} aria-label={[title, first?.label, reset, value].filter(Boolean).join(' · ')}
          className="flex min-w-0 items-center gap-1 rounded-sm text-12 font-medium tabular-nums text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
          {first && <span title={first.label} className="max-w-28 truncate">{first.label}</span>}
          {reset && <span className="whitespace-nowrap">{reset}</span>}
          <span className={cn('whitespace-nowrap', QUOTA_TEXT_COLOR_CLASSES[level])}>{value}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent {...menu.contentProps} side="top" align="end" className="w-auto max-w-[calc(100vw-16px)] border-0 bg-transparent p-0 shadow-none">
        <QuotaHoverCard account={account} nowMs={now} />
      </PopoverContent>
    </Popover>
  );
}
