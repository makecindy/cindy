/**
 * feishu/streamingText.ts
 * ---------------------------------------------------------------------------
 * Throttled streaming-text card with `xdt-image://` / `xdt-file://` rewrite.
 *
 * Lifecycle:
 *   start(openId, initial)        → mints v2 markdown card, returns handle
 *   handle.append(delta)          → throttled v2 markdown patch (every 1.5s).
 *                                   xdt-image/file references are stripped to
 *                                   placeholder text in intermediate frames
 *                                   (feishu rejects raw xdt-* URLs in cards).
 *   handle.finalize(finalText)    → 1) parse xdt-image URLs, parallel-upload
 *                                      to feishu → image_keys
 *                                   2) parse xdt-file URLs (dedup), send each
 *                                      as a separate file message
 *                                   3) strip xdt-file from card text
 *                                   4) update the progress card with final
 *                                      text/images; the optional process
 *                                      record becomes a collapsed panel above
 *                                      the answer
 *                                   5) an answer that does not fit one card
 *                                      (30 KB / 4 tables) is split on content
 *                                      boundaries: the first part replaces the
 *                                      progress card, the rest follow as new
 *                                      cards in order — nothing is truncated
 *   handle.close()                → cancel pending throttle, no further patches
 *
 * Design parity: matches the legacy feishuBot/replyClient.ts behaviour
 * (xdt-image: `![alt](xdt-image://...)`, xdt-file:
 * `[name](xdt-file:///abs/path)`).
 */

import {
  sendCardRaw,
  patchCardRaw,
  uploadImage,
  sendFile,
  sendText,
  claimPatchableOpener,
  recallMessage,
  getAccountEpoch,
  rearmAnchorToTrigger,
} from './outbound.js';
import { buildMarkdownCardV2, buildReplyCardV2 } from './cards.js';
import {
  FEISHU_MARKDOWN_MAX_TABLES,
  countMarkdownTables,
  cutMarkdownPrefix,
  splitMarkdownForCards,
} from './cardSplit.js';
import { resolveFeishuMediaUrl } from './mediaCache.js';
import { bindScope, getHost, getLog, getScope } from './moduleScope.js';
import { messages as transportMessages } from './messages.js';
import type {
  StreamingFinalizeOptions,
  StreamingProcessRecord,
  StreamingTextHandle,
} from '../types.js';
// xdt-* 引用解析抽到渠道无关模块(slack streamingText 共用同一套语义)
import {
  stripXdtForStreaming,
  classifyXdtOnly,
  stripXdtFileLinks,
  collectXdtFileLinks,
  collectXdtImageUrls,
} from '../xdtRefs.js';

const PATCH_THROTTLE_MS = 1500;
/** Feishu caps serialized card request bodies at 30 KB. */
export const FEISHU_CARD_REQUEST_MAX_BYTES = 30 * 1024;

function cardRequestBytes(card: unknown): number {
  return Buffer.byteLength(JSON.stringify({ content: JSON.stringify(card) }), 'utf8');
}

/**
 * 单张卡片最多挂多少张正文之外的图片。飞书一张卡片最多 200 个元素, 每张图片
 * 连同替代文本占两个, 留足余量。
 */
const EXTRA_IMAGES_PER_CARD = 50;

/** 飞书两条硬上限都满足才算装得下: 请求体字节数、富文本里的表格个数。 */
function fitsOneCard(card: unknown, markdown: string): boolean {
  return (
    cardRequestBytes(card) <= FEISHU_CARD_REQUEST_MAX_BYTES &&
    countMarkdownTables(markdown) <= FEISHU_MARKDOWN_MAX_TABLES
  );
}

/**
 * 写作中的中间帧只有一张卡片可用: 装不下时展示装得下的开头(切在内容边界上,
 * 代码块与表格保持完整), 并说明写完后会分条完整发送。
 */
function fitIntermediateCard(text: string): unknown {
  const full = buildMarkdownCardV2(text);
  if (fitsOneCard(full, text)) return full;
  const suffix = transportMessages.streaming.replyContinues;
  const cut = cutMarkdownPrefix(text, (chunk) =>
    fitsOneCard(buildMarkdownCardV2(`${chunk}${suffix}`), chunk),
  );
  return buildMarkdownCardV2(cut ? `${cut.chunk}${suffix}` : suffix.trim());
}

