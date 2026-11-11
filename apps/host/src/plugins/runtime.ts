import { createRequire } from 'node:module';
import { GhostManager } from '../../../desktop/src/main/cindy-brain/GhostManager.js';
import { GhostRuntime } from '../../../desktop/src/main/cindy-brain/runtime/GhostRuntime.js';
import { GhostPipeDispatcher } from '../../../desktop/src/main/cindy-brain/pipeDispatcher.js';
import { createGhostExecutionPipe } from '../../../desktop/src/main/cindy-brain/executionPipe.js';
import { createGhostKvStore } from '../../../desktop/src/main/cindy-brain/ghostKvStore.js';
import { createGhostPageHandler } from '../../../desktop/src/main/cindy-brain/runtime/ghostPageHandler.js';
import { handleGhostSecretsRequest } from '../../../desktop/src/main/cindy-brain/runtime/ghostSecretsEndpoint.js';
import { handleGhostModelsRequest } from '../../../desktop/src/main/cindy-brain/runtime/ghostModelsEndpoint.js';
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
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, type ActiveAppSession } from '../../../desktop/src/main/appSessionState.js';
import { ownerScopedPath } from '../../../desktop/src/main/dataOwnerPath.js';
import { createLogger } from '../../../desktop/src/main/logger.js';
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

interface PluginRuntimeOptions {
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
  /** Built/release paths only, never plugin-provided. */
  assets?: Awaited<ReturnType<typeof prepareHostPluginAssets>>;
}

/** Production installed-plugin execution. All persistent stores use the same
 * owner roots and records as Desktop; no installation or approval is fabricated.
 * UI and account-dependent slots are attached separately by their owning services. */
