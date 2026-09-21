import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import type {
  MakeSourceLatestVersion,
  MakeSourcePreparation,
} from '../../../shared/cindyMakeDoctor';

export function CindyMakeSourceDetails({
  source,
  latestVersion,
  showComparison = true,
}: {
  source: MakeSourcePreparation;
  latestVersion?: MakeSourceLatestVersion;
  /** Progress and errors may occupy the status area while version facts remain visible. */
  showComparison?: boolean;
}) {
  const { t } = useTranslation();
  const unknown = t('cindyMake.source.details.unknown');
  const { personalAhead: ahead, personalBehind: behind } = source;
  const comparison =
    !source.commit || !source.mainCommit
      ? 'unknown'
      : source.commit === source.mainCommit
        ? 'same'
        : ahead === undefined || behind === undefined || (ahead === 0 && behind === 0)
          ? 'different'
          : behind === 0
            ? 'personalAhead'
            : ahead === 0
              ? 'mainAhead'
              : 'diverged';
  const latestChannel = latestVersion?.channel ?? source.channel;
  const latestLabel = latestChannel ?? (source.ref === 'main' ? 'dev' : 'unknown');
  const onlineLabel = t('cindyMake.source.details.latest.' + latestLabel);
  const mainMatchesOnline =
    latestVersion?.status === 'ready' && source.mainCommit === latestVersion.commit;
  let upstreamDifference: string | undefined;
  if (mainMatchesOnline) {
    upstreamDifference = t('cindyMake.source.details.latest.same', { target: onlineLabel });
  } else if (
    latestVersion?.status === 'ready' &&
    source.mainCommit &&
    latestVersion.ahead !== undefined &&
    latestVersion.behind !== undefined &&
    (latestVersion.ahead !== 0 || latestVersion.behind !== 0)
  ) {
    const { ahead, behind } = latestVersion;
    upstreamDifference =
      ahead === 0
        ? t('cindyMake.source.details.latest.behind', { count: behind })
        : behind === 0
          ? t('cindyMake.source.details.latest.ahead', { count: ahead })
          : t('cindyMake.source.details.latest.difference', { ahead, behind });
  }

  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 text-13 text-[var(--text-secondary)]">
      <dt className={mainMatchesOnline ? 'text-[var(--status-success)]' : undefined}>
        {t('cindyMake.overview.localMain')}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={mainMatchesOnline ? 'font-mono text-[var(--status-success)]' : 'font-mono'}
          title={source.mainCommit}
        >
          {source.mainCommit?.slice(0, 12) ?? unknown}
        </span>
        {!mainMatchesOnline && (
          <span className="inline-flex min-w-0 items-baseline gap-x-3">
            <ArrowRight
              size={14}
              className="shrink-0 self-center text-[var(--text-tertiary)]"
              aria-hidden
            />
            <span
              className={
                latestVersion?.status === 'ready'
                  ? 'inline-flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[var(--status-success)]'
                  : 'inline-flex flex-wrap items-baseline gap-x-2 gap-y-1'
              }
            >
              <span>{onlineLabel}</span>
              {latestVersion?.status === 'ready' ? (
                <span className="font-mono" title={latestVersion.commit}>
                  {latestVersion.commit.slice(0, 12)}
                </span>
              ) : (
                <span>
                  {latestVersion?.status === 'unavailable'
                    ? t('cindyMake.overview.lookupUnavailable')
                    : unknown}
                </span>
              )}
            </span>
          </span>
        )}
        {latestVersion?.status === 'ready' && (
          <>
            {latestVersion.ref !== 'main' && (
              <span className="text-[var(--status-success)]">{latestVersion.ref}</span>
            )}
            <span
              className={mainMatchesOnline ? 'text-12 text-[var(--status-success)]' : 'text-12'}
            >
              {upstreamDifference ?? t('cindyMake.overview.comparisonUnavailable')}
            </span>
          </>
        )}
      </dd>
      <dt>{t('cindyMake.overview.personal')}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono" title={source.commit}>
          {source.commit?.slice(0, 12) ?? unknown}
        </span>
        {showComparison && (
          <span
            role="status"
            className={comparison === 'same' ? 'text-12 text-[var(--status-success)]' : 'text-12'}
          >
            {t('cindyMake.overview.comparison.' + comparison, { ahead, behind })}
          </span>
        )}
      </dd>
    </dl>
  );
}
