import type { ProviderView } from '@cindy/model-providers';
import type { ModelGroupAgentKind, ModelGroupTraceQuota } from '../../shared/modelGroups.js';
import { pluginEngineKeyFromProviderId, type PluginEngineView } from '../../shared/pluginEngines.js';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { getPluginModelPickerAgents, isPluginModelPickerRouteAvailable, isPluginRouteHarnessInstalled } from '../cindy-brain/ghostModelPicker.js';
import { remoteBackgroundInvoke } from '../device-link/index.js';
import { isSessionSharedTaskActive } from '../device-link/sharedTaskDispatch.js';
import { getGoalController } from '../goal-host/index.js';
import { getSessionRowSnapshot } from '../localDb/sessionDispatchSnapshot.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { isPluginEngineOfferedRemotely } from '../maker-host/pluginEngineRemoteUse.js';
import { isRemoteProviderInvocationAllowed } from '../maker-host/remote-provider-access-store.js';
import * as pluginEnginesIpc from '../maker-ipc/pluginEnginesIpc.js';
import { readWorkerAgentLocations } from '../maker-ipc/workerAgentLocations.js';
import { getQuotaOverviewService } from '../quota-overview/service.js';
import { getGatewayModelPricing } from '../usage/modelPricing.js';
import { getReferenceModelPricing } from '../usage/referenceModelPricing.js';
import { readDeviceProviderCatalog, readRemotePluginEngines } from '../remote-agent/controller/deviceCatalog.js';
import { recordModelGroupDecision } from './decisionLog.js';
import { createModelGroupResolver, modelGroupQuotaKey, MODEL_GROUP_REMOTE_WAIT_MS } from './resolver.js';
import { readModelGroupSessionBinding } from './sessionBindings.js';
import { readModelGroupsConfigForSelected, setModelGroupSourceCatalog } from './store.js';
import type { ModelGroupInnerQuota } from './pick.js';
import { fiveHourTightFor } from '../provider-group/scheduler.js';
import { readProviderGroup } from '../provider-group/store.js';
import { computeModelGroupSwitchOffer } from './switchOffer.js';

const pickLog = createLogger('model-groups:pick');

/** 选路时让额度总览保持采集这么久；面板没开时它平时不采集。 */
const QUOTA_LEASE_MS = 5 * 60_000;
/** 等一份新额度最多这么久，等不到就用已有的；不让新任务卡在读额度上。读别处的位置与目录用同一个上限。 */
const QUOTA_WAIT_MS = MODEL_GROUP_REMOTE_WAIT_MS;

/**
 * 额度总览里的订阅窗口：本机的按供应商连接 ID；别的电脑上的按那台的设备 id + 那台的连接 ID(modelGroupQuotaKey)，
 * 只给同一台电脑上的来源用。那台此刻读不到、只剩上次读数的(lastSeenAtMs)不算；与本机是同一个账号、
 * 总览里只列了本机那份的，别的电脑上的来源按读不到额度处理。分享来的来源按运行位置 `share:<id>` 取那个分享
 * 开放给本账号的额度(分享者没开「允许查看剩余额度」或读不到时总览里没有它，按读不到处理)。
 */
async function quotaWindows(options?: { cached?: boolean }) {
  const overview = getQuotaOverviewService();
  overview.lease(QUOTA_LEASE_MS);
  // 总览里常有来源还没读全(刚启动、某个来源在刷新、有电脑离线)，这时等一份读全的会等满上限。
  // 只为显示时不等：拿手头这份，同时照常催它重读，下一次就是新的。
  const build = await overview.fresh(options?.cached ? 0 : QUOTA_WAIT_MS);
  const byProvider = new Map<string, (ModelGroupTraceQuota & { scopedTo?: string | null })[]>();
  for (const source of build?.input.sources ?? []) {
    if (source.kind !== 'subscription' || (source.device && source.lastSeenAtMs != null)) continue;
    // 分享来源在总览里的 id 就是它的运行位置 `share:<shareId>`。
    const location = source.shared ? source.id : source.device?.id;
    byProvider.set(modelGroupQuotaKey(location, source.providerId), source.windows.map((window) => ({
      usedPercent: window.usedPercent,
      resetAtMs: window.resetsAtMs,
      windowMs: window.windowMinutes * 60_000,
      ...(window.kind === 'scoped' ? { scopedTo: window.label ?? null } : {}),
    })));
  }
  return byProvider;
}

