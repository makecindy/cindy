/**
 * 智能路由运行时的桌面装配(architecture-invariants §2 & §5)：
 * 所有依赖顶层静态导入，所有端口调用期转发；纯 Node 核心逻辑在 runtimeCore.ts。
 */
import { isSessionActivityRunning } from '@cindy/maker-shared/session-activity';
import type { AgentKind, ProviderView } from '@cindy/model-providers';
import type { ModelGroupAgentKind, ModelGroupTraceQuota } from '../../shared/modelGroups.js';
import { isSubscriptionProvider } from '../../shared/subscriptionAccounts.js';
import { getAgentIslandService } from '../agent-island/service.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getPluginModelPickerAgents, isPluginRouteHarnessInstalled } from '../cindy-brain/ghostModelPicker.js';
import { remoteBackgroundInvoke } from '../device-link/index.js';
import { isSessionSharedTaskActive } from '../device-link/sharedTaskDispatch.js';
import { getGoalController } from '../goal-host/index.js';
import { t } from '../i18n.desktop.js';
import { getSessionRowSnapshot } from '../localDb/sessionDispatchSnapshot.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { isRemoteProviderInvocationAllowed } from '../maker-host/remote-provider-access-store.js';
import * as pluginEnginesIpc from '../maker-ipc/pluginEnginesIpc.js';
import { readWorkerAgentLocations } from '../maker-ipc/workerAgentLocations.js';
import { isOpenAiGroupAccountUnavailable } from '../provider-group/localOpenAiAccounts.js';
import { getProviderGroupRouter } from '../provider-group/runtime.js';
import { fiveHourTightFor } from '../provider-group/scheduler.js';
import { readProviderGroup } from '../provider-group/store.js';
import { getQuotaOverviewService } from '../quota-overview/service.js';
import { readDeviceProviderCatalog, readRemotePluginEngines } from '../remote-agent/controller/deviceCatalog.js';
import {
  listSubscriptionPoolSources,
  readSessionBoundSubscriptionAccount,
  onSubscriptionAccountsChanged,
  readSubscriptionPool,
  readSubscriptionPoolScheduling,
} from '../subscription-accounts/runtime.js';
import { getGatewayModelPricing } from '../usage/modelPricing.js';
import { getReferenceModelPricing } from '../usage/referenceModelPricing.js';
import { createAutoUsageProfileStore, readLocalAutoUsageSamples } from './autoUsageProfile.js';
import type { ModelGroupInnerQuota } from './pick.js';
import { modelGroupQuotaKey, MODEL_GROUP_REMOTE_WAIT_MS, type ModelGroupLocalAccountFact } from './resolver.js';
import { createModelGroupRuntime, type ModelGroupRunningSession } from './runtimeCore.js';
import type { SourceCatalogAccount } from './sourceRoutes.js';

/** 选路时让额度总览保持采集这么久；面板没开时它平时不采集。 */
const QUOTA_LEASE_MS = 5 * 60_000;
/** 显式「试一下」最多等这么久取新鲜快照。 */
const QUOTA_WAIT_MS = MODEL_GROUP_REMOTE_WAIT_MS;
/** 正式选路冷启动（完全无缓存）最多等这么久，不让发消息白等 2 秒。 */
const QUOTA_COLD_WAIT_MS = 400;
/** 已有这么新的额度快照时直接 0ms 返回，后台静默刷新（Stale-While-Revalidate）。 */
const QUOTA_STALE_OK_MS = 5 * 60_000;
const INNER_GROUP_TTL_MS = 60_000;
const innerGroups = new Map<string, { at: number; value: Promise<ModelGroupInnerQuota | null> }>();

const autoUsageProfileStore = createAutoUsageProfileStore({
  scope: () => activeOwnerScopeKey(),
  readSamples: (sinceMs, nowMs) => readLocalAutoUsageSamples(sinceMs, nowMs),
});

