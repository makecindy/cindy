/**
 * 伙伴主任务「按这一轮是谁触发的」分档（2026-10-01 产品裁决，见 cindy-bots-runtime.md 6.4）。
 *
 * 本机伙伴主任务和普通任务拿同一套 session 工具；工具列表在整个会话里保持稳定（前缀缓存规则），
 * 每次调用时由这里按本轮来源决定放不放行：
 *
 * - owner：主人本人在伙伴聊天里的输入（桌面、手机、同账号设备，含工作台按钮代发）。由可信输入通道
 *   盖章，判据与插件任务「真人接管」共用 `hasAcceptedUserTaskInput`。= 全套。
 * - arranged：主人事先安排好的——自动化 / 例行任务、伙伴自己开的后台任务回报或等待交互、
 *   授权卡确认后的续跑。= 读全部；只动已接手项目里的任务和自己开的任务；不新建自动化、不改账号设置。
 *   后台任务回报与授权续跑不高于引出它们的那一轮：由 other 那一轮引出的仍是 other。
 * - other：其余一切（伙伴群聊、其他伙伴的消息、别的任务转来的消息）以及认不出来的。= 只动自己开的
 *   任务、只读自己的记录。
 *
 * 判档只看宿主持有的事实，不看模型说了什么。
 */
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';

import type { DbClient } from '../localDb/client/DbClient.js';
import { botDelegations, messages, sessions } from '../localDb/schema.js';
import { hasAcceptedUserTaskInput, isAcceptedUserInputRow, type AcceptedTaskInput } from './pluginTaskInput.js';

export type BotTurnAuthority = 'owner' | 'arranged' | 'other';

/**
 * 宿主代发的续跑输入：后台任务完成回报、后台任务等待交互、账号授权完成后的续跑。
 * 它们本身不是主人说的话，可信程度不高于引出它们的那一轮（见 continuationAuthority）。
 */
const CONTINUATION_CLIENT_ID_PREFIXES = [
  'bot-delegation-completion:',
  'bot-delegation-interaction:',
  'bot-authorization-resume:',
] as const;
const DELEGATION_CONTINUATION = /^bot-delegation-(?:completion|interaction):([^:]+)/;
/** 续跑链（后台任务里又开后台任务……）最多回溯几层；更深按最低档。 */
const MAX_CONTINUATION_HOPS = 4;

const isContinuationClientId = (clientId: string | null | undefined): boolean =>
  !!clientId && CONTINUATION_CLIENT_ID_PREFIXES.some((prefix) => clientId.startsWith(prefix));

export interface BotTurnExecution {
  executing: boolean;
  input: AcceptedTaskInput | null;
}

type RootInput = { clientId: string; originKind: string | null; agentMeta: string | null };

/**
 * 一轮的起点：`before` 之前最近一条根用户输入（不含回滚、清空前、自动续跑与上下文重建的行）。
 * 没有协调器输入（直接派发、或工具先于派发回执到达）时也用它判断这一轮的来源。
 */
async function rootUserInputBefore(
  db: Pick<DbClient, 'drizzle'>,
  sessionId: string,
  before: number | null,
): Promise<RootInput | null> {
  const meta = sql`CASE WHEN json_valid(${messages.agentMeta}) THEN ${messages.agentMeta} ELSE '{}' END`;
  const [row] = await db.drizzle
    .select({
      clientId: messages.clientId,
      agentMeta: messages.agentMeta,
      originKind: sql<string | null>`json_extract(${meta}, '$.origin.kind')`,
    })
    .from(messages)
    .innerJoin(sessions, eq(sessions.id, messages.sessionId))
    .where(and(
      eq(messages.sessionId, sessionId),
      eq(messages.role, 'user'),
      isNull(messages.rewindAt),
      before === null ? undefined : lt(messages.createdAt, before),
      sql`${messages.createdAt} > COALESCE(${sessions.clearedAt}, 0)`,
      sql`json_extract(${meta}, '$.parentUuid') IS NULL`,
      sql`COALESCE(json_extract(${meta}, '$.autoResume'), 0) != 1`,
      sql`COALESCE(json_extract(${meta}, '$.contextRebuild'), 0) != 1`,
    ))
    .orderBy(desc(messages.createdAt), desc(sql`messages.rowid`))
    .limit(1);
  return row ? { clientId: row.clientId, originKind: row.originKind ?? null, agentMeta: row.agentMeta ?? null } : null;
}

