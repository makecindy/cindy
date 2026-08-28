/**
 * cardActionHandler — ask 多题/多选打勾卡(ask:multi / ask:multi-submit)。
 *
 * 语义: 选项按键只改写 pendingInteractions 里登记的勾选态并原地 patch 整卡
 * (✓ 前缀反馈), 不产生决策; 提交按键从勾选态合成 answers(未答的题不写 key,
 * 多选 JSON 数组 / 单选裸 label)走通用收口。pendingInteractions 用真实实现 —
 * 这条链路本来就是它和多处注入的唯一粘合点。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AskUserQuestionItem } from '@cindy/maker-core';
import type { ChannelIM, IMCardActionEvent } from '@cindy/im';
import type { DesktopCcPrefs } from '../../index';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getMaker: vi.fn(),
  getDesktopCcPrefs: vi.fn<() => DesktopCcPrefs | null>(() => null),
  resolveLenientSessionRoute: vi.fn(),
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
  bindingStore: { get: vi.fn(), attach: vi.fn(), attachWithResult: vi.fn() },
  executeDetach: vi.fn(),
}));
vi.mock('../sessionSummary', () => ({ generateTakeoverSummary: vi.fn() }));
vi.mock('../fbotTitle', () => ({ FBOT_DRAFT_TITLE: 'FBot · New' }));
vi.mock('../sessionRepo', () => ({
  readModelRouteSnapshot: vi.fn(async () => null),
  readPermissionMode: vi.fn(async () => 'auto'),
  touchUserSent: vi.fn(async () => {}),
  updateModelEffort: vi.fn(async () => {}),
  updatePermissionMode: vi.fn(async () => {}),
}));
vi.mock('../../../maker-host/session-provider-store', () => ({
  getSessionProvider: vi.fn(() => null),
  normalizeSessionProviderId: (providerId: string | null | undefined) =>
    providerId === undefined ? undefined : providerId?.trim() || null,
  setSessionProvider: vi.fn(),
}));
vi.mock('../../../maker-ipc/runtimeSetModel', () => ({
  applyRuntimeSetModelChange: vi.fn(),
}));
vi.mock('../../../maker-ipc/register', () => ({
  cancelPendingAgentSwitchForSession: vi.fn(),
  isSessionInTurn: vi.fn(() => false),
  registerPendingCredentialSwitchForSession: vi.fn(),
  clearPendingCredentialSwitchForSession: vi.fn(),
  wakeSessionInputAfterCredentialSwitch: vi.fn(),
  getPendingCredentialSwitchTarget: vi.fn(() => undefined),
  withSendToSessionLock: vi.fn(
    async (_sessionId: string, task: () => Promise<unknown>) => task(),
  ),
}));

import { ui } from '../../feishu/uiText';
import { enqueueAskCardPatch } from '../askCardPatchQueue';
import { createCardActionHandler } from '../cardActionHandler';
import { createCardBuilders } from '../cardBuilders';
import { cancelPending, lookupPending, registerPending } from '../pendingInteractions';
import { activateImAccountBoundary } from '../../accountBoundary';
import type { ImChannelAdapter } from '../types';
import type { ImTurnRunner } from '../turnRunner';

const cards = createCardBuilders(ui, () => 'high');

const turnRunner = {
  getMakerSessionById: vi.fn(() => null),
  prewireAttachedSession: vi.fn(async () => {}),
} as unknown as ImTurnRunner;

const adapter = {
  channel: 'feishu',
  ui,
  config: { agentKind: 'claude-code', defaultModel: 'm', defaultPermissionMode: 'auto' },
} as unknown as ImChannelAdapter;

/** 夹具: 第一问多选(3 选项), 第二问单选(2 选项)。 */
const QUESTIONS: AskUserQuestionItem[] = [
  {
    question: '开启哪些组件?',
    header: '组件',
    multiSelect: true,
    options: [{ label: '网关' }, { label: '监控' }, { label: '日志' }],
  },
  { question: '部署到哪?', options: [{ label: '测试环境' }, { label: '生产环境' }] },
];

/** 本测试用过的 requestId — afterEach 统一收口, 不让 entry 跨用例泄漏。 */
const liveRequestIds: string[] = [];

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

/**
 * 注册一张打勾卡 pending(与 turnRunner 的 askMultiExtras 同构)并返回
 * press() 依次模拟按键。每个用例独立 im / handler。
 */
