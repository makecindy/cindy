/**
 * xdt-helper/list_sessions.ts —— history 类工具 2/3。
 *
 * 列出会话元数据(不含 messages 内容)。按 workdir / 时间段 / agentKind 任意组合过滤,
 * 默认按 createdAt desc。messageCount 用相关子查询带出(已过滤 rewindAt)。
 *
 * 设计:
 *  - 时间参数接受 ISO 8601 字符串, 内部转 unix ms 后入 SQL
 *  - 时间解析失败 → INVALID_ARGS (zod 之外的业务校验)
 *  - 默认不含 status='deleted'; includeDeleted=true 时全量返
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperHistoryDeps } from './_history_types.js';
import type { SessionQueueDeps } from './list_session_queue.js';
import { okPayload, errorPayload } from './_payload.js';
import { encodeCursor, decodeCursor } from './_history_cursor.js';

const DESCRIPTION = [
  '列出本地数据库里的 session 元数据(id / title / workingDir / agentKind / model /',
  '时间戳 / messageCount 等), 按多种过滤条件组合查。**不返回 messages 内容** —',
  '要拉具体聊天内容请用 get_chat_history。',
  '',
  '【何时调用】用户问"我某天聊了哪些 session / 这个项目下我都开过哪些会话 /',
  '我用 codex 的所有 session 列一下"等场景。',
  '',
  '【过滤参数】所有参数可任意组合, 不传 = 不过滤:',
  '  - workdir: 精确匹配 sessions.workingDir',
  '  - from / to: ISO 8601 时间窗 (from 含, to 不含), 过滤 sessions.createdAt',
  '  - agent_kind: cc(Claude Code) | codex',
  '  - include_deleted: 默认 false (排除 status=deleted)',
  '',
  '【输出】messageCount 已过滤被 rewind 软删的消息, 是用户可见的真实条数。',
  'queuedCount 是当前尚未消费的输入队列条数，可用 list_session_queue 查看明细。',
  '时间戳均为 ISO 8601 字符串(对应 DB 里的 unix ms 转换)。',
  'orcaRole / parentSessionId / userSendAt 仅在非 null 时出现(默认场景几乎全为 null, 已 omit)。',
  '',
  '【分页】游标分页, 默认 100 条/次, 最大 1000。串联 nextCursor 拿全量。',
].join('\n');

export interface ListSessionsToolDeps {
  history: XdtHelperHistoryDeps;
  sessionQueue?: SessionQueueDeps;
}

export function registerListSessionsTool(
  registry: XdtHelperToolRegistry,
  deps: ListSessionsToolDeps,
): void {
  registry.register({
    name: 'list_sessions',
    category: 'history',
    description: DESCRIPTION,
    inputShape: {
      workdir: z
        .string()
        .optional()
        .describe('精确匹配 sessions.workingDir 的绝对路径。先用 list_workdirs 拿候选。'),
      from: z
        .string()
        .optional()
        .describe('ISO 8601 时间字符串(含), 过滤 sessions.createdAt >= from。例: "2026-05-01T00:00:00Z"'),
      to: z
        .string()
        .optional()
        .describe('ISO 8601 时间字符串(不含), 过滤 sessions.createdAt < to。'),
      agent_kind: z
        .enum(['cc', 'codex'])
        .optional()
        .describe('过滤 agent 类型, 不传 = 两者都返。'),
      include_deleted: z
        .boolean()
        .default(false)
        .describe('默认 false 排除 status=deleted 的 session; true = 包括已删除。'),
      limit: z.number().int().min(1).max(1000).default(100).describe('单次返回条数, 1-1000, 默认 100。'),
      cursor: z.string().optional().describe('上次响应的 nextCursor; 不传 = 第一页。坏 cursor 自动 fallback。'),
      order: z
        .enum(['asc', 'desc'])
        .default('desc')
        .describe('按 sessions.createdAt 排序, desc = 最新在前(默认)。'),
    },
    handler: async ({ workdir, from, to, agent_kind, include_deleted, limit, cursor, order }) => {
      const fromMs = parseIsoMs(from);
      if (fromMs === 'invalid') {
        return errorPayload('INVALID_ARGS', `from 不是合法 ISO 8601 时间字符串: "${from}"`);
      }
      const toMs = parseIsoMs(to);
      if (toMs === 'invalid') {
        return errorPayload('INVALID_ARGS', `to 不是合法 ISO 8601 时间字符串: "${to}"`);
      }
      const cursorObj = decodeCursor(cursor);

      const result = await deps.history.listSessions({
        workdir: workdir ?? null,
        fromMs,
        toMs,
        agentKind: agent_kind ?? null,
        includeDeleted: include_deleted,
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
      let queuedCounts: Record<string, number> | null = null;
      if (deps.sessionQueue && page.items.length > 0) {
        const countsResult = await deps.sessionQueue.listSessionQueuedCounts(
          page.items.map((session) => session.id),
        );
        if (!countsResult.ok) {
          if (countsResult.errorCode === 'HOST_NOT_READY') {
            return errorPayload(
              'HOST_NOT_READY',
              `${BRAND_NAME} 本机 session 队列服务尚未就绪，请稍后重试。`,
            );
          }
          return errorPayload('INTERNAL', countsResult.message);
        }
        queuedCounts = countsResult.counts;
      }
      // Token 优化: orcaRole / parentSessionId / userSendAt 这几个字段在绝大多数
      // session 上都是 null, 逐行带 null 会浪费 token。改成 omit-when-null。
      return okPayload({
        sessions: page.items.map((s) => {
          const out: Record<string, unknown> = {
            id: s.id,
            title: s.title,
            workingDir: s.workingDir,
            agentKind: s.agentKind,
            workspaceKind: s.workspaceKind,
            model: s.model,
            status: s.status,
            source: s.source,
            createdAt: new Date(s.createdAt).toISOString(),
            updatedAt: new Date(s.updatedAt).toISOString(),
            messageCount: s.messageCount,
          };
          if (queuedCounts !== null) out.queuedCount = queuedCounts[s.id] ?? 0;
          if (s.orcaRole !== null) out.orcaRole = s.orcaRole;
          if (s.parentSessionId !== null) out.parentSessionId = s.parentSessionId;
          if (s.userSendAt !== null) out.userSendAt = new Date(s.userSendAt).toISOString();
          return out;
        }),
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
        hasMore: page.hasMore,
        query: { workdir, from, to, agent_kind, include_deleted, limit, order },
        ...(cursor && !cursorObj ? { warning: 'INVALID_CURSOR_FALLBACK_TO_FIRST_PAGE' } : {}),
      });
    },
  });
}

/**
 * 把可选 ISO 8601 字符串解析成 unix ms。
 *  - undefined / 空串 → null (不过滤)
 *  - 合法时间 → number
 *  - 非法 → 'invalid' (调用方返 INVALID_ARGS)
 */
function parseIsoMs(s: string | undefined): number | null | 'invalid' {
  if (s === undefined || s === '') return null;
  const t = new Date(s).getTime();
  if (!Number.isFinite(t)) return 'invalid';
  return t;
}
