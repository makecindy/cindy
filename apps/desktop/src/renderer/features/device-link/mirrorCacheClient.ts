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
import {
  isDataOwnerGenerationCurrent,
  getDataOwnerGeneration,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

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

/**
 * 等在途受保护读的上限。缓存是纯 best-effort:若那笔 get IPC 异常挂起(既不 resolve 也不
 * reject,如 main 侧卡死 / 通道断开但 Promise 没被 settle),无限等下去会**永久堵住**该会话
 * 后续所有缓存写入。超时后降级为 undefined 令牌,交给 store 的 fail-closed 丢这一次写 ——
 * 下次 hydrate 会重新补上锚点(review: copilot P1)。
 */
const TOKEN_READ_WAIT_TIMEOUT_MS = 3000;

/**
 * 给独立的缓存令牌补读加同一等待上限。底层 IPC 超时后仍可能在后台完成,但 `Promise.race`
 * 已经以 undefined 收敛,不会再执行调用方的记令牌逻辑。
 */
function tokenReadWithin<T>(read: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), TOKEN_READ_WAIT_TIMEOUT_MS);
  });
  return Promise.race([read, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** 每会话在途的受保护缓存读(供并发写点等待 opaque owner token / 代际就位,见 ownerTokenAtRequestStart)。 */
interface PendingProtectedRead {
  /** 发起这笔读时的 owner 身份:账号切换后旧读的令牌对新账号无效,不能等它。 */
  readonly owner: DataOwnerGeneration;
  readonly done: Promise<void>;
}

const pendingProtectedRead = new Map<string, PendingProtectedRead>();

/**
 * 等在途受保护读完成后取令牌,带超时与账号代际复核。
 *
 * 两个降级到 undefined(→ store fail-closed 丢这次写)的出口:
 *  1. 等待超过 TOKEN_READ_WAIT_TIMEOUT_MS —— 那笔 IPC 挂住了,不能永久堵写;
 *  2. 等待期间账号又切了 —— 取到的令牌属于旧账号,拿去比对只会误判。
 */
function afterProtectedRead<T>(
  sessionId: string,
  entry: PendingProtectedRead,
  pick: () => T | undefined,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), TOKEN_READ_WAIT_TIMEOUT_MS);
  });
  return Promise.race([entry.done.then(() => 'done' as const), timeout]).then((outcome) => {
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === 'timeout') {
      // done 永久不 settle 时,它自己的 finally 也永远不会清 map。超时必须把同一 entry 摘掉,
      // 否则后续每次写仍会重复白等 3 秒,且挂起会话让 map 无界增长(review: independent P1)。
      if (pendingProtectedRead.get(sessionId) === entry) pendingProtectedRead.delete(sessionId);
      return undefined;
    }
    if (!isDataOwnerGenerationCurrent(entry.owner)) return undefined;
    return pick();
  });
}

/** 读某 (设备, 会话) 缓存的最近一页 server rows;未命中 / 出错一律空数组。 */
export async function readCachedMessages(deviceId: string, sessionId: string): Promise<Message[]> {
  const api = bridge();
  if (!api || !deviceId || !sessionId) return [];
  const ownerAtStart = getDataOwnerGeneration();
  const read = (async (): Promise<Message[]> => {
    try {
      const result = await api.getMessages(deviceId, sessionId);
      // owner 不再是发起时身份(读 IPC 在途期间账号已切换)→ 整份结果作废:
      //  1. 不记 token:把旧账号的 opaque owner token / 代际写回会污染新账号的写入锚点,让 B 复用
      //     同一 sessionId 时被 main fail-closed 持续拒写;
      //  2. **不返回消息**:hydrate 路径没有账号代际复核,会把 A 的消息写进 chat store,
      //     远端首拉失败时 B 会一直看到 A 的消息 —— 跨账号数据泄漏(review: Greptile P1
      //     security)。
      if (!isDataOwnerGenerationCurrent(ownerAtStart)) return [];
      // opaque owner token 与账号代际必须**成对**缓存:counter 不可读(-1 / 未提供)时 token 单独缓存
      // 会让 ownerTokenAtRequestStart 短路返回 token、accountCounterAtRequestStart 却 undefined,
      // 非空写入被 fail-closed 拒到下次 hydrate(review: codex P2)。
      const accountCounter =
        typeof result?.accountCounter === 'number'
        && Number.isInteger(result.accountCounter)
        && result.accountCounter >= 0
          ? result.accountCounter
          : undefined;
      if (accountCounter === undefined) return [];
      rememberMainInvalidation(sessionId, result?.invalidation);
      rememberOwnerToken(sessionId, result?.ownerToken);
      rememberAccountCounter(sessionId, accountCounter);
      return Array.isArray(result?.messages) ? (result.messages as unknown as Message[]) : [];
    } catch (err) {
      log.debug('read cached messages failed', err);
      return [];
    }
  })();
  // 登记在途受保护读:账号切换后首次打开远程会话时,hydrate 的 readCachedMessages 与
  // listMessagesFor 并行,写点要等这份读完成拿到 opaque owner token / 代际,而不是同步拿到 undefined
  // 被 store fail-closed 丢弃(review: Greptile P1)。等它完成后清掉登记,避免泄漏。
  const done = read.then(() => undefined, () => undefined);
  const entry: PendingProtectedRead = { owner: ownerAtStart, done };
  pendingProtectedRead.set(sessionId, entry);
  void done.finally(() => {
    if (pendingProtectedRead.get(sessionId) === entry) pendingProtectedRead.delete(sessionId);
  });
  return read;
}