/** 续跑是哪一轮引出来的：后台任务看它被创建时伙伴那边的那一轮；授权续跑看授权卡之前的那一轮。 */
async function continuationAnchor(
  db: Pick<DbClient, 'drizzle'>,
  sessionId: string,
  clientId: string,
): Promise<{ sessionId: string; before: number | null } | null> {
  const delegation = DELEGATION_CONTINUATION.exec(clientId);
  if (delegation) {
    const [row] = await db.drizzle
      .select({ parentSessionId: botDelegations.parentSessionId, createdAt: botDelegations.createdAt })
      .from(botDelegations)
      .where(eq(botDelegations.id, delegation[1]!))
      .limit(1);
    return row?.parentSessionId ? { sessionId: row.parentSessionId, before: row.createdAt } : null;
  }
  const [resume] = await db.drizzle
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId)))
    .limit(1);
  // 续跑消息还没落库时，引出它的就是目前最近的那条根输入。
  return { sessionId, before: resume?.createdAt ?? null };
}

/**
 * 宿主续跑最多算「主人事先安排」，且不高于引出它的那一轮：主人本人或自动化引出的 → arranged；
 * 群聊、其他伙伴、别的任务转来的消息引出的 → other（否则开个后台任务就能把档位抬上去）。
 */
async function continuationAuthority(
  db: Pick<DbClient, 'drizzle'>,
  sessionId: string,
  clientId: string,
  hops: number,
): Promise<BotTurnAuthority> {
  if (!isContinuationClientId(clientId) || hops >= MAX_CONTINUATION_HOPS) return 'other';
  const anchor = await continuationAnchor(db, sessionId, clientId);
  if (!anchor) return 'other';
  const root = await rootUserInputBefore(db, anchor.sessionId, anchor.before);
  if (!root) return 'other';
  if (isAcceptedUserInputRow(root) || root.originKind === 'scheduler') return 'arranged';
  return continuationAuthority(db, anchor.sessionId, root.clientId, hops + 1);
}

/**
 * 这一轮开始后，有没有别的任务或伙伴用插话（steer）塞进来的输入。插话进来的内容和这一轮混在一起，
 * 不能沿用这一轮起点的档位。主人自己在输入框里插话不带 origin，不算。
 */
async function hasForeignSteerSince(
  db: Pick<DbClient, 'drizzle'>,
  sessionId: string,
  turnClientId: string,
): Promise<boolean> {
  const [start] = await db.drizzle
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, turnClientId)))
    .limit(1);
  if (!start) return false;
  const meta = sql`CASE WHEN json_valid(${messages.agentMeta}) THEN ${messages.agentMeta} ELSE '{}' END`;
  const [steer] = await db.drizzle
    .select({ clientId: messages.clientId })
    .from(messages)
    .where(and(
      eq(messages.sessionId, sessionId),
      eq(messages.role, 'user'),
      isNull(messages.rewindAt),
      sql`${messages.createdAt} >= ${start.createdAt}`,
      sql`json_extract(${meta}, '$.delivery') = 'steer'`,
      sql`json_extract(${meta}, '$.origin') IS NOT NULL`,
    ))
    .limit(1);
  return Boolean(steer);
}

export async function resolveBotTurnAuthority(
  db: Pick<DbClient, 'drizzle'>,
  sessionId: string,
  execution: BotTurnExecution,
): Promise<BotTurnAuthority> {
  const authority = await resolveTurnStartAuthority(db, sessionId, execution);
  const turnClientId = execution.input ? execution.input.retrySourceClientId ?? execution.input.clientId : null;
  if (authority !== 'other' && turnClientId && await hasForeignSteerSince(db, sessionId, turnClientId)) return 'other';
  return authority;
}

