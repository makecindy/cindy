/**
 * xdt-helper/create_worker.ts —— 在 active workflow 内创建新 worker session。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlDispatchOutcome, ControlResult, ControlWorkerAgent } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';

const WORKER_LABEL_PATTERN = /^[a-z0-9_-]+$/i;

/** Worker 数量闸的结构化快照；批量编排据此生成稳定汇总。 */
export interface WorkerLimitSnapshot {
  workerHardLimit: number;
  occupiedSlots: number;
  remainingSlots: number;
}

type CreateWorkerErrorCode =
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'WORKER_LIMIT_HARD_EXCEEDED'
  | 'DUPLICATE_LABEL'
  | 'WORKER_CREATION_IN_PROGRESS'
  | 'BUDGET_MODEL_REQUIRES_API_MODE'
  | 'NO_PROVIDER_FOR_AGENT'
  | 'PROVIDER_ROUTE_UNAVAILABLE';

interface CreateWorkerSuccessData {
  workerId: string;
  workerSessionId: string;
  softLimitExceeded?: boolean;
  dispatched?: boolean;
  dispatchOutcome?: ControlDispatchOutcome;
  queuedMessageId?: string;
}

export type CreateWorkerControlResult = ControlResult<CreateWorkerSuccessData, CreateWorkerErrorCode> & {
  limit?: WorkerLimitSnapshot;
};

export interface CreateWorkerDeps {
  sessionId: string | undefined;
  vendorOptions?: Record<string, unknown>;
  getSessionContext?: () => {
    sessionId?: string;
    vendorOptions?: Record<string, unknown>;
  };
  createWorker: (params: {
    leadSessionId: string;
    role: string;
    agent: ControlWorkerAgent;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    fast?: boolean;
    label: string;
    initialTask?: string;
  }) => Promise<CreateWorkerControlResult>;
}

/** 单个 worker 的稳定输入 schema；create_worker/create_workers 共用。 */
export const createWorkerSpecSchema = z.object({
  role: z
    .string()
    .min(1)
    .max(32)
    .describe('worker 角色: developer / reviewer / tester / merger 或自定义 string'),
  agent: z
    .enum(['claude-code', 'codex', 'pi'])
    .describe('worker agent 类型'),
  model: z
    .string()
    .optional()
    .describe('可选, worker 使用的模型 id; 不传走 host 端默认 fallback'),
  effort: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    .optional()
    .describe('可选, reasoning/thinking 强度。Codex GPT worker 支持 low/medium/high/xhigh，部分模型(如 GPT-5.6 Sol)还支持 max/ultra；Claude 支持到 max。显式传入时必须匹配所选 model 能力；当前 worker 模型都不把 minimal 作为可选档。'),
  fast: z
    .boolean()
    .optional()
    .describe('可选, 是否给 worker 开启 Fast 模式。对 codex 与 pi worker 生效(且需所选模型支持 Fast); claude-code 忽略。不传则继承默认。'),
  label: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(WORKER_LABEL_PATTERN)
    .describe('worker 短标识, 1-32 chars, 只能含字母、数字、-、_, 同 workflow 内唯一'),
  initial_task: z
    .string()
    .min(1)
    .optional()
    .describe('可选, 创建后立即派给 worker 的第一条消息'),
}).strict();

export type CreateWorkerSpec = z.infer<typeof createWorkerSpecSchema>;

/** MCP payload 使用 snake_case，host 内部继续使用 camelCase。 */
export function toWorkerLimitPayload(limit: WorkerLimitSnapshot | undefined): Record<string, number> | undefined {
  if (!limit) return undefined;
  return {
    hard_limit: limit.workerHardLimit,
    occupied_slots: limit.occupiedSlots,
    remaining_slots: limit.remainingSlots,
  };
}

