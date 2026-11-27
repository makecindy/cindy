import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, onAppSessionInvalidated } from '../appSessionState.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch, type ApiFetchOptions } from '../serverApiClient.desktop.js';
import { createOfficialDeviceLinkApiFetch } from './deviceLinkApi.js';

// Forward at call time: in an import cycle this module can load before serverApiClient.desktop.
const officialDeviceLinkApiFetch = createOfficialDeviceLinkApiFetch({
  getClientEndpoint,
  serverApiFetch: (...args) => serverApiFetch(...args),
});

const endpoint = '/api/device-link/plugin-automation-host';
export interface AutomationHostChoice {
  revision: number;
  selected: boolean;
  isPrimary: boolean;
  deviceName: string | null;
}

/** Bind all hops, including a 401 refresh and lease release, to the original signed-in account. */
export function pluginAutomationAccount(key: string, current: () => boolean = () => true) {
  const owner = activeOwnerScopeKey();
  function assertCurrent() {
    if (!current() || owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending() || getActiveAppSession().mode !== 'cloud') {
      throw new Error('Plugin automation account is unavailable');
    }
  }
  async function request<T>(path: string, options: Pick<ApiFetchOptions, 'method' | 'body' | 'signal'> = {}): Promise<T> {
    const ownerLifetime = new AbortController();
    const unsubscribe = onAppSessionInvalidated(() => ownerLifetime.abort());
    try {
      const signal = options.signal ? AbortSignal.any([options.signal, ownerLifetime.signal]) : ownerLifetime.signal;
      const result = await officialDeviceLinkApiFetch<T>(path, { ...options, beforeHop: assertCurrent, signal, timeoutMs: 8000 });
      signal.throwIfAborted();
      assertCurrent();
      return result;
    } finally {
      unsubscribe();
    }
  }
  return {
    read: () => request<AutomationHostChoice>(endpoint + '?key=' + encodeURIComponent(key)),
    select: (revision: number, useThisDevice: boolean) => request<AutomationHostChoice>(endpoint, {
      method: 'PUT', body: { key, revision, useThisDevice },
    }),
    run: (action: 'acquire' | 'renew' | 'release', runId: string, signal?: AbortSignal) =>
      request<{ granted?: boolean; validForMs?: number }>(endpoint + '/run', {
        signal, method: 'POST', body: { action, key, runId },
      }),
  };
}
