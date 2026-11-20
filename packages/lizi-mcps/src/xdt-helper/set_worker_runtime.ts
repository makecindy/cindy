/**
 * xdt-helper/set_worker_runtime.ts —— Lead 给自己团队里已开始的 Worker 换引擎、模型、来源、
 * 推理强度与 Fast。与用户在 Worker 任务的模型面板里重新选择同一套宿主事务：选择登记后在下一条
 * send_to_worker 时生效，已有待生效选择时省略 agent 即修改那次选择。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';

const EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
type WorkerRuntimeAgent = 'claude-code' | 'codex' | 'pi';
type WorkerRuntimeEffort = (typeof EFFORT_VALUES)[number];

export interface WorkerRuntimeProfile {
  agentKind: WorkerRuntimeAgent;
  model: string;
  providerId: string | null;
  effort: WorkerRuntimeEffort | null;
  fastMode: boolean | 'ultrafast';
}

export interface SetWorkerRuntimeDeps {
  getSessionContext?: () => { sessionId?: string };
  setWorkerRuntime: (params: {
    callerLeadSessionId: string;
    workerId: string;
    expectedGeneration?: number;
    patch: {
      harness?: WorkerRuntimeAgent;
      model?: string;
      providerId?: string | null;
      effort?: WorkerRuntimeEffort;
      fastMode?: boolean | 'ultrafast';
    };
  }) => Promise<
    ControlResult<
      {
        workerId: string;
        sessionId: string;
        status: 'applied' | 'deferred';
        effectiveBoundary?: 'next_send';
        generation: number;
        effectiveProfile: WorkerRuntimeProfile;
        pendingMutation: { generation: number; source: string; profile: WorkerRuntimeProfile } | null;
      },
      | 'WORKER_NOT_FOUND'
      | 'REMOTE_WORKER_NOT_SUPPORTED'
      | 'CONFLICT'
      | 'INVALID_ARGS'
      | 'ROUTE_UNAVAILABLE'
      | 'UNSUPPORTED_CAPABILITY'
      | 'NOT_FOUND'
    >
  >;
}

const DESCRIPTION =
  '给你团队里已开始的 Worker 换引擎(agent)、模型、来源、推理强度或 Fast，与用户在该 Worker 任务的模型面板里重新选择效果相同；' +
  '对话、工作目录与未提交改动都保留。Worker 撞用量上限、模型不可用或要换更合适的模型时用它，不要归档重建。' +
  '先用 list_available_models 确认 model 与 provider_id。提供 agent 时必须同时给 model；' +
  '选择在下一条 send_to_worker 时生效(effective_boundary=next_send)，宿主先换到新路线再启动 Worker；' +
  'Worker 已有待生效的选择时，省略 agent 即修改那次选择(未给的字段沿用它)，否则省略 agent 的调整在 Worker 当前轮结束后生效。' +
  '运行在另一台电脑上的 Worker 不支持(REMOTE_WORKER_NOT_SUPPORTED)。' +
  'expected_generation 可选：传 get_session_runtime 读到的 generation 可防止覆盖并发修改，省略则以调用时的状态为准。' +
  '失败码: LEAD_NOT_SUPPORTED / WORKER_NOT_FOUND / REMOTE_WORKER_NOT_SUPPORTED / INVALID_ARGS / CONFLICT(状态已变，重读后再试) / ' +
  'ROUTE_UNAVAILABLE(该模型或来源当前不可用) / UNSUPPORTED_CAPABILITY。';

function profilePayload(profile: WorkerRuntimeProfile) {
  return {
    agent: profile.agentKind,
    model: profile.model,
    provider_id: profile.providerId,
    effort: profile.effort,
    fast: profile.fastMode,
  };
}

export function registerSetWorkerRuntimeTool(
  registry: XdtHelperToolRegistry,
  deps: SetWorkerRuntimeDeps,
): void {
  registry.register({
    name: 'set_worker_runtime',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      worker_id: z.string().min(1).describe('目标 worker 的 worker_id 或 session_id 任一'),
      agent: z.enum(['claude-code', 'codex', 'pi']).optional().describe('目标执行引擎；提供时必须同时指定 model。'),
      model: z.string().min(1).optional().describe('目标模型 id(取 list_available_models 的 id)。'),
      provider_id: z
        .string()
        .min(1)
        .nullable()
        .optional()
        .describe('来源 id(取 list_available_models 的 providers[].provider_id)；null 表示该模型的默认来源；省略表示保持。'),
      effort: z.enum(EFFORT_VALUES).optional().describe('推理强度；省略表示保持。'),
      fast: z.union([z.boolean(), z.literal('ultrafast')]).optional()
        .describe('false=标准，true=快速，ultrafast=超快(仅支持该档位的 Codex 模型)；省略表示保持。'),
      expected_generation: z.number().int().nonnegative().optional()
        .describe('可选：get_session_runtime 读到的 generation，用于防止覆盖并发修改。'),
    },
    handler: async ({ worker_id, agent, model, provider_id, effort, fast, expected_generation }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝 worker 控制操作。');
      }
      if (agent !== undefined && !model) {
        return errorPayload('INVALID_ARGS', '提供 agent 时必须同时指定目标 model。');
      }
      if (model === undefined && provider_id === undefined && effort === undefined && fast === undefined) {
        return errorPayload('INVALID_ARGS', '至少提供 model、provider_id、effort 或 fast 之一。');
      }
      const result = await deps.setWorkerRuntime({
        callerLeadSessionId: ctx.sessionId,
        workerId: worker_id,
        ...(expected_generation !== undefined ? { expectedGeneration: expected_generation } : {}),
        patch: {
          ...(agent !== undefined ? { harness: agent } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(provider_id !== undefined ? { providerId: provider_id } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(fast !== undefined ? { fastMode: fast } : {}),
        },
      });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程协同服务尚未就绪。`);
        }
        return errorPayload(result.errorCode, result.message);
      }
      const nextSend = result.status === 'deferred' && result.effectiveBoundary === 'next_send';
      return okPayload({
        worker_id: result.workerId,
        session_id: result.sessionId,
        status: result.status,
        effective_boundary: result.effectiveBoundary ?? (result.status === 'deferred' ? 'next_turn' : 'immediate'),
        generation: result.generation,
        effective: profilePayload(result.effectiveProfile),
        pending: result.pendingMutation
          ? {
              generation: result.pendingMutation.generation,
              source: result.pendingMutation.source,
              profile: profilePayload(result.pendingMutation.profile),
            }
          : null,
        instruction: nextSend
          ? 'Route staged. It takes effect when you next send_to_worker to this Worker; the new route starts with its conversation.'
          : result.status === 'deferred'
            ? 'Change accepted. It takes effect when the Worker finishes its current turn.'
            : 'Change applied.',
      });
    },
  });
}
