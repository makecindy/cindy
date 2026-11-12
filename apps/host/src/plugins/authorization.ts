import { isDeepStrictEqual } from 'node:util';
import { GhostOauthAccountManager } from '../../../desktop/src/main/cindy-brain/ghostOauthAccounts.js';
import { GhostConnectionManager } from '../../../desktop/src/main/cindy-brain/ghostConnections.js';
import { GhostSetupChangeBus } from '../../../desktop/src/main/cindy-brain/ghostSetupChangeBus.js';
import { GhostSetupCoordinator } from '../../../desktop/src/main/cindy-brain/ghostSetupCoordinator.js';
import { GhostSetupInteractionBridge } from '../../../desktop/src/main/cindy-brain/ghostSetupInteractionBridge.js';
import { withGhostOauthMutationLock } from '../../../desktop/src/main/cindy-brain/ghostOauthMutationLock.js';
import { cancelActiveGhostOauthFlow } from '../../../desktop/src/main/cindy-brain/ghostOauthFlow.js';
import { createGhostOauthBrokerClient } from '../../../desktop/src/main/cindy-brain/ghostOauthBroker.js';
import { parseOauthConnectSecretKey } from '../../../desktop/src/main/cindy-brain/ghostSetupStatus.js';
import { mapGhostOauthConnectError } from '../../../desktop/src/main/cindy-brain/ghostOauthSetupError.js';
import { executeGhostSetupInlineSubmission } from '../../../desktop/src/main/cindy-brain/ghostSetupInlineExecutorCore.js';
import { executeGhostSetupConnectionSubmission } from '../../../desktop/src/main/cindy-brain/ghostSetupConnectionExecutor.js';
import { assessPluginSetup, pluginSetupProbes, pluginOauthReauthSuggestion } from '../../../desktop/src/main/cindy-brain/pluginSetupService.js';
import { createGhostVisibility } from '../../../desktop/src/main/cindy-brain/ghostVisibility.js';
import { isGhostDisabledForWorkdir } from '../../../desktop/src/main/cindy-brain/ghostWorkdirPrefs.js';
import { toolNotFoundMessage } from '../../../desktop/src/main/cindy-brain/pipeDispatcher.js';
import { installedGhostMutationTargetToken, installedGhostStoragePart } from '../../../desktop/src/shared/pluginIdentity.js';
import type { InstalledGhost } from '../../../desktop/src/shared/ghost.js';
import type { GhostKvStore } from '../../../desktop/src/main/cindy-brain/ghostKvStore.js';
import type { createHostPluginSecrets } from './secrets.js';
import type { createHostPluginIdentity } from './identity.js';
import { getRemoteOauthContext } from '../../../desktop/src/main/plugin-oauth/context.js';
import { ConnectionTokenProvider, type IssuedConnectionToken } from '../../../desktop/src/main/cindy-brain/connectionTokenProvider.js';
import { createMainI18n } from '../../../desktop/src/main/i18n.js';
import { createLogger } from '../../../desktop/src/main/logger.js';
import { hostOutbound } from '../outbound.mjs';

export interface PluginAccountPorts {
  hasLogin(): boolean;
  post(service: 'oauthBrokerApiBaseUrl' | 'authApiBaseUrl', path: string, body: Record<string, unknown>): Promise<unknown>;
  endpoint(service: 'oauthBrokerApiBaseUrl'): string;
  openExternal(url: string): Promise<void>;
  modelAccessReady(): boolean;
}

/** Owner-scoped assembly of the existing OAuth/setup services. The browser and
 * Node adapter never receive refresh tokens, OIDC tokens or raw setup values. */
