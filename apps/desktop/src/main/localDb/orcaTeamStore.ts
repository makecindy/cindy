import { BrowserWindow } from 'electron';
import { and, desc, eq, gt, inArray, ne } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';

import { getDbClient } from './client/current.js';
import { orcaWorkers, orcaTeams, orcaWorkerCreationReservations, sessions } from './schema.js';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { notifyAgentIslandSessionPatch } from './agentIslandSessionPatch.js';
import { withSessionRouteLock, withSessionRouteLocks } from './sessionRouteLock.js';
import { cleanupSessionRuntimeForTerminalStatus } from './sessionRuntimeCleanup.js';
import { compactSessionToolResultsBestEffort } from './toolResultCompaction.js';

const log = createLogger('orca-team-store');

export type OrcaRole = 'lead' | 'worker';
export type OrcaTeamStatus = 'active' | 'completed' | 'cancelled' | 'failed';
export type MakerAgentKind = 'claude-code' | 'codex' | 'pi';

// Worker 状态枚举与 "占用槽位" 判定下沉到 renderer-safe 模块,
// 让 main (本文件) 与 renderer (useWorkers) 共享同一份算法, 避免 F6 那种
// "前后端各写一份 status filter → 漂移" 的复发。
import {
  ACTIVE_WORKER_STATUSES,
  isActiveWorkerStatus,
  type OrcaWorkerStatus,
} from '../../shared/orca-worker-status.js';
export { ACTIVE_WORKER_STATUSES, isActiveWorkerStatus, type OrcaWorkerStatus };

