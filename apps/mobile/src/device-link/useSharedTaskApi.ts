import { useMemo } from 'react';
import { createSharedTaskApi, SharedTaskScopeChangedError } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { getOfficialDeviceLinkApiBaseUrl } from '@/config/env';
import { joinMobileAgentNetSharedTask, requestMobileAgentNetSharedTask } from './agentNetSharing';

export function useSharedTaskApi() {
  const { apiFetch, accountGeneration, deviceId } = useAuth();
  return useMemo(() => {
    const context = { apiFetch, deviceId: deviceId ?? '' };
    const api = createSharedTaskApi({
    captureScope() {
      const owner = getMobileAuthOwner();
      return { isCurrent: () => !!owner.accountId && isMobileAuthOwnerCurrent(owner) };
    },
    async request(path, options) {
      if (!options.isCurrent()) throw new SharedTaskScopeChangedError();
      // 成员关系在官方服务,走自建中转时也不换地址。
      const legacy = () => apiFetch(path, { baseUrl: getOfficialDeviceLinkApiBaseUrl(), method: options.method,
        body: options.body, cache: 'no-store', timeoutMs: 12_000,
        assertCurrent() {
          if (!options.isCurrent()) throw new SharedTaskScopeChangedError();
        },
      });
      // A test/old login can lack a device ID; only the existing official API
      // is usable until Auth has supplied the physical device identity.
      return deviceId ? await requestMobileAgentNetSharedTask(path, options, context, legacy) ?? legacy() : legacy();
    },
    });
    return { ...api, async join(invitation: string, displayName: string) {
      return await joinMobileAgentNetSharedTask(invitation, displayName, context) ?? api.join(invitation, displayName);
    } };
  }, [apiFetch, accountGeneration, deviceId]);
}