const DESCRIPTION = [
  '在当前 workflow 内创建新 worker session。',
  '注:create_worker 建的是 Orca worker(session 级、持久、UI 可见),不是 subagent。若用户要的是 subagent(一次性、用完即弃),请用你自己的原生 subagent 机制(如 Codex 的 spawn_agent、Claude Code 的 Task 工具),不要用 create_worker。' +
  'Orca worker 永远不是 subagent 的替代品;你没有原生 subagent 机制时,如实告知用户并请他决定,不要拿 worker 顶替。',
  '用户一次要求创建 2 个及以上 Worker 时必须改用 create_workers；不要并行或连续多次调用 create_worker。',
  '',
  '参数:',
  '- role: worker 角色 (developer / reviewer / tester / merger 或自定义 string)',
  '- agent: worker agent 类型 (codex / claude-code / pi)',
  '- model: 可选, worker 使用的模型 id; 不传走 host 端默认 fallback',
  '- effort: 可选, reasoning/thinking 强度 (low / medium / high / xhigh / max / ultra)。Codex: 映射 OpenAI reasoning effort(max/ultra 仅部分模型如 GPT-5.6 Sol 支持); Claude Code: 映射 extended thinking token 预算(无 ultra,自动降级为 max)。显式传入时必须匹配所选 model 能力；当前 worker 模型都不把 minimal 作为可选思考档。',
  '- fast: 可选 boolean, 是否给 worker 开启 Fast 模式 (更快输出)。用户明确说「fast / 快速 / 开/关 fast」时显式传。对 codex 与 pi worker 生效 (且需所选模型声明 supportsFastMode; 否则自动降级为关); claude-code worker 忽略此参数 (其 fast mode 在 agent 层为 no-op)。不传则继承默认 (New Maker 面板默认或 lead session 的 fastMode)。',
  '- label: worker 短标识, 1-32 chars, 只能含字母、数字、-、_, 同 workflow 内唯一, 用于 switch_focus 定位',
  "- initial_task: 可选, 创建后立即派给 worker 的第一条消息；dispatch_outcome.wakeKind=queued 表示首条任务已成功入队(此时回传 queued_message_id, 被消费前可用 list_worker_queue / update_queued_message / cancel_queued_message 管理)；dispatch_outcome.kind='session-dispatch' 且 dispatched=false，或 kind='host-send' 且 accepted=false，表示 worker 已创建但首条任务未送达 / 派发失败",
  '',
  '【硬边界】',
  '- worker 数量达软上限 → 创建仍成功, payload.warning = WORKER_LIMIT_SOFT_EXCEEDED',
  '- worker 数量达硬上限 → 返 WORKER_LIMIT_HARD_EXCEEDED (拒绝创建)',
  '- label 在同 workflow 内重复 → 返 DUPLICATE_LABEL',
  '- 同 label 的另一个 Worker 正在创建 → 返 WORKER_CREATION_IN_PROGRESS',
  '- 当前 lead session 不存在或没有 active team → 返 NOT_FOUND',
  '- role / label / model 等参数不合法 → 返 INVALID_PARAMS',
  '- 选了 tier=budget (codex/ 前缀模型) 但当前 Codex 不在 API key 模式 → 返 BUDGET_MODEL_REQUIRES_API_MODE: 应如实告知用户「该模型需切换到 API key 模式才能使用」, 不要擅自改用官方版顶替 (除非用户明确同意)。',
  '- 该 agent 没有任何已连接的模型供应商 (provider) → 返 NO_PROVIDER_FOR_AGENT: 应如实把 message 转告用户 (去「设置 → 模型供应商」连接一个支持该 agent 的供应商), 或按 message 建议改用「已连接供应商的另一个 agent」创建 worker; 不要反复重试同一 agent。',
  '- Worker 解析出的精确 provider + model 路由当前不可用 → 返 PROVIDER_ROUTE_UNAVAILABLE: 应如实把 message 转告用户并调整模型或供应商; 不要按“完全没有供应商”处理，也不要反复重试同一路由。',
].join('\n');

export function registerCreateWorkerTool(
  registry: XdtHelperToolRegistry,
  deps: CreateWorkerDeps,
): void {
  registry.register({
    name: 'create_worker',
    category: 'control',
    description: DESCRIPTION,
    inputShape: createWorkerSpecSchema.shape,
    handler: async ({ role, agent, model, effort, fast, label, initial_task }) => {
      const ctx = deps.getSessionContext?.() ?? deps;
      if (!ctx.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead。');
      }
      if (ctx.vendorOptions?.orcaRole === 'worker') {
        return errorPayload(
          'WORKER_CANNOT_NEST',
          'create_worker 是 Orca Lead 创建 worker session 的入口,不是 subagent 入口。若用户明确要求 subagent / 子代理,请使用你自己的原生 subagent 机制(如 Codex 的 spawn_agent、Claude Code 的 Task/Agent 工具),不要使用 Orca create_worker / start_team。没有原生 subagent 机制时如实告知用户,Orca worker 不是它的替代品。',
        );
      }
      const result = await deps.createWorker({
        leadSessionId: ctx.sessionId,
        role,
        agent,
        model,
        effort,
        fast,
        label,
        initialTask: initial_task,
      });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程协同服务尚未就绪。`);
        }
        return errorPayload(result.errorCode, result.message, {
          ...(result.limit ? { limit: toWorkerLimitPayload(result.limit) } : {}),
        });
      }
      return okPayload({
        worker_id: result.workerId,
        worker_session_id: result.workerSessionId,
        role,
        agent,
        label,
        ...(result.dispatched !== undefined ? { dispatched: result.dispatched } : {}),
        ...(result.dispatchOutcome ? { dispatch_outcome: result.dispatchOutcome } : {}),
        ...(result.queuedMessageId ? { queued_message_id: result.queuedMessageId } : {}),
        ...(result.softLimitExceeded ? { warning: 'WORKER_LIMIT_SOFT_EXCEEDED' } : {}),
        ...(result.limit ? { limit: toWorkerLimitPayload(result.limit) } : {}),
      });
    },
  });
}
