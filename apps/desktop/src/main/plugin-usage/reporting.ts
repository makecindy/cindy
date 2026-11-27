import { app } from 'electron';
import { getAccessToken, getActiveAuthRealm, getCurrentUserId, isLocalMode } from '../authManager.js';
import { isAnalyticsAllowed } from '../analytics-settings-store.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { PluginMarketApi } from '../plugin-market/api.js';
import type { PluginUsageIdentity, PluginUsageReportTarget } from '../../shared/pluginUsage.js';
import type { PluginUsageBuckets } from './buckets.js';

export interface PluginUsageReporting {
  scope(): string | null;
  target(identity: PluginUsageIdentity): PluginUsageReportTarget | null;
  send: ConstructorParameters<typeof PluginUsageBuckets>[0]['send'];
}

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
  const canSend = (target: PluginUsageReportTarget) =>
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
    scope() {
      if (!allowed()) return null;
      const serverRoot = root();
      return serverRoot ? JSON.stringify([getActiveAuthRealm(), serverRoot]) : null;
    },
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
    async send(target, buckets, signal, assertCurrent) {
      const guard = () => {
        assertCurrent();
        if (!canSend(target)) throw new Error('Plugin usage reporting source changed');
      };
      guard();
      const token = getAccessToken();
      if (!token) throw new Error('Plugin usage reporting authentication unavailable');
      return api.reportUsageBuckets(target.pluginId, buckets, {
        token, signal, serverRoot: target.serverRoot, assertCurrent: guard,
      });
    },
  };
}
