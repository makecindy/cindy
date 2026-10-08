import { useMemo } from 'react';
import { createSharedTaskApi, SharedTaskScopeChangedError } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';

export function useSharedTaskApi() {
  const { apiFetch, accountGeneration } = useAuth();
  return useMemo(() => createSharedTaskApi({
    captureScope() {
      const owner = getMobileAuthOwner();
      return { isCurrent: () => !!owner.accountId && isMobileAuthOwnerCurrent(owner) };
    },
    request(path, options) {
      if (!options.isCurrent()) throw new SharedTaskScopeChangedError();
      return apiFetch(path, { baseUrl: DEVICE_LINK_API_BASE_URL, method: options.method,
        body: options.body, cache: 'no-store', timeoutMs: 12_000,
        assertCurrent() {
          if (!options.isCurrent()) throw new SharedTaskScopeChangedError();
        },
      });
    },
  }), [apiFetch, accountGeneration]);
}
