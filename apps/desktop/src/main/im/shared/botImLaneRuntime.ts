/**
 * main/im/shared/botImLaneRuntime.ts
 * ---------------------------------------------------------------------------
 * 伙伴「消息平台」页的隐藏任务小节: 列出一条连接下有任务的落点, 并能让某一条重新开始。
 *
 *   - 主人私聊落在伙伴主任务(bot_session_links role=canonical);
 *   - 群 / 话题 / 其他人的私聊各一条隐藏专线(role=channel, route_key 以这条连接的
 *     `im:<channel>:<botContextId>:` 开头, 见 imBotBindingRoute.ts)。
 *
 * 范围只按 伙伴 id + 这条连接的 route key 前缀取, 别的伙伴、同一伙伴的其它连接都不会混进来。
 * 状态只读已有数据: 正在回复取 live 会话, 出错取最近一条消息是否为错误行, 不另存状态。
 *
 * 「重新开始」不另写一套换会话逻辑: 由 register.ts 注入伙伴已有的显式重启
 * (restartBotCanonicalRuntime → contextOverflowRollover.prepareNativeSessionRecovery),
 * 与空闲间隔刷新共用同一套交接 + commitRebuild: 同一条任务、记录不删, 下一条消息
 * 换一个干净的原生会话。这里只负责校验这条任务确实属于这条连接。
 */

