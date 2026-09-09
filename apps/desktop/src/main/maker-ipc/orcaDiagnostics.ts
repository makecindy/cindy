import type { AgentKind } from '@cindy/maker-core';

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
}

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
    working_dir: worker.session.workingDir,
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
    result: await deps.readLatestAssistantMessage(worker.session_id),
  };
}
