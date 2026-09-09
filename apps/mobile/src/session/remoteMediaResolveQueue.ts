/**
 * remoteMediaResolveQueue.ts — 远程媒体取件队列(会话屏实例级)。
 * ---------------------------------------------------------------------------
 * 聊天列表缩略图懒取件后,同屏可能有大量 xdt-image:// 图片同时请求取件,而每次
 * 取件都会让桌面端真实上传一次 OSS(见 desktop mediaFetch.ts,无按 url 去重)。
 * 本模块在手机端收敛这条链路:
 *
 *   - 同 url 去重:并发 request 共享同一个 in-flight promise,只触发一次桌面上传;
 *   - 并发上限:同时 in-flight 的取件数受 maxConcurrent 限制,其余排队(FIFO,
 *     payload 查看器可用 front:true 插队头,保证用户主动点开的图优先);
 *   - 结果缓存:resolve 成功写缓存,fresh(presign 未过期)命中直接返回;
 *   - 负缓存:失败后 errorTtlMs 内同 url 直接拒绝,防止桌面离线时列表滚动
 *     造成风暴式重试;forceRefresh(用户显式重试 / 加载失败自愈)穿透并清除
 *     负缓存——防风暴只压制被动重试,不压制主动动作;
 *   - 排队取消:signal abort 只移除「仍在排队且无其他等待者」的条目;已 in-flight
 *     的任其完成并写缓存(桌面端上传已经发生,结果不该浪费)。
 *
 * 纯逻辑模块,依赖注入(resolve/isFresh/now),node 环境可单测。
 */
import { i18n } from '@/i18n';
import {
  isResolvedRemoteMediaFresh,
  type MobileResolvedRemoteMedia,
} from '@/session/remoteMedia';

export interface RemoteMediaRequest {
  kind: 'image' | 'video' | 'audio';
  url: string;
  /** 只要缩略图(被控端缩 1024px webp);与原图取件在队列/缓存层按不同键隔离。 */
  thumbnail?: boolean;
}

/**
 * 队列/缓存键:缩略图与原图是同 url 的不同产物,必须分键——查看器取原图不能
 * 命中缩略图缓存(点开大图要可缩放的原图),反之列表也不该为缩略图取整个原图。
 * peekFresh / evict 的 url 参数按原图键解释(外部只对原图条目做这两种操作)。
 */
function requestKeyOf(media: RemoteMediaRequest): string {
  return media.thumbnail ? `thumb\u0000${media.url}` : media.url;
}

/**
 * 单次 resolve 的回写钩子(队列绑定到该次请求的缓存键)。
 * 取件方拿到 presign 结果后仍在后台落盘,落盘成功时经此把缓存条目升级成本地
 * file://,不必让调用方同步等待落盘。
 */
export interface RemoteMediaResolveHooks {
  /**
   * 本地副本已确证就绪(字节确实写进磁盘缓存)。队列据此把自己的缓存条目换成
   * 本地地址,后续同键请求直接命中本地文件、零网络。
   * 迟到 / 已退屏 / 条目已被更新的对象替换等情形由队列自行丢弃,取件方无需判断。
   */
  onLocalCopy(media: MobileResolvedRemoteMedia): void;
}

export interface RemoteMediaResolveQueueDeps {
  /** 真正的取件实现(fetchRemoteMedia + presignGet)。skipCache 随 forceRefresh 请求透传,
   *  让下游(磁盘缓存 / 被控端上传去重缓存)一并绕过,保证强制重取真的取到新对象。
   *  hooks 见 {@link RemoteMediaResolveHooks}。 */
  resolve(
    media: RemoteMediaRequest,
    opts?: { skipCache?: boolean },
    hooks?: RemoteMediaResolveHooks,
  ): Promise<MobileResolvedRemoteMedia>;
  /** presign 是否仍然新鲜;默认 isResolvedRemoteMediaFresh。 */
  isFresh?(media: MobileResolvedRemoteMedia, now: number): boolean;
  /** 时钟注入,测试用;默认 Date.now。 */
  now?(): number;
  /**
   * releaseAll 之后才完成的 in-flight 取件的下水道。此时队列已经完成最终释放,
   * 无法再把新结果纳入 releaseAll,宿主拿到后立即补 DELETE。
   */
  onOrphanResolved?(media: MobileResolvedRemoteMedia): void;
}