/** 终稿的一段: 一张卡片承载的正文与尾部图片。 */
interface FinalPart {
  text: string;
  extras: readonly string[];
}

/**
 * 把终稿排成一张或多张卡片。整篇装得下就是一张(与以前逐字一致); 装不下时
 * 正文按内容边界分段, 尾部图片挂在最后一段后面、挂不下就另起卡片分批发。
 * 过程记录只在第一张, 多张时每张底部带页码。
 */
function buildFinalCards(
  text: string,
  imageMap: Map<string, string> | null,
  extraImageKeys: readonly string[],
  process: StreamingProcessRecord | undefined,
): unknown[] {
  const cardOf = (part: FinalPart, first: boolean, partNote?: string): unknown =>
    buildReplyCardV2({
      text: part.text,
      imageMap,
      appendImageKeys: part.extras,
      ...(first && process ? { process } : {}),
      ...(partNote ? { partNote } : {}),
    });
  const whole = cardOf({ text, extras: extraImageKeys }, true);
  if (fitsOneCard(whole, text)) return [whole];

  // 页码要等分完才知道总数: 先按最长的页码占位(中间页的文案比末页长), 保证填上
  // 真页码后仍装得下。
  const reserve = transportMessages.streaming.partNote(98, 99);
  const parts: FinalPart[] = text.trim()
    ? splitMarkdownForCards(text, (chunk, index) =>
        fitsOneCard(cardOf({ text: chunk, extras: [] }, index === 0, reserve), chunk),
      ).map((chunk) => ({ text: chunk, extras: [] }))
    : [];

  let pending = [...extraImageKeys];
  const last = parts[parts.length - 1];
  if (last && pending.length > 0 && pending.length <= EXTRA_IMAGES_PER_CARD) {
    const withImages: FinalPart = { text: last.text, extras: pending };
    if (fitsOneCard(cardOf(withImages, parts.length === 1, reserve), last.text)) {
      parts[parts.length - 1] = withImages;
      pending = [];
    }
  }
  while (pending.length > 0) {
    let take = Math.min(pending.length, EXTRA_IMAGES_PER_CARD);
    while (
      take > 1 &&
      !fitsOneCard(cardOf({ text: '', extras: pending.slice(0, take) }, parts.length === 0, reserve), '')
    ) {
      take = Math.floor(take / 2);
    }
    parts.push({ text: '', extras: pending.slice(0, take) });
    pending = pending.slice(take);
  }

  const total = parts.length;
  return parts.map((part, index) => {
    const card = cardOf(
      part,
      index === 0,
      total > 1 ? transportMessages.streaming.partNote(index + 1, total) : undefined,
    );
    // 切不动的极端内容(单个不可再分的片段就超限)仍给一句明确说明, 不发会被拒的卡。
    return cardRequestBytes(card) <= FEISHU_CARD_REQUEST_MAX_BYTES
      ? card
      : buildMarkdownCardV2(transportMessages.streaming.deliveryFailed);
  });
}

/**
 * 这份流式卡片对外界的全部依赖。排版(中间帧怎么截、终稿怎么分条、过程怎么折叠)都在
 * 本模块里, 只有「把卡片送到哪、怎么送」由调用方给出 —— 个人 bot 直接调飞书接口,
 * 官方 bot 经 msg.op 交给服务端执行, 两边用同一份排版。
 */
