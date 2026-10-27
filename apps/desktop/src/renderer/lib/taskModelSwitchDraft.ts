import type { AgentKind } from '@cindy/model-providers';

/**
 * 已有任务里换模后，怎么写回新建任务默认的判定(纯函数，ChatInput 的写回入口只执行结果)。
 *
 * - `modelOnly`：同引擎，且写回的来源就是任务换模前的来源 = 只换了模型，来源是沿用任务的
 *   而不是这次选的。交给 patchVendorPrefsFromTaskModelSwitch 判断新建默认是否在同一来源。
 * - `sourceUnknown`：任务来源确认不了(跟随默认路由且模型 / 来源被停用)、这次写回又没带显式
 *   来源，无法确认新建默认是否在同一来源，保守地不打显式选择标记(走只同步路径)。
 *
 * 任务当前模型被停用时 `effectiveSourceId` 会是 null，任务自己记着的显式来源
 * (`initialProviderId`)仍然有效，用它识别同来源换模。
 */
export function resolveTaskModelSwitchDraftWrite(input: {
  requestedMarkModelChoice: boolean;
  agentKind: AgentKind;
  currentAgentKind: AgentKind | null | undefined;
  activeProviderId: string | null | undefined;
  memoryProviderId: string | null | undefined;
  effectiveSourceId: string | null | undefined;
  initialProviderId: string | null | undefined;
}): {
  markModelChoice: boolean;
  modelOnly: boolean;
  sourceUnknown: boolean;
  taskProviderId: string | null;
  /** 写回草稿用的来源：只换模型时是已确认的任务来源，否则是这次显式选的来源。 */
  draftProviderId: string | null;
} {
  const sameEngine = input.agentKind === input.currentAgentKind;
  // 记忆 / 生效来源优先于持久化的显式来源：Auto 被服务端搬走后，后者可能已过期。
  const taskProviderId = input.memoryProviderId ?? input.activeProviderId ?? null;
  const taskSourceId = input.effectiveSourceId ?? input.initialProviderId ?? null;
  const sourceUnknown =
    input.requestedMarkModelChoice && sameEngine && !taskSourceId && !input.activeProviderId;
  const markModelChoice = input.requestedMarkModelChoice && !sourceUnknown;
  const modelOnly = markModelChoice && sameEngine && !!taskSourceId && taskProviderId === taskSourceId;
  const draftProviderId = modelOnly ? taskProviderId : (input.activeProviderId ?? null);
  return { markModelChoice, modelOnly, sourceUnknown, taskProviderId, draftProviderId };
}
