/**
 * turnRunner send-outcome / 消息排队回归(原 feishu runAgentTurnSendOutcome.test
 * 工厂化改写)— 断言逐条保留, 用 feishu 真实文案包 + 假 adapter 注入, 行为契约
 * 与重构前一致(characterization)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentEvent,
  MakerEvent,
  Session,
  SessionSendResult,
} from '@cindy/maker-core';
import type { ChannelIM } from '@cindy/im';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  feishuIm: {
    reactToMessage: vi.fn(),
    removeMessageReaction: vi.fn(),
    sendText: vi.fn(),
    sendMarkdownText: vi.fn(),
    startStreamingText: vi.fn(),
    patchMarkdownCard: vi.fn(),
    sendInteractiveCard: vi.fn(),
    updateInteractiveCard: vi.fn(),
  },
  getMaker: vi.fn(),
  listProviders: vi.fn(),
  hasCustomProviderKey: vi.fn(),
  readXdGatewayApiKey: vi.fn(),
  bindingGet: vi.fn(),
  bindingDetach: vi.fn(),
  findActiveSession: vi.fn(),
  createSession: vi.fn(),
  touchUserSent: vi.fn(),
  persistUserMessage: vi.fn(),
  persistAssistantMessage: vi.fn(),
  wireSessionToIpcExternal: vi.fn(),
  noteSilentStopUserSend: vi.fn(),
  noteSilentStopSessionReset: vi.fn(),
  onSilentStopSettled: vi.fn(() => vi.fn()),
  installDesktopInteractionListener: vi.fn(),
  takePendingInteractionsForSession: vi.fn(),
  rejectAllPending: vi.fn(),
  registerPending: vi.fn(),
  registerPendingExternal: vi.fn(),
  buildPermissionCard: vi.fn(),
  buildAskUserCard: vi.fn(),
  buildPlanReviewCard: vi.fn(),
  checkDestructiveToolCall: vi.fn(),
  resolveXdtImageUrl: vi.fn(),
  generateAndPersistFbotTitle: vi.fn(),
  desktopSessionRows: vi.fn(),
}));

vi.mock('../../../logger', () => ({
  createLogger: () => mocks.logger,
}));

vi.mock('../../../maker-host', () => ({
  getMaker: mocks.getMaker,
}));

vi.mock('../../../maker-host/createDesktopProviderService', () => ({
  getDesktopProviderService: () => ({ listProviders: mocks.listProviders }),
}));

vi.mock('../../../maker-host/provider-route', () => ({
  hasCustomProviderKey: mocks.hasCustomProviderKey,
}));

vi.mock('../../../localDb/client/current', () => ({
  getDbClient: vi.fn(() => ({
    drizzle: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: mocks.desktopSessionRows,
          })),
        })),
      })),
      update: vi.fn(),
    },
  })),
}));

vi.mock('../../../localDb/schema', () => ({
  sessions: {},
}));

vi.mock('../../../imageCacheStore', () => ({
  resolveSafe: mocks.resolveXdtImageUrl,
}));

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

vi.mock('../apiKey', () => ({
  readXdGatewayApiKey: mocks.readXdGatewayApiKey,
}));

vi.mock('../fbotTitle', () => ({
  FBOT_DRAFT_TITLE: 'FBot · New',
  generateAndPersistFbotTitle: mocks.generateAndPersistFbotTitle,
}));

import { createTurnRunner, type ImTurnRunner } from '../turnRunner';
import type { ImCardBuilders } from '../cardBuilders';
import type { ImSessionRepo, ImSessionRow } from '../sessionRepo';
import type { ImChannelAdapter } from '../types';
import { ui } from '../../feishu/uiText';
import { CredentialModeSwitchBusyError } from '../../../maker-host/codex-credential-switch';
import { isHeadlessGhostSetupTurn } from '../../../mcp-integrations/ghostSetupInteractionSurface';

/** harness send 的完整签名 — 第二参透传 onAccepted(对齐 maker-core 语义)。 */
type HarnessSend = (
  message: Parameters<Session['send']>[0],
  opts?: Parameters<Session['send']>[1],
) => Promise<SessionSendResult>;

interface SessionHarness {
  session: Session;
  send: ReturnType<typeof vi.fn<HarnessSend>>;
  /** maker-core Session.isTurnRunning 的 mock — 模拟接管模式下 desktop 侧 turn 在跑。 */
  isTurnRunning: ReturnType<typeof vi.fn>;
  /** maker-core Session.abort 的 mock — !stop 中止路径断言用。 */
  abort: ReturnType<typeof vi.fn>;
  emit(event: AgentEvent): void;
}

