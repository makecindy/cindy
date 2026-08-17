/**
 * cardActionHandler — control:session-pick 重复接管替换流程(thread 模型)。
 *
 * 语义: 目标 desktop session 已被另一个 thread 接管时, attach 原子替换
 * persisted owner；成功后才收口旧锚点并 prewire 新渠道。attach 失败时旧
 * binding / listener / 锚点都保持原状。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelIM, IMCardActionEvent } from '@cindy/im';
import type { DesktopCcPrefs } from '../../index';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bindingGet: vi.fn(),
  bindingAttach: vi.fn(),
  bindingAttachWithResult: vi.fn(),
  executeDetach: vi.fn(),
  generateTakeoverSummary: vi.fn(),
  getMaker: vi.fn(),
  closeSession: vi.fn(async () => {}),
  getDesktopCcPrefs: vi.fn<() => DesktopCcPrefs | null>(() => null),
  resolveLenientSessionRoute: vi.fn(),
  applyRuntimeSetModelChange:
    vi.fn<(input: unknown) => Promise<{ status: 'applied' | 'deferred' }>>(),
  registerPendingCredentialSwitchForSession: vi.fn(),
  clearPendingCredentialSwitchForSession: vi.fn(),
  wakeSessionInputAfterCredentialSwitch: vi.fn(),
  getPendingCredentialSwitchTarget: vi.fn(() => undefined),
  readModelRouteSnapshot: vi.fn(
    async (): Promise<{ model: string; effort: string; providerId: string | null } | null> => null,
  ),
  readPermissionMode: vi.fn(async () => 'auto'),
  updatePermissionMode: vi.fn(async () => {}),
  updateModelEffort: vi.fn(async () => {}),
  getSessionProvider: vi.fn<() => string | null>(() => null),
  setSessionProvider: vi.fn(),
  isSessionInTurn: vi.fn(() => false),
  cancelPendingAgentSwitchForSession: vi.fn(),
  withSendToSessionLock: vi.fn(
    async (_sessionId: string, task: () => Promise<unknown>) => task(),
  ),
  // 禁止回落 cwd:TEMP 是 Windows 独有变量,macOS 上回落 cwd 会让传递 import 的
  // 写盘副作用落进仓库工作区(见 authAdaptersImportPurity.test.ts 记录的事故)。
  userDataDir: process.env.TMPDIR ?? process.env.TEMP ?? '/tmp',
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => mocks.userDataDir,
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({ createLogger: () => mocks.logger }));
vi.mock('../../../maker-host', () => ({ getMaker: mocks.getMaker }));
vi.mock('../../../maker-host/model-route-guard-live', () => ({
  resolveLenientSessionRoute: mocks.resolveLenientSessionRoute,
}));
vi.mock('../../index', () => ({ getDesktopCcPrefs: mocks.getDesktopCcPrefs }));
vi.mock('../controlProjects', () => ({
  listProjectsForControl: vi.fn(async () => []),
  listSessionsForWorkspace: vi.fn(async () => []),
  readSessionTitle: vi.fn(async () => null),
}));
vi.mock('../../binding', () => ({
  bindingStore: {
    get: mocks.bindingGet,
    attach: mocks.bindingAttach,
    attachWithResult: mocks.bindingAttachWithResult,
  },
  executeDetach: mocks.executeDetach,
}));
vi.mock('../sessionSummary', () => ({
  generateTakeoverSummary: mocks.generateTakeoverSummary,
}));
vi.mock('../fbotTitle', () => ({
  FBOT_DRAFT_TITLE: 'FBot · New',
}));
vi.mock('../sessionRepo', () => ({
  readModelRouteSnapshot: mocks.readModelRouteSnapshot,
  readPermissionMode: mocks.readPermissionMode,
  touchUserSent: vi.fn(async () => {}),
  updateModelEffort: mocks.updateModelEffort,
  updatePermissionMode: mocks.updatePermissionMode,
}));
vi.mock('../../../maker-host/session-provider-store', () => ({
  getSessionProvider: mocks.getSessionProvider,
  normalizeSessionProviderId: (providerId: string | null | undefined) =>
    providerId === undefined ? undefined : providerId?.trim() || null,
  setSessionProvider: mocks.setSessionProvider,
}));
vi.mock('../../../maker-ipc/runtimeSetModel', () => ({
  applyRuntimeSetModelChange: mocks.applyRuntimeSetModelChange,
}));
vi.mock('../../../maker-ipc/register', () => ({
  cancelPendingAgentSwitchForSession: mocks.cancelPendingAgentSwitchForSession,
  isSessionInTurn: mocks.isSessionInTurn,
  registerPendingCredentialSwitchForSession: mocks.registerPendingCredentialSwitchForSession,
  clearPendingCredentialSwitchForSession: mocks.clearPendingCredentialSwitchForSession,
  wakeSessionInputAfterCredentialSwitch: mocks.wakeSessionInputAfterCredentialSwitch,
  getPendingCredentialSwitchTarget: mocks.getPendingCredentialSwitchTarget,
  withSendToSessionLock: mocks.withSendToSessionLock,
}));
vi.mock('../pendingInteractions', () => ({
  resolvePending: vi.fn(() => false),
  lookupPending: vi.fn(() => null),
}));

import { ui as slackUi } from './threadUiFixture';
import { readSessionTitle } from '../controlProjects';
import { createCardActionHandler } from '../cardActionHandler';
import { resolvePending } from '../pendingInteractions';
import {
  activateImAccountBoundary,
  captureImAccountGeneration,
  deactivateImAccountBoundary,
  waitForImAccountGenerationIdle,
} from '../../accountBoundary';
import type { ImCardBuilders } from '../cardBuilders';
import type { ImChannelAdapter } from '../types';
import type { ImTurnRunner } from '../turnRunner';

function makeIm() {
  const im = {
    sendText: vi.fn(async () => ({ messageId: 'm-text' })),
    sendMarkdownText: vi.fn(async () => ({ messageId: 'm-md' })),
    sendInteractiveCard: vi.fn(async () => ({ messageId: 'm-card' })),
    updateInteractiveCard: vi.fn(async () => {}),
    patchMarkdownCard: vi.fn(async () => {}),
    threadKeyForMessage: vi.fn((id: string) => id),
    onCardAction: vi.fn(),
  };
  return im as unknown as ChannelIM & typeof im;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cards = {
  buildResolvedCard: (text: string) => ({ title: 'resolved', body: text, buttons: [] }),
  buildControlPickerCard: vi.fn(() => ({ title: 'picker', body: '', buttons: [] })),
  buildControlSessionPickerCard: vi.fn(),
} as unknown as ImCardBuilders;

const turnRunner = {
  getMakerSessionById: vi.fn(() => null),
  prewireAttachedSession: vi.fn(async () => {}),
} as unknown as ImTurnRunner & { prewireAttachedSession: ReturnType<typeof vi.fn> };

const adapter = {
  channel: 'slack',
  threadScoped: true,
  ui: slackUi,
  config: { agentKind: 'claude-code', defaultModel: 'm', defaultPermissionMode: 'acceptEdits' },
} as unknown as ImChannelAdapter;

function registeredHandler(
  handler: ((e: IMCardActionEvent) => Promise<void>) | null,
): (e: IMCardActionEvent) => Promise<void> {
  if (!handler) throw new Error('card action handler 未注册');
  return handler;
}

function slackThreadUi(): NonNullable<typeof slackUi.thread> {
  if (!slackUi.thread) throw new Error('slack thread UI 未配置');
  return slackUi.thread;
}

/** 触发 control:session-pick(锚点流程: payload 带 anchorMessageId + event 带 scopeKey)。 */
async function pressSessionPick(
  im: ChannelIM,
  overrides?: Partial<IMCardActionEvent>,
  testAdapter: ImChannelAdapter = adapter,
): Promise<void> {
  const attach = createCardActionHandler(testAdapter, cards, turnRunner);
  let handler: ((e: IMCardActionEvent) => Promise<void>) | null = null;
  (im.onCardAction as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
    handler = cb;
    return () => {};
  });
  attach(im)();
  await registeredHandler(handler)({
    messageId: 'picker-msg',
    senderId: 'U_NEW',
    buttonId: 'control:session-pick',
    scopeKey: 'anchor-new.ts',
    payload: {
      botAppId: 'BOT1',
      sessionId: 'sess-target',
      sessionTitle: 'My Session',
      displayName: 'proj',
      anchorMessageId: 'anchor-new',
    },
    ...overrides,
  } as IMCardActionEvent);
}

