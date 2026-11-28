import { AsyncLocalStorage } from 'node:async_hooks';
import { holdError, holdRefusal, releaseFailure, type ProfileHold } from '../agent/profile-hold.js';
import { createRequire } from 'node:module';
import { setMaxListeners } from 'node:events';
import { GhostManager } from '../../../desktop/src/main/cindy-brain/GhostManager.js';
import { GhostBrowserExtensionSlot } from '../../../desktop/src/main/cindy-brain/browserExtensionSlot.js';
import { hostRuntimeLayout } from '../runtime-layout.mjs';
import { GhostRuntime } from '../../../desktop/src/main/cindy-brain/runtime/GhostRuntime.js';
import { GhostPipeDispatcher } from '../../../desktop/src/main/cindy-brain/pipeDispatcher.js';
import { createGhostExecutionPipe } from '../../../desktop/src/main/cindy-brain/executionPipe.js';
import { createGhostKvStore, removeGhostKvBestEffort } from '../../../desktop/src/main/cindy-brain/ghostKvStore.js';
import { createGhostPageHandler } from '../../../desktop/src/main/cindy-brain/runtime/ghostPageHandler.js';
import { handleGhostSecretsRequest } from '../../../desktop/src/main/cindy-brain/runtime/ghostSecretsEndpoint.js';
import { handleGhostModelsRequest } from '../../../desktop/src/main/cindy-brain/runtime/ghostModelsEndpoint.js';
import { handleGhostHarnessesRequest } from '../../../desktop/src/main/cindy-brain/runtime/ghostHarnessesEndpoint.js';
import { configurePluginHarnessRegistry, PLUGIN_USAGE_WORKER_FAILURE, reconcilePluginHarnesses } from '../../../desktop/src/main/cindy-brain/pluginHarnesses.js';
import { pluginEngineAccountRoot } from '../../../desktop/src/main/plugin-engine-accounts/paths.js';
import { forgetPluginEngineAccountsOfPlugin } from '../../../desktop/src/main/plugin-engine-accounts/store.js';
import { checkGhostSecret } from '../../../desktop/src/main/cindy-brain/runtime/ghostSecretCheck.js';
import { mediaTypeForLibraryPath } from '../../../desktop/src/main/cindy-brain/runtime/ghostFiles.js';
import { GhostLibrarySlot } from '../../../desktop/src/main/cindy-brain/librarySlot.js';
import { LibraryBindingStore } from '../../../desktop/src/main/cindy-brain/libraryBinding.js';
import { LibraryVault, statfsFreeBytes } from '../../../desktop/src/main/cindy-brain/libraryVault.js';
import { LibrarySqlService } from '../../../desktop/src/main/cindy-brain/librarySqlService.js';
import { LibraryStagingStore } from '../../../desktop/src/main/cindy-brain/libraryStaging.js';
import { GhostNetworkSlot } from '../../../desktop/src/main/cindy-brain/networkSlot.js';
import { GhostCardService } from '../../../desktop/src/main/cindy-brain/cardService.js';
import { sanitizeGhostCardHtml } from '../../../desktop/src/main/cindy-brain/cardSanitizer.js';
import { upsertGhostCard } from '../../../desktop/src/main/cindy-brain/cardStoreDb.js';
import { resolveGhostFsSessionSnapshot } from '../../../desktop/src/main/maker-ipc/ghostFsSessionSnapshot.js';
import { recordGhostCallMedia } from '../../../desktop/src/main/cindy-brain/ghostMediaLedger.js';
import type { GhostGrantConfirmBridge } from '../../../desktop/src/main/cindy-brain/ghostGrantConfirmBridge.js';
import type { Session } from '@cindy/maker-core';
import { GhostFsSlot } from '../../../desktop/src/main/cindy-brain/fsSlot.js';
import { getGhostPickedDirectory } from '../../../desktop/src/main/cindy-brain/pickGrantsStore.js';
import { HostStorageService } from '../../../desktop/src/main/cindy-brain/storageService.js';
import { createHostStorageProviders } from '../../../desktop/src/main/cindy-brain/storageProviders.js';
import { GhostNotifySlot } from '../../../desktop/src/main/cindy-brain/notifySlot.js';
import { getDirDepositVault, getSaveDepositVault } from '../../../desktop/src/main/cindy-brain/dirDeposit.js';
import { PluginDownloadSlot } from '../../../desktop/src/main/cindy-brain/downloadSlot.js';
import { createDownloader } from '../../../desktop/src/main/downloader/service.js';
import { createPluginFileAccessCore } from '../../../desktop/src/main/mcp-apps/pluginFileAccessCore.js';
import { GhostMutationCoordinator } from '../../../desktop/src/main/cindy-brain/ghostMutationCoordinator.js';
import { GhostHandoffStore } from '../../../desktop/src/main/cindy-brain/handoffStore.js';
import { spawnResidentGhost } from '../../../desktop/src/main/cindy-brain/residentGhost.js';
import { setPluginEnabled } from '../../../desktop/src/main/cindy-brain/pluginEnableService.js';
import { ghostInstallApprovalToken, type InstalledGhost, type GhostAppContextResult } from '../../../desktop/src/shared/ghost.js';
import { installedGhostStoragePart, findInstalledGhostByInstanceId } from '../../../desktop/src/shared/pluginIdentity.js';
import { activeOwnerScopeKey, getActiveAppSession, getActiveDataOwnerPushStamp, isAppSessionBoundaryPending, type ActiveAppSession } from '../../../desktop/src/main/appSessionState.js';
import {
  availableGhostsIn,
  findGhostForInstanceIdIn,
  isGhostAvailableForSessionIn,
  listAvailableGhostsFrom,
  listInstalledGhostsForOwner,
} from '../../../desktop/src/main/cindy-brain/ghostAvailability.js';
import { createManagedSkills } from '../../../desktop/src/main/maker-host/managedSkillsCore.js';
import { ownerScopedPath } from '../../../desktop/src/main/dataOwnerPath.js';
import { createLogger, type Logger } from '../../../desktop/src/main/logger.js';
import { hostBlobStore, hostMediaIngest } from '../media-store.js';
import * as ledger from '../../../desktop/src/main/cindy-media/ledger.js';
import { createHeadlessPluginSandbox } from './chromium-sandbox.js';
import { createHostNodeRuntimeBroker } from './node-process.js';
import { createHostPluginSecrets } from './secrets.js';
import { createHostPluginIdentity } from './identity.js';
import { createHostPluginAuthorization, type PluginAccountPorts } from './authorization.js';
import { handleGhostOauthRequest } from '../../../desktop/src/main/cindy-brain/runtime/ghostOauthEndpoint.js';
import { handleGhostConnectionsRequest } from '../../../desktop/src/main/cindy-brain/runtime/ghostConnectionsEndpoint.js';
import type { User } from '../../../desktop/src/shared/authUser.js';
import { hostOutbound } from '../outbound.mjs';
import { prepareHostPluginAssets } from './assets.mjs';
import type { GhostNodeRuntimeBrokerDeps } from '../../../desktop/src/main/cindy-brain/nodeRuntimeBroker.js';

