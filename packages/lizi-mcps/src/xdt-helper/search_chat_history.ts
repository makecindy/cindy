/**
 * xdt-helper/search_chat_history.ts —— history 类工具:跨 session 混合检索聊天记录。
 *
 * 与 get_chat_history 的分工:
 *   - get_chat_history : "按元数据精确捞" —— 你已经知道 session / workdir / 时间段,
 *                        要把那段对话原样拉出来。
 *   - search_chat_history: "按内容语义找" —— 你只记得聊过 X 这个东西, 不知道在哪个
 *                        session / 什么时候, 用自然语言把它找回来。
 *
 * 检索策略(host 侧 chatHistorySearch.ts 实现, 本工具只做 schema 校验 + payload 整形):
 *   - FTS5 全文检索(messages_fts)是地基, 全量历史、永远可用。
 *   - 向量语义检索(chat_messages_vec_v1)是增益, 用户开了"聊天记录语义索引"后
 *     体验更好; 没开 / sqlite-vec 没加载 / embedding host 没起时静默退化为纯 FTS,
 *     搜索照常工作(响应里 vector_used=false + vector_skip_reason 标明原因)。
 *   - 两路结果用 RRF(Reciprocal Rank Fusion)融合排序。
 *   - 每条命中额外带同 session 内前后 ±context_radius 条邻居, 给出连贯对话片段。
 *
 * 设计取舍(与 get_chat_history 一致):
 *   - content / agentMeta 是 JSON.parse 后的原始结构, 不做 markdown 拼装。
 *   - session 元数据抽顶层 sessions map, 按 id 索引一次避免逐条命中重复。
 *   - toolUseId / agentMeta / rewindAt 这类默认几乎永远 null 的字段 omit-when-null。
 *   - 游标分页: 融合分非稳定 DB 排序, 走"物化候选池 + offset 游标", 串联 nextCursor
 *     拿后续页; pool_capped=true 表示候选池触达硬上限, 更靠后的相关结果可能未进池。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperHistoryDeps, HistoryRole } from './_history_types.js';
import { okPayload, errorPayload } from './_payload.js';

const ROLE_VALUES = [
  'user',
  'assistant',
  'tool_use',
  'tool_result',
  'ask_user',
  'plan_review',
  'thinking',
] as const satisfies readonly HistoryRole[];

/** 缺省命中 role: 只搜问答类, 排除 tool_use / tool_result / thinking 技术性 role。 */
const DEFAULT_QA_ROLES = ['user', 'assistant', 'ask_user', 'plan_review'] as const satisfies readonly HistoryRole[];

const DESCRIPTION = [
  '跨所有 session 用自然语言语义检索历史聊天记录, 返回相关命中 + 上下文窗口的原始数据。',
  '',
  '【何时调用】用户"我之前聊过 X / 上次怎么解决那个 bug / 关于 Y 我们讨论过啥"等',
  '只记得内容、不知道在哪个 session / 什么时候 的场景。若已知 session/时间段要精确',
  '拉全文, 用 get_chat_history。',
  '',
  '【混合检索】FTS5 全文(全量历史、永远可用)+ 向量语义(用户开启"聊天记录语义索引"',
  '后生效, 能召回同义/改写/跨语言)RRF 融合排序。用户没开 embedding 也能正常搜, 只是',
  '退化为纯 FTS —— 响应里 vector_used 标明向量是否生效, vector_skip_reason 给出未生效原因。',
  '',
  '【过滤】query 必填; session_ids / workdir / from / to / agent_kind / roles 可任意叠加',
  '(AND), 语义同 get_chat_history。roles 不传 = 只命中问答类(user/assistant/ask_user/plan_review)。',
  '',
  '【返回结构】顶层:',
  '  - hits: 数组, 每条 { messageId, sessionId, role, createdAt(ISO), snippet(FTS 高亮或 null),',
  '    score(RRF 融合分), ftsRank/vectorRank/vectorDistance(命中来源, 可选), context }。',
  '  - context: 该命中前后 ±context_radius 条同 session 邻居(含命中本身, isHit 标记),',
  '    按 createdAt 升序, content 为 JSON.parse 后原始结构。',
  '  - sessions: { [sessionId]: { workingDir, agentKind, title } } 命中涉及的 session 元数据。',
  '  - vector_used / vector_skip_reason / pool_size / pool_capped 诊断字段。',
  '',
  '【分页】游标分页, 默认 limit=10(最大 50)。hasMore=true 时用 nextCursor 再调拿下一页。',
  'pool_capped=true 表示候选池已达上限, 更靠后的相关结果可能未进池(可缩小过滤范围再搜)。',
].join('\n');

export interface SearchChatHistoryToolDeps {
  history: XdtHelperHistoryDeps;
}

