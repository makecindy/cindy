/**
 * deviceLinkControllerScenarios.test.ts —— device-link「控制端镜像」端到端集成(Tier 1)。
 * ---------------------------------------------------------------------------
 * 把过去要两台真机手测的**控制端那一半**变成 CI 可跑:用**真实** makerChatStore +
 * remoteProjectsStore + makerTransport + initGlobalListeners,只在唯一外部缝
 * `window.electronAPI.deviceLink.{invoke,onRemotePush}` 注入一个**忠实的 FakeHost**
 * (被控端单一真相源的内存替身)。覆盖一条连贯的镜像回路:
 *   1. 打开远程会话 → 经隧道拉被控端历史(控制端本机无该 row)。
 *   2. 被控端实时 push(messages:created)→ 控制端就地追加(同本机 reducer)。
 *   3. push 丢失(fire-and-forget)→ 控制端缺这条 → reconcile 重拉权威页 → heal 补回、去重、保序。
 *   4. 被控端改设置(sessions:patched push)→ 控制端镜像(remoteProjectsStore)就地收敛,不乐观预测。
 *   5. 经隧道 maker:create-session 建会话 → 拿回 sessionId、出现在该设备会话列表。
 *
 * 与既有聚焦单测的关系:reconcileRemoteMessages / remoteHistoryOriginReconcile 锁单点行为,
 * 本套锁「多步骤交织」的整体回路(live push 与丢帧 heal 同时发生时仍正确)。node 环境、不引 RTL。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message, Session } from '@/lib/ccAgent.types';
import {
  __testing as dataOwnerTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  around: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));
vi.mock('@/lib/sessionService', () => ({
  // 远程会话:控制端本机 DB 没有该 row → 本地 get 抛 NOT_FOUND(线上同款);远程走隧道。
  get: vi.fn(async () => {
    throw new Error('[NOT_FOUND] Session 不存在');
  }),
  update: vi.fn(async () => ({})),
  touchUserSend: vi.fn(async () => ({})),
}));
vi.mock('@/lib/sessionsBus', () => ({ emitPatch: vi.fn() }));
vi.mock('@/lib/userPromptStore', () => ({ getUserPrompt: () => '' }));
vi.mock('@/lib/imageRef', () => ({
  parseUserContent: vi.fn((c: string) => ({ text: c, images: [], files: [] })),
  stringifyUserContent: vi.fn((text: string) => text),
}));
vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  setRemoteOptimisticAttachmentUrls: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] }),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';

// ─── 忠实的被控端内存替身(单一真相源)───────────────────────────────────────────

const TEST_OWNER_STAMP = { dataOwnerId: 'test-owner', ownerGeneration: 0 } as const;
type RemotePush = {
  deviceId: string;
  channel: string;
  payload: unknown;
  ownerStamp?: typeof TEST_OWNER_STAMP;
};

function emptyProjection(sessionId: string) {
  return {
    sessionId, pendingQueue: [], steeringQueueClientIds: [], queuePaused: false,
    queueExpanded: false, queueInteractionLocks: [], queueEditLocks: [], queueAbortPending: false,
    error: null, recovery: null, errorRetryText: null,
  };
}

function dbMessage(sessionId: string, id: string, content: string, ts: string, role: Message['role'] = 'assistant'): Message {
  return { id, clientId: `client-${id}`, sessionId, role, content, toolUseId: null, agentMeta: null, createdAt: ts };
}

function makeFakeHost(deviceId: string, deviceName: string) {
  const sessionsMeta = new Map<string, Record<string, unknown>>();
  const messages = new Map<string, Message[]>();
  let pushCb: ((p: RemotePush) => void) | null = null;

  function meta(sid: string): Record<string, unknown> {
    return {
      agentKind: 'cc', remoteHostId: null, sdkSessionId: null, fastMode: false,
      contextTokens: 0, contextWindow: 0, totalCostUsd: 0,
      ...(sessionsMeta.get(sid) ?? {}),
    };
  }

  const invoke = vi.fn(async (_d: string, channel: string, args: unknown[]) => {
    switch (channel) {
      case 'local-db:messages:list': {
        const sid = args[0] as string;
        const opts = (args[1] ?? {}) as { limit?: number };
        const all = messages.get(sid) ?? [];
        return opts.limit ? all.slice(-opts.limit) : all;
      }
      case 'local-db:sessions:get':
        return meta(args[0] as string);
      case 'local-db:sessions:list':
        return [...sessionsMeta.keys()].map((id) => ({ id, ...meta(id) }) as unknown as Session);
      case 'maker:create-session': {
        const opts = (args[0] ?? {}) as Record<string, unknown>;
        const id = `remote-sess-${sessionsMeta.size + 1}`;
        sessionsMeta.set(id, { ...opts });
        messages.set(id, []);
        return { sessionId: id };
      }
      case 'maker:input:get-projection':
        return emptyProjection(args[0] as string);
      default:
        return null; // set-* 等:ok/no-op
    }
  });

  return {
    deviceId,
    deviceName,
    invoke,
    /** 注册控制端 onRemotePush 回调(被控端经此向控制端转发广播)。 */
    registerPush(cb: (p: RemotePush) => void): () => void {
      pushCb = (push) => cb({ ...push, ownerStamp: push.ownerStamp ?? TEST_OWNER_STAMP });
      return () => {
        pushCb = null;
      };
    },
    seedSession(sid: string, m: Record<string, unknown> = {}, history: Message[] = []): void {
      sessionsMeta.set(sid, m);
      messages.set(sid, [...history]);
    },
    /** 被控端产生一条消息;lossy=true 模拟 push 丢帧(只落库、不转发)。 */
    hostMessage(sid: string, msg: Message, opts?: { lossy?: boolean }): void {
      const arr = messages.get(sid) ?? [];
      arr.push(msg);
      messages.set(sid, arr);
      if (!opts?.lossy) pushCb?.({ deviceId, channel: 'local-db:messages:created', payload: { sessionId: sid, message: msg } });
    },
    /** 被控端改某会话设置 → 广播 sessions:patched(控制端镜像收敛)。 */
    hostPatch(sid: string, patch: Record<string, unknown>): void {
      sessionsMeta.set(sid, { ...(sessionsMeta.get(sid) ?? {}), ...patch });
      pushCb?.({ deviceId, channel: 'local-db:sessions:patched', payload: { sessionId: sid, patch } });
    },
    /** 被控端 turn 结束落库累计 cost → usage:session-spend-changed(sessionSpendBroadcaster tap)。 */
    hostSessionSpend(sid: string, totalCostUsd: number): void {
      sessionsMeta.set(sid, { ...(sessionsMeta.get(sid) ?? {}), totalCostUsd });
      pushCb?.({ deviceId, channel: 'usage:session-spend-changed', payload: { sessionId: sid, totalCostUsd } });
    },
    /** 被控端 turn 结束落库累计 token → usage:session-tokens-changed。 */
    hostSessionTokens(sid: string, totalTokens: number): void {
      sessionsMeta.set(sid, { ...(sessionsMeta.get(sid) ?? {}), totalTokenUsage: totalTokens });
      pushCb?.({ deviceId, channel: 'usage:session-tokens-changed', payload: { sessionId: sid, totalTokens } });
    },
  };
}