beforeEach(() => {
  vi.clearAllMocks();
  activateImAccountBoundary();
  (resolvePending as ReturnType<typeof vi.fn>).mockReturnValue(false);
  mocks.generateTakeoverSummary.mockResolvedValue('brief');
  mocks.bindingAttach.mockResolvedValue(undefined);
  mocks.bindingAttachWithResult.mockResolvedValue({ displaced: null });
  mocks.executeDetach.mockResolvedValue({ wasAttached: true, targetSessionId: 'sess-target' });
  mocks.readModelRouteSnapshot.mockResolvedValue(null);
  mocks.readPermissionMode.mockResolvedValue('auto');
  mocks.updatePermissionMode.mockResolvedValue(undefined);
  mocks.applyRuntimeSetModelChange.mockResolvedValue({ status: 'applied' });
  mocks.getMaker.mockReturnValue({
    createSession: vi.fn(async () => ({ id: 'sess-new' })),
    closeSession: mocks.closeSession,
    getCapabilities: vi.fn(() => ({
      permissionModes: [
        { id: 'ask' },
        { id: 'auto' },
        { id: 'bypassPermissions' },
      ],
    })),
  });
  mocks.getDesktopCcPrefs.mockReturnValue(null);
  // 路由裁决默认「原样放行」：真实 model-route-guard-live 会读 provider 目录,
  // 本 harness 不搭目录 fixture; 需要裁决语义的用例自己 mockResolvedValue 覆盖。
  mocks.resolveLenientSessionRoute.mockImplementation(
    async (_agent: string, model: string | undefined, providerId: string | null) => ({
      model,
      providerId,
      degraded: false,
    }),
  );
  (turnRunner.getMakerSessionById as ReturnType<typeof vi.fn>).mockReturnValue(null);
});

