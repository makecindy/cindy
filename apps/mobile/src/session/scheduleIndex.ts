import { isDeviceUnresponsiveRemoteError } from '@cindy/maker-shared/device-link-contract';
import { createMobileMakerTransport, type MobileMakerTransport, type RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { unresponsiveDevicesStore } from '@/device-link/unresponsiveDevicesStore';
import { isTransientRemoteError } from '@/device-link/remoteRetry';
import { normalizeScheduleList, normalizeScheduleRuns } from '@/scheduler/scheduleModel';
import type { RemoteScheduleRun } from '@/scheduler/types';
import { buildSessionScheduleIndex, type RemoteSessionScheduleInfo } from '@/session/sessionList';

const SCHEDULE_INDEX_RUN_LIMIT = 50;

type LoadSessionScheduleIndexOptions = {
  throwOnTransientRunListError?: boolean;
  /**
   * 该目标设备当前是否熔断 open(实时查询)。最后一项 listRuns 的超时恰好把
   * 熔断打开时,catch 到的还是原始 INVOKE_TIMEOUT 而非快速失败码——只按错误码
   * 判断会把残缺索引当成功提交进 30s 正缓存(review P1)。
   */
  isDeviceUnresponsive?: () => boolean;
};

export async function loadSessionScheduleIndex(
  maker: Pick<MobileMakerTransport, 'schedule'>,
  options: LoadSessionScheduleIndexOptions = {},
): Promise<Map<string, RemoteSessionScheduleInfo>> {
  const schedules = normalizeScheduleList(await maker.schedule.list());
  // listRuns 逐个串行而非 Promise.all 全并发:device-link 是无优先级的单 WS 管道,
  // N 个背景 listRuns 一齐压上去会把会话打开的关键读(messages / getSession / projection)
  // 挤到队尾(2026-07 实测:并发轮次叠加时 list-runs 均值 8.8s、messages:list 被拖到 6s+)。
  // schedule-index 本就是"晚半拍"的次要数据(见 scheduleIndexDefer 头注释),串行慢一点
  // 无感,但任何时刻最多只占用管道一个槽位,关键读随到随插队。治本(协议级请求优先级)
  // 见 issue #324。
  const pairs: Array<readonly [string, RemoteScheduleRun[]]> = [];
  for (const schedule of schedules) {
    let runs: RemoteScheduleRun[] = [];
    try {
      runs = normalizeScheduleRuns(await maker.schedule.listRuns(schedule.id, SCHEDULE_INDEX_RUN_LIMIT));
    } catch (error) {
      if (options.throwOnTransientRunListError && isTransientRemoteError(error)) throw error;
      // 目标设备熔断 open(DEVICE_UNRESPONSIVE 快速失败):剩余 N-1 个 listRuns 会
      // 同样逐个失败,立即止损。**上抛而不是截断成功**(review P1):把部分索引当
      // 成功返回会被调用方提交并进入 30s 正缓存——首页/详情页拿着不完整徽标还
      // 以为是新鲜数据;上抛让节流层走失败负缓存,熔断恢复后重拉全量。
      // isDeviceUnresponsive 兜住末项竞态(review P1):最后一项的超时恰好凑满
      // 阈值开熔断时,抛的是 INVOKE_TIMEOUT,只看错误码会漏判。
      if (isDeviceUnresponsiveRemoteError(error) || options.isDeviceUnresponsive?.()) {
        throw error;
      }
      runs = [];
    }
    pairs.push([schedule.id, runs] as const);
  }
  return buildSessionScheduleIndex(schedules, new Map(pairs));
}

/**
 * schedule-index 加载的按 key 单飞 + TTL 节流。
 * 触发源(首页 focus、设备 hydrate、schedule 事件推送)高频且互相独立,不节流时每次都
 * 全量重放 1 + N×listRuns(2026-07 实测一晚 360 次 list-runs 拥塞管道)。语义:
 *  - 同 key 在途请求直接复用(单飞);
 *  - 完成后 TTL 内的触发复用上次结果(index 只喂次要徽标,短暂陈旧无感);
 *  - `force`(用户显式操作,如标记已读后的重建)绕过 TTL 立即重拉;
 *  - 失败负缓存:reject 后失败 TTL 内复用同一个 rejected promise,不重放 1+N 批次
 *    (参照 remoteMediaResolveQueue)。旧的「失败即清坑」+ 多触发源交叠,是 2026-07
 *    被控端无响应事故里首页反复全量重放、堆积请求风暴的放大器之一;`force` 照常穿透。
 */
export const SCHEDULE_INDEX_THROTTLE_TTL_MS = 30_000;
/** 失败负缓存时长:窗口内的被动触发直接吃上次失败,不再压请求上管道。 */
export const SCHEDULE_INDEX_FAILURE_TTL_MS = 30_000;

interface ScheduleIndexThrottleEntry {
  at: number;
  promise: Promise<Map<string, RemoteSessionScheduleInfo>>;
  /** 该轮加载失败的时刻;非 null 表示条目处于负缓存态。 */
  failedAt: number | null;
  /** 失败原因是 DEVICE_UNRESPONSIVE(熔断快速失败);恢复旁路判定用。 */
  failedUnresponsive: boolean;
  /** 失败原因是本机链路问题(NOT_CONNECTED / LINK_NOT_OPEN / BACKPRESSURE);重连全局失效。 */
  failedTransient: boolean;
  /** 失败原因是目标设备离线(DEVICE_OFFLINE);仅该设备 presence 恢复时失效。 */
  failedOffline: boolean;
}

const scheduleIndexThrottleEntries = new Map<string, ScheduleIndexThrottleEntry>();
const scheduleIndexInvalidationVersions = new Map<string, number>();

/**
 * 错误标记匹配:优先结构化 code,兜底 message 文本(review:mobile 各处的
 * 远端错误存在 message-only 形态,如 devices 页按 '[DEVICE_OFFLINE]' 文本
 * 回落判定;只认 code 会让这类失败漏掉分类)。
 */
function hasRemoteErrorMarker(error: unknown, marker: string): boolean {
  if ((error as { code?: unknown } | null | undefined)?.code === marker) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes(marker);
}

/**
 * 本机链路未通(NOT_CONNECTED / LINK_NOT_OPEN / BACKPRESSURE):重连即恢复,重连钩子全局失效。
 * 不含 INVOKE_TIMEOUT——「设备不回包」不是断线,不能被重连钩子清掉;也不含
 * DEVICE_OFFLINE——那是逐设备状态,归 isDeviceOfflineError(review:全局失效
 * 会让 B 设备的任何 rehydrate 反复清掉仍离线的 A 设备的负缓存,止损失效)。
 */
function isLocalLinkDownError(error: unknown): boolean {
  return (
    hasRemoteErrorMarker(error, 'NOT_CONNECTED')
    || hasRemoteErrorMarker(error, 'LINK_NOT_OPEN')
    || hasRemoteErrorMarker(error, 'BACKPRESSURE')
  );
}

/**
 * 目标设备离线(DEVICE_OFFLINE):负缓存只在**该设备**presence 可用时失效
 * (invalidateOfflineScheduleIndexFailureFor,key 即 deviceId)。不认它的话,
 * presence 恢复落在 30s 负缓存窗内,reseed 会吃旧 rejected promise,详情页被
 * 换成空索引且无人补拉(review P1)。
 */
function isDeviceOfflineError(error: unknown): boolean {
  return hasRemoteErrorMarker(error, 'DEVICE_OFFLINE');
}

export function loadSessionScheduleIndexThrottled(
  key: string,
  load: () => Promise<Map<string, RemoteSessionScheduleInfo>>,
  options: { force?: boolean; ttlMs?: number; failureTtlMs?: number; now?: () => number } = {},
): Promise<Map<string, RemoteSessionScheduleInfo>> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SCHEDULE_INDEX_THROTTLE_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? SCHEDULE_INDEX_FAILURE_TTL_MS;
  const existing = scheduleIndexThrottleEntries.get(key);
  if (!options.force && existing) {
    // 熔断恢复旁路(review P1):DEVICE_UNRESPONSIVE 负缓存的存在意义是「open
    // 期间别再压请求」,设备一旦恢复(移出 unresponsive 集合)就立刻失效——
    // 否则熔断关闭触发的 reseed/重载会在失败 TTL 内吃到同一个 rejected
    // promise,把索引替换成空集,且无任何定时器在 TTL 过期后补拉,徽标要等
    // 无关触发源才回来。key 即 deviceId(两处调用方约定,见 devices 页注释)。
    const failedUnresponsiveButRecovered =
      existing.failedAt !== null
      && existing.failedUnresponsive
      && !unresponsiveDevicesStore.has(key);
    const withinTtl = existing.failedAt !== null
      ? now() - existing.failedAt < failureTtlMs
      : now() - existing.at < ttlMs;
    if (withinTtl && !failedUnresponsiveButRecovered) return existing.promise;
  }
  const promise = load();
  const entry: ScheduleIndexThrottleEntry = {
    at: now(),
    promise,
    failedAt: null,
    failedUnresponsive: false,
    failedTransient: false,
    failedOffline: false,
  };
  scheduleIndexThrottleEntries.set(key, entry);
  promise.then(
    () => {
      // TTL 语义是「完成后 TTL 内复用」:一轮 load 本身耗时较长(1+N 串行)时,
      // 若从启动时刻起算,可复用窗口会被吃掉大半甚至直接过期(review 反馈)。
      // 成功落定时把基准挪到 resolve 时刻;在途期间的复用由单飞(同一 promise)保证。
      if (scheduleIndexThrottleEntries.get(key) === entry) entry.at = now();
    },
    (error) => {
      if (scheduleIndexThrottleEntries.get(key) === entry) {
        entry.failedAt = now();
        // 末项竞态下抛出的是原始 INVOKE_TIMEOUT(见 loadSessionScheduleIndex
        // 注释),此时熔断已 open——补查 store(key 即 deviceId),保证这类失败
        // 同样享受「恢复即旁路」而不是干等 30s TTL。
        entry.failedUnresponsive =
          isDeviceUnresponsiveRemoteError(error) || unresponsiveDevicesStore.has(key);
        // 收窄为真正的本机链路失败(review):isTransientRemoteError 把
        // INVOKE_TIMEOUT(目标不回包)也算 transient,若沿用,重连失效钩子会把
        // 「设备不回包」的负缓存也当断线恢复清掉,削弱止损效果。
        entry.failedTransient = !entry.failedUnresponsive && isLocalLinkDownError(error);
        entry.failedOffline = !entry.failedUnresponsive && isDeviceOfflineError(error);
      }
    },
  );
  return promise;
}