export interface FeishuStreamingDeps {
  /** 这份载体是否仍然有效(换账号 / 断线隔离后为 false: 不再出站)。 */
  isCurrent(): boolean;
  /** 新建这一轮的卡片, 返回消息号。 */
  createCard(card: unknown): Promise<string>;
  /** 原地更新这一轮的卡片(中间帧)。 */
  updateCard(messageId: string, card: unknown): Promise<void>;
  /**
   * 终稿第一张: 落在这一轮已有的卡片上(messageId 非空), 没有或改不了时新发。
   * 返回最终承载它的消息号; 送不出去时抛出。
   */
  putFinalHead(messageId: string | null, card: unknown): Promise<string>;
  /** 终稿第 index 张(从 1 起): 在本轮回复位置新发一张。 */
  sendFinalPart(index: number, card: unknown): Promise<void>;
  /** 成功但没有任何内容: 撤回这一轮的卡片。 */
  recallEmpty(messageId: string): Promise<void>;
  /** 终稿没能完整送达时给用户的一句说明(尽力而为)。 */
  sendNotice(text: string): Promise<void>;
  /**
   * 正文里的托管图片与文件。缺省 = 不处理: 官方 bot 的附件由服务端随 turn.end 发布,
   * 到这里的正文已不含这类引用。
   */
  media?: {
    /** 托管图片地址 → 本机绝对路径(解析失败抛出)。 */
    resolveImagePath(url: string): string;
    uploadImage(absPath: string): Promise<string | null>;
    sendFile(absPath: string, name: string | undefined): Promise<void>;
  };
  log: { debug(message: string): void; warn(message: string): void; error(message: string): void };
  /** 把内部的异步入口绑到创建时的连接作用域(个人 bot 的事件可能来自别的作用域)。 */
  bind?<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
}

/** 官方 bot 用的轮次载体: 与 StreamingTextHandle 同一个实现, 只暴露它需要的三件事。 */
export interface FeishuTurnCarrier {
  /** 交一帧最新快照(markdown), 节流后出站; 第一帧建卡。 */
  replace(markdown: string): void;
  /** 发布终稿。true = 每一张卡片都已送达; false = 没有完整送达(调用方另行兜底)。 */
  finalize(finalText: string, options?: StreamingFinalizeOptions): Promise<boolean>;
  /** 永久停止, 不再出站。幂等。 */
  close(): void;
}

class FeishuStreamingTextHandle implements StreamingTextHandle {
  private messageIdValue: string | null;
  get messageId(): string {
    return this.messageIdValue ?? '';
  }
  private buffer: string;
  private flushed: string;
  private pending: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private finalized = false;
  /**
   * 工具结果(tool_result_full event)带过来的图片 absPath, finalize 时跟文本里
   * xdt-image markdown 链接一起 upload + 拼到 card 末尾。host 主进程负责把
   * xdt-image:// URL 用 imageCacheStore.resolveSafe 解成 absPath 再投递, 这里
   * 不参与 namespace 路由(@cindy/im 包对 lizi-art / 其它 host 命名空间不感知)。
   */
  private extraImageAbsPaths: string[] = [];
  /** 收口时由调用方交来的过程记录; 折叠在终稿第一张卡片的正文上方。 */
  private process: StreamingProcessRecord | undefined;

  /**
   * `messageId` 为 null = 还没有卡片: 第一帧(或终稿)到来时才建。`initial` 是此刻
   * 卡片上**已经显示**的内容(如「🧠 思考中...」), 没有卡片时为空。
   */
  constructor(
    private readonly deps: FeishuStreamingDeps,
    messageId: string | null,
    initial: string,
  ) {
    this.messageIdValue = messageId;
    // `buffer` is what we've ACCUMULATED to display — starts empty so the
    // first real append() *replaces* the placeholder rather than appending
    // to it (otherwise the placeholder permanently prefixes the message).
    this.buffer = '';
    this.flushed = initial;
    // The handle outlives FeishuIM.startStreamingText's ALS call. Agent events
    // may arrive from outside that scope (or another bot's), so bind both I/O
    // paths to the connection that created the card, including timer callbacks,
    // media uploads, empty-reply recalls and delivery-failure fallbacks.
    if (deps.bind) {
      this.flushIntermediate = deps.bind(this.flushIntermediate.bind(this));
      this.doFinalize = deps.bind(this.doFinalize.bind(this));
    }
  }

  append(delta: string): void {
    if (this.finalized) return;
    this.buffer += delta;
    this.scheduleFlush();
  }

