import { useTranslation } from 'react-i18next';
import type { CindyMakePersonalBuildState } from '../../../shared/cindyMakeSession';
import { parseCindyMakeBuildDiagnostic } from '../../../shared/cindyMakeBuildDiagnostic';

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
  const diagnostic =
    code === build?.error && build?.status === 'failed'
      ? parseCindyMakeBuildDiagnostic(build.diagnostic)
      : undefined;
  return (
    <div role="alert" className="space-y-1 text-12 text-[var(--error-fg)]">
      {step && (
        <p>
          {t('cindyMake.personal.failedStep', {
            step: t('cindyMake.personal.buildLog.steps.' + step),
          })}
        </p>
      )}
      <p>
        {t(
          diagnostic && diagnostic.kind !== 'process'
            ? 'cindyMake.personal.diagnostic.' + diagnostic.kind
            : reason,
        )}
      </p>
      {diagnostic?.exitCode !== undefined && (
        <p>{t('cindyMake.personal.diagnostic.exitCode', { code: diagnostic.exitCode })}</p>
      )}
      {diagnostic?.message && (
        <pre className="max-h-48 select-text overflow-auto whitespace-pre-wrap break-words font-mono text-12">
          {diagnostic.message}
        </pre>
      )}
      {!diagnostic && ['buildFailed', 'checksFailed'].includes(code) && (
        <p>{t('cindyMake.personal.diagnostic.unavailable')}</p>
      )}
    </div>
  );
}
