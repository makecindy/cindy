import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { officialDeviceLinkApiFetch } from './deviceLinkApi.desktop.js';

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
  const options = { beforeHop: assertCurrent, timeoutMs: 8000 };
  return {
    read: () => officialDeviceLinkApiFetch<AutomationHostChoice>(endpoint + '?key=' + encodeURIComponent(key), options),
    select: (revision: number, useThisDevice: boolean) => officialDeviceLinkApiFetch<AutomationHostChoice>(endpoint, {
      ...options, method: 'PUT', body: { key, revision, useThisDevice },
    }),
    run: (action: 'acquire' | 'renew' | 'release', runId: string, signal?: AbortSignal) =>
      officialDeviceLinkApiFetch<{ granted?: boolean; validForMs?: number }>(endpoint + '/run', {
        ...options, signal, method: 'POST', body: { action, key, runId },
      }),
  };
}
