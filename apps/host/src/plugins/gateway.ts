import path from 'node:path';
import type { Session, McpProvider } from '@cindy/maker-core';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';
import type { LiziMcpProvider } from '@cindy/mcps';
import { createCindyGhostsMcpServer } from 'cindy-tools';
import { createGhostGateway, type CindyGhostsHostDeps } from '../../../desktop/src/main/mcp-integrations/ghost.js';
import { createGhostAttachmentResolver } from '../../../desktop/src/main/mcp-integrations/ghostAttachmentResolveCore.js';
import { createImageCacheStore } from '../../../desktop/src/main/imageCacheStore.js';
import { createMcpAppsRuntime } from '../../../desktop/src/main/mcp-apps/runtimeCore.js';
import { createPluginAppRegistry } from '../../../desktop/src/main/mcp-integrations/pluginAppRegistryCore.js';
import { createPluginAppPublisher, pluginAppResult, pluginModelResult } from '../../../desktop/src/main/mcp-apps/pluginCardsCore.js';
import { createMcpAppsService, type McpAppsServicePorts } from '../../../desktop/src/main/mcp-apps/service.js';
import { handleMcpAppOperation } from '../../../desktop/src/main/mcp-apps/operations.js';
import { createMcpAppRevisionKeyStore } from '../../../desktop/src/main/secrets/mcpAppRevisionKeyCore.js';
import { MCP_APP_REVISION_KEY_STORAGE_KEY, customMcpSecretStorageKey } from '../../../desktop/src/shared/providerSecrets.js';
import { createCustomMcpStore } from '../../../desktop/src/main/maker-host/custom-mcp-store.js';
import { createCustomMcpRegistry } from '../../../desktop/src/main/mcp-integrations/custom-mcp-registry.js';
import { createAppServerProxyFactory } from '../../../desktop/src/main/mcp-apps/serverProxy.js';
import { getCurrentDbClientSnapshot } from '../../../desktop/src/main/localDb/client/current.js';
import { getSessionFsSnapshot } from '../../../desktop/src/main/localDb/sessionFsSnapshot.js';
import { getBotAuthorizationService } from '../../../desktop/src/main/maker-ipc/botAuthorizationService.js';
import { isBotAuthorizationSession } from '../../../desktop/src/main/maker-ipc/botAuthorizationIdentity.js';
import { resolveGhostFsSessionSnapshot } from '../../../desktop/src/main/maker-ipc/ghostFsSessionSnapshot.js';
import type { GhostGrantConfirmBridge } from '../../../desktop/src/main/cindy-brain/ghostGrantConfirmBridge.js';
import { dataOwnerStorageKey } from '../../../desktop/src/main/dataOwnerPath.js';
import { hostBlobStore, hostChatAttachments } from '../media-store.js';
import type { createHostPluginRuntime } from './runtime.js';

interface GatewayOptions {
  runtime: Awaited<ReturnType<typeof createHostPluginRuntime>>;
  profileDir: string;
  ownerId: string;
  version: string;
  credentials: { encrypt(value: string): string; decrypt(value: string): string; read(key: string): string | null };
  getSession(id: string): Session | undefined;
  /** Uses the task service's existing serial admission and lazy restoration. */
  restoreSession(id: string, assertCurrent: () => Promise<void>): Promise<Session>;
  fileConfirmation: GhostGrantConfirmBridge;
  requestHostPermission: CindyGhostsHostDeps['requestHostPermission'];
  cards: Pick<McpAppsServicePorts, 'writeMessage' | 'publishMessage' | 'request' | 'review' | 'send' | 'allowPendingPage'>;
}

/** The same discovery, approval, tool-call and card services as Desktop. The
 * launcher owns transport and lifetime; neither models nor remote pages call
 * the runtime dispatcher directly. */
