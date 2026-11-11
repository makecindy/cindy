/**
 * 供应商组的运行期单例：组内电脑目录与分配器。设置页(IPC)与任务生命周期(register)共用同一份，
 * 这样设置页看到的「正在运行 / 冷却中」与实际分配一致。
 *
 * 目录缓存、冷却、轮询位置都属于当前账号：换账号后另起一份，旧账号还在路上的远端读取只落进旧的那份，
 * 新账号看不到旧账号的电脑与冷却。冷却按账号落盘(coolingStore.ts)，新起的那份先读回来。
 * 调用方拿到的是固定的门面，每次调用按当前账号转发。
 */

import { createLocalAgentLoadRegistry } from '../local-agent/load.js';
import { REMOTE_AGENT_CHANNEL, parseRemoteAgentCaps } from '@cindy/device-link';
import { app } from 'electron';
import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage.js';

import { activeOwnerScopeKey } from '../appSessionState.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import {
  readProviderGroupSummary,
  type ProviderGroupRebalanceSuggestion,
  type ProviderGroupSessionGroup,
} from '../../shared/providerGroup.js';
import { captureProviderShareGroupRecovery, getReceivedShares } from '../device-link/providerShareGuest.js';
import { handleListDevices, defaultDeps as deviceDirectoryDeps } from '../device-link/ipc.js';
import { remoteBackgroundInvoke, getDeviceLinkStatus, getRemoteLinkCloseEpoch, getSelfDeviceId, hasOfflineDirectPath } from '../device-link/index.js';
import { captureProviderMetadataContinuityScope, isTemporaryProviderMetadataFailure } from '../device-link/providerMetadataContinuity.js';
import { isMobilePlatform } from '../device-link/controllerPlatform.js';
import { deviceName } from '../device-link/deviceName.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { readDeviceProviderCatalog, readDeviceProviderViews } from '../remote-agent/controller/deviceCatalog.js';
import { listProviderGroupBindings } from './bindings.desktop.js';
import { readProviderGroupCooling, writeProviderGroupCooling } from './coolingStore.js';
import { createProviderGroupDirectory, type ProviderGroupCatalogRead, type ProviderGroupDirectory } from './directory.js';
import { createProviderGroupExternalLoad, type ProviderGroupExternalLoad } from './externalLoad.js';
import { createProviderGroupRemoteClient, type ProviderGroupRemoteClient } from './remoteClient.js';
import { captureProviderManagementScope } from './managementScope.js';
import { createProviderGroupRouter, type ProviderGroupRouter } from './router.js';
import type { ProviderGroupRemoteGroups } from './service.js';
import { readProviderGroup } from './store.js';
import { readSubscriptionPoolUsage } from '../subscription-accounts/runtime.js';
import { isSubscriptionProvider } from '../../shared/subscriptionAccounts.js';
import { createGroupContinuityClient } from './continuityClient.js';
import { createProviderGroupUsageReader, providerGroupUsageSnapshot, providerGroupCodexUsageSnapshot, providerGroupCodexUsageFromReads, type ProviderGroupCodexUsageSnapshot } from './usage.js';

interface OwnerRuntime {
  owner: string;
  directory: ProviderGroupDirectory;
  router: ProviderGroupRouter;
  externalLoad: ProviderGroupExternalLoad;
  applicationLoad: ReturnType<typeof createLocalAgentLoadRegistry>;
}

let current: OwnerRuntime | null = null;
let applicationLoadListener: ((sessionId: string) => void) | null = null;
let isTurnRunning: (sessionId: string) => boolean = () => false;
let localLoad: (() => Promise<ReadonlyMap<string, number>>) | null = null;
let sessionGroupReader: ((sessionId: string) => Promise<ProviderGroupSessionGroup>) | null = null;
let claudeUsageReader: ((providerId: string) => Promise<ClaudeSubscriptionUsageSnapshot | null>) | null = null;
let codexUsageReader: ((providerId: string) => Promise<unknown>) | null = null;
let codexRateLimitsReader: ((providerId: string) => Promise<unknown>) | null = null;