async function resolveTurnStartAuthority(
  db: Pick<DbClient, 'drizzle'>,
  sessionId: string,
  execution: BotTurnExecution,
): Promise<BotTurnAuthority> {
  if (await hasAcceptedUserTaskInput(db, sessionId, execution.input)) return 'owner';
  const input = execution.input;
  const source = input
    ? { clientId: input.retrySourceClientId ?? input.clientId, originKind: input.originKind ?? null }
    : await rootUserInputBefore(db, sessionId, null);
  if (!source) return 'other';
  if (source.originKind === 'scheduler') return 'arranged';
  return continuationAuthority(db, sessionId, source.clientId, 0);
}

// ── 每个工具的规则（纯函数，单测覆盖） ───────────────────────────────────────

export type BotToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; errorCode: string; message: string }
  /** 宿主逐个核对目标任务：`own` 只认伙伴自己的任务；`own-or-handed` 另认已接手项目里的任务。 */
  | { kind: 'targets'; sessionIds: string[]; scope: 'own' | 'own-or-handed' };

const OWNER_TURN_REQUIRED = {
  kind: 'deny',
  errorCode: 'OWNER_TURN_REQUIRED',
  message: '这一步只能在主人本人发话的那一轮里做；这一轮来自群聊、其他伙伴、自动化或后台任务回报。先告诉主人，等主人自己说了再做。',
} as const satisfies BotToolDecision;

/** 任何来源都能用：自省、登录、伙伴管理自己的后台任务与消息、沉淀技能，读取自己的资料、能力与例行任务。 */
const ANY_TURN_TOOLS = new Set([
  'get_capabilities',
  'get_current_session_id',
  'start_grok_device_login',
  'get_grok_login_status',
  'cancel_grok_device_login',
  'start_session_task',
  'check_session_task',
  'inspect_session_task_route',
  'advance_session_task_route',
  'message_session_task',
  'stop_session_task',
  'list_agents',
  'send_to_agent',
  'check_agent_message',
  'save_teammate_skill',
  'list_teammate_skills',
  'get_teammate_state',
  'find_teammate_capabilities',
  // 旧名别名（bot_capabilities.ts），行为同上。
  'get_bot_state',
  'find_bot_capabilities',
  'get_app_default_model',
  'routine_list',
  'routine_sources',
  'routine_history',
  'schedule_notify_current_run',
  'list_available_models',
  // 历史读取：前两档不限范围，最低档由历史范围只给伙伴自己的记录（见 mcp-providers）。
  'list_workdirs',
  'list_sessions',
  'get_chat_history',
  'search_chat_history',
]);

/**
 * 读全部、动已接手项目：主人本人与主人事先安排的那两档。例行任务的写入也在这里——例行任务跑起来
 * 是 arranged，若 other 那一轮能建例行任务，就能借下一次运行把档位抬上去。
 */
const OWNER_OR_ARRANGED_TOOLS = new Set([
  'get_workbench',
  'read_workbench_task',
  'set_workbench_task',
  'set_workbench_tasks',
  'continue_workbench_task',
  'list_projects',
  'create_project',
  'routine_save',
  'routine_delete',
  'routine_run_now',
  'schedule_set_pre_run_hook',
]);

/**
 * 按目标任务判定的会话控制工具。`read` = 只读；`currentByDefault` = 省略 session_id 时作用于
 * 调用方自己的当前任务（伙伴自己的任务，任何档都可以）。
 */
const TARGETED_TOOLS = new Map<string, { read: boolean; currentByDefault?: boolean }>([
  ['get_session_runtime', { read: true, currentByDefault: true }],
  ['list_session_queue', { read: true }],
  ['steer_session', { read: false }],
  ['stop_session_turn', { read: false }],
  ['set_session_runtime', { read: false, currentByDefault: true }],
  ['update_session_queued_message', { read: false }],
  ['cancel_session_queued_message', { read: false }],
]);

