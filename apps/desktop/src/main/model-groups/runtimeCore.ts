/**
 * 智能路由运行时核心(纯 Node，零 Electron 依赖，Desktop 与 Node Host 共用，见 architecture-invariants §5)。
 * 统一封装：本机/远程目录刷新与合成、resolver 解析器、故障恢复与横幅提议、任务中间发前持续托管评估、
 * 伙伴/定时任务选路，以及切账号时的状态释放。
 */
import { scheduledBillingHold } from '../scheduler-host/billingHolds.js';
import type { ProviderView } from '@cindy/model-providers';
import type { ModelGroupAgentKind, ModelGroupResolveRequest, ModelGroupTraceQuota } from '../../shared/modelGroups.js';
import { pluginEngineKeyFromProviderId, type PluginEngineView } from '../../shared/pluginEngines.js';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';
import type { ModelPricingCatalog } from '../../shared/regionalMoney.js';
import { isPluginModelPickerRouteAvailable } from '../cindy-brain/ghostModelPicker.js';
import { createLogger } from '../logger.js';
import { getSessionProvider, hasSessionProvider } from '../maker-host/session-provider-store.js';
import { recordModelGroupDecision } from './decisionLog.js';
import { autoUsageSourceKey, type AutoUsageProfileSnapshot } from './autoUsageProfile.js';
import type { ModelGroupInnerQuota } from './pick.js';
import { createModelGroupResolver, MODEL_GROUP_REMOTE_WAIT_MS, type ModelGroupResolverDeps } from './resolver.js';
import { readModelGroupBindingForDispatch, readModelGroupSessionBinding } from './sessionBindings.js';
import type { SourceCatalogAccount } from './sourceRoutes.js';
import { createSshModelGroupSupport } from './sshFilter.js';
import { readModelGroupsConfigForSelected, setModelGroupSourceCatalog } from './store.js';
import {
  computeModelGroupSwitchOffer,
  type ModelGroupRecoveryRequest,
  type ModelGroupSwitchOfferSessionRow,
} from './switchOffer.js';
import {
  evaluateModelGroupBeforeSend,
  type ModelGroupTurnContext,
  type ModelGroupTurnCurrentRoute,
  type ModelGroupTurnDecision,
} from './turnRouting.js';

const pickLog = createLogger('model-groups:pick');

const REMOTE_CATALOG_TTL_MS = 60_000;
const LOCAL_CATALOG_TTL_MS = 1_000;

export interface ModelGroupRunningSession {
  id: string;
  agentDeviceId?: string | null;
  /** Fallback for a live task whose provider has not been registered in memory. */
  providerId?: string;
}

export interface ModelGroupRuntimePorts {
  scope(): string;
  localViews(): Promise<ProviderView[]>;
  localAccounts?(views: readonly ProviderView[]): ReadonlyMap<string, readonly SourceCatalogAccount[]>;
  warmLocalAccounts?(views: readonly ProviderView[]): Promise<void>;
  localAccount?: ModelGroupResolverDeps['localAccount'];
  localCandidateAvailable?: ModelGroupResolverDeps['localCandidateAvailable'];
  /** 任务在本机账号池里实际绑定的账号(订阅账号池的任务绑定)。 */
  taskAccount?(sessionId: string, providerId: string): string | undefined;
  pluginEngines?(): readonly PluginEngineView[];
  localAgents(): readonly string[];
  harnessInstalled(agent: string, agentDeviceId?: string): Promise<boolean>;
  quotaWindows(options?: { cached?: boolean; dryRun?: boolean }): Promise<ReadonlyMap<string, readonly (ModelGroupTraceQuota & { scopedTo?: string | null })[]>>;
  innerQuota?(source: { providerId: string; model: string; agentKind: ModelGroupAgentKind }): Promise<ModelGroupInnerQuota | null>;
  usageProfile?(options?: { dryRun?: boolean }): AutoUsageProfileSnapshot | null | Promise<AutoUsageProfileSnapshot | null>;
  runningSessions(): readonly ModelGroupRunningSession[];
  onCommitPick?(candidate: { providerId: string; agentDeviceId?: string | null; model: string }): void;
  onDispose?(): void;
  remoteInvocable?(providerId: string): boolean;
  locations?(): Promise<{
    status?: 'complete' | 'degraded';
    locations: readonly {
      agentDeviceId: string;
      providerIds?: readonly string[];
      favoriteSource?: { providerId?: string } | null;
    }[];
  }>;
  remoteViews?(agentDeviceId: string): Promise<{ views: ProviderView[]; stale: boolean }>;
  remotePluginEngines?(agentDeviceId: string): Promise<readonly PluginEngineView[]>;
  pricing?(): Promise<{ gateway: ModelPricingCatalog | null; reference: ModelPricingCatalog | null }>;
  listSshCodexProviders?(hostId: string): Promise<ProviderView[]>;
  readSession(sessionId: string): Promise<ModelGroupSwitchOfferSessionRow | null>;
  isShared(sessionId: string): boolean;
  hasGoal(sessionId: string): Promise<boolean>;
  now?(): number;
}

