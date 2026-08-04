/**
 * 文件浏览 → ImageLightbox(聊天同款图片查看器)的桥接。
 *
 * 统一决策(2026-07-04 产品):图片文件不再走 Quick Look 预览页,直接进
 * ImageLightbox,与聊天看图同一套体验(左右滑/捏合缩放/下拉关闭/分享)。
 * 做法:把目录里的图片文件包装成 `xdt-file://open?path=<绝对路径>` 的
 * gallery 项(previewable:false)——这是被控端媒体取件通道原生认可的 scheme,
 * lightbox 经 onResolveRemoteMedia 走「取件上传 OSS → presign」既有管线拿到
 * 可显示 URL,对老版本被控端同样生效,零新协议。
 */
import { i18n } from '@/i18n';
import { buildMediaPayload } from '@/session/messagePayload';
import type { MobileMessageGalleryImage } from '@/session/messageGallery';
import {
  isResolvedRemoteMediaFresh,
  resolveMobileRemoteMedia,
  type MobileRemoteMediaResolverDeps,
  type MobileResolvedRemoteMedia,
  type ResolveRemoteMediaFn,
} from '@/session/remoteMedia';
import type { FileBrowserGridItem } from '@/session/fileBrowserGrid';

/**
 * 远程文件的媒体取件 URL(被控端 mediaFetch 的 parsePathQuery 消费,只读
 * `path` 参数)。`v`(文件 mtime)仅用于让 URL 随文件版本变化:同路径文件被
 * 覆写后,以 URL 为 key 的手机端 resolver 缓存自然失效,不会复用旧图;被控端
 * 忽略该参数,新老版本均兼容。
 */
/**
 * SSH 远程工作区的取件上下文。被控端 parseSshMediaOrigin 要求 sessionId /
 * remoteHostId / workdir **三者同时提供**,并按 sessionId 反查本地会话库逐项比对后
 * 才使用 —— 缺项直接抛错,少给一项等于取件必失败。
 */
export interface RemoteMediaSshContext {
  sessionId: string;
  remoteHostId: string;
  workdir: string;
}

/**
 * 三项齐备(trim 后非空)才算有效上下文,与被控端 parseSshMediaOrigin 的完整性要求同口径。
 *
 * **URL 构造与取件缓存键必须共用这一份判定**(review P2 实捉):此前 URL 侧要求「三项 trim
 * 后均非空」,而 fetchRemoteAbsFileToUrl 的缓存键只看 `ssh` 对象是否存在就无条件拼接三个
 * 字段 —— 调用方误传 `{sessionId:'', …}` 时 URL 退化成不带 SSH 参数(按本机路径取件),
 * 缓存键却被这些空字段区分开,同一次取件永远命中不了缓存,白发请求。
 */
export function effectiveRemoteMediaSshContext(
  ssh: RemoteMediaSshContext | null | undefined,
): RemoteMediaSshContext | null {
  if (!ssh) return null;
  const sessionId = ssh.sessionId.trim();
  const remoteHostId = ssh.remoteHostId.trim();
  const workdir = ssh.workdir.trim();
  if (!sessionId || !remoteHostId || !workdir) return null;
  return { sessionId, remoteHostId, workdir };
}

function sshContextQuery(ssh: RemoteMediaSshContext | null | undefined): string {
  const eff = effectiveRemoteMediaSshContext(ssh);
  if (!eff) return '';
  return `&sessionId=${encodeURIComponent(eff.sessionId)}`
    + `&remoteHostId=${encodeURIComponent(eff.remoteHostId)}`
    + `&workdir=${encodeURIComponent(eff.workdir)}`;
}

/**
 * 取件的**服务端强制约束**(被控端 mediaFetch 消费,不是手机端的自我约束)。
 *
 * 为什么必须由被控端强制:手机侧的词法校验与下载后判断都晚于「被控端 stat → 上传 OSS
 * (SSH 场景还要先整份拉到 Desktop 磁盘缓存)」,一份不可信 HTML 引用一个 2 GB 的
 * `.css` 就能在手机看到 `media.size` 之前打出数 GB 的磁盘/网络/OSS 流量(review P2)。
 *
 * **版本歪斜是 fail-open**:老被控端不认这两个参数会照旧取件,约束等于不生效。这不构成
 * 回退(它今天本来就没有这两道校验),但手机侧的既有判断必须全部保留作第二道。
 */
