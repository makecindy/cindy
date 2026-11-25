import type { ProviderView } from '@cindy/model-providers';
import type { ModelGroupTraceQuota } from '../../shared/modelGroups.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getPluginModelPickerAgents, isPluginModelPickerRouteAvailable, isPluginRouteHarnessInstalled } from '../cindy-brain/ghostModelPicker.js';
import { remoteBackgroundInvoke } from '../device-link/index.js';
import { isSessionSharedTaskActive } from '../device-link/sharedTaskDispatch.js';
import { getGoalController } from '../goal-host/index.js';
import { getSessionRowSnapshot } from '../localDb/sessionDispatchSnapshot.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { isRemoteProviderInvocationAllowed } from '../maker-host/remote-provider-access-store.js';
import { readWorkerAgentLocations } from '../maker-ipc/workerAgentLocations.js';
import { getQuotaOverviewService } from '../quota-overview/service.js';
import { getGatewayModelPricing } from '../usage/modelPricing.js';
import { getReferenceModelPricing } from '../usage/referenceModelPricing.js';
import { readDeviceProviderCatalog } from '../remote-agent/controller/deviceCatalog.js';
import { recordModelGroupDecision } from './decisionLog.js';
import { createModelGroupResolver, modelGroupQuotaKey, MODEL_GROUP_REMOTE_WAIT_MS } from './resolver.js';
import { readModelGroupSessionBinding } from './sessionBindings.js';
import { readModelGroupsConfig, setModelGroupSourceCatalog } from './store.js';
import { computeModelGroupSwitchOffer } from './switchOffer.js';


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
async function quotaWindows() {
  const overview = getQuotaOverviewService();
  overview.lease(QUOTA_LEASE_MS);
  const build = await overview.fresh(QUOTA_WAIT_MS);
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

/** 其他电脑与分享来的位置各自允许远程调用的供应商：按账号记，最多每分钟读一次。 */
let remoteCatalogs: { scope: string; at: number; value: Map<string, ProviderView[]> } | null = null;
let remoteReading: Promise<void> | null = null;
let lastLocal: { scope: string; views: ProviderView[] } | null = null;
const REMOTE_CATALOG_TTL_MS = 60_000;

function publishCatalog(): void {
  const scope = activeOwnerScopeKey();
  if (lastLocal?.scope !== scope) return;
  const views = lastLocal.views;
  setModelGroupSourceCatalog({
    views,
    agents: getPluginModelPickerAgents(),
    ...(remoteCatalogs?.scope === scope ? { remote: remoteCatalogs.value } : {}),
    // 与解析路由时同一个判断；别的位置上的来源按那个位置的目录看，执行时那台还会再拦一次。
    available: (candidate, locationViews, agents) =>
      isPluginModelPickerRouteAvailable({ ...candidate, effort: '', fastMode: false }, locationViews as ProviderView[], agents),
  });
}

/**
 * 读其他电脑与分享来的供应商目录(供应商路由的成员可以在那里)。只在有人读配置、选路或发消息时才读，没有定时器；
 * 同一时刻只读一轮，一分钟内不重读；每个位置读一次目录(与选择器列那台的模型是同一个请求)，各自最多等
 * MODEL_GROUP_REMOTE_WAIT_MS。这次没读到的位置沿用不了旧目录(对方可能已经收回)，按没有处理。
 */
function readRemoteCatalogs(): Promise<void> {
  const scope = activeOwnerScopeKey();
  if (remoteReading) return remoteReading;
  if (remoteCatalogs?.scope === scope && Date.now() - remoteCatalogs.at < REMOTE_CATALOG_TTL_MS) return Promise.resolve();
  const timeout = <T>(work: Promise<T>): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      work.catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MODEL_GROUP_REMOTE_WAIT_MS); }),
    ]).finally(() => clearTimeout(timer));
  };
  remoteReading = (async () => {
    const { locations } = await readWorkerAgentLocations();
    const entries = await Promise.all(locations.map(async ({ agentDeviceId }) => {
      const catalog = await timeout(readDeviceProviderCatalog(remoteBackgroundInvoke, agentDeviceId));
      return catalog && !catalog.stale ? [agentDeviceId, catalog.views] as const : null;
    }));
    if (scope !== activeOwnerScopeKey()) return;
    remoteCatalogs = { scope, at: Date.now(), value: new Map(entries.filter((entry): entry is readonly [string, ProviderView[]] => !!entry)) };
    publishCatalog();
  })().catch(() => undefined).finally(() => { remoteReading = null; });
  return remoteReading;
}

/**
 * 本机供应商目录的快照(不触发发现或登录)。每次读出来顺手交给配置读取：供应商路由按它合成和展开，取配置与
 * 解析路由都先读目录，所以两处看到的供应商路由与目录是同一时刻的。别处的目录在后台跟上，不让这里等。
 */
async function localViews() {
  const views = await getDesktopProviderService({ allowSideEffects: false }).listProviders({ allowSideEffects: false, snapshotOnly: true });
  lastLocal = { scope: activeOwnerScopeKey(), views };
  publishCatalog();
  void readRemoteCatalogs();
  return views;
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
  config: readModelGroupsConfig,
  recordDecision: recordModelGroupDecision,
  views: localViews,
  // 另一台电脑借这台跑 Agent 时只用开了「允许被远程调用」的连接(与设置里那个开关同一份)。
  remoteInvocable: isRemoteProviderInvocationAllowed,
  agents: getPluginModelPickerAgents,
  // 别的电脑上的引擎问那台的 maker:agent:status，与插件选路同一判断。
  harnessInstalled: (agent, agentDeviceId) => isPluginRouteHarnessInstalled(agent, agentDeviceId, async (deviceId, name) => {
    const result = await remoteBackgroundInvoke(deviceId, 'maker:agent:status', [name]);
    if (!result.ok) throw new Error(result.error?.message ?? 'Remote agent status unavailable');
    return result.result as { binaryReady?: boolean } | null | undefined;
  }),
  quotaWindows,
  // 其他电脑与分享来的来源：与插件卡片里的远程模型同一份位置名单与同一条目录读取。
  locations: readWorkerAgentLocations,
  // 带上 stale：读不到时底层会给上次的目录，选路不能把它当成那台现在能用。
  remoteViews: (agentDeviceId) => readDeviceProviderCatalog(remoteBackgroundInvoke, agentDeviceId),
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
  config: readModelGroupsConfig,
  candidateFacts: resolver.candidateFacts,
  now: Date.now,
};

export async function readModelGroupRecoveryOffer(sessionId: string, recovery?: NonNullable<Parameters<typeof computeModelGroupSwitchOffer>[2]>) {
  await refreshAutoModelGroupRoutes();
  return computeModelGroupSwitchOffer(switchOfferDeps, sessionId, recovery);
}

/**
 * 伙伴与定时任务按组的规则挑一个来源(model-groups.md §6.2)：与新任务同一个解析，不限运行位置。
 * 组已删除或此刻都用不了时为 null，调用方沿用存下的具体模型。dryRun 只看会选谁；否则 `commit`
 * 要在这个来源真的用上之后再调(推进「轮流」、记进「最近的选择」)。
 */
export async function pickModelGroupRoute(groupId: string, options: { dryRun: boolean }) {
  const result = await resolver.resolve({ selection: { type: 'route', id: groupId }, dryRun: options.dryRun });
  if (result.outcome !== 'routed') return null;
  const { decisionId } = result;
  return {
    route: result.route,
    commit: () => { if (decisionId) resolver.commit(decisionId); },
  };
}