describe('plan_review IM 卡片决策', () => {
  it('Reject 按钮按取消语义 resolve, 不作为修订反馈', async () => {
    const im = makeIm();
    const attach = createCardActionHandler(adapter, cards, turnRunner);
    let handler: ((e: IMCardActionEvent) => Promise<void>) | null = null;
    (im.onCardAction as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
      handler = cb;
      return () => {};
    });
    (resolvePending as ReturnType<typeof vi.fn>).mockReturnValue(true);

    attach(im)();
    await registeredHandler(handler)({
      channelName: 'slack',
      chatId: 'C_PLAN',
      messageId: 'plan-card',
      senderId: 'U_REJECT',
      buttonId: 'plan:reject',
      payload: { requestId: 'plan-request-1' },
    } as IMCardActionEvent);

    expect(resolvePending).toHaveBeenCalledWith('plan-request-1', {
      kind: 'plan_review',
      behavior: 'deny',
      reason: 'user_rejected',
      dismissed: true,
    });
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'plan-card',
      expect.objectContaining({ body: slackUi.cards.plan.resolvedRejected }),
    );
  });

  it('keeps the complete async card callback inside the closing account scope', async () => {
    const updateGate = deferred();
    const im = makeIm();
    im.updateInteractiveCard.mockImplementationOnce(async () => updateGate.promise);
    const attach = createCardActionHandler(adapter, cards, turnRunner);
    let handler: ((e: IMCardActionEvent) => Promise<void>) | null = null;
    (im.onCardAction as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
      handler = cb;
      return () => {};
    });
    (resolvePending as ReturnType<typeof vi.fn>).mockReturnValue(true);
    attach(im)();
    const accountGeneration = captureImAccountGeneration();
    expect(accountGeneration).not.toBeNull();

    const handling = registeredHandler(handler)({
      channelName: 'slack',
      chatId: 'C_PLAN',
      messageId: 'plan-card',
      senderId: 'U_REJECT',
      buttonId: 'plan:reject',
      payload: { requestId: 'plan-request-drain' },
    } as IMCardActionEvent);
    await vi.waitFor(() => expect(im.updateInteractiveCard).toHaveBeenCalledOnce());
    deactivateImAccountBoundary();

    let drained = false;
    const draining = waitForImAccountGenerationIdle(accountGeneration!).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    updateGate.resolve();
    await handling;
    await draining;
    expect(drained).toBe(true);
  });
});

