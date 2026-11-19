import { messageSourceSenderFromMeta, sanitizeSourceName } from '@cindy/maker-shared/message-source';

/**
 * 「由哪个任务发起」(sessions.origin_session 的 JSON 形态)。
 *
 * 另一个任务经 send_to_session 新建本任务时，在任务这一行记下来源任务，供侧栏标记与标题区入口
 * 使用，不必逐行查首条消息。与 parent_session_id(分叉专用)、orca_role / orca_remote_lead
 * (Orca 协同)互不相干。只用于归属展示，不是权限或信任判据。main / renderer 共用，必须保持
 * renderer-safe。
 */
export interface SessionOrigin {
  /** 来源任务 id；另一台电脑上的任务为接收端盖章的 `deviceId::sessionId`。 */
  sessionId: string;
  /** 建任务时来源任务的标题快照；界面优先取实时标题。 */
  title?: string;
}

const MAX_ORIGIN_SESSION_ID_LENGTH = 300;

function readSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id && id.length <= MAX_ORIGIN_SESSION_ID_LENGTH ? id : null;
}

export function parseSessionOrigin(raw: unknown): SessionOrigin | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sessionId = readSessionId(record.sessionId);
  if (!sessionId) return null;
  const title = sanitizeSourceName(record.title);
  return { sessionId, ...(title ? { title } : {}) };
}

export function serializeSessionOrigin(origin: SessionOrigin): string {
  return JSON.stringify(origin);
}

/**
 * 从新任务首条消息的宿主盖章来源推出任务级来源。只认「由任务发送」：插件派发以插件为准、
 * 群话题 / 群请求没有来源任务，都不记。
 */
export function sessionOriginFromInputMeta(meta: unknown): SessionOrigin | null {
  const sender = messageSourceSenderFromMeta(meta);
  if (sender?.kind !== 'session' || sender.groupThread || sender.groupRequest) return null;
  return parseSessionOrigin({ sessionId: sender.sessionId, title: sender.title });
}
