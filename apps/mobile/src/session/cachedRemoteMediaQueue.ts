/**
 * 带手机磁盘缓存的远程媒体取件队列(会话页与伙伴群聊共用)。
 * ---------------------------------------------------------------------------
 * 取件队列(remoteMediaResolveQueue)只做同屏去重和并发上限,结果随页面释放;本模块在它
 * 前后接上磁盘缓存:取件前先查本地,取到后把缩略图字节/原图落盘,之后同一张图在任何
 * 页面、任何一次启动都直接用本地 file:// 显示,不再让电脑重新压图或上传。
 *
 * 磁盘缓存是**全 App 单例**:所有实例共用同一个目录和 index.json,且初始化时会删除
 * 「index 里没有的文件」——两个实例各自持有一份 index,会把对方刚写入的文件当孤儿删掉,
 * 后写的 index 也会覆盖先写的。所以不能每个页面各建一份。
 *
 * 磁盘键按「账号 + 电脑 + 地址」分空间:电脑 id 跨登录存续、缓存目录登出不清,只用地址
 * 会把上一账号/另一台电脑的同名图当命中。缩略图与原图分键;缩不了图回落原图时落裸键,
 * 缩略图查找带裸键兜底。
 */
import type { AuthContextValue } from '@/auth/AuthContext';
import { PEER_FILE_DISK_RESERVE_BYTES } from '@/device-link/peerFileRegistry';
import { deviceLinkMediaApiBaseUrl } from '@/device-link/selfHostedRelayRouting';
import {
  REMOTE_MEDIA_NEVER_EXPIRES,
  cacheInlineRemoteMedia,
  localCopyResolvedMedia,
  resolveMobileRemoteMedia,
  type MobileRemoteMediaPresignResult,
  type MobileRemoteMediaResolverDeps,
  type MobileResolvedRemoteMedia,
} from './remoteMedia';
import { createRemoteMediaDiskCache, type RemoteMediaDiskCache } from './remoteMediaDiskCache';
import {
  createRemoteMediaResolveQueue,
  type RemoteMediaResolveQueue,
  type RemoteMediaResolveQueueOptions,
} from './remoteMediaResolveQueue';

let sharedDiskCache: Promise<RemoteMediaDiskCache> | null = null;

/**
 * 远程图片/视频的全 App 共用磁盘缓存(见文件头:不能多实例)。
 * 首次取件时才加载 expo 文件系统:群聊时间线组件被很多界面复用,静态引入会让只渲染
 * 不取件的地方也去加载原生模块。
 */
export function sharedRemoteMediaDiskCache(): Promise<RemoteMediaDiskCache> {
  sharedDiskCache ??= Promise.all([import('expo-file-system'), import('./remoteMediaDiskCacheExpo')])
    .then(([{ Paths }, { createExpoRemoteMediaDiskCacheIO }]) => createRemoteMediaDiskCache(createExpoRemoteMediaDiskCacheIO(), {
      availableBytes: () => Paths.availableDiskSpace,
      reserveBytes: PEER_FILE_DISK_RESERVE_BYTES,
      // Preserve manual image retention; only the new regenerable video copies
      // join pressure cleanup, with mounted players holding a protection lease.
      canEvict: (mimeType) => mimeType.startsWith('video/'),
    }));
  sharedDiskCache.catch(() => { sharedDiskCache = null; });
  return sharedDiskCache;
}

/** 磁盘缓存源键:账号 + 电脑 + 地址(见文件头)。 */
export function remoteMediaDiskSource(userId: string | null | undefined, deviceId: string | null | undefined, url: string): string {
  return `${userId || 'unknown-user'}\u0000${deviceId || 'unknown-device'}\u0000${url}`;
}

export interface CachedRemoteMediaDeps {
  fetchRemoteMedia: MobileRemoteMediaResolverDeps['fetchRemoteMedia'];
  apiFetch: AuthContextValue['apiFetch'];
  /** 当前账号与电脑下的磁盘键;取件开始时同步捕获(见 resolve 内注释)。 */
  diskSource(url: string): string;
}

