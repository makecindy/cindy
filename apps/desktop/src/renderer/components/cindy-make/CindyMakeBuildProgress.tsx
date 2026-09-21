import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { CindyMakePersonalBuildState } from '../../../shared/cindyMakeSession';

const BUILD_STEPS = ['waiting', 'merging', 'checking', 'packaging', 'publishing'] as const;

/** Shared build-stage presentation for the session card and Make history. */
export function CindyMakeBuildProgress({ build }: { build?: CindyMakePersonalBuildState }) {
  const { t } = useTranslation();
  if (!build || build.status === 'ready' || build.status === 'failed') return null;

  const current = BUILD_STEPS.indexOf(build.status);
  return (
    <ol className="grid gap-1 text-12 text-[var(--text-secondary)] sm:grid-cols-2">
      {BUILD_STEPS.map((step, index) => {
        const active = current === index;
        const done = current > index;
        return (
          <li
            key={step}
            aria-current={active ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2',
              active && 'font-medium text-[var(--text-primary)]',
              done && 'text-[var(--status-success)]',
            )}
          >
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
            {t('cindyMake.history.progress.' + step)}
          </li>
        );
      })}
    </ol>
  );
}
