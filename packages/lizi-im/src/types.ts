/**
 * @cindy/im public types
 * ---------------------------------------------------------------------------
 * The transport-layer contract between @cindy/im (pure package) and the host
 * (apps/desktop). Keep this file electron-free; host adapters fulfil the
 * `IMHost` shape using whatever Electron / Node / browser APIs they need.
 */

import type { Logger } from './logger.js';

/** Result of a secret read when callers must distinguish absence from failure. */
export type IMSecretReadResult =
  | { kind: 'value'; value: string }
  | { kind: 'missing' }
  | { kind: 'error' };

/**
 * Host-injected capabilities. Hosts must provide encrypted KV storage, an IPC
 * bridge, and a couple of derived paths. Optionally a logger factory; otherwise
 * we use the bundled console logger.
 */
export interface IMHost {
  /** Encrypted KV storage (replaces electron.safeStorage). */
  secrets: {
    /** Persist `plaintext` under `name`; returns whether it was written. */
    write(name: string, plaintext: string): boolean;
    /** Read; missing or unavailable returns null. */
    read(name: string): string | null;
    /**
     * Read without collapsing a missing key and a storage/decryption failure.
     * Optional for backwards-compatible hosts; callers that require certainty
     * must treat an absent implementation as `error`.
     */
    readResult?(name: string): IMSecretReadResult;
    /** Remove (no-op if missing). */
    remove(name: string): void;
    /** Whether encryption is currently usable (e.g. Linux without keychain). */
    isAvailable(): boolean;
  };

  /** IPC bridge (replaces electron.ipcMain + BrowserWindow). */
  ipc: {
    /** Raise a host-standard, renderer-decodable IPC error. */
    throwIpcError(code: 'INVALID_PARAMS', message: string): never;
    /** Register an `invoke` handler. @cindy/im owns channel names. */
    handle(
      channel: string,
      handler: (payload?: unknown) => Promise<unknown> | unknown,
    ): void;
    /** Push to all renderer windows. */
    broadcast(channel: string, payload: unknown): void;
  };

  /**
   * Optional host-owned authenticated-account scope. Transport packages use
   * this to keep long-running setup flows (credential save / app registration)
   * inside the same account generation that initiated them, without depending
   * on a renderer, database, or host lifecycle implementation.
   */
  accountScope?: {
    /** Capture the current opaque account generation; null means logged out. */
    capture(): unknown | null;
    /** Whether a previously captured generation still owns the active account. */
    isCurrent(token: unknown): boolean;
    /** Run transport-mutating work only while that generation remains active. */
    run<T>(token: unknown, operation: () => Promise<T>): Promise<T>;
  };

  /** Filesystem path config; hosts derive these from `app.getPath('userData')`. */
  paths: {
    /** Root for downloaded feishu media (images / files). MUST equal the media root the host wires elsewhere (e.g. the xdt-image:// media service) so xdt-image:// URLs resolve consistently across contexts. */
    feishuMediaDir: string;
    /** Root for downloaded discord media. Optional — only hosts that wire the discord channel provide it. */
    discordMediaDir?: string;
    /** Root for downloaded telegram media. Optional — only hosts that wire the telegram channel provide it. */
    telegramMediaDir?: string;
    /** Root for downloaded WeCom files and legacy image fallback. */
    wecomMediaDir?: string;
  };

  /**
   * host 托管的媒体缓存(cindy-media 媒体总仓)。可选——注入后入站图片及
   * host 明确支持的其它媒体改走内容寻址仓;非媒体文件仍走
   * `paths.*MediaDir`。包侧只摸字节和字符串,落盘/记账细节全在 host。
   */
  media?: IMHostMediaCache;

  httpPostForm(url: string, form: URLSearchParams): Promise<{ status: number; body: unknown }>;

  /** Optional logger factory; default is a console logger. */
  createLogger?(scope: string): Logger;
}

// ── Inbound events ────────────────────────────────────────────────────────────
// p2p only — group_chat / topic_chat events are dropped at wsClient before
// emitting, so handlers never see them.

