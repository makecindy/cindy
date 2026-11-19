/**
 * remoteMediaCacheStore.ts — 控制端「入方向远程媒体」的本地缓存(纯内存)。
 * ---------------------------------------------------------------------------
 * 控制端经 OSS 中转取到被控端媒体后,在本机缓存,避免重复 media:fetch / 重复下载。
 * 两类条目:
 *   - local:小媒体(图片/文件)整下后**字节存内存**,用后即删 OSS;按总字节上限 LRU 逐出。
 *   - stream:视频/音频不整下,只记 ossKey,range 请求时从 OSS 流式取(见 protocol handler);
 *     OSS 对象保活,空闲超 TTL → 清条目 + 删 OSS。
 *
 * 本模块只管理内存热缓存;不可变图片的跨重启副本由 remoteMediaPersistentCache
 * 通过现有媒体仓管理。内存占用由 LOCAL_CAP_BYTES 上限 + LRU 兜底。
 */
import { createHash } from 'node:crypto';

import { createLogger } from '../logger';
import { removeRemote } from './mediaTransfer.desktop';
import { activeOwnerScopeKey } from '../appSessionState';

const log = createLogger('device-link:remoteMediaCache');

/** local 条目(整下进内存)总字节上限,超出按 lastAccess LRU 逐出。 */
let localCapBytes = 256 * 1024 * 1024;
/** stream 条目(OSS 保活)空闲多久后清理 + 删 OSS。 */
const STREAM_TTL_MS = 30 * 60 * 1000;
/**
 * stream 条目数量上限。每条仅几百字节内存,但每条对应一个**保活的 OSS 对象** ——
 * 海量不同视频连看会让 OSS 对象累积(TTL 内)。超过上限按 lastAccess 逐出最旧的 + 删其 OSS,
 * 给 TTL 之外再加一道数量兜底。
 */
let maxStreamEntries = 256;

export interface LocalEntry {
  kind: 'local';
  bytes: Buffer;
  mimeType: string;
  size: number;
  lastAccess: number;
}
export interface StreamEntry {
  kind: 'stream';
  ossKey: string;
  mimeType: string;
  size: number;
  lastAccess: number;
  /**
   * 当前正在被服务的 range 响应数。>0 表示有 in-flight 流(<video>/<audio> 长连接正在播放)——
   * 此时 sweep / 数量逐出都**不得**删它,否则会删掉正在播放的 OSS 对象,后续 seek 404。
   * serveStream 开始时 retainStream++、流结束 / 出错 / cancel 时 releaseStream--(并刷新 lastAccess)。
   */
  inFlight: number;
}
export type RemoteMediaEntry = LocalEntry | StreamEntry;

const entries = new Map<string, RemoteMediaEntry>();

/** cacheKey = sha256(deviceId \0 origUrl):同设备同原始媒体唯一。 */
function keyOf(deviceId: string, origUrl: string): string {
  return createHash('sha256').update(`${activeOwnerScopeKey()}\0${deviceId}\0${origUrl}`).digest('hex');
}

/** Explicit disk-cache cleanup also retires warm copies. Streaming playback is unaffected. */
export function clearLocalEntries(): void {
  for (const [key, entry] of entries) if (entry.kind === 'local') entries.delete(key);
}

/** 命中则刷新 lastAccess 并返回;未命中 undefined。 */
export function lookup(deviceId: string, origUrl: string): RemoteMediaEntry | undefined {
  const e = entries.get(keyOf(deviceId, origUrl));
  if (e) e.lastAccess = nowMs();
  return e;
}

/** 记小媒体(字节存内存),触发 LRU 逐出。 */
export function recordLocal(
  deviceId: string,
  origUrl: string,
  bytes: Buffer,
  mimeType: string,
): LocalEntry {
  const entry: LocalEntry = {
    kind: 'local',
    bytes,
    mimeType,
    size: bytes.byteLength,
    lastAccess: nowMs(),
  };
  entries.set(keyOf(deviceId, origUrl), entry);
  evictLocalIfNeeded();
  return entry;
}

/** 记可流式媒体(只存 ossKey,OSS 保活)。 */
export function recordStream(
  deviceId: string,
  origUrl: string,
  ossKey: string,
  mimeType: string,
  size: number,
): StreamEntry {
  const entry: StreamEntry = { kind: 'stream', ossKey, mimeType, size, lastAccess: nowMs(), inFlight: 0 };
  entries.set(keyOf(deviceId, origUrl), entry);
  evictStreamsIfNeeded();
  return entry;
}

