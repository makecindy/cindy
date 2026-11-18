import { useMemo } from 'react';
import { remoteProviderDisableKey } from '@cindy/model-providers';
import { useProviders } from '@/hooks/useProviders';

/** Reuse the main-owned disable preference and provider refresh, with no second state store. */
export function useRemoteProviderDisable() {
  const { disabledProviders, loading, refetch } = useProviders();
  return useMemo(() => ({
    available: !loading,
    isDisabled(deviceId: string, providerId: string): boolean {
      return disabledProviders?.[remoteProviderDisableKey(deviceId, providerId)] === true;
    },
    async setDisabled(deviceId: string, providerId: string, disabled: boolean): Promise<void> {
      await window.electronAPI.maker.setModelDisable({ kind: 'provider', providerId, remoteDeviceId: deviceId, disabled });
      await refetch();
    },
  }), [disabledProviders, loading, refetch]);
}