import { createRuntimePluginHost, type RuntimePluginHostPorts } from '../../../desktop/src/main/cindy-brain/runtimePluginHostCore.js';
import { summarizeLegacyPluginApprovals, type LegacyPluginApprovals } from './legacy-approvals.js';

interface PluginRuntimeOptions {
  modelRouteSources: RuntimePluginHostPorts['modelRouteSources'];
  /** Coexistence plan A: whether a Cindy desktop app running on its own uses this profile (plugin OAuth). */
  isProfileHeld?(): boolean;
  profileDir: string;
  ownerId: string;
  manager: GhostManager;
  credentials: Parameters<typeof createHostPluginSecrets>[2];
  getLoginEmail(): string | null;
  getUser?(): User | null;
  account?: PluginAccountPorts;
  confirmConnectionHost?(id: string, label: string, host: string): Promise<boolean>;
  appContext(): GhostAppContextResult;
  getSession(id: string): Session | undefined;
  requestFileConfirmation: GhostGrantConfirmBridge['request'];
  publish(channel: string, payload: unknown): void;
  hostToolRequest?: GhostNodeRuntimeBrokerDeps['hostToolRequest'];
  onPluginStopped?(id: string): void;
  log?: Logger;
  /** Built/release paths only, never plugin-provided. */
  assets?: Awaited<ReturnType<typeof prepareHostPluginAssets>>;
}

/** Production installed-plugin execution. All persistent stores use the same
 * owner roots and records as Desktop; no installation or approval is fabricated.
 * UI and account-dependent slots are attached separately by their owning services. */