/**
 * 重连恢复钩子(review P1):普通断线(NOT_CONNECTED 等瞬态失败)产生的负缓存
 * 在链路恢复后立即失效——否则 30s 失败 TTL 内重连触发的 reseed 会吃到旧的
 * rejected promise,设备详情页把索引替换成空集、首页保留陈旧数据,且没有任何
 * 定时器在 TTL 过期后补拉。由 DeviceLinkContext 在每轮 rehydrate(只在 online
 * 时运行,重连必经)的共享生命周期入口调用;单 peer 恢复使用下方逐设备版本，
 * 熔断类负缓存不受影响(走各自的恢复旁路)。
 */
export function invalidateTransientScheduleIndexFailures(): void {
  for (const [key, entry] of scheduleIndexThrottleEntries) {
    if (entry.failedAt !== null && entry.failedTransient) {
      scheduleIndexThrottleEntries.delete(key);
    }
  }
}

/** Per-peer variant used by independent Mobile recovery lifecycles. */
export function invalidateTransientScheduleIndexFailureFor(deviceId: string): void {
  const entry = scheduleIndexThrottleEntries.get(deviceId);
  if (entry?.failedAt !== null && entry?.failedTransient) {
    scheduleIndexThrottleEntries.delete(deviceId);
  }
}

