import { sessionControlRequestSchema } from '@cindy/maker-shared/session-controller-schema';
import { BRAND_NAME } from '@cindy/maker-shared/branding';
import type { AgentKind, Effort } from '@cindy/maker-core';
import type { SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';
import type { SessionCapability, SessionRuntimeSelection, SessionControllerSnapshot, SessionDiagnosis } from '@cindy/maker-shared/session-controller';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export type SessionQueueControlErrorCode =
  | 'NOT_FOUND'
  | 'QUEUED_MESSAGE_NOT_FOUND'
  | 'MESSAGE_CONSUMING'
  | 'NOT_AUTHORIZED'
  | 'INVALID_ARGS';

export type SessionSteerErrorCode =
  | 'NOT_FOUND'
  | 'NO_ACTIVE_TURN'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INPUT_LOCKED'
  | 'DELIVERY_FAILED';

export type SessionStopErrorCode = 'NOT_FOUND' | 'UNSUPPORTED_CAPABILITY' | 'CONFLICT';

export type SessionRuntimeProfile = SessionRuntimeSelection;

export interface SessionRuntimeSnapshot extends SessionActivitySnapshot {
  runtimeGeneration?: number;
  baselineProfile?: SessionRuntimeProfile;
  effectiveProfile?: SessionRuntimeProfile;
  pendingMutation?: {
    generation: number;
    source: 'agent' | 'fallback';
    profile: SessionRuntimeProfile;
  } | null;
  fallbackEnabled?: boolean;
}

export interface SessionControlDeps {
  listSessionDevices?(context: LiziMcpSessionContext): Promise<unknown>;
  controlSession?(request: unknown, context: LiziMcpSessionContext): Promise<unknown>;
  listActiveSessions?(): Promise<ControlResult<{ sessions: SessionControllerSnapshot[] }, 'NOT_FOUND'>>;
  sessionCapabilities?(sessionId: string): Promise<ControlResult<{ capabilities: SessionCapability[] }, 'NOT_FOUND'>>;
  inspectSession?(sessionId: string): Promise<ControlResult<{ snapshot: SessionControllerSnapshot }, 'NOT_FOUND'>>;
  diagnoseSession?(sessionId: string): Promise<ControlResult<{ diagnosis: SessionDiagnosis }, 'NOT_FOUND'>>;
  getSessionContext: () => LiziMcpSessionContext;
  updateQueuedMessage(params: {
    callerSessionId: string;
    targetSessionId: string;
    queuedMessageId: string;
    message: string;
  }): Promise<ControlResult<{ queuedMessageId: string }, SessionQueueControlErrorCode>>;
  cancelQueuedMessage(params: {
    callerSessionId: string;
    targetSessionId: string;
    queuedMessageId: string;
  }): Promise<ControlResult<{ queuedMessageId: string }, SessionQueueControlErrorCode>>;
  steerSession(params: {
    callerSessionId: string;
    targetSessionId: string;
    message: string;
  }): Promise<ControlResult<{ queuedMessageId: string }, SessionSteerErrorCode>>;
  stopSessionTurn(params: {
    targetSessionId: string;
  }): Promise<
    ControlResult<
      {
        status: 'no-active-turn' | 'waiting-for-safe-point' | 'requested' | 'unconfirmed';
        turnGeneration?: number;
        reason?: string;
      },
      SessionStopErrorCode
    >
  >;
  getSessionRuntime(params: {
    targetSessionId: string;
  }): Promise<ControlResult<{ runtime: SessionRuntimeSnapshot }, 'NOT_FOUND'>>;
  setSessionRuntime(params: {
    targetSessionId: string;
    expectedGeneration?: number;
    patch: {
      harness?: AgentKind;
      model?: string;
      providerId?: string | null;
      effort?: Effort;
      fastMode?: boolean;
    };
  }): Promise<
    ControlResult<
      {
        status: 'applied' | 'deferred';
        effectiveBoundary?: 'next_send';
        generation: number;
        effectiveProfile: SessionRuntimeProfile;
        pendingMutation: SessionRuntimeSnapshot['pendingMutation'];
      },
      'NOT_FOUND' | 'CONFLICT' | 'INVALID_ARGS' | 'ROUTE_UNAVAILABLE'
    >
  >;
}

export function registerSessionObservationTools(registry: XdtHelperToolRegistry, deps: SessionControlDeps): void {
  if (deps.listSessionDevices) registry.register({
    name: 'list_session_devices', category: 'control',
    description: '列出本机和设备互联目录中的 Cindy 设备，供任务控制选择 deviceId。在线或已连接不等于已经获得任务权限；执行时目标端仍会复核。',
    inputShape: {}, handler: async () => okPayload({ devices: await deps.listSessionDevices!(deps.getSessionContext()) }),
  });
  if (deps.controlSession) registry.register({
    name: 'control_session', category: 'control',
    description: '通过目标 Cindy 设备统一管理任务；操作和参数见 request schema。先读取 capabilities，设备在线不代表获得所有操作权限。listRecords/listActive/createRecord 不填 target，其余填写 {deviceId,sessionId}。createRecord 只建记录，ensureRuntime 才恢复运行实例；send 的受理或入队不表示完成。创建和发送重试复用原 businessKey，超时须对账。文件和目录必须属于目标设备及其 SSH 命名空间。权限批准等用户操作仍走已有宿主入口。跨设备伙伴只允许主人亲自发起的当前轮次，不自动授予其它项目权限。',
    inputShape: { request: sessionControlRequestSchema },
    handler: async ({ request }) => {
      const result = await deps.controlSession!(request, deps.getSessionContext()) as import('@cindy/maker-shared/session-controller').SessionControllerResult<unknown>;
      return result.ok ? okPayload({ result }) : errorPayload(result.errorCode, result.message, { requestId: result.requestId, idempotencyKey: result.idempotencyKey });
    },
  });
  if (deps.listActiveSessions) registry.register({
    name: 'list_active_sessions', category: 'control',
    description: '列出已授权且当前仍有运行实例的任务。currentTurnActive 区分正在执行与已加载空闲；历史记录的 running 标记不会进入本列表。',
    inputShape: {},
    handler: async () => {
      const result = await deps.listActiveSessions!();
      return result.ok ? okPayload({ sessions: result.sessions }) : mapControlFailure(result);
    },
  });
  if (deps.sessionCapabilities) registry.register({
    name: 'get_session_capabilities', category: 'control',
    description: '读取目标任务当前允许的控制操作。能力同时受调用权限、设备版本和实际运行引擎限制。',
    inputShape: { session_id: z.string().min(1).optional().describe('目标任务，省略时读取当前任务。') },
    handler: async ({ session_id }) => {
      const id = session_id ?? requireCallerSession(deps);
      if (!id) return errorPayload('NO_SESSION_CONTEXT', '请指定目标任务。');
      const result = await deps.sessionCapabilities!(id);
      return result.ok ? okPayload({ capabilities: result.capabilities }) : mapControlFailure(result);
    },
  });
  if (deps.inspectSession) registry.register({
    name: 'inspect_session', category: 'control',
    description: '读取任务的持久状态、当前运行实例、轮次、队列、交互和模型选择。freshness=stale 表示读取期间状态发生变化，不能据此确认当前仍在运行。只读，不启动任务。',
    inputShape: { session_id: z.string().min(1).optional().describe('目标任务，省略时读取当前任务。') },
    handler: async ({ session_id }) => {
      const id = session_id ?? requireCallerSession(deps);
      if (!id) return errorPayload('NO_SESSION_CONTEXT', '请指定目标任务。');
      const result = await deps.inspectSession!(id);
      return result.ok ? okPayload({ ...result.snapshot }) : mapControlFailure(result);
    },
  });
  if (deps.diagnoseSession) registry.register({
    name: 'diagnose_session', category: 'control',
    description: '只读检查任务是否等待用户、队列暂停、模型切换待落地、恢复中或宿主不可达，并读取现有 watchdog。availableControls 仅是当前可用操作，不会自动继续、停止或重启任务。',
    inputShape: { session_id: z.string().min(1).optional().describe('目标任务，省略时读取当前任务。') },
    handler: async ({ session_id }) => {
      const id = session_id ?? requireCallerSession(deps);
      if (!id) return errorPayload('NO_SESSION_CONTEXT', '请指定目标任务。');
      const result = await deps.diagnoseSession!(id);
      return result.ok ? okPayload({ ...result.diagnosis }) : mapControlFailure(result);
    },
  });
}

function requireCallerSession(deps: SessionControlDeps): string | null {
  return deps.getSessionContext().sessionId ?? null;
}

function mapControlFailure(result: { ok: false; errorCode: string; message: string }) {
  if (result.errorCode === 'HOST_NOT_READY') {
    return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程会话服务尚未就绪，请稍后重试。`);
  }
  return errorPayload(result.errorCode, result.message);
}

export function registerUpdateSessionQueuedMessageTool(
  registry: XdtHelperToolRegistry,
  deps: SessionControlDeps,
): void {
  registry.register({
    name: 'update_session_queued_message',
    category: 'control',
    description:
      '修改你通过 send_to_session 投递、且目标 session 尚未消费的一条排队消息。' +
      '只能修改当前调用 session 自己投递的消息；正在投递或其它来源的消息会被拒绝。',
    inputShape: {
      session_id: z.string().min(1).describe('目标 session id。'),
      queued_message_id: z.string().min(1).describe('来自 send_to_session 或 list_session_queue 的消息 id。'),
      message: z.string().min(1).describe('替换后的完整消息正文。'),
    },
    handler: async ({ session_id, queued_message_id, message }) => {
      const callerSessionId = requireCallerSession(deps);
      if (!callerSessionId) {
        return errorPayload('NO_SESSION_CONTEXT', '当前 MCP 调用没有绑定 session，无法校验消息所有权。');
      }
      const result = await deps.updateQueuedMessage({
        callerSessionId,
        targetSessionId: session_id,
        queuedMessageId: queued_message_id,
        message,
      });
      if (!result.ok) return mapControlFailure(result);
      return okPayload({
        session_id,
        queued_message_id: result.queuedMessageId,
        updated: true,
      });
    },
  });
}

export function registerCancelSessionQueuedMessageTool(
  registry: XdtHelperToolRegistry,
  deps: SessionControlDeps,
): void {
  registry.register({
    name: 'cancel_session_queued_message',
    category: 'control',
    description:
      '撤回你通过 send_to_session 投递、且目标 session 尚未消费的一条排队消息。' +
      '只能撤回当前调用 session 自己投递的消息；正在投递或其它来源的消息会被拒绝。',
    inputShape: {
      session_id: z.string().min(1).describe('目标 session id。'),
      queued_message_id: z.string().min(1).describe('来自 send_to_session 或 list_session_queue 的消息 id。'),
    },
    handler: async ({ session_id, queued_message_id }) => {
      const callerSessionId = requireCallerSession(deps);
      if (!callerSessionId) {
        return errorPayload('NO_SESSION_CONTEXT', '当前 MCP 调用没有绑定 session，无法校验消息所有权。');
      }
      const result = await deps.cancelQueuedMessage({
        callerSessionId,
        targetSessionId: session_id,
        queuedMessageId: queued_message_id,
      });
      if (!result.ok) return mapControlFailure(result);
      return okPayload({
        session_id,
        queued_message_id: result.queuedMessageId,
        cancelled: true,
      });
    },
  });
}

export function registerSteerSessionTool(
  registry: XdtHelperToolRegistry,
  deps: SessionControlDeps,
): void {
  registry.register({
    name: 'steer_session',
    category: 'control',
    description:
      '向正在运行的本机 session 高优先级插话；消息复用该 session 的原生 same-turn steer，' +
      '在 provider 的下一个输入安全间隙可见，不等待当前 turn 结束。目标不在运行或不支持时明确失败。',
    inputShape: {
      session_id: z.string().min(1).describe('目标 session id。'),
      message: z.string().min(1).describe('要注入当前 turn 的完整消息正文。'),
    },
    handler: async ({ session_id, message }) => {
      const callerSessionId = requireCallerSession(deps);
      if (!callerSessionId) {
        return errorPayload('NO_SESSION_CONTEXT', '当前 MCP 调用没有绑定 session，无法记录插话来源。');
      }
      const result = await deps.steerSession({
        callerSessionId,
        targetSessionId: session_id,
        message,
      });
      if (!result.ok) return mapControlFailure(result);
      return okPayload({
        session_id,
        queued_message_id: result.queuedMessageId,
        steered: true,
      });
    },
  });
}

export function registerStopSessionTurnTool(
  registry: XdtHelperToolRegistry,
  deps: SessionControlDeps,
): void {
  registry.register({
    name: 'stop_session_turn',
    category: 'control',
    description:
      '请求另一个本机 session 的当前 turn 优雅停止。若正在执行工具，会等全部当前工具结果返回后再发送 provider 软中断；' +
      '不会关闭 transport、重建 session 或硬杀进程。',
    inputShape: {
      session_id: z.string().min(1).describe('目标 session id。'),
    },
    handler: async ({ session_id }) => {
      const result = await deps.stopSessionTurn({ targetSessionId: session_id });
      if (!result.ok) return mapControlFailure(result);
      return okPayload({
        session_id,
        status: result.status,
        ...(result.turnGeneration !== undefined
          ? { turn_generation: result.turnGeneration }
          : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      });
    },
  });
}

export function registerGetSessionRuntimeTool(
  registry: XdtHelperToolRegistry,
  deps: SessionControlDeps,
): void {
  registry.register({
    name: 'get_session_runtime',
    category: 'control',
    description:
      '只读查询本机 session 的统一状态：记录生命周期、运行/等待/正常结束/出错结束、标题工作流语义、' +
      '开始时间、最后活动时间、动作摘要、优雅停止状态，以及运行时模型组合、待生效修改和 generation；' +
      '不返回提示词正文、工具参数或凭证。',
    inputShape: {
      session_id: z.string().min(1).optional().describe('目标 session id；省略时查询当前任务。'),
    },
    handler: async ({ session_id }) => {
      const targetSessionId = session_id ?? requireCallerSession(deps);
      if (!targetSessionId) {
        return errorPayload('NO_SESSION_CONTEXT', '当前 MCP 调用没有绑定 session，请显式提供 session_id。');
      }
      const result = await deps.getSessionRuntime({ targetSessionId });
      if (!result.ok) return mapControlFailure(result);
      const runtime = result.runtime;
      return okPayload({
        session_id: targetSessionId,
        phase: runtime.phase,
        active: runtime.phase === 'running' || runtime.phase === 'needs-interaction',
        record_status: runtime.recordStatus ?? null,
        source: runtime.source,
        attention: runtime.attention,
        workflow: runtime.workflow,
        turn_generation: runtime.turnGeneration,
        started_at: runtime.startedAtMs === null ? null : new Date(runtime.startedAtMs).toISOString(),
        last_activity_at:
          runtime.lastActivityAtMs === null ? null : new Date(runtime.lastActivityAtMs).toISOString(),
        current_action_summary: runtime.currentActionSummary,
        graceful_stop_state: runtime.gracefulStopState,
        generation: runtime.runtimeGeneration ?? 0,
        baseline: runtime.baselineProfile ? runtimeProfilePayload(runtime.baselineProfile) : null,
        effective: runtime.effectiveProfile ? runtimeProfilePayload(runtime.effectiveProfile) : null,
        pending: runtime.pendingMutation
          ? {
              generation: runtime.pendingMutation.generation,
              source: runtime.pendingMutation.source,
              profile: runtimeProfilePayload(runtime.pendingMutation.profile),
            }
          : null,
        fallback_enabled: runtime.fallbackEnabled ?? false,
      });
    },
  });
}

const EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

function runtimeProfilePayload(profile: SessionRuntimeProfile) {
  return {
    harness: profile.agentKind,
    model: profile.model,
    provider_id: profile.providerId,
    effort: profile.effort,
    fast: profile.fastMode,
  };
}

export function registerSetSessionRuntimeTool(
  registry: XdtHelperToolRegistry,
  deps: SessionControlDeps,
): void {
  registry.register({
    name: 'set_session_runtime',
    category: 'control',
    description:
      '原子调整当前或指定本机任务的模型来源、模型、推理强度与 Fast。省略 session_id 时作用于当前任务；' +
      '临时调整在忙碌任务的当前 turn 结束后生效。先用 get_session_runtime 读取 generation，再用 expected_generation 防止覆盖并发修改。' +
      '提供 harness 时必须同时指定 model：完整选择会保存到目标任务，并在下一条消息发送时切换（返回 next_send）；' +
      '省略 harness 保持临时调整语义。不修改全局默认选择。',
    inputShape: {
      harness: z.enum(['claude-code', 'codex', 'pi']).optional().describe('目标执行引擎；提供时必须同时指定 model。'),
      session_id: z.string().min(1).optional().describe('目标 session id；省略时使用当前任务。'),
      provider_id: z
        .string()
        .min(1)
        .nullable()
        .optional()
        .describe('来源 id；null 表示恢复该模型的默认来源。'),
      model: z.string().min(1).optional().describe('目标模型 id。'),
      effort: z.enum(EFFORT_VALUES).optional().describe('推理强度。省略表示保持当前值。'),
      fast: z.boolean().optional().describe('是否启用 Fast。'),
      expected_generation: z
        .number()
        .int()
        .nonnegative()
        .describe(
          '必填:先调用 get_session_runtime 读取当前 generation 并原样传回,用于防止覆盖并发修改。',
        ),
    },
    handler: async ({ session_id, harness, provider_id, model, effort, fast, expected_generation }) => {
      const targetSessionId = session_id ?? requireCallerSession(deps);
      if (!targetSessionId) {
        return errorPayload('NO_SESSION_CONTEXT', '当前 MCP 调用没有绑定 session，请显式提供 session_id。');
      }
      if (harness !== undefined && !model?.trim()) {
        return errorPayload('INVALID_ARGS', '提供 harness 时必须同时指定目标 model。');
      }
      if (
        provider_id === undefined &&
        model === undefined &&
        effort === undefined &&
        fast === undefined
      ) {
        return errorPayload('INVALID_ARGS', '至少提供 provider_id、model、effort 或 fast 之一。');
      }
      if (expected_generation === undefined) {
        // schema 已必填,此分支为纵深防御:任何绕过 zod 的调用路径仍拿到同一引导。
        return errorPayload('INVALID_ARGS', '请先调用 get_session_runtime 获取 generation,并作为 expected_generation 传回。');
      }
      const result = await deps.setSessionRuntime({
        targetSessionId,
        expectedGeneration: expected_generation,
        patch: {
          ...(harness !== undefined ? { harness } : {}),
          ...(provider_id !== undefined ? { providerId: provider_id } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(fast !== undefined ? { fastMode: fast } : {}),
        },
      });
      if (!result.ok) return mapControlFailure(result);
      return okPayload({
        session_id: targetSessionId,
        status: result.status,
        generation: result.generation,
        effective: runtimeProfilePayload(result.effectiveProfile),
        pending: result.pendingMutation
          ? {
              generation: result.pendingMutation.generation,
              source: result.pendingMutation.source,
              profile: runtimeProfilePayload(result.pendingMutation.profile),
            }
          : null,
        effective_boundary: result.effectiveBoundary ?? (result.status === 'deferred' ? 'next_turn' : 'immediate'),
      });
    },
  });
}