export interface RemoteMediaResolveQueueOptions {
  /** 同时 in-flight 的取件上限;桌面端上传是瓶颈,默认 2。 */
  maxConcurrent?: number;
  /** 失败负缓存时长(ms),默认 20s。 */
  errorTtlMs?: number;
  /** Approximate byte budget for resolved entries retained by this screen. */
  maxCacheBytes?: number;
}

export interface RemoteMediaRequestOptions {
  /** true 时插到队头(用户主动打开原图,优先于列表缩略图预取)。 */
  front?: boolean;
  /** abort 时若该 url 仍在排队且没有其他等待者,则移出队列并 reject。 */
  signal?: AbortSignal;
  /** true 时跳过 fresh 缓存强制重取(缩略图加载失败的一次性重试用)。 */
  forceRefresh?: boolean;
  /**
   * true 时只吃本队列的 fresh 缓存:命中即回,未命中直接 reject——绝不排队、不触发
   * 取件、也不写负缓存(lightbox 垫底预取用:缩略图对 gif/老被控端会回落成整张
   * 原图下载,装饰性预取不值得为此付一次全量取件)。
   */
  cachedOnly?: boolean;
}

export interface RemoteMediaResolveQueue {
  request(media: RemoteMediaRequest, opts?: RemoteMediaRequestOptions): Promise<MobileResolvedRemoteMedia>;
  /** 同步读 fresh 缓存(未过期才返回),缓存命中的缩略图首帧直接出图。 */
  peekFresh(url: string): MobileResolvedRemoteMedia | null;
  /** 使某 url 缓存失效;对应 OSS 对象延迟到 releaseAll 统一交还宿主。 */
  evict(url: string): MobileResolvedRemoteMedia | null;
  /** 清空缓存并返回本屏产生过且仍在世的 OSS 条目,供最终离场批量 DELETE。 */
  releaseAll(): MobileResolvedRemoteMedia[];
  stats(): { inFlight: number; queued: number };
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_ERROR_TTL_MS = 20 * 1000;
const DEFAULT_MAX_CACHE_BYTES = 32 * 1024 * 1024;

interface QueueEntry {
  media: RemoteMediaRequest;
  waiters: Array<{
    resolve: (media: MobileResolvedRemoteMedia) => void;
    reject: (err: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }>;
  inFlight: boolean;
  /** 任一等待者要求 forceRefresh 时置位,起飞时带 skipCache 透传下游。 */
  skipCache: boolean;
  /**
   * forceRefresh 撞上「已起飞的非 skipCache 取件」时的暂存等待者:不能并入本轮
   * (会拿到可能悬空的旧结果),本轮完成后携带它们立刻以 skipCache 重飞一轮。
   */
  forcedFollowUp?: QueueEntry['waiters'];
}

export function createRemoteMediaResolveQueue(
  deps: RemoteMediaResolveQueueDeps,
  options: RemoteMediaResolveQueueOptions = {},
): RemoteMediaResolveQueue {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const errorTtlMs = options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS;
  const maxCacheBytes = Math.max(0, options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES);
  const isFresh = deps.isFresh ?? ((media, now) => isResolvedRemoteMediaFresh(media, now));
  const now = deps.now ?? (() => Date.now());

  // 以下四个容器一律以 requestKeyOf 产出的**缓存键**为键(缩略图带前缀,原图 = 裸 url)。
  const cache = new Map<string, MobileResolvedRemoteMedia>();
  // 从 JS cache 逐出的条目不能立刻 DELETE:列表行或播放器可能仍持有它的
  // presign URL。这里只保留最终删除需要的小记录,不保留 inlineBase64 大字节。
  const retired = new Map<string, MobileResolvedRemoteMedia>();
  let cacheBytes = 0;
  const errorCache = new Map<string, { message: string; until: number }>();
  /** key → entry;排队与 in-flight 的都在这里,靠 entry.inFlight 区分。 */
  const entries = new Map<string, QueueEntry>();
  /** 排队顺序(只含未 in-flight 的 key)。 */
  const pendingOrder: string[] = [];
  let inFlightCount = 0;
  /** releaseAll 已执行:此后完成的 in-flight 结果改走 onOrphanResolved,不回填缓存。 */
  let released = false;

  function estimateCacheBytes(media: MobileResolvedRemoteMedia): number {
    const inlineBytes = media.inlineBase64 ? media.inlineBase64.length * 2 : 0;
    const metadataBytes = 256 + media.url.length * 2 + media.ossKey.length * 2;
    const declaredBytes = Number.isFinite(media.size) && media.size > 0
      ? Math.min(media.size, 8 * 1024 * 1024)
      : 0;
    return Math.max(metadataBytes + inlineBytes, declaredBytes);
  }

  function deleteCacheEntry(key: string): MobileResolvedRemoteMedia | null {
    const current = cache.get(key);
    if (!current) return null;
    cache.delete(key);
    cacheBytes = Math.max(0, cacheBytes - estimateCacheBytes(current));
    return current;
  }

  function retire(media: MobileResolvedRemoteMedia | null | undefined): void {
    if (!media?.ossKey) return;
    // 最终 DELETE 只需要 key。不要让 retired 通过 url(data URI 也可能很大)
    // 或 inlineBase64 间接抵消 cache 的字节上限。
    retired.set(media.ossKey, {
      url: '',
      ossKey: media.ossKey,
      mimeType: '',
      size: 0,
      expiresAt: '',
      previewable: false,
    });
  }

  function setCacheEntry(key: string, media: MobileResolvedRemoteMedia): void {
    deleteCacheEntry(key);
    cache.set(key, media);
    cacheBytes += estimateCacheBytes(media);
    // Keep the just-resolved item when it alone exceeds the budget: callers
    // are about to receive it, and deleting its OSS object would invalidate the
    // result. The next insertion can evict it normally once another entry exists.
    while (cacheBytes > maxCacheBytes && cache.size > 1) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const removed = deleteCacheEntry(oldest);
      retire(removed);
    }
  }

