/**
 * 哪些任务所在的对话里, 除了主人还有别人能说话。
 *
 * File: <owner-scoped userData>/channel-shared-sessions.json
 * 形态: { sessions: ["<sessionId>", ...] }
 *
 * 用途只有一个: 这类任务启动时不把主人账号级记忆的索引写进系统提示词
 * (docs/product-rules/cindy-memory.md §7)。索引里是每条记忆的标题和一句话摘要,
 * 写进提示词就等于交给了这段对话里的每一个人 —— 访客不调任何工具也能问出来。
 *
 * 判定来自渠道派发每一轮时给出的事实 (群聊 / 发起人不是主人), 由 turnRunner 在任务
 * 启动之前登记。登记后不再撤销: 一段对话有过别人, 之后重启、从桌面端接着聊都算。
 * 任务删除后登记留着也无妨 (任务 id 不复用), 总量由 MAX_ENTRIES 兜住。
 *
 * 落在偏好文件而不是 sessions 表: 与 session-context-budget-store 同一条理由 ——
 * 加列要走迁移链, 旧包打开同一个库会因身份不符拒绝启动; 这里不参与查询也不需要事务。
 */

import type { TurnPermissionPolicy } from '@cindy/maker-core';

import type { ImMessageOrigin } from '../../../shared/imMessageSource';
import { desktopMakerLogger } from '../../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../../maker-host/override-settings-file.js';
import { ownerScopedPath } from '../../ownerContext.js';
import type { ImChannelNoteSource } from './channelNote';
import { isGuestTurnAuthority } from './channelToolPolicy';

const log = desktopMakerLogger.child('channel-shared-sessions');

/** 深防线: 文件同步读写, 不让它无界增长。超出时丢最早登记的 (按登记顺序排列)。 */
const MAX_ENTRIES = 16_384;

interface SharedSessionsFile {
  sessions: string[];
}

function normalize(raw: unknown): SharedSessionsFile {
  const list = raw && typeof raw === 'object' ? (raw as { sessions?: unknown }).sessions : undefined;
  if (!Array.isArray(list)) return { sessions: [] };
  const sessions = [...new Set(list.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  return { sessions: sessions.slice(-MAX_ENTRIES) };
}

const store = createOverrideSettingsFile<SharedSessionsFile>({
  filePath: () => ownerScopedPath('channel-shared-sessions.json'),
  defaults: { sessions: [] },
  normalize,
  log,
  label: 'channel-shared-sessions',
  maxBytes: 1_048_576,
  preserveUnreadableFile: true,
});

/** 这一轮所在的对话是不是别人也能说话的: 群聊, 或发起人不是主人。 */
export function isSharedChannelTurn(turn: {
  channelNoteSource?: Pick<ImChannelNoteSource, 'chatKind'>;
  messageOrigin?: Pick<ImMessageOrigin, 'chat'>;
  turnPermissionPolicy?: Pick<TurnPermissionPolicy, 'autoReviewContext'>;
}): boolean {
  const authority = turn.turnPermissionPolicy?.autoReviewContext;
  return turn.channelNoteSource?.chatKind === 'group'
    || turn.messageOrigin?.chat?.kind === 'group'
    || authority?.source === 'group'
    || isGuestTurnAuthority(authority);
}

/**
 * 本进程里登记过的。落盘失败时它保证同一进程内仍然生效; 换账号后任务 id 不会重复,
 * 留着旧账号的 id 没有影响。
 */
const notedThisProcess = new Set<string>();

function readSessions(): string[] {
  store.invalidateIfChanged();
  return store.read().sessions;
}

/**
 * 这个任务所在的对话有没有登记过「别人也能说话」。账号目录还取不到时按「有」处理。
 * 登记文件损坏时读到的是空表 (文件保留、不覆盖): 本进程内的登记仍然生效, 重启前的丢失。
 */
export function isSharedChannelSession(sessionId: string): boolean {
  if (!sessionId) return false;
  if (notedThisProcess.has(sessionId)) return true;
  try {
    return readSessions().includes(sessionId);
  } catch (error) {
    log.warn('channel shared sessions unreadable; withholding the account memory index', {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

/**
 * turnRunner 在派发一轮、任务启动之前调用。先记在内存里 (本进程内立即生效), 再落盘
 * (重启后仍生效); 落盘失败只记日志, 不拦这一轮。
 */
export function noteSharedChannelSession(sessionId: string): void {
  if (!sessionId || notedThisProcess.has(sessionId)) return;
  notedThisProcess.add(sessionId);
  try {
    const sessions = readSessions();
    if (sessions.includes(sessionId)) return;
    store.writePatch({ sessions: [...sessions, sessionId].slice(-MAX_ENTRIES) });
  } catch (error) {
    log.warn('channel shared session could not be saved; it holds until this app restarts', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 仅测试用: 模拟应用重启 (内存清空, 文件还在)。 */
export function forgetNotedChannelSessionsForTest(): void {
  notedThisProcess.clear();
}
