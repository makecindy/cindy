/** Settings → Personalization → Auxiliary models: why no auxiliary model can run, and how to fix it. */

import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import type { AuxiliaryModelHealth } from '../../../shared/auxiliaryModelHealth';

type UnavailableHealth = Extract<AuxiliaryModelHealth, { status: 'unavailable' }>;

export function AuxiliaryModelHealthNotice({
  health,
  onCustomize,
}: {
  health: UnavailableHealth;
  /** Absent while the custom chain is already shown. */
  onCustomize?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const config = health.kind === 'config';
  return (
    <ErrorNotice
      role="status"
      className="min-w-0 max-w-full break-words"
      message={t(config
        ? 'settings.auxiliaryModels.health.configTitle'
        : 'settings.auxiliaryModels.health.runtimeTitle')}
      description={
        <>
          <span className="block">
            {t(config
              ? 'settings.auxiliaryModels.health.configDescription'
              : 'settings.auxiliaryModels.health.runtimeDescription')}
          </span>
          {health.fallbackModel ? (
            <span className="mt-1 block">
              {t('settings.auxiliaryModels.health.fallback', { model: health.fallbackModel })}
            </span>
          ) : null}
        </>
      }
      actions={
        <>
          {config ? (
            <Button variant="secondary" size="sm" onClick={() => navigate('/settings?tab=providers')}>
              {t('settings.auxiliaryModels.health.openProviders')}
            </Button>
          ) : null}
          {onCustomize ? (
            <Button variant="secondary" size="sm" onClick={onCustomize}>
              {t('settings.auxiliaryModels.health.customize')}
            </Button>
          ) : null}
        </>
      }
    >
      {config && health.candidates.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1 text-12 leading-[1.667] text-[var(--text-secondary)]">
          {health.candidates.map((candidate) => (
            <li key={candidate.ref} className="[overflow-wrap:anywhere]">
              {t('settings.auxiliaryModels.health.candidate', {
                model: candidate.label,
                reason: t(`settings.auxiliaryModels.health.issues.${candidate.issue}`),
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </ErrorNotice>
  );
}
