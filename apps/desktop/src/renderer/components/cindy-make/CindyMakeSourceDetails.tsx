import { useTranslation } from 'react-i18next';
import { ArrowRight, CircleCheck, CircleHelp, Download } from 'lucide-react';
import { Tip } from '@/components/ui/tooltip';
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
  const personalIncludesMain = comparison === 'same' || comparison === 'personalAhead';
  const personalMatchesOnline =
    latestVersion?.status === 'ready' && source.commit === latestVersion.commit;
  const mainIncludesOnline =
    mainMatchesOnline ||
    (latestVersion?.status === 'ready' &&
      !!source.mainCommit &&
      latestVersion.behind === 0 &&
      latestVersion.ahead !== undefined &&
      latestVersion.ahead > 0);
  const personalIsLatest = personalMatchesOnline || (personalIncludesMain && mainIncludesOnline);
  // A different personal SHA can still include all official updates. Only report
  // an update when the verified comparisons prove that official changes are missing.
  const personalNeedsUpdate =
    latestVersion?.status === 'ready' &&
    !!source.commit &&
    !!source.mainCommit &&
    (mainMatchesOnline
      ? behind !== undefined && behind > 0
      : comparison !== 'different' &&
        comparison !== 'unknown' &&
        latestVersion.behind !== undefined &&
        latestVersion.behind > 0 &&
        (comparison === 'same' ||
          (ahead !== undefined && ahead < latestVersion.behind) ||
          (latestVersion.ahead === 0 && behind !== undefined && behind > 0)));
  const personalStatus = personalIsLatest
    ? 'upToDate'
    : personalNeedsUpdate
      ? 'updateAvailable'
      : 'unverified';
  const PersonalStatusIcon = personalIsLatest
    ? CircleCheck
    : personalNeedsUpdate
      ? Download
      : CircleHelp;
  const personalName = t('cindyMake.overview.personal');
  const personalStatusLabel = t('cindyMake.overview.personalStatus.' + personalStatus);
  const personalStatusDescription = personalIsLatest
    ? `${personalStatusLabel} · ${t('cindyMake.overview.personalStatus.upToDateDescription', {
        target: onlineLabel,
      })}`
    : personalStatusLabel;
  const personalDetail = personalIsLatest
    ? !personalMatchesOnline && comparison === 'personalAhead'
      ? t('cindyMake.overview.personalStatus.personalChanges', { ahead })
      : undefined
    : t('cindyMake.overview.comparison.' + comparison, { ahead, behind });
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
    <dl className="space-y-2 text-13 text-[var(--text-secondary)]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
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
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <dt>
          <Tip text={showComparison ? personalStatusDescription : undefined}>
            <span
              role={showComparison ? 'status' : undefined}
              aria-label={showComparison ? `${personalName} · ${personalStatusLabel}` : undefined}
              tabIndex={showComparison ? 0 : undefined}
              className={`inline-flex max-w-full items-center gap-1.5 rounded-full font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${
                !showComparison
                  ? 'text-[var(--text-secondary)]'
                  : personalIsLatest
                    ? 'text-[var(--status-success)]'
                    : personalNeedsUpdate
                      ? 'text-[var(--upgrade-banner-fg)]'
                      : 'text-[var(--text-secondary)]'
              }`}
            >
              {showComparison && <PersonalStatusIcon size={14} className="shrink-0" aria-hidden />}
              <span>
                <span>{personalName}</span>
                {showComparison &&
                  t('cindyMake.overview.personalStatus.suffix', { status: personalStatusLabel })}
              </span>
            </span>
          </Tip>
        </dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {showComparison && personalDetail && <span className="text-12">{personalDetail}</span>}
        </dd>
      </div>
    </dl>
  );
}
