/**
 * mirrorCacheClient —— 远程会话镜像冷缓存的 renderer 侧薄封装。
 * ---------------------------------------------------------------------------
 * 落盘在 main(`main/device-link/mirrorCacheStore.ts`,userData owner 命名空间);
 * 这里只负责:
 *  - 把 IPC 调用包成**永不抛错**的形式(缓存是纯优化,任何失败都必须静默降级),
 *  - 会话列表快照的去抖回写(多设备 bootstrap 会连续触发,只落盘最后一次),
 *  - 桥缺失时(老 preload / 测试环境)整体 no-op。
 *
 * 语义边界见 mirrorCacheStore 头部:缓存非权威、不含 live 态、fresh 一到即被接管。
 */

import type { Message, Session } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';

const log = createLogger('device-link:mirror-cache');

/** 会话列表回写去抖:多设备 bootstrap / reconcile 会连续触发,静默一小段后只落盘一次。 */
const SESSION_LIST_PERSIST_DEBOUNCE_MS = 1200;

type MirrorCacheBridge = typeof window.electronAPI.deviceLink.mirrorCache;

/**
 * 桥可能整体缺失,一律判空后 no-op:
 *  - node 单测环境里连 `window` 这个标识符都没有(直接写 window.x 会 ReferenceError,
 *    所以先 typeof 判断);
 *  - 窗口的 preload 还没注入 / 老版本 preload 没有这个桥。
 */
function bridge(): MirrorCacheBridge | null {
  if (typeof window === 'undefined') return null;
  return (window.electronAPI?.deviceLink?.mirrorCache as MirrorCacheBridge | undefined) ?? null;
}

/** 读某 (设备, 会话) 缓存的最近一页 server rows;未命中 / 出错一律空数组。 */
export async function readCachedMessages(deviceId: string, sessionId: string): Promise<Message[]> {
  const api = bridge();
  if (!api || !deviceId || !sessionId) return [];
  try {
    const result = await api.getMessages(deviceId, sessionId);
    rememberMainInvalidation(sessionId, result?.invalidation);
    return Array.isArray(result?.messages) ? (result.messages as unknown as Message[]) : [];
  } catch (err) {
    log.debug('read cached messages failed', err);
    return [];
  }
}

/** 写某 (设备, 会话) 的最近一页 server rows(空数组 = 清掉该条缓存)。失败静默。 */
/**
 * main 侧会话级作废计数的**本地已知值**。get / put 的响应都会带回它;写入时把它当成
 * "我取到这批内容时的计数"交给 main 比对 —— 于是另一个窗口(甚至另一个共享 userData 的进程)
 * 作废这个会话时,这次写会被 main 丢弃(renderer 本地令牌只在本渲染进程内可见)(review: codex P1)。
 */
const knownMainInvalidation = new Map<string, number>();

function rememberMainInvalidation(sessionId: string, value: number | undefined): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    knownMainInvalidation.set(sessionId, value);
  }
}

export function persistCachedMessages(
  deviceId: string,
  sessionId: string,
  rows: readonly Message[],
  expectedInvalidation?: number | Promise<number | undefined>,
): void {
  const api = bridge();
  if (!api || !deviceId || !sessionId) return;
  const dispatch = (expected: number | undefined): void => {
    void api
      .putMessages(deviceId, sessionId, rows as unknown as Record<string, unknown>[], expected)
      .then((result) => rememberMainInvalidation(sessionId, result?.invalidation))
      .catch((err: unknown) => log.debug('persist cached messages failed', err));
  };
  // 令牌已经在手 / 根本没有(空写)时**同步**派发 —— 清缓存这类"必须尽快到 main"的调用不该
  // 因为多一个 await 被推到下一个微任务(顺序会被后面的写入抢到前面去)。
  if (typeof expectedInvalidation === 'number' || expectedInvalidation === undefined) {
    dispatch(expectedInvalidation);
    return;
  }
  void expectedInvalidation
    .then(dispatch)
    .catch((err: unknown) => log.debug('persist cached messages failed', err));
}

/**
 * 取"发起这次远端请求时 main 侧的会话级作废计数",没有已知值就**当场补读一次**。
 *
 * main 侧现在拒绝没带令牌的非空写入(见 mirrorCacheStore 的同名说明):缓存读与远端请求
 * 刻意并行,远端页先到时本地还没有令牌,那笔写没有任何会话级比对可做。补读必须在**发起
 * 远端请求时**启动(而不是落盘前),否则读到的是清理**之后**的值,反而会让取自清理之前的
 * 行通过比对 —— 时序是这条屏障的全部意义(review: codex P1)。
 */
export function invalidationAtRequestStart(
  deviceId: string,
  sessionId: string,
): number | Promise<number | undefined> {
  const known = knownMainInvalidation.get(sessionId);
  if (typeof known === 'number') return known;
  const api = bridge();
  if (!api || !deviceId || !sessionId) return Promise.resolve(undefined);
  return api
    .getMessages(deviceId, sessionId)
    .then((result) => {
      rememberMainInvalidation(sessionId, result?.invalidation);
      return typeof result?.invalidation === 'number' ? result.invalidation : undefined;
    })
    .catch(() => undefined);
}

