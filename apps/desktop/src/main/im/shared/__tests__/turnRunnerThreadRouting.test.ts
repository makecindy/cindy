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
import path from 'node:path';

import type { AgentEvent, Session, SessionSendResult } from '@cindy/maker-core';
import type { ChannelIM } from '@cindy/im';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  slackIm: {
    reactToMessage: vi.fn(),
    removeMessageReaction: vi.fn(),
    sendText: vi.fn(),
    sendMarkdownText: vi.fn(),
    sendFile: vi.fn(async () => ({ ok: true, messageId: 'file' })),
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
  // 与生产同语义的最小替身: 统一停止按 id 取**当前** runtime 并中止(唯一的一次 abort)。
  stopSessionTurnExplicitly: vi.fn(async (sessionId: string): Promise<void> => {
    await (mocks.getMaker() as { getSession(id: string): { abort(): Promise<void> } | undefined })
      .getSession(sessionId)
      ?.abort();
  }),
  onSilentStopSettled: vi.fn((_sessionId: string, _cb: () => void) => vi.fn()),
  rejectAllPending: vi.fn<(reason: string, owner?: symbol) => Array<{ requestId: string; messageId: string }>>(() => []),
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
  stopSessionTurnExplicitly: mocks.stopSessionTurnExplicitly,
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

import { ImAccountScopeClosedError } from '../../accountBoundary';
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
    workDir: '/tmp/slack-wd',
    agentKind: 'claude-code',
    abort: vi.fn(async () => undefined),
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
    finalize: vi.fn(async (): Promise<void> => undefined),
    addExtraImageAbsPath: vi.fn(),
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
    getSession: vi.fn((id: string) => harnesses.get(id)?.session),
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

describe('turnRunner 渠道任务后台结果回传', () => {
  it.each(['next-background', 'dispose'] as const)('keeps delivery busy until the last result settles across %s', async (action) => {
    const h = await channelAndIdle();
    h.send.mockClear();
    const stub = streamingHandleStub();
    let release!: () => void;
    stub.finalize.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    h.emit({ type: 'text', data: { text: 'first background' } });
    h.emit({ type: 'done', data: {} });
    await vi.waitFor(() => expect(stub.finalize).toHaveBeenCalledTimes(1));
    if (action === 'next-background') {
      h.emit({ type: 'text', data: { text: 'second background' } });
      h.emit({ type: 'done', data: {} });
      await vi.waitFor(() => expect(stub.finalize).toHaveBeenCalledTimes(2));
    }
    await runTurn('100.1', 'arrives during delivery');
    expect(h.send).not.toHaveBeenCalled();
    if (action === 'dispose') await runner.disposeAllSessions();
    release();
    if (action === 'next-background') {
      await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
      h.emit({ type: 'done', data: {} });
    } else {
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.send).not.toHaveBeenCalled();
    }
  });

  it.each(['done', 'error', 'settled'].flatMap((ending) => [false, true].map((fail) => ({ ending, fail }))))(
    'holds queued input through background final delivery (ending=$ending, fail=$fail)', async ({ ending, fail }) => {
    const h = await channelAndIdle();
    h.send.mockClear();
    const stub = streamingHandleStub();
    let release!: () => void;
    stub.finalize.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      release = () => fail ? reject(new Error('delivery failed')) : resolve();
    }));
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    let settled!: () => void;
    if (ending === 'settled') {
      mocks.onSilentStopSettled.mockImplementationOnce((_id, cb) => { settled = cb; return vi.fn(); });
    }
    h.emit({ type: 'text', data: { text: 'background' } });
    await runTurn('100.1', 'queued before completion');
    if (ending === 'settled') {
      h.emit({ type: 'done', data: { silentStop: true } });
      settled();
    } else if (ending === 'error') {
      h.emit({ type: 'error', data: { message: 'failed', isTerminal: true } });
    } else h.emit({ type: 'done', data: {} });
    await vi.waitFor(() => expect(stub.finalize).toHaveBeenCalledTimes(1));
    await runTurn('100.1', 'queued during delivery');
    expect(h.send).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    expect(h.send.mock.calls[0]![0]).toEqual(expect.objectContaining({
      content: expect.stringContaining('queued before completion'),
    }));
    h.emit({ type: 'done', data: {} });
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    h.emit({ type: 'done', data: {} });
  });

  it.each(['done', 'settled'] as const)('silent stop keeps queued input out of the resumed turn until %s', async (ending) => {
    const h = await channelAndIdle();
    h.send.mockClear();
    const stub = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    let settled!: () => void;
    mocks.onSilentStopSettled.mockImplementationOnce((_id, cb) => { settled = cb; return vi.fn(); });
    h.emit({ type: 'text', data: { text: 'background' } });
    h.emit({ type: 'done', data: { silentStop: true } });
    await runTurn('100.1', 'queued input');
    expect(h.send).not.toHaveBeenCalled();
    h.emit({ type: 'text', data: { text: ' resumed' } });
    if (ending === 'done') h.emit({ type: 'done', data: {} });
    else settled();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(stub.finalize).toHaveBeenCalledWith('background resumed'));
    h.emit({ type: 'done', data: {} });
  });

  it.each(['done', 'settled', 'error', 'dispose'] as const)('silent stop waits for %s and ignores late settlement', async (ending) => {
    const h = await channelAndIdle();
    const stub = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    const unsubscribe = vi.fn();
    let settled!: () => void;
    mocks.onSilentStopSettled.mockImplementationOnce((_id, cb) => { settled = cb; return unsubscribe; });
    h.emit({ type: 'text', data: { text: 'first' } });
    h.emit({ type: 'done', data: { silentStop: true } });
    h.emit({ type: 'done', data: { silentStop: true } });
    await Promise.resolve();
    expect(stub.finalize).not.toHaveBeenCalled();
    expect(mocks.onSilentStopSettled).toHaveBeenCalledTimes(1);
    h.emit({ type: 'text', data: { text: ' resumed' } });
    if (ending === 'done') h.emit({ type: 'done', data: {} });
    else if (ending === 'error') h.emit({ type: 'error', data: { message: 'failed', isTerminal: true } });
    else if (ending === 'dispose') await runner.disposeAllSessions();
    else settled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    settled();
    if (ending === 'dispose') {
      expect(stub.finalize).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(stub.finalize).toHaveBeenCalledTimes(1));
      expect(stub.finalize).toHaveBeenCalledWith(expect.stringContaining('first resumed'));
    }
    expect(mocks.slackIm.startStreamingText).toHaveBeenCalledTimes(1);
  });

  it('换执行实例只换绑监听，保留同话题已经排队的消息', async () => {
    const old = await channelAndIdle();
    vi.mocked(old.session.isTurnRunning).mockReturnValue(true);
    await runTurn('100.1', 'queued after background');
    const next = makeSessionHarness(old.session.id);
    harnesses.set(old.session.id, next);
    runner.attachSessionOutput(next.session, 'U1');
    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    old.emit({ type: 'text', data: { text: 'stale result' } });
    expect(mocks.slackIm.startStreamingText).not.toHaveBeenCalled();
    next.emit({ type: 'done', data: {} });
    await vi.waitFor(() => expect(next.send).toHaveBeenCalledTimes(1));
    expect(next.send.mock.calls[0]![0]).toEqual(expect.objectContaining({
      content: expect.stringContaining('queued after background'),
    }));
    next.emit({ type: 'done', data: {} });
  });

  it.each(['rich-card', 'chunked-text'] as const)('%s 回传纯工具图片并去重，不依赖最终正文', async (kind) => {
    const stub = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    if (kind === 'chunked-text') {
      runner = createTurnRunner({ ...fakeAdapter, output: {
        kind, im: fakeAdapter.im, commitFinal: vi.fn(async () => undefined),
      } }, fakeRepo, fakeCards);
    }
    const h = makeSessionHarness('image-background');
    runner.attachSessionOutput(h.session, 'U1');
    const absPath = path.resolve('generated.png');
    mocks.resolveXdtImageUrl.mockReturnValue({ absPath });
    const event: AgentEvent = { type: 'tool_result_full', data: {
      fullText: JSON.stringify({ xdt_image_url: 'xdt-image://generated' }),
    } };
    h.emit(event);
    h.emit(event);
    h.emit({ type: 'done', data: {} });
    if (kind === 'rich-card') {
      await vi.waitFor(() => expect(stub.finalize).toHaveBeenCalledWith(''));
      expect(stub.addExtraImageAbsPath).toHaveBeenCalledExactlyOnceWith(absPath);
      expect(stub.addExtraImageAbsPath.mock.invocationCallOrder[0]).toBeLessThan(stub.finalize.mock.invocationCallOrder[0]!);
    } else {
      await vi.waitFor(() => expect(mocks.slackIm.sendFile).toHaveBeenCalledExactlyOnceWith('U1', absPath, undefined, { threadTs: undefined }));
      expect(mocks.slackIm.sendMarkdownText).not.toHaveBeenCalled();
    }
  });

  it('远端后台轮次不把媒体路径作为本地文件发送', async () => {
    const h = makeSessionHarness('remote-background');
    Object.assign(h.session, { remoteHostId: 'ssh-host' });
    runner.attachSessionOutput(h.session, 'U1');
    h.emit({ type: 'tool_result_full', data: { fullText: '{"xdt_image_url":"xdt-image://remote"}' } });
    h.emit({ type: 'done', data: {} });
    expect(mocks.resolveXdtImageUrl).not.toHaveBeenCalled();
    expect(mocks.slackIm.startStreamingText).not.toHaveBeenCalled();
  });

  it.each(['rich-card', 'chunked-text'] as const)('%s 远端正文引用只回传标签，不交给渠道解析本机附件', async (kind) => {
    const stub = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    if (kind === 'chunked-text') {
      runner = createTurnRunner({ ...fakeAdapter, output: {
        kind, im: fakeAdapter.im, commitFinal: vi.fn(async () => undefined),
      } }, fakeRepo, fakeCards);
    }
    const h = makeSessionHarness('remote-markdown');
    Object.assign(h.session, { remoteHostId: 'ssh-host' });
    runner.attachSessionOutput(h.session, 'U1');
    h.emit({ type: 'text', data: {
      text: '结果 ![图](xdt-image://remote.png) ![媒体](cindy-media://blobs/remote.png) [文件](xdt-file:///repo/report.txt)',
      isFinal: true,
    } });
    h.emit({ type: 'done', data: {} });
    if (kind === 'rich-card') {
      await vi.waitFor(() => expect(stub.finalize).toHaveBeenCalledWith('结果 图 媒体 文件'));
      for (const [text] of stub.replace.mock.calls) {
        expect(text).not.toMatch(/(?:xdt-image|xdt-file|cindy-media):/);
      }
    } else {
      await vi.waitFor(() => expect(mocks.slackIm.sendMarkdownText).toHaveBeenCalledWith(
        'U1', '结果 图 媒体 文件', { threadTs: undefined },
      ));
    }
    expect(mocks.resolveXdtImageUrl).not.toHaveBeenCalled();
    expect(mocks.slackIm.sendFile).not.toHaveBeenCalled();
  });

  it.each((['rich-card', 'chunked-text'] as const).flatMap((kind) =>
    [false, true].flatMap((remote) => ['done', 'error'].map((ending) => ({ kind, remote, ending }))),
  ))('strips background citations across split deltas and final snapshots ($kind, remote=$remote, $ending)', async ({ kind, remote, ending }) => {
    const stub = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    if (kind === 'chunked-text') {
      runner = createTurnRunner({ ...fakeAdapter, output: {
        kind, im: fakeAdapter.im, commitFinal: vi.fn(async () => undefined),
      } }, fakeRepo, fakeCards);
    }
    const h = makeSessionHarness('citation-background');
    if (remote) Object.assign(h.session, { remoteHostId: 'ssh-host' });
    runner.attachSessionOutput(h.session, 'U1');
    const turnOrigin = remote
      ? { kind: 'scheduler' as const, scheduleId: 's', scheduleName: 'daily' }
      : undefined;
    for (const text of ['结果\uE200ci', 'te\uE202turn0search0', '\uE201。']) {
      const previousCalls = stub.replace.mock.calls.length;
      h.emit({ type: 'text', data: { text }, turnOrigin });
      if (kind === 'rich-card') {
        await vi.waitFor(() => expect(stub.replace.mock.calls.length).toBeGreaterThan(previousCalls));
        expect(stub.replace.mock.calls.at(-1)![0]).not.toMatch(/[\uE200-\uE202]|turn0search0/);
      }
    }
    h.emit({ type: 'text', data: {
      text: '结果\uE200cite\uE202turn0search0\uE201。[来源](https://example.com)\uE200cite\uE202unfinished',
      isFinal: true,
    }, turnOrigin });
    h.emit(ending === 'done'
      ? { type: 'done', data: {}, turnOrigin }
      : { type: 'error', data: { message: 'failed', isTerminal: true }, turnOrigin });
    const body = `${remote ? '🤖 自动任务「daily」\n\n' : ''}结果。[来源](https://example.com)`;
    const expected = ending === 'error' ? `${body}\n\n${slackUi.agent.runtimeError('failed')}` : body;
    if (kind === 'rich-card') {
      await vi.waitFor(() => expect(stub.finalize).toHaveBeenCalledExactlyOnceWith(expected));
    } else {
      await vi.waitFor(() => expect(mocks.slackIm.sendMarkdownText).toHaveBeenCalledExactlyOnceWith(
        'U1', expected, { threadTs: undefined },
      ));
    }
    await runner.disposeAllSessions();
  });

  it('重启后仅恢复输出监听，不新建会话；重复恢复不会重复回复', async () => {
    const h = makeSessionHarness('cold-session');
    const stub = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    runner.attachSessionOutput(h.session, 'U1');
    runner.attachSessionOutput(h.session, 'U1');
    h.emit({ type: 'text', data: { text: '冷启动结果', isFinal: true } });
    h.emit({ type: 'done', data: {} });
    await vi.waitFor(() => expect(stub.finalize).toHaveBeenCalledWith('冷启动结果'));
    expect(mocks.slackIm.startStreamingText).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
    expect(mocks.getMaker().createSession).not.toHaveBeenCalled();
  });

  it.each([false, true])('cold takeover restores scheduler-only topic output (replace runtime: %s)', async (replace) => {
    const old = makeSessionHarness('cold-takeover');
    const route = { attached: true, scopeKey: '300.3' };
    runner.attachSessionOutput(old.session, 'U1', route);
    const h = replace ? makeSessionHarness(old.session.id) : old;
    runner.attachSessionOutput(h.session, 'U1', route);
    if (replace) expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    const stub = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    old.emit({ type: 'text', data: { text: 'desktop input' } });
    old.emit({ type: 'done', data: {} });
    h.emit({ type: 'text', data: { text: 'cross-session input' } });
    h.emit({ type: 'done', data: {} });
    expect(mocks.slackIm.startStreamingText).not.toHaveBeenCalled();
    const turnOrigin = { kind: 'scheduler' as const, scheduleId: 's', scheduleName: 'daily' };
    h.emit({ type: 'text', turnOrigin, data: { text: 'scheduled result', isFinal: true } });
    h.emit({ type: 'done', turnOrigin, data: {} });
    await vi.waitFor(() => expect(stub.finalize).toHaveBeenCalledTimes(1));
    expect(stub.finalize).toHaveBeenCalledWith(expect.stringContaining('scheduled result'));
    expect(mocks.slackIm.startStreamingText).toHaveBeenCalledExactlyOnceWith('U1', undefined, { threadTs: '300.3' });
    expect(mocks.getMaker().createSession).not.toHaveBeenCalled();
    expect(h.session.setInteractionListener).not.toHaveBeenCalled();
    runner.detachFromSession(h.session.id);
    mocks.slackIm.startStreamingText.mockClear();
    h.emit({ type: 'text', turnOrigin, data: { text: 'after detach' } });
    h.emit({ type: 'done', turnOrigin, data: {} });
    expect(mocks.slackIm.startStreamingText).not.toHaveBeenCalled();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  async function channelAndIdle(): Promise<SessionHarness> {
    await runTurn('100.1');
    const h = harnesses.get(sessionIdFor('T1', 'U1', '100.1'))!;
    const initial = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(initial);
    h.emit({ type: 'text', data: { text: '首次回复' } });
    h.emit({ type: 'done' } as AgentEvent);
    await vi.waitFor(() => expect(initial.finalize).toHaveBeenCalledTimes(1));
    mocks.slackIm.startStreamingText.mockClear();
    mocks.slackIm.sendMarkdownText.mockClear();
    return h;
  }

  it.each([
    ['自动任务', { kind: 'scheduler', scheduleId: 's1', scheduleName: '检查进度' }],
    ['其它任务消息触发的轮次', undefined],
  ] as const)('%s 的结果回到原聊天，不要求先接管', async (_name, turnOrigin) => {
    const h = await channelAndIdle();
    const stub = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    h.emit({ type: 'text', data: { text: '处理结果', isFinal: true }, turnOrigin });
    h.emit({ type: 'done', data: {}, turnOrigin });
    await vi.waitFor(() => expect(stub.finalize).toHaveBeenCalledTimes(1));
    expect(mocks.slackIm.startStreamingText).toHaveBeenCalledTimes(1);
    expect(mocks.slackIm.startStreamingText).toHaveBeenCalledWith('U1', undefined, { threadTs: '100.1' });
    expect(stub.finalize).toHaveBeenCalledWith(turnOrigin ? '🤖 自动任务「检查进度」\n\n处理结果' : '处理结果');
  });

  it('子代理及旧轮次的后台事件不回传，也不提前结束当前回复', async () => {
    const h = await channelAndIdle();
    const stub = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    for (const scope of [{ agentMeta: { parentUuid: 'child' } }, { turnScope: 'background' as const }]) {
      h.emit({ type: 'text', data: { text: '内部内容' }, ...scope });
      h.emit({ type: 'done', data: {}, ...scope });
    }
    expect(mocks.slackIm.startStreamingText).not.toHaveBeenCalled();
    h.emit({ type: 'text', data: { text: '公开结果' } });
    h.emit({ type: 'done', data: {} });
    await vi.waitFor(() => expect(stub.finalize).toHaveBeenCalledWith('公开结果'));
  });

  it('纯文本渠道仅在收口时通过适配器回传结果', async () => {
    const commitFinal = vi.fn(async () => undefined);
    runner = createTurnRunner({
      ...fakeAdapter,
      channel: 'wechat',
      output: { kind: 'chunked-text', im: fakeAdapter.im, commitFinal },
    }, fakeRepo, fakeCards);
    await runTurn('100.1');
    const h = harnesses.get(sessionIdFor('T1', 'U1', '100.1'))!;
    h.emit({ type: 'done', data: {} });
    await vi.waitFor(() => expect(commitFinal).toHaveBeenCalledTimes(1));
    mocks.slackIm.sendMarkdownText.mockClear();
    h.emit({ type: 'text', data: { text: '后台结果', isFinal: true } });
    expect(mocks.slackIm.sendMarkdownText).not.toHaveBeenCalled();
    h.emit({ type: 'done', data: {} });
    await vi.waitFor(() => expect(mocks.slackIm.sendMarkdownText).toHaveBeenCalledWith('U1', '后台结果', { threadTs: '100.1' }));
    expect(commitFinal).toHaveBeenCalledTimes(1);
    expect(mocks.slackIm.startStreamingText).not.toHaveBeenCalled();
  });

  it('断开渠道后丢弃迟到的消息句柄，避免继续回传', async () => {
    const h = await channelAndIdle();
    const stub = streamingHandleStub();
    let resolveHandle!: (handle: ReturnType<typeof streamingHandleStub>) => void;
    mocks.slackIm.startStreamingText.mockReturnValue(new Promise((resolve) => { resolveHandle = resolve; }));
    h.emit({ type: 'text', data: { text: '结果' } });
    h.emit({ type: 'done', data: {} });
    await runner.disposeAllSessions();
    resolveHandle(stub);
    await vi.waitFor(() => expect(stub.close).toHaveBeenCalled());
    expect(stub.finalize).not.toHaveBeenCalled();
    expect(stub.replace).not.toHaveBeenCalled();
  });

  it('空输出不发送，发送失败不会留下未处理的 rejection', async () => {
    const h = await channelAndIdle();
    h.emit({ type: 'status', data: { isRunning: true } });
    h.emit({ type: 'session_id', data: { sessionId: 'sdk' } });
    h.emit({ type: 'done', data: {} });
    expect(mocks.slackIm.startStreamingText).not.toHaveBeenCalled();
    mocks.slackIm.startStreamingText.mockRejectedValue(new Error('offline'));
    h.emit({ type: 'text', data: { text: '结果' } });
    h.emit({ type: 'done', data: {} });
    await vi.waitFor(() => expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('transpond finalize failed')));
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

  it('does not forward child output or settle on a child terminal during scheduled turns', async () => {
    const stub = streamingHandleStub();
    mocks.slackIm.startStreamingText.mockResolvedValue(stub);
    const h = await attachAndIdle();
    const child = { parentUuid: 'toolu_scheduled_child' };
    h.emit(withOrigin({ type: 'text', data: { text: 'internal report', isFinal: true }, agentMeta: child }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.slackIm.startStreamingText).not.toHaveBeenCalled();
    h.emit(withOrigin({ type: 'text', data: { text: 'public result', isFinal: true } }));
    await vi.waitFor(() => expect(stub.replace).toHaveBeenCalled());
    h.emit(withOrigin({ type: 'done', data: {}, agentMeta: child }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stub.finalize).not.toHaveBeenCalled();
    h.emit(withOrigin({ type: 'done', data: {} }));
    await vi.waitFor(() => expect(stub.finalize).toHaveBeenCalledWith(expect.stringContaining('public result')));
    expect(JSON.stringify(stub.replace.mock.calls)).not.toContain('internal report');
  });

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

describe('notification replies reuse the originating session without takeover', () => {
  function origin(status = 'active') {
    mocks.dbSelect.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{
      ...rowFor('original-session'), sdkSessionId: 'original-sdk-session', status,
    }] }) }) });
  }
  const reply = (scopeKey: string) => runner.runAgentTurn({
    notificationSessionId: 'original-session', botContextId: 'T1', userId: 'U1',
    userMessageId: `reply-${scopeKey}`, text: 'continue', attachments: [], scopeKey,
  });

  it('resumes the original SDK session without changing bindings or moving desktop interactions', async () => {
    origin();
    await reply('om_notification_a');
    expect(fakeRepo.createSession).not.toHaveBeenCalled();
    expect(mocks.bindingGet).not.toHaveBeenCalled();
    expect(mocks.takePendingInteractionsForSession).not.toHaveBeenCalled();
    expect(mocks.getMaker().createSession).toHaveBeenCalledWith(expect.objectContaining({
      id: 'original-session', resumeSessionId: 'original-sdk-session', vendorOptions: undefined,
    }));
    expect(harnesses.get('original-session')!.send).toHaveBeenCalledTimes(1);
  });

  it('queues different topics on the same session and sends each final result to its own root', async () => {
    origin();
    await reply('om_notification_a');
    await reply('om_notification_b');
    const h = harnesses.get('original-session')!;
    expect(h.send).toHaveBeenCalledTimes(1);
    h.emit({ type: 'text', data: { text: 'first' } } as AgentEvent);
    await vi.waitFor(() => expect(mocks.slackIm.startStreamingText).toHaveBeenCalledWith('U1', undefined, { threadTs: 'om_notification_a' }));
    h.emit({ type: 'done' } as AgentEvent);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    h.emit({ type: 'text', data: { text: 'second' } } as AgentEvent);
    await vi.waitFor(() => expect(mocks.slackIm.startStreamingText).toHaveBeenCalledWith('U1', undefined, { threadTs: 'om_notification_b' }));
    h.emit({ type: 'done' } as AgentEvent);
    expect(fakeRepo.createSession).not.toHaveBeenCalled();
  });

  it('revalidates a queued reply before invoking the original session', async () => {
    origin();
    await reply('om_notification_a');
    const revalidateNotificationReply = vi.fn(async () => { throw new Error('bot changed'); });
    await runner.runAgentTurn({
      notificationSessionId: 'original-session', revalidateNotificationReply,
      botContextId: 'T1', userId: 'U1', userMessageId: 'reply-b',
      text: 'continue', attachments: [], scopeKey: 'om_notification_b',
    });
    expect(revalidateNotificationReply).not.toHaveBeenCalled();
    const h = harnesses.get('original-session')!;
    h.emit({ type: 'done' } as AgentEvent);
    await vi.waitFor(() => expect(revalidateNotificationReply).toHaveBeenCalledTimes(1));
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(fakeRepo.createSession).not.toHaveBeenCalled();
  });

  it('discards queued account-closure errors without sending through the replacement account', async () => {
    origin();
    await reply('om_notification_a');
    await runner.runAgentTurn({
      notificationSessionId: 'original-session',
      revalidateNotificationReply: async () => { throw new ImAccountScopeClosedError(); },
      botContextId: 'T1', userId: 'U1', userMessageId: 'reply-stale',
      text: 'continue', attachments: [], scopeKey: 'om_notification_b',
    });
    mocks.slackIm.sendText.mockClear();
    const h = harnesses.get('original-session')!;
    h.emit({ type: 'done' } as AgentEvent);
    await vi.waitFor(() => expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('dispatchQueuedSend threw (queued path): [IM_NOT_READY]'),
    ));
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(mocks.slackIm.sendText).not.toHaveBeenCalledWith(
      'U1', expect.anything(), expect.objectContaining({ threadTs: 'om_notification_b' }),
    );
    expect(mocks.slackIm.removeMessageReaction.mock.calls.some(([id]) => id === 'reply-stale')).toBe(false);
  });

  it('stopping a queued topic never aborts the active turn from another topic', async () => {
    origin();
    await reply('om_notification_a');
    await reply('om_notification_b');
    const h = harnesses.get('original-session')!;
    await expect(runner.stopActiveTurn({
      notificationSessionId: 'original-session', botContextId: 'T1', userId: 'U1', scopeKey: 'om_notification_b',
    })).resolves.toEqual({ stopped: true, droppedQueued: 1 });
    expect(h.session.abort).not.toHaveBeenCalled();
    h.emit({ type: 'done' } as AgentEvent);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('rejects an archived origin rather than creating another session', async () => {
    origin('archived');
    await expect(reply('om_notification_a')).rejects.toThrow('Notification target session is unavailable');
    expect(fakeRepo.createSession).not.toHaveBeenCalled();
    expect(harnesses.size).toBe(0);
  });
});