  replace(fullText: string): void {
    if (this.finalized) return;
    this.buffer = fullText;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.flushIntermediate();
    }, PATCH_THROTTLE_MS);
    this.pending.unref?.();
  }

  async finalize(finalText: string, options?: StreamingFinalizeOptions): Promise<void> {
    await this.finalizeDelivered(finalText, options);
  }

  /** finalize 的完整形态: 返回终稿是否每一张卡片都已送达(重复调用返回 false)。 */
  async finalizeDelivered(finalText: string, options?: StreamingFinalizeOptions): Promise<boolean> {
    if (this.finalized) return false;
    this.finalized = true;
    this.process = options?.process;
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* swallow */
      }
    }
    this.buffer = finalText;
    return this.doFinalize();
  }

  close(): void {
    this.finalized = true;
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
  }

  addExtraImageAbsPath(absPath: string): void {
    if (this.finalized) return;
    if (!absPath) return;
    // dedupe by absPath — model 偶尔在同一 turn 多条 tool_result 重复同一张图
    if (this.extraImageAbsPaths.includes(absPath)) return;
    this.extraImageAbsPaths.push(absPath);
  }

  // ── intermediate (throttled) patch ────────────────────────────────────────

  private async flushIntermediate(): Promise<void> {
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* swallow */
      }
    }
    if (this.finalized || !this.deps.isCurrent() || this.buffer === this.flushed) return;
    // Friendlier placeholder when buffer is xdt-only (model sent images/files
    // but no narration yet) — `classifyXdtOnly` returns the kind so we can
    // show a hint instead of stripped placeholders.
    const klass = classifyXdtOnly(this.buffer);
    let text: string;
    if (klass === 'image-only') text = transportMessages.streaming.preparingImage;
    else if (klass === 'file-only') text = transportMessages.streaming.preparingFile;
    else text = stripXdtForStreaming(this.buffer);
    // 还没有卡片时不为空白内容建卡(惰性建卡: 有东西可看才出现)。
    if (this.messageIdValue === null && !text.trim()) return;
    const snapshot = this.buffer;
    this.inFlight = (async () => {
      try {
        const card = fitIntermediateCard(text);
        if (this.messageIdValue === null) this.messageIdValue = await this.deps.createCard(card);
        else await this.deps.updateCard(this.messageIdValue, card);
        this.flushed = snapshot;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.log.warn(
          `[feishu/streamingText] intermediate patch failed (will retry): ${msg}`,
        );
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
  }

  // ── finalize: upload media, replace progress with the final ───────────────

  private async doFinalize(): Promise<boolean> {
    const { deps } = this;
    const log = deps.log;
    const text = this.buffer;
    if (!deps.isCurrent()) return false;
    if (!text.trim() && this.extraImageAbsPaths.length === 0) {
      // A claimed opener is also the topic's reply anchor. Only its owning
      // account/round may restore that anchor after a successful recall.
      if (this.messageIdValue !== null) await deps.recallEmpty(this.messageIdValue);
      return true;
    }
    const media = deps.media;

    // 1. Upload all xdt-image URLs in parallel; missing entries get a "图片
    //    加载失败" placeholder in the final card.
    const imageUrls = media ? collectXdtImageUrls(text) : [];
    const imageMap = new Map<string, string>();
    // 正文图 absPath 集合:1b 用它对 extras 求差——同一张图既被模型 markdown
    // 内联进正文、又经 tool_result 账本 sidechannel 送来时(ghost 读文档
    // xdt_media_inline 内联场景),只保留正文内联位,不在卡片尾部再挂一份。
    const bodyImageAbsPaths = new Set<string>();
    if (media && imageUrls.length > 0) {
      log.debug(`[feishu/streamingText] uploading ${imageUrls.length} xdt-image(s)`);
      const results = await Promise.all(
        imageUrls.map(async (url) => {
          let absPath: string;
          try {
            absPath = media.resolveImagePath(url);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(
              `[feishu/streamingText] resolve managed image failed for ${url}: ${msg}`,
            );
            return null;
          }
          bodyImageAbsPaths.add(absPath);
          try {
            const key = await media.uploadImage(absPath);
            return key ? ([url, key] as const) : null;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`[feishu/streamingText] uploadImage ${absPath} failed: ${msg}`);
            return null;
          }
        }),
      );
      for (const r of results) {
        if (r) imageMap.set(r[0], r[1]);
      }
    }

    // 1b. Upload extras (来自 tool_result event 的图片). 跟文本里 xdt-image 走
    //     同一条 uploadImage 通道, 但 path 由 host 主进程已经解好直接传 absPath。
    //     正文里已内联的同图(按 absPath)跳过,防"正文一张 + 尾部一张"双份。
    const extrasToUpload = media
      ? this.extraImageAbsPaths.filter((p) => !bodyImageAbsPaths.has(p))
      : [];
    if (extrasToUpload.length > 0) {
      log.debug(
        `[feishu/streamingText] uploading ${extrasToUpload.length} extra image(s) from tool_result`,
      );
    }
    if (!deps.isCurrent()) return false;
    const extraImageKeys: string[] = [];
    if (media) {
      const uploaded = await Promise.all(
        extrasToUpload.map(async (absPath) => {
          try {
            return await media.uploadImage(absPath);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`[feishu/streamingText] uploadImage extra ${absPath} failed: ${msg}`);
            return null;
          }
        }),
      );
      for (const key of uploaded) if (key) extraImageKeys.push(key);
    }
    if (!deps.isCurrent()) return false;

    // 2. Send xdt-file links as separate file messages.
    const fileLinks = media ? collectXdtFileLinks(text) : [];
    if (media && fileLinks.length > 0) {
      log.debug(`[feishu/streamingText] sending ${fileLinks.length} xdt-file(s)`);
      await Promise.all(
        fileLinks.map(async (link) => {
          try {
            await media.sendFile(link.absPath, link.alt || undefined);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(
              `[feishu/streamingText] sendFile ${link.absPath} failed: ${msg}`,
            );
          }
        }),
      );
    }

    if (!deps.isCurrent()) return false;

    // 3. Strip xdt-file from card text (delivered separately, no placeholder).
    const cardText = media ? stripXdtFileLinks(text) : text;
    const cardTextTrimmed = cardText.trim();

    // 4. Update the original card without a recall notice. Terminal shapes:
    //    a) text only → plain markdown card v2
    //    b) text + images (markdown 内联 OR tool_result 追加) → mixed elements card
    //    c) empty text + only files → "🎉 N 个文件已送达" placeholder
    //    d) extra images all failed → delivery failure (truly empty finals returned above)
    //    a–c 带上过程记录(折叠在正文上方); 一张装不下时分成多张, 首张落在原卡上、
    //    其余按顺序另发(见 buildFinalCards)。
    const hasAnyImage = imageUrls.length > 0 || extraImageKeys.length > 0;
    const fileOnly = cardTextTrimmed.length === 0 && !hasAnyImage && fileLinks.length > 0;
    let cards: unknown[];
    let answered = true;
    if (fileOnly) {
      cards = buildFinalCards(
        transportMessages.streaming.fileSentDone(fileLinks.length),
        null,
        [],
        this.process,
      );
    } else if (hasAnyImage) {
      // 文本空但有图(画完图没说话) — 不要在图上面塞 "(空回复)" 占位, 让图自己说话。
      cards = buildFinalCards(cardText, imageMap, extraImageKeys, this.process);
    } else if (cardTextTrimmed.length > 0) {
      cards = buildFinalCards(cardText, null, [], this.process);
    } else {
      cards = [buildMarkdownCardV2(transportMessages.streaming.deliveryFailed)];
      answered = false;
    }
    try {
      this.messageIdValue = await deps.putFinalHead(this.messageIdValue, cards[0]);
      this.flushed = this.buffer;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[feishu/streamingText] final delivery failed: ${msg}`);
      if (!deps.isCurrent()) return false;
      try {
        await deps.sendNotice(transportMessages.streaming.deliveryFailed);
      } catch (textErr) {
        const textMsg = textErr instanceof Error ? textErr.message : String(textErr);
        log.error(`[feishu/streamingText] fallback text failed: ${textMsg}`);
      }
      // 第一段都没送达: 后面的段落不再单独发, 否则只剩没头没尾的后半截。
      return false;
    }
    return (await this.sendFollowingCards(cards.slice(1))) && answered;
  }

  /**
   * 分条终稿的第二张起: 按顺序各发一条新卡片, 留在本轮的回复位置上。某一张发不出去
   * 就停下并说明, 不跳过它继续发后面的(读者会以为内容是连续的)。返回是否全部送达。
   */
  private async sendFollowingCards(cards: readonly unknown[]): Promise<boolean> {
    const { deps } = this;
    for (const [offset, card] of cards.entries()) {
      if (!deps.isCurrent()) return false;
      try {
        await deps.sendFinalPart(offset + 1, card);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.log.warn(`[feishu/streamingText] following card send failed: ${msg}`);
        if (!deps.isCurrent()) return false;
        try {
          await deps.sendNotice(transportMessages.streaming.continuationFailed);
        } catch (textErr) {
          const textMsg = textErr instanceof Error ? textErr.message : String(textErr);
          deps.log.error(`[feishu/streamingText] continuation notice failed: ${textMsg}`);
        }
        return false;
      }
    }
    return true;
  }
}

/**
 * 个人飞书 bot 的发送通道: 直接调飞书接口。卡片发在本轮的回复位置(lane 锚点),
 * 账号换代后一律停手。
 */
function personalDeps(
  openId: string,
  opts: { threadTs?: string } | undefined,
  claimedOpener: boolean,
): FeishuStreamingDeps {
  const accountEpoch = getAccountEpoch();
  const scope = getScope();
  const log = getLog();
  const isCurrent = (): boolean => getAccountEpoch() === accountEpoch;
  const stay = { ...opts, advanceRound: false };
  return {
    isCurrent,
    createCard: async (card) => (await sendCardRaw(openId, card, opts)).messageId,
    updateCard: (messageId, card) => patchCardRaw(messageId, card),
    async putFinalHead(messageId, card) {
      if (messageId !== null) {
        try {
          await patchCardRaw(messageId, card);
          return messageId;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[feishu/streamingText] finalize patch failed: ${msg}`);
          if (!isCurrent()) throw err;
        }
      }
      // Preserve the full answer if the original card can no longer be edited.
      // Stay on this round's target and never recall the user's progress card.
      return (await sendCardRaw(openId, card, stay)).messageId;
    },
    async sendFinalPart(_index, card) {
      await sendCardRaw(openId, card, stay);
    },
    async recallEmpty(messageId) {
      await recallMessage(messageId);
      if (claimedOpener && isCurrent()) rearmAnchorToTrigger(openId, messageId);
    },
    async sendNotice(text) {
      await sendText(openId, text, opts);
    },
    media: {
      // cindy-media(媒体总仓新地址)优先走 host 注入的解析回调;老 xdt-image 仍走
      // feishu 专属目录解析。
      resolveImagePath: (url) =>
        getHost().media?.resolveMediaUrl(url) ??
        resolveFeishuMediaUrl(url, getHost().paths.feishuMediaDir).absPath,
      uploadImage: (absPath) => uploadImage(absPath),
      async sendFile(absPath, name) {
        await sendFile(openId, absPath, name, opts);
      },
    },
    log,
    bind: (fn) => bindScope(scope, fn),
  };
}

