/**
 * telegram/streamingText.ts — 流式文本 handle(sendMessage + editMessageText)。
 * ---------------------------------------------------------------------------
 * 与 discord/streamingText.ts 同一节流模型: 首条 send 建消息, 中间态按
 * 1.5s 尾随节流 editMessageText 覆盖, finalize 渲染终稿(超长部分追发新消息,
 * 受管图片经 uploadImages 旁路补发)。
 *
 * Telegram 特有约束:
 *   - editMessageText 打同一条消息, 编辑频率过高会 429 — 节流间隔取 1.5s
 *     (对齐 turnRunner 的 CARD_PATCH_THROTTLE_MS, 双层节流冗余但无害);
 *   - "message is not modified" 错误静默吞掉(内容未变的重复编辑);
 *   - 中间态超过单条上限后停止编辑(终稿由 finalize 分段补发), 与 Discord
 *     的 INTERMEDIATE_EDIT_LIMIT 行为一致。
 */

import type { StreamingTextHandle } from '../types.js';

export const TELEGRAM_UPDATE_THROTTLE_MS = 1500;
/** draft 更新节流 — draft 不产生消息、不推通知, 可以比 edit 更勤。 */
export const TELEGRAM_DRAFT_THROTTLE_MS = 900;
/** 中间态渲染后 HTML 超过该长度就不再编辑(接近 4096 上限时停手)。 */
const INTERMEDIATE_EDIT_LIMIT = 3800;
/** draft 中间态文本上限(4096 硬顶留余量); 超出截断尾部展示。 */
const DRAFT_PREVIEW_LIMIT = 3800;
/**
 * draft 是 30 秒临时预览(Bot API 语义) — 长工具静默期没有新文本时按此间隔
 * 重推同一 draft_id 保活, 否则 "Thinking…" 会在用户眼前凭空消失。
 */
const DRAFT_KEEPALIVE_MS = 20_000;
const IMAGE_ONLY_PLACEHOLDER = '🖼️';
/**
 * 自主判断沉默哨兵(全响应群的 ambient turn): 模型整条回复只有它时,
 * 本次 turn 静默 — 经典路径删掉流式占位消息, draft 路径什么都不发。
 */
export const NO_REPLY_SENTINEL = 'NO_REPLY';

function isNoReply(text: string): boolean {
  return text.trim() === NO_REPLY_SENTINEL;
}

export interface TelegramStreamingDeps {
  /** 发送一条 markdown 渲染消息, 返回编码 messageId。 */
  send: (markdown: string) => Promise<string>;
  /** 用 markdown 渲染结果覆盖既有消息。 */
  edit: (messageId: string, markdown: string) => Promise<void>;
  /** 终稿里的受管图片旁路上传(sendPhoto)。 */
  uploadImages: (messageId: string, imageUrls: string[]) => Promise<void>;
  /** markdown 分段(fence 感知)。 */
  chunk: (text: string) => string[];
  /** 提取 markdown 里的受管图片 URL(渲染由 send/edit 内部完成)。 */
  extractImageUrls: (markdown: string) => string[];
  /**
   * DM 原生流式草稿(sendMessageDraft, 仅私聊可用)。提供即启用 draft 模式:
   * 中间态推 draft(空文本 = 客户端原生 "Thinking…" 占位动画), 定稿才发真消息。
   * 任何一次 draft 调用失败都永久 latch 回 send+edit 经典路径(本 handle 内)。
   */
  sendDraft?: (plainText: string) => Promise<void>;
  /**
   * Rich 定稿(sendRichMessage): 整段 markdown 一条到底(32768 上限), 表格/
   * 标题/LaTeX 原生渲染。返回 null = 本条不可用(方法缺失/内容解析不过/
   * 网络失败), 调用方回落 chunk+send 经典定稿。仅 draft 模式消费。
   */
  sendFinal?: (markdown: string) => Promise<string | null>;
  /**
   * 经典路径的 rich 原地定稿(editMessageText + rich_message): 把流式占位
   * 消息一步升级成 rich 渲染(群与降级档 DM 共用)。返回 false = 本条不可用,
   * 调用方回落 HTML edit 分段定稿。
   */
  editFinal?: (messageId: string, markdown: string) => Promise<boolean>;
  /** NO_REPLY 静默时删除流式占位消息(经典路径)。 */
  deleteMessage?: (messageId: string) => Promise<void>;
}

