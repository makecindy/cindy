import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import type {
  MakeSourceLatestVersion,
  MakeSourcePreparation,
} from '../../../shared/cindyMakeDoctor';

export function CindyMakeSourceDetails({
  source,
  latestVersion,
  updateAction,
}: {
  source: MakeSourcePreparation;
  latestVersion?: MakeSourceLatestVersion;
  updateAction?: ReactNode;
}) {
  const { t } = useTranslation();
  const unknown = t('cindyMake.source.details.unknown');
  let difference: string | undefined;
  if (
    latestVersion?.status === 'ready' &&
    latestVersion.ahead !== undefined &&
    latestVersion.behind !== undefined
  ) {
    const { ahead, behind } = latestVersion;
    difference =
      ahead === 0 && behind === 0
        ? t('cindyMake.source.details.latest.same')
        : ahead === 0
          ? t('cindyMake.source.details.latest.behind', { count: behind })
          : behind === 0
            ? t('cindyMake.source.details.latest.ahead', { count: ahead })
            : t('cindyMake.source.details.latest.difference', { ahead, behind });
  }
  return (
    <div className="min-w-0 space-y-2 text-12 text-[var(--text-secondary)]">
      <dl className="grid gap-3">
        <div className="min-w-0">
          <dt className="font-medium">{t('cindyMake.source.details.branch')}</dt>
          <dd className="space-y-1">
            <div className="break-all font-mono">{source.branch ?? unknown}</div>
            <div className="text-[var(--text-tertiary)]">
              {source.ref
                ? t('cindyMake.source.details.baseRef', { ref: source.ref })
                : t('cindyMake.source.details.baseCommit')}{' '}
              <span className="break-all font-mono" title={source.baseCommit}>
                {source.baseCommit?.slice(0, 12) ?? unknown}
              </span>
            </div>
          </dd>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <dt className="shrink-0 font-medium">{t('cindyMake.source.details.mainCommit')}</dt>
          <dd className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto whitespace-nowrap">
            <span
              className="shrink-0 font-mono text-[var(--text-secondary)]"
              title={source.mainCommit}
            >
              {source.mainCommit?.slice(0, 12) ?? unknown}
            </span>
            {latestVersion && (
              <>
                <ArrowRight
                  size={14}
                  className="shrink-0 text-[var(--text-tertiary)]"
                  aria-hidden="true"
                />
                <span
                  className={
                    latestVersion.status === 'ready'
                      ? 'shrink-0 text-[var(--status-success)]'
                      : 'shrink-0 text-[var(--text-tertiary)]'
                  }
                >
                  <span>{t(`cindyMake.source.details.latest.${latestVersion.channel}`)}</span>{' '}
                  {latestVersion.status === 'ready' ? (
                    <>
                      {latestVersion.ref !== 'main' && <span>{latestVersion.ref} </span>}
                      <span className="font-mono" title={latestVersion.commit}>
                        {latestVersion.commit.slice(0, 12)}
                      </span>
                      {difference && (
                        <>
                          {' '}
                          <span>{difference}</span>
                        </>
                      )}
                    </>
                  ) : (
                    t('cindyMake.source.details.latest.unavailable')
                  )}
                </span>
              </>
            )}
          </dd>
          {updateAction && <dd className="ml-auto shrink-0">{updateAction}</dd>}
        </div>
        <div className="min-w-0">
          <dt className="font-medium">{t('cindyMake.source.details.currentBranch')}</dt>
          <dd className="break-all font-mono">
            {source.currentBranch === null
              ? t('cindyMake.source.details.detached')
              : (source.currentBranch ?? unknown)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
