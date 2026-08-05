/**
 * reconcileRemoteMessages.test.ts —— device-link 远程会话消息对账(host-authoritative heal)。
 *
 * 被控端实时流走 fire-and-forget push,断连/重启/丢帧会让某轮消息静默丢失,打开的会话首拉后
 * 只靠 live push 增长、从不补。reconcileRemoteMessages 重拉最近一页 + 合并去重把缺失补回。
 * 覆盖:远程会话补回缺失 + 去重 + hydrate 权威字段;本机会话 no-op;historyLoaded=false no-op。
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

const DEVICE_ID = 'dev-A';
let n = 0;
const sid = () => `reconcile-${n++}`;
type RemotePush = { deviceId: string; channel: string; payload: unknown };
let remotePush: ((push: RemotePush) => void) | undefined;

function dbMessage(sessionId: string, id: string, content: string, ts: string, role: Message['role'] = 'assistant'): Message {
  return { id, clientId: `client-${id}`, sessionId, role, content, toolUseId: null, agentMeta: null, createdAt: ts };
}

function thinkingDbMessage(
  sessionId: string,
  id: string,
  text: string,
  createdAt: string,
  durationMs: number,
  finishedAt: string,
): Message {
  return {
    id,
    clientId: id,
    sessionId,
    role: 'thinking',
    content: { kind: 'thinking', text, durationMs, finishedAt, isRedacted: false },
    toolUseId: null,
    agentMeta: null,
    createdAt,
  };
}

/** 被控端经隧道返回的权威消息列表(local-db:messages:list)。 */
let remoteList: Message[] = [];
let remoteListResolver: ((args: unknown[]) => Message[] | Promise<Message[]>) | null = null;
/** 被控端经隧道返回的 around 窗口(local-db:messages:around-client-id):搜索跳转用。 */
let remoteAround: Message[] = [];
const invoke = vi.fn(async (_deviceId: string, channel: string, _args: unknown[]) => {
  if (channel === 'local-db:messages:list') return remoteListResolver?.(_args) ?? remoteList;
  if (channel === 'local-db:messages:around-client-id') return remoteAround;
  if (channel === 'local-db:sessions:get') {
    return { agentKind: 'cc', remoteHostId: null, sdkSessionId: null, fastMode: false, contextTokens: 0, contextWindow: 0, totalCostUsd: 0 };
  }
  if (channel === 'maker:input:get-projection') {
    return { sessionId: _args[0], pendingQueue: [], steeringQueueClientIds: [], queuePaused: false, queueExpanded: false, queueInteractionLocks: [], queueEditLocks: [], queueAbortPending: false, error: null, recovery: null, errorRetryText: null };
  }
  return null;
});

function stubApi(): void {
  remotePush = undefined;
  const onNoop = vi.fn(() => vi.fn());
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    electronAPI: {
      maker: {
        input: { getProjection: vi.fn(async (s: string) => ({ sessionId: s, pendingQueue: [], steeringQueueClientIds: [], queuePaused: false, queueExpanded: false, queueInteractionLocks: [], queueEditLocks: [], queueAbortPending: false, error: null, recovery: null, errorRetryText: null })) },
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
        onRemotePush: (cb: (push: RemotePush) => void) => {
          remotePush = cb;
          return vi.fn();
        },
      },
    },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

async function flushMany(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

// reconcileRemoteMessages can page up to 10 times; keep this above the current microtask count.
const REMOTE_RECONCILE_FLUSH_TICKS = 60;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 把会话注册成 deviceId='dev-A' 的远程会话,并完成首拉(historyLoaded=true)。 */
async function openRemoteWithHistory(s: string, initial: Message[]): Promise<void> {
  remoteList = initial;
  remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s }] as never);
  makerChatStore.ensureInitialMessages(s);
  await flush();
}

beforeEach(() => {
  makerChatStore.__teardownGlobalListeners();
  stubApi();
  remoteList = [];
  remoteListResolver = null;
  remoteAround = [];
  invoke.mockClear();
});

afterEach(() => {
  // remoteProjectsStore 跨用例持久 → 每用例唯一 sessionId 已隔离;结束清设备分片。
  makerChatStore.__teardownGlobalListeners();
  remoteProjectsStore.clear();
  vi.unstubAllGlobals();
});