/**
 * 逐设备失效钩子(review P1):DEVICE_OFFLINE 的负缓存只在该设备 presence
 * 恢复时清除(DeviceLinkContext 的 presence.recovered 分支调用,key 即
 * deviceId)——若挂在全局重连钩子上,别的设备的任何 rehydrate 都会反复清掉
 * 仍离线设备的 30s 负缓存,请求风暴止损失效。
 */
export function invalidateOfflineScheduleIndexFailureFor(deviceId: string): void {
  const entry = scheduleIndexThrottleEntries.get(deviceId);
  if (entry && entry.failedAt !== null && entry.failedOffline) {
    scheduleIndexThrottleEntries.delete(deviceId);
  }
}

export function invalidateScheduleIndexForDevice(deviceId: string): void {
  if (!deviceId) return;
  scheduleIndexThrottleEntries.delete(deviceId);
  scheduleIndexInvalidationVersions.set(
    deviceId,
    (scheduleIndexInvalidationVersions.get(deviceId) ?? 0) + 1,
  );
}

/**
 * Offline invalidation generation for consumers that need to reject a stale
 * completion from a request which was already in flight when the device went
 * offline. The generation is monotonic per device and intentionally separate
 * from the TTL cache entry.
 */
export function getScheduleIndexInvalidationVersion(deviceId: string): number {
  return scheduleIndexInvalidationVersions.get(deviceId) ?? 0;
}

