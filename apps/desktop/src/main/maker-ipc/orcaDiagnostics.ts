import type { WorkerOwnedWorktree } from '../../shared/orca-worker-project';
import type { AgentKind } from '@cindy/maker-core';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';

export interface OrcaDiagnosticTeamSnapshot {
  id: string;
  leadSessionId: string;
  status: string;
}

export interface OrcaDiagnosticWorkerSnapshot {
  id: string;
  sessionId: string;
  status: string;
  label: string | null;
  role: string;
  focused: boolean;
  idleSince: string | null;
  updatedAt: string;
  session: {
    agentKind: AgentKind;
    model: string;
    effort: string | null;
    workingDir: string;
  };
  /** 跑在另一台电脑上的 Worker：运行设备投影；本机 Worker 无此字段。 */
  executionDevice?: {
    deviceId: string;
    deviceName?: string;
    reachable?: boolean;
    workingDir?: string;
  };
}

/**
 * Worker 本轮 turn 的 terminal error 摘要。
 *
 * createdAt 是 unix ms(messages.createdAt 同单位);对外出口统一转成 ISO 8601。
 */
export interface OrcaTurnErrorSummary {
  message: string;
  reason?: string;
  sdkError?: string;
  toolLoop?: string;
  createdAt: number;
}

/**
 * error 行 content → 脱敏摘要的统一投影。
 *
 * 为什么放在这里而不是调用方:read_worker 是新的对外出口(跨进程、会进 Lead 上下文),
 * 脱敏必须是出口的固有属性而不是调用方的自律 —— 换一个注入点也不该有绕过脱敏的可能。
 * 持久化侧(messagePersistBroadcaster)写库时已用同一个 redactSensitiveText 处理过
 * message / sdkError,这里再过一层是纵深防御:脱敏规则变更或规则上线前写入的历史行,
 * 出网前仍然被兜住。
 *
 * content 是 TEXT 列,可能是非法 JSON 或任意形态(历史数据),故全字段做窄取:只接受
 * string,其余形态一律丢弃而不是强转。
 *
 * @returns 摘要;message 缺失/为空时返回 null(写侧保证非空 message 才落 error 行,
 *          读侧遇到该形态按「无摘要」处理,不返回空对象)。
 */
export function projectOrcaTurnErrorSummary(
  content: unknown,
  createdAt: number,
): OrcaTurnErrorSummary | null {
  if (!content || typeof content !== 'object') return null;
  const row = content as Record<string, unknown>;
  const message = typeof row.message === 'string' && row.message
    ? redactSensitiveText(row.message)
    : '';
  if (!message) return null;
  // toolLoop 在库里是被 parseToolLoopErrorDetails 校验过的对象({ kind, count }),
  // 出口契约是 string,统一压成 JSON;非对象/非字符串形态直接丢弃。
  const toolLoop =
    typeof row.toolLoop === 'string'
      ? row.toolLoop
      : row.toolLoop && typeof row.toolLoop === 'object'
        ? JSON.stringify(row.toolLoop)
        : '';
  return {
    message,
    ...(typeof row.reason === 'string' && row.reason
      ? { reason: redactSensitiveText(row.reason) }
      : {}),
    ...(typeof row.sdkError === 'string' && row.sdkError
      ? { sdkError: redactSensitiveText(row.sdkError) }
      : {}),
    ...(toolLoop ? { toolLoop: redactSensitiveText(toolLoop) } : {}),
    createdAt,
  };
}

/**
 * 出口兜底:对 turnError 摘要的每个出网字符串再过一层 redactSensitiveText。
 *
 * 为什么还要这一层(纵深防御):OrcaDiagnosticsDeps.readLatestTurnError 承诺的是
 * 「已脱敏」,但那只是**注入方当前的行为**,不是本出口能验证的契约 —— 换一个注入点
 * (测试替身、未来的远端 worker 读取路径)就有绕过脱敏的可能。read_worker 的返回会
 * 跨进程进 Lead 上下文,脱敏必须是出口的固有属性。
 *
 * 只碰字符串字段:createdAt 是 unix ms number,不该进脱敏路径,所以逐字段处理而不是
 * 整体走 redactSensitiveTextDeep(后者返回 unknown,在这里要靠断言关掉类型检查)。
 * redactSensitiveText 幂等,已经是 [REDACTED] / [REDACTED_KEY] 的文本再过一次不会
 * 被撑成 [REDACTED]]。
 */