export function startTelegramStreaming(
  deps: TelegramStreamingDeps,
  initial?: string,
): Promise<StreamingTextHandle> {
  if (deps.sendDraft) {
    return Promise.resolve(new TelegramDraftStreamingHandle(deps, initial));
  }
  return TelegramStreamingTextHandle.create(deps, initial);
}

class TelegramStreamingTextHandle implements StreamingTextHandle {
  private buffer = '';
  private flushed = '';
  private pending: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private done = false;
  private extraImageAbsPaths: string[] = [];
  /**
   * 惰性占位(2026-07-30 review): 有真实正文才发首条消息 — ambient turn 的
   * NO_REPLY 沉默从"发 '…' 再删"变成从头到尾零消息零通知; 普通 turn 也不再
   * 闪一条 '…'(typing 循环已承担"在干活"的反馈)。
   */
  private messageIdValue = '';

  private constructor(private readonly deps: TelegramStreamingDeps) {}

  get messageId(): string {
    return this.messageIdValue;
  }

  static async create(
    deps: TelegramStreamingDeps,
    initial?: string,
  ): Promise<TelegramStreamingTextHandle> {
    const handle = new TelegramStreamingTextHandle(deps);
    // 调用方给了真实初始正文才立即建消息(保持旧契约); '…' 一律惰性。
    if (initial !== undefined && initial.trim() !== '' && initial !== '…') {
      handle.messageIdValue = await deps.send(initial);
      handle.flushed = initial;
      handle.buffer = initial;
    }
    return handle;
  }

  append(delta: string): void {
    if (this.done) return;
    this.buffer += delta;
    this.scheduleFlush();
  }

  replace(fullText: string): void {
    if (this.done) return;
    this.buffer = fullText;
    this.scheduleFlush();
  }

  addExtraImageAbsPath(absPath: string): void {
    if (this.done || !absPath || this.extraImageAbsPaths.includes(absPath)) return;
    this.extraImageAbsPaths.push(absPath);
  }

  close(): void {
    this.done = true;
    this.clearPending();
  }