function runtimeForActiveOwner(): OwnerRuntime {
  const owner = activeOwnerScopeKey();
  if (current?.owner === owner) return current;
  type PoolQuota = Awaited<ReturnType<typeof readSubscriptionPoolUsage>>;
  const poolQuotaReads = new Map<string, { at: number; result: Promise<PoolQuota> }>();
  const readPoolQuota = async (providerId: string, deviceId?: string) => {
    if (!isSubscriptionProvider(providerId)) return undefined;
    if (!deviceId) return readSubscriptionPoolUsage(providerId);
    const key = `${deviceId}:${providerId}`;
    const cached = poolQuotaReads.get(key);
    if (cached && Date.now() - cached.at < 30_000) return cached.result;
    const resultPromise = (async (): Promise<PoolQuota> => {
    const result = await remoteBackgroundInvoke(deviceId, 'maker:subscription-pool:quota', [providerId], {
      preSend: () => { if (activeOwnerScopeKey() !== owner) throw new Error('provider group account changed'); },
    }).catch(() => null);
    const raw = result?.ok ? result.result as { providerId?: string; pooled?: boolean; usage?: Record<string, unknown> | null } : null;
    if (raw?.providerId !== providerId || raw.pooled !== true) return undefined;
    return raw.usage ? {
      claudeUsage: providerGroupUsageSnapshot(raw.usage.claudeUsage, Date.now()),
      codexUsage: providerGroupCodexUsageSnapshot(raw.usage.codexUsage),
    } : null;
    })();
    poolQuotaReads.set(key, { at: Date.now(), result: resultPromise });
    return resultPromise;
  };
  const usage = createProviderGroupUsageReader({
    parseSnapshot: providerGroupUsageSnapshot,
    readLocal: async (providerId) => {
      const pooled = await readPoolQuota(providerId);
      return pooled !== undefined ? pooled?.claudeUsage ?? null : claudeUsageReader?.(providerId) ?? null;
    },
    readRemote: async (deviceId, providerId) => {
      const pooled = await readPoolQuota(providerId, deviceId);
      if (pooled !== undefined) return pooled?.claudeUsage ?? null;
      const result = await remoteBackgroundInvoke(deviceId, 'maker:usage:claude-subscription', [providerId], {
        preSend: () => {
          if (activeOwnerScopeKey() !== owner) throw new Error('provider group account changed');
        },
      });
      if (!result.ok) return null;
      const raw = result.result;
      if (!raw || typeof raw !== 'object') return null;
      const echoedProvider = (raw as { providerId?: unknown }).providerId;
      // Old peers may ignore account selection: never mistake their default account for a named one.
      if (echoedProvider !== undefined ? echoedProvider !== providerId : providerId !== 'anthropic') return null;
      return raw;
    },
    isCurrent: () => activeOwnerScopeKey() === owner,
    now: () => Date.now(),
  });
  const readRemoteCodexUsage = async (deviceId: string, providerId: string, channel: string, args: unknown[]) => {
    const pooled = await readPoolQuota(providerId, deviceId);
    if (pooled !== undefined) return channel === 'maker:usage:account' ? pooled?.codexUsage ?? null : null;
    const result = await remoteBackgroundInvoke(deviceId, channel, args, {
      preSend: () => {
        if (activeOwnerScopeKey() !== owner) throw new Error('provider group account changed');
      },
    });
    if (!result.ok) return null;
    const raw = result.result;
    if (!raw || typeof raw !== 'object') return null;
    const echoedProvider = (raw as { providerId?: unknown }).providerId;
    if (echoedProvider !== undefined ? echoedProvider !== providerId : providerId !== 'openai') return null;
    return raw;
  };
  // Bound/cache each source separately so a slow native RPC cannot discard ready WHAM data (or vice versa).
  const codexUsage = createProviderGroupUsageReader({
    parseSnapshot: providerGroupCodexUsageSnapshot,
    cacheLocal: true,
    readLocal: async (providerId) => {
      const pooled = await readPoolQuota(providerId);
      return pooled !== undefined ? pooled?.codexUsage ?? null : codexUsageReader?.(providerId) ?? null;
    },
    readRemote: (deviceId, providerId) => readRemoteCodexUsage(deviceId, providerId, 'maker:usage:account', ['codex', providerId]),
    isCurrent: () => activeOwnerScopeKey() === owner,
    now: () => Date.now(),
  });
  const codexLimits = createProviderGroupUsageReader({
    parseSnapshot: providerGroupCodexUsageSnapshot,
    cacheLocal: true,
    readLocal: async (providerId) => {
      const pooled = await readPoolQuota(providerId);
      return pooled !== undefined ? pooled?.codexUsage ?? null : providerGroupCodexUsageFromReads(null, await codexRateLimitsReader?.(providerId), Date.now());
    },
    readRemote: async (deviceId, providerId) => providerGroupCodexUsageFromReads(null,
      await readRemoteCodexUsage(deviceId, providerId, 'maker:usage:codex-rate-limits', [providerId]), Date.now()),
    isCurrent: () => activeOwnerScopeKey() === owner,
    now: () => Date.now(),
  });
  const mergeCodexUsage = (account: ProviderGroupCodexUsageSnapshot | null, limits: ProviderGroupCodexUsageSnapshot | null) => {
    if (activeOwnerScopeKey() !== owner) return null;
    return providerGroupCodexUsageSnapshot({
      appServerBuckets: limits?.appServerBuckets ?? account?.appServerBuckets,
      webSnapshot: account?.webSnapshot,
      nativeAccountPool: account?.nativeAccountPool || limits?.nativeAccountPool,
    });
  };
  const directory = createProviderGroupDirectory({
    listLocalProviders: () => getDesktopProviderService().listProviders({ allowSideEffects: false }),
    localDeviceName: () => deviceName(),
    localAppVersion: () => app.getVersion(),
    listDevices: async () => (await handleListDevices(deviceDirectoryDeps())).devices,
    readDeviceProviders: (agentDeviceId, options) => readDeviceProviderViews(remoteBackgroundInvoke, agentDeviceId, { groupMember: true, live: options?.live }),
    readDeviceProviderCatalog: (agentDeviceId, options) => readDeviceProviderCatalog(remoteBackgroundInvoke, agentDeviceId, { groupMember: true, live: options?.live }),
    listReceivedShares: () => getReceivedShares(),
    isMobilePlatform: (platform) => isMobilePlatform(platform),
    localRunning: async (providerId) => (await readProviderRunningTurnsByProvider())?.get(providerId) ?? null,
    readClaudeUsage: (member) => usage.read(member),
    readCodexUsage: async (member) => {
      const [account, limits] = await Promise.all([codexUsage.read(member), codexLimits.read(member)]);
      return mergeCodexUsage(account, limits);
    },
    peekCodexUsage: (member) => mergeCodexUsage(codexUsage.peek(member), codexLimits.peek(member)),
    invalidateUsage: () => { usage.invalidate(); codexUsage.invalidate(); codexLimits.invalidate(); },
    now: () => Date.now(),
    mono: () => performance.now(),
  });
  const externalLoad = createProviderGroupExternalLoad({ now: () => Date.now() });
  const applicationLoad = createLocalAgentLoadRegistry();
  const router = createProviderGroupRouter({
    directory,
    readCaps: async (member) => {
      if (activeOwnerScopeKey() !== owner) throw new Error('The account changed');
      const reply = await remoteBackgroundInvoke(member.agentDeviceId!, REMOTE_AGENT_CHANNEL, [{ op: 'caps' }]);
      if (activeOwnerScopeKey() !== owner) throw new Error('The account changed');
      if (!reply.ok) throw new Error('Could not read computer capabilities');
      return parseRemoteAgentCaps(reply.result);
    },
    readGroup: readProviderGroup,
    listBindings: () => ({ ...listProviderGroupBindings(), ...Object.fromEntries(
      Object.entries(applicationLoad.bindings()).filter(([, binding]) => !binding.groupDeviceId),
    ) }),
    isTurnRunning: (sessionId) => applicationLoad.isTurnRunning(sessionId) || isTurnRunning(sessionId),
    externalRunning: (providerId, memberKey) => externalLoad.running(providerId, memberKey),
    coolingStore: {
      read: readProviderGroupCooling,
      // 换账号后旧账号那份还在路上的写入不落进新账号的文件。
      write: (value) => {
        if (activeOwnerScopeKey() === owner) writeProviderGroupCooling(value);
      },
    },
    now: () => Date.now(),
    random: () => Math.random(),
  });
  applicationLoad.subscribe((id) => {
    if (activeOwnerScopeKey() === owner) applicationLoadListener?.(id);
  });
  current = { owner, directory, router, externalLoad, applicationLoad };
  return current;
}