type FakeHost = ReturnType<typeof makeFakeHost>;

function stubElectronApi(host: FakeHost): void {
  const fanOut = () => () => () => {};
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      maker: {
        onEvent: fanOut(),
        onStatusChanged: fanOut(),
        onInputProjection: fanOut(),
        onInteractionRequest: fanOut(),
        onInteractionDismissed: fanOut(),
        input: { getProjection: vi.fn(async (s: string) => emptyProjection(s)) },
      },
      localDb: { messages: { onCreated: fanOut() } },
      onUsageMessageTurnCost: fanOut(),
      deviceLink: {
        invoke: host.invoke,
        onRemotePush: (cb: (p: RemotePush) => void) => host.registerPush(cb),
        onStatusChanged: fanOut(),
        onPresenceChanged: fanOut(),
      },
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const DEVICE_ID = 'dev-ctrl-scn';
let n = 0;
const sid = () => `ctrl-scn-${n++}`;

let host: FakeHost;

beforeEach(() => {
  dataOwnerTesting.reset();
  setDataOwnerGeneration(TEST_OWNER_STAMP.dataOwnerId, TEST_OWNER_STAMP.ownerGeneration);
  host = makeFakeHost(DEVICE_ID, 'Mac A');
  stubElectronApi(host);
  makerChatStore.initGlobalListeners();
});

afterEach(() => {
  makerChatStore.__teardownGlobalListeners();
  remoteProjectsStore.clear();
  delete (globalThis as { window?: unknown }).window;
  vi.clearAllMocks();
  dataOwnerTesting.reset();
});

describe('device-link controller mirror — end-to-end scenarios', () => {
  it('完整镜像回路:开会话见历史 → live push 追加 → 丢帧 reconcile heal → 设置变更镜像', async () => {
    const s = sid();
    // 被控端已有 1 条历史 + 注册到远程项目(getSessionDeviceId 命中 → 传输层走隧道)。
    host.seedSession(s, { model: 'claude-sonnet-4-6' }, [dbMessage(s, 'h1', '历史', '2026-06-15T00:00:00.000Z')]);
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);

    // 1) 打开会话 → 经隧道拉到被控端历史(本机无该 row)。
    makerChatStore.ensureInitialMessages(s);
    await flush();
    await flush();
    expect(host.invoke).toHaveBeenCalledWith(DEVICE_ID, 'local-db:messages:list', expect.anything());
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-h1']);

    // 2) 被控端实时 push 两条 → 控制端就地追加。
    host.hostMessage(s, dbMessage(s, 'a1', '你好', '2026-06-15T00:00:01.000Z'));
    host.hostMessage(s, dbMessage(s, 'a2', '在', '2026-06-15T00:00:02.000Z'));
    await flush();
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-h1', 'client-a1', 'client-a2']);

    // 3) 第三条 push 丢失(断连窗口)→ 控制端缺这条。
    host.hostMessage(s, dbMessage(s, 'a3', '丢了的回复', '2026-06-15T00:00:03.000Z'), { lossy: true });
    await flush();
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-h1', 'client-a1', 'client-a2']);

    // reconcile(重连 / turn 结束触发)→ 以被控端为准重拉 → 补回 a3、不重复 a1/a2、保序。
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual([
      'client-h1', 'client-a1', 'client-a2', 'client-a3',
    ]);

    // 4) 被控端改 model → sessions:patched push → 控制端镜像(remoteProjectsStore)收敛。
    host.hostPatch(s, { model: 'claude-opus-4-8' });
    await flush();
    const mirrored = remoteProjectsStore.getMergedRemoteSessions().find((x) => x.id === s);
    expect(mirrored?.model).toBe('claude-opus-4-8');
  });

  it('被控端累计 cost / token 推送 → 控制端远程会话行镜像(底部 $ chip 数据源)', async () => {
    const s = sid();
    host.seedSession(s, {});
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);

    // 被控端 sessionSpendBroadcaster 落库后 tap 转发(裸 UPDATE 不发 sessions:patched,
    // 控制端只有这条通道能看到累计值增长)。
    host.hostSessionSpend(s, 1.23);
    host.hostSessionTokens(s, 45_000);
    await flush();
    const mirrored = remoteProjectsStore.getMergedRemoteSessions().find((x) => x.id === s);
    expect(mirrored?.totalCostUsd).toBe(1.23);
    expect(mirrored?.totalTokenUsage).toBe(45_000);
  });

  it('丢帧后 reconcile 是合并而非替换:本机已有的不被清、in-flight 顺序不乱', async () => {
    const s = sid();
    host.seedSession(s, {}, [
      dbMessage(s, 'u1', 'hi', '2026-06-15T00:00:00.000Z', 'user'),
      dbMessage(s, 'a1', '在', '2026-06-15T00:00:01.000Z'),
    ]);
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
    makerChatStore.ensureInitialMessages(s);
    await flush();
    await flush();

    // 被控端又产生 a2(push 到达),a3(push 丢失)。
    host.hostMessage(s, dbMessage(s, 'a2', '收到', '2026-06-15T00:00:02.000Z'));
    host.hostMessage(s, dbMessage(s, 'a3', '继续', '2026-06-15T00:00:03.000Z'), { lossy: true });
    await flush();

    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    const ids = makerChatStore.getSnapshot(s).messages.map((m) => m.clientId);
    expect(ids).toEqual(['client-u1', 'client-a1', 'client-a2', 'client-a3']);
  });

  it('经隧道 maker:create-session 建会话 → 拿回 sessionId、出现在该设备会话列表', async () => {
    const opts = { agentKind: 'claude-code', workingDir: '/host/proj', workspaceKind: 'project', model: 'claude-sonnet-4-6' };
    const res = (await host.invoke(DEVICE_ID, 'maker:create-session', [opts])) as { sessionId?: string };
    expect(res.sessionId).toBeTruthy();
    const list = (await host.invoke(DEVICE_ID, 'local-db:sessions:list', [])) as Session[];
    expect(list.map((x) => x.id)).toContain(res.sessionId);

    // 注册进控制端镜像后,传输层认其为远程会话(后续读写走隧道)。
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', list.map((x) => ({ id: x.id }) as Session));
    expect(remoteProjectsStore.getSessionDeviceId(res.sessionId!)).toBe(DEVICE_ID);
  });

  it('本机会话零回归:未注册 origin → 读写不经隧道', async () => {
    const s = sid();
    makerChatStore.ensureInitialMessages(s); // 本机空库
    await flush();
    await flush();
    expect(host.invoke).not.toHaveBeenCalledWith(DEVICE_ID, 'local-db:messages:list', expect.anything());
    expect(makerChatStore.getSnapshot(s).messages).toHaveLength(0);
  });
});
