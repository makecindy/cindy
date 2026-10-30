/**
 * turnRunner: 连接交给伙伴后的路由(整合方案 §7.2)。
 *
 *  - 未交出 → 原有渠道行(不碰伙伴路由);
 *  - 主人私聊 → 伙伴主任务(不注入渠道 vendorOptions, 按共享任务给投递说明);
 *  - 群 / 话题 → 伙伴 channel 专线(route key 按 chat / topic, 照常挂渠道工具);
 *  - 伙伴任务不跟随渠道默认、不对齐渠道默认路由;
 *  - 伙伴解析不出 → 回落原有渠道路由, 每个连接只告警一次;
 *  - 发送前伙伴守卫拒绝 → 回一句提示, 不发送;
 *  - 停止 / `/new` 走同一解析, 停止不建行。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, MakerEvent, Session, SessionSendResult, TurnPermissionPolicy } from '@cindy/maker-core';
import type { ChannelIM } from '@cindy/im';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  im: {
    reactToMessage: vi.fn(),
    removeMessageReaction: vi.fn(),
    sendText: vi.fn(),
    sendMarkdownText: vi.fn(),
    sendFile: vi.fn(async () => ({ ok: true, messageId: 'file' })),
    startStreamingText: vi.fn(),
    patchMarkdownCard: vi.fn(),
    sendInteractiveCard: vi.fn(),
    updateInteractiveCard: vi.fn(),
  },
  getMaker: vi.fn(),
  listProviders: vi.fn(),
  readXdGatewayApiKey: vi.fn(),
  bindingGet: vi.fn(),
  bindingDetach: vi.fn(),
  touchUserSent: vi.fn(),
  persistUserMessage: vi.fn(),
  wireSessionToIpcExternal: vi.fn(),
  takePendingInteractionsForSession: vi.fn(() => []),
  noteSilentStopUserSend: vi.fn(),
  stopSessionTurnExplicitly: vi.fn(async (sessionId: string): Promise<void> => {
    await (mocks.getMaker() as { getSession(id: string): { abort(): Promise<void> } | undefined })
      .getSession(sessionId)
      ?.abort();
  }),
  onSilentStopSettled: vi.fn(() => vi.fn()),
  rejectAllPending: vi.fn(() => []),
  dbSelect: vi.fn(),
}));

vi.mock('../../../logger', () => ({ createLogger: () => mocks.logger }));
vi.mock('../../../maker-host', () => ({ getMaker: mocks.getMaker }));
vi.mock('../../../maker-host/createDesktopProviderService', () => ({
  getDesktopProviderService: () => ({ listProviders: mocks.listProviders }),
}));
vi.mock('../../../localDb/client/current', () => ({
  getDbClient: vi.fn(() => ({ drizzle: { select: mocks.dbSelect, update: vi.fn() } })),
}));
vi.mock('../../../localDb/schema', () => ({ sessions: {} }));
vi.mock('../sessionRepo', () => ({
  touchUserSent: mocks.touchUserSent,
  toCoreAgentKind: (kind: string) => (kind === 'codex' ? 'codex' : 'claude-code'),
}));
vi.mock('../../messagePersistence', () => ({ persistUserMessage: mocks.persistUserMessage }));
vi.mock('../../binding', () => ({
  bindingStore: { get: mocks.bindingGet, detach: mocks.bindingDetach },
}));
vi.mock('../../../maker-ipc/register', () => ({
  wireSessionToIpcExternal: mocks.wireSessionToIpcExternal,
  takePendingInteractionsForSession: mocks.takePendingInteractionsForSession,
  noteSilentStopUserSend: mocks.noteSilentStopUserSend,
  stopSessionTurnExplicitly: mocks.stopSessionTurnExplicitly,
  onSilentStopSettled: mocks.onSilentStopSettled,
  beginTurnChangeSetAtDispatch: vi.fn(async () => undefined),
}));
vi.mock('../pendingInteractions', () => ({
  registerPending: vi.fn(),
  registerPendingExternal: vi.fn(),
  rejectAllPending: mocks.rejectAllPending,
}));
vi.mock('../apiKey', () => ({ readXdGatewayApiKey: mocks.readXdGatewayApiKey }));

import { createTurnRunner, type ImTurnRunner } from '../turnRunner';
import type { ImCardBuilders } from '../cardBuilders';
import type { ImSessionRepo, ImSessionRow } from '../sessionRepo';
import type { ImChannelAdapter } from '../types';
import type { ImCompanionRouteDeps } from '../imBotBindingRoute';
import { ui as telegramUi } from '../../telegram/uiText';

interface SessionHarness {
  session: Session;
  send: ReturnType<typeof vi.fn>;
  emit(event: AgentEvent): void;
}

function makeSessionHarness(sessionId: string): SessionHarness {
  const listeners: Array<(event: AgentEvent) => void> = [];
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
    workDir: '/tmp/wd',
    agentKind: 'claude-code',
    instanceId: `${sessionId}-instance`,
    abort: vi.fn(async () => undefined),
    send,
    isTurnRunning: vi.fn(() => false),
    onEvent(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    setInteractionListener: vi.fn(),
    acquireTurnLease: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Session;
  return {
    session,
    send,
    emit(event: AgentEvent) {
      for (const l of [...listeners]) l(event);
    },
  };
}

const harnesses = new Map<string, SessionHarness>();
const createSessionArgs: Array<Record<string, unknown>> = [];

function rowFor(id: string, overrides: Partial<ImSessionRow> = {}): ImSessionRow {
  return {
    id,
    agentKind: 'claude-code',
    workingDir: '/tmp/wd',
    model: 'claude-opus-4-7',
    effort: 'xhigh',
    permissionMode: 'auto',
    fastMode: false,
    sdkSessionId: null,
    providerId: null,
    ...overrides,
  };
}

const legacyRows = new Map<string, ImSessionRow>();
const botRows = new Map<string, ImSessionRow>();
const legacyIdFor = (bot: string, user: string) => `telegram_${bot}_${user.replace(/\//g, '-')}`;

const fakeRepo: ImSessionRepo = {
  sessionIdFor: legacyIdFor,
  peekSession: async () => null,
  peekSessionById: vi.fn(async (id: string) => botRows.get(id) ?? legacyRows.get(id) ?? null),
  findActiveSession: vi.fn(async (bot: string, user: string) => legacyRows.get(legacyIdFor(bot, user)) ?? null),
  prepareNewSession: vi.fn(async (bot: string, user: string) => rowFor(legacyIdFor(bot, user))),
  createSession: vi.fn(async (bot: string, user: string) => {
    const row = rowFor(legacyIdFor(bot, user));
    legacyRows.set(row.id, row);
    return row;
  }),
  getDefaultEffortFor: () => 'high',
};

const fakeCards = {} as unknown as ImCardBuilders;

const fakeAdapter: ImChannelAdapter = {
  channel: 'telegram',
  im: mocks.im as unknown as ChannelIM,
  output: { kind: 'rich-card', im: mocks.im as unknown as ChannelIM },
  config: { agentKind: 'claude-code', defaultModel: 'claude-opus-4-7', defaultPermissionMode: 'auto' },
  ui: telegramUi,
  sessions: {
    source: 'telegram',
    sessionIdFor: legacyIdFor,
    createTaskOnNew: true,
    defaultTitle: (userId) => (userId.startsWith('g/') ? `[TG·群] ${userId.slice(-6)}` : `[TG·DM] ${userId.slice(-6)}`),
    workspaceKind: 'dialogue',
    ensureWorkingDir: () => '/tmp/wd',
    extraInsertColumns: () => ({}),
  },
  processingEmoji: '👀',
  buildVendorOptions: (userId) => ({ telegramChatId: userId, source: 'telegram' }),
  companionLane: (userId) => {
    if (!userId.startsWith('g/')) return { kind: 'owner-dm' };
    const [chatId, threadId = ''] = userId.slice(2).split('/');
    return { kind: 'group', chatId: chatId!, threadId };
  },
};

const BOT_CONTEXT = '777';
const OWNER = '4242';

let binding: string | null;
let companion: {
  readBinding: ReturnType<typeof vi.fn>;
  resolveSession: ReturnType<typeof vi.fn>;
  archiveLane: ReturnType<typeof vi.fn>;
  prepareSend: ReturnType<typeof vi.fn>;
};
let acquirePendingAgentSwitch: ReturnType<typeof vi.fn>;
let previewSwitchTarget: ReturnType<typeof vi.fn>;
let runner: ImTurnRunner;

function streamingHandleStub() {
  return {
    messageId: 'm-1',
    append: vi.fn(),
    replace: vi.fn(),
    finalize: vi.fn(async (): Promise<void> => undefined),
    addExtraImageAbsPath: vi.fn(),
    close: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  harnesses.clear();
  legacyRows.clear();
  botRows.clear();
  createSessionArgs.length = 0;
  binding = 'bot-mimi';
  botRows.set('mimi-main', rowFor('mimi-main', { model: 'bot-model', permissionMode: 'ask' }));
  mocks.readXdGatewayApiKey.mockReturnValue('sk-test');
  mocks.listProviders.mockResolvedValue([
    {
      id: 'xd',
      name: 'XD',
      source: 'builtin',
      connected: true,
      agents: ['claude-code'],
      models: { 'claude-code': [{ id: 'claude-opus-4-7' }, { id: 'bot-model' }] },
      routing: { 'claude-code': { upstream: 'https://gateway.example', authStrategy: 'gateway-key' } },
    },
  ]);
  mocks.bindingGet.mockReturnValue(null);
  mocks.im.reactToMessage.mockResolvedValue('👀');
  mocks.im.removeMessageReaction.mockResolvedValue(undefined);
  mocks.im.sendText.mockResolvedValue({ messageId: 'm' });
  mocks.im.sendMarkdownText.mockResolvedValue({ messageId: 'm' });
  mocks.im.startStreamingText.mockResolvedValue(streamingHandleStub());
  mocks.persistUserMessage.mockResolvedValue({ clientId: 'client-1' });
  mocks.dbSelect.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: async () => [],
      }),
    }),
  }));
  mocks.getMaker.mockReturnValue({
    getSession: vi.fn((id: string) => harnesses.get(id)?.session),
    on: vi.fn(() => () => undefined),
    createSession: vi.fn(async (args: { id?: string }) => {
      createSessionArgs.push(args as Record<string, unknown>);
      const id = args.id ?? 'anon';
      let h = harnesses.get(id);
      if (!h) {
        h = makeSessionHarness(id);
        harnesses.set(id, h);
      }
      return h.session;
    }),
  });
  companion = {
    readBinding: vi.fn((botContextId: string) => (botContextId === BOT_CONTEXT ? binding : null)),
    resolveSession: vi.fn(async ({ target }: Parameters<ImCompanionRouteDeps['resolveSession']>[0]) => {
      if (target.kind === 'canonical') return { ok: true, sessionId: 'mimi-main', created: false };
      const id = `lane:${target.routeKey}`;
      const created = !botRows.has(id);
      botRows.set(id, rowFor(id, { model: 'bot-model', permissionMode: 'ask' }));
      return { ok: true, sessionId: id, created };
    }),
    archiveLane: vi.fn(async (routeKey: string) => {
      const id = `lane:${routeKey}`;
      if (!botRows.has(id)) return [];
      botRows.delete(id);
      return [id];
    }),
    prepareSend: vi.fn(async () => null),
  };
  acquirePendingAgentSwitch = vi.fn(async () => () => undefined);
  previewSwitchTarget = vi.fn(async () => null);
  runner = createTurnRunner(fakeAdapter, fakeRepo, fakeCards, {
    companion: companion as unknown as ImCompanionRouteDeps,
    channelDefaultRoute: { previewSwitchTarget, syncBeforeWiring: vi.fn(async () => undefined) },
  });
});

async function runTurn(userId: string, text = 'hello'): Promise<void> {
  await runner.runAgentTurn({
    botContextId: BOT_CONTEXT,
    userId,
    userMessageId: `${userId}|${text}`,
    text,
    attachments: [],
    ...(userId === OWNER ? { requesterIsOwner: true } : {}),
  });
}

describe('turnRunner: connection handed to a companion bot', () => {
  it('keeps the channel’s own routing for an unbound connection', async () => {
    binding = null;
    await runTurn(OWNER, 'first');
    harnesses.get(legacyIdFor(BOT_CONTEXT, OWNER))!.emit({ type: 'done', data: {} } as AgentEvent);
    await runTurn(OWNER, 'second');
    expect(companion.resolveSession).not.toHaveBeenCalled();
    expect(fakeRepo.createSession).toHaveBeenCalledTimes(1);
    expect(harnesses.get(legacyIdFor(BOT_CONTEXT, OWNER))!.send).toHaveBeenCalledTimes(2);
    // An existing channel-owned row still follows the channel default route.
    expect(previewSwitchTarget).toHaveBeenCalledTimes(1);
    expect(createSessionArgs[0]!.vendorOptions).toEqual({ telegramChatId: OWNER, source: 'telegram' });
  });

  it('routes the owner DM into the bot’s canonical session without channel vendor options', async () => {
    await runTurn(OWNER);
    expect(companion.resolveSession).toHaveBeenCalledWith({
      botId: 'bot-mimi',
      target: { kind: 'canonical' },
      create: true,
    });
    expect(fakeRepo.findActiveSession).not.toHaveBeenCalled();
    expect(fakeRepo.createSession).not.toHaveBeenCalled();
    // Bot sessions keep their own route; no channel-default following.
    expect(previewSwitchTarget).not.toHaveBeenCalled();
    expect(createSessionArgs).toHaveLength(1);
    expect(createSessionArgs[0]).toMatchObject({ id: 'mimi-main', model: 'bot-model', permissionMode: 'ask' });
    expect(createSessionArgs[0]!.vendorOptions).toBeUndefined();
    expect(createSessionArgs[0]!.title).toBeUndefined();
    const h = harnesses.get('mimi-main')!;
    expect(h.send).toHaveBeenCalledTimes(1);
    // Shared with Desktop → the model is told replies are delivered automatically.
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('<cindy_delivery_context>') }),
      expect.anything(),
    );
    expect(companion.prepareSend).toHaveBeenCalledWith('mimi-main');
  });

  it('routes a group and a topic into their own channel lanes with channel tools mounted', async () => {
    await runTurn('g/-100123');
    await runTurn('g/-100123/9');
    expect(companion.resolveSession).toHaveBeenNthCalledWith(1, {
      botId: 'bot-mimi',
      target: { kind: 'channel', routeKey: 'im:telegram:777:g:-100123', title: '[TG·群] 100123' },
      create: true,
    });
    expect(companion.resolveSession).toHaveBeenNthCalledWith(2, {
      botId: 'bot-mimi',
      target: { kind: 'channel', routeKey: 'im:telegram:777:g:-100123:t:9', title: '[TG·群] 0123/9' },
      create: true,
    });
    expect(fakeRepo.createSession).not.toHaveBeenCalled();
    expect(createSessionArgs.map((args) => args.id)).toEqual([
      'lane:im:telegram:777:g:-100123',
      'lane:im:telegram:777:g:-100123:t:9',
    ]);
    expect(createSessionArgs[0]!.vendorOptions).toEqual({ telegramChatId: 'g/-100123', source: 'telegram' });
    expect(createSessionArgs[0]!.title).toBeUndefined();
    const laneSend = harnesses.get('lane:im:telegram:777:g:-100123')!.send;
    expect(laneSend).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.not.stringContaining('<cindy_delivery_context>') }),
      expect.anything(),
    );
    expect(previewSwitchTarget).not.toHaveBeenCalled();
  });

  it('does not align bot sessions with the channel default route under the send lock', async () => {
    runner = createTurnRunner(fakeAdapter, fakeRepo, fakeCards, {
      companion: companion as unknown as ImCompanionRouteDeps,
      acquirePendingAgentSwitch,
    });
    mocks.dbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ ...botRows.get('mimi-main'), status: 'active' }],
        }),
      }),
    }));
    await runTurn(OWNER);
    expect(acquirePendingAgentSwitch).toHaveBeenCalledWith('mimi-main', { channelOwned: false });
    // The bot guard runs before the send lock is taken.
    expect(companion.prepareSend.mock.invocationCallOrder[0]!)
      .toBeLessThan(acquirePendingAgentSwitch.mock.invocationCallOrder[0]!);
  });

  it('keeps the turn alive when the bot guard applies the pending agent switch and closes the live session', async () => {
    // reconcileBotModelRoute applies the staged switch immediately on an idle task:
    // the live session closes with reason 'agent-switch' *inside* prepareSend, before
    // the send lock's own suppression window. The runner must not forget the task.
    const listeners: Array<(event: MakerEvent) => void> = [];
    const switched = makeSessionHarness('mimi-main');
    let live: Session | undefined;
    const base = mocks.getMaker() as {
      createSession: (args: { id?: string }) => Promise<Session>;
    };
    mocks.getMaker.mockReturnValue({
      createSession: base.createSession,
      getSession: vi.fn((id: string) => live ?? harnesses.get(id)?.session),
      on: vi.fn((listener: (event: MakerEvent) => void) => {
        listeners.push(listener);
        return () => undefined;
      }),
    });
    companion.prepareSend.mockImplementation(async () => {
      const old = harnesses.get('mimi-main')!.session;
      live = switched.session;
      for (const listener of [...listeners]) {
        listener({ type: 'session:closed', sessionId: 'mimi-main', session: old, reason: 'agent-switch' });
      }
      return null;
    });
    mocks.dbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ ...botRows.get('mimi-main'), status: 'active' }],
        }),
      }),
    }));
    runner = createTurnRunner(fakeAdapter, fakeRepo, fakeCards, {
      companion: companion as unknown as ImCompanionRouteDeps,
      acquirePendingAgentSwitch,
    });

    await runTurn(OWNER);

    expect(harnesses.get('mimi-main')!.send).not.toHaveBeenCalled();
    expect(switched.send).toHaveBeenCalledTimes(1);
    for (const [, text] of mocks.im.sendText.mock.calls) expect(String(text)).not.toContain('❌');
    expect(runner.getMakerSessionById('mimi-main')).toBe(switched.session);
  });

  it('runs the shared pre-send context check between the bot guard and the send lock, and rebinds the refreshed session', async () => {
    // prepareUnhealthySessionForSend closes the live handle with reason 'runtime-refresh'
    // (idle-gap / pressure rebuild). The runner must keep the task, recreate the session from
    // the DB row and send this message to the new handle.
    const listeners: Array<(event: MakerEvent) => void> = [];
    const rebuilt = makeSessionHarness('mimi-main');
    let live: Session | undefined;
    const base = mocks.getMaker() as {
      createSession: (args: { id?: string }) => Promise<Session>;
    };
    mocks.getMaker.mockReturnValue({
      createSession: vi.fn(async (args: { id?: string }) => {
        if (args.id === 'mimi-main' && live === null) {
          live = rebuilt.session;
          return rebuilt.session;
        }
        return base.createSession(args);
      }),
      getSession: vi.fn((id: string) => (live === null ? undefined : live ?? harnesses.get(id)?.session)),
      on: vi.fn((listener: (event: MakerEvent) => void) => {
        listeners.push(listener);
        return () => undefined;
      }),
    });
    const prepareUnhealthySession = vi.fn(async (sessionId: string) => {
      const old = harnesses.get('mimi-main')!.session;
      live = null as unknown as Session | undefined;
      for (const listener of [...listeners]) {
        listener({ type: 'session:closed', sessionId, session: old, reason: 'runtime-refresh' });
      }
    });
    mocks.dbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ ...botRows.get('mimi-main'), status: 'active', sdkSessionId: null }],
        }),
      }),
    }));
    runner = createTurnRunner(fakeAdapter, fakeRepo, fakeCards, {
      companion: companion as unknown as ImCompanionRouteDeps,
      acquirePendingAgentSwitch,
      prepareUnhealthySession,
    });

    await runTurn(OWNER);

    expect(prepareUnhealthySession).toHaveBeenCalledWith('mimi-main');
    expect(companion.prepareSend.mock.invocationCallOrder[0]!)
      .toBeLessThan(prepareUnhealthySession.mock.invocationCallOrder[0]!);
    expect(prepareUnhealthySession.mock.invocationCallOrder[0]!)
      .toBeLessThan(acquirePendingAgentSwitch.mock.invocationCallOrder[0]!);
    expect(harnesses.get('mimi-main')!.send).not.toHaveBeenCalled();
    expect(rebuilt.send).toHaveBeenCalledTimes(1);
    for (const [, text] of mocks.im.sendText.mock.calls) expect(String(text)).not.toContain('❌');
    expect(runner.getMakerSessionById('mimi-main')).toBe(rebuilt.session);
  });

  // Use the public runner and inspect Session.send: a binding alone must never
  // suppress the policy on fallback. No network or extra runtime is required.
  it.each([
    { route: 'companion', owner: true, optIn: true, forced: false },
    { route: 'companion', owner: false, optIn: true, forced: true },
    { route: 'companion', owner: undefined, optIn: true, forced: true },
    { route: 'companion', owner: true, optIn: false, forced: true },
    { route: 'paused', owner: true, optIn: true, forced: true },
    { route: 'missing-row', owner: true, optIn: true, forced: true },
    { route: 'unbound', owner: true, optIn: true, forced: true },
  ])('keeps the resolved-route permission boundary: %j', async ({ route, owner, optIn, forced }) => {
    if (route === 'paused') {
      companion.resolveSession.mockResolvedValue({ ok: false, errorCode: 'TARGET_BOT_INACTIVE', message: 'paused' });
    } else if (route === 'missing-row') {
      botRows.delete('mimi-main');
    } else if (route === 'unbound') {
      binding = null;
    }
    const policy: TurnPermissionPolicy = {
      origin: { kind: 'im', channel: 'wechat' },
      confirmationSurface: 'channel',
      forceConfirmToolCall: () => true,
    };
    await runner.runAgentTurn({
      botContextId: BOT_CONTEXT, userId: OWNER, userMessageId: 'permission-route',
      text: 'hello', attachments: [], requesterIsOwner: owner,
      turnPermissionPolicy: policy, inheritCompanionOwnerPermissions: optIn,
    });
    const id = route === 'companion' ? 'mimi-main' : legacyIdFor(BOT_CONTEXT, OWNER);
    const send = harnesses.get(id)!.send;
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]?.turnPermissionPolicy).toBe(forced ? policy : undefined);
  });

  it('falls back to the channel’s own routing when the bot cannot be resolved, warning once', async () => {
    companion.resolveSession.mockResolvedValue({ ok: false, errorCode: 'TARGET_BOT_INACTIVE', message: 'paused' });
    await runTurn(OWNER, 'first');
    harnesses.get(legacyIdFor(BOT_CONTEXT, OWNER))!.emit({ type: 'done', data: {} } as AgentEvent);
    await runTurn(OWNER, 'second');
    expect(fakeRepo.createSession).toHaveBeenCalledTimes(1);
    expect(harnesses.get(legacyIdFor(BOT_CONTEXT, OWNER))!.send).toHaveBeenCalledTimes(2);
    const warnings = mocks.logger.warn.mock.calls.filter(([msg]) =>
      String(msg).includes('falling back to the channel'));
    expect(warnings).toHaveLength(1);
  });

  it('replies with a notice and does not send when the bot guard blocks the turn', async () => {
    companion.prepareSend.mockResolvedValue('Bot 当前未启用，请先恢复 Bot 后再发送消息');
    await runTurn(OWNER);
    expect(harnesses.get('mimi-main')!.send).not.toHaveBeenCalled();
    expect(mocks.im.sendText).toHaveBeenCalledWith(
      OWNER,
      expect.stringContaining('伙伴现在接不了消息'),
      expect.anything(),
    );
    expect(mocks.persistUserMessage).not.toHaveBeenCalled();
  });

  it('stops only an existing bot task and never creates one or touches the legacy row', async () => {
    companion.resolveSession.mockImplementation(async ({ create }: { create: boolean }) =>
      (create ? { ok: true, sessionId: 'mimi-main', created: false } : null));
    await expect(runner.stopActiveTurn({ botContextId: BOT_CONTEXT, userId: OWNER }))
      .resolves.toEqual({ stopped: false, droppedQueued: 0 });
    expect(companion.resolveSession).toHaveBeenCalledWith(expect.objectContaining({ create: false }));
    expect(fakeRepo.findActiveSession).not.toHaveBeenCalled();
  });

  it('`/new` rotates a group lane but never the owner’s canonical session', async () => {
    await runTurn('g/-100123');
    const before = 'lane:im:telegram:777:g:-100123';
    expect(harnesses.has(before)).toBe(true);

    await expect(runner.rotateCompanionLane!(BOT_CONTEXT, 'g/-100123')).resolves.toBe('rotated');
    expect(companion.archiveLane).toHaveBeenCalledWith('im:telegram:777:g:-100123');
    expect(harnesses.get(before)!.session.close).toHaveBeenCalled();
    // A fresh lane is ensured for the same route key.
    expect(companion.resolveSession).toHaveBeenLastCalledWith(expect.objectContaining({ create: true }));

    await expect(runner.rotateCompanionLane!(BOT_CONTEXT, OWNER)).resolves.toBe('owner-dm');
    expect(companion.archiveLane).toHaveBeenCalledTimes(1);

    binding = null;
    await expect(runner.rotateCompanionLane!(BOT_CONTEXT, 'g/-100123')).resolves.toBe('unbound');
  });

  it('exposes the bound bot only for connections that are handed over', () => {
    expect(runner.companionBotIdFor!(BOT_CONTEXT)).toBe('bot-mimi');
    expect(runner.companionBotIdFor!('other-bot')).toBeNull();
  });

  it('keeps `/ctr` takeover precedence above the companion route', async () => {
    mocks.bindingGet.mockReturnValue('desktop-sess-1');
    mocks.dbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: async () => [{
            id: 'desktop-sess-1', agentKind: 'cc', workingDir: '/tmp/desktop', model: 'claude-opus-4-7',
            effort: 'xhigh', permissionMode: 'auto', fastMode: false, sdkSessionId: 'sdk-1', status: 'active',
          }],
        }),
      }),
    }));
    await runTurn(OWNER);
    expect(companion.resolveSession).not.toHaveBeenCalled();
    expect(harnesses.get('desktop-sess-1')!.send).toHaveBeenCalledTimes(1);
  });
});
