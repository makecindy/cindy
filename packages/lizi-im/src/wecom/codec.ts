const GROUP_LANE_PREFIX = "group/";
const MAX_MESSAGE_BYTES = 18 * 1024;

export interface WecomLane {
  kind: "single" | "group";
  targetId: string;
}

export function encodeWecomGroupLane(chatId: string): string {
  if (!chatId) throw new Error("WECOM_CHAT_ID_REQUIRED");
  return `${GROUP_LANE_PREFIX}${Buffer.from(chatId, "utf8").toString("base64url")}`;
}

export function decodeWecomLane(userId: string): WecomLane {
  if (!userId.startsWith(GROUP_LANE_PREFIX)) {
    if (!userId) throw new Error("WECOM_USER_ID_REQUIRED");
    return { kind: "single", targetId: userId };
  }
  const encoded = userId.slice(GROUP_LANE_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("WECOM_GROUP_LANE_INVALID");
  }
  try {
    const targetId = Buffer.from(encoded, "base64url").toString("utf8");
    if (
      !targetId ||
      Buffer.from(targetId, "utf8").toString("base64url") !== encoded
    ) {
      throw new Error("WECOM_GROUP_LANE_INVALID");
    }
    return { kind: "group", targetId };
  } catch {
    throw new Error("WECOM_GROUP_LANE_INVALID");
  }
}

export function chunkWecomMarkdown(source: string): string[] {
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return ["✅ (本轮无文本输出)"];

  const chunks: string[] = [];
  let current = "";
  for (const point of normalized) {
    const candidate = current + point;
    if (Buffer.byteLength(candidate, "utf8") > MAX_MESSAGE_BYTES && current) {
      chunks.push(current);
      current = point;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function escapeWecomMarkdown(source: string): string {
  return source.replace(/([\\`*_{}[\]()#+\-.!>])/g, "\\$1");
}
