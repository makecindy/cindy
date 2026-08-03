import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/lib/sessionsBus', () => ({
  emitPatch: vi.fn(),
}));

vi.mock('@/lib/userPromptStore', () => ({
  getUserPrompt: () => '',
}));

vi.mock('@/lib/imageRef', () => ({
  parseUserContent: vi.fn((c: string) => ({ text: c, images: [], files: [] })),
  stringifyUserContent: vi.fn((text: string) => text),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import * as messageService from '@/lib/messageService';

const BASE_TIME = new Date('2026-05-20T00:00:00.000Z');

let disposers: Array<() => void> = [];
let sessionIds: string[] = [];

function sid(label: string): string {
  const value = `${label}-${Math.random().toString(36).slice(2, 8)}`;
  sessionIds.push(value);
  return value;
}

function enter(sessionId: string): () => void {
  const dispose = makerChatStore.enterView(sessionId);
  disposers.push(dispose);
  return dispose;
}

function addMessage(sessionId: string): void {
  makerChatStore.insertSystemCard(sessionId, 'status', { label: sessionId });
}

async function flushPromises(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function dbMessage(
  sessionId: string,
  id: string,
  content: string,
  createdAt: string,
  clientId = `client-${id}`,
): Message {
  return {
    id,
    clientId,
    sessionId,
    role: 'assistant',
    content,
    toolUseId: null,
    agentMeta: null,
    createdAt,
  };
}

function dbToolUseMessage(
  sessionId: string,
  id: string,
  toolName: string,
  input: unknown,
  createdAt: string,
): Message {
  const toolUseId = `tool-${id}`;
  return {
    id,
    clientId: `client-${id}`,
    sessionId,
    role: 'tool_use',
    content: { toolName, input, toolUseId },
    toolUseId,
    agentMeta: null,
    createdAt,
  } as unknown as Message;
}

function dbToolResultMessage(
  sessionId: string,
  id: string,
  toolUseId: string,
  content: string,
  createdAt: string,
): Message {
  return {
    id,
    clientId: `client-${id}`,
    sessionId,
    role: 'tool_result',
    content,
    toolUseId,
    agentMeta: null,
    createdAt,
  } as unknown as Message;
}

function thinkingDbMessage(
  sessionId: string,
  id: string,
  text: string,
  createdAt: string,
  durationMs: number,
  opts: { finishedAt?: number } = {},
): Message {
  return {
    id,
    clientId: `client-${id}`,
    sessionId,
    role: 'thinking',
    content: { kind: 'thinking', text, durationMs, isRedacted: false, ...opts },
    toolUseId: null,
    agentMeta: null,
    createdAt,
  };
}

describe('makerChatStore active view tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.mocked(messageService.list).mockReset();
    vi.mocked(messageService.list).mockResolvedValue([]);
    vi.mocked(messageService.around).mockReset();
    vi.mocked(messageService.around).mockResolvedValue([]);
    disposers = [];
    sessionIds = [];
  });

  afterEach(() => {
    for (const dispose of [...disposers].reverse()) dispose();
    for (const sessionId of sessionIds) makerChatStore.purgeSession(sessionId);
    makerChatStore.__teardownGlobalListeners();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('enterView marks a session active and clears lastViewedAt', () => {
    const sessionId = sid('enter');
    const dispose = enter(sessionId);
    dispose();
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 1_000));
    const disposeAgain = enter(sessionId);

    expect(makerChatStore.__activeViewTest.getActiveSessionIds()).toContain(sessionId);
    expect(makerChatStore.__activeViewTest.getLastViewedAt(sessionId)).toBeUndefined();

    disposeAgain();
  });

  it('leaveView removes a session and records lastViewedAt', () => {
    const sessionId = sid('leave');
    const dispose = enter(sessionId);

    vi.setSystemTime(new Date(BASE_TIME.getTime() + 2_000));
    dispose();

    expect(makerChatStore.__activeViewTest.getActiveSessionIds()).not.toContain(sessionId);
    expect(makerChatStore.__activeViewTest.getLastViewedAt(sessionId)).toBe(BASE_TIME.getTime() + 2_000);
  });

  it('keeps two simultaneously mounted Orca panes out of soft eviction', () => {
    const leadId = sid('lead');
    const workerId = sid('worker');
    const disposeLead = enter(leadId);
    const disposeWorker = enter(workerId);
    addMessage(leadId);
    addMessage(workerId);

    vi.advanceTimersByTime(90_000);

    expect(makerChatStore.getSnapshot(leadId).messages).toHaveLength(1);
    expect(makerChatStore.getSnapshot(workerId).messages).toHaveLength(1);

    disposeWorker();
    disposeLead();
  });

  // F3 回归:硬 LRU 回收 (_evictLruIfNeeded,缓存 > MAX_CACHED_SESSIONS 时触发) 必须
  // 跳过仍被 mounted view 看着的 session —— 多窗/分屏副屏钉的 idle 会话不能因为沉到
  // LRU 最旧就被 _purgeSession 删掉(否则活 view 变 blank)。与 demote/trim 对齐。
  it('never hard-evicts an active-view session even when it is the LRU-oldest', () => {
    // keepId 先建 + 落一条消息(此刻在 MRU),随后不再 touch → 被后续创建挤到 LRU 最旧。
    const keepId = sid('keep-active');
    addMessage(keepId);
    enter(keepId); // 标记为 active-view(模拟副窗钉着它)

    // 创建 25 个(> MAX_CACHED_SESSIONS=20)idle 会话,反复强制触发硬回收。
    const otherIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      const id = sid(`idle-${i}`);
      otherIds.push(id);
      addMessage(id);
    }

    // keepId 虽是 LRU 最旧,但 active-view → 不被回收,消息仍在。
    expect(makerChatStore.getSnapshot(keepId).messages).toHaveLength(1);
    // 非空泛验证:回收确实发生了 —— 最早创建的 idle 会话(非 active)已被 purge,
    // 重新 getSnapshot 只会拿到重建的空 slice。
    expect(makerChatStore.getSnapshot(otherIds[0]).messages).toHaveLength(0);
  });

  it('initial history load backfills to the latest plan boundary', async () => {
    const sessionId = sid('initial-plan-backfill');
    const latestPage = Array.from({ length: 50 }, (_, i) =>
      dbMessage(
        sessionId,
        `latest-${String(i).padStart(2, '0')}`,
        `latest message ${i}`,
        new Date(BASE_TIME.getTime() + (60 + i) * 1000).toISOString(),
      ),
    );
    const planRow = dbToolUseMessage(
      sessionId,
      'older-plan',
      'update_plan',
      { plan: [{ step: 'Restore pinned plan', status: 'in_progress' }] },
      new Date(BASE_TIME.getTime() + 30_000).toISOString(),
    );
    vi.mocked(messageService.list)
      .mockResolvedValueOnce(latestPage)
      .mockResolvedValueOnce([planRow]);

    makerChatStore.ensureInitialMessages(sessionId);
    await flushPromises();

    const snapshot = makerChatStore.getSnapshot(sessionId);
    expect(messageService.list).toHaveBeenNthCalledWith(1, sessionId, undefined);
    expect(messageService.list).toHaveBeenNthCalledWith(2, sessionId, {
      limit: 50,
      before: 'latest-00',
    });
    expect(snapshot.messages.some((message) => message.toolName === 'update_plan')).toBe(true);
    expect(snapshot.oldestMessageId).toBe('older-plan');
  });

  it('initial history load treats swallowed plan tool rows as non-anchor rows', async () => {
    const sessionId = sid('initial-plan-non-anchor');
    vi.mocked(messageService.list).mockClear();
    const latestPage = Array.from({ length: 50 }, (_, i) =>
      dbToolUseMessage(
        sessionId,
        `plan-${String(i).padStart(2, '0')}`,
        'update_plan',
        { plan: [{ step: `Plan row ${i}`, status: 'completed' }] },
        new Date(BASE_TIME.getTime() + (60 + i) * 1000).toISOString(),
      ),
    );
    vi.mocked(messageService.list)
      .mockResolvedValueOnce(latestPage)
      .mockResolvedValueOnce([
        dbMessage(sessionId, 'older-visible', 'older visible message', BASE_TIME.toISOString()),
      ]);

    makerChatStore.ensureInitialMessages(sessionId);
    await flushPromises();

    expect(messageService.list).toHaveBeenCalledTimes(2);
    expect(messageService.list).toHaveBeenNthCalledWith(2, sessionId, {
      limit: 50,
      before: 'plan-00',
    });
    expect(makerChatStore.getSnapshot(sessionId).oldestMessageId).toBe('older-visible');
  });

  it('continues initial history backfill until the latest plan boundary is found', async () => {
    const sessionId = sid('initial-plan-backfill-deep');
    vi.mocked(messageService.list).mockClear();
    const page = (prefix: string, startOffsetSeconds: number) =>
      Array.from({ length: 50 }, (_, i) =>
        dbMessage(
          sessionId,
          `${prefix}-${String(i).padStart(2, '0')}`,
          `${prefix} message ${i}`,
          new Date(BASE_TIME.getTime() + (startOffsetSeconds + i) * 1000).toISOString(),
        ),
      );
    vi.mocked(messageService.list)
      .mockResolvedValueOnce(page('latest', 300))
      .mockResolvedValueOnce(page('older-1', 200))
      .mockResolvedValueOnce(page('older-2', 100))
      .mockResolvedValueOnce(page('older-3', 0))
      .mockResolvedValueOnce([
        dbToolUseMessage(
          sessionId,
          'older-plan',
          'update_plan',
          { plan: [{ step: 'Deep plan boundary', status: 'in_progress' }] },
          new Date(BASE_TIME.getTime() - 100_000).toISOString(),
        ),
      ]);

    makerChatStore.ensureInitialMessages(sessionId);
    await flushPromises();

    expect(messageService.list).toHaveBeenCalledTimes(5);
    expect(messageService.list).toHaveBeenNthCalledWith(5, sessionId, {
      limit: 50,
      before: 'older-3-00',
    });
    expect(makerChatStore.getSnapshot(sessionId).oldestMessageId).toBe('older-plan');
  });

  it('caps initial plan discovery backfill for sessions that never used plans', async () => {
    const sessionId = sid('initial-plan-backfill-no-plan');
    vi.mocked(messageService.list).mockClear();
    const page = (prefix: string, startOffsetSeconds: number) =>
      Array.from({ length: 50 }, (_, i) =>
        dbMessage(
          sessionId,
          `${prefix}-${String(i).padStart(2, '0')}`,
          `${prefix} message ${i}`,
          new Date(BASE_TIME.getTime() + (startOffsetSeconds + i) * 1000).toISOString(),
        ),
      );
    vi.mocked(messageService.list)
      .mockResolvedValueOnce(page('latest', 1000));
    for (let i = 0; i < 12; i += 1) {
      vi.mocked(messageService.list).mockResolvedValueOnce(page(`older-${i}`, 900 - i * 100));
    }

    makerChatStore.ensureInitialMessages(sessionId);
    await flushPromises(20);

    expect(messageService.list).toHaveBeenCalledTimes(11);
    expect(makerChatStore.getSnapshot(sessionId).oldestMessageId).toBe('older-9-00');
  });

  it('continues initial plan backfill past older sources until a latest TaskUpdate can be resolved', async () => {
    const sessionId = sid('initial-plan-task-boundary');
    vi.mocked(messageService.list).mockClear();
    const fillerPage = (prefix: string, startOffsetSeconds: number) =>
      Array.from({ length: 49 }, (_, i) =>
        dbMessage(
          sessionId,
          `${prefix}-${String(i).padStart(2, '0')}`,
          `${prefix} message ${i}`,
          new Date(BASE_TIME.getTime() + (startOffsetSeconds + i) * 1000).toISOString(),
        ),
      );
    const latestTaskUpdate = dbToolUseMessage(
      sessionId,
      'latest-task-update',
      'TaskUpdate',
      { taskId: 'abc', status: 'completed' },
      new Date(BASE_TIME.getTime() + 3_000_000).toISOString(),
    );
    const olderTodo = dbToolUseMessage(
      sessionId,
      'older-todo',
      'TodoWrite',
      { todos: [{ content: 'Older source should not stop backfill', status: 'in_progress' }] },
      new Date(BASE_TIME.getTime() + 1_100_000).toISOString(),
    );
    const taskCreate = dbToolUseMessage(
      sessionId,
      'task-create',
      'TaskCreate',
      { subject: 'Collect logs' },
      new Date(BASE_TIME.getTime() - 2_000).toISOString(),
    );
    const taskCreateResult = dbToolResultMessage(
      sessionId,
      'task-create-result',
      'tool-task-create',
      'Task #abc created successfully: Collect logs',
      new Date(BASE_TIME.getTime() - 1_000).toISOString(),
    );

    vi.mocked(messageService.list)
      .mockResolvedValueOnce([...fillerPage('latest', 2000), latestTaskUpdate])
      .mockResolvedValueOnce([...fillerPage('older-1', 1000), olderTodo])
      .mockResolvedValueOnce([taskCreate, taskCreateResult]);

    makerChatStore.ensureInitialMessages(sessionId);
    await flushPromises(10);

    expect(messageService.list).toHaveBeenCalledTimes(3);
    expect(messageService.list).toHaveBeenNthCalledWith(3, sessionId, {
      limit: 50,
      before: 'older-1-00',
    });
    expect(makerChatStore.getSnapshot(sessionId).oldestMessageId).toBe('task-create');
  });

  it('continues plan backfill when the visible TaskCreate may be a later step in the same plan', async () => {
    const sessionId = sid('initial-plan-missing-earlier-create');
    vi.mocked(messageService.list).mockClear();
    const filler = Array.from({ length: 47 }, (_, i) =>
      dbMessage(
        sessionId,
        `latest-${String(i).padStart(2, '0')}`,
        `latest message ${i}`,
        new Date(BASE_TIME.getTime() + (100 + i) * 1000).toISOString(),
      ),
    );
    const laterCreate = dbToolUseMessage(
      sessionId,
      'later-task-create',
      'TaskCreate',
      { subject: 'Fix renderer' },
      new Date(BASE_TIME.getTime() + 200_000).toISOString(),
    );
    const laterResult = dbToolResultMessage(
      sessionId,
      'later-task-result',
      'tool-later-task-create',
      'Task #2 created successfully: Fix renderer',
      new Date(BASE_TIME.getTime() + 201_000).toISOString(),
    );
    const laterUpdate = dbToolUseMessage(
      sessionId,
      'later-task-update',
      'TaskUpdate',
      { taskId: '2', status: 'in_progress' },
      new Date(BASE_TIME.getTime() + 202_000).toISOString(),
    );
    const earlierCreate = dbToolUseMessage(
      sessionId,
      'earlier-task-create',
      'TaskCreate',
      { subject: 'Inspect logs' },
      new Date(BASE_TIME.getTime() - 2_000).toISOString(),
    );
    const earlierResult = dbToolResultMessage(
      sessionId,
      'earlier-task-result',
      'tool-earlier-task-create',
      'Task #1 created successfully: Inspect logs',
      new Date(BASE_TIME.getTime() - 1_000).toISOString(),
    );

    vi.mocked(messageService.list)
      .mockResolvedValueOnce([...filler, laterCreate, laterResult, laterUpdate])
      .mockResolvedValueOnce([earlierCreate, earlierResult]);

    makerChatStore.ensureInitialMessages(sessionId);
    await flushPromises(10);

    expect(messageService.list).toHaveBeenCalledTimes(2);
    expect(messageService.list).toHaveBeenNthCalledWith(2, sessionId, {
      limit: 50,
      before: 'latest-00',
    });
    expect(makerChatStore.getSnapshot(sessionId).oldestMessageId).toBe('earlier-task-create');
  });

  it('continues plan backfill past an unrelated visible task until the updated task is found', async () => {
    const sessionId = sid('initial-plan-unrelated-task');
    vi.mocked(messageService.list).mockClear();
    const fillerPage = (prefix: string, startOffsetSeconds: number, count = 49) =>
      Array.from({ length: count }, (_, i) =>
        dbMessage(
          sessionId,
          `${prefix}-${String(i).padStart(2, '0')}`,
          `${prefix} message ${i}`,
          new Date(BASE_TIME.getTime() + (startOffsetSeconds + i) * 1000).toISOString(),
        ),
      );
    const latestTaskUpdate = dbToolUseMessage(
      sessionId,
      'latest-task-update',
      'TaskUpdate',
      { taskId: 'abc', status: 'completed' },
      new Date(BASE_TIME.getTime() + 3_000_000).toISOString(),
    );
    const unrelatedCreate = dbToolUseMessage(
      sessionId,
      'unrelated-task-create',
      'TaskCreate',
      { subject: 'Fix existing tests' },
      new Date(BASE_TIME.getTime() + 1_100_000).toISOString(),
    );
    const unrelatedResult = dbToolResultMessage(
      sessionId,
      'unrelated-task-result',
      'tool-unrelated-task-create',
      'Task #def created successfully: Fix existing tests',
      new Date(BASE_TIME.getTime() + 1_100_001).toISOString(),
    );
    const targetCreate = dbToolUseMessage(
      sessionId,
      'target-task-create',
      'TaskCreate',
      { subject: 'Run stress tests' },
      new Date(BASE_TIME.getTime() - 4_000).toISOString(),
    );
    const targetResult = dbToolResultMessage(
      sessionId,
      'target-task-result',
      'tool-target-task-create',
      'Task #abc created successfully: Run stress tests',
      new Date(BASE_TIME.getTime() - 3_000).toISOString(),
    );
    const missingOlderUpdate = dbToolUseMessage(
      sessionId,
      'missing-task-update',
      'TaskUpdate',
      { taskId: 'legacy', status: 'completed' },
      new Date(BASE_TIME.getTime() - 2_000).toISOString(),
    );
    const missingOlderCreate = dbToolUseMessage(
      sessionId,
      'missing-task-create',
      'TaskCreate',
      { subject: 'Inspect collision failures' },
      new Date(BASE_TIME.getTime() - 6_000).toISOString(),
    );
    const missingOlderResult = dbToolResultMessage(
      sessionId,
      'missing-task-result',
      'tool-missing-task-create',
      'Task #legacy created successfully: Inspect collision failures',
      new Date(BASE_TIME.getTime() - 5_000).toISOString(),
    );

    vi.mocked(messageService.list)
      .mockResolvedValueOnce([...fillerPage('latest', 2000), latestTaskUpdate])
      .mockResolvedValueOnce([
        ...fillerPage('middle', 1000, 48),
        unrelatedCreate,
        unrelatedResult,
      ])
      .mockResolvedValueOnce([
        ...fillerPage('older-target', 100, 47),
        targetCreate,
        targetResult,
        missingOlderUpdate,
      ])
      .mockResolvedValueOnce([missingOlderCreate, missingOlderResult]);

    makerChatStore.ensureInitialMessages(sessionId);
    await flushPromises(10);

    expect(messageService.list).toHaveBeenCalledTimes(4);
    expect(messageService.list).toHaveBeenNthCalledWith(4, sessionId, {
      limit: 50,
      before: 'target-task-create',
    });
    expect(makerChatStore.getSnapshot(sessionId).oldestMessageId).toBe('missing-task-create');
  });

  it('caps initial plan resolution backfill when a latest TaskUpdate cannot be resolved', async () => {
    const sessionId = sid('initial-plan-task-boundary-missing');
    vi.mocked(messageService.list).mockClear();
    const page = (prefix: string, startOffsetSeconds: number) =>
      Array.from({ length: 50 }, (_, i) =>
        dbMessage(
          sessionId,
          `${prefix}-${String(i).padStart(2, '0')}`,
          `${prefix} message ${i}`,
          new Date(BASE_TIME.getTime() + (startOffsetSeconds + i) * 1000).toISOString(),
        ),
      );
    const latestPage = page('latest', 1000);
    latestPage[49] = dbToolUseMessage(
      sessionId,
      'latest-task-update',
      'TaskUpdate',
      { taskId: 'missing', status: 'completed' },
      new Date(BASE_TIME.getTime() + 2_000_000).toISOString(),
    );
    vi.mocked(messageService.list).mockResolvedValueOnce(latestPage);
    for (let i = 0; i < 12; i += 1) {
      vi.mocked(messageService.list).mockResolvedValueOnce(page(`older-${i}`, 900 - i * 100));
    }

    makerChatStore.ensureInitialMessages(sessionId);
    await flushPromises(20);

    expect(messageService.list).toHaveBeenCalledTimes(11);
    expect(makerChatStore.getSnapshot(sessionId).oldestMessageId).toBe('older-9-00');
  });

  it('enterView disposer leaves the session', () => {
    const sessionId = sid('disposer');
    const dispose = enter(sessionId);

    dispose();

    expect(makerChatStore.__activeViewTest.getActiveSessionIds()).not.toContain(sessionId);
    expect(makerChatStore.__activeViewTest.getLastViewedAt(sessionId)).toBe(BASE_TIME.getTime());
  });

  it('leaveView is a no-op for sessions that were never entered', () => {
    const sessionId = sid('unknown');

    makerChatStore.leaveView(sessionId);

    expect(makerChatStore.__activeViewTest.getActiveSessionIds()).not.toContain(sessionId);
    expect(makerChatStore.__activeViewTest.getLastViewedAt(sessionId)).toBeUndefined();
  });

  it('survives the React StrictMode enter-leave-enter sequence', () => {
    const sessionId = sid('strict');
    const firstDispose = enter(sessionId);
    addMessage(sessionId);
    firstDispose();
    const secondDispose = enter(sessionId);

    vi.advanceTimersByTime(90_000);

    expect(makerChatStore.__activeViewTest.getActiveSessionIds()).toContain(sessionId);
    expect(makerChatStore.__activeViewTest.getLastViewedAt(sessionId)).toBeUndefined();
    expect(makerChatStore.getSnapshot(sessionId).messages).toHaveLength(1);

    secondDispose();
  });

  it('keeps existing history when loading a search result window', async () => {
    const sessionId = sid('search-jump');
    addMessage(sessionId);
    const localMessage = makerChatStore.getSnapshot(sessionId).messages[0];
    vi.mocked(messageService.around).mockResolvedValueOnce([
      dbMessage(sessionId, 'older', 'older search hit', '2026-05-19T00:00:00.000Z'),
      dbMessage(sessionId, 'hit', 'target search hit', '2026-05-19T00:01:00.000Z'),
    ]);

    const target = await makerChatStore.loadAroundMessage(sessionId, 'hit', { radius: 60 });
    const messages = makerChatStore.getSnapshot(sessionId).messages;

    expect(target?.clientId).toBe('client-hit');
    expect(messages.map((message) => message.clientId)).toEqual([
      'client-older',
      'client-hit',
      localMessage.clientId,
    ]);
  });

  it('keeps search result windows in chronological order across jumps', async () => {
    const sessionId = sid('search-jump-order');
    vi.mocked(messageService.around).mockResolvedValueOnce([
      dbMessage(sessionId, 'older', 'older search hit', '2026-05-19T00:00:00.000Z'),
      dbMessage(sessionId, 'first-hit', 'first target search hit', '2026-05-19T00:01:00.000Z'),
    ]);

    await makerChatStore.loadAroundMessage(sessionId, 'first-hit', { radius: 60 });
    expect(makerChatStore.getSnapshot(sessionId).oldestMessageId).toBe('older');

    vi.mocked(messageService.around).mockResolvedValueOnce([
      dbMessage(sessionId, 'later', 'later search context', '2026-05-19T00:05:00.000Z'),
      dbMessage(sessionId, 'second-hit', 'second target search hit', '2026-05-19T00:06:00.000Z'),
    ]);

    const target = await makerChatStore.loadAroundMessage(sessionId, 'second-hit', { radius: 60 });
    const snapshot = makerChatStore.getSnapshot(sessionId);

    expect(target?.clientId).toBe('client-second-hit');
    expect(snapshot.messages.map((message) => message.clientId)).toEqual([
      'client-older',
      'client-first-hit',
      'client-later',
      'client-second-hit',
    ]);
    expect(snapshot.oldestMessageId).toBe('older');
  });

  it('preserves server order for search jump messages with equal timestamps', async () => {
    const sessionId = sid('search-jump-same-time');
    vi.mocked(messageService.around).mockResolvedValueOnce([
      dbMessage(sessionId, '001', 'first same-time message', '2026-05-19T00:00:00.000Z', 'client-z'),
      dbMessage(sessionId, '002', 'target same-time message', '2026-05-19T00:00:00.000Z', 'client-a'),
      dbMessage(sessionId, '003', 'third same-time message', '2026-05-19T00:00:00.000Z', 'client-m'),
    ]);

    const target = await makerChatStore.loadAroundMessage(sessionId, '002', { radius: 60 });
    const snapshot = makerChatStore.getSnapshot(sessionId);

    expect(target?.clientId).toBe('client-a');
    expect(snapshot.messages.map((message) => message.clientId)).toEqual([
      'client-z',
      'client-a',
      'client-m',
    ]);
  });

  // 首拉未回来就深跳 → 只能用 around 孤岛下沿播种游标(那时窗口里只有孤岛)。首拉的最新页
  // 落地后,游标必须**交还给最新页的下沿**:缺失区间比孤岛更新,继续保留更老的孤岛游标会让
  // 普通翻页与孤岛感知补齐都只请求"比孤岛更老"的行,那段洞永远拉不回来(#676 review codex P1)。
  // 本用例原来断言的是"保留孤岛游标",那是修复前的行为;新断言同时守住播种(跳转当时)与
  // 交还(最新页落地后)两个阶段。
  it('hands the cursor back to the latest page when initial history resolves after a jump', async () => {
    const sessionId = sid('search-jump-initial-race');
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          input: {
            getProjection: vi.fn(async () => ({
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
            })),
          },
        },
      },
    });
    let resolveInitialList!: (messages: Message[]) => void;
    const initialListPromise = new Promise<Message[]>((resolve) => {
      resolveInitialList = resolve;
    });
    vi.mocked(messageService.list).mockReturnValueOnce(initialListPromise);
    vi.mocked(messageService.around).mockResolvedValueOnce([
      dbMessage(sessionId, 'older-hit-context', 'older context', '2026-05-19T00:00:00.000Z'),
      dbMessage(sessionId, 'hit', 'target search hit', '2026-05-19T00:01:00.000Z'),
    ]);

    makerChatStore.ensureInitialMessages(sessionId);
    await makerChatStore.loadAroundMessage(sessionId, 'hit', { radius: 60 });
    // 阶段一:窗口里只有孤岛 → 必须播种,游标为 null 会让下一次翻页从最新重开、把跳转位置顶掉。
    expect(makerChatStore.getSnapshot(sessionId).oldestMessageId).toBe('older-hit-context');
    expect(makerChatStore.getSnapshot(sessionId).historyWindowHasIsland).toBe(true);
    expect(makerChatStore.getLightSnapshot(sessionId).historyWindowHasIsland).toBe(true);

    resolveInitialList([
      dbMessage(sessionId, 'latest-page-oldest', 'latest page oldest', '2026-05-19T00:10:00.000Z'),
      dbMessage(sessionId, 'latest-page-newest', 'latest page newest', '2026-05-19T00:11:00.000Z'),
    ]);
    await initialListPromise;
    await Promise.resolve();
    await Promise.resolve();

    const snapshot = makerChatStore.getSnapshot(sessionId);
    expect(snapshot.messages.map((message) => message.clientId)).toEqual([
      'client-older-hit-context',
      'client-hit',
      'client-latest-page-oldest',
      'client-latest-page-newest',
    ]);
    // 阶段二:最新页落地 → 游标交还给它的下沿,往上翻才会穿过孤岛与尾段之间的缺失区间。
    expect(snapshot.oldestMessageId).toBe('latest-page-oldest');
    // 洞还在,孤岛标记不清 —— 下一次跳转仍会尝试补齐。
    expect(snapshot.historyWindowHasIsland).toBe(true);
  });

  it('keeps loadOlder history chronological after thinking timestamps are backdated', async () => {
    const sessionId = sid('older-thinking-order');
    const finishedAt = Date.parse('2026-05-19T00:10:00.000Z');
    vi.mocked(messageService.around).mockResolvedValueOnce([
      thinkingDbMessage(
        sessionId,
        'thinking',
        'thinking across page boundary',
        '2026-05-19T00:15:00.000Z',
        5 * 60 * 1000,
        { finishedAt },
      ),
      dbMessage(sessionId, 'current', 'current page message', '2026-05-19T00:11:00.000Z'),
    ]);

    await makerChatStore.loadAroundMessage(sessionId, 'current', { radius: 60 });
    expect(makerChatStore.getSnapshot(sessionId).messages.map((message) => message.clientId)).toEqual([
      'client-thinking',
      'client-current',
    ]);
    expect(makerChatStore.getSnapshot(sessionId).messages[0].createdAt).toBe('2026-05-19T00:05:00.000Z');

    vi.mocked(messageService.list).mockResolvedValueOnce([
      dbMessage(sessionId, 'older-db-row', 'older DB row, later display time', '2026-05-19T00:08:00.000Z'),
    ]);

    makerChatStore.loadOlderMessages(sessionId);
    await Promise.resolve();
    await Promise.resolve();

    const snapshot = makerChatStore.getSnapshot(sessionId);
    expect(snapshot.messages.map((message) => message.clientId)).toEqual([
      'client-thinking',
      'client-older-db-row',
      'client-current',
    ]);
    expect(snapshot.oldestMessageId).toBe('older-db-row');
    expect(snapshot.hasMoreMessages).toBe(false);
  });

  // 向上翻页追页回归(2026-07 用户反馈"加载不动"):单页 50 行可能整页都是同一
  // turn 的工作过程(渲染层折叠后可见高度零增长),loadOlderMessages 需带着
  // spinner 连续追页,直到页里出现 user 行(可见锚点)或翻完;半程失败要提交
  // 已拉到的页并保持 hasMoreMessages 可重试。
  describe('loadOlderMessages visible-anchor backfill paging', () => {
    /** 生成一整页 50 行(newest-first),行号 newestIdx..newestIdx-49。 */
    function fullPage(
      sessionId: string,
      newestIdx: number,
      opts: { userAtIdx?: number } = {},
    ): Message[] {
      const rows: Message[] = [];
      for (let i = 0; i < 50; i++) {
        const idx = newestIdx - i;
        const iso = new Date(Date.parse('2026-05-01T00:00:00.000Z') + idx * 1000).toISOString();
        const base = dbMessage(sessionId, `row-${idx}`, `row ${idx}`, iso);
        rows.push(opts.userAtIdx === idx ? { ...base, role: 'user' } : base);
      }
      return rows;
    }

    /** 追页循环全靠 microtask 链推进,多 flush 几轮保证 10 页内的链条都跑完。 */
    async function flushPagingLoop(): Promise<void> {
      for (let i = 0; i < 100; i++) await Promise.resolve();
    }

    /** 用 loadAroundMessage 播种 oldestMessageId=current + hasMoreMessages=true。 */
    async function seedSession(sessionId: string): Promise<void> {
      vi.mocked(messageService.around).mockResolvedValueOnce([
        dbMessage(sessionId, 'current', 'current message', '2026-05-19T00:00:00.000Z'),
      ]);
      await makerChatStore.loadAroundMessage(sessionId, 'current', { radius: 60 });
      vi.mocked(messageService.list).mockClear();
    }

    it('keeps paging past user-less full pages and stops at the first page with a user row', async () => {
      const sessionId = sid('older-backfill-stop-at-user');
      await seedSession(sessionId);

      // 第 1 页整页无 user 行(模拟长 turn 中段工作过程)→ 继续追;
      // 第 2 页含 user 行(turn 边界,可见锚点)→ 停,即使整页 50 行 hasMore=true。
      vi.mocked(messageService.list)
        .mockResolvedValueOnce(fullPage(sessionId, 999))
        .mockResolvedValueOnce(fullPage(sessionId, 949, { userAtIdx: 920 }));

      makerChatStore.loadOlderMessages(sessionId);
      await flushPagingLoop();

      expect(vi.mocked(messageService.list).mock.calls.map((call) => call[1])).toEqual([
        { limit: 50, before: 'current' },
        { limit: 50, before: 'row-950' },
      ]);
      const snapshot = makerChatStore.getSnapshot(sessionId);
      expect(snapshot.isLoadingMore).toBe(false);
      expect(snapshot.hasMoreMessages).toBe(true);
      expect(snapshot.oldestMessageId).toBe('row-900');
      expect(snapshot.messages).toHaveLength(101); // current + 两页各 50
      expect(snapshot.messages[0].clientId).toBe('client-row-900');
      expect(snapshot.messages.at(-1)?.clientId).toBe('client-current');
      expect(snapshot.messages.some((m) => m.clientId === 'client-row-920' && m.role === 'user')).toBe(true);
    });

    it('stops at MAX pages without a user row and still commits collected rows', async () => {
      const sessionId = sid('older-backfill-page-cap');
      await seedSession(sessionId);

      // 10 页全是无 user 行的整页(游标停在同一批行也没关系,循环靠页数上限收口)。
      for (let i = 0; i < 10; i++) {
        vi.mocked(messageService.list).mockResolvedValueOnce(fullPage(sessionId, 999));
      }

      makerChatStore.loadOlderMessages(sessionId);
      await flushPagingLoop();

      expect(vi.mocked(messageService.list)).toHaveBeenCalledTimes(10);
      const snapshot = makerChatStore.getSnapshot(sessionId);
      expect(snapshot.isLoadingMore).toBe(false);
      expect(snapshot.hasMoreMessages).toBe(true); // 没翻完,下次手势继续
      expect(snapshot.oldestMessageId).toBe('row-950');
      expect(snapshot.messages).toHaveLength(51); // current + 去重后的 50 行
    });

    it('commits already-fetched pages when a later page fetch fails', async () => {
      const sessionId = sid('older-backfill-partial-failure');
      await seedSession(sessionId);

      vi.mocked(messageService.list)
        .mockResolvedValueOnce(fullPage(sessionId, 999))
        .mockRejectedValueOnce(new Error('tunnel dropped'));

      makerChatStore.loadOlderMessages(sessionId);
      await flushPagingLoop();

      const snapshot = makerChatStore.getSnapshot(sessionId);
      expect(snapshot.isLoadingMore).toBe(false);
      // 第 1 页已进 UI(游标推进、内容不丢),失败只终止追页,保持可重试。
      expect(snapshot.hasMoreMessages).toBe(true);
      expect(snapshot.oldestMessageId).toBe('row-950');
      expect(snapshot.messages).toHaveLength(51);
      expect(snapshot.messages[0].clientId).toBe('client-row-950');
    });

    it('keeps hasMoreMessages retryable when the first page fetch fails', async () => {
      const sessionId = sid('older-backfill-first-failure');
      await seedSession(sessionId);

      vi.mocked(messageService.list).mockRejectedValueOnce(new Error('tunnel dropped'));

      makerChatStore.loadOlderMessages(sessionId);
      await flushPagingLoop();

      const snapshot = makerChatStore.getSnapshot(sessionId);
      expect(snapshot.isLoadingMore).toBe(false);
      expect(snapshot.hasMoreMessages).toBe(true);
      expect(snapshot.oldestMessageId).toBe('current');
    });

    // rewind 竞态守卫:追页 in-flight 期间 reloadMessages(rewind commit 后的强制
    // 重载)把切片清空重置,晚到的翻页窗口必须整体作废——merge 回去会让服务端
    // 已软删的行复活。守卫走 _messagesEpoch 代际比对。
    it('discards an in-flight paging window when the session is reloaded mid-flight', async () => {
      const sessionId = sid('older-backfill-reload-race');
      // reloadMessages → ensureInitialMessages → reconcilePendingInteractions 需要
      // window.electronAPI(与"preserves the search jump cursor"测试同款 stub)。
      vi.stubGlobal('window', {
        electronAPI: {
          maker: {
            input: {
              getProjection: vi.fn(async () => ({
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
              })),
            },
          },
        },
      });
      await seedSession(sessionId);

      let resolveOlderPage!: (rows: Message[]) => void;
      const olderPagePromise = new Promise<Message[]>((resolve) => {
        resolveOlderPage = resolve;
      });
      vi.mocked(messageService.list)
        .mockReturnValueOnce(olderPagePromise) // loadOlderMessages 第 1 页(挂起中)
        .mockResolvedValueOnce([]); // reloadMessages → ensureInitialMessages(重载后空历史)

      makerChatStore.loadOlderMessages(sessionId);
      expect(makerChatStore.getSnapshot(sessionId).isLoadingMore).toBe(true);

      makerChatStore.reloadMessages(sessionId);
      await Promise.resolve();

      // 翻页此刻才返回(短页 → 循环立即收口进入提交),但代际已变 → 作废。
      resolveOlderPage(fullPage(sessionId, 999).slice(0, 10));
      await flushPagingLoop();

      const snapshot = makerChatStore.getSnapshot(sessionId);
      expect(snapshot.isLoadingMore).toBe(false);
      expect(snapshot.messages).toHaveLength(0); // 旧窗口没有被 merge 回清空后的切片
      expect(snapshot.oldestMessageId).toBeNull();
      expect(snapshot.hasMoreMessages).toBe(false);
    });

    it('keeps legacy single-row removal compatible with an in-flight paging window', async () => {
      const sessionId = sid('older-backfill-single-delete-compat');
      await seedSession(sessionId);

      let resolveOlderPage!: (rows: Message[]) => void;
      vi.mocked(messageService.list).mockReturnValueOnce(
        new Promise<Message[]>((resolve) => {
          resolveOlderPage = resolve;
        }),
      );

      makerChatStore.loadOlderMessages(sessionId);
      makerChatStore.removeMessageByClientId(sessionId, 'client-current');
      resolveOlderPage(fullPage(sessionId, 999).slice(0, 10));
      await flushPagingLoop();

      const snapshot = makerChatStore.getSnapshot(sessionId);
      expect(snapshot.messages).toHaveLength(10);
      expect(snapshot.messages.some((message) => message.clientId === 'client-current')).toBe(false);
      expect(snapshot.isLoadingMore).toBe(false);
    });

    it('discards an in-flight paging window after grouped deletion', async () => {
      const sessionId = sid('older-backfill-group-delete-race');
      await seedSession(sessionId);

      let resolveOlderPage!: (rows: Message[]) => void;
      vi.mocked(messageService.list).mockReturnValueOnce(
        new Promise<Message[]>((resolve) => {
          resolveOlderPage = resolve;
        }),
      );

      makerChatStore.loadOlderMessages(sessionId);
      makerChatStore.removeMessagesByClientIds(sessionId, ['client-current']);
      resolveOlderPage(fullPage(sessionId, 999).slice(0, 10));
      await flushPagingLoop();

      const snapshot = makerChatStore.getSnapshot(sessionId);
      expect(snapshot.messages).toHaveLength(0);
      expect(snapshot.isLoadingMore).toBe(false);
    });
  });

  // 反向验证：Set 版没破坏原 522b2b31 的 demote 触发条件——session leave 后超过
  // DEMOTE_IDLE_MS 应被清空 messages（释放内存）。
  it('demotes a session after it has been left for longer than DEMOTE_IDLE_MS', () => {
    const sessionId = sid('demote');
    const dispose = enter(sessionId);
    addMessage(sessionId);
    expect(makerChatStore.getSnapshot(sessionId).messages).toHaveLength(1);

    dispose(); // 写 lastViewedAt = BASE_TIME
    // 推进 90s（>60s DEMOTE_IDLE_MS）让 demote timer 至少跑一次（间隔 30s）。
    vi.advanceTimersByTime(90_000);

    expect(makerChatStore.getSnapshot(sessionId).messages).toHaveLength(0);
    expect(makerChatStore.getSnapshot(sessionId).historyLoaded).toBe(false);
  });
});
