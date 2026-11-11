/** 模型组的 IPC：读写配置、解析选中的路线或模式。只接受可信的主界面。 */
import { ipcMain } from 'electron';

import {
  MODEL_GROUPS_IPC,
  normalizeModelGroupsConfig,
  sanitizeModelGroupSelection,
  type ModelGroupResolveRequest,
  type ModelGroupTraceQuota,
} from '../../shared/modelGroups.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getPluginModelPickerAgents, isPluginRouteHarnessInstalled } from '../cindy-brain/ghostModelPicker.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { getQuotaOverviewService } from '../quota-overview/service.js';
import { getGatewayModelPricing } from '../usage/modelPricing.js';
import { getReferenceModelPricing } from '../usage/referenceModelPricing.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { recordModelGroupDecision } from './decisionLog.js';
import { createModelGroupResolver } from './resolver.js';
import { readModelGroupsConfig, writeModelGroupsConfig } from './store.js';

/** 选路时让额度总览保持采集这么久；面板没开时它平时不采集。 */
const QUOTA_LEASE_MS = 5 * 60_000;
/** 等一份新额度最多这么久，等不到就用已有的；不让新任务卡在读额度上。 */
const QUOTA_WAIT_MS = 2_000;

async function localQuotaWindows() {
  const overview = getQuotaOverviewService();
  overview.lease(QUOTA_LEASE_MS);
  const build = await overview.fresh(QUOTA_WAIT_MS);
  const byProvider = new Map<string, (ModelGroupTraceQuota & { scopedTo?: string | null })[]>();
  for (const source of build?.input.sources ?? []) {
    // 别的电脑上的同名账号不是本机这个连接的额度。
    if (source.kind !== 'subscription' || source.device) continue;
    byProvider.set(source.providerId, source.windows.map((window) => ({
      usedPercent: window.usedPercent,
      resetAtMs: window.resetsAtMs,
      windowMs: window.windowMinutes * 60_000,
      ...(window.kind === 'scoped' ? { scopedTo: window.label ?? null } : {}),
    })));
  }
  return byProvider;
}

const resolver = createModelGroupResolver({
  config: readModelGroupsConfig,
  views: () => getDesktopProviderService({ allowSideEffects: false }).listProviders({ allowSideEffects: false, snapshotOnly: true }),
  agents: getPluginModelPickerAgents,
  harnessInstalled: (agent) => isPluginRouteHarnessInstalled(agent),
  quotaWindows: localQuotaWindows,
  scope: activeOwnerScopeKey,
  now: Date.now,
  pricing: async () => ({ gateway: await getGatewayModelPricing(), reference: getReferenceModelPricing() }),
});

export function registerModelGroupsIpc(): void {
  ipcMain.handle(MODEL_GROUPS_IPC.GET, (event) => {
    assertTrustedAppRendererEvent(event);
    return readModelGroupsConfig();
  });
  ipcMain.handle(MODEL_GROUPS_IPC.SET, (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (!raw || typeof raw !== 'object') throwIpcError('INVALID_PARAMS', 'model groups config must be an object');
    return writeModelGroupsConfig(normalizeModelGroupsConfig(raw));
  });
  ipcMain.handle(MODEL_GROUPS_IPC.RESOLVE, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const selection = sanitizeModelGroupSelection(value.selection);
    if (!selection) throwIpcError('INVALID_PARAMS', 'model group selection is required');
    const context = value.context && typeof value.context === 'object' ? value.context as Record<string, unknown> : null;
    const request: ModelGroupResolveRequest = {
      selection,
      dryRun: value.dryRun === true,
      ...(context?.hasImages === true ? { context: { hasImages: true } } : {}),
    };
    const result = await resolver.resolve(request);
    // 设置页的「试一下」不算一次真实选择。
    if (!request.dryRun) recordModelGroupDecision(selection, result);
    return result;
  });
}
