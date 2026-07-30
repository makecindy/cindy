import type { NormalizedToolMedia } from '@/session/messageNormalize';
import {
  isPayloadDesktopLocalMediaUrl,
  isPayloadDirectPreviewableUrl,
} from '@cindy/maker-shared/payload-summary';
import { i18n } from '@/i18n';

const EXPIRY_SAFETY_WINDOW_MS = 60 * 1000;

export interface MobileRemoteMediaFetchResult {
  /** inline 缩略图回包(新被控端)时为空串。 */
  ossKey: string;
  mimeType: string;
  size: number;
  /** 被控端缩好的缩略图字节(base64,thumbnail 请求且被控端支持时才有)。 */
  inlineBase64?: string;
}

export interface MobileRemoteMediaPresignResult {
  getUrl: string;
  expiresAt: string;
}

export interface MobileResolvedRemoteMedia {
  url: string;
  /** inline 缩略图 / 本地磁盘缓存命中没有在世 OSS 对象,为空串(退屏清理跳过 DELETE)。 */
  ossKey: string;
  mimeType: string;
  size: number;
  expiresAt: string;
  previewable: boolean;
  /** inline 缩略图的原始字节(base64),供宿主写入磁盘缓存;消费端渲染用 url 即可。 */
  inlineBase64?: string;
}

export interface MobileRemoteMediaResolverDeps {
  fetchRemoteMedia(url: string, opts?: { skipCache?: boolean; thumbnail?: boolean }): Promise<MobileRemoteMediaFetchResult>;
  presignGet(ossKey: string): Promise<MobileRemoteMediaPresignResult>;
}

export interface MobileRemoteMediaResolveOptions {
  /** 强制被控端绕过上传去重缓存(上次的 ossKey 已悬空时的自愈路径)。 */
  skipCache?: boolean;
  /** 只要聊天列表缩略图:被控端缩 1024px webp inline 回包;老被控端回落原图。 */
  thumbnail?: boolean;
}

/** inline 缩略图没有 presign 过期语义,给个远未来的过期时间(本地字节不过期)。 */
export const REMOTE_MEDIA_NEVER_EXPIRES = '9999-12-31T00:00:00.000Z';

/**
 * UI 层远程媒体取件回调:缩略图懒取件传 signal(滚出队列可取消)+ thumbnail
 * (被控端只回缩略图),查看器传 front(插队,取原图),Image 加载失败重试传
 * forceRefresh(跳过各级缓存)。thumbnail 与非 thumbnail 的取件在队列/缓存层
 * 按不同键隔离,查看器取原图不会命中缩略图缓存。
 */
export type ResolveRemoteMediaFn = (
  media: Pick<NormalizedToolMedia, 'kind' | 'url' | 'previewable'> & { thumbnail?: boolean },
  opts?: { front?: boolean; signal?: AbortSignal; forceRefresh?: boolean; cachedOnly?: boolean },
) => Promise<MobileResolvedRemoteMedia>;

export function isDesktopLocalMediaUrl(url: unknown): url is string {
  return isPayloadDesktopLocalMediaUrl(url);
}

export function isDirectPreviewableMediaUrl(url: unknown): url is string {
  return isPayloadDirectPreviewableUrl(url);
}

export function canPreviewResolvedRemoteMedia(
  kind: NormalizedToolMedia['kind'],
  mimeType: string,
): boolean {
  if (kind === 'image') return mimeType.startsWith('image/');
  if (kind === 'video') return mimeType.startsWith('video/');
  if (kind === 'audio') return mimeType.startsWith('audio/');
  return false;
}

/**
 * 原图落盘成功后的条目升级:把渲染地址从 presign OSS 换成本地 file://。
 *
 * 为什么必须换:presign 地址在有效期内会被取件队列当 fresh 缓存命中反复复用,
 * 同键请求再也不会重进磁盘 lookup,于是每次点开查看器都从 OSS 重新拉整张原图
 * (用户实测「已经打开过原图,关闭再打开又从黑屏开始」),盘上那份副本永远轮不
 * 到用。换成本地文件后再次点开零网络秒出。
 *
 * 升级是**事件驱动**的(落盘完成后经 RemoteMediaResolveHooks 回写队列缓存),不让
 * 调用方同步等待落盘——取件队列并发上限只有 2 且看不到 front,同步等待会让相邻页
 * 预取占住槽位,把用户正在看的那张饿住(PR #1125 review)。
 *
 * ossKey 必须保留:OSS 对象仍在世,退屏清理要靠它 DELETE(空 key 才跳过),队列也
 * 靠它识别「升级迟到、对象已被 forceRefresh 换掉」并丢弃本次升级。
 * hit 为空(落盘被跳过 / 失败)或 mime 不是图片时返回 null,由调用方放弃升级。
 */
