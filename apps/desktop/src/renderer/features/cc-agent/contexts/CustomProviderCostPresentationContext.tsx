import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { ProviderView } from '@cindy/model-providers';

import { useCustomProviderBillingSettings } from '@/hooks/useCustomProviderBillingSettings';
import {
  resolveCustomProviderCostPresentation,
  type CustomProviderCostPresentation,
} from '@/lib/customProviderCostPresentation';

interface CustomProviderCostPresentationContextValue {
  providers: readonly Pick<ProviderView, 'id' | 'source'>[];
}

const CustomProviderCostPresentationContext =
  createContext<CustomProviderCostPresentationContextValue>({ providers: [] });

export function CustomProviderCostPresentationProvider({
  providers,
  children,
}: {
  providers: readonly Pick<ProviderView, 'id' | 'source'>[];
  children: ReactNode;
}) {
  const value = useMemo(() => ({ providers }), [providers]);
  return (
    <CustomProviderCostPresentationContext.Provider value={value}>
      {children}
    </CustomProviderCostPresentationContext.Provider>
  );
}

export function useSessionCustomProviderCostPresentation(
  providerId: string | null | undefined,
  deviceId?: string | null,
): CustomProviderCostPresentation {
  const { providers } = useContext(CustomProviderCostPresentationContext);
  const { showSdkCostForCustomProviders } = useCustomProviderBillingSettings(deviceId);
  return resolveCustomProviderCostPresentation(providerId, providers, showSdkCostForCustomProviders);
}

export function useShowCustomProviderSdkEstimate(deviceId?: string | null): boolean {
  return useCustomProviderBillingSettings(deviceId).showSdkCostForCustomProviders;
}