const directoryFacade: ProviderGroupDirectory = {
  resolveMembers: (providerId, config, options) => runtimeForActiveOwner().directory.resolveMembers(providerId, config, options),
  listCandidates: (providerId, config) => runtimeForActiveOwner().directory.listCandidates(providerId, config),
  readDeviceCatalog: (agentDeviceId) => runtimeForActiveOwner().directory.readDeviceCatalog(agentDeviceId),
  readDeviceCatalogState: (agentDeviceId) => runtimeForActiveOwner().directory.readDeviceCatalogState!(agentDeviceId),
  probe: (agentDeviceId, providerId) => runtimeForActiveOwner().directory.probe(agentDeviceId, providerId),
  memberLabel: (member) => runtimeForActiveOwner().directory.memberLabel(member),
  offlineForMs: async (agentDeviceId) => (await runtimeForActiveOwner().directory.offlineForMs?.(agentDeviceId)) ?? null,
  invalidate: (agentDeviceId) => runtimeForActiveOwner().directory.invalidate(agentDeviceId),
};


const routerFacade: ProviderGroupRouter = {
  pick: (input) => runtimeForActiveOwner().router.pick(input),
  rebalanceCandidates: (input, resolved) => runtimeForActiveOwner().router.rebalanceCandidates(input, resolved),
  view: async (providerId, options) => {
    const runtime = runtimeForActiveOwner();
    const view = await runtime.router.view(providerId, options);
    return activeOwnerScopeKey() === runtime.owner ? view : { providerId, config: null, members: [] };
  },
  running: (providerId, memberKey) => runtimeForActiveOwner().router.running(providerId, memberKey),
  markCooling: (providerId, memberKey, until, model) => runtimeForActiveOwner().router.markCooling(providerId, memberKey, until, model),
  coolingUntil: (providerId, memberKey, model) => runtimeForActiveOwner().router.coolingUntil(providerId, memberKey, model),
  markTried: (sessionId, memberKey) => runtimeForActiveOwner().router.markTried(sessionId, memberKey),
  triedThisTurn: (sessionId) => runtimeForActiveOwner().router.triedThisTurn(sessionId),
  resetTurn: (sessionId) => runtimeForActiveOwner().router.resetTurn(sessionId),
};

