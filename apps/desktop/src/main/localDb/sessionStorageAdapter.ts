/**
 * Owner-database session metadata mapping, shared by the Desktop host and the
 * Node `cindy-host`. The client is injected; this module imports no Electron.
 */

import { and, eq, inArray } from 'drizzle-orm';

import type { AgentKind, SessionMeta, SessionStorage, WorkspaceKind } from '@cindy/maker-core';

import { dbToMakerAgentKind, makerToDbAgentKind } from '../../shared/agentKindConversion.js';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../shared/sessionSource.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import { normalizeRemoteHostId } from '../localDb/mapper.js';
import { sessions } from '../localDb/schema.js';

type DbAgentKind = 'cc' | 'codex' | 'pi';

function toDbKind(k: AgentKind): DbAgentKind {
  return makerToDbAgentKind(k);
}

function fromDbKind(k: string): AgentKind {
  return dbToMakerAgentKind(k);
}

function normalizeWorkspaceKind(value: unknown): WorkspaceKind {
  return value === 'dialogue' ? 'dialogue' : 'project';
}

type SessionRow = typeof sessions.$inferSelect;

function rowToMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    agentKind: fromDbKind(row.agentKind),
    workDir: row.workingDir ?? '',
    title: row.title,
    model: row.model,
    workspaceKind: row.workspaceKind,
    projectDir: row.projectDir,
    effort: row.effort,
    permissionMode: row.permissionMode,
    fastMode: row.fastMode,
    planMode: row.planModeEnabled,
    ...(row.source === 'review' ? { reviewMode: true as const } : {}),
    sdkSessionId: row.sdkSessionId ?? undefined,
    parentSessionId: row.parentSessionId ?? undefined,
    remoteHostId: row.remoteHostId ?? undefined,
    ...(row.agentDeviceId ? { agentDeviceId: row.agentDeviceId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Session metadata persistence over the owner database client.
 *
 * The client is injected so the Node `cindy-host` reuses this exact mapping
 * against its own connection instead of growing a second sessions adapter.
 */
export interface SessionStorageDeps {
  /** Current owner-bound client; the host swaps it at account boundaries. */
  db(): DbClient;
  /** Optional per-owner preference cleanup when a task row is hard-deleted. */
  pruneSessionContextBudget?(sessionId: string): void;
}

export class OwnerSessionStorage implements SessionStorage {
  constructor(private readonly deps: SessionStorageDeps) {}

  async create(meta: Omit<SessionMeta, 'createdAt' | 'updatedAt'>): Promise<SessionMeta> {
    const db = this.deps.db().drizzle;
    const now = Date.now();
    const workingDir = normalizeWorkingDirForStorage(meta.workDir);
    await db.insert(sessions).values({
      id: meta.id,
      title: meta.title,
      workingDir,
      workspaceKind: normalizeWorkspaceKind(meta.workspaceKind),
      projectDir: normalizeWorkingDirForStorage(meta.projectDir),
      model: meta.model,
      effort: meta.effort ?? 'high',
      permissionMode: meta.permissionMode ?? 'ask',
      fastMode: meta.fastMode ?? false,
      planModeEnabled: meta.planMode ?? false,
      status: 'active',
      sdkSessionId: meta.sdkSessionId ?? null,
      agentKind: toDbKind(meta.agentKind),
      parentSessionId: meta.parentSessionId ?? null,
      // null = 本地 session (老 row 也是 null, 兼容); 非空 = 远端 host alias。
      // 与 localDb sessions:create 同一规范化:trim 后非空才算 remote,空串/空白落 null,
      // 避免 maker.createSession (maker:create-session / scheduler / Feishu / Orca 等入口)
      // 把空白 host 原样入库,导致 renderer 按 local 分组、maker 按 remote-like 处理的分裂。
      remoteHostId: normalizeRemoteHostId(meta.remoteHostId),
      agentDeviceId: normalizeRemoteHostId(meta.remoteHostId) ? null : normalizeRemoteHostId(meta.agentDeviceId),
      source: meta.reviewMode === true ? 'review' : 'desktop',
      createdAt: now,
      updatedAt: now,
    });
    return { ...meta, workDir: workingDir ?? '', createdAt: now, updatedAt: now };
  }

  async get(id: string): Promise<SessionMeta | null> {
    const db = this.deps.db().drizzle;
    const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return rows[0] ? rowToMeta(rows[0]) : null;
  }

  /** Read the product lifecycle status without widening maker-core SessionMeta. */
  async getStatus(id: string): Promise<'active' | 'archived' | 'deleted' | null> {
    const db = this.deps.db().drizzle;
    const rows = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);
    const status = rows[0]?.status;
    return status === 'active' || status === 'archived' || status === 'deleted' ? status : null;
  }

  async list(): Promise<SessionMeta[]> {
    const db = this.deps.db().drizzle;
    const rows = await db
      .select()
      .from(sessions)
      .where(inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES));
    return rows.map(rowToMeta);
  }

  async update(id: string, patch: Partial<SessionMeta>): Promise<SessionMeta> {
    const db = this.deps.db().drizzle;
    const updateFields: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.title !== undefined) updateFields.title = patch.title;
    if (patch.model !== undefined) updateFields.model = patch.model;
    if (patch.sdkSessionId !== undefined) updateFields.sdkSessionId = patch.sdkSessionId;
    // DB 的 status 列 ('active'|'archived'|'deleted') 是产品归档语义, 走 IPC local-db:sessions:update,
    // 不在这里写 —— maker-core 接口已经移除了 status 字段。
    await db.update(sessions).set(updateFields).where(eq(sessions.id, id));
    // The write and its readback belong to the same captured database, even
    // when the active account changes while the write is settling.
    const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    if (!rows[0]) throw new Error(`Session ${id} not found after update`);
    return rowToMeta(rows[0]);
  }

  async compareAndClearSdkSessionId(
    id: string,
    expectedSdkSessionId: string,
  ): Promise<boolean> {
    const db = this.deps.db().drizzle;
    const result = await db
      .update(sessions)
      .set({ sdkSessionId: null, updatedAt: Date.now() })
      .where(and(eq(sessions.id, id), eq(sessions.sdkSessionId, expectedSdkSessionId)))
      .run();
    return result.changes > 0;
  }

  async delete(id: string): Promise<void> {
    const db = this.deps.db().drizzle;
    await db.delete(sessions).where(eq(sessions.id, id));
    // 任务行已消失，偏好文件里的档位条目也就没有意义了（软删除保留行，故不在这里清理）。
    try {
      this.deps.pruneSessionContextBudget?.(id);
    } catch (error) {
      console.warn('[session-storage] pruning context window budget failed', {
        sessionId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

