import {
  createDefaultRouteFollower, isChannelOwnedRow, type ImDefaultRouteHost,
  type RouteAuthCheck,
} from '@cindy/im-runtime/channelDefaultRouteSync';
import type { ImDefaultSettingsChannel } from '@cindy/im-runtime/imDefaultSettings';
import type { ImOrchestratorConfig } from '@cindy/im-runtime/types';
import type { createImSessionDefaults } from '@cindy/im-runtime/defaultSessionSettings';
import type { Logger } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import type { TerminalTaskStorage } from '../tasks/storage.js';
import type { TerminalTaskRoutes } from '../tasks/routes.js';

export interface TerminalChannelRouteConfig {
  source: ImDefaultSettingsChannel;
  config: ImOrchestratorConfig;
  isRouteUsable: RouteAuthCheck;
}

/** Same follower as Desktop; only the owner-scoped journal and send lane differ. */
export function createTerminalChannelRouteFollower(channel: TerminalChannelRouteConfig, host: {
  storage: TerminalTaskStorage;
  routes: TerminalTaskRoutes;
  defaults: ReturnType<typeof createImSessionDefaults>;
  listProviders(): Promise<ProviderView[]>;
  assertCurrent(): void;
  logger: Logger;
}) {
  const adapter: ImDefaultRouteHost = {
    log: host.logger,
    readSessionRouteRow: async id => {
      host.assertCurrent();
      const row = await host.storage.get(id);
      host.assertCurrent();
      return row ? { agentKind: row.agentKind, model: row.model, providerId: row.providerId ?? null,
        agentDeviceId: row.agentDeviceId ?? null, effort: row.effort ?? null, fastMode: row.fastMode ?? false,
        source: row.source ?? null, status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active',
        remoteHostId: row.remoteHostId ?? null, orcaRole: null, imDefaultRoute: row.imDefaultRoute ?? null,
        feishuBotAppId: row.feishuBotAppId ?? null, imBotContextId: row.imBotContextId ?? null } : null;
    },
    listProviders: async () => { try { return await host.listProviders(); } catch { return null; } },
    writeRecord: async (id, json) => {
      if (!await host.storage.updateIf(id, row => !row.deleted && !row.archived, { imDefaultRoute: json }, host.assertCurrent)) throw new Error('TASK_NOT_FOUND');
    },
    readPendingAgentSwitchRoute: host.routes.pendingRoute,
    applySessionRouteUnderSendLock: host.routes.applySystemUnderLock,
    cancelPendingAgentSwitchForSession: id => host.routes.cancel(id),
    acquirePendingAgentSwitchForImSend: (id, sync) => host.routes.acquireForSend(id, sync),
  };
  return createDefaultRouteFollower({
    label: channel.source,
    ownsRow: row => isChannelOwnedRow(row, channel.source),
    fingerprint: () => host.defaults.readImDefaultSettingsFingerprint(channel.source),
    resolveTarget: providers => host.defaults.resolveImSessionDefaults(channel.config, providers, channel.source),
    isRouteUsable: channel.isRouteUsable,
  }, adapter);
}
