import { useTranslation } from 'react-i18next';
import type { MakeSourcePreparation } from '../../../shared/cindyMakeDoctor';

export function CindyMakeSourceDetails({ source }: { source: MakeSourcePreparation }) {
  const { t } = useTranslation();
  const unknown = t('cindyMake.source.details.unknown');
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
        <div className="min-w-0">
          <dt className="font-medium">{t('cindyMake.source.details.mainCommit')}</dt>
          <dd className="break-all font-mono" title={source.mainCommit}>
            {source.mainCommit?.slice(0, 12) ?? unknown}
          </dd>
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