/** 写某 (设备, 会话) 的最近一页 server rows(空数组 = 清掉该条缓存)。失败静默。 */
/**
 * main 侧会话级作废计数的**本地已知值**。get / put 的响应都会带回它;写入时把它当成
 * "我取到这批内容时的计数"交给 main 比对 —— 于是另一个窗口(甚至另一个共享 userData 的进程)
 * 作废这个会话时,这次写会被 main 丢弃(renderer 本地令牌只在本渲染进程内可见)(review: codex P1)。
 */
const knownMainInvalidation = new Map<string, number>();

/** 每会话最近一次 get 时 main 侧的 opaque owner token(见 persistCachedMessages 的 expectedOwnerToken)。 */
const knownOwnerToken = new Map<string, string>();

/** 每会话最近一次 get 时 main 侧的账号代际计数(clearAll 会自增;区分同账号登出再登录)。 */
const knownAccountCounter = new Map<string, number>();

function rememberMainInvalidation(sessionId: string, value: number | undefined): void {
  // 只缓存**非负**计数:main 在「有墓碑 / 计数不可读」时返回 -1(不可比对),缓存 -1 会让
  // 后续请求同步拿到 -1、被 store 持续拒写,即使之后清理完成也恢复不了(review: copilot)。
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    knownMainInvalidation.set(sessionId, value);
  }
}

function rememberOwnerToken(sessionId: string, value: string | undefined): void {
  if (typeof value === 'string' && value.length > 0) {
    knownOwnerToken.set(sessionId, value);
  }
}

function rememberAccountCounter(sessionId: string, value: number | undefined): void {
  // 同 rememberMainInvalidation:不缓存 -1(不可比对的哨兵值),否则账号代际校验会一直拒写。
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    knownAccountCounter.set(sessionId, value);
  }
}

/** 该会话最近一次 get 时的 opaque owner token;未知返回 undefined。 */
export function knownOwnerTokenFor(sessionId: string): string | undefined {
  return knownOwnerToken.get(sessionId);
}

/**
 * 取"发起这次远端请求时 main 侧的 opaque owner token"。
 *
 * **只信任受保护的缓存读**(`readCachedMessages` / `readCachedSessionList`,经 main 侧
 * `handleMirrorCacheGetMessages` 的 owner 原子复核)带回的值,绝不单独 `getMessages` 补读:
 * 若补读 IPC 在账号切换后才被 main 处理,读到的是**新账号**的 token,旧账号在途响应带着
 * 这个新 token 提交时 `expectedOwnerToken === tokenAtStart` 恰好相等 → 穿透 store 的
 * fail-closed(review: codex P1)。
 *
 * 但也不在未知时直接返回 undefined 丢掉首次写入:账号切换后首次打开会话时,hydrate 的
 * readCachedMessages 与 listMessagesFor **并行**,写点此刻可能还没拿到 opaque owner token。这里
 * **等待在途的受保护读完成**(如果存在),拿到它原子复核过的 token;没有在途读(异常时序)
 * 才返回 undefined → 由 store fail-closed 丢弃(review: Greptile P1)。
 */
export function ownerTokenAtRequestStart(
  sessionId: string,
): string | undefined | Promise<string | undefined> {
  const known = knownOwnerToken.get(sessionId);
  if (typeof known === 'string') return known;
  const pending = pendingProtectedRead.get(sessionId);
  // 只等**当前账号**发起的在途读:B 复用同一 sessionId 时,A 的在途读已被账号边界作废
  // (它完成时会因代际不符不写令牌),等它只会白等一场再拿到 undefined(review: Greptile P1)。
  if (pending && isDataOwnerGenerationCurrent(pending.owner)) {
    return afterProtectedRead(sessionId, pending, () => knownOwnerToken.get(sessionId));
  }
  return undefined;
}