export function getProviderGroupDirectory(): ProviderGroupDirectory {
  return directoryFacade;
}

/** Capture this registry per owner; old application callbacks must never enter a new account's snapshot. */
export function getProviderGroupApplicationLoad() {
  return runtimeForActiveOwner().applicationLoad;
}

/** IPC registers once; forward only the active owner's subsequent application changes. */
export function setProviderGroupApplicationLoadListener(listener: (sessionId: string) => void): void {
  applicationLoadListener = listener;
}

export function getProviderGroupRouter(): ProviderGroupRouter {
  return routerFacade;
}

/**
 * 一次分配用的当前账号运行期(不经按调用时账号转发的门面)：选电脑要等目录，等待期间换了账号时，记占用仍
 * 落在这次分配所属账号的那份里，不会记进新账号；`isCurrent()` 为 false 时调用方丢弃这次结果。
 */
export interface ProviderGroupOwnerScope {
  router: ProviderGroupRouter;
  externalLoad: ProviderGroupExternalLoad;
  isCurrent(): boolean;
}

export function getProviderGroupOwnerScope(): ProviderGroupOwnerScope {
  const runtime = runtimeForActiveOwner();
  return {
    router: runtime.router,
    externalLoad: runtime.externalLoad,
    isCurrent: () => activeOwnerScopeKey() === runtime.owner,
  };
}

