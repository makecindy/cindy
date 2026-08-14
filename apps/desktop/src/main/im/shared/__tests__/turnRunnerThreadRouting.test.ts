/**
 * turnRunner thread = session 路由矩阵(slack threadScoped adapter)。
 *
 * 覆盖:
 *  1. 顶层消息(scopeKey = 自身 ts)→ 每个 scope 新建独立 session
 *  2. thread 回复(同 scopeKey)→ 命中既有 session 续聊, 不新建
 *  3. 多 thread 并行: 两个 scope 各自跑 turn, 互不排队
 *  4. 出站串 thread: 流式首发 / 排队提示带 threadTs = scopeKey
 *  5. binding(identity+scopeKey)命中 → attached 路由到 desktop session
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, Session, SessionSendResult } from '@cindy/maker-core';
import type { ChannelIM } from '@cindy/im';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  slackIm: {
    reactToMessage: vi.fn(),
    removeMessageReaction: vi.fn(),
    sendText: vi.fn(),
    sendMarkdownText: vi.fn(),
    startStreamingText: vi.fn(),
    patchMarkdownCard: vi.fn(),
    sendInteractiveCard: vi.fn(),
    updateInteractiveCard: vi.fn(),
    threadKeyForMessage: vi.fn((id: string) => id.split('|')[1] ?? id),
  },
  getMaker: vi.fn(),
  listProviders: vi.fn(),
  readXdGatewayApiKey: vi.fn(),
  bindingGet: vi.fn(),
  bindingDetach: vi.fn(),
  bindingGetAttachCardMessageId: vi.fn(),
  touchUserSent: vi.fn(),
  persistUserMessage: vi.fn(),
  persistAssistantMessage: vi.fn(),
  wireSessionToIpcExternal: vi.fn(),
  installDesktopInteractionListener: vi.fn(),
  takePendingInteractionsForSession: vi.fn(() => []),
  noteSilentStopUserSend: vi.fn(),
  noteSilentStopSessionReset: vi.fn(),
  onSilentStopSettled: vi.fn(() => vi.fn()),
  rejectAllPending: vi.fn(),
  registerPending: vi.fn(),
  registerPendingExternal: vi.fn(),
  checkDestructiveToolCall: vi.fn(() => ({ destructive: false })),
  resolveXdtImageUrl: vi.fn(),
  generateAndPersistFbotTitle: vi.fn(),
  dbSelect: vi.fn(),
}));

vi.mock('../../../logger', () => ({ createLogger: () => mocks.logger }));
vi.mock('../../../maker-host', () => ({ getMaker: mocks.getMaker }));
vi.mock('../../../maker-host/createDesktopProviderService', () => ({
  getDesktopProviderService: () => ({ listProviders: mocks.listProviders }),
}));
vi.mock('../../../localDb/client/current', () => ({
  getDbClient: vi.fn(() => ({
    drizzle: { select: mocks.dbSelect, update: vi.fn() },
  })),
}));
vi.mock('../../../localDb/schema', () => ({ sessions: {} }));
vi.mock('../../../imageCacheStore', () => ({ resolveSafe: mocks.resolveXdtImageUrl }));
vi.mock('../sessionRepo', () => ({
  touchUserSent: mocks.touchUserSent,
  toCoreAgentKind: (kind: string) => (kind === 'codex' ? 'codex' : 'claude-code'),
}));
vi.mock('../../messagePersistence', () => ({
  persistUserMessage: mocks.persistUserMessage,
  persistAssistantMessage: mocks.persistAssistantMessage,
}));
vi.mock('../../binding', () => ({
  bindingStore: {
    get: mocks.bindingGet,
    detach: mocks.bindingDetach,
    getAttachCardMessageId: mocks.bindingGetAttachCardMessageId,
  },
}));
vi.mock('../../../maker-ipc/register', () => ({
  wireSessionToIpcExternal: mocks.wireSessionToIpcExternal,
  installDesktopInteractionListener: mocks.installDesktopInteractionListener,
  takePendingInteractionsForSession: mocks.takePendingInteractionsForSession,
  noteSilentStopUserSend: mocks.noteSilentStopUserSend,
  noteSilentStopSessionReset: mocks.noteSilentStopSessionReset,
  onSilentStopSettled: mocks.onSilentStopSettled,
}));
vi.mock('../pendingInteractions', () => ({
  registerPending: mocks.registerPending,
  registerPendingExternal: mocks.registerPendingExternal,
  rejectAllPending: mocks.rejectAllPending,
}));
vi.mock('../../../destructiveGuard', () => ({
  checkDestructiveToolCall: mocks.checkDestructiveToolCall,
}));
vi.mock('../apiKey', () => ({ readXdGatewayApiKey: mocks.readXdGatewayApiKey }));
vi.mock('../fbotTitle', () => ({
  FBOT_DRAFT_TITLE: 'FBot · New',
  generateAndPersistFbotTitle: mocks.generateAndPersistFbotTitle,
}));

import { createTurnRunner, type ImTurnRunner } from '../turnRunner';
import type { ImCardBuilders } from '../cardBuilders';
import type { ImSessionRepo, ImSessionRow } from '../sessionRepo';
import type { ImChannelAdapter } from '../types';
import { ui as slackUi } from './threadUiFixture';

interface SessionHarness {
  session: Session;
  send: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  emit(event: AgentEvent): void;
}

function makeSessionHarness(sessionId: string): SessionHarness {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const unsubscribe = vi.fn();
  const send = vi.fn(
    async (
      _message: Parameters<Session['send']>[0],
      opts?: Parameters<Session['send']>[1],
    ): Promise<SessionSendResult> => {
      await opts?.onAccepted?.();
      return { accepted: true } as SessionSendResult;
    },
  );
  const session = {
    id: sessionId,
    agentKind: 'claude-code',
    send,
    isTurnRunning: vi.fn(() => false),
    onEvent(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      return () => {
        unsubscribe();
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    setInteractionListener: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as Session;
  return {
    session,
    send,
    unsubscribe,
    emit(event: AgentEvent) {
      for (const l of [...listeners]) l(event);
    },
  };
}

// ── per-scope 行仓库(内存)+ per-id maker session 工厂 ─────────────────────
const rows = new Map<string, ImSessionRow>();
const harnesses = new Map<string, SessionHarness>();

function rowFor(id: string): ImSessionRow {
  return {
    id,
    agentKind: 'claude-code',
    workingDir: '/tmp/slack-wd',
    model: 'claude-opus-4-7',
    effort: 'xhigh',
    permissionMode: 'auto',
    fastMode: false,
    sdkSessionId: null,
    providerId: null,
  };
}

const sessionIdFor = (bot: string, user: string, scope?: string): string =>
  scope ? `slack_${bot}_${user}_${scope.replace(/\./g, '_')}` : `slack_${bot}_${user}`;

const fakeRepo: ImSessionRepo = {
  sessionIdFor,
  peekSession: async () => null,
  peekSessionById: async () => null,
  findActiveSession: vi.fn(async (bot: string, user: string, scope?: string) => {
    return rows.get(sessionIdFor(bot, user, scope)) ?? null;
  }),
  prepareNewSession: vi.fn(async (bot: string, user: string, scope?: string) =>
    rowFor(sessionIdFor(bot, user, scope))),
  createSession: vi.fn(async (bot: string, user: string, scope?: string) => {
    const row = rowFor(sessionIdFor(bot, user, scope));
    rows.set(row.id, row);
    return row;
  }),
  getDefaultEffortFor: () => 'high',
};

const fakeCards = {
  buildPermissionCard: vi.fn(),
  buildAskUserCard: vi.fn(),
  buildPlanReviewCard: vi.fn(),
  buildModelPickerCard: vi.fn(),
  buildPermissionModePickerCard: vi.fn(),
  buildControlPickerCard: vi.fn(),
  buildControlSessionPickerCard: vi.fn(),
  buildResolvedCard: vi.fn(),
} as unknown as ImCardBuilders;

const fakeAdapter: ImChannelAdapter = {
  channel: 'slack',
  im: mocks.slackIm as unknown as ChannelIM,
  output: { kind: 'rich-card', im: mocks.slackIm as unknown as ChannelIM },
  config: {
    agentKind: 'claude-code',
    defaultModel: 'claude-opus-4-7',
    defaultPermissionMode: 'auto',
  },
  ui: slackUi,
  threadScoped: true,
  sessions: {
    source: 'slack',
    sessionIdFor,
    defaultTitle: (user) => `Slack · ${user.slice(-6)}`,
    generatedTitlePrefix: 'Slack · ',
    ensureWorkingDir: () => '/tmp/slack-wd',
    extraInsertColumns: () => ({}),
  },
  processingEmoji: 'eyes',
  buildVendorOptions: (userId, scopeKey) => ({
    slackChatId: userId,
    ...(scopeKey ? { slackThreadTs: scopeKey } : {}),
    source: 'slack',
  }),
};

let runner: ImTurnRunner;

function streamingHandleStub() {
  return {
    messageId: 'C1|9.9',
    append: vi.fn(),
    replace: vi.fn(),
    finalize: vi.fn(async () => undefined),
    close: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  harnesses.clear();
  mocks.readXdGatewayApiKey.mockReturnValue('sk-test');
  mocks.listProviders.mockResolvedValue([
    {
      id: 'xd',
      name: 'XD',
      source: 'builtin',
      connected: true,
      agents: ['claude-code', 'codex'],
      models: {
        'claude-code': [{ id: 'claude-opus-4-7' }],
        codex: [],
      },
      routing: {
        'claude-code': { upstream: 'https://gateway.example', authStrategy: 'gateway-key' },
        codex: { upstream: 'https://gateway.example/v1', authStrategy: 'gateway-key' },
      },
    },
  ]);
  mocks.bindingGet.mockReturnValue(null);
  mocks.slackIm.reactToMessage.mockResolvedValue('eyes');
  mocks.slackIm.removeMessageReaction.mockResolvedValue(undefined);
  mocks.slackIm.sendText.mockResolvedValue({ messageId: 'C1|m' });
  mocks.slackIm.sendMarkdownText.mockResolvedValue({ messageId: 'C1|m' });
  mocks.slackIm.sendInteractiveCard.mockResolvedValue({ messageId: 'C1|hdr' });
  mocks.slackIm.startStreamingText.mockResolvedValue(streamingHandleStub());
  mocks.bindingGetAttachCardMessageId.mockReturnValue(null);
  mocks.generateAndPersistFbotTitle.mockResolvedValue(null);
  mocks.takePendingInteractionsForSession.mockReturnValue([]);
  // maker.createSession: 按 id 返回独立 harness(多 session 并行的关键)
  mocks.getMaker.mockReturnValue({
    on: vi.fn(() => () => undefined),
    createSession: vi.fn(async (args: { id?: string }) => {
      const id = args.id ?? 'anon';
      let h = harnesses.get(id);
      if (!h) {
        h = makeSessionHarness(id);
        harnesses.set(id, h);
      }
      return h.session;
    }),
  });
  runner = createTurnRunner(fakeAdapter, fakeRepo, fakeCards);
});

async function runTurn(scopeKey: string, text = 'hello'): Promise<void> {
  await runner.runAgentTurn({
    botContextId: 'T1',
    userId: 'U1',
    userMessageId: `C1|${scopeKey}`,
    text,
    attachments: [],
    scopeKey,
  });
}

describe('turnRunner thread = session 路由(slack threadScoped)', () => {
  it('顶层消息: 不同 scopeKey 各建独立 session', async () => {
    await runTurn('100.1');
    await runTurn('200.2');
    expect(fakeRepo.createSession).toHaveBeenCalledTimes(2);
    expect(harnesses.has('slack_T1_U1_100_1')).toBe(true);
    expect(harnesses.has('slack_T1_U1_200_2')).toBe(true);
  });

  it('thread 回复: 同 scopeKey 命中既有 session, 不新建', async () => {
    await runTurn('100.1');
    // 第一轮收口, 让第二条不走排队
    harnesses.get('slack_T1_U1_100_1')!.emit({ type: 'done' } as AgentEvent);
    await runTurn('100.1', 'follow-up');
    expect(fakeRepo.createSession).toHaveBeenCalledTimes(1);
    expect(harnesses.get('slack_T1_U1_100_1')!.send).toHaveBeenCalledTimes(2);
  });

  it('多 thread 并行: 两个 scope 各自 dispatch, 不互相排队', async () => {
    await runTurn('100.1');
    await runTurn('200.2');
    // 两个 session 都直接 send(没有 queuedNotice)
    expect(harnesses.get('slack_T1_U1_100_1')!.send).toHaveBeenCalledTimes(1);
    expect(harnesses.get('slack_T1_U1_200_2')!.send).toHaveBeenCalledTimes(1);
    expect(mocks.slackIm.sendMarkdownText).not.toHaveBeenCalled();
  });

  it('出站串 thread: 流式首发带 threadTs = scopeKey', async () => {
    await runTurn('100.1');
    const h = harnesses.get('slack_T1_U1_100_1')!;
    h.emit({ type: 'text', data: { text: 'hi' } } as AgentEvent);
    await vi.waitFor(() => {
      expect(mocks.slackIm.startStreamingText).toHaveBeenCalledWith('U1', undefined, {
        threadTs: '100.1',
      });
    });
  });

  it('claim-bearing SDK done keeps the IM card open until the product done', async () => {
    const stub = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    await runTurn('100.1');
    const h = harnesses.get('slack_T1_U1_100_1')!;

    h.emit({ type: 'text', data: { text: '第一段结果', isFinal: true } } as AgentEvent);
    await vi.waitFor(() => expect(mocks.slackIm.startStreamingText).toHaveBeenCalledTimes(1));

    h.emit({ type: 'done', data: {}, turnContinuationId: 1 } as AgentEvent);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stub.finalize).not.toHaveBeenCalled();

    h.emit({ type: 'text', data: { text: '续跑后的最终结果', isFinal: true } } as AgentEvent);
    h.emit({ type: 'done', data: {} } as AgentEvent);
    await vi.waitFor(() => expect(stub.finalize).toHaveBeenCalledTimes(1));
    const finalBody = (stub.finalize.mock.calls[0] as unknown[] | undefined)?.[0];
    expect(finalBody).toContain('续跑后的最终结果');
  });

  it('排队提示带 threadTs(同 thread 第二条在 turn 进行中到达)', async () => {
    await runTurn('100.1');
    // 第一轮未收口 → 第二条同 scope 消息排队
    await runTurn('100.1', 'queued message');
    expect(mocks.slackIm.sendMarkdownText).toHaveBeenCalledWith(
      'U1',
      expect.stringContaining('排队'),
      { threadTs: '100.1' },
    );
    expect(harnesses.get('slack_T1_U1_100_1')!.send).toHaveBeenCalledTimes(1);
  });

  it('binding(identity+scopeKey)命中 → attached 路由到 desktop session', async () => {
    mocks.bindingGet.mockImplementation(
      (id: { scopeKey?: string }) => (id.scopeKey === '300.3' ? 'desktop-sess-1' : null),
    );
    mocks.dbSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: 'desktop-sess-1',
              agentKind: 'cc',
              workingDir: '/tmp/desktop-wd',
              model: 'claude-opus-4-7',
              effort: 'xhigh',
              permissionMode: 'auto',
              fastMode: false,
              sdkSessionId: 'sdk-1',
              title: 'T',
            },
          ],
        }),
      }),
    });
    await runTurn('300.3');
    // 接管路由: 不经 repo 建行, 直接 wire desktop session + IPC fanout
    expect(fakeRepo.createSession).not.toHaveBeenCalled();
    expect(harnesses.get('desktop-sess-1')!.send).toHaveBeenCalledTimes(1);
    expect(harnesses.get('desktop-sess-1')!.send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('<cindy_delivery_context>'),
      }),
      expect.anything(),
    );
    expect(mocks.wireSessionToIpcExternal).toHaveBeenCalledTimes(1);
    // binding 验证走了带 scopeKey 的 identity
    expect(mocks.bindingGet).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'slack', scopeKey: '300.3' }),
    );
  });

  it('replacement detach keeps the old listener until its active turn drains', async () => {
    mocks.bindingGet.mockImplementation(
      (id: { scopeKey?: string }) =>
        id.scopeKey === '300.3' || id.scopeKey === '400.4' ? 'desktop-sess-1' : null,
    );
    mocks.dbSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: 'desktop-sess-1',
              agentKind: 'cc',
              workingDir: '/tmp/desktop-wd',
              model: 'claude-opus-4-7',
              effort: 'xhigh',
              permissionMode: 'auto',
              fastMode: false,
              sdkSessionId: 'sdk-1',
              title: 'T',
            },
          ],
        }),
      }),
    });
    const stream = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stream);
    await runTurn('300.3');
    const harness = harnesses.get('desktop-sess-1')!;

    runner.detachFromSession('desktop-sess-1');
    expect(harness.unsubscribe).not.toHaveBeenCalled();
    expect(mocks.installDesktopInteractionListener).not.toHaveBeenCalled();
    let rewireResolved = false;
    const rewire = runner.prewireAttachedSession('T1', 'U2', '400.4').then(() => {
      rewireResolved = true;
    });
    await Promise.resolve();
    expect(rewireResolved).toBe(false);

    harness.emit({ type: 'text', data: { text: 'late output' } } as AgentEvent);
    await vi.waitFor(() => expect(mocks.slackIm.startStreamingText).toHaveBeenCalled());
    harness.emit({ type: 'done' } as AgentEvent);

    await vi.waitFor(() => {
      expect(stream.finalize).toHaveBeenCalledWith('late output');
      expect(harness.unsubscribe).toHaveBeenCalledOnce();
      // Central InteractionRouter keeps the Session listener installed; detach
      // only releases this turn's route and must not overwrite the listener.
      expect(mocks.installDesktopInteractionListener).not.toHaveBeenCalled();
    });
    await rewire;
    expect(rewireResolved).toBe(true);
  });

  it('新 thread 首条消息: 名片卡先发进 thread, 续聊不再发', async () => {
    await runTurn('100.1');
    expect(mocks.slackIm.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(mocks.slackIm.sendInteractiveCard).toHaveBeenCalledWith(
      'U1',
      expect.objectContaining({
        title: slackUi.thread!.sessionHeaderCard.title,
        buttons: [],
      }),
      { threadTs: '100.1' },
    );
    // 第一轮收口后续聊 — 不重复发名片
    harnesses.get('slack_T1_U1_100_1')!.emit({ type: 'done' } as AgentEvent);
    await runTurn('100.1', 'follow-up');
    expect(mocks.slackIm.sendInteractiveCard).toHaveBeenCalledTimes(1);
  });

  it('标题生成后: 名片卡升级为正式标题(渠道前缀透传)', async () => {
    mocks.generateAndPersistFbotTitle.mockResolvedValue('Slack · 修复登录');
    await runTurn('100.1');
    await vi.waitFor(() => {
      expect(mocks.slackIm.updateInteractiveCard).toHaveBeenCalledWith(
        'C1|hdr',
        expect.objectContaining({
          title: slackUi.thread!.sessionHeaderTitled('Slack · 修复登录').title,
        }),
      );
    });
    expect(mocks.generateAndPersistFbotTitle).toHaveBeenCalledWith(
      'slack_T1_U1_100_1',
      'hello',
      'Slack · ',
    );
  });

  it('新建+接管: 标题生成后锚点卡升级为正式标题(保留退出按钮)', async () => {
    mocks.bindingGet.mockImplementation(
      (id: { scopeKey?: string }) => (id.scopeKey === '400.4' ? 'desktop-new-1' : null),
    );
    mocks.bindingGetAttachCardMessageId.mockReturnValue('C1|anchor');
    // resolveRouteTarget 的 row 查询与标题草稿检查共用同一条 select 链 —
    // title = 'FBot · New' 草稿占位触发生成
    mocks.dbSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: 'desktop-new-1',
              agentKind: 'cc',
              workingDir: '/tmp/desktop-wd',
              model: 'claude-opus-4-7',
              effort: 'xhigh',
              permissionMode: 'auto',
              fastMode: false,
              sdkSessionId: null,
              title: 'FBot · New',
            },
          ],
        }),
      }),
    });
    mocks.generateAndPersistFbotTitle.mockResolvedValue('Slack · 新功能');
    await runTurn('400.4', '帮我做个新功能');
    await vi.waitFor(() => {
      expect(mocks.slackIm.updateInteractiveCard).toHaveBeenCalledWith(
        'C1|anchor',
        expect.objectContaining({
          title: slackUi.thread!.takeoverCard('Slack · 新功能', 'desktop-wd').title,
          buttons: [expect.objectContaining({ id: 'control:thread-exit' })],
        }),
      );
    });
    // 接管路径与渠道默认会话同名族: 无渠道拼装(slack)时透传渠道前缀,
    // 与「标题生成后: 名片卡升级」用例的 'Slack · ' 前缀一致。
    expect(mocks.generateAndPersistFbotTitle).toHaveBeenCalledWith(
      'desktop-new-1',
      '帮我做个新功能',
      'Slack · ',
    );
  });
});

describe('turnRunner 自动任务转播(scheduler turn → 远程控制 thread)', () => {
  /** 接管 desktop-sess-1 到 thread 300.3,并清掉用户首轮,使后续 scheduler 事件走 stray。 */
  async function attachAndIdle(): Promise<SessionHarness> {
    mocks.bindingGet.mockImplementation(
      (id: { scopeKey?: string }) => (id.scopeKey === '300.3' ? 'desktop-sess-1' : null),
    );
    mocks.dbSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: 'desktop-sess-1',
              agentKind: 'cc',
              workingDir: '/tmp/desktop-wd',
              model: 'claude-opus-4-7',
              effort: 'xhigh',
              permissionMode: 'auto',
              fastMode: false,
              sdkSessionId: 'sdk-1',
              title: 'T',
            },
          ],
        }),
      }),
    });
    await runTurn('300.3');
    const h = harnesses.get('desktop-sess-1')!;
    h.emit({ type: 'done' } as AgentEvent); // 收口用户首轮 → queue 空,后续走 stray
    mocks.slackIm.startStreamingText.mockClear();
    return h;
  }

  const schedulerOrigin = { kind: 'scheduler', scheduleId: 's1', scheduleName: 'PR #118 跟进' };
  const withOrigin = (e: Partial<AgentEvent>): AgentEvent =>
    ({ ...e, turnOrigin: schedulerOrigin }) as AgentEvent;

  it('scheduler stray 事件 → 在接管 thread 开转播卡,带任务名 + 步骤 + 流式结果', async () => {
    const stub = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    const h = await attachAndIdle();

    h.emit(withOrigin({ type: 'tool_use', data: { toolName: 'Read', input: { file_path: '/x/a.ts' } } }));
    h.emit(withOrigin({ type: 'text', data: { text: '检查完毕,无新变化', isFinal: true } }));

    await vi.waitFor(() => {
      // 转播卡开在接管 thread(threadTs = scopeKey 300.3)
      expect(mocks.slackIm.startStreamingText).toHaveBeenCalledWith('U1', undefined, {
        threadTs: '300.3',
      });
      // 卡片正文含任务名 + 工具步骤 + 结果文本
      const lastReplace = stub.replace.mock.calls.at(-1)?.[0] as string;
      expect(lastReplace).toContain('🤖 自动任务「PR #118 跟进」');
      expect(lastReplace).toContain('读取 a.ts');
      expect(lastReplace).toContain('检查完毕,无新变化');
    });

    // continuation 的 SDK done 只封存中间段,不能提前 finalize scheduler 卡。
    h.emit(withOrigin({ type: 'done', data: {}, turnContinuationId: 1 }));
    await new Promise((r) => setTimeout(r, 10));
    expect(stub.finalize).not.toHaveBeenCalled();

    h.emit(withOrigin({ type: 'text', data: { text: '\n续跑后最终结果', isFinal: false } }));
    // done 收口:finalize 去掉步骤,只留任务名 + 结果
    h.emit(withOrigin({ type: 'done', data: {} }));
    await vi.waitFor(() => {
      const finalBody = (stub.finalize.mock.calls.at(-1) as unknown[] | undefined)?.[0] as string;
      expect(finalBody).toContain('🤖 自动任务「PR #118 跟进」');
      expect(finalBody).toContain('检查完毕,无新变化');
      expect(finalBody).toContain('续跑后最终结果');
      expect(finalBody).not.toContain('工作中'); // 过程区已去掉
    });
  });

  it('非 scheduler 的 stray(desktop 自发 turn,无 turnOrigin)→ 不转播', async () => {
    const stub = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    const h = await attachAndIdle();

    // 无 turnOrigin 的 stray 文本(desktop 用户自己在桌面端发起)
    h.emit({ type: 'text', data: { text: 'desktop 自发', isFinal: true } } as AgentEvent);
    h.emit({ type: 'done' } as AgentEvent);

    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.slackIm.startStreamingText).not.toHaveBeenCalled();
    expect(stub.replace).not.toHaveBeenCalled();
  });

  it('可重试 error(willRetry,非终止)不收口转播卡;后随 done 才收口(单卡,不开第二张)', async () => {
    const stub = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    const h = await attachAndIdle();

    // 先开卡(一个工具步骤)
    h.emit(withOrigin({ type: 'tool_use', data: { toolName: 'Read', input: { file_path: '/x/a.ts' } } }));
    // 可重试 error:turn 仍在继续,不能收口卡片
    h.emit(withOrigin({ type: 'error', data: { message: 'transient 502', willRetry: true } }));
    await vi.waitFor(() => {
      expect(mocks.slackIm.startStreamingText).toHaveBeenCalledTimes(1); // 卡已开
    });
    expect(stub.finalize).not.toHaveBeenCalled(); // ★ 可重试 error 不 finalize

    // 重试成功 → 终止 done 才收口
    h.emit(withOrigin({ type: 'text', data: { text: '重试后成功', isFinal: true } }));
    h.emit(withOrigin({ type: 'done', data: {} }));
    await vi.waitFor(() => {
      expect(stub.finalize).toHaveBeenCalledTimes(1);
    });
    // 全程只开了一张卡(没有因 error 过早收口后又惰性开第二张)
    expect(mocks.slackIm.startStreamingText).toHaveBeenCalledTimes(1);
    const finalBody = (stub.finalize.mock.calls.at(-1) as unknown[] | undefined)?.[0] as string;
    expect(finalBody).toContain('重试后成功');
  });
});