function redactTurnErrorSummary(summary: OrcaTurnErrorSummary): OrcaTurnErrorSummary {
  return {
    ...summary,
    message: redactSensitiveText(summary.message),
    ...(summary.reason ? { reason: redactSensitiveText(summary.reason) } : {}),
    ...(summary.sdkError ? { sdkError: redactSensitiveText(summary.sdkError) } : {}),
    ...(summary.toolLoop ? { toolLoop: redactSensitiveText(summary.toolLoop) } : {}),
  };
}

export interface OrcaDiagnosticsDeps {
  readActiveTeam(leadSessionId: string): Promise<OrcaDiagnosticTeamSnapshot | null>;
  listWorkersByLead(leadSessionId: string): Promise<OrcaDiagnosticWorkerSnapshot[]>;
  getSessionStatus(sessionId: string): string;
  getWorkerFlowStatus(sessionId: string): Promise<{
    isWorking: boolean;
    willQueue: boolean;
    queuedCount: number;
    queuePaused: boolean;
  }>;
  readLatestAssistantMessage(workerSessionId: string): Promise<string>;
  /**
   * 本轮 turn 的 terminal error 摘要,没有则 null。
   *
   * 「本轮」由注入方负责绑定:read_worker 只做搬运,不自行决定取哪一轮。
   * 可选:未注入时 read_worker 的 turnError 恒为 null,既有构造点不受影响。
   *
   * 生产注入方返回的是已脱敏摘要,但这只是注入方当前的行为,不是本出口能验证的
   * 契约 —— 换一个注入点(测试替身、未来的远端 worker 读取路径)就有绕过脱敏的
   * 可能。readOrcaWorkerOutputReadOnly 出网前会对每个字符串字段再兜一层。
   */
  readLatestTurnError?(workerSessionId: string): Promise<OrcaTurnErrorSummary | null>;
  getWorkerWorktree?(sessionId: string): WorkerOwnedWorktree | undefined;}

export type OrcaDiagnosticResult<T extends object> =
  | ({ ok: true } & T)
  | { ok: false; errorCode: 'WORKER_NOT_FOUND'; message: string };

function idleMs(worker: OrcaDiagnosticWorkerSnapshot): number | null {
  const source = worker.idleSince
    ? Date.parse(worker.idleSince)
    : Date.parse(worker.updatedAt);
  if (!Number.isFinite(source)) return null;
  return Math.max(0, Date.now() - source);
}

async function toWorkerSummary(deps: OrcaDiagnosticsDeps, worker: OrcaDiagnosticWorkerSnapshot) {
  const worktree = worker.executionDevice ? undefined : deps.getWorkerWorktree?.(worker.sessionId);
  const sessionStatus = deps.getSessionStatus(worker.sessionId);
  const flow = await deps.getWorkerFlowStatus(worker.sessionId);
  return {
    worker_id: worker.id,
    session_id: worker.sessionId,
    status: worker.status,
    session_status: sessionStatus,
    idle_ms: idleMs(worker),
    restored_from_storage: sessionStatus === 'not_running',
    is_working: flow.isWorking,
    will_queue: flow.willQueue,
    queued_count: flow.queuedCount,
    queue_paused: flow.queuePaused,
    label: worker.label,
    role: worker.role,
    agent_kind: worker.session.agentKind,
    model: worker.session.model,
    effort: worker.session.effort ?? null,
    focused: worker.focused,
    // 远端 Worker 的本机代理行没有目录；展示运行设备上的目录。
    working_dir: worker.executionDevice?.workingDir ?? worker.session.workingDir,
    owns_worktree: !!worktree,
    ...(worktree ? { worktree } : {}),
    ...(worker.executionDevice
      ? {
          execution_device: {
            device_id: worker.executionDevice.deviceId,
            device_name: worker.executionDevice.deviceName ?? null,
            reachable: worker.executionDevice.reachable ?? null,
          },
        }
      : {}),
  };
}

type OrcaWorkerSummary = Awaited<ReturnType<typeof toWorkerSummary>>;

async function readDiagnosticWorkers(
  deps: OrcaDiagnosticsDeps,
  leadSessionId: string,
): Promise<OrcaWorkerSummary[]> {
  const workers = await deps.listWorkersByLead(leadSessionId);
  return Promise.all(workers.map((worker) => toWorkerSummary(deps, worker)));
}

