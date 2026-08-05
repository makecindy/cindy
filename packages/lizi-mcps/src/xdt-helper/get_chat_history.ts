/**
 * xdt-helper/get_chat_history.ts —— history 类工具 3/3。
 *
 * 按 session_ids / workdir / 时间段 / agent_kind / roles 任意组合过滤拉 messages,
 * 原样返回(包含 raw role + JSON.parse 后的 content + agentMeta)。
 *
 * 设计:
 *  - 必须至少提供一种主要 filter(session_ids / workdir / from / to), 否则一次性
 *    扫全表风险大, 返 INVALID_FILTER 引导调用方先用 list_sessions 缩范围
 *  - JOIN sessions 拿 workingDir / agentKind / title 元数据带在 message 行里,
 *    方便调用方区分跨 session 结果
 *  - 默认排除 rewindAt IS NOT NULL 的软删消息, includeRewound=true 时全量返
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperHistoryDeps, HistoryRole } from './_history_types.js';
import { okPayload, errorPayload } from './_payload.js';
import { encodeCursor, decodeCursor } from './_history_cursor.js';

const ROLE_VALUES = [
  'user',
  'assistant',
  'tool_use',
  'tool_result',
  'ask_user',
  'plan_review',
  'thinking',
] as const satisfies readonly HistoryRole[];

/**
 * 默认只返"问答"类 role: 用户消息 / 助手回复 / 主动询问用户 / plan 评审。
 * tool_use / tool_result / thinking 是开发者 debug 用的技术性 role, 体积大且
 * 对"回顾历史对话"语义无价值, 默认排除避免撑爆调用方上下文。需要时调用方
 * 显式在 roles 里列出来即可。
 */
const DEFAULT_QA_ROLES = ['user', 'assistant', 'ask_user', 'plan_review'] as const satisfies readonly HistoryRole[];

/**
 * workdir 模式下若调用方既不传 from 也不传 include_full_history=true,
 * 自动套一个 180 天窗口, 防止 LLM 一时手抖触发"workdir 全量扫描"(随
 * 用户数据增长该路径成本会线性放大)。180 天覆盖绝大多数"近期回顾"
 * 场景, 真要全量明示 include_full_history=true 即可。
 */
const DEFAULT_WORKDIR_WINDOW_DAYS = 180;
const DEFAULT_WORKDIR_WINDOW_MS = DEFAULT_WORKDIR_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const DESCRIPTION = [
  'Cross-device read-only history accepts exactly one session_id in the form deviceId::sessionId.',
  'The source device must be online with an active authorized device-link; remote ids cannot be mixed with local or other remote ids.',
  'Remote reads preserve the same filters, ordering, and cursor pagination. If a payload is too large, retry with a smaller limit.',
  '拉取本地数据库里的原始 message 数据 (raw role + JSON.parse 后的 content + agentMeta),',
  '按 session_ids / workdir / 时间段 / agent_kind / roles 任意组合过滤。',
  '',
  '【何时调用】用户想"看某个 session 的完整聊天 / 总结某个 workdir 某段时间的对话 /',
  '帮我把昨天和 agent 的讨论整理成 memory 条目"等需要原始对话数据的场景。',
  '',
  '【必须至少满足一个主过滤】session_ids / workdir / from / to 至少传一个, 否则返',
  'INVALID_FILTER。这是为了防止误调用一次性拉全库。要"全量"语义请用游标分页串联。',
  '',
  '【workdir 模式自带 180 天默认窗口】只带 workdir(不带 session_ids / from)调用时,',
  '自动套最近 180 天的 from, 防止误触发跨年扫描。若用户明确说"全量历史/不限时间",',
  '传 include_full_history=true 解锁。响应里的 query.auto_window_days 会标明窗口是否生效。',
  '',
  '【默认只返问答类 role】不传 roles = 只返 user / assistant / ask_user / plan_review,',
  '排除 tool_use / tool_result / thinking 这些开发者 debug 用的技术性 role(体积大且',
  '对"回顾对话"无价值)。需要工具调用 / 思考链等技术 role 时, 在 roles 里显式列出',
  '(例如要全量就传 roles=["user","assistant","tool_use","tool_result","ask_user","plan_review","thinking"])。',
  '',
  '【返回原始数据】content 是 JSON.parse 后的原始结构 (按 role 形态不同, 调用方自己解析),',
  '不做任何 markdown / 文本拼装。',
  '',
  '【输出结构】顶层有两个字段:',
  '  - sessions: { [sessionId]: { workingDir, agentKind, title } } —— 涉及到的 session 元数据,',
  '    按 id 索引一次, 避免在每条 message 上重复(同 session 拉 N 条消息 → 元数据只出现一次)。',
  '  - messages: 数组, 每行字段 id / sessionId / role / content(已 JSON 解析) / createdAt(ISO);',
  '    可选字段(仅在非 null 时出现): toolUseId / agentMeta(已 JSON 解析) / rewindAt(ISO)。',
  '  要拿某条 message 的 workdir / agentKind / title, 用 sessions[message.sessionId] 查。',
  '',
  '【分页】游标分页, 默认 200/次, 最大 1000。串联 nextCursor 多次调用拿全量, 信息不丢。',
  '默认按 createdAt desc + id desc, 同毫秒多消息靠 id 兜底排序稳定。',
].join('\n');

