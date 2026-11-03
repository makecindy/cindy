import { app } from 'electron';
import { getAccessToken, getCurrentUserId, isLocalMode } from '../authManager.js';
import { isAnalyticsAllowed } from '../analytics-settings-store.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { PluginMarketApi } from '../plugin-market/api.js';
import type { PluginUsageReporting } from './reporter.js';

/** The installed release's verified origin is frozen into each event, never inferred on retry. */
export function createPluginUsageReporting(ownerId: string): PluginUsageReporting {
  const api = new PluginMarketApi(undefined, () => app.getVersion());
  const root = () => {
    try {
      return getClientEndpoint('pluginApiBaseUrl').replace(/\/+$/, '');
    } catch {
      return '';
    }
  };
  const allowed = () => !isLocalMode() && getCurrentUserId() === ownerId && isAnalyticsAllowed();
  const canSend: PluginUsageReporting['canSend'] = (target) =>
    Boolean(
      target &&
      allowed() &&
      target.ownerId === ownerId &&
      target.serverRoot &&
      target.serverRoot === root() &&
      typeof target.pluginId === 'string' &&
      target.pluginId.length > 0 &&
      ((target.scope === 'public' && target.organizationId === null) ||
        (target.scope === 'organization' &&
          typeof target.organizationId === 'string' &&
          target.organizationId.length > 0)),
    );
  return {
    allowed,
    canSend,
    target(identity) {
      if (
        !allowed() ||
        identity.sourceKind !== 'server' ||
        !identity.pluginId ||
        !identity.releaseId ||
        !identity.verifiedServerRoot ||
        identity.verifiedServerRoot !== identity.serverRoot ||
        (identity.reportingScope !== 'public' && identity.reportingScope !== 'organization')
      )
        return null;
      const target = {
        serverRoot: identity.verifiedServerRoot,
        pluginId: identity.pluginId,
        ownerId,
        scope: identity.reportingScope,
        organizationId: identity.organizationId,
      };
      return canSend(target) ? target : null;
    },
    async send(target, events, assertCurrent) {
      const guard = () => {
        assertCurrent();
        if (!canSend(target)) throw new Error('Plugin usage reporting source changed');
      };
      guard();
      const token = getAccessToken();
      if (!token) throw new Error('Plugin usage reporting authentication unavailable');
      return api.reportUsage(target.pluginId, events, { token, assertCurrent: guard });
    },
  };
}
