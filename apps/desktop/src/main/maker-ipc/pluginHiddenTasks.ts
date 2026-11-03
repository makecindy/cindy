import { and, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { DbClient } from '../localDb/client/DbClient.js';
import { pluginTaskRequests, sessions } from '../localDb/schema.js';
import type { PluginBackgroundTask } from '../../shared/pluginTasks.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** 插件详情页「后台任务」一次最多列出的条数（按最后活动时间倒序）。 */
export const PLUGIN_BACKGROUND_TASK_LIST_LIMIT = 1000;

/** 与 pluginTaskStore.list 同一判据：创建回执合法且未被卸载撤销归属。 */
const OWNED_RECEIPT_SQL = sql`(json_valid(${pluginTaskRequests.payload})
  AND json_type(${pluginTaskRequests.payload}) = 'object'
  AND coalesce(json_type(${pluginTaskRequests.payload}, '$.ownershipRevoked'), 'null') != 'true')`;

/**
 * 本插件经创建回执拥有、当前处于后台隐藏（hidden_at 非空）且未删除的普通任务。
 * 只认 create 回执，不按 source='plugin' 一刀切；Worker 与远程任务没有创建回执，天然不在其中。
 */
export async function selectPluginHiddenTaskRows(
  db: DbClient,
  pluginId: string,
  options: { taskId?: string; limit?: number } = {},
): Promise<Array<{ taskId: string; title: string; status: string; updatedAt: number }>> {
  return db.drizzle
    .select({
      taskId: sessions.id,
      title: sessions.title,
      status: sessions.status,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .innerJoin(pluginTaskRequests, eq(pluginTaskRequests.id, sessions.id))
    .where(and(
      eq(pluginTaskRequests.pluginId, pluginId),
      eq(pluginTaskRequests.operation, 'create'),
      eq(sessions.source, 'plugin'),
      isNotNull(sessions.hiddenAt),
      ne(sessions.status, 'deleted'),
      options.taskId ? eq(sessions.id, options.taskId) : undefined,
      OWNED_RECEIPT_SQL,
    ))
    .orderBy(desc(sessions.updatedAt), desc(sessions.id))
    .limit(options.limit ?? PLUGIN_BACKGROUND_TASK_LIST_LIMIT);
}

/**
 * 卸载前把本插件的全部后台任务恢复显示（不受列表展示上限约束）：分批查询并逐条
 * reveal，直到查不到隐藏任务。已恢复过的任务再次出现说明 reveal 没生效，直接抛错，
 * 不死循环；maxBatches（默认 1000）再兜一层上限。
 */
export async function revealAllPluginHiddenTasks(
  db: DbClient,
  pluginId: string,
  reveal: (taskId: string) => Promise<unknown>,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<void> {
  const batchSize = options.batchSize ?? PLUGIN_BACKGROUND_TASK_LIST_LIMIT;
  const maxBatches = options.maxBatches ?? 1000;
  const attempted = new Set<string>();
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await selectPluginHiddenTaskRows(db, pluginId, { limit: batchSize });
    if (rows.length === 0) return;
    for (const row of rows) {
      if (attempted.has(row.taskId)) {
        throw new Error(`Plugin background task ${row.taskId} is still hidden after reveal`);
      }
      attempted.add(row.taskId);
      await reveal(row.taskId);
    }
  }
  throw new Error(`Plugin background tasks still hidden after ${maxBatches} batches`);
}

export interface PluginBackgroundTaskDeps {
  /** 当前账号数据库；未就绪返回 null。 */
  currentDb(): DbClient | null;
  /** 插件是否仍安装在当前账号下（停用的插件也要能查看与接手后台任务）。 */
  isInstalled(pluginId: string): boolean;
  isRunning(taskId: string): boolean;
  setHidden(input: {
    sessionId: string;
    hidden: boolean;
    db: DbClient;
    assertCurrent: () => void;
  }): Promise<boolean>;
}

function requireId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throwIpcError('INVALID_PARAMS', `${name} must be a non-empty string`);
  }
  return value;
}

/**
 * 详情页「后台任务」的两个本机 IPC 业务体（列表 / 显示到任务列表）。
 * 透明性兜底：插件停用后同样可见；只经 Desktop 可信窗口调用，不登记 device-link。
 */
export function createPluginBackgroundTaskHandlers(deps: PluginBackgroundTaskDeps) {
  const requireDb = (pluginId: string): DbClient => {
    const db = deps.currentDb();
    if (!db) throwIpcError('PRECONDITION_FAILED', 'Task storage is unavailable');
    if (!deps.isInstalled(pluginId)) throwIpcError('NOT_FOUND', 'Plugin is not installed');
    return db;
  };
  return {
    list: async (rawPluginId: unknown): Promise<{ items: PluginBackgroundTask[] }> => {
      const pluginId = requireId(rawPluginId, 'pluginId');
      const db = requireDb(pluginId);
      const rows = await selectPluginHiddenTaskRows(db, pluginId);
      if (deps.currentDb() !== db) throwIpcError('PRECONDITION_FAILED', 'Account changed');
      return {
        items: rows.map((row) => ({
          taskId: row.taskId,
          title: row.title,
          status: row.status === 'archived' ? 'archived' : 'active',
          updatedAt: row.updatedAt,
          running: deps.isRunning(row.taskId),
        })),
      };
    },
    reveal: async (rawPluginId: unknown, rawTaskId: unknown): Promise<{ ok: true }> => {
      const pluginId = requireId(rawPluginId, 'pluginId');
      const taskId = requireId(rawTaskId, 'taskId');
      const db = requireDb(pluginId);
      const [row] = await selectPluginHiddenTaskRows(db, pluginId, { taskId });
      // 已经显示（或被别处显示）视为成功：用户意图已达成，列表刷新即可。
      if (!row) return { ok: true };
      await deps.setHidden({
        sessionId: taskId,
        hidden: false,
        db,
        assertCurrent: () => {
          if (deps.currentDb() !== db) throwIpcError('PRECONDITION_FAILED', 'Account changed');
        },
      });
      return { ok: true };
    },
  };
}