let remoteClient: ProviderGroupRemoteClient | null = null;
let continuityClient: ReturnType<typeof createGroupContinuityClient> | null = null;
let localContinuityHandler: ((controller: string, raw: unknown) => Promise<unknown>) | null = null;
export function setProviderGroupContinuityHandler(handler: typeof localContinuityHandler): void { localContinuityHandler = handler; }
export function hasProviderGroupContinuityHandler(): boolean { return localContinuityHandler !== null; }

/** 问其他电脑上的组(无状态，按调用时的账号经设备互联发出)。 */
export function getProviderGroupRemoteClient(): ProviderGroupRemoteClient {
  remoteClient ??= createProviderGroupRemoteClient(remoteBackgroundInvoke, {
    captureShareRecovery: captureProviderShareGroupRecovery,
  });
  return remoteClient;
}

/**
 * 任务生命周期用的「另一台电脑上的组」：组设置读那台目录里的组摘要(与组内电脑状态共用同一份短时缓存)，
 * 选电脑、冷却与状态经 `provider-group:remote` 问那台。
 */
export function getProviderGroupRemoteGroups(): ProviderGroupRemoteGroups {
  const client = getProviderGroupRemoteClient();
  // Re-read the local generation on every use. Binding it once at factory creation
  // would make a later account/endpoint generation inherit the old routing scope.
  const continuityScopeKey = () => `${activeOwnerScopeKey()}|${getClientEndpoint('deviceLinkApiBaseUrl')}`;
  continuityClient ??= createGroupContinuityClient({
    livePick: client.pick,
    invoke: async (deviceId, channel, args, options) => {
      options?.preSend?.();
      if (deviceId === getSelfDeviceId()) {
        if (!localContinuityHandler) throw new Error('[REMOTE_AGENT_UNAVAILABLE] Group continuity is not ready');
        return { ok: true, result: await localContinuityHandler(deviceId, args[0]) };
      }
      return remoteBackgroundInvoke(deviceId, channel, args, options);
    },
    capture(ownerDeviceId, executor) {
      const ownerScope = captureProviderMetadataContinuityScope(ownerDeviceId);
      const executorScope = executor ? captureProviderMetadataContinuityScope(executor) : () => true;
      const ownerEpoch = getRemoteLinkCloseEpoch(ownerDeviceId), executorEpoch = executor ? getRemoteLinkCloseEpoch(executor) : 0;
      return () => ownerScope() && executorScope() && ownerEpoch === getRemoteLinkCloseEpoch(ownerDeviceId)
        && (!executor || executorEpoch === getRemoteLinkCloseEpoch(executor));
    },
    onlineCapture(ownerDeviceId) {
      let ownerScope: (() => void) | null = null;
      try { ownerScope = captureProviderManagementScope(); } catch { return () => false; }
      const closeEpoch = getRemoteLinkCloseEpoch(ownerDeviceId);
      return () => {
        try { ownerScope!(); } catch { return false; }
        return closeEpoch === getRemoteLinkCloseEpoch(ownerDeviceId);
      };
    },
    ownerMayRespond: owner => getDeviceLinkStatus() === 'online' || hasOfflineDirectPath(owner),
    retryable: error => isTemporaryProviderMetadataFailure(error)
      // dispatch reports an owner whose group handler has not registered yet as
      // [UNAVAILABLE]; that is the same temporary "not ready" condition as the
      // remote-agent channel and must not retire contexts already acknowledged
      // by this owner and the executor.
      || (error instanceof Error && /^\[(?:REMOTE_AGENT_UNAVAILABLE|UNAVAILABLE)\]/.test(error.message)
        && !/Fast policy/.test(error.message)),
    wall: Date.now, mono: () => performance.now(),
    scopeKey: continuityScopeKey,
  });
  return {
    async readGroup(ownerDeviceId, providerId, options) {
      const scope = continuityClient?.scope();
      const epoch = continuityClient?.scopeEpoch(ownerDeviceId, providerId);
      // A different account/endpoint generation means the reply may belong to the
      // previous account, so it is never used.
      const scopeChanged = () => !!continuityClient && continuityClient.scope() !== scope;
      // Only the destructive paths below (retiring acknowledged rows) need this
      // fence: a routing generation which a concurrent pick created or moved
      // during the read means those rows may be newer than this reply.
      const routesReplaced = () => !!continuityClient
        && continuityClient.scopeEpoch(ownerDeviceId, providerId) !== epoch;
      const targetScope = captureProviderMetadataContinuityScope(ownerDeviceId);
      // A full target registry deliberately makes an unregistered target fail the
      // offline capture, while invokeProviderMetadataContinuity still permits a
      // fenced live-only read. Do not discard that live result just because the
      // capture was already false before the read. Once it was true, a later false
      // still retires the old snapshot.
      const targetScopeAtStart = targetScope();
      // An explicit denial observed during the read retires its reply.
      const erased = () => targetScopeAtStart && !targetScope();
      let catalog: ProviderGroupCatalogRead;
      try {
        catalog = directoryFacade.readDeviceCatalogState
          ? await directoryFacade.readDeviceCatalogState(ownerDeviceId)
          : { views: await directoryFacade.readDeviceCatalog(ownerDeviceId), freshRead: true, stale: false };
      } catch {
        // A late directory result from an old local generation must not clear
        // a newer generation's acknowledged rows for the same remote owner.
        if (erased() || scopeChanged() || routesReplaced()) return undefined;
        // Only a new task's first assignment may use the config carried by an
        // earlier pick. Existing-task failover must wait for the owner.
        return options?.allowSnapshot
          ? continuityClient?.readConfig(ownerDeviceId, providerId) ?? undefined
          : undefined;
      }
      if (erased() || scopeChanged()) return undefined;
      const view = catalog.views.find((candidate) => candidate.id === providerId);
      if (!view) {
        // A cached or stale reply is not the owner's confirmation that the group is gone.
        // Only a read started by this call with a current (non-stale) directory may
        // retire acknowledged routes; otherwise keep them for the service snapshot path.
        if (!catalog.freshRead || catalog.stale || routesReplaced()) return undefined;
        continuityClient?.forgetGroup(ownerDeviceId, providerId);
        return null;
      }
      const config = readProviderGroupSummary((view as { group?: unknown }).group, providerId);
      // A stale reply is a snapshot, not current membership: it may predate a
      // member picked later, so it cannot authorize or release a binding.
      if (config) {
        // Only a new task's first assignment may use this live reply when a
        // concurrent pick created or replaced the routing generation during the
        // read: it writes a fresh binding from the owner's current config. An
        // existing binding's reconciliation stays conservative instead, because
        // a reply older than those routes must not retire them.
        if (routesReplaced() && options?.allowSnapshot !== true) return undefined;
        return catalog.stale ? undefined : config;
      }
      if (!catalog.freshRead || catalog.stale || routesReplaced()) return undefined;
      continuityClient?.forgetGroup(ownerDeviceId, providerId);
      return null;
    },
    // Keep the acknowledged-config read local, but preserve the service's async contract.
    readSnapshotGroup: async (ownerDeviceId, providerId) => continuityClient!.readConfig(ownerDeviceId, providerId),
    pick: (ownerDeviceId, input) => continuityClient!.pick(ownerDeviceId, input),
    cool: (ownerDeviceId, input) => client.cool(ownerDeviceId, input),
    view: (ownerDeviceId, providerId, model, agentKind) => client.view(ownerDeviceId, providerId, agentKind ? { model, agentKind } : model),
    invalidate: (ownerDeviceId) => directoryFacade.invalidate(ownerDeviceId),
  };
}