/** 批量整理任务的工具：从参数里取出全部目标任务，按同样的目标规则判定。 */
const TARGETED_BATCH_TOOLS = new Map<string, (args: unknown) => unknown[] | null>([
  ['rename_sessions', (args) => arrayArg(args, 'changes')?.map((change) => stringArg(change, 'session_id')) ?? null],
  ['archive_sessions', (args) => arrayArg(args, 'session_ids')],
  ['unarchive_sessions', (args) => arrayArg(args, 'session_ids')],
]);

/** 自动化里只读或只作用于本次运行的工具；其余（新建 / 改 / 删 / 暂停 / 立即跑）只在主人本人那一轮。 */
const SCHEDULER_READ_TOOLS = new Set(['schedule_list', 'schedule_get', 'schedule_list_runs']);
const SCHEDULER_CURRENT_RUN_TOOLS = new Set(['schedule_notify_current_run', 'schedule_silence_current_run']);

function stringArg(args: unknown, key: string): string | null {
  if (!args || typeof args !== 'object') return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function arrayArg(args: unknown, key: string): unknown[] | null {
  if (!args || typeof args !== 'object') return null;
  const value = (args as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}

export function decideBotToolCall(
  server: 'cindy_helper' | 'cindy_scheduler',
  tool: string,
  args: unknown,
  authority: BotTurnAuthority,
): BotToolDecision {
  if (authority === 'owner') return { kind: 'allow' };

  if (server === 'cindy_scheduler') {
    if (SCHEDULER_CURRENT_RUN_TOOLS.has(tool)) return { kind: 'allow' };
    if (authority === 'arranged' && SCHEDULER_READ_TOOLS.has(tool)) return { kind: 'allow' };
    return OWNER_TURN_REQUIRED;
  }

  if (ANY_TURN_TOOLS.has(tool)) return { kind: 'allow' };
  if (OWNER_OR_ARRANGED_TOOLS.has(tool)) {
    return authority === 'arranged' ? { kind: 'allow' } : OWNER_TURN_REQUIRED;
  }

  const targeted = TARGETED_TOOLS.get(tool);
  if (targeted) {
    const sessionId = stringArg(args, 'session_id');
    if (!sessionId) {
      return targeted.currentByDefault
        ? { kind: 'allow' }
        : { kind: 'deny', errorCode: 'INVALID_ARGS', message: '缺少 session_id。' };
    }
    if (authority === 'arranged' && targeted.read) return { kind: 'allow' };
    return { kind: 'targets', sessionIds: [sessionId], scope: authority === 'arranged' ? 'own-or-handed' : 'own' };
  }

  const batchTargets = TARGETED_BATCH_TOOLS.get(tool);
  if (batchTargets) {
    const ids = batchTargets(args);
    const sessionIds = ids?.map((id) => (typeof id === 'string' ? id.trim() : '')) ?? [];
    if (sessionIds.length === 0 || sessionIds.some((id) => !id)) {
      return { kind: 'deny', errorCode: 'INVALID_ARGS', message: '缺少目标任务的 session id。' };
    }
    return { kind: 'targets', sessionIds: [...new Set(sessionIds)], scope: authority === 'arranged' ? 'own-or-handed' : 'own' };
  }

  if (tool === 'send_to_session') {
    const target = stringArg(args, 'target_session_id');
    // 新建任务只在主人本人那一轮；其余档用 start_session_task 开自己的后台任务。
    if (!target) return OWNER_TURN_REQUIRED;
    return { kind: 'targets', sessionIds: [target], scope: authority === 'arranged' ? 'own-or-handed' : 'own' };
  }

  // 其余一律只在主人本人那一轮：新建伙伴、改伙伴自己的资料与能力（持久生效，后台任务回报里可能夹带外部内容）/
  // 标签 / 项目改名移除与移动任务 / 改应用默认模型 /
  // 接手或移除项目 / 反馈 / 技能发布与学习 / 应用更新，以及将来新增、这里还没登记的工具。
  return OWNER_TURN_REQUIRED;
}
