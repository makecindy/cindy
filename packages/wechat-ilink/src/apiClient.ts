import { randomBytes } from "node:crypto";
import { asWechatIlinkError, WechatIlinkError } from "./errors.js";
import { parseJsonObject } from "./codec.js";
import type {
  IlinkMessage,
  IlinkMessageItem,
  WechatMediaRef,
  WechatSendMediaRequest,
  WechatSendRequest,
} from "./types.js";
import {
  MessageItemType,
  MessageState,
  MessageType,
  TypingStatus,
} from "./types.js";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface IlinkApiClientOptions {
  baseUrl: string;
  token?: string;
  appId?: string;
  clientVersion?: string;
  botAgent: string;
  routeTag?: string;
  fetch: FetchLike;
  apiTimeoutMs?: number;
  longPollTimeoutMs?: number;
  maxResponseBytes?: number;
  maxPollMessages?: number;
  maxItemsPerMessage?: number;
}

export interface QrStatusResponse {
  status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
}

const AUTHORIZATION_ORIGIN = new URL("https://ilinkai.weixin.qq.com");

function versionInteger(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

export function sanitizeBotAgent(raw: string): string {
  const product = /^[A-Za-z0-9_.-]{1,32}\/[A-Za-z0-9_.+-]{1,32}$/;
  const accepted = raw
    .trim()
    .split(/\s+/)
    .filter((token) => product.test(token));
  const result: string[] = [];
  let length = 0;
  for (const token of accepted) {
    const next = length + (result.length ? 1 : 0) + Buffer.byteLength(token);
    if (next > 256) break;
    result.push(token);
    length = next;
  }
  return result.join(" ") || "Cindy/unknown";
}

export function validateTencentIlinkBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink base URL is invalid.",
      false,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port !== "" && url.port !== "443") ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.hostname === "weixin.qq.com" ||
      url.hostname.endsWith(".weixin.qq.com")
    )
  ) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink base URL must be a Tencent credential-free HTTPS origin.",
      false,
    );
  }
  return url;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new WechatIlinkError(
      "BAD_RESPONSE",
      "iLink response exceeded the size limit.",
      true,
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WechatIlinkError(
          "BAD_RESPONSE",
          "iLink response exceeded the size limit.",
          true,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
}

function combineSignal(
  signal: AbortSignal,
  timeoutMs: number,
): {
  signal: AbortSignal;
  timedOut(): boolean;
  cleanup(): void;
} {
  const controller = new AbortController();
  let timeoutReached = false;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    },
  };
}