function setupAskMulti(requestId: string) {
  const decisionPromise = registerPending(requestId, 'ask_user_question', 'card-1', {
    askQuestions: QUESTIONS,
    askSelections: new Map(),
  });
  liveRequestIds.push(requestId);
  const im = makeIm();
  const attach = createCardActionHandler(adapter, cards, turnRunner);
  let handler: ((e: IMCardActionEvent) => Promise<void>) | null = null;
  (im.onCardAction as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
    handler = cb;
    return () => {};
  });
  attach(im)();
  const press = (buttonId: string, payload: Record<string, unknown>) =>
    handler!({
      messageId: 'card-1',
      senderId: 'ou_owner',
      buttonId,
      payload,
    } as IMCardActionEvent);
  /** 第 n 次(1 起)原地 patch 的卡片 spec。 */
  const patchedSpec = (n: number) => {
    const call = (im.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[n - 1];
    if (!call) throw new Error(`updateInteractiveCard 未被调用第 ${n} 次`);
    return call[1] as ReturnType<typeof cards.buildAskMultiCard>;
  };
  return { decisionPromise, im, press, patchedSpec };
}

/** 找打勾卡里某问某选项的按钮。 */
function optionButton(
  spec: ReturnType<typeof cards.buildAskMultiCard>,
  q: number,
  o: number,
) {
  const hit = spec.buttons.find(
    (b) => b.id === 'ask:multi' && (b.payload as Record<string, unknown>).q === q && (b.payload as Record<string, unknown>).o === o,
  );
  if (!hit) throw new Error(`spec 里没有 q=${q} o=${o} 的选项按钮`);
  return hit;
}

beforeEach(() => {
  vi.clearAllMocks();
  activateImAccountBoundary();
});

afterEach(() => {
  for (const id of liveRequestIds.splice(0)) cancelPending(id, 'test-end');
});