async function quotaWindows(options?: { cached?: boolean; dryRun?: boolean }) {
  const overview = getQuotaOverviewService();
  overview.lease(QUOTA_LEASE_MS);
  const existing = overview.latest();
  const age = existing ? Date.now() - existing.builtAtMs : Number.POSITIVE_INFINITY;
  let build = existing;
  if (options?.cached) {
    if (!existing || existing.stale || age >= QUOTA_STALE_OK_MS) void overview.fresh(0);
  } else if (existing && !existing.stale && age < QUOTA_STALE_OK_MS && !options?.dryRun) {
    // 近期已有新鲜快照：0ms 直接用，后台异步刷新供下次使用，消灭选路卡顿。
    void overview.fresh(0);
  } else {
    build = await overview.fresh(options?.dryRun ? QUOTA_WAIT_MS : QUOTA_COLD_WAIT_MS);
  }
  const byProvider = new Map<string, (ModelGroupTraceQuota & { scopedTo?: string | null })[]>();
  for (const source of build?.input.sources ?? []) {
    if (source.kind !== 'subscription' || (source.device && source.lastSeenAtMs != null)) continue;
    const windows = source.windows.map((window) => ({
      usedPercent: window.usedPercent,
      resetAtMs: window.resetsAtMs,
      windowMs: window.windowMinutes * 60_000,
      ...(window.kind === 'scoped' ? { scopedTo: window.label ?? null } : {}),
    }));
    const location = source.shared ? source.id : source.device?.id;
    if (!location && source.pooled) {
      const prefix = `${source.providerId}:account:`;
      const accountId = source.id === source.providerId
        ? 'default'
        : source.id.startsWith(prefix)
          ? source.id.slice(prefix.length)
          : null;
      if (accountId) {
        const accountKey = modelGroupQuotaKey(undefined, source.providerId, accountId);
        if (windows.length > 0 || !byProvider.has(accountKey)) byProvider.set(accountKey, windows);
      }
      if (!byProvider.has(modelGroupQuotaKey(undefined, source.providerId))) {
        byProvider.set(modelGroupQuotaKey(undefined, source.providerId), windows);
      }
      continue;
    }
    const key = modelGroupQuotaKey(location, source.providerId);
    if (windows.length > 0 || !byProvider.has(key)) byProvider.set(key, windows);
  }
  return byProvider;
}

/** 取本进程的任务活动和已缓存的执行位置，不为选路查库或询问对端。 */
function runningSessions(): ModelGroupRunningSession[] {
  const activities = getAgentIslandService()?.getSessionActivitySnapshots() ?? [];
  if (activities.length === 0) return [];
  const routes = autoUsageProfileStore.peek()?.sessionRoutes;
  return activities
    .filter(activity => activity.currentTurnActive ?? isSessionActivityRunning(activity))
    .map(({ sessionId }) => ({ id: sessionId, ...routes?.get(sessionId) }));
}

function accountDisplayLabel(label: string, index: number): string {
  return label || (t('providerGroup.member.accountFallback' as never, { index: index + 1 } as never) as string);
}

function readLocalAccounts(views: readonly ProviderView[]): ReadonlyMap<string, readonly SourceCatalogAccount[]> {
  const map = new Map<string, readonly SourceCatalogAccount[]>();
  for (const view of views) {
    if (!view.connected || view.suspended || view.removed || view.subscriptionPoolAlias) continue;
    if (!isSubscriptionProvider(view.id) && !view.subscriptionPool && !view.subscriptionAccountPool) continue;
    const raw = listSubscriptionPoolSources(view.id);
    if (!raw || raw.length === 0) continue;
    map.set(view.id, raw.map((item, index) => ({
      ...item,
      label: accountDisplayLabel(item.label, index),
    })));
  }
  return map;
}

async function warmLocalAccounts(views: readonly ProviderView[]): Promise<void> {
  const coldIds = views
    .filter((view) => view.connected && !view.suspended && !view.removed && !view.subscriptionPoolAlias
      && (isSubscriptionProvider(view.id) || !!view.subscriptionPool || !!view.subscriptionAccountPool))
    .filter((view) => {
      const list = listSubscriptionPoolSources(view.id);
      if (!list || list.length < 2) return false;
      return list.some((item) => !item.paused && !item.apiConnectionId && (!item.accountKey || !item.label));
    })
    .map((view) => view.id);
  if (coldIds.length === 0) return;
  await Promise.all(coldIds.map((providerId) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const warm = readSubscriptionPool(providerId).then(() => {
      if (settled) desktopModelGroupRuntime.refreshLocalAccounts();
    }, () => undefined);
    return Promise.race([
      warm,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_500); }),
    ]).finally(() => {
      settled = true;
      clearTimeout(timer);
    });
  }));
}

