/**
 * telegram/streamingText.ts — 流式文本 handle(sendMessage + editMessageText)。
 *
 * DM 与群/topic 共用这一条路径 —— 呈现不按聊天类型分叉。私聊曾另走
 * sendMessageDraft 草稿通道(原生 Thinking 占位动画), 但草稿只能承载一行纯
 * 文本, 于是工具调用的过程时间线在私聊里整体看不到, 与群聊形成两套体验
 * (Chris 2026-08 点名)。现已统一回 send + edit。
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
 *     的 INTERMEDIATE_EDIT_LIMIT 行为一致;
 *   - **终稿的原位编辑必须有兜底**: 长轮次会对同一条消息累计上百次编辑, 撞
 *     flood 时最后那次(携带答案)最容易失败。finalize 因此在编辑失败后把答案
 *     新发一条消息承载, 见 finalizeInPlaceOrRepost。
 */

import type { StreamingTextHandle } from '../types.js';

export const TELEGRAM_UPDATE_THROTTLE_MS = 1500;
/** 中间态渲染后 HTML 超过该长度就不再编辑(接近 4096 上限时停手)。 */
const INTERMEDIATE_EDIT_LIMIT = 3800;
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
  /**
   * 终稿补送专用的发送(见 finalizeInPlaceOrRepost)。与 send 有两点不同, 都由实现方
   * (index.ts)负责, 本模块只负责在编辑失败时调用它:
   *   1. 沿用**本轮原始的回挂目标** —— 补送替换的是那条已经消耗掉目标的过程消息,
   *      重新领取只会拿到空目标, 群里的答案就此脱离提问脉络;
   *   2. 先核验**本轮身份仍然有效**(配置世代/api 客户端/主人未变、未被取消)。补送是
   *      一次全新的出站, 会按"当前"状态取连接 —— 换主人之后旧回合的答案绝不能照发。
   * 身份失效时本函数应当抛错: finalize 会据此抛回原始编辑错误并放弃整个收口, 后续
   * 分段与图片一并不发。未提供时回落 send。
   */
  repost?: (markdown: string) => Promise<string>;
  /** 用 markdown 渲染结果覆盖既有消息。 */
  edit: (messageId: string, markdown: string) => Promise<void>;
  /** 终稿里的受管图片旁路上传(sendPhoto)。 */
  uploadImages: (messageId: string, imageUrls: string[]) => Promise<void>;
  /** markdown 分段(fence 感知)。 */
  chunk: (text: string) => string[];
  /** 提取 markdown 里的受管图片 URL(渲染由 send/edit 内部完成)。 */
  extractImageUrls: (markdown: string) => string[];
  /**
   * rich 原地定稿(editMessageText + rich_message): 把流式占位消息一步升级成
   * rich 渲染(DM 与群共用)。返回 false = 本条不可用, 调用方回落 HTML edit
   * 分段定稿。
   */
  editFinal?: (messageId: string, markdown: string) => Promise<boolean>;
  /** NO_REPLY 静默时删除流式占位消息。 */
  deleteMessage?: (messageId: string) => Promise<void>;
}

export function startTelegramStreaming(
  deps: TelegramStreamingDeps,
  initial?: string,
): Promise<StreamingTextHandle> {
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
    // 原位定稿的目标文本(有正文用首段; 纯图轮次用占位符); null = 消息已是终态。
    const inPlaceText =
      firstChunk.trim().length > 0 && this.flushed !== firstChunk
        ? firstChunk
        : firstChunk.trim().length === 0 &&
            (imageUrls.length > 0 || this.extraImageAbsPaths.length > 0) &&
            this.flushed !== IMAGE_ONLY_PLACEHOLDER
          ? IMAGE_ONLY_PLACEHOLDER
          : null;
    if (inPlaceText !== null) {
      await this.finalizeInPlaceOrRepost(inPlaceText);
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

  /**
   * 原位定稿(editMessageText 覆盖流式那条消息); 编辑失败则把终稿**新发**一条
   * 消息承载, 落地后再撤掉停在过程态的旧消息。
   *
   * 为什么需要这条兜底: 过程区每 5s 重渲染一次(时长在变), 长轮次会对同一条
   * 消息累计上百次 editMessageText, 迟早撞 Telegram 的编辑 flood。而携带答案
   * 的这一次编辑排在整轮最后, 最容易被撞 —— 实测 2026-08-04 一个 11 分钟的
   * 群轮次就是这样丢掉了整条终稿(`429 retry after 26`), 上游只会记一条
   * non-fatal 警告, 聊天里只剩一条停在"⚙️ 工作中 · 10m44s"的僵尸消息。
   *
   * 顺序固定"先发新、后删旧", 不可对调:
   *   - 先删旧: 一旦新发也失败, 答案与过程记录一起消失, 比现状更糟;
   *   - 先删再发还会让客户端滚动跳位(与 openclaw 同一条纪律)。
   * 删除是 best-effort —— 删不掉只是多留一条过程消息, 答案已经到了。
   *
   * 补送走 deps.repost(而非 send): 它替换的是那条已经消耗掉本轮回挂目标的过程
   * 消息, 必须沿用同一个 reply 目标, 否则群里的答案会脱离提问脉络。
   *
   * repost 抛错(含"本轮身份已失效"——被取消/换主人/换代)一律按**放弃收口**处理:
   * 抛回原始编辑错误, 且因为本函数抛出, finalize 后面的分段补发与图片上传都不会
   * 执行 —— 它们同属这个已经作废的回合。生命周期取消不能被当成普通编辑失败。
   */
  private async finalizeInPlaceOrRepost(text: string): Promise<void> {
    const staleMessageId = this.messageIdValue;
    try {
      await this.deps.edit(staleMessageId, text);
      return;
    } catch (editErr) {
      // 新发失败就把原始编辑错误抛回上游(与改动前同语义), 不掩盖真实原因。
      const repost = this.deps.repost ?? this.deps.send;
      try {
        this.messageIdValue = await repost(text);
      } catch {
        throw editErr;
      }
      this.flushed = text;
    }
    try {
      await this.deps.deleteMessage?.(staleMessageId);
    } catch {
      /* 删不掉(权限/已删)就留着, 不影响已送达的答案 */
    }
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
