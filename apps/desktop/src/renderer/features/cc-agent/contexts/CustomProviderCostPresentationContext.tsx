import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { ProviderView } from '@cindy/model-providers';

import { useCustomProviderBillingSettingsSnapshot } from '@/hooks/useCustomProviderBillingSettings';
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
  enabled = true,
): {
  presentation: CustomProviderCostPresentation;
  showSdkEstimate: boolean;
} {
  const { providers } = useContext(CustomProviderCostPresentationContext);
  const { showSdkCostForCustomProviders } = useCustomProviderBillingSettingsSnapshot(
    deviceId,
    enabled,
  );
  return {
    presentation: resolveCustomProviderCostPresentation(
      providerId,
      providers,
      showSdkCostForCustomProviders,
    ),
    showSdkEstimate: showSdkCostForCustomProviders,
  };
}