/** host 托管媒体缓存回调组(见 IMHost.media)。 */
export interface IMHostMediaCache {
  /** 图片字节入 host 总仓;返回仓内绝对路径(喂 agent)+ 渲染 URL(cindy-media://)。 */
  cacheImage(params: {
    integration: 'feishu' | 'discord' | 'telegram' | 'dingtalk' | 'wecom';
    /** 平台侧稳定 token(feishu image_key / discord attachment id / telegram file_id),host 据此免重下。 */
    token: string;
    buffer: Uint8Array;
    mimeType: string;
    /** Keep the blob reclaimable until the transport confirms account ownership after the write. */
    staging?: boolean;
  }): Promise<{ absPath: string; url: string; discard?: () => Promise<void> }>;
  /**
   * 其它 Cindy 托管媒体入总仓。未提供时 transport 必须降级为 unsupported，
   * 不得新增写入冻结的 `cc-agent/*-media` 历史目录。
   */
  cacheMedia?(params: {
    integration: 'feishu' | 'discord' | 'telegram' | 'wecom';
    token: string;
    buffer: Uint8Array;
    mimeType: string;
  }): Promise<{
    absPath: string;
    url: string;
    mimeType: string;
    /** Release host-side staging when the originating account becomes stale. */
    discard?: () => Promise<void>;
  }>;
  /** 按 token 查已缓存图片;未缓存返回 null(调用方去真下载)。 */
  getCachedImage(
    integration: 'feishu' | 'discord' | 'telegram' | 'dingtalk' | 'wecom',
    token: string,
    options?: {
      /** Re-check transport/account ownership after the async lookup, before host-side pinning. */
      shouldReuse?: () => boolean;
    },
  ): Promise<{ absPath: string; url: string; mimeType: string } | null>;
  /** host 托管媒体 URL(cindy-media://)→ 绝对路径;认不出返回 null(出站上传用)。 */
  resolveMediaUrl(url: string): string | null;
  /**
   * 下载公开 HTTPS 图片供 IM 出站上传或拉取平台签发的临时媒体 URL。
   * host 必须逐跳执行 SSRF / DNS rebinding 防护并在读取过程中执行
   * maxBytes 上限；返回字节不落盘。
   */
  fetchRemoteImage?(
    url: string,
    maxBytes: number,
  ): Promise<{ buffer: Uint8Array; mimeType?: string }>;
}

export interface IMAttachment {
  kind: 'image' | 'file';
  /** 下载副本的绝对路径:老目录(`host.paths.*MediaDir`)或 host 媒体总仓内(经 media.cacheImage 提升后)。 */
  absPath: string;
  /** Original filename from the IM platform. */
  originalName: string;
  /** Detected MIME type. */
  mimeType: string;
  /** host 媒体总仓地址(cindy-media://,经 media.cacheImage 提升后才有);host 落库时据此挂会话引用。 */
  url?: string;
}

export interface IMUnsupportedEntry {
  /** Channel-specific machine code (e.g. 'audio', 'media', 'oversize'). */
  type: string;
  /** Localised label suitable for showing the user. */
  label: string;
}

export interface IMMessageEvent {
  channelName: string;
  /** Sender open_id (or channel-equivalent stable user id). */
  senderId: string;
  /** Channel-native chat id (feishu chat_id), useful if main wants to persist. */
  chatId: string;
  /** Channel context id (feishu app id). */
  contextId: string;
  /** Channel message id — host can use to ack via reactions / quote-reply etc. */
  messageId: string;
  /** Plain-text payload. */
  text: string;
  /**
   * 群多人对话的发言人元数据(telegram 群 turn 提供; 其它渠道/DM 缺省)。
   * name 为平台显示名 — 不可信输入, 消费方注入 prompt 前必须消毒。
   */
  speaker?: { id: string; name: string; username?: string; isOwner: boolean };
  /**
   * 全响应模式下的旁听触发(非显式召唤): 业务层注入安静上下文指令,
   * 模型可用 NO_REPLY 哨兵选择沉默; transport 抑制该消息的表情回应。
   */
  ambient?: boolean;
  /**
   * 这条消息来自「禁止保存内容」的群(Telegram `has_protected_content`)。
   *
   * 它照常起 turn —— 用户 @ 机器人说的话是他此刻要说给 bot 的。但**不得写入
   * 任何长期存档**: 群历史池已在渠道侧拦下, 这个标记是给业务层的第二道 ——
   * 会话消息存档同样不能成为绕过保护边界的旁路。
   *
   * 缺省 / false = 未受保护(只有 Telegram 会置它, 其它渠道不设置, 行为不变)。
   */
  protectedContent?: boolean;
  /** Pre-downloaded attachments. */
  attachments: IMAttachment[];
  /**
   * Items the channel could not deliver to the agent (audio, video, oversized,
   * unknown msg_type, download failures, etc.). Host decides how to respond:
   *   - text empty + attachments empty + unsupported non-empty → reply with
   *     a "🙏 这条消息我没法处理" notice; do NOT invoke the agent
   *   - mixed (text/attachments + unsupported) → ack the user that some bits
   *     were skipped, then run the agent with the clean text/attachments
   * @cindy/im does not auto-format these into the user prompt — that would
   * pollute the model's input.
   */
  unsupported: IMUnsupportedEntry[];
  /**
   * Thread root ts(仅 thread 内回复时有值;顶层消息 undefined)。
   * thread 能力渠道(slack)专用;feishu 恒 undefined。
   */
  threadTs?: string;
  /**
   * 会话维度键 = threadTs ?? 自身 ts。threadScoped 渠道用它路由
   * 「thread = 独立 session」;feishu 恒 undefined(整 DM 单会话)。
   */
  scopeKey?: string;
  /**
   * 本条消息所**回复/引用**的原消息(telegram reply_to_message 等)。
   * 编排层可据此在送模型正文前拼引用上下文块;落库仍是渠道原文。
   * 不支持引用语义的渠道恒 undefined。
   */
  replyContext?: {
    author: string;
    text: string;
    isBot?: boolean;
    /** 被引消息的附件数(已并入本事件 attachments;0/缺省 = 无)。 */
    attachmentCount?: number;
  };
  /** Channel-specific raw event for debug. */
  raw?: unknown;
  /**
   * 群历史上下文的取数 lane, 与路由 lane(senderId)分离。仅 feishu 群主流 @
   * 开新话题时设置: 出站路由进新话题 lane, 但上下文前缀仍按触发时所在 lane
   * (群主流, threadId='')拉取 — 新话题是空的, 按它过滤会丢掉「总结上面」等
   * 依赖的群主流上文。其它场景/渠道恒 undefined(上下文按 senderId lane 取)。
   */
  groupContextLane?: { chatId: string; threadId: string };
}