export async function createHostPluginRuntime(options: PluginRuntimeOptions) {
  const assets = options.assets ?? await prepareHostPluginAssets();
  const owner = activeOwnerScopeKey();
  const log = createLogger('host-plugins');
  const root = (...parts: string[]) => ownerScopedPath(options.profileDir, options.ownerId, ...parts);
  const mutation = new GhostMutationCoordinator();
  const handoff = new GhostHandoffStore({ root: () => root('ghost-handoff') });
  const stopSignal = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const known = new Map<string, string>();
  const suspended = new Set<string>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let reconciliation: Promise<void> = Promise.resolve();
  let enableChanges: Promise<unknown> = Promise.resolve();
  const current = () => !closed && !isAppSessionBoundaryPending() && activeOwnerScopeKey() === owner;
  const assertCurrent = () => { if (!current()) throw new Error('PLUGIN_OWNER_CHANGED'); };
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
    return () => { if (!ghost || !isCurrent(ghost)) throw new Error('PLUGIN_PAGE_UNAVAILABLE'); };
  };
  const track = <T>(job: Promise<T>) => {
    pending.add(job);
    void job.then(() => pending.delete(job), () => pending.delete(job));
    return job;
  };
  const secret = createHostPluginSecrets(options.profileDir, options.ownerId, options.credentials);
  const kv = createGhostKvStore({ getRootDir: () => root('ghost-kv'), log });
  const models = createGhostKvStore({ getRootDir: () => root('ghost-published-models'), log });
  const identity = createHostPluginIdentity({ manager: options.manager, root, getGhost,
    getUser: options.getUser ?? (() => null), assertCurrent });
  const unavailable = () => { throw new Error('PLUGIN_ACCOUNT_SERVICE_UNAVAILABLE'); };
  const authorization = createHostPluginAuthorization({ owner, root, current, assertCurrent,
    getGhost, list: () => options.manager.list(), secret, kv, identity,
    account: options.account ?? { hasLogin: () => false, post: unavailable, endpoint: unavailable,
      openExternal: unavailable, modelAccessReady: () => false },
    publish: options.publish, signal: stopSignal.signal });
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
    broadcast: payload => { if (current()) options.publish('ghosts:card-updated', payload); }, log,
  });
  const fsSlot = new GhostFsSlot({ getGhost, dataRootDir: () => root('ghost-fs'),
    callInfo: id => current() ? cards.callInfoOf(id) : null,
    inFlightCallInfo: id => current() ? cards.inFlightCallInfoOf(id) : null,
    getSessionSnapshot: async (id, instance) => current() ? resolveGhostFsSessionSnapshot(options.getSession, id, instance) : null,
    requestWriteConfirm: (id, payload) => { assertCurrent(); return options.requestFileConfirmation(id, payload); },
    writeSaveDeposit: (id, token, name, bytes) => getSaveDepositVault().write(id, token, name, bytes), log });
  const network = new GhostNetworkSlot({ getGhost, captureRequestGuard: guard,
    inFlightCallInfo: id => current() ? cards.inFlightCallInfoOf(id) : null,
    readSecret: secret.readGhostSecret, getLoginEmail: options.getLoginEmail,
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
  const ownerScope = { capture: () => owner, isCurrent: (value: unknown) => value === owner && current(), isStable: (value: unknown) => value === owner && current() };
  const node = createHostNodeRuntimeBroker(assets.nodeWorker!, { getGhost, ownerScope,
    readSecret: secret.readGhostSecret, secretSaved: secret.ghostSecretSaved,
    resolveOauthSecret: async (id, key, accountId) => {
      const decl = getGhost(id)?.manifest.network?.secrets?.find(item => item.key === key && item.source === 'oauth')?.oauth;
      return decl ? authorization.oauth.getFreshAccessToken(id, key, decl, accountId)
        : { ok: false, error: 'NO_ACCOUNT' };
    },
    getCallSignal: (id, callId) => dispatcher.getPendingCallSignal(id, callId),
    getCallSessionId: (id, callId) => dispatcher.getPendingCallSessionId(id, callId),
    authenticatedFetch: (id, request, authorization, check, signal) => network.handleAuthenticatedNodeFetch(id, request, authorization, check, signal),
    sendToGhost: (id, payload) => { void sandbox.deliver(id, payload); }, log,
  });
  const download = new PluginDownloadSlot({ getGhost, root: id => root('plugin-downloads', id), scope: () => owner,
    send: (id, event) => { void sandbox.deliver(id, event); }, download: createDownloader(), guardedFetch: hostOutbound.guardedOutboundFetch });
  const notify = new GhostNotifySlot({ getGhost, broadcast: payload => options.publish('ghosts:notify', payload), log });
  const pipe = createGhostExecutionPipe({ dispatcher: () => dispatcher,
    fetch: (id, payload) => network.handleFetchRequest(id, payload), files: (id, payload) => fsSlot.handleFsRequest(id, payload),
    library: (id, payload) => library.handleLibraryRequest(id, payload),
    download: (id, payload, check) => download.handle(id, payload, check),
    node: (id, payload, check) => download.withNodeDownloads(id, payload as Record<string, unknown>, request => node.handleRequest(id, request), check),
    warn: (message, details) => log.warn(message, details),
  });
  const sandbox = createHeadlessPluginSandbox({ ...assets, executablePath: assets.executablePath ?? undefined, ownerKey: () => owner,
    isCurrent: ghost => isCurrent(ghost),
    send(ghost, payload) {
      const id = installedGhostStoragePart(ghost);
      const result = pipe(id, payload, () => isCurrent(ghost));
      if (result) return track(result);
      const request = payload as { type?: string; kind?: string } | null;
      if (request?.type === 'card-update') { cards.handleCardUpdate(id, payload); return Promise.resolve({ ok: true }); }
      if (request?.type === 'host-request' && request.kind === 'app-context') return Promise.resolve(options.appContext());
      if (request?.type === 'notify') return Promise.resolve(notify.handleNotify(id, payload));
      return Promise.reject(new Error('UNSUPPORTED_CAPABILITY: this Host service is not connected'));
    },
    pageHandler: (ghost, origin, pageCurrent) => createGhostPageHandler({ ghost, origin, isCurrent: pageCurrent,
      ghostKvStore: { read: id => { guard(id)(); return kv.read(id); }, write: (id, value) => { guard(id)(); kv.write(id, value); authorization.changes.emit(id, { source: 'kv' }); },
        captureTarget: id => revision(getGhost(id)), isTargetCurrent: (id, target) => current() && target === revision(getGhost(id)) },
      ghostWakeHandler: async id => { const item = getGhost(id); if (!item) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
        const spawned = await runtime.spawn(item); return { state: spawned.ok ? spawned.state : runtime.stateOf(id) }; },
      ghostAppContextProvider: options.appContext,
      ghostModelsHandler: input => handleGhostModelsRequest({ ...input, needs: () => getGhost(input.ghostId)?.manifest.models ?? null,
        store: models, onChanged: () => options.publish('ghosts:changed', { ghosts: options.manager.list() }) }),
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
      ghostAgentModelsProvider: null, ghostMediaModelsProvider: null,
      serveGhostMedia: (id, file, range) => files.read(id, `cindy-media://blobs/${file}`, new Request(origin, { headers: range ? { range } : {} })),
      serveGhostLibraryFile: (id, file, range) => files.read(id, `library:${file}`, new Request(origin, { headers: range ? { range } : {} })),
      serveGhostGallery: async id => {
        const items = await ledger.listGhostGallery(id); guard(id)();
        return Response.json(items.map(item => ({ src: `${origin}/media/${item.hash}${item.ext}`, caption: item.label ?? '' })),
          { headers: { 'Cache-Control': 'no-cache' } });
      }, log,
    }),
  });
  const runtime = new GhostRuntime({ adapter: sandbox.adapter, log,
    onStateChanged: (id, state) => { dispatcher?.onRuntimeState(id, state); options.publish('ghosts:runtime-changed', { states: runtime.listStates() }); } });
  const dispatcher = new GhostPipeDispatcher({ getGhost, runtimeStateOf: id => runtime.stateOf(id),
    spawn: ghost => runtime.spawnForTool(ghost), sendToGhost: sandbox.deliver, ownerScope, log });
  async function reconcileInstalled() {
    assertCurrent();
    const ghosts = await options.manager.listAsync(); assertCurrent();
    for (const [id, previous] of known) {
      if (previous === revision(getGhost(id))) continue;
      authorization.changes.emit(id, { source: 'manifest' });
      runtime.stop(id); await node.stopAndWait(id); await library.disposeGhost(id); known.delete(id);
      assertCurrent();
    }
    await sandbox.revokeStale();
    assertCurrent();
    for (const ghost of ghosts) {
      const id = installedGhostStoragePart(ghost);
      if (!known.has(id)) await authorization.reconcile(ghost);
      assertCurrent(); known.set(id, revision(ghost));
      spawnResidentGhost(ghost, { isAvailable: () => isCurrent(ghost), startNode: item => track(node.startResident(item)),
        spawnBrowser: item => track(runtime.spawn(item)), warn: (message, fields) => log.warn(message, fields) });
    }
  }
  function reconcile() {
    const next = reconciliation.then(reconcileInstalled);
    reconciliation = next.catch(() => {});
    return next;
  }
  function setEnabled(id: string, enabled: boolean, approval?: string) {
    const next = enableChanges.then(() => setPluginEnabled({
      find: findGhost, requireAvailable: assertCurrent,
      notFound: message => { throw new Error(message); },
      acquire: () => { assertCurrent(); return mutation.acquire(); },
      stop: async key => {
        // Requests from old pages lose authority immediately, even if writing the
        // disabled receipt fails. Re-enabling is an explicit new transaction.
        suspended.add(key);
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
    }, id, enabled, approval, assertCurrent));
    enableChanges = next.catch(() => {});
    return next;
  }
  async function dispose() {
    closed = true; stopSignal.abort(); runtime.destroyAll();
    const errors: unknown[] = [];
    const finish = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { errors.push(error); } };
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
    list: () => options.manager.listAsync(), reconcile, cards, library, fsSlot, network, secret, node, authorization,
    manager: options.manager, getGhost, current, assertCurrent, dispatcher, handoff, files,
    captureMutationOwner() { assertCurrent(); return getActiveAppSession(); },
    acquireMutationLease(expected: ActiveAppSession) {
      assertCurrent();
      const active = getActiveAppSession();
      if (active.mode !== expected.mode || active.dataOwnerId !== expected.dataOwnerId || active.generation !== expected.generation)
        throw new Error('PLUGIN_OWNER_CHANGED');
      return mutation.acquire();
    },
    runtimeStates: () => ({ states: runtime.listStates() }),
    callTool: (request: Parameters<GhostPipeDispatcher['callGhostTool']>[0]) => { assertCurrent(); return track(dispatcher.callGhostTool(request)); },
    async openPage(id: string, file: string) { const ghost = getGhost(id); if (!ghost?.enabled) throw new Error('PLUGIN_PAGE_UNAVAILABLE'); return sandbox.openPage(ghost, file); },
    setEnabled,
    close() { return closing ??= dispose(); },
  };
}