  function touchCacheEntry(key: string, media: MobileResolvedRemoteMedia): void {
    cache.delete(key);
    cache.set(key, media);
  }

  function detachWaiter(entry: QueueEntry, waiter: QueueEntry['waiters'][number]): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }

  function settleEntry(key: string, entry: QueueEntry, result: MobileResolvedRemoteMedia | null, err?: unknown): void {
    entries.delete(key);
    for (const waiter of entry.waiters) {
      detachWaiter(entry, waiter);
      if (result) waiter.resolve(result);
      else waiter.reject(err);
    }
    entry.waiters.length = 0;
  }

  /**
   * 后台落盘完成后把缓存条目升级成本地 file://(见 RemoteMediaResolveHooks)。
   *
   * 为什么必须有这一步:取件返回的 presign 地址会被当 fresh 结果缓存,在有效期内
   * 同键请求一律直接命中它,**再也不会重新进入磁盘 lookup**。于是「已经打开过的
   * 原图,关掉再打开又要从 OSS 重下一整张」——盘上那份副本永远轮不到用
   * (PR #1125 review)。事件驱动的升级取代了此前"同步等落盘"的做法:调用方不必
   * 等待,预取也就不会占住并发槽位把用户正在看的那张饿住。
   *
   * 三条丢弃路径(乱序 / 迟到的升级绝不能污染缓存):
   *   - 已 releaseAll:缓存归退屏清理接管,升级会凭空复活一个条目;
   *   - 条目不存在:被 evict / 从未落缓存(如缩略图回落原图落的是裸键),不创建;
   *   - ossKey 已变:forceRefresh 换过对象,本次升级对应的是旧对象,已过期。
   */
  function upgradeToLocalCopy(key: string, local: MobileResolvedRemoteMedia): void {
    if (released) return;
    const current = cache.get(key);
    if (!current) return;
    if (current.ossKey !== local.ossKey) return;
    setCacheEntry(key, local);
  }