  async finalize(finalText: string): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.clearPending();
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* swallow */
      }
    }

    if (isNoReply(finalText)) {
      // 自主判断选择沉默: 惰性占位下通常从未发过消息(真零痕迹);
      // 若中间态已建消息(哨兵前有过正文流出)则撤掉。
      if (this.messageIdValue) {
        try {
          await this.deps.deleteMessage?.(this.messageIdValue);
        } catch {
          /* 删除失败(权限等)保留占位, 不抛错 */
        }
      }
      return;
    }
    const imageUrls = this.deps.extractImageUrls(finalText);
    const chunks = this.deps.chunk(finalText);
    const firstChunk = chunks[0] ?? '';
    // 惰性占位: 至此必有真实内容 — 没建过消息就用首段正文建。
    if (!this.messageIdValue) {
      const seed =
        firstChunk.trim().length > 0
          ? firstChunk
          : imageUrls.length > 0 || this.extraImageAbsPaths.length > 0
            ? IMAGE_ONLY_PLACEHOLDER
            : '';
      if (seed === '') return; // 空终稿且无图: 无事可做
      this.messageIdValue = await this.deps.send(seed);
      this.flushed = seed;
    }
    // 无受管图片时优先 rich 原地定稿(表格/标题/LaTeX 原生渲染, 32768 上限
    // 免分段); 失败回落 HTML edit 分段。
    if (
      this.deps.editFinal &&
      imageUrls.length === 0 &&
      this.extraImageAbsPaths.length === 0 &&
      finalText.trim().length > 0
    ) {
      const upgraded = await this.deps.editFinal(this.messageIdValue, finalText);
      if (upgraded) return;
    }
    if (firstChunk.trim().length > 0 && this.flushed !== firstChunk) {
      await this.deps.edit(this.messageIdValue, firstChunk);
    } else if (
      firstChunk.trim().length === 0 &&
      (imageUrls.length > 0 || this.extraImageAbsPaths.length > 0) &&
      this.flushed !== IMAGE_ONLY_PLACEHOLDER
    ) {
      await this.deps.edit(this.messageIdValue, IMAGE_ONLY_PLACEHOLDER);
    }
    for (const chunk of chunks.slice(1)) {
      await this.deps.send(chunk);
    }
    // extraImageAbsPaths(tool_result 账本图)与正文图都交 uploadImages 收口;
    // 去重职责在 index.ts 的 uploadImages 实现里(absPath / url 双口径)。
    await this.deps.uploadImages(this.messageIdValue, [
      ...imageUrls,
      ...this.extraImageAbsPaths.map((absPath) => `abs:${absPath}`),
    ]);
  }

  private scheduleFlush(): void {
    if (this.pending || this.done) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.flushIntermediate();
    }, TELEGRAM_UPDATE_THROTTLE_MS);
  }

  private async flushIntermediate(): Promise<void> {
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* swallow */
      }
    }
    if (this.done || this.buffer === this.flushed) return;
    if (this.buffer.length > INTERMEDIATE_EDIT_LIMIT) return;
    // 哨兵(或其前缀, 流式可能分片送达)不落地 — 惰性占位下连消息都不建。
    const trimmed = this.buffer.trim();
    if (trimmed === '' || NO_REPLY_SENTINEL.startsWith(trimmed)) return;

    const next = this.buffer;
    this.inFlight = (async () => {
      try {
        if (!this.messageIdValue) {
          this.messageIdValue = await this.deps.send(next);
        } else {
          await this.deps.edit(this.messageIdValue, next);
        }
        this.flushed = next;
      } catch {
        /* 下一次节流窗口重试 */
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
  }

  private clearPending(): void {
    if (!this.pending) return;
    clearTimeout(this.pending);
    this.pending = null;
  }
}

/**
 * DM 原生草稿流式 handle(Bot API sendMessageDraft)。
 *
 * 与经典 handle 的差异:
 *   - 中间态不产生真实消息 —— 推 draft(同 draft_id 连续更新, 客户端原生动画;
 *     空文本 = "Thinking…" 占位), 30s 预览窗口靠 keepalive 重推兜住;
 *   - finalize 直接发正式消息(分段全走 send), 客户端用真消息替换掉 draft;
 *   - draft 调用失败 → 永久 latch 到经典 send+edit handle, 后续调用全部转发,
 *     旧客户端/异常场景体验 = 现状, 不劣化;
 *   - messageId 是合成占位(编排层只用 replace/finalize/close, 不读它;
 *     finalize 后图片上传用第一条真实消息的 id)。
 */
class TelegramDraftStreamingHandle implements StreamingTextHandle {
  readonly messageId: string;

  private buffer: string;
  private flushed = '';
  private pending: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private done = false;
  private extraImageAbsPaths: string[] = [];
  private fallback: Promise<TelegramStreamingTextHandle> | null = null;

  constructor(
    private readonly deps: TelegramStreamingDeps,
    initial?: string,
  ) {
    this.messageId = `draft:${Date.now().toString(36)}`;
    // 立即推空 draft → 原生 Thinking 占位; 初始文案(如有)随首个节流窗刷出。
    this.buffer = initial && initial !== '…' ? initial : '';
    void this.pushDraft(this.buffer);
    if (this.buffer) this.scheduleFlush();
  }

  append(delta: string): void {
    if (this.done) return;
    if (this.fallback) {
      void this.fallback.then((h) => h.append(delta), () => {});
      return;
    }
    this.buffer += delta;
    this.scheduleFlush();
  }

  replace(fullText: string): void {
    if (this.done) return;
    if (this.fallback) {
      void this.fallback.then((h) => h.replace(fullText), () => {});
      return;
    }
    this.buffer = fullText;
    this.scheduleFlush();
  }

  addExtraImageAbsPath(absPath: string): void {
    if (this.done || !absPath || this.extraImageAbsPaths.includes(absPath)) return;
    if (this.fallback) {
      void this.fallback.then((h) => h.addExtraImageAbsPath(absPath), () => {});
      return;
    }
    this.extraImageAbsPaths.push(absPath);
  }

  close(): void {
    this.done = true;
    this.clearTimers();
    if (this.fallback) void this.fallback.then((h) => h.close(), () => {});
    // 无 fallback 时不做事: draft 是临时预览, ≤30s 自然消失。
  }

  async finalize(finalText: string): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.clearTimers();
    if (this.fallback) {
      const h = await this.fallback;
      for (const absPath of this.extraImageAbsPaths) h.addExtraImageAbsPath(absPath);
      await h.finalize(finalText);
      return;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* swallow */
      }
    }

    if (isNoReply(finalText)) return; // 沉默: draft 30s 内自然蒸发, 不发正式消息
    const imageUrls = this.deps.extractImageUrls(finalText);
    // 无受管图片时优先 rich 定稿(一条到底); 带图回落经典分段 + sendPhoto 旁路,
    // 避免 rich markdown 里的受管 URL 变成死链。
    if (this.deps.sendFinal && imageUrls.length === 0 && this.extraImageAbsPaths.length === 0) {
      const richId = await this.deps.sendFinal(finalText);
      if (richId) return;
    }
    const chunks = this.deps.chunk(finalText);
    let anchorMessageId: string | null = null;
    for (const chunk of chunks) {
      if (chunk.trim().length === 0) continue;
      const id = await this.deps.send(chunk);
      if (!anchorMessageId) anchorMessageId = id;
    }
    if (!anchorMessageId && (imageUrls.length > 0 || this.extraImageAbsPaths.length > 0)) {
      anchorMessageId = await this.deps.send(IMAGE_ONLY_PLACEHOLDER);
    }
    if (anchorMessageId) {
      await this.deps.uploadImages(anchorMessageId, [
        ...imageUrls,
        ...this.extraImageAbsPaths.map((absPath) => `abs:${absPath}`),
      ]);
    }
  }

  private scheduleFlush(): void {
    if (this.pending || this.done || this.fallback) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.flushDraft();
    }, TELEGRAM_DRAFT_THROTTLE_MS);
  }

  private async flushDraft(): Promise<void> {
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* swallow */
      }
    }
    if (this.done || this.fallback || this.buffer === this.flushed) return;
    if (isNoReply(this.buffer)) return;
    await this.pushDraft(this.buffer);
  }

  private pushDraft(text: string): Promise<void> {
    const preview =
      text.length > DRAFT_PREVIEW_LIMIT ? `${text.slice(0, DRAFT_PREVIEW_LIMIT)}…` : text;
    this.inFlight = (async () => {
      try {
        await this.deps.sendDraft!(preview);
        this.flushed = text;
        this.armKeepalive();
      } catch {
        this.latchToFallback();
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** 静默期保活: 距上次成功推送 20s 无新内容时重推同一 draft, 防 30s 过期消失。 */
  private armKeepalive(): void {
    if (this.keepalive) clearTimeout(this.keepalive);
    this.keepalive = setTimeout(() => {
      this.keepalive = null;
      if (this.done || this.fallback) return;
      void this.pushDraft(this.flushed);
    }, DRAFT_KEEPALIVE_MS);
  }

  /** draft 通道坏了(限流/客户端不支持等) → 本 handle 永久转发到经典路径。 */
  private latchToFallback(): void {
    if (this.fallback || this.done) return;
    this.clearTimers();
    const pendingText = this.buffer;
    this.fallback = TelegramStreamingTextHandle.create(
      this.deps,
      pendingText.trim().length > 0 ? pendingText : undefined,
    );
    this.fallback.catch(() => {
      /* create 失败时后续转发调用各自兜底; finalize 会把错误抛给编排层重试 */
    });
  }

  private clearTimers(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    if (this.keepalive) {
      clearTimeout(this.keepalive);
      this.keepalive = null;
    }
  }
}
