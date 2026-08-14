/**
 * telegram/api.ts — Telegram Bot API 最小客户端。
 * ---------------------------------------------------------------------------
 * 个人 Telegram bot 直连官方 Bot API(用户自填 BotFather token), 不经任何中继。
 * 只封装本渠道用到的方法; 统一错误形状(TelegramApiError 携带 error_code),
 * 上层据 401/409 等区分「token 无效」与「另一个进程在轮询」。
 *
 * 零第三方依赖: 用全局 fetch + FormData(Node 18+), 与包的 electron-free
 * 约束一致; 网络代理等宿主策略由 Node 全局 dispatcher 生效, 这里不感知。
 */

const API_BASE = 'https://api.telegram.org';

/** Bot API 业务失败(ok=false)。error_code 语义: 401 token 无效, 409 轮询冲突。 */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    description: string,
    /** 429 时 Telegram 建议的重试等待秒数。 */
    readonly retryAfterSec?: number,
  ) {
    super(`telegram ${method} failed: ${errorCode} ${description}`);
    this.name = 'TelegramApiError';
  }
}

export interface TelegramApiClient {
  /** JSON 方法调用; ok=false 时抛 TelegramApiError。 */
  call<T = unknown>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  /** multipart 上传(sendDocument / sendPhoto 的本地文件路径场景)。 */
  callForm<T = unknown>(method: string, form: FormData, signal?: AbortSignal): Promise<T>;
  /** getFile 返回的 file_path → 直链下载地址(含 token, 不入日志)。 */
  fileUrl(filePath: string): string;
}

export function createTelegramApiClient(token: string): TelegramApiClient {
  const base = `${API_BASE}/bot${token}`;

  async function parseResponse<T>(method: string, res: Response): Promise<T> {
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } }
      | null;
    if (body?.ok === true) return body.result as T;
    const errorCode = body?.error_code ?? res.status;
    const description = body?.description ?? `HTTP ${res.status}`;
    throw new TelegramApiError(method, errorCode, description, body?.parameters?.retry_after);
  }

  return {
    async call<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
      const res = await fetch(`${base}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params ?? {}),
        ...(signal ? { signal } : {}),
      });
      return parseResponse<T>(method, res);
    },
    async callForm<T>(method: string, form: FormData, signal?: AbortSignal): Promise<T> {
      const res = await fetch(`${base}/${method}`, {
        method: 'POST',
        body: form,
        ...(signal ? { signal } : {}),
      });
      return parseResponse<T>(method, res);
    },
    fileUrl(filePath: string): string {
      return `${API_BASE}/file/bot${token}/${filePath}`;
    },
  };
}

// ── Bot API 对象子集(只声明用到的字段) ─────────────────────────────────────

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessageEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  /** forum topic 消息所属话题 id(supergroup 开启 topics 时)。 */
  message_thread_id?: number;
  /** 相册分组 id — 一次多图/多文件会拆成多条消息, 同组共此 id。 */
  media_group_id?: string;
  /** 仅当消息真的属于某个 forum topic 时为 true — 普通回复也会带 thread_id。 */
  is_topic_message?: boolean;
  /**
   * 群开启「禁止保存内容」时 Telegram 给每条消息带上 true。
   *
   * 它是**隐私边界的唯一信号**, 拦的是「内容留存」而不是「响应」——
   *   - 带标的群消息不落进本地群历史池, bot 自己的出站回复也不回流进窗口;
   *   - 被**引用**的消息带标时, 它的正文与附件不进 prompt 的 reply_context;
   *   - 但 owner @ 机器人**仍照常起 turn** —— 触发消息是用户此刻说给 bot 的话,
   *     不是要被留存的群内容, 它的正文照常进 prompt。
   *
   * 与官方 bot 服务端「has_protected_content 的消息不中继」同一语义
   * (docs/telegram-hook-server.md「群消息中继」节)。字段缺失按未保护处理:
   * Telegram 只在保护开启时下发它。
   */
  has_protected_content?: boolean;
  reply_to_message?: TgMessage;
  text?: string;
  caption?: string;
  entities?: TgMessageEntity[];
  caption_entities?: TgMessageEntity[];
  photo?: TgPhotoSize[];
  document?: TgDocument;
  sticker?: { emoji?: string; set_name?: string };
  voice?: { duration?: number };
  audio?: { file_name?: string };
  video?: { file_name?: string };
  video_note?: { duration?: number };
  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;
  /**
   * 消息当前挂着的内联键盘。callback_query.message 会带上它 —— 于是收到一次
   * 失效回调时能就地看到同卡其它按钮的 token, 判断整张卡是不是真的都失效了。
   */
  reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgFile {
  file_id: string;
  file_size?: number;
  file_path?: string;
}
