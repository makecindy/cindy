import { useCallback, useEffect, useState } from 'react';

import {
  getCustomProviderShowSdkCost,
  setCustomProviderShowSdkCost,
  subscribeCustomProviderShowSdkCost,
} from '@/lib/customProviderBillingSettingsStore';

export function useCustomProviderBillingSettings(): {
  showSdkCostForCustomProviders: boolean;
  isCustomized: boolean;
  setShowSdkCostForCustomProviders: (next: boolean) => Promise<void>;
  reset: () => Promise<void>;
} {
  const [showSdkCostForCustomProviders, setEnabledState] = useState<boolean>(
    getCustomProviderShowSdkCost,
  );
  const [isCustomized, setIsCustomized] = useState(false);

  const refresh = useCallback(async (isCancelled: () => boolean = () => false) => {
    const settings = await window.electronAPI.maker.customProviderBillingGet();
    if (isCancelled()) return;
    setCustomProviderShowSdkCost(settings.showSdkCostForCustomProviders);
    setEnabledState(settings.showSdkCostForCustomProviders);
    setIsCustomized(settings.isCustomized);
  }, []);

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
    void refresh(() => cancelled).catch(() => undefined);
    const unsubscribe = subscribeCustomProviderShowSdkCost((next) => {
      if (!cancelled) setEnabledState(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [refresh]);

  return { showSdkCostForCustomProviders, isCustomized, setShowSdkCostForCustomProviders, reset };
}
