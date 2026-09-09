/**
 * cardActionHandler — 飞书群卡片认不出「自己发在哪条话题」时的 fail-closed。
 *
 * 语义: `/ctr` 接管**只跟话题走** —— binding 的 userId 就是话题 lane。飞书卡片
 * 回调不带话题上下文, lane 靠 transport 侧「发卡 messageId → lane」内存表归一;
 * 应用重启 / 换连接后表清空, 老卡再被点时 senderId 回落成点击人的 open_id
 * (**私聊身份**)。这时候照它 attach, 接管会挂到私聊上 —— owner 之后在私聊说的
 * 每句话都被路由进那个项目会话, 而目标话题根本没接上(用户感知:「绑定之后不管
 * 在哪问, 工作目录都是绑定那个项目」)。
 *
 * 所以: 群卡(chatId 为 `oc_` 前缀)+ senderId 不是 lane ⇒ 拒绝建绑定, 卡片
 * 原地收口成「回话题里重发 /ctr」。DM 卡与改投 owner 私聊的卡本就按 open_id
 * 记账, 不受影响。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelIM, IMCardActionEvent } from '@cindy/im';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bindingGet: vi.fn(() => null),
  bindingAttach: vi.fn(async () => {}),
  bindingAttachWithResult: vi.fn(async () => ({ displaced: null })),
  executeDetach: vi.fn(async () => ({ wasAttached: false, targetSessionId: null })),
  getMaker: vi.fn(),
  createSession: vi.fn(async () => ({ id: 'sess-new', model: 'm', agentKind: 'claude-code' })),
  resolveLenientSessionRoute: vi.fn(),
  getDesktopCcPrefs: vi.fn(() => null),
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
vi.mock('../sessionSummary', () => ({ generateTakeoverSummary: vi.fn(async () => 'brief') }));
vi.mock('../sessionRepo', () => ({
  readModelRouteSnapshot: vi.fn(async () => null),
  readPermissionMode: vi.fn(async () => 'auto'),
  switchSessionWorkingDir: vi.fn(async () => {}),
  touchUserSent: vi.fn(async () => {}),
  updateModelEffort: vi.fn(async () => {}),
  updatePermissionMode: vi.fn(async () => {}),
}));
vi.mock('../../defaultSettingsStore', () => ({
  readImDefaultSettings: () => ({ groupPermissionMode: 'auto' }),
}));
vi.mock('../../../maker-host/session-provider-store', () => ({
  getSessionProvider: vi.fn(() => null),
  normalizeSessionProviderId: (providerId: string | null | undefined) =>
    providerId === undefined ? undefined : providerId?.trim() || null,
  setSessionProvider: vi.fn(),
}));
vi.mock('../../../maker-ipc/runtimeSetModel', () => ({
  applyRuntimeSetModelChange: vi.fn(async () => ({ status: 'applied' })),
}));
vi.mock('../../../maker-ipc/register', () => ({
  cancelPendingAgentSwitchForSession: vi.fn(),
  isSessionInTurn: vi.fn(() => false),
  registerPendingCredentialSwitchForSession: vi.fn(),
  clearPendingCredentialSwitchForSession: vi.fn(),
  wakeSessionInputAfterCredentialSwitch: vi.fn(),
  getPendingCredentialSwitchTarget: vi.fn(() => undefined),
  withSendToSessionLock: vi.fn(async (_sessionId: string, task: () => Promise<unknown>) => task()),
}));
vi.mock('../pendingInteractions', () => ({
  resolvePending: vi.fn(() => false),
  lookupPending: vi.fn(() => null),
}));

import { ui as feishuUi } from '../../feishu/uiText';
import { createCardActionHandler } from '../cardActionHandler';
import {
  activateImAccountBoundary,
  captureImAccountGeneration,
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
    onCardAction: vi.fn(),
  };
  return im as unknown as ChannelIM & typeof im;
}

const cards = {
  buildResolvedCard: (text: string) => ({ title: 'resolved', body: text, buttons: [] }),
  buildControlPickerCard: vi.fn(() => ({ title: 'picker', body: '', buttons: [] })),
  buildControlSessionPickerCard: vi.fn(),
} as unknown as ImCardBuilders;

const turnRunner = {
  getMakerSessionById: vi.fn(() => null),
  prewireAttachedSession: vi.fn(async () => {}),
} as unknown as ImTurnRunner;

/** 飞书 adapter(非 threadScoped, 话题靠 lane userId 表达)。 */
const feishuAdapter = {
  channel: 'feishu',
  ui: feishuUi,
  config: { agentKind: 'claude-code', defaultModel: 'm', defaultPermissionMode: 'auto' },
} as unknown as ImChannelAdapter;

