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
vi.mock('@/features/device-link/mirrorCacheClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/features/device-link/mirrorCacheClient')>(),
  readCachedMessages: vi.fn(async () => []),
  clearCachedMessages: vi.fn(),
}));
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

import { makerChatStore, getRemoteHistoryView, type HistoryChatMessage } from '@/lib/makerChatStore';
import { projectHistoryView, HistoryViewHandoff } from '@cindy/maker-shared/message-window';
import { getLatestMessageTodoState } from '@cindy/maker-shared/message-render';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { readCachedMessages, clearCachedMessages } from '@/features/device-link/mirrorCacheClient';

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
  let historyViewEnabled = false;

  function meta(sid: string): Record<string, unknown> {
    return {
      agentKind: 'cc', remoteHostId: null, sdkSessionId: null, fastMode: false,
      contextTokens: 0, contextWindow: 0, totalCostUsd: 0,
      ...(sessionsMeta.get(sid) ?? {}),
    };
  }

  const invoke = vi.fn(async (_d: string, channel: string, args: unknown[]) => {
    switch (channel) {
      case 'local-db:messages:view': {
        if (!historyViewEnabled) return null;
        const rows = messages.get(args[0] as string) ?? [];
        const before = (args[1] as { before?: string })?.before;
        const projected = projectHistoryView(before ? rows.slice(0, rows.findIndex((row) => row.id === before)) : rows, false);
        const items = projected.slice(-20);
        const first = items[0];
        const hasMore = projected.length > items.length;
        return { version: 1, items, hasMore,
          nextCursor: hasMore ? (first.type === 'work' ? first.summary.firstMessageId : first.messages[0].id) : null };
      }
      case 'local-db:messages:work-details': {
        const rows = messages.get(args[0] as string) ?? [];
        const ref = args[1] as { firstMessageId: string; lastMessageId: string };
        return { version: 1, messages: rows.slice(rows.findIndex((row) => row.id === ref.firstMessageId), rows.findIndex((row) => row.id === ref.lastMessageId) + 1), hasMore: false, nextCursor: null };
      }
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
    enableHistoryView: () => { historyViewEnabled = true; },
    disableHistoryView: () => { historyViewEnabled = false; },
    invoke,
    /** 注册控制端 onRemotePush 回调(被控端经此向控制端转发广播)。 */
    registerPush(cb: (p: RemotePush) => void): () => void {
      pushCb = (push) => cb({ ...push, ownerStamp: push.ownerStamp ?? TEST_OWNER_STAMP });
      return () => {
        pushCb = null;
      };
    },
    push(channel: string, payload: unknown): void {
      pushCb?.({ deviceId, channel, payload });
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
    hostDelete(sid: string, clientIds: string[]): void {
      messages.set(sid, (messages.get(sid) ?? []).filter((row) => !clientIds.includes(row.clientId)));
      pushCb?.({ deviceId, channel: 'local-db:messages:deleted', payload: { sessionId: sid, clientIds } });
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
  it('does not lose repair signals received while the first historical page is in flight', async () => {
    const s = sid();
    const old = dbMessage(s, 'h1', 'old page', '2026-09-08T00:00:00Z');
    host.seedSession(s, {}, [old]);
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
    let resolveFirst!: (rows: Message[]) => void;
    const first = new Promise<Message[]>((resolve) => { resolveFirst = resolve; });
    const original = host.invoke.getMockImplementation()!;
    let hold = true;
    host.invoke.mockImplementation((...args) => {
      if (args[1] === 'local-db:messages:list' && hold) { hold = false; return first; }
      return original(...args);
    });
    makerChatStore.ensureInitialMessages(s);
    await flush();
    host.hostMessage(s, dbMessage(s, 'missed', 'new history', '2026-09-08T00:00:01Z'), { lossy: true });
    // Invalid text must not throw or prevent the independent history repair.
    host.push('maker:session-sync', { sessionId: s, event: { type: 'text' }, resyncRequired: true });
    host.push('maker:session-sync', { sessionId: s, resyncRequired: true });
    resolveFirst([old]);
    await flush();
    await flush();
    expect(makerChatStore.getSnapshot(s).messages.map((message) => message.content)).toEqual(['old page', 'new history']);
    expect(host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:list')).toHaveLength(2);
  });

  it.each([[false, false, false], [false, true, false], [true, false, false], [true, true, false], [true, false, true], [true, true, true], [true, false, 'during'], [true, true, 'during']])('hands lost terminal text to history (projected=%s, concurrent=%s, inactive=%s)', async (projected, concurrent, inactive) => {
    const s = sid();
    if (projected) host.enableHistoryView();
    host.seedSession(s, {}, [dbMessage(s, 'h1', 'history', '2026-09-08T00:00:00Z')]);
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
    makerChatStore.enterView(s);
    makerChatStore.ensureInitialMessages(s);
    await flush();
    await flush();
    host.push('maker:event', { sessionId: s, event: { type: 'status', data: { status: 'Running', isRunning: true } } });
    host.push('maker:session-sync', { sessionId: s, persistId: 'live', event: {
      type: 'text', data: { text: 'prefix', isFinal: false, isFullText: true },
    } });
    const durable = { ...dbMessage(s, 'live-db', 'prefix complete', '2026-09-08T00:00:02Z'), clientId: 'live' };
    let finish!: (rows: Message[]) => void;
    const pending = new Promise<Message[]>((resolve) => { finish = resolve; });
    const original = host.invoke.getMockImplementation()!;
    host.invoke.mockImplementation((...args) => {
      if (args[1] === 'local-db:messages:list') return pending;
      if (args[1] === 'local-db:messages:view') return pending.then((rows) => ({
        version: 1, items: projectHistoryView(rows, false), hasMore: false, nextCursor: null,
      }));
      return original(...args);
    });
    // Both the final text event and persistence push were lost. A sealed Host
    // block has no in-flight snapshot; history alone must repair the same row.
    if (inactive === true) makerChatStore.leaveView(s);
    host.push('maker:session-sync', { sessionId: s, resyncRequired: true });
    if (inactive) {
      await flush();
      if (inactive === 'during') makerChatStore.leaveView(s);
      expect(getRemoteHistoryView(s)?.isActive()).toBe(false);
      makerChatStore.enterView(s);
    }
    await flush();
    if (concurrent) {
      host.push('maker:event', { sessionId: s, persistId: 'live', event: {
        type: 'text', data: { text: ' newer', isFinal: false },
      } });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    finish([durable]);
    await flush();
    await flush();
    const row = makerChatStore.getSnapshot(s).messages.find((message) => message.clientId === 'live');
    expect(row?.content).toBe(concurrent ? 'prefix newer' : 'prefix complete');
    expect(row?.isStreaming).toBe(concurrent);
    if (projected) {
      const view = getRemoteHistoryView(s)!;
      const handoff = new HistoryViewHandoff<HistoryChatMessage>((message) => message.isStreaming === true);
      const raw = makerChatStore.getSnapshot(s).messages.map((message) => ({ ...message, id: message.id ?? message.clientId, createdAt: message.createdAt ?? '' }));
      const rendered = handoff.reconcile(view.getSnapshot(), raw);
      expect(rendered.messages.find((message) => message?.clientId === 'live')?.content).toBe(concurrent ? 'prefix newer' : 'prefix complete');
    }
  });

  it('resumes terminal handoff when the first projected page was not ready before leaving', async () => {
    const s = sid();
    host.enableHistoryView();
    host.seedSession(s, {}, []);
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
    let finish!: (value: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
    const original = host.invoke.getMockImplementation()!;
    host.invoke.mockImplementation((...args) => args[1] === 'local-db:messages:view' ? pending : original(...args));
    makerChatStore.enterView(s);
    makerChatStore.ensureInitialMessages(s);
    await flush();
    expect(getRemoteHistoryView(s)?.getSnapshot().ready).toBe(false);
    host.push('maker:session-sync', { sessionId: s, persistId: 'live', event: {
      type: 'text', data: { text: 'prefix', isFinal: false, isFullText: true },
    } });
    makerChatStore.leaveView(s);
    const reads = host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view').length;
    host.push('maker:session-sync', { sessionId: s, resyncRequired: true });
    await flush();
    expect(host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view')).toHaveLength(reads);
    makerChatStore.enterView(s);
    const durable = { ...dbMessage(s, 'live-db', 'prefix complete', '2026-09-08T00:00:02Z'), clientId: 'live' };
    finish({ version: 1, items: projectHistoryView([durable], false), hasMore: false, nextCursor: null });
    await flush();
    await flush();
    expect(makerChatStore.getSnapshot(s).messages.find((row) => row.clientId === 'live')).toMatchObject({
      content: 'prefix complete', isStreaming: false,
    });
  });

  it.each([true, false])('repairs missing history during a live stream without replacing its newer text (overlap=%s)', async (overlap) => {
    const s = sid();
    host.seedSession(s, {}, [dbMessage(s, 'h1', 'history', '2026-09-08T00:00:00Z')]);
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
    makerChatStore.ensureInitialMessages(s);
    await flush();
    await flush();
    host.push('maker:event', { sessionId: s, event: { type: 'status', data: { status: 'Running', isRunning: true } } });
    host.push('maker:session-sync', { sessionId: s, persistId: 'live', event: {
      type: 'text', data: { text: 'live prefix', isFinal: false, isFullText: true, createdAt: '2026-09-08T00:00:02Z' },
    } });
    expect(makerChatStore.getSnapshot(s).messages.at(-1)?.content).toBe('live prefix');
    expect(makerChatStore.getSnapshot(s).isStreaming).toBe(true);
    if (!overlap) host.seedSession(s, {}, []);
    host.hostMessage(s, dbMessage(s, 'missed', 'missed history', '2026-09-08T00:00:01Z'), { lossy: true });
    const before = host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:list').length;
    host.push('maker:session-sync', { sessionId: s, resyncRequired: true });
    await flush();
    await flush();
    expect(host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:list').length).toBeGreaterThan(before);
    expect(makerChatStore.getSnapshot(s).messages.map((message) => message.content)).toEqual([
      ...(overlap ? ['history'] : []), 'missed history', 'live prefix',
    ]);
    host.push('maker:event', { sessionId: s, persistId: 'live', event: {
      type: 'text', data: { text: ' tail', isFinal: false },
    } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(makerChatStore.getSnapshot(s).messages.at(-1)?.content).toBe('live prefix tail');
    const durable = { ...dbMessage(s, 'live-db', 'persisted', '2026-09-08T00:00:02Z'), clientId: 'live' };
    host.hostMessage(s, durable);
    expect(makerChatStore.getSnapshot(s).streamingClientId).toBe('live');
    expect(makerChatStore.getSnapshot(s).messages.at(-1)?.isStreaming).toBe(false);
    // The assembly pointer outlives persistence. It must not prevent repair of
    // a later durable correction whose push was lost.
    host.seedSession(s, {}, [{ ...durable, content: 'corrected durable' }]);
    host.push('maker:session-sync', { sessionId: s, resyncRequired: true });
    await flush();
    await flush();
    expect(makerChatStore.getSnapshot(s).messages.at(-1)?.content).toBe('corrected durable');
  });

  it.each(['migration', 'purge', 'failed-intent'])('orders old release before a replacement same-Host expansion (%s)', async (transition) => {
    const s = sid();
    const other = makeFakeHost('dev-B', 'Mac B');
    host.enableHistoryView();
    other.enableHistoryView();
    const rows = [dbMessage(s, 'user', 'Work', '2026-06-15T00:00:00.000Z', 'user'),
      dbMessage(s, 'work', 'Thinking', '2026-06-15T00:00:01.000Z', 'thinking'),
      dbMessage(s, 'answer', 'Done', '2026-06-15T00:00:02.000Z')];
    host.seedSession(s, {}, rows);
    other.seedSession(s, {}, rows);
    const original = host.invoke.getMockImplementation()!;
    const applied: unknown[][] = [];
    let finish = () => {};
    let pause = true;
    host.invoke.mockImplementation(async (device, channel, args) => {
      if (device === other.deviceId) return other.invoke(device, channel, args);
      if (channel === 'local-db:messages:view-intent') {
        if (pause && (args[1] as unknown[]).length) {
          pause = false;
          await new Promise<void>((resolve) => { finish = resolve; });
          if (transition === 'failed-intent') throw new Error('late intent failure');
        }
        applied.push(args[1] as unknown[]);
      }
      return original(device, channel, args);
    });
    try {
      remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
      makerChatStore.ensureInitialMessages(s);
      await flush();
      const oldView = getRemoteHistoryView(s)!;
      oldView.setExpanded(oldView.getSnapshot().items.find((item) => item.type === 'work')!.key, true);
      await flush();
      if (transition === 'purge') {
        makerChatStore.purgeSession(s);
        makerChatStore.ensureInitialMessages(s);
      } else {
        remoteProjectsStore.setDeviceSessions(other.deviceId, 'Mac B', [{ id: s } as Session]);
        await flush();
        // B's page is independent of the unfinished A intent.
        expect(getRemoteHistoryView(s)?.getSnapshot().ready).toBe(true);
        remoteProjectsStore.removeDevice(other.deviceId);
        remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
      }
      await flush();
      const current = getRemoteHistoryView(s)!;
      expect(remoteProjectsStore.getSessionDeviceId(s)).toBe(DEVICE_ID);
      expect(current).not.toBe(oldView);
      expect(current.getSnapshot().ready).toBe(true);
      const work = current.getSnapshot().items.find((item) => item.type === 'work')!;
      current.setExpanded(work.key, true);
      await flush();
      finish();
      await flush();
      await flush();
      expect(applied.at(-1)).toEqual([work.type === 'work' ? work.summary : undefined]);
      expect(getRemoteHistoryView(s)).toBe(current);
    } finally {
      finish();
      makerChatStore.purgeSession(s);
      await flush();
    }
  });

  it.each(['initial', 'older', 'reconcile', 'details', 'intent', 'aba'])('retires every old-source history path before replacement (%s)', async (scenario) => {
    const s = sid();
    const other = makeFakeHost('dev-B', 'Mac B');
    host.enableHistoryView();
    other.enableHistoryView();
    const oldRows = [
      dbMessage(s, 'old-user', 'old user', '2026-06-15T00:00:00.000Z', 'user'),
      dbMessage(s, 'old-work', 'old thinking', '2026-06-15T00:00:01.000Z', 'thinking'),
      dbMessage(s, 'old-answer', 'old answer', '2026-06-15T00:00:02.000Z'),
    ];
    const newRows = [dbMessage(s, 'new-user', 'new source', '2026-06-15T00:01:00.000Z', 'user')];
    host.seedSession(s, {}, oldRows);
    other.seedSession(s, {}, newRows);
    const original = host.invoke.getMockImplementation()!;
    let pause = scenario === 'initial';
    let finish: () => void = () => {};
    const channelToPause = scenario === 'details' ? 'local-db:messages:work-details'
      : scenario === 'intent' ? 'local-db:messages:view-intent' : 'local-db:messages:view';
    host.invoke.mockImplementation(async (device, channel, args) => {
      if (device === other.deviceId) return other.invoke(device, channel, args);
      // Capture the old response before migration, including an old-Host failure.
      const value = await original(device, channel, args);
      if (pause && channel === channelToPause && (scenario !== 'intent' || (args[1] as unknown[]).length)) {
        pause = false;
        await new Promise<void>((resolve) => { finish = resolve; });
        if (scenario === 'older' || scenario === 'reconcile') throw new Error('[CHANNEL_NOT_ALLOWED] No handler');
      }
      return value;
    });
    try {
      remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
      makerChatStore.ensureInitialMessages(s);
      await flush();
      const oldView = getRemoteHistoryView(s)!;
      let pending: Promise<unknown> | undefined;
      if (scenario !== 'initial') {
        const work = oldView.getSnapshot().items.find((item) => item.type === 'work')!;
        if (scenario === 'older') {
          // Give the real pagination entry point an older cursor to request.
          host.seedSession(s, {}, Array.from({ length: 25 }, (_, index) =>
            dbMessage(s, `past-${index}`, `past ${index}`, new Date(Date.UTC(2026, 5, 14) + index * 1000).toISOString(), 'user')));
          await oldView.refresh();
          pause = true;
          pending = makerChatStore.loadOlderMessages(s);
        } else if (scenario === 'reconcile' || scenario === 'aba') {
          pause = true;
          pending = makerChatStore.reconcileRemoteMessages(s);
        } else {
          pause = true;
          oldView.setExpanded(work.key, true);
        }
        await flush();
      }
      if (scenario === 'aba') {
        remoteProjectsStore.removeDevice(DEVICE_ID);
        expect(getRemoteHistoryView(s)).toBeUndefined();
        expect(oldView.isActive()).toBe(false);
        host.seedSession(s, {}, newRows);
        remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
      } else {
        remoteProjectsStore.setDeviceSessions(other.deviceId, 'Mac B', [{ id: s } as Session]);
      }
      await flush();
      const newView = getRemoteHistoryView(s)!;
      expect(newView).toBeDefined();
      expect(newView).not.toBe(oldView);
      expect(oldView.isActive()).toBe(false);
      expect(makerChatStore.getSnapshot(s).messages.map((row) => row.content)).toEqual(['new source']);
      finish();
      await pending;
      await flush();
      expect(getRemoteHistoryView(s)).toBe(newView);
      expect(newView.getSnapshot().error).toBeNull();
      expect(makerChatStore.getSnapshot(s).messages.map((row) => row.content)).toEqual(['new source']);
      const reads = host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view').length;
      // A retained old reference cannot issue more page/detail reads.
      await oldView.refresh();
      expect(host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view')).toHaveLength(reads);
      if (scenario === 'intent') {
        const oldIntents = host.invoke.mock.calls.filter(([device, channel]) => device === DEVICE_ID && channel === 'local-db:messages:view-intent');
        expect(oldIntents.at(-1)?.[2]).toEqual([s, []]);
      }
    } finally {
      finish();
      makerChatStore.purgeSession(s);
      await flush();
    }
  });

  it('keeps a same-source controller on ordinary mirror updates', async () => {
    const s = sid();
    host.enableHistoryView();
    host.seedSession(s, {}, [dbMessage(s, 'one', 'same source', '2026-06-15T00:00:00.000Z')]);
    try {
      remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
      makerChatStore.ensureInitialMessages(s);
      await flush();
      const view = getRemoteHistoryView(s);
      const reads = host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view').length;
      remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s, title: 'new title' } as Session]);
      await flush();
      expect(getRemoteHistoryView(s)).toBe(view);
      expect(host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view')).toHaveLength(reads);
    } finally {
      makerChatStore.purgeSession(s);
      await flush();
    }
  });

  it.each(['empty', 'rewound', 'failure', 'late-cache'])('hands off cold cache to authoritative history (%s)', async (scenario) => {
    const s = sid();
    const create = { ...dbMessage(s, 'create', '', '2026-06-15T00:00:00.000Z', 'tool_use'),
      content: { toolName: 'TodoWrite', input: { todos: [{ content: 'Deleted plan', status: 'pending', activeForm: 'Working' }] } } } as unknown as Message;
    const cached = [create, dbMessage(s, 'same', 'stale text', '2026-06-15T00:00:01.000Z', 'user')];
    let finishCache: (rows: Message[]) => void = () => {};
    vi.mocked(readCachedMessages).mockImplementationOnce(() => scenario === 'late-cache'
      ? new Promise((resolve) => { finishCache = resolve; }) : Promise.resolve(cached));
    host.enableHistoryView();
    host.seedSession(s, {}, scenario === 'rewound'
      ? [dbMessage(s, 'same', 'current text', '2026-06-15T00:00:01.000Z', 'user')] : []);
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
    const invoke = host.invoke.getMockImplementation()!;
    let finishPage: () => void = () => {};
    host.invoke.mockImplementation(async (device, channel, args) => {
      if (channel === 'local-db:messages:view') {
        await new Promise<void>((resolve) => { finishPage = resolve; });
        if (scenario === 'failure') throw new Error('timeout');
      }
      return invoke(device, channel, args);
    });
    try {
      makerChatStore.ensureInitialMessages(s);
      await flush();
      if (scenario !== 'late-cache') {
        expect(getLatestMessageTodoState(makerChatStore.getSnapshot(s).messages).hasPlanEvent).toBe(true);
        expect(makerChatStore.getSnapshot(s).messages.every((row) => row.cacheHydrated)).toBe(true);
      }
      // A push arriving during the cache handoff is not part of the stale cache.
      if (scenario === 'rewound') host.hostMessage(s, dbMessage(s, 'live', 'live output', '2026-06-15T00:00:02.000Z'));
      finishPage();
      await flush();
      finishCache(cached);
      await flush();
      const state = makerChatStore.getSnapshot(s);
      if (scenario === 'failure') {
        expect(state.messages).toHaveLength(2);
        expect(state.historyLoaded).toBe(false);
        expect(clearCachedMessages).not.toHaveBeenCalled();
      } else {
        expect(state.historyLoaded).toBe(true);
        expect(state.messages.some((row) => row.cacheHydrated)).toBe(false);
        expect(getLatestMessageTodoState(state.messages).hasPlanEvent).toBe(false);
        expect(clearCachedMessages).toHaveBeenCalledWith(DEVICE_ID, s);
        if (scenario === 'rewound') {
          expect(state.messages.map((row) => row.content)).toEqual(['current text', 'live output']);
        } else expect(state.messages).toHaveLength(0);
      }
    } finally {
      makerChatStore.purgeSession(s);
    }
  });

  it.each(['demote', 'in-flight-demote', 'purge'])('releases unmounted prefetch without starting another read (%s)', async (mode) => {
    vi.useFakeTimers();
    const s = sid();
    let finishPage: () => void = () => {};
    try {
      host.enableHistoryView();
      host.seedSession(s, {}, [dbMessage(s, 'old', 'old text', '2026-06-15T00:00:00.000Z')]);
      remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
      makerChatStore.ensureInitialMessages(s);
      await vi.advanceTimersByTimeAsync(0);
      const view = getRemoteHistoryView(s)!;
      const invoke = host.invoke.getMockImplementation()!;
      if (mode === 'in-flight-demote') {
        host.invoke.mockImplementation(async (device, channel, args) => {
          if (channel === 'local-db:messages:view') await new Promise<void>((resolve) => { finishPage = resolve; });
          return invoke(device, channel, args);
        });
        void view.refresh();
      }
      const reads = host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view').length;
      if (mode === 'purge') makerChatStore.purgeSession(s);
      else await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(view.isActive()).toBe(false);
      expect(getRemoteHistoryView(s)).toBeUndefined();
      finishPage();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view')).toHaveLength(reads);
      expect(makerChatStore.getSnapshot(s).messages).toHaveLength(0);
      host.invoke.mockImplementation(invoke);
      host.seedSession(s, {}, [dbMessage(s, 'new', 'new text', '2026-06-15T00:00:01.000Z')]);
      // Re-prefetch must work even without a mounted view to reactivate it.
      makerChatStore.ensureInitialMessages(s);
      await vi.advanceTimersByTimeAsync(0);
      expect(makerChatStore.getSnapshot(s).messages.map((row) => row.content)).toEqual(['new text']);
      expect(host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view')).toHaveLength(reads + 1);
    } finally {
      finishPage();
      makerChatStore.purgeSession(s);
      vi.useRealTimers();
    }
  });

  it.each(['mounted', 'prefetched', 'resumed', 'discovered', 'stalled'])('discovers plans through visible pages and stops without progress (%s)', async (entry) => {
    vi.useFakeTimers();
    const s = sid();
    let leave: (() => void) | undefined;
    const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
    try {
      const row = (index: number, content: string, role: Message['role'] = 'assistant') =>
        dbMessage(s, String(index), content, new Date(Date.UTC(2026, 5, 15) + index * 1000).toISOString(), role);
      const create = { ...row(1, '', 'tool_use'), toolUseId: 'create',
        content: { toolName: 'TaskCreate', input: { subject: 'Collect logs' }, toolUseId: 'create' } } as unknown as Message;
      const result = { ...row(2, 'Task #abc created successfully: Collect logs', 'tool_result'), toolUseId: 'create' };
      const update = { ...row(44, '', 'tool_use'), toolUseId: 'update',
        ...(entry === 'discovered' ? { createdAt: row(23.5, '').createdAt } : {}),
        content: { toolName: 'TaskUpdate', input: { taskId: 'abc', status: 'in_progress' }, toolUseId: 'update' } } as unknown as Message;
      host.enableHistoryView();
      host.seedSession(s, {}, [row(0, 'Investigate', 'user'), create, result, row(3, 'hidden', 'thinking'),
        ...Array.from({ length: 40 }, (_, i) => row(i + 4, `# Result ${i}\nUseful output`)), update]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
      if (entry !== 'prefetched') leave = makerChatStore.enterView(s);
      makerChatStore.ensureInitialMessages(s);
      await settle();
      const view = getRemoteHistoryView(s)!;
      expect(view.getSnapshot().items).toHaveLength(20);
      expect(getLatestMessageTodoState(makerChatStore.getSnapshot(s).messages, { taskHistoryMayBeIncomplete: true }).hasPlanEvent).toBe(entry !== 'discovered');
      if (entry === 'stalled') {
        const invoke = host.invoke.getMockImplementation()!;
        host.invoke.mockImplementation((device, channel, args) => invoke(device, channel,
          channel === 'local-db:messages:view' ? [args[0], {}] : args));
      }
      if (entry === 'resumed') { leave!(); leave = undefined; }
      if (entry === 'prefetched' || entry === 'resumed') {
        await vi.advanceTimersByTimeAsync(200);
        expect(host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view')).toHaveLength(1);
        leave = makerChatStore.enterView(s);
        await settle();
      }
      await vi.advanceTimersByTimeAsync(200);
      await settle();
      const state = makerChatStore.getSnapshot(s);
      const plan = getLatestMessageTodoState(state.messages, { taskHistoryMayBeIncomplete: state.hasMoreMessages });
      if (entry === 'stalled') {
        expect(plan.isResolved).toBe(false);
        expect(host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view')).toHaveLength(2);
        return;
      }
      expect(plan).toMatchObject({ hasPlanEvent: true, isResolved: true });
      expect(JSON.stringify(plan.insertion)).toContain('Collect logs');
      expect(view.getSnapshot().hasMore).toBe(false);
      expect(view.getSnapshot().details.size).toBe(0);
      expect(host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view')).toHaveLength(entry === 'resumed' ? 4 : 3);
      expect(host.invoke.mock.calls.some(([, channel]) => channel === 'local-db:messages:list' || channel === 'local-db:messages:work-details')).toBe(false);
    } finally {
      leave?.();
      makerChatStore.purgeSession(s);
      vi.useRealTimers();
    }
  });

  it.each([false, true])('bounds idle discovery without a plan, including a failed page (fails=%s)', async (fails) => {
    vi.useFakeTimers();
    const s = sid();
    let leave: (() => void) | undefined;
    try {
      host.enableHistoryView();
      host.seedSession(s, {}, Array.from({ length: 60 }, (_, i) => dbMessage(s, String(i), `# Result ${i}\nUseful output`, new Date(Date.UTC(2026, 5, 15) + i * 1000).toISOString())));
      remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
      leave = makerChatStore.enterView(s);
      makerChatStore.ensureInitialMessages(s);
      await vi.advanceTimersByTimeAsync(0);
      const invoke = host.invoke.getMockImplementation()!;
      if (fails) host.invoke.mockImplementation(async (device, channel, args) => {
        if (channel === 'local-db:messages:view' && (args[1] as { before?: string })?.before) throw new Error('timeout');
        return invoke(device, channel, args);
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view')).toHaveLength(2);
      const snapshot = getRemoteHistoryView(s)!.getSnapshot();
      expect(snapshot.items).toHaveLength(fails ? 20 : 40);
      expect(snapshot.hasMore).toBe(true);
      expect(snapshot.error ? String(snapshot.error) : null).toBe(fails ? 'Error: timeout' : null);
    } finally {
      leave?.();
      makerChatStore.purgeSession(s);
      vi.useRealTimers();
    }
  });

  it.each(['delete', 'clear'])('retires loaded older projection pages after a remote %s', async (operation) => {
    const s = sid();
    host.enableHistoryView();
    const rows = Array.from({ length: 30 }, (_, index) => dbMessage(s, String(index), 'visible',
      new Date(1_750_000_000_000 + index * 1000).toISOString(), 'user'));
    host.seedSession(s, { clearedAt: null }, rows);
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
    makerChatStore.ensureInitialMessages(s);
    await flush(); await flush();
    const view = getRemoteHistoryView(s)!;
    await view.refresh(true);
    expect(view.getSnapshot().items).toHaveLength(30);
    host.hostPatch(s, { title: 'ordinary metadata' });
    expect(view.getSnapshot().items).toHaveLength(30);
    if (operation === 'delete') host.hostDelete(s, [rows[0].clientId]);
    else {
      host.seedSession(s, {}, []);
      host.hostPatch(s, { clearedAt: '2026-09-08T10:00:00Z' });
    }
    expect(view.getSnapshot().items).toEqual([]);
    expect(makerChatStore.getSnapshot(s).messages.some((row) => row.clientId === rows[0].clientId)).toBe(false);
    await flush(); await flush();
    expect(view.getSnapshot().ready).toBe(true);
    expect(view.getSnapshot().items).toHaveLength(operation === 'delete' ? 20 : 0);
    view.setActive(false);
  });

  it('returns to raw history when a previously capable Host is downgraded', async () => {
    const s = sid();
    host.enableHistoryView();
    host.seedSession(s, {}, [dbMessage(s, 'old', 'old', '2026-06-15T00:00:00.000Z')]);
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
    makerChatStore.ensureInitialMessages(s);
    await flush();
    await flush();
    const view = getRemoteHistoryView(s)!;
    expect(view.getSnapshot().ready).toBe(true);
    host.disableHistoryView();
    host.hostMessage(s, dbMessage(s, 'new', 'new', '2026-06-15T00:00:01.000Z'), { lossy: true });
    await makerChatStore.reconcileRemoteMessages(s, { force: true });
    expect(view.getSnapshot().ready).toBe(false);
    expect(getRemoteHistoryView(s)).toBeUndefined();
    expect(host.invoke).toHaveBeenCalledWith(DEVICE_ID, 'local-db:messages:list', expect.anything());
    expect(makerChatStore.getSnapshot(s).messages.map((row) => row.clientId)).toEqual(['client-old', 'client-new']);
  });
  it.each(['resync', 'queued-resync', 'stall', 'newer-live', 'snapshot-repair'] as const)(
    'recovers HistoryView rows without losing expanded history (%s)', async (scenario) => {
      const s = sid();
      host.enableHistoryView();
      const history = [
        dbMessage(s, 'u', 'previous question', '2026-06-15T00:00:00.000Z', 'user'),
        { ...dbMessage(s, 'thought', '', '2026-06-15T00:00:01.000Z', 'thinking'),
          content: { kind: 'thinking', text: 'expanded history', durationMs: 500, isRedacted: false } },
        dbMessage(s, 'previous', 'previous answer', '2026-06-15T00:00:02.000Z'),
        dbMessage(s, 'question', 'current question', '2026-06-15T00:00:03.000Z', 'user'),
      ];
      host.seedSession(s, {}, history);
      remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
      makerChatStore.ensureInitialMessages(s);
      await flush(); await flush();
      const view = getRemoteHistoryView(s)!;
      expect(view.getSnapshot().ready).toBe(true);
      const group = view.getSnapshot().items.find((item) => item.type === 'work')!;
      view.setExpanded(group.key, true);
      await flush();
      expect(view.getSnapshot().details.get(group.key)?.messages[0].content).toBe('expanded history');

      host.push('maker:event', { sessionId: s, event: { type: 'status', source: 'claude-code',
        data: { status: 'thinking', isRunning: true, tokenUsage: 0, contextTokens: 0, contextWindow: 0 } } });
      const snapshot = (text: string, resyncRequired = false) => host.push('maker:session-sync', {
        sessionId: s, persistId: 'client-answer', resyncRequired,
        event: { type: 'text', source: 'claude-code', data: { text, isFullText: true, isFinal: false } },
      });
      snapshot('stale prefix');
      const raw = () => makerChatStore.getSnapshot(s).messages;
      expect(makerChatStore.getSnapshot(s).isStreaming).toBe(true);
      expect(raw().find((row) => row.clientId === 'client-answer')).toMatchObject({ content: 'stale prefix', isStreaming: true });
      const handoff = new HistoryViewHandoff<HistoryChatMessage>((row) => !!row.isStreaming);
      const visible = () => handoff.reconcile(view.getSnapshot(), raw().map(row => ({
        ...row, id: row.id ?? row.clientId, createdAt: row.createdAt ?? '',
      })));
      expect(visible().pending.has('client-answer')).toBe(true);

      const original = host.invoke.getMockImplementation()!;
      let finish: (() => void) | undefined;
      let delayNextPage = scenario === 'queued-resync' || scenario === 'newer-live';
      host.invoke.mockImplementation(async (device, channel, args) => {
        const value = await original(device, channel, args);
        if (channel === 'local-db:messages:view' && delayNextPage) {
          delayNextPage = false;
          await new Promise<void>(resolve => { finish = resolve; });
        }
        return value;
      });
      let repair: Promise<boolean> | undefined;
      if (scenario === 'queued-resync') {
        repair = makerChatStore.reconcileRemoteMessages(s, { repair: true });
        await flush();
        expect(finish).toBeTypeOf('function');
      }
      // The final text and terminal push were both lost. The same persistId is
      // now sealed in the Host DB; the controller still has the streaming prefix.
      host.hostMessage(s, dbMessage(s, 'answer', 'authoritative sealed answer', '2026-06-15T00:00:04.000Z'), { lossy: true });
      const readsBeforeRecovery = host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view').length;
      let forced: Promise<boolean> | undefined;
      if (scenario === 'stall') forced = makerChatStore.reconcileRemoteMessages(s, { force: true });
      else if (scenario === 'snapshot-repair') snapshot('current live snapshot', true);
      else host.push('maker:session-sync', { sessionId: s, resyncRequired: true });
      await flush();
      if (scenario === 'newer-live') {
        expect(finish).toBeTypeOf('function');
        snapshot('newer live text received during recovery');
      }
      finish?.();
      await repair; await forced;
      await flush(); await flush();

      const stillLive = scenario === 'newer-live' || scenario === 'snapshot-repair';
      const expected = scenario === 'newer-live' ? 'newer live text received during recovery'
        : scenario === 'snapshot-repair' ? 'current live snapshot' : 'authoritative sealed answer';
      expect(raw().filter((row) => row.clientId === 'client-answer')).toEqual([
        expect.objectContaining({ content: expected, isStreaming: stillLive }),
      ]);
      expect(getRemoteHistoryView(s)).toBe(view);
      expect(view.isActive()).toBe(true);
      expect(view.getSnapshot().expanded.has(group.key)).toBe(true);
      expect(view.getSnapshot().details.get(group.key)?.messages[0].content).toBe('expanded history');
      expect(visible().messages.find((row) => row.clientId === 'client-answer')?.content).toBe(expected);
      expect(visible().pending.has('client-answer')).toBe(stillLive);
      expect(host.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:messages:view')).toHaveLength(readsBeforeRecovery + 1);
      expect(host.invoke).not.toHaveBeenCalledWith(DEVICE_ID, 'local-db:messages:list', expect.anything());
      makerChatStore.purgeSession(s);
    },
  );

  it.each([false, true])('registers a fresh history page after ACK; reset during wait=%s', async (reset) => {
    const s = sid();
    host.enableHistoryView();
    host.seedSession(s, {}, [dbMessage(s, 'answer', 'answer', '2026-06-15T00:00:00.000Z')]);
    const original = host.invoke.getMockImplementation()!;
    let finish!: () => void;
    let finishReset!: () => void;
    let pageReads = 0;
    host.invoke.mockImplementation(async (device, channel, args) => {
      const value = await original(device, channel, args);
      if (channel === 'local-db:messages:view' && ++pageReads === 1) await new Promise<void>(done => { finish = done; });
      else if (reset && channel === 'local-db:messages:view') await new Promise<void>(done => { finishReset = done; });
      return value;
    });
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
    makerChatStore.ensureInitialMessages(s);
    await flush();
    const view = getRemoteHistoryView(s)!;
    expect(view.getSnapshot().ready).toBe(false);
    const recovered = makerChatStore.reconcileRemoteMessages(s, { freshHistory: true });
    if (reset) { view.reset(); await flush(); }
    finish();
    expect(await recovered).toBe(!reset);
    expect(pageReads).toBe(2);
    expect(view.getSnapshot().ready).toBe(!reset);
    if (reset) { finishReset(); await flush(); }
    view.setActive(false);
  });
  it('reads visible history first and fetches a collapsed work range only after expansion', async () => {
    const s = sid();
    host.enableHistoryView();
    const history = [dbMessage(s, 'u', 'question', '2026-06-15T00:00:00.000Z', 'user'),
      { ...dbMessage(s, 'thought', '', '2026-06-15T00:00:01.000Z', 'thinking'), content: { kind: 'thinking', text: 'hidden body', durationMs: 500, isRedacted: false } },
      dbMessage(s, 'answer', 'answer', '2026-06-15T00:00:02.000Z')];
    host.seedSession(s, {}, history);
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s } as Session]);
    makerChatStore.ensureInitialMessages(s);
    await flush();
    await flush();
    expect(host.invoke).not.toHaveBeenCalledWith(DEVICE_ID, 'local-db:messages:list', expect.anything());
    expect(makerChatStore.getSnapshot(s).messages.map((row) => row.clientId)).toEqual(['client-u', 'client-answer']);
    const view = getRemoteHistoryView(s)!;
    const group = view.getSnapshot().items.find((item) => item.type === 'work')!;
    expect(view.getSnapshot().details.size).toBe(0);
    view.setExpanded(group.key, true);
    await flush();
    expect(view.getSnapshot().details.get(group.key)?.messages[0].content).toBe('hidden body');
    expect(makerChatStore.getSnapshot(s).messages.some((row) => row.clientId === 'client-thought')).toBe(true);
    view.setActive(false);
  });

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