/** 其他电脑与分享来的位置各自允许远程调用的供应商与插件引擎：按账号记，最多每分钟读一次。 */
let remoteCatalogs: {
  scope: string;
  at: number;
  value: Map<string, ProviderView[]>;
  pluginEngines: Map<string, PluginEngineView[]>;
} | null = null;
let remoteReading: { scope: string; promise: Promise<void> } | null = null;
let lastLocal: { scope: string; views: ProviderView[]; pluginEngines: PluginEngineView[] } | null = null;
const REMOTE_CATALOG_TTL_MS = 60_000;

function publishCatalog(): void {
  const scope = activeOwnerScopeKey();
  if (lastLocal?.scope !== scope) return;
  const { views, pluginEngines } = lastLocal;
  setModelGroupSourceCatalog({
    views,
    pluginEngines,
    agents: getPluginModelPickerAgents(),
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

let pluginEnginesSubscribed = false;
function ensurePluginEnginesSubscription(): void {
  if (pluginEnginesSubscribed) return;
  pluginEnginesSubscribed = true;
  // 插件执行引擎增删、模型目录刷新或停用切换时，立刻重发本机目录快照让自动合成路由同步。
  pluginEnginesIpc.onPluginEnginesChanged?.(() => {
    const scope = activeOwnerScopeKey();
    if (lastLocal?.scope === scope) {
      lastLocal = { ...lastLocal, pluginEngines: pluginEnginesIpc.listPluginEngineViews() };
      publishCatalog();
    }
  });
}

/**
 * 读其他电脑与分享来的供应商与插件引擎目录(供应商路由的成员可以在那里)。只在有人读配置、选路或发消息时才读，没有定时器；
 * 同一时刻只读一轮，一分钟内不重读；每个位置各自最多等 MODEL_GROUP_REMOTE_WAIT_MS。
 * 这次没读到的位置沿用不了旧目录(对方可能已经收回)，按没有处理。
 */
function readRemoteCatalogs(): Promise<void> {
  const scope = activeOwnerScopeKey();
  // 换了账号：上一个账号那一轮读完也会丢掉结果，不等它，按这个账号重读。
  if (remoteReading?.scope === scope) return remoteReading.promise;
  if (remoteCatalogs?.scope === scope && Date.now() - remoteCatalogs.at < REMOTE_CATALOG_TTL_MS) return Promise.resolve();
  const timeout = <T>(work: Promise<T>): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      work.catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MODEL_GROUP_REMOTE_WAIT_MS); }),
    ]).finally(() => clearTimeout(timer));
  };
  const promise: Promise<void> = (async () => {
    const { locations } = await readWorkerAgentLocations({ favoriteSources: true });
    const value = new Map<string, ProviderView[]>();
    const pluginEngines = new Map<string, PluginEngineView[]>();
    await Promise.all(locations.map(async ({ agentDeviceId, favoriteSource }) => {
      const isShare = isProviderShareAgentDeviceId(agentDeviceId);
      const isPluginShare = isShare && pluginEngineKeyFromProviderId(favoriteSource?.providerId) !== null;
      const [catalog, remotePlugins] = await Promise.all([
        isPluginShare ? Promise.resolve(null) : timeout(readDeviceProviderCatalog(remoteBackgroundInvoke, agentDeviceId)),
        isShare && !isPluginShare ? Promise.resolve(null) : timeout(readRemotePluginEngines(agentDeviceId)),
      ]);
      if (catalog && !catalog.stale) value.set(agentDeviceId, catalog.views);
      if (remotePlugins && remotePlugins.length > 0) pluginEngines.set(agentDeviceId, remotePlugins);
    }));
    if (scope !== activeOwnerScopeKey()) return;
    remoteCatalogs = { scope, at: Date.now(), value, pluginEngines };
    publishCatalog();
  })().catch(() => {
    // 这一轮意外失败也记下时间：一分钟内不再重读，失败时不随每次取配置、发消息反复读远端。
    if (scope === activeOwnerScopeKey()) remoteCatalogs = { scope, at: Date.now(), value: new Map(), pluginEngines: new Map() };
  }).finally(() => { if (remoteReading?.promise === promise) remoteReading = null; });
  remoteReading = { scope, promise };
  return promise;
}

/**
 * 本机供应商目录的快照(不触发发现或登录)。每次读出来顺手交给配置读取：供应商路由按它合成和展开，取配置与
 * 解析路由都先读目录，所以两处看到的供应商路由与目录是同一时刻的。别处的目录在后台跟上，不让这里等。
 */
async function localViews() {
  ensurePluginEnginesSubscription();
  const views = await getDesktopProviderService({ allowSideEffects: false }).listProviders({ allowSideEffects: false, snapshotOnly: true });
  lastLocal = { scope: activeOwnerScopeKey(), views, pluginEngines: pluginEnginesIpc.listPluginEngineViews() };
  publishCatalog();
  void readRemoteCatalogs();
  return views;
}

