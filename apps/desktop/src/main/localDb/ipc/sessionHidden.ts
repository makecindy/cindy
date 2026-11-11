import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import type { DbClient } from '../client/DbClient.js';
import { getCurrentDbClientSnapshot, getDbClient } from '../client/current.js';
import { sessions } from '../schema.js';
import { noteSessionHidden } from '../sessionFlagRegistry.js';
import { notifyAgentIslandSessionPatch } from '../agentIslandSessionPatch.js';
import { broadcastSessionPatched } from './sessions.js';
import { emitSessionCreated } from './sessionCreatedBroadcast.js';

/**
 * `sessions.hidden_at` 的唯一宿主写入口（插件 setHidden、详情页「显示到任务列表」、
 * 卸载时恢复显示共用）。创建时直接带 hidden_at 落库的路径见 createPluginTaskSession。
 *
 * - 隐藏：只写 hidden_at，不改 updatedAt；广播 `sessions:patched {hiddenAt}`，
 *   renderer 据此把任务移出列表，灵动岛同步收起该任务。
 * - 显示：清 hidden_at 并刷新 updatedAt（让任务落在列表前部、不被 1000 条上限截掉），
 *   广播 patched 后再发一次「新建」推送，复用侧栏与远端控制端的整体重拉。
 *
 * 已删除任务不处理；状态未变化时返回 false 且不广播。调用方负责归属与权限校验，
 * `assertCurrent` 在写入前同步执行，用于复核账号与插件授权。
 */
export async function setSessionHidden(input: {
  sessionId: string;
  hidden: boolean;
  db?: DbClient;
  assertCurrent?: () => void;
  now?: number;
}): Promise<boolean> {
  const client = input.db ?? getDbClient();
  const now = input.now ?? Date.now();
  input.assertCurrent?.();
  const updated = await client.drizzle
    .update(sessions)
    .set(input.hidden ? { hiddenAt: now } : { hiddenAt: null, updatedAt: now })
    .where(and(
      eq(sessions.id, input.sessionId),
      ne(sessions.status, 'deleted'),
      input.hidden ? isNull(sessions.hiddenAt) : isNotNull(sessions.hiddenAt),
    ))
    .returning({ id: sessions.id });
  if (!updated.length) return false;
  noteSessionHidden(input.sessionId, input.hidden, client);
  // 账号已切换时不向新账号的窗口广播旧账号的任务变化。
  if (getCurrentDbClientSnapshot()?.client !== client) return true;
  const iso = new Date(now).toISOString();
  if (input.hidden) {
    broadcastSessionPatched(input.sessionId, { hiddenAt: iso });
    notifyAgentIslandSessionPatch(input.sessionId, { hiddenAt: iso });
  } else {
    broadcastSessionPatched(input.sessionId, { hiddenAt: null, updatedAt: iso });
    emitSessionCreated(input.sessionId);
  }
  return true;
}
