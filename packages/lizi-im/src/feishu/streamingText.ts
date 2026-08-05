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
 *                                   4) patch card with mixed text + img
 *                                      elements (or plain markdown card if no
 *                                      images)
 *   handle.close()                → cancel pending throttle, no further patches
 *
 * Design parity: matches the legacy feishuBot/replyClient.ts behaviour
 * (xdt-image: `![alt](xdt-image://...)`, xdt-file:
 * `[name](xdt-file:///abs/path)`).
 */

import { sendCardRaw, patchCardRaw, uploadImage, sendFile } from './outbound.js';
import { buildMarkdownCardV2, buildMixedMarkdownCardV2 } from './cards.js';
import { getLog } from './moduleScope.js';
import { messages as transportMessages } from './messages.js';
import type { StreamingTextHandle } from '../types.js';
// xdt-* 引用解析抽到渠道无关模块(slack streamingText 共用同一套语义)
import {
  stripXdtForStreaming,
  classifyXdtOnly,
  stripXdtFileLinks,
  collectXdtFileLinks,
  collectXdtImageUrls,
} from '../xdtRefs.js';

const PATCH_THROTTLE_MS = 1500;

class FeishuStreamingTextHandle implements StreamingTextHandle {
  readonly messageId: string;
  private readonly openId: string;
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

  constructor(messageId: string, openId: string, initial: string) {
    this.messageId = messageId;
    this.openId = openId;
    // `initial` is what's currently DISPLAYED in feishu (e.g. "🧠 思考中...").
    // `buffer` is what we've ACCUMULATED to display — starts empty so the
    // first real append() *replaces* the placeholder rather than appending
    // to it (otherwise the placeholder permanently prefixes the message).
    this.buffer = '';
    this.flushed = initial;
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
  }