/** Test-only: clear cache and invalidation generations. */
export function resetScheduleIndexThrottleForTesting(): void {
  scheduleIndexThrottleEntries.clear();
  scheduleIndexInvalidationVersions.clear();
}

export function loadDeviceSessionScheduleIndex(
  deviceId: string,
  invoke: RemoteInvoke,
): Promise<Map<string, RemoteSessionScheduleInfo>> {
  return loadSessionScheduleIndex(createMobileMakerTransport({ deviceId, invoke }), {
    isDeviceUnresponsive: () => unresponsiveDevicesStore.has(deviceId),
  });
}

export function invalidateRunningSessionScheduleEntries(
  current: Map<string, RemoteSessionScheduleInfo>,
  sessionIds: Iterable<string>,
): Map<string, RemoteSessionScheduleInfo> {
  let next: Map<string, RemoteSessionScheduleInfo> | null = null;
  for (const sessionId of sessionIds) {
    const info = current.get(sessionId);
    if (!info?.running) continue;
    next ??= new Map(current);
    next.set(sessionId, { ...info, running: false });
  }
  return next ?? current;
}

export function replaceSessionScheduleIndexEntries(
  current: Map<string, RemoteSessionScheduleInfo>,
  sessionIds: Iterable<string>,
  next: Map<string, RemoteSessionScheduleInfo>,
): Map<string, RemoteSessionScheduleInfo> {
  const ids = new Set(sessionIds);
  const merged = new Map(current);
  for (const sessionId of ids) merged.delete(sessionId);
  for (const [sessionId, info] of next) {
    if (ids.has(sessionId)) merged.set(sessionId, info);
  }
  return scheduleInfoMapsEqual(current, merged) ? current : merged;
}

function scheduleInfoMapsEqual(
  a: ReadonlyMap<string, RemoteSessionScheduleInfo>,
  b: ReadonlyMap<string, RemoteSessionScheduleInfo>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [sessionId, info] of a) {
    const next = b.get(sessionId);
    if (!next || !scheduleInfoEqual(info, next)) return false;
  }
  return true;
}

function scheduleInfoEqual(a: RemoteSessionScheduleInfo, b: RemoteSessionScheduleInfo): boolean {
  return a.scheduleId === b.scheduleId
    && a.scheduleName === b.scheduleName
    && a.unreadCount === b.unreadCount
    && a.running === b.running
    && a.latestRunAt === b.latestRunAt
    && a.scheduleStatus === b.scheduleStatus
    && a.allSchedulesStopped === b.allSchedulesStopped
    && stringListsEqual(a.unreadRunIds, b.unreadRunIds);
}

function stringListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}
