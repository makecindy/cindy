import {
  REMOTE_DESKTOP_ICE_CONFIG_PATH,
  REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
  resolveDesktopIceServers,
} from '@cindy/device-link';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch } from '../serverApiClient.js';

export function loadDesktopIceServers() {
  return resolveDesktopIceServers(() =>
    serverApiFetch(REMOTE_DESKTOP_ICE_CONFIG_PATH, {
      baseUrl: () => getClientEndpoint('deviceLinkApiBaseUrl'),
      timeoutMs: REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
      cache: 'no-store',
      redactErrorDetails: true,
    }),
  );
}
