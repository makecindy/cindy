import { readRemoteDeviceFile } from './fileAccess';
/**
 * remoteMediaProtocol.ts — 控制端 `cindy-remote-media://` 自定义 scheme(入方向媒体)。
 * ---------------------------------------------------------------------------
 * renderer 把远程会话里的本机媒体 URL 改写成 `cindy-remote-media://m/{b64(originToken)}/{b64(origUrl)}`
 * (见 shared/remoteMediaUrl.ts)。本 handler 解出 (origin, origUrl) 后按来源分流:
 * ssh 来源交给 file-browser/ssh-media.ts(file-service 分片 → 磁盘缓存 → range 服务);
 * device 来源走本文件的 OSS 中转管线,经 OSS 向被控端取字节:
 *
 *   cindy-media:// 且本机字节仓命中 → 直接本地服务(内容寻址,字节必一致,
 *     见 serveLocalCindyMediaBlob)。
 *   缓存命中 → 直接服务(local 从内存切片 / stream 从 OSS range)。
 *   未命中   → remoteInvoke(device-link:media:fetch) 让被控端把媒体传到 OSS → 拿 { ossKey, mimeType, size }
 *     - 视频/音频:记 stream 条目,range 请求从 OSS 流式 206 透传(不整下,OSS 保活)。
 *     - 其它(图片/文件):presign-get 整下进内存缓存 → 删 OSS(用后删)→ 切片服务(支持 range)。
 *
 * 并发去重:`<video>` 首帧会并发打多个 range 请求 —— 同 key 的首次取件用 inflight Promise 合并,
 * 避免触发 N 次 media:fetch / N 次被控端上传。
 *
 * 失败语义:取件/流式失败回 5xx,renderer 媒体占位 + 可重试,不阻断会话。
 */
import { protocol, type CustomScheme } from 'electron';
import fs from 'node:fs/promises';

import { createLogger } from '../logger';
import { collectStreamWithLimit, REMOTE_IMAGE_MAX_BYTES } from '../lightboxMediaActions';
import { parseRemoteMediaUrl, REMOTE_MEDIA_SCHEME } from '../../shared/remoteMediaUrl';
import { parseRangeHeader } from '../videoProtocol';
import * as blobStore from '../cindy-media/blobStore';
import * as ledger from '../cindy-media/ledger';
import { buildRangedMediaResponse } from '../cindy-media/rangeResponse';
import { remoteInvoke } from './index';
import { DL_MEDIA_FETCH_CHANNEL } from '@cindy/device-link';
import { downloadToBuffer, openMediaStream, removeRemote } from './mediaTransfer';
import * as cache from './remoteMediaCacheStore';
import type { RemoteMediaEntry, StreamEntry } from './remoteMediaCacheStore';

const log = createLogger('device-link:remoteMediaProtocol');

interface MediaFetchResult {
  ossKey: string;
  mimeType: string;
  size: number;
  inlineBase64?: string;
}

/** 视频/音频走 OSS 流式(不整下);其它整下进内存缓存。 */
function isStreamable(mimeType: string): boolean {
  return mimeType.startsWith('video/') || mimeType.startsWith('audio/');
}

/**
 * 整下进内存的单对象上限:超过则不论 mime 一律走 OSS 流式(防大文件/大 PDF
 * 把 main 进程堆撑爆 —— 本地内存缓存只该装小媒体)。
 */
const LOCAL_BUFFER_MAX = 64 * 1024 * 1024;

/**
 * `cindy-media://` blob 的本地优先短路:内容寻址下同指纹字节两端逐字节一致,
 * 本机字节仓命中就直接服务,不必经 OSS 向被控端取。两类场景受益:
 *   - 控制端自己刚发出的附件(粘贴时已 ingest 进本机总仓)——不走远程即消灭
 *     「被控端尚未物化落盘 → media:fetch ENOENT → 占位框」的发送端竞态;
 *   - 两端恰好持有同一内容的 blob(转发/重发)——省一次被控端真实上传。
 * 本机无此 blob(或形状不合法)返回 null,照常走远程取件,行为零变化。
 * 响应形态照抄 cindyMediaProtocol(整读 + range 切片 + immutable 缓存头 +
 * touchBlob 刷 LRU),两条本地取件路径行为一致。
 */
