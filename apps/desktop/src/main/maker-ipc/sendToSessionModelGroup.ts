/**
 * send_to_session 新建任务时按模型组的模式选来源。规则见 docs/product-rules/model-groups.md §6.3：
 * 与 Lead 建 Worker(§6.2)同一个选路与同一个 resolver 实例；选中的引擎、模型、供应商连接与 Agent 位置
 * 作为固定路线交给原有的新建流程，任务建好、首条消息被接受后才提交(推进「轮流」、记「最近的选择」)。
 */
import type { ModelGroupResolveRequest, ModelGroupResolveResult } from '../../shared/modelGroups';
import { routeWorkerByModelGroup, type WorkerModelGroupRouting } from './orcaWorkerModelGroup';
import type { SendToSessionExecutionOverrides } from './sendToSessionExecutionConfig';

/** 模式决定引擎、模型、来源位置与推理强度；这些参数与 model_group_id 同时出现即冲突(fast 可传)。 */
export function sendToSessionModelGroupConflict(request: {
  targetSessionId?: string;
  execution?: SendToSessionExecutionOverrides;
  agentDeviceId?: string | null;
}): string | null {
  if (request.targetSessionId !== undefined) {
    return 'model_group_id only applies when creating a task; an existing task keeps its model. Omit model_group_id or target_session_id.';
  }
  const owned = [
    request.execution?.agentKind !== undefined ? 'agent_kind' : null,
    request.execution?.model !== undefined ? 'model' : null,
    request.execution?.effort !== undefined ? 'effort' : null,
    request.agentDeviceId !== undefined ? 'provider_device_id (agent_device_id)' : null,
  ].filter((name): name is string => name !== null);
  return owned.length > 0
    ? `model_group_id chooses the Agent, model, provider, location and effort; remove ${owned.join(', ')} or omit model_group_id.`
    : null;
}

/**
 * 按模式选一次。send_to_session 不带图片，图片例外不生效；时段例外照常。没有能用的来源或模式已删除时
 * 直接失败，不回退到来源任务的模型(调用方没有选过别的模型，偷偷沿用等于替用户做了选择)。
 */
export function routeSendToSessionByModelGroup(
  modelGroupId: string,
  resolve: ((request: ModelGroupResolveRequest) => Promise<ModelGroupResolveResult>) | undefined,
): Promise<WorkerModelGroupRouting> {
  return routeWorkerByModelGroup(modelGroupId, { hasImages: false }, resolve, 'task');
}
