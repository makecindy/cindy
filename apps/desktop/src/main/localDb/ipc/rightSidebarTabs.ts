/**
 * 右侧栏 Tab 持久化 IPC —— per-session 的多 Tab 容器(对标 Codex in-app browser sidebar)。
 *
 * 6 个 channel(全部 `local-db:right-sidebar-tabs:*`):
 *   - `:list`        按 session 拉 tab 列表 + activeTabId
 *   - `:ensure-singleton` 原子创建/读取声明为单例的 tab kind
 *   - `:upsert`      新增 / 更新单个 tab(state JSON / position 等)
 *   - `:close`       删除单个 tab
 *   - `:setActive`   切换激活 tab(先清同 session 旧 active 再设新 active)
 *   - `:reorder`     一次性重写 same session 内全部 tab 的 position
 *
 * 约束 / 校验(全部走 `throwIpcError`,规则 13):
 *   - tab 数 ≤ 20/session             → 超抛 `RIGHT_SIDEBAR_TOO_MANY_TABS`
 *   - state JSON 序列化 ≤ 16KB         → 超抛 `RIGHT_SIDEBAR_STATE_TOO_LARGE`
 *   - kind 在 plugin registry         → renderer 端注册 plugin 时定义,本层不校验白名单
 *     (避免 schema 和 renderer kinds 双源真相不同步;renderer 端调用前已校验)
 *
 * 大小数据:
 *   - 按单条 state 上限与常见 tab 数估算,普通用户 1 年约 600KB,重度用户约 3.5MB。
 *   - `ON DELETE CASCADE` 联动 sessions 表,删 session 自动清相关 tab,无孤立行。
 */

import { ipcMain } from 'electron';
import { createId } from '@paralleldrive/cuid2';
import { and, asc, eq } from 'drizzle-orm';

import { getDbClient } from '../client/current.js';
import { rightSidebarTabs, sessions } from '../schema.js';
import { MAX_STATE_JSON_BYTES } from '../../../shared/rightSidebarTabState.js';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate.js';
import { createLogger } from '../../logger.js';

const log = createLogger('rightSidebarTabs');

/** 单 session 最多 20 个 tab,超抛 RIGHT_SIDEBAR_TOO_MANY_TABS。 */
const MAX_TABS_PER_SESSION = 20;
const SINGLETON_TAB_KINDS = new Set(['subagents']);

export interface TabRow {
  id: string;
  sessionId: string;
  kind: string;
  position: number;
  state: unknown;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

function parseState(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // 不该发生(写入时已 stringify),保守降级返回 null
    return null;
  }
}

function rowToTab(row: typeof rightSidebarTabs.$inferSelect): TabRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    position: row.position,
    state: parseState(row.state),
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throwIpcError('INVALID_PARAMS', `${name} must be a non-negative integer`);
  }
  return value;
}

function serializeState(value: unknown): string {
  // undefined → 用默认 '{}';其它一律 stringify(包含 null,plugin 真要存 null 也能存)
  if (value === undefined) return '{}';
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throwIpcError('INVALID_PARAMS', 'tab state must be JSON-serializable');
  }
  // JSON.stringify 顶层 function / symbol 时不抛错而返回 undefined,不能交给 DB。
  if (typeof json !== 'string') {
    throwIpcError('INVALID_PARAMS', 'tab state must be JSON-serializable');
  }
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_STATE_JSON_BYTES) {
    throwIpcError(
      'RIGHT_SIDEBAR_STATE_TOO_LARGE',
      `tab state JSON too large: ${bytes} bytes (limit ${MAX_STATE_JSON_BYTES})`,
    );
  }
  return json;
}