async function press(
  im: ChannelIM,
  event: Partial<IMCardActionEvent>,
  adapter: ImChannelAdapter = feishuAdapter,
): Promise<void> {
  const attach = createCardActionHandler(adapter, cards, turnRunner);
  let handler: ((e: IMCardActionEvent) => Promise<void>) | null = null;
  (im.onCardAction as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
    handler = cb;
    return () => {};
  });
  attach(im)();
  if (!handler) throw new Error('card action handler 未注册');
  // handler 内部把工作丢进账号代次里跑, 直接 await 它拿不到内层收尾 —— 取当前
  // 代次再等它跑空(与 cardActionTakeoverReplace.test.ts 同款)。
  const generation = captureImAccountGeneration();
  await (handler as (e: IMCardActionEvent) => Promise<void>)(event as IMCardActionEvent);
  if (generation !== null) await waitForImAccountGenerationIdle(generation);
}

const SESSION_PICK: Partial<IMCardActionEvent> = {
  messageId: 'om_picker',
  buttonId: 'control:session-pick',
  chatId: 'oc_chat1',
  payload: {
    botAppId: 'cli_abc',
    sessionId: 'sess-target',
    sessionTitle: '某个任务',
    displayName: 'proj',
  },
};

const CONTROL_NEW: Partial<IMCardActionEvent> = {
  messageId: 'om_picker',
  buttonId: 'control:new',
  chatId: 'oc_chat1',
  payload: { botAppId: 'cli_abc', workingDir: '/tmp/proj', displayName: 'proj' },
};

beforeEach(() => {
  vi.clearAllMocks();
  activateImAccountBoundary();
  mocks.getMaker.mockReturnValue({
    createSession: mocks.createSession,
    closeSession: vi.fn(async () => {}),
    getCapabilities: vi.fn(() => ({ permissionModes: [{ id: 'auto' }] })),
  });
  mocks.resolveLenientSessionRoute.mockImplementation(
    async (_agent: string, model: string | undefined, providerId: string | null) => ({
      model,
      providerId,
      degraded: false,
    }),
  );
});

describe('飞书群卡片 lane 丢失时的 /ctr fail-closed', () => {
  it('control:session-pick: 群卡 + senderId 是私聊 open_id ⇒ 不建绑定, 提示重发 /ctr', async () => {
    const im = makeIm();

    await press(im, { ...SESSION_PICK, senderId: 'ou_owner' });

    // 关键断言: 绝不能 attach —— 否则接管落到 owner 私聊身份上。
    expect(mocks.bindingAttach).not.toHaveBeenCalled();
    expect(mocks.bindingAttachWithResult).not.toHaveBeenCalled();
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'om_picker',
      expect.objectContaining({ body: feishuUi.cards.control.staleGroupCard }),
    );
  });

  it('control:new: 同样拒绝, 且不新建会话(不留孤儿 session)', async () => {
    const im = makeIm();

    await press(im, { ...CONTROL_NEW, senderId: 'ou_owner' });

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.bindingAttach).not.toHaveBeenCalled();
    expect(im.updateInteractiveCard).toHaveBeenCalledWith(
      'om_picker',
      expect.objectContaining({ body: feishuUi.cards.control.staleGroupCard }),
    );
  });

  it('senderId 是话题 lane 时照常放行(正常路径不受影响)', async () => {
    const im = makeIm();

    await press(im, { ...SESSION_PICK, senderId: 'g/oc_chat1/omt_t1' });

    expect(mocks.bindingAttach).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'feishu', userId: 'g/oc_chat1/omt_t1' }),
      'sess-target',
      expect.anything(),
    );
  });

  it('DM 卡(chatId 是对方 open_id)按 open_id 记账, 不被拦', async () => {
    const im = makeIm();

    await press(im, { ...SESSION_PICK, chatId: 'ou_owner', senderId: 'ou_owner' });

    expect(mocks.bindingAttach).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'feishu', userId: 'ou_owner' }),
      'sess-target',
      expect.anything(),
    );
  });
});
