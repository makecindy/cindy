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
 *   - **终稿永远新发**: 过程消息是可替换的载体, 不能承担最终答案。终稿先尝试
 *     新发 Rich Message, 不可用时回落新发 HTML/Markdown；答案落地后才尽力清理
 *     过程载体。
 */

import type { StreamingTextHandle } from '../types.js';
import {
  createTelegramMessageLifecycle,
  type TelegramFinalIntent,
  type TelegramMessageLifecycle,
} from './messageLifecycle.js';

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

/**
 * 这次出站是**确定没送达**, 还是回执未知?
 *
 * Telegram 以 4xx 应答时报文已经完整往返: 它明确拒绝了这一段, 聊天里不可能
 * 出现它。此时把该段留给重试是安全的, 跳过反而造成答案缺段。
 *
 * 其余情况(网络中断、超时、5xx、以及 429 退避耗尽——退避里最后那次请求可能
 * 已经抵达 Telegram)都无法证明未送达, 一律按"可能已送达"处理: 重试跳过它,
 * 宁可缺一段, 也不让用户看到重复的整篇正文。
 *
 * 用结构判定而非 `instanceof`: 本模块是不做 I/O 的纯生命周期层, 不应反向依赖
 * api.ts 的具体错误类; deps 的实现方(index.ts)抛的正是带 errorCode 的那一种。
 */
function isDefiniteRejection(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { errorCode?: unknown }).errorCode;
  if (typeof code !== 'number') return false;
  // 429 不算确定拒绝: callSend 的退避重试里, 最后一次请求可能已经被 Telegram
  // 受理而回执丢失, 无法证明这一段没出现在聊天里。
  if (code === 429) return false;
  return code >= 400 && code < 500;
}

export interface TelegramStreamingDeps {
  /** 发送一条 markdown 渲染消息, 返回编码 messageId。 */
  send: (markdown: string) => Promise<string>;
  /**
   * HTML/Markdown 终稿的补送专用发送。与 send 有两点不同, 都由实现方
   * (index.ts)负责：
   *   1. 沿用**本轮原始的回挂目标** —— 补送替换的是那条已经消耗掉目标的过程消息,
   *      重新领取只会拿到空目标, 群里的答案就此脱离提问脉络;
   *   2. 先核验**本轮身份仍然有效**(配置世代/api 客户端/主人未变、未被取消)。补送是
   *      一次全新的出站, 会按"当前"状态取连接 —— 换主人之后旧回合的答案绝不能照发。
   * 身份失效时本函数应当抛错，终稿与后续分段、图片一并不发。未提供时回落 send。
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
   * 新发 Rich Message 终稿。`reuseReplyTarget` 表示过程载体已经消耗本轮回挂
   * 目标，Rich 终稿必须沿用冻结目标；返回 null 表示本条 Rich 不可用，调用方
   * 回落 HTML/Markdown 新发。网络/权限失败必须抛出，不能伪装成可安全降级。
   */
  sendFinal?: (markdown: string, reuseReplyTarget: boolean) => Promise<string | null>;
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
  /** terminal I/O is serialized so duplicate done events cannot mint two finals. */
  private finalizing: Promise<void> | null = null;
  /**
   * 本轮终稿已经落地的分段数。跨 finalize 重试保留 —— 已经出现在聊天里的段落
   * 不再重发, 重试只补未送达的部分(设计稿 §5.1 的 FINAL_PARTIAL)。
   */
  private deliveredChunks = 0;
  /** 受管图片是否已收口; 与分段同理, 成功过就不重传。 */
  private imagesDelivered = false;
  /**
   * 本轮**过程载体**的 messageId, 在首次 finalize 进入终稿路径时冻结。
   *
   * 不能在每次尝试里从 `messageIdValue` 重算: 首段一旦新发成功, 那个字段就指向
   * 终稿了。首段成功、尾段失败后重试时再读它, 清理会把**终稿**删掉而留下过程
   * 载体 —— 用户看到的就是答案消失、只剩一条停在过程态的消息。
   *
   * `null` = 尚未冻结; `''` = 已冻结且本轮从未建过过程载体(惰性占位)。
   */
  private carrierMessageId: string | null = null;
  private readonly lifecycle: TelegramMessageLifecycle;
  private extraImageAbsPaths: string[] = [];
  /**
   * 惰性占位(2026-07-30 review): 有真实正文才发首条消息 — ambient turn 的
   * NO_REPLY 沉默从"发 '…' 再删"变成从头到尾零消息零通知; 普通 turn 也不再
   * 闪一条 '…'(typing 循环已承担"在干活"的反馈)。
   */
  private messageIdValue = '';