  function pump(): void {
    while (inFlightCount < maxConcurrent && pendingOrder.length > 0) {
      const key = pendingOrder.shift();
      if (!key) break;
      const entry = entries.get(key);
      if (!entry || entry.inFlight || entry.waiters.length === 0) continue;
      entry.inFlight = true;
      inFlightCount += 1;
      void deps.resolve(
        entry.media,
        entry.skipCache ? { skipCache: true } : undefined,
        { onLocalCopy: (local) => upgradeToLocalCopy(key, local) },
      )
        .then((resolved) => {
          if (released) {
            // 退屏后没人关心新旧,follow-up 一并按本轮结果 settle。
            if (entry.forcedFollowUp?.length) {
              entry.waiters.push(...entry.forcedFollowUp);
              entry.forcedFollowUp = undefined;
            }
            deps.onOrphanResolved?.(resolved);
            settleEntry(key, entry, resolved);
            return;
          }
          // 刷新重取覆盖旧条目时,旧 OSS 对象(ossKey 不同才是真被替换,相同则仍在用)
          // 退出 cache 但仍可能被已挂载行持有,延迟到最终 releaseAll 再删除。
          const prev = cache.get(key);
          if (prev && prev.ossKey && prev.ossKey !== resolved.ossKey) {
            retire(prev);
          }
          setCacheEntry(key, resolved);
          errorCache.delete(key);
          const followUp = entry.forcedFollowUp;
          entry.forcedFollowUp = undefined;
          settleEntry(key, entry, resolved);
          if (followUp?.length) {
            // 强制重取等待者:携带 skipCache 立刻重飞一轮(插队头),
            // 新结果经上面的 replaced-entry 路径覆盖缓存并延后回收旧对象。
            const follow: QueueEntry = { media: entry.media, waiters: followUp, inFlight: false, skipCache: true };
            entries.set(key, follow);
            pendingOrder.unshift(key);
          }
        })
        .catch((err) => {
          // 本轮都失败了,follow-up 的 skipCache 重飞大概率同样失败(桌面离线),
          // 一并拒绝,让重试按钮语义接管。
          if (entry.forcedFollowUp?.length) {
            entry.waiters.push(...entry.forcedFollowUp);
            entry.forcedFollowUp = undefined;
          }
          if (!released) {
            errorCache.set(key, {
              message: err instanceof Error ? err.message : String(err),
              until: now() + errorTtlMs,
            });
            if (entry.skipCache) {
              // 强制重取失败:旧缓存条目已被 onError / 显式重试证伪,留着会让
              // 后续被动请求继续命中坏对象;逐出并登记最终回收,负缓存过期后
              // 重新走全新取件。
              const prev = cache.get(key);
              if (prev) {
                deleteCacheEntry(key);
                retire(prev);
              }
            }
          }
          settleEntry(key, entry, null, err);
        })
        .finally(() => {
          inFlightCount -= 1;
          pump();
        });
    }
  }