export interface IMCardActionEvent {
  channelName: string;
  /**
   * Identity of the user who pressed the button. For group cards on lane
   * channels (feishu) this is the card's lane id `g/{chatId}[/{threadId}]` —
   * transport resolves it from a messageId→lane registry so card actions share
   * the same identity key as inbound messages; p2p cards keep the open_id.
   */
  senderId: string;
  /** Chat where the card lives (p2p only). */
  chatId: string;
  /** messageId of the card; pass to updateInteractiveCard to mutate it. */
  messageId: string;
  /** The button id business code put into `button.value.id`. */
  buttonId: string;
  /** Remaining fields of the button's value JSON (business-defined payload). */
  payload: Record<string, unknown>;
  /** 卡片所在 thread root ts(卡片在 thread 内时有值)。 */
  threadTs?: string;
  /** 会话维度键 = threadTs ?? 卡片自身 ts(slack);feishu undefined。 */
  scopeKey?: string;
}

/**
 * 稳定的传输层错误分类。`reason` 是给日志/诊断看的原文(可能是英文技术串或
 * 渠道原始描述), **不适合直接当 UI 文案**;渲染层按本枚举映射到 i18n key。
 * 可选字段 —— 未标注 code 的渠道/旧路径由消费方回退到 reason。
 */
export type IMErrorCode =
  /** token 无效 / 被吊销(401 / 404)。 */
  | 'invalid-token'
  /** 渠道 API 返回了其它失败码(限流、服务端错误等)。 */
  | 'provider-api'
  /** 网络不可达 / 请求异常。 */
  | 'network'
  /** 系统安全存储不可用或写入失败,凭证与状态无法落盘。 */
  | 'secret-unavailable';

export type IMStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; appId: string }
  | { kind: 'conflict'; appId: string }
  /**
   * 凭证仍在、但用户主动下线 —— 不轮询、不收派发, 重启后保持。
   * 与 idle 严格区分: idle = 没配置(无凭证), offline = 配好了但停用。
   * 换机器时把另一端停掉而不清凭证, 之后随时可一键上线。
   */
  | { kind: 'offline'; appId: string }
  | { kind: 'error'; reason: string; code?: IMErrorCode };

// ── Outbound spec ─────────────────────────────────────────────────────────────
// p2p only — outbound APIs always take a single openId: string.

export interface InteractiveCardButton {
  id: string;
  label: string;
  type?: 'primary' | 'default' | 'danger';
  payload?: Record<string, unknown>;
}

export interface InteractiveCardSpec {
  title?: string;
  /** Markdown body. */
  body: string;
  buttons: InteractiveCardButton[];
}

/** Handle returned by `startStreamingText`; allows throttled append + finalise. */
export interface StreamingTextHandle {
  readonly messageId: string;
  /** Append delta text (@cindy/im throttles internally). */
  append(delta: string): void;
  /**
   * Replace the displayed text wholesale (still throttled). Use when the
   * caller composes the full view from multiple sources (e.g. thinking +
   * text) and append-deltas don't fit naturally.
   */
  replace(fullText: string): void;
  /** Replace card with `finalText` and stop throttling. */
  finalize(finalText: string): Promise<void>;
  /** Cancel without finalising (still leaves the last rendered text on screen). */
  close(): void;
  /**
   * 投递一张"工具结果带过来的"图片到本 card, 让 finalize 时跟原文里 xdt-image
   * markdown 链接一起 upload + 拼图。absPath 必须是已经被 host 主进程解析好的
   * OS 绝对路径 (@cindy/im 包不参与 host-specific xdt-image:// namespace 解析,
   * 那段路由 desktop main 用 imageCacheStore.resolveSafe 自己做)。
   *
   * 可选 — 不实现也合法 (e.g. 单纯 patch markdown 的轻量 handle 不支持图片)。
   */
  addExtraImageAbsPath?(absPath: string): void;
}

export interface SendFileResult {
  ok: boolean;
  reason?: 'NOT_FOUND' | 'EMPTY' | 'TOO_LARGE' | 'UPLOAD_FAIL' | 'SEND_FAIL';
  messageId?: string;
}
