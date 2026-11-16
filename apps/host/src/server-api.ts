import { createServerApiClient, type ApiFetchOptions } from '../../desktop/src/main/serverApiClient.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../desktop/src/main/appSessionState.js';
import { createLogger } from '../../desktop/src/main/logger.js';
import { hostOutbound } from './outbound.mjs';

/** Use the Desktop error/refresh contract, with the Node network adapter and a
 * captured account boundary covering requests, refresh and returned payloads. */
export function createHostServerApi(options: {
  token(): string | null;
  refresh(): Promise<boolean>;
  invalidate(reason: string): Promise<void>;
  locale(): string;
}) {
  const log = createLogger('serverApiClient');
  return async function request<T>(path: string, init: ApiFetchOptions): Promise<T> {
    const owner = activeOwnerScopeKey();
    const check = () => {
      if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner) throw new Error('ACCOUNT_CHANGED');
    };
    check();
    const client = createServerApiClient({ log, locale: options.locale,
      fetch: async (url, request) => {
        check();
        const response = await hostOutbound.outboundFetch(url, { ...request, redirect: 'error' });
        check(); return response;
      },
      auth: {
        getAccessToken: () => { check(); return options.token(); },
        refresh: async () => { check(); const refreshed = await options.refresh(); check(); return refreshed; },
        invalidateSession: async reason => { check(); await options.invalidate(reason); },
      },
    });
    const result = await client<T>(path, init);
    check(); return result;
  };
}
