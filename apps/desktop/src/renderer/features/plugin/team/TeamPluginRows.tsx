/**
 * 「团队共享」 rows on the 「发布插件」 page: organization plugins the member creates or maintains
 * (#1541). Columns and wording match the public-market rows; the author line is the member's own
 * name for creators and maintainers alike.
 */
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ORGANIZATION_REVIEW_ID_PREFIX, type PersonalPluginSummary } from '../../../../shared/pluginAuthor';
import type { PluginReviewUpdate } from '../../../../shared/pluginContributions';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import type { GhostPluginListItem } from '../lib/ghostPluginViewModel';
import { GhostPluginIcon } from '../GhostPluginIcon';
import { teamLatestStateKey, teamMarketState, teamPluginIconUrl } from './teamPluginModel';

const copy = 'settings.ghosts.contribution';

export function teamLocalVersion(plugin: PersonalPluginSummary, localPlugins: readonly GhostPluginListItem[]) {
  return localPlugins.find((local) => local.ghostId === plugin.ghostId) ?? null;
}

export function TeamPluginRows({
  plugins,
  localPlugins,
  memberName,
  reviewUpdates,
  onOpen,
}: {
  plugins: readonly PersonalPluginSummary[];
  localPlugins: readonly GhostPluginListItem[];
  memberName: string | null;
  /** Unread review results; organization entries use the `org:` id prefix. */
  reviewUpdates: readonly PluginReviewUpdate[];
  onOpen: (pluginId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="my-plugins-table">
      <div className="my-plugins-columns border-b border-[var(--border-default)] pb-3 text-12 text-[var(--text-tertiary)]" aria-hidden="true">
        <span>{t(`${copy}.pluginColumn`)}</span>
        <span>{t(`${copy}.localVersion`)}</span>
        <span>{t(`${copy}.currentMarket`)}</span>
        <span>{t(`${copy}.latestState`)}</span>
        <span />
      </div>
      {plugins.map((plugin) => {
        const local = teamLocalVersion(plugin, localPlugins);
        const market = teamMarketState(plugin);
        const latestKey = teamLatestStateKey(plugin);
        const review = reviewUpdates.find((item) => item.unread && item.pluginId === `${ORGANIZATION_REVIEW_ID_PREFIX}${plugin.id}`);
        return (
          <button
            type="button"
            key={plugin.id}
            className="my-plugins-row w-full border-b border-[var(--border-default)] py-5 text-left hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
            onClick={() => onOpen(plugin.id)}
          >
            <span className="my-plugins-identity flex min-w-0 items-center gap-3">
              <GhostPluginIcon iconDataUrl={teamPluginIconUrl(plugin)} iconId={plugin.id} iconName={plugin.name} />
              <span className="min-w-0">
                <span className="block break-words text-16 font-medium leading-[1.5] text-[var(--text-primary)]">{plugin.name}</span>
                {memberName ? <span className="block break-words text-13 leading-[1.54] text-[var(--text-tertiary)]">{memberName}</span> : null}
              </span>
              {review ? (
                <span role="img" className="inline-flex" aria-label={t(`${copy}.unreadReview`)}>
                  <AttentionDot tone={review.status === 'approved' ? 'done' : 'error'} />
                </span>
              ) : null}
            </span>
            <span className="my-plugins-local min-w-0 break-words text-13 leading-[1.54] text-[var(--text-primary)]">
              <span className="my-plugins-mobile-label">{t(`${copy}.localVersion`)} ·{' '}</span>
              {local ? local.version : t(`${copy}.localState.missing`)}
            </span>
            <span className="my-plugins-market min-w-0 break-words text-13 leading-[1.54] text-[var(--text-tertiary)]">
              <span className="my-plugins-mobile-label">{t(`${copy}.currentMarket`)} ·{' '}</span>
              {market.state === 'available' ? market.version : t(`${copy}.market.${market.state}`)}
            </span>
            <span className="my-plugins-latest min-w-0 break-words text-13 leading-[1.54] text-[var(--text-primary)]">
              <span className="my-plugins-mobile-label">{t(`${copy}.latestState`)} ·{' '}</span>
              {plugin.latestRelease && latestKey
                ? `${plugin.latestRelease.version} · ${t(`${copy}.review.${latestKey}`)}`
                : t(`${copy}.noSubmission`)}
            </span>
            <span className="my-plugins-chevron inline-flex items-center justify-end gap-1 text-13 text-[var(--text-secondary)]">
              {t(`${copy}.versionManagement`)}
              <ChevronRight size={16} className="shrink-0" aria-hidden="true" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
