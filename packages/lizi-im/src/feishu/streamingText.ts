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

import fs from 'node:fs';
import path from 'node:path';

import {
  sendCardRaw,
  patchCardRaw,
  uploadImage,
  sendFile,
  sendFileToChat,
  sendCardToChat,
  sendText,
  claimPatchableOpener,
  getAccountEpoch,
  getBoundClient,
  runWithPinnedAccount,
  isPinnedAccountCurrent,
  attestedRealPath,
  attestOpenFileWithinDirectory,
  type FeishuUploadedFileSource,
  type ReusableFeishuFileMessage,
} from './outbound.js';
import { buildMarkdownCardV2, buildMixedMarkdownCardV2 } from './cards.js';
import { resolveFeishuMediaUrl } from './mediaCache.js';
import { getHost, getLog } from './moduleScope.js';
import {
  releaseMirrorConfirmation,
  scheduleMirrorOnConfirmation,
  waitForMirrorConfirmation,
} from './dualDelivery.js';
import { messages as transportMessages } from './messages.js';
import type { IMFinalReplyMirror, StreamingTextHandle } from '../types.js';
// xdt-* 引用解析抽到渠道无关模块(slack streamingText 共用同一套语义)
import {
  stripXdtForStreaming,
  classifyXdtOnly,
  stripXdtFileLinks,
  stripXdtImageLinks,
  collectXdtFileLinks,
  collectXdtImageUrls,
} from '../xdtRefs.js';

const PATCH_THROTTLE_MS = 1500;
/** Feishu caps serialized card request bodies at 30 KB. */
export const FEISHU_CARD_REQUEST_MAX_BYTES = 30 * 1024;

function cardRequestBytes(card: unknown): number {
  return Buffer.byteLength(JSON.stringify({ content: JSON.stringify(card) }), 'utf8');
}

function fitCardToLimit(
  text: string,
  fullCard: unknown,
  buildCard: (visibleText: string) => unknown,
): unknown {
  if (cardRequestBytes(fullCard) <= FEISHU_CARD_REQUEST_MAX_BYTES) return fullCard;

  const chars = Array.from(text);
  const suffix = transportMessages.streaming.replyTruncated;
  let low = 0;
  let high = chars.length;
  let fitted = buildCard(suffix);
  if (cardRequestBytes(fitted) > FEISHU_CARD_REQUEST_MAX_BYTES) {
    return buildMarkdownCardV2(transportMessages.streaming.deliveryFailed);
  }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = buildCard(`${chars.slice(0, middle).join('')}${suffix}`);
    if (cardRequestBytes(candidate) <= FEISHU_CARD_REQUEST_MAX_BYTES) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return fitted;
}

function mirrorUuid(key: string, suffix: string): string {
  return `${key.slice(0, 32)}-${suffix}`.slice(0, 50);
}

async function uploadExtraImageKeys(absPaths: readonly string[]): Promise<string[]> {
  const results = await Promise.all(
    absPaths.map(async (absPath) => {
      try {
        return await uploadImage(absPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        getLog().warn(`[feishu/streamingText] uploadImage extra ${absPath} failed: ${msg}`);
        return null;
      }
    }),
  );
  const keys: string[] = [];
  for (const key of results) {
    if (key) keys.push(key);
  }
  return keys;
}

interface FinalCardResult {
  card: unknown;
  /** Parent-chat copy. Differs from `card` when local media must not be mirrored. */
  mirrorCard: unknown;
  reusableFiles: ReusableMirroredFile[];
  fileOnly: boolean;
}

interface ReusableMirroredFile {
  message: ReusableFeishuFileMessage;
  sourceIndex: number;
}

function sameInode(
  left: { dev: string; ino: string },
  right: { dev: string; ino: string },
): boolean {
  // Node reports ino===0 on some Windows volumes for every file. Matching
  // that sentinel would treat unrelated objects as the same inode.
  if (left.ino === '0' || right.ino === '0') return false;
  return left.dev === right.dev && left.ino === right.ino;
}

function isSyntheticFdPath(resolved: string): boolean {
  const normalized = resolved.replaceAll('\\', '/');
  return /(?:^|\/)(?:proc\/self\/fd|dev\/fd)\/\d+$/.test(normalized);
}

function normalizePathForContainment(value: string): string {
  const resolved = path.resolve(value);
  if (process.platform !== 'win32') return resolved;
  // Drive letter is the only OS-defined case-insensitive component. Folding the
  // rest would collapse NTFS per-directory case-sensitive siblings (C:\work vs
  // C:\Work) into one root.
  return resolved.replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
}

function pathSegmentsWithinRoot(realFilePath: string, realRoot: string): string[] | null {
  const file = normalizePathForContainment(realFilePath);
  const root = normalizePathForContainment(realRoot);
  if (file === root) return null;
  // path.win32.relative is case-insensitive even when this directory is not.
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!file.startsWith(rootWithSep)) return null;
  const segments = file.slice(rootWithSep.length).split(path.sep);
  return segments.length > 0 && segments.every((segment) => segment && segment !== '.' && segment !== '..')
    ? segments
    : null;
}