async function serveLocalCindyMediaBlob(
  origUrl: string,
  rangeHeader: string | null,
): Promise<Response | null> {
  let resolved: { absPath: string; mimeType: string; hash: string };
  try {
    resolved = blobStore.resolveSafe(origUrl);
  } catch {
    return null; // 形状不合法:交远程管线按原语义处理
  }
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(resolved.absPath);
  } catch {
    return null; // 本机无此 blob:走远程取件
  }
  void ledger.touchBlob(resolved.hash);
  return buildRangedMediaResponse({
    buffer,
    mimeType: resolved.mimeType,
    rangeHeader,
    cacheControl: 'public, max-age=31536000, immutable',
  });
}

/** 同 key 取件去重:首次取件期间的并发请求复用同一 Promise。 */
const inflight = new Map<string, Promise<RemoteMediaEntry>>();

function inflightKeyOf(deviceId: string, origUrl: string): string {
  return `${deviceId} ${origUrl}`;
}

/** 取得缓存条目:命中直接返回,未命中向被控端取件并落缓存(并发去重)。 */
async function ensureEntry(deviceId: string, origUrl: string): Promise<RemoteMediaEntry> {
  const hit = cache.lookup(deviceId, origUrl);
  if (hit) return hit;
  const k = inflightKeyOf(deviceId, origUrl);
  const pending = inflight.get(k);
  if (pending) return pending;
  const p = fetchAndCache(deviceId, origUrl).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

/** 向被控端 invoke media:fetch。skipCache 强制其绕过图片上传去重缓存(悬空 key 自愈)。 */
async function invokeMediaFetch(
  deviceId: string,
  origUrl: string,
  skipCache: boolean,
): Promise<MediaFetchResult> {
  const payload = skipCache ? { url: origUrl, skipCache: true } : { url: origUrl };
  const res = await remoteInvoke(deviceId, DL_MEDIA_FETCH_CHANNEL, [payload]);
  if (!res.ok) {
    throw new Error(`media:fetch ${res.error?.code ?? 'FAIL'}: ${res.error?.message ?? ''}`);
  }
  return res.result as MediaFetchResult;
}

/** 小媒体:整下进内存 → 用后删 OSS(成功/失败都删,避免下载失败时孤儿对象)。 */
async function downloadLocalEntry(
  deviceId: string,
  origUrl: string,
  fetched: MediaFetchResult,
): Promise<RemoteMediaEntry> {
  try {
    const { bytes } = await downloadToBuffer(fetched.ossKey);
    return cache.recordLocal(deviceId, origUrl, bytes, fetched.mimeType);
  } finally {
    void removeRemote(fetched.ossKey);
  }
}

function toEntry(
  deviceId: string,
  origUrl: string,
  fetched: MediaFetchResult,
): Promise<RemoteMediaEntry> {
  if (fetched.inlineBase64 !== undefined) {
    return Promise.resolve(
      cache.recordLocal(
        deviceId,
        origUrl,
        Buffer.from(fetched.inlineBase64, 'base64'),
        fetched.mimeType,
      ),
    );
  }
  if (isStreamable(fetched.mimeType) || fetched.size > LOCAL_BUFFER_MAX) {
    // 视频/音频,或任意大文件(> 64MiB):OSS 保活,按 range 流式取,不整下进内存。
    return Promise.resolve(
      cache.recordStream(deviceId, origUrl, fetched.ossKey, fetched.mimeType, fetched.size),
    );
  }
  return downloadLocalEntry(deviceId, origUrl, fetched);
}

async function fetchAndCache(deviceId: string, origUrl: string): Promise<RemoteMediaEntry> {
  const fetched = await readRemoteDeviceFile(deviceId, origUrl, remoteInvoke, {
    maxPeerBytes: LOCAL_BUFFER_MAX,
    stream: true,
  });
  if ('path' in fetched) {
    try {
      return cache.recordLocal(
        deviceId,
        origUrl,
        await fs.readFile(fetched.path),
        fetched.mimeType,
      );
    } finally {
      await fetched.dispose();
    }
  }
  try {
    return await toEntry(deviceId, origUrl, fetched);
  } catch (err) {
    // 下载失败的常见根因:被控端图片上传去重缓存返回了悬空 key(对象已被消费方用后删)。
    // 带 skipCache 重取一次强制重传;仍失败按原语义抛给上层(renderer 占位 + 可重试)。
    log.warn(`remote media download failed, retrying with skipCache: ${String(err)}`);
    const refetched = await invokeMediaFetch(deviceId, origUrl, true);
    return toEntry(deviceId, origUrl, refetched);
  }
}

/** local 条目:从内存字节切片服务(支持 range 206 / 整文件 200)。 */
function serveLocal(
  entry: { bytes: Buffer; mimeType: string },
  rangeHeader: string | null,
): Response {
  const buffer = entry.bytes;
  const totalSize = buffer.byteLength;
  const range = parseRangeHeader(rangeHeader, totalSize);
  if (range) {
    const slice = buffer.subarray(range.start, range.end + 1);
    const body = slice.buffer.slice(
      slice.byteOffset,
      slice.byteOffset + slice.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      status: 206,
      headers: {
        'Content-Type': entry.mimeType,
        'Content-Length': String(slice.byteLength),
        'Content-Range': `bytes ${range.start}-${range.end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      },
    });
  }
  const body = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': entry.mimeType,
      'Content-Length': String(totalSize),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * 包装上游 body 流:在流读完 / 出错 / 被取消时回调 onEnd 一次(用于 release in-flight 计数)。
 * <video> 的长连接 range 请求生命周期 = 这个流的生命周期,故 onEnd 即「本次服务结束」。
 */
function trackStreamEnd(
  src: ReadableStream<Uint8Array>,
  onEnd: () => void,
): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  let ended = false;
  const fire = (): void => {
    if (!ended) {
      ended = true;
      onEnd();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          fire();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        fire();
      }
    },
    cancel(reason) {
      fire();
      return reader.cancel(reason);
    },
  });
}

/** stream 条目:从 OSS(可选 range)取并透传原始 status(200/206)+ body 流,不 buffer。 */
async function serveStream(
  entry: StreamEntry,
  rangeHeader: string | null,
  signal?: AbortSignal,
): Promise<Response> {
  // 开流**之前**就 retain:openMediaStream await 窗口内若 inFlight 仍为 0,
  // 同 key 并发请求的瞬时失败会通过自愈 evictEntry 把共享条目连 OSS 对象一起
  // 删掉,打断正在开流的这一路(开成功也会 seek 404)。开流失败成对 release,
  // 自愈路径(本请求自己失败后 evict)不受影响。
  cache.retainStream(entry);
  let upstream: Awaited<ReturnType<typeof openMediaStream>>;
  try {
    upstream = await openMediaStream(entry.ossKey, rangeHeader ?? undefined, signal);
  } catch (err) {
    cache.releaseStream(entry);
    throw err;
  }
  const headers: Record<string, string> = {
    'Content-Type': entry.mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const cr = upstream.headers.get('content-range');
  if (cr) headers['Content-Range'] = cr;
  const cl = upstream.headers.get('content-length');
  if (cl) headers['Content-Length'] = cl;
  // 服务期间保持 in-flight,sweep/逐出不得删它;流结束/出错/取消后 release + 刷新
  // lastAccess(空闲 TTL 从「最后一次服务结束」起算),避免长视频播放超 30min TTL
  // 被删掉正在播放的 OSS 对象。
  const body = upstream.body
    ? trackStreamEnd(upstream.body, () => cache.releaseStream(entry))
    : (cache.releaseStream(entry), null);
  return new Response(body, { status: upstream.status, headers });
}

/**
 * 核心:处理一个 cindy-remote-media 请求(供 handler + 单测调用)。
 * 按 origin token 分流:device → 本文件的 OSS 中转管线(原有路径,零变化);
 * ssh → file-browser/ssh-media.ts(file-service 分片拉到磁盘缓存后 range 服务)。
 */
async function handleRemoteMedia(
  url: string,
  rangeHeader: string | null,
  signal?: AbortSignal,
): Promise<Response> {
  const parsed = parseRemoteMediaUrl(url);
  if (!parsed) return new Response(null, { status: 400 });
  if (parsed.origin.kind === 'ssh') {
    // 惰性加载:ssh 管线拖着 file-service / SSH pool 的依赖链,device-only
    // 场景(绝大多数)不为它买单;首个 ssh 媒体请求后模块常驻缓存。
    const { serveSshRemoteMedia } = await import('../file-browser/ssh-media');
    return serveSshRemoteMedia(parsed.origin, parsed.origUrl, rangeHeader);
  }
  const deviceId = parsed.origin.deviceId;
  try {
    if (parsed.origUrl.startsWith('cindy-media://')) {
      const local = await serveLocalCindyMediaBlob(parsed.origUrl, rangeHeader);
      if (local) return local;
    }
    const entry = await ensureEntry(deviceId, parsed.origUrl);
    if (entry.kind === 'local') return serveLocal(entry, rangeHeader);
    try {
      return await serveStream(entry, rangeHeader, signal);
    } catch (err) {
      // 视频/音频的 key 是新鲜上传(不经过被控端图片去重缓存),首开失败多为瞬时
      // 网络问题,保持原 502 语义(重取一次 = 被控端整段重传,代价不值)。
      // 因体积(> LOCAL_BUFFER_MAX)走流式的图片/大文件才可能拿到去重缓存的悬空
      // key:首开失败时逐出坏条目(否则它驻留缓存,后续请求 502 到 sweep 为止)
      // 并带 skipCache 重取一次,对齐小图整下路径的自愈语义;仍失败抛给外层 502。
      // 客户端主动取消(滚走 / 关页)抛的是 AbortError,不是悬空 key:此时自愈
      // 是纯负收益——会删掉仍健康的 OSS 对象、触发被控端白重传,且用同一个已
      // abort 的 signal 重服务必然再失败。取消一律按原失败语义直接抛。
      if (isStreamable(entry.mimeType) || signal?.aborted) throw err;
      // 只有进被控端上传去重缓存的 scheme(xdt-image:// 与媒体总仓 cindy-media://,
      // 见 mediaFetch.ts 的 cacheable 判定)才存在「悬空 key」这种病;xdt-file:// 等
      // 大文件的 key 都是新鲜上传,首开失败多为瞬时错误,skipCache 也绕不了任何
      // 缓存——自愈 = 整个大文件白重传,保持原 502/重试语义。
      if (
        !parsed.origUrl.startsWith('xdt-image://') &&
        !parsed.origUrl.startsWith('cindy-media://')
      ) {
        throw err;
      }
      // 已有并发取件 / 自愈在跑:并入等它的结果,不再各自动手。
      const k = inflightKeyOf(deviceId, parsed.origUrl);
      const joined = inflight.get(k);
      if (joined) {
        const fresh = await joined;
        return fresh.kind === 'local'
          ? serveLocal(fresh, rangeHeader)
          : await serveStream(fresh, rangeHeader, signal);
      }
      // 只逐出「本次失败的那把 key」:并发失败请求里后到的不能把先到者刚重取
      // 回来的新条目误删。evictEntry 拒绝的两种情况分别处理:
      //   - 条目已被并发自愈换成新对象 → 直接用新条目重服务,不再重传;
      //   - 条目仍有 in-flight 响应(正被观看)→ key 不是悬空的,按原语义 502。
      if (!cache.evictEntry(deviceId, parsed.origUrl, entry.ossKey)) {
        const current = cache.lookup(deviceId, parsed.origUrl);
        if (current && current.kind === 'local') return serveLocal(current, rangeHeader);
        if (current && current.kind === 'stream' && current.ossKey !== entry.ossKey) {
          return await serveStream(current, rangeHeader, signal);
        }
        throw err;
      }
      log.warn(
        `stream open failed for oversized non-AV media, retrying with skipCache: ${String(err)}`,
      );
      // 自愈重取登记进同一 inflight map(逐出与登记在同一同步 tick 内完成,不暴露
      // cache miss 窗口):否则窗口期的并发请求会发起**不带 skipCache** 的普通取件,
      // 被控端去重缓存可能把同一把 stale key 再记回缓存、覆盖掉新对象。
      const p = (async () => {
        const refetched = await invokeMediaFetch(deviceId, parsed.origUrl, true);
        return toEntry(deviceId, parsed.origUrl, refetched);
      })().finally(() => inflight.delete(k));
      inflight.set(k, p);
      const fresh = await p;
      return fresh.kind === 'local'
        ? serveLocal(fresh, rangeHeader)
        : await serveStream(fresh, rangeHeader, signal);
    }
  } catch (err) {
    log.warn(`remote-media fetch failed: ${String(err)}`);
    // 502:上游(被控端 / OSS)取件失败 → renderer 媒体占位 + 可重试,不致命。
    return new Response(null, { status: 502 });
  }
}

/** Privilege entry for the one-shot registerSchemesAsPrivileged in bootstrap. */
/**
 * 图片 lightbox 动作(复制/另存/标注/发送)取远程图字节的 main 侧入口。
 * 直接复用协议 handler 的完整管线(ssh/device 分流、内存缓存、悬空 key 自愈),
 * 不重复实现取件逻辑。仅面向图片:stream 型条目(视频/音频/超大文件)不会由
 * 图片动作触达,返回非 2xx 时抛错交由调用方包装。
 */
export async function fetchRemoteMediaImageBytes(
  url: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await handleRemoteMedia(url, null);
  if (!res.ok) {
    throw new Error(`remote media fetch failed: HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error('remote media fetch failed: empty body');
  }
  // stream 型条目(超过本地缓冲阈值的对象)会以流式 Response 返回:不能
  // arrayBuffer() 整读——那会绕过 handleRemoteMedia 的流式安全边界,把整个
  // 远程对象物化进 main 内存(review P2)。与 http 取图共用同一限流读取。
  const reader = res.body.getReader();
  let buffer: Buffer;
  try {
    buffer = await collectStreamWithLimit(reader, REMOTE_IMAGE_MAX_BYTES);
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  const mimeType = res.headers.get('Content-Type') ?? 'application/octet-stream';
  return { buffer, mimeType };
}

export const remoteMediaSchemePrivilege: CustomScheme = {
  scheme: REMOTE_MEDIA_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    bypassCSP: false,
    stream: false,
    corsEnabled: false,
  },
};

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function registerRemoteMediaProtocolHandler(): void {
  protocol.handle(REMOTE_MEDIA_SCHEME, (request) =>
    handleRemoteMedia(request.url, request.headers.get('range'), request.signal),
  );
  // 周期清理空闲 stream 条目 + 删其 OSS 对象(用后删的流式版兜底)。
  if (!sweepTimer) {
    sweepTimer = setInterval(() => void cache.sweepIdleStreams(), cache.__testing.STREAM_TTL_MS);
    sweepTimer.unref?.();
  }
}

export const __testing = { handleRemoteMedia, ensureEntry, isStreamable, serveLocal, serveStream };