/** register 装配会话表后注入：分配器据此统计「正在运行」。 */
export function setProviderGroupTurnProbe(probe: (sessionId: string) => boolean): void {
  isTurnRunning = probe;
}

/** register 装配供应商组服务后注入：任务此刻归哪个组(模型列表用)。 */
export function setProviderGroupSessionGroupReader(reader: ((sessionId: string) => Promise<ProviderGroupSessionGroup>) | null): void {
  sessionGroupReader = reader;
}

/** 任务此刻归哪个组；还没装配或读不到时按没归组处理。 */
export async function readProviderGroupOfSession(sessionId: string): Promise<ProviderGroupSessionGroup> {
  if (!sessionGroupReader) return null;
  try {
    return await sessionGroupReader(sessionId);
  } catch {
    return null;
  }
}

/** register 装配供应商组服务后注入：任务进行中换号的提议与用户的决定(provider-groups.md §6.2「任务进行中换号」)。 */
export interface ProviderGroupSessionRebalance {
  suggest(sessionId: string): Promise<ProviderGroupRebalanceSuggestion>;
  decide(sessionId: string, memberKey: string, remember: boolean, clientId?: string): Promise<boolean>;
  preference(sessionId: string, enabled: boolean): Promise<boolean>;
}

let sessionRebalance: ProviderGroupSessionRebalance | null = null;

