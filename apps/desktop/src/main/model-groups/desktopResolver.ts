/**
 * 智能路由运行时的桌面装配(architecture-invariants §2 & §5)：
 * 所有依赖顶层静态导入，所有端口调用期转发；纯 Node 核心逻辑在 runtimeCore.ts。
 */
import type { AgentKind, ProviderView } from '@cindy/model-providers';
import type { ModelGroupAgentKind, ModelGroupTraceQuota } from '../../shared/modelGroups.js';
import { isSubscriptionProvider } from '../../shared/subscriptionAccounts.js';
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
import type { ModelGroupInnerQuota } from './pick.js';
import { modelGroupQuotaKey, MODEL_GROUP_REMOTE_WAIT_MS } from './resolver.js';
import { createModelGroupRuntime } from './runtimeCore.js';
import type { SourceCatalogAccount } from './sourceRoutes.js';

/** 选路时让额度总览保持采集这么久；面板没开时它平时不采集。 */
const QUOTA_LEASE_MS = 5 * 60_000;
/** 等一份新额度最多这么久，等不到就用已有的；不让新任务卡在读额度上。 */
const QUOTA_WAIT_MS = MODEL_GROUP_REMOTE_WAIT_MS;
const INNER_GROUP_TTL_MS = 60_000;
const innerGroups = new Map<string, { at: number; value: Promise<ModelGroupInnerQuota | null> }>();

async function quotaWindows(options?: { cached?: boolean }) {
  const overview = getQuotaOverviewService();
  overview.lease(QUOTA_LEASE_MS);
  const build = await overview.fresh(options?.cached ? 0 : QUOTA_WAIT_MS);
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
        byProvider.set(modelGroupQuotaKey(undefined, source.providerId, accountId), windows);
      }
      if (!byProvider.has(modelGroupQuotaKey(undefined, source.providerId))) {
        byProvider.set(modelGroupQuotaKey(undefined, source.providerId), windows);
      }
      continue;
    }
    byProvider.set(modelGroupQuotaKey(location, source.providerId), windows);
  }
  return byProvider;
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

function readLocalAccountFact(providerId: string, accountId: string, model: string, agent: AgentKind): { available: boolean; label: string } | null {
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
