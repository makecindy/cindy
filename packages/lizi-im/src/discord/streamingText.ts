import type { StreamingTextHandle } from '../types.js';
import type { chunkDiscordText } from './chunk.js';
import type { markdownToDiscord } from './markdown.js';

export const UPDATE_THROTTLE_MS = 1300;
const INTERMEDIATE_EDIT_LIMIT = 1900;
const IMAGE_ONLY_PLACEHOLDER = '🖼️';

export interface DiscordImageUploadResult {
  deliveredAbsPaths: string[];
  nonRetryableAbsPaths?: string[];
  error?: unknown;
}

export function startStreaming(
  deps: {
    send: (text: string) => Promise<string>;
    edit: (messageId: string, text: string) => Promise<void>;
    markdownToDiscord: typeof markdownToDiscord;
    chunk: typeof chunkDiscordText;
    resolveImageUrl?: (url: string) => string;
    uploadImages: (messageId: string, absPaths: string[]) => Promise<DiscordImageUploadResult>;
  },
  initial?: string,
): Promise<StreamingTextHandle> {
  return DiscordStreamingTextHandle.create(deps, initial);
}

class DiscordStreamingTextHandle implements StreamingTextHandle {
  readonly messageId: string;

  private buffer = '';
  private flushed = '';
  private pending: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private done = false;
  private extraImageAbsPaths: string[] = [];
  private deliveredExtraImageAbsPaths: string[] = [];
  private nonRetryableExtraImageAbsPaths: string[] = [];

  private constructor(
    messageId: string,
    private readonly deps: Parameters<typeof startStreaming>[0],
  ) {
    this.messageId = messageId;
  }

  static async create(
    deps: Parameters<typeof startStreaming>[0],
    initial?: string,
  ): Promise<DiscordStreamingTextHandle> {
    const messageId = await deps.send(initial ?? '…');
    return new DiscordStreamingTextHandle(messageId, deps);
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

  getDeliveredExtraImageAbsPaths(): readonly string[] {
    return [...this.deliveredExtraImageAbsPaths];
  }

  getNonRetryableExtraImageAbsPaths(): readonly string[] {
    return [...this.nonRetryableExtraImageAbsPaths];
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

    // 正文图与 tool_result 账本图按 absPath 去重——同一张图两个来源都到场时
    // (ghost 读文档 xdt_media_inline 内联场景)只上传一份。
    const imageAbsPaths = [...this.extraImageAbsPaths];
    const seenAbsPaths = new Set(imageAbsPaths);
    const { text, imageUrls } = this.deps.markdownToDiscord(finalText);
    for (const url of imageUrls) {
      if (!this.deps.resolveImageUrl) continue;
      try {
        const absPath = this.deps.resolveImageUrl(url);
        if (seenAbsPaths.has(absPath)) continue;
        seenAbsPaths.add(absPath);
        imageAbsPaths.push(absPath);
      } catch {
        /* best-effort */
      }
    }

    const chunks = this.deps.chunk(text);
    const firstChunk = chunks[0] ?? '';
    if (firstChunk.trim().length > 0) {
      await this.deps.edit(this.messageId, firstChunk);
    } else if (imageAbsPaths.length > 0) {
      await this.deps.edit(this.messageId, IMAGE_ONLY_PLACEHOLDER);
    }
    for (const chunk of chunks.slice(1)) {
      await this.deps.send(chunk);
    }

    if (imageAbsPaths.length > 0) {
      const uploadResult = await this.deps.uploadImages(this.messageId, imageAbsPaths);
      const delivered = new Set(uploadResult.deliveredAbsPaths);
      this.deliveredExtraImageAbsPaths = this.extraImageAbsPaths.filter((absPath) =>
        delivered.has(absPath),
      );
      const nonRetryable = new Set(uploadResult.nonRetryableAbsPaths ?? []);
      this.nonRetryableExtraImageAbsPaths = this.extraImageAbsPaths.filter((absPath) =>
        nonRetryable.has(absPath),
      );
      if (uploadResult.error !== undefined) throw uploadResult.error;
    }
  }

  private scheduleFlush(): void {
    if (this.pending || this.done) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.flushIntermediate();
    }, UPDATE_THROTTLE_MS);
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
        /* retry on the next scheduled flush */
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
