import { BadgeCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PluginMarketItem } from '../../../shared/pluginMarket';

/** A display of verified public provenance; it never grants runtime privileges. */
export function PluginPublisherBadge({ kind }: { kind?: PluginMarketItem['publisherKind'] }) {
  const { t } = useTranslation();
  if (kind !== 'official') return null;
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2 text-11 font-medium leading-none text-[var(--text-primary)]">
      <BadgeCheck size={12} strokeWidth={2} aria-hidden="true" />
      {t('settings.ghosts.market.publisherKind.official')}
    </span>
  );
}
