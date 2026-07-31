import type { AgentKind } from '@cindy/maker-core';

import { createHostSendFailure } from '../maker-host/send-outcome.js';
import type { DispatchWorkerTaskResult, OrcaWorkerEffort } from './orcaTeamService.js';
import { normalizeOrcaWorkerLabel } from './orcaWorkerCreationService.js';
import type {
  OrcaTeamSnapshot,
  OrcaWorkerCreateInTeamParams,
  OrcaWorkerCreateParams,
  OrcaWorkerCreationResult,
} from './orcaWorkerCreationService.js';

export const ORCA_WORKER_READY_MESSAGE = '[系统] Orca Worker 已就绪，等待 Lead 分配任务。';

/** 开启协同时的一次性入参；负责把 UI/MCP 的 worker 偏好归一到 worker 创建内核。 */
export interface OrcaEnableTeamParams {
  leadSessionId: string;
  workerAgent: AgentKind;
  role?: string;
  label?: string;
  model?: string;
  effort?: OrcaWorkerEffort;
  fast?: boolean;
  /** 显式选定的模型来源;语义见 OrcaWorkerCreateParams.providerId。 */
  providerId?: string | null;
  delegateTask?: string;
}

/** MCP start_team 只建立 lead team，不创建 worker；worker 后续由 create_worker 添加。 */
export interface OrcaStartTeamParams {
  leadSessionId: string;
}

/** lifecycle 内部统一使用 INTERNAL 承载依赖异常，adapter 再决定 IPC/MCP 如何翻译。 */
type OrcaInternalFailure = {
  ok: false;
  errorCode: 'INTERNAL';
  message: string;
};

/** start_team 的领域结果；reused 表示复用已有 active team，并已刷新 lead 运行态。 */
export type OrcaStartTeamResult =
  | {
      ok: true;
      teamId: string;
      reused?: boolean;
    }
  | OrcaInternalFailure;

/** enable_collab_mode 的领域结果，保留初始任务派发 outcome 供 IPC/MCP 区分 created-but-not-dispatched。 */
export type OrcaEnableTeamResult =
  | {
      ok: true;
      teamId: string;
      workerSessionId: string;
      workerId: string;
      dispatched: boolean;
      dispatchOutcome?: DispatchWorkerTaskResult['dispatchOutcome'];
    }
  | Extract<OrcaWorkerCreationResult, { ok: false }>
  | {
      ok: false;
      errorCode: 'ALREADY_EXISTS' | 'INTERNAL' | 'INVALID_PARAMS';
      message: string;
    };

/** lifecycle service 的 I/O 边界；register.ts 只负责注入 DB、Maker session 与广播能力。 */
export interface OrcaLifecycleDeps {
  getActiveTeamByLead(leadSessionId: string): Promise<OrcaTeamSnapshot | null>;
  createActiveTeam(leadSessionId: string): Promise<OrcaTeamSnapshot>;
  createWorkerInTeam(params: OrcaWorkerCreateInTeamParams): Promise<OrcaWorkerCreationResult>;
  dispatchWorkerTask(params: {
    targetSessionId: string;
    message: string;
    dispatchMeta: {
      source: string;
      context: string;
    };
  }): Promise<DispatchWorkerTaskResult>;
  markTeamEnded(teamId: string, status: 'completed' | 'cancelled' | 'failed'): Promise<void>;
  setSessionOrcaRole(sessionId: string, role: 'lead' | null): Promise<void>;
  clearKnownNonOrcaSession(sessionId: string): void;
  setLeadVendorOptions(params: {
    leadSessionId: string;
    teamId: string;
    workerId?: string;
    workerSessionId?: string;
  }): Promise<void>;
  clearLeadVendorOptions(leadSessionId: string): Promise<void>;
  sendWorkerReadyPlaceholder(params: {
    workerSessionId: string;
    agentKind: AgentKind;
    entrypoint: 'create_worker' | 'enable_collab_mode';
    context: string;
  }): Promise<void>;
  rollbackCreatedWorker(params: { workerId: string; workerSessionId: string }): Promise<void>;
  broadcastSessionCreated(sessionId: string): void;
  broadcastOrcaWorkerChanged(leadSessionId: string): void;
}

/** 协同生命周期入口，集中处理 start_team、enable_collab_mode 和 create_worker 的补偿顺序。 */
export interface OrcaLifecycleService {
  startTeam(params: OrcaStartTeamParams): Promise<OrcaStartTeamResult>;
  createWorker(params: OrcaWorkerCreateParams): Promise<OrcaWorkerCreationResult>;
  enableTeam(params: OrcaEnableTeamParams): Promise<OrcaEnableTeamResult>;
}

function internalFailure(err: unknown): OrcaInternalFailure {
  return {
    ok: false,
    errorCode: 'INTERNAL',
    message: err instanceof Error ? err.message : String(err),
  };
}