describe('control:session-pick 重复接管替换', () => {
  it('按串行 attach 实际替换的 owner 收口旧锚点', async () => {
    const oldIdentity = {
      channel: 'slack',
      botContextId: 'BOT1',
      userId: 'U_OLD',
      scopeKey: 'anchor-old.ts',
    };
    mocks.bindingAttachWithResult.mockResolvedValueOnce({
      displaced: {
        identity: oldIdentity,
        attachedViaCardMessageId: 'anchor-old',
      },
    });

    const im = makeIm();
    await pressSessionPick(im);

    expect(mocks.executeDetach).not.toHaveBeenCalled();
    // 旧锚点卡收口为 takeoverReplaced
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'anchor-old',
      expect.objectContaining({
        body: slackThreadUi().takeoverReplaced('My Session'),
      }),
    );
    // 新 thread 正常 attach(identity 带新 scopeKey)
    expect(mocks.bindingAttachWithResult).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U_NEW', scopeKey: 'anchor-new.ts' }),
      'sess-target',
      expect.anything(),
    );
    const oldAnchorPatchIndex = (
      im.updateInteractiveCard as ReturnType<typeof vi.fn>
    ).mock.calls.findIndex(([messageId]) => messageId === 'anchor-old');
    expect(mocks.bindingAttachWithResult.mock.invocationCallOrder[0]).toBeLessThan(
      (im.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.invocationCallOrder[
        oldAnchorPatchIndex
      ]!,
    );
    // 新锚点卡 morph 成已接管(带 🚪 按钮)
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'anchor-new',
      expect.objectContaining({
        buttons: [expect.objectContaining({ id: 'control:thread-exit' })],
      }),
    );
  });

  it('新 thread attach 失败 → 旧 binding/listener/锚点保持不变', async () => {
    mocks.bindingAttachWithResult.mockRejectedValueOnce(new Error('db locked'));

    const im = makeIm();
    await pressSessionPick(im);

    expect(mocks.bindingAttachWithResult).toHaveBeenCalled();
    expect(mocks.executeDetach).not.toHaveBeenCalled();
    expect(turnRunner.prewireAttachedSession).not.toHaveBeenCalled();
    // 新锚点显示写入失败
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'anchor-new',
      expect.objectContaining({
        body: slackUi.cards.control.attachFailed('db locked'),
      }),
    );
    // 旧锚点不该被收口(接管还在)
    expect(im.updateInteractiveCard).not.toHaveBeenCalledWith('anchor-old', expect.anything());
  });

  it('跨渠道旧 binding(feishu)→ 原子替换但不 patch 旧卡(本 im 实例 patch 不动)', async () => {
    mocks.bindingAttachWithResult.mockResolvedValueOnce({
      displaced: {
        identity: {
          channel: 'feishu',
          botContextId: 'FBOT',
          userId: 'ou_old',
        },
        attachedViaCardMessageId: 'om_feishu_card',
      },
    });

    const im = makeIm();
    await pressSessionPick(im);

    expect(mocks.executeDetach).not.toHaveBeenCalled();
    expect(im.updateInteractiveCard).not.toHaveBeenCalledWith('om_feishu_card', expect.anything());
    expect(mocks.bindingAttachWithResult).toHaveBeenCalled();
  });

  it('Discord 接管普通会话由 attach 原子替换 Feishu，再 prewire Discord', async () => {
    const discordAdapter = {
      ...adapter,
      channel: 'discord',
      threadScoped: false,
    } as ImChannelAdapter;

    const im = makeIm();
    await pressSessionPick(im, undefined, discordAdapter);

    expect(mocks.executeDetach).not.toHaveBeenCalled();
    expect(mocks.bindingAttach).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'discord', userId: 'U_NEW' }),
      'sess-target',
      expect.anything(),
    );
    expect(turnRunner.prewireAttachedSession).toHaveBeenCalledWith('BOT1', 'U_NEW');
    expect(mocks.bindingAttach.mock.invocationCallOrder[0]).toBeLessThan(
      turnRunner.prewireAttachedSession.mock.invocationCallOrder[0]!,
    );
  });

  it('普通渠道新 attach 失败时不显式 detach 旧 binding', async () => {
    mocks.bindingAttach.mockRejectedValueOnce(new Error('db locked'));
    const discordAdapter = {
      ...adapter,
      channel: 'discord',
      threadScoped: false,
    } as ImChannelAdapter;

    const im = makeIm();
    await pressSessionPick(im, undefined, discordAdapter);

    expect(mocks.bindingAttach).toHaveBeenCalled();
    expect(mocks.executeDetach).not.toHaveBeenCalled();
    expect(turnRunner.prewireAttachedSession).not.toHaveBeenCalled();
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'picker-msg',
      expect.objectContaining({ body: slackUi.cards.control.attachFailed('db locked') }),
    );
  });

  it('无旧 binding → 不 detach, 直接 attach', async () => {
    const im = makeIm();
    await pressSessionPick(im);

    expect(mocks.executeDetach).not.toHaveBeenCalled();
    expect(mocks.bindingAttachWithResult).toHaveBeenCalled();
  });
});

describe('control:start 按钮(免打字重新发起远程控制)', () => {
  async function pressStart(im: ChannelIM): Promise<void> {
    const attach = createCardActionHandler(adapter, cards, turnRunner);
    let handler: ((e: IMCardActionEvent) => Promise<void>) | null = null;
    (im.onCardAction as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
      handler = cb;
      return () => {};
    });
    attach(im)();
    await registeredHandler(handler)({
      messageId: 'exited-card',
      senderId: 'U_NEW',
      buttonId: 'control:start',
      payload: { botAppId: 'BOT1' },
    } as unknown as IMCardActionEvent);
  }

  it('按下 → 新锚点卡 + thread 内选择卡, 原卡不收口(常驻入口可反复按)', async () => {
    const im = makeIm();
    await pressStart(im);

    // 第一发: 顶层锚点卡(远程控制)
    expect(im.sendInteractiveCard).toHaveBeenNthCalledWith(
      1,
      'U_NEW',
      expect.objectContaining({ title: slackThreadUi().controlAnchorCard.title }),
    );
    // 第二发: 工作区选择卡进锚点 thread(threadTs = 锚点 ts)
    expect(im.sendInteractiveCard).toHaveBeenNthCalledWith(2, 'U_NEW', expect.anything(), {
      threadTs: 'm-card',
    });
    // 原卡(收口卡/欢迎卡)不收口 — 按钮常驻
    expect(im.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it('锚点卡发送失败 → 同样不动原卡(按钮保留可重试)', async () => {
    const im = makeIm();
    im.sendInteractiveCard.mockRejectedValueOnce(new Error('slack 500'));
    await pressStart(im);
    expect(im.updateInteractiveCard).not.toHaveBeenCalled();
  });
});

describe('/permission Full access 确认', () => {
  async function pressPermission(
    im: ChannelIM,
    buttonId: 'permmode:pick' | 'permmode:confirm-full-access' | 'permmode:cancel-full-access',
  ): Promise<void> {
    const attach = createCardActionHandler(adapter, cards, turnRunner);
    let handler: ((e: IMCardActionEvent) => Promise<void>) | null = null;
    (im.onCardAction as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
      handler = cb;
      return () => {};
    });
    attach(im)();
    await registeredHandler(handler)({
      messageId: 'permission-card',
      senderId: 'U_NEW',
      buttonId,
      payload: {
        sessionId: 'sess-target',
        mode: 'bypassPermissions',
        modeLabel: 'Full access',
        agentKind: 'codex',
      },
    } as unknown as IMCardActionEvent);
  }

  it('first replaces the picker with a confirmation card without changing state', async () => {
    const im = makeIm();

    await pressPermission(im, 'permmode:pick');

    expect(mocks.updatePermissionMode).not.toHaveBeenCalled();
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'permission-card',
      expect.objectContaining({
        title: slackUi.cards.permissionMode.fullAccessConfirmTitle,
        buttons: expect.arrayContaining([
          expect.objectContaining({ id: 'permmode:confirm-full-access', type: 'danger' }),
          expect.objectContaining({ id: 'permmode:cancel-full-access' }),
        ]),
      }),
    );
  });

  it('changes runtime before persistence only after explicit confirmation', async () => {
    const live = { setPermissionMode: vi.fn(async () => {}) };
    (turnRunner.getMakerSessionById as ReturnType<typeof vi.fn>).mockReturnValue(live);
    const im = makeIm();

    await pressPermission(im, 'permmode:confirm-full-access');

    expect(live.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    expect(mocks.updatePermissionMode).toHaveBeenCalledWith('sess-target', 'bypassPermissions');
    expect(live.setPermissionMode.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updatePermissionMode.mock.invocationCallOrder[0]!,
    );
  });

  it('rolls runtime back and reports failure when persistence fails', async () => {
    const live = { setPermissionMode: vi.fn(async () => {}) };
    (turnRunner.getMakerSessionById as ReturnType<typeof vi.fn>).mockReturnValue(live);
    mocks.updatePermissionMode.mockRejectedValueOnce(new Error('db locked'));
    const im = makeIm();

    await pressPermission(im, 'permmode:confirm-full-access');

    expect(live.setPermissionMode).toHaveBeenNthCalledWith(1, 'bypassPermissions');
    expect(live.setPermissionMode).toHaveBeenNthCalledWith(2, 'auto');
    expect(im.updateInteractiveCard).toHaveBeenLastCalledWith(
      'permission-card',
      expect.objectContaining({ body: slackUi.cards.permissionMode.failed('db locked') }),
    );
  });

  it('cancels without changing runtime or persistence', async () => {
    const im = makeIm();

    await pressPermission(im, 'permmode:cancel-full-access');

    expect(mocks.updatePermissionMode).not.toHaveBeenCalled();
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'permission-card',
      expect.objectContaining({ body: slackUi.cards.permissionMode.fullAccessCancelled }),
    );
  });
});

