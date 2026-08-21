import { useCallback, useEffect, useState } from 'react';

import { customProviderBillingGetFor } from '@/lib/makerTransport';
import {
  getCustomProviderShowSdkCost,
  setCustomProviderShowSdkCost,
  subscribeCustomProviderShowSdkCost,
} from '@/lib/customProviderBillingSettingsStore';

export function useCustomProviderBillingSettings(deviceId?: string | null): {
  showSdkCostForCustomProviders: boolean;
  isCustomized: boolean;
  setShowSdkCostForCustomProviders: (next: boolean) => Promise<void>;
  reset: () => Promise<void>;
} {
  const [showSdkCostForCustomProviders, setEnabledState] = useState<boolean>(
    deviceId ? false : getCustomProviderShowSdkCost(),
  );
  const [isCustomized, setIsCustomized] = useState(false);

  const refresh = useCallback(async (isCancelled: () => boolean = () => false) => {
    const settings = await customProviderBillingGetFor(deviceId);
    if (isCancelled()) return;
    if (!deviceId) {
      setCustomProviderShowSdkCost(settings.showSdkCostForCustomProviders);
    }
    setEnabledState(settings.showSdkCostForCustomProviders);
    setIsCustomized(settings.isCustomized);
  }, [deviceId]);

  const setShowSdkCostForCustomProviders = useCallback(async (next: boolean) => {
    const settings = await window.electronAPI.maker.customProviderBillingSet(next);
    setCustomProviderShowSdkCost(settings.showSdkCostForCustomProviders);
    setEnabledState(settings.showSdkCostForCustomProviders);
    setIsCustomized(settings.isCustomized);
  }, []);

  const reset = useCallback(async () => {
    const settings = await window.electronAPI.maker.customProviderBillingReset();
    setCustomProviderShowSdkCost(settings.showSdkCostForCustomProviders);
    setEnabledState(settings.showSdkCostForCustomProviders);
    setIsCustomized(settings.isCustomized);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void refresh(() => cancelled).catch(() => {
      if (!cancelled && deviceId) {
        setEnabledState(false);
        setIsCustomized(false);
      }
    });
    if (deviceId) {
      return () => {
        cancelled = true;
      };
    }
    const unsubscribe = subscribeCustomProviderShowSdkCost((next) => {
      if (!cancelled) setEnabledState(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [deviceId, refresh]);

  return { showSdkCostForCustomProviders, isCustomized, setShowSdkCostForCustomProviders, reset };
}
