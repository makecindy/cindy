/**
 * remotePathVerdict — 聊天文件 chip 点亮前的远端存在性验证(verdict 缓存层)。
 * ---------------------------------------------------------------------------
 * 手机端一切会话都是 device-link 远程会话:chip 点亮不能打本机文件系统,必须
 * 问被控端「这个绝对路径是不是文件 / 目录」。本模块与桌面
 * renderer/lib/remoteFileOpen.ts 的 verdict 层同语义:
 *
 *   - `file` / `directory` → 点亮;`nonfile`(远端明确不存在)→ 保持纯文本;
 *   - `unknown`(链路断 / stat 异常等无法判定)→ 乐观点亮,点击后由预览页
 *     自己的错误 UX 兜底——绝不因为断链把整条消息的 chip 全灭掉;
 *   - 确定态(file/directory/nonfile)按 (deviceId, workdir, absPath) 缓存,
 *     无 TTL、容量兜底:聊天引用的文件在视图生命周期内视作不变,切会话回来
 *     chip 必须同步点亮不闪烁;
 *   - unknown 按同 key 落短 TTL 负缓存(不进 peek):链路差时 FlatList 窗口化
 *     反复挂卸 chip,若每次重挂都重发 stat,长转录 × 断续链路会形成打满
 *     device-link 通道的重验风暴(2026-07 线上实捉:整机点按延迟秒级)。TTL 内
 *     直接按 unknown 乐观点亮,TTL 过后重挂自愈重验,自愈语义不变、只是不再
 *     每次重挂都打一发;
 *   - 并发去重:同一路径在同屏多处出现时只发一次 stat;
 *   - 并发限流:不同路径的 stat 全局最多同时在飞 STAT_MAX_CONCURRENCY 条。
 *     stat 与消息收发共用同一条 device-link 通道,首屏一次性点亮几十个 chip
 *     时不限流会把用户操作挤在长队后面(同上事故的另一半成因)。
 *
 * stat 执行体由调用方注入(会话屏包装 device-link transport),本模块零 IO
 * 依赖,可直接单测。
 */

import type { RemotePathStatResult } from '@/device-link/mobileMakerTransport';

export type RemotePathVerdict = 'file' | 'directory' | 'nonfile' | 'unknown';

/** stat 执行体:被控端 `fs:stat-path`(dir / file / missing 三态)。 */
export type RemotePathStatFn = (absPath: string) => Promise<RemotePathStatResult>;

const VERDICT_CACHE_CAP = 1000;
/** unknown 负缓存 TTL:链路差时同 key 最多每 30s 重验一次(重挂不再必发)。 */
const UNKNOWN_TTL_MS = 30_000;
const UNKNOWN_CACHE_CAP = 1000;
/** 全局 stat 并发上限:pace 住验证流量,别挤占用户操作的 device-link 往返。 */
const STAT_MAX_CONCURRENCY = 3;

const verdictCache = new Map<string, RemotePathVerdict>();
const verdictInflight = new Map<string, Promise<RemotePathVerdict>>();
/** key → 负缓存过期时刻(epoch ms)。 */
const unknownUntil = new Map<string, number>();

let statActive = 0;
const statWaiters: Array<() => void> = [];

/** 占一个 stat 并发槽;满员时排队(FIFO),由 releaseStatSlot 交接唤醒。 */
function acquireStatSlot(): Promise<void> {
  if (statActive < STAT_MAX_CONCURRENCY) {
    statActive += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    statWaiters.push(resolve);
  });
}

/** 释放并发槽:有排队者则把槽原地交接(计数不变),否则归还计数。 */
function releaseStatSlot(): void {
  const next = statWaiters.shift();
  if (next) {
    next();
    return;
  }
  statActive -= 1;
}

function verdictKey(deviceId: string, workdir: string, absPath: string): string {
  return `${deviceId}|${workdir}|${absPath}`;
}

function capMapSize(map: Map<string, unknown>, cap: number): void {
  if (map.size < cap) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

/** 同步读已验证结论(未验证 / 仅负缓存 unknown → undefined,调用方走异步验证)。 */
export function peekRemotePathVerdict(
  deviceId: string,
  workdir: string,
  absPath: string,
): RemotePathVerdict | undefined {
  return verdictCache.get(verdictKey(deviceId, workdir, absPath));
}

/** 异步验证(并发去重 + 限流 + 落缓存)。stat 异常按 unknown 处理,绝不 throw。 */
export function verifyRemotePathCached(
  deviceId: string,
  workdir: string,
  absPath: string,
  stat: RemotePathStatFn,
): Promise<RemotePathVerdict> {
  const key = verdictKey(deviceId, workdir, absPath);
  const hit = verdictCache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = verdictInflight.get(key);
  if (pending) return pending;
  const negativeUntil = unknownUntil.get(key);
  if (negativeUntil !== undefined) {
    if (negativeUntil > Date.now()) return Promise.resolve('unknown');
    unknownUntil.delete(key);
  }
  const p = (async (): Promise<RemotePathVerdict> => {
    await acquireStatSlot();
    try {
      const res = await stat(absPath);
      if (res.kind === 'dir') return 'directory';
      if (res.kind === 'file') return 'file';
      return 'nonfile';
    } catch {
      return 'unknown';
    } finally {
      releaseStatSlot();
    }
  })()
    .then((verdict) => {
      if (verdict === 'unknown') {
        // 短 TTL 负缓存(见头注释):TTL 内同 key 不再发 stat,乐观点亮语义不变。
        capMapSize(unknownUntil, UNKNOWN_CACHE_CAP);
        unknownUntil.set(key, Date.now() + UNKNOWN_TTL_MS);
      } else {
        capMapSize(verdictCache, VERDICT_CACHE_CAP);
        verdictCache.set(key, verdict);
      }
      return verdict;
    })
    .finally(() => verdictInflight.delete(key));
  verdictInflight.set(key, p);
  return p;
}

/** Test-only:清空缓存、负缓存、在途请求与并发槽状态。调用前先把自己发起的
 *  在途 stat 全部 settle 掉,否则迟到的 releaseStatSlot 会污染下一个用例的计数。 */
export function _clearRemotePathVerdictCache(): void {
  verdictCache.clear();
  verdictInflight.clear();
  unknownUntil.clear();
  statActive = 0;
  statWaiters.length = 0;
}
