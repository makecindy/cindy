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
/** 中间态渲染后 HTML 超过该长度就不再编辑(接近 4096 上限时停手)。 */
const INTERMEDIATE_EDIT_LIMIT = 3800;
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
}

export function startTelegramStreaming(
  deps: TelegramStreamingDeps,
  initial?: string,
): Promise<StreamingTextHandle> {
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
