import type { ModelGroupTraceQuota } from '../../shared/modelGroups.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getPluginModelPickerAgents, isPluginRouteHarnessInstalled } from '../cindy-brain/ghostModelPicker.js';
import { remoteBackgroundInvoke } from '../device-link/index.js';
import { isSessionSharedTaskActive } from '../device-link/sharedTaskDispatch.js';
import { getGoalController } from '../goal-host/index.js';
import { getSessionRowSnapshot } from '../localDb/sessionDispatchSnapshot.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { readWorkerAgentLocations } from '../maker-ipc/workerAgentLocations.js';
import { getQuotaOverviewService } from '../quota-overview/service.js';
import { getGatewayModelPricing } from '../usage/modelPricing.js';
import { getReferenceModelPricing } from '../usage/referenceModelPricing.js';
import { readDeviceProviderCatalog } from '../remote-agent/controller/deviceCatalog.js';
import { recordModelGroupDecision } from './decisionLog.js';
import { createModelGroupResolver, modelGroupQuotaKey, MODEL_GROUP_REMOTE_WAIT_MS } from './resolver.js';
import { readModelGroupSessionBinding } from './sessionBindings.js';
import { readModelGroupsConfig } from './store.js';
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

export const resolver = createModelGroupResolver({
  config: readModelGroupsConfig,
  recordDecision: recordModelGroupDecision,
  views: () => getDesktopProviderService({ allowSideEffects: false }).listProviders({ allowSideEffects: false, snapshotOnly: true }),
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

export function readModelGroupRecoveryOffer(sessionId: string, recovery?: NonNullable<Parameters<typeof computeModelGroupSwitchOffer>[2]>) {
  return computeModelGroupSwitchOffer(switchOfferDeps, sessionId, recovery);
}
