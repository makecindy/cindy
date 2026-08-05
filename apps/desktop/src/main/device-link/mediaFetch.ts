/**
 * mediaFetch.ts — 被控端处理「入方向媒体取件」(device-link:media:fetch)。
 * ---------------------------------------------------------------------------
 * 控制端要查看被控端会话里的媒体(图片/视频/文件/音频)时,字节在**被控端**本地缓存,
 * relay 帧 2MB 装不下。本模块在被控端把原始媒体 URL 解析成本地绝对路径 → 经 mediaTransfer
 * 上传到 OSS 中转区(明文 + 同账号 key)→ 回 { ossKey, mimeType, size }。控制端凭 ossKey
 * presign-get 直下 / range 流式(见 #23b),bytes 全程不经 relay。
 *
 * 安全:本函数仅由 dispatch.runInvoke 在三道 gate(remoteControlEnabled + 未撤销 + allowlist)
 * 之后调用 —— 调用方已是「同账号 + 显式 opt-in 被控 + 未撤销」的受信控制端。
 * 仅放行 5 个媒体 scheme(4 个 xdt 系 + 媒体总仓 cindy-media)。file/audio
 * 的本机 ?path= 强制绝对路径,且与 xdt-file 协议 handler 共用同一份
 * 敏感目录黑名单(realpath 后校验,并用 realpath 结果关 TOCTOU 窗口);
 * 携带 remoteHostId + workdir 的 SSH 路径则走 file-service workdir 限界与磁盘缓存,
 * 绝不进入被控桌面的本机 realpath。取件 URL 可能来自 agent 渲染的内容,
 * 不能只信控制端意图,两条路径都必须在服务端重新校验边界。
 *
 * 上传去重(仅图片):控制端(手机缩略图 / 桌面查看)可能在短时间窗内对同一 url 反复
 * 取件,而每次取件都是一次真实 OSS 上传。对 xdt-image:// 按 url 缓存上次上传的 ossKey,
 * 源文件 mtime/size 未变且未过 TTL 时直接复用不重传。对象可能已被消费方「用后删」——
 * 消费方拿到悬空 key 下载 404 后带 skipCache 重取即可自愈(手机端 Image onError →
 * forceRefresh;桌面控制端 remoteMediaProtocol 下载失败带 skipCache 重试),故 TTL
 * 保守取 30min,只收敛短时间窗内的重复上传,不追求跨天复用。视频/音频**不**缓存:
 * 其对象被查看器关闭即删,而播放器侧没有自动 skipCache 重试路径,悬空 key 会卡住播放。
 */
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';

import * as imageCacheStore from '../imageCacheStore.js';
import * as videoCacheStore from '../videoCacheStore.js';
import * as cindyMediaBlobStore from '../cindy-media/blobStore.js';
import { getSensitiveMediaBlocklist, isPathAllowedAgainst } from '../filePathPolicy.js';
import { materializeSshRemoteMedia } from '../file-browser/ssh-media.js';
import { getSessionFsSnapshot } from '../localDb/ipc/sessions.js';
import { uploadLocalFile } from './mediaTransfer.js';
import { createLogger } from '../logger.js';

const log = createLogger('device-link:mediaFetch');

const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;

/** 图片上传去重缓存 TTL;过期重传(消费方删对象造成的悬空 key 由 skipCache 重试自愈)。 */
const UPLOAD_CACHE_TTL_MS = 30 * 60 * 1000;
/** 去重缓存条目上限(FIFO 淘汰;条目极小,上限只防长期运行无界增长)。 */
const UPLOAD_CACHE_MAX = 512;

interface UploadCacheEntry {
  ossKey: string;
  mimeType: string;
  size: number;
  statSize: number;
  statMtimeMs: number;
  uploadedAt: number;
}

/** url → 上次上传结果(仅 xdt-image:// 与 cindy-media://,见 cacheable 判定)。 */
const uploadCache = new Map<string, UploadCacheEntry>();

export interface MediaFetchResult {
  /** OSS object key(内嵌 userId);控制端凭此 presign-get。inline 缩略图回包时为空串。 */
  ossKey: string;
  mimeType: string;
  size: number;
  /**
   * 聊天缩略图 inline 回包(仅请求方带 thumbnail:true 且缩图成功时存在):
   * webp 字节 base64,随 invoke 帧直接返回,不经 OSS——省一次「被控端上传 +
   * presign + 控制端下载」整往返(与 file-browser thumbnail op 同取舍)。
   */
  inlineBase64?: string;
}

