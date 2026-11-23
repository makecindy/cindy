/** Desktop wiring for the organization plugin author / colleague-picker client. */
import { app } from 'electron';

import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getActiveAuthRealm, getAuthState } from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch } from '../serverApiClient.desktop.js';
import { PluginAuthorApi } from './api.js';

/** Bound to account, organization, realm and data owner; null outside an org identity. */
export function pluginAuthorOwnerKey(): string | null {
  if (isAppSessionBoundaryPending()) return null;
  const state = getAuthState();
  const user = state.isAuthenticated ? state.user : null;
  if (!user || user.membershipKind !== 'org' || !user.orgId) return null;
  return JSON.stringify([activeOwnerScopeKey(), getActiveAuthRealm(), user.id, user.orgId]);
}

export function createPluginAuthorApi(): PluginAuthorApi {
  return new PluginAuthorApi({
    fetch: serverApiFetch,
    pluginBaseUrl: () => getClientEndpoint('pluginApiBaseUrl'),
    authBaseUrl: () => getClientEndpoint('authApiBaseUrl'),
    clientVersion: () => app.getVersion(),
    ownerKey: pluginAuthorOwnerKey,
  });
}