/** main 侧会话级作废计数的本地已知值(写入侧在**取内容时**取一次,落盘时交给 main 比对)。 */
export function knownMainInvalidationFor(sessionId: string): number | undefined {
  return knownMainInvalidation.get(sessionId);
}

/** 清掉某会话的消息缓存(被控端 /clear、rewind、删除会话后不留陈旧正文)。 */
export function clearCachedMessages(deviceId: string, sessionId: string): void {
  // 作废令牌先自增:此刻还在途的"最新页"请求(它握着作废之前的行)提交前会发现令牌变了,
  // 于是丢弃那次写 —— 否则它排在这次空写之后落地,把已经被 /clear、rewind、删消息抹掉的
  // 正文重新写回盘上(review: pr-code-review)。
  invalidationTokens.set(sessionId, (invalidationTokens.get(sessionId) ?? 0) + 1);
  persistCachedMessages(deviceId, sessionId, []);
}

/**
 * 每会话的「缓存已被权威侧作废」令牌。写点(makerTransport 的最新页写入)在**发起时**取一次,
 * 落盘前再取一次比对:变了说明期间发生过 /clear、rewind 或删消息,这次写必须丢弃。
 * 读路径已有同款守卫(hydrateRemoteMessagesFromCache 落地前复查 _cacheHydrateSuppressed)。
 */
const invalidationTokens = new Map<string, number>();

export function sessionCacheInvalidationToken(sessionId: string): number {
  return invalidationTokens.get(sessionId) ?? 0;
}

/** 缓存快照里的单台设备(与 main 侧 CachedDeviceSessions 同形)。 */
export interface CachedDeviceSessionsSnapshot {
  deviceId: string;
  deviceName: string;
  sessions: Session[];
}

/** 读侧边栏远程会话列表快照;未命中 / 出错一律空数组。 */
export async function readCachedSessionList(): Promise<CachedDeviceSessionsSnapshot[]> {
  const api = bridge();
  if (!api) return [];
  try {
    const result = await api.getSessionList();
    if (!Array.isArray(result?.devices)) return [];
    return result.devices.map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      sessions: (device.sessions ?? []) as unknown as Session[],
    }));
  } catch (err) {
    log.debug('read cached session list failed', err);
    return [];
  }
}

// ── 会话列表去抖回写(模块级单定时器:侧边栏是单例视图)──────────────────────
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCollect: (() => readonly CachedDeviceSessionsSnapshot[]) | null = null;

/**
 * 去抖回写:`collect` 在定时器触发时才执行,拿的是届时最新的 store 快照(不闭包旧数据)。
 * 与手机端 `scheduleHomeListSnapshotPersist` 同款。
 */
export function scheduleSessionListPersist(
  collect: () => readonly CachedDeviceSessionsSnapshot[],
  debounceMs: number = SESSION_LIST_PERSIST_DEBOUNCE_MS,
): void {
  if (!bridge()) return;
  pendingCollect = collect;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const fn = pendingCollect;
    pendingCollect = null;
    if (!fn) return;
    try {
      writeSessionListNow(fn());
    } catch (err) {
      // collect 本身抛错也静默:最多损失一次快照更新,不能影响侧边栏。
      log.debug('collect session list snapshot failed', err);
    }
  }, debounceMs);
}

function writeSessionListNow(devices: readonly CachedDeviceSessionsSnapshot[]): void {
  const api = bridge();
  if (!api) return;
  void api
    .putSessionList(
      devices.map((device) => ({
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        sessions: device.sessions as unknown as Record<string, unknown>[],
      })),
    )
    .catch((err: unknown) => log.debug('persist session list failed', err));
}

/**
 * 某设备离场(移除 / 撤销控制):清它的消息缓存与列表快照条目。
 *
 * 刻意**不**取消 pending 的列表回写:那是一个全局去抖,取消它会连带丢掉别的设备刚排下的
 * 快照更新 —— 「A 被归档 / 删除排了回写、1.2 秒内 B 被撤销」时,A 那次更新被吞掉,而
 * 随后的对账内容没变就不会再通知订阅者,于是 A 的旧会话能在下次离线冷启动重新出现
 * (review: codex P1)。
 *
 * 不取消也不会把 B 写回去:`collect` 是懒的(定时器触发时才读 store),而所有调用方都在
 * 调这里之前先 `removeDevice` 掉了 B 的分片;真正的删除由 main 侧 `clearDevice()` 完成,
 * 它会原子地把 B 从盘上的快照里摘掉。
 */
export function clearCachedDevice(deviceId: string): void {
  const api = bridge();
  if (!api || !deviceId) return;
  void api.clear(deviceId).catch((err: unknown) => log.debug('clear device cache failed', err));
}

/**
 * 作废尚未落盘的列表回写。
 *
 * 清空镜像(登出 / relay stopped / 接入器卸载)时**必须**调用:去抖定时器如果留着,
 * 会在清空之后把刚被清掉的设备与会话原样写回盘上。整棵缓存的删除不在 renderer 做 ——
 * 那是 owner 边界的事,由 main 在 teardownAuthAccountBoundary 里清(那时 owner 还是旧
 * 账号,清得准;renderer 卸载还可能只是关了个窗口,不该动盘)。
 */
export function cancelSessionListPersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  pendingCollect = null;
}

export const __testing = {
  writeSessionListNow,
};