export interface RemoteMediaFetchConstraints {
  /**
   * 资源必须落在这个目录内。被控端对**资源与该目录双方各自 realpath 后**判定包含关系,
   * 目的是挡住「产物目录内有一个指向目录外的软链」这条绕过(词法 `..` 校验挡不住它)。
   */
  baseDir?: string;
  /** 字节上限。被控端在 stat 之后、上传/拉取之前拒绝,不让超限文件产生任何流量。 */
  maxBytes?: number;
}

function constraintsQuery(c: RemoteMediaFetchConstraints | null | undefined): string {
  if (!c) return '';
  let q = '';
  const baseDir = c.baseDir?.trim();
  if (baseDir) q += `&baseDir=${encodeURIComponent(baseDir)}`;
  if (Number.isFinite(c.maxBytes) && (c.maxBytes as number) > 0) {
    q += `&maxBytes=${Math.floor(c.maxBytes as number)}`;
  }
  return q;
}

export function remoteFileMediaUrl(
  absPath: string,
  versionMs?: number,
  /**
   * SSH 会话必须带上,否则被控端会把 absPath 当**本机**路径交给 realpath:
   * 取件失败,而被控桌面恰有同名路径时还会读到错误来源(review P2 实捉)。
   * 本机会话传 null / 省略。
   */
  ssh?: RemoteMediaSshContext | null,
  /** 服务端强制约束(HTML 资源透传专用;普通媒体取件省略)。 */
  constraints?: RemoteMediaFetchConstraints | null,
): string {
  const base = `xdt-file://open?path=${encodeURIComponent(absPath)}`;
  const withSsh = `${base}${sshContextQuery(ssh)}${constraintsQuery(constraints)}`;
  return versionMs ? `${withSsh}&v=${versionMs}` : withSsh;
}

/** 当前目录的图片文件 → lightbox gallery(顺序与网格排序一致)。 */
export function buildFileBrowserGalleryImages(
  items: readonly FileBrowserGridItem[],
  absolutePathOf: (relPath: string) => string,
): MobileMessageGalleryImage[] {
  const images: MobileMessageGalleryImage[] = [];
  for (const item of items) {
    if (item.kind !== 'file' || item.thumb !== 'image') continue;
    const url = remoteFileMediaUrl(absolutePathOf(item.relPath), item.mtimeMs);
    const payload = buildMediaPayload(
      { kind: 'image', url, title: item.name, previewable: false },
      item.name,
    );
    if (payload.kind !== 'media') continue;
    images.push({ key: item.key, title: item.name, url, payload, subtitle: item.metaLabel || undefined });
  }
  return images;
}

/**
 * 文件浏览专用的媒体解析器:复用聊天媒体的 resolveMobileRemoteMedia,外加
 * 一层按 URL 的新鲜度缓存(presign 未过期不重取;文件浏览没有消息队列那套
 * resolve queue,这层小缓存补上重开 lightbox 不重导出的语义)。
 */
export function createFileBrowserMediaResolver(deps: MobileRemoteMediaResolverDeps): ResolveRemoteMediaFn {
  const cache = new Map<string, MobileResolvedRemoteMedia>();
  return async (media, opts) => {
    const cached = cache.get(media.url);
    if (cached && !opts?.forceRefresh && isResolvedRemoteMediaFresh(cached)) return cached;
    // cachedOnly(lightbox 垫底预取):只吃缓存,未命中不触发取件——本 resolver 不区分
    // 缩略图变体,放行会变成一次装饰性的整图导出+下载,与主取件叠成双下载。
    if (opts?.cachedOnly) throw new Error(i18n.t('files.gallery.cacheMiss'));
    // forceRefresh(Image 加载失败自愈)映射为被控端 skipCache,穿透上传去重缓存。
    const resolved = await resolveMobileRemoteMedia(media, deps, opts?.forceRefresh ? { skipCache: true } : undefined);
    cache.set(media.url, resolved);
    return resolved;
  };
}
