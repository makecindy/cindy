import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { CindyMakePersonalBuildState } from '../../../shared/cindyMakeSession';
import { parseCindyMakeBuildOutput } from '../../../shared/cindyMakeBuildDiagnostic';
import { cindyMakeBuildStatusKey } from './cindyMakeBuildStatus';

/** Shared build-stage presentation for the session card and Make history. */
export function CindyMakeBuildProgress({ build }: { build?: CindyMakePersonalBuildState }) {
  const { t } = useTranslation();
  if (!build || build.status === 'ready' || build.status === 'failed') return null;
  const outputLine = build.stopping
    ? t('cindyMake.history.stopping')
    : (parseCindyMakeBuildOutput(build.outputLine) ?? t(cindyMakeBuildStatusKey(build)));

  const conflicts =
    build.mergeStep === 'conflicts' ||
    build.logs?.some((entry) => entry.step === 'resolving-conflicts');
  const cleanup = !!build.mergeStep || build.logs?.some((entry) => entry.step === 'cleaning-merge');
  const steps = [
    'waiting',
    'merging',
    ...(conflicts ? ['conflicts'] : []),
    ...(cleanup ? ['cleanup'] : []),
    'checking',
    'packaging',
    'publishing',
  ];
  const current = steps.indexOf(
    build.status === 'merging' ? (build.mergeStep ?? 'merging') : build.status,
  );
  return (
    <div className="min-w-0 space-y-2">
      <ol className="grid gap-1 text-12 text-[var(--text-secondary)] sm:grid-cols-2">
        {steps.map((step, index) => {
          const active = current === index;
          const done = current > index;
          return (
            <li
              key={step}
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2',
                active && 'session-status-breathing font-medium text-[var(--text-primary)]',
                done && 'text-[var(--status-success)]',
              )}
            >
              <span
                aria-hidden="true"
                className="inline-flex size-3 shrink-0 items-center justify-center"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
              </span>
              {t(
                step === 'conflicts'
                  ? 'cindyMake.personal.buildLog.steps.resolving-conflicts'
                  : step === 'cleanup'
                    ? 'cindyMake.personal.buildLog.steps.cleaning-merge'
                    : 'cindyMake.history.progress.' + step,
              )}
            </li>
          );
        })}
      </ol>
      <p role="status" className="truncate text-12 text-[var(--text-secondary)]" title={outputLine}>
        {outputLine}
      </p>
    </div>
  );
}