export interface OrcaTeamRecord {
  id: string;
  leadSessionId: string;
  status: OrcaTeamStatus;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrcaWorkerRecord {
  id: string;
  teamId: string;
  leadSessionId: string;
  sessionId: string;
  status: OrcaWorkerStatus;
  label: string | null;
  worktreeBranch: string | null;
  role: string;
  focused: boolean;
  idleSince: string | null;
  createdAt: string;
  updatedAt: string;
  session: {
    id: string;
    title: string;
    agentKind: MakerAgentKind;
    workingDir: string;
    model: string;
    effort: string;
    permissionMode: string;
    fastMode: boolean;
    sdkSessionId?: string;
  };
}

export interface OrcaWorkerLinkRecord {
  workerId: string;
  teamId: string;
  workerSessionId: string;
  leadSessionId: string;
  leadSession: {
    sessionId: string;
    agentKind: MakerAgentKind;
    workingDir: string;
    model: string;
    providerId?: string | null;
    effort: string;
    permissionMode: string;
    fastMode: boolean;
    sdkSessionId?: string;
    title: string;
    /** SSH 远端 lead 的 host id;bridge rehydrate 必须带回 createSession。 */
    remoteHostId?: string | null;
  };
}

export type OrcaWorkerCreationReservationResult =
  | { ok: true; occupiedSlotsBefore: number }
  | { ok: false; errorCode: 'DUPLICATE_LABEL' | 'WORKER_CREATION_IN_PROGRESS' | 'WORKER_LIMIT_HARD_EXCEEDED' };

export async function reserveWorkerCreation(input: {
  reservationId: string;
  teamId: string;
  label: string;
  hardLimit: number;
  leaseMs: number;
}): Promise<OrcaWorkerCreationReservationResult> {
  const now = Date.now();
  return getDbClient().tx('orca.reserveWorkerCreation', {
    ...input,
    label: input.label.toLowerCase(),
    now,
    expiresAt: now + input.leaseMs,
  });
}

export async function renewWorkerCreationReservation(
  reservationId: string,
  leaseMs: number,
): Promise<boolean> {
  const now = Date.now();
  return getDbClient().tx('orca.renewWorkerCreationReservation', {
    reservationId,
    now,
    expiresAt: now + leaseMs,
  });
}

export async function releaseWorkerCreationReservation(reservationId: string): Promise<void> {
  await getDbClient().tx('orca.releaseWorkerCreationReservation', { reservationId });
}

export async function createOrGetTeamForLead(input: {
  id?: string;
  leadSessionId: string;
  status?: OrcaTeamStatus;
}): Promise<OrcaTeamRecord> {
  const existing = await getTeamByLeadSession(input.leadSessionId);
  if (existing) {
    await setSessionOrcaRole(input.leadSessionId, 'lead');
    return existing;
  }

  const db = getDbClient().drizzle;
  const now = Date.now();
  const id = input.id ?? createId();
  await db.insert(orcaTeams).values({
    id,
    leadSessionId: input.leadSessionId,
    status: input.status ?? 'active',
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await setSessionOrcaRole(input.leadSessionId, 'lead');
  const created = await getTeamByLeadSession(input.leadSessionId);
  if (!created) throwIpcError('INTERNAL', `Orca team ${id} was not found after create`);
  return created;
}

export async function getTeamByLeadSession(
  leadSessionId: string,
): Promise<OrcaTeamRecord | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select()
    .from(orcaTeams)
    .where(eq(orcaTeams.leadSessionId, leadSessionId))
    .limit(1);
  return row ? teamToRecord(row) : null;
}

/**
 * F-COLLAB: 查找指定 lead session 当前 active 的 team。
 * DB 层 partial unique 约束可能因历史 migration / drift 暂时缺失,因此这里仍做 read-time dedup:
 * 同一 lead 如果出现多个 active team,保留最新一条,其余标记为 cancelled。
 */
export async function getActiveTeamByLead(
  leadSessionId: string,
): Promise<OrcaTeamRecord | null> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select()
    .from(orcaTeams)
    .where(
      and(eq(orcaTeams.leadSessionId, leadSessionId), eq(orcaTeams.status, 'active')),
    )
    .orderBy(desc(orcaTeams.updatedAt), desc(orcaTeams.createdAt));

  const latest = rows[0];
  if (!latest) return null;

  // 罕见: 同一 lead 出现多个 active team(partial unique 约束缺失 / drift 时)。
  // 高频路径(0 或 1 个 team)走上面的纯 async select, 不付 worker 事务开销;
  // 只有真出现重复时才走原子的 cancelStaleTeams 兜底, 取消除 latest 外的全部。
  // (DbClient.drizzle 是 worker-thread 异步代理, 不支持同步 db.transaction —
  //  需要原子性的多语句写必须走命名事务, 见 client/tx/types.ts。)
  if (rows.length > 1) {
    await getDbClient().tx('orca.cancelStaleTeams', {
      leadSessionId,
      keepTeamId: latest.id,
      now: Date.now(),
    });
    log.warn('cancelled stale duplicate active orca teams', {
      leadSessionId,
      keptTeamId: latest.id,
      staleTeamIds: rows.slice(1).map((team) => team.id),
    });
  }

  return teamToRecord(latest);
}

/**
 * #3555:判定 active team 是否为「初始化被进程退出打断」遗留的孤儿。
 * 判据取最保守的一档:该 team 从未挂上任何 worker 行(任意状态,含归档——
 * 全员归档的 team 是用户可继续 create_worker 的合法状态,不算孤儿),且没有
 * 仍在租期内的创建 reservation(有则说明另一进程正在为它建 worker)。两条都
 * 满足的 team 不可能承载任何用户状态,调用方可安全按 failed 收口重新启用。
 */
/** #3555 review:太年轻的 team 视为「可能仍在别处初始化」,不判孤儿。 */
const ORPHAN_TEAM_MIN_AGE_MS = 60_000;

export async function isOrphanedTeamInit(teamId: string): Promise<boolean> {
  const db = getDbClient().drizzle;
  // 并发初始化兜底(同进程窗口已由 lifecycle 的 in-flight 集合覆盖,这里
  // 挡住其余场景):创建后不足 ORPHAN_TEAM_MIN_AGE_MS 的 team 不判孤儿——
  // 进程中断遗留的孤儿在用户重启重试时天然老于该地板,收敛性不受影响。
  const [team] = await db
    .select({ createdAt: orcaTeams.createdAt })
    .from(orcaTeams)
    .where(eq(orcaTeams.id, teamId))
    .limit(1);
  if (!team) return false;
  if (Date.now() - team.createdAt < ORPHAN_TEAM_MIN_AGE_MS) return false;
  const [worker] = await db
    .select({ id: orcaWorkers.id })
    .from(orcaWorkers)
    .where(eq(orcaWorkers.teamId, teamId))
    .limit(1);
  if (worker) return false;
  const [reservation] = await db
    .select({ id: orcaWorkerCreationReservations.id })
    .from(orcaWorkerCreationReservations)
    .where(
      and(
        eq(orcaWorkerCreationReservations.teamId, teamId),
        gt(orcaWorkerCreationReservations.expiresAt, Date.now()),
      ),
    )
    .limit(1);
  return !reservation;
}

/**
 * F-COLLAB: 直接插入新的 active team。
 * 跟 createOrGetTeamForLead 不同 — 不查 existing,任何已有的同 lead team
 * 必须先被显式 markTeamEnded(completed/cancelled/failed)。调用方 (OrcaLifecycleService)
 * 已先用 getActiveTeamByLead 做 read-time dedup；DB partial unique 索引只是兜底并发插入。
 */
export async function createActiveTeam(input: {
  id?: string;
  leadSessionId: string;
}): Promise<OrcaTeamRecord> {
  const db = getDbClient().drizzle;
  const now = Date.now();
  const id = input.id ?? createId();
  await db.insert(orcaTeams).values({
    id,
    leadSessionId: input.leadSessionId,
    status: 'active',
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const created = await getTeamById(id);
  if (!created) throwIpcError('INTERNAL', `Orca team ${id} not found after create`);
  return created;
}

/**
 * F-COLLAB: 把 team 标记为终态(completed / cancelled / failed)+ 写 completedAt。
 * 终态后 partial unique 不再限制,同一 lead 可以再开新 active team。
 */
export async function markTeamEnded(
  teamId: string,
  status: 'completed' | 'cancelled' | 'failed',
): Promise<void> {
  const db = getDbClient().drizzle;
  const now = Date.now();
  await db
    .update(orcaTeams)
    .set({ status, completedAt: now, updatedAt: now })
    .where(eq(orcaTeams.id, teamId));
}

/**
 * F-COLLAB: 关闭协同时把所有相关 Worker session 标 archived。
 * sessions.status='archived' 让 sidebar 自然隐藏(其他列表 / 历史搜索仍可查到)。
 * orca_role 字段保留 'worker' 不动 — 历史上下文识别需要它。
 */
export async function archiveWorkersByTeam(teamId: string): Promise<string[]> {
  const client = getDbClient();
  const candidateIds = await listActiveWorkerSessionIdsForTeam(teamId);
  const updatedIds = await withSessionRouteLocks(candidateIds, async () => {
    const ids = await client.tx('orca.archiveWorkersByTeam', {
      teamId,
      sessionIds: candidateIds,
      now: Date.now(),
    });
    for (const id of ids) cleanupSessionRuntimeForTerminalStatus(id, 'archived');
    return ids;
  });
  for (const id of updatedIds) {
    broadcastSessionPatch(id, { status: 'archived' });
    void compactSessionToolResultsBestEffort({ client, sessionId: id });
  }
  return updatedIds;
}

/**
 * F-COLLAB: 把 team 下所有 worker rows 标记终态 status。
 * 不区分单个 worker 当时是 idle 还是 running — 调用方负责按需选 'done' / 'cancelled'。
 */
export async function markWorkersStatusByTeam(
  teamId: string,
  status: OrcaWorkerStatus,
): Promise<void> {
  const db = getDbClient().drizzle;
  const now = Date.now();
  await db
    .update(orcaWorkers)
    .set({ status, updatedAt: now })
    .where(eq(orcaWorkers.teamId, teamId));
}

/**
 * F-COLLAB 兜底:把一个「已无 active team」的 lead 名下、属于非 active team 的 orphaned worker
 * 收敛干净 —— worker session 归档(status='archived',orca_role 保留 'worker' 作历史识别),
 * 对应 orca_workers 收敛 'done'。
 *
 * 服务 disableOrcaInternal 的 no-team 兜底分支:如果上一次关闭在 archiveWorkersByTeam 之前被
 * 打断,team 已非 active 但 worker session 仍停在 status='active' + orca_role='worker' —— 既被
 * sidebar 的 worker 过滤隐藏,又因为 listWorkersByLead 只看 active team 而无法触达。这里按
 * 「该 lead 的全部非 active team」补齐归档。返回本次新归档的 worker session id 列表。
 */
export async function reconcileInactiveTeamWorkersForLead(
  leadSessionId: string,
): Promise<string[]> {
  const client = getDbClient();
  const candidateIds = await listActiveWorkerSessionIdsForInactiveTeams(leadSessionId);
  const updatedIds = await withSessionRouteLocks(candidateIds, async () => {
    const ids = await client.tx('orca.reconcileInactiveTeamWorkersForLead', {
      leadSessionId,
      sessionIds: candidateIds,
      now: Date.now(),
    });
    for (const id of ids) cleanupSessionRuntimeForTerminalStatus(id, 'archived');
    return ids;
  });
  for (const id of updatedIds) {
    broadcastSessionPatch(id, { status: 'archived' });
    void compactSessionToolResultsBestEffort({ client, sessionId: id });
  }
  return updatedIds;
}

export async function getTeamByWorkerSession(
  workerSessionId: string,
): Promise<OrcaTeamRecord | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({ team: orcaTeams })
    .from(orcaWorkers)
    .innerJoin(orcaTeams, eq(orcaTeams.id, orcaWorkers.teamId))
    .where(eq(orcaWorkers.sessionId, workerSessionId))
    .limit(1);
  return row ? teamToRecord(row.team) : null;
}

export async function addOrUpdateWorker(input: {
  id: string;
  teamId?: string;
  leadSessionId?: string;
  sessionId: string;
  status?: OrcaWorkerStatus;
  label?: string | null;
  worktreeBranch?: string | null;
  role?: string;
  focused?: boolean;
  idleSince?: number | null;
}): Promise<OrcaWorkerRecord> {
  const team =
    input.teamId
      ? await getTeamById(input.teamId)
      : input.leadSessionId
        ? await createOrGetTeamForLead({ leadSessionId: input.leadSessionId })
        : null;
  if (!team) {
    throwIpcError('INVALID_PARAMS', 'teamId or leadSessionId is required to add an Orca worker');
  }

  const now = Date.now();

  // clear-focus + select + upsert 需要原子性 —— DbClient.drizzle 是 worker-thread
  // 异步代理, 不支持同步 db.transaction, 故走命名事务在 worker 内一个事务里执行。
  // 可选字段为 undefined 表示 "保留 existing 当前值", 与原 drizzle 写法语义一致。
  await getDbClient().tx('orca.upsertWorker', {
    id: input.id,
    teamId: team.id,
    sessionId: input.sessionId,
    status: input.status,
    label: input.label?.toLowerCase() ?? input.label,
    worktreeBranch: input.worktreeBranch,
    role: input.role,
    focused: input.focused,
    idleSince: input.idleSince,
    now,
  });
  await setSessionOrcaRole(input.sessionId, 'worker');
  const workers = await listWorkersByLead(team.leadSessionId);
  const worker = workers.find((w) => w.id === input.id || w.sessionId === input.sessionId);
  if (!worker) throwIpcError('INTERNAL', `Orca worker ${input.id} was not found after save`);
  return worker;
}

export async function listWorkersByLead(
  leadSessionId: string,
): Promise<OrcaWorkerRecord[]> {
  const grouped = await listWorkersByLeads([leadSessionId]);
  return grouped[leadSessionId] ?? [];
}

export async function listWorkersByLeads(
  leadSessionIds: readonly string[],
): Promise<Record<string, OrcaWorkerRecord[]>> {
  const uniqueLeadSessionIds = [...new Set(leadSessionIds)];
  const grouped = Object.fromEntries(uniqueLeadSessionIds.map((id) => [id, [] as OrcaWorkerRecord[]]));
  if (uniqueLeadSessionIds.length === 0) {
    return grouped;
  }
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ worker: orcaWorkers, team: orcaTeams, session: sessions })
    .from(orcaWorkers)
    .innerJoin(orcaTeams, eq(orcaTeams.id, orcaWorkers.teamId))
    .innerJoin(sessions, eq(sessions.id, orcaWorkers.sessionId))
    .where(and(
      inArray(orcaTeams.leadSessionId, uniqueLeadSessionIds),
      eq(orcaTeams.status, 'active'),
      eq(sessions.status, 'active'),
    ))
    .orderBy(orcaTeams.leadSessionId, desc(orcaWorkers.createdAt));
  for (const row of rows) {
    grouped[row.team.leadSessionId]?.push(workerToRecord(row.worker, row.team, row.session));
  }
  return grouped;
}

