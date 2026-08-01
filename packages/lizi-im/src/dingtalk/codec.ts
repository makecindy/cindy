const GROUP_LANE_PREFIX = "g/";

export interface DingTalkLane {
  conversationId: string;
}

export function encodeLaneUserId(conversationId: string): string {
  if (!conversationId || conversationId.includes("\0")) {
    throw new Error("invalid dingtalk conversation id");
  }
  return `${GROUP_LANE_PREFIX}${encodeURIComponent(conversationId)}`;
}

export function decodeLaneUserId(userId: string): DingTalkLane | null {
  if (!userId.startsWith(GROUP_LANE_PREFIX)) return null;
  const encoded = userId.slice(GROUP_LANE_PREFIX.length);
  if (!encoded) return null;
  try {
    const conversationId = decodeURIComponent(encoded);
    return conversationId ? { conversationId } : null;
  } catch {
    return null;
  }
}
