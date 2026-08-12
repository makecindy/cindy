/**
 * feishu/codec.ts — 群 lane id 的编码约定。
 * ---------------------------------------------------------------------------
 * 群/话题会话在编排层的"userId":`g/${chatId}` 或 `g/${chatId}/${threadId}`。
 * 编排层按 (botAppId, userId) 路由会话与出站目标,lane id 让「每群一个会话、
 * 每话题一个会话」零共享层改动成立(telegram/codec.ts 同款语义);transport
 * 出站时解码路由回对应群聊/话题。
 *
 * 私聊 userId 是飞书 open_id(`ou_` 前缀),群 chat_id 是 `oc_` 前缀,话题
 * thread_id 是 `omt_` 前缀 —— 与 `g/` 前缀无歧义。
 */

const LANE_PREFIX = 'g/';

export interface FeishuLane {
  chatId: string;
  /** 话题 thread_id;'' = 群主流(非话题消息)。 */
  threadId: string;
}

export function encodeLaneUserId(chatId: string, threadId?: string | null): string {
  const thread = threadId ?? '';
  return thread ? `${LANE_PREFIX}${chatId}/${thread}` : `${LANE_PREFIX}${chatId}`;
}

/** 非 lane id(私聊 open_id)返回 null。 */
export function decodeLaneUserId(userId: string): FeishuLane | null {
  if (!userId.startsWith(LANE_PREFIX)) return null;
  const rest = userId.slice(LANE_PREFIX.length);
  const [chatId, threadId = ''] = rest.split('/');
  if (!chatId) return null;
  return { chatId, threadId };
}
