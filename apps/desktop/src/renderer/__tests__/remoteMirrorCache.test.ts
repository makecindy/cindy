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
    agentKind: 'cc', remoteHostId: null, sdkSessionId: null, fastMode: false,
    contextTokens: 0, contextWindow: 0, totalCostUsd: 0,
  })),
  update: vi.fn(async () => ({})),
  touchUserSend: vi.fn(async () => ({})),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { listMessagesFor } from '@/lib/makerTransport';
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

/** 被控端经隧道返回的权威列表;可换成挂起的 promise 模拟慢隧道 / 离线。 */
let remoteList: Message[] = [];
let remoteListPromise: Promise<Message[]> | null = null;
const invoke = vi.fn(async (_deviceId: string, channel: string, args: unknown[]) => {
  if (channel === 'local-db:messages:list') return remoteListPromise ?? remoteList;
  if (channel === 'local-db:sessions:get') {
    return {
      agentKind: 'cc', remoteHostId: null, sdkSessionId: null, fastMode: false,
      contextTokens: 0, contextWindow: 0, totalCostUsd: 0,
    };
  }
  if (channel === 'maker:input:get-projection') {
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
const getMessages = vi.fn(async (deviceId: string, sessionId: string) => ({
  messages: cachedMessages.get(`${deviceId}::${sessionId}`) ?? [],
}));
// 显式签名(而非从实现推断):断言里要读 mock.calls[0][0/1],推断成空元组就取不到。
const putMessages = vi.fn<
  (
    deviceId: string,
    sessionId: string,
    rows: readonly Record<string, unknown>[],
  ) => Promise<{ ok: true }>
>(async () => ({ ok: true as const }));
const getSessionList = vi.fn(async () => ({ devices: [] as never[] }));
const putSessionList = vi.fn(async () => ({ ok: true as const }));
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
  getMessages.mockClear();
  putMessages.mockClear();
  putSessionList.mockClear();
  clearCache.mockClear();
});

afterEach(() => {
  makerChatStore.__teardownGlobalListeners();
  remoteProjectsStore.clear();
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
    expect(putMessages).toHaveBeenCalledWith(DEVICE_ID, s, []);
  });

  it('本机会话不读缓存(本机历史就在本机 DB)', async () => {
    const s = sid();
    makerChatStore.ensureInitialMessages(s);
    await flush();
    expect(getMessages).not.toHaveBeenCalled();
  });

  // review(codex P1):整页无可见渲染锚点时,种入会让 messages 非空(于是 loading 覆盖层
  // 被收起)但 MessageStream 渲染 0 项 —— 被控端离线时就是一片永久空白。
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

    expect(
      makerChatStore.getSnapshot(s).messages.some((m) => m.clientId === 'client-a1'),
    ).toBe(true);
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

describe('会话离场时清消息缓存', () => {
  it('被控端把会话标 deleted / archived → 清掉该会话的缓存文件', () => {
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [
      { id: 's-del' },
      { id: 's-arch' },
    ] as never);

    remoteProjectsStore.applyPatch(DEVICE_ID, 's-del', { status: 'deleted' });
    remoteProjectsStore.applyPatch(DEVICE_ID, 's-arch', { status: 'archived' });

    expect(putMessages).toHaveBeenCalledWith(DEVICE_ID, 's-del', []);
    expect(putMessages).toHaveBeenCalledWith(DEVICE_ID, 's-arch', []);
  });
});