export async function createHostPluginRuntime(options: PluginRuntimeOptions) {
  const assets = options.assets ?? await prepareHostPluginAssets();
  const owner = activeOwnerScopeKey();
  const log = options.log ?? createLogger('host-plugins');
  const root = (...parts: string[]) => ownerScopedPath(options.profileDir, options.ownerId, ...parts);
  const mutation = new GhostMutationCoordinator();
  const handoff = new GhostHandoffStore({ root: () => root('ghost-handoff') });
  const stopSignal = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const known = new Map<string, string>();
  const suspended = new Set<string>();
  const newDeliveryController = () => {
    const controller = new AbortController();
    setMaxListeners(0, controller.signal); // one listener per pending hook
    return controller;
  };
  let delivery = newDeliveryController();
  type CleanupJob = { id: string; kind: 'node' | 'library'; run(): Promise<void> };
  type Pause = { reason: ProfileHold; cleanup: Promise<CleanupJob[]>; resuming: boolean; signal: AbortSignal };
  let desktopPause: Pause | null = null;
  const unknownDelivery = {
    ok: false as const, errorCode: 'PLUGIN_DELIVERY_UNKNOWN',
    message: 'This tool call was running when the plugin paused and may have taken effect. Check the outcome before retrying.',
  };
  let closed = false;
  let closing: Promise<void> | undefined;
  let reconciliation: Promise<void> = Promise.resolve();
  let legacyApprovals: LegacyPluginApprovals | null = null;
  let enableChanges: Promise<unknown> = Promise.resolve();
  const current = () => !closed && !isAppSessionBoundaryPending() && activeOwnerScopeKey() === owner;
  const assertCurrent = () => { if (!current()) throw new Error('PLUGIN_OWNER_CHANGED'); };
  // Keep external tool admission closed while reconcile restores resident runtimes.
  let restoring: Pause | null = null;
  const uninstallRecovery = new AsyncLocalStorage<Pause>();
  const pausedReason = () => desktopPause?.reason ?? restoring?.reason;
  const profileHoldMessage = () => {
    const held = pausedReason();
    return held ? holdRefusal(held).message : null;
  };
  const pluginPauseFailure = () => {
    const reason = pausedReason();
    if (!reason) return null;
    const { code: errorCode, ...detail } = holdRefusal(reason);
    return { ok: false as const, errorCode, ...detail };
  };
  const assertPluginAvailable = () => {
    assertCurrent();
    const held = pausedReason();
    if (held) throw holdError(held);
  };
  const publish = (channel: string, payload: unknown) => {
    if (!pausedReason()) options.publish(channel, payload);
  };
  const findGhost = (id: string) => current() ? options.manager.findInstalledInstance(id)
    ?? findInstalledGhostByInstanceId(options.manager.list(), id) ?? null : null;
  const getGhost = (id: string) => {
    const ghost = findGhost(id);
    return ghost && suspended.has(installedGhostStoragePart(ghost)) ? { ...ghost, enabled: false } : ghost;
  };
  const revision = (ghost: InstalledGhost | null) => ghost
    ? JSON.stringify([ghost.dir, ghost.manifest.version, ghost.enabled, ghostInstallApprovalToken(ghost.approval)]) : '';
  const isCurrent = (ghost: InstalledGhost) => current() && ghost.enabled && revision(getGhost(installedGhostStoragePart(ghost))) === revision(ghost);
  const guard = (id: string) => {
    const ghost = getGhost(id);
    const signal = delivery.signal;
    return () => {
      const held = pausedReason();
      if (held) throw holdError(held);
      if (signal.aborted || !ghost || !isCurrent(ghost)) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
    };
  };
  const track = <T>(job: Promise<T>) => {
    pending.add(job);
    void job.then(() => pending.delete(job), () => pending.delete(job));
    return job;
  };
  const secret = createHostPluginSecrets(options.profileDir, options.ownerId, options.credentials);
  const kv = createGhostKvStore({ getRootDir: () => root('ghost-kv'), log });
  const models = createGhostKvStore({ getRootDir: () => root('ghost-published-models'), log });
  const harnesses = createGhostKvStore({ getRootDir: () => root('ghost-published-harnesses'), log });
  // Desktop's findGhostForInstanceId over this owner's manager (ghostAvailability.ts),
  // including its account-availability check. Identity reads use it; the runtime's
  // getGhost keeps its suspension overlay for everything else.
  const identityLookup = {
    getGhostManager: () => options.manager,
    isGhostAvailableForActiveSession: (id: string) => isGhostAvailableForSessionIn(options.manager, id),
    availableGhosts: () => availableGhostsIn(() => options.manager),
  };
  const identity = createHostPluginIdentity({ manager: options.manager, root,
    findGhost: id => (current() ? findGhostForInstanceIdIn(identityLookup, id) : null),
    getUser: options.getUser ?? (() => null), assertCurrent });
  // Desktop ghostOwnerScope (cindy-brain/index.ts): capture fails during an account
  // boundary; owner and generation must still match after the scan. The Host also
  // requires this runtime to be current.
  const sameAppSession = (a: ActiveAppSession, b: ActiveAppSession) =>
    a.mode === b.mode && a.dataOwnerId === b.dataOwnerId && a.generation === b.generation;
  const listingScope = {
    capture: () => {
      if (isAppSessionBoundaryPending()) throw new Error('账号切换中，已取消本次 Plugin 操作');
      return getActiveAppSession();
    },
    isCurrent: (scope: unknown) => current() && !!scope && sameAppSession(scope as ActiveAppSession, getActiveAppSession()),
    isStable: (scope: unknown) => current() && !!scope && !isAppSessionBoundaryPending()
      && sameAppSession(scope as ActiveAppSession, getActiveAppSession()),
  };
  // The desktop managed Skill catalog (managedSkillsCore.ts) over this owner's plugins.
  const managedSkills = createManagedSkills({
    listAvailableGhosts: () => listAvailableGhostsFrom(() => listInstalledGhostsForOwner(listingScope, () => options.manager)),
    getGhostManager: () => options.manager,
    loadGhostFirstPartyFactsForGhost: (id, purpose) => identity.loadFirstPartyFacts(id, purpose),
  });
  const unavailable = () => { throw new Error('PLUGIN_ACCOUNT_SERVICE_UNAVAILABLE'); };
  const authorization = createHostPluginAuthorization({ owner, root, current, assertCurrent,
    getGhost, list: () => options.manager.list(), secret, kv, identity, isProfileHeld: options.isProfileHeld,
    account: options.account ?? { hasLogin: () => false, post: unavailable, endpoint: unavailable,
      openExternal: unavailable },
    publish, signal: stopSignal.signal });
  const require = createRequire(import.meta.url);
  const library = new GhostLibrarySlot({
    getGhost, captureOwnerScope: () => current() ? owner : null,
    bindingStore: new LibraryBindingStore({ getFile: () => root('libraries-binding.json'),
      getManagedRoots: () => [options.profileDir], getDefaultRoot: id => root('libraries', id), log }),
    getDefaultRoot: id => root('libraries', id), getStagingRoot: id => root('library-staging', id),
    createVault: deps => new LibraryVault(deps), createSqlService: deps => new LibrarySqlService(deps),
    createStagingStore: deps => new LibraryStagingStore(deps), getDiskFreeBytes: statfsFreeBytes,
    workerScriptPath: () => assets.libraryWorker!, betterSqliteModulePath: () => require.resolve('better-sqlite3'),
    captureMutationOwner: () => owner,
    beginMutation: expected => { assertCurrent(); if (expected !== owner) throw new Error('PLUGIN_OWNER_CHANGED'); return mutation.acquire(); }, log,
  });
  const files = createPluginFileAccessCore(hostBlobStore, {
    openHandoff: (id, ref) => handoff.openForPage(id, ref),
    libraryPath: (id, file) => library.resolvePanelFilePath(id, file), libraryMime: mediaTypeForLibraryPath,
  });
  const cards = new GhostCardService({
    hasCardSlot: id => { const ghost = getGhost(id); return Boolean(ghost?.enabled && ghost.manifest.card); },
    sanitize: sanitizeGhostCardHtml,
    // Shutdown closes admission before draining already accepted writes. Storage
    // stays mounted until close() completes; never resolve a replacement owner.
    persist: async row => {
      if (activeOwnerScopeKey() !== owner) throw new Error('PLUGIN_OWNER_CHANGED');
      await upsertGhostCard(row);
    },
    broadcast: payload => { if (current()) publish('ghosts:card-updated', payload); }, log,
  });
  const fsSlot = new GhostFsSlot({ getGhost, dataRootDir: () => root('ghost-fs'),
    ownerKey: () => owner, resolvePickedDirectory: getGhostPickedDirectory,
    callInfo: id => current() ? cards.callInfoOf(id) : null,
    inFlightCallInfo: id => current() ? cards.inFlightCallInfoOf(id) : null,
    getSessionSnapshot: async (id, instance) => current() ? resolveGhostFsSessionSnapshot(options.getSession, id, instance) : null,
    requestWriteConfirm: (id, payload) => { assertCurrent(); return options.requestFileConfirmation(id, payload); },
    writeSaveDeposit: (id, token, name, bytes) => getSaveDepositVault().write(id, token, name, bytes), log });
  const storage = new HostStorageService({ ownerKey: () => owner, getGhost, handoff, listGhosts: () => options.manager.list(),
    providers: createHostStorageProviders({ kv, files: fsSlot, library, handoff, media: files,
      kvChanged: id => authorization.changes.emit(id, { source: 'kv' }) }),
  });
  const network = new GhostNetworkSlot({ getGhost, captureRequestGuard: guard,
    inFlightCallInfo: id => current() ? cards.inFlightCallInfoOf(id) : null,
    getCallSignal: (id, callId) => dispatcher.getPendingCallSignal(id, callId) ?? undefined,
    resolveWebSocketAgent: hostOutbound.createOutboundHttpAgent,
    readSecret: secret.readGhostSecret, getLoginEmail: options.getLoginEmail,
    resolveSavedCredential: (id, key) => authorization.resolveSavedCredential(id, key),
    fetchImpl: (url, init) => hostOutbound.outboundFetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), stopSignal.signal]) } as RequestInit),
    fetchPublicImpl: (url, init, before) => hostOutbound.guardedOutboundFetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), stopSignal.signal]) } as RequestInit, before),
    readHandoffFile: (id, ref) => { assertCurrent(); return handoff.read(id, ref); },
    touchHandoffFiles: (id, refs) => handoff.touch(id, refs),
    readLibraryFile: (id, file, signal) => files.read(id, `library:${file}`, new Request('https://cindy.invalid/', { signal })),
    saveLibraryStream: (id, input) => library.importStream(id, input),
    isSupportedMediaMime: hostBlobStore.supportedMime,
    readGhostMedia: async (id, hash) => {
      const check = guard(id); check();
      if (!await ledger.ghostCanRead(hash, id)) return null;
      const info = await ledger.getBlobInfo(hash); if (!info) return null;
      const { buffer } = await hostBlobStore.readFile(hostBlobStore.blobUrl(hash, info.ext));
      check(); return { buffer, mimeType: info.mimeType, ext: info.ext };
    },
    saveGhostMedia: async ({ ghostId, buffer, mimeType, label, callId, assertStillValid }) => {
      const check = guard(ghostId);
      const result = await hostMediaIngest.ingestMedia({ buffer, mimeType, isCache: false,
        refs: [{ refKind: 'ghost-gallery', refId: ghostId, originKind: 'ghost', originId: ghostId, ...(label ? { label } : {}) }],
        assertStillValid: () => { check(); assertStillValid?.(); } });
      recordGhostCallMedia(ghostId, callId, result.url);
      return { url: result.url, hash: result.hash, ext: result.ext };
    },
    takeDirDeposit: (id, token, callId) => getDirDepositVault().take(id, token, callId),
    writeSaveDeposit: (id, token, name, bytes) => getSaveDepositVault().write(id, token, name, bytes), log,
    oauthTokens: {
      getFreshAccessToken: (...args) => authorization.oauth.getFreshAccessToken(...args),
      invalidateAccessToken: (...args) => authorization.oauth.invalidateAccessToken(...args),
    },
    connectionTokens: {
      resolve: identity.connectionAudience,
      getToken: input => authorization.connectionTokens.getToken(input),
      invalidate: input => authorization.connectionTokens.invalidate(input),
    },
    connections: {
      hostsFor: id => [...new Set((getGhost(id)?.manifest.network?.connections ?? [])
        .flatMap(decl => authorization.connections.hostsOf(id, decl.key)))],
      tokenFor: (id, hostname) => {
        for (const decl of getGhost(id)?.manifest.network?.connections ?? []) {
          const value = authorization.connections.resolveTokenByHost(id, decl.key, hostname);
          if (value !== null) return { value, header: decl.inject.header, format: decl.inject.format };
        }
        return null;
      },
    },
  });
  // The execution owner, not a UI attachment, owns the browser bridge. The same
  // slot keeps pairing/provenance rules and stops accepted jobs on owner change.
  const browserExtensions = new GhostBrowserExtensionSlot({
    getGhost, policyDir: () => root('browser-extension'), ownerScopeKey: () => owner,
    isVerifiedOfficial: ghost => !hostRuntimeLayout().packaged || identity.isVerifiedPublicMarket(installedGhostStoragePart(ghost)),
    sendToGhost: async (id, payload) => { assertPluginAvailable(); return sandbox.deliver(id, payload, { failOnUncertain: true }); },
    wake: async id => { assertPluginAvailable(); const ghost = getGhost(id); return Boolean(ghost?.enabled && (await runtime.spawn(ghost)).ok); },
    // No trusted native confirmation surface is attached to Node Host yet. A
    // conflicting native registration is retained; never approve a takeover.
    confirmNativeTakeover: async () => false,
    log,
  });
  const ownerScope = { capture: () => owner, isCurrent: (value: unknown) => value === owner && current(), isStable: (value: unknown) => value === owner && current() };
  const disposeRuntimeHostServices = (id: string) => {
    network.disposeGhost(id); fsSlot.disposePlugin(id);
    // A profile hold stops plugin runtimes. An existing plugin terminal is
    // outside this boundary and keeps its original lifetime.
    if (!desktopPause || closed) options.onPluginStopped?.(id);
  };
  const hostToolRequest = options.hostToolRequest;
  const requestHostTool: PluginRuntimeOptions['hostToolRequest'] = hostToolRequest && ((id, payload, isPageCurrent) => {
    const refusal = pluginPauseFailure();
    if (refusal) return Promise.resolve(refusal);
    const signal = delivery.signal;
    return hostToolRequest(id, payload, () => !signal.aborted && isPageCurrent());
  });
  const node = createHostNodeRuntimeBroker(assets.nodeWorker!, { getGhost, ownerScope, startBlockedReason: profileHoldMessage,
    hostToolRequest: requestHostTool, onStopped: disposeRuntimeHostServices,
    // A stop that timed out left the reconcile unfinished; once the old processes are gone,
    // rerun it so the plugin returns to its expected state instead of staying gated.
    onStopSettledLate: () => { void reconcile().catch(error => log.warn('plugin reconcile after late stop failed', { error: String(error) })); },
    readSecret: secret.readGhostSecret, secretSaved: secret.ghostSecretSaved,
    resolveOauthSecret: async (id, key, accountId) => {
      const decl = getGhost(id)?.manifest.network?.secrets?.find(item => item.key === key && item.source === 'oauth')?.oauth;
      if (!decl) return { ok: false, error: 'NO_ACCOUNT' };
      return authorization.oauth.getNodeAccessToken(id, key, decl, accountId);
    },
    getCallSignal: (id, callId) => dispatcher.getPendingCallSignal(id, callId),
    getCallSessionId: (id, callId) => dispatcher.getPendingCallSessionId(id, callId),
    authenticatedFetch: async (id, request, authorization, check, signal) =>
      pluginPauseFailure() ?? network.handleAuthenticatedNodeFetch(id, request, authorization, check, signal),
    networkRequest: async (id, request) => pluginPauseFailure() ?? (request.op === 'fetch'
      ? network.handleFetchRequest(id, request) : network.handleNetworkRequest(id, request)),
    sendToGhost: (id, payload) => { void sandbox.deliver(id, payload); }, log,
  });
  const download = new PluginDownloadSlot({ getGhost, root: id => root('plugin-downloads', id), scope: () => owner,
    send: (id, event) => { void sandbox.deliver(id, event); }, download: createDownloader(), guardedFetch: hostOutbound.guardedOutboundFetch });
  const notify = new GhostNotifySlot({ getGhost, broadcast: payload => publish('ghosts:notify', payload), log });
  const pipe = createGhostExecutionPipe({ dispatcher: () => dispatcher,
    hostTools: requestHostTool,
    fetch: (id, payload) => network.handleFetchRequest(id, payload), files: (id, payload, check) => fsSlot.handleFsRequest(id, payload, check),
    network: (id, payload) => network.handleNetworkRequest(id, payload),
    library: (id, payload) => library.handleLibraryRequest(id, payload),
    download: (id, payload, check) => download.handle(id, payload, check),
    node: (id, payload, check) => download.withNodeDownloads(id, payload as Record<string, unknown>, request => node.handleRequest(id, request), check),
    warn: (message, details) => log.warn(message, details),
  });
  const sandbox = createHeadlessPluginSandbox({ ...assets, executablePath: assets.executablePath ?? undefined, ownerKey: () => owner,
    isCurrent: ghost => isCurrent(ghost), profileHoldMessage,
    send(ghost, payload) {
      const refusal = pluginPauseFailure();
      if (refusal) return Promise.resolve(refusal);
      const signal = delivery.signal;
      const id = installedGhostStoragePart(ghost);
      const result = pipe(id, payload, () => !signal.aborted && isCurrent(ghost));
      if (result) return track(result);
      const request = payload as { type?: string; kind?: string } | null;
      if (request?.type === 'browser-extension-request') return track(browserExtensions.handleRequest(id, payload));
      if (request?.type === 'event-verdict') {
        // The sandbox supplies the installation id. The shared gateway ignores stale or
        // mismatched replies and returns no information about pending requests to the page.
        taskPlugins.getGhostSubscriptionGateway().handleVerdict(id, payload);
        return Promise.resolve({ ok: true });
      }
      if (request?.type === 'card-update') { cards.handleCardUpdate(id, payload); return Promise.resolve({ ok: true }); }
      if (request?.type === 'host-request' && request.kind === 'app-context') return Promise.resolve(options.appContext());
      if (request?.type === 'notify') return Promise.resolve(notify.handleNotify(id, payload));
      return Promise.reject(new Error('UNSUPPORTED_CAPABILITY: this Host service is not connected'));
    },
    pageHandler: (ghost, origin, pageCurrent) => createGhostPageHandler({ ghost, origin, isCurrent: () => !pausedReason() && pageCurrent(),
      ghostKvStore: { read: id => { guard(id)(); return kv.read(id); }, write: (id, value) => { guard(id)(); kv.write(id, value); authorization.changes.emit(id, { source: 'kv' }); },
        captureTarget: id => revision(getGhost(id)), isTargetCurrent: (id, target) => !pausedReason() && current() && target === revision(getGhost(id)) },
      ghostWakeHandler: async id => { assertPluginAvailable(); const item = getGhost(id); if (!item) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
        const spawned = await runtime.spawn(item); return { state: spawned.ok ? spawned.state : runtime.stateOf(id) }; },
      ghostAppContextProvider: options.appContext,
      ghostModelsHandler: input => handleGhostModelsRequest({ ...input, needs: () => getGhost(input.ghostId)?.manifest.models ?? null,
        store: models, onChanged: () => publish('ghosts:changed', { ghosts: options.manager.list() }) }),
      ghostHarnessesHandler: input => handleGhostHarnessesRequest({
        ...input,
        declared: () => { const item = getGhost(input.ghostId); return item ? item.manifest.harnesses : null; },
        store: harnesses,
        onChanged: () => reconcilePluginHarnesses(),
      }),
      ghostSecretsHandler: async input => {
        const item = getGhost(input.ghostId); if (!item) return { status: 404 };
        const declared = item.manifest.network?.secrets ?? [];
        return handleGhostSecretsRequest({ ...input, userSecretKeys: declared.filter(s => !['login-email', 'oauth', 'oidc-token'].includes(s.source ?? 'user')).map(s => s.key)
          .concat((item.manifest.node?.secretBindings ?? []).filter(s => !s.oauthSecret).map(s => s.key)),
          identitySecretKeys: declared.filter(s => s.source === 'login-email').map(s => s.key), getLoginEmail: options.getLoginEmail,
          checkSecretKeys: declared.filter(s => s.check && (!s.source || s.source === 'user')).map(s => s.key),
          checkSecret: (key, value) => checkGhostSecret({ instanceKey: input.ghostId, secret: declared.find(s => s.key === key)!, value,
            isCurrent: input.isCurrent, fetch: hostOutbound.outboundFetch }),
          vault: { saved: secret.ghostSecretSaved, tail: secret.readGhostSecretTail,
            store: (id, key, value) => { const saved = secret.storeGhostSecret(id, key, value); if (saved) authorization.changed(id, 'secret', key); return saved; },
            remove: (id, key) => { secret.removeGhostSecret(id, key); authorization.changed(id, 'secret', key); } }, log });
      },
      ghostOauthHandler: input => {
        const ghost = getGhost(input.ghostId); if (!ghost) return Promise.resolve({ status: 404 });
        return handleGhostOauthRequest({ ...input, manager: authorization.oauth,
          oauthSecrets: new Map((ghost.manifest.network?.secrets ?? []).flatMap(item => item.source === 'oauth' && item.oauth ? [[item.key, item.oauth]] : [])),
          networkHosts: ghost.manifest.network?.hosts, isTokenBrokerAuthorized: identity.brokerAuthorized,
          withMutationLock: authorization.withMutationLock,
          onChanged: key => authorization.changed(input.ghostId, 'oauth', key), log });
      },
      ghostConnectionsHandler: input => {
        const ghost = getGhost(input.ghostId); if (!ghost) return Promise.resolve({ status: 404 });
        return handleGhostConnectionsRequest({ ...input, manager: authorization.connections,
          decls: new Map((ghost.manifest.network?.connections ?? []).map(decl => [decl.key,
            { label: decl.label, maxConnections: decl.maxConnections ?? 8 }])),
          confirmAddHost: async (label, host) => options.confirmConnectionHost?.(input.ghostId, label, host) ?? false,
          onChanged: key => authorization.changed(input.ghostId, 'connection', key), log });
      },
      ghostModelPickerProvider: null,
      ghostAgentModelsProvider: null, ghostModelPreferencesProvider: null, ghostMediaModelsProvider: null,
      serveGhostMedia: (id, file, range) => files.read(id, `cindy-media://blobs/${file}`, new Request(origin, { headers: range ? { range } : {} })),
      serveGhostLibraryFile: (id, file, range) => files.read(id, `library:${file}`, new Request(origin, { headers: range ? { range } : {} })),
      serveGhostGallery: async id => {
        const items = await ledger.listGhostGallery(id); guard(id)();
        return Response.json(items.map(item => ({ src: `${origin}/media/${item.hash}${item.ext}`, caption: item.label ?? '' })),
          { headers: { 'Cache-Control': 'no-cache' } });
      }, log,
    }),
  });
  const runtime = new GhostRuntime({ adapter: sandbox.adapter, log, startBlockedReason: profileHoldMessage,
    onStateChanged: (id, state) => {
      if (state !== 'running' && state !== 'starting') disposeRuntimeHostServices(id);
      dispatcher?.onRuntimeState(id, state); publish('ghosts:runtime-changed', { states: runtime.listStates() });
    } });
  const withSuspension = (ghost: InstalledGhost) =>
    suspended.has(installedGhostStoragePart(ghost)) ? { ...ghost, enabled: false } : ghost;
  const stampCurrent: RuntimePluginHostPorts['isGhostOwnerStampCurrent'] = stamp => {
    if (!current() || !stamp) return false;
    const active = getActiveDataOwnerPushStamp();
    return stamp.dataOwnerId === active.dataOwnerId && stamp.ownerGeneration === active.ownerGeneration;
  };
  const taskPlugins = createRuntimePluginHost({
    getGhostRuntime: () => runtime,
    availableGhosts: () => current() ? identityLookup.availableGhosts().map(withSuspension) : [],
    listGhostNotificationCandidates: () => listAvailableGhostsFrom(() => listInstalledGhostsForOwner(listingScope,
      () => ({ listAsync: () => options.manager.listNotificationCandidatesAsync() }))).then(items => items.map(withSuspension)),
    findGhostNotificationTarget: id => {
      if (!current()) return null;
      const ghost = options.manager.findInstalledInstance(id);
      return ghost && identityLookup.isGhostAvailableForActiveSession(id) ? withSuspension(ghost) : null;
    },
    findGhostForInstanceId: (id, namespace) => {
      const ghost = current() ? findGhostForInstanceIdIn(identityLookup, id, namespace) : null;
      return ghost ? withSuspension(ghost) : null;
    },
    sendToGhostLogic: sandbox.acceptGatewayDelivery,
    // Discovery and the owner/approval checks still see the same exact plugin
    // during a hold. Only the gateway's delivery is suspended.
    hookDeliveryPauseSignal: () => (desktopPause ?? restoring)?.signal ?? delivery.signal,
    ghostOwnerScope: { ...listingScope, onInvalidated: id => runtime.stop(id) },
    getGhostOwnerPushStamp: getActiveDataOwnerPushStamp,
    isGhostOwnerStampCurrent: stampCurrent,
    broadcastGhostWindowPush: (channel, payload, stamp) => {
      if (current() && (!stamp || stampCurrent(stamp))) publish(channel, payload);
    },
    modelRouteSources: options.modelRouteSources,
    log,
  });
  class HostGhostPipeDispatcher extends GhostPipeDispatcher {
    override async callGhostTool(request: Parameters<GhostPipeDispatcher['callGhostTool']>[0]) {
      const refusal = pluginPauseFailure();
      if (refusal) return refusal;
      const signal = delivery.signal;
      const result = await super.callGhostTool(request);
      // A stopped tool may already have made changes the host cannot observe.
      // Calls refused at admission and tools that returned a result keep theirs.
      return !result.ok && signal.aborted && current() ? unknownDelivery : result;
    }
  }
  const dispatcher = new HostGhostPipeDispatcher({ getGhost, runtimeStateOf: id => runtime.stateOf(id),
    spawn: ghost => runtime.spawnForTool(ghost), sendToGhost: sandbox.deliver, ownerScope, log });
  configurePluginHarnessRegistry({
    listGhosts: () => (current() ? identityLookup.availableGhosts().map(withSuspension) : []),
    isAvailable: id => current() && identityLookup.isGhostAvailableForActiveSession(id) && !suspended.has(id),
    readAvailability: id => (current() ? harnesses.read(id) : {}),
    uiLocale: () => {
      const result = options.appContext();
      const ctx = result.ok ? (result.context as { uiLocale?: string; locale?: string }) : undefined;
      return ctx?.uiLocale ?? ctx?.locale ?? 'en';
    },
    spawn: async (ghostId, harnessId, spawnOptions) => {
      assertPluginAvailable();
      return node.spawnHarness(ghostId, harnessId, spawnOptions);
    },
    requestRefresh: ghostId => {
      if (!current() || pausedReason()) return false;
      try { return sandbox.acceptGatewayDelivery(ghostId, { type: 'harnesses-refresh-requested' }); }
      catch { return false; }
    },
    readUsage: async (ghostId, harnessId, accountDir) => {
      if (!current() || pausedReason()) return null;
      const response = await node.handleRequest(ghostId, {
        type: 'node-request', method: 'usage',
        params: { harnessId, ...(accountDir !== undefined ? { accountDir } : {}) },
        timeoutMs: 26_000,
      });
      if (!current()) return null;
      if (response.ok) return response.result;
      switch (response.errorCode) {
        case 'TIMEOUT':
        case 'RATE_LIMITED':
        case 'PROCESS_START_FAILED':
        case 'PROCESS_EXITED':
        case 'PROTOCOL_ERROR':
        case 'INTERNAL':
          return PLUGIN_USAGE_WORKER_FAILURE;
        default:
          return null;
      }
    },
    callAccount: async (ghostId, method, params, timing) => {
      if (!current() || pausedReason()) return null;
      const response = await node.handleRequest(ghostId, {
        type: 'node-request', method, params, ...timing,
      });
      return response.ok && current() ? response.result : null;
    },
    accountRoot: (ghostId, harnessId) => (current() ? pluginEngineAccountRoot(ghostId, harnessId) : null),
    log,
  });
  function startResident(ghost: InstalledGhost) {
    // Mirror Desktop's spawnIfResident (cindy-brain/index.ts): lift the harness spawn gate
    // set by node.stopAndWait() whenever an enabled, available plugin (resident or on-demand)
    // is safely back in place after re-enable, update, or desktop-hold recovery.
    const storagePart = installedGhostStoragePart(ghost);
    if (!pausedReason() && isCurrent(ghost) && identityLookup.isGhostAvailableForActiveSession(storagePart)) {
      node.resumeHarnesses(storagePart);
    }
    spawnResidentGhost(ghost, {
      isAvailable: () => !pausedReason() && isCurrent(ghost),
      startNode: item => track(node.startResident(item)),
      spawnBrowser: item => track(runtime.spawn(item)),
      warn: (message, fields) => log.warn(message, fields),
    });
  }
  async function reconcileInstalled() {
    assertCurrent();
    if (desktopPause) return;
    const ghosts = await options.manager.listAsync(); assertCurrent();
    if (desktopPause) return;
    const approvals = summarizeLegacyPluginApprovals(ghosts);
    if (legacyApprovals === null) log.info('legacy plugin approval census: %j', approvals);
    legacyApprovals = approvals;
    const effectiveGhosts = ghosts.map(ghost => getGhost(installedGhostStoragePart(ghost)) ?? { ...ghost, enabled: false });
    browserExtensions.reconcile(effectiveGhosts);
    reconcilePluginHarnesses(effectiveGhosts);
    for (const [id, previous] of known) {
      if (desktopPause) return;
      if (previous === revision(getGhost(id))) continue;
      authorization.changes.emit(id, { source: 'manifest' });
      taskPlugins.dropGhost(id); runtime.stop(id); await node.stopAndWait(id); await library.disposeGhost(id); known.delete(id);
      assertCurrent();
    }
    await sandbox.revokeStale();
    assertCurrent();
    for (const ghost of ghosts) {
      const id = installedGhostStoragePart(ghost);
      if (desktopPause) return;
      if (!known.has(id)) await authorization.reconcile(ghost);
      assertCurrent(); known.set(id, revision(ghost));
      if (!restoring) startResident(ghost);
    }
  }
  function reconcile() {
    const next = reconciliation.then(reconcileInstalled);
    reconciliation = next.catch(() => {});
    return next;
  }
  async function cleanPausedPlugins(jobs: CleanupJob[]): Promise<CleanupJob[]> {
    const results = await Promise.all(jobs.map(async job => {
      try {
        await job.run();
        return null;
      } catch (error) {
        log.warn('paused plugin cleanup failed', {
          id: job.id, kind: job.kind, error: error instanceof Error ? error.message : String(error),
        });
        return job;
      }
    }));
    return results.filter(job => job !== null);
  }
  function pauseForDesktop(reason: ProfileHold): void {
    if (closed) return;
    if (desktopPause) {
      desktopPause.reason = reason;
      return;
    }
    const ids = new Set([...known.keys(), ...Object.keys(runtime.listStates())]);
    const pause = { reason, signal: delivery.signal, cleanup: Promise.resolve<CleanupJob[]>([]), resuming: false };
    desktopPause = pause;
    // Mark this generation before any synchronous stop callback can report
    // delivery failure. Aborting removes the gateway's pending verdicts.
    delivery.abort();
    for (const id of ids) runtime.stop(id);
    // The Node stop starts synchronously. Library teardown aborts open staging
    // uploads and leaves committed receipts queryable by stagingId.
    pause.cleanup = cleanPausedPlugins([
      ...[...ids].map(id => ({ id, kind: 'node' as const, run: () => node.stopAndWait(id) })),
      ...[...ids].map(id => ({ id, kind: 'library' as const, run: () => library.disposeGhost(id) })),
    ]);
    download.abortAll();
    track(pause.cleanup);
  }
  async function resumeAfterDesktop(): Promise<boolean> {
    const pause = desktopPause;
    const canResume = () => current() && !options.isProfileHeld?.();
    if (!pause || pause.resuming || !canResume()) return false;
    pause.resuming = true;
    try {
      const failed = await pause.cleanup;
      if (!canResume()) return false;
      if (failed.length) {
        // Retry only what failed. A Node stop timeout isn't proof of exit.
        pause.cleanup = track(cleanPausedPlugins(failed));
        if ((await pause.cleanup).length) {
          if (canResume()) pause.reason = releaseFailure();
          return false;
        }
        if (!canResume()) return false;
      }
      delivery = newDeliveryController();
      const resumedSignal = delivery.signal;
      restoring = pause;
      desktopPause = null;
      try {
        if (options.manager.hasPendingMutationRecovery()) {
          await uninstallRecovery.run(pause, () => options.manager.retryInterruptedMutationsAfterDbReady());
          assertCurrent();
          if (options.manager.hasPendingMutationRecovery()) {
            log.warn('some plugin mutations remain isolated after recovery');
          }
        }
        // Preserve the browser partition and the gateway fuses. The usual
        // resident policy starts residents; on-demand plugins wait for a call.
        await reconcile();
        const ghosts = await options.manager.listAsync();
        if (resumedSignal.aborted) return false;
        if (!canResume()) {
          pauseForDesktop(pause.reason);
          return false;
        }
        // Residents can use their approved services as soon as their entry runs.
        // Finish recovery before starting them, just as on an ordinary startup.
        restoring = null;
        for (const ghost of ghosts) {
          if (known.get(installedGhostStoragePart(ghost)) === revision(ghost)) startResident(ghost);
        }
        publish('ghosts:changed', { ghosts });
        publish('ghosts:runtime-changed', { states: runtime.listStates() });
        return true;
      } catch (error) {
        if (current() && !resumedSignal.aborted) pauseForDesktop(releaseFailure());
        throw error;
      }
    } finally {
      if (restoring === pause) restoring = null;
      pause.resuming = false;
    }
  }
  async function setEnabled(id: string, enabled: boolean, approval?: string) {
    assertPluginAvailable();
    const next = enableChanges.then(() => setPluginEnabled({
      find: findGhost, requireAvailable: assertPluginAvailable,
      notFound: message => { throw new Error(message); },
      acquire: () => { assertPluginAvailable(); return mutation.acquire(); },
      stop: async key => {
        // Requests from old pages lose authority immediately, even if writing the
        // disabled receipt fails. Re-enabling is an explicit new transaction.
        suspended.add(key);
        taskPlugins.dropGhost(key);
        network.disposeGhost(key);
        const effectiveGhosts = options.manager.list().map(ghost => getGhost(installedGhostStoragePart(ghost)) ?? { ...ghost, enabled: false });
        browserExtensions.reconcile(effectiveGhosts);
        reconcilePluginHarnesses(effectiveGhosts);
        runtime.stop(key);
        await node.stopAndWait(key);
        await library.disposeGhost(key);
        await sandbox.revokeStale();
      },
      persist: async (relId, next, token, check) => {
        const result = await options.manager.setEnabled(relId, next, token, check);
        if ('rejection' in result) throw new Error(`PLUGIN_ENABLE_REJECTED: ${result.rejection.code}`);
      },
      start: key => { suspended.delete(key); runtime.resetFuse(key); },
      didChange: async () => { await reconcile(); },
    }, id, enabled, approval, assertPluginAvailable));
    enableChanges = next.catch(() => {});
    return next;
  }
  async function dispose() {
    closed = true; stopSignal.abort(); runtime.destroyAll();
    reconcilePluginHarnesses([]);
    fsSlot.disposeAll();
    const errors: unknown[] = [];
    const finish = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { errors.push(error); } };
    await finish(() => network.disposeAll());
    await finish(() => browserExtensions.dispose());
    await finish(() => authorization.close());
    await finish(() => enableChanges);
    await finish(() => reconciliation);
    await finish(() => download.stopAndWait());
    await finish(() => sandbox.close());
    await Promise.all([...known.keys()].map(id => finish(() => node.stopAndWait(id))));
    node.destroyAll();
    while (pending.size) await Promise.allSettled([...pending]);
    await finish(() => cards.flushWrites());
    await finish(() => mutation.waitForIdle());
    await finish(() => library.disposeAll());
    await finish(() => assets.close());
    if (errors.length) throw new AggregateError(errors, 'Plugin runtime cleanup failed');
  }
  return {
    list: () => options.manager.listAsync(), reconcile, cards, library, fsSlot, storage, network, secret, node, authorization,
    browserExtensions, taskPlugins,
    legacyPluginApprovals: () => current() ? legacyApprovals : null,
    manager: options.manager, getGhost, current, assertCurrent, assertPluginAvailable, pluginPauseFailure, dispatcher, handoff, files,
    /** Built-in and approved plugin Skills, as Desktop's listCindyManagedSkills. */
    listManagedSkills: () => managedSkills.listCindyManagedSkills(),
    identity,
    async cleanupUninstalledSource(part: string) {
      const pause = uninstallRecovery.getStore();
      const check = () => {
        if (!pause) return assertPluginAvailable();
        assertCurrent();
        if (desktopPause) throw holdError(desktopPause.reason);
        if (pause !== restoring || options.isProfileHeld?.()) throw new Error('Plugin recovery was superseded');
      };
      check();
      const release = mutation.acquire();
      try {
        await authorization.cleanupSourceReferences(part, check);
        removeGhostKvBestEffort(harnesses, part, log);
        await forgetPluginEngineAccountsOfPlugin(part).catch(error =>
          log.warn('plugin engine account cleanup failed', { part, error: error instanceof Error ? error.message : String(error) }));
        check();
      } finally { release(); }
    },
    captureMutationOwner() { assertPluginAvailable(); return getActiveAppSession(); },
    acquireMutationLease(expected: ActiveAppSession) {
      assertPluginAvailable();
      const active = getActiveAppSession();
      if (active.mode !== expected.mode || active.dataOwnerId !== expected.dataOwnerId || active.generation !== expected.generation)
        throw new Error('PLUGIN_OWNER_CHANGED');
      return mutation.acquire();
    },
    runtimeStates: () => ({ states: runtime.listStates() }),
    callTool(request: Parameters<GhostPipeDispatcher['callGhostTool']>[0]) {
      assertCurrent();
      return track(dispatcher.callGhostTool(request));
    },
    async openPage(id: string, file: string) {
      assertPluginAvailable();
      const ghost = getGhost(id);
      if (!ghost?.enabled) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
      return sandbox.openPage(ghost, file);
    },
    pauseForDesktop, resumeAfterDesktop,
    setEnabled,
    close() { return closing ??= dispose(); },
  };
}