/** 缩略图最长边:手机聊天气泡最宽 ~360pt@3x≈1080px,1024 足够清晰;点开查看器仍取原图。 */
const THUMB_MAX_EDGE = 1024;
/** 缩略图 webp 质量。 */
const THUMB_WEBP_QUALITY = 80;
/** inline 回包字节上限:超过就退回 OSS 整取路径,别占满 relay 帧预算(~1.8MB)。 */
const THUMB_INLINE_MAX_BYTES = 700 * 1024;
/** 输入文件大小上限:超过不缩直接走原图路径,解码成本失控(对齐 file-browser thumbnail)。 */
const THUMB_INPUT_MAX_BYTES = 48 * 1024 * 1024;
/** 渲染软超时:超时放弃缩图走原图路径,别让病态大图把 invoke 挂住(对齐 file-browser thumbnail)。 */
const THUMB_RENDER_TIMEOUT_MS = 5000;
/** 可缩图的静态图片 mime(gif 动图缩成静帧是语义损失,svg 本身极小,都不缩)。 */
const THUMBNAILABLE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const THUMBNAILABLE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** 缩略图渲染实现(可注入,单测用假实现避免触碰 sharp);null = 放弃走原图路径。 */
export type ChatThumbnailRenderer = (absPath: string) => Promise<Buffer | null>;
let thumbnailRenderer: ChatThumbnailRenderer = renderChatThumbnailSharp;

/** mime(缺省时按扩展名)判断是否值得缩图。 */
function canThumbnail(absPath: string, mimeType: string | undefined): boolean {
  if (mimeType) return THUMBNAILABLE_MIMES.has(mimeType);
  return THUMBNAILABLE_EXTS.has(path.extname(absPath).toLowerCase());
}

