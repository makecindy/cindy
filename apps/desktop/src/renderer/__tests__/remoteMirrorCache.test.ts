/**
 * remoteMirrorCache.test.ts —— 远程会话镜像冷缓存在 renderer 侧的接线。
 *
 * 缓存的价值是「冷启动 / 被控端离线时先画出上次看到的最近一页」,风险是「把已经不存在的
 * 消息留在屏上」。这里守两头:
 *  - hydrate:远程会话首拉未回来时用缓存种入,行带 cacheHydrated 标记;
 *  - 接管:fresh 一到就整批剔除缓存行 —— 被控端 /clear、rewind、删消息后不得残留;
 *  - 写点纪律:只有远程会话的**最新页**写缓存(翻页、本机会话都不写);
 *  - 列表快照:hydrateFromCache 只种空缺设备、一律标 disconnected(不画假在线)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { Message } from '@/lib/ccAgent.types';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  around: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));
vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({
    agentKind: 'cc',
    remoteHostId: null,
    sdkSessionId: null,
    fastMode: false,
    contextTokens: 0,
    contextWindow: 0,
    totalCostUsd: 0,
  })),
  update: vi.fn(async () => ({})),
  touchUserSend: vi.fn(async () => ({})),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { listMessagesFor } from '@/lib/makerTransport';
import { collectSessionListSnapshot } from '@/features/device-link/refreshRemoteSessions';
import {
  cancelSessionListPersist,
  clearCachedDevice,
  clearCachedMessages,
  clearMirrorCacheAccountState,
  readCachedMessages,
  readCachedSessionList,
  scheduleSessionListPersist,
} from '@/features/device-link/mirrorCacheClient';
import {
  __testing as dataOwnerGenTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import * as messageService from '@/lib/messageService';

const DEVICE_ID = 'dev-A';
let n = 0;
const sid = (): string => `mirror-cache-${n++}`;

function dbMessage(sessionId: string, id: string, content: string, ts: string): Message {
  return {
    id,
    clientId: `client-${id}`,
    sessionId,
    role: 'assistant',
    content,
    toolUseId: null,
    agentMeta: null,
    createdAt: ts,
  };
}

function dbPlanToolMessage(sessionId: string, id: string, ts: string): Message {
  const toolUseId = `tool-${id}`;
  return {
    id,
    clientId: `client-${id}`,
    sessionId,
    role: 'tool_use',
    content: {
      toolName: 'update_plan',
      toolUseId,
      input: {
        plan: [{ content: 'Cached remote plan', status: 'in_progress' }],
      },
    },
    toolUseId,
    agentMeta: null,
    createdAt: ts,
  } as unknown as Message;
}

/** 被控端经隧道返回的权威列表;可换成挂起的 promise 模拟慢隧道 / 离线。 */
let remoteList: Message[] = [];
let remoteListPromise: Promise<Message[]> | null = null;
const invoke = vi.fn(async (_deviceId: string, channel: string, args: unknown[]) => {
  if (channel === 'local-db:messages:list') return remoteListPromise ?? remoteList;
  if (channel === 'local-db:sessions:get') {
    return {
      agentKind: 'cc',
      remoteHostId: null,
      sdkSessionId: null,
      fastMode: false,
      contextTokens: 0,
      contextWindow: 0,
      totalCostUsd: 0,
    };
  }
  if (channel === 'maker:input:get-projection' || channel === 'maker:input:clear-session') {
    // clear-session 必须返回合法 projection:返回 null 会让 applyInputProjection 抛出
    // 未捕获拒绝(那条链在 clearSessionAfterGuard 里没有 catch),整轮 vitest 会因此失败。
    return emptyProjection(String(args[0]));
  }
  return null;
});

function emptyProjection(sessionId: string) {
  return {
    sessionId,
    pendingQueue: [],
    steeringQueueClientIds: [],
    queuePaused: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    error: null,
    recovery: null,
    errorRetryText: null,
  };
}

/** 盘上缓存的替身:key 为 `${deviceId}::${sessionId}`。 */
let cachedMessages = new Map<string, Record<string, unknown>[]>();
/** get 的返回形状:main 会把当前会话级作废计数与 owner root / 账号代际一起带回来。 */
type CachedRead = {
  messages: Record<string, unknown>[];
  invalidation: number;
  ownerToken?: string;
  accountCounter?: number;
};
let cachedInvalidation = 7;
let cachedOwnerToken = 'opaque-owner-token-a';
let cachedAccountCounter = 0;
const getMessages = vi.fn<
  (
    deviceId: string,
    sessionId: string,
  ) => Promise<{
    messages: Record<string, unknown>[];
    invalidation: number;
    ownerToken?: string;
    accountCounter?: number;
  }>
>(async (deviceId: string, sessionId: string) => ({
  messages: cachedMessages.get(`${deviceId}::${sessionId}`) ?? [],
  invalidation: cachedInvalidation,
  ownerToken: cachedOwnerToken,
  accountCounter: cachedAccountCounter,
}));
// 显式签名(而非从实现推断):断言里要读 mock.calls[0][0/1],推断成空元组就取不到。
const putMessages = vi.fn<
  (
    deviceId: string,
    sessionId: string,
    rows: readonly Record<string, unknown>[],
    expectedInvalidation?: number,
    expectedOwnerToken?: string,
    expectedAccountCounter?: number,
  ) => Promise<{ ok: true }>
>(async () => ({ ok: true as const }));

/**
 * 断言"某次写入发生过"。不用 toHaveBeenCalledWith:写入现在还带第 4~6 个参数
 * (main 侧作废计数 / owner root / 账号代际,值随路径不同),逐参数写死会让断言变脆。
 */
function expectPut(deviceId: string, sessionId: string, rows: unknown[]): void {
  const hit = putMessages.mock.calls.some(
    ([d, s2, r]) =>
      d === deviceId && s2 === sessionId && JSON.stringify(r) === JSON.stringify(rows),
  );
  expect(hit).toBe(true);
}
const getSessionList = vi.fn(async () => ({
  devices: [] as never[],
  ownerToken: cachedOwnerToken,
  accountCounter: cachedAccountCounter,
}));
const putSessionList = vi.fn<
  (
    devices: readonly Record<string, unknown>[],
    expectedOwnerToken?: string,
    expectedAccountCounter?: number,
  ) => Promise<{ ok: true }>
>(async () => ({ ok: true as const }));
const clearCache = vi.fn(async () => ({ ok: true as const }));

function stubApi(): void {
  const onNoop = vi.fn(() => vi.fn());
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    electronAPI: {
      maker: {
        input: { getProjection: vi.fn(async (s: string) => emptyProjection(s)) },
        getPendingInteractions: vi.fn(async () => []),
        onEvent: onNoop,
        onStatusChanged: onNoop,
        onInputProjection: onNoop,
        onInteractionRequest: onNoop,
        onInteractionDismissed: onNoop,
      },
      localDb: { messages: { onCreated: onNoop } },
      onUsageMessageTurnCost: onNoop,
      deviceLink: {
        invoke,
        onRemotePush: onNoop,
        mirrorCache: {
          getMessages,
          putMessages,
          getSessionList,
          putSessionList,
          clear: clearCache,
        },
      },
    },
  });
}