export function setProviderGroupSessionRebalance(value: ProviderGroupSessionRebalance | null): void {
  sessionRebalance = value;
}

/** 要不要提议换号；还没装配或读不到时不提议(照常发送)。 */
export async function readProviderGroupRebalanceSuggestion(sessionId: string): Promise<ProviderGroupRebalanceSuggestion> {
  if (!sessionRebalance) return null;
  try {
    return await sessionRebalance.suggest(sessionId);
  } catch {
    return null;
  }
}

/** 记下用户确认换号；没记上返回 false，这条消息照常发到原来的号。 */
export async function recordProviderGroupRebalanceDecision(sessionId: string, memberKey: string, remember: boolean, clientId?: string): Promise<boolean> {
  if (!sessionRebalance) return false;
  try {
    return await sessionRebalance.decide(sessionId, memberKey, remember, clientId);
  } catch {
    return false;
  }
}

/** 任务偏好由所属电脑保存；失败不伪报成功。 */
export async function setProviderGroupRebalancePreference(sessionId: string, enabled: boolean): Promise<boolean> {
  if (!sessionRebalance) return false;
  return sessionRebalance.preference(sessionId, enabled);
}

/** register 装配会话表后注入：这台电脑上每个供应商正在运行一轮的任务数(localLoad.ts)。 */
export function setProviderGroupLocalLoad(probe: (() => Promise<ReadonlyMap<string, number>>) | null): void {
  localLoad = probe;
}

/** Reuse the CLI-backed subscription reader without importing the IPC adapter into routing. */
export function setProviderGroupClaudeUsageReader(reader: typeof claudeUsageReader): void {
  claudeUsageReader = reader;
}

export function setProviderGroupCodexUsageReader(reader: typeof codexUsageReader, rateLimits: typeof codexRateLimitsReader = null): void {
  codexUsageReader = reader;
  codexRateLimitsReader = rateLimits;
}

/** 这台电脑上每个供应商正在运行一轮的任务数；还没装配或读不到时返回 null(调用方照旧只算经组的)。 */
export async function readProviderRunningTurnsByProvider(): Promise<ReadonlyMap<string, number> | null> {
  if (!localLoad) return null;
  try {
    return await localLoad();
  } catch {
    return null;
  }
}
