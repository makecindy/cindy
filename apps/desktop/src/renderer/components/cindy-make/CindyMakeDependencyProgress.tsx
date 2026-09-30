import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/spinner';
import type { MakeDependencyProgress } from '../../../shared/cindyMakeDoctor';

export function CindyMakeDependencyProgress({
  progress,
  running,
  cacheOnly = false,
}: {
  progress?: MakeDependencyProgress;
  running: boolean;
  cacheOnly?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1 text-12 text-[var(--text-secondary)]" aria-live="polite">
      {running && (
        <div className="flex items-center gap-2">
          <Spinner size={14} />
          <span>
            {t(
              cacheOnly
                ? 'cindyMake.source.phase.caching'
                : 'cindyMake.code.dependencyActivity.' +
                    (progress?.activity ?? (progress ? 'packages' : 'starting')),
            )}
          </span>
        </div>
      )}
      {progress?.resolved !== undefined && (
        <p>
          {t(cacheOnly ? 'cindyMake.source.cacheProgress' : 'cindyMake.code.dependencyProgress', {
            ...progress,
          })}
        </p>
      )}
    </div>
  );
}