/**
 * 电脑组的「下一台」：组的轮流进度不变时一分钟内复用同一个预判，同时来的共用一次。进度变了(派发过一次)就按此刻的进度重算，
 * 各台的账号池摘要由电脑组在一分钟内复用(只预判时不再问那台电脑)，重算不增加远端读取。
 */
const INNER_GROUP_TTL_MS = 60_000;
const innerGroups = new Map<string, { at: number; value: Promise<ModelGroupInnerQuota | null> }>();

/**
 * 本机来源背后的内层(2026-11-26，dash 建议)：电脑组按组的选法下一台会接任务的电脑、几个账号的连接按账号池下一个会用的
 * 账号，报能不能用、快满没、急不急、余量，外层智能路由按它判断，与内层实际会用的一致。只读：不占位、不推进轮流或计数。
 * 单个账号、没有组的来源返回 null，照旧按额度总览里那一份判断。
 */
function innerQuota(source: { providerId: string; model: string; agentKind: ModelGroupAgentKind }): Promise<ModelGroupInnerQuota | null> {
  if (source.agentKind === 'acp') return Promise.resolve(null);
  const agent = source.agentKind === 'cc' ? 'claude-code' as const : source.agentKind;
  const config = readProviderGroup(source.providerId);
  if (config) {
    return (async (): Promise<ModelGroupInnerQuota | null> => {
      // 用到时才加载组与账号池的运行时，不把它们拉进启动时就加载的模块。
      const { getProviderGroupRouter } = await import('../provider-group/runtime.js');
      const router = getProviderGroupRouter();
      // 组里真正派发过一次(轮流、比例推进了)就不再用缓存的预判。
      const progress = router.pickProgress?.(source.providerId);
      const prefix = [activeOwnerScopeKey(), source.providerId, source.model, agent].join('\u0000');
      const key = `${prefix}\u0000${progress?.lastPicked ?? ''}\u0000${progress?.roundPicks ?? 0}\u0000${JSON.stringify([...(progress?.weightCounters ?? [])])}`;
      const cached = innerGroups.get(key);
      if (cached && Date.now() - cached.at < INNER_GROUP_TTL_MS) return cached.value;
      // 与正式派发同一次选路(只预判)：账号池摘要、轮流槽位、模型准入、套餐用完后置都与真正接任务时一致。
      const value = router.pick({ providerId: source.providerId, agentKind: agent, model: source.model, localTask: true, preview: true })
        .then((picked): ModelGroupInnerQuota | null => {
          if (picked.kind === 'none') return null;
          // 一台都不能接、又不是因为都满载：额度用完或都用不了。满载只是忙，不算额度用完。
          if (picked.kind === 'unavailable') return { limited: !picked.full, urgency: null, fiveHourTight: false, headroom: null };
          const facts = picked.facts;
          if (!facts) return null;
          return { limited: false, urgency: facts.urgency ?? null, fiveHourTight: fiveHourTightFor(facts), headroom: facts.headroom ?? null };
        })
        .catch(() => null);
      innerGroups.set(key, { at: Date.now(), value });
      // 过期的、以及同一来源进度已变的旧预判一并清掉。
      for (const [entry, item] of innerGroups) {
        if (Date.now() - item.at >= INNER_GROUP_TTL_MS || (entry !== key && entry.startsWith(`${prefix}\u0000`))) innerGroups.delete(entry);
      }
      return value;
    })();
  }
  // 几个账号的连接：只有确实有两个以上已核实的账号才问账号池(与智能路由页列「N 个账号」同一判断)。
  const view = lastLocal?.scope === activeOwnerScopeKey() ? lastLocal.views.find((item) => item.id === source.providerId) : undefined;
  if ((view?.subscriptionAccountKeys?.length ?? 0) < 2) return Promise.resolve(null);
  return import('../subscription-accounts/runtime.js').then(({ readSubscriptionPoolScheduling }) =>
    readSubscriptionPoolScheduling(source.providerId, source.model, { agent })).then((summary) => summary && {
    // 一个都不能接、又不是因为都满载：额度用完或都在冷却。
    limited: summary.accounts === 0 && !summary.full,
    urgency: summary.urgency,
    fiveHourTight: summary.fiveHourTight,
    headroom: summary.headroom ?? null,
  }, () => null);
}

/** 本机供应商目录最近一次的快照里的这个连接(当前账号的)；还没读过为 undefined。 */
export function localProviderView(providerId: string): ProviderView | undefined {
  return lastLocal?.scope === activeOwnerScopeKey() ? lastLocal.views.find((item) => item.id === providerId) : undefined;
}

let refreshing: Promise<void> | null = null;
let refreshedAt = 0;