// sharp 懒加载:带原生二进制,启动期不加载;不可用则缩略图整体降级走原图路径
// (与 file-browser/thumbnail 同取舍)。
type SharpModule = (typeof import('sharp'))['default'];
let sharpInstance: SharpModule | null = null;
let sharpLoadAttempted = false;
function loadSharp(): SharpModule | null {
  if (sharpLoadAttempted) return sharpInstance;
  sharpLoadAttempted = true;
  try {
    const req: NodeJS.Require =
      typeof require !== 'undefined' ? require : (eval('require') as NodeJS.Require);
    sharpInstance = req('sharp') as SharpModule;
  } catch (err) {
    log.warn('sharp unavailable, chat media thumbnails disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
    sharpInstance = null;
  }
  return sharpInstance;
}

/** 渲染软超时:超时抛错由调用方回退原图路径;后台 sharp 任务跑完即弃,无副作用。 */
async function withRenderTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`thumbnail render timeout after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 默认缩略图渲染:sharp 读盘 → EXIF 转正 → fit-inside 降采样 → webp。 */
async function renderChatThumbnailSharp(absPath: string): Promise<Buffer | null> {
  const sharp = loadSharp();
  if (!sharp) return null;
  return sharp(absPath)
    .rotate()
    .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: THUMB_WEBP_QUALITY })
    .toBuffer();
}

/** 把 ?path= 型 URL(xdt-file / xdt-audio)解析出本地绝对路径(强制绝对,挡相对/逃逸)。 */
function parsePathQuery(url: string): string {
  const p = new URL(url).searchParams.get('path');
  if (!p) throw new Error('媒体 URL 缺少 path');
  if (!(p.startsWith('/') || WIN_ABS_RE.test(p))) {
    throw new Error('媒体 path 必须为绝对路径');
  }
  return path.resolve(p);
}

/**
 * xdt-file/audio URL 上的 SSH 取件上下文。URL 只作声明，真正的 host/workdir
 * 必须按 sessionId 从本地会话库反查，并与 URL 声明逐项一致后才可使用。
 */
async function parseSshMediaOrigin(url: string): Promise<{ remoteHostId: string; workdir: string } | null> {
  const params = new URL(url).searchParams;
  const hasSessionId = params.has('sessionId');
  const hasRemoteHostId = params.has('remoteHostId');
  const hasWorkdir = params.has('workdir');
  if (!hasSessionId && !hasRemoteHostId && !hasWorkdir) return null;

  const sessionId = params.get('sessionId') ?? '';
  const remoteHostId = params.get('remoteHostId') ?? '';
  const workdir = params.get('workdir') ?? '';
  if (!hasSessionId || !hasRemoteHostId || !hasWorkdir
    || !sessionId.trim() || !remoteHostId.trim() || !workdir.trim()) {
    throw new Error('SSH 媒体参数不完整：sessionId、remoteHostId 和 workdir 必须同时提供');
  }

  const snapshot = await getSessionFsSnapshot(sessionId);
  if (!snapshot) throw new Error('SSH 媒体会话不存在');
  const trustedRemoteHostId = snapshot.remoteHostId ?? '';
  const trustedWorkdir = snapshot.workingDir ?? '';
  if (!trustedRemoteHostId.trim() || !trustedWorkdir.trim()) {
    throw new Error('SSH 媒体会话不是有效的 SSH 会话');
  }
  if (remoteHostId !== trustedRemoteHostId || workdir !== trustedWorkdir) {
    throw new Error('SSH 媒体上下文与会话记录不一致');
  }
  return { remoteHostId: trustedRemoteHostId, workdir: trustedWorkdir };
}

/** 原始媒体 URL → { absPath, mimeType? }(按 scheme 选解析器)。 */
function resolveLocalMedia(url: string): { absPath: string; mimeType?: string } {
  if (url.startsWith('xdt-image://')) return imageCacheStore.resolveSafe(url);
  if (url.startsWith('xdt-video://')) return videoCacheStore.resolveSafe(url);
  // cindy-media 内容寻址 blob(统一媒体仓):resolveSafe 自带指纹校验
  // 与仓内前缀双保险,mime 由扩展名白名单定死。
  if (url.startsWith('cindy-media://')) return cindyMediaBlobStore.resolveSafe(url);
  // file/audio 是 ?path= 直引本机文件,mime 交给 uploadLocalFile 按 ext 推断。
  if (url.startsWith('xdt-file://') || url.startsWith('xdt-audio://')) {
    return { absPath: parsePathQuery(url) };
  }
  throw new Error(`不支持的媒体 scheme: ${url.slice(0, 24)}`);
}

/** 命中条件:未过 TTL 且源文件 mtime/size 与上传时一致(文件被覆写即失效)。 */
function lookupUploadCache(
  url: string,
  statSize: number,
  statMtimeMs: number,
  now: number,
): UploadCacheEntry | null {
  const hit = uploadCache.get(url);
  if (!hit) return null;
  if (now - hit.uploadedAt >= UPLOAD_CACHE_TTL_MS
    || hit.statSize !== statSize
    || hit.statMtimeMs !== statMtimeMs) {
    uploadCache.delete(url);
    return null;
  }
  return hit;
}

function rememberUpload(url: string, entry: UploadCacheEntry): void {
  uploadCache.delete(url); // 重插保持 Map 迭代序 = 插入序,FIFO 淘汰最旧
  uploadCache.set(url, entry);
  while (uploadCache.size > UPLOAD_CACHE_MAX) {
    const oldest = uploadCache.keys().next().value;
    if (oldest === undefined) break;
    uploadCache.delete(oldest);
  }
}

/**
 * 被控端处理 device-link:media:fetch:解析本机媒体 → 上传 OSS → 返回引用。
 * @param arg invoke 首个参数,形如 { url: string, skipCache?: boolean, thumbnail?: boolean }。
 *   skipCache:消费方发现上次的 ossKey 已悬空(对象被删)时带上,强制绕过去重缓存重传。
 *   thumbnail:控制端只要聊天列表缩略图时带上——静态图片缩到 1024px webp 随
 *   invoke 帧 inline 返回(不经 OSS);不可缩(gif/svg/解码失败/超限)自动退回原图路径。
 *   老被控端不识别该字段,自然回落原图 ossKey,控制端两种回包都要兼容。
 */
export async function fetchLocalMediaToOss(arg: unknown): Promise<MediaFetchResult> {
  const record = arg && typeof arg === 'object'
    ? arg as { url?: unknown; skipCache?: unknown; thumbnail?: unknown }
    : {};
  const url = record.url;
  if (typeof url !== 'string' || !url) throw new Error('media:fetch 缺少 url');
  const skipCache = record.skipCache === true;
  const isPathMedia = url.startsWith('xdt-file://') || url.startsWith('xdt-audio://');
  const sshOrigin = isPathMedia ? await parseSshMediaOrigin(url) : null;
  let absPath: string;
  let mimeType: string | undefined;
  if (sshOrigin) {
    const materialized = await materializeSshRemoteMedia(sshOrigin, url);
    if (!materialized.ok) {
      throw new Error(`SSH 媒体取回失败（${materialized.status}）：${materialized.message}`);
    }
    absPath = materialized.cachePath;
    mimeType = materialized.mime;
  } else {
    ({ absPath, mimeType } = resolveLocalMedia(url));
  }
  // For file/audio schemes the requested URL path carries the semantic
  // extension; if it resolves through a symlink whose target has a different
  // (or no) extension, uploads must still name/type by the requested ext so
  // OSS Content-Type stays correct and streaming isn't broken. Captured before
  // absPath is reassigned to the realpath below.
  let uploadExtHint: string | undefined;

  // ?path= 直引任意本机路径的 scheme(file/audio)必须过与 xdt-file 协议
  // handler 同一份敏感目录黑名单;xdt-image/xdt-video 解析自 app 缓存目录,
  // 由 resolveSafe 保证不出缓存根,无需重复校验。realpath 先行(挡 symlink
  // 逃逸),其结果用于后续 stat/上传(关 check→open 的 TOCTOU 窗口)。
  if (isPathMedia && !sshOrigin) {
    // 字面路径 blocklist 先查(在 realpath 之前):敏感请求路径确定性拒绝,
    // 不因 realpath 的权限失败(EACCES/EPERM)漏判(同 xdt-file/xdt-audio handler)。
    if (!isPathAllowedAgainst(absPath, getSensitiveMediaBlocklist())) {
      log.warn(`media:fetch blocked sensitive path ${url.slice(0, 60)}`);
      throw new Error('该路径位于敏感目录,已阻止远程取件');
    }
    let real: string;
    try {
      real = await realpath(absPath);
    } catch {
      throw new Error('媒体文件不存在或不可读');
    }
    // realpath 再查:挡字面形式看似无害的 symlink 逃逸。
    if (!isPathAllowedAgainst(real, getSensitiveMediaBlocklist())) {
      log.warn(`media:fetch blocked sensitive realpath ${url.slice(0, 60)}`);
      throw new Error('该路径位于敏感目录,已阻止远程取件');
    }
    // 语义扩展名取请求路径(absPath 此时仍是请求路径),再切到 realpath 读字节。
    uploadExtHint = path.extname(absPath);
    absPath = real;
  }

  if (record.thumbnail === true && canThumbnail(absPath, mimeType)) {
    try {
      // 输入体量护栏:病态大图(> 48MB)解码成本失控,直接放弃缩图走原图路径;
      // 渲染再包 5s 软超时,超时同样回退,不让单次 invoke 被 sharp 挂住
      // (对齐 file-browser thumbnail 的同款护栏)。
      const inputStat = await stat(absPath);
      if (inputStat.size > 0 && inputStat.size <= THUMB_INPUT_MAX_BYTES) {
        const thumb = await withRenderTimeout(thumbnailRenderer(absPath), THUMB_RENDER_TIMEOUT_MS);
        if (thumb && thumb.byteLength > 0 && thumb.byteLength <= THUMB_INLINE_MAX_BYTES) {
          log.debug(`media:fetch thumb ${url.slice(0, 40)} → inline ${thumb.byteLength}B`);
          return {
            ossKey: '',
            mimeType: 'image/webp',
            size: thumb.byteLength,
            inlineBase64: thumb.toString('base64'),
          };
        }
      }
    } catch (err) {
      log.warn('chat thumbnail render failed, fallback to full image', {
        error: err instanceof Error ? err.message : String(err),
        url: url.slice(0, 60),
      });
    }
    // 缩不动(输入超限/产物超限/超时/失败)→ 继续走下面的原图上传路径。
  }

  // cindy-media 地址=内容指纹,永不变更,是最理想的上传去重键。
  const cacheable = url.startsWith('xdt-image://') || url.startsWith('cindy-media://');
  let st: { size: number; mtimeMs: number } | null = null;
  if (cacheable) {
    st = await stat(absPath);
    if (!skipCache) {
      const hit = lookupUploadCache(url, st.size, st.mtimeMs, Date.now());
      if (hit) {
        log.debug(`media:fetch cache hit ${url.slice(0, 40)} → ossKey=${hit.ossKey}`);
        return { ossKey: hit.ossKey, mimeType: hit.mimeType, size: hit.size };
      }
    }
  }

  const uploaded = await uploadLocalFile(absPath, {
    ...(mimeType ? { contentType: mimeType } : {}),
    ...(uploadExtHint ? { extHint: uploadExtHint } : {}),
  });
  if (cacheable && st) {
    rememberUpload(url, {
      ossKey: uploaded.key,
      mimeType: uploaded.contentType,
      size: uploaded.size,
      statSize: st.size,
      statMtimeMs: st.mtimeMs,
      uploadedAt: Date.now(),
    });
  }
  log.debug(`media:fetch ${url.slice(0, 40)} → ossKey=${uploaded.key} size=${uploaded.size}`);
  return { ossKey: uploaded.key, mimeType: uploaded.contentType, size: uploaded.size };
}

export const __testing = {
  resolveLocalMedia,
  parsePathQuery,
  parseSshMediaOrigin,
  uploadCache,
  UPLOAD_CACHE_TTL_MS,
  UPLOAD_CACHE_MAX,
  THUMB_INLINE_MAX_BYTES,
  THUMB_INPUT_MAX_BYTES,
  THUMB_RENDER_TIMEOUT_MS,
  /** 单测注入假缩略图渲染;传 null 还原 sharp 默认实现。 */
  setThumbnailRenderer(renderer: ChatThumbnailRenderer | null): void {
    thumbnailRenderer = renderer ?? renderChatThumbnailSharp;
  },
};