export function registerRightSidebarTabsIpc(): void {
  ipcMain.handle('local-db:right-sidebar-tabs:list', async (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    const obj = requireObject(payload, 'list payload');
    const sessionId = requireString(obj.sessionId, 'sessionId');
    const db = getDbClient().drizzle;
    const sessionExists = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (sessionExists.length === 0) {
      return {
        tabs: [],
        activeTabId: null,
        persistable: false,
      };
    }
    const rows = await db
      .select()
      .from(rightSidebarTabs)
      .where(eq(rightSidebarTabs.sessionId, sessionId))
      .orderBy(asc(rightSidebarTabs.position));
    const activeRow = rows.find((r) => r.isActive);
    return {
      tabs: rows.map(rowToTab),
      activeTabId: activeRow?.id ?? null,
      persistable: true,
    };
  });

  // Renderer caches are per window, so find-then-add there cannot enforce a
  // singleton while attached/detached hosts overlap. The partial unique index
  // is the authority; INSERT OR IGNORE + re-read returns one canonical row to
  // every caller without changing the user's active tab.
  ipcMain.handle('local-db:right-sidebar-tabs:ensure-singleton', async (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    const obj = requireObject(payload, 'ensure singleton payload');
    const sessionId = requireString(obj.sessionId, 'sessionId');
    const kind = requireString(obj.kind, 'kind');
    if (!SINGLETON_TAB_KINDS.has(kind)) {
      throwIpcError('INVALID_PARAMS', `${kind} is not a singleton tab kind`);
    }
    const stateJson = serializeState(obj.state);
    const db = getDbClient().drizzle;
    const sessionExists = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (sessionExists.length === 0) {
      return { tab: null, created: false, persistable: false };
    }
    const [existing] = await db
      .select()
      .from(rightSidebarTabs)
      .where(and(eq(rightSidebarTabs.sessionId, sessionId), eq(rightSidebarTabs.kind, kind)))
      .limit(1);
    if (existing) {
      return { tab: rowToTab(existing), created: false, persistable: true };
    }
    const current = await db
      .select({ id: rightSidebarTabs.id })
      .from(rightSidebarTabs)
      .where(eq(rightSidebarTabs.sessionId, sessionId));
    if (current.length >= MAX_TABS_PER_SESSION) {
      throwIpcError(
        'RIGHT_SIDEBAR_TOO_MANY_TABS',
        `session ${sessionId} already has ${MAX_TABS_PER_SESSION} tabs (limit reached)`,
      );
    }
    const now = Date.now();
    const id = `t_${createId()}`;
    await db
      .insert(rightSidebarTabs)
      .values({
        id,
        sessionId,
        kind,
        position: current.length,
        state: stateJson,
        isActive: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const [canonical] = await db
      .select()
      .from(rightSidebarTabs)
      .where(and(eq(rightSidebarTabs.sessionId, sessionId), eq(rightSidebarTabs.kind, kind)))
      .limit(1);
    if (!canonical) throw new Error(`failed to ensure ${kind} tab for session ${sessionId}`);
    return {
      tab: rowToTab(canonical),
      created: canonical.id === id,
      persistable: true,
    };
  });

  // upsert: 新增或更新 tab(state / position / kind)。kind 不变(新 tab 注册时定),
  // 但接口允许传以保持 IPC 形态对称(renderer 拿到 unknown kind 时可以 fallback)。
  ipcMain.handle('local-db:right-sidebar-tabs:upsert', async (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    const obj = requireObject(payload, 'upsert payload');
    const id = requireString(obj.id, 'id');
    const sessionId = requireString(obj.sessionId, 'sessionId');
    const kind = requireString(obj.kind, 'kind');
    const position = requireInt(obj.position, 'position');
    const stateJson = serializeState(obj.state);
    const db = getDbClient().drizzle;
    // tab count 上限:仅在"新增"路径上校验(更新已有 tab 不增加总数)
    const existing = await db
      .select({ id: rightSidebarTabs.id })
      .from(rightSidebarTabs)
      .where(eq(rightSidebarTabs.sessionId, sessionId));
    const isNew = !existing.some((r) => r.id === id);
    if (isNew && existing.length >= MAX_TABS_PER_SESSION) {
      throwIpcError(
        'RIGHT_SIDEBAR_TOO_MANY_TABS',
        `session ${sessionId} already has ${MAX_TABS_PER_SESSION} tabs (limit reached)`,
      );
    }
    const now = Date.now();
    await db
      .insert(rightSidebarTabs)
      .values({
        id,
        sessionId,
        kind,
        position,
        state: stateJson,
        isActive: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: rightSidebarTabs.id,
        set: { kind, position, state: stateJson, updatedAt: now },
      });
    return { ok: true };
  });

  ipcMain.handle('local-db:right-sidebar-tabs:close', async (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    const obj = requireObject(payload, 'close payload');
    const id = requireString(obj.id, 'id');
    const db = getDbClient().drizzle;
    // SELECT 验证存在再 DELETE,不用 `.delete().returning()` —— 本仓 SQLite 上不使用
    // drizzle 的 update/delete `.returning()`(grep 验证全仓 0 处)。
    const exists = await db
      .select({ id: rightSidebarTabs.id })
      .from(rightSidebarTabs)
      .where(eq(rightSidebarTabs.id, id))
      .limit(1);
    if (exists.length === 0) {
      throwIpcError('NOT_FOUND', `tab ${id} not found`);
    }
    await db.delete(rightSidebarTabs).where(eq(rightSidebarTabs.id, id));
    return { ok: true };
  });

  // setActive: 先把 session 内所有 tab 设 inactive,再设 target 为 active(targetId=null
  // 表示无激活态,close last tab 时使用)。两步操作不在事务里 —— 单 session 内 tab 数 ≤ 20,
  // 失败概率极低;真出现中间态 next list 时 UI 会展示"无激活 tab",用户重新点一下就好。
  ipcMain.handle('local-db:right-sidebar-tabs:setActive', async (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    const obj = requireObject(payload, 'setActive payload');
    const sessionId = requireString(obj.sessionId, 'sessionId');
    const targetId = obj.id === null ? null : requireString(obj.id, 'id');
    const db = getDbClient().drizzle;
    const now = Date.now();
    await db
      .update(rightSidebarTabs)
      .set({ isActive: false, updatedAt: now })
      .where(eq(rightSidebarTabs.sessionId, sessionId));
    if (targetId !== null) {
      // SELECT 验证存在再 UPDATE,不用 `.update().returning()` —— 本仓 SQLite 上不使用
      // drizzle 的 update/delete `.returning()`(grep 验证全仓 0 处);某些 drizzle 版本
      // 在 update returning 上行为不一致(测试 setup 与 production 之间存在差异),
      // 直接用 select + 无 returning update 最稳。
      const exists = await db
        .select({ id: rightSidebarTabs.id })
        .from(rightSidebarTabs)
        .where(and(eq(rightSidebarTabs.id, targetId), eq(rightSidebarTabs.sessionId, sessionId)))
        .limit(1);
      if (exists.length === 0) {
        throwIpcError('NOT_FOUND', `tab ${targetId} not found in session ${sessionId}`);
      }
      await db
        .update(rightSidebarTabs)
        .set({ isActive: true, updatedAt: now })
        .where(and(eq(rightSidebarTabs.id, targetId), eq(rightSidebarTabs.sessionId, sessionId)));
    }
    return { ok: true };
  });

  // reorder: 一次性重写 same session 内全部 tab 的 position;orderedIds 数组下标 = 新 position。
  // 数组里漏的 id 不会被改动 —— renderer 端调用时应该传完整 orderedIds(同 session 当前全部 tab id)。
  ipcMain.handle('local-db:right-sidebar-tabs:reorder', async (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    const obj = requireObject(payload, 'reorder payload');
    const sessionId = requireString(obj.sessionId, 'sessionId');
    if (!Array.isArray(obj.orderedIds)) {
      throwIpcError('INVALID_PARAMS', 'orderedIds must be an array');
    }
    const orderedIds: string[] = (obj.orderedIds as unknown[]).map((id, i) => {
      if (typeof id !== 'string' || id === '') {
        throwIpcError('INVALID_PARAMS', `orderedIds[${i}] must be a non-empty string`);
      }
      return id;
    });
    const db = getDbClient().drizzle;
    const now = Date.now();
    for (let i = 0; i < orderedIds.length; i++) {
      await db
        .update(rightSidebarTabs)
        .set({ position: i, updatedAt: now })
        .where(
          and(eq(rightSidebarTabs.id, orderedIds[i]), eq(rightSidebarTabs.sessionId, sessionId)),
        );
    }
    return { ok: true };
  });

  log.info('rightSidebarTabs IPC handlers registered');
}
