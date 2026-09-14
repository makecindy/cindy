/**
 * xdt-helper/list_workdirs.ts —— history 类工具 1/3。
 *
 * 列出本地 DB 里所有出现过的工作目录(基于 sessions.working_dir, group by + 聚合
 * MIN/MAX createdAt + count + agentKinds)。返回原始毫秒时间戳, 由调用方按需
 * 格式化。
 *
 * 设计:
 *  - 不复用 recent_workdirs 表 — 那只有 LRU 10 条; 用户用工具的目的就是"找全",
 *    要看到所有曾出现的 workdir。
 *  - 已经被软删 (status='deleted') 的 session 不计入聚合。
 *  - 游标分页, 单次硬上限 500, 调用方多次串联拉全量。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperHistoryDeps } from './_history_types.js';
import { okPayload, errorPayload } from './_payload.js';
import { encodeCursor, decodeCursor } from './_history_cursor.js';
import { resolveHistoryScope } from './_history_scope.js';

const DESCRIPTION = [
  `列出 ${BRAND_NAME} 本地数据库里所有出现过的工作目录(workdir), 以及每个 workdir 下`,
  '的 session 总数 / 首次活动时间 / 最后活动时间 / 涉及的 agent 类型(cc / codex)。',
  '',
  '【何时调用】用户想"看看我都在哪些项目里聊过 / 我的工作目录全集是什么 / 哪个',
  '项目我最近最忙"等场景, 或者作为后续 list_sessions / get_chat_history 的入口拿',
  'workdir 列表。',
  '',
  '【过滤】不返回已删除(status=deleted) session 所在的 workdir; 不返回 workingDir',
  '为 NULL 的 session(典型: 对话型 session 没有项目目录绑定)。',
  '',
  '【分页】游标分页, 默认每次返回 50 条, 最大 500。返回 hasMore=true 时, 用响应里',
  '的 nextCursor 再次调用本工具可拿下一页, 多次串联可拿全量(不会丢信息)。',
  '',
  '【输出字段】workingDir(绝对路径) / sessionCount(条数) / firstSessionAt(ISO) /',
  'lastSessionAt(ISO) / agentKinds(cc/codex 数组)。',
].join('\n');

export interface ListWorkdirsToolDeps {
  history: XdtHelperHistoryDeps;
  getSessionContext?: () => import('../types.js').LiziMcpSessionContext | undefined;
}

export function registerListWorkdirsTool(
  registry: XdtHelperToolRegistry,
  deps: ListWorkdirsToolDeps,
): void {
  registry.register({
    name: 'list_workdirs',
    category: 'history',
    description: DESCRIPTION,
    inputShape: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe('单次返回条数, 1-500, 默认 50。超出会被硬截断。'),
      cursor: z
        .string()
        .optional()
        .describe('上次响应的 nextCursor。不传 = 第一页。坏 cursor 自动 fallback 到第一页。'),
      order: z
        .enum(['asc', 'desc'])
        .default('desc')
        .describe('按 lastSessionAt 排序, desc = 最近活动的在前(默认), asc = 最早活动的在前。'),
    },
    handler: async ({ limit, cursor, order }) => {
      const scope = await resolveHistoryScope(deps.history, deps.getSessionContext, null);
      if (!scope.ok) return errorPayload(scope.errorCode, scope.message);
      const cursorObj = decodeCursor(cursor);
      const result = await deps.history.listWorkdirs({
        sessionIds: scope.sessionIds,
        limit,
        cursor: cursorObj,
        order,
      });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload(
            'HOST_NOT_READY',
            `${BRAND_NAME} 本地数据库尚未就绪(典型: app 仍在启动或用户未登录), 请告知用户稍等几秒后重试。`,
          );
        }
        return errorPayload('INTERNAL', result.message);
      }
      const { page } = result;
      return okPayload({
        workdirs: page.items.map((w) => ({
          workingDir: w.workingDir,
          sessionCount: w.sessionCount,
          firstSessionAt: new Date(w.firstSessionAt).toISOString(),
          lastSessionAt: new Date(w.lastSessionAt).toISOString(),
          agentKinds: w.agentKinds,
        })),
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
        hasMore: page.hasMore,
        ...(cursor && !cursorObj ? { warning: 'INVALID_CURSOR_FALLBACK_TO_FIRST_PAGE' } : {}),
      });
    },
  });
}
