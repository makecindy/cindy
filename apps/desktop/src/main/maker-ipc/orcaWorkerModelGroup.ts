/**
 * Lead 用模型组(模式)创建 Worker：创建时按模式规则选一次来源，再交给原有的 Worker 创建与校验。
 * 规则见 docs/product-rules/model-groups.md §6.4。选路凭据只留在宿主里，Worker 真正建好、首条任务送出后
 * 才由生命周期提交(推进「轮流」、记「最近的选择」)；冲突、选不到与创建失败都不提交。
 */
import type { AgentKind } from '@cindy/maker-core';

import type {
  ModelGroupAppliedException,
  ModelGroupResolveRequest,
  ModelGroupResolveResult,
  ModelGroupTraceWhy,
} from '../../shared/modelGroups';

/** 成功结果里带回的模式事实；decisionId 只在宿主内部流转，不进工具回执。 */
export interface WorkerModelGroupResolution {
  routeId: string;
  groupName: string;
  why: ModelGroupTraceWhy;
  modelName: string;
  sourceName: string;
  exceptions?: ModelGroupAppliedException[];
  decisionId?: string;
}

export function withoutModelGroupDecision(group: WorkerModelGroupResolution): WorkerModelGroupResolution {
  const { decisionId: _decisionId, ...rest } = group;
  return rest;
}

const WORKER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
type WorkerEffort = (typeof WORKER_EFFORTS)[number];

/** 模式决定引擎、模型、来源、Agent 位置与推理强度；这些参数与 model_group_id 同时出现即冲突。 */
const ROUTE_OWNED_FIELDS = [
  ['agent', 'agent'],
  ['model', 'model'],
  ['providerId', 'provider_id'],
  ['agentDeviceId', 'agent_device_id'],
  ['effort', 'effort'],
] as const;

export function workerModelGroupConflict(request: {
  agent?: unknown; model?: unknown; providerId?: unknown; agentDeviceId?: unknown; effort?: unknown;
  executionDeviceId?: unknown;
}): string | null {
  const owned = ROUTE_OWNED_FIELDS.filter(([key]) => request[key] !== undefined).map(([, name]) => name);
  if (owned.length > 0) {
    return `model_group_id chooses the Agent, model, provider, location and effort; remove ${owned.join(', ')} or omit model_group_id.`;
  }
  // 模式的来源位置相对这台电脑记录；运行设备上 "local" 指那台，不能直接套用。
  if (request.executionDeviceId !== undefined) {
    return 'model_group_id is only supported for Workers on the Lead\'s computer; omit execution_device_id or choose an explicit model.';
  }
  return null;
}

const agentOf = (kind: 'cc' | 'codex' | 'pi'): AgentKind => (kind === 'cc' ? 'claude-code' : kind);

function unavailableSummary(result: Extract<ModelGroupResolveResult, { outcome: 'missing' | 'unavailable' }>): string {
  const counts = new Map<ModelGroupTraceWhy, number>();
  for (const entry of result.trace) counts.set(entry.why, (counts.get(entry.why) ?? 0) + 1);
  const labels: Partial<Record<ModelGroupTraceWhy, string>> = {
    off: 'turned off', unavailable: 'not connected or unreachable', limited: 'out of quota', noVision: 'cannot read images',
  };
  const parts = [...counts].map(([why, count]) => `${count} ${labels[why] ?? why}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

export type WorkerModelGroupRouting =
  | {
      ok: true;
      route: { agent: AgentKind; model: string; providerId: string; agentDeviceId: string | null; effort?: WorkerEffort };
      modelGroup: WorkerModelGroupResolution;
    }
  | { ok: false; errorCode: 'MODEL_GROUP_NOT_FOUND' | 'MODEL_GROUP_UNAVAILABLE'; message: string };

/**
 * 按模式选一次。没有可用来源或模式已删除时直接失败，不回退到 Worker 记忆或默认模型(Lead 没有选过别的模型，
 * 偷偷换成默认值等于替用户做了选择)。
 */
export async function routeWorkerByModelGroup(
  routeId: string,
  context: { hasImages: boolean },
  resolve: ((request: ModelGroupResolveRequest) => Promise<ModelGroupResolveResult>) | undefined,
  /** 失败说明里「什么没建」：Worker 或 send_to_session 新建的任务。 */
  subject: 'Worker' | 'task' = 'Worker',
): Promise<WorkerModelGroupRouting> {
  if (!resolve) {
    return { ok: false, errorCode: 'MODEL_GROUP_UNAVAILABLE', message: 'Model groups are not available on this computer.' };
  }
  const result = await resolve({
    selection: { type: 'route', id: routeId },
    ...(context.hasImages ? { context: { hasImages: true } } : {}),
  });
  if (result.outcome === 'missing') {
    return {
      ok: false,
      errorCode: 'MODEL_GROUP_NOT_FOUND',
      message: `Model group mode "${routeId}" does not exist for this account on this computer; call list_model_groups and retry.`,
    };
  }
  if (result.outcome !== 'routed') {
    return {
      ok: false,
      errorCode: 'MODEL_GROUP_UNAVAILABLE',
      message: `No source in model group mode "${result.groupName}" can be used now${unavailableSummary(result)}. No ${subject} was created.`,
    };
  }
  const effort = WORKER_EFFORTS.find((item) => item === result.route.effort);
  return {
    ok: true,
    route: {
      agent: agentOf(result.route.agentKind),
      model: result.route.model,
      providerId: result.route.providerId,
      // 本机来源显式为 null：省略会让 Worker 跟 Lead 的位置，在 Lead 用远程 Agent 时查错目录。
      agentDeviceId: result.route.agentDeviceId ?? null,
      ...(effort ? { effort } : {}),
    },
    modelGroup: {
      routeId,
      groupName: result.groupName,
      why: result.why,
      modelName: result.modelName,
      sourceName: result.sourceName,
      ...(result.exceptions ? { exceptions: result.exceptions } : {}),
      ...(result.decisionId ? { decisionId: result.decisionId } : {}),
    },
  };
}
