import type { IMAttachment, IMUnsupportedEntry } from "../types.js";

export interface DingTalkInboundEnvelope {
  conversationId: string;
  conversationType: "1" | "2";
  messageId: string;
  messageType: string;
  robotCode: string;
  senderId: string;
  senderName: string;
  senderStaffId: string;
  sessionWebhook: string | null;
  sessionWebhookExpiresAt: number | null;
  mentioned: boolean;
  raw: Record<string, unknown>;
}

export interface DingTalkInboundContent {
  text: string;
  downloadCodes: string[];
  unsupported: IMUnsupportedEntry[];
}

export function parseInboundEnvelope(
  raw: unknown,
): DingTalkInboundEnvelope | null {
  if (!isRecord(raw)) return null;
  const conversationId = readString(raw, "conversationId");
  const conversationType = readString(raw, "conversationType");
  const messageId = readString(raw, "msgId");
  const messageType = readString(raw, "msgtype");
  const robotCode = readString(raw, "robotCode");
  const senderId = readString(raw, "senderId");
  const senderStaffId = readString(raw, "senderStaffId");
  if (
    !conversationId ||
    (conversationType !== "1" && conversationType !== "2") ||
    !messageId ||
    !messageType ||
    !robotCode ||
    (!senderId && !senderStaffId)
  ) {
    return null;
  }

  return {
    conversationId,
    conversationType,
    messageId,
    messageType,
    robotCode,
    senderId: senderStaffId || senderId,
    senderStaffId,
    senderName: readString(raw, "senderNick") || "钉钉用户",
    sessionWebhook: readString(raw, "sessionWebhook") || null,
    sessionWebhookExpiresAt: normalizeEpochMs(
      readFiniteNumber(raw, "sessionWebhookExpiredTime"),
    ),
    mentioned: isBotMentioned(raw, robotCode),
    raw,
  };
}

export function parseInboundContent(
  envelope: DingTalkInboundEnvelope,
): DingTalkInboundContent {
  const raw = envelope.raw;
  switch (envelope.messageType) {
    case "text":
      return result(readNestedString(raw, "text", "content"));
    case "richText":
      return parseRichText(raw);
    case "picture":
      return {
        text: "",
        downloadCodes: [
          readNestedString(raw, "content", "downloadCode") ||
            readString(raw, "downloadCode"),
        ].filter(Boolean),
        unsupported: [],
      };
    case "audio": {
      const recognition =
        readString(raw, "recognition") ||
        readNestedString(raw, "content", "recognition");
      return recognition
        ? result(recognition)
        : unsupported("audio", "语音（没有可用的文字识别结果）");
    }
    case "video":
      return unsupported("video", "视频");
    case "file":
      return unsupported("file", "文件");
    default:
      return unsupported(
        envelope.messageType,
        `暂不支持的消息类型 ${envelope.messageType}`,
      );
  }
}

export function imageAttachment(
  absPath: string,
  url: string,
  mimeType: string,
): IMAttachment {
  return {
    kind: "image",
    absPath,
    originalName: `dingtalk-image.${extensionForMime(mimeType)}`,
    mimeType,
    url,
  };
}

function result(text: string): DingTalkInboundContent {
  return { text: text.trim(), downloadCodes: [], unsupported: [] };
}

function unsupported(type: string, label: string): DingTalkInboundContent {
  return { text: "", downloadCodes: [], unsupported: [{ type, label }] };
}

function parseRichText(raw: Record<string, unknown>): DingTalkInboundContent {
  const content = isRecord(raw.content) ? raw.content : {};
  const richText = content.richText;
  const parts: string[] = [];
  const downloadCodes: string[] = [];
  visitRichText(richText, parts, downloadCodes);
  return {
    text: parts
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    downloadCodes: Array.from(new Set(downloadCodes)),
    unsupported: [],
  };
}

function visitRichText(
  value: unknown,
  parts: string[],
  downloadCodes: string[],
): void {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      visitRichText(entry, parts, downloadCodes);
      if (index < value.length - 1 && isRecord(entry)) parts.push("\n");
    });
    return;
  }
  if (!isRecord(value)) return;
  const type = readString(value, "type");
  const downloadCode =
    readString(value, "downloadCode") ||
    (type === "picture" ? readString(value, "pictureUrl") : "");
  if (downloadCode) downloadCodes.push(downloadCode);
  for (const key of ["text", "content", "title"]) {
    if (typeof value[key] === "string") parts.push(value[key] as string);
  }
  for (const key of ["richText", "children", "items"]) {
    if (value[key] !== undefined)
      visitRichText(value[key], parts, downloadCodes);
  }
}

function isBotMentioned(
  raw: Record<string, unknown>,
  robotCode: string,
): boolean {
  if (raw.isInAtList === true) return true;
  const atUsers = raw.atUsers;
  if (!Array.isArray(atUsers)) return false;
  return atUsers.some((entry) => {
    if (!isRecord(entry)) return false;
    return Object.values(entry).some((value) => value === robotCode);
  });
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? (value[key] as string).trim() : "";
}

function readNestedString(
  value: Record<string, unknown>,
  parent: string,
  key: string,
): string {
  return isRecord(value[parent])
    ? readString(value[parent] as Record<string, unknown>, key)
    : "";
}

function readFiniteNumber(
  value: Record<string, unknown>,
  key: string,
): number | null {
  return typeof value[key] === "number" && Number.isFinite(value[key])
    ? (value[key] as number)
    : null;
}

function normalizeEpochMs(value: number | null): number | null {
  if (value === null) return null;
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}