describe('model:pick 持久化失败', () => {
  async function pressModelPick(im: ChannelIM, providerId = 'anthropic'): Promise<void> {
    const attach = createCardActionHandler(adapter, cards, turnRunner);
    let handler: ((e: IMCardActionEvent) => Promise<void>) | null = null;
    (im.onCardAction as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
      handler = cb;
      return () => {};
    });
    attach(im)();
    await registeredHandler(handler)({
      messageId: 'model-card',
      senderId: 'U_NEW',
      buttonId: 'model:pick',
      payload: {
        sessionId: 'sess-target',
        modelId: 'claude-opus-4-7',
        modelLabel: 'Opus 4.7',
        effort: 'high',
        providerId,
      },
    } as unknown as IMCardActionEvent);
  }

  it('在共享 session 锁内提交 DB 与运行态选择', async () => {
    const lockGate = deferred();
    mocks.withSendToSessionLock.mockImplementationOnce(async (_sessionId, task) => {
      await lockGate.promise;
      return task();
    });
    const im = makeIm();

    const pickPromise = pressModelPick(im);
    await vi.waitFor(() => {
      expect(mocks.withSendToSessionLock).toHaveBeenCalledWith(
        'sess-target',
        expect.any(Function),
      );
    });
    expect(mocks.updateModelEffort).not.toHaveBeenCalled();
    expect(mocks.applyRuntimeSetModelChange).not.toHaveBeenCalled();

    lockGate.resolve();
    await pickPromise;

    expect(mocks.updateModelEffort).toHaveBeenCalled();
    expect(mocks.applyRuntimeSetModelChange).toHaveBeenCalled();
    expect(mocks.cancelPendingAgentSwitchForSession).toHaveBeenCalledWith('sess-target');
  });

  it('在持久化和运行态切换前统一归一化 providerId', async () => {
    const im = makeIm();

    await pressModelPick(im, '  anthropic  ');

    expect(mocks.updateModelEffort).toHaveBeenCalledWith(
      'sess-target',
      'claude-opus-4-7',
      'high',
      'anthropic',
    );
    expect(mocks.applyRuntimeSetModelChange).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'anthropic' }),
    );
  });

  it('busy provider 切换注入 pending hooks，并在 deferred 时不 mid-turn 改 effort', async () => {
    const live = {
      agentKind: 'codex',
      remoteHostId: null,
      model: 'gpt-5.4',
      setModel: vi.fn(async () => {}),
      setEffort: vi.fn(async () => {}),
    };
    (turnRunner.getMakerSessionById as ReturnType<typeof vi.fn>).mockReturnValue(live);
    mocks.applyRuntimeSetModelChange.mockImplementationOnce(async (input: unknown) => {
      const hooks = input as {
        registerPendingCredentialSwitch?: (
          sessionId: string,
          target: { model: string; providerId: string | null },
        ) => void;
      };
      hooks.registerPendingCredentialSwitch?.('sess-target', {
        model: 'claude-opus-4-7',
        providerId: 'anthropic',
      });
      return { status: 'deferred' as const };
    });
    const im = makeIm();

    await pressModelPick(im);

    expect(mocks.applyRuntimeSetModelChange).toHaveBeenCalledWith(
      expect.objectContaining({
        registerPendingCredentialSwitch: mocks.registerPendingCredentialSwitchForSession,
        clearPendingCredentialSwitch: mocks.clearPendingCredentialSwitchForSession,
        wakeSessionInputQueue: mocks.wakeSessionInputAfterCredentialSwitch,
        getPendingCredentialSwitch: mocks.getPendingCredentialSwitchTarget,
      }),
    );
    expect(mocks.registerPendingCredentialSwitchForSession).toHaveBeenCalledWith('sess-target', {
      model: 'claude-opus-4-7',
      providerId: 'anthropic',
    });
    expect(live.setEffort).not.toHaveBeenCalled();
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'model-card',
      expect.objectContaining({ body: slackUi.cards.model.resolved('Opus 4.7', 'high') }),
    );
  });

  it('DB 未落盘时不触碰 runtime，并收口失败卡', async () => {
    const live = {
      agentKind: 'claude-code',
      remoteHostId: null,
      model: 'claude-sonnet-4-6',
      setModel: vi.fn(async () => {}),
      setEffort: vi.fn(async () => {}),
    };
    (turnRunner.getMakerSessionById as ReturnType<typeof vi.fn>).mockReturnValue(live);
    mocks.readModelRouteSnapshot.mockResolvedValueOnce({
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      providerId: 'openrouter',
    });
    mocks.updateModelEffort.mockRejectedValueOnce(new Error('db locked'));
    const im = makeIm();

    await pressModelPick(im);

    expect(mocks.updateModelEffort).toHaveBeenCalledWith(
      'sess-target',
      'claude-opus-4-7',
      'high',
      'anthropic',
    );
    expect(mocks.applyRuntimeSetModelChange).not.toHaveBeenCalled();
    expect(mocks.cancelPendingAgentSwitchForSession).not.toHaveBeenCalled();
    expect(mocks.setSessionProvider).not.toHaveBeenCalled();
    expect(live.setModel).not.toHaveBeenCalled();
    expect(live.setEffort).not.toHaveBeenCalled();
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'model-card',
      expect.objectContaining({ body: slackUi.cards.model.failed('db locked') }),
    );
  });

  it('runtime setModel 失败时恢复已落盘的旧路由', async () => {
    mocks.readModelRouteSnapshot.mockResolvedValueOnce({
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      providerId: 'openrouter',
    });
    mocks.applyRuntimeSetModelChange.mockRejectedValueOnce(new Error('runtime rejected'));
    const im = makeIm();

    await pressModelPick(im);

    expect(mocks.updateModelEffort).toHaveBeenNthCalledWith(
      1,
      'sess-target',
      'claude-opus-4-7',
      'high',
      'anthropic',
    );
    expect(mocks.updateModelEffort).toHaveBeenNthCalledWith(
      2,
      'sess-target',
      'claude-sonnet-4-6',
      'medium',
      'openrouter',
    );
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'model-card',
      expect.objectContaining({ body: slackUi.cards.model.failed('runtime rejected') }),
    );
    expect(mocks.cancelPendingAgentSwitchForSession).not.toHaveBeenCalled();
  });

  it('live setEffort 失败时恢复 route store 和 live model', async () => {
    const live = {
      agentKind: 'claude-code',
      remoteHostId: null,
      model: 'claude-sonnet-4-6',
      setModel: vi.fn(async () => {}),
      setEffort: vi
        .fn()
        .mockRejectedValueOnce(new Error('effort rejected'))
        .mockResolvedValue(undefined),
    };
    (turnRunner.getMakerSessionById as ReturnType<typeof vi.fn>).mockReturnValue(live);
    mocks.readModelRouteSnapshot.mockResolvedValueOnce({
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      providerId: 'openrouter',
    });
    const im = makeIm();

    await pressModelPick(im);

    expect(mocks.updateModelEffort).toHaveBeenNthCalledWith(
      1,
      'sess-target',
      'claude-opus-4-7',
      'high',
      'anthropic',
    );
    expect(mocks.updateModelEffort).toHaveBeenNthCalledWith(
      2,
      'sess-target',
      'claude-sonnet-4-6',
      'medium',
      'openrouter',
    );
    expect(mocks.setSessionProvider).toHaveBeenCalledWith('sess-target', 'openrouter');
    expect(live.setModel).toHaveBeenCalledWith('claude-sonnet-4-6', {
      providerId: 'openrouter',
    });
    expect(live.setEffort).toHaveBeenNthCalledWith(1, 'high');
    expect(live.setEffort).toHaveBeenNthCalledWith(2, 'medium');
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'model-card',
      expect.objectContaining({ body: slackUi.cards.model.failed('effort rejected') }),
    );
    expect(mocks.cancelPendingAgentSwitchForSession).not.toHaveBeenCalled();
  });

  it('回滚时保留 DB 快照中明确清空的 provider', async () => {
    const live = {
      agentKind: 'claude-code',
      remoteHostId: null,
      model: 'claude-sonnet-4-6',
      setModel: vi.fn(async () => {}),
      setEffort: vi
        .fn()
        .mockRejectedValueOnce(new Error('effort rejected'))
        .mockResolvedValue(undefined),
    };
    (turnRunner.getMakerSessionById as ReturnType<typeof vi.fn>).mockReturnValue(live);
    mocks.readModelRouteSnapshot.mockResolvedValueOnce({
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      providerId: null,
    });
    mocks.getSessionProvider.mockReturnValueOnce('stale-provider');
    const im = makeIm();

    await pressModelPick(im);

    expect(mocks.updateModelEffort).toHaveBeenNthCalledWith(
      2,
      'sess-target',
      'claude-sonnet-4-6',
      'medium',
      null,
    );
    expect(mocks.setSessionProvider).toHaveBeenCalledWith('sess-target', null);
    expect(live.setModel).toHaveBeenCalledWith('claude-sonnet-4-6', {
      providerId: null,
    });
  });
});