export function createModelGroupRuntime(ports: ModelGroupRuntimePorts) {
  const now = ports.now ?? Date.now;

  /** 其他电脑与分享来的位置各自允许远程调用的供应商与插件引擎，按账号缓存。 */
  let remoteCatalogs: { scope: string; at: number; provisional: boolean; value: Map<string, ProviderView[]>; pluginEngines: Map<string, PluginEngineView[]> } | null = null;
  let remoteReading: { scope: string; promise: Promise<void> } | null = null;
  let lastLocal: { scope: string; views: ProviderView[]; pluginEngines: readonly PluginEngineView[] } | null = null;
  let refreshing: Promise<void> | null = null;
  let refreshedAt = 0;

  function publishCatalog(): void {
    const scope = ports.scope();
    if (lastLocal?.scope !== scope) return;
    const { views, pluginEngines } = lastLocal;
    const localAccounts = ports.localAccounts ? ports.localAccounts(views) : undefined;
    setModelGroupSourceCatalog({
      views,
      ...(localAccounts && localAccounts.size > 0 ? { localAccounts } : {}),
      pluginEngines,
      agents: ports.localAgents(),
      ...(remoteCatalogs?.scope === scope ? {
        remote: remoteCatalogs.value,
        remotePluginEngines: remoteCatalogs.pluginEngines,
      } : {}),
      // 与解析路由时同一个判断；别的位置上的来源按那个位置的目录看，执行时那台还会再拦一次。
      available: (candidate, locationViews, agents) => (candidate.agentKind === 'acp'
        ? true
        : isPluginModelPickerRouteAvailable({ ...candidate, agentKind: candidate.agentKind, effort: '', fastMode: false }, locationViews as ProviderView[], agents)),
    });
  }

  function refreshLocalPluginEngines(): void {
    const scope = ports.scope();
    if (lastLocal?.scope === scope && ports.pluginEngines) {
      lastLocal = { ...lastLocal, pluginEngines: ports.pluginEngines() };
      publishCatalog();
    }
  }

  function refreshLocalAccounts(): void {
    const scope = ports.scope();
    if (lastLocal?.scope === scope) {
      publishCatalog();
    }
  }

  function readRemoteCatalogs(waitForStartup = false): Promise<void> {
    if (!ports.locations || (!ports.remoteViews && !ports.remotePluginEngines)) return Promise.resolve();
    const scope = ports.scope();
    if (remoteReading?.scope === scope) return remoteReading.promise;
    if (remoteCatalogs?.scope === scope) {
      const ttl = waitForStartup && remoteCatalogs.provisional ? LOCAL_CATALOG_TTL_MS : REMOTE_CATALOG_TTL_MS;
      if (now() - remoteCatalogs.at < ttl) return Promise.resolve();
    }
    const timeout = <T>(work: Promise<T>): Promise<T | null> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        work.catch(() => null),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MODEL_GROUP_REMOTE_WAIT_MS); }),
      ]).finally(() => clearTimeout(timer));
    };
    const promise: Promise<void> = (async () => {
      const { status, locations } = await ports.locations!();
      if (scope !== ports.scope()) return;
      const prev = remoteCatalogs?.scope === scope ? remoteCatalogs : null;
      const nextProviders = new Map<string, ProviderView[]>();
      const nextPlugins = new Map<string, PluginEngineView[]>();
      const present = new Set<string>();
      await Promise.all(locations.map(async ({ agentDeviceId, providerIds, favoriteSource }) => {
        present.add(agentDeviceId);
        const isShare = isProviderShareAgentDeviceId(agentDeviceId);
        const shareProviderIds = providerIds?.length
          ? providerIds
          : (favoriteSource?.providerId ? [favoriteSource.providerId] : []);
        const isPluginShare = isShare && shareProviderIds.length > 0 && shareProviderIds.every((id) => pluginEngineKeyFromProviderId(id) !== null);
        const isProviderOnlyShare = isShare && shareProviderIds.length > 0 && shareProviderIds.every((id) => pluginEngineKeyFromProviderId(id) === null);
        const [catalog, plugins] = await Promise.all([
          !isPluginShare && ports.remoteViews ? timeout(ports.remoteViews(agentDeviceId)) : Promise.resolve(null),
          !isProviderOnlyShare && ports.remotePluginEngines ? timeout(ports.remotePluginEngines(agentDeviceId)) : Promise.resolve(null),
        ]);
        if (catalog && !catalog.stale) {
          nextProviders.set(agentDeviceId, catalog.views);
        } else if (!isPluginShare && prev?.value.has(agentDeviceId)) {
          // 瞬时超时或远端缓存未刷新时保留上次已读到的目录，不让自动合并路由与展开突然消失。
          nextProviders.set(agentDeviceId, prev.value.get(agentDeviceId)!);
        }
        if (plugins !== null) {
          if (plugins.length > 0) nextPlugins.set(agentDeviceId, [...plugins]);
        } else if (!isProviderOnlyShare && prev?.pluginEngines.has(agentDeviceId)) {
          // 远端插件引擎读取无独立缓存；超时/瞬时失败保留上次已读到的条目，避免保存设置时自动路由突然蒸发。
          nextPlugins.set(agentDeviceId, prev.pluginEngines.get(agentDeviceId)!);
        }
      }));
      if (scope !== ports.scope()) return;
      // 同账号设备名单读取降级(status === 'degraded')时仅分享来自本机，保留上次已读到的其他电脑条目。
      if (status === 'degraded' && prev) {
        for (const [id, views] of prev.value) {
          if (!isProviderShareAgentDeviceId(id) && !present.has(id)) nextProviders.set(id, views);
        }
        for (const [id, engines] of prev.pluginEngines) {
          if (!isProviderShareAgentDeviceId(id) && !present.has(id)) nextPlugins.set(id, engines);
        }
      }
      // 启动期可能连续读到空名单。需要等远程目录的入口可缩短读取间隔，直到读到位置。
      const provisional = locations.length === 0 && (!prev || prev.provisional);
      remoteCatalogs = { scope, at: now(), provisional, value: nextProviders, pluginEngines: nextPlugins };
      publishCatalog();
    })().catch(() => {
      // locations() 瞬时失败时不清空已读到的远程目录；尚未读到过时保持为空以便下次重试。
    }).finally(() => { if (remoteReading?.promise === promise) remoteReading = null; });
    remoteReading = { scope, promise };
    return promise;
  }

  async function readLocalViews(): Promise<ProviderView[]> {
    const views = await ports.localViews();
    const scope = ports.scope();
    lastLocal = { scope, views, pluginEngines: ports.pluginEngines ? ports.pluginEngines() : [] };
    publishCatalog();
    if (ports.warmLocalAccounts) {
      await ports.warmLocalAccounts(views).catch(() => undefined);
      if (lastLocal?.scope === scope) publishCatalog();
    }
    void readRemoteCatalogs();
    return views;
  }

  function localProviderView(providerId: string): ProviderView | undefined {
    return lastLocal?.scope === ports.scope() ? lastLocal.views.find((item) => item.id === providerId) : undefined;
  }

  function refreshAutoModelGroupRoutes(options: { waitRemote?: boolean } = {}): Promise<void> {
    const hasRemoteReader = Boolean(ports.locations && (ports.remoteViews || ports.remotePluginEngines));
    const remoteMissing = Boolean(options.waitRemote && hasRemoteReader && (remoteCatalogs?.scope !== ports.scope() || remoteCatalogs.provisional));
    if (!refreshing && now() - refreshedAt < LOCAL_CATALOG_TTL_MS) return remoteMissing ? readRemoteCatalogs(true) : Promise.resolve();
    refreshing ??= readLocalViews().then(() => undefined, () => undefined).finally(() => { refreshedAt = now(); refreshing = null; });
    return remoteMissing ? refreshing.then(() => readRemoteCatalogs(true)) : refreshing;
  }

  const { sshFilter, sshCodexViews } = createSshModelGroupSupport({
    listSshCodexProviders: ports.listSshCodexProviders
      ? (hostId) => ports.listSshCodexProviders!(hostId)
      : undefined,
    now,
  });

  const resolver = createModelGroupResolver({
    billingUnavailable: id => !!scheduledBillingHold(id),
    config: readModelGroupsConfigForSelected,
    recordDecision: recordModelGroupDecision,
    views: readLocalViews,
    pluginEngines: ports.pluginEngines ? () => ports.pluginEngines!() : undefined,
    remoteInvocable: ports.remoteInvocable ? (providerId) => ports.remoteInvocable!(providerId) : undefined,
    agents: () => ports.localAgents(),
    harnessInstalled: (agent, agentDeviceId) => ports.harnessInstalled(agent, agentDeviceId),
    quotaWindows: (options) => ports.quotaWindows(options),
    localCandidateAvailable: ports.localCandidateAvailable ? (view, agent) => ports.localCandidateAvailable!(view, agent) : undefined,
    localAccount: ports.localAccount ? (providerId, accountId, model, agent) => ports.localAccount!(providerId, accountId, model, agent) : undefined,
    innerQuota: ports.innerQuota ? (source) => ports.innerQuota!(source) : undefined,
    usageProfile: ports.usageProfile ? (options) => ports.usageProfile!(options) : undefined,
    runningSourceCounts: () => {
      const counts = new Map<string, number>();
      for (const session of ports.runningSessions()) {
        const providerId = hasSessionProvider(session.id) ? getSessionProvider(session.id) : session.providerId;
        if (!providerId) continue;
        const key = autoUsageSourceKey(session.agentDeviceId, providerId);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    },
    onCommitPick: ports.onCommitPick ? (candidate) => ports.onCommitPick!(candidate) : undefined,
    locations: ports.locations ? () => ports.locations!() : undefined,
    remoteViews: ports.remoteViews ? (agentDeviceId) => ports.remoteViews!(agentDeviceId) : undefined,
    remotePluginEngines: ports.remotePluginEngines ? (agentDeviceId) => ports.remotePluginEngines!(agentDeviceId) : undefined,
    scope: () => ports.scope(),
    now,
    pricing: ports.pricing ? () => ports.pricing!() : undefined,
    sshFilter,
    sshCodexViews,
  });

  const switchOfferDeps = {
    readBinding: readModelGroupSessionBinding,
    readSession: (sessionId: string) => ports.readSession(sessionId),
    isShared: (sessionId: string) => ports.isShared(sessionId),
    hasGoal: (sessionId: string) => ports.hasGoal(sessionId),
    config: readModelGroupsConfigForSelected,
    candidateFacts: (route: Parameters<typeof resolver.candidateFacts>[0], context?: ModelGroupResolveRequest['context'], options?: { sshHostId?: string; cachedQuota?: boolean }) =>
      resolver.candidateFacts(route, context, options),
    now,
  };

  async function readModelGroupRecoveryOffer(sessionId: string, recovery?: ModelGroupRecoveryRequest) {
    await refreshAutoModelGroupRoutes({ waitRemote: true });
    return computeModelGroupSwitchOffer(switchOfferDeps, sessionId, recovery);
  }

  async function evaluateTurnRouting(
    sessionId: string,
    current: ModelGroupTurnCurrentRoute,
    turn: ModelGroupTurnContext = {},
  ): Promise<ModelGroupTurnDecision> {
    await refreshAutoModelGroupRoutes({ waitRemote: false });
    return evaluateModelGroupBeforeSend(
      {
        readBinding: readModelGroupBindingForDispatch,
        ...(ports.taskAccount ? { readTaskAccount: ports.taskAccount } : {}),
        config: readModelGroupsConfigForSelected,
        candidateFacts: (route, context, options) => resolver.candidateFacts(route, context, options),
        now,
      },
      sessionId,
      current,
      turn,
    );
  }

  async function pickModelGroupRoute(
    groupId: string,
    options: { dryRun: boolean; sshHostId?: string; location?: { agentDeviceId: string | null }; context?: ModelGroupResolveRequest['context'] },
  ) {
    let result: Awaited<ReturnType<typeof resolver.resolve>>;
    try {
      result = await resolver.resolve({
        selection: { type: 'route', id: groupId },
        dryRun: options.dryRun,
        ...(options.sshHostId ? { sshHostId: options.sshHostId } : {}),
        ...(options.location ? { location: options.location } : {}),
        ...(options.context ? { context: options.context } : {}),
      });
    } catch (error) {
      pickLog.warn('model group pick failed; keeping the saved model', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
    if (result.outcome !== 'routed') return null;
    const { decisionId } = result;
    return {
      route: result.route,
      commit: () => { if (decisionId) resolver.commit(decisionId); },
    };
  }

  /** 本机配置首读可等画像预热，发送仍走 resolver 的同步缓存读取。 */
  async function autoModelPriorities(): Promise<Record<string, number> | undefined> {
    const scope = ports.scope();
    const cached = await ports.usageProfile?.();
    const profile = cached ?? await ports.usageProfile?.({ dryRun: true });
    const map = profile?.modelPriorities;
    return scope === ports.scope() && map && Object.keys(map).length > 0 ? map : undefined;
  }

  function dispose(): void {
    remoteCatalogs = null;
    remoteReading = null;
    lastLocal = null;
    refreshing = null;
    refreshedAt = 0;
    resolver.dispose();
    ports.onDispose?.();
  }

  return {
    resolver,
    localProviderView,
    autoModelPriorities,
    refreshLocalPluginEngines,
    refreshLocalAccounts,
    refreshAutoModelGroupRoutes,
    readModelGroupRecoveryOffer,
    evaluateTurnRouting,
    pickModelGroupRoute,
    dispose,
  };
}

export type ModelGroupRuntime = ReturnType<typeof createModelGroupRuntime>;