/** 该会话最近一次 get 时的账号代际计数;未知道等受保护读,无在途读则 undefined(fail-closed)。 */
export function accountCounterAtRequestStart(
  sessionId: string,
): number | undefined | Promise<number | undefined> {
  const known = knownAccountCounter.get(sessionId);
  if (typeof known === 'number') return known;
  const pending = pendingProtectedRead.get(sessionId);
  if (pending && isDataOwnerGenerationCurrent(pending.owner)) {
    return afterProtectedRead(sessionId, pending, () => knownAccountCounter.get(sessionId));
  }
  return undefined;
}

export function persistCachedMessages(
  deviceId: string,
  sessionId: string,
  rows: readonly Message[],
  expectedInvalidation?: number | Promise<number | undefined>,
  expectedOwnerToken?: string | Promise<string | undefined>,
  expectedAccountCounter?: number | Promise<number | undefined>,
): void {
  const api = bridge();
  if (!api || !deviceId || !sessionId) return;
  const dispatch = (
    expected: number | undefined,
    ownerToken: string | undefined,
    accountCounter: number | undefined,
  ): void => {
    void api
      .putMessages(
        deviceId,
        sessionId,
        rows as unknown as Record<string, unknown>[],
        expected,
        ownerToken,
        accountCounter,
      )
      .then((result) => rememberMainInvalidation(sessionId, result?.invalidation))
      .catch((err: unknown) => log.debug('persist cached messages failed', err));
  };
  // 令牌已经在手 / 根本没有(空写)时**同步**派发 —— 清缓存这类"必须尽快到 main"的调用不该
  // 因为多一个 await 被推到下一个微任务(顺序会被后面的写入抢到前面去)。
  if (
    (typeof expectedInvalidation === 'number' || expectedInvalidation === undefined)
    && (typeof expectedOwnerToken === 'string' || expectedOwnerToken === undefined)
    && (typeof expectedAccountCounter === 'number' || expectedAccountCounter === undefined)
  ) {
    dispatch(expectedInvalidation, expectedOwnerToken, expectedAccountCounter);
    return;
  }
  void Promise.all([
    expectedInvalidation instanceof Promise
      ? expectedInvalidation
      : Promise.resolve(expectedInvalidation),
    expectedOwnerToken instanceof Promise ? expectedOwnerToken : Promise.resolve(expectedOwnerToken),
    expectedAccountCounter instanceof Promise
      ? expectedAccountCounter
      : Promise.resolve(expectedAccountCounter),
  ] as const)
    .then(([expected, ownerToken, accountCounter]) =>
      dispatch(expected, ownerToken, accountCounter),
    )
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
  const ownerAtStart = getDataOwnerGeneration();
  return tokenReadWithin(api.getMessages(deviceId, sessionId))
    .then((result) => {
      // 补读永久挂起时不能让 persistCachedMessages 的 Promise.all 永久堵住:3 秒后以 undefined
      // 收敛,交给 store fail-closed 丢这次 best-effort 写(review: copilot suppressed)。
      if (!result || !isDataOwnerGenerationCurrent(ownerAtStart)) return undefined;
      rememberMainInvalidation(sessionId, result.invalidation);
      // 刻意**不**在这里 rememberOwnerToken:这个补读 IPC 可能在账号切换后才被 main 处理,
      // 会把新账号的 token 记进 knownOwnerToken,污染后续写入的 owner 锚点(review: codex P1)。
      // opaque owner token 只由受保护的 readCachedMessages / readCachedSessionList 写入。
      return typeof result.invalidation === 'number' ? result.invalidation : undefined;
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

/** 最近一次读会话列表时 main 侧的 opaque owner token(供去抖回写时原样回传,见 scheduleSessionListPersist)。 */
let knownSessionListOwnerToken: string | undefined;

/** 最近一次读会话列表时 main 侧的账号代际计数(clearAll 自增;区分同账号登出再登录)。 */
let knownSessionListAccountCounter: number | undefined;

/**
 * 会话列表的 owner 锚点是否已就位(opaque owner token + 账号代际都拿到了)。
 *
 * 账号切换后 `clearMirrorCacheAccountState` 清空它们,由 `readCachedSessionList` 重新填充;
 * 补读可能因待清队列 / owner 边界复核 / 瞬时 IPC 错误失败。调用方(账号边界 effect)靠这个
 * 判断是否需要重试补读,避免新账号的排程回写一直带 undefined 被 fail-closed 丢弃
 * (review: Greptile P1)。
 */
export function sessionListOwnerTokensReady(): boolean {
  return typeof knownSessionListOwnerToken === 'string'
    && typeof knownSessionListAccountCounter === 'number';
}

/** 读侧边栏远程会话列表快照;未命中 / 出错一律空数组。 */
export async function readCachedSessionList(): Promise<CachedDeviceSessionsSnapshot[]> {
  const api = bridge();
  if (!api) return [];
  const ownerAtStart = getDataOwnerGeneration();
  try {
    const result = await api.getSessionList();
    // owner 不再是发起时身份(读 IPC 在途期间账号已切换)→ 整份结果作废,与 readCachedMessages
    // 完全一致:
    //  1. 不记 token:旧账号的 token / 代际会污染新账号排程回写的锚点(review: Greptile P1);
    //  2. **不返回 devices**:调用方(冷启动 hydrate)会把这份快照直接种进侧边栏,B 会看到 A
    //     的设备与会话标题 —— 跨账号数据串读(review: copilot P1)。
    if (!isDataOwnerGenerationCurrent(ownerAtStart)) return [];
    if (typeof result?.ownerToken === 'string' && result.ownerToken.length > 0) {
      knownSessionListOwnerToken = result.ownerToken;
    }
    if (
      typeof result?.accountCounter === 'number'
      && Number.isInteger(result.accountCounter)
      && result.accountCounter >= 0
    ) {
      knownSessionListAccountCounter = result.accountCounter;
    }
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
  // 排程时快照 renderer owner 代际(不是 token 字符串):触发时 owner 已变就整笔丢弃,绝不能
  // 用新账号令牌提交旧账号排下的 collect。仍是同一代时,触发点读取**最新**已知 token / counter:
  // 排程与 1.2s debounce 之间的 session-list 补读可能刚把令牌补齐,若把 undefined 冻结在闭包,
  // 这次非空快照会被 main fail-closed 丢弃,而相同 reconcile 数据不再通知时缓存就持续陈旧
  // (review: codex P2)。令牌仍只来自受保护 readCachedSessionList,这里不发起异步补读。
  const ownerAtSchedule = getDataOwnerGeneration();
  pendingCollect = collect;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const fn = pendingCollect;
    pendingCollect = null;
    if (!fn) return;
    // 账号边界已推进:fn 虽然是懒 collect,但排程动作属于旧账号;不能用新账号令牌落盘。
    if (!isDataOwnerGenerationCurrent(ownerAtSchedule)) return;
    try {
      writeSessionListNow(fn(), knownSessionListOwnerToken, knownSessionListAccountCounter);
    } catch (err) {
      // collect 本身抛错也静默:最多损失一次快照更新,不能影响侧边栏。
      log.debug('collect session list snapshot failed', err);
    }
  }, debounceMs);
}

function writeSessionListNow(
  devices: readonly CachedDeviceSessionsSnapshot[],
  expectedOwnerToken?: string,
  expectedAccountCounter?: number,
): void {
  const api = bridge();
  if (!api) return;
  void api
    .putSessionList(
      devices.map((device) => ({
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        sessions: device.sessions as unknown as Record<string, unknown>[],
      })),
      expectedOwnerToken,
      expectedAccountCounter,
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
  // 刻意**不**清 opaque owner token / 账号代际:本函数既在账号边界也在 relay-stopped(服务停掉而非
  // 登出)时被调用。relay-stopped 时清掉 token 会让同一挂载实例重新 online 后 `scheduleSessionListPersist`
  // 持续带 undefined 写非空快照,被 main fail-closed 丢弃 —— 侧边栏冷缓存直到重挂载都不刷新
  // (review: codex P2)。owner / 代际的清空只归真正的账号边界 `clearMirrorCacheAccountState()`。
}

/**
 * 清空账号边界上的 renderer 侧镜像缓存状态(登出 / 切账号时必须调用)。
 *
 * 每条会话的 `knownOwnerToken` 是在某个账号下读缓存时记下的;账号切换后若不清理,B 复用
 * 同一 sessionId 时会一直带着 A 的 token 提交,被 store 的 fail-closed 持续拒写 —— 新账号
 * 的缓存从此静默失效(review: #1801)。会话级 `knownMainInvalidation` / `knownAccountCounter`
 * 同理,留在旧账号的会话上可能让后续写入的计数比对错位。owner / 代际 / 计数的唯一正确来源
 * 是「当前账号下的受保护缓存读」,切换后让它们重新从读路径获取,而不是继承旧账号的残留。
 */
export function clearMirrorCacheAccountState(): void {
  knownOwnerToken.clear();
  knownMainInvalidation.clear();
  knownAccountCounter.clear();
  knownSessionListOwnerToken = undefined;
  knownSessionListAccountCounter = undefined;
  // 在途受保护读也要摘掉:它属于旧账号,完成时会因代际不符不写令牌。留着会让 B 复用同一
  // sessionId 时的写点去等一笔注定拿不到令牌的读(review: Greptile P1)。`afterProtectedRead`
  // 的代际复核已是兜底,这里直接摘掉登记,让 B 的写点走「无在途读 → undefined」的快路径。
  pendingProtectedRead.clear();
}

export const __testing = {
  writeSessionListNow,
  clearMirrorCacheAccountState,
};