export async function getWorkerLink(input: {
  workerId?: string;
  workerSessionId?: string;
}): Promise<OrcaWorkerLinkRecord | null> {
  const conditions = [
    input.workerId ? eq(orcaWorkers.id, input.workerId) : null,
    input.workerSessionId ? eq(orcaWorkers.sessionId, input.workerSessionId) : null,
  ].filter((condition): condition is NonNullable<typeof condition> => condition !== null);
  if (conditions.length === 0) return null;

  const db = getDbClient().drizzle;
  const where = conditions.length === 1 ? conditions[0] : and(conditions[0], conditions[1]);
  const [row] = await db
    .select({ worker: orcaWorkers, team: orcaTeams, leadSession: sessions })
    .from(orcaWorkers)
    .innerJoin(orcaTeams, eq(orcaTeams.id, orcaWorkers.teamId))
    .innerJoin(sessions, eq(sessions.id, orcaTeams.leadSessionId))
    .where(where)
    .limit(1);
  if (!row) return null;
  return {
    workerId: row.worker.id,
    teamId: row.team.id,
    workerSessionId: row.worker.sessionId,
    leadSessionId: row.team.leadSessionId,
    leadSession: {
      sessionId: row.leadSession.id,
      agentKind: fromDbAgentKind(row.leadSession.agentKind),
      workingDir: row.leadSession.workingDir ?? '',
      model: row.leadSession.model,
      providerId: row.leadSession.providerId ?? null,
      effort: row.leadSession.effort,
      permissionMode: row.leadSession.permissionMode,
      fastMode: !!row.leadSession.fastMode,
      sdkSessionId: row.leadSession.sdkSessionId ?? undefined,
      title: row.leadSession.title,
      remoteHostId: row.leadSession.remoteHostId ?? null,
    },
  };
}