  private constructor(
    private readonly deps: TelegramStreamingDeps,
    lifecycle: TelegramMessageLifecycle,
  ) {
    this.lifecycle = lifecycle;
  }

  get messageId(): string {
    return this.messageIdValue;
  }

  static async create(
    deps: TelegramStreamingDeps,
    initial?: string,
  ): Promise<TelegramStreamingTextHandle> {
    const handle = new TelegramStreamingTextHandle(deps, createTelegramMessageLifecycle());
    // 调用方给了真实初始正文才立即建消息(保持旧契约); '…' 一律惰性。
    if (initial !== undefined && initial.trim() !== '' && initial !== '…') {
      handle.lifecycle.acceptProgress();
      handle.messageIdValue = await deps.send(initial);
      handle.flushed = initial;
      handle.buffer = initial;
    }
    return handle;
  }

  append(delta: string): void {
    if (this.done || !this.lifecycle.acceptProgress()) return;
    this.buffer += delta;
    this.scheduleFlush();
  }

  replace(fullText: string): void {
    if (this.done || !this.lifecycle.acceptProgress()) return;
    this.buffer = fullText;
    this.scheduleFlush();
  }

  addExtraImageAbsPath(absPath: string): void {
    if (this.done || !absPath || this.extraImageAbsPaths.includes(absPath)) return;
    this.extraImageAbsPaths.push(absPath);
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    this.lifecycle.cancel();
    this.clearPending();
  }

  async finalize(finalText: string): Promise<void> {
    if (this.finalizing) return this.finalizing;
    if (this.lifecycle.phase === 'final-sent' || this.lifecycle.phase === 'complete') return;
    const intent = this.lifecycle.beginFinal();
    if (!intent) return;
    this.done = true;
    this.clearPending();
    this.finalizing = this.finalizeOnce(finalText, intent).finally(() => {
      this.finalizing = null;
    });
    return this.finalizing;
  }

