import { useTranslation } from 'react-i18next';
import type { CindyMakeTestState } from '../../../shared/cindyMakeSession';

/** Task and Settings display the same persisted startup step and failure location. */
export function CindyMakeTestStep({ test }: { test?: CindyMakeTestState }) {
  const { t } = useTranslation();
  const starting = test?.status === 'starting';
  if (!starting && !(test?.step && test.error)) return null;
  return (
    <p role="status" className="mt-2 text-12 text-[var(--text-secondary)]">
      {t(starting ? 'cindyMake.test.currentStep' : 'cindyMake.test.failedStep', {
        step: t('cindyMake.test.steps.' + (test?.step ?? 'waiting')),
      })}
    </p>
  );
}