// worker_id 与 session_id 都接受（与 resolveWorkerRef 同语义，只读诊断侧）。
async function findDiagnosticWorker(
  deps: OrcaDiagnosticsDeps,
  leadSessionId: string,
  workerId: string,
): Promise<OrcaWorkerSummary | null> {
  const workers = await readDiagnosticWorkers(deps, leadSessionId);
  return workers.find((w) => w.worker_id === workerId || w.session_id === workerId) ?? null;
}

export async function getOrcaWorkspaceInfoReadOnly(
  deps: OrcaDiagnosticsDeps,
  leadSessionId: string,
): Promise<OrcaDiagnosticResult<{
  workflow: {
    workflow_id: string;
    lead_session_id: string;
    status: string;
  } | null;
  ui_capacity: number;
  worker_count: number;
  workers: OrcaWorkerSummary[];
}>> {
  const active = await deps.readActiveTeam(leadSessionId);
  if (!active) {
    return {
      ok: true,
      workflow: null,
      ui_capacity: 1,
      worker_count: 0,
      workers: [],
    };
  }
  const workers = await readDiagnosticWorkers(deps, leadSessionId);
  return {
    ok: true,
    workflow: {
      workflow_id: active.id,
      lead_session_id: active.leadSessionId,
      status: active.status,
    },
    ui_capacity: 1,
    worker_count: workers.length,
    workers,
  };
}

export async function getOrcaWorkerDiagnosticStatusReadOnly(
  deps: OrcaDiagnosticsDeps,
  leadSessionId: string,
  workerId: string,
): Promise<OrcaDiagnosticResult<{
  worker_id: string;
  session_id: string;
  status: string;
  session_status: string;
  idle_ms: number | null;
  restored_from_storage: boolean;
}>> {
  const worker = await findDiagnosticWorker(deps, leadSessionId, workerId);
  if (!worker) {
    return { ok: false, errorCode: 'WORKER_NOT_FOUND', message: `worker ${workerId} not found` };
  }
  return {
    ok: true,
    worker_id: worker.worker_id,
    session_id: worker.session_id,
    status: worker.status,
    session_status: worker.session_status,
    idle_ms: worker.idle_ms,
    restored_from_storage: worker.restored_from_storage,
  };
}

export async function readOrcaWorkerOutputReadOnly(
  deps: OrcaDiagnosticsDeps,
  leadSessionId: string,
  workerId: string,
): Promise<OrcaDiagnosticResult<{
  worker_id: string;
  session_id: string;
  status: string;
  session_status: string;
  idle_ms: number | null;
  restored_from_storage: boolean;
  result: string;
  turnError: {
    message: string;
    reason?: string;
    sdkError?: string;
    toolLoop?: string;
    createdAt: string;
  } | null;
}>> {
  const worker = await findDiagnosticWorker(deps, leadSessionId, workerId);
  if (!worker) {
    return { ok: false, errorCode: 'WORKER_NOT_FOUND', message: `worker ${workerId} not found` };
  }
  const summary = deps.readLatestTurnError
    ? await deps.readLatestTurnError(worker.session_id)
    : null;
  // 出口兜底脱敏:「已脱敏」只是生产注入方的当前行为,不是本出口能验证的契约
  // (见 OrcaDiagnosticsDeps.readLatestTurnError 注释),出网前每个字符串字段在这里
  // 再过一层。createdAt 是 number,不进脱敏路径(见 redactTurnErrorSummary)。
  const safe = summary ? redactTurnErrorSummary(summary) : null;
  return {
    ok: true,
    worker_id: worker.worker_id,
    session_id: worker.session_id,
    status: worker.status,
    session_status: worker.session_status,
    idle_ms: worker.idle_ms,
    restored_from_storage: worker.restored_from_storage,
    result: await deps.readLatestAssistantMessage(worker.session_id),
    turnError: safe
      ? {
          message: safe.message,
          ...(safe.reason ? { reason: safe.reason } : {}),
          ...(safe.sdkError ? { sdkError: safe.sdkError } : {}),
          ...(safe.toolLoop ? { toolLoop: safe.toolLoop } : {}),
          createdAt: new Date(safe.createdAt).toISOString(),
        }
      : null,
  };
}
