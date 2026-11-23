/**
 * Auxiliary-model health for the Settings card and the one-time notification
 * (docs/product-rules/auxiliary-model-health.md).
 *
 * Refresh on health changes and configuration repairs. The settings page and
 * main-window notice share a read, coalescing same-microtask invalidations and
 * retaining one trailing read while the IPC is in flight.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { createCoalescedRefresh } from '@/lib/coalescedRefresh';
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

const refreshHealth = createCoalescedRefresh<AuxiliaryModelHealth>();

export function useAuxiliaryModelHealth(): AuxiliaryModelHealth | null {
  const [health, setHealth] = useState<AuxiliaryModelHealth | null>(null);
  useEffect(() => {
    let cancelled = false;
    let current: AuxiliaryModelHealth | undefined;
    let pending: Promise<AuxiliaryModelHealth> | undefined;
    const { maker, appPreferenceControl } = window.electronAPI;
    const refresh = () => {
      const request = refreshHealth(() => maker.auxiliaryModelHealthGet());
      if (pending === request) return;
      pending = request;
      void request.then((next) => {
          if (cancelled) return;
          current = next;
          setHealth(next);
        })
        .catch((error) => {
          if (!cancelled) log.warn('auxiliaryModelHealthGet failed', error);
        });
    };
    const refreshConfigProblem = () => {
      if (!current || (current.status === 'unavailable' && current.kind === 'config')) refresh();
    };
    const offSettings = appPreferenceControl?.onSettingsChanged(event => {
      if (event.section === AUXILIARY_MODEL_HEALTH_SECTION && isDataOwnerPushStampCurrent(event.ownerStamp)) {
        refresh();
      }
    });
    const offProviders = maker.onProvidersChanged?.(refreshConfigProblem);
    const offAuth = maker.auth?.onStateChanged?.(refreshConfigProblem);
    refresh();
    return () => {
      cancelled = true;
      offSettings?.();
      offProviders?.();
      offAuth?.();
    };
  }, []);
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