/**
 * 读配置前调用：让随后读到的配置带上此刻的供应商路由(它们按供应商目录合成和展开，不存盘)。读目录失败时沿用上一次的。
 * 发消息、出问题接替这些路径每次都会调：一秒内只读一次目录快照，同时来的调用等同一次读取。
 * `waitRemote`：界面取配置时，别处的目录还一次都没读到就等它读完(有时限)，免得第一次打开看不到分享来的成员。
 */
export function refreshAutoModelGroupRoutes(options: { waitRemote?: boolean } = {}): Promise<void> {
  const remoteMissing = options.waitRemote && remoteCatalogs?.scope !== activeOwnerScopeKey();
  if (!refreshing && Date.now() - refreshedAt < 1_000) return remoteMissing ? readRemoteCatalogs() : Promise.resolve();
  refreshing ??= localViews().then(() => undefined, () => undefined).finally(() => { refreshedAt = Date.now(); refreshing = null; });
  return remoteMissing ? refreshing.then(() => readRemoteCatalogs()) : refreshing;
}

export const resolver = createModelGroupResolver({
  config: readModelGroupsConfigForSelected,
  recordDecision: recordModelGroupDecision,
  views: localViews,
  pluginEngines: () => pluginEnginesIpc.listPluginEngineViews(),
  // 另一台电脑借这台跑 Agent 时只用开了「允许被远程调用」的连接(与设置里那个开关同一份)。
  remoteInvocable: isRemoteProviderInvocationAllowed,
  pluginEngineRemoteInvocable: isPluginEngineOfferedRemotely,
  agents: getPluginModelPickerAgents,
  // 别的电脑上的引擎问那台的 maker:agent:status，与插件选路同一判断。
  harnessInstalled: (agent, agentDeviceId) => isPluginRouteHarnessInstalled(agent, agentDeviceId, async (deviceId, name) => {
    const result = await remoteBackgroundInvoke(deviceId, 'maker:agent:status', [name]);
    if (!result.ok) throw new Error(result.error?.message ?? 'Remote agent status unavailable');
    return result.result as { binaryReady?: boolean } | null | undefined;
  }),
  quotaWindows,
  innerQuota,
  // 其他电脑与分享来的来源：与插件卡片里的远程模型同一份位置名单与同一条目录读取。
  locations: readWorkerAgentLocations,
  // 带上 stale：读不到时底层会给上次的目录，选路不能把它当成那台现在能用。
  remoteViews: (agentDeviceId) => readDeviceProviderCatalog(remoteBackgroundInvoke, agentDeviceId),
  remotePluginEngines: (agentDeviceId) => readRemotePluginEngines(agentDeviceId).catch(() => null),
  scope: activeOwnerScopeKey,
  now: Date.now,
  pricing: async () => ({ gateway: await getGatewayModelPricing(), reference: getReferenceModelPricing() }),
});

const switchOfferDeps = {
  readBinding: readModelGroupSessionBinding,
  readSession: getSessionRowSnapshot,
  isShared: isSessionSharedTaskActive,
  // 目标还没就绪时说不清这个任务有没有目标：按有处理，不提议。
  hasGoal: async (sessionId: string) => {
    const goals = getGoalController();
    return !goals || (await goals.getStatus(sessionId).catch(() => null)) !== null;
  },
  config: readModelGroupsConfigForSelected,
  candidateFacts: resolver.candidateFacts,
  now: Date.now,
};

export async function readModelGroupRecoveryOffer(sessionId: string, recovery?: NonNullable<Parameters<typeof computeModelGroupSwitchOffer>[2]>) {
  // 刚启动时别处的目录还没读过：合并路由里在别处的成员要算进来，等一轮(有时限)，否则这次认不出任务用的路由。
  await refreshAutoModelGroupRoutes({ waitRemote: true });
  return computeModelGroupSwitchOffer(switchOfferDeps, sessionId, recovery);
}

/**
 * 伙伴与定时任务按组的规则挑一个来源(model-groups.md §6.2)：与新任务同一个解析，不限运行位置。
 * 组已删除或此刻都用不了时为 null，调用方沿用存下的具体模型。dryRun 只看会选谁；否则 `commit`
 * 要在这个来源真的用上之后再调(推进「轮流」、记进「最近的选择」)。
 */
export async function pickModelGroupRoute(groupId: string, options: { dryRun: boolean }) {
  let result: Awaited<ReturnType<typeof resolver.resolve>>;
  try {
    result = await resolver.resolve({ selection: { type: 'route', id: groupId }, dryRun: options.dryRun });
  } catch (error) {
    // 伙伴的消息不能因为选路本身出错(读目录、读额度失败)发不出去：null = 沿用存下的模型(2026-11-26 排查)。
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