export function createHostPluginGateway(options: GatewayOptions) {
  const { runtime } = options;
  const apps = createMcpAppsRuntime();
  const database = getCurrentDbClientSnapshot();
  const customStore = createCustomMcpStore({
    getDbClient() {
      runtime.assertCurrent();
      if (!database || database !== getCurrentDbClientSnapshot()) throw new Error('MCP_APP_OWNER_CHANGED');
      return database.client;
    },
    credentials: { ...options.credentials, assertAvailable: runtime.assertCurrent },
  });
  const readCustomMcpToken = (id: string) => {
    runtime.assertCurrent();
    return options.credentials.read(`owner_${dataOwnerStorageKey(options.ownerId)}_${customMcpSecretStorageKey(id)}`);
  };
  const custom = createCustomMcpRegistry({
    ...apps,
    listCustomMcpServers: async () => {
      const configs = await customStore.listCustomMcpServers(); runtime.assertCurrent(); return configs;
    },
    readCustomMcpToken,
    createAppServerProxy: createAppServerProxyFactory(apps),
  });
  const registry = createPluginAppRegistry(apps.replacePluginAppServers);
  const key = `owner_${dataOwnerStorageKey(options.ownerId)}_${MCP_APP_REVISION_KEY_STORAGE_KEY}`;
  const revisionKey = createMcpAppRevisionKeyStore({
    filePath: () => { runtime.assertCurrent(); return path.join(options.profileDir, 'safe-storage', `${key}.enc`); },
    available: runtime.current,
    read: () => { runtime.assertCurrent(); return options.credentials.read(key); },
    encrypt: value => { runtime.assertCurrent(); return options.credentials.encrypt(value); },
  });
  const { host } = createMcpAppsService({
    ...options.cards,
    currentOwner: () => runtime.current() ? getCurrentDbClientSnapshot() ?? undefined : undefined,
    readAppServer: apps.readAppServer,
    getMcpAppRevisionKey: revisionKey.get,
    pluginFiles: runtime.files,
  });
  apps.setMcpAppsHost(host);
  const gateway = createGhostGateway({
    publishPluginAppResult: createPluginAppPublisher(apps), pluginModelResult,
    getBotAuthorizationService, isBotAuthorizationSession, getSessionFsSnapshot,
    getGhostCardService: () => runtime.cards,
    getGhostManager: () => runtime.manager,
    listInstalledGhostsAsync: runtime.list,
    getGhostPipeDispatcher: () => runtime.dispatcher,
    getGhostSetupAssessment: runtime.authorization.assess,
    captureGhostMutationOwnerForMcp: runtime.captureMutationOwner,
    acquireGhostMutationLeaseForMcp: runtime.acquireMutationLease,
    isGhostAvailableForActiveSession: id => runtime.current() && runtime.getGhost(id) !== null,
    getGhostHandoffStore: () => runtime.handoff,
    blobStore: hostBlobStore,
    commitMessageMediaRefs: hostChatAttachments.commitMessageMediaRefs,
    resolveGhostAttachmentUrl: createGhostAttachmentResolver(hostBlobStore, createImageCacheStore(() => options.profileDir)),
    getGhostGrantConfirmBridge: () => options.fileConfirmation,
    getGhostSetupCoordinator: () => runtime.authorization.coordinator,
    setupFollowsToolCancellation: true,
    t: runtime.authorization.i18n.t,
  });
  const hostDeps: CindyGhostsHostDeps = {
    getAppVersion: () => options.version,
    requestHostPermission: options.requestHostPermission,
    getLiveSessionGrantState(id, instanceId) {
      const snapshot = resolveGhostFsSessionSnapshot(options.getSession, id, instanceId);
      if (!snapshot || !runtime.current()) return null;
      return { ...snapshot, permissionMode: permissionModeOrAsk(snapshot.permissionMode), isCurrent: () => runtime.current() && !snapshot.planModeEnabled
        && snapshot.permissionMode !== 'plan' && snapshot.isCurrent?.() === true };
    },
  };
  registry.setPluginPageToolRunner(async (grant, args, signal) => {
    const assertCurrent = async () => {
      signal.throwIfAborted(); runtime.assertCurrent(); await grant.assertCurrent();
      runtime.assertCurrent(); signal.throwIfAborted();
    };
    await assertCurrent();
    const session = grant.sessionId === null ? undefined : await options.restoreSession(grant.sessionId, assertCurrent);
    await assertCurrent();
    if (session?.remoteHostId) throw new Error('MCP_APP_SESSION_UNAVAILABLE');
    const deps = gateway.getCindyGhostsMcpDeps(session ? { sessionId: session.id, sessionInstanceId: session.instanceId,
      agentKind: session.agentKind, workingDir: session.workDir } : undefined, hostDeps, grant);
    const result = await deps.callGhostTool({ ghostId: grant.instance, tool: grant.tool, args, signal });
    await assertCurrent();
    return result.ok ? pluginAppResult(result.result) : { isError: true,
      content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  gateway.setPageControlGhostProvider(() => runtime.browserExtensions.getPageControl()?.instanceId ?? null);
  const provider: LiziMcpProvider = {
    name: 'cindy',
    capability: { title: 'Plugins and media', description: 'Discover installed plugins, their tools, accounts and media capabilities.',
      source: 'builtin', discovery: { tool: 'ghost_list' } },
    isEnabled: runtime.current,
    toClaudeSdkConfig: context => {
      runtime.assertCurrent();
      return { type: 'sdk', name: 'cindy', instance: createCindyGhostsMcpServer(gateway.getCindyGhostsMcpDeps(context, hostDeps)) };
    },
  };
  return {
    provider, host, modelContext: apps.mcpAppModelContext, appServerIds: apps.appServerIds,
    /** The plugin roster section the desktop gives each engine (ghost.ts getGhostRosterPrompt).
     * After an owner change it is empty instead of describing the previous owner's plugins. */
    rosterPrompt: (ctx: { workingDir?: string }) => (runtime.current() ? gateway.getGhostRosterPrompt(ctx) : ''),
    /** Built-in and approved plugin Skills, the desktop's listCindyManagedSkills (maker-host/managed-skills.ts). */
    managedSkills: () => runtime.listManagedSkills(),
    /** This owner's custom MCP registry reads and token reader, as the desktop's MCP duplicate
     * preferences read them (mcp-duplicate-preferences.ts). Read-only. */
    customMcp: {
      getBuiltinMcpServerNames: () => custom.getBuiltinMcpServerNames(),
      listRegistrableCustomMcpServers: () => custom.listRegistrableCustomMcpServers(),
      readCustomMcpToken,
    },
    async prepareMcpProviders(providers: McpProvider[]) {
      runtime.assertCurrent();
      custom.registerCustomMcpArrays(providers);
      await custom.refreshCustomMcpProviders();
      runtime.assertCurrent();
      return providers;
    },
    async refresh() {
      const ghosts = await runtime.list(); runtime.assertCurrent();
      registry.refreshPluginApps(ghosts, { find: runtime.getGhost, available: runtime.current,
        evidence: id => runtime.manager.approvedInstallEvidence(id) });
    },
    async invoke(caller: string, sessionId: string, input: unknown) {
      runtime.assertCurrent();
      const result = await handleMcpAppOperation(host, caller, sessionId, input);
      runtime.assertCurrent(); return result;
    },
    releaseCaller: (caller: string) => host.releaseCaller(caller),
    async close() { await host.reset(); custom.resetCustomMcpRegistry(); revisionKey.clear(); },
  };
}