/** Stateless JSON/HTTP client. Tokens and cursor persistence remain host-owned. */
export class IlinkApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: URL;

  constructor(private readonly options: IlinkApiClientOptions) {
    this.baseUrl = validateTencentIlinkBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch;
  }

  private baseInfo() {
    return {
      channel_version: this.options.clientVersion ?? "unknown",
      bot_agent: sanitizeBotAgent(this.options.botAgent),
    };
  }

  private headers(
    authenticated: boolean,
    jsonBody: boolean,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "iLink-App-Id": this.options.appId ?? "bot",
      "iLink-App-ClientVersion": String(
        versionInteger(this.options.clientVersion ?? "0.0.0"),
      ),
      "X-WECHAT-UIN": Buffer.from(
        String(randomBytes(4).readUInt32BE(0)),
      ).toString("base64"),
    };
    if (this.options.routeTag) headers.SKRouteTag = this.options.routeTag;
    if (jsonBody) {
      headers["Content-Type"] = "application/json";
      headers.AuthorizationType = "ilink_bot_token";
    }
    if (authenticated) {
      if (this.options.token?.trim())
        headers.Authorization = `Bearer ${this.options.token.trim()}`;
    }
    return headers;
  }

  private async request(
    endpoint: string,
    init: { method: "GET" | "POST"; body?: unknown; authenticated: boolean },
    signal: AbortSignal,
    timeoutMs = this.options.apiTimeoutMs ?? 15_000,
    baseUrl = this.baseUrl,
  ): Promise<Record<string, unknown>> {
    const url = new URL(endpoint, baseUrl);
    const combined = combineSignal(signal, timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: init.method,
        headers: this.headers(init.authenticated, init.method === "POST"),
        signal: combined.signal,
        redirect: "manual",
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const text = await readBoundedText(
        response,
        this.options.maxResponseBytes ?? 4 * 1024 * 1024,
      );
      if (!response.ok) {
        throw new WechatIlinkError(
          "HTTP_ERROR",
          `iLink request failed with HTTP ${response.status}.`,
          response.status >= 500,
        );
      }
      return parseJsonObject(text);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (signal.aborted) {
          throw new WechatIlinkError(
            "ABORTED",
            "The iLink operation was cancelled.",
            true,
            {
              cause: error,
            },
          );
        }
        if (combined.timedOut()) {
          throw new WechatIlinkError(
            "TIMEOUT",
            "The iLink request timed out.",
            true,
            {
              cause: error,
            },
          );
        }
      }
      throw asWechatIlinkError(error);
    } finally {
      combined.cleanup();
    }
  }

  beginQr(
    localTokens: string[],
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "ilink/bot/get_bot_qrcode?bot_type=3",
      {
        method: "POST",
        body: { local_token_list: localTokens.slice(-10) },
        authenticated: false,
      },
      signal,
      this.options.apiTimeoutMs ?? 15_000,
      AUTHORIZATION_ORIGIN,
    );
  }

  async pollQr(
    qrCode: string,
    verificationCode: string | undefined,
    signal: AbortSignal,
    baseUrl?: string,
  ): Promise<QrStatusResponse> {
    const query = new URLSearchParams({ qrcode: qrCode });
    if (verificationCode) query.set("verify_code", verificationCode);
    try {
      return (await this.request(
        `ilink/bot/get_qrcode_status?${query}`,
        { method: "GET", authenticated: false },
        signal,
        this.options.longPollTimeoutMs ?? 35_000,
        baseUrl ? validateTencentIlinkBaseUrl(baseUrl) : this.baseUrl,
      )) as unknown as QrStatusResponse;
    } catch (error) {
      if (error instanceof WechatIlinkError && error.code === "TIMEOUT") {
        return { status: "wait" };
      }
      throw error;
    }
  }

  async getUpdates(cursor: string, signal: AbortSignal) {
    try {
      return await this.request(
        "ilink/bot/getupdates",
        {
          method: "POST",
          authenticated: true,
          body: {
            get_updates_buf: cursor,
            base_info: this.baseInfo(),
          },
        },
        signal,
        this.options.longPollTimeoutMs ?? 35_000,
      );
    } catch (error) {
      if (error instanceof WechatIlinkError && error.code === "TIMEOUT") {
        return { ret: 0, msgs: [], get_updates_buf: cursor };
      }
      throw error;
    }
  }

  notifyStart(signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.notifyLifecycle("ilink/bot/msg/notifystart", signal);
  }

  notifyStop(signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.notifyLifecycle("ilink/bot/msg/notifystop", signal);
  }

  async sendText(
    request: WechatSendRequest,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      !request.peerId.trim() ||
      !request.contextToken.trim() ||
      !request.clientId.trim() ||
      request.text.length === 0 ||
      Array.from(request.text).length > 3500
    ) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "The iLink text message is incomplete.",
        false,
      );
    }
    const response = await this.request(
      "ilink/bot/sendmessage",
      {
        method: "POST",
        authenticated: true,
        body: {
          msg: {
            from_user_id: "",
            to_user_id: request.peerId,
            client_id: request.clientId,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [
              { type: MessageItemType.TEXT, text_item: { text: request.text } },
            ],
            context_token: request.contextToken,
            run_id: request.runId,
          },
          base_info: this.baseInfo(),
        },
      },
      signal,
    );
    if (typeof response.ret === "number" && response.ret !== 0) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "iLink rejected the message.",
        true,
      );
    }
  }

  async getUploadUrl(
    request: {
      peerId: string;
      fileKey: string;
      mediaType: number;
      rawSize: number;
      rawMd5: string;
      encryptedSize: number;
      aesKeyHex: string;
    },
    signal: AbortSignal,
  ): Promise<{
    uploadParam?: string;
    uploadFullUrl?: string;
  }> {
    const response = await this.request(
      "ilink/bot/getuploadurl",
      {
        method: "POST",
        authenticated: true,
        body: {
          filekey: request.fileKey,
          media_type: request.mediaType,
          to_user_id: request.peerId,
          rawsize: request.rawSize,
          rawfilemd5: request.rawMd5,
          filesize: request.encryptedSize,
          no_need_thumb: true,
          aeskey: request.aesKeyHex,
          base_info: this.baseInfo(),
        },
      },
      signal,
    );
    if (typeof response.ret === "number" && response.ret !== 0) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "iLink rejected the media upload request.",
        true,
      );
    }
    return {
      uploadParam:
        typeof response.upload_param === "string"
          ? response.upload_param
          : undefined,
      uploadFullUrl:
        typeof response.upload_full_url === "string"
          ? response.upload_full_url
          : undefined,
    };
  }

  async sendMedia(
    request: WechatSendMediaRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const { ref, fileName } = request.uploaded;
    if (
      !request.peerId.trim() ||
      !request.contextToken.trim() ||
      !request.clientId.trim() ||
      !ref.encryptedQuery ||
      !ref.aesKeyBase64
    ) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "The iLink media message is incomplete.",
        false,
      );
    }
    const item = mediaItemFor(ref, fileName);
    const response = await this.request(
      "ilink/bot/sendmessage",
      {
        method: "POST",
        authenticated: true,
        body: {
          msg: {
            from_user_id: "",
            to_user_id: request.peerId,
            client_id: request.clientId,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [item],
            context_token: request.contextToken,
            run_id: request.runId,
          },
          base_info: this.baseInfo(),
        },
      },
      signal,
    );
    if (typeof response.ret === "number" && response.ret !== 0) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "iLink rejected the media message.",
        true,
      );
    }
  }

  getConfig(peerId: string, contextToken: string, signal: AbortSignal) {
    if (!peerId.trim() || !contextToken.trim()) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "The iLink typing request is incomplete.",
        false,
      );
    }
    return this.request(
      "ilink/bot/getconfig",
      {
        method: "POST",
        authenticated: true,
        body: {
          ilink_user_id: peerId,
          context_token: contextToken,
          base_info: this.baseInfo(),
        },
      },
      signal,
    );
  }

  async setTyping(
    peerId: string,
    ticket: string,
    active: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (!peerId.trim() || !ticket.trim()) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "The iLink typing request is incomplete.",
        false,
      );
    }
    const response = await this.request(
      "ilink/bot/sendtyping",
      {
        method: "POST",
        authenticated: true,
        body: {
          ilink_user_id: peerId,
          typing_ticket: ticket,
          status: active ? TypingStatus.TYPING : TypingStatus.CANCEL,
          base_info: this.baseInfo(),
        },
      },
      signal,
    );
    if (typeof response.ret === "number" && response.ret !== 0) {
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "iLink rejected the typing request.",
        true,
      );
    }
  }

  static messagesFrom(response: Record<string, unknown>): IlinkMessage[] {
    if (response.msgs === undefined) return [];
    if (!Array.isArray(response.msgs)) {
      throw new WechatIlinkError(
        "BAD_RESPONSE",
        "iLink returned an invalid message list.",
        true,
      );
    }
    return response.msgs.filter(
      (message): message is IlinkMessage =>
        message !== null &&
        typeof message === "object" &&
        !Array.isArray(message),
    );
  }

  messagesFrom(response: Record<string, unknown>): IlinkMessage[] {
    const messages = IlinkApiClient.messagesFrom(response);
    if (messages.length > (this.options.maxPollMessages ?? 100)) {
      throw new WechatIlinkError(
        "BAD_RESPONSE",
        "iLink returned too many messages in one poll.",
        true,
      );
    }
    for (const message of messages) {
      if (
        message.item_list !== undefined &&
        (!Array.isArray(message.item_list) ||
          message.item_list.length > (this.options.maxItemsPerMessage ?? 20))
      ) {
        throw new WechatIlinkError(
          "BAD_RESPONSE",
          "iLink returned an invalid message item list.",
          true,
        );
      }
    }
    return messages;
  }

  private notifyLifecycle(
    endpoint: "ilink/bot/msg/notifystart" | "ilink/bot/msg/notifystop",
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.request(
      endpoint,
      {
        method: "POST",
        authenticated: true,
        body: { base_info: this.baseInfo() },
      },
      signal,
      5_000,
    );
  }
}

function mediaItemFor(ref: WechatMediaRef, fileName: string): IlinkMessageItem {
  const media = {
    encrypt_query_param: ref.encryptedQuery,
    aes_key: ref.aesKeyBase64,
    encrypt_type: 1,
  };
  switch (ref.kind) {
    case "image":
      return {
        type: MessageItemType.IMAGE,
        image_item: {
          media,
          mid_size: ref.encryptedByteLength ?? ref.byteLength,
        },
      };
    case "video":
      return {
        type: MessageItemType.VIDEO,
        video_item: {
          media,
          video_size: ref.encryptedByteLength ?? ref.byteLength,
        },
      };
    case "file":
      return {
        type: MessageItemType.FILE,
        file_item: {
          media,
          file_name: fileName,
          len:
            ref.byteLength === undefined ? undefined : String(ref.byteLength),
        },
      };
    case "voice":
      throw new WechatIlinkError(
        "PROTOCOL_ERROR",
        "Outbound voice messages are not supported.",
        false,
      );
  }
}
