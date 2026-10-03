/**
 * Desktop SessionStorage 实现 —— 直接 drizzle 操作 sessions 表。
 *
 * AgentKind 翻译：
 *   maker-core 'claude-code' ⇄ db 'cc'
 *   maker-core 'codex'       ⇄ db 'codex'
 *
 * 注意：本轮 (stage-1) 是新链路独立写入，不会影响老链路 ('local-db:sessions:*' IPC) 的查询/读取。
 * 两边读同一张表，新链路默认 source='desktop'；host-owned Review 在同一 INSERT
 * 原子写 source='review'，自动化 runner 仍会在创建后 backfill 为 'scheduler'。
 */

import { and, eq, inArray, ne } from 'drizzle-orm';

import { dbToMakerAgentKind, makerToDbAgentKind } from '../../shared/agentKindConversion.js';

import type {
  AgentKind,
  SessionMeta,
  SessionStorage,
  WorkspaceKind,
} from '@cindy/maker-core';

import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { normalizeRemoteHostId } from '../localDb/mapper.js';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../shared/sessionSource.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';

type DbAgentKind = 'cc' | 'codex' | 'pi';

// 形态映射走 shared/agentKindConversion 正本(支持 pi;此前 pi 被误落成 codex)。
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
  // 注意: row.status (DB 的 'active'|'archived'|'deleted') 是产品语义, 由 sidebar IPC 自管,
  // 不映射到 SessionMeta —— maker-core 接口已不再持有 status 字段。
  return {
    id: row.id,
    agentKind: fromDbKind(row.agentKind),
    workDir: row.workingDir ?? '',
    title: row.title,
    model: row.model,
    workspaceKind: row.workspaceKind,
    effort: row.effort,
    permissionMode: row.permissionMode,
    fastMode: row.fastMode,
    ...(row.source === 'review' ? { reviewMode: true as const } : {}),
    sdkSessionId: row.sdkSessionId ?? undefined,
    parentSessionId: row.parentSessionId ?? undefined,
    remoteHostId: row.remoteHostId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DesktopSessionStorage implements SessionStorage {
  async create(meta: Omit<SessionMeta, 'createdAt' | 'updatedAt'>): Promise<SessionMeta> {
    const db = getDbClient().drizzle;
    const now = Date.now();
    const workingDir = normalizeWorkingDirForStorage(meta.workDir);
    await db.insert(sessions).values({
      id: meta.id,
      title: meta.title,
      workingDir,
      workspaceKind: normalizeWorkspaceKind(meta.workspaceKind),
      model: meta.model,
      effort: meta.effort ?? 'high',
      permissionMode: meta.permissionMode ?? 'ask',
      fastMode: meta.fastMode ?? false,
      status: 'active',
      sdkSessionId: meta.sdkSessionId ?? null,
      agentKind: toDbKind(meta.agentKind),
      parentSessionId: meta.parentSessionId ?? null,
      // null = 本地 session (老 row 也是 null, 兼容); 非空 = 远端 host alias。
      // 与 localDb sessions:create 同一规范化:trim 后非空才算 remote,空串/空白落 null,
      // 避免 maker.createSession (maker:create-session / scheduler / Feishu / Orca 等入口)
      // 把空白 host 原样入库,导致 renderer 按 local 分组、maker 按 remote-like 处理的分裂。
      remoteHostId: normalizeRemoteHostId(meta.remoteHostId),
      source: meta.reviewMode === true ? 'review' : 'desktop',
      createdAt: now,
      updatedAt: now,
    });
    return { ...meta, workDir: workingDir ?? '', createdAt: now, updatedAt: now };
  }

  async get(id: string): Promise<SessionMeta | null> {
    const db = getDbClient().drizzle;
    const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return rows[0] ? rowToMeta(rows[0]) : null;
  }

  /** Read the product lifecycle status without widening maker-core SessionMeta. */
  async getStatus(id: string): Promise<'active' | 'archived' | 'deleted' | null> {
    const db = getDbClient().drizzle;
    const rows = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);
    const status = rows[0]?.status;
    return status === 'active' || status === 'archived' || status === 'deleted' ? status : null;
  }

  async list(): Promise<SessionMeta[]> {
    const db = getDbClient().drizzle;
    const rows = await db
      .select()
      .from(sessions)
      .where(inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES));
    return rows.map(rowToMeta);
  }

  async update(id: string, patch: Partial<SessionMeta>): Promise<SessionMeta> {
    const db = getDbClient().drizzle;
    const updateFields: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.title !== undefined) updateFields.title = patch.title;
    if (patch.model !== undefined) updateFields.model = patch.model;
    if (patch.sdkSessionId !== undefined) updateFields.sdkSessionId = patch.sdkSessionId;
    // DB 的 status 列 ('active'|'archived'|'deleted') 是产品归档语义, 走 IPC local-db:sessions:update,
    // 不在这里写 —— maker-core 接口已经移除了 status 字段。
    await db.update(sessions).set(updateFields).where(eq(sessions.id, id));
    const updated = await this.get(id);
    if (!updated) throw new Error(`Session ${id} not found after update`);
    return updated;
  }

  async compareAndClearSdkSessionId(
    id: string,
    expectedSdkSessionId: string,
  ): Promise<boolean> {
    const db = getDbClient().drizzle;
    const result = await db
      .update(sessions)
      .set({ sdkSessionId: null, updatedAt: Date.now() })
      .where(and(eq(sessions.id, id), eq(sessions.sdkSessionId, expectedSdkSessionId)))
      .run();
    return result.changes > 0;
  }

  async delete(id: string): Promise<void> {
    const db = getDbClient().drizzle;
    await db.delete(sessions).where(eq(sessions.id, id));
  }
}