describe('control:new 新建会话来源持久化', () => {
  async function pressNew(im: ChannelIM, testAdapter = adapter): Promise<void> {
    const attach = createCardActionHandler(testAdapter, cards, turnRunner);
    let handler: ((e: IMCardActionEvent) => Promise<void>) | null = null;
    (im.onCardAction as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
      handler = cb;
      return () => {};
    });
    attach(im)();
    await registeredHandler(handler)({
      messageId: 'picker-msg',
      senderId: 'U_NEW',
      buttonId: 'control:new',
      scopeKey: 'anchor-new.ts',
      payload: {
        botAppId: 'BOT1',
        workingDir: 'E:\\proj',
        displayName: 'proj',
        anchorMessageId: 'anchor-new',
      },
    } as unknown as IMCardActionEvent);
  }

  it('thread 模式新建后持久化 desktop 默认 provider 并写 route store', async () => {
    mocks.getDesktopCcPrefs.mockReturnValue({
      providerId: 'anthropic',
      model: 'claude-opus-4-7',
      effort: 'high',
      permissionMode: 'acceptEdits',
      fastMode: false,
    });
    const im = makeIm();

    await pressNew(im);

    expect(mocks.updateModelEffort).toHaveBeenCalledWith(
      'sess-new',
      'claude-opus-4-7',
      'high',
      'anthropic',
    );
    expect(mocks.setSessionProvider).toHaveBeenCalledWith('sess-new', 'anthropic');
  });

  it('普通模式新建后持久化 desktop 默认 provider 并写 route store', async () => {
    mocks.getDesktopCcPrefs.mockReturnValue({
      providerId: 'openrouter',
      model: 'openrouter/anthropic/claude-sonnet-4',
      effort: 'medium',
      permissionMode: 'acceptEdits',
      fastMode: true,
    });
    const plainAdapter = {
      ...adapter,
      threadScoped: false,
    } as ImChannelAdapter;
    const im = makeIm();

    await pressNew(im, plainAdapter);

    expect(mocks.updateModelEffort).toHaveBeenCalledWith(
      'sess-new',
      'openrouter/anthropic/claude-sonnet-4',
      'medium',
      'openrouter',
    );
    expect(mocks.setSessionProvider).toHaveBeenCalledWith('sess-new', 'openrouter');
  });

  it('新建后 provider 持久化失败会关闭刚创建的 active session 且不 attach', async () => {
    mocks.getDesktopCcPrefs.mockReturnValue({
      providerId: 'openrouter',
      model: 'openrouter/anthropic/claude-sonnet-4',
      effort: 'medium',
      permissionMode: 'acceptEdits',
      fastMode: true,
    });
    mocks.updateModelEffort.mockRejectedValueOnce(new Error('db locked'));
    const plainAdapter = {
      ...adapter,
      threadScoped: false,
    } as ImChannelAdapter;
    const im = makeIm();

    await pressNew(im, plainAdapter);

    expect(mocks.closeSession).toHaveBeenCalledWith('sess-new');
    expect(mocks.bindingAttach).not.toHaveBeenCalled();
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'picker-msg',
      expect.objectContaining({ body: slackUi.cards.control.attachFailed('db locked') }),
    );
  });
});