function openDirectoryFd(target: string, noFollow: boolean): number {
  let flags = fs.constants.O_RDONLY;
  if (noFollow && fs.constants.O_NOFOLLOW) flags |= fs.constants.O_NOFOLLOW;
  if (fs.constants.O_DIRECTORY) flags |= fs.constants.O_DIRECTORY;
  return fs.openSync(target, flags);
}

/**
 * Parent-chat reuse never re-uploads disk bytes. It reopens the frozen uploaded
 * inode and the turn-pinned root only to prove object ancestry: the leaf is
 * opened once, the root is opened once, and the native helper walks each child
 * relative to the preceding directory handle without following links. A final
 * handle identity comparison binds both sides even if their lexical paths are
 * swapped between checks. Missing pins/helpers fail closed.
 */
async function isSourceWithinAllowedFileRoots(
  source: FeishuUploadedFileSource,
  allowedFileRoots: readonly string[],
  pinnedFileRoots?: ReadonlyArray<{ dev: string; ino: string; realPath?: string }>,
): Promise<boolean> {
  if (source.ino === '0') return false;
  if (!source.realPath || isSyntheticFdPath(source.realPath)) return false;
  if (!pinnedFileRoots?.length) return false;

  let sourceFd: number | undefined;
  try {
    let flags = fs.constants.O_RDONLY;
    if (fs.constants.O_NOFOLLOW) flags |= fs.constants.O_NOFOLLOW;
    if (fs.constants.O_NONBLOCK) flags |= fs.constants.O_NONBLOCK;
    sourceFd = fs.openSync(source.realPath, flags);
    const sourceStat = fs.fstatSync(sourceFd, { bigint: true });
    if (
      !sourceStat.isFile() ||
      !sameInode({ dev: String(sourceStat.dev), ino: String(sourceStat.ino) }, source)
    ) {
      return false;
    }

    for (const root of allowedFileRoots) {
      if (!root.trim()) continue;
      let rootFd: number | undefined;
      try {
        rootFd = openDirectoryFd(root, false);
        const rootStat = fs.fstatSync(rootFd, { bigint: true });
        if (!rootStat.isDirectory()) continue;
        const rootIdentity = { dev: String(rootStat.dev), ino: String(rootStat.ino) };
        const pin = pinnedFileRoots.find((candidate) => sameInode(rootIdentity, candidate));
        if (!pin) continue;
        const rootRealPath =
          pin.realPath && !isSyntheticFdPath(pin.realPath)
            ? pin.realPath
            : await attestedRealPath(rootFd, rootIdentity);
        if (!rootRealPath || isSyntheticFdPath(rootRealPath)) continue;
        const segments = pathSegmentsWithinRoot(source.realPath, rootRealPath);
        if (!segments) continue;
        if (await attestOpenFileWithinDirectory(sourceFd, rootFd, segments)) return true;
      } catch {
        /* This root cannot prove containment. Try the next approved root. */
      } finally {
        if (rootFd !== undefined) fs.closeSync(rootFd);
      }
    }
  } catch {
    return false;
  } finally {
    if (sourceFd !== undefined) fs.closeSync(sourceFd);
  }
  return false;
}