describe('makerChatStore.reconcileRemoteMessages', () => {
  it('remote stall watchdog only counts heavy session pushes, not lightweight activity', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();

    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:sessions:activity',
      payload: {
        sessionId: s,
        phase: 'running',
        compactDetail: 'still running',
      },
    });

    expect(makerChatStore.getLastInboundEventAt(s)).toBeUndefined();

    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'maker:event',
      payload: {
        sessionId: s,
        event: {
          type: 'status',
          source: 'codex',
          data: { status: 'Running', isRunning: true },
        },
      },
    });

    expect(makerChatStore.getLastInboundEventAt(s)).toEqual(expect.any(Number));
  });

  it('remote stall watchdog counts persisted message pushes as heavy inbound traffic', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();

    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:messages:created',
      payload: {
        sessionId: s,
        message: dbMessage(s, 'heavy-msg', 'persisted push', '2026-06-15T00:00:00.000Z'),
      },
    });

    expect(makerChatStore.getLastInboundEventAt(s)).toEqual(expect.any(Number));
  });

  it('远程会话:对账找不到重叠时替换为权威最新窗口,避免跨断层合并', async () => {
    const s = sid();
    await openRemoteWithHistory(s, [
      dbMessage(s, 'old-cache', 'old cached text', '2026-06-15T00:00:00.000Z'),
      dbMessage(s, 'cached-future', 'controller clock ahead text', '2026-06-16T00:00:00.000Z'),
    ]);

    const remoteHistory = Array.from({ length: 550 }, (_, index) =>
      dbMessage(
        s,
        `new-${index}`,
        `remote ${index}`,
        new Date(Date.UTC(2026, 5, 15, 1, 0, index)).toISOString(),
      ),
    );
    remoteListResolver = (args) => pageMessages(remoteHistory, args);

    makerChatStore.reconcileRemoteMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    const snapshot = makerChatStore.getSnapshot(s);
    expect(snapshot.messages).toHaveLength(500);
    expect(snapshot.messages.map((m) => m.clientId)).not.toContain('client-old-cache');
    expect(snapshot.messages.map((m) => m.clientId)).not.toContain('client-cached-future');
    expect(snapshot.messages[0]?.clientId).toBe('client-new-50');
    expect(snapshot.messages.at(-1)?.clientId).toBe('client-new-549');
    expect(snapshot.oldestMessageId).toBe('new-50');
    expect(snapshot.hasMoreMessages).toBe(true);
  });

  it('远程会话:无重叠对账保留分页期间新到的 remote push', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, [
      dbMessage(s, 'old-cache', 'old cached text', '2026-06-15T00:00:00.000Z'),
    ]);

    const pendingList = deferred<Message[]>();
    remoteListResolver = () => pendingList.promise;

    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:messages:created',
      payload: {
        sessionId: s,
        message: dbMessage(s, 'late', 'late push text', '2026-06-15T02:00:00.000Z'),
      },
    });

    pendingList.resolve([
      dbMessage(s, 'new-1', 'remote latest page', '2026-06-15T01:00:00.000Z'),
    ]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    const ids = makerChatStore.getSnapshot(s).messages.map((m) => m.clientId);
    expect(ids).toEqual(['client-new-1', 'client-late']);
    expect(ids).not.toContain('client-old-cache');
  });

  it('远程会话:重拉合并把 push 丢失的消息补回(去重不重复)', async () => {
    const s = sid();
    await openRemoteWithHistory(s, [
      dbMessage(s, 'u1', 'hi', '2026-06-15T00:00:00.000Z', 'user'),
      dbMessage(s, 'a1', '在', '2026-06-15T00:00:01.000Z'),
    ]);
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-u1', 'client-a1']);

    // 被控端又产生了 a2(控制端 push 丢了)。对账重拉最近页(含 a1+a2)。
    remoteList = [
      dbMessage(s, 'u1', 'hi', '2026-06-15T00:00:00.000Z', 'user'),
      dbMessage(s, 'a1', '在', '2026-06-15T00:00:01.000Z'),
      dbMessage(s, 'a2', '收到', '2026-06-15T00:00:02.000Z'),
    ];
    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    const ids = makerChatStore.getSnapshot(s).messages.map((m) => m.clientId);
    expect(ids).toEqual(['client-u1', 'client-a1', 'client-a2']); // a2 补回、a1 不重复、保序
  });

  it('远程会话:reconcile 命中重复 clientId 时 hydrate DB 权威时间', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, []);

    // 控制端收到 live maker:event,但漏掉后续 local-db:messages:created echo。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'maker:event',
      payload: {
        sessionId: s,
        persistId: 'client-a1',
        event: {
          type: 'text',
          source: 'claude-code',
          data: { text: 'draft', isFinal: true },
        },
      },
    });

    const live = makerChatStore.getSnapshot(s).messages[0];
    expect(live).toEqual(expect.objectContaining({ clientId: 'client-a1', content: 'draft' }));
    expect(live?.createdAt).not.toBe('2026-06-15T00:00:05.000Z');

    // 对账重拉到同 clientId 的被控端 DB row;没有新 ID,但仍应 hydrate createdAt/content。
    remoteList = [dbMessage(s, 'a1', 'persisted', '2026-06-15T00:00:05.000Z')];
    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    const messages = makerChatStore.getSnapshot(s).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        clientId: 'client-a1',
        role: 'assistant',
        content: 'persisted',
        isStreaming: false,
        createdAt: '2026-06-15T00:00:05.000Z',
      }),
    );
  });

  it('远程会话:reconcile 用 DB 权威 tool_result 全文覆盖 live summary,即使全文更短', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, []);

    // 控制端只收到 live summary,但漏掉后续 tool_result_full push;DB 全文可能更短(如 "ok")。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'maker:event',
      payload: {
        sessionId: s,
        persistId: 'tool-result-1',
        event: {
          type: 'tool_result',
          source: 'claude-code',
          data: { toolUseIds: ['tool-1'] },
        },
        resolvedContent: 'summary',
      },
    });

    expect(makerChatStore.getSnapshot(s).messages).toEqual([
      expect.objectContaining({
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'summary',
      }),
    ]);

    remoteList = [
      {
        ...dbMessage(s, 'tool-result-1', 'ok', '2026-06-15T00:00:06.000Z', 'tool_result'),
        clientId: 'tool-result-1',
        toolUseId: 'tool-1',
      },
    ];
    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    expect(makerChatStore.getSnapshot(s).messages).toEqual([
      expect.objectContaining({
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'ok',
        toolUseId: 'tool-1',
        createdAt: '2026-06-15T00:00:06.000Z',
      }),
    ]);
  });

  it('远程会话:初始历史 hydrate 用 DB 全文覆盖 live summary,即使全文更短', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s }] as never);

    // 控制端先收到 live summary;首拉历史稍后拿到被控端已更新的短 DB full output。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'maker:event',
      payload: {
        sessionId: s,
        persistId: 'tool-result-1',
        event: {
          type: 'tool_result',
          source: 'claude-code',
          data: { toolUseIds: ['tool-1'] },
        },
        resolvedContent: 'summary',
      },
    });
    expect(makerChatStore.getSnapshot(s).messages).toEqual([
      expect.objectContaining({
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'summary',
      }),
    ]);

    remoteList = [
      {
        ...dbMessage(s, 'tool-result-1', 'ok', '2026-06-15T00:00:06.000Z', 'tool_result'),
        clientId: 'tool-result-1',
        toolUseId: 'tool-1',
      },
    ];
    makerChatStore.ensureInitialMessages(s);
    await flush();

    expect(makerChatStore.getSnapshot(s).messages).toEqual([
      expect.objectContaining({
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'ok',
        toolUseId: 'tool-1',
        createdAt: '2026-06-15T00:00:06.000Z',
      }),
    ]);
  });

  it('远程会话:DB-created echo 回填 thinking 开始时间后重新排序', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, []);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:10.000Z'));

    try {
      remotePush?.({
        deviceId: DEVICE_ID,
        channel: 'maker:event',
        payload: {
          sessionId: s,
          persistId: 'assistant-after-thinking',
          event: {
            type: 'text',
            source: 'claude-code',
            data: { text: 'later assistant text', isFinal: true },
          },
        },
      });
      remotePush?.({
        deviceId: DEVICE_ID,
        channel: 'maker:event',
        payload: {
          sessionId: s,
          event: {
            type: 'thinking',
            source: 'claude-code',
            data: {
              stage: 'final',
              blockId: 'thinking-1',
              text: 'thinking result',
              durationMs: 5000,
            },
          },
        },
      });

      expect(makerChatStore.getSnapshot(s).messages.map((message) => message.clientId)).toEqual([
        'assistant-after-thinking',
        'thinking-1',
      ]);

      remotePush?.({
        deviceId: DEVICE_ID,
        channel: 'local-db:messages:created',
        payload: {
          sessionId: s,
          message: thinkingDbMessage(
            s,
            'thinking-1',
            'thinking result',
            '2026-06-15T00:00:09.000Z',
            5000,
            '2026-06-15T00:00:05.000Z',
          ),
        },
      });

      const messages = makerChatStore.getSnapshot(s).messages;
      expect(messages.map((message) => message.clientId)).toEqual([
        'thinking-1',
        'assistant-after-thinking',
      ]);
      expect(messages[0]).toEqual(
        expect.objectContaining({
          clientId: 'thinking-1',
          role: 'thinking',
          content: 'thinking result',
          isStreaming: false,
          thinkingDurationMs: 5000,
          createdAt: '2026-06-15T00:00:00.000Z',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('远程会话:新 DB-created echo 的 thinking 也按回填开始时间排序', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, []);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:10.000Z'));

    try {
      remotePush?.({
        deviceId: DEVICE_ID,
        channel: 'maker:event',
        payload: {
          sessionId: s,
          persistId: 'assistant-after-thinking',
          event: {
            type: 'text',
            source: 'claude-code',
            data: { text: 'later assistant text', isFinal: true },
          },
        },
      });

      expect(makerChatStore.getSnapshot(s).messages.map((message) => message.clientId)).toEqual([
        'assistant-after-thinking',
      ]);

      remotePush?.({
        deviceId: DEVICE_ID,
        channel: 'local-db:messages:created',
        payload: {
          sessionId: s,
          message: thinkingDbMessage(
            s,
            'thinking-1',
            'thinking result',
            '2026-06-15T00:00:09.000Z',
            5000,
            '2026-06-15T00:00:05.000Z',
          ),
        },
      });

      const messages = makerChatStore.getSnapshot(s).messages;
      expect(messages.map((message) => message.clientId)).toEqual([
        'thinking-1',
        'assistant-after-thinking',
      ]);
      expect(messages[0]).toEqual(
        expect.objectContaining({
          clientId: 'thinking-1',
          role: 'thinking',
          content: 'thinking result',
          isStreaming: false,
          thinkingDurationMs: 5000,
          createdAt: '2026-06-15T00:00:00.000Z',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('远程会话:reconcile 信任更短的 DB 权威 tool_result 内容', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, []);

    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'maker:event',
      payload: {
        sessionId: s,
        persistId: 'tool-result-1',
        event: {
          type: 'tool_result',
          source: 'claude-code',
          data: { toolUseIds: ['tool-1'] },
        },
        resolvedContent: 'verbose summary',
      },
    });

    remoteList = [
      {
        ...dbMessage(s, 'tool-result-1', 'ok', '2026-06-15T00:00:06.000Z', 'tool_result'),
        clientId: 'tool-result-1',
        toolUseId: 'tool-1',
      },
    ];
    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    expect(makerChatStore.getSnapshot(s).messages).toEqual([
      expect.objectContaining({
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'ok',
        toolUseId: 'tool-1',
        createdAt: '2026-06-15T00:00:06.000Z',
      }),
    ]);
  });

  it('无缺失:不换 messages 引用(避免无谓重渲染)', async () => {
    const s = sid();
    await openRemoteWithHistory(s, [dbMessage(s, 'a1', 'x', '2026-06-15T00:00:01.000Z')]);
    const snap1 = makerChatStore.getSnapshot(s);
    remoteList = [dbMessage(s, 'a1', 'x', '2026-06-15T00:00:01.000Z')]; // 同一条
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    expect(makerChatStore.getSnapshot(s).messages).toBe(snap1.messages); // 引用未变
  });

  it('本机会话:no-op(不经隧道、不动消息)', async () => {
    const s = sid();
    // 不 setDeviceSessions → 本机会话。先用本地空库首拉。
    makerChatStore.ensureInitialMessages(s);
    await flush();
    invoke.mockClear();
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    expect(invoke).not.toHaveBeenCalledWith(DEVICE_ID, 'local-db:messages:list', expect.anything());
  });

  it('historyLoaded=false:no-op(交给 ensureInitialMessages)', async () => {
    const s = sid();
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s }] as never);
    // 不调 ensureInitialMessages → historyLoaded 仍 false。
    invoke.mockClear();
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    expect(invoke).not.toHaveBeenCalledWith(DEVICE_ID, 'local-db:messages:list', expect.anything());
  });

  it('远程会话:fire-and-forget 调用不产生 unhandled rejection(请求失败时)', async () => {
    // review #676(copilot):单飞包装返回的是 entry.run,旧实现靠 run.then(onOk, onErr) 顺带把
    // rejection 标记为已处理。包装接手后必须自己挂 —— 否则隧道断链时 `void reconcile...` 这种
    // fire-and-forget 调用会冒出 unhandled rejection(vitest 会因此整个文件失败)。
    const s = sid();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);
    remoteListResolver = () => Promise.reject(new Error('tunnel down'));

    // 故意不 catch,复刻 useRemoteSessionSync 的调用形态。
    void makerChatStore.reconcileRemoteMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    // 窗口不受影响(失败什么都不落地)。
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-seed']);
    // 需要的调用方仍能 await 到 rejection —— 语义没被吞掉。
    await expect(makerChatStore.reconcileRemoteMessages(s)).rejects.toThrow('tunnel down');
  });

  it('远程会话:同一会话不并发对账 —— 第二次触发被合并,收尾后补跑一次', async () => {
    // review #676(codex P1 连着七八轮):两次对账重叠会长出一整族只有并发才成立的错况
    // (旧那次拿过期 existingIds 覆盖新窗口、陈旧快照 hydrate 更新的行、bump 代际抢别人的分页锁、
    // 浅重叠的后继丢掉深翻的前驱、代际 bump 的出处追踪…)。每加一道谓词就长出新角落,所以改成
    // 单飞 + 尾随重跑:根上不让两次重叠。
    const s = sid();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const first = deferred<Message[]>();
    let calls = 0;
    remoteListResolver = () => {
      calls += 1;
      if (calls === 1) return first.promise;
      return [
        dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z'),
        dbMessage(s, 'from-rerun', 'row fetched by the trailing rerun', '2026-06-17T00:00:00.000Z'),
      ];
    };

    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    expect(calls).toBe(1);

    // 第二、第三次触发都在飞行期间到达:不许再发请求,合并成"收尾后补跑一次"。
    makerChatStore.reconcileRemoteMessages(s);
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    expect(calls).toBe(1);

    first.resolve([
      dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z'),
      dbMessage(s, 'from-first', 'row fetched by the first run', '2026-06-16T00:00:00.000Z'),
    ]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    // 两次的结果都在:第一次照常落地,合并掉的触发变成一次尾随重跑(不丢触发)。
    const ids = makerChatStore.getSnapshot(s).messages.map((m) => m.clientId);
    expect(ids).toContain('client-from-first');
    expect(ids).toContain('client-from-rerun');
    // 而且只补跑**一次**,不是每个被合并的触发各跑一次。
    expect(calls).toBe(2);
  });

  it('远程会话:飞行期间窗口被重置(rewind)时,陈旧对账整体作废;尾随重跑照常补', async () => {
    // 单飞之后"代际变了"必然来自真正的窗口重置,不可能是另一次对账 —— 这条守卫因此变成唯一一道。
    const s = sid();
    await openRemoteWithHistory(s, [
      dbMessage(s, 'keep', 'kept prefix', '2026-06-15T00:00:00.000Z'),
      dbMessage(s, 'rewound', 'to be rewound', '2026-06-16T00:00:00.000Z'),
    ]);

    const stale = deferred<Message[]>();
    let calls = 0;
    remoteListResolver = () => {
      calls += 1;
      if (calls === 1) return stale.promise;
      return [dbMessage(s, 'keep', 'kept prefix', '2026-06-15T00:00:00.000Z')];
    };

    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    // rewind:本地截断掉 'rewound' 起的整段(bump 代际)。
    makerChatStore.dropMessagesFromClientId(s, 'client-rewound');
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-keep']);

    // 陈旧那次现在才回来,带着被 rewind 掉的那一行。
    stale.resolve([
      dbMessage(s, 'keep', 'kept prefix', '2026-06-15T00:00:00.000Z'),
      dbMessage(s, 'rewound', 'to be rewound', '2026-06-16T00:00:00.000Z'),
    ]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    // 关键:被 rewind 掉的行不得复活。
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-keep']);
  });

  it('远程会话:purge 期间在飞的对账不把陈旧行塞回重开后的窗口', async () => {
    const s = sid();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const prePurge = deferred<Message[]>();
    let calls = 0;
    remoteListResolver = () => {
      calls += 1;
      if (calls === 1) return prePurge.promise;
      return [dbMessage(s, 'fresh', 'fresh row', '2026-06-25T00:00:00.000Z')];
    };

    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    // LRU 驱逐 / 归档 → 同 ID 重开。
    makerChatStore.purgeSession(s);
    makerChatStore.ensureInitialMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    prePurge.resolve([
      dbMessage(s, 'stale', 'stale authoritative', '2026-05-01T00:00:00.000Z'),
    ]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).not.toContain(
      'client-stale',
    );
  });

  it('远程会话:分页期间被 live 更新过的行,对账不用旧快照盖回去;未被动过的照常 hydrate', async () => {
    // review #676(codex P1):普通(未被超越)的对账也可能翻好几秒,期间 messages:created 把某行
    // 更新过;默认 persisted-wins 会让几秒前取的页把更新的内容盖回去。判据用对象引用:起始快照里
    // 引用相同 ⇒ 期间没被动过 ⇒ 仍按权威快照 hydrate。
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, [
      dbMessage(s, 'touched', 'old content', '2026-06-15T00:00:00.000Z'),
      dbMessage(s, 'untouched', 'old content', '2026-06-16T00:00:00.000Z'),
    ]);

    const pendingList = deferred<Message[]>();
    remoteListResolver = () => pendingList.promise;
    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    // 分页期间 live push 更新了其中一行。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:messages:created',
      payload: {
        sessionId: s,
        message: dbMessage(s, 'touched', 'live newer content', '2026-06-15T00:00:00.000Z'),
      },
    });
    expect(
      makerChatStore.getSnapshot(s).messages.find((m) => m.clientId === 'client-touched')?.content,
    ).toBe('live newer content');

    // 对账那一页回来:与已知窗口有重叠 → 加性 merge,但它带的是**两行的旧内容**。
    pendingList.resolve([
      dbMessage(s, 'touched', 'stale page content', '2026-06-15T00:00:00.000Z'),
      dbMessage(s, 'untouched', 'authoritative content', '2026-06-16T00:00:00.000Z'),
    ]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    const rows = makerChatStore.getSnapshot(s).messages;
    // 关键:被动过的那行保留 live 内容。
    expect(rows.find((m) => m.clientId === 'client-touched')?.content).toBe('live newer content');
    // 没被动过的那行照常 hydrate 成权威内容(权威口径没有被一刀切掉)。
    expect(rows.find((m) => m.clientId === 'client-untouched')?.content).toBe(
      'authoritative content',
    );
  });

  it('远程会话:thinking 晚到行按落库时间线判脱离,不被改写后的开始时刻骗过', async () => {
    // review #676(codex P1):mapServerMessages 把 thinking 的 createdAt 改写成
    // `finishedAt - durationMs`(块的开始时刻),而权威页边界是原始 DB 行。混着比会让一个
    // "想了很久"的 thinking 落进页范围,而它与权威窗口之间那一行可能正好被有损推送丢了。
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const pendingList = deferred<Message[]>();
    remoteListResolver = () => pendingList.promise;
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    // 落库时间(finishedAt)= 06-25,明显比权威页最新行(06-20)更新 → 应判脱离;
    // 但它想了 10 天,改写后的"开始时刻"= 06-15,落在权威页范围里 → 旧写法会判连续。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:messages:created',
      payload: {
        sessionId: s,
        message: thinkingDbMessage(
          s,
          'long-thinking',
          'thought for a long time',
          '2026-06-25T00:00:00.000Z',
          10 * 24 * 60 * 60 * 1000,
          '2026-06-25T00:00:00.000Z',
        ),
      },
    });

    // 权威页跨 06-10 ~ 06-20:改写后的"开始时刻"(06-15)恰好落在里面,而落库时间(06-25)在外面。
    pendingList.resolve([
      dbMessage(s, 'auth-a', 'authoritative a', '2026-06-10T00:00:00.000Z'),
      dbMessage(s, 'auth-b', 'authoritative b', '2026-06-20T00:00:00.000Z'),
    ]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    const ids = makerChatStore.getSnapshot(s).messages.map((m) => m.clientId);
    expect(ids).toContain('long-thinking');
    expect(ids).toContain('client-auth-b');
    // 关键:按落库时间线它在权威范围之外 → 按孤岛处理。
    expect(makerChatStore.getSnapshot(s).historyWindowHasIsland).toBe(true);
  });

  it('远程会话:同毫秒但没有 rowid 的 live push 保守按脱离处理', async () => {
    // review #676(codex P1):生产的 local-db:messages:created 广播走 messageToCamel、**不带
    // rowid**(list 结果才带),所以 live push 与权威边界同毫秒时排不出先后 —— 中间那一行可能
    // 正好被有损推送丢了。无法判定 ⇒ 保守判脱离。
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const pendingList = deferred<Message[]>();
    remoteListResolver = () => pendingList.promise;
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    // 与权威边界同毫秒,且**没有** rowid(复刻生产广播的形状)。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:messages:created',
      payload: {
        sessionId: s,
        message: dbMessage(s, 'same-ms-no-rowid', 'no rowid in broadcast', '2026-06-20T00:00:00.000Z'),
      },
    });

    pendingList.resolve([
      { ...dbMessage(s, 'auth-1', 'authoritative', '2026-06-20T00:00:00.000Z'), rowid: 10 },
    ]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toContain(
      'client-same-ms-no-rowid',
    );
    // 关键:排不出先后 → 按孤岛处理,而不是当成连续。
    expect(makerChatStore.getSnapshot(s).historyWindowHasIsland).toBe(true);
  });

  it('远程会话:同毫秒、rowid 更小的范围内晚到行不被误判成脱离', async () => {
    // review #676(copilot):newestMessageRowForWindow 只比毫秒时可能挑到 rowid 更小的那行当
    // "最新边界",于是把同毫秒、rowid 更大的**范围内**行误判成脱离。这里权威页同毫秒两行
    // (rowid 10 / 12),晚到行 rowid 11 夹在中间 → 落在范围内。
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const pendingList = deferred<Message[]>();
    remoteListResolver = () => pendingList.promise;
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:messages:created',
      payload: {
        sessionId: s,
        message: {
          ...dbMessage(s, 'inside', 'inside the authoritative range', '2026-06-20T00:00:00.000Z'),
          rowid: 11,
        },
      },
    });

    pendingList.resolve([
      { ...dbMessage(s, 'auth-a', 'authoritative a', '2026-06-20T00:00:00.000Z'), rowid: 10 },
      { ...dbMessage(s, 'auth-b', 'authoritative b', '2026-06-20T00:00:00.000Z'), rowid: 12 },
    ]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toContain('client-inside');
    // 关键:范围内 → 不记孤岛。
    expect(makerChatStore.getSnapshot(s).historyWindowHasIsland).toBe(false);
  });

  it('远程会话:加性提交不能替一次无关的 rewind 背书,rewind 掉的尾部不得被补回', async () => {
    // review #676(codex P1):加性提交不 bump 代际,所以"它记的代际恰好等于现在"解释不了代际
    // 为什么从本次启动时变了 —— 那个变化另有来源(这里是 rewind)。旧写法让任何更晚的加性提交
    // 都能替这次无关重置背书,于是 rewind 掉的尾部被先启动那次当成"缺的行"补回来。
    const s = sid();
    await openRemoteWithHistory(s, [
      dbMessage(s, 'keep', 'kept prefix', '2026-06-15T00:00:00.000Z'),
      dbMessage(s, 'rewound', 'to be rewound', '2026-06-16T00:00:00.000Z'),
    ]);

    const prePage = deferred<Message[]>();
    let calls = 0;
    remoteListResolver = () => {
      calls += 1;
      // #1(rewind 之前启动):回来时仍带着 rewind 掉的那一行。
      if (calls === 1) return prePage.promise;
      // #2(rewind 之后启动):与保留下来的前缀有重叠 → 加性提交(不 bump 代际)。
      return [dbMessage(s, 'keep', 'kept prefix', '2026-06-15T00:00:00.000Z')];
    };

    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    // rewind:本地截断掉 'rewound' 起的整段(bump 代际)。
    makerChatStore.dropMessagesFromClientId(s, 'client-rewound');
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-keep']);

    // rewind 之后的对账:有重叠 → 加性提交。
    makerChatStore.reconcileRemoteMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-keep']);

    // rewind 之前那次现在才回来。
    prePage.resolve([
      dbMessage(s, 'keep', 'kept prefix', '2026-06-15T00:00:00.000Z'),
      dbMessage(s, 'rewound', 'to be rewound', '2026-06-16T00:00:00.000Z'),
    ]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    // 关键:被 rewind 掉的行不得复活。
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-keep']);
  });

  it('远程会话:与权威窗口最新行同毫秒、rowid 更大的晚到行也算脱离', async () => {
    // review #676(codex P1):同一毫秒里插入的多行靠 rowid 定序(messages 表与分页都用它)。
    // 只比毫秒会把"同毫秒但 rowid 更大"的晚到行判成范围内,而它与权威窗口之间那一行可能正好
    // 被有损推送丢了。
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const pendingList = deferred<Message[]>();
    remoteListResolver = () => pendingList.promise;
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    // 与权威窗口最新行**同毫秒**、但 rowid 更大(中间那行 rowid=11 没送到)。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:messages:created',
      payload: {
        sessionId: s,
        message: {
          ...dbMessage(s, 'same-ms-later', 'same ms, later rowid', '2026-06-20T00:00:00.000Z'),
          rowid: 12,
        },
      },
    });

    pendingList.resolve([
      { ...dbMessage(s, 'auth-1', 'authoritative', '2026-06-20T00:00:00.000Z'), rowid: 10 },
    ]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    const ids = makerChatStore.getSnapshot(s).messages.map((m) => m.clientId);
    expect(ids).toContain('client-same-ms-later');
    expect(ids).toContain('client-auth-1');
    // 关键:同毫秒但 rowid 更大 → 落在权威范围之外 → 按孤岛处理。
    expect(makerChatStore.getSnapshot(s).historyWindowHasIsland).toBe(true);
  });

  it('远程会话:权威重建保留了比权威窗口更新的晚到行时也记孤岛(推送有损)', async () => {
    // review #676(codex P1):"比权威窗口最新一行还新"只证明它来得更晚。device-link 的实时
    // 推送是 fire-and-forget 有损的,被控端连产多行时可能只送到最后一行 —— 中间那几行没到,
    // 它与权威窗口之间就是个洞。所以只有落在权威时间范围**之内**才算连续。
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const pendingList = deferred<Message[]>();
    remoteListResolver = () => pendingList.promise;
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    // 分页期间只送到了"最后一行"(比权威窗口更新)。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:messages:created',
      payload: {
        sessionId: s,
        message: dbMessage(s, 'last-of-burst', 'only the last row arrived', '2026-06-30T00:00:00.000Z'),
      },
    });

    pendingList.resolve([dbMessage(s, 'auth-1', 'authoritative', '2026-06-20T00:00:00.000Z')]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    const ids = makerChatStore.getSnapshot(s).messages.map((m) => m.clientId);
    expect(ids).toContain('client-last-of-burst');
    expect(ids).toContain('client-auth-1');
    // 关键:范围外的晚到行按孤岛处理,下一次跳转会尝试补连续。
    expect(makerChatStore.getSnapshot(s).historyWindowHasIsland).toBe(true);
  });

  it('远程会话:purge 清掉对账次序簿,但旧代际的对账仍被代际守卫拦下', async () => {
    // review #676(copilot):次序簿按 sessionId 无界增长,应随 purge 清理。清理后 seq 检查
    // 会因为 committed 归零而放行,正确性由代际守卫兜住(purge 刚 bump 过 epoch,而 epoch
    // 条目是刻意保留的)。这里守的就是"清理不会把作废兜底一起清掉"。
    const s = sid();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const pendingList = deferred<Message[]>();
    remoteListResolver = () => pendingList.promise;
    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    // 会话被删除 / 归档 / LRU 驱逐。
    makerChatStore.purgeSession(s);

    pendingList.resolve([dbMessage(s, 'stale', 'stale authoritative', '2026-06-20T00:00:00.000Z')]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    // 关键:陈旧对账不得把行 merge 进 purge 后重建的空切片。
    expect(makerChatStore.getSnapshot(s).messages).toHaveLength(0);
  });

  it('远程会话:权威重建保留了更老的晚到行时,按事实记上孤岛', async () => {
    // review #676(codex P1):晚到行不一定与新窗口连续。搜索补齐若在 existingIds 快照之后
    // 落地,它相对**旧**窗口是 covered、标记还是 false;重建把旧窗口换掉之后,那些行就成了
    // 与新窗口之间隔着未加载历史的孤岛。所以标记要按事实赋值,不能"没有晚到行才清、否则沿用"。
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);
    expect(makerChatStore.getSnapshot(s).historyWindowHasIsland).toBe(false);

    const pendingList = deferred<Message[]>();
    remoteListResolver = () => pendingList.promise;
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    // 分页期间落地了一段**更老**的历史(补齐 / 深跳 merge 的形状)。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:messages:created',
      payload: {
        sessionId: s,
        message: dbMessage(s, 'far-older', 'far older row', '2026-05-01T00:00:00.000Z'),
      },
    });

    // 权威页与旧窗口无重叠 → 重建;far-older 比权威窗口最老一行还老 → 保留但不连续。
    pendingList.resolve([dbMessage(s, 'auth-1', 'authoritative', '2026-06-20T00:00:00.000Z')]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    const ids = makerChatStore.getSnapshot(s).messages.map((m) => m.clientId);
    expect(ids).toContain('client-far-older');
    expect(ids).toContain('client-auth-1');
    // 关键:保留了脱离新窗口的行 → 标记必须点亮,后续跳转才会尝试补连续。
    expect(makerChatStore.getSnapshot(s).historyWindowHasIsland).toBe(true);
  });

  it('远程会话:分页期间转入 streaming 时,不 bump 代际也不抢别人的分页锁', async () => {
    // review #676(codex P1):代际 bump 原先在 setState **之前**。一旦更新器里的 isStreaming
    // 守卫否掉这次重建,窗口没换,却已经作废了一个无关的 in-flight 跳转 / 翻页,还替它放了锁。
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const reconcilePage = deferred<Message[]>();
    const jumpPage = deferred<Message[]>();
    remoteListResolver = (args) => {
      const opts = (args[1] ?? {}) as { limit?: number };
      if (opts.limit === 100) return jumpPage.promise;
      return reconcilePage.promise;
    };

    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    // 新代际里发起一次跳转,它拿到分页锁并停在自己那一页上。
    const target = dbMessage(s, 'jump-target', 'jump target', '2026-06-14T00:00:00.000Z');
    remoteAround = [target];
    const jump = makerChatStore.loadAroundMessageClientId(s, 'client-jump-target', { radius: 60 });
    await flush();
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(true);

    // 对账页回来之前,被控端开始了新 turn(isRunning=true → isStreaming=true)。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'maker:event',
      payload: {
        sessionId: s,
        event: {
          type: 'status',
          source: 'claude-code',
          data: { status: 'thinking', isRunning: true, tokenUsage: 0, contextTokens: 0, contextWindow: 0 },
        },
      },
    });
    expect(makerChatStore.getSnapshot(s).isStreaming).toBe(true);

    reconcilePage.resolve([dbMessage(s, 'auth-1', 'authoritative', '2026-06-20T00:00:00.000Z')]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    // 重建被 streaming 守卫否掉:窗口没换,锁仍属于那次跳转。
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).not.toContain('client-auth-1');
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(true);

    // 跳转没被作废:它自己那一页回来后正常命中目标。
    jumpPage.resolve([target]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    expect((await jump)?.clientId).toBe('client-jump-target');
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(false);
  });

  it('远程会话:权威重建没保留任何晚到的行时,孤岛标记清零', async () => {
    // review #676(codex P1):这种情况下新窗口**完全**由本次从最新连续翻回来的页组成,按构造
    // 没有孤岛。留着标记的代价不是"多做一次补齐":标记只由整窗重建清零,而窗口内的目标比重建
    // 后的 oldestMessageId 更新、往上翻永远碰不到,于是每次窗口内搜索都白跑到预算上限。
    const s = sid();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);
    // 先制造孤岛状态。
    remoteAround = [dbMessage(s, 'island', 'island row', '2026-06-01T00:00:00.000Z')];
    await makerChatStore.loadAroundMessageClientId(s, 'client-island', { radius: 60 });
    expect(makerChatStore.getSnapshot(s).historyWindowHasIsland).toBe(true);

    // 无重叠对账 → 权威重建,期间没有任何 remote push 进来。
    remoteListResolver = () => [
      dbMessage(s, 'auth-1', 'authoritative', '2026-06-20T00:00:00.000Z'),
    ];
    makerChatStore.reconcileRemoteMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-auth-1']);
    // 关键:窗口是完整重建出来的,标记必须清零。
    expect(makerChatStore.getSnapshot(s).historyWindowHasIsland).toBe(false);
  });

  it('远程会话:权威重建作废在飞行中的跳转补齐,并释放分页锁', async () => {
    // review #676(codex P1):无重叠分支换掉整片窗口 + 改写 oldestMessageId,却不 bump
    // 代际。此时一个在飞行中的搜索跳转补齐会带着**重建前**的游标返回,把脱离上下文的旧
    // 历史接到新窗口上;若那一页里有跳转目标,补齐还会判 covered、连孤岛标记都不留,
    // 退化成本 PR 要修的静默空洞。
    const s = sid();
    await openRemoteWithHistory(s, [
      dbMessage(s, 'stale-tail', 'stale cached tail', '2026-06-15T00:00:00.000Z'),
    ]);

    const target = dbMessage(s, 'jump-target', 'jump target', '2026-06-10T00:00:00.000Z');
    // 跳转补齐用 limit=100 翻页(JUMP_BACKFILL_PAGE_SIZE),对账用 limit=50 —— 按 limit
    // 分派,让补齐那一页停在飞行中,对账那几页正常返回。
    const backfillPage = deferred<Message[]>();
    remoteListResolver = (args) => {
      const opts = (args[1] ?? {}) as { limit?: number };
      if (opts.limit === 100) return backfillPage.promise;
      return [dbMessage(s, 'auth-1', 'authoritative latest', '2026-06-20T00:00:00.000Z')];
    };

    remoteAround = [target];
    // 跳转:around 拿到目标后进入补齐循环,卡在第一页上。
    const jump = makerChatStore.loadAroundMessageClientId(s, 'client-jump-target', { radius: 60 });
    await flush();
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(true);

    // 对账落地:与已有窗口没有重叠 → 权威重建。
    makerChatStore.reconcileRemoteMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-auth-1']);
    // 锁归本次重置释放:被作废的补齐不会代清。
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(false);

    // 补齐那一页现在才回来(带着重建前的游标)。
    backfillPage.resolve([target]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    await jump;

    const ids = makerChatStore.getSnapshot(s).messages.map((m) => m.clientId);
    // 关键:陈旧的那一页(含跳转目标)不得被接到权威窗口上。
    expect(ids).toEqual(['client-auth-1']);
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(false);
  });
});

function pageMessages(all: Message[], args: unknown[]): Message[] {
  const opts = (args[1] ?? {}) as { limit?: number; before?: string; beforeTs?: number };
  const limit = typeof opts.limit === 'number' ? opts.limit : 50;
  let beforeMs = Number.POSITIVE_INFINITY;
  if (typeof opts.before === 'string') {
    const beforeRow = all.find((row) => row.id === opts.before);
    if (beforeRow) beforeMs = new Date(beforeRow.createdAt).getTime();
  } else if (typeof opts.beforeTs === 'number' && Number.isFinite(opts.beforeTs)) {
    beforeMs = opts.beforeTs;
  }
  return [...all]
    .filter((row) => new Date(row.createdAt).getTime() < beforeMs)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}
