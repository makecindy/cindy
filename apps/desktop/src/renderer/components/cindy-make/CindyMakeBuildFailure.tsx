import { useTranslation } from 'react-i18next';
import type { CindyMakePersonalBuildState } from '../../../shared/cindyMakeSession';

/** Failure stays outside the collapsed log on every build surface, including legacy receipts. */
export function CindyMakeBuildFailure({
  build,
  error,
}: {
  build?: CindyMakePersonalBuildState;
  error?: string;
}) {
  const { t } = useTranslation();
  if (build?.status !== 'failed' && !error) return null;
  const code = error ?? build?.error ?? 'unavailable';
  const lastStep =
    build?.status === 'failed' && code !== 'cancelled'
      ? build.logs?.findLast((entry) => entry.step !== 'failed' && entry.step !== 'cancelled')?.step
      : undefined;
  const step = lastStep === 'ready' ? undefined : lastStep;
  const reason = 'cindyMake.personal.errors.' + code;
  return (
    <div role="alert" className="space-y-1 text-12 text-[var(--status-danger)]">
      {step && (
        <p>
          {t('cindyMake.personal.failedStep', {
            step: t('cindyMake.personal.buildLog.steps.' + step),
          })}
        </p>
      )}
      <p>{t(reason)}</p>
    </div>
  );
}
