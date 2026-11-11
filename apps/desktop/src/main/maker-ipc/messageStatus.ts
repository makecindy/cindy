/**
 * messageStatus —— 单条已投递消息送达状态的纯判定层。
 *
 * IO（队列快照、active turn、messages 表）由 register.ts 的
 * readSessionMessageStatus 提供；本文件只做无副作用的状态归并，
 * 本机 MCP、device-link 远程入口与单测共用同一份判定，避免两套口径漂移。
 *
 * 状态口径（对齐 get_message_status 工具契约）：
 *  - queued:      仍在 pendingQueue 等待派发（含持久化快照恢复出的条目）
 *  - processing:  consuming(正在投递) 或该 clientId 是当前 active turn 的输入
 *  - dispatched:  user 行已落库、尚无 assistant/error 回复行、也不是 active 输入
 *  - consumed:    该 user 行之后出现了 assistant 回复行
 *  - failed:      行被 rewind / /clear 边界隐藏，或首个回复行为 error
 */

export type SessionMessageStatusState =
  | 'queued'
  | 'processing'
  | 'dispatched'
  | 'consumed'
  | 'failed';

export interface SessionMessageStatusSnapshot {
  status: SessionMessageStatusState;
  /** 0-based 队列位置（与 list_session_queue 的 position 同口径）。 */
  position?: number;
  source?: 'user' | 'orca' | 'scheduler' | 'session';
  source_label?: string | null;
  enqueued_at?: string | null;
  detail?: string;
  consumed_at?: string | null;
}

export interface MessageStatusQueueEntry {
  queuedMessageId: string;
  position: number;
  source: 'user' | 'orca' | 'scheduler' | 'session';
  sourceLabel: string | null;
  enqueuedAtMs: number | null;
  consuming: boolean;
}

export interface MessageStatusPersistedRow {
  role: string;
  createdAt: number;
  rewindAt: number | null;
  /** /clear 边界：createdAt <= sessions.cleared_at 视为已被清空隐藏。 */
  cleared: boolean;
}

export interface MessageStatusReplyRow {
  role: string;
  createdAt: number;
  content: string;
}

const MAX_DETAIL_CHARS = 300;

function isoOrNull(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** error 行 content 是 JSON 字符串；提取最像原因的字段，失败则截断原文。 */
function summarizeErrorContent(content: string): string {
  let text = content;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown> | null;
    if (parsed && typeof parsed === 'object') {
      const candidate =
        typeof parsed.message === 'string' ? parsed.message
        : typeof parsed.sdkError === 'string' ? parsed.sdkError
        : typeof parsed.reason === 'string' ? parsed.reason
        : null;
      if (candidate) text = candidate;
    }
  } catch {
    // 非 JSON：按原文截断。
  }
  const normalized = text.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(normalized);
  return chars.length <= MAX_DETAIL_CHARS
    ? normalized
    : `${chars.slice(0, MAX_DETAIL_CHARS).join('')}…`;
}

/**
 * 归并队列 / 持久化 / active turn 三路信号为一个状态快照。
 * 返回 null 表示消息 id 在任何通道都不存在（调用方报 NOT_FOUND）。
 */
export function classifySessionMessageStatus(input: {
  queueEntry: MessageStatusQueueEntry | null;
  /** 该 clientId 是否属于当前 active turn 的输入集合。 */
  isActiveTurnInput: boolean;
  persisted: MessageStatusPersistedRow | null;
  /** 该 user 行之后按 (createdAt, rowid) 排序的第一个 assistant/error 行。 */
  firstReply: MessageStatusReplyRow | null;
}): SessionMessageStatusSnapshot | null {
  const { queueEntry } = input;
  if (queueEntry) {
    const base = {
      position: queueEntry.position,
      source: queueEntry.source,
      source_label: queueEntry.sourceLabel,
      enqueued_at: isoOrNull(queueEntry.enqueuedAtMs),
    };
    return queueEntry.consuming
      ? { status: 'processing', ...base, detail: '消息正在投递给任务。' }
      : { status: 'queued', ...base };
  }
  const { persisted } = input;
  if (!persisted) return null;
  if (persisted.rewindAt !== null || persisted.cleared) {
    return {
      status: 'failed',
      detail: '消息已被移除（队列取消、会话清空或回滚），不会再送达。',
    };
  }
  if (input.firstReply) {
    if (input.firstReply.role === 'assistant') {
      return {
        status: 'consumed',
        consumed_at: isoOrNull(input.firstReply.createdAt),
      };
    }
    return {
      status: 'failed',
      detail: `投递失败：${summarizeErrorContent(input.firstReply.content)}`,
    };
  }
  if (input.isActiveTurnInput) {
    return { status: 'processing', detail: '消息已派发，任务正在处理。' };
  }
  return {
    status: 'dispatched',
    detail: '消息已受理并落库，尚未见到 assistant 回复。',
  };
}