import { and, count, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

import { createLogger } from '../../logger';
import { getDbClient } from '../../localDb/client/current';
import { botSessionLinks, messages, sessions } from '../../localDb/schema';
import { throwIpcError } from '../../utils/ipcValidate';
import type {
  BotImConnectionLane,
  BotImConnectionLanesPayload,
  BotImConnectionRecord,
  BotImLaneKind,
} from '../../../shared/botImConnection';
import { readBotImConnection } from './botImConnectionStore';
import { companionConnectionRouteKeyPrefix } from './imBotBindingRoute';

const log = createLogger('im:bot-lanes');

export interface BotImLaneRuntimeDeps {
  /** 这条任务此刻是否有一轮在跑(live 会话)。 */
  isTurnRunning(sessionId: string): boolean;
  /** 伙伴已有的显式重启: 停掉当前一轮, 下一条消息从干净的原生会话开始。 */
  restartSession(sessionId: string): Promise<void>;
}

/** 一条伙伴任务链接(主任务或隐藏专线)。 */
export interface BotImLaneLink {
  sessionId: string;
  role: 'canonical' | 'channel';
  routeKey: string | null;
}

export interface BotImLaneActivity {
  lastActivityAt: number | null;
  /** 最近一条 user / assistant / error 是否是错误行, 且之后没有重新开始过。 */
  lastTurnFailed: boolean;
  contextMessageCount: number;
  /** 最近一条渠道消息记下的群名 / 发言人(imSource.origin)。 */
  origin: { chatName: string | null; senderName: string | null };
}

/** 数据读取(默认走本地库; 单测注入内存替身)。 */
export interface BotImLaneStore {
  listLinks(botId: string): Promise<BotImLaneLink[]>;
  readActivity(sessionId: string): Promise<BotImLaneActivity>;
}

export interface BotImLaneListOptions {
  /** 这个机器人进过的群(群窗口表); 只用来补群名, 读不到不影响列表。 */
  knownGroups?: (record: BotImConnectionRecord) => Promise<Array<{ chatId: string; chatName: string | null }>>;
}

let deps: BotImLaneRuntimeDeps | null = null;

export function configureBotImLaneRuntime(next: BotImLaneRuntimeDeps | null): void {
  deps = next;
}

function readOrigin(agentMeta: string | null): BotImLaneActivity['origin'] {
  if (!agentMeta) return { chatName: null, senderName: null };
  try {
    const origin = (JSON.parse(agentMeta) as { imSource?: { origin?: unknown } } | null)?.imSource?.origin;
    const o = origin && typeof origin === 'object' ? (origin as Record<string, unknown>) : {};
    const chat = o.chat && typeof o.chat === 'object' ? (o.chat as Record<string, unknown>) : {};
    const sender = o.sender && typeof o.sender === 'object' ? (o.sender as Record<string, unknown>) : {};
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    return { chatName: text(chat.name), senderName: text(sender.name) };
  } catch {
    return { chatName: null, senderName: null };
  }
}

const dbLaneStore: BotImLaneStore = {
  async listLinks(botId) {
    const rows = await getDbClient()
      .drizzle.select({
        sessionId: botSessionLinks.sessionId,
        role: botSessionLinks.role,
        routeKey: botSessionLinks.routeKey,
      })
      .from(botSessionLinks)
      .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
      .where(and(
        eq(botSessionLinks.botId, botId),
        inArray(botSessionLinks.role, ['canonical', 'channel']),
        isNull(botSessionLinks.archivedAt),
        eq(sessions.source, 'bot'),
        eq(sessions.status, 'active'),
      ));
    return rows.flatMap((row) =>
      row.role === 'canonical' || row.role === 'channel'
        ? [{ sessionId: row.sessionId, role: row.role, routeKey: row.routeKey }]
        : [],
    );
  },

  async readActivity(sessionId) {
    const db = getDbClient().drizzle;
    // 同毫秒次序按写入顺序(与 messages.ts 同口径)。
    const messageRowid = sql<number>`rowid`;
    const visible = and(eq(messages.sessionId, sessionId), isNull(messages.rewindAt));
    const [session] = await db
      .select({ clearedAt: sessions.clearedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    // 重新开始 / 自动整理上下文都会落一条 context_rebuild 标记(rewind_at 恒非空, 普通历史不可见)。
    const [rebuild] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'context_rebuild')))
      .orderBy(desc(messages.createdAt), desc(messageRowid))
      .limit(1);
    const [latest] = await db
      .select({ role: messages.role, createdAt: messages.createdAt })
      .from(messages)
      .where(and(visible, inArray(messages.role, ['user', 'assistant', 'error'])))
      .orderBy(desc(messages.createdAt), desc(messageRowid))
      .limit(1);
    const [lastUser] = await db
      .select({ agentMeta: messages.agentMeta })
      .from(messages)
      .where(and(visible, eq(messages.role, 'user')))
      .orderBy(desc(messages.createdAt), desc(messageRowid))
      .limit(1);
    const rebuiltAt = rebuild?.createdAt ?? 0;
    const contextStart = Math.max(rebuiltAt, session?.clearedAt ?? 0);
    const [counted] = await db
      .select({ n: count() })
      .from(messages)
      .where(and(visible, eq(messages.role, 'user'), gt(messages.createdAt, contextStart)));
    return {
      lastActivityAt: latest?.createdAt ?? null,
      lastTurnFailed: latest?.role === 'error' && latest.createdAt >= rebuiltAt,
      contextMessageCount: Number(counted?.n ?? 0),
      origin: readOrigin(lastUser?.agentMeta ?? null),
    };
  },
};

let store: BotImLaneStore = dbLaneStore;

type ParsedLane = { kind: Exclude<BotImLaneKind, 'owner-dm'>; chatId: string; threadId: string | null };

/** 拆专线 route key 的尾段(`g:<chatId>[:t:<threadId>]` / `dm:<userId>`); 认不出返回 null。 */
export function parseLaneRouteKey(prefix: string, routeKey: string | null): ParsedLane | null {
  if (!routeKey || !routeKey.startsWith(prefix)) return null;
  const rest = routeKey.slice(prefix.length);
  if (rest.startsWith('dm:')) {
    const userId = rest.slice(3);
    return userId ? { kind: 'guest-dm', chatId: userId, threadId: null } : null;
  }
  if (!rest.startsWith('g:')) return null;
  const group = rest.slice(2);
  const marker = group.indexOf(':t:');
  if (marker < 0) return group ? { kind: 'group', chatId: group, threadId: null } : null;
  const chatId = group.slice(0, marker);
  const threadId = group.slice(marker + 3);
  if (!chatId) return null;
  return threadId ? { kind: 'topic', chatId, threadId } : { kind: 'group', chatId, threadId: null };
}

type ScopedLink = { sessionId: string; kind: BotImLaneKind; chatId: string | null; threadId: string | null };