/**
 * 显式逐出一个条目(流式首开失败的自愈路径用):删条目,stream 条目 best-effort
 * 删其 OSS 对象(悬空 key 删除幂等;活 key 逐出前清掉避免孤儿)。
 * stream 条目仍有 in-flight 响应(inFlight > 0,正被观看/seek)时**拒绝逐出**并
 * 返回 false——此时 key 显然不是悬空的,删了会打断正在服务的流;调用方应放弃
 * 自愈重试、按原失败语义处理。条目不存在视为已逐出,返回 true。
 * 传 expectedOssKey 时只逐出「仍是那把 key」的 stream 条目:并发失败请求里
 * 后到的那个不能把先到者刚重取回来的新条目(新 key)误删掉。
 */
export function evictEntry(deviceId: string, origUrl: string, expectedOssKey?: string): boolean {
  const k = keyOf(deviceId, origUrl);
  const e = entries.get(k);
  if (!e) return true;
  if (e.kind === 'stream' && e.inFlight > 0) return false;
  if (expectedOssKey !== undefined && !(e.kind === 'stream' && e.ossKey === expectedOssKey)) {
    return false; // 条目已被并发自愈换成新对象(或已变 local),不动它
  }
  entries.delete(k);
  if (e.kind === 'stream') void removeRemote(e.ossKey);
  return true;
}

/** 标记一个 stream 条目「正在被服务」(serveStream 开始时调)。期间 sweep / 逐出跳过它。 */
export function retainStream(entry: StreamEntry): void {
  entry.inFlight += 1;
}

/** 流式响应结束 / 出错 / 被取消时调:计数减一并刷新 lastAccess(空闲 TTL 从「最后一次服务结束」起算)。 */
export function releaseStream(entry: StreamEntry): void {
  if (entry.inFlight > 0) entry.inFlight -= 1;
  entry.lastAccess = nowMs();
}

/** stream 条目数超上限时,按 lastAccess 从旧到新逐出,逐出即删其 OSS 对象(防保活对象无限累积)。 */
function evictStreamsIfNeeded(): void {
  // total 计入全部 stream(含 in-flight)判是否超上限;但只从**非 in-flight**池里逐出 ——
  // 正在播放(inFlight>0)的流不能删(会删掉正在播放的 OSS 对象)。若可逐出的不够补足 overflow,
  // 就接受暂时超上限(那些是正在播放的,本就该保留),待它们播完再被后续逐出/sweep 收掉。
  let total = 0;
  const evictable: Array<[string, StreamEntry]> = [];
  for (const [k, e] of entries) {
    if (e.kind !== 'stream') continue;
    total += 1;
    if (e.inFlight === 0) evictable.push([k, e]);
  }
  if (total <= maxStreamEntries) return;
  evictable.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  const overflow = total - maxStreamEntries;
  for (let i = 0; i < overflow && i < evictable.length; i++) {
    const [k, e] = evictable[i];
    entries.delete(k);
    void removeRemote(e.ossKey); // 逐出即删 OSS,best-effort
    log.debug(`evicted stream entry (count cap) ossKey=${e.ossKey}`);
  }
}

/** 总 local 字节超上限时,按 lastAccess 从旧到新逐出(仅 local 占内存)。 */
function evictLocalIfNeeded(): void {
  let total = 0;
  const locals: Array<[string, LocalEntry]> = [];
  for (const [k, e] of entries) {
    if (e.kind === 'local') {
      total += e.size;
      locals.push([k, e]);
    }
  }
  if (total <= localCapBytes) return;
  locals.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  for (const [k, e] of locals) {
    if (total <= localCapBytes) break;
    entries.delete(k);
    total -= e.size;
    log.debug(`evicted local entry size=${e.size}`);
  }
}

/** 清理空闲超 TTL 的 stream 条目并删其 OSS 对象(best-effort)。 */
export async function sweepIdleStreams(now: number = nowMs()): Promise<void> {
  for (const [k, e] of [...entries]) {
    // inFlight>0:仍在被服务的长流(播放中)不算 idle,绝不清 —— 否则删掉正在播放的 OSS 对象。
    if (e.kind === 'stream' && e.inFlight === 0 && now - e.lastAccess > STREAM_TTL_MS) {
      entries.delete(k);
      await removeRemote(e.ossKey);
      log.debug(`swept idle stream ossKey=${e.ossKey}`);
    }
  }
}

function nowMs(): number {
  return Date.now();
}

/** 仅测试:清空缓存 + 还原 cap。 */
export function __resetForTests(): void {
  entries.clear();
  localCapBytes = 256 * 1024 * 1024;
  maxStreamEntries = 256;
}

export const __testing = {
  keyOf,
  STREAM_TTL_MS,
  entries,
  setLocalCap: (n: number) => {
    localCapBytes = n;
  },
  setMaxStreamEntries: (n: number) => {
    maxStreamEntries = n;
  },
};