  /** One terminal attempt. Retries reuse the lifecycle delivery key. */
  private async finalizeOnce(finalText: string, intent: TelegramFinalIntent): Promise<void> {
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* an intermediate edit is decorative; the final send remains authoritative */
      }
    }

    // 过程载体只在**首次**进入终稿路径时冻结; 之后 messageIdValue 会被终稿覆盖,
    // 重试再读它就会把终稿当成待清理的旧消息(见 carrierMessageId 的说明)。
    this.carrierMessageId ??= this.messageIdValue;
    const staleMessageId = this.carrierMessageId;
    if (isNoReply(finalText)) {
      // 惰性占位下通常从未发过消息(真零痕迹); 已建过程消息则尽力清掉。
      this.lifecycle.cancel();
      if (staleMessageId) {
        try {
          await this.deps.deleteMessage?.(staleMessageId);
        } catch {
          /* 删除失败(权限等)保留占位, 不抛错 */
        }
      }
      return;
    }

    const imageUrls = this.deps.extractImageUrls(finalText);
    const chunks = this.deps.chunk(finalText);
    const firstChunk = chunks[0] ?? '';
    const seed =
      firstChunk.trim().length > 0
        ? firstChunk
        : imageUrls.length > 0 || this.extraImageAbsPaths.length > 0
          ? IMAGE_ONLY_PLACEHOLDER
          : '';
    if (seed === '') {
      this.lifecycle.cancel();
      return;
    }

    try {
      // 分段投递进度跨重试保留: 已经出现在聊天里的段落绝不重发。一次 finalize
      // 里首段成功、尾段失败时, 上游重试必须从 deliveredChunks 之后继续 ——
      // 否则用户会看到重复的首段(长答案里就是重复整篇正文)。
      if (this.deliveredChunks === 0) {
        // Rich 是终稿的新消息，不是对过程载体的原位升级。它可保留表格、公式等
        // 结构化排版；仅当没有需要旁路上传的受管图片时尝试，失败为「本条不支持」
        // 才安全降级到 HTML/Markdown。
        const richMessageId =
          imageUrls.length === 0 && this.extraImageAbsPaths.length === 0 && this.deps.sendFinal
            ? await this.deps.sendFinal(finalText, staleMessageId !== '')
            : null;
        if (richMessageId) {
          this.messageIdValue = richMessageId;
          this.flushed = finalText;
          // Rich 一条消息就承载了完整正文, 没有后续分段。
          this.deliveredChunks = chunks.length;
        } else {
          // Hermes-style close: always mint a fresh final message. If a process
          // carrier already exists, repost keeps its frozen reply target; if the
          // turn was lazy and has no carrier, send consumes the normal target lease.
          this.messageIdValue = staleMessageId
            ? await (this.deps.repost ?? this.deps.send)(seed)
            : await this.deps.send(seed);
          this.flushed = seed;
          this.deliveredChunks = 1;
        }
      }
      // 逐段推进计数: 中途抛错时前面几段的进度已经记下, 重试从这里接着走。
      //
      // 计数在 send **发起前**推进 —— 抛错的 send 通常无法区分「Telegram 没收到」
      // 和「收到了但回执丢在路上」。默认按"可能已送达"记账: 最坏是这一段没出现
      // (上游仍持有完整正文可再收口); 反过来默认未送达则会在重试时把用户已经看见
      // 的一段再发一遍, 长答案里就是整篇重复。
      //
      // 例外是 Telegram **明确拒绝**(4xx, 429 除外): 报文完整往返、它拒绝了这一段,
      // 聊天里不可能出现它。这时必须把计数退回去, 否则重试会跳过一段确定未送达的
      // 正文, 随后照样 markFinalSent 并清掉过程载体 —— 答案就此缺段。
      while (this.deliveredChunks < chunks.length) {
        const chunk = chunks[this.deliveredChunks]!;
        this.deliveredChunks += 1;
        try {
          await this.deps.send(chunk);
        } catch (err) {
          if (isDefiniteRejection(err)) this.deliveredChunks -= 1;
          throw err;
        }
      }
      // extraImageAbsPaths(tool_result 账本图)与正文图都交 uploadImages 收口;
      // 去重职责在 index.ts 的 uploadImages 实现里(absPath / url 双口径)。
      if (!this.imagesDelivered) {
        await this.deps.uploadImages(this.messageIdValue, [
          ...imageUrls,
          ...this.extraImageAbsPaths.map((absPath) => `abs:${absPath}`),
        ]);
        this.imagesDelivered = true;
      }
      this.lifecycle.markFinalSent(intent);
    } catch (err) {
      // The process carrier remains visible and no cleanup runs. A later
      // explicit finalize may retry the same delivery key, resuming from
      // deliveredChunks so already-visible content is never duplicated.
      this.lifecycle.markFinalFailed(intent);
      throw err;
    }

    if (!staleMessageId) return;
    // Answer is already accepted; cleanup is best-effort and cannot make the
    // final delivery fail. If delete fails, both messages may remain.
    if (!this.lifecycle.beginCleanup()) return;
    try {
      await this.deps.deleteMessage?.(staleMessageId);
    } catch {
      /* keep the old process message; the fresh answer is authoritative */
    } finally {
      this.lifecycle.finishCleanup();
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
    if (this.done || !this.lifecycle.progressOpen || this.buffer === this.flushed) return;
    if (this.buffer.length > INTERMEDIATE_EDIT_LIMIT) return;
    // 哨兵(或其前缀, 流式可能分片送达)不落地 — 惰性占位下连消息都不建。
    const trimmed = this.buffer.trim();
    if (trimmed === '' || NO_REPLY_SENTINEL.startsWith(trimmed)) return;

    const next = this.buffer;
    this.inFlight = (async () => {
      try {
        if (!this.lifecycle.progressOpen || this.done) return;
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