export function localCopyResolvedMedia(
  resolved: MobileResolvedRemoteMedia,
  hit: { uri: string; mimeType: string; size: number } | null | undefined,
): MobileResolvedRemoteMedia | null {
  if (!hit || !hit.uri || !hit.mimeType.startsWith('image/')) return null;
  return {
    url: hit.uri,
    ossKey: resolved.ossKey,
    mimeType: hit.mimeType,
    size: hit.size,
    // 本地文件不过期;被 LRU/OS 清掉时 Image onError → forceRefresh 重取自愈。
    expiresAt: REMOTE_MEDIA_NEVER_EXPIRES,
    previewable: true,
  };
}

export function isResolvedRemoteMediaFresh(
  media: Pick<MobileResolvedRemoteMedia, 'expiresAt'>,
  now = Date.now(),
): boolean {
  const expiresAt = Date.parse(media.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - now > EXPIRY_SAFETY_WINDOW_MS;
}

export async function resolveMobileRemoteMedia(
  media: Pick<NormalizedToolMedia, 'kind' | 'url'>,
  deps: MobileRemoteMediaResolverDeps,
  opts?: MobileRemoteMediaResolveOptions,
): Promise<MobileResolvedRemoteMedia> {
  if (!isDesktopLocalMediaUrl(media.url)) {
    throw new Error(i18n.t('composer.attachments.notFetchableMedia'));
  }
  const fetchOpts = {
    ...(opts?.skipCache ? { skipCache: true } : {}),
    ...(opts?.thumbnail ? { thumbnail: true } : {}),
  };
  const fetched = await deps.fetchRemoteMedia(
    media.url,
    Object.keys(fetchOpts).length > 0 ? fetchOpts : undefined,
  );
  // inline 缩略图回包:字节已随 invoke 帧到手,无 OSS 对象,跳过 presign。
  // url 先给 data URI 保证任何情况下可渲染;宿主(会话屏)会把字节落盘并换成 file://。
  if (isValidInlineResult(fetched)) {
    return {
      url: `data:${fetched.mimeType};base64,${fetched.inlineBase64}`,
      ossKey: '',
      mimeType: fetched.mimeType,
      size: fetched.size,
      expiresAt: REMOTE_MEDIA_NEVER_EXPIRES,
      previewable: canPreviewResolvedRemoteMedia(media.kind, fetched.mimeType),
      inlineBase64: fetched.inlineBase64,
    };
  }
  if (!isValidFetchResult(fetched)) {
    throw new Error(i18n.t('composer.attachments.mediaResultInvalid'));
  }
  const signed = await deps.presignGet(fetched.ossKey);
  if (!isValidPresignResult(signed)) {
    throw new Error(i18n.t('composer.attachments.mediaUrlInvalid'));
  }
  return {
    url: signed.getUrl,
    ossKey: fetched.ossKey,
    mimeType: fetched.mimeType,
    size: fetched.size,
    expiresAt: signed.expiresAt,
    previewable: canPreviewResolvedRemoteMedia(media.kind, fetched.mimeType),
  };
}

export function formatRemoteMediaSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** inline 缩略图回包有效性:字节 + 图片 mime + 正数 size 齐备才算。 */
function isValidInlineResult(value: MobileRemoteMediaFetchResult): value is MobileRemoteMediaFetchResult & { inlineBase64: string } {
  return (
    !!value
    && typeof value.inlineBase64 === 'string'
    && value.inlineBase64.length > 0
    && typeof value.mimeType === 'string'
    && value.mimeType.startsWith('image/')
    && typeof value.size === 'number'
    && Number.isFinite(value.size)
    && value.size > 0
  );
}

function isValidFetchResult(value: MobileRemoteMediaFetchResult): boolean {
  return (
    !!value
    && typeof value.ossKey === 'string'
    && value.ossKey.length > 0
    && typeof value.mimeType === 'string'
    && value.mimeType.length > 0
    && typeof value.size === 'number'
    && Number.isFinite(value.size)
    && value.size > 0
  );
}

function isValidPresignResult(value: MobileRemoteMediaPresignResult): boolean {
  return (
    !!value
    && typeof value.getUrl === 'string'
    && value.getUrl.startsWith('http')
    && typeof value.expiresAt === 'string'
    && Number.isFinite(Date.parse(value.expiresAt))
  );
}