export async function getSessionOrcaRole(sessionId: string): Promise<OrcaRole | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({ orcaRole: sessions.orcaRole })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row?.orcaRole === 'lead' || row?.orcaRole === 'worker' ? row.orcaRole : null;
}

/**
 * 设置 worker 的 task status。**`status === 'running'` 时会同时清掉 `idleSince`**
 * (idle→running 唤醒收敛点, 见 review F3)。其他状态切换不动 `idleSince`,
 * 调用方若需要显式 set/clear, 直接走 db.update。
 */
export async function updateWorkerStatus(
  workerId: string,
  status: OrcaWorkerStatus,
): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(orcaWorkers)
    .set({
      status,
      updatedAt: Date.now(),
      ...(status === 'running' ? { idleSince: null } : {}),
    })
    .where(eq(orcaWorkers.id, workerId));
}

/** Atomically marks a worker idle only while it still has the expected status. */
export async function markWorkerIdleIfStatus(
  workerId: string,
  expectedStatus: OrcaWorkerStatus,
): Promise<boolean> {
  const db = getDbClient().drizzle;
  const now = Date.now();
  const result = await db
    .update(orcaWorkers)
    .set({ status: 'idle', idleSince: now, updatedAt: now })
    .where(and(eq(orcaWorkers.id, workerId), eq(orcaWorkers.status, expectedStatus)))
    .run();
  return result.changes > 0;
}