export function createHostPluginAuthorization(options: {
  owner: string;
  root(...parts: string[]): string;
  current(): boolean;
  assertCurrent(): void;
  getGhost(id: string): InstalledGhost | null;
  list(): InstalledGhost[];
  secret: ReturnType<typeof createHostPluginSecrets>;
  kv: GhostKvStore;
  identity: ReturnType<typeof createHostPluginIdentity>;
  account: PluginAccountPorts;
  publish(channel: string, payload: unknown): void;
  signal: AbortSignal;
}) {
  const { owner, root, current, assertCurrent, getGhost, secret, identity, account } = options;
  const log = createLogger('host-plugin-auth');
  const i18n = createMainI18n(() => [Intl.DateTimeFormat().resolvedOptions().locale]);
  const changes = new GhostSetupChangeBus(log);
  const changed = (id: string, source: 'oauth' | 'secret' | 'connection', ref?: string) => {
    assertCurrent(); changes.emit(id, { source, ref });
    options.publish('ghosts:changed', { ghosts: options.list() });
  };
  const target = (id: string) => {
    const ghost = getGhost(id);
    return ghost ? installedGhostMutationTargetToken(ghost, owner) : null;
  };
  function withMutationLock<T>(id: string, task: () => Promise<T> | T): Promise<T> {
    assertCurrent();
    return withGhostOauthMutationLock(owner, id, root('ghost-install-state', '.oauth-locks', `${id}.lock`), () => {
      assertCurrent(); return task();
    });
  }
  const oauth = new GhostOauthAccountManager({
    vault: { read: secret.readGhostSecret, readStrict: secret.readGhostSecretStrict,
      store: secret.storeGhostSecret, remove: secret.removeGhostSecret },
    fetchImpl: (url, init) => hostOutbound.outboundFetch(url, { ...init,
      signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), options.signal]) }),
    fetchAvatarHop: (url, init) => hostOutbound.guardedOutboundFetch(url, { ...init, credentials: 'omit',
      signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), options.signal]) }, assertCurrent),
    openExternal: url => { assertCurrent(); return account.openExternal(url); },
    broker: createGhostOauthBrokerClient({
      hasLoginToken: account.hasLogin,
      apiPost: (path, body) => { assertCurrent(); return account.post('oauthBrokerApiBaseUrl', path, body); }, logger: log,
    }),
    resolveBrokerPublicUrl: path => `${account.endpoint('oauthBrokerApiBaseUrl').replace(/\/+$/, '')}${path}`,
    captureConnectTarget: target,
    isConnectTargetCurrent: (id, key, decl, expected) => {
      if (!current() || (expected !== undefined && (target(id) === null || target(id) !== expected))) return false;
      const fresh = getGhost(id)?.manifest.network?.secrets?.find(item => item.key === key && item.source === 'oauth')?.oauth;
      return fresh !== undefined && isDeepStrictEqual(fresh, decl);
    },
    withMutationLock,
    isTokenBrokerAuthorized: identity.brokerAuthorized,
    onAccountConnected: ({ ghostId, secretKey }) => changed(ghostId, 'oauth', secretKey),
    onAccountStatusChanged: ({ ghostId, secretKey }) => changed(ghostId, 'oauth', secretKey), logger: log,
  });
  const connections = new GhostConnectionManager({ vault: {
    read: secret.readGhostSecret, store: secret.storeGhostSecret, remove: secret.removeGhostSecret,
    readTail: secret.readGhostSecretTail,
  } });
  const connectionTokens = new ConnectionTokenProvider({ issue: async audience => {
    assertCurrent();
    const result = await account.post('authApiBaseUrl', '/api/auth/connections/token', { audience });
    assertCurrent(); return result as IssuedConnectionToken;
  } });
  const stores = { secretSaved: secret.ghostSecretSaved, oauth, connections, kv: options.kv };
  const assess = (id: string) => {
    assertCurrent(); const ghost = getGhost(id);
    if (!ghost) throw new Error('PLUGIN_SETUP_UNAVAILABLE');
    const storeId = installedGhostStoragePart(ghost);
    return assessPluginSetup({ translate: i18n.t, manifest: ghost.manifest, probes: pluginSetupProbes(stores, storeId, ghost.manifest),
      revision: changes.currentRevision(storeId),
      clientConfigReady: key => key === 'model-provider' && account.modelAccessReady(),
      reauthSuggestion: () => pluginOauthReauthSuggestion(oauth, storeId, ghost.manifest),
    });
  };
  const bridge = new GhostSetupInteractionBridge({ broadcast: options.publish, logger: log });
  const visibility = createGhostVisibility(i18n.t);
  const coordinator = new GhostSetupCoordinator({
    getTargetToken: target, remoteConnection: true, changeBus: changes, bridge, assess,
    resolveStoreId: id => { const ghost = getGhost(id); return ghost ? installedGhostStoragePart(ghost) : id; },
    validateTarget: (id, tool, workingDir) => {
      const ghost = getGhost(id);
      if (!ghost) return { ok: false, errorCode: 'GHOST_NOT_FOUND', message: i18n.t('newChat.pluginSetup.targetNotFound') };
      const result = visibility.classifyInstalledGhostVisibility(ghost, workingDir ?? null, {
        listGhosts: options.list, findInstalledInstance: id => getGhost(id) ?? undefined,
        isAvailableForActiveSession: () => current(), isDisabledForWorkdir: isGhostDisabledForWorkdir,
      });
      if (!result.ok) return result;
      if (tool && !result.ghost.manifest.tools?.some(item => item.name === tool))
        return { ok: false, errorCode: 'TOOL_NOT_FOUND', message: toolNotFoundMessage(id, tool, result.ghost.manifest) };
      return { ok: true };
    },
    getGhostIdentity: id => {
      const ghost = getGhost(id);
      return ghost ? { id: installedGhostStoragePart(ghost), name: ghost.manifest.name,
        ...(ghost.iconDataUrl ? { iconDataUrl: ghost.iconDataUrl } : {}) } : null;
    },
    executeAction: async args => {
      assertCurrent(); args.assertCurrent?.();
      const ghost = getGhost(args.ghostId);
      if (!ghost) return { ok: false, errorCode: 'TARGET_UNAVAILABLE' };
      if (args.action.kind !== 'oauth_connect') return { ok: false, errorCode: 'TARGET_UNAVAILABLE' };
      const key = parseOauthConnectSecretKey(args.action.id);
      const decl = ghost.manifest.network?.secrets?.find(item => item.key === key && item.source === 'oauth')?.oauth;
      if (!key || !decl) return { ok: false, errorCode: 'ACTION_STALE' };
      const remote = getRemoteOauthContext(); remote?.assertCurrent();
      const result = await oauth.connectAccount(installedGhostStoragePart(ghost), key, decl, {
        deliveryHosts: ghost.manifest.network?.hosts, remote,
        assertCurrent: () => { assertCurrent(); args.assertCurrent?.(); },
      });
      remote?.finish(result.ok);
      return result.ok ? { ok: true } : { ok: false, errorCode: mapGhostOauthConnectError(result.error) };
    },
    executeInlineAction: async args => {
      assertCurrent();
      return executeGhostSetupInlineSubmission({ translate: i18n.t, getAssessment: assess,
        getManifest: id => getGhost(id)?.manifest ?? null, storeSecret: secret.storeGhostSecret,
        emitChange: (id, key) => changed(id, 'secret', key), logger: log }, args);
    },
    timeoutMessage: () => i18n.t('newChat.pluginSetup.timeout'),
    cancelledMessage: () => i18n.t('newChat.pluginSetup.cancelled'), logger: log,
  });
  return {
    oauth, connections, connectionTokens, changes, target, assess, bridge, coordinator, withMutationLock, i18n,
    changed,
    bindConnection(args: { ghostId: string; actionId: string; onCommitted(): void }) {
      const ghost = getGhost(args.ghostId); if (!ghost) return null;
      const id = installedGhostStoragePart(ghost);
      const expectedTarget = target(id); const expectedManifest = JSON.stringify(ghost.manifest);
      return (value: import('@cindy/device-link').PluginConnectionInput) => {
        if (!current() || !expectedTarget || target(id) !== expectedTarget) return false;
        return executeGhostSetupConnectionSubmission({ getAssessment: assess,
          getManifest: key => getGhost(key)?.manifest ?? null, manager: connections,
          emitChange: (key, ref) => changed(key, 'connection', ref),
        }, { ...args, ghostId: id, value, expectedManifest });
      };
    },
    async reconcile(ghost: InstalledGhost) {
      const id = installedGhostStoragePart(ghost);
      await withMutationLock(id, () => oauth.reconcileAccountsForInstalledManifestWithResult(ghost.manifest, id));
    },
    cancelPending() {
      bridge.cleanupAll('session_closed'); cancelActiveGhostOauthFlow(); connectionTokens.clearAll();
    },
    async close() {
      this.cancelPending();
      await coordinator.waitForActionsIdle();
    },
  };
}
