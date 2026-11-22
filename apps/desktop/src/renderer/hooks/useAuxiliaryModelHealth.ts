/**
 * Auxiliary-model health for the Settings card and the one-time notification
 * (docs/product-rules/auxiliary-model-health.md).
 *
 * Main announces changes on the existing app-settings push (section
 * `auxiliary-model-health`, only on real state changes); each one triggers a single
 * light read. A read that resolves after a newer one started is dropped.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAppSettingsRevision } from '@/hooks/useAppSettingsRevision';
import { createLogger } from '@/lib/logger';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { toast } from '@/lib/toast';
import {
  AUXILIARY_MODEL_HEALTH_SECTION,
  AUXILIARY_MODEL_SETTINGS_PATH,
  auxiliaryModelHealthFingerprint,
  type AuxiliaryModelHealth,
} from '../../shared/auxiliaryModelHealth';

const log = createLogger('useAuxiliaryModelHealth');

export function useAuxiliaryModelHealth(): AuxiliaryModelHealth | null {
  const revision = useAppSettingsRevision(AUXILIARY_MODEL_HEALTH_SECTION);
  const [health, setHealth] = useState<AuxiliaryModelHealth | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.maker
      .auxiliaryModelHealthGet()
      .then((next) => {
        if (!cancelled) setHealth(next);
      })
      .catch((error) => {
        // Nothing to show is the safe default; the features keep their own fallbacks.
        log.warn('auxiliaryModelHealthGet failed', error);
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);
  return health;
}

/** Last problem announced in this window; a recovery clears it so a later problem is announced again. */
let lastAnnounced: string | null = null;

/** Announces each new auxiliary-model problem once, with a way to the settings. Main window only. */
export function useAuxiliaryModelHealthNotice(): void {
  const health = useAuxiliaryModelHealth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  useEffect(() => {
    if (!health || isSecondaryWindow()) return;
    const fingerprint = auxiliaryModelHealthFingerprint(health);
    if (fingerprint === lastAnnounced) return;
    lastAnnounced = fingerprint;
    if (health.status === 'ok') return;
    toast.warning(
      t(health.kind === 'config'
        ? 'settings.auxiliaryModels.health.toast.config'
        : 'settings.auxiliaryModels.health.toast.runtime'),
      {
        action: {
          label: t('settings.auxiliaryModels.health.toast.open'),
          onClick: () => navigate(AUXILIARY_MODEL_SETTINGS_PATH),
        },
      },
    );
  }, [health, navigate, t]);
}

/** exported for unit tests only. */
export function resetAuxiliaryModelHealthNoticeForTests(): void {
  lastAnnounced = null;
}