export interface CachedRemoteMediaQueue {
  queue: RemoteMediaResolveQueue;
  /** 释放队列并删除本队列取件留下的中转对象(仍在落盘的等落盘结束再删)。 */
  releaseAll(): void;
}

export function createCachedRemoteMediaQueue(
  current: () => CachedRemoteMediaDeps,
  queueOptions: RemoteMediaResolveQueueOptions = {},
): CachedRemoteMediaQueue {
  // 后台落盘中的 ossKey → store promise:DELETE 该 key 前先等对应落盘结束,
  // 避免「离开前最后取件成功的图」store 下载撞上 DELETE 404、白丢缓存下次又要电脑重传。
  const pendingDiskStores = new Map<string, Promise<unknown>>();
  // DELETE 一个已取件的 OSS 对象;若其字节仍在后台落盘,等落盘结束(成败皆可)再删。
  const deleteObject = (media: MobileResolvedRemoteMedia) => {
    if (!media.ossKey) return; // 磁盘缓存命中 / inline 缩略图没有在世 OSS 对象
    const doDelete = (): void => {
      void current().apiFetch('/api/device-link/media', {
        baseUrl: deviceLinkMediaApiBaseUrl(media.ossKey),
        method: 'DELETE',
        body: { key: media.ossKey },
      }).catch(() => undefined);
    };
    const pending = pendingDiskStores.get(media.ossKey);
    if (pending) void pending.then(doDelete, doDelete);
    else doDelete();
  };

  const queue = createRemoteMediaResolveQueue({
    resolve: async (media, opts, hooks) => {
      const deps = current();
      // 命名空间键与 deps 同一时刻捕获(首个 await 之前):切设备/账号时在飞的
      // 取件按旧 deps 取到的字节必须落进旧命名空间,await 之后再算键会把上一
      // 设备/账号的图写进新命名空间、之后被当命中返回。
      // 缩略图与原图是同 url 的不同产物,磁盘键同样分离(与取件队列的分键一致);
      // 但「回落原图」(gif/svg/老被控端缩不了图)一律落裸键(见下),因此缩略图
      // 查找带裸键兜底——原图字节既已在盘上,缩略图直接用它,不再二次下载。
      const bareDiskSource = deps.diskSource(media.url);
      const diskSource = (media.thumbnail ? 'thumb\u0000' : '') + bareDiskSource;
      // 缓存只是优化:加载失败照常取件,只是不落盘。
      const diskCache = await sharedRemoteMediaDiskCache().catch(() => null);
      if (media.kind === 'image' && !opts?.skipCache && diskCache) {
        const hit =
              (await diskCache.lookup(diskSource).catch(() => null))
          ?? (media.thumbnail ? await diskCache.lookup(bareDiskSource).catch(() => null) : null);
        if (hit) {
          return {
            url: hit.uri,
            // 本地缓存命中没有对应的在世 OSS 对象;空 ossKey 让退屏清理跳过 DELETE。
            ossKey: '',
            mimeType: hit.mimeType,
            size: hit.size,
            // 本地文件不过期;若被 LRU/OS 清掉,Image onError → forceRefresh 重取自愈。
            expiresAt: REMOTE_MEDIA_NEVER_EXPIRES,
            previewable: hit.mimeType.startsWith('image/'),
          };
        }
      }
      let retainedImage = false;
      const resolved = await resolveMobileRemoteMedia(media, {
        fetchRemoteMedia: deps.fetchRemoteMedia,
        ...(diskCache ? { retainLocalImage: async (image: MobileResolvedRemoteMedia) => {
          const stored = await diskCache.store(bareDiskSource, image.url, image.mimeType, image.size);
          const copy = stored ? await diskCache.lookup(bareDiskSource) : null;
          if (!copy) throw new Error('IMAGE_CACHE_FAILED');
          retainedImage = true;
          return { ...image, url: copy.uri, expiresAt: REMOTE_MEDIA_NEVER_EXPIRES };
        } } : {}),
        ...(diskCache ? { retainLocalVideo: async (video: MobileResolvedRemoteMedia) => {
          const stored = await diskCache.store(bareDiskSource, video.url, video.mimeType, video.size);
          const copy = stored ? await diskCache.lookup(bareDiskSource) : null;
          if (!copy) throw new Error('VIDEO_CACHE_FAILED');
          return { ...video, url: copy.uri, expiresAt: REMOTE_MEDIA_NEVER_EXPIRES,
            protectLocalFile: () => diskCache.protect(bareDiskSource) };
        } } : {}),
        presignGet: (ossKey) => deps.apiFetch<MobileRemoteMediaPresignResult>(
          '/api/device-link/media/presign-get',
          { baseUrl: deviceLinkMediaApiBaseUrl(ossKey), method: 'POST', body: { key: ossKey } },
        ),
      }, { ...opts, ...(media.thumbnail ? { thumbnail: true } : {}) });
      if (resolved.inlineBase64 && diskCache) {
        return cacheInlineRemoteMedia(media.kind, resolved, diskCache, diskSource);
      }
      if (media.kind === 'image' && resolved.previewable && diskCache && !retainedImage) {
        // 登记落盘 promise(按 ossKey):退屏 DELETE 会先等它结束再删对象。
        // 传 size:超出缓存预算的对象直接跳过落盘,不白下载整个对象。
        // 走到这里的都是完整原图字节(inline 缩略图已在上面 return):即便请求方
        // 要的是缩略图(被控端缩不了回落原图),也落**裸键**——查看器后续按裸键
        // 取原图直接磁盘命中,不再对同一张原图二次下载、双份落盘。
        const store = diskCache.store(bareDiskSource, resolved.url, resolved.mimeType, resolved.size)
          .catch(() => false);
        if (resolved.ossKey) {
          const key = resolved.ossKey;
          pendingDiskStores.set(key, store.finally(() => {
            pendingDiskStores.delete(key);
          }));
        }
        // 落盘成功后把队列缓存条目升级成本地 file://:presign 地址会被队列当 fresh
        // 结果缓存,在有效期内同键请求一律直接命中它、再也不会重进磁盘 lookup,
        // 于是「已经打开过的原图,关掉再打开又从 OSS 重下一整张」,盘上那份副本
        // 永远轮不到用(用户实测 + PR #1125 review)。
        // 这里刻意**不同步等待**落盘:调用方立即拿到可渲染的 presign 地址。取件队列
        // maxConcurrent=2 且看不到 front,同步等待会让查看器的相邻页预取同样
        // 占住槽位,把用户正在看的那张排到已翻过去的图的后台下载之后。
        // store 的返回值是「本次是否真的写入了新字节」:超预算跳过 / 下载失败(现存
        // 同名旧文件被刻意保留)/ 落成 0 字节都为 false,此时绝不能改用本地文件——
        // 否则会把**已被 onError 证伪的旧文件**当本次结果并标成永不过期。
        void store
          .then(async (stored) => {
            if (!stored) return;
            const hit = await diskCache.lookup(bareDiskSource).catch(() => null);
            const local = localCopyResolvedMedia(resolved, hit);
            if (local) hooks?.onLocalCopy(local);
          })
          .catch(() => undefined);
      }
      return resolved;
    },
    // 退屏后才完成的 in-flight 取件:缓存已被 releaseAll 清空接管不到,这里直接
    // 补 DELETE,避免「退出时正在取件」的对象漏出退屏统一清理悬到生命周期兜底。
    onOrphanResolved: deleteObject,
  }, queueOptions);

  return {
    queue,
    releaseAll: () => {
      for (const media of queue.releaseAll()) deleteObject(media);
    },
  };
}
