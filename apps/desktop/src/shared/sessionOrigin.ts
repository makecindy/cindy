import { sanitizeSourceName } from '@cindy/maker-shared/message-source';

/**
 * 由另一个任务经 `send_to_session`（create 模式）新建时的会话级来源归属
 * （`sessions.created_by_session` 的 JSON 形态）。
 *
 * 与 `sessions.parent_session_id`（仅用于 fork / 侧边追问）严格分离。
 * 本字段仅用于侧边栏与任务头部的来源展示、筛选及回跳，不是权限或编排依据。
 * main / renderer / host 共用，必须保持 renderer-safe。
 */
export interface SessionCreatedBy {
  kind: 'session';
  /**
   * 发起创建的任务业务 ID。
   * 跨电脑新建时带服务端认证的控制端设备前缀 `deviceId::sessionId`（与 `agentMeta.origin.senderSessionId` 同口径）。
   */
  sessionId: string;
  /** 创建时刻的来源任务标题快照（已清洗，可选）。 */
  title?: string;
  /** 跨电脑发起创建时的服务端认证设备 ID（可选）。 */
  deviceId?: string;
  /** 跨电脑发起创建时的设备展示名快照（已清洗，可选）。 */
  deviceName?: string;
  /** 发起任务绑定伙伴时的伙伴 ID 快照（可选）。 */
  botId?: string;
  /** 发起任务绑定伙伴时的伙伴名称快照（已清洗，可选）。 */
  botName?: string;
}

const MAX_ID = 512;
const MAX_DEVICE_ID = 128;

function boundedId(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

export function buildSessionCreatedBy(input: {
  sessionId: string;
  title?: unknown;
  deviceId?: unknown;
  deviceName?: unknown;
  botId?: unknown;
  botName?: unknown;
}): SessionCreatedBy | null {
  const sessionId = boundedId(input.sessionId, MAX_ID);
  if (!sessionId) return null;
  const title = sanitizeSourceName(input.title);
  const deviceId = boundedId(input.deviceId, MAX_DEVICE_ID);
  const deviceName = deviceId ? sanitizeSourceName(input.deviceName) : undefined;
  const botId = boundedId(input.botId, MAX_DEVICE_ID);
  const botName = botId ? sanitizeSourceName(input.botName) : undefined;
  return {
    kind: 'session',
    sessionId,
    ...(title ? { title } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(deviceName ? { deviceName } : {}),
    ...(botId ? { botId } : {}),
    ...(botName ? { botName } : {}),
  };
}

/** 宽松解析：损坏或缺必填字段时返回 null（按普通用户新建任务处理），不抛错。 */
export function parseSessionCreatedBy(raw: unknown): SessionCreatedBy | null {
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
  if (record.kind !== 'session') return null;
  if (typeof record.sessionId !== 'string') return null;
  return buildSessionCreatedBy({
    sessionId: record.sessionId,
    title: record.title,
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    botId: record.botId,
    botName: record.botName,
  });
}

export function serializeSessionCreatedBy(origin: SessionCreatedBy): string {
  return JSON.stringify(origin);
}
