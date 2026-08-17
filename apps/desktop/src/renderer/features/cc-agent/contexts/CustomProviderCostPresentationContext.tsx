import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { ProviderView } from '@cindy/model-providers';

import { useCustomProviderBillingSettings } from '@/hooks/useCustomProviderBillingSettings';
import {
  resolveCustomProviderCostPresentation,
  type CustomProviderCostPresentation,
} from '@/lib/customProviderCostPresentation';

interface CustomProviderCostPresentationContextValue {
  providers: readonly Pick<ProviderView, 'id' | 'source'>[];
  showSdkEstimate: boolean;
}

const CustomProviderCostPresentationContext =
  createContext<CustomProviderCostPresentationContextValue>({
    providers: [],
    showSdkEstimate: false,
  });

export function CustomProviderCostPresentationProvider({
  providers,
  children,
}: {
  providers: readonly Pick<ProviderView, 'id' | 'source'>[];
  children: ReactNode;
}) {
  const { showSdkCostForCustomProviders } = useCustomProviderBillingSettings();
  const value = useMemo(
    () => ({
      providers,
      showSdkEstimate: showSdkCostForCustomProviders,
    }),
    [providers, showSdkCostForCustomProviders],
  );
  return (
    <CustomProviderCostPresentationContext.Provider value={value}>
      {children}
    </CustomProviderCostPresentationContext.Provider>
  );
}

export function useSessionCustomProviderCostPresentation(
  providerId: string | null | undefined,
): CustomProviderCostPresentation {
  const { providers, showSdkEstimate } = useContext(CustomProviderCostPresentationContext);
  return resolveCustomProviderCostPresentation(providerId, providers, showSdkEstimate);
}

export function useShowCustomProviderSdkEstimate(): boolean {
  return useContext(CustomProviderCostPresentationContext).showSdkEstimate;
}