  async finalize(finalText: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
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
    await this.doFinalize();
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
    if (this.buffer === this.flushed) return;
    // Friendlier placeholder when buffer is xdt-only (model sent images/files
    // but no narration yet) — `classifyXdtOnly` returns the kind so we can
    // show a hint instead of stripped placeholders.
    const klass = classifyXdtOnly(this.buffer);
    let text: string;
    if (klass === 'image-only') text = transportMessages.streaming.preparingImage;
    else if (klass === 'file-only') text = transportMessages.streaming.preparingFile;
    else text = stripXdtForStreaming(this.buffer);
    const log = getLog();
    this.inFlight = (async () => {
      try {
        await patchCardRaw(this.messageId, buildMarkdownCardV2(text));
        this.flushed = this.buffer;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          `[feishu/streamingText] intermediate patch failed (will retry): ${msg}`,
        );
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
  }

  // ── finalize: upload images, send files, patch with mixed elements ────────

  private async doFinalize(): Promise<void> {
    const log = getLog();
    const text = this.buffer;

    // 1. Upload all xdt-image URLs in parallel; missing entries get a "图片
    //    加载失败" placeholder in the final card.
    const imageUrls = collectXdtImageUrls(text);
    const imageMap = new Map<string, string>();
    // 正文图 absPath 集合:1b 用它对 extras 求差——同一张图既被模型 markdown
    // 内联进正文、又经 tool_result 账本 sidechannel 送来时(ghost 读文档
    // xdt_media_inline 内联场景),只保留正文内联位,不在卡片尾部再挂一份。
    const bodyImageAbsPaths = new Set<string>();
    if (imageUrls.length > 0) {
      log.debug(`[feishu/streamingText] uploading ${imageUrls.length} xdt-image(s)`);
      const results = await Promise.all(
        imageUrls.map(async (url) => {
          // mediaCache.resolveFeishuMediaUrl decoupled to outbound layer:
          // uploadImage takes an absPath, so we resolve here.
          // cindy-media(媒体总仓新地址)优先走 host 注入的解析回调;老
          // xdt-image 仍走 feishu 专属目录解析。
          const { resolveFeishuMediaUrl } = await import('./mediaCache.js');
          const { getHost } = await import('./moduleScope.js');
          let absPath: string;
          try {
            const hostResolved = getHost().media?.resolveMediaUrl(url) ?? null;
            absPath =
              hostResolved ??
              resolveFeishuMediaUrl(url, getHost().paths.feishuMediaDir).absPath;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(
              `[feishu/streamingText] resolve managed image failed for ${url}: ${msg}`,
            );
            return null;
          }
          bodyImageAbsPaths.add(absPath);
          const key = await uploadImage(absPath);
          return key ? ([url, key] as const) : null;
        }),
      );
      for (const r of results) {
        if (r) imageMap.set(r[0], r[1]);
      }
    }

    // 1b. Upload extras (来自 tool_result event 的图片). 跟文本里 xdt-image 走
    //     同一条 uploadImage 通道, 但 path 由 host 主进程已经解好直接传 absPath,
    //     这里不再过 resolveFeishuMediaUrl (@cindy/im 包对其它 host namespace 不感知)。
    //     正文里已内联的同图(按 absPath)跳过,防"正文一张 + 尾部一张"双份。
    const extraImageKeys: string[] = [];
    const extrasToUpload = this.extraImageAbsPaths.filter((p) => !bodyImageAbsPaths.has(p));
    if (extrasToUpload.length > 0) {
      log.debug(
        `[feishu/streamingText] uploading ${extrasToUpload.length} extra image(s) from tool_result`,
      );
      const results = await Promise.all(
        extrasToUpload.map(async (absPath) => {
          try {
            return await uploadImage(absPath);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(
              `[feishu/streamingText] uploadImage extra ${absPath} failed: ${msg}`,
            );
            return null;
          }
        }),
      );
      for (const k of results) {
        if (k) extraImageKeys.push(k);
      }
    }

    // 2. Send xdt-file links as separate file messages.
    const fileLinks = collectXdtFileLinks(text);
    if (fileLinks.length > 0) {
      log.debug(`[feishu/streamingText] sending ${fileLinks.length} xdt-file(s)`);
      await Promise.all(
        fileLinks.map(async (link) => {
          try {
            await sendFile(this.openId, link.absPath, link.alt || undefined);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(
              `[feishu/streamingText] sendFile ${link.absPath} failed: ${msg}`,
            );
          }
        }),
      );
    }

    // 3. Strip xdt-file from card text (delivered separately, no placeholder).
    const cardText = stripXdtFileLinks(text);
    const cardTextTrimmed = cardText.trim();

    // 4. Patch the card. Terminal shapes:
    //    a) text only → plain markdown card v2
    //    b) text + images (markdown 内联 OR tool_result 追加) → mixed elements card
    //    c) empty text + only files → "🎉 N 个文件已送达" placeholder
    //    d) totally empty → fallback "(空回复)"
    const hasAnyImage = imageUrls.length > 0 || extraImageKeys.length > 0;
    try {
      let card: unknown;
      if (cardTextTrimmed.length === 0 && !hasAnyImage && fileLinks.length > 0) {
        card = buildMarkdownCardV2(transportMessages.streaming.fileSentDone(fileLinks.length));
      } else if (hasAnyImage) {
        // 文本空但有图(画完图没说话) — 不要在图上面塞 "(空回复)" 占位, 让图自己说话。
        // 反过来如果文本也空, buildMixedMarkdownCardV2 内部 elements.length===0
        // 兜底分支会塞 "(空回复)" — 但 hasAnyImage 时一定不为空, 所以不会触发。
        card = buildMixedMarkdownCardV2(cardText, imageMap, extraImageKeys);
      } else {
        card = buildMarkdownCardV2(cardTextTrimmed.length > 0 ? cardText : transportMessages.streaming.emptyReply);
      }
      await patchCardRaw(this.messageId, card);
      this.flushed = this.buffer;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[feishu/streamingText] finalize patch failed: ${msg}`);
    }
  }
}

export async function start(
  openId: string,
  initial: string = transportMessages.streaming.randomThinking(),
): Promise<StreamingTextHandle> {
  const { messageId } = await sendCardRaw(openId, buildMarkdownCardV2(initial));
  return new FeishuStreamingTextHandle(messageId, openId, initial);
}

/**
 * 一次性把已有 card patch 成 v2 markdown 内容 (不流式)。/ctr 接管路径用这个
 * 把 picker card 直接转成"已接管 + 总结"视图, 替代发两张独立消息。
 */
export async function patchMarkdown(messageId: string, markdown: string): Promise<void> {
  await patchCardRaw(messageId, buildMarkdownCardV2(markdown));
}