/** Restores a raced done acknowledgement only while the worker is still idle. */
export async function restoreWorkerDoneIfIdle(workerId: string): Promise<boolean> {
  const db = getDbClient().drizzle;
  const now = Date.now();
  const result = await db
    .update(orcaWorkers)
    .set({ status: 'done', idleSince: null, updatedAt: now })
    .where(and(eq(orcaWorkers.id, workerId), eq(orcaWorkers.status, 'idle')))
    .run();
  return result.changes > 0;
}

/**
 * create_worker 派发失败补偿：移除尚未成功 dispatch 的 worker link，并归档对应 session。
 * 这条路径只服务失败清理，不影响正常协同结束时保留历史 worker link 的语义。
 */
export async function removeWorker(workerId: string): Promise<void> {
  const client = getDbClient();
  const removedSessionId = await client.tx('orca.removeWorker', {
    workerId,
    now: Date.now(),
  });
  if (removedSessionId) {
    broadcastSessionPatch(removedSessionId, { status: 'archived', orcaRole: null });
    void compactSessionToolResultsBestEffort({ client, sessionId: removedSessionId });
  }
}

/**
 * 原子切换 team 内的 focused worker: 清掉所有旧 focused + set 目标 focused=true。
 * 抽出来给 IPC switch_focus 和 MCP switchFocus 两条入口共用, 避免 transaction body
 * 各 inline 一份后漂移(review F4 落地后的 follow-up; reuse review 命中)。
 */
export async function setWorkerFocus(teamId: string, workerId: string): Promise<void> {
  // 清旧 focused + set 新 focused 需要原子性。DbClient.drizzle 是 worker-thread 异步
  // 代理, 不支持同步 db.transaction, 故走命名事务在 worker 内一个事务里执行。
  await getDbClient().tx('orca.setWorkerFocus', { teamId, workerId, now: Date.now() });
}

