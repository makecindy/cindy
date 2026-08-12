/**
 * remoteHistoryOriginReconcile.test.ts
 * ---------------------------------------------------------------------------
 * device-link 远程历史竞速回归(被控端历史在控制端「看不见」根因)。
 *
 * 控制端启动时路由可能**先于** remote-projects bootstrap 恢复到某远程会话:此刻
 * getSessionDeviceId 仍是 undefined → ensureInitialMessages 误命中控制端本机空库
 * (被控端 row 不在本地)→ 拿到空历史且 historyLoaded=true 卡死,即使随后 mapping
 * 注入也不再重试。修复:makerChatStore 记录每个任务「按哪个 origin 加载」,
 * remoteProjectsStore 注入 / 变更来源后 reconcileOpenSessionOrigins 检测漂移并经隧道重载。
 *
 * 本测试直接调用导出的 reconcileOpenSessionOrigins(生产由 initGlobalListeners 的
 * remoteProjectsStore.subscribe 驱动),免去整套 initGlobalListeners 的 electronAPI mock。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message, Session } from '@/lib/ccAgent.types';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  around: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));

vi.mock('@/lib/sessionService', () => ({
  // 远程会话:控制端本机 DB 没有该 row → sessions:get 抛 NOT_FOUND(与线上日志一致)。
  get: vi.fn(async () => {
    throw new Error('[NOT_FOUND] Session 不存在');
  }),
  update: vi.fn(async () => ({})),
  touchUserSend: vi.fn(async () => ({})),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import * as messageService from '@/lib/messageService';
import * as sessionService from '@/lib/sessionService';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';

const DEVICE_ID = 'dev-A';
let n = 0;
const sid = () => `origin-reconcile-${n++}`;

function dbMessage(sessionId: string, id: string, content: string): Message {
  return {
    id,
    clientId: `client-${id}`,
    sessionId,
    role: 'assistant',
    content,
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-06-15T00:00:00.000Z',
  };
}

/** 被控端经隧道返回的真历史(deviceLink.invoke 的 local-db:messages:list 应命中)。 */
let remoteHistory: Message[] = [];
let remoteProjectionOwner: string | null = null;
const invoke = vi.fn(async (_deviceId: string, channel: string, _args: unknown[]) => {
  if (channel === 'local-db:messages:list') return remoteHistory;
  if (channel === 'local-db:sessions:get') {
    return { agentKind: 'cc', remoteHostId: null, sdkSessionId: null, fastMode: false, contextTokens: 0, contextWindow: 0, totalCostUsd: 0 };
  }
  if (channel === 'maker:input:get-projection') {
    return {
      sessionId: _args[0], pendingQueue: [], steeringQueueClientIds: [], queuePaused: false,
      queueExpanded: false, queueInteractionLocks: [], queueEditLocks: [], queueAbortPending: false,
      ...(remoteProjectionOwner ? { continuationTurnClientId: remoteProjectionOwner } : {}),
      error: null, recovery: null, errorRetryText: null,
    };
  }
  return null;
});

function stubElectronApi(): void {
  vi.stubGlobal('window', {
    electronAPI: {
      maker: {
        input: {
          getProjection: vi.fn(async (sessionId: string) => ({
            sessionId, pendingQueue: [], steeringQueueClientIds: [], queuePaused: false,
            queueExpanded: false, queueInteractionLocks: [], queueEditLocks: [], queueAbortPending: false,
            error: null, recovery: null, errorRetryText: null,
          })),
        },
      },
      deviceLink: { invoke },
    },
  });
}

