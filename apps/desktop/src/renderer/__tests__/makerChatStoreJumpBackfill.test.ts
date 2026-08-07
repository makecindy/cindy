/**
 * makerChatStoreJumpBackfill.test.ts
 * ---------------------------------------------------------------------------
 * 回归:跳转到历史消息后,窗口必须是"某点 → 最新"的连续区间,不留历史空洞。
 *
 * 旧行为:loadAroundMessage / loadAroundMessageClientId 只把目标附近的 around 窗口
 * mergeMessages 进当前 messages。它与已加载的尾部窗口之间隔着大段没加载的历史,
 * 中间那些 user 行——渲染层唯一的 turn 边界——全部缺席,于是 groupWorkRuns 把跨空洞
 * 的动作折成同一个「已工作 Xs」。实测会话 749cc942:DB 里 1936 条一条没少,UI 上却
 * 只剩一行「已工作 2820m 29s」(吞掉 47 小时、40 条 user 消息),用户看到的就是
 * "中间掉了很多条消息"。
 *
 * 现行为:跳转前先用 before 游标从最新连续向上翻页补齐到目标(backfillHistoryUntil),
 * 补齐后窗口连续、向下滚也能回到最新;补不到才退回 around 窗口(渲染层的
 * HISTORY_GAP_SPLIT_MS 守卫兜底)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/makerTransport', () => ({
  getSessionFor: vi.fn(async () => ({
    agentKind: 'cc',
    remoteHostId: null,
    sdkSessionId: null,
    contextTokens: 0,
    contextWindow: 0,
    totalCostUsd: 0,
  })),
  listMessagesFor: vi.fn(async () => []),
  aroundMessagesByClientIdFor: vi.fn(async () => []),
  makerApiFor: vi.fn(() => ({
    input: {
      getProjection: vi.fn(async () => Promise.reject(new Error('n/a in test'))),
      clearSession: vi.fn(async () => ({ text: '', images: [], files: [] })),
    },
    closeSession: vi.fn(async () => {}),
  })),
  isRemoteSession: vi.fn(() => false),
}));

// /clear 的落库与 sidebar 广播副作用(用例 X 会走到):只需要不炸,断言看的是渲染层 state。
// sessionsBus 真身走 window.dispatchEvent,Node 环境下会往 stderr 抛一串已被 catch 的报错。
vi.mock('@/lib/sessionService', () => ({
  update: vi.fn(async () => {}),
  get: vi.fn(async () => null),
}));

vi.mock('@/lib/sessionsBus', () => ({
  emitRefresh: vi.fn(),
  emitPatch: vi.fn(),
  onRefresh: vi.fn(() => () => {}),
  onPatch: vi.fn(() => () => {}),
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
  setRemoteOptimisticAttachmentUrls: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import { aroundMessagesByClientIdFor, listMessagesFor } from '@/lib/makerTransport';
import type { Message } from '@/lib/ccAgent.types';

const SID = 'sess-jump-backfill';

/** 捕获 local-db:messages:created 的监听器,用来在测试里模拟 live push。 */
let messageCreatedListener: ((raw: unknown) => void) | undefined;

function makeElectronApiStub() {
  const fanOut = () => () => () => {};
  return {
    maker: {
      onEvent: fanOut(),
      onStatusChanged: fanOut(),
      onInputProjection: fanOut(),
      onInteractionRequest: fanOut(),
      onInteractionDismissed: fanOut(),
      input: {
        getProjection: vi.fn(async () => Promise.reject(new Error('n/a in test'))),
      },
    },
    localDb: {
      messages: {
        onCreated: (cb: (raw: unknown) => void) => {
          messageCreatedListener = cb;
          return () => {
            messageCreatedListener = undefined;
          };
        },
      },
    },
    onUsageMessageTurnCost: fanOut(),
  };
}

function serverMessage(over: Partial<Message>): Message {
  return {
    id: over.id ?? over.clientId ?? 'id',
    clientId: over.clientId ?? 'client',
    sessionId: over.sessionId ?? SID,
    role: over.role ?? 'user',
    content: over.content ?? 'hello',
    toolUseId: null,
    agentMeta: null,
    createdAt: over.createdAt ?? '2026-07-25T00:00:00.000Z',
    ...over,
  } as Message;
}

function planToolMessage(over: Partial<Message>): Message {
  const toolUseId = over.toolUseId ?? over.id ?? over.clientId ?? 'plan-tool';
  return serverMessage({
    role: 'tool_use',
    content: {
      toolName: 'update_plan',
      toolUseId,
      input: {
        plan: [{ content: 'Preserve current plan after trim', status: 'in_progress' }],
      },
    },
    toolUseId,
    ...over,
  } as Partial<Message>);
}

/** 让挂起的 store 异步链推进若干轮微任务(store 内部多层 await)。 */
async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** 一整页(100 行 = messages:list 的 MAX_LIMIT)较新的历史,newest-first。 */
function fullPageNewestFirst(): Message[] {
  return Array.from({ length: 100 }, (_, i) =>
    serverMessage({
      id: `mid-${i}`,
      clientId: `mid-${i}`,
      // 越靠前越新:2026-07-25T12:00:00 往前推分钟。
      createdAt: new Date(Date.UTC(2026, 6, 25, 12, 0, 0) - i * 60_000).toISOString(),
    }),
  );
}