export async function start(
  openId: string,
  initial: string = transportMessages.streaming.randomThinking(),
  opts?: { threadTs?: string },
): Promise<StreamingTextHandle> {
  // Preserve explicit opener callers; ordinary inbound messages never create topics.
  const claimed = opts?.threadTs ? null : claimPatchableOpener(openId);
  if (claimed) {
    return new FeishuStreamingTextHandle(personalDeps(openId, opts, true), claimed, initial);
  }
  const deps = personalDeps(openId, opts, false);
  const { messageId } = await sendCardRaw(openId, buildMarkdownCardV2(initial), opts);
  return new FeishuStreamingTextHandle(deps, messageId, initial);
}

/**
 * 用调用方给的发送通道起一份轮次载体(官方 bot: 经 msg.op 交给服务端执行)。排版与个人
 * bot 完全相同; 卡片在第一帧到来时才建。
 */
export function startFeishuTurnCarrier(deps: FeishuStreamingDeps): FeishuTurnCarrier {
  const handle = new FeishuStreamingTextHandle(deps, null, '');
  return {
    replace: (markdown) => handle.replace(markdown),
    finalize: (finalText, options) => handle.finalizeDelivered(finalText, options),
    close: () => handle.close(),
  };
}

/**
 * 一次性把已有 card patch 成 v2 markdown 内容 (不流式)。/ctr 接管路径用这个
 * 把 picker card 直接转成"已接管 + 总结"视图, 替代发两张独立消息。
 */
export async function patchMarkdown(messageId: string, markdown: string): Promise<void> {
  if (!markdown.trim()) {
    await recallMessage(messageId);
    return;
  }
  await patchCardRaw(messageId, buildMarkdownCardV2(markdown));
}