/** 冲刷若干轮微任务,等 ensureInitialMessages 的两条 promise 链(meta + 历史)落定。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function seedRemote(sessionId: string): void {
  remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: sessionId } as Session]);
}

beforeEach(() => {
  stubElectronApi();
  remoteHistory = [];
  remoteProjectionOwner = null;
  invoke.mockClear();
});

afterEach(() => {
  remoteProjectsStore.clear();
  vi.unstubAllGlobals();
});

describe('makerChatStore.reconcileOpenSessionOrigins (device-link 历史竞速)', () => {
  it('启动竞速:origin 解析后经隧道重载被控端真历史(不再停留本机空库)', async () => {
    const s = sid();
    // 1) 竞速:mapping 未注入,ensureInitialMessages 命中本机空库 → 空历史 historyLoaded=true。
    makerChatStore.ensureInitialMessages(s);
    await flush();
    expect(makerChatStore.getSnapshot(s).historyLoaded).toBe(true);
    expect(makerChatStore.getSnapshot(s).messages).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalledWith(DEVICE_ID, 'local-db:messages:list', expect.anything());

    // 2) bootstrap 注入该会话来源 + 被控端真历史就位。
    remoteHistory = [dbMessage(s, 'r1', '被控端的历史消息')];
    seedRemote(s);

    // 3) 生产里由 remoteProjectsStore.subscribe 自动触发;此处直接调。
    makerChatStore.reconcileOpenSessionOrigins();
    await flush();

    // 4) 已经隧道重载,本机镜像出被控端历史。
    expect(invoke).toHaveBeenCalledWith(DEVICE_ID, 'local-db:messages:list', expect.anything());
    const msgs = makerChatStore.getSnapshot(s).messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].clientId).toBe('client-r1');
  });

  it('幂等:来源未变(current === loaded)再次 reconcile 不重复隧道拉取', async () => {
    const s = sid();
    remoteHistory = [dbMessage(s, 'r1', 'x')];
    seedRemote(s); // 加载前来源已知
    makerChatStore.ensureInitialMessages(s);
    await flush();
    const firstCalls = invoke.mock.calls.filter((c) => c[1] === 'local-db:messages:list').length;
    expect(firstCalls).toBe(1);

    makerChatStore.reconcileOpenSessionOrigins(); // current === loaded → no-op
    await flush();
    const afterCalls = invoke.mock.calls.filter((c) => c[1] === 'local-db:messages:list').length;
    expect(afterCalls).toBe(1);
  });

  it('本机会话:从不注入来源 → reconcile 永不触发隧道(零回归)', async () => {
    const s = sid();
    vi.mocked(messageService.list).mockResolvedValueOnce([dbMessage(s, 'local1', '本机历史')]);
    makerChatStore.ensureInitialMessages(s);
    await flush();
    expect(makerChatStore.getSnapshot(s).messages).toHaveLength(1);

    makerChatStore.reconcileOpenSessionOrigins();
    await flush();
    expect(invoke).not.toHaveBeenCalledWith(DEVICE_ID, 'local-db:messages:list', expect.anything());
  });

  it('设备下线(current 变 undefined)不重载——避免回落本机空库', async () => {
    const s = sid();
    remoteHistory = [dbMessage(s, 'r1', 'x')];
    seedRemote(s);
    makerChatStore.ensureInitialMessages(s);
    await flush();
    expect(makerChatStore.getSnapshot(s).messages).toHaveLength(1);

    // 设备下线:移除来源 mapping。reconcile 不应把已加载的历史清成本机空库。
    remoteProjectsStore.removeDevice(DEVICE_ID);
    makerChatStore.reconcileOpenSessionOrigins();
    await flush();
    expect(makerChatStore.getSnapshot(s).messages).toHaveLength(1);
  });

  it('来源漂移后丢弃旧 sessions:get 响应，避免本机 metadata 覆盖远程状态', async () => {
    const s = sid();
    let resolveStaleMetadata!: (session: unknown) => void;
    vi.mocked(sessionService.get).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStaleMetadata = resolve;
      }) as never,
    );

    // 首拉先按本机来源完成，metadata 请求故意留在途。
    makerChatStore.ensureInitialMessages(s);
    await flush();
    expect(makerChatStore.getSnapshot(s).historyLoaded).toBe(true);

    // 来源解析后触发新一轮远程首拉，旧 metadata Promise 必须失效。
    remoteHistory = [dbMessage(s, 'r1', 'remote')];
    seedRemote(s);
    makerChatStore.reconcileOpenSessionOrigins();
    await flush();

    resolveStaleMetadata({
      agentKind: 'codex',
      remoteHostId: null,
      sdkSessionId: 'stale-local-session',
      fastMode: false,
      contextTokens: 0,
      contextWindow: 0,
      totalCostUsd: 0,
    });
    await flush();

    expect(makerChatStore.getSnapshot(s).agentKind).toBe('claude-code');
    expect(makerChatStore.getSnapshot(s).sdkSessionId).toBeNull();
  });

  it('purge 后丢弃此前发起的旧投影查询', async () => {
    const s = sid();
    let resolveLocalProjection!: (projection: unknown) => void;
    const localProjection = new Promise((resolve) => {
      resolveLocalProjection = resolve;
    });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          input: {
            getProjection: vi.fn().mockReturnValueOnce(localProjection),
          },
        },
        deviceLink: { invoke },
      },
    });

    makerChatStore.ensureInitialMessages(s);
    makerChatStore.purgeSession(s);
    resolveLocalProjection({
      sessionId: s,
      pendingQueue: [],
      steeringQueueClientIds: [],
      queuePaused: false,
      queueExpanded: false,
      queueInteractionLocks: [],
      queueEditLocks: [],
      queueAbortPending: false,
      continuationTurnClientId: 'stale-owner',
      error: null,
      recovery: null,
      errorRetryText: null,
    });
    await flush();

    expect(makerChatStore.getSnapshot(s).continuationTurnClientId).toBeNull();
  });

  it('来源漂移时丢弃旧投影查询，避免旧本机 null 覆盖远程续跑 owner', async () => {
    const s = sid();
    let resolveLocalProjection!: (projection: unknown) => void;
    const localProjection = new Promise((resolve) => {
      resolveLocalProjection = resolve;
    });
    const localGetProjection = vi
      .fn()
      .mockReturnValueOnce(localProjection)
      .mockResolvedValue({
        sessionId: s,
        pendingQueue: [],
        steeringQueueClientIds: [],
        queuePaused: false,
        queueExpanded: false,
        queueInteractionLocks: [],
        queueEditLocks: [],
        queueAbortPending: false,
        continuationTurnClientId: null,
        error: null,
        recovery: null,
        errorRetryText: null,
      });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { input: { getProjection: localGetProjection } },
        deviceLink: { invoke },
      },
    });

    makerChatStore.ensureInitialMessages(s);
    seedRemote(s);
    remoteProjectionOwner = 'continue-owner';
    makerChatStore.reconcileOpenSessionOrigins();
    await flush();

    expect(makerChatStore.getSnapshot(s).continuationTurnClientId).toBe('continue-owner');

    resolveLocalProjection({
      sessionId: s,
      pendingQueue: [],
      steeringQueueClientIds: [],
      queuePaused: false,
      queueExpanded: false,
      queueInteractionLocks: [],
      queueEditLocks: [],
      queueAbortPending: false,
      continuationTurnClientId: null,
      error: null,
      recovery: null,
      errorRetryText: null,
    });
    await flush();

    expect(makerChatStore.getSnapshot(s).continuationTurnClientId).toBe('continue-owner');
  });
});
