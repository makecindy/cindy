import { WechatIlinkError } from "./errors.js";
import {
  MessageItemType,
  MessageType,
  type IlinkCdnMedia,
  type IlinkMessage,
  type IlinkMessageItem,
  type WechatInboundMessage,
  type WechatMediaRef,
} from "./types.js";

export function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Converted to the stable package error below.
  }
  throw new WechatIlinkError(
    "BAD_RESPONSE",
    "iLink returned invalid JSON.",
    true,
  );
}

function mediaBase(
  kind: WechatMediaRef["kind"],
  media?: IlinkCdnMedia,
): WechatMediaRef {
  return {
    kind,
    downloadUrl: media?.full_url,
    encryptedQuery: media?.encrypt_query_param,
    aesKeyBase64: media?.aes_key,
  };
}

function optionalByteLength(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function decodeQuote(item: IlinkMessageItem) {
  const ref = item.ref_msg;
  if (!ref) return undefined;
  const quoted = ref.message_item;
  if (!quoted) {
    return ref.title ? { title: ref.title, media: [] } : undefined;
  }
  const text =
    quoted.type === MessageItemType.TEXT &&
    typeof quoted.text_item?.text === "string"
      ? quoted.text_item.text
      : quoted.type === MessageItemType.VOICE &&
          typeof quoted.voice_item?.text === "string"
        ? quoted.voice_item.text
        : undefined;
  const decoded = decodeItemMedia(quoted);
  return {
    ...(ref.title ? { title: ref.title } : {}),
    ...(text ? { text } : {}),
    media: decoded ? [decoded] : [],
  };
}

function decodeItemMedia(item: IlinkMessageItem): WechatMediaRef | null {
  switch (item.type) {
    case MessageItemType.IMAGE:
      return {
        ...mediaBase("image", item.image_item?.media),
        aesKeyHex: item.image_item?.aeskey,
        encryptedByteLength: item.image_item?.mid_size,
      };
    case MessageItemType.VOICE:
      return {
        ...mediaBase("voice", item.voice_item?.media),
        voiceEncoding: item.voice_item?.encode_type,
        transcript: item.voice_item?.text,
      };
    case MessageItemType.FILE:
      return {
        ...mediaBase("file", item.file_item?.media),
        fileName: item.file_item?.file_name,
        byteLength: optionalByteLength(item.file_item?.len),
        md5Hex: item.file_item?.md5,
      };
    case MessageItemType.VIDEO:
      return {
        ...mediaBase("video", item.video_item?.media),
        encryptedByteLength: item.video_item?.video_size,
      };
    default:
      return null;
  }
}

export function decodeInboundMessage(
  message: IlinkMessage,
): WechatInboundMessage | null {
  if (!message || typeof message !== "object") return null;
  if (message.message_type != null && message.message_type !== MessageType.USER)
    return null;
  const senderId =
    typeof message.from_user_id === "string" ? message.from_user_id.trim() : "";
  const recipientId =
    typeof message.to_user_id === "string" ? message.to_user_id.trim() : "";
  const contextToken =
    typeof message.context_token === "string"
      ? message.context_token.trim()
      : "";
  const messageId = stableInboundMessageId(message);
  if (!senderId || !contextToken || !messageId) return null;

  const textParts: string[] = [];
  const media: WechatMediaRef[] = [];
  let quote: WechatInboundMessage["quote"];
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    quote ??= decodeQuote(item);
    switch (item.type) {
      case MessageItemType.TEXT:
        if (typeof item.text_item?.text === "string" && item.text_item.text) {
          textParts.push(item.text_item.text);
        }
        break;
      case MessageItemType.IMAGE:
        media.push(decodeItemMedia(item)!);
        break;
      case MessageItemType.VOICE:
        if (typeof item.voice_item?.text === "string" && item.voice_item.text) {
          textParts.push(item.voice_item.text);
        }
        media.push(decodeItemMedia(item)!);
        break;
      case MessageItemType.FILE:
        media.push(decodeItemMedia(item)!);
        break;
      case MessageItemType.VIDEO:
        media.push(decodeItemMedia(item)!);
        break;
    }
  }

  return {
    messageId,
    senderId,
    ...(recipientId ? { recipientId } : {}),
    clientId: message.client_id,
    createdAt: message.create_time_ms,
    contextToken,
    text: textParts.join("\n"),
    media,
    ...(quote ? { quote } : {}),
  };
}

function stableInboundMessageId(message: IlinkMessage): string {
  const clientId =
    typeof message.client_id === "string" ? message.client_id.trim() : "";
  if (clientId) return `client:${clientId}`;

  if (
    typeof message.message_id === "number" &&
    Number.isFinite(message.message_id) &&
    Number.isInteger(message.message_id)
  ) {
    return `message:${message.message_id}`;
  }
  if (typeof message.message_id === "string" && message.message_id.trim()) {
    return `message:${message.message_id.trim()}`;
  }
  if (
    typeof message.seq === "number" &&
    Number.isFinite(message.seq) &&
    Number.isInteger(message.seq)
  ) {
    return `seq:${message.seq}`;
  }
  return "";
}
