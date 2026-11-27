import { useMemo } from 'react';
import { remoteProviderDisableKey } from '@cindy/model-providers';
import { useProviders } from '@/hooks/useProviders';

/** Reuse the main-owned disable / picker-visibility preferences and provider refresh, with no second state store. */
export function useRemoteProviderDisable() {
  const { disabledProviders, hiddenProviders, loading, refetch } = useProviders();
  return useMemo(() => ({
    available: !loading,
    isDisabled(deviceId: string, providerId: string): boolean {
      return disabledProviders?.[remoteProviderDisableKey(deviceId, providerId)] === true;
    },
    async setDisabled(deviceId: string, providerId: string, disabled: boolean): Promise<void> {
      await window.electronAPI.maker.setModelDisable({ kind: 'provider', providerId, remoteDeviceId: deviceId, disabled });
      await refetch();
    },
    /** 只从这台电脑的模型选择器里收起；那台电脑上的模型照常可用(收藏、已在用的任务)。 */
    isHidden(deviceId: string, providerId: string): boolean {
      return hiddenProviders?.[remoteProviderDisableKey(deviceId, providerId)] === true;
    },
    async setHidden(deviceId: string, providerId: string, hidden: boolean): Promise<void> {
      await window.electronAPI.maker.setModelDisable({ kind: 'provider-hidden', providerId, remoteDeviceId: deviceId, hidden });
      await refetch();
    },
  }), [disabledProviders, hiddenProviders, loading, refetch]);
}