/**
 * 归档单个 worker session, 不牵连同 team 其他 worker。
 */
export async function archiveSingleWorkerSession(sessionId: string): Promise<void> {
  const client = getDbClient();
  const changed = await withSessionRouteLock(sessionId, async () => {
    const result = await client.drizzle
      .update(sessions)
      .set({ status: 'archived', updatedAt: Date.now() })
      .where(and(eq(sessions.id, sessionId), ne(sessions.status, 'deleted')))
      .run();
    if (result.changes === 0) return false;
    cleanupSessionRuntimeForTerminalStatus(sessionId, 'archived');
    return true;
  });
  if (changed) {
    broadcastSessionPatch(sessionId, { status: 'archived' });
    void compactSessionToolResultsBestEffort({ client, sessionId });
  }
}

async function listActiveWorkerSessionIdsForTeam(teamId: string): Promise<string[]> {
  const rows = await getDbClient().drizzle
    .select({ id: sessions.id })
    .from(orcaWorkers)
    .innerJoin(sessions, eq(orcaWorkers.sessionId, sessions.id))
    .where(and(eq(orcaWorkers.teamId, teamId), eq(sessions.status, 'active')))
    .orderBy(sessions.id);
  return rows.map((row) => row.id);
}

async function listActiveWorkerSessionIdsForInactiveTeams(
  leadSessionId: string,
): Promise<string[]> {
  const rows = await getDbClient().drizzle
    .select({ id: sessions.id })
    .from(orcaWorkers)
    .innerJoin(orcaTeams, eq(orcaWorkers.teamId, orcaTeams.id))
    .innerJoin(sessions, eq(orcaWorkers.sessionId, sessions.id))
    .where(and(
      eq(orcaTeams.leadSessionId, leadSessionId),
      ne(orcaTeams.status, 'active'),
      eq(sessions.status, 'active'),
    ))
    .orderBy(sessions.id);
  return rows.map((row) => row.id);
}

export async function setSessionOrcaRole(
  sessionId: string,
  role: OrcaRole | null,
): Promise<void> {
  const db = getDbClient().drizzle;
  await db.update(sessions).set({ orcaRole: role }).where(eq(sessions.id, sessionId));
  broadcastSessionPatch(sessionId, { orcaRole: role });
}

async function getTeamById(id: string): Promise<OrcaTeamRecord | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select()
    .from(orcaTeams)
    .where(eq(orcaTeams.id, id))
    .limit(1);
  return row ? teamToRecord(row) : null;
}

function teamToRecord(row: typeof orcaTeams.$inferSelect): OrcaTeamRecord {
  return {
    id: row.id,
    leadSessionId: row.leadSessionId,
    status: row.status as OrcaTeamStatus,
    completedAt: msToIso(row.completedAt),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function workerToRecord(
  worker: typeof orcaWorkers.$inferSelect,
  team: typeof orcaTeams.$inferSelect,
  session: typeof sessions.$inferSelect,
): OrcaWorkerRecord {
  return {
    id: worker.id,
    teamId: worker.teamId,
    leadSessionId: team.leadSessionId,
    sessionId: worker.sessionId,
    status: worker.status as OrcaWorkerStatus,
    label: worker.label,
    worktreeBranch: worker.worktreeBranch,
    role: worker.role,
    focused: worker.focused,
    idleSince: msToIso(worker.idleSince),
    createdAt: new Date(worker.createdAt).toISOString(),
    updatedAt: new Date(worker.updatedAt).toISOString(),
    session: {
      id: session.id,
      title: session.title,
      agentKind: fromDbAgentKind(session.agentKind),
      workingDir: session.workingDir ?? '',
      model: session.model,
      effort: session.effort,
      permissionMode: session.permissionMode,
      fastMode: !!session.fastMode,
      sdkSessionId: session.sdkSessionId ?? undefined,
    },
  };
}

function fromDbAgentKind(agentKind: string): MakerAgentKind {
  return agentKind === 'codex' || agentKind === 'pi' ? agentKind : 'claude-code';
}

function msToIso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

function broadcastSessionPatch(sessionId: string, patch: Record<string, unknown>): void {
  notifyAgentIslandSessionPatch(sessionId, patch);
  tapWindowBroadcast('local-db:sessions:patched', { sessionId, patch });
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('local-db:sessions:patched', { sessionId, patch });
    } catch {
      // best effort only
    }
  }
}
