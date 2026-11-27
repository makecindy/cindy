/**
 * 智能路由运行时核心(纯 Node，零 Electron 依赖，Desktop 与 Node Host 共用，见 architecture-invariants §5)。
 * 统一封装：本机/远程目录刷新与合成、resolver 解析器、故障恢复与横幅提议、任务中间发前持续托管评估、
 * 伙伴/定时任务选路，以及切账号时的状态释放。
 */
import type { ProviderView } from '@cindy/model-providers';
import type { ModelGroupAgentKind, ModelGroupResolveRequest, ModelGroupTraceQuota } from '../../shared/modelGroups.js';
import { pluginEngineKeyFromProviderId, type PluginEngineView } from '../../shared/pluginEngines.js';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';
import type { ModelPricingCatalog } from '../../shared/regionalMoney.js';
import { isPluginModelPickerRouteAvailable } from '../cindy-brain/ghostModelPicker.js';
import { createLogger } from '../logger.js';
import { recordModelGroupDecision } from './decisionLog.js';
import type { ModelGroupInnerQuota } from './pick.js';
import { createModelGroupResolver, MODEL_GROUP_REMOTE_WAIT_MS } from './resolver.js';
import { readModelGroupBindingForDispatch, readModelGroupSessionBinding } from './sessionBindings.js';
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

export interface ModelGroupRuntimePorts {
  scope(): string;
  localViews(): Promise<ProviderView[]>;
  pluginEngines?(): readonly PluginEngineView[];
  localAgents(): readonly string[];
  harnessInstalled(agent: string, agentDeviceId?: string): Promise<boolean>;
  quotaWindows(options?: { cached?: boolean }): Promise<ReadonlyMap<string, readonly (ModelGroupTraceQuota & { scopedTo?: string | null })[]>>;
  innerQuota?(source: { providerId: string; model: string; agentKind: ModelGroupAgentKind }): Promise<ModelGroupInnerQuota | null>;
  remoteInvocable?(providerId: string): boolean;
  locations?(): Promise<{ locations: readonly { agentDeviceId: string; providerIds?: readonly string[] }[] }>;
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

  /** 其他电脑与分享来的位置各自允许远程调用的供应商与插件引擎：按账号记，最多每分钟读一次。 */
  let remoteCatalogs: { scope: string; at: number; value: Map<string, ProviderView[]>; pluginEngines: Map<string, PluginEngineView[]> } | null = null;
  let remoteReading: { scope: string; promise: Promise<void> } | null = null;
  let lastLocal: { scope: string; views: ProviderView[]; pluginEngines: readonly PluginEngineView[] } | null = null;
  let refreshing: Promise<void> | null = null;
  let refreshedAt = 0;

