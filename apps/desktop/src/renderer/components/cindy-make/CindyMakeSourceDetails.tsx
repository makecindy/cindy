import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import type {
  MakeSourceLatestVersion,
  MakeSourcePreparation,
} from '../../../shared/cindyMakeDoctor';

export function CindyMakeSourceDetails({
  source,
  latestVersion,
}: {
  source: MakeSourcePreparation;
  latestVersion?: MakeSourceLatestVersion;
}) {
  const { t } = useTranslation();
  const unknown = t('cindyMake.source.details.unknown');
  const { personalAhead: ahead, personalBehind: behind } = source;
  const comparison =
    ahead === undefined || behind === undefined
      ? 'unknown'
      : ahead === 0 && behind === 0
        ? 'same'
        : behind === 0
          ? 'personalAhead'
          : ahead === 0
            ? 'mainAhead'
            : 'diverged';
  let upstreamDifference: string | undefined;
  if (
    latestVersion?.status === 'ready' &&
    latestVersion.ahead !== undefined &&
    latestVersion.behind !== undefined
  ) {
    const { ahead, behind } = latestVersion;
    upstreamDifference =
      ahead === 0 && behind === 0
        ? t('cindyMake.source.details.latest.same')
        : ahead === 0
          ? t('cindyMake.source.details.latest.behind', { count: behind })
          : behind === 0
            ? t('cindyMake.source.details.latest.ahead', { count: ahead })
            : t('cindyMake.source.details.latest.difference', { ahead, behind });
  }

  return (
    <div className="space-y-2 text-13 text-[var(--text-secondary)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <dl className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <dt>{t('cindyMake.versions.personal')}</dt>
          <dd className="font-mono" title={source.commit}>
            {source.commit?.slice(0, 12) ?? unknown}
          </dd>
        </dl>
        <div className="flex min-w-0 items-center gap-3">
          <ArrowRight size={14} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
          <dl className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <dt>{t('cindyMake.overview.localMain')}</dt>
            <dd className="font-mono" title={source.mainCommit}>
              {source.mainCommit?.slice(0, 12) ?? unknown}
            </dd>
          </dl>
        </div>
      </div>
      <p role="status" className="text-12">
        {t('cindyMake.overview.comparison.' + comparison, { ahead, behind })}
      </p>
      {latestVersion && (
        <dl className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-12">
          <dt>{t('cindyMake.source.details.latest.' + latestVersion.channel)}</dt>
          <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            {latestVersion.status === 'ready' ? (
              <>
                <span
                  className="font-mono text-[var(--status-success)]"
                  title={latestVersion.commit}
                >
                  {latestVersion.commit.slice(0, 12)}
                </span>
                {latestVersion.ref !== 'main' && <span>{latestVersion.ref}</span>}
                <span className={upstreamDifference ? 'text-[var(--status-success)]' : undefined}>
                  {t('cindyMake.overview.localMain')}{' '}
                  {upstreamDifference ?? t('cindyMake.overview.comparisonUnavailable')}
                </span>
              </>
            ) : (
              t('cindyMake.overview.lookupUnavailable')
            )}
          </dd>
        </dl>
      )}
    </div>
  );
}
