/**
 * 把供应商组接到设备互联(docs/product-rules/provider-groups.md §4)：同账号其他电脑的
 * `provider-group:remote` 请求(含它们报告来的用量)，以及给它们的 `maker:provider:list` 补组摘要与运行数。
 * 组摘要只服务同账号电脑，dispatch 已拒绝受邀者与共享任务访客；受邀者的台数由本接口提供，匿名状态另由受邀者分配器提供(§8)。
 */
import { setProviderGroupRemoteHandler } from '../device-link/dispatch.js';
import { isRemoteProviderInvocationAllowed } from '../maker-host/remote-provider-access-store.js';
import { currentProviderPartyUsageStore } from '../usage/providerPartyUsageStore.js';
import {
  decorateProviderListWithGroups,
  handleProviderGroupRemote,
  sharedProviderGroupSize,
  type ProviderGroupRemoteHandlerDeps,
} from './remoteHandler.js';
import {
  getProviderGroupOwnerScope,
  readProviderGroupOfSession,
  readProviderGroupRebalanceSuggestion,
  readProviderRunningTurnsByProvider,
  recordProviderGroupRebalanceDecision,
} from './runtime.js';
import { readProviderGroup } from './store.js';
import { isProviderManagementRequest } from '../../shared/providerManagement.js';
import { handleProviderManagementRequest } from './management.js';
import { bindGroupFastPolicy } from './fastPolicyRuntime.js';

export function registerProviderGroupRemoteHandler(options: { onGroupChanged?: (providerId: string) => void } = {}): void {
  const deps: ProviderGroupRemoteHandlerDeps = {
    bindFastPolicy: bindGroupFastPolicy,
    scope: getProviderGroupOwnerScope,
    readGroup: readProviderGroup,
    isRemoteAllowed: isRemoteProviderInvocationAllowed,
    now: () => Date.now(),
    replaceReportedUsage: (controller, sinceDay, rows) =>
      currentProviderPartyUsageStore().replaceReported(controller, sinceDay, rows),
    sessionGroup: readProviderGroupOfSession,
    rebalanceSuggestion: readProviderGroupRebalanceSuggestion,
    rebalanceDecision: recordProviderGroupRebalanceDecision,
  };
  setProviderGroupRemoteHandler({
    handle: (controller, raw) => isProviderManagementRequest(raw)
      ? handleProviderManagementRequest(raw, options) : handleProviderGroupRemote(deps, controller, raw),
    decorateProviderList: async (result) =>
      decorateProviderListWithGroups(result, readProviderGroup, await readProviderRunningTurnsByProvider()),
    sharedGroupSize: (providerId) => sharedProviderGroupSize(deps, providerId),
  });
}
