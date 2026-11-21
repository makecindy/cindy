import { useState } from 'react';
import { Network, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';
import { useUpdateBannerDismiss } from '@/hooks/useUpdateBannerDismiss';
import { useLocalNetworkAccess } from '@/hooks/useLocalNetworkAccess';
import type { LocalNetworkReminder } from '../../../shared/localNetwork';

const DISMISSED_KEY = 'cindy.localNetworkReminder.dismissed';

export interface LocalNetworkReminderDismissal {
  controlAt?: number;
  deviceIds?: string[];
}

/** A dismissed reminder returns only for new evidence: another control opt-in, or a new relay-only device. */
export function shouldShowLocalNetworkReminder(
  reminder: LocalNetworkReminder | null,
  dismissed: LocalNetworkReminderDismissal | null,
): boolean {
  if (!reminder) return false;
  if (reminder.reason === 'controlEnabled') return dismissed?.controlAt !== reminder.at;
  const seen = new Set(dismissed?.deviceIds ?? []);
  return reminder.deviceIds.some((id) => !seen.has(id));
}

export function dismissLocalNetworkReminder(
  reminder: LocalNetworkReminder,
  dismissed: LocalNetworkReminderDismissal | null,
): LocalNetworkReminderDismissal {
  if (reminder.reason === 'controlEnabled') return { ...dismissed, controlAt: reminder.at };
  return { ...dismissed, deviceIds: [...new Set([...(dismissed?.deviceIds ?? []), ...reminder.deviceIds])] };
}

function readDismissal(): LocalNetworkReminderDismissal | null {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.controlAt === 'number' ? { controlAt: record.controlAt } : {}),
      ...(Array.isArray(record.deviceIds)
        ? { deviceIds: record.deviceIds.filter((id): id is string => typeof id === 'string').slice(-50) }
        : {}),
    };
  } catch {
    return null;
  }
}

interface LocalNetworkBannerProps {
  isCollapsed: boolean;
}

/** Shown only while macOS denies Local Network access and it is slowing the user's own devices down. */
export function LocalNetworkBanner({ isCollapsed }: LocalNetworkBannerProps) {
  const { t } = useTranslation();
  const { status: updateStatus } = useUpdateStatus();
  const { dismissed: updateDismissed } = useUpdateBannerDismiss();
  const { state, requesting, request } = useLocalNetworkAccess({ probe: false });
  const [dismissal, setDismissal] = useState(readDismissal);

  const reminder = state?.access === 'denied' ? state.reminder : null;
  const updateHasPriority =
    (updateStatus === 'ready' || updateStatus === 'superseding') && !updateDismissed;
  if (isCollapsed || updateHasPriority || !reminder || !shouldShowLocalNetworkReminder(reminder, dismissal)) {
    return null;
  }

  const handleDismiss = () => {
    const next = dismissLocalNetworkReminder(reminder, dismissal);
    setDismissal(next);
    try {
      window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    } catch {
      // Storage full or unavailable: the reminder stays hidden for this run.
    }
  };

  return (
    <div
      className={cn(
        'relative mx-2 mb-2 flex flex-col gap-2 rounded-xl p-3',
        'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
        'text-[var(--text-primary)]',
      )}
      role="status"
    >
      <Tip text={t('sidebar.localNetwork.dismiss')} side="left">
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={t('sidebar.localNetwork.dismiss')}
          className={cn(
            'absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full',
            'text-sidebar-muted transition-colors hover:bg-sidebar-item-hover hover:text-foreground',
          )}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </Tip>
      <div className="flex items-start gap-2 pr-5">
        <span
          className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-[var(--warning-bg-soft)]"
          aria-hidden
        >
          <Network className="h-3.5 w-3.5 text-[var(--warning-fg)]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-12 font-medium leading-[1.35]">{t('sidebar.localNetwork.title')}</p>
          <p className="mt-0.5 text-12 leading-[1.35] text-[var(--text-secondary)]">
            {t(
              reminder.reason === 'controlEnabled'
                ? 'sidebar.localNetwork.controlEnabled'
                : 'sidebar.localNetwork.relayOnly',
            )}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end">
        <Button variant="cta" size="md" disabled={requesting} onClick={() => void request()}>
          {t('sidebar.localNetwork.allow')}
        </Button>
      </div>
    </div>
  );
}