  function request(
    media: RemoteMediaRequest,
    opts: RemoteMediaRequestOptions = {},
  ): Promise<MobileResolvedRemoteMedia> {
    // key 是队列/缓存键(缩略图带前缀,原图 = 裸 url),entry.media 才是原始请求。
    const key = requestKeyOf(media);
    const cached = cache.get(key);
    if (cached && !opts.forceRefresh && isFresh(cached, now())) {
      touchCacheEntry(key, cached);
      return Promise.resolve(cached);
    }
    if (opts.cachedOnly) {
      // 只读缓存模式:未命中直接拒绝,不入队、不碰负缓存(不污染同键的真实取件)。
      return Promise.reject(new Error(i18n.t('composer.attachments.mediaCacheMiss')));
    }

    const negative = errorCache.get(key);
    if (negative && (opts.forceRefresh || negative.until <= now())) {
      // forceRefresh 是用户显式动作(重试按钮 / 加载失败自愈),穿透负缓存。
      errorCache.delete(key);
    } else if (negative) {
      return Promise.reject(new Error(negative.message));
    }

    if (opts.signal?.aborted) {
      return Promise.reject(abortError());
    }

    return new Promise<MobileResolvedRemoteMedia>((resolve, reject) => {
      let entry = entries.get(key);
      if (!entry) {
        entry = { media, waiters: [], inFlight: false, skipCache: !!opts.forceRefresh };
        entries.set(key, entry);
        if (opts.front) pendingOrder.unshift(key);
        else pendingOrder.push(key);
      } else if (opts.forceRefresh && !entry.inFlight) {
        entry.skipCache = true;
      }
      if (opts.front && !entry.inFlight) {
        // 已排队的条目被高优先级请求命中 → 提到队头。
        const idx = pendingOrder.indexOf(key);
        if (idx > 0) {
          pendingOrder.splice(idx, 1);
          pendingOrder.unshift(key);
        }
      }

      const waiter: QueueEntry['waiters'][number] = { resolve, reject, signal: opts.signal };
      if (opts.signal) {
        waiter.onAbort = () => {
          const current = entries.get(key);
          if (!current) return;
          if (current.inFlight) {
            // in-flight 本体任其完成写缓存;还没起飞的强制 follow-up 等待者可撤。
            const followIdx = current.forcedFollowUp?.indexOf(waiter) ?? -1;
            if (followIdx >= 0) {
              current.forcedFollowUp?.splice(followIdx, 1);
              waiter.reject(abortError());
            }
            return;
          }
          const idx = current.waiters.indexOf(waiter);
          if (idx >= 0) current.waiters.splice(idx, 1);
          waiter.reject(abortError());
          if (current.waiters.length === 0) {
            entries.delete(key);
            const orderIdx = pendingOrder.indexOf(key);
            if (orderIdx >= 0) pendingOrder.splice(orderIdx, 1);
          }
        };
        opts.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      if (opts.forceRefresh && entry.inFlight && !entry.skipCache) {
        // 强制重取不能并入已起飞的普通取件(桌面去重缓存可能返回悬空 key,
        // 本轮结果对强制重取无效):暂存,本轮完成后立刻以 skipCache 重飞。
        (entry.forcedFollowUp ??= []).push(waiter);
      } else {
        entry.waiters.push(waiter);
      }
      pump();
    });
  }

  return {
    request,
    peekFresh(url) {
      const cached = cache.get(url);
      if (!cached || !isFresh(cached, now())) return null;
      touchCacheEntry(url, cached);
      return cached;
    },
    evict(url) {
      const cached = deleteCacheEntry(url);
      retire(cached);
      errorCache.delete(url);
      return cached;
    },
    releaseAll() {
      released = true;
      // 仍在排队未起飞的请求直接拒掉:退屏后才起飞的上传只会立刻变 orphan 被删,
      // 纯浪费(缩略图的 signal abort 已清一部分;lightbox 预取不带 signal,靠这里兜底)。
      // 已 in-flight 的任其完成,走 onOrphanResolved 补删。
      for (const key of pendingOrder.splice(0)) {
        const entry = entries.get(key);
        if (!entry || entry.inFlight) continue;
        settleEntry(key, entry, null, abortError());
      }
      const allByOssKey = new Map(retired);
      for (const media of cache.values()) {
        if (!media.ossKey) continue;
        if (media.inlineBase64 === undefined) {
          allByOssKey.set(media.ossKey, media);
        } else {
          const { inlineBase64: _inlineBase64, ...smallRecord } = media;
          allByOssKey.set(media.ossKey, smallRecord);
        }
      }
      const all = [...allByOssKey.values()];
      cache.clear();
      retired.clear();
      cacheBytes = 0;
      errorCache.clear();
      return all;
    },
    stats() {
      return { inFlight: inFlightCount, queued: pendingOrder.length };
    },
  };
}

function abortError(): Error {
  return new Error(i18n.t('composer.attachments.mediaFetchCancelled'));
}