describe('ask 多题/多选打勾卡', () => {
  it('多选题: 切换勾选态并原地 patch(✓ 前缀), 再点一次取消', async () => {
    const { im, press, patchedSpec } = setupAskMulti('req-toggle');

    await press('ask:multi', { requestId: 'req-toggle', q: 0, o: 0 });
    expect(im.updateInteractiveCard).toHaveBeenCalledTimes(1);
    expect(optionButton(patchedSpec(1), 0, 0).label).toBe('✓ 1·网关');

    // 同一选项再点 = 取消勾选
    await press('ask:multi', { requestId: 'req-toggle', q: 0, o: 0 });
    expect(optionButton(patchedSpec(2), 0, 0).label).toBe('1·网关');

    // 多选可同时勾多枚
    await press('ask:multi', { requestId: 'req-toggle', q: 0, o: 1 });
    await press('ask:multi', { requestId: 'req-toggle', q: 0, o: 2 });
    const final = patchedSpec(4);
    expect(optionButton(final, 0, 0).label).toBe('1·网关');
    expect(optionButton(final, 0, 1).label).toBe('✓ 1·监控');
    expect(optionButton(final, 0, 2).label).toBe('✓ 1·日志');
    // 未决期间不 resolve: pending 仍在
    expect(lookupPending('req-toggle')).not.toBeNull();
  });

  it('单选题: 直接换选(点第二项时清掉同问第一项)', async () => {
    const { press, patchedSpec } = setupAskMulti('req-radio');

    await press('ask:multi', { requestId: 'req-radio', q: 1, o: 0 });
    expect(optionButton(patchedSpec(1), 1, 0).label).toBe('✓ 2·测试环境');

    await press('ask:multi', { requestId: 'req-radio', q: 1, o: 1 });
    const final = patchedSpec(2);
    expect(optionButton(final, 1, 0).label).toBe('2·测试环境');
    expect(optionButton(final, 1, 1).label).toBe('✓ 2·生产环境');
  });

  it('提交: 全部已答合成 answers(多选 JSON 数组), 未答的题不写 key, 卡片收口', async () => {
    const { decisionPromise, im, press, patchedSpec } = setupAskMulti('req-submit');

    await press('ask:multi', { requestId: 'req-submit', q: 0, o: 0 });
    await press('ask:multi', { requestId: 'req-submit', q: 0, o: 2 });
    await press('ask:multi', { requestId: 'req-submit', q: 1, o: 1 });
    await press('ask:multi-submit', { requestId: 'req-submit' });

    await expect(decisionPromise).resolves.toEqual({
      kind: 'ask_user_question',
      answers: { '开启哪些组件?': JSON.stringify(['网关', '日志']), '部署到哪?': '生产环境' },
    });
    // 最后一拍是收口卡: 决策摘要拼成一句, 按钮清空
    const resolved = patchedSpec(4);
    expect(resolved.body).toContain('网关, 日志；生产环境');
    expect(resolved.buttons).toEqual([]);
    expect(lookupPending('req-submit')).toBeNull();
    // 提交后再点选项: pending 已收口, 静默忽略, 不再 patch
    const calls = (im.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.length;
    await press('ask:multi', { requestId: 'req-submit', q: 0, o: 0 });
    expect(im.updateInteractiveCard).toHaveBeenCalledTimes(calls);
  });

  it('部分未答就提交: 未答的题不进 answers', async () => {
    const { decisionPromise, press } = setupAskMulti('req-partial');

    await press('ask:multi', { requestId: 'req-partial', q: 0, o: 1 });
    await press('ask:multi-submit', { requestId: 'req-partial' });

    await expect(decisionPromise).resolves.toEqual({
      kind: 'ask_user_question',
      answers: { '开启哪些组件?': JSON.stringify(['监控']) },
    });
  });

  it('一个不选直接提交: 等价未回答(空 answers), 收口文案沿用「继续」', async () => {
    const { decisionPromise, press, patchedSpec } = setupAskMulti('req-empty');

    await press('ask:multi-submit', { requestId: 'req-empty' });

    await expect(decisionPromise).resolves.toEqual({ kind: 'ask_user_question', answers: {} });
    expect(patchedSpec(1).body).toContain('已选择：继续');
  });

  it('toggle 未完成时提交: 终态 patch 排进同一队列, 不被旧勾选 patch 覆盖', async () => {
    const { decisionPromise, im, press } = setupAskMulti('req-race');
    const deferred: Array<() => void> = [];
    (im.updateInteractiveCard as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          deferred.push(resolve);
        }),
    );

    const toggleP = press('ask:multi', { requestId: 'req-race', q: 0, o: 0 });
    await vi.waitFor(() => expect(deferred).toHaveLength(1));

    const submitP = press('ask:multi-submit', { requestId: 'req-race' });
    // 终态还没发出: 还在等 toggle 的 in-flight patch
    expect(im.updateInteractiveCard).toHaveBeenCalledTimes(1);

    deferred[0]!();
    await toggleP;
    await vi.waitFor(() => expect(deferred).toHaveLength(2));
    deferred[1]!();
    await submitP;

    const calls = (im.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    const last = calls[1]![1] as ReturnType<typeof cards.buildResolvedCard>;
    expect(last.buttons).toEqual([]);
    expect(last.body).toContain('网关');
    await expect(decisionPromise).resolves.toEqual({
      kind: 'ask_user_question',
      answers: { '开启哪些组件?': JSON.stringify(['网关']) },
    });
  });

  it('toggle 未完成时作废: 过期终态排进同一队列, 不被旧勾选 patch 覆盖', async () => {
    const { decisionPromise, im, press } = setupAskMulti('req-drop');
    const deferred: Array<() => void> = [];
    (im.updateInteractiveCard as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          deferred.push(resolve);
        }),
    );

    const toggleP = press('ask:multi', { requestId: 'req-drop', q: 0, o: 0 });
    await vi.waitFor(() => expect(deferred).toHaveLength(1));

    const cancelled = cancelPending('req-drop', 'turn-end');
    expect(cancelled?.messageId).toBe('card-1');
    const dropP = enqueueAskCardPatch('req-drop', async () => {
      await im.updateInteractiveCard('card-1', cards.buildResolvedCard('卡片已过期'));
    });
    expect(im.updateInteractiveCard).toHaveBeenCalledTimes(1);

    deferred[0]!();
    await toggleP;
    await vi.waitFor(() => expect(deferred).toHaveLength(2));
    deferred[1]!();
    await dropP;

    const calls = (im.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    const last = calls[1]![1] as ReturnType<typeof cards.buildResolvedCard>;
    expect(last.buttons).toEqual([]);
    expect(last.body).toContain('卡片已过期');
    await expect(decisionPromise).resolves.toEqual({ kind: 'ask_user_question', answers: {} });
  });
});