export function registerSearchChatHistoryTool(
  registry: XdtHelperToolRegistry,
  deps: SearchChatHistoryToolDeps,
): void {
  registry.register({
    name: 'search_chat_history',
    category: 'history',
    description: DESCRIPTION,
    inputShape: {
      query: z.string().min(1).describe('自然语言查询(必填)。例: "上次怎么修的语音输入授权问题"。'),
      session_ids: z
        .array(z.string().min(1))
        .max(50)
        .optional()
        .describe('限定一批 sessionId(最多 50)。与其它过滤叠加(AND)。'),
      workdir: z.string().optional().describe('精确匹配 sessions.workingDir。'),
      from: z.string().optional().describe('ISO 8601(含): 过滤 messages.createdAt >= from。'),
      to: z.string().optional().describe('ISO 8601(不含): 过滤 messages.createdAt < to。'),
      agent_kind: z
        .enum(['cc', 'codex', 'pi'])
        .optional()
        .describe('按 session.agentKind 过滤; 不传 = 全部搜。'),
      roles: z
        .array(z.enum(ROLE_VALUES))
        .optional()
        .describe(
          '只命中这些 role 的消息(也用于上下文窗口过滤)。不传 = 问答类' +
            '(user/assistant/ask_user/plan_review)。',
        ),
      context_radius: z
        .number()
        .int()
        .min(0)
        .max(10)
        .default(2)
        .describe('每条命中前后各取多少条同 role 邻居; 0 = 不带上下文。默认 2。'),
      limit: z.number().int().min(1).max(50).default(10).describe('融合后返回命中条数, 1-50, 默认 10。'),
      cursor: z.string().optional().describe('上次响应的 nextCursor; 不传 = 第一页。坏 cursor 自动回第一页。'),
    },
    handler: async ({
      query,
      session_ids,
      workdir,
      from,
      to,
      agent_kind,
      roles,
      context_radius,
      limit,
      cursor,
    }) => {
      const fromMs = parseIsoMs(from);
      if (fromMs === 'invalid') {
        return errorPayload('INVALID_ARGS', `from 不是合法 ISO 8601 时间字符串: "${from}"`);
      }
      const toMs = parseIsoMs(to);
      if (toMs === 'invalid') {
        return errorPayload('INVALID_ARGS', `to 不是合法 ISO 8601 时间字符串: "${to}"`);
      }

      const offset = decodeOffsetCursor(cursor);
      const cursorWasBad = cursor !== undefined && cursor !== '' && offset === null;
      const effectiveRoles: HistoryRole[] = roles ?? [...DEFAULT_QA_ROLES];

      const res = await deps.history.searchChatHistory({
        query: query.trim(),
        sessionIds: session_ids ?? null,
        workdir: workdir ?? null,
        fromMs,
        toMs,
        agentKind: agent_kind ?? null,
        roles: effectiveRoles,
        contextRadius: context_radius,
        limit,
        offset: offset ?? 0,
      });
      if (!res.ok) {
        if (res.errorCode === 'HOST_NOT_READY') {
          return errorPayload(
            'HOST_NOT_READY',
            `${BRAND_NAME} 本地数据库尚未就绪(典型: app 仍在启动或用户未登录), 请告知用户稍等几秒后重试。`,
          );
        }
        return errorPayload('INTERNAL', res.message);
      }

      const { result } = res;
      return okPayload({
        hits: result.hits.map((h) => {
          const out: Record<string, unknown> = {
            messageId: h.messageId,
            sessionId: h.sessionId,
            role: h.role,
            createdAt: new Date(h.createdAt).toISOString(),
            score: h.score,
            context: h.context.map((c) => {
              const cm: Record<string, unknown> = {
                id: c.id,
                sessionId: c.sessionId,
                role: c.role,
                content: c.content,
                createdAt: new Date(c.createdAt).toISOString(),
                isHit: c.isHit,
              };
              if (c.toolUseId !== null) cm.toolUseId = c.toolUseId;
              if (c.agentMeta !== null && c.agentMeta !== undefined) cm.agentMeta = c.agentMeta;
              if (c.rewindAt !== null) cm.rewindAt = new Date(c.rewindAt).toISOString();
              return cm;
            }),
          };
          if (h.snippet !== null) out.snippet = h.snippet;
          if (h.ftsRank !== null) out.ftsRank = h.ftsRank;
          if (h.vectorRank !== null) out.vectorRank = h.vectorRank;
          if (h.vectorDistance !== null) out.vectorDistance = h.vectorDistance;
          return out;
        }),
        sessions: result.sessions,
        vector_used: result.vectorUsed,
        ...(result.vectorSkipReason ? { vector_skip_reason: result.vectorSkipReason } : {}),
        pool_size: result.poolSize,
        pool_capped: result.poolCapped,
        nextCursor: result.nextOffset !== null ? encodeOffsetCursor(result.nextOffset) : null,
        hasMore: result.hasMore,
        query: {
          query: query.trim(),
          session_ids,
          workdir,
          from,
          to,
          agent_kind,
          roles: effectiveRoles,
          roles_defaulted: roles === undefined,
          context_radius,
          limit,
        },
        ...(cursorWasBad ? { warning: 'INVALID_CURSOR_FALLBACK_TO_FIRST_PAGE' } : {}),
      });
    },
  });
}

function parseIsoMs(s: string | undefined): number | null | 'invalid' {
  if (s === undefined || s === '') return null;
  const t = new Date(s).getTime();
  if (!Number.isFinite(t)) return 'invalid';
  return t;
}

/**
 * offset 游标编解码 —— search 的候选池是物化排名列表, 用简单 offset 翻页
 * (区别于 list/get 工具的 (createdAt,id) keyset 游标, 故不复用 _history_cursor)。
 * 坏 cursor 返 null, caller fallback 到第一页(offset=0)。
 */
function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeOffsetCursor(raw: string | undefined | null): number | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof obj.o !== 'number' || !Number.isInteger(obj.o) || obj.o < 0) return null;
    return obj.o;
  } catch {
    return null;
  }
}