async function flush(ticks = 12): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

/** 把会话登记成 dev-A 的远程会话(不触发首拉)。 */
function registerRemote(sessionId: string): void {
  remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: sessionId }] as never);
}

beforeEach(() => {
  makerChatStore.__teardownGlobalListeners();
  stubApi();
  remoteList = [];
  remoteListPromise = null;
  cachedMessages = new Map();
  invoke.mockClear();
  cachedInvalidation = 7;
  cachedOwnerToken = 'opaque-owner-token-a';
  cachedAccountCounter = 0;
  getMessages.mockClear();
  putMessages.mockClear();
  putSessionList.mockClear();
  clearCache.mockClear();
});

afterEach(() => {
  makerChatStore.__teardownGlobalListeners();
  remoteProjectsStore.clear();
  // 清掉 per-session owner root / 作废计数残留,保持测试隔离。
  clearMirrorCacheAccountState();
  dataOwnerGenTesting.reset();
  vi.unstubAllGlobals();
});

describe('冷缓存 hydrate', () => {
  it('首拉未回来时用缓存种入,行带 cacheHydrated 且不置 historyLoaded', async () => {
    const s = sid();
    cachedMessages.set(`${DEVICE_ID}::${s}`, [
      dbMessage(s, 'a', 'cached A', '2026-01-01T00:00:00.000Z') as unknown as Record<
        string,
        unknown
      >,
    ]);
    registerRemote(s);
    // 隧道挂起 = 慢网 / 被控端离线:缓存是屏上唯一内容。
    remoteListPromise = new Promise<Message[]>(() => {});

    makerChatStore.ensureInitialMessages(s);
    await flush();

    const snapshot = makerChatStore.getSnapshot(s);
    expect(snapshot.messages.map((m) => m.clientId)).toEqual(['client-a']);
    expect(snapshot.messages[0].cacheHydrated).toBe(true);
    expect(snapshot.historyLoaded).toBe(false);
    // 缓存窗口不接管分页游标:不发注定失败的隧道翻页。
    expect(snapshot.hasMoreMessages).toBe(false);
  });

  it('缓存页只有计划工具行时仍种入,供 PinnedPlanPanel 派生计划', async () => {
    const s = sid();
    cachedMessages.set(`${DEVICE_ID}::${s}`, [
      dbPlanToolMessage(s, 'plan', '2026-01-01T00:00:00.000Z') as unknown as Record<
        string,
        unknown
      >,
    ]);
    registerRemote(s);
    remoteListPromise = new Promise<Message[]>(() => {});

    makerChatStore.ensureInitialMessages(s);
    await flush();

    const snapshot = makerChatStore.getSnapshot(s);
    expect(snapshot.messages.map((m) => m.clientId)).toEqual(['client-plan']);
    expect(snapshot.messages[0].cacheHydrated).toBe(true);
    expect(snapshot.historyLoaded).toBe(false);
  });

  it('fresh 落地后整批剔除缓存行:权威页里没有的缓存消息不残留', async () => {
    const s = sid();
    cachedMessages.set(`${DEVICE_ID}::${s}`, [
      dbMessage(s, 'gone', 'deleted upstream', '2026-01-01T00:00:00.000Z') as unknown as Record<
        string,
        unknown
      >,
      dbMessage(s, 'kept', 'still there', '2026-01-02T00:00:00.000Z') as unknown as Record<
        string,
        unknown
      >,
    ]);
    registerRemote(s);
    // 被控端只剩 kept(gone 已被删 / rewind 掉)。
    remoteList = [dbMessage(s, 'kept', 'still there', '2026-01-02T00:00:00.000Z')];

    makerChatStore.ensureInitialMessages(s);
    await flush(30);

    const snapshot = makerChatStore.getSnapshot(s);
    expect(snapshot.messages.map((m) => m.clientId)).toEqual(['client-kept']);
    expect(snapshot.messages.every((m) => m.cacheHydrated !== true)).toBe(true);
    expect(snapshot.historyLoaded).toBe(true);
  });

  it('权威页为空(被控端 /clear)→ 缓存行清空,不留旧正文', async () => {
    const s = sid();
    cachedMessages.set(`${DEVICE_ID}::${s}`, [
      dbMessage(s, 'stale', 'cleared upstream', '2026-01-01T00:00:00.000Z') as unknown as Record<
        string,
        unknown
      >,
    ]);
    registerRemote(s);
    remoteList = [];

    makerChatStore.ensureInitialMessages(s);
    await flush(30);

    const snapshot = makerChatStore.getSnapshot(s);
    expect(snapshot.messages).toHaveLength(0);
    expect(snapshot.historyLoaded).toBe(true);
    // 空页也要把盘上那份清掉(putMessages 收到空数组 = 删除)。
    expectPut(DEVICE_ID, s, []);
  });

  // review(codex P1):读缓存这一跳期间设备可能已被移除 / 会话换到了另一台设备。
  // 只看 chat state 挡不住,于是 A 的历史会被种进一个已经不属于 A 的会话。
  it('读缓存期间设备已离场 → 不种入(不把另一台机器的历史画上去)', async () => {
    const s = sid();
    cachedMessages.set(`${DEVICE_ID}::${s}`, [
      dbMessage(s, 'a', 'cached A', '2026-01-01T00:00:00.000Z') as unknown as Record<
        string,
        unknown
      >,
    ]);
    registerRemote(s);
    remoteListPromise = new Promise<Message[]>(() => {}); // 首拉挂起(被控端离线)
    // 缓存读挂起,等我们把设备摘掉之后才 resolve。
    let resolveRead: (value: CachedRead) => void = () => {};
    getMessages.mockImplementationOnce(
      () =>
        new Promise<CachedRead>((resolve) => {
          resolveRead = resolve;
        }),
    );

    makerChatStore.ensureInitialMessages(s);
    await flush();
    remoteProjectsStore.removeDevice(DEVICE_ID);
    resolveRead({
      messages: cachedMessages.get(`${DEVICE_ID}::${s}`) ?? [],
      invalidation: cachedInvalidation,
    });
    await flush(20);

    expect(makerChatStore.getSnapshot(s).messages).toHaveLength(0);
  });

  it('本机会话不读缓存(本机历史就在本机 DB)', async () => {
    const s = sid();
    makerChatStore.ensureInitialMessages(s);
    await flush();
    expect(getMessages).not.toHaveBeenCalled();
  });

  // review(codex P1):整页无可见渲染锚点时,种入会让 messages 非空(于是 loading 覆盖层
  // 被收起)但 MessageStream 渲染 0 项 —— 被控端离线时就是一片永久空白。
  // review(codex P1):rewind 之后紧随的权威首拉若失败(被控端离线),原先 catch 会把
  // hydrate 守卫整个放开 —— 重挂会话就把 rewind 之前的旧缓存(已被软删的消息)画回来。
  it('rewind 重载后首拉失败 → 重挂会话仍不借那份过期缓存', async () => {
    const s = sid();
    cachedMessages.set(`${DEVICE_ID}::${s}`, [
      dbMessage(
        s,
        'pre-rewind',
        '被 rewind 截掉的消息',
        '2026-01-01T00:00:00.000Z',
      ) as unknown as Record<string, unknown>,
    ]);
    registerRemote(s);
    // 先正常加载一次(权威页有内容),再 rewind。
    remoteList = [dbMessage(s, 'kept', 'kept', '2026-01-02T00:00:00.000Z')];
    makerChatStore.ensureInitialMessages(s);
    await flush(30);

    // rewind 之后的重载:权威首拉失败(被控端离线)。
    remoteListPromise = Promise.reject(new Error('DEVICE_OFFLINE'));
    makerChatStore.reloadMessages(s);
    await flush(30);
    expect(makerChatStore.getSnapshot(s).messages).toHaveLength(0);

    // 重挂会话(remount)→ 仍然不许把 rewind 之前的缓存种回来。
    makerChatStore.ensureInitialMessages(s);
    await flush(30);
    expect(makerChatStore.getSnapshot(s).messages).toHaveLength(0);
  });

  // review(codex P1):这次读是在 rewind **之前**发起的,入口的抑制检查挡不住它。
  it('在途的缓存读遇上 rewind → 不把 rewind 之前的行插进刚清空的切片', async () => {
    const s = sid();
    cachedMessages.set(`${DEVICE_ID}::${s}`, [
      dbMessage(s, 'pre', '被 rewind 截掉', '2026-01-01T00:00:00.000Z') as unknown as Record<
        string,
        unknown
      >,
    ]);
    registerRemote(s);
    remoteListPromise = new Promise<Message[]>(() => {}); // 首拉挂起
    let resolveRead: (value: CachedRead) => void = () => {};
    getMessages.mockImplementationOnce(
      () =>
        new Promise<CachedRead>((resolve) => {
          resolveRead = resolve;
        }),
    );

    makerChatStore.ensureInitialMessages(s);
    await flush();
    // rewind:清空切片 + 置抑制(缓存读仍在途)
    makerChatStore.reloadMessages(s);
    await flush();
    resolveRead({
      messages: cachedMessages.get(`${DEVICE_ID}::${s}`) ?? [],
      invalidation: cachedInvalidation,
    });
    await flush(20);

    expect(makerChatStore.getSnapshot(s).messages).toHaveLength(0);
  });

  it('权威页落地后粘滞抑制解除:再一次重挂可以照常借缓存', async () => {
    const s = sid();
    registerRemote(s);
    remoteList = [dbMessage(s, 'fresh', 'fresh', '2026-01-02T00:00:00.000Z')];
    makerChatStore.reloadMessages(s); // 作废式重载 → 置抑制
    await flush(30);
    expect(makerChatStore.getSnapshot(s).historyLoaded).toBe(true);

    // 权威已落地 → 抑制解除。清掉切片后再借缓存应当成功。
    cachedMessages.set(`${DEVICE_ID}::${s}`, [
      dbMessage(s, 'cold', 'cold', '2026-01-03T00:00:00.000Z') as unknown as Record<
        string,
        unknown
      >,
    ]);
    remoteListPromise = new Promise<Message[]>(() => {}); // 隧道挂起,缓存是屏上唯一内容
    makerChatStore.reloadMessages(s, { allowCacheHydrate: true });
    await flush(30);
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-cold']);
  });

  it('缓存页整页都是 orphan tool_result → 不种入,留给 loading 覆盖层', async () => {
    const s = sid();
    cachedMessages.set(`${DEVICE_ID}::${s}`, [
      {
        id: 'tr1',
        clientId: 'client-tr1',
        sessionId: s,
        role: 'tool_result',
        content: 'orphan result',
        toolUseId: 'tu-missing',
        agentMeta: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    registerRemote(s);
    remoteListPromise = new Promise<Message[]>(() => {});

    makerChatStore.ensureInitialMessages(s);
    await flush();

    expect(makerChatStore.getSnapshot(s).messages).toHaveLength(0);
  });

  // review(codex P1):启动竞速里会话先以 origin=undefined 命中本机空库,mapping 注入后
  // reconcileOpenSessionOrigins 会重载一次。那次重载并没有让缓存过期(这才是本会话第一次
  // 知道自己是远程会话),压着不 hydrate 的话被控端离线时只剩空白 + spinner。
  it('origin 首次解析(undefined → deviceId)后的重载仍然借缓存', async () => {
    const s = sid();
    // 1) 竞速:mapping 未注入 → 命中本机空库(messageService.list 返回 [])。
    makerChatStore.ensureInitialMessages(s);
    await flush(20);
    expect(makerChatStore.getSnapshot(s).historyLoaded).toBe(true);

    // 2) bootstrap 注入来源;被控端离线(隧道必失败),盘上有上次看到的最近一页。
    cachedMessages.set(`${DEVICE_ID}::${s}`, [
      dbMessage(
        s,
        'cold',
        'cached before restart',
        '2026-01-01T00:00:00.000Z',
      ) as unknown as Record<string, unknown>,
    ]);
    registerRemote(s);
    remoteListPromise = Promise.reject(new Error('DEVICE_OFFLINE'));

    makerChatStore.reconcileOpenSessionOrigins();
    await flush(30);

    const snapshot = makerChatStore.getSnapshot(s);
    expect(snapshot.messages.map((m) => m.clientId)).toEqual(['client-cold']);
    expect(snapshot.messages[0].cacheHydrated).toBe(true);
  });

  it('缓存页里只要有一条可见锚点就照常种入', async () => {
    const s = sid();
    cachedMessages.set(`${DEVICE_ID}::${s}`, [
      {
        id: 'tr1',
        clientId: 'client-tr1',
        sessionId: s,
        role: 'tool_result',
        content: 'orphan result',
        toolUseId: 'tu-missing',
        agentMeta: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      dbMessage(s, 'a1', 'visible answer', '2026-01-02T00:00:00.000Z') as unknown as Record<
        string,
        unknown
      >,
    ]);
    registerRemote(s);
    remoteListPromise = new Promise<Message[]>(() => {});

    makerChatStore.ensureInitialMessages(s);
    await flush();

    expect(makerChatStore.getSnapshot(s).messages.some((m) => m.clientId === 'client-a1')).toBe(
      true,
    );
  });
});

describe('缓存写点纪律', () => {
  it('远程会话最新页 → 写缓存', async () => {
    const s = sid();
    registerRemote(s);
    remoteList = [dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')];

    await listMessagesFor(s);
    await flush();

    expect(putMessages).toHaveBeenCalledTimes(1);
    expect(putMessages.mock.calls[0]?.[0]).toBe(DEVICE_ID);
    expect(putMessages.mock.calls[0]?.[1]).toBe(s);
  });

  it('本地还没有令牌时,在请求发起时补读一次计数,并把它带给这次写入', async () => {
    // review(codex P1):main 拒绝没带令牌的非空写入(缓存读与远端请求刻意并行,远端页可能
    // 先到)。补读必须发生在**发起远端请求时**,拖到落盘前做就会读到清理之后的值。
    const s = sid();
    registerRemote(s);
    cachedInvalidation = 11;
    remoteList = [dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')];

    await listMessagesFor(s);
    await flush(20);

    expect(putMessages).toHaveBeenCalledTimes(1);
    expect(putMessages.mock.calls[0]?.[3]).toBe(11);
  });

  it('本地还没有 owner root 时,写入不携带 owner root(由 store fail-closed 决定去留)', async () => {
    // review(#1783 / codex P1):owner root 只信任受保护读(如 readCachedMessages)带回的已知值;
    // 不知道时**不做异步补读** —— 补读 IPC 若在账号切换后才被 main 处理,会把新账号的 root
    // 当成本次请求的 owner 锚点,反而让旧账号在途响应通过比对。未知即传 undefined,由 store
    // 侧 fail-closed 丢弃(缓存是纯优化)。
    const s = sid();
    registerRemote(s);
    // 不预置 knownOwnerToken:直接发起远端请求,owner root 未知。
    cachedOwnerToken = 'opaque-owner-token-b';
    remoteList = [dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')];

    await listMessagesFor(s);
    await flush(20);

    // 写入仍会发出(会话计数在),但第 5 个参数(owner root)应为 undefined。
    expect(putMessages).toHaveBeenCalledTimes(1);
    expect(putMessages.mock.calls[0]?.[4]).toBeUndefined();
  });

  it('账号切换后复用同一 sessionId:旧账号残留 owner root 被清,新账号可重建缓存', async () => {
    // review(#1801):knownOwnerToken 是 per-session、在某账号下读缓存时记下的。账号切换后若
    // B 复用同一 sessionId,不清理的话会一直带着 A 的 root 提交,被 store fail-closed 持续
    // 拒写 → B 的缓存静默失效。账号边界必须清空 per-session 残留,让 owner 重新从受保护读
    // 获取。
    const s = sid();
    registerRemote(s);

    // 账号 A:先有一次成功的缓存读,让 knownOwnerToken 记住 A 的 root。
    cachedOwnerToken = 'opaque-owner-token-a';
    await readCachedMessages(DEVICE_ID, s);
    expect(putMessages).not.toHaveBeenCalled();

    // 账号边界:登出 A / 切到 B。
    cachedOwnerToken = 'opaque-owner-token-b';
    clearMirrorCacheAccountState();

    // 账号 B:复用同一 sessionId。真实时序里 B 的 hydrate 会先做一次受保护的缓存读(把
    // knownOwnerToken 重设为 B 的 root),随后远端请求的写入才能带上正确的 B root —— 而不是
    // A 的残留。这里复现「边界清空 → B 重新读到 B root → 写入带 B root」的完整序列。
    await readCachedMessages(DEVICE_ID, s);
    remoteList = [dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')];
    await listMessagesFor(s);
    await flush(20);

    expect(putMessages).toHaveBeenCalledTimes(1);
    expect(putMessages.mock.calls[0]?.[4]).toBe('opaque-owner-token-b');
  });

  it('在途缓存读在账号切换后才完成 → 不把旧账号 owner root 写回 knownOwnerToken', async () => {
    // review(Greptile P1):readCachedMessages 的 IPC 在途期间账号切换,clearMirrorCacheAccountState
    // 已清掉旧 token;读完成时若直接写回,会把 A 的 owner root / 代际重新种回,导致 B 复用同一
    // sessionId 时被 main fail-closed 持续拒写。读完成前先校验 owner 仍是发起时身份,不是则丢弃。
    const s = sid();
    registerRemote(s);

    // 账号 A 发起一次受保护缓存读,让它挂起(读完成前切换账号)
    setDataOwnerGeneration('owner-a', 1);
    let resolveRead!: (v: CachedRead) => void;
    getMessages.mockImplementationOnce(
      () =>
        new Promise<CachedRead>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const readPromise = readCachedMessages(DEVICE_ID, s);
    await flush(2);

    // 账号切换:dataOwnerGeneration 推进到 B(模拟 runtime 替换刷新直接发布新 owner)
    setDataOwnerGeneration('owner-b', 2);
    clearMirrorCacheAccountState();
    // 旧读完成,返回 A 的 root + A 的消息 —— 但 owner 已变:
    //  1. 不应写回 knownOwnerToken;
    //  2. **不应把 A 的消息返回**给 hydrate(否则 B 会看到 A 的消息,远端首拉失败时持续保留,
    //     跨账号泄漏)(review: Greptile P1 security)。
    resolveRead({
      messages: [{ id: 'a-msg', role: 'user', content: 'secret A message' }] as never,
      invalidation: 0,
      ownerToken: 'opaque-owner-token-a',
      accountCounter: 0,
    });
    const rows = await readPromise;
    expect(rows).toEqual([]);

    // B 发起远端请求:owner root 应未知(B 的受保护读还没跑),写入不携带 A 的残留
    cachedOwnerToken = 'opaque-owner-token-b';
    remoteList = [dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')];
    await listMessagesFor(s);
    await flush(20);

    expect(putMessages).toHaveBeenCalledTimes(1);
    // 若旧 A root 被写回,这里会带上 A 的 root;正确行为是 undefined(B 尚未重读)
    expect(putMessages.mock.calls[0]?.[4]).toBeUndefined();
  });

  it('accountCounter 不可读(-1)时整份读作废:消息不种入、owner root 不缓存', async () => {
    // review(Codex P2):owner root 与账号代际必须**成对**缓存。main 在「计数不可读」时返回
    // -1,此时若仍单独缓存 owner root,ownerTokenAtRequestStart 会短路返回 root、
    // accountCounterAtRequestStart 却 undefined → 非空写入被 store fail-closed 拒到下次
    // hydrate。counter 无效 = root 也不记,整份读作废返回 []。
    const s = sid();
    registerRemote(s);
    cachedMessages.set(`${DEVICE_ID}::${s}`, [
      dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z') as unknown as Record<string, unknown>,
    ]);
    cachedAccountCounter = -1; // main 返回「计数不可读」哨兵

    const rows = await readCachedMessages(DEVICE_ID, s);
    expect(rows).toEqual([]); // 不把盘上缓存内容种入

    // 远端请求:写入不应携带任何残留令牌(counter 无效 → root 也没缓存)
    remoteList = [dbMessage(s, 'm2', 'x', '2026-01-01T00:00:01.000Z')];
    await listMessagesFor(s);
    await flush(20);

    expect(putMessages).toHaveBeenCalledTimes(1);
    expect(putMessages.mock.calls[0]?.[4]).toBeUndefined(); // owner root
    expect(putMessages.mock.calls[0]?.[5]).toBeUndefined(); // account counter
  });

  it('翻页(before / beforeTs)不写缓存:老窗口不是"最近一页"', async () => {
    const s = sid();
    registerRemote(s);
    remoteList = [dbMessage(s, 'old', 'x', '2025-01-01T00:00:00.000Z')];

    await listMessagesFor(s, { limit: 50, before: 'some-id' });
    await listMessagesFor(s, { limit: 50, beforeTs: 1_700_000_000_000 });
    await flush();

    expect(putMessages).not.toHaveBeenCalled();
  });

  it('本机会话不写缓存', async () => {
    const s = sid();
    vi.mocked(messageService.list).mockResolvedValueOnce([
      dbMessage(s, 'local', 'x', '2026-01-01T00:00:00.000Z'),
    ]);

    await listMessagesFor(s);
    await flush();

    expect(putMessages).not.toHaveBeenCalled();
  });

  // review(codex P1):请求在途期间设备可能被撤销 / 关闭被控,那条路径已经清过盘了;
  // 迟到的响应若照写,会用清理**之后**的 main 代际把被撤销对端的明文重新落盘。
  it('响应回来前设备已离场 → 丢弃这次写入(不把被撤销对端的正文写回)', async () => {
    const s = sid();
    registerRemote(s);
    let resolveList: (rows: Message[]) => void = () => {};
    remoteListPromise = new Promise<Message[]>((resolve) => {
      resolveList = resolve;
    });

    const pending = listMessagesFor(s);
    // 撤销访问 / 关闭被控 → 设备分片被移除,mapping 随之消失。
    remoteProjectsStore.removeDevice(DEVICE_ID);
    resolveList([dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')]);
    await pending;
    await flush();

    expect(putMessages).not.toHaveBeenCalled();
  });

  it('隧道失败不写缓存(旧缓存留着,离线时正好还能用)', async () => {
    const s = sid();
    registerRemote(s);
    remoteListPromise = Promise.reject(new Error('DEVICE_OFFLINE'));

    await expect(listMessagesFor(s)).rejects.toThrow();
    await flush();

    expect(putMessages).not.toHaveBeenCalled();
  });
});

describe('remoteProjectsStore.hydrateFromCache', () => {
  it('种入的设备一律标 disconnected(缓存不是 live 设备)', () => {
    remoteProjectsStore.hydrateFromCache([
      { deviceId: 'dev-cold', deviceName: 'Cold Mac', sessions: [{ id: 's-cold' }] as never },
    ]);
    const sessions = remoteProjectsStore.getDeviceSessions('dev-cold');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].deviceLinkConnectionStatus).toBe('disconnected');
    expect(sessions[0].deviceLinkDeviceName).toBe('Cold Mac');
    expect(remoteProjectsStore.getDeviceList()[0]?.connected).toBe(false);
  });

  it('已有权威分片的设备不被覆盖', () => {
    remoteProjectsStore.setDeviceSessions('dev-live', 'Live Mac', [{ id: 's-live' }] as never);
    remoteProjectsStore.hydrateFromCache([
      { deviceId: 'dev-live', deviceName: 'Stale Name', sessions: [{ id: 's-stale' }] as never },
    ]);
    const sessions = remoteProjectsStore.getDeviceSessions('dev-live');
    expect(sessions.map((s) => s.id)).toEqual(['s-live']);
    expect(sessions[0].deviceLinkConnectionStatus).toBe('connected');
  });

  it('bootstrap 的权威快照整片替换缓存种入的分片', () => {
    remoteProjectsStore.hydrateFromCache([
      { deviceId: 'dev-cold', deviceName: 'Cold', sessions: [{ id: 'gone' }] as never },
    ]);
    remoteProjectsStore.setDeviceSessions('dev-cold', 'Cold', [{ id: 'fresh' }] as never);
    const sessions = remoteProjectsStore.getDeviceSessions('dev-cold');
    expect(sessions.map((s) => s.id)).toEqual(['fresh']);
    expect(sessions[0].deviceLinkConnectionStatus).toBe('connected');
  });

  it('空会话列表的设备不种入(不画出一台空壳设备)', () => {
    remoteProjectsStore.hydrateFromCache([
      { deviceId: 'dev-empty', deviceName: 'Empty', sessions: [] },
    ]);
    expect(remoteProjectsStore.hasDevice('dev-empty')).toBe(false);
  });
});

describe('在途 hydrate 遇上权威删除', () => {
  // review(codex P1):删消息 / clear 会清盘,但在途的缓存读回调仍可能把刚被删掉的行
  // 插回空切片 —— 这两条路径都不触发最新页重拉,没有"权威接管"来纠正。
  it('删消息期间的在途缓存读 → 不把已删的行插回来', async () => {
    const s = sid();
    cachedMessages.set(`${DEVICE_ID}::${s}`, [
      dbMessage(s, 'gone', '已被删掉', '2026-01-01T00:00:00.000Z') as unknown as Record<
        string,
        unknown
      >,
    ]);
    registerRemote(s);
    remoteListPromise = new Promise<Message[]>(() => {}); // 首拉挂起
    let resolveRead: (value: CachedRead) => void = () => {};
    getMessages.mockImplementationOnce(
      () =>
        new Promise<CachedRead>((resolve) => {
          resolveRead = resolve;
        }),
    );

    makerChatStore.ensureInitialMessages(s);
    await flush();
    makerChatStore.removeMessagesByClientIds(s, ['client-gone']);
    resolveRead({
      messages: cachedMessages.get(`${DEVICE_ID}::${s}`) ?? [],
      invalidation: cachedInvalidation,
    });
    await flush(20);

    expect(makerChatStore.getSnapshot(s).messages).toHaveLength(0);
    expectPut(DEVICE_ID, s, []);
  });

  it('edit-last 截断(dropMessagesFromClientId)也清缓存', async () => {
    const s = sid();
    registerRemote(s);
    remoteList = [dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')];
    makerChatStore.ensureInitialMessages(s);
    await flush(30);
    putMessages.mockClear();

    makerChatStore.dropMessagesFromClientId(s, 'client-m1');
    await flush(20);

    expectPut(DEVICE_ID, s, []);
  });
});

describe('在途最新页遇上权威作废', () => {
  // review(pr-code-review):/clear、rewind、删消息都不改设备归属,所以"归属重核"挡不住这一种:
  // 在途的最新页请求带着**作废之前**的行迟到 resolve,排在那次空写之后落地 → 把已经被抹掉的
  // 正文重新写回盘上,下次离线冷启动又画回来。
  it('请求在途期间 /clear → 迟到的最新页不写缓存', async () => {
    const s = sid();
    registerRemote(s);
    let resolveList: (rows: Message[]) => void = () => {};
    remoteListPromise = new Promise<Message[]>((resolve) => {
      resolveList = resolve;
    });

    const pending = listMessagesFor(s);
    // 期间权威侧作废(等价于 /clear、rewind、删消息走的那条路径)
    clearCachedMessages(DEVICE_ID, s);
    putMessages.mockClear();
    resolveList([dbMessage(s, 'stale', '作废前的行', '2026-01-01T00:00:00.000Z')]);
    await pending;
    await flush(20);

    // 只应看到"作废"那次空写(已被 mockClear 排除),不应有把旧行写回去的调用
    expect(putMessages).not.toHaveBeenCalled();
  });

  it('没有发生作废时,最新页照常写缓存(令牌没变)', async () => {
    const s = sid();
    registerRemote(s);
    remoteList = [dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')];
    putMessages.mockClear();

    await listMessagesFor(s);
    await flush(20);

    expect(putMessages).toHaveBeenCalledTimes(1);
  });
});

describe('首拉在途遇上消息代际失效', () => {
  it('messages:deleted 作废首拉后自动重拉当前代,不让 historyLoaded 永久卡 false', async () => {
    const s = sid();
    registerRemote(s);
    let resolveInitial: (rows: Message[]) => void = () => {};
    remoteListPromise = new Promise<Message[]>((resolve) => {
      resolveInitial = resolve;
    });

    makerChatStore.ensureInitialMessages(s);
    await flush();
    expect(
      invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:list'),
    ).toHaveLength(1);

    // messages:deleted 与其它 renderer 删除入口共用 removeMessagesByClientIds，
    // 即使当前窗口没有这条消息也会 bump epoch 作废在途首拉。
    makerChatStore.removeMessagesByClientIds(s, ['client-deleted']);
    remoteListPromise = Promise.resolve([
      dbMessage(s, 'fresh', '当前代的消息', '2026-01-02T00:00:00.000Z'),
    ]);
    resolveInitial([dbMessage(s, 'stale', '上一代的迟到消息', '2026-01-01T00:00:00.000Z')]);
    await flush(40);

    expect(
      invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:list'),
    ).toHaveLength(2);
    const snapshot = makerChatStore.getSnapshot(s);
    expect(snapshot.historyLoaded).toBe(true);
    expect(snapshot.messages.map((message) => message.clientId)).toEqual(['client-fresh']);
  });
});

describe('作废式重载 → 缓存一起清', () => {
  // review(codex P1):粘滞抑制标记只活在本进程里。rewind 后权威首拉失败、用户直接退出 app,
  // 重启后标记没了而盘上那份还是 rewind 之前的窗口 —— 照样 hydrate 出已被软删的消息。
  it('rewind 重载(不允许借缓存)→ 同时清掉盘上那份', async () => {
    const s = sid();
    registerRemote(s);
    remoteList = [dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')];
    makerChatStore.ensureInitialMessages(s);
    await flush(30);
    putMessages.mockClear();

    makerChatStore.reloadMessages(s);
    await flush(20);

    expectPut(DEVICE_ID, s, []);
  });

  it('origin 首次解析的重载(允许借缓存)不清盘', async () => {
    const s = sid();
    makerChatStore.ensureInitialMessages(s); // 本机空库(mapping 未注入)
    await flush(20);
    registerRemote(s);
    remoteListPromise = new Promise<Message[]>(() => {});
    putMessages.mockClear();

    makerChatStore.reloadMessages(s, { allowCacheHydrate: true });
    await flush(20);

    expect(putMessages).not.toHaveBeenCalledWith(DEVICE_ID, s, []);
  });
});

describe('权威侧删消息 → 缓存一起清', () => {
  // review(codex P1):/clear 与 messages:deleted 都**不会**触发"最新页"重拉(唯一的写缓存
  // 路径),盘上那份仍是删除前的正文;此刻退出 app,下次离线冷启动就把它 hydrate 回来。
  it('远程会话 /clear → 清掉该会话的缓存文件', async () => {
    const s = sid();
    registerRemote(s);
    remoteList = [dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')];
    makerChatStore.ensureInitialMessages(s);
    await flush(30);
    putMessages.mockClear();

    makerChatStore.clearSession(s);
    await flush(40);

    expectPut(DEVICE_ID, s, []);
  });

  it('删消息(菜单删除 / messages:deleted 推送)→ 清掉该会话的缓存文件', async () => {
    const s = sid();
    registerRemote(s);
    remoteList = [dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')];
    makerChatStore.ensureInitialMessages(s);
    await flush(30);
    putMessages.mockClear();

    makerChatStore.removeMessagesByClientIds(s, ['client-m1']);
    await flush(20);

    expectPut(DEVICE_ID, s, []);
  });
});

describe('清某设备缓存不牵连别的设备', () => {
  // review(codex P1):clearCachedDevice 原先顺手 cancel 了那个**全局**去抖回写 ——
  // 「A 被归档排了回写、1.2 秒内 B 被撤销」时 A 那次更新被吞掉,而随后的对账内容没变
  // 就不会再通知订阅者,于是 A 的旧会话能在下次离线冷启动重新出现。
  it('清 B 的缓存不会吞掉 A 刚排下的列表回写', async () => {
    vi.useFakeTimers();
    try {
      scheduleSessionListPersist(() => [
        { deviceId: 'dev-A', deviceName: 'Mac A', sessions: [{ id: 's-a' }] as never },
      ]);
      clearCachedDevice('dev-B');

      await vi.advanceTimersByTimeAsync(2_000);

      expect(clearCache).toHaveBeenCalledWith('dev-B');
      expect(putSessionList).toHaveBeenCalledTimes(1);
      const written = putSessionList.mock.calls[0]?.[0] as Array<{ deviceId: string }>;
      expect(written.map((d) => d.deviceId)).toEqual(['dev-A']);
    } finally {
      cancelSessionListPersist();
      vi.useRealTimers();
    }
  });
});

describe('session-list 去抖回写的账号令牌时序', () => {
  it('排程时令牌未知、触发前补读成功 → 使用同账号的最新令牌写入', async () => {
    // review(codex P2):若排程时把 undefined 冻结进闭包,即使 debounce 期间令牌补齐,
    // 非空快照仍会被 main fail-closed 丢弃;相同 reconcile 数据不再通知时缓存持续陈旧。
    vi.useFakeTimers();
    try {
      setDataOwnerGeneration('owner-a', 1);
      clearMirrorCacheAccountState();
      scheduleSessionListPersist(() => [
        { deviceId: 'dev-A', deviceName: 'Mac A', sessions: [{ id: 's-a' }] as never },
      ]);

      // debounce 触发前,受保护列表读把当前账号令牌补齐。
      await readCachedSessionList();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(putSessionList).toHaveBeenCalledTimes(1);
      expect(putSessionList.mock.calls[0]?.[1]).toBe(cachedOwnerToken);
      expect(putSessionList.mock.calls[0]?.[2]).toBe(cachedAccountCounter);
    } finally {
      cancelSessionListPersist();
      vi.useRealTimers();
    }
  });

  it('排程后账号切换 → 不用新账号令牌提交旧账号排下的快照', async () => {
    vi.useFakeTimers();
    try {
      setDataOwnerGeneration('owner-a', 1);
      await readCachedSessionList();
      scheduleSessionListPersist(() => [
        { deviceId: 'dev-A', deviceName: 'Mac A', sessions: [{ id: 'secret-a' }] as never },
      ]);

      setDataOwnerGeneration('owner-b', 2);
      clearMirrorCacheAccountState();
      cachedOwnerToken = 'opaque-owner-token-b';
      await readCachedSessionList();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(putSessionList).not.toHaveBeenCalled();
    } finally {
      cancelSessionListPersist();
      vi.useRealTimers();
    }
  });
});

describe('cancelSessionListPersist 不丢 owner token(relay-stopped 非账号边界)', () => {
  // review(codex P2):cancelSessionListPersist 既在账号边界也在 relay-stopped(服务停掉而非登出)
  // 时被调用。若它在普通 cancel 时清掉 owner root / 账号代际,同一挂载实例重新 online 后
  // scheduleSessionListPersist 会持续带 undefined 写非空快照,被 main fail-closed 丢弃 ——
  // 侧边栏冷缓存直到重挂载都不刷新。清空只归真正的账号边界 clearMirrorCacheAccountState()。
  it('relay stopped(普通 cancel)后,列表回写仍携带 owner root / 账号代际', async () => {
    vi.useFakeTimers();
    try {
      // 先有一次受保护读,让 knownSessionListOwnerToken / knownSessionListAccountCounter 就位
      await readCachedSessionList();
      // relay-stopped:普通 cancel,不应清 token
      cancelSessionListPersist();
      // 重新 online 后排一次列表回写 → 必须仍带 owner root / 账号代际
      scheduleSessionListPersist(() => [
        { deviceId: 'dev-A', deviceName: 'Mac A', sessions: [{ id: 's-a' }] as never },
      ]);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(putSessionList).toHaveBeenCalledTimes(1);
      expect(putSessionList.mock.calls[0]?.[1]).toBe(cachedOwnerToken);
      expect(putSessionList.mock.calls[0]?.[2]).toBe(cachedAccountCounter);
    } finally {
      cancelSessionListPersist();
      vi.useRealTimers();
    }
  });
});

describe('会话作废计数补读的等待纪律', () => {
  it('独立 getMessages IPC 永久挂起时,超时后以 undefined 计数安全降级', async () => {
    // review(copilot suppressed):没有受保护 hydrate 读时,invalidationAtRequestStart 会独立
    // getMessages;若 IPC 永不 settle,persistCachedMessages 会永久卡在 Promise.all。
    vi.useFakeTimers();
    try {
      const s = sid();
      registerRemote(s);
      let resolveRead!: (value: CachedRead) => void;
      getMessages.mockImplementationOnce(
        () =>
          new Promise<CachedRead>((resolve) => {
            resolveRead = resolve;
          }),
      );
      remoteList = [dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')];

      await listMessagesFor(s);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(putMessages).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(putMessages).toHaveBeenCalledTimes(1);
      expect(putMessages.mock.calls[0]?.[3]).toBeUndefined(); // main invalidation
      expect(putMessages.mock.calls[0]?.[4]).toBeUndefined(); // owner root
      expect(putMessages.mock.calls[0]?.[5]).toBeUndefined(); // account counter

      // 底层 IPC 在超时后迟到,不能再把旧结果写进 knownMainInvalidation。
      resolveRead({
        messages: [],
        invalidation: 99,
        ownerToken: 'opaque-owner-token-a',
        accountCounter: 0,
      });
      await vi.advanceTimersByTimeAsync(0);
      putMessages.mockClear();
      remoteList = [dbMessage(s, 'm2', 'y', '2026-01-01T00:00:01.000Z')];
      await listMessagesFor(s);
      await vi.advanceTimersByTimeAsync(0);

      // 若迟到结果污染了已知计数,第二次不会重新 get;正确行为是重新补读并拿默认值 7。
      expect(getMessages).toHaveBeenCalledTimes(2);
      expect(putMessages).toHaveBeenCalledTimes(1);
      expect(putMessages.mock.calls[0]?.[3]).toBe(cachedInvalidation);
    } finally {
      vi.useRealTimers();
    }
  });

  it('补读完成前切换账号:旧账号计数作废且不写回 knownMainInvalidation', async () => {
    const s = sid();
    registerRemote(s);
    setDataOwnerGeneration('owner-a', 1);
    let resolveRead!: (value: CachedRead) => void;
    getMessages.mockImplementationOnce(
      () =>
        new Promise<CachedRead>((resolve) => {
          resolveRead = resolve;
        }),
    );
    remoteList = [dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')];
    await listMessagesFor(s);

    setDataOwnerGeneration('owner-b', 2);
    clearMirrorCacheAccountState();
    resolveRead({
      messages: [],
      invalidation: 99,
      ownerToken: 'opaque-owner-token-a',
      accountCounter: 0,
    });
    await flush(20);

    expect(putMessages).toHaveBeenCalledTimes(1);
    expect(putMessages.mock.calls[0]?.[3]).toBeUndefined();

    // 第二次仍须补读:99 属于旧 owner,不能成为 B 的已知计数。
    putMessages.mockClear();
    remoteList = [dbMessage(s, 'm2', 'y', '2026-01-01T00:00:01.000Z')];
    await listMessagesFor(s);
    await flush(20);
    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(putMessages.mock.calls[0]?.[3]).toBe(cachedInvalidation);
  });
});

describe('在途受保护读的等待纪律', () => {
  it('IPC 永久挂起时写入不被无限阻塞:超时后降级为 undefined 令牌', async () => {
    // review(copilot P1):ownerTokenAtRequestStart 在有 pendingProtectedRead 时把 Promise 交给
    // persistCachedMessages(它 Promise.all 等待)。若那笔 get 既不 resolve 也不 reject
    // (main 卡死 / 通道断开但 Promise 没 settle),该会话后续缓存写入会被**永久**堵住。
    // 缓存是 best-effort:超时降级为 undefined,由 store fail-closed 丢这一次写。
    vi.useFakeTimers();
    try {
      const s = sid();
      registerRemote(s);
      // 永不 settle 的读:模拟挂死的 IPC
      getMessages.mockImplementationOnce(() => new Promise(() => {}));
      void readCachedMessages(DEVICE_ID, s);
      await vi.advanceTimersByTimeAsync(0);

      remoteList = [dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')];
      await listMessagesFor(s);
      // 超时窗口内写入还在等(不该抢跑派发)
      await vi.advanceTimersByTimeAsync(500);
      expect(putMessages).not.toHaveBeenCalled();

      // 超时后必须降级派发,而不是永久挂着
      await vi.advanceTimersByTimeAsync(4_000);
      expect(putMessages).toHaveBeenCalledTimes(1);
      expect(putMessages.mock.calls[0]?.[4]).toBeUndefined(); // owner root
      expect(putMessages.mock.calls[0]?.[5]).toBeUndefined(); // account counter

      // 永久挂起的 entry 必须在超时后从 map 摘掉:第二次写不应再重复白等 3 秒。
      putMessages.mockClear();
      remoteList = [dbMessage(s, 'm2', 'y', '2026-01-01T00:00:01.000Z')];
      await listMessagesFor(s);
      await vi.advanceTimersByTimeAsync(0);
      expect(putMessages).toHaveBeenCalledTimes(1);
      expect(putMessages.mock.calls[0]?.[4]).toBeUndefined();
      expect(putMessages.mock.calls[0]?.[5]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('账号切换后 B 不等 A 的在途读:立即降级,不白等一场', async () => {
    // review(Greptile P1):clearMirrorCacheAccountState 清空已知令牌却保留 A 的
    // pendingProtectedRead。B 复用同一 sessionId 时会去等那笔注定拿不到令牌的旧读
    // (它完成时因代际不符不写令牌)—— 白等一个超时窗口后仍是 undefined。
    const s = sid();
    registerRemote(s);
    getMessages.mockImplementationOnce(() => new Promise(() => {})); // A 的读挂在途
    void readCachedMessages(DEVICE_ID, s);
    await flush(2);

    // 账号切换到 B
    setDataOwnerGeneration('owner-b', 2);
    clearMirrorCacheAccountState();

    // B 复用同一 sessionId 发起远端请求:不该等 A 的在途读,直接 undefined 令牌
    remoteList = [dbMessage(s, 'm1', 'x', '2026-01-01T00:00:00.000Z')];
    await listMessagesFor(s);
    await flush(20);

    expect(putMessages).toHaveBeenCalledTimes(1);
    expect(putMessages.mock.calls[0]?.[4]).toBeUndefined();
    expect(putMessages.mock.calls[0]?.[5]).toBeUndefined();
  });
});

describe('列表读在账号切换后整份作废', () => {
  it('在途 getSessionList 在切账号后完成:不返回旧账号设备、不缓存旧令牌', async () => {
    // review(copilot P1):readCachedSessionList 原先只挡令牌写回,仍把旧账号的 devices
    // 返回给调用方;冷启动 hydrate 会把这份快照直接种进侧边栏 → B 看到 A 的设备与会话标题。
    let resolveRead!: (v: {
      devices: unknown[];
      ownerToken?: string;
      accountCounter?: number;
    }) => void;
    getSessionList.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve as never;
        }) as never,
    );
    const readPromise = readCachedSessionList();
    await flush(2);

    setDataOwnerGeneration('owner-b', 2);
    clearMirrorCacheAccountState();

    // 旧读带着 A 的设备快照完成
    resolveRead({
      devices: [
        { deviceId: 'dev-A', deviceName: "Alice's Mac", sessions: [{ id: 'secret-a-session' }] },
      ],
      ownerToken: 'opaque-owner-token-a',
      accountCounter: 0,
    });

    // 整份作废:一条都不能返回给侧边栏
    expect(await readPromise).toEqual([]);

    // 令牌也不该被旧读写回 —— 否则 B 的列表回写会带上 A 的 root 被 fail-closed 拒写
    vi.useFakeTimers();
    try {
      scheduleSessionListPersist(() => [
        { deviceId: 'dev-B', deviceName: 'Mac B', sessions: [{ id: 's-b' }] as never },
      ]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(putSessionList).toHaveBeenCalledTimes(1);
      expect(putSessionList.mock.calls[0]?.[1]).toBeUndefined();
      expect(putSessionList.mock.calls[0]?.[2]).toBeUndefined();
    } finally {
      cancelSessionListPersist();
      vi.useRealTimers();
    }
  });
});

describe('会话离场时清消息缓存', () => {
  // review(codex P1):会话可能不在当前(有界)分片里、甚至这台设备还没有分片,但它完全可能
  // 有一份上次打开时留下的缓存文件 —— 早退就等于把"别的控制端刚删掉的会话"的正文留在盘上。
  it('会话不在分片里(甚至没有分片)时,终态推送同样清缓存', () => {
    // 没有分片:直接对一台未知设备发终态 patch
    remoteProjectsStore.applyPatch('dev-unknown', 'sess-ghost', { status: 'deleted' });
    expectPut('dev-unknown', 'sess-ghost', []);

    // 有分片但会话不在窗口内
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: 's-in' }] as never);
    putMessages.mockClear();
    remoteProjectsStore.applyPatch(DEVICE_ID, 's-outside-window', { status: 'archived' });
    expectPut(DEVICE_ID, 's-outside-window', []);
  });

  it('被控端把会话标 deleted / archived → 清掉该会话的缓存文件', () => {
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [
      { id: 's-del' },
      { id: 's-arch' },
    ] as never);

    remoteProjectsStore.applyPatch(DEVICE_ID, 's-del', { status: 'deleted' });
    remoteProjectsStore.applyPatch(DEVICE_ID, 's-arch', { status: 'archived' });

    expectPut(DEVICE_ID, 's-del', []);
    expectPut(DEVICE_ID, 's-arch', []);
  });
});

describe('分片变更通知(冷缓存回写的触发源)', () => {
  // review(codex P1):archived / deleted 的增量原先只改内存,列表快照要等下一次成功
  // refresh 才更新;app 若在 10 秒对账前退出,下次离线冷启动会把它 hydrate 回侧边栏。
  // 现在回写由 store 订阅驱动 —— 这里钉住「这些 mutation 确实会通知订阅者」这一契约。
  it('applyPatch 的 deleted / archived 会通知订阅者', () => {
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [
      { id: 's-del' },
      { id: 's-arch' },
    ] as never);
    let notified = 0;
    const off = remoteProjectsStore.subscribe(() => {
      notified += 1;
    });
    try {
      remoteProjectsStore.applyPatch(DEVICE_ID, 's-del', { status: 'deleted' });
      expect(notified).toBeGreaterThan(0);
      const afterDelete = notified;
      remoteProjectsStore.applyPatch(DEVICE_ID, 's-arch', { status: 'archived' });
      expect(notified).toBeGreaterThan(afterDelete);
    } finally {
      off();
    }
  });

  it('markDeviceDisconnected / removeDevice 同样通知订阅者', () => {
    remoteProjectsStore.setDeviceSessions('dev-x', 'X', [{ id: 's-x' }] as never);
    let notified = 0;
    const off = remoteProjectsStore.subscribe(() => {
      notified += 1;
    });
    try {
      remoteProjectsStore.markDeviceDisconnected('dev-x');
      const afterDisconnect = notified;
      expect(afterDisconnect).toBeGreaterThan(0);
      remoteProjectsStore.removeDevice('dev-x');
      expect(notified).toBeGreaterThan(afterDisconnect);
    } finally {
      off();
    }
  });
});

describe('列表快照的采集口径', () => {
  // review(codex P1):collectSessionListSnapshot 原本用 getDeviceIds()(只返回 connected),
  // 于是「A 离线、B 刚 refresh」时整份回写会把 A 抹掉,下次冷启动恢复不出那台离线设备 ——
  // 而离线可见正是这份缓存存在的理由。
  it('断连设备仍进快照(否则冷启动就恢复不出离线设备)', () => {
    remoteProjectsStore.setDeviceSessions('dev-online', 'Online Mac', [{ id: 's-on' }] as never);
    remoteProjectsStore.setDeviceSessions('dev-offline', 'Offline Mac', [{ id: 's-off' }] as never);
    remoteProjectsStore.markDeviceDisconnected('dev-offline');

    const snapshot = collectSessionListSnapshot();

    expect(snapshot.map((d) => d.deviceId).sort()).toEqual(['dev-offline', 'dev-online']);
    expect(snapshot.find((d) => d.deviceId === 'dev-offline')?.sessions.map((s) => s.id)).toEqual([
      's-off',
    ]);
  });

  it('缓存种入的(disconnected)分片也在采集范围内', () => {
    remoteProjectsStore.hydrateFromCache([
      { deviceId: 'dev-cold', deviceName: 'Cold', sessions: [{ id: 's-cold' }] as never },
    ]);
    expect(collectSessionListSnapshot().map((d) => d.deviceId)).toEqual(['dev-cold']);
  });

  it('getDeviceIds 仍是「在线可控」语义(anti-entropy 只该轮询在线设备)', () => {
    remoteProjectsStore.setDeviceSessions('dev-online', 'Online', [{ id: 's-on' }] as never);
    remoteProjectsStore.setDeviceSessions('dev-offline', 'Offline', [{ id: 's-off' }] as never);
    remoteProjectsStore.markDeviceDisconnected('dev-offline');

    expect(remoteProjectsStore.getDeviceIds()).toEqual(['dev-online']);
    expect(remoteProjectsStore.getAllDeviceIds().sort()).toEqual(['dev-offline', 'dev-online']);
  });
});