function createSessionHarness(
  sendImpl: (
    message: Parameters<Session['send']>[0],
  ) => Promise<SessionSendResult>,
  sessionId = 'feishu-session',
): SessionHarness {
  const listeners: Array<(event: AgentEvent) => void> = [];
  // onAccepted 仅在消息真被接受时触发 — 对齐 maker-core Session.send 语义;
  // mockRejectedValueOnce 整体替换实现, 抛错路径自然不会触发(正确)。
  const send = vi.fn<HarnessSend>(async (message, opts) => {
    const result = await sendImpl(message);
    if (result.accepted) {
      await opts?.beforeProviderStart?.();
      await opts?.onAccepted?.();
    }
    return result;
  });
  const isTurnRunning = vi.fn(() => false);
  const abort = vi.fn(async () => undefined);
  const session = {
    id: sessionId,
    agentKind: 'claude-code',
    send,
    isTurnRunning,
    abort,
    onEvent(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      return () => {
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
    isTurnRunning,
    abort,
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

// ── 工厂注入的假件 — 行为与重构前的模块 mock 等价 ─────────────────────────────

const fakeRepo: ImSessionRepo = {
  sessionIdFor: (bot, user) => `feishu_${bot}_${user}`,
  findActiveSession: (...args: [string, string]) => mocks.findActiveSession(...args),
  prepareNewSession: vi.fn(async (bot: string, user: string): Promise<ImSessionRow> => ({
    id: `feishu_${bot}_${user}`,
    agentKind: 'claude-code',
    workingDir: 'F:\\XDMaker',
    model: 'claude-opus-4-7',
    effort: 'xhigh',
    permissionMode: 'auto',
    fastMode: false,
    sdkSessionId: null,
    providerId: null,
  })),
  createSession: (...args: [string, string]) => mocks.createSession(...args),
  getDefaultEffortFor: () => 'high',
};

const fakeCards = {
  buildPermissionCard: mocks.buildPermissionCard,
  buildAskUserCard: mocks.buildAskUserCard,
  buildPlanReviewCard: mocks.buildPlanReviewCard,
  buildModelPickerCard: vi.fn(),
  buildPermissionModePickerCard: vi.fn(),
  buildControlPickerCard: vi.fn(),
  buildControlSessionPickerCard: vi.fn(),
  buildResolvedCard: vi.fn(),
} as unknown as ImCardBuilders;

const fakeAdapter: ImChannelAdapter = {
  channel: 'feishu',
  im: mocks.feishuIm as unknown as ChannelIM,
  output: { kind: 'rich-card', im: mocks.feishuIm as unknown as ChannelIM },
  config: {
    agentKind: 'claude-code',
    defaultModel: 'claude-opus-4-7',
    defaultPermissionMode: 'auto',
  },
  ui,
  sessions: {
    source: 'feishu',
    sessionIdFor: (bot, user) => `feishu_${bot}_${user}`,
    defaultTitle: (user) => `飞书 · ${user.slice(-6)}`,
    ensureWorkingDir: () => '/tmp/im-working-dir',
    extraInsertColumns: () => ({}),
  },
  processingEmoji: 'SMUG',
  buildVendorOptions: (userId) => ({ feishuChatId: userId, source: 'feishu' }),
};

let runner: ImTurnRunner | null = null;
let makerEventListeners: Array<(event: MakerEvent) => void> = [];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createMakerHarness(session: Session) {
  return {
    createSession: vi.fn(async () => session),
    on: vi.fn((listener: (event: MakerEvent) => void) => {
      makerEventListeners.push(listener);
      return () => {
        makerEventListeners = makerEventListeners.filter((candidate) => candidate !== listener);
      };
    }),
  };
}

function createMakerCreateSessionFailureHarness(err: unknown) {
  return {
    createSession: vi.fn(async () => {
      throw err;
    }),
    on: vi.fn((listener: (event: MakerEvent) => void) => {
      makerEventListeners.push(listener);
      return () => {
        makerEventListeners = makerEventListeners.filter((candidate) => candidate !== listener);
      };
    }),
  };
}

function emitMakerEvent(event: MakerEvent): void {
  for (const listener of [...makerEventListeners]) listener(event);
}

function getRunner(): ImTurnRunner {
  if (!runner) runner = createTurnRunner(fakeAdapter, fakeRepo, fakeCards);
  return runner;
}

function setupSession(
  sendImpl: Parameters<typeof createSessionHarness>[0],
): SessionHarness {
  const h = createSessionHarness(sendImpl);
  mocks.getMaker.mockReturnValue(createMakerHarness(h.session));
  return h;
}

function setupAttachedSession(
  sendImpl: Parameters<typeof createSessionHarness>[0],
): SessionHarness {
  const sessionId = 'desktop-attached-session';
  const h = createSessionHarness(sendImpl, sessionId);
  mocks.bindingGet.mockReturnValue(sessionId);
  mocks.desktopSessionRows.mockResolvedValue([
    {
      id: sessionId,
      agentKind: 'claude-code',
      workingDir: 'F:\\XDMaker',
      model: 'claude-opus-4-7',
      effort: 'xhigh',
      permissionMode: 'bypassPermissions',
      fastMode: false,
      sdkSessionId: null,
      providerId: null,
    },
  ]);
  mocks.getMaker.mockReturnValue(createMakerHarness(h.session));
  return h;
}

function setupSessionWithId(
  sessionId: string,
  sendImpl: Parameters<typeof createSessionHarness>[0],
): SessionHarness {
  const h = createSessionHarness(sendImpl, sessionId);
  mocks.findActiveSession.mockResolvedValue({
    id: sessionId,
    agentKind: 'claude-code',
    workingDir: 'F:\\XDMaker',
    model: 'claude-opus-4-7',
    effort: 'xhigh',
    permissionMode: 'bypassPermissions',
    fastMode: false,
    sdkSessionId: null,
    providerId: null,
  });
  mocks.getMaker.mockReturnValue(createMakerHarness(h.session));
  return h;
}

interface TurnOverrides {
  userMessageId?: string;
  text?: string;
}

async function runDefaultTurn(
  onTurnComplete = vi.fn(),
  overrides: TurnOverrides = {},
) {
  const { turnPromise } = await startDefaultTurn(onTurnComplete, overrides);
  await turnPromise;
  return { onTurnComplete };
}

async function startDefaultTurn(
  onTurnComplete = vi.fn(),
  overrides: TurnOverrides = {},
) {
  const turnPromise = getRunner().runAgentTurn({
    botContextId: 'cli_test_bot',
    userId: 'ou_user',
    userMessageId: overrides.userMessageId ?? 'msg-user',
    text: overrides.text ?? 'PROMPT_SECRET full user message TOKEN_VALUE file body',
    attachments: [],
    onTurnComplete,
  });
  return { onTurnComplete, turnPromise };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

function expectSafeSendOutcomeLog(expected: {
  source: string;
  reason: string;
}): void {
  expect(mocks.logger.error).toHaveBeenCalledWith(
    'feishu session send failed before dispatch',
    expect.objectContaining({
      kind: 'session-dispatch',
      source: expected.source,
      owner: 'feishu-im',
      entrypoint: 'feishu.runAgentTurn',
      sessionId: expect.stringMatching(/^session:[a-f0-9]{12}$/),
      action: 'send-user-message',
      reason: expected.reason,
      context: expect.stringContaining('sessionId=session:'),
    }),
  );
  const loggedPayload = JSON.stringify(mocks.logger.error.mock.calls);
  expect(loggedPayload).not.toContain('PROMPT_SECRET');
  expect(loggedPayload).not.toContain('full user message');
  expect(loggedPayload).not.toContain('TOKEN_VALUE');
  expect(loggedPayload).not.toContain('file body');
}

describe('turnRunner send outcome policy (feishu adapter characterization)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    makerEventListeners = [];
    mocks.readXdGatewayApiKey.mockReturnValue('xd-gateway-key');
    mocks.hasCustomProviderKey.mockReturnValue(false);
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
    mocks.bindingGet.mockReturnValue(undefined);
    mocks.desktopSessionRows.mockResolvedValue([
      {
        id: 'feishu-session',
        status: 'active',
        agentKind: 'claude-code',
        workingDir: 'F:\\XDMaker',
        model: 'claude-opus-4-7',
        effort: 'xhigh',
        permissionMode: 'bypassPermissions',
        fastMode: false,
        sdkSessionId: null,
        providerId: null,
      },
    ]);
    mocks.findActiveSession.mockResolvedValue({
      id: 'feishu-session',
      agentKind: 'claude-code',
      workingDir: 'F:\\XDMaker',
      model: 'claude-opus-4-7',
      effort: 'xhigh',
      permissionMode: 'bypassPermissions',
      fastMode: false,
      sdkSessionId: null,
      providerId: null,
    });
    mocks.createSession.mockRejectedValue(new Error('unexpected create'));
    mocks.touchUserSent.mockResolvedValue(undefined);
    mocks.persistUserMessage.mockResolvedValue(undefined);
    mocks.persistAssistantMessage.mockResolvedValue(undefined);
    mocks.feishuIm.reactToMessage.mockResolvedValue('reaction-1');
    mocks.feishuIm.removeMessageReaction.mockResolvedValue(undefined);
    mocks.feishuIm.sendText.mockResolvedValue(undefined);
    mocks.feishuIm.sendMarkdownText.mockResolvedValue(undefined);
    mocks.feishuIm.startStreamingText.mockResolvedValue({
      messageId: 'stream-1',
      append: vi.fn(),
      replace: vi.fn(),
      finalize: vi.fn(),
      close: vi.fn(),
    });
    mocks.takePendingInteractionsForSession.mockReturnValue([]);
    mocks.checkDestructiveToolCall.mockReturnValue({ destructive: false });
  });

  afterEach(async () => {
    await runner?.disposeAllSessions();
    runner = null;
  });

  it('keeps IM persistence, ack, card, and completion exactly-once when Maker recovery is transparent', async () => {
    const streamingHandle = {
      messageId: 'stream-recovered',
      append: vi.fn(),
      replace: vi.fn(),
      finalize: vi.fn(),
      close: vi.fn(),
    };
    mocks.feishuIm.startStreamingText.mockResolvedValue(streamingHandle);
    const h = setupSession(async () => ({ accepted: true }));
    const onTurnComplete = vi.fn();
    await runDefaultTurn(onTurnComplete);
    // invalid-resume 的旧失败已由 maker-core 吞掉；IM 只看到 fresh query 的公开事件。
    h.emit({ type: 'session_id', data: 'sdk-fresh', source: 'claude-code' });
    h.emit({ type: 'text', data: { text: 'fresh answer', isFinal: true }, source: 'claude-code' });
    await flushMicrotasks();
    h.emit({ type: 'done', data: {}, source: 'claude-code' });
    await waitForAssertion(() => {
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(streamingHandle.finalize).toHaveBeenCalledTimes(1);
    });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(mocks.persistUserMessage).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.reactToMessage).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.sendText).not.toHaveBeenCalledWith(
      'ou_user',
      expect.stringContaining('错误'),
      expect.anything(),
    );
  });

  it('marks only an accepted attached IM turn headless and releases it on done', async () => {
    const sendGate = deferred<SessionSendResult>();
    const h = setupAttachedSession(async () => sendGate.promise);
    const { turnPromise } = await startDefaultTurn();

    await waitForAssertion(() => {
      expect(h.send).toHaveBeenCalledTimes(1);
    });
    expect(isHeadlessGhostSetupTurn('desktop-attached-session')).toBe(false);

    sendGate.resolve({ accepted: true });
    await turnPromise;
    expect(isHeadlessGhostSetupTurn('desktop-attached-session')).toBe(true);

    h.emit({ type: 'done', data: {} });
    await waitForAssertion(() => {
      expect(isHeadlessGhostSetupTurn('desktop-attached-session')).toBe(false);
    });
  });

  it('releases an attached IM headless marker on terminal error', async () => {
    const h = setupAttachedSession(async () => ({ accepted: true }));

    await runDefaultTurn();
    expect(isHeadlessGhostSetupTurn('desktop-attached-session')).toBe(true);

    h.emit({ type: 'error', data: { message: 'terminal failure' } });
    await waitForAssertion(() => {
      expect(isHeadlessGhostSetupTurn('desktop-attached-session')).toBe(false);
    });
  });

  it('keeps channel-native IM turns on their existing non-marker path', async () => {
    const h = setupSession(async () => ({ accepted: true }));

    await runDefaultTurn();
    expect(isHeadlessGhostSetupTurn('feishu-session')).toBe(false);

    h.emit({ type: 'done', data: {} });
    await flushMicrotasks();
    expect(isHeadlessGhostSetupTurn('feishu-session')).toBe(false);
  });

  it('does not reacquire attached IM headless state from a late acceptance callback', async () => {
    let lateOnAccepted: NonNullable<Parameters<Session['send']>[1]>['onAccepted'];
    const h = setupAttachedSession(async () => ({
      accepted: false,
      reason: 'cancelled-before-dispatch',
    }));
    h.send.mockImplementationOnce(async (_message, opts) => {
      lateOnAccepted = opts?.onAccepted;
      return { accepted: false, reason: 'cancelled-before-dispatch' };
    });

    await runDefaultTurn();
    expect(isHeadlessGhostSetupTurn('desktop-attached-session')).toBe(false);

    await lateOnAccepted?.();
    expect(isHeadlessGhostSetupTurn('desktop-attached-session')).toBe(false);
    expect(mocks.persistUserMessage).not.toHaveBeenCalled();
  });

  it('applies a deferred switch and sends the first queued IM message through the refreshed session', async () => {
    const order: string[] = [];
    const oldSession = createSessionHarness(async () => ({
      accepted: false,
      reason: 'cancelled-before-dispatch',
    }));
    const switchedSession = createSessionHarness(async () => {
      order.push('send');
      // agent switch 已完成后的关闭不属于切换自己的瞬态 close，必须正常清缓存。
      emitMakerEvent({
        type: 'session:closed',
        sessionId: 'feishu-session',
        session: switchedSession.session,
        reason: 'requested',
      });
      return {
        accepted: false,
        reason: 'cancelled-before-dispatch',
      };
    });
    let live: Session | undefined = oldSession.session;
    const maker = {
      createSession: vi.fn(async () => oldSession.session),
      getSession: vi.fn(() => live),
      on: vi.fn((listener: (event: MakerEvent) => void) => {
        makerEventListeners.push(listener);
        return () => {
          makerEventListeners = makerEventListeners.filter((candidate) => candidate !== listener);
        };
      }),
    };
    mocks.getMaker.mockReturnValue(maker);
    const releaseAgentSwitchLock = vi.fn(() => {
      order.push('release');
    });
    const acquirePendingAgentSwitch = vi.fn(async () => {
      order.push('apply');
      live = switchedSession.session;
      emitMakerEvent({
        type: 'session:closed',
        sessionId: 'feishu-session',
        session: oldSession.session,
        reason: 'agent-switch',
      });
      return releaseAgentSwitchLock;
    });
    const localRunner = createTurnRunner(fakeAdapter, fakeRepo, fakeCards, {
      acquirePendingAgentSwitch,
    });

    try {
      await localRunner.runAgentTurn({
        botContextId: 'cli_test_bot',
        userId: 'ou_user',
        userMessageId: 'msg-agent-switch',
        text: 'send after switch',
        attachments: [],
      });

      expect(acquirePendingAgentSwitch).toHaveBeenCalledWith('feishu-session');
      expect(oldSession.send).not.toHaveBeenCalled();
      expect(switchedSession.send).toHaveBeenCalledTimes(1);
      expect(mocks.wireSessionToIpcExternal).toHaveBeenLastCalledWith(switchedSession.session);
      expect(order).toEqual(['apply', 'send', 'release']);
      expect(localRunner.getMakerSessionById('feishu-session')).toBeNull();
    } finally {
      localRunner.disposeAllSessions();
    }
  });

  it('does not suppress a requested close during no-op switch acquisition', async () => {
    const oldSession = createSessionHarness(async () => ({ accepted: true }));
    let live: Session | undefined = oldSession.session;
    const maker = {
      createSession: vi.fn(async () => oldSession.session),
      getSession: vi.fn(() => live),
      on: vi.fn((listener: (event: MakerEvent) => void) => {
        makerEventListeners.push(listener);
        return () => {
          makerEventListeners = makerEventListeners.filter((candidate) => candidate !== listener);
        };
      }),
    };
    mocks.getMaker.mockReturnValue(maker);
    const acquirePendingAgentSwitch = vi.fn(async () => {
      live = undefined;
      emitMakerEvent({
        type: 'session:closed',
        sessionId: 'feishu-session',
        session: oldSession.session,
        reason: 'requested',
      });
      return vi.fn();
    });
    const localRunner = createTurnRunner(fakeAdapter, fakeRepo, fakeCards, {
      acquirePendingAgentSwitch,
    });

    try {
      await localRunner.runAgentTurn({
        botContextId: 'cli_test_bot',
        userId: 'ou_user',
        userMessageId: 'msg-close-race',
        text: 'do not recreate',
        attachments: [],
      });

      expect(oldSession.send).not.toHaveBeenCalled();
      expect(maker.createSession).toHaveBeenCalledTimes(1);
      expect(localRunner.getMakerSessionById('feishu-session')).toBeNull();
    } finally {
      localRunner.disposeAllSessions();
    }
  });

  it('does not suppress a concurrent close of the replacement session', async () => {
    const oldSession = createSessionHarness(async () => ({ accepted: true }));
    const switchedSession = createSessionHarness(async () => ({ accepted: true }));
    let live: Session | undefined = oldSession.session;
    const maker = {
      createSession: vi.fn(async () => oldSession.session),
      getSession: vi.fn(() => live),
      on: vi.fn((listener: (event: MakerEvent) => void) => {
        makerEventListeners.push(listener);
        return () => {
          makerEventListeners = makerEventListeners.filter((candidate) => candidate !== listener);
        };
      }),
    };
    mocks.getMaker.mockReturnValue(maker);
    const acquirePendingAgentSwitch = vi.fn(async () => {
      live = switchedSession.session;
      emitMakerEvent({
        type: 'session:closed',
        sessionId: 'feishu-session',
        session: oldSession.session,
        reason: 'agent-switch',
      });
      live = undefined;
      emitMakerEvent({
        type: 'session:closed',
        sessionId: 'feishu-session',
        session: switchedSession.session,
        reason: 'requested',
      });
      return vi.fn();
    });
    const localRunner = createTurnRunner(fakeAdapter, fakeRepo, fakeCards, {
      acquirePendingAgentSwitch,
    });

    try {
      await localRunner.runAgentTurn({
        botContextId: 'cli_test_bot',
        userId: 'ou_user',
        userMessageId: 'msg-replacement-close-race',
        text: 'do not send after replacement closes',
        attachments: [],
      });

      expect(oldSession.send).not.toHaveBeenCalled();
      expect(switchedSession.send).not.toHaveBeenCalled();
      expect(localRunner.getMakerSessionById('feishu-session')).toBeNull();
    } finally {
      localRunner.disposeAllSessions();
    }
  });

  it('treats accepted:false as pre-dispatch failure with exactly-once cleanup and user notification', async () => {
    const h = setupSession(async () => ({
      accepted: false,
      reason: 'cancelled-before-dispatch',
    }));
    const { onTurnComplete } = await runDefaultTurn();
    await flushMicrotasks();

    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledWith('msg-user', 'reaction-1');
    expect(mocks.feishuIm.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.sendText).toHaveBeenCalledWith(
      'ou_user',
      expect.stringContaining('启动 agent 失败'),
      // thread = session 模型加的末位可选参数 — feishu 无 scope, 恒 undefined
      { threadTs: undefined },
    );
    expectSafeSendOutcomeLog({
      source: 'feishu-runner',
      reason: 'cancelled-before-dispatch',
    });

    h.emit({ type: 'done', data: {} });
    await flushMicrotasks();

    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.sendText).toHaveBeenCalledTimes(1);
  });

  it('keeps thrown send cleanup exactly once while aligning structured log fields', async () => {
    const err = new Error('PROMPT_SECRET full user message TOKEN_VALUE file body');
    const h = setupSession(async () => {
      throw err;
    });
    const { onTurnComplete } = await runDefaultTurn();
    await flushMicrotasks();

    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.sendText).toHaveBeenCalledTimes(1);
    expectSafeSendOutcomeLog({
      source: 'session.send',
      reason: 'Error',
    });
    const notificationText = String(mocks.feishuIm.sendText.mock.calls[0][1]);
    expect(notificationText).not.toContain('PROMPT_SECRET');
    expect(notificationText).not.toContain('full user message');
    expect(notificationText).not.toContain('TOKEN_VALUE');
    expect(notificationText).not.toContain('file body');

    h.emit({ type: 'error', data: { message: 'late terminal' } });
    await flushMicrotasks();

    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.sendText).toHaveBeenCalledTimes(1);
  });

  it('waits for ack removal before callback and failure notification on pre-dispatch failure', async () => {
    const order: string[] = [];
    let resolveReaction: ((reactionId: string) => void) | undefined;
    let resolveRemove: (() => void) | undefined;
    mocks.feishuIm.reactToMessage.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveReaction = resolve;
      }),
    );
    mocks.feishuIm.removeMessageReaction.mockImplementation(async () => {
      order.push('remove-start');
      await new Promise<void>((resolve) => {
        resolveRemove = resolve;
      });
      order.push('remove-done');
    });
    mocks.feishuIm.sendText.mockImplementation(async () => {
      order.push('notify');
    });
    const h = setupSession(async () => ({
      accepted: false,
      reason: 'cancelled-before-dispatch',
    }));
    const onTurnComplete = vi.fn(() => {
      order.push('callback');
    });
    const { turnPromise } = await startDefaultTurn(onTurnComplete);
    await flushMicrotasks();

    expect(mocks.feishuIm.removeMessageReaction).not.toHaveBeenCalled();
    expect(onTurnComplete).not.toHaveBeenCalled();
    expect(mocks.feishuIm.sendText).not.toHaveBeenCalled();

    resolveReaction?.('reaction-late');
    await waitForAssertion(() => {
      expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledTimes(1);
    });

    expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledWith('msg-user', 'reaction-late');
    expect(onTurnComplete).not.toHaveBeenCalled();
    expect(mocks.feishuIm.sendText).not.toHaveBeenCalled();
    expect(order).toEqual(['remove-start']);

    resolveRemove?.();
    await turnPromise;
    await flushMicrotasks();
    expect(order).toEqual(['remove-start', 'remove-done', 'callback', 'notify']);

    h.emit({ type: 'done', data: {} });
    await flushMicrotasks();

    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledTimes(1);
  });

  it('continues failure cleanup when ack cleanup hangs past the bounded wait', async () => {
    vi.useFakeTimers();
    try {
      mocks.feishuIm.reactToMessage.mockReturnValue(new Promise<string>(() => undefined));
      setupSession(async () => ({
        accepted: false,
        reason: 'cancelled-before-dispatch',
      }));
      const onTurnComplete = vi.fn();
      const { turnPromise } = await startDefaultTurn(onTurnComplete);
      await flushMicrotasks();

      expect(onTurnComplete).not.toHaveBeenCalled();
      expect(mocks.feishuIm.sendText).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);
      await turnPromise;

      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(mocks.feishuIm.sendText).toHaveBeenCalledTimes(1);
      expect(mocks.feishuIm.removeMessageReaction).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('redacts user identity from send failure log session fields', async () => {
    const sensitiveSessionId = 'feishu_cli_test_bot_ou_sensitive_openid';
    setupSessionWithId(sensitiveSessionId, async () => ({
      accepted: false,
      reason: 'cancelled-before-dispatch',
    }));

    await runDefaultTurn();

    const loggedPayload = JSON.stringify(mocks.logger.error.mock.calls);
    expect(loggedPayload).toContain('session:');
    expect(loggedPayload).not.toContain(sensitiveSessionId);
    expect(loggedPayload).not.toContain('ou_sensitive_openid');
  });

  it('queues a SESSION_RUNNING race silently and retries via the backoff timer (no error reply, no raw text leak)', async () => {
    vi.useFakeTimers();
    try {
      // pre-check 时 isTurnRunning=false, 但 send 时另一端抢先开了 turn —
      // 第一次 send 抛 SESSION_RUNNING, 应入队重试而不是回"启动 agent 失败"。
      const err = new Error('SESSION_RUNNING: PROMPT_SECRET TOKEN_VALUE file body') as Error & { code?: string };
      err.code = 'SESSION_RUNNING';
      const h = setupSession(async () => ({ accepted: true }));
      h.send.mockRejectedValueOnce(err);

      await runDefaultTurn();
      await flushMicrotasks();

      // 不报错、不泄漏原始错误文本, 只发排队提示
      expect(mocks.feishuIm.sendText).not.toHaveBeenCalled();
      expect(mocks.feishuIm.sendMarkdownText).toHaveBeenCalledTimes(1);
      const noticeText = String(mocks.feishuIm.sendMarkdownText.mock.calls[0][1]);
      expect(noticeText).toContain('排队');
      expect(noticeText).not.toContain('PROMPT_SECRET');
      expect(noticeText).not.toContain('TOKEN_VALUE');
      expect(h.send).toHaveBeenCalledTimes(1);
      // 落库走 onAccepted 钩子 — send 被 SESSION_RUNNING 拒绝时不写库,
      // 避免 user 消息排在还在跑的那轮 assistant 输出之前(transcript 乱序)。
      expect(mocks.persistUserMessage).not.toHaveBeenCalled();

      // backoff timer 触发重试 → 第二次 send 成功 dispatch, 此时才落库
      await vi.advanceTimersByTimeAsync(600);
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(mocks.persistUserMessage).toHaveBeenCalledTimes(1);

      h.emit({ type: 'done', data: {} });
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports credential busy during session wiring without leaking as internal error', async () => {
    const busy = new CredentialModeSwitchBusyError(['busy-session']);
    mocks.getMaker.mockReturnValue(createMakerCreateSessionFailureHarness(busy));
    const onTurnComplete = vi.fn();

    await runDefaultTurn(onTurnComplete);
    await flushMicrotasks();

    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledWith('msg-user', 'reaction-1');
    expect(mocks.feishuIm.sendText).toHaveBeenCalledWith(
      'ou_user',
      ui.agent.credentialBusy,
      { threadTs: undefined },
    );
    expect(mocks.persistUserMessage).not.toHaveBeenCalled();
    expect(mocks.logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining('session send failed before dispatch'),
      expect.anything(),
    );
  });

  it('queues a second message while the first turn is running and dispatches it after done', async () => {
    mocks.feishuIm.reactToMessage.mockImplementation(async (messageId: string) => `reaction-${messageId}`);
    const h = setupSession(async () => ({ accepted: true }));
    const firstComplete = vi.fn();
    await runDefaultTurn(firstComplete, {
      userMessageId: 'msg-first',
      text: 'first user message',
    });

    expect(firstComplete).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);

    const secondComplete = vi.fn();
    await runDefaultTurn(secondComplete, {
      userMessageId: 'msg-second',
      text: 'second user message',
    });
    await flushMicrotasks();

    // 第二条不再触发 send / 不再报 SESSION_RUNNING, 而是排队 + 提示;
    // user message 落库延迟到 dispatch 时(保证 messages 表顺序)。
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.sendText).not.toHaveBeenCalled();
    expect(mocks.feishuIm.sendMarkdownText).toHaveBeenCalledTimes(1);
    expect(secondComplete).not.toHaveBeenCalled();
    expect(mocks.persistUserMessage).toHaveBeenCalledTimes(1);

    h.emit({
      type: 'error',
      data: { message: 'Reconnecting... 1/5', isTerminal: false, willRetry: true },
    });
    await flushMicrotasks();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(firstComplete).not.toHaveBeenCalled();
    expect(secondComplete).not.toHaveBeenCalled();
    expect(mocks.feishuIm.sendText).not.toHaveBeenCalled();

    h.emit({ type: 'text', data: { text: 'first final', isFinal: true } });
    h.emit({ type: 'done', data: {} });
    await waitForAssertion(() => {
      expect(h.send).toHaveBeenCalledTimes(2);
    });

    expect(firstComplete).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledWith('msg-first', 'reaction-msg-first');
    expect(mocks.persistUserMessage).toHaveBeenCalledTimes(2);
    // assistant 落库收口在 messagePersistBroadcaster(经 wireSessionToIpcExternal),
    // turnRunner 不再自写 — 自写会与 broadcaster 双份落库。
    expect(mocks.persistAssistantMessage).not.toHaveBeenCalled();
    expect(mocks.wireSessionToIpcExternal).toHaveBeenCalledTimes(1);

    h.emit({ type: 'text', data: { text: 'second final', isFinal: true } });
    h.emit({ type: 'done', data: {} });
    await flushMicrotasks();

    expect(secondComplete).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledWith('msg-second', 'reaction-msg-second');
  });

  it('queues while a desktop-originated turn is running (attached takeover) and dispatches on its stray done', async () => {
    // 接管模式典型场景: desktop 侧 turn 在跑(本渠道没有对应 TurnState),
    // isTurnRunning=true → 入队; desktop turn 的 done 以 stray event 到达 → 派发。
    const h = setupSession(async () => ({ accepted: true }));
    h.isTurnRunning.mockReturnValue(true);

    await runDefaultTurn();
    await flushMicrotasks();

    expect(h.send).not.toHaveBeenCalled();
    expect(mocks.feishuIm.sendText).not.toHaveBeenCalled();
    expect(mocks.feishuIm.sendMarkdownText).toHaveBeenCalledTimes(1);
    expect(mocks.persistUserMessage).not.toHaveBeenCalled();

    h.emit({
      type: 'error',
      data: { message: 'Reconnecting... 1/5', isTerminal: false, willRetry: true },
    });
    await flushMicrotasks();
    expect(h.send).not.toHaveBeenCalled();
    expect(mocks.persistUserMessage).not.toHaveBeenCalled();

    h.isTurnRunning.mockReturnValue(false);
    h.emit({ type: 'done', data: {} }); // desktop turn 的 stray done
    await waitForAssertion(() => {
      expect(h.send).toHaveBeenCalledTimes(1);
    });
    expect(mocks.persistUserMessage).toHaveBeenCalledTimes(1);

    h.emit({ type: 'done', data: {} });
    await flushMicrotasks();
    expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledTimes(1);
  });

  it('drains the queue via the backoff timer when the desktop turn ends without a stray done', async () => {
    // 窄竞态回归: desktop turn 的 done 在 enqueue 之前已送达(或被错过),
    // 之后不再有任何事件 — 排队消息只能靠入队时挂上的兜底 timer 自愈派发。
    vi.useFakeTimers();
    try {
      const h = setupSession(async () => ({ accepted: true }));
      h.isTurnRunning.mockReturnValue(true);

      await runDefaultTurn();
      await flushMicrotasks();
      expect(h.send).not.toHaveBeenCalled();

      // 第一轮 timer: 仍在跑 → 自动续挂
      await vi.advanceTimersByTimeAsync(600);
      expect(h.send).not.toHaveBeenCalled();

      // session 空闲后, 无任何事件到达 — 仅靠续挂的 timer 派发
      h.isTurnRunning.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(600);
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(mocks.persistUserMessage).toHaveBeenCalledTimes(1);

      h.emit({ type: 'done', data: {} });
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps cleanup completed when the failure notification itself fails', async () => {
    mocks.feishuIm.sendText.mockRejectedValue(new Error('notify failed'));
    setupSession(async () => ({
      accepted: false,
      reason: 'cancelled-before-dispatch',
    }));
    const { onTurnComplete } = await runDefaultTurn();
    await flushMicrotasks();

    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.sendText).toHaveBeenCalledTimes(1);
  });

  it('keeps the normal turn flow when send is accepted', async () => {
    const h = setupSession(async () => ({ accepted: true }));
    const { onTurnComplete } = await runDefaultTurn();
    await flushMicrotasks();

    expect(onTurnComplete).not.toHaveBeenCalled();
    expect(mocks.feishuIm.sendText).not.toHaveBeenCalled();
    expect(mocks.feishuIm.removeMessageReaction).not.toHaveBeenCalled();

    h.emit({ type: 'text', data: { text: 'final answer', isFinal: true } });
    h.emit({ type: 'done', data: {} });
    await flushMicrotasks();

    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledTimes(1);
    // 渠道默认(非接管)session 也必须 wire 进 desktop 事件管线 — 过程消息
    // (tool_use / thinking)与 assistant 文本由 messagePersistBroadcaster 落库,
    // desktop 聊天流才能像 Slack hook 会话一样看到完整过程。
    expect(mocks.wireSessionToIpcExternal).toHaveBeenCalledTimes(1);
    expect(mocks.persistAssistantMessage).not.toHaveBeenCalled();
    // 顺序不变量:wire 先安装中央 Router 的 Desktop fallback;本 turn 只在
    // beforeProviderStart 登记 route,不再覆盖/恢复 Session listener。
    const wireOrder = mocks.wireSessionToIpcExternal.mock.invocationCallOrder[0];
    const listenerMock = h.session.setInteractionListener as unknown as ReturnType<typeof vi.fn>;
    expect(wireOrder).toBeLessThan(listenerMock.mock.invocationCallOrder[0]);
    // 真实用户消息给 silent-stop 守卫充值(scheduler / hook runner 同款 parity)。
    expect(mocks.noteSilentStopUserSend).toHaveBeenCalledWith('feishu-session');
  });

  it('exposes accepted and terminal outcomes for an external durable queue', async () => {
    const h = setupSession(async () => ({ accepted: true }));
    const beforeProviderStart = vi.fn(async () => undefined);

    const dispatch = await getRunner().dispatchAgentTurn({
      botContextId: 'cli_test_bot',
      userId: 'ou_user',
      userMessageId: 'msg-external',
      text: 'durable task',
      attachments: [],
      queueMode: 'external',
      beforeProviderStart,
    });

    expect(dispatch.kind).toBe('accepted');
    if (dispatch.kind !== 'accepted') throw new Error('expected accepted dispatch');
    expect(dispatch.sessionId).toBe('feishu-session');
    expect(dispatch.acceptedAt).toBeGreaterThan(0);
    expect(beforeProviderStart).toHaveBeenCalledTimes(1);

    h.emit({ type: 'text', data: { text: 'durable answer', isFinal: true } });
    h.emit({ type: 'done', data: {} });

    await expect(dispatch.terminal).resolves.toMatchObject({
      kind: 'done',
      text: 'durable answer',
    });
  });

  it('reports the attached Desktop route before provider startup', async () => {
    const h = setupAttachedSession(async () => ({ accepted: true }));
    const onRouteResolved = vi.fn();
    const beforeProviderStart = vi.fn(async () => undefined);

    const dispatch = await getRunner().dispatchAgentTurn({
      botContextId: 'cli_test_bot',
      userId: 'ou_user',
      userMessageId: 'msg-attached-route',
      text: 'route this turn',
      attachments: [],
      queueMode: 'external',
      onRouteResolved,
      beforeProviderStart,
    });

    expect(dispatch.kind).toBe('accepted');
    expect(onRouteResolved).toHaveBeenCalledWith('desktop-attached-session');
    expect(onRouteResolved.mock.invocationCallOrder[0]).toBeLessThan(
      beforeProviderStart.mock.invocationCallOrder[0]!,
    );

    h.emit({ type: 'done', data: {} });
    if (dispatch.kind === 'accepted') await dispatch.terminal;
  });

  it('returns busy without copying external work into the in-memory queue', async () => {
    const h = setupSession(async () => ({ accepted: true }));
    const first = await getRunner().dispatchAgentTurn({
      botContextId: 'cli_test_bot',
      userId: 'ou_user',
      userMessageId: 'msg-external-1',
      text: 'first durable task',
      attachments: [],
      queueMode: 'external',
      beforeProviderStart: async () => undefined,
    });
    expect(first.kind).toBe('accepted');

    const second = await getRunner().dispatchAgentTurn({
      botContextId: 'cli_test_bot',
      userId: 'ou_user',
      userMessageId: 'msg-external-2',
      text: 'second durable task',
      attachments: [],
      queueMode: 'external',
      beforeProviderStart: async () => undefined,
    });

    expect(second).toEqual({ kind: 'busy', reason: 'session_running' });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.sendMarkdownText).not.toHaveBeenCalledWith(
      'ou_user',
      expect.stringContaining('排队'),
      expect.anything(),
    );

    h.emit({ type: 'done', data: {} });
    if (first.kind === 'accepted') await first.terminal;
  });

  it('commits one terminal payload for a chunked-text output driver', async () => {
    const previousOutput = fakeAdapter.output;
    const commitFinal = vi.fn(async () => undefined);
    fakeAdapter.output = {
      kind: 'chunked-text',
      im: mocks.feishuIm as unknown as ChannelIM,
      commitFinal,
    };
    try {
      const h = setupSession(async () => ({ accepted: true }));
      const { turnPromise } = await startDefaultTurn();
      await turnPromise;

      h.emit({ type: 'text', data: { text: 'complete text only', isFinal: true } });
      h.emit({ type: 'done', data: {} });
      await flushMicrotasks();

      expect(mocks.feishuIm.startStreamingText).not.toHaveBeenCalled();
      expect(commitFinal).toHaveBeenCalledTimes(1);
      expect(commitFinal).toHaveBeenCalledWith({
        userId: 'ou_user',
        text: 'complete text only',
        terminal: 'done',
        threadTs: undefined,
      });
    } finally {
      fakeAdapter.output = previousOutput;
    }
  });

  it('holds the turn open on silentStop done and finalizes only when the guard settles without resume', async () => {
    const handle = {
      messageId: 'stream-ss',
      append: vi.fn(),
      replace: vi.fn(),
      finalize: vi.fn(),
      close: vi.fn(),
    };
    mocks.feishuIm.startStreamingText.mockResolvedValue(handle);
    const h = setupSession(async () => ({ accepted: true }));
    const { onTurnComplete } = await runDefaultTurn();

    h.emit({ type: 'text', data: { text: 'partial answer', isFinal: false } });
    h.emit({ type: 'done', data: { silentStop: true } });
    await flushMicrotasks();

    // silentStop done 不当普通 done 收口 — 挂起等守卫 settle。
    expect(onTurnComplete).not.toHaveBeenCalled();
    expect(handle.finalize).not.toHaveBeenCalled();
    expect(mocks.onSilentStopSettled).toHaveBeenCalledTimes(1);
    expect(mocks.onSilentStopSettled).toHaveBeenCalledWith('feishu-session', expect.any(Function));

    // 守卫决定不续跑(exhausted / skip)→ 此时才按 done 收口。
    const settleCb = (mocks.onSilentStopSettled.mock.calls[0] as unknown[])[1] as (
      sessionId: string,
      reason: string,
    ) => void;
    settleCb('feishu-session', 'exhausted');
    await waitForAssertion(() => {
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(handle.finalize).toHaveBeenCalledTimes(1);
    });
    // settle 回调自身退订,不留陈旧监听。
    const unsub = mocks.onSilentStopSettled.mock.results[0].value as ReturnType<typeof vi.fn>;
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('clears the retry notice when the retried turn succeeds with no output', async () => {
    // 不变量锁定(review #844 codex P1 提出的担心, 实测不成立但值得锁住):
    // 重投成功而那一轮零输出时, 没有任何进展 handler 会清掉"正在自动重试" —— 卡片
    // 会不会停在"仍在重试"、并因正文非空而压掉空回复兜底? 不会: handleTurnDoneAsync
    // 先置 turn.done, 而 composeStreamingView 对 done 的 turn 直接返回正文、整段跳过
    // 过程区。这条用例把这个短路行为钉住, 以后改 composeStreamingView 会立刻暴露。
    const handle = {
      messageId: 'stream-retry-empty-done',
      append: vi.fn(),
      replace: vi.fn(),
      finalize: vi.fn(),
      close: vi.fn(),
    };
    mocks.feishuIm.startStreamingText.mockResolvedValue(handle);
    const h = setupSession(async () => ({ accepted: true }));
    await runDefaultTurn();

    h.emit({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model. (auto-retry 1/4)',
        isTerminal: false,
        willRetry: true,
      },
    });
    await flushMicrotasks();
    expect(handle.replace.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      '正在自动重试',
    );

    // 重投成功, 但这一轮一个字都没输出。
    h.emit({ type: 'done', data: {} });
    await waitForAssertion(() => {
      expect(handle.finalize).toHaveBeenCalledTimes(1);
    });
    const finalView = String(handle.finalize.mock.calls[0][0]);
    expect(finalView).not.toContain('正在自动重试');
    // 过程区清空后应回落到空回复兜底, 而不是把状态行当正文。
    expect(finalView).toContain('空回复');
  });

  it('waits for the pending retry card before finalizing a terminal overload error', async () => {
    // 过载重试提示会**惰性建卡**, 而终态错误可能恰好在 startStreamingText 回来之前
    // 到达。不同步的话: 终态看到 streamingHandle 还是 null → 另发一条错误消息并把
    // turn 出队, 随后建卡 promise resolve, 又去 replace 一张没人收口的孤儿卡, 渠道
    // 里出现重复/残留输出(review #844 codex P1)。
    let releaseCard: (h: unknown) => void = () => {};
    const handle = {
      messageId: 'stream-retry-race',
      append: vi.fn(),
      replace: vi.fn(),
      finalize: vi.fn(),
      close: vi.fn(),
    };
    mocks.feishuIm.startStreamingText.mockReturnValue(
      new Promise((resolve) => {
        releaseCard = resolve;
      }),
    );
    const h = setupSession(async () => ({ accepted: true }));
    const { onTurnComplete } = await runDefaultTurn();

    // 非终止过载 error → 开始建卡(请求挂住)。
    h.emit({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model. (auto-retry 1/4)',
        isTerminal: false,
        willRetry: true,
      },
    });
    await flushMicrotasks();
    expect(mocks.feishuIm.startStreamingText).toHaveBeenCalledTimes(1);
    expect(handle.replace).not.toHaveBeenCalled(); // 卡还没建好

    // 建卡还在飞时重试耗尽 → 终态。
    h.emit({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model.',
        isTerminal: true,
      },
    });
    await flushMicrotasks();
    // 卡还没回来, 收口正文不能先落地(不然就是"另发一条 + 留下孤儿卡")。
    expect(handle.finalize).not.toHaveBeenCalled();

    releaseCard(handle);
    await waitForAssertion(() => {
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      // 失败说明落在**同一张**卡上, 而不是另发一条 + 留下孤儿卡。
      expect(handle.finalize).toHaveBeenCalledTimes(1);
    });
    expect(mocks.feishuIm.startStreamingText).toHaveBeenCalledTimes(1);
    const finalView = String(handle.finalize.mock.calls[0][0]);
    expect(finalView).toContain('模型服务繁忙');
    expect(finalView).not.toContain('正在自动重试');
    // 没有另发一条错误消息(那正是重复输出的来源)。
    expect(
      mocks.feishuIm.sendText.mock.calls.some(([, text]) => String(text).includes('错误')),
    ).toBe(false);
  });

  it('holds the turn open on a non-terminal error and surfaces the auto-retry notice', async () => {
    const handle = {
      messageId: 'stream-retry',
      append: vi.fn(),
      replace: vi.fn(),
      finalize: vi.fn(),
      close: vi.fn(),
    };
    mocks.feishuIm.startStreamingText.mockResolvedValue(handle);
    const h = setupSession(async () => ({ accepted: true }));
    const { onTurnComplete } = await runDefaultTurn();

    // 过载重投只在本 turn **零产出**时发生, 所以这里刻意不先发 text: 卡片此刻
    // 还不存在, 提示必须能把它建出来, 否则用户除了 👀 表情什么都看不到。
    // 非终止 error = agent 正在自愈。此前这里无条件收口: 卡片被判失败、turn
    // 出队、排队消息立刻放行, 而 agent 其实还在跑。
    h.emit({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model. (auto-retry 2/4)',
        isTerminal: false,
        willRetry: true,
      },
    });
    await flushMicrotasks();

    expect(onTurnComplete).not.toHaveBeenCalled();
    expect(handle.finalize).not.toHaveBeenCalled();
    expect(mocks.feishuIm.startStreamingText).toHaveBeenCalled();
    const retryView = handle.replace.mock.calls.map((call) => String(call[0])).join('\n');
    expect(retryView).toContain('模型服务繁忙，正在自动重试（2/4）…');

    // 重试成功: 同一张卡继续收口, 状态行随真实进展消失。
    h.emit({ type: 'text', data: { text: 'done at last', isFinal: false } });
    h.emit({ type: 'done', data: {} });
    await waitForAssertion(() => {
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(handle.finalize).toHaveBeenCalledTimes(1);
    });
    const finalView = String(handle.finalize.mock.calls[0][0]);
    expect(finalView).toContain('done at last');
    expect(finalView).not.toContain('自动重试');
  });

  it('still finalizes as failed on a terminal error', async () => {
    const handle = {
      messageId: 'stream-fatal',
      append: vi.fn(),
      replace: vi.fn(),
      finalize: vi.fn(),
      close: vi.fn(),
    };
    mocks.feishuIm.startStreamingText.mockResolvedValue(handle);
    const h = setupSession(async () => ({ accepted: true }));
    const { onTurnComplete } = await runDefaultTurn();

    h.emit({ type: 'text', data: { text: 'partial', isFinal: false } });
    await flushMicrotasks(); // 等卡片 handle 建好, 收口才走 finalize 而非另发一条
    h.emit({ type: 'error', data: { message: 'process exited with code 1', isTerminal: true } });
    await waitForAssertion(() => {
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(handle.finalize).toHaveBeenCalledTimes(1);
    });
    expect(String(handle.finalize.mock.calls[0][0])).toContain('process exited with code 1');
  });

  it('keeps streaming resumed-turn output into the same turn after a silentStop resume', async () => {
    const handle = {
      messageId: 'stream-resume',
      append: vi.fn(),
      replace: vi.fn(),
      finalize: vi.fn(),
      close: vi.fn(),
    };
    mocks.feishuIm.startStreamingText.mockResolvedValue(handle);
    const h = setupSession(async () => ({ accepted: true }));
    const { onTurnComplete } = await runDefaultTurn();

    h.emit({ type: 'text', data: { text: 'first half', isFinal: false } });
    h.emit({ type: 'done', data: { silentStop: true } });
    await flushMicrotasks();
    expect(onTurnComplete).not.toHaveBeenCalled();

    // 守卫自动续跑(不 settle),续跑轮输出继续路由到同一 turn/卡片。
    h.emit({ type: 'text', data: { text: ' second half', isFinal: false } });
    h.emit({ type: 'done', data: {} });
    await waitForAssertion(() => {
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(handle.finalize).toHaveBeenCalledTimes(1);
    });
    expect(String(handle.finalize.mock.calls[0][0])).toContain('first half second half');
    // 真 done 收口时清掉挂着的 settle 订阅,防陈旧回调二次收口。
    const unsub = mocks.onSilentStopSettled.mock.results[0].value as ReturnType<typeof vi.fn>;
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('resets the silent-stop guard on !stop during the suspension window and closes the turn on settle', async () => {
    const handle = {
      messageId: 'stream-stop',
      append: vi.fn(),
      replace: vi.fn(),
      finalize: vi.fn(),
      close: vi.fn(),
    };
    mocks.feishuIm.startStreamingText.mockResolvedValue(handle);
    const h = setupSession(async () => ({ accepted: true }));
    const { onTurnComplete } = await runDefaultTurn();

    h.emit({ type: 'text', data: { text: 'half done', isFinal: false } });
    h.emit({ type: 'done', data: { silentStop: true } });
    await flushMicrotasks();
    expect(onTurnComplete).not.toHaveBeenCalled();

    // 挂起窗口内 !stop: 必须重置守卫(不重置的话守卫 1.5s 后照样自动续跑,
    // 用户喊停后 agent 原地复活)。abort 对早已收尾的 SDK turn 无事件产出,
    // 收口依赖守卫 reset → superseded → settle('skip') 这条链。
    const result = await getRunner().stopActiveTurn({
      botContextId: 'cli_test_bot',
      userId: 'ou_user',
    });
    expect(result.stopped).toBe(true);
    expect(mocks.noteSilentStopSessionReset).toHaveBeenCalledWith('feishu-session');
    expect(h.abort).toHaveBeenCalledTimes(1);

    const settleCb = (mocks.onSilentStopSettled.mock.calls[0] as unknown[])[1] as (
      sessionId: string,
      reason: string,
    ) => void;
    settleCb('feishu-session', 'skip');
    await waitForAssertion(() => {
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(handle.finalize).toHaveBeenCalledTimes(1);
    });
  });

  it('forgets cached IM sessions when Maker reports them closed', async () => {
    const first = setupSession(async () => ({ accepted: true }));
    const firstComplete = vi.fn();
    await runDefaultTurn(firstComplete, {
      userMessageId: 'msg-first',
      text: 'first message',
    });
    first.emit({ type: 'done', data: {} });
    await flushMicrotasks();

    expect(getRunner().getMakerSessionById('feishu-session')).toBe(first.session);

    emitMakerEvent({
      type: 'session:closed',
      sessionId: 'feishu-session',
      session: first.session,
      reason: 'requested',
    });

    expect(getRunner().getMakerSessionById('feishu-session')).toBeNull();

    const second = setupSession(async () => ({ accepted: true }));
    await runDefaultTurn(vi.fn(), {
      userMessageId: 'msg-second',
      text: 'second message',
    });

    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledTimes(1);
  });

  it('allows Claude Code IM sessions explicitly routed to an authenticated Anthropic provider without XD key', async () => {
    mocks.readXdGatewayApiKey.mockReturnValue(null);
    mocks.listProviders.mockResolvedValue([
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'builtin',
        connected: true,
        agents: ['claude-code'],
        models: {
          'claude-code': [{ id: 'claude-opus-4-8' }],
          codex: [],
        },
        routing: {
          'claude-code': { upstream: 'https://api.anthropic.com', authStrategy: 'oauth-passthrough' },
        },
      },
    ]);
    mocks.findActiveSession.mockResolvedValue({
      id: 'feishu-session',
      agentKind: 'claude-code',
      workingDir: 'F:\\XDMaker',
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      permissionMode: 'auto',
      fastMode: false,
      sdkSessionId: null,
      providerId: 'anthropic',
    });
    const h = setupSession(async () => ({ accepted: true }));

    await runDefaultTurn();

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.sendText).not.toHaveBeenCalledWith(
      'ou_user',
      ui.agent.apiKeyMissing,
      expect.anything(),
    );
  });

  it('rejects stale explicit provider routes instead of authenticating against another source', async () => {
    mocks.listProviders.mockResolvedValue([
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'builtin',
        connected: false,
        agents: ['claude-code'],
        models: {
          'claude-code': [{ id: 'claude-opus-4-8' }],
          codex: [],
        },
        routing: {
          'claude-code': { upstream: 'https://api.anthropic.com', authStrategy: 'oauth-passthrough' },
        },
      },
      {
        id: 'xd',
        name: 'XD',
        source: 'builtin',
        connected: true,
        agents: ['claude-code'],
        models: {
          'claude-code': [{ id: 'claude-opus-4-8' }],
          codex: [],
        },
        routing: {
          'claude-code': { upstream: 'https://gateway.example', authStrategy: 'gateway-key' },
        },
      },
    ]);
    mocks.findActiveSession.mockResolvedValue({
      id: 'feishu-session',
      agentKind: 'claude-code',
      workingDir: 'F:\\XDMaker',
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      permissionMode: 'auto',
      fastMode: false,
      sdkSessionId: null,
      providerId: 'anthropic',
    });
    const h = setupSession(async () => ({ accepted: true }));

    await runDefaultTurn();

    expect(h.send).not.toHaveBeenCalled();
    expect(mocks.feishuIm.sendText).toHaveBeenCalledWith(
      'ou_user',
      ui.agent.authMissing?.({
        agentKind: 'claude-code',
        model: 'claude-opus-4-8',
        providerId: 'anthropic',
        providerLabel: 'Anthropic',
        missing: 'provider-disconnected',
      }),
      { threadTs: undefined },
    );
  });

  it('reuses the default route provider snapshot for new-session auth checks', async () => {
    const providers = [
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
    ];
    mocks.listProviders.mockResolvedValue(providers);
    mocks.findActiveSession.mockResolvedValue(null);
    mocks.createSession.mockResolvedValue({
      id: 'feishu_cli_test_bot_ou_user',
      agentKind: 'claude-code',
      workingDir: 'F:\\XDMaker',
      model: 'claude-opus-4-7',
      effort: 'xhigh',
      permissionMode: 'auto',
      fastMode: false,
      sdkSessionId: null,
      providerId: null,
    });
    const h = setupSession(async () => ({ accepted: true }));

    await runDefaultTurn();

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(mocks.listProviders).toHaveBeenCalledTimes(1);
    expect(fakeRepo.prepareNewSession).toHaveBeenCalledWith(
      'cli_test_bot',
      'ou_user',
      undefined,
      providers,
    );
  });

  it('does not create a sticky default session when the selected agent is unauthenticated', async () => {
    mocks.readXdGatewayApiKey.mockReturnValue(null);
    mocks.findActiveSession.mockResolvedValue(null);
    mocks.createSession.mockResolvedValue({
      id: 'feishu-new-session',
      agentKind: 'claude-code',
      workingDir: 'F:\\XDMaker',
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      permissionMode: 'auto',
      fastMode: false,
      sdkSessionId: null,
      providerId: null,
    });

    await runDefaultTurn();

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.getMaker).not.toHaveBeenCalled();
    expect(mocks.feishuIm.sendText).toHaveBeenCalledWith(
      'ou_user',
      ui.agent.authMissing?.({
        agentKind: 'claude-code',
        model: 'claude-opus-4-7',
        providerId: 'xd',
        providerLabel: 'XD',
        missing: 'gateway-key',
      }),
      { threadTs: undefined },
    );
  });

  it('does not create a route target for config commands when the default route is unauthenticated', async () => {
    mocks.readXdGatewayApiKey.mockReturnValue(null);
    mocks.findActiveSession.mockResolvedValue(null);
    mocks.createSession.mockResolvedValue({
      id: 'feishu-new-session',
      agentKind: 'claude-code',
      workingDir: 'F:\\XDMaker',
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      permissionMode: 'auto',
      fastMode: false,
      sdkSessionId: null,
      providerId: null,
    });

    const target = await getRunner().resolveRouteTarget('cli_test_bot', 'ou_user');

    expect(target).toBeNull();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('rejects custom provider IM routes without a saved API key or auth header', async () => {
    mocks.listProviders.mockResolvedValue([
      {
        id: 'openrouter',
        name: 'OpenRouter',
        source: 'user',
        connected: true,
        agents: ['codex'],
        models: {
          'claude-code': [],
          codex: [{ id: 'meta/llama-4' }],
        },
        routing: {
          codex: {
            upstream: 'https://openrouter.ai/api/v1',
            authStrategy: 'api-key-header',
          },
        },
      },
    ]);
    mocks.findActiveSession.mockResolvedValue({
      id: 'feishu-session',
      agentKind: 'codex',
      workingDir: 'F:\\XDMaker',
      model: 'meta/llama-4',
      effort: 'high',
      permissionMode: 'auto',
      fastMode: false,
      sdkSessionId: null,
      providerId: 'openrouter',
    });
    const h = setupSession(async () => ({ accepted: true }));

    await runDefaultTurn();

    expect(h.send).not.toHaveBeenCalled();
    expect(mocks.feishuIm.sendText).toHaveBeenCalledWith(
      'ou_user',
      ui.agent.authMissing?.({
        agentKind: 'codex',
        model: 'meta/llama-4',
        providerId: 'openrouter',
        providerLabel: 'OpenRouter',
        missing: 'provider-key',
      }),
      { threadTs: undefined },
    );
  });

  it('stopActiveTurn aborts the running turn and drops queued sends without dispatching them', async () => {
    mocks.feishuIm.reactToMessage.mockImplementation(
      async (messageId: string) => `reaction-${messageId}`,
    );
    const h = setupSession(async () => ({ accepted: true }));
    await runDefaultTurn(vi.fn(), { userMessageId: 'msg-first', text: 'first user message' });
    await runDefaultTurn(vi.fn(), { userMessageId: 'msg-second', text: 'second user message' });
    await flushMicrotasks();
    expect(h.send).toHaveBeenCalledTimes(1);

    const result = await getRunner().stopActiveTurn({
      botContextId: 'cli_test_bot',
      userId: 'ou_user',
    });

    expect(result).toEqual({ stopped: true, droppedQueued: 1 });
    expect(h.abort).toHaveBeenCalledTimes(1);
    // 被丢弃的排队消息的 ack 表情要撤掉(否则永远挂在用户消息上)
    await waitForAssertion(() => {
      expect(mocks.feishuIm.removeMessageReaction).toHaveBeenCalledWith(
        'msg-second',
        'reaction-msg-second',
      );
    });

    // abort 触发的 done 不得把已丢弃的排队消息派发出去
    h.emit({ type: 'done', data: {} });
    await flushMicrotasks();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(mocks.persistUserMessage).toHaveBeenCalledTimes(1);
  });

  it('disposeAllSessions aborts and awaits an IM-owned in-flight turn', async () => {
    const h = setupSession(async () => ({ accepted: true }));
    const abortGate = deferred<void>();
    h.abort.mockImplementationOnce(async () => abortGate.promise);
    await runDefaultTurn();

    let disposed = false;
    const disposing = runner!.disposeAllSessions().then(() => {
      disposed = true;
    });
    expect(h.abort).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(disposed).toBe(false);

    abortGate.resolve(undefined);
    await disposing;
    expect(disposed).toBe(true);
  });

  it('stopActiveTurn reports idle when nothing is running or queued', async () => {
    const h = setupSession(async () => ({ accepted: true }));
    await runDefaultTurn();
    h.emit({ type: 'done', data: {} });
    await flushMicrotasks();

    const result = await getRunner().stopActiveTurn({
      botContextId: 'cli_test_bot',
      userId: 'ou_user',
    });

    expect(result).toEqual({ stopped: false, droppedQueued: 0 });
    expect(h.abort).not.toHaveBeenCalled();
  });

  it('stopActiveTurn reports idle when the session was never wired', async () => {
    const h = setupSession(async () => ({ accepted: true }));

    const result = await getRunner().stopActiveTurn({
      botContextId: 'cli_test_bot',
      userId: 'ou_user',
    });

    expect(result).toEqual({ stopped: false, droppedQueued: 0 });
    expect(h.abort).not.toHaveBeenCalled();
  });

  it('stopActiveTurn aborts a desktop-originated turn on an attached session (no channel TurnState)', async () => {
    // 接管模式: desktop 侧 turn 在跑, 本渠道 queue/sendQueue 都为空 —
    // isTurnRunning 是唯一的"在跑"信号, !stop 仍应中止它。
    const h = setupSession(async () => ({ accepted: true }));
    // 先跑一轮把 session wire 起来, 收口后模拟 desktop 侧开新 turn
    await runDefaultTurn();
    h.emit({ type: 'done', data: {} });
    await flushMicrotasks();
    h.isTurnRunning.mockReturnValue(true);

    const result = await getRunner().stopActiveTurn({
      botContextId: 'cli_test_bot',
      userId: 'ou_user',
    });

    expect(result).toEqual({ stopped: true, droppedQueued: 0 });
    expect(h.abort).toHaveBeenCalledTimes(1);
  });

  it('allows custom provider IM routes authenticated by custom headers without a saved API key', async () => {
    mocks.listProviders.mockResolvedValue([
      {
        id: 'header-auth',
        name: 'Header Auth',
        source: 'user',
        connected: true,
        agents: ['codex'],
        models: {
          'claude-code': [],
          codex: [{ id: 'meta/llama-4' }],
        },
        routing: {
          codex: {
            upstream: 'https://header-auth.example/v1',
            authStrategy: 'api-key-header',
            headerOverride: { Authorization: 'Bearer static-token' },
          },
        },
      },
    ]);
    mocks.findActiveSession.mockResolvedValue({
      id: 'feishu-session',
      agentKind: 'codex',
      workingDir: 'F:\\XDMaker',
      model: 'meta/llama-4',
      effort: 'high',
      permissionMode: 'auto',
      fastMode: false,
      sdkSessionId: null,
      providerId: 'header-auth',
    });
    const h = setupSession(async () => ({ accepted: true }));

    await runDefaultTurn();

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(mocks.feishuIm.sendText).not.toHaveBeenCalledWith(
      'ou_user',
      ui.agent.apiKeyMissing,
      expect.anything(),
    );
  });

  // ── 非 threadScoped 渠道的新上下文 oneshot 起名 ──────────────────────────────
  // 触发条件: generatedTitlePrefix 已声明 && row.sdkSessionId == null(首次建行
  // 或 /new 重置后的新上下文首条消息)。threadScoped(slack)路径的回归在
  // turnRunnerThreadRouting.test.ts。
  describe('non-threadScoped generatedTitlePrefix title generation', () => {
    function makePrefixedRunner(): ImTurnRunner {
      return createTurnRunner(
        {
          ...fakeAdapter,
          sessions: { ...fakeAdapter.sessions, generatedTitlePrefix: '[飞书·DM] ' },
        },
        fakeRepo,
        fakeCards,
      );
    }

    async function runPrefixedTurn(prefixedRunner: ImTurnRunner): Promise<void> {
      try {
        await prefixedRunner.runAgentTurn({
          botContextId: 'cli_test_bot',
          userId: 'ou_user',
          userMessageId: 'msg-user',
          text: '帮我修个 bug',
          attachments: [],
        });
        await flushMicrotasks();
      } finally {
        await prefixedRunner.disposeAllSessions();
      }
    }

    it('sdkSessionId == null(新上下文)触发 oneshot 起名, 前缀透传', async () => {
      setupSession(async () => ({ accepted: false, reason: 'cancelled-before-dispatch' }));
      await runPrefixedTurn(makePrefixedRunner());

      expect(mocks.generateAndPersistFbotTitle).toHaveBeenCalledWith(
        'feishu-session',
        '帮我修个 bug',
        '[飞书·DM] ',
      );
    });

    it('registers title generation as background work without delaying turn dispatch', async () => {
      const titleGate = deferred<string | null>();
      mocks.generateAndPersistFbotTitle.mockImplementationOnce(async () => titleGate.promise);
      setupSession(async () => ({ accepted: false, reason: 'cancelled-before-dispatch' }));
      const prefixedRunner = makePrefixedRunner();
      const backgroundTasks: Promise<void>[] = [];
      const trackBackgroundTask = vi.fn((operation: () => Promise<void>) => {
        backgroundTasks.push(operation());
      });

      try {
        await prefixedRunner.runAgentTurn({
          botContextId: 'cli_test_bot',
          userId: 'ou_user',
          userMessageId: 'msg-user',
          text: '帮我修个 bug',
          attachments: [],
          trackBackgroundTask,
        });

        expect(trackBackgroundTask).toHaveBeenCalledOnce();
        expect(backgroundTasks).toHaveLength(1);
        titleGate.resolve('[飞书·DM] 修复问题');
        await Promise.all(backgroundTasks);
      } finally {
        await prefixedRunner.disposeAllSessions();
      }
    });

    it('sdkSessionId 非空(上下文进行中)不重复起名', async () => {
      mocks.findActiveSession.mockResolvedValue({
        id: 'feishu-session',
        agentKind: 'claude-code',
        workingDir: 'F:\\XDMaker',
        model: 'claude-opus-4-7',
        effort: 'xhigh',
        permissionMode: 'bypassPermissions',
        fastMode: false,
        sdkSessionId: 'sdk-ctx-1',
        providerId: null,
      });
      setupSession(async () => ({ accepted: false, reason: 'cancelled-before-dispatch' }));
      await runPrefixedTurn(makePrefixedRunner());

      expect(mocks.generateAndPersistFbotTitle).not.toHaveBeenCalled();
    });

    it('渠道未声明 generatedTitlePrefix 时(默认 adapter)不起名', async () => {
      setupSession(async () => ({ accepted: false, reason: 'cancelled-before-dispatch' }));
      await runDefaultTurn();
      await flushMicrotasks();

      expect(mocks.generateAndPersistFbotTitle).not.toHaveBeenCalled();
    });
  });
});