/** 只取属于这条连接的落点: 伙伴主任务 + 本连接前缀下的专线。 */
async function listScopedLinks(record: BotImConnectionRecord): Promise<ScopedLink[]> {
  if (!record.botContextId) return [];
  const prefix = companionConnectionRouteKeyPrefix(record.channel, record.botContextId);
  const scoped: ScopedLink[] = [];
  for (const link of await store.listLinks(record.botId)) {
    if (link.role === 'canonical') {
      scoped.push({ sessionId: link.sessionId, kind: 'owner-dm', chatId: null, threadId: null });
      continue;
    }
    const lane = parseLaneRouteKey(prefix, link.routeKey);
    if (lane) scoped.push({ sessionId: link.sessionId, ...lane });
  }
  return scoped;
}

function requireRecord(id: string): BotImConnectionRecord {
  const record = readBotImConnection(id);
  if (!record) throwIpcError('NOT_FOUND', 'CONNECTION_NOT_FOUND');
  return record;
}

export async function listBotImConnectionLanes(
  id: string,
  options: BotImLaneListOptions = {},
): Promise<BotImConnectionLanesPayload> {
  const record = requireRecord(id);
  const links = await listScopedLinks(record);
  if (links.length === 0) return { connectionId: id, lanes: [] };
  const groupNames = new Map<string, string>();
  if (options.knownGroups && links.some((link) => link.kind === 'group' || link.kind === 'topic')) {
    try {
      for (const group of await options.knownGroups(record)) {
        if (group.chatName) groupNames.set(group.chatId, group.chatName);
      }
    } catch (err) {
      log.warn(`bot im connection ${id}: known groups unavailable: ${String(err)}`);
    }
  }
  const lanes = await Promise.all(
    links.map(async (link): Promise<BotImConnectionLane> => {
      const activity = await store.readActivity(link.sessionId);
      const running = deps?.isTurnRunning(link.sessionId) === true;
      const name =
        link.kind === 'owner-dm'
          ? null
          : link.kind === 'guest-dm'
            ? activity.origin.senderName
            : (groupNames.get(link.chatId ?? '') ?? activity.origin.chatName);
      return {
        sessionId: link.sessionId,
        kind: link.kind,
        chatId: link.chatId,
        threadId: link.threadId,
        name,
        state: running ? 'running' : activity.lastTurnFailed ? 'failed' : 'idle',
        lastActivityAt: activity.lastActivityAt,
        contextMessageCount: activity.contextMessageCount,
      };
    }),
  );
  // 主人私聊在最前, 其余按最近活动倒序。
  lanes.sort((a, b) => {
    if (a.kind === 'owner-dm' || b.kind === 'owner-dm') return a.kind === 'owner-dm' ? -1 : 1;
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  });
  return { connectionId: id, lanes };
}

/**
 * 让一条落点重新开始。只接受这条连接自己的任务(主任务或本连接前缀下的专线),
 * 渲染端传来的任意任务 id 不会被重启。
 */
export async function resetBotImConnectionLane(
  id: string,
  sessionId: string,
  options: BotImLaneListOptions = {},
): Promise<BotImConnectionLanesPayload> {
  const record = requireRecord(id);
  const links = await listScopedLinks(record);
  const link = links.find((item) => item.sessionId === sessionId);
  if (!link) throwIpcError('NOT_FOUND', 'LANE_NOT_FOUND');
  if (!deps) throwIpcError('PRECONDITION_FAILED', 'LANE_RESET_UNAVAILABLE');
  try {
    await deps.restartSession(sessionId);
  } catch (err) {
    log.warn(`bot im connection ${id}: reset lane ...${sessionId.slice(-8)} (${link.kind}) failed: ${String(err)}`);
    throwIpcError('PRECONDITION_FAILED', 'LANE_RESET_FAILED');
  }
  log.info(`bot im connection ${id}: lane ...${sessionId.slice(-8)} (${link.kind}) restarted`);
  return listBotImConnectionLanes(id, options);
}

export const __testing = {
  setStore(next: BotImLaneStore | null): void {
    store = next ?? dbLaneStore;
  },
};