  function publishCatalog(): void {
    const scope = ports.scope();
    if (lastLocal?.scope !== scope) return;
    const { views, pluginEngines } = lastLocal;
    setModelGroupSourceCatalog({
      views,
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

  function readRemoteCatalogs(): Promise<void> {
    if (!ports.locations || (!ports.remoteViews && !ports.remotePluginEngines)) return Promise.resolve();
    const scope = ports.scope();
    if (remoteReading?.scope === scope) return remoteReading.promise;
    if (remoteCatalogs?.scope === scope && now() - remoteCatalogs.at < REMOTE_CATALOG_TTL_MS) return Promise.resolve();
    const timeout = <T>(work: Promise<T>): Promise<T | null> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        work.catch(() => null),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MODEL_GROUP_REMOTE_WAIT_MS); }),
      ]).finally(() => clearTimeout(timer));
    };
    const promise: Promise<void> = (async () => {
      const { locations } = await ports.locations!();
      const providerEntries: Array<readonly [string, ProviderView[]]> = [];
      const pluginEntries: Array<readonly [string, PluginEngineView[]]> = [];
      await Promise.all(locations.map(async ({ agentDeviceId, providerIds }) => {
        const isShare = isProviderShareAgentDeviceId(agentDeviceId);
        const isPluginShare = isShare && !!providerIds?.length && providerIds.every((id) => pluginEngineKeyFromProviderId(id) !== null);
        const isProviderOnlyShare = isShare && !!providerIds?.length && providerIds.every((id) => pluginEngineKeyFromProviderId(id) === null);
        const [catalog, plugins] = await Promise.all([
          !isPluginShare && ports.remoteViews ? timeout(ports.remoteViews(agentDeviceId)) : Promise.resolve(null),
          !isProviderOnlyShare && ports.remotePluginEngines ? timeout(ports.remotePluginEngines(agentDeviceId)) : Promise.resolve(null),
        ]);
        if (catalog && !catalog.stale) providerEntries.push([agentDeviceId, catalog.views]);
        if (plugins && plugins.length > 0) pluginEntries.push([agentDeviceId, [...plugins]]);
      }));
      if (scope !== ports.scope()) return;
      remoteCatalogs = { scope, at: now(), value: new Map(providerEntries), pluginEngines: new Map(pluginEntries) };
      publishCatalog();
    })().catch(() => {
      if (scope === ports.scope()) remoteCatalogs = { scope, at: now(), value: new Map(), pluginEngines: new Map() };
    }).finally(() => { if (remoteReading?.promise === promise) remoteReading = null; });
    remoteReading = { scope, promise };
    return promise;
  }

  async function readLocalViews(): Promise<ProviderView[]> {
    const views = await ports.localViews();
    lastLocal = { scope: ports.scope(), views, pluginEngines: ports.pluginEngines ? ports.pluginEngines() : [] };
    publishCatalog();
    void readRemoteCatalogs();
    return views;
  }

  function localProviderView(providerId: string): ProviderView | undefined {
    return lastLocal?.scope === ports.scope() ? lastLocal.views.find((item) => item.id === providerId) : undefined;
  }

  function refreshAutoModelGroupRoutes(options: { waitRemote?: boolean } = {}): Promise<void> {
    const remoteMissing = Boolean(options.waitRemote && ports.locations && ports.remoteViews && remoteCatalogs?.scope !== ports.scope());
    if (!refreshing && now() - refreshedAt < 1_000) return remoteMissing ? readRemoteCatalogs() : Promise.resolve();
    refreshing ??= readLocalViews().then(() => undefined, () => undefined).finally(() => { refreshedAt = now(); refreshing = null; });
    return remoteMissing ? refreshing.then(() => readRemoteCatalogs()) : refreshing;
  }

  const { sshFilter, sshCodexViews } = createSshModelGroupSupport({
    listSshCodexProviders: ports.listSshCodexProviders
      ? (hostId) => ports.listSshCodexProviders!(hostId)
      : undefined,
    now,
  });

  const resolver = createModelGroupResolver({
    config: readModelGroupsConfigForSelected,
    recordDecision: recordModelGroupDecision,
    views: readLocalViews,
    pluginEngines: ports.pluginEngines ? () => ports.pluginEngines!() : undefined,
    remoteInvocable: ports.remoteInvocable ? (providerId) => ports.remoteInvocable!(providerId) : undefined,
    agents: () => ports.localAgents(),
    harnessInstalled: (agent, agentDeviceId) => ports.harnessInstalled(agent, agentDeviceId),
    quotaWindows: (options) => ports.quotaWindows(options),
    innerQuota: ports.innerQuota ? (source) => ports.innerQuota!(source) : undefined,
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

  function dispose(): void {
    remoteCatalogs = null;
    remoteReading = null;
    lastLocal = null;
    refreshing = null;
    refreshedAt = 0;
    resolver.dispose();
  }

  return {
    resolver,
    localProviderView,
    refreshLocalPluginEngines,
    refreshAutoModelGroupRoutes,
    readModelGroupRecoveryOffer,
    evaluateTurnRouting,
    pickModelGroupRoute,
    dispose,
  };
}

export type ModelGroupRuntime = ReturnType<typeof createModelGroupRuntime>;