export const desktopSessionStorage = new DesktopSessionStorage();

/**
 * 标记某 session 创建时注入了 project-context 知识。
 * 由 CREATE_SESSION IPC handler 在 maker.createSession 之后、注入成功时调用。
 * 字段在 schema 默认 false，所以未注入的 session 自然为 false，无需显式写。
 */
export async function markSessionUsedProjectContext(id: string): Promise<void> {
  const db = getDbClient().drizzle;
  await db.update(sessions).set({ usedProjectContext: true }).where(eq(sessions.id, id));
}

export async function readCodexHistoryHasProductPrompt(id: string): Promise<boolean | undefined> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ value: sessions.codexHistoryHasProductPrompt })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  const value = rows[0]?.value;
  return typeof value === 'boolean' ? value : undefined;
}

export async function writeCodexHistoryHasProductPrompt(
  id: string,
  value: boolean,
): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({ codexHistoryHasProductPrompt: value })
    .where(eq(sessions.id, id));
}

/**
 * 读 sessions.working_dir(既有会话的权威值)。SEND lazy-create 把它当唯一真源直接
 * 采纳(caller 传入的 createOpts.workingDir 可能是陈旧快照 —— 输入队列崩溃回放里
 * 内嵌的老路径,或用户把任务移走后排队/重试项里内嵌的旧目录);rehydrate 在 caller
 * 目录校验失败时用它兜底。行不存在 / 空值 → null,不抛错。
 */
export async function readSessionWorkingDirFromDb(id: string): Promise<string | null> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ workingDir: sessions.workingDir })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  const raw = rows[0]?.workingDir;
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/**
 * 读 sessions.extra_dirs (TEXT JSON 数组) 反序列化为 string[]。
 * SEND lazy-create handler 用它兜底 (renderer 不走 createOpts 透传 extraDirs)。
 * 失败 / 空 / 不是数组 → 返回 []，不抛错。
 */
/**
 * 读 working_dir 时同时报告「行是否存在」。lazy-create 必须区分两种 null：
 * 「没有这一行」(首次建 runtime,沿用 caller 快照)与「行在、但 working_dir 已被
 * 显式清空」(DB 明确说这个会话没有目录,不能让排队/重试快照里的旧目录把它复活)。
 */
export async function readSessionWorkingDirRow(
  id: string,
): Promise<{ exists: boolean; workingDir: string | null }> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ workingDir: sessions.workingDir })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return { exists: false, workingDir: null };
  const raw = row.workingDir;
  return {
    exists: true,
    workingDir: typeof raw === 'string' && raw.trim() !== '' ? raw : null,
  };
}

export async function readSessionExtraDirsFromDb(id: string): Promise<string[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ extraDirs: sessions.extraDirs })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  const raw = rows[0]?.extraDirs;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return [];
}

/** 读 sessions.writable_dirs；旧库迁移后默认 []，绝不从 extra_dirs 推导。 */
export async function readSessionWritableDirsFromDb(id: string): Promise<string[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ writableDirs: sessions.writableDirs })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  const raw = rows[0]?.writableDirs;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed;
  } catch {
    /* fall through */
  }
  return [];
}

/** 当前 owner 可见、未删除的桌面会话(含 plugin 入口)。review 不注入 library 槽。 */
export async function listVisibleActiveSessionDirectoryGrants(): Promise<Array<{ id: string; extraDirs: string | null }>> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ id: sessions.id, extraDirs: sessions.extraDirs })
    .from(sessions)
    .where(and(
      inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES),
      eq(sessions.status, 'active'),
      ne(sessions.source, 'review'),
    ));
  return rows;
}