describe('control:thread-exit 收口卡', () => {
  it('退出后收口卡标题保留曾控制的 session 名 + 带发起按钮', async () => {
    vi.mocked(readSessionTitle).mockResolvedValue('修复登录 bug');
    const attach = createCardActionHandler(adapter, cards, turnRunner);
    let handler: ((e: IMCardActionEvent) => Promise<void>) | null = null;
    const im = makeIm();
    (im.onCardAction as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
      handler = cb;
      return () => {};
    });
    attach(im)();
    await registeredHandler(handler)({
      messageId: 'root-card',
      senderId: 'U_NEW',
      buttonId: 'control:thread-exit',
      scopeKey: 'root.ts',
      payload: { botAppId: 'BOT1' },
    } as unknown as IMCardActionEvent);

    expect(mocks.executeDetach).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey: 'root.ts', userId: 'U_NEW' }),
      'slack-slash',
    );
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'root-card',
      expect.objectContaining({
        title: '🧵 修复登录 bug',
        buttons: [expect.objectContaining({ id: 'control:start' })],
      }),
    );
  });
});

describe('control:new 新建会话（非 threadScoped 分支 — feishu 实际路径）', () => {
  // feishu 是非 threadScoped 渠道（见 shared/types.ts），群 /ctr 永远走
  // 非 thread 分支 —— 权限档治理与 providerId 落地都必须在这一分支生效。
  const feishuAdapter = {
    channel: 'feishu',
    threadScoped: false,
    ui: slackUi,
    config: { agentKind: 'claude-code', defaultModel: 'm', defaultPermissionMode: 'acceptEdits' },
  } as unknown as ImChannelAdapter;

  async function pressControlNew(
    im: ChannelIM,
    overrides?: Partial<IMCardActionEvent>,
    testAdapter: ImChannelAdapter = feishuAdapter,
  ): Promise<void> {
    const attach = createCardActionHandler(testAdapter, cards, turnRunner);
    let handler: ((e: IMCardActionEvent) => Promise<void>) | null = null;
    (im.onCardAction as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
      handler = cb;
      return () => {};
    });
    attach(im)();
    await registeredHandler(handler)({
      messageId: 'ctr-new',
      // 群卡回调的 senderId 是**发卡那条话题 lane**(transport 侧
      // outbound.resolveCardLane 归一) —— 接管只跟话题走。群 chatId + 私聊
      // open_id 的组合是「卡片认不出自己在哪条话题」的失效态, 会被 fail-closed
      // 拦掉(见 cardActionGroupLaneGuard.test.ts), 不是群 /ctr 的正常形态。
      senderId: 'g/oc_12345/omt_t1',
      chatId: 'oc_12345',
      buttonId: 'control:new',
      scopeKey: '',
      payload: {
        botAppId: 'BOT1',
        workingDir: 'E:/Cindy/cindy',
        displayName: 'cindy',
      },
      ...overrides,
    } as IMCardActionEvent);
  }

  function setupDesktopPrefs(prefs: DesktopCcPrefs): ReturnType<typeof vi.fn> {
    mocks.getDesktopCcPrefs.mockReturnValue(prefs);
    const createSession = vi.fn(async () => ({ id: 'sess-new' }));
    mocks.getMaker.mockReturnValue({ createSession, closeSession: mocks.closeSession });
    return createSession;
  }

  it('feishu 群 /ctr：权限档用渠道设置（默认 auto），providerId 随桌面偏好传入 createSession', async () => {
    const createSession = setupDesktopPrefs({
      model: 'deepseek-v4-pro',
      providerId: 'deepseek',
      effort: 'max',
      permissionMode: 'bypassPermissions',
      fastMode: false,
    });
    mocks.resolveLenientSessionRoute.mockResolvedValue({
      model: 'deepseek-v4-pro',
      providerId: 'deepseek',
      effort: 'max',
      degraded: false,
    });

    await pressControlNew(makeIm());

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'deepseek-v4-pro',
        providerId: 'deepseek',
        permissionMode: 'auto',
      }),
    );
  });

  it('feishu 私聊 /ctr：权限档保持 desktop 偏好', async () => {
    const createSession = setupDesktopPrefs({
      model: 'deepseek-v4-pro',
      providerId: 'deepseek',
      effort: 'max',
      permissionMode: 'bypassPermissions',
      fastMode: false,
    });
    mocks.resolveLenientSessionRoute.mockResolvedValue({
      model: 'deepseek-v4-pro',
      providerId: 'deepseek',
      effort: 'max',
      degraded: false,
    });

    // 私聊卡: chatId 是对方 open_id, senderId 也是 open_id(私聊不登记 lane)。
    await pressControlNew(makeIm(), { chatId: 'ou_peer_openid', senderId: 'ou_user1' });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'deepseek',
        permissionMode: 'bypassPermissions',
      }),
    );
  });

  it('桌面偏好缺 providerId 时仍走隐式路由（不传 providerId，与修复前一致）', async () => {
    const createSession = setupDesktopPrefs({
      model: 'deepseek-v4-pro',
      providerId: null,
      effort: 'max',
      permissionMode: 'bypassPermissions',
      fastMode: false,
    });
    mocks.resolveLenientSessionRoute.mockResolvedValue({
      model: 'deepseek-v4-pro',
      providerId: null,
      effort: 'max',
      degraded: false,
    });

    await pressControlNew(makeIm());

    expect(createSession).toHaveBeenCalledTimes(1);
    const arg = createSession.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.model).toBe('deepseek-v4-pro');
    expect(arg.providerId).toBeUndefined();
  });
});
