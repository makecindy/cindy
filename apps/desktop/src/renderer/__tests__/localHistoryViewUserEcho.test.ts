/**
 * localHistoryViewUserEcho.test.ts
 * ---------------------------------------------------------------------------
 * 本机任务也由历史视图渲染(#5073)。本端发出的 user 行在落库回声时去掉
 * isPendingPersist，而历史视图要等防抖重读(≥500ms)后才读到它；这段时间里
 * 它既不在快照里、也不再算本地行，气泡会消失再出现。这里锁定：普通发送、排队
 * 派发、插话三条本机路径的回声都保留位置预留，直到历史视图确认后才撤掉；
 * 外部注入的 user 行与已进入快照的行不受影响。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentInputProjection, AgentInputQueuedMessage } from '../../shared/agentInputQueue';
import type { Message } from '@/lib/ccAgent.types';
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
  get: vi.fn(async () => {
    throw new Error('[NOT_FOUND] Session 不存在');
  }),
  update: vi.fn(async () => ({})),
  touchUserSend: vi.fn(async () => ({})),
}));
vi.mock('@/lib/sessionsBus', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/sessionsBus')>(),
  emitPatch: vi.fn(),
}));
vi.mock('@/lib/userPromptStore', () => ({ getUserPrompt: () => '' }));
vi.mock('@/lib/imageRef', () => ({
  parseUserContent: vi.fn((c: string) => ({ text: c, images: [], files: [] })),
  stringifyUserContent: vi.fn((text: string) => text),
}));
vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  setRemoteOptimisticAttachmentUrls: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

import { makerChatStore, getRemoteHistoryView, type HistoryChatMessage } from '@/lib/makerChatStore';
import {
  HistoryViewHandoff,
  historyViewLeaves,
  projectHistoryView,
  renderHistoryView,
} from '@cindy/maker-shared/message-window';
import { projectRemoteUsers } from '@/lib/remoteUserHandoff';

const OWNER_STAMP = { dataOwnerId: 'test-owner', ownerGeneration: 0 } as const;
const WD = 'C:\\workspace';

function emptyProjection(sessionId: string, patch: Partial<AgentInputProjection> = {}): AgentInputProjection {
  return {
    sessionId, pendingQueue: [], steeringQueueClientIds: [], queuePaused: false,
    queueExpanded: false, queueInteractionLocks: [], queueEditLocks: [], queueAbortPending: false,
    error: null, recovery: null, errorRetryText: null, credentialSwitchWait: null,
    ...patch,
  };
}

function dbMessage(sessionId: string, clientId: string, content: string, createdAt: string, role: Message['role']): Message {
  return { id: `db-${clientId}`, clientId, sessionId, role, content, toolUseId: null, agentMeta: null, createdAt };
}

// 本机 DB 的内存替身：historyView 按同一套投影读最新一页；落库时广播 messages:created。
const rowsBySession = new Map<string, Message[]>();
let onCreatedCb: ((data: unknown, ownerStamp?: unknown) => void) | null = null;
let onProjectionCb: ((data: unknown, ownerStamp?: unknown) => void) | null = null;
const enqueue = vi.fn(async (sessionId: string, _item: AgentInputQueuedMessage) => emptyProjection(sessionId));
const steer = vi.fn(async (_sessionId: string, _item: AgentInputQueuedMessage) => true);

function persist(message: Message): void {
  rowsBySession.set(message.sessionId, [...(rowsBySession.get(message.sessionId) ?? []), message]);
  onCreatedCb?.({ sessionId: message.sessionId, message }, OWNER_STAMP);
}

function persistQueued(sessionId: string, item: AgentInputQueuedMessage, createdAt: string): void {
  persist(dbMessage(sessionId, item.clientId, item.text, createdAt, 'user'));
}

function installElectronApi(): void {
  const fanOut = () => () => () => {};
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      maker: {
        onEvent: fanOut(),
        onStatusChanged: fanOut(),
        onInputProjection: (cb: (data: unknown, ownerStamp?: unknown) => void) => {
          onProjectionCb = cb;
          return () => { onProjectionCb = null; };
        },
        onInteractionRequest: fanOut(),
        onInteractionDismissed: fanOut(),
        autoTitle: vi.fn(async () => ({ applied: true, done: true })),
        getPendingInteractions: vi.fn(async () => []),
        input: {
          enqueue,
          steer,
          getProjection: vi.fn(async (s: string) => emptyProjection(s)),
        },
      },
      localDb: {
        messages: {
          onCreated: (cb: (data: unknown, ownerStamp?: unknown) => void) => {
            onCreatedCb = cb;
            return () => { onCreatedCb = null; };
          },
          historyView: vi.fn(async (sessionId: string) => {
            // 最新一页：按行截尾再投影（prose 行会合成单个 messages 叶子，
            // 直接 slice items 截不掉旧行，测试就无法把旧行挤出快照）。
            const rows = (rowsBySession.get(sessionId) ?? []).slice(-20);
            return { version: 1, items: projectHistoryView(rows, false), hasMore: false, nextCursor: null };
          }),
          workDetails: vi.fn(async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null })),
        },
      },
      onUsageMessageTurnCost: fanOut(),
      deviceLink: {
        invoke: vi.fn(async () => null),
        onRemotePush: fanOut(),
        onStatusChanged: fanOut(),
        onPresenceChanged: fanOut(),
      },
    },
  };
}

/** 与 MessageStream 同一条渲染链：projectRemoteUsers → handoff → renderHistoryView。 */
function renderedClientIds(sessionId: string): string[] {
  const view = getRemoteHistoryView(sessionId)!;
  const snapshot = view.getSnapshot();
  const historyIds = new Set(historyViewLeaves(snapshot.items).flatMap((item) =>
    item.type === 'messages' ? item.messages.map((row) => row.clientId) : []));
  for (const detail of snapshot.details.values()) for (const row of detail.messages) historyIds.add(row.clientId);
  const live = projectRemoteUsers(makerChatStore.getSnapshot(sessionId).messages, historyIds)
    .map((row) => ({ ...row, id: row.id ?? row.clientId, createdAt: row.createdAt ?? '' })) as HistoryChatMessage[];
  const handoff = new HistoryViewHandoff<HistoryChatMessage>((row) => row.isStreaming === true);
  return renderHistoryView<HistoryChatMessage, string>({
    view, snapshot, liveMessages: live, streaming: false,
    isLive: (row) => row.isStreaming === true,
    pendingHandoff: handoff.reconcile(snapshot, live).pending,
    isLocalUser: (row) => row.role === 'user'
      && (row.isPendingPersist === true || !!row.blockedByGhost || !!row.localSendPrecedingClientIds),
    build: (rows) => rows.map((row) => row.clientId),
    structure: {
      placeholder: () => { throw new Error('fixture contains prose only'); },
      children: () => undefined,
      sourceIds: () => [],
      rebuild: (item) => item,
    },
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let n = 0;
const sid = () => `local-echo-${n++}`;

async function openSession(sessionId: string): Promise<void> {
  rowsBySession.set(sessionId, [
    dbMessage(sessionId, 'old-user', 'old question', '2026-09-28T00:00:00.000Z', 'user'),
    dbMessage(sessionId, 'old-answer', 'old answer', '2026-09-28T00:00:01.000Z', 'assistant'),
  ]);
  makerChatStore.enterView(sessionId);
  makerChatStore.ensureInitialMessages(sessionId);
  await flush(); await flush();
  expect(getRemoteHistoryView(sessionId)?.getSnapshot().ready).toBe(true);
}

beforeEach(() => {
  dataOwnerTesting.reset();
  setDataOwnerGeneration(OWNER_STAMP.dataOwnerId, OWNER_STAMP.ownerGeneration);
  rowsBySession.clear();
  installElectronApi();
  makerChatStore.initGlobalListeners();
});

afterEach(() => {
  makerChatStore.__teardownGlobalListeners();
  delete (globalThis as { window?: unknown }).window;
  vi.clearAllMocks();
  dataOwnerTesting.reset();
});

describe('local history view keeps user rows through the DB echo', () => {
  it('keeps an ordinary send visible between the echo and the history refresh', async () => {
    const s = sid();
    await openSession(s);
    await makerChatStore.sendMessage(s, 'new question', 'claude', '', 'default', WD);
    const item = enqueue.mock.calls[0][1];
    expect(renderedClientIds(s)).toEqual(['old-user', 'old-answer', item.clientId]);

    persistQueued(s, item, '2026-09-28T00:00:02.000Z');
    expect(renderedClientIds(s)).toEqual(['old-user', 'old-answer', item.clientId]);
    const echoed = makerChatStore.getSnapshot(s).messages.find((row) => row.clientId === item.clientId)!;
    expect(echoed.isPendingPersist).toBeUndefined();
    expect(echoed.localSendPrecedingClientIds).toEqual(['old-user', 'old-answer']);

    await getRemoteHistoryView(s)!.refresh();
    const final = makerChatStore.getSnapshot(s).messages.filter((row) => row.clientId === item.clientId);
    expect(final).toHaveLength(1);
    expect(final[0].localSendPrecedingClientIds).toBeUndefined();
    expect(renderedClientIds(s)).toEqual(['old-user', 'old-answer', item.clientId]);
    makerChatStore.purgeSession(s);
  });

  it.each(['echo-first', 'projection-first'])('keeps a queued send visible once main dispatches it: %s', async (order) => {
    const s = sid();
    await openSession(s);
    enqueue.mockImplementationOnce(async (sessionId, queued) => emptyProjection(sessionId, { pendingQueue: [queued] }));
    await makerChatStore.sendMessage(s, 'queued question', 'claude', '', 'default', WD);
    const item = enqueue.mock.calls[0][1];
    expect(makerChatStore.getSnapshot(s).pendingQueue.map((queued) => queued.clientId)).toEqual([item.clientId]);

    if (order === 'projection-first') onProjectionCb?.(emptyProjection(s), OWNER_STAMP);
    persistQueued(s, item, '2026-09-28T00:00:02.000Z');
    if (order === 'echo-first') onProjectionCb?.(emptyProjection(s), OWNER_STAMP);
    await flush();

    expect(makerChatStore.getSnapshot(s).pendingQueue).toEqual([]);
    expect(renderedClientIds(s)).toEqual(['old-user', 'old-answer', item.clientId]);

    await getRemoteHistoryView(s)!.refresh();
    expect(makerChatStore.getSnapshot(s).messages.find((row) => row.clientId === item.clientId)?.localSendPrecedingClientIds)
      .toBeUndefined();
    expect(renderedClientIds(s)).toEqual(['old-user', 'old-answer', item.clientId]);
    makerChatStore.purgeSession(s);
  });

  it('keeps a steer visible from its echo until history owns it', async () => {
    const s = sid();
    await openSession(s);
    await makerChatStore.steerMessage(s, 'steer text', 'claude', '', 'default', WD);
    const item = steer.mock.calls[0][1];
    persistQueued(s, item, '2026-09-28T00:00:02.000Z');
    expect(renderedClientIds(s)).toEqual(['old-user', 'old-answer', item.clientId]);
    await getRemoteHistoryView(s)!.refresh();
    expect(makerChatStore.getSnapshot(s).messages.find((row) => row.clientId === item.clientId)?.localSendPrecedingClientIds)
      .toBeUndefined();
    makerChatStore.purgeSession(s);
  });

  it('leaves externally injected users and rows already in history unreserved', async () => {
    const s = sid();
    await openSession(s);
    persist(dbMessage(s, 'from-im', 'im message', '2026-09-28T00:00:02.000Z', 'user'));
    expect(makerChatStore.getSnapshot(s).messages.find((row) => row.clientId === 'from-im')?.localSendPrecedingClientIds)
      .toBeUndefined();

    await makerChatStore.sendMessage(s, 'already read', 'claude', '', 'default', WD);
    const item = enqueue.mock.calls[0][1];
    // 历史视图先读到落库行，回声后到：快照已拥有它，不再预留。
    rowsBySession.set(s, [...rowsBySession.get(s)!, dbMessage(s, item.clientId, item.text, '2026-09-28T00:00:03.000Z', 'user')]);
    await getRemoteHistoryView(s)!.refresh();
    onCreatedCb?.({ sessionId: s, message: rowsBySession.get(s)!.at(-1) }, OWNER_STAMP);
    expect(makerChatStore.getSnapshot(s).messages.find((row) => row.clientId === item.clientId)?.localSendPrecedingClientIds)
      .toBeUndefined();
    expect(renderedClientIds(s)).toEqual(['old-user', 'old-answer', 'from-im', item.clientId]);
    makerChatStore.purgeSession(s);
  });

  // Codex review P2：排队项本身不构成本端发送证据。IM 通道、手机端、定时任务
  // 注入的 user 项也会经 pendingQueue 派发，且不登记 localSentUserMessageIds；
  // 它们的落库回声不得被附上 localSendPrecedingClientIds（否则历史视图会把它
  // 当本地 user 尾项提前插入/重排，刷新后才纠正）。
  it.each<[string, (item: AgentInputQueuedMessage) => AgentInputQueuedMessage]>([
    ['IM 通道', (item) => item],
    ['手机端', (item) => ({ ...item, fromMobileClient: true })],
    ['定时任务', (item) => ({
      ...item,
      origin: { kind: 'scheduler', scheduleId: 'sch-1', scheduleName: 'nightly' },
    })],
  ])('不把%s注入的排队项当成本端发送', async (source, decorate) => {
    const s = sid();
    await openSession(s);
    const externalItem = decorate({
      clientId: `from-queue-${source}`,
      text: `${source} injected`,
      persistedContent: JSON.stringify({ text: `${source} injected`, images: [], files: [] }),
      model: 'claude',
      effort: '',
      permissionMode: 'default',
      workingDir: WD,
      chatMessage: {
        clientId: `from-queue-${source}`,
        role: 'user',
        content: `${source} injected`,
        isStreaming: false,
        createdAt: '2026-09-28T00:00:02.000Z',
      },
      createOpts: {
        agentKind: 'claude-code',
        workingDir: WD,
        model: 'claude',
        effort: '',
        permissionMode: 'default',
        userPrompt: `${source} injected`,
      },
    } satisfies AgentInputQueuedMessage);
    // 外部入口把 user 项注入 pendingQueue，回声先于派发投影到达。
    onProjectionCb?.(emptyProjection(s, { pendingQueue: [externalItem] }), OWNER_STAMP);
    expect(makerChatStore.getSnapshot(s).pendingQueue.map((queued) => queued.clientId))
      .toEqual([externalItem.clientId]);
    expect(makerChatStore.isLocalSentUserMessage(s, externalItem.clientId)).toBe(false);

    persistQueued(s, externalItem, '2026-09-28T00:00:03.000Z');
    const echoed = makerChatStore.getSnapshot(s).messages.find(
      (row) => row.clientId === externalItem.clientId,
    );
    expect(echoed?.localSendPrecedingClientIds).toBeUndefined();
    expect(makerChatStore.getSnapshot(s).pendingQueue).toEqual([]);
    // 不被当成本端 user 尾项提前插入：回声不进本地气泡通道，历史视图读到才出现，
    // 不会出现“提前插入/重排、刷新后又纠正”。
    expect(renderedClientIds(s)).toEqual(['old-user', 'old-answer']);
    await getRemoteHistoryView(s)!.refresh();
    expect(renderedClientIds(s)).toEqual(['old-user', 'old-answer', externalItem.clientId]);
    const final = makerChatStore.getSnapshot(s).messages.filter(
      (row) => row.clientId === externalItem.clientId,
    );
    expect(final).toHaveLength(1);
    expect(final[0].localSendPrecedingClientIds).toBeUndefined();
    makerChatStore.purgeSession(s);
  });

  // Codex review P2（第二轮）：session.treeRehydrate 等会把活动路径的历史行重播成
  // messages:created；仍留在 localSentUserMessageIds 的旧 user 行不得被当成新回声
  // 再次预留——否则旧气泡被长期挪到历史尾部，后续刷新读不到这些较老的 id，
  // confirmRemoteUsers 永远撤不掉预留。
  it('历史行重播（treeRehydrate）不再次预留旧的本端发送行', async () => {
    const s = sid();
    await openSession(s);
    await makerChatStore.sendMessage(s, 'old local send', 'claude', '', 'default', WD);
    const item = enqueue.mock.calls[0][1];
    persistQueued(s, item, '2026-09-28T00:00:02.000Z');
    await getRemoteHistoryView(s)!.refresh();
    const findEchoed = () => makerChatStore.getSnapshot(s).messages.find(
      (row) => row.clientId === item.clientId,
    );
    expect(findEchoed()?.localSendPrecedingClientIds).toBeUndefined();
    // 新行把旧 user 行挤出历史视图最新分页（mock 只回最新 20 行）：
    // isAwaitingHistoryView 对它重新为真，具备被误判成新回声的条件。
    for (let i = 0; i < 25; i++) {
      persist(dbMessage(s, `newer-${i}`, 'newer answer',
        `2026-09-28T01:${String(i).padStart(2, '0')}:00.000Z`, 'assistant'));
    }
    await getRemoteHistoryView(s)!.refresh();
    // treeRehydrate 重播旧 user 行的 messages:created（本端发送账本仍盖着它）。
    onCreatedCb?.({
      sessionId: s,
      message: rowsBySession.get(s)!.find((row) => row.clientId === item.clientId),
    }, OWNER_STAMP);
    expect(findEchoed()?.localSendPrecedingClientIds).toBeUndefined();
    makerChatStore.purgeSession(s);
  });
});
