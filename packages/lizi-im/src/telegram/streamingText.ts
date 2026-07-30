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
  readonly messageId: string;

  private buffer = '';
  private flushed = '';
  private pending: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private done = false;
  private extraImageAbsPaths: string[] = [];

  private constructor(
    messageId: string,
    private readonly deps: TelegramStreamingDeps,
  ) {
    this.messageId = messageId;
  }

  static async create(
    deps: TelegramStreamingDeps,
    initial?: string,
  ): Promise<TelegramStreamingTextHandle> {
    const messageId = await deps.send(initial ?? '…');
    return new TelegramStreamingTextHandle(messageId, deps);
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

    const imageUrls = this.deps.extractImageUrls(finalText);
    const chunks = this.deps.chunk(finalText);
    const firstChunk = chunks[0] ?? '';
    if (firstChunk.trim().length > 0) {
      await this.deps.edit(this.messageId, firstChunk);
    } else if (imageUrls.length > 0 || this.extraImageAbsPaths.length > 0) {
      await this.deps.edit(this.messageId, IMAGE_ONLY_PLACEHOLDER);
    }
    for (const chunk of chunks.slice(1)) {
      await this.deps.send(chunk);
    }
    // extraImageAbsPaths(tool_result 账本图)与正文图都交 uploadImages 收口;
    // 去重职责在 index.ts 的 uploadImages 实现里(absPath / url 双口径)。
    await this.deps.uploadImages(this.messageId, [
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

    const next = this.buffer;
    this.inFlight = (async () => {
      try {
        await this.deps.edit(this.messageId, next);
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