function readLocalAccountFact(providerId: string, accountId: string, model: string, agent: AgentKind): ModelGroupLocalAccountFact | null {
  const list = listSubscriptionPoolSources(providerId);
  if (!list) return null;
  const index = list.findIndex((item) => item.id === accountId);
  if (index < 0) return null;
  const item = list[index];
  const modelOk = !item.supportedModelIds || item.supportedModelIds.has(model.replace(/^chatgpt\//, ''));
  return {
    available: item.usable && modelOk
      && (!item.apiConnectionId || !isOpenAiGroupAccountUnavailable(item.apiConnectionId, agent)),
    label: accountDisplayLabel(item.label, index),
    running: item.running,
    payAsYouGo: Boolean(item.apiConnectionId),
  };
}

function innerQuota(source: { providerId: string; model: string; agentKind: ModelGroupAgentKind }): Promise<ModelGroupInnerQuota | null> {
  if (source.agentKind === 'acp') return Promise.resolve(null);
  const agent = source.agentKind === 'cc' ? 'claude-code' as const : source.agentKind;
  const config = readProviderGroup(source.providerId);
  if (config) {
    return (async (): Promise<ModelGroupInnerQuota | null> => {
      const router = getProviderGroupRouter();
      const progress = router.pickProgress?.(source.providerId);
      const prefix = [activeOwnerScopeKey(), source.providerId, source.model, agent].join('\u0000');
      const key = `${prefix}\u0000${progress?.lastPicked ?? ''}\u0000${progress?.roundPicks ?? 0}\u0000${JSON.stringify([...(progress?.weightCounters ?? [])])}`;
      const cached = innerGroups.get(key);
      if (cached && Date.now() - cached.at < INNER_GROUP_TTL_MS) return cached.value;
      const value = router.pick({ providerId: source.providerId, agentKind: agent, model: source.model, localTask: true, preview: true })
        .then((picked): ModelGroupInnerQuota | null => {
          if (picked.kind === 'none') return null;
          if (picked.kind === 'unavailable') return { limited: !picked.full, urgency: null, fiveHourTight: false, headroom: null };
          const facts = picked.facts;
          if (!facts) return null;
          return { limited: false, urgency: facts.urgency ?? null, fiveHourTight: fiveHourTightFor(facts), headroom: facts.headroom ?? null };
        })
        .catch(() => null);
      innerGroups.set(key, { at: Date.now(), value });
      for (const [entry, item] of innerGroups) {
        if (Date.now() - item.at >= INNER_GROUP_TTL_MS || (entry !== key && entry.startsWith(`${prefix}\u0000`))) innerGroups.delete(entry);
      }
      return value;
    })();
  }
  const view = desktopModelGroupRuntime.localProviderView(source.providerId);
  if ((view?.subscriptionAccountKeys?.length ?? 0) < 2) return Promise.resolve(null);
  return readSubscriptionPoolScheduling(source.providerId, source.model, { agent }).then((summary) => summary && {
    limited: summary.accounts === 0 && !summary.full,
    urgency: summary.urgency,
    fiveHourTight: summary.fiveHourTight,
    headroom: summary.headroom ?? null,
  }, () => null);
}

let sshCodexProvidersReader: ((hostId: string) => Promise<ProviderView[]>) | null = null;

/** 由 bootstrap-electron 注入 SSH Codex 供应商查询，避免 desktopResolver 反向静态依赖 maker-host/index.ts。 */
export function registerDesktopSshCodexProvidersReader(
  reader: ((hostId: string) => Promise<ProviderView[]>) | null,
): void {
  sshCodexProvidersReader = reader;
}

let pluginEnginesSubscribed = false;
function ensurePluginEnginesSubscription(): void {
  if (pluginEnginesSubscribed) return;
  pluginEnginesSubscribed = true;
  pluginEnginesIpc.onPluginEnginesChanged?.(() => {
    desktopModelGroupRuntime.refreshLocalPluginEngines();
  });
  onSubscriptionAccountsChanged(() => {
    desktopModelGroupRuntime.refreshLocalAccounts();
  });
}

export const desktopModelGroupRuntime = createModelGroupRuntime({
  scope: () => activeOwnerScopeKey(),
  localViews: () => {
    ensurePluginEnginesSubscription();
    return getDesktopProviderService({ allowSideEffects: false }).listProviders({ allowSideEffects: false, snapshotOnly: true });
  },
  localAccounts: (views) => readLocalAccounts(views),
  warmLocalAccounts: (views) => warmLocalAccounts(views),
  // For a flat member, the individual account health is checked by localAccount.
  // A standalone key has no account slot, so check its own connection directly.
  localCandidateAvailable: (view, agent) => !!view.subscriptionAccountPool
    || !isOpenAiGroupAccountUnavailable(view.id, agent) || !!readProviderGroup(view.id),
  localAccount: readLocalAccountFact,
  taskAccount: (sessionId, providerId) => readSessionBoundSubscriptionAccount(sessionId, providerId),
  pluginEngines: () => pluginEnginesIpc.listPluginEngineViews(),
  localAgents: () => getPluginModelPickerAgents(),
  harnessInstalled: (agent, agentDeviceId) => isPluginRouteHarnessInstalled(agent, agentDeviceId, async (deviceId, name) => {
    const result = await remoteBackgroundInvoke(deviceId, 'maker:agent:status', [name]);
    if (!result.ok) throw new Error(result.error?.message ?? 'Remote agent status unavailable');
    return result.result as { binaryReady?: boolean } | null | undefined;
  }),
  quotaWindows: (options) => quotaWindows(options),
  innerQuota: (source) => innerQuota(source),
  usageProfile: (options) => (options?.dryRun ? autoUsageProfileStore.readForPreview(200) : autoUsageProfileStore.peek()),
  runningSessions: () => runningSessions(),
  onCommitPick: (candidate) => autoUsageProfileStore.recordPick(candidate),
  onDispose: () => autoUsageProfileStore.dispose(),
  remoteInvocable: (providerId) => isRemoteProviderInvocationAllowed(providerId),
  locations: () => readWorkerAgentLocations({ favoriteSources: true }),
  remoteViews: (agentDeviceId) => readDeviceProviderCatalog(remoteBackgroundInvoke, agentDeviceId),
  remotePluginEngines: (agentDeviceId) => readRemotePluginEngines(agentDeviceId),
  pricing: async () => ({ gateway: await getGatewayModelPricing(), reference: getReferenceModelPricing() }),
  listSshCodexProviders: (hostId) => sshCodexProvidersReader ? sshCodexProvidersReader(hostId) : Promise.resolve([]),
  readSession: (sessionId) => getSessionRowSnapshot(sessionId),
  isShared: (sessionId) => isSessionSharedTaskActive(sessionId),
  hasGoal: async (sessionId: string) => {
    const goals = getGoalController();
    return !!goals && (await goals.getStatus(sessionId).catch(() => null)) !== null;
  },
  now: () => Date.now(),
});

export const resolver = desktopModelGroupRuntime.resolver;
export const localProviderView = desktopModelGroupRuntime.localProviderView;
export const refreshAutoModelGroupRoutes = desktopModelGroupRuntime.refreshAutoModelGroupRoutes;
export const readModelGroupRecoveryOffer = desktopModelGroupRuntime.readModelGroupRecoveryOffer;
export const evaluateDesktopModelGroupBeforeSend = desktopModelGroupRuntime.evaluateTurnRouting;
export const pickModelGroupRoute = desktopModelGroupRuntime.pickModelGroupRoute;
export const warmDesktopAutoUsageProfile = (): void => {
  void autoUsageProfileStore.peek();
};
