import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Tip } from '@/components/ui/tooltip';
import type { PluginMarketItem } from '../../../shared/pluginMarket';
import { GhostPluginIcon } from './GhostPluginIcon';
import { PluginPublisherBadge } from './PluginPublisherBadge';
import type { PluginPresentationOrigin } from './lib/pluginMarketPresentation';
import './plugin-detail-layout.css';

type VersionLabel = 'current' | 'installed' | 'listed';
const versionLabelKeys = {
  current: 'infoVersion',
  installed: 'heroInstalledVersion',
  listed: 'heroListedVersion',
} as const;
const copy = 'settings.ghosts.detail';

export interface PluginDetailHeroProps {
  id: string;
  name: string;
  author?: string | null;
  status?: string | null;
  version?: string | null;
  versionLabel?: VersionLabel;
  marketItem?: PluginMarketItem | null;
  origin?: PluginPresentationOrigin;
  publisherKind?: PluginMarketItem['publisherKind'];
  installationPending?: boolean;
  iconContainerRef?: Ref<HTMLSpanElement>;
  iconDataUrl?: string;
  onIconLoad?: () => void;
  onIconLoadError?: () => void;
  actions?: ReactNode;
  enableControl?: ReactNode;
  fallbackFacts?: { permissionCount?: number; toolCount?: number; source?: string };
}

export function PluginDetailHero({
  id,
  name,
  author,
  status,
  version,
  versionLabel = 'current',
  marketItem,
  origin,
  publisherKind,
  installationPending,
  iconContainerRef,
  iconDataUrl,
  onIconLoad,
  onIconLoadError,
  actions,
  enableControl,
  fallbackFacts,
}: PluginDetailHeroProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.resolvedLanguage ?? i18n?.language;
  const sharedMarketItem = marketItem?.sourceType === 'server' && marketItem.scope !== 'personal' ? marketItem : undefined;
  const downloadCount = sharedMarketItem?.downloadStatistics?.requestCount;
  const weeklyUsage = sharedMarketItem?.usageStatistics?.usageCountLast7Days;
  const usageCount = weeklyUsage ?? sharedMarketItem?.usageStatistics?.usageCount;
  const releaseDate = sharedMarketItem?.publishedAt ? new Date(sharedMarketItem.publishedAt) : null;
  const visibleAuthor = origin === 'public' && publisherKind !== 'official' ? null : author;
  const identityLabel = versionLabel === 'listed'
    ? status ?? t('settings.ghosts.contribution.listedVersion')
    : [visibleAuthor, status].filter(Boolean).join(' · ');
  const compactCount = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  const facts: { title: string; value: string; fullValue?: string; explanation?: string }[] = [];
  if (downloadCount !== undefined) {
    const count = BigInt(downloadCount);
    facts.push({
      title: t(`${copy}.heroDownloads`),
      value: compactCount.format(count),
      fullValue: t('settings.ghosts.usage.downloadsValue', { value: count.toLocaleString(locale) }),
      explanation: t('settings.ghosts.usage.downloadExplanation'),
    });
  }
  if (usageCount !== undefined) {
    const count = BigInt(usageCount);
    const title = t(`${copy}.${weeklyUsage === undefined ? 'heroUsage' : 'heroWeeklyUsage'}`);
    facts.push({
      title,
      value: compactCount.format(count),
      fullValue: weeklyUsage === undefined
        ? t('settings.ghosts.usage.usesValue', { value: count.toLocaleString(locale) })
        : `${title} ${count.toLocaleString(locale)}`,
      explanation: weeklyUsage === undefined
        ? t('settings.ghosts.usage.usesExplanation') : t(`${copy}.heroWeeklyUsageExplanation`),
    });
  }
  if (version) {
    facts.push({ title: t(`${copy}.${versionLabelKeys[versionLabel]}`), value: version.startsWith('v') ? version : `v${version}` });
  }
  if (releaseDate && Number.isFinite(releaseDate.getTime())) {
    facts.push({
      title: t(`${copy}.heroLatestUpdate`),
      value: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(releaseDate),
    });
  }
  if (fallbackFacts && facts.length < 3) {
    const { permissionCount, toolCount, source } = fallbackFacts;
    const supplements = [
      ...(permissionCount === undefined ? [] : [{
        title: t(`${copy}.permissionsTitle`), value: t('settings.ghosts.perm.itemCount', { count: permissionCount }),
      }]),
      ...(toolCount ? [{ title: t(`${copy}.toolsTitle`), value: t(`${copy}.toolCount`, { count: toolCount }) }] : []),
      ...(source ? [{ title: t('mcpApps.sourceLabel'), value: source }] : []),
    ];
    facts.push(...supplements.slice(0, 3 - facts.length));
  }
  return (
    <div className="plugin-detail-hero-container">
      <div data-v5-detail-header className="plugin-detail-identity">
        <div className="plugin-detail-identity-icon">
          <GhostPluginIcon iconId={id} iconName={name} size="detail"
            iconContainerRef={iconContainerRef} iconDataUrl={iconDataUrl}
            onIconLoad={onIconLoad}
            onIconLoadError={onIconLoadError} />
        </div>
        <div className="plugin-detail-identity-body">
          <div className="min-w-0">
            <h1 title={name}
              className="plugin-detail-identity-name line-clamp-2 min-w-0 font-medium text-[var(--text-primary)] [overflow-wrap:anywhere]">{name}</h1>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 empty:hidden">
              {identityLabel ? (
                <span className="min-w-0 text-15 leading-[1.467] text-[var(--text-secondary)] [overflow-wrap:anywhere]">{identityLabel}</span>
              ) : null}
              <PluginPublisherBadge origin={origin} kind={publisherKind} />
            </div>
          </div>
          <div className="plugin-detail-identity-controls" style={WINDOW_NO_DRAG_STYLE}>
            {actions ? <div className="plugin-detail-identity-actions">{actions}</div> : null}
            {enableControl ? <div className="plugin-detail-identity-enable">{enableControl}</div> : null}
          </div>
        </div>
      </div>
      {facts.length >= 2 ? (
        <dl className="plugin-detail-hero-facts" aria-busy={installationPending || undefined}>
          {facts.map(({ title, value, fullValue, explanation }) => {
            const cell = (
              <div key={title} className="plugin-detail-hero-fact" tabIndex={explanation ? 0 : undefined}
                aria-label={fullValue} aria-description={explanation} role={explanation ? 'group' : undefined}>
                <dt className="text-12 leading-[1.5] text-[var(--text-tertiary)]">{title}</dt>
                <dd className="text-15 font-medium leading-[1.467] tabular-nums text-[var(--text-primary)]">{value}</dd>
              </div>
            );
            return explanation ? <Tip key={title} text={explanation}>{cell}</Tip> : cell;
          })}
        </dl>
      ) : null}
    </div>
  );
}