export interface GetChatHistoryToolDeps {
  history: XdtHelperHistoryDeps;
}

export function registerGetChatHistoryTool(
  registry: XdtHelperToolRegistry,
  deps: GetChatHistoryToolDeps,
): void {
  registry.register({
    name: 'get_chat_history',
    category: 'history',
    description: DESCRIPTION,
    inputShape: {
      // device-link hosts may use one `deviceId::sessionId`; the host enforces the trusted route.
      session_ids: z
        .array(z.string().min(1))
        .max(50)
        .optional()
        .describe('一批 sessionId(最多 50 个)。与 workdir / 时间段可叠加(AND)。'),
      workdir: z
        .string()
        .optional()
        .describe('精确匹配 sessions.workingDir。与 session_ids 同时传 = AND。'),
      from: z
        .string()
        .optional()
        .describe('ISO 8601 (含): 过滤 messages.createdAt >= from。'),
      to: z
        .string()
        .optional()
        .describe('ISO 8601 (不含): 过滤 messages.createdAt < to。'),
      agent_kind: z
        .enum(['cc', 'codex'])
        .optional()
        .describe('按 session.agentKind 过滤; 不传 = 两者都返。'),
      roles: z
        .array(z.enum(ROLE_VALUES))
        .optional()
        .describe(
          '只返这些 role 的消息。不传 = 默认只返问答类(user/assistant/ask_user/plan_review),' +
            '排除 tool_use/tool_result/thinking 等技术性 role。需要技术 role 时, 在数组里显式列出。',
        ),
      include_rewound: z
        .boolean()
        .default(false)
        .describe('默认 false (排除被 rewind 软删的消息); true = 含已 rewind 消息。'),
      include_full_history: z
        .boolean()
        .default(false)
        .describe(
          '默认 false。仅在 workdir 模式 (workdir 是唯一主过滤、未传 from) 下生效: ' +
            '默认会自动套 180 天窗口防止扫全库; 设为 true 解除该窗口拉全量历史。' +
            '仅在用户明确说"全量历史 / 不限时间 / 所有记录"等语义时才传 true。',
        ),
      limit: z.number().int().min(1).max(1000).default(200).describe('单次返回条数, 1-1000, 默认 200。'),
      cursor: z.string().optional().describe('上次响应的 nextCursor。坏 cursor 自动 fallback。'),
      order: z
        .enum(['asc', 'desc'])
        .default('desc')
        .describe('按 (messages.createdAt, messages.id) 排序; desc = 最新在前(默认)。'),
    },
    handler: async ({
      session_ids,
      workdir,
      from,
      to,
      agent_kind,
      roles,
      include_rewound,
      include_full_history,
      limit,
      cursor,
      order,
    }) => {
      // 至少一个主过滤
      const hasMainFilter =
        (session_ids !== undefined && session_ids.length > 0) ||
        (workdir !== undefined && workdir.length > 0) ||
        (from !== undefined && from.length > 0) ||
        (to !== undefined && to.length > 0);
      if (!hasMainFilter) {
        return errorPayload(
          'INVALID_FILTER',
          '至少要提供 session_ids / workdir / from / to 其中一个, 防止误调用扫全库。' +
            '若要拉全量, 先用 list_workdirs / list_sessions 定位后再分批调用。',
        );
      }

      const fromMs = parseIsoMs(from);
      if (fromMs === 'invalid') {
        return errorPayload('INVALID_ARGS', `from 不是合法 ISO 8601 时间字符串: "${from}"`);
      }
      const toMs = parseIsoMs(to);
      if (toMs === 'invalid') {
        return errorPayload('INVALID_ARGS', `to 不是合法 ISO 8601 时间字符串: "${to}"`);
      }
      const cursorObj = decodeCursor(cursor);

      // roles 缺省时套用 DEFAULT_QA_ROLES, 把工具调用/思考链等技术性 role 过滤掉,
      // 避免一次 get_chat_history 把调用方上下文撑爆。调用方需要技术 role 时显式
      // 在 roles 数组里列出来即可绕过该默认。
      const effectiveRoles: HistoryRole[] = roles ?? [...DEFAULT_QA_ROLES];

      // workdir 模式默认窗口: 仅当 workdir 是唯一主过滤(无 session_ids 且无 from)
      // 且未显式 include_full_history 时, 套 180 天上界, 防止 LLM 触发 workdir
      // 全量扫描这种随数据线性退化的路径。to 不动 — 即使调用方只传了 to
      // 也不影响"近 180 天"语义。
      const workdirOnly =
        workdir !== undefined && workdir.length > 0 &&
        (session_ids === undefined || session_ids.length === 0);
      const autoWindowApplied =
        workdirOnly && fromMs === null && !include_full_history;
      const effectiveFromMs = autoWindowApplied
        ? Date.now() - DEFAULT_WORKDIR_WINDOW_MS
        : fromMs;

      const result = await deps.history.getMessages({
        sessionIds: session_ids ?? null,
        workdir: workdir ?? null,
        fromMs: effectiveFromMs,
        toMs,
        agentKind: agent_kind ?? null,
        roles: effectiveRoles,
        rolesDefaulted: roles === undefined,
        includeRewound: include_rewound,
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
        return errorPayload(result.errorCode, result.message);
      }
      const { page } = result;
      // Token 优化: session 元数据 (workingDir / agentKind / title) 对同一 sessionId
      // 是恒定的, 按消息逐条复制会在跨 session 拉量大时浪费可观 token。
      // 改成顶层 sessions map (sessionId -> meta), message 行只留 sessionId 引用。
      // 同时对 toolUseId / agentMeta / rewindAt 这三个"默认场景几乎永远 null"
      // 的字段做 omit-when-null, 进一步压响应体。
      const sessionsMap: Record<string, { workingDir: string | null; agentKind: string; title: string }> = {};
      const messagesOut = page.items.map((m) => {
        if (!sessionsMap[m.sessionId]) {
          sessionsMap[m.sessionId] = {
            workingDir: m.sessionWorkingDir,
            agentKind: m.sessionAgentKind,
            title: m.sessionTitle,
          };
        }
        const out: Record<string, unknown> = {
          id: m.id,
          sessionId: m.sessionId,
          role: m.role,
          content: m.content,
          createdAt: new Date(m.createdAt).toISOString(),
        };
        if (m.toolUseId !== null) out.toolUseId = m.toolUseId;
        if (m.agentMeta !== null && m.agentMeta !== undefined) out.agentMeta = m.agentMeta;
        if (m.rewindAt !== null) out.rewindAt = new Date(m.rewindAt).toISOString();
        return out;
      });
      return okPayload({
        sessions: sessionsMap,
        messages: messagesOut,
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
        hasMore: page.hasMore,
        query: {
          session_ids,
          workdir,
          from,
          to,
          agent_kind,
          roles: effectiveRoles,
          roles_defaulted: roles === undefined,
          include_rewound,
          include_full_history,
          // 自动套窗时把生效的 from 回吐给调用方, 方便理解返回范围;
          // 0 = 未生效。
          auto_window_days: autoWindowApplied ? DEFAULT_WORKDIR_WINDOW_DAYS : 0,
          effective_from: effectiveFromMs !== null
            ? new Date(effectiveFromMs).toISOString()
            : null,
          limit,
          order,
        },
        ...(cursor && !cursorObj ? { warning: 'INVALID_CURSOR_FALLBACK_TO_FIRST_PAGE' } : {}),
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
