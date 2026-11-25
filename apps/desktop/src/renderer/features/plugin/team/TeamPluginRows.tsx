/**
 * 「团队共享」 rows on the 「发布插件」 page: organization plugins the member creates or maintains
 * (#1541). Same row as the public-market list (#12773): name with the unread dot, the description,
 * a facts line 「已上架 1.2.0 · 本机 1.3.0 · 创建者」 (the member's role where public rows name the
 * author), and the latest submission's state with its version and date.
 */
import { ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { ORGANIZATION_REVIEW_ID_PREFIX, type PersonalPluginSummary } from '../../../../shared/pluginAuthor';
import type { PluginReviewUpdate } from '../../../../shared/pluginContributions';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import type { GhostPluginListItem } from '../lib/ghostPluginViewModel';
import { GhostPluginIcon } from '../GhostPluginIcon';
import { VersionStatusIcon } from '../PluginPublishVersions';
import { teamLatestStateKey, teamMarketState, teamPluginIconUrl } from './teamPluginModel';

const copy = 'settings.ghosts.contribution';

export function teamLocalVersion(plugin: PersonalPluginSummary, localPlugins: readonly GhostPluginListItem[]) {
  return localPlugins.find((local) => local.ghostId === plugin.ghostId) ?? null;
}

/** Icon for the latest submission: the listed version reads 「已上架」, a delisted one 「已下架」. */
function statusOf(latestKey: string): string {
  if (latestKey === 'review.published') return 'published';
  if (latestKey === 'market.disabled') return 'disabled';
  return latestKey.replace(/^review\./, '');
}

export function TeamPluginRows({
  plugins,
  localPlugins,
  reviewUpdates,
  onOpen,
}: {
  plugins: readonly PersonalPluginSummary[];
  localPlugins: readonly GhostPluginListItem[];
  /** Unread review results; organization entries use the `org:` id prefix. */
  reviewUpdates: readonly PluginReviewUpdate[];
  onOpen: (pluginId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const shortDate = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }), [locale]);
  const fullDate = (value: string) => new Date(value).toLocaleString(locale);
  return (
    <ul className="-mx-3 grid gap-0.5">
      {plugins.map((plugin) => {
        const local = teamLocalVersion(plugin, localPlugins);
        const market = teamMarketState(plugin);
        const latest = plugin.latestRelease ?? null;
        const latestKey = teamLatestStateKey(plugin);
        const status = latestKey ? statusOf(latestKey) : null;
        const rejected = status === 'rejected';
        const review = reviewUpdates.find((item) => item.unread && item.pluginId === `${ORGANIZATION_REVIEW_ID_PREFIX}${plugin.id}`);
        // The listed (or delisted) version already reads in the state column; other rows say what
        // the market has, as public rows do.
        const marketFact = latestKey === 'review.published' || latestKey === 'market.disabled' ? null
          : market.state === 'available' ? t(`${copy}.marketVersion`, { version: market.version })
            : t(`${copy}.market.${market.state}`);
        const localFact = local ? t(`${copy}.localState.installed`, { version: local.version }) : t(`${copy}.localState.missing`);
        const role = t(`${copy}.team.role.${plugin.myRole}`);
        // A decision's date comes from the latest review event when it is about this release;
        // otherwise the submission's.
        const decidedAt = latest && plugin.latestReviewEvent?.releaseId === latest.id ? plugin.latestReviewEvent.at : null;
        const date = latest ? (status === 'pending' ? latest.publishedAt : decidedAt ?? latest.publishedAt) ?? null : null;
        const time = date ? new Date(date) : null;
        return (
          <li key={plugin.id}>
            <button type="button"
              className="plugin-publish-list-row grid w-full min-w-0 items-center rounded-xl px-3 py-3.5 text-left transition-colors duration-[var(--motion-fast)] hover:bg-[var(--surface-hover-soft)] active:bg-[var(--surface-chip)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
              onClick={() => onOpen(plugin.id)}
            >
              <span className="plugin-publish-list-icon flex">
                <GhostPluginIcon iconDataUrl={teamPluginIconUrl(plugin)} iconId={plugin.id} iconName={plugin.name} />
              </span>
              <span className="plugin-publish-list-info grid min-w-0 gap-px">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-15 font-medium leading-[1.4] text-[var(--text-primary)]">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{plugin.name}</span>
                  {review ? (
                    <span role="img" className="inline-flex" aria-label={t(`${copy}.unreadReview`)}>
                      <AttentionDot tone={review.status === 'approved' ? 'done' : 'error'} />
                    </span>
                  ) : null}
                </span>
                {/* The personal list carries no return reason (only the detail does), so a
                    returned row keeps its description; the reason reads in the detail. */}
                {plugin.description?.trim() ? (
                  <span className="truncate text-13 leading-[1.54] text-[var(--text-secondary)]">{plugin.description}</span>
                ) : null}
                <span className="text-12 leading-normal tabular-nums text-[var(--text-tertiary)] [overflow-wrap:anywhere]">
                  {[marketFact, localFact, role].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="plugin-publish-list-revision grid min-w-0 gap-y-0.5 [overflow-wrap:anywhere]">
                <span className={`flex min-w-0 items-center gap-1.5 text-13 leading-[1.54] ${rejected ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                  {status ? <VersionStatusIcon status={status} size={16} className={rejected ? undefined : 'text-[var(--text-tertiary)]'} /> : null}
                  <span className="min-w-0">{t(latestKey ? `${copy}.${latestKey}` : `${copy}.noSubmission`)}</span>
                </span>
                {latest ? (
                  <span className="plugin-publish-list-revision-meta min-w-0 text-12 leading-normal tabular-nums text-[var(--text-tertiary)]">
                    {latest.version}
                    {date && time && Number.isFinite(time.getTime()) ? (
                      <> · <time dateTime={date} title={fullDate(date)}>{shortDate.format(time)}</time></>
                    ) : null}
                  </span>
                ) : null}
              </span>
              <ChevronRight size={16} aria-hidden="true" className="plugin-publish-list-chevron justify-self-end text-[var(--text-tertiary)]" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