describe('跳转补齐 — 窗口连续,不留历史空洞', () => {
  beforeEach(() => {
    vi.mocked(listMessagesFor).mockReset();
    vi.mocked(listMessagesFor).mockResolvedValue([]);
    vi.mocked(aroundMessagesByClientIdFor).mockReset();
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValue([]);
    (globalThis as { window?: unknown }).window = { electronAPI: makeElectronApiStub() };
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.purgeSession(SID);
    makerChatStore.__teardownGlobalListeners();
    delete (globalThis as { window?: unknown }).window;
    vi.clearAllMocks();
  });

  it('A. 跳转到更早的消息时连续向上翻页,中间历史全部进入窗口', async () => {
    const target = serverMessage({
      id: 'old-target',
      clientId: 'old-target',
      createdAt: '2026-07-23T16:28:30.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    // 第 1 页:最新 100 条(满页 → 还有更多);第 2 页:命中目标。
    vi.mocked(listMessagesFor)
      .mockResolvedValueOnce(fullPageNewestFirst())
      .mockResolvedValueOnce([target]);

    const result = await makerChatStore.loadAroundMessageClientId(SID, 'old-target', {
      radius: 60,
    });

    expect(result?.clientId).toBe('old-target');

    const ids = makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId);
    // 目标 + 中间 100 条都在窗口里 —— 修复前中间这 100 条是缺席的。
    expect(ids).toContain('old-target');
    expect(ids).toContain('mid-0');
    expect(ids).toContain('mid-99');
    expect(ids).toHaveLength(101);
    // 连续区间:目标最老,排在最前。
    expect(ids[0]).toBe('old-target');

    // 第二页必须带 before 游标(从最老处继续向上翻)。
    expect(vi.mocked(listMessagesFor).mock.calls).toHaveLength(2);
    const secondCallOpts = vi.mocked(listMessagesFor).mock.calls[1][1] as { before?: string };
    expect(secondCallOpts.before).toBeTruthy();
  });

  it('B. 目标已在窗口里时不额外翻页', async () => {
    const target = serverMessage({
      id: 'already',
      clientId: 'already',
      createdAt: '2026-07-25T11:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValue([target]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce([target]);

    // 首次跳转:窗口为空 → 翻 1 页拿到目标。
    await makerChatStore.loadAroundMessageClientId(SID, 'already', { radius: 60 });
    expect(vi.mocked(listMessagesFor).mock.calls).toHaveLength(1);

    // 再次跳转同一条:已在窗口里,不应再翻页。
    await makerChatStore.loadAroundMessageClientId(SID, 'already', { radius: 60 });
    expect(vi.mocked(listMessagesFor).mock.calls).toHaveLength(1);
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).toEqual(['already']);
  });

  it('D. 补齐期间切片被 clear/rewind 重置时,跳转整体作废,不把 around 行 merge 回来', async () => {
    // review #676（codex P1）：epoch 变化后若仍执行 fallback merge，会把刚被移除的
    // 消息重新塞回窗口。补齐必须与「补不到」区分开，返回取消语义。
    const target = serverMessage({
      id: 'gone',
      clientId: 'gone',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    // 第一页返回满页（本会继续翻），但这次响应落地时切片已被 purge（bump epoch），
    // 等价于 /clear、rewind、purge 在补齐 await 期间发生。
    vi.mocked(listMessagesFor).mockImplementationOnce(async () => {
      const page = fullPageNewestFirst();
      makerChatStore.purgeSession(SID);
      return page;
    });

    const result = await makerChatStore.loadAroundMessageClientId(SID, 'gone', { radius: 60 });

    // 跳转作废：不返回目标，也不能把 around 行 merge 进窗口。
    expect(result).toBeNull();
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).not.toContain('gone');
    // spinner 仍要复位，否则行首守卫会让该会话永久无法再翻页。
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);
  });

  it('E. 已有向上分页在飞行中时让位,不并发抢同一个游标', async () => {
    // review #676（greptile P1）：两个流程并发读写 oldestMessageId，响应乱序会让
    // 游标回退、重复拉页并耗尽上限。让位后退回 around 窗口（渲染层守卫兜底）。
    const seeded = fullPageNewestFirst();
    const inWindow = seeded[50];

    // 第 1 步：一次正常跳转把窗口建立起来（满页 → hasMoreMessages=true，
    // oldestMessageId 已就位），这样 loadOlderMessages 才能通过行首守卫。
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([inWindow]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce(seeded);
    await makerChatStore.loadAroundMessageClientId(SID, inWindow.clientId, { radius: 60 });
    expect(makerChatStore.getSnapshot(SID).hasMoreMessages).toBe(true);
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);

    // 第 2 步：让向上分页进入飞行并挂住，占住 isLoadingMore 这把锁。
    let releasePage: (rows: Message[]) => void = () => {};
    vi.mocked(listMessagesFor).mockImplementationOnce(
      () =>
        new Promise<Message[]>((resolve) => {
          releasePage = resolve;
        }),
    );
    makerChatStore.loadOlderMessages(SID);
    await flushMicrotasks();
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(true);

    // 第 3 步：此时跳转到窗口外的更早消息 —— 必须让位，不得再翻页抢游标。
    const older = serverMessage({
      id: 'older-target',
      clientId: 'older-target',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([older]);
    const callsBefore = vi.mocked(listMessagesFor).mock.calls.length;
    const result = await makerChatStore.loadAroundMessageClientId(SID, 'older-target', {
      radius: 60,
    });

    // 没有额外翻页（没抢游标），但跳转仍走 around 窗口成功定位。
    expect(vi.mocked(listMessagesFor).mock.calls).toHaveLength(callsBefore);
    expect(result?.clientId).toBe('older-target');

    // 收尾：放开挂住的分页，避免 pending promise 拖到后续用例。
    releasePage([]);
    await flushMicrotasks();
  });

  it('C. 翻完历史仍没命中时退回 around 窗口,跳转不失败,且仍允许继续向上翻页', async () => {
    const target = serverMessage({
      id: 'orphan',
      clientId: 'orphan',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    // 非满页 → hasMore=false,翻完仍没有 target。
    vi.mocked(listMessagesFor).mockResolvedValueOnce([
      serverMessage({ id: 'tail', clientId: 'tail', createdAt: '2026-07-25T12:00:00.000Z' }),
    ]);

    const result = await makerChatStore.loadAroundMessageClientId(SID, 'orphan', { radius: 60 });

    // 退回 around 窗口:目标仍然可定位,调用方的滚动定位不受影响。
    expect(result?.clientId).toBe('orphan');
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).toContain('orphan');
    // spinner 必须复位,否则行首守卫会让该会话永久无法再翻页。
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);
    // review #676（copilot 建议在 fallback 保留 false）——核实后不采纳：fallback 刚
    // merge 进来的 around 行比旧游标更早，窗口最老边界前移，「从旧游标往上没有更多」
    // 对新边界不成立；锁成 false 会让这段历史再也翻不动。
    expect(makerChatStore.getSnapshot(SID).hasMoreMessages).toBe(true);
  });

  it('H. covered 时游标推进到 around 窗口更早的边界', async () => {
    // review #676（codex）：目标落在命中页靠旧的一侧时，radius 决定的 around 窗口会
    // 含比该页 oldestMessageId 更早的行。只 merge 不推进游标，下一次向上翻页就会从
    // 已加载区间重新拉，连翻几次都看不到新内容。
    const page = fullPageNewestFirst();
    const target = page[page.length - 1]; // 该页最老的一行
    // around 窗口除目标外，还带回一条更早的行（radius 往旧侧多取的部分）。
    const olderNeighbour = serverMessage({
      id: 'older-neighbour',
      clientId: 'older-neighbour',
      createdAt: '2026-07-25T09:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([olderNeighbour, target]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce(page);

    await makerChatStore.loadAroundMessageClientId(SID, target.clientId, { radius: 60 });

    // 游标必须指向 around 带回的那条更早的行，而不是命中页的最老行。
    expect(makerChatStore.getSnapshot(SID).oldestMessageId).toBe('older-neighbour');
  });

  it('I. edit-last 本地截断也作废 in-flight 补齐(dropMessagesFromClientId bump epoch)', async () => {
    // review #676（codex）：editLastUserMessage 走 dropMessagesFromClientId 做本地软删，
    // 该路径原先不 bump epoch，于是 pre-rewind 的分页响应会被当成有效结果，把刚被
    // 软删的行 merge 回渲染层。
    const target = serverMessage({
      id: 'rewound',
      clientId: 'rewound',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    vi.mocked(listMessagesFor).mockImplementationOnce(async () => {
      const page = fullPageNewestFirst();
      // 补齐 await 期间发生 edit-last 截断。
      makerChatStore.dropMessagesFromClientId(SID, page[page.length - 1].clientId);
      return page;
    });

    const result = await makerChatStore.loadAroundMessageClientId(SID, 'rewound', { radius: 60 });

    // 跳转整体作废：不返回目标，也不把 around 行 merge 回窗口。
    expect(result).toBeNull();
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).not.toContain('rewound');
  });

  it('J. 纯文本会话在预算内停手,不会无限翻到几千行', async () => {
    // review #676（codex）：早期预算是 2000 行 + 「render item ≈ 行数 / 5」的折算假设，
    // 而纯文本对话每条 user/assistant 各自就是一个 render item（接近 1:1），2000 行就是
    // 2000 个 item，照样冻结渲染。
    // 折算模型后来整个放弃了（口径见 JUMP_BACKFILL_MAX_ITEMS 注释）：现在按**行数**当
    // render item 数的保守上界、封顶 600 —— 折算必须逐一追平 buildRenderItems 的每种 item
    // 展开规则，review 中已发现 5 种被低估的路径，是条追不完的线。所以本用例现在守的是
    // 「纯文本页也会在预算内停手」这个更简单的口径。
    const target = serverMessage({
      id: 'way-back',
      clientId: 'way-back',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    // 每页 100 条纯文本（满页 → 一直有更多），永远命不中目标。
    let page = 0;
    vi.mocked(listMessagesFor).mockImplementation(async () => {
      const base = page++;
      return Array.from({ length: 100 }, (_, i) =>
        serverMessage({
          id: `txt-${base}-${i}`,
          clientId: `txt-${base}-${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          createdAt: new Date(
            Date.UTC(2026, 6, 25, 12, 0, 0) - (base * 100 + i) * 60_000,
          ).toISOString(),
        }),
      );
    });

    await makerChatStore.loadAroundMessageClientId(SID, 'way-back', { radius: 60 });

    // 600 个 item 预算 ÷ 每页 100 个 item ≈ 6 页就该停，远小于按行数算的 20 页。
    const calls = vi.mocked(listMessagesFor).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(7);
  });

  it('J2. 预算是硬上限:最后一页把 limit 夹到剩余额度,窗口不会被顶出上限', async () => {
    // review #676(copilot):循环条件只判"还没到上限",而每页最多带回 PAGE_SIZE 行,于是
    // 最后一次请求可以把窗口顶出上限近一整页 —— 上限就不是上限了。
    //
    // 用"首页不满页但仍有更多"制造错位(device-link 帧裁剪的真实形状:整页被压成几十行,
    // 靠 remoteRowsTrimmed 表示"还有"),这样预算边界就落在页中间而不是刚好对齐。
    const target = serverMessage({
      id: 'never-reached',
      clientId: 'never-reached',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    let page = 0;
    const requestedLimits: number[] = [];
    vi.mocked(listMessagesFor).mockImplementation(async (_sid, opts) => {
      const limit = (opts as { limit: number }).limit;
      requestedLimits.push(limit);
      const base = page++;
      // 首页只回 55 行并带 remoteRowsTrimmed(不满页也还有更多),之后按请求的 limit 回满页。
      const trimmed = base === 0;
      const count = trimmed ? Math.min(55, limit) : limit;
      return Array.from({ length: count }, (_, i) =>
        serverMessage({
          id: `cap-${base}-${i}`,
          clientId: `cap-${base}-${i}`,
          createdAt: new Date(
            Date.UTC(2026, 6, 25, 12, 0, 0) - (base * 100 + i) * 60_000,
          ).toISOString(),
          ...(trimmed && i === 0 ? { agentMeta: { remoteRowsTrimmed: true } } : {}),
        }),
      );
    });

    await makerChatStore.loadAroundMessageClientId(SID, 'never-reached', { radius: 60 });

    // 关键:窗口不得超过预算(around 那一行是 fallback merge 的,单独计)。
    expect(makerChatStore.getSnapshot(SID).messages.length).toBeLessThanOrEqual(600 + 1);
    // 收尾那一页的 limit 被夹小,不再是整页。
    expect(requestedLimits.at(-1)).toBeLessThan(100);
  });

  it('K. Agent/Task 类调用按 1:1 计入 item 预算,不按普通工具的 4:1 折算', async () => {
    // review #676（codex）：buildRenderItems 给每个 Agent/Task/Workflow tool_use 出一张
    // 独立 agent_task 卡（1:1）。按普通工具 4:1 折算会让预算放进约 4 倍的实际渲染量，
    // 尤其历史里大量是被中断、没有 result 的单行 Task 调用时。
    const target = serverMessage({
      id: 'far-away',
      clientId: 'far-away',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    let page = 0;
    vi.mocked(listMessagesFor).mockImplementation(async () => {
      const base = page++;
      // 每页 100 条「无 result 的 Task 调用」——每条都是一张独立卡。
      return Array.from({ length: 100 }, (_, i) =>
        serverMessage({
          id: `task-${base}-${i}`,
          clientId: `task-${base}-${i}`,
          role: 'tool_use',
          content: JSON.stringify({ toolName: 'Task', input: { description: '子任务' } }),
          createdAt: new Date(
            Date.UTC(2026, 6, 25, 12, 0, 0) - (base * 100 + i) * 60_000,
          ).toISOString(),
        }),
      );
    });

    await makerChatStore.loadAroundMessageClientId(SID, 'far-away', { radius: 60 });

    // 100 张卡/页、600 个 item 预算 → 约 6 页停手；按 4:1 折算会翻到 24 页。
    const calls = vi.mocked(listMessagesFor).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(7);
  });

  it('L. 补齐请求 reject 且切片已被重置时,跳转作废而不是当成可重试失败', async () => {
    // review #676（codex）：catch 分支原样返回 unavailable，绕过了 epoch 检查。典型场景是
    // 远程会话在 /clear 期间断链导致 listMessagesFor 抛错——调用方会照常 merge 陈旧的
    // around 行，把重置刚移除的消息复活；purge 后还会把已删的切片重新 materialize。
    const target = serverMessage({
      id: 'stale-on-error',
      clientId: 'stale-on-error',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    vi.mocked(listMessagesFor).mockImplementationOnce(async () => {
      makerChatStore.purgeSession(SID);
      throw new Error('[REMOTE] relay down');
    });

    const result = await makerChatStore.loadAroundMessageClientId(SID, 'stale-on-error', {
      radius: 60,
    });

    expect(result).toBeNull();
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).not.toContain(
      'stale-on-error',
    );
  });

  it('M. 被间隔切开的孤立工具调用按 1:1 计入预算,不按 4:1 折算', async () => {
    // review #676（codex）：buildRenderItems 现在会在相邻工具调用间隔超过阈值时切段，
    // 所以被间隔隔开的单行调用各自就是一个 tool_segment；一次性 ceil(总数/4) 会低估到 1/4。
    const target = serverMessage({
      id: 'deep',
      clientId: 'deep',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    let page = 0;
    vi.mocked(listMessagesFor).mockImplementation(async () => {
      const base = page++;
      // 每页 100 条普通工具调用，但每条相隔 1 小时（> 30 分钟阈值）→ 各自一段。
      return Array.from({ length: 100 }, (_, i) =>
        serverMessage({
          id: `far-${base}-${i}`,
          clientId: `far-${base}-${i}`,
          role: 'tool_use',
          content: JSON.stringify({ toolName: 'Bash', input: { command: 'ls' } }),
          createdAt: new Date(
            Date.UTC(2026, 6, 25, 12, 0, 0) - (base * 100 + i) * 3600_000,
          ).toISOString(),
        }),
      );
    });

    await makerChatStore.loadAroundMessageClientId(SID, 'deep', { radius: 60 });

    // 100 段/页、600 预算 → 约 6 页；按 4:1 折算会翻到 24 页。
    const calls = vi.mocked(listMessagesFor).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(7);
  });

  it('N. 任何 role 的行都按 1:1 计入预算,预算是渲染量的上界', async () => {
    // 折算模型已放弃（见 JUMP_BACKFILL_MAX_ITEMS 注释）：#676 的 review 连着四轮各挖出
    // 一种被低估的 item 展开路径（agent_task / 空洞切段 / ghost_card / agent_plan /
    // tool_media），每次都是「某行额外产生 item」，而折算恰恰假设「多行合成一个 item」。
    // 现在一律按行数当上界——密集连续的工具调用也不再享受折算。
    const target = serverMessage({
      id: 'dense',
      clientId: 'dense',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    let page = 0;
    vi.mocked(listMessagesFor).mockImplementation(async () => {
      const base = page++;
      // 每条相隔 10 秒 → 真实渲染里会合成同一段，但预算按行数保守计。
      return Array.from({ length: 100 }, (_, i) =>
        serverMessage({
          id: `dense-${base}-${i}`,
          clientId: `dense-${base}-${i}`,
          role: 'tool_use',
          content: JSON.stringify({ toolName: 'Bash', input: { command: 'ls' } }),
          createdAt: new Date(
            Date.UTC(2026, 6, 25, 12, 0, 0) - (base * 100 + i) * 10_000,
          ).toISOString(),
        }),
      );
    });

    await makerChatStore.loadAroundMessageClientId(SID, 'dense', { radius: 60 });

    // 600 行预算 ÷ 每页 100 行 = 6 页停手（折算模型下会翻到 24 页）。
    const calls = vi.mocked(listMessagesFor).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(7);
  });

  it('O. edit-last 截断与 /clear 都自己释放分页锁,不把翻页永久卡死', async () => {
    // review #676（copilot + codex）：锁释放责任移给「重置路径」后，dropMessagesFromClientId
    // 与 clearSessionAfterGuard 都 bump epoch 但没清锁，而被作废的 backfill 的 finally
    // 会因 epoch 变化跳过清理 → isLoadingMore 永久 true，行首守卫让该会话再也翻不了页。
    const seeded = fullPageNewestFirst();
    const inWindow = seeded[50];
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([inWindow]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce(seeded);
    await makerChatStore.loadAroundMessageClientId(SID, inWindow.clientId, { radius: 60 });

    // 让补齐挂在飞行中（持锁），期间发生 edit-last 本地截断。
    let releasePage: (rows: Message[]) => void = () => {};
    vi.mocked(listMessagesFor).mockImplementationOnce(
      () =>
        new Promise<Message[]>((resolve) => {
          releasePage = resolve;
        }),
    );
    makerChatStore.loadOlderMessages(SID);
    await flushMicrotasks();
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(true);

    makerChatStore.dropMessagesFromClientId(SID, seeded[10].clientId);
    // 截断路径自己就该把锁放掉，不能等被作废的请求代劳。
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);

    releasePage([]);
    await flushMicrotasks();
    // 被作废的请求收尾时也不该把锁重新置上或误清新代际的锁。
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);
  });

  it('P. ghost_call 与未知工具名都按 1:1 计入预算(白名单口径)', async () => {
    // review #676（codex + copilot）：ghost_call 配上卡后工具行隐身、另出一个独立
    // ghost_card；toolName 解析失败的行也无从判断。这两类按普通工具 4:1 折算都是
    // **低估**，而低估方向恰恰危险——它会放进更多实际渲染量。
    const target = serverMessage({
      id: 'cards-deep',
      clientId: 'cards-deep',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    let page = 0;
    vi.mocked(listMessagesFor).mockImplementation(async () => {
      const base = page++;
      // 每页 100 条 ghost_call（密集，间隔 10 秒 → 不会被空洞切段）。
      return Array.from({ length: 100 }, (_, i) =>
        serverMessage({
          id: `gc-${base}-${i}`,
          clientId: `gc-${base}-${i}`,
          role: 'tool_use',
          content: JSON.stringify({
            toolName: 'mcp__cindy__ghost_call',
            input: { ghostId: 'g1' },
          }),
          createdAt: new Date(
            Date.UTC(2026, 6, 25, 12, 0, 0) - (base * 100 + i) * 10_000,
          ).toISOString(),
        }),
      );
    });

    await makerChatStore.loadAroundMessageClientId(SID, 'cards-deep', { radius: 60 });

    // 100 张卡/页、600 预算 → 约 6 页；按 4:1 折算会翻到 24 页。
    const calls = vi.mocked(listMessagesFor).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(7);
  });

  it('Q. 锁被占用时即便目标已在窗口内也让位,不写游标', async () => {
    // review #676（copilot）：covered 判定原先排在锁检查之前，于是别人持锁期间
    // commitAroundWindow('covered') 仍会写 oldestMessageId，破坏游标单调性。
    const seeded = fullPageNewestFirst();
    const inWindow = seeded[50];
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([inWindow]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce(seeded);
    await makerChatStore.loadAroundMessageClientId(SID, inWindow.clientId, { radius: 60 });

    let releasePage: (rows: Message[]) => void = () => {};
    vi.mocked(listMessagesFor).mockImplementationOnce(
      () =>
        new Promise<Message[]>((resolve) => {
          releasePage = resolve;
        }),
    );
    makerChatStore.loadOlderMessages(SID);
    await flushMicrotasks();
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(true);

    const cursorBefore = makerChatStore.getSnapshot(SID).oldestMessageId;
    // 目标已经在窗口里（→ covered），但 around 窗口按 radius 还带回一条**更早**的行。
    // 旧顺序先判 covered，commitAroundWindow('covered') 就会把游标推到那条更早的行，
    // 而锁归正在飞行的 loadOlderMessages —— 游标单调性被破坏。
    const olderNeighbour = serverMessage({
      id: 'q-older',
      clientId: 'q-older',
      createdAt: '2026-07-19T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([olderNeighbour, inWindow]);
    await makerChatStore.loadAroundMessageClientId(SID, inWindow.clientId, { radius: 60 });

    expect(makerChatStore.getSnapshot(SID).oldestMessageId).toBe(cursorBefore);
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(true);

    releasePage([]);
    await flushMicrotasks();
  });

  it('R. 补齐 await 期间被重置,跳转作废(命中 backfill 内部的代际检查)', async () => {
    // review #676（codex）指出的是更窄的一层：outcome 只反映 backfill 返回那一刻的代际，
    // 它 return 之后、调用方从 await 恢复之前还有一个 microtask 间隙。两个入口都在 merge
    // 前补了一次 epoch 复检作为纵深防御，但那一跳无法从外部稳定构造（purge 的 microtask
    // 必然排在 backfill 自己的 await 之后，先被内部检查拦住）——本用例覆盖的是内部这层，
    // merge 前的复检只有代码注释与它对应。
    const target = serverMessage({
      id: 'gap-victim',
      clientId: 'gap-victim',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    // 第一页就命中目标 → backfill 返回 covered；但在它 return 之后立刻 purge。
    vi.mocked(listMessagesFor).mockImplementationOnce(async () => {
      void Promise.resolve().then(() => makerChatStore.purgeSession(SID));
      return [target];
    });

    const result = await makerChatStore.loadAroundMessageClientId(SID, 'gap-victim', {
      radius: 60,
    });

    expect(result).toBeNull();
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).not.toContain(
      'gap-victim',
    );
  });

  it('S. 删除推送只涉及窗口外的行时也要放锁,不把翻页永久卡死', async () => {
    // review #676（codex）：removeMessagesByClientIds 已经 bump 了 epoch，但本地没有任何
    // 行要移除时会走 unchanged-state 早退，绕过清锁；被作废的 loadOlderMessages 又刻意
    // 不清锁（避免误解锁新代际）→ 该会话的翻页与跳转永久阻塞。
    const seeded = fullPageNewestFirst();
    const inWindow = seeded[50];
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([inWindow]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce(seeded);
    await makerChatStore.loadAroundMessageClientId(SID, inWindow.clientId, { radius: 60 });

    let releasePage: (rows: Message[]) => void = () => {};
    vi.mocked(listMessagesFor).mockImplementationOnce(
      () =>
        new Promise<Message[]>((resolve) => {
          releasePage = resolve;
        }),
    );
    makerChatStore.loadOlderMessages(SID);
    await flushMicrotasks();
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(true);

    // 删的是本窗口之外的行（另一个窗口/设备删的），本地一行都不匹配。
    makerChatStore.removeMessagesByClientIds(SID, ['not-in-this-window']);
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);

    releasePage([]);
    await flushMicrotasks();
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);
  });

  it('T. 退回 around 窗口后再跳同一目标会重新补齐,不被成员判定短路', async () => {
    // review #676（codex）：快速通道原来只判 messages.some(clientId===target)，那是成员
    // 判定而非连续覆盖判定。孤岛（补齐失败时 merge 的 around 窗口）一旦落进窗口，再跳同一
    // 目标就直接返回 covered、不补齐——"中间缺失"永久修不好。
    const target = serverMessage({
      id: 'island',
      clientId: 'island',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    // 第 1 次跳转：翻完历史仍没命中 → exhausted → 退回 around 窗口，留下孤岛。
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce([
      serverMessage({ id: 'tail', clientId: 'tail', createdAt: '2026-07-25T12:00:00.000Z' }),
    ]);
    await makerChatStore.loadAroundMessageClientId(SID, 'island', { radius: 60 });
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).toContain('island');

    expect(makerChatStore.getSnapshot(SID).historyWindowHasIsland).toBe(true);

    // 第 2 次跳转同一目标：目标已在窗口里，但那是孤岛 —— 必须重新尝试翻页补齐，
    // 而且「取回一页无关的行」不能算作已覆盖（review #676：判定必须看本页是否真的取到
    // 目标，看合并后的数组会让任何一页都让判定成立、进而错误清掉孤岛标记）。
    const callsBefore = vi.mocked(listMessagesFor).mock.calls.length;
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce([
      serverMessage({ id: 'noise', clientId: 'noise', createdAt: '2026-07-24T00:00:00.000Z' }),
    ]);
    await makerChatStore.loadAroundMessageClientId(SID, 'island', { radius: 60 });

    expect(vi.mocked(listMessagesFor).mock.calls.length).toBeGreaterThan(callsBefore);
    // 关键：没真的取到目标 → 孤岛标记必须还在，下次跳转仍会重试。
    expect(makerChatStore.getSnapshot(SID).historyWindowHasIsland).toBe(true);

    // 第 3 次跳转：这次翻页真的取到目标 → 本次算覆盖（不再退回 around fallback）。
    // 但孤岛标记**不清**：到达本次目标只证明「尾部 → 本目标」连续，不证明更早的孤岛都被
    // 跨过（review #676 的两孤岛序列）。只由窗口整体重建清零。
    const callsBefore3 = vi.mocked(listMessagesFor).mock.calls.length;
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce([target]);
    const found = await makerChatStore.loadAroundMessageClientId(SID, 'island', { radius: 60 });
    expect(found?.clientId).toBe('island');
    expect(vi.mocked(listMessagesFor).mock.calls.length).toBeGreaterThan(callsBefore3);
    expect(makerChatStore.getSnapshot(SID).historyWindowHasIsland).toBe(true);

    // 窗口整体重建（reloadMessages 语义）才把标记清零。
    makerChatStore.reloadMessages(SID);
    expect(makerChatStore.getSnapshot(SID).historyWindowHasIsland).toBe(false);
  });

  it('U. 预算对照窗口总量,连续多次跳转不会各自重新起算', async () => {
    // review #676（codex）：itemsFetched 每次跳转从 0 起算，而先前跳转 merge 的行还在
    // s.messages 里；连续向更早处跳转会各加一整份预算，锚定的 slice(startIdx) 照样能把
    // 挂载树堆到几千行。
    const target = serverMessage({
      id: 'never-found',
      clientId: 'never-found',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValue([target]);
    let page = 0;
    vi.mocked(listMessagesFor).mockImplementation(async () => {
      const base = page++;
      return Array.from({ length: 100 }, (_, i) =>
        serverMessage({
          id: `u-${base}-${i}`,
          clientId: `u-${base}-${i}`,
          createdAt: new Date(
            Date.UTC(2026, 6, 25, 12, 0, 0) - (base * 100 + i) * 60_000,
          ).toISOString(),
        }),
      );
    });

    // 第 1 次跳转把窗口填到预算上限附近。
    await makerChatStore.loadAroundMessageClientId(SID, 'never-found', { radius: 60 });
    const sizeAfterFirst = makerChatStore.getSnapshot(SID).messages.length;
    expect(sizeAfterFirst).toBeGreaterThan(0);

    // 第 2 次跳转：窗口已经到量，不该再翻一整份预算进来。
    const callsBefore = vi.mocked(listMessagesFor).mock.calls.length;
    await makerChatStore.loadAroundMessageClientId(SID, 'never-found', { radius: 60 });
    const extraCalls = vi.mocked(listMessagesFor).mock.calls.length - callsBefore;

    expect(extraCalls).toBe(0);
    // 窗口总量始终受同一个上限约束（around 行本身可能再加少量，留一点余量）。
    expect(makerChatStore.getSnapshot(SID).messages.length).toBeLessThanOrEqual(650);
  });

  it('V. edit-last 的目标已不在切片里时也放锁', async () => {
    // review #676（codex）：dropMessagesFromClientId 的 idx<0 早退（reload/重开已把目标
    // 清掉）绕过清锁，而被作废的请求刻意不自清 → 翻页永久阻塞。
    const seeded = fullPageNewestFirst();
    const inWindow = seeded[50];
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([inWindow]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce(seeded);
    await makerChatStore.loadAroundMessageClientId(SID, inWindow.clientId, { radius: 60 });

    let releasePage: (rows: Message[]) => void = () => {};
    vi.mocked(listMessagesFor).mockImplementationOnce(
      () =>
        new Promise<Message[]>((resolve) => {
          releasePage = resolve;
        }),
    );
    makerChatStore.loadOlderMessages(SID);
    await flushMicrotasks();
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(true);

    // 截断目标压根不在窗口里 → idx<0 早退，但 epoch 已 bump。
    makerChatStore.dropMessagesFromClientId(SID, 'never-existed');
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);

    releasePage([]);
    await flushMicrotasks();
  });

  it('W. 已有连续窗口时,退回孤岛不推进游标(否则缺失区间再也拉不回来)', async () => {
    // review #676（codex）：缺失的区间比孤岛更新。把 oldestMessageId 推到孤岛上之后，
    // 正常向上翻页只会取比孤岛更老的行，缺失区间永远拉不到；而重试也救不了——窗口已经
    // 吃满预算，补齐一个请求都不发。游标必须留在连续段的边缘。
    const seeded = fullPageNewestFirst();
    const inWindow = seeded[50];
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([inWindow]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce(seeded);
    await makerChatStore.loadAroundMessageClientId(SID, inWindow.clientId, { radius: 60 });
    const contiguousCursor = makerChatStore.getSnapshot(SID).oldestMessageId;
    expect(contiguousCursor).toBeTruthy();

    // 跳到一条远得多的目标：翻完历史仍没命中 → exhausted → 退回 around 孤岛。
    const farTarget = serverMessage({
      id: 'far-island',
      clientId: 'far-island',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([farTarget]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce([
      serverMessage({ id: 'one', clientId: 'one', createdAt: '2026-07-24T00:00:00.000Z' }),
    ]);
    await makerChatStore.loadAroundMessageClientId(SID, 'far-island', { radius: 60 });

    // 孤岛进了窗口，但游标仍在连续段边缘 —— 向上翻页才能填补中间的空档。
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).toContain('far-island');
    expect(makerChatStore.getSnapshot(SID).oldestMessageId).not.toBe('far-island');
  });

  it('F. 让位时不释放别人的分页锁', async () => {
    // review #676（codex）：让位后 fallback 若写 isLoadingMore:false，就把仍在飞行的
    // loadOlderMessages 的锁提前释放了，下一次滚动/跳转会从同一游标再开一个请求。
    const seeded = fullPageNewestFirst();
    const inWindow = seeded[50];
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([inWindow]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce(seeded);
    await makerChatStore.loadAroundMessageClientId(SID, inWindow.clientId, { radius: 60 });

    let releasePage: (rows: Message[]) => void = () => {};
    vi.mocked(listMessagesFor).mockImplementationOnce(
      () =>
        new Promise<Message[]>((resolve) => {
          releasePage = resolve;
        }),
    );
    makerChatStore.loadOlderMessages(SID);
    await flushMicrotasks();
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(true);

    const cursorBefore = makerChatStore.getSnapshot(SID).oldestMessageId;
    const hasMoreBefore = makerChatStore.getSnapshot(SID).hasMoreMessages;
    const older = serverMessage({
      id: 'older2',
      clientId: 'older2',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([older]);
    await makerChatStore.loadAroundMessageClientId(SID, 'older2', { radius: 60 });

    // 锁仍归原请求持有 —— 跳转的 fallback 不得代为释放。
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(true);
    // review #676（copilot + codex）：分页状态整体归锁持有者。这里若把游标推到
    // around 窗口更早的位置，锁持有者提交时会用自己那一页的边界无条件覆盖，
    // 把游标「回退到更新的值」，破坏单调性 → 后续向上滚动重复拉已加载历史。
    expect(makerChatStore.getSnapshot(SID).oldestMessageId).toBe(cursorBefore);
    expect(makerChatStore.getSnapshot(SID).hasMoreMessages).toBe(hasMoreBefore);
    // 但权威 around 行仍要 merge 进窗口（定位 + 内容 hydration）。
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).toContain('older2');

    releasePage([]);
    await flushMicrotasks();
    // 原请求自己收尾后才释放。
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);
  });

  it('G. around 请求飞行期间切片被重置时,跳转作废(epoch 在请求前快照)', async () => {
    // review #676（codex）：epoch 若在 around 请求返回后才快照，就漏掉了这个 await
    // 自身的竞态窗口，陈旧的 around 行会被当成新代际 merge 回窗口。
    const target = serverMessage({
      id: 'stale',
      clientId: 'stale',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockImplementationOnce(async () => {
      makerChatStore.purgeSession(SID);
      return [target];
    });

    const result = await makerChatStore.loadAroundMessageClientId(SID, 'stale', { radius: 60 });

    expect(result).toBeNull();
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).not.toContain('stale');
  });

  it('Z. busy 让位时 around 一行没新增,不得凭空记上孤岛', async () => {
    // review #676(codex P1):busy 是在成员快速通道**之前**返回的(锁优先),所以"目标本来
    // 就在连续窗口里"也会走到 busy 的 fallback。那里原先无条件置 historyWindowHasIsland,
    // 于是一个本来连续的窗口被永久标成不连续:此后每次窗口内搜索都绕过直接 focus、从
    // oldestMessageId 往上补齐,而那个游标比已加载的目标更老、翻页永远碰不到它。
    const seeded = fullPageNewestFirst();
    const inWindow = seeded[50];

    // 建立连续窗口。
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([inWindow]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce(seeded);
    await makerChatStore.loadAroundMessageClientId(SID, inWindow.clientId, { radius: 60 });
    expect(makerChatStore.getSnapshot(SID).historyWindowHasIsland).toBe(false);
    const windowSize = makerChatStore.getSnapshot(SID).messages.length;

    // 让普通向上分页占住锁。
    let releasePage: (rows: Message[]) => void = () => {};
    vi.mocked(listMessagesFor).mockImplementationOnce(
      () =>
        new Promise<Message[]>((resolve) => {
          releasePage = resolve;
        }),
    );
    makerChatStore.loadOlderMessages(SID);
    await flushMicrotasks();
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(true);

    // 跳一个**已在窗口里**的目标:补齐让位(busy),around 返回的行也全在窗口里 → 零新增。
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([seeded[49], inWindow]);
    await makerChatStore.loadAroundMessageClientId(SID, inWindow.clientId, { radius: 60 });

    expect(makerChatStore.getSnapshot(SID).messages).toHaveLength(windowSize);
    // 关键:一行都没加进来 → 窗口连续性没有变化,标记不得被点亮。
    expect(makerChatStore.getSnapshot(SID).historyWindowHasIsland).toBe(false);

    releasePage([]);
    await flushMicrotasks();
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);
  });

  it('J6. 补齐页只补缺行,不用旧快照 hydrate 已有的行(不盖掉飞行期间的 live 更新)', async () => {
    // review #676(codex P1):补齐的页可能在几秒前就取到了(多页 + 隧道),期间
    // local-db:messages:created 可能已经把某行更新过。默认 merge 是 {...existing, ...persisted}
    // ——persisted 赢,于是旧快照把 live 更新盖回去,界面上已完成的结果会变回旧内容。
    const liveRow = serverMessage({
      id: 'tool-row',
      clientId: 'tool-row',
      role: 'tool_result',
      content: 'live final content',
      createdAt: '2026-07-25T12:00:00.000Z',
    });
    // 第一次跳转把这一行的**最新**内容放进窗口。
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([liveRow]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce([liveRow]);
    await makerChatStore.loadAroundMessageClientId(SID, 'tool-row', { radius: 60 });
    expect(
      makerChatStore.getSnapshot(SID).messages.find((m) => m.clientId === 'tool-row')?.content,
    ).toBe('live final content');

    // 第二次跳转到更早的目标:补齐取回的那一页带着**旧快照**的同一行。
    const target = serverMessage({
      id: 'deep-target',
      clientId: 'deep-target',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce([
      { ...liveRow, content: 'stale snapshot content' },
    ]);
    await makerChatStore.loadAroundMessageClientId(SID, 'deep-target', { radius: 60 });

    // 关键:补齐页不 hydrate 已有的行 —— live 内容原样保留。
    expect(
      makerChatStore.getSnapshot(SID).messages.find((m) => m.clientId === 'tool-row')?.content,
    ).toBe('live final content');
    // 缺的行照常补进来。
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).toContain(
      'deep-target',
    );
  });

  it('J7. around 提交只 hydrate 跳转目标,不用陈旧快照盖掉窗口里其它行', async () => {
    // review #676(codex P1):around 是在整个补齐循环**之前**取的,隧道下可能陈旧好几秒;
    // 期间 live push 可能已经更新过窗口里某行。默认 hydrate 让 persisted 赢 → 陈旧的 around
    // 快照把更新的内容盖回去。目标那一行的 hydrate 是刻意保留的(重复跳转收敛权威内容)。
    const other = serverMessage({
      id: 'other-row',
      clientId: 'other-row',
      role: 'tool_result',
      content: 'live final content',
      createdAt: '2026-07-25T12:00:00.000Z',
    });
    const target = serverMessage({
      id: 'jump-target',
      clientId: 'jump-target',
      role: 'tool_result',
      content: 'stale local content',
      createdAt: '2026-07-25T11:00:00.000Z',
    });
    // 先建立窗口:两行都在,内容都是"当前最新"。
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target, other]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce([target, other]);
    await makerChatStore.loadAroundMessageClientId(SID, 'other-row', { radius: 60 });
    expect(
      makerChatStore.getSnapshot(SID).messages.find((m) => m.clientId === 'other-row')?.content,
    ).toBe('live final content');

    // 再跳到 target:around 快照里两行都是**旧内容**(target 的权威内容更长,other 已过期)。
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([
      { ...target, content: 'authoritative target content' },
      { ...other, content: 'stale other content' },
    ]);
    // 目标已在连续窗口里 → 走成员快速通道,一个 list 请求都不发(所以这里不排 list mock,
    // 免得留下未消费的 Once 影响后续用例)。
    await makerChatStore.loadAroundMessageClientId(SID, 'jump-target', { radius: 60 });

    const snap = makerChatStore.getSnapshot(SID);
    // 目标照常 hydrate 成权威内容(这是跳转提交的目的)。
    expect(snap.messages.find((m) => m.clientId === 'jump-target')?.content).toBe(
      'authoritative target content',
    );
    // 关键:其它行不被陈旧的 around 快照盖掉。
    expect(snap.messages.find((m) => m.clientId === 'other-row')?.content).toBe(
      'live final content',
    );
  });

  it('J8. 跳转期间目标行被 live 更新过时,around 快照也不许 hydrate 它', async () => {
    // review #676(codex P1):目标行的 hydrate 是 around 提交的目的,但 around 是在补齐循环
    // **之前**取的;这期间 local-db:messages:created 把目标更新过时,拿旧快照 hydrate 就会把
    // 更新的内容盖回去。判据是对象引用:store 里的 ChatMessage 不可变,只有真的变了才换对象。
    const target = serverMessage({
      id: 'live-target',
      clientId: 'live-target',
      role: 'assistant',
      content: 'content when around was fetched',
      createdAt: '2026-07-25T11:00:00.000Z',
    });
    // 第 1 步:普通跳转把目标放进窗口。
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce([target]);
    await makerChatStore.loadAroundMessageClientId(SID, 'live-target', { radius: 60 });

    // 第 2 步:制造孤岛(补齐取不到 → 退回 around fallback),这样下一次跳转不会走成员快速通道。
    const island = serverMessage({
      id: 'island-row',
      clientId: 'island-row',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([island]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce([]);
    await makerChatStore.loadAroundMessageClientId(SID, 'island-row', { radius: 60 });
    expect(makerChatStore.getSnapshot(SID).historyWindowHasIsland).toBe(true);

    // 第 3 步:再跳目标。around 返回的是"取快照那一刻"的旧内容,补齐停在飞行中。
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    let releasePage: (rows: Message[]) => void = () => {};
    vi.mocked(listMessagesFor).mockImplementationOnce(
      () =>
        new Promise<Message[]>((resolve) => {
          releasePage = resolve;
        }),
    );
    const jump = makerChatStore.loadAroundMessageClientId(SID, 'live-target', { radius: 60 });
    await flushMicrotasks();

    // 飞行期间 live push 把目标更新了(真实通道:local-db:messages:created)。
    messageCreatedListener?.({
      sessionId: SID,
      message: { ...target, content: 'live newer content' },
    });
    expect(
      makerChatStore.getSnapshot(SID).messages.find((m) => m.clientId === 'live-target')?.content,
    ).toBe('live newer content');

    releasePage([]);
    await jump;
    await flushMicrotasks();

    // 关键:陈旧的 around 快照不许把 live 内容盖回去。
    expect(
      makerChatStore.getSnapshot(SID).messages.find((m) => m.clientId === 'live-target')?.content,
    ).toBe('live newer content');
  });

  it('J9. 跳转期间目标行才被 push 补进来时,同样不许用陈旧 around 快照 hydrate 它', async () => {
    // review #676(codex P1):目标"跳转前不在窗口里"原先无条件放行 hydrate,但它可能在补齐飞行
    // 期间被 messages:created 补进来,那份内容比 around 快照**更新**。
    const target = serverMessage({
      id: 'arrived-target',
      clientId: 'arrived-target',
      role: 'assistant',
      content: 'content in the around snapshot',
      createdAt: '2026-07-25T11:00:00.000Z',
    });
    // 先制造孤岛,保证下一次跳转必须走补齐(有飞行窗口)。
    const island = serverMessage({
      id: 'island-row',
      clientId: 'island-row',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([island]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce([]);
    await makerChatStore.loadAroundMessageClientId(SID, 'island-row', { radius: 60 });
    expect(makerChatStore.getSnapshot(SID).historyWindowHasIsland).toBe(true);
    // 目标此刻**不在**窗口里。
    expect(
      makerChatStore.getSnapshot(SID).messages.some((m) => m.clientId === 'arrived-target'),
    ).toBe(false);

    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    let releasePage: (rows: Message[]) => void = () => {};
    vi.mocked(listMessagesFor).mockImplementationOnce(
      () =>
        new Promise<Message[]>((resolve) => {
          releasePage = resolve;
        }),
    );
    const jump = makerChatStore.loadAroundMessageClientId(SID, 'arrived-target', { radius: 60 });
    await flushMicrotasks();

    // 飞行期间目标被 push 补进来,内容比 around 快照更新。
    messageCreatedListener?.({
      sessionId: SID,
      message: { ...target, content: 'live newer content' },
    });
    releasePage([]);
    await jump;
    await flushMicrotasks();

    // 关键:陈旧的 around 快照不许把它盖回去。
    expect(
      makerChatStore.getSnapshot(SID).messages.find((m) => m.clientId === 'arrived-target')?.content,
    ).toBe('live newer content');
  });

  it('J6b. addOnly 只影响"已有的行",缺行照补(merge 契约直测)', () => {
    const existing = [
      { clientId: 'a', role: 'assistant' as const, content: 'live', createdAt: '2026-07-25T12:00:00.000Z' },
    ];
    const server = [
      { clientId: 'a', role: 'assistant' as const, content: 'stale', createdAt: '2026-07-25T12:00:00.000Z' },
      { clientId: 'b', role: 'assistant' as const, content: 'new row', createdAt: '2026-07-25T11:00:00.000Z' },
    ];
    const addOnly = makerChatStore.__mergeMessagesForTest(server, existing, { addOnly: true }, 'newest-first');
    expect(addOnly.find((m) => m.clientId === 'a')?.content).toBe('live');
    expect(addOnly.map((m) => m.clientId)).toContain('b');
    // 对照:默认口径下 server 快照会赢(around 提交刻意依赖这个)。
    const hydrated = makerChatStore.__mergeMessagesForTest(server, existing, {}, 'newest-first');
    expect(hydrated.find((m) => m.clientId === 'a')?.content).toBe('stale');
  });

  it('J5. 成员快速通道不写分页状态(它没有置过锁,游标 / hasMore / 锁都不归它)', async () => {
    // review #676(codex P1):快速通道在置锁**之前**就返回 covered。它的提交若照常写
    // oldestMessageId 并清 isLoadingMore,两个 around 响应同时落地时就会把另一次刚拿到的锁
    // 清掉、并覆写它的游标(隧道 continuation 下尤其容易排在一起)。
    const seeded = fullPageNewestFirst();
    const inWindow = seeded[50];

    // 建立连续窗口(无孤岛),记下分页状态。
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([inWindow]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce(seeded);
    await makerChatStore.loadAroundMessageClientId(SID, inWindow.clientId, { radius: 60 });
    const before = makerChatStore.getSnapshot(SID);
    expect(before.historyWindowHasIsland).toBe(false);
    const cursorBefore = before.oldestMessageId;
    const hasMoreBefore = before.hasMoreMessages;
    const callsBefore = vi.mocked(listMessagesFor).mock.calls.length;

    // 再跳同一个(已在连续窗口里的)目标:走成员快速通道,一个请求都不发。
    // around 这次带回一条**比当前游标更老**的邻居 —— 旧实现会据此把游标前移。
    const olderNeighbour = serverMessage({
      id: 'older-neighbour',
      clientId: 'older-neighbour',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([olderNeighbour, inWindow]);
    await makerChatStore.loadAroundMessageClientId(SID, inWindow.clientId, { radius: 60 });

    // 没发新请求(快速通道)。
    expect(vi.mocked(listMessagesFor).mock.calls).toHaveLength(callsBefore);
    // 权威 merge 照做。
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).toContain(
      'older-neighbour',
    );
    // 关键:分页状态一律没碰 —— 它不归这次跳转。
    expect(makerChatStore.getSnapshot(SID).oldestMessageId).toBe(cursorBefore);
    expect(makerChatStore.getSnapshot(SID).hasMoreMessages).toBe(hasMoreBefore);
  });

  it('J4. 分页锁一路持有到 around 提交,中途不出现"锁已开但窗口未提交"的空档', async () => {
    // review #676(codex P1):原先 backfill 在 finally 里放锁,于是"backfill 返回"与"调用方
    // 提交"之间多出一个 microtask 空档 —— 另一次跳转(隧道响应的 continuation 尤其容易排在
    // 这里)能在空档里抢到锁,随后旧那次的提交又把 isLoadingMore 清掉,新持有者的游标就暴露
    // 给并发分页了。
    //
    // 这里用一个确定性的观察点来守:订阅每一次发布,断言**第一个 isLoadingMore=false 的状态
    // 里已经能看到 around 行**。旧实现会先发布一个"锁已开、around 还没 merge"的中间态。
    const target = serverMessage({
      id: 'held-lock',
      clientId: 'held-lock',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    // 空页 → exhausted → 走 fallback 提交(around 行在提交里才 merge)。
    vi.mocked(listMessagesFor).mockResolvedValueOnce([]);

    const seen: { loading: boolean; hasTarget: boolean }[] = [];
    const unsubscribe = makerChatStore.subscribe(SID, () => {
      const snap = makerChatStore.getSnapshot(SID);
      seen.push({
        loading: snap.isLoadingMore,
        hasTarget: snap.messages.some((m) => m.clientId === 'held-lock'),
      });
    });

    await makerChatStore.loadAroundMessageClientId(SID, 'held-lock', { radius: 60 });
    unsubscribe();

    // 锁确实被持有过,也确实被释放了。
    expect(seen.some((entry) => entry.loading)).toBe(true);
    const firstReleased = seen.find((entry) => !entry.loading);
    expect(firstReleased).toBeDefined();
    // 关键:锁开的那一刻,around 行已经在窗口里 —— 没有"锁已开、窗口还没提交"的中间态。
    expect(firstReleased?.hasTarget).toBe(true);
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);
  });

  it('J3. fallback 一行都没加进来时,不把已确证的 hasMoreMessages 翻回 true', async () => {
    // review #676(codex P1):fallback 原先无条件置 hasMoreMessages=true。已经完整翻到历史
    // 起点的会话因此每次窗口内搜索都重新亮起"还有更多历史",并再发一轮无用请求。
    // 置 true 的正当理由只在"merge 真的把更早的行加进来了"时成立(窗口边界前移)。
    const target = serverMessage({
      id: 'only-row',
      clientId: 'only-row',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    // 第 1 次跳转:补齐取不到目标(空页 → exhausted)→ 退回 around,merge 进目标这一行。
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValue([target]);
    vi.mocked(listMessagesFor).mockResolvedValue([]);
    await makerChatStore.loadAroundMessageClientId(SID, 'only-row', { radius: 60 });
    expect(makerChatStore.getSnapshot(SID).historyWindowHasIsland).toBe(true);
    // 有新行加进来 → 边界前移,hasMore 置 true 是对的。
    expect(makerChatStore.getSnapshot(SID).hasMoreMessages).toBe(true);

    // 第 2 次跳转同一目标:孤岛在,所以仍走补齐 → 空页 → exhausted(确证没有更多历史),
    // 而 around 这次一行都没新增。
    await makerChatStore.loadAroundMessageClientId(SID, 'only-row', { radius: 60 });

    expect(makerChatStore.getSnapshot(SID).messages).toHaveLength(1);
    // 关键:没加进任何行 → 窗口边界没动 → 不得把 exhausted 刚确证的 false 翻回 true。
    expect(makerChatStore.getSnapshot(SID).hasMoreMessages).toBe(false);
  });

  it('Y. 超长裁剪不清孤岛标记(裁剪只保证"最新 200 行",不保证连续)', async () => {
    // review #676(codex P1):slice(-TRIM_TARGET) 取的是最新 200 行,不等于"连续的最新
    // 一段"。若先前几次深跳留下多个孤岛、真正连续的尾段不足 200 行,裁剪结果里还夹着孤岛。
    // 清掉标记会让 canFocusWithoutJumpLoad 把命中孤岛当成已覆盖直接 focus,而从孤岛边界
    // 往上翻又取不到那段更新的缺失区间 → 洞永久固化。
    const target = serverMessage({
      id: 'island-trim',
      clientId: 'island-trim',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    // 先制造孤岛(补齐取不到目标 → 退回 around 窗口),同时把窗口灌到超过 TRIM_THRESHOLD。
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    let page = 0;
    vi.mocked(listMessagesFor).mockImplementation(async () => {
      const base = page++;
      return Array.from({ length: 100 }, (_, i) =>
        serverMessage({
          id: `trim-${base}-${i}`,
          clientId: `trim-${base}-${i}`,
          createdAt: new Date(Date.UTC(2026, 6, 20) - (base * 100 + i) * 60_000).toISOString(),
        }),
      );
    });
    await makerChatStore.loadAroundMessageClientId(SID, 'island-trim', { radius: 60 });
    expect(makerChatStore.getSnapshot(SID).historyWindowHasIsland).toBe(true);
    expect(makerChatStore.getSnapshot(SID).messages.length).toBeGreaterThan(300);

    // 离开视图 → 触发 _trimMessagesIfNeeded。
    const leave = makerChatStore.enterView(SID);
    leave();

    expect(makerChatStore.getSnapshot(SID).messages).toHaveLength(200);
    // 关键:裁剪不清标记 —— 保留的 200 行未必连续。
    expect(makerChatStore.getSnapshot(SID).historyWindowHasIsland).toBe(true);
  });

  it('Y2. 超长裁剪丢掉当前计划边界时,允许重入重新首拉补回计划', async () => {
    const oldPlan = planToolMessage({
      id: 'trimmed-plan',
      clientId: 'trimmed-plan',
      createdAt: '2026-07-24T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([oldPlan]);
    let page = 0;
    vi.mocked(listMessagesFor).mockImplementation(async () => {
      const base = page++;
      return Array.from({ length: 100 }, (_, i) =>
        serverMessage({
          id: `post-plan-${base}-${i}`,
          clientId: `post-plan-${base}-${i}`,
          createdAt: new Date(
            Date.UTC(2026, 6, 25, 12, 0, 0) - (base * 100 + i) * 60_000,
          ).toISOString(),
        }),
      );
    });
    await makerChatStore.loadAroundMessageClientId(SID, 'trimmed-plan', { radius: 60 });
    expect(makerChatStore.getSnapshot(SID).messages.length).toBeGreaterThan(300);
    expect(makerChatStore.getSnapshot(SID).historyLoaded).toBe(true);

    const leave = makerChatStore.enterView(SID);
    leave();

    const snapshot = makerChatStore.getSnapshot(SID);
    expect(snapshot.messages).toHaveLength(200);
    expect(snapshot.messages.some((message) => message.clientId === 'trimmed-plan')).toBe(false);
    expect(snapshot.historyLoaded).toBe(false);
  });

  it('X. /clear 清空窗口时一并清掉孤岛标记,不把会话永久钉在"不连续"', async () => {
    // review #676（codex P1）：covered 刻意保留孤岛标记（到达本次目标不证明更早的洞都补
    // 上了），所以标记只能由「窗口整体重建」清零。/clear 清了 messages / 游标 / 锁却漏了
    // 这个标记 → 清空后的会话永远被判为不连续：canFocusWithoutJumpLoad 拒绝每一次窗口内
    // 命中，之后每次搜索跳转都白跑一轮补齐。
    const target = serverMessage({
      id: 'island-clear',
      clientId: 'island-clear',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    // 先制造孤岛：翻页取不到目标 → 退回 around 窗口。
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce([
      serverMessage({ id: 'tail-c', clientId: 'tail-c', createdAt: '2026-07-25T12:00:00.000Z' }),
    ]);
    await makerChatStore.loadAroundMessageClientId(SID, 'island-clear', { radius: 60 });
    expect(makerChatStore.getSnapshot(SID).historyWindowHasIsland).toBe(true);

    makerChatStore.clearSession(SID);
    await flushMicrotasks();

    // 窗口空了 → 按构造没有孤岛。
    expect(makerChatStore.getSnapshot(SID).messages).toHaveLength(0);
    expect(makerChatStore.getSnapshot(SID).historyWindowHasIsland).toBe(false);
  });
});