async function isWithinAllowedFileRoots(
  allowedFileRoots: readonly string[],
  pinnedFileRoots?: ReadonlyArray<{ dev: string; ino: string; realPath?: string }>,
  uploadedSource?: FeishuUploadedFileSource,
): Promise<boolean> {
  if (!uploadedSource) return false;
  return isSourceWithinAllowedFileRoots(uploadedSource, allowedFileRoots, pinnedFileRoots);
}

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

  async finalize(
    finalText: string,
    opts?: { finalReplyMirror?: IMFinalReplyMirror },
  ): Promise<void> {
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
    const mirror = opts?.finalReplyMirror;
    try {
      await this.doFinalize(mirror);
    } finally {
      if (mirror?.kind === 'parent-chat') {
        releaseMirrorConfirmation(mirror.idempotencyKey);
      }
    }
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

  private async doFinalize(finalReplyMirror?: IMFinalReplyMirror): Promise<void> {
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
          try {
            const key = await uploadImage(absPath);
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
    //     同一条 uploadImage 通道, 但 path 由 host 主进程已经解好直接传 absPath,
    //     这里不再过 resolveFeishuMediaUrl (@cindy/im 包对其它 host namespace 不感知)。
    //     正文里已内联的同图(按 absPath)跳过,防"正文一张 + 尾部一张"双份。
    const extrasToUpload = this.extraImageAbsPaths.filter((p) => !bodyImageAbsPaths.has(p));
    if (extrasToUpload.length > 0) {
      log.debug(
        `[feishu/streamingText] uploading ${extrasToUpload.length} extra image(s) from tool_result`,
      );
    }
    const extraImageKeys = await uploadExtraImageKeys(extrasToUpload);

    // 2. Send xdt-file links as separate file messages.
    const fileLinks = collectXdtFileLinks(text);
    let reusableFiles: ReusableMirroredFile[] = [];
    if (fileLinks.length > 0) {
      log.debug(`[feishu/streamingText] sending ${fileLinks.length} xdt-file(s)`);
      const results = await Promise.all(
        fileLinks.map(async (link, sourceIndex) => {
          try {
            const sent = await sendFile(this.openId, link.absPath, link.alt || undefined);
            // This path check only decides whether an existing Feishu upload
            // key may be mirrored. It never authorizes another filesystem read.
            if (
              sent.ok &&
              sent.reusableMessage &&
              (await isWithinAllowedFileRoots(
                finalReplyMirror?.allowedFileRoots ?? [],
                finalReplyMirror?.pinnedFileRoots,
                sent.uploadedSource,
              ))
            ) {
              return { message: sent.reusableMessage, sourceIndex };
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(
              `[feishu/streamingText] sendFile ${link.absPath} failed: ${msg}`,
            );
          }
          return null;
        }),
      );
      reusableFiles = results.filter(
        (message): message is ReusableMirroredFile => message !== null,
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
    const fileOnly = cardTextTrimmed.length === 0 && !hasAnyImage && fileLinks.length > 0;
    let primaryCardPatched = false;
    let mirrorResult: FinalCardResult | null = null;
    try {
      let card: unknown;
      if (fileOnly) {
        card = buildMarkdownCardV2(transportMessages.streaming.fileSentDone(fileLinks.length));
      } else if (hasAnyImage) {
        // 文本空但有图(画完图没说话) — 不要在图上面塞 "(空回复)" 占位, 让图自己说话。
        // 反过来如果文本也空, buildMixedMarkdownCardV2 内部 elements.length===0
        // 兜底分支会塞 "(空回复)" — 但 hasAnyImage 时一定不为空, 所以不会触发。
        card = buildMixedMarkdownCardV2(cardText, imageMap, extraImageKeys);
      } else {
        card = buildMarkdownCardV2(cardTextTrimmed.length > 0 ? cardText : transportMessages.streaming.emptyReply);
      }
      card = fitCardToLimit(cardText, card, (visibleText) =>
        hasAnyImage
          ? buildMixedMarkdownCardV2(visibleText, imageMap, extraImageKeys)
          : buildMarkdownCardV2(visibleText),
      );
      const allowLocalMedia = allowLocalMediaRoots(finalReplyMirror?.allowedFileRoots ?? []);
      let mirrorCard = card;
      let mirroredFiles = reusableFiles;
      let mirroredFileOnly = fileOnly;
      if (!allowLocalMedia) {
        const skippedLocalMedia =
          this.extraImageAbsPaths.length > 0 || imageUrls.length > 0 || fileLinks.length > 0;
        const mirrorText = stripXdtImageLinks(stripXdtFileLinks(text)).trim();
        mirroredFiles = [];
        mirroredFileOnly = false;
        if (skippedLocalMedia && mirrorText.length === 0) {
          mirrorCard = buildMarkdownCardV2(transportMessages.streaming.deliveryFailed);
        } else {
          const remoteSafeText =
            mirrorText.length > 0 ? mirrorText : transportMessages.streaming.emptyReply;
          mirrorCard = fitCardToLimit(
            remoteSafeText,
            buildMarkdownCardV2(remoteSafeText),
            (visibleText) => buildMarkdownCardV2(visibleText),
          );
        }
      }
      mirrorResult = {
        card,
        mirrorCard,
        reusableFiles: mirroredFiles,
        fileOnly: mirroredFileOnly,
      };
      await patchCardRaw(this.messageId, card);
      primaryCardPatched = true;
      this.flushed = this.buffer;
      await this.sendOrScheduleMirror(mirrorResult, finalReplyMirror);
    } catch (err) {
      if (primaryCardPatched) {
        log.warn(
          `[feishu/streamingText] parent-chat mirror failed after primary finalize (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[feishu/streamingText] finalize patch failed: ${msg}`);
      const notice = transportMessages.streaming.deliveryFailed;
      try {
        await patchCardRaw(this.messageId, buildMarkdownCardV2(notice));
      } catch (fallbackErr) {
        const fallbackMsg =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        log.warn(`[feishu/streamingText] fallback patch failed: ${fallbackMsg}`);
        try {
          await sendText(this.openId, notice);
        } catch (textErr) {
          const textMsg = textErr instanceof Error ? textErr.message : String(textErr);
          log.error(`[feishu/streamingText] fallback text failed: ${textMsg}`);
        }
      }
      if (mirrorResult) {
        try {
          await this.sendOrScheduleMirror(mirrorResult, finalReplyMirror);
        } catch (mirrorErr) {
          log.warn(
            `[feishu/streamingText] parent-chat mirror failed after primary fallback (non-fatal): ${
              mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)
            }`,
          );
        }
      }
    }
  }

  private async sendOrScheduleMirror(
    result: FinalCardResult,
    mirror: IMFinalReplyMirror | undefined,
  ): Promise<void> {
    if (mirror?.kind !== 'parent-chat') return;
    await sendOrScheduleMirror(
      mirror.idempotencyKey,
      () => this.mirrorFinalResult(result, mirror),
      mirror.accountEpoch,
      mirror.confirmed,
    );
  }

  private async mirrorFinalResult(
    result: FinalCardResult,
    mirror: IMFinalReplyMirror,
  ): Promise<void> {
    const chatId = mirror.chatId;
    const key = mirror.idempotencyKey;
    const log = getLog();
    if (result.fileOnly) {
      const sentCount = await sendMirroredFiles(chatId, key, result.reusableFiles);
      if (!isPinnedAccountCurrent()) return;
      const status =
        sentCount > 0
          ? transportMessages.streaming.fileSentDone(sentCount)
          : transportMessages.streaming.deliveryFailed;
      try {
        await sendCardToChat(chatId, buildMarkdownCardV2(status), mirrorUuid(key, 'card'));
      } catch (err) {
        log.warn(
          `[feishu/streamingText] parent-chat mirror card failed (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }
    try {
      await sendCardToChat(chatId, result.mirrorCard, mirrorUuid(key, 'card'));
    } catch (err) {
      log.warn(
        `[feishu/streamingText] parent-chat mirror card failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (!isPinnedAccountCurrent()) return;
    await sendMirroredFiles(chatId, key, result.reusableFiles);
  }
}

export async function start(
  openId: string,
  initial: string = transportMessages.streaming.randomThinking(),
): Promise<StreamingTextHandle> {
  // 群主流 @ 开话题时, 开场白卡就是本轮流式卡(openThread 已用它开好话题) —
  // 认领后直接 patch, 不再新建一条「开个话题」占位回复。
  const claimed = claimPatchableOpener(openId);
  if (claimed) {
    return new FeishuStreamingTextHandle(claimed, openId, initial);
  }
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

function allowLocalMediaRoots(allowedFileRoots: readonly string[] = []): boolean {
  return allowedFileRoots.some((root) => root.trim());
}

async function sendMirroredFiles(
  chatId: string,
  key: string,
  files: readonly ReusableMirroredFile[],
): Promise<number> {
  const log = getLog();
  const delivered = await Promise.all(
    files.map(async ({ message, sourceIndex }) => {
      if (!isPinnedAccountCurrent()) return false;
      try {
        const sent = await sendFileToChat(
          chatId,
          message,
          mirrorUuid(key, `f${sourceIndex}`),
        );
        if (!sent.ok) {
          log.warn(
            `[feishu/streamingText] parent-chat mirror file failed (non-fatal): ${
              sent.reason ?? 'unknown'
            }`,
          );
          return false;
        }
        return true;
      } catch (err) {
        log.warn(
          `[feishu/streamingText] parent-chat mirror file threw (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return false;
      }
    }),
  );
  return delivered.filter(Boolean).length;
}

async function sendOrScheduleMirror(
  mirrorKey: string,
  send: () => Promise<void>,
  inboundEpoch: number,
  alreadyConfirmed = false,
): Promise<void> {
  const release = (): void => {
    releaseMirrorConfirmation(mirrorKey);
  };
  if (getAccountEpoch() !== inboundEpoch) {
    release();
    return;
  }
  const pinned = getBoundClient();
  if (!pinned) {
    release();
    return;
  }
  const runPinned = async (): Promise<void> => {
    if (getAccountEpoch() !== inboundEpoch) return;
    await runWithPinnedAccount({ client: pinned, epoch: inboundEpoch }, send);
  };
  if (alreadyConfirmed || (await waitForMirrorConfirmation(mirrorKey))) {
    try {
      await runPinned();
    } finally {
      release();
    }
    return;
  }
  const deferred = scheduleMirrorOnConfirmation(mirrorKey, () => {
    void runPinned()
      .catch((err) => {
        getLog().warn(
          `[feishu/streamingText] deferred parent-chat mirror failed (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      })
      .finally(release);
  });
  if (!deferred) release();
}

/** One-shot mirror used when the primary streaming surface failed to start. */
export async function mirrorFinal(
  chatId: string,
  mirrorKey: string,
  text: string,
  extraImageAbsPaths: readonly string[] = [],
  allowedFileRoots: readonly string[] = [],
  inboundEpoch: number,
  alreadyConfirmed = false,
): Promise<void> {
  const send = async (): Promise<void> => {
    // Empty roots is the SSH fail-closed signal from turnRunner. Do not resolve
    // xdt-image / cindy-media URLs or extra absPaths through local media stores.
    const allowLocalMedia = allowLocalMediaRoots(allowedFileRoots);
    const requestedImageUrls = collectXdtImageUrls(text);
    const imageUrls = allowLocalMedia ? requestedImageUrls : [];
    const skippedLocalMedia =
      !allowLocalMedia && (extraImageAbsPaths.length > 0 || requestedImageUrls.length > 0);
    const imageMap = new Map<string, string>();
    const bodyImageAbsPaths = new Set<string>();
    if (imageUrls.length > 0) {
      const results = await Promise.all(
        imageUrls.map(async (url) => {
          let absPath: string;
          try {
            absPath =
              getHost().media?.resolveMediaUrl(url) ??
              resolveFeishuMediaUrl(url, getHost().paths.feishuMediaDir).absPath;
          } catch {
            return null;
          }
          bodyImageAbsPaths.add(absPath);
          try {
            const key = await uploadImage(absPath);
            return key ? ([url, key] as const) : null;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            getLog().warn(
              `[feishu/streamingText] uploadImage inline ${absPath} failed: ${msg}`,
            );
            return null;
          }
        }),
      );
      for (const result of results) {
        if (result) imageMap.set(result[0], result[1]);
      }
      if (!isPinnedAccountCurrent()) return;
    }
    const imageKeys = await uploadExtraImageKeys(
      allowLocalMedia
        ? extraImageAbsPaths.filter((absPath) => !bodyImageAbsPaths.has(absPath))
        : [],
    );
    if (!isPinnedAccountCurrent()) return;
    const fileLinks = collectXdtFileLinks(text);
    const cardText = allowLocalMedia
      ? stripXdtFileLinks(text)
      : stripXdtImageLinks(stripXdtFileLinks(text)).trim();
    const cardTextTrimmed = cardText.trim();
    const hasImages = imageUrls.length > 0 || imageKeys.length > 0;
    const fileOnly = cardTextTrimmed.length === 0 && !hasImages && fileLinks.length > 0;
    if (fileOnly) {
      if (!isPinnedAccountCurrent()) return;
      await sendCardToChat(
        chatId,
        buildMarkdownCardV2(transportMessages.streaming.deliveryFailed),
        mirrorUuid(mirrorKey, 'card'),
      );
      return;
    }
    if (skippedLocalMedia && cardTextTrimmed.length === 0) {
      await sendCardToChat(
        chatId,
        buildMarkdownCardV2(transportMessages.streaming.deliveryFailed),
        mirrorUuid(mirrorKey, 'card'),
      );
      return;
    }
    let card: unknown;
    if (hasImages) {
      card = buildMixedMarkdownCardV2(cardText, imageMap, imageKeys);
    } else {
      card = buildMarkdownCardV2(
        cardTextTrimmed.length > 0 ? cardText : transportMessages.streaming.emptyReply,
      );
    }
    card = fitCardToLimit(cardText, card, (visibleText) =>
      hasImages
        ? buildMixedMarkdownCardV2(visibleText, imageMap, imageKeys)
        : buildMarkdownCardV2(visibleText),
    );
    await sendCardToChat(chatId, card, mirrorUuid(mirrorKey, 'card'));
  };
  await sendOrScheduleMirror(mirrorKey, send, inboundEpoch, alreadyConfirmed);
}
