/**
 * Auxiliary-model health for the Settings card and the one-time notification
 * (docs/product-rules/auxiliary-model-health.md).
 *
 * Refresh on health changes and configuration repairs. The settings page and
 * main-window notice share a read, coalescing same-microtask invalidations and
 * retaining one trailing read while the IPC is in flight.
 */

import { useEffect, useState } from 'react';

import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { createCoalescedRefresh } from '@/lib/coalescedRefresh';
import { createLogger } from '@/lib/logger';
import {
  AUXILIARY_MODEL_HEALTH_SECTION,
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