function normalizeEnableParams(params: OrcaEnableTeamParams): OrcaWorkerCreateParams {
  const delegateTask = params.delegateTask?.trim() || undefined;
  const role = params.role?.trim() || 'developer';
  const explicitLabel = params.label !== undefined ? params.label.trim() : undefined;
  return {
    leadSessionId: params.leadSessionId,
    role,
    label: explicitLabel ?? createDefaultWorkerLabel(role),
    agent: params.workerAgent,
    model: params.model?.trim() || undefined,
    effort: params.effort,
    fast: params.fast,
    providerId: params.providerId,
    initialTask: delegateTask,
  };
}

function createDefaultWorkerLabel(role: string): string {
  return role
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'worker';
}

function validateEnableParams(normalized: OrcaWorkerCreateParams): Extract<OrcaEnableTeamResult, { ok: false }> | null {
  if (normalized.role.length < 1 || normalized.role.length > 32) {
    return { ok: false, errorCode: 'INVALID_PARAMS', message: 'role must be 1-32 chars' };
  }
  const label = normalizeOrcaWorkerLabel(normalized.label);
  if (!label.ok) {
    return { ok: false, errorCode: 'INVALID_PARAMS', message: label.message };
  }
  return null;
}

function hasNonEmptyInitialTask(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function createOrcaLifecycleService(deps: OrcaLifecycleDeps): OrcaLifecycleService {
  const dispatchSource = 'maker-ipc/collab';

  async function dispatchInitialTask(params: {
    workerSessionId: string;
    message: string | undefined;
    context: string;
  }): Promise<DispatchWorkerTaskResult | undefined> {
    if (!params.message) return undefined;
    try {
      return await deps.dispatchWorkerTask({
        targetSessionId: params.workerSessionId,
        message: params.message,
        dispatchMeta: {
          source: dispatchSource,
          context: params.context,
        },
      });
    } catch {
      return {
        dispatched: false,
        dispatchOutcome: {
          ...createHostSendFailure(
            'SEND_FAILED',
            `Collab delegate send failed before vendor dispatch: ${params.context}`,
          ),
          source: dispatchSource,
          context: params.context,
        },
      };
    }
  }

  async function createWorker(params: OrcaWorkerCreateParams): Promise<OrcaWorkerCreationResult> {
    const team = await deps.getActiveTeamByLead(params.leadSessionId);
    if (!team) {
      return { ok: false, errorCode: 'NOT_FOUND', message: 'no active team for this lead' };
    }
    const initialTask = hasNonEmptyInitialTask(params.initialTask) ? params.initialTask : undefined;
    const created = await deps.createWorkerInTeam({ ...params, teamId: team.id });
    if (!created.ok) return created;

    const dispatchResult = initialTask
      ? await dispatchInitialTask({
          workerSessionId: created.workerSessionId,
          message: initialTask,
          context: `create_worker/${created.workerSessionId}/initial_task`,
        })
      : undefined;
    if (!initialTask) {
      try {
        await deps.sendWorkerReadyPlaceholder({
          workerSessionId: created.workerSessionId,
          agentKind: created.resolved.agent,
          entrypoint: 'create_worker',
          context: `create_worker/${created.workerSessionId}/worker-ready-placeholder`,
        });
      } catch (err) {
        await deps.rollbackCreatedWorker({
          workerId: created.workerId,
          workerSessionId: created.workerSessionId,
        }).catch(() => undefined);
        return internalFailure(err);
      }
    }
    deps.broadcastSessionCreated(created.workerSessionId);
    deps.broadcastOrcaWorkerChanged(params.leadSessionId);
    return {
      ...created,
      ...(initialTask ? { dispatched: dispatchResult?.dispatched ?? false } : {}),
      ...(dispatchResult ? { dispatchOutcome: dispatchResult.dispatchOutcome } : {}),
      ...(dispatchResult?.queued === true ? { queuedMessageId: dispatchResult.queuedMessageId } : {}),
    };
  }

  async function failCreatedTeam(params: {
    teamId: string;
    leadSessionId: string;
    workerId?: string;
    workerSessionId?: string;
    clearLeadVendorOptions?: boolean;
    err?: unknown;
    failure?: Extract<OrcaEnableTeamResult, { ok: false }>;
  }): Promise<Extract<OrcaEnableTeamResult, { ok: false }>> {
    if (params.workerId && params.workerSessionId) {
      await deps.rollbackCreatedWorker({
        workerId: params.workerId,
        workerSessionId: params.workerSessionId,
      }).catch(() => undefined);
    }
    await deps.markTeamEnded(params.teamId, 'failed').catch(() => undefined);
    await deps.setSessionOrcaRole(params.leadSessionId, null).catch(() => undefined);
    if (params.clearLeadVendorOptions) {
      await deps.clearLeadVendorOptions(params.leadSessionId).catch(() => undefined);
    }
    return params.failure ?? internalFailure(params.err);
  }

  async function failCreatedTeamOnly(params: {
    teamId: string;
    leadSessionId: string;
    err: unknown;
  }): Promise<Extract<OrcaStartTeamResult, { ok: false }>> {
    await deps.markTeamEnded(params.teamId, 'failed').catch(() => undefined);
    await deps.setSessionOrcaRole(params.leadSessionId, null).catch(() => undefined);
    return internalFailure(params.err);
  }

  async function activateLeadTeam(params: {
    leadSessionId: string;
    teamId: string;
  }): Promise<void> {
    await deps.setSessionOrcaRole(params.leadSessionId, 'lead');
    deps.clearKnownNonOrcaSession(params.leadSessionId);
    await deps.setLeadVendorOptions({
      leadSessionId: params.leadSessionId,
      teamId: params.teamId,
    });
  }

  async function startTeam(params: OrcaStartTeamParams): Promise<OrcaStartTeamResult> {
    const existing = await deps.getActiveTeamByLead(params.leadSessionId);
    if (existing) {
      try {
        await activateLeadTeam({ leadSessionId: params.leadSessionId, teamId: existing.id });
      } catch (err) {
        return internalFailure(err);
      }
      return { ok: true, teamId: existing.id, reused: true };
    }

    const team = await deps.createActiveTeam(params.leadSessionId);
    try {
      await activateLeadTeam({ leadSessionId: params.leadSessionId, teamId: team.id });
    } catch (err) {
      return failCreatedTeamOnly({ teamId: team.id, leadSessionId: params.leadSessionId, err });
    }
    return { ok: true, teamId: team.id };
  }

  async function enableTeam(params: OrcaEnableTeamParams): Promise<OrcaEnableTeamResult> {
    const normalized = normalizeEnableParams(params);
    const validationFailure = validateEnableParams(normalized);
    if (validationFailure) return validationFailure;

    const existing = await deps.getActiveTeamByLead(params.leadSessionId);
    if (existing) {
      return {
        ok: false,
        errorCode: 'ALREADY_EXISTS',
        message: `lead session already has active orca team ${existing.id}`,
      };
    }

    const team = await deps.createActiveTeam(params.leadSessionId);
    const created = await deps.createWorkerInTeam({ ...normalized, teamId: team.id });
    if (!created.ok) {
      return failCreatedTeam({
        teamId: team.id,
        leadSessionId: params.leadSessionId,
        failure: created,
      });
    }

    let leadVendorOptionsSet = false;
    try {
      await deps.setSessionOrcaRole(params.leadSessionId, 'lead');
      deps.clearKnownNonOrcaSession(params.leadSessionId);
      await deps.setLeadVendorOptions({
        leadSessionId: params.leadSessionId,
        teamId: team.id,
        workerId: created.workerId,
        workerSessionId: created.workerSessionId,
      });
      leadVendorOptionsSet = true;
    } catch (err) {
      return failCreatedTeam({
        teamId: team.id,
        leadSessionId: params.leadSessionId,
        workerId: created.workerId,
        workerSessionId: created.workerSessionId,
        clearLeadVendorOptions: leadVendorOptionsSet,
        err,
      });
    }

    let dispatchResult: DispatchWorkerTaskResult | undefined;
    if (normalized.initialTask) {
      dispatchResult = await dispatchInitialTask({
        workerSessionId: created.workerSessionId,
        message: normalized.initialTask,
        context: `enable_collab_mode/${created.workerSessionId}/delegate_task`,
      });
    } else {
      try {
        await deps.sendWorkerReadyPlaceholder({
          workerSessionId: created.workerSessionId,
          agentKind: created.resolved.agent,
          entrypoint: 'enable_collab_mode',
          context: `enable_collab_mode/${created.workerSessionId}/worker-ready-placeholder`,
        });
      } catch (err) {
        return failCreatedTeam({
          teamId: team.id,
          leadSessionId: params.leadSessionId,
          workerId: created.workerId,
          workerSessionId: created.workerSessionId,
          clearLeadVendorOptions: true,
          err,
        });
      }
    }

    deps.broadcastSessionCreated(created.workerSessionId);
    deps.broadcastOrcaWorkerChanged(params.leadSessionId);
    return {
      ok: true,
      teamId: team.id,
      workerSessionId: created.workerSessionId,
      workerId: created.workerId,
      dispatched: dispatchResult?.dispatched ?? false,
      ...(dispatchResult ? { dispatchOutcome: dispatchResult.dispatchOutcome } : {}),
    };
  }

  return {
    startTeam,
    createWorker,
    enableTeam,
  };
}
