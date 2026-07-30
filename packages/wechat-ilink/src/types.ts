/** Raw iLink wire constants mirrored from Tencent's public client. */
export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

export interface IlinkCdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface IlinkMessageItem {
  type?: number;
  msg_id?: string;
  ref_msg?: {
    title?: string;
    message_item?: IlinkMessageItem;
  };
  text_item?: { text?: string };
  image_item?: {
    media?: IlinkCdnMedia;
    aeskey?: string;
    mid_size?: number;
  };
  voice_item?: {
    media?: IlinkCdnMedia;
    encode_type?: number;
    text?: string;
    playtime?: number;
  };
  file_item?: {
    media?: IlinkCdnMedia;
    file_name?: string;
    len?: string;
    md5?: string;
  };
  video_item?: {
    media?: IlinkCdnMedia;
    video_size?: number;
    play_length?: number;
  };
}

export interface IlinkMessage {
  seq?: number;
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  message_type?: number;
  message_state?: number;
  item_list?: IlinkMessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface WechatAuthChallenge {
  id: string;
  qrCodeUrl: string;
  createdAt: number;
}

export interface WechatCredentials {
  token: string;
  botId: string;
  userId: string;
  baseUrl: string;
}

export type WechatAuthorizationEvent =
  | { status: "waiting" | "scanned" }
  | { status: "verification-required"; retry: boolean }
  | { status: "qr-refreshed"; challenge: WechatAuthChallenge };

export interface WechatAuthorizationObserver {
  onEvent?(event: WechatAuthorizationEvent): void | Promise<void>;
  requestVerificationCode?(
    retry: boolean,
    signal: AbortSignal,
  ): Promise<string>;
}

export interface WechatMediaRef {
  kind: "image" | "voice" | "file" | "video";
  downloadUrl?: string;
  encryptedQuery?: string;
  aesKeyBase64?: string;
  aesKeyHex?: string;
  fileName?: string;
  /** Plaintext byte length when the wire format exposes it. */
  byteLength?: number;
  /** AES-padded ciphertext byte length used by image/video send payloads. */
  encryptedByteLength?: number;
  voiceEncoding?: number;
  transcript?: string;
  md5Hex?: string;
}

export interface WechatQuote {
  title?: string;
  text?: string;
  media: WechatMediaRef[];
}

export interface WechatInboundMessage {
  messageId: string;
  senderId: string;
  recipientId?: string;
  clientId?: string;
  createdAt?: number;
  contextToken: string;
  text: string;
  media: WechatMediaRef[];
  quote?: WechatQuote;
}

export interface WechatPollResult {
  cursor: string;
  messages: WechatInboundMessage[];
  suggestedTimeoutMs?: number;
}

export interface WechatSendRequest {
  peerId: string;
  text: string;
  contextToken: string;
  clientId: string;
  runId?: string;
}

export interface WechatSendResult {
  clientId: string;
}

export interface WechatUploadRequest {
  peerId: string;
  bytes: Uint8Array;
  fileName: string;
  kind: WechatMediaRef["kind"];
}

export interface WechatUploadedMedia {
  ref: WechatMediaRef;
  fileName: string;
}

export interface WechatSendMediaRequest {
  peerId: string;
  contextToken: string;
  clientId: string;
  uploaded: WechatUploadedMedia;
  runId?: string;
}
