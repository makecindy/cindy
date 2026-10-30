// @vitest-environment jsdom

import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Tooltip } from '@/components/ui/tooltip';
import userEvent from '@testing-library/user-event';
import { shareSelectionStore } from '@/components/chat/shareSelectionStore';
import { MarkdownMermaidBlock } from '@/components/chat/MarkdownMermaidBlock';
import { prepareShareMessageClone, queryShareableMessageIds } from '@/lib/shareConversationImage';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearDraft, getDraft } from '@/lib/composerDraftStore';
import { FeatureSidebarSlotProvider, useFeatureContentHeader } from '../../feature-context';
import { markBotRead, getBotLastReadAt, botGroupReadKey, resetBotReadStateForTests } from '../botReadState';
import { botGroupAttachmentScope, botGroupThreadDraftKey } from '../botGroupAttachments';
import { getBotGroupListSnapshot, refreshBotGroups, resetBotGroupStoreForTests } from '../botGroupStore';
import { getBotGroupOutbox, getBotGroupOutboxPreviews, resetBotGroupOutboxForTests } from '../botGroupOutbox';
import { resetCompanionCloudStoreForTests } from '../companionCloudStore';
import { botGroupWorkPreview } from '../BotGroupLivePreview';
import { BotGroupChatView } from '../BotGroupChatView';
import { ControlledBanner, __resetControlledBannerForTests } from '../../remote-device/ControlledBanner';
import type {
  BotGroupChangedPayload,
  BotGroupDetail,
  BotGroupMessageView,
  BotGroupPlanView,
} from '../../../../shared/botGroupChat';

const mocks = vi.hoisted(() => ({
  // Keep translation identity stable so attachment effects do not reload on every render.
  t: (key: string, options?: Record<string, unknown>) =>
    options && 'name' in options ? `${key}:${String(options.name)}`
      : key === 'bots.groupChat.memberCount' ? `${key}:${String(options?.count)}` : key,
  groupId: 'g1',
  locationState: null as { createdGroupInvite?: string | null } | null,
  createInvite: vi.fn(),
  navigate: vi.fn(),
  getBotGroup: vi.fn(),
  cachedGroup: null as BotGroupDetail | null,
  sendBotGroupMessage: vi.fn(),
  stopBotGroupRound: vi.fn(),
  continueBotGroupRound: vi.fn(),
  startBotGroupPlan: vi.fn(),
  dismissBotGroupPlan: vi.fn(),
  continueBotGroupPlan: vi.fn(),
  retryBotGroupPlan: vi.fn(),
  editBotGroupPlanStep: vi.fn(),
  openPath: vi.fn(),
  pushes: [] as Array<(payload: BotGroupChangedPayload, stamp?: unknown) => void>,
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  toastInfo: vi.fn(),
  /** Real paths the fake `getFilePath` knows; anything else is an in-memory bitmap. */
  filePaths: new Map<File, string>(),
  cacheImageFromBuffer: vi.fn(),
  cacheImageFromPath: vi.fn(),
  controlledPush: null as null | ((payload: { controllers: Array<{ deviceId: string; name: string }> }) => void),
  getControlledState: vi.fn(),
  revoke: vi.fn(),
  thread: vi.fn(),
  /** Live activity of the speaking Session (null = not running on this machine). */
  activity: null as null | { compactDetail: string; startedAtMs: number | null; phase: string },
  ownerGeneration: { dataOwnerId: 'account-a', generation: 1 },
  remoteInvoke: vi.fn(),
  reply: vi.fn(),
  shareToMain: vi.fn(),
}));

// Partial: the shared attachment pieces pull in the app i18n instance, which needs initReactI18next.
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: mocks.t,
    i18n: { language: 'en-US', resolvedLanguage: 'en' },
  }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: `/bots/groups/${mocks.groupId}`, search: '', state: mocks.locationState }),
  useNavigate: () => mocks.navigate,
  useParams: () => ({ groupId: mocks.groupId }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => mocks.ownerGeneration,
  isDataOwnerGenerationCurrent: (owner: { dataOwnerId: string; generation: number }) =>
    owner.dataOwnerId === mocks.ownerGeneration.dataOwnerId && owner.generation === mocks.ownerGeneration.generation,
  isDataOwnerPushCurrent: () => true,
}));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError, warning: mocks.toastWarning, info: mocks.toastInfo } }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => false) }),
  useOptionalConfirmDialog: () => null,
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-markdown>{content}</div>,
}));
vi.mock('mermaid', () => ({ default: {
  initialize: vi.fn(), parse: vi.fn().mockResolvedValue(true),
  render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 100 100"><text>Diagram</text></svg>' }),
} }));
vi.mock('../BotGroupPendingInteraction', () => ({
  BotGroupPendingInteraction: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="pending-interaction">{sessionId}</div>
  ),
}));
vi.mock('../BotGroupTaskCard', () => ({
  BotGroupTaskCard: ({ task, owned }: { task: { title: string }; owned: boolean }) => (
    <div data-testid="bot-group-task" data-owned={String(owned)}>{task.title}</div>
  ),
}));
vi.mock('../BotAvatar', () => ({
  BotAvatar: ({ bot }: { bot: { name: string } }) => <span data-avatar={bot.name} />,
}));
vi.mock('../BotGenerationLabel', () => ({
  BotGenerationLabel: ({ phase }: { phase?: string }) => <span>{`phase:${phase}`}</span>,
}));
vi.mock('@/state/agentIslandActivity', () => ({ useAgentIslandActivity: () => mocks.activity }));

beforeAll(() => {
  // jsdom has no layout; scrolling is a no-op here.
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 0 });
});

function msg(overrides: Partial<BotGroupMessageView>): BotGroupMessageView {
  return {
    id: 'm',
    sequence: 1,
    kind: 'message',
    authorKind: 'user',
    authorBotId: null,
    authorName: '',
    content: '',
    mentions: { all: false, botIds: [] },
    noticeCode: null,
    planId: null,
    files: [],
    attachments: [],
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function detail(overrides: Partial<BotGroupDetail> = {}): BotGroupDetail {
  return {
    id: 'g1',
    name: '周末出游',
    replyMode: 'all',
    speakingMode: 'auto',
    members: [
      { botId: 'mimi', name: '咪咪', avatar: '', avatarColor: 'red', status: 'active' },
      { botId: 'xiaoman', name: '小满', avatar: '', avatarColor: 'blue', status: 'active' },
    ],
    organizerBotId: 'mimi',
    projectDir: null,
    lastMessage: null,
    speakingBotIds: [],
    planningBotId: null,
    openPlan: null,
    createdAt: 1,
    updatedAt: 1,
    plans: [],
    messages: [
      msg({ id: 'u1', sequence: 1, content: '@小满 帮我查余票' }),
      msg({
        id: 'b1',
        sequence: 2,
        authorKind: 'bot',
        authorBotId: 'xiaoman',
        authorName: '小满',
        content: '周六 8:10 有票',
      }),
      msg({
        id: 'n1',
        sequence: 3,
        kind: 'notice',
        authorKind: 'system',
        authorName: '咪咪',
        noticeCode: 'member-timeout',
      }),
      msg({ id: 'e1', sequence: 4, kind: 'round-end', authorKind: 'system' }),
    ],
    hasMoreBefore: false,
    round: { status: 'idle', speakers: [], canContinue: true },
    ...overrides,
  };
}

function plan(overrides: Partial<BotGroupPlanView> = {}): BotGroupPlanView {
  return {
    id: 'p1',
    status: 'proposed',
    organizerBotId: 'mimi',
    organizerName: '咪咪',
    steps: [
      { position: 0, botId: 'mimi', botName: '咪咪', task: '想清楚这页讲什么', status: 'pending' },
      { position: 1, botId: 'xiaoman', botName: '小满', task: '画设计稿', status: 'pending' },
    ],
    currentStep: null,
    workDir: null,
    branch: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const planCard = msg({
  id: 'plan-1',
  sequence: 10,
  kind: 'plan',
  authorKind: 'bot',
  authorBotId: 'mimi',
  authorName: '咪咪',
  planId: 'p1',
});

function openSummary(planView: BotGroupPlanView): NonNullable<BotGroupDetail['openPlan']> {
  const current = planView.steps.find((step) => step.position === planView.currentStep) ?? null;
  return {
    id: planView.id,
    status: planView.status,
    currentStep: planView.currentStep,
    stepCount: planView.steps.length,
    currentBotName: current?.botName ?? null,
    currentStepStatus: current?.status ?? null,
  };
}

/** The group with one plan card; `planView` decides whether it is still open. */
function withPlan(planView: BotGroupPlanView, extra: BotGroupMessageView[] = [], overrides: Partial<BotGroupDetail> = {}) {
  const open = ['proposed', 'running', 'waiting'].includes(planView.status);
  return detail({
    messages: [msg({ id: 'u1', sequence: 1, content: '帮我做官网介绍页' }), planCard, ...extra],
    plans: [planView],
    openPlan: open ? openSummary(planView) : null,
    round: { status: 'idle', speakers: [], canContinue: false },
    ...overrides,
  });
}

/** A file the fake `getFilePath` resolves, as one picked or copied in a file manager. */
function diskFile(name: string, type: string, path = `/tmp/${name}`): File {
  const file = new File(['content'], name, { type });
  mocks.filePaths.set(file, path);
  return file;
}

function pickFiles(files: File[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

function clipboardFileItem(file: File, directory = false) {
  return { kind: 'file', type: file.type, getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: directory }) };
}

function lastSend(): Record<string, unknown> {
  const calls = mocks.sendBotGroupMessage.mock.calls;
  return calls[calls.length - 1]![0] as Record<string, unknown>;
}

function HeaderSlot() {
  return <header data-testid="content-header">{useFeatureContentHeader()}</header>;
}

function renderView() {
  return render(
    <Tooltip.Provider>
    <FeatureSidebarSlotProvider isCollapsed={false}>
      <HeaderSlot />
      <BotGroupChatView />
    </FeatureSidebarSlotProvider>
    </Tooltip.Provider>,
  );
}

beforeEach(() => {
  resetCompanionCloudStoreForTests();
  mocks.remoteInvoke.mockReset();
  window.localStorage.clear();
  for (const id of ['g1', 'g2']) clearDraft(botGroupAttachmentScope(id));
  // 话题 reply drafts persist like the group's own; start every test without one.
  for (const root of ['u1', 'b1', 'q1', 'm']) clearDraft(botGroupThreadDraftKey('g1', root));
  mocks.toastWarning.mockReset();
  mocks.filePaths = new Map();
  mocks.cacheImageFromBuffer.mockReset().mockResolvedValue({ url: 'cindy-media://blobs/pasted.png', filename: 'pasted.png' });
  mocks.cacheImageFromPath.mockReset().mockResolvedValue({ url: 'cindy-media://blobs/photo.png', filename: 'photo.png' });
  resetBotReadStateForTests();
  resetBotGroupOutboxForTests();
  mocks.groupId = 'g1';
  mocks.locationState = null;
  mocks.createInvite.mockReset().mockResolvedValue({ ok: true, link: 'cindy://chat-invite/preview', expiresAt: null, reusable: true });
  __resetControlledBannerForTests();
  mocks.controlledPush = null;
  mocks.getControlledState.mockReset().mockResolvedValue({ controlledBy: [] });
  mocks.revoke.mockReset();
  mocks.navigate.mockReset();
  mocks.toastError.mockReset();
  mocks.toastInfo.mockReset();
  mocks.pushes = [];
  mocks.cachedGroup = null;
  mocks.getBotGroup.mockReset().mockResolvedValue({ ok: true, group: detail() });
  mocks.sendBotGroupMessage.mockReset().mockResolvedValue({ ok: true, messageId: 'u2' });
  mocks.stopBotGroupRound.mockReset().mockResolvedValue({ ok: true });
  mocks.continueBotGroupRound.mockReset().mockResolvedValue({ ok: true });
  mocks.startBotGroupPlan.mockReset().mockResolvedValue({ ok: true });
  mocks.dismissBotGroupPlan.mockReset().mockResolvedValue({ ok: true });
  mocks.continueBotGroupPlan.mockReset().mockResolvedValue({ ok: true });
  mocks.retryBotGroupPlan.mockReset().mockResolvedValue({ ok: true });
  mocks.editBotGroupPlanStep.mockReset().mockResolvedValue({ ok: true });
  mocks.openPath.mockReset().mockResolvedValue({ success: true });
  mocks.thread.mockReset().mockImplementation(async ({ rootId }: { rootId: string }) => ({
    ok: true,
    root: msg({ id: rootId, content: `Thread root ${rootId}` }),
    replies: [msg({ id: `reply-${rootId}`, content: `Reply to ${rootId}` })],
    hasMore: false,
  }));
  mocks.reply.mockReset().mockResolvedValue({ ok: true, messageId: 'new-reply' });
  mocks.shareToMain.mockReset().mockResolvedValue({ ok: true, messageId: 'share-1', alreadyShared: false });
  mocks.toastInfo.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      deviceLink: {
        invoke: mocks.remoteInvoke,
        onRemotePush: () => () => {},
        getState: mocks.getControlledState,
        onControlledState: (callback: NonNullable<typeof mocks.controlledPush>) => {
          mocks.controlledPush = callback;
          return () => {};
        },
        revoke: mocks.revoke,
      },
      openPath: (...args: unknown[]) => mocks.openPath(...args),
      getFilePath: (file: File) => mocks.filePaths.get(file) ?? '',
      cacheImageFromPath: (...args: unknown[]) => mocks.cacheImageFromPath(...args),
      cacheImageFromBuffer: (...args: unknown[]) => mocks.cacheImageFromBuffer(...args),
      cleanupCachedImages: vi.fn(async () => undefined),
      getFileThumbnail: vi.fn(async () => null),
      maker: {
        chatServer: { createInvite: mocks.createInvite, thread: mocks.thread, reply: mocks.reply, shareToMain: mocks.shareToMain, reactors: vi.fn(async () => ({ ok: true, reactors: [] })) },
        listBotGroups: vi.fn(async () => ({ ok: true, groups: [] })),
        getBotGroup: (...args: unknown[]) => (args[1] as { cacheOnly?: boolean } | undefined)?.cacheOnly
          ? Promise.resolve(mocks.cachedGroup ? { ok: true, group: mocks.cachedGroup } : { ok: false, errorCode: 'NOT_FOUND' })
          : mocks.getBotGroup(...args),
        sendBotGroupMessage: (...args: unknown[]) => mocks.sendBotGroupMessage(...args),
        stopBotGroupRound: (...args: unknown[]) => mocks.stopBotGroupRound(...args),
        continueBotGroupRound: (...args: unknown[]) => mocks.continueBotGroupRound(...args),
        startBotGroupPlan: (...args: unknown[]) => mocks.startBotGroupPlan(...args),
        dismissBotGroupPlan: (...args: unknown[]) => mocks.dismissBotGroupPlan(...args),
        continueBotGroupPlan: (...args: unknown[]) => mocks.continueBotGroupPlan(...args),
        retryBotGroupPlan: (...args: unknown[]) => mocks.retryBotGroupPlan(...args),
        editBotGroupPlanStep: (...args: unknown[]) => mocks.editBotGroupPlanStep(...args),
        onBotGroupChanged: (cb: (payload: BotGroupChangedPayload, stamp?: unknown) => void) => {
          mocks.pushes.push(cb);
          return () => {
            mocks.pushes = mocks.pushes.filter((entry) => entry !== cb);
          };
        },
      },
    },
  });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('BotGroupChatView', () => {
  // Regression: returning to a group must not replay its consumed creation intent.
  it('does not reopen a created invitation or regenerate its link after leaving and returning', async () => {
    mocks.locationState = { createdGroupInvite: 'g1' };
    const tree = () => <Tooltip.Provider><FeatureSidebarSlotProvider isCollapsed={false}>
      <HeaderSlot /><BotGroupChatView />
    </FeatureSidebarSlotProvider></Tooltip.Provider>;
    const view = render(tree());
    await screen.findByRole('button', { name: 'bots.groupChat.server.copyLink' });
    expect(mocks.createInvite).toHaveBeenCalledTimes(1);
    mocks.locationState = { createdGroupInvite: null };
    mocks.groupId = 'g2';
    view.rerender(tree());
    expect(screen.queryByRole('dialog')).toBeNull();
    mocks.groupId = 'g1';
    view.rerender(tree());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.createInvite).toHaveBeenCalledTimes(1);
  });

  it('clears the selected route when an authoritative personal hide unmounts settings', async () => {
    renderView();
    await screen.findByRole('textbox');
    act(() => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'list', listState: { hidden: true, revision: 1 } })));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps archived history readable and restores the composer only after the group is unarchived', async () => {
    const archived = detail({ serverBacked: true, archived: true,
      messages: [msg({ content: 'Preserved group history' })],
    });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: archived });
    renderView();
    await screen.findByText('Preserved group history');
    expect(screen.getByText('bots.groupChat.server.settings.archived')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: { ...archived, archived: false } });
    act(() => { mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'updated' })); });
    await screen.findByRole('textbox');
    expect(screen.getByText('Preserved group history')).toBeTruthy();
    expect(screen.queryByText('bots.groupChat.server.settings.archived')).toBeNull();
  });

  it('replaces the composer with read-only history when dissolved without being archived', async () => {
    const live = detail({ serverBacked: true, archived: false,
      messages: [msg({ content: 'Preserved dissolved history' })],
    });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: live });
    renderView();
    await screen.findByRole('textbox');
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: { ...live, dissolvedAt: '2026-10-15T00:00:00.000Z' } });
    act(() => { mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'updated' })); });
    await screen.findByText('bots.groupChat.lifecycle.dissolved');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Preserved dissolved history')).toBeTruthy();
  });

  function mockThreadMotion(duration: string) {
    const style = document.createElement('style');
    style.textContent = `aside { --motion-base: ${duration}; --motion-ease-move: linear; }`;
    document.head.append(style);
    const original = HTMLElement.prototype.animate;
    const animations: Array<{ finished: Promise<void>; finish: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
    const animate = vi.fn(() => {
      let finish!: () => void;
      const finished = new Promise<void>(resolve => { finish = resolve; });
      const animation = { finished, finish, cancel: vi.fn() };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    return { animate, animations, restore: () => {
      style.remove();
      if (original) Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: original });
      else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    } };
  }

  it.each(['200ms', '0ms'])('opens and closes with motion token %s, restoring focus and ignoring duplicate close', async duration => {
    const motion = mockThreadMotion(duration);
    try {
      vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
      const user = userEvent.setup();
      renderView();
      const trigger = (await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!;
      await user.click(trigger);
      const panel = screen.getByRole('complementary');
      if (duration === '200ms') {
        expect(motion.animate).toHaveBeenCalledWith([{ width: '0px' }, { width: '50%' }], { duration: 200, easing: 'linear', fill: 'forwards' });
        await act(async () => motion.animations[0]!.finish());
      }
      await user.click(within(panel).getByRole('button', { name: 'bots.close' }));
      expect(document.activeElement).toBe(trigger);
      if (duration === '200ms') {
        expect(panel.inert).toBe(true);
        expect(screen.getByRole('complementary')).toBe(panel);
        expect(motion.animate).toHaveBeenCalledTimes(2);
        fireEvent.keyDown(trigger, { key: 'Escape' });
        expect(motion.animate).toHaveBeenCalledTimes(2);
        await act(async () => motion.animations[1]!.finish());
      } else expect(motion.animate).not.toHaveBeenCalled();
      expect(screen.queryByRole('complementary')).toBeNull();
    } finally { cleanup(); motion.restore(); }
  });

  it('shows a task card live only for a member of this group; an author who left is a snapshot', async () => {
    const task = { state: 'running', title: '整理行程', summary: null, meta: { role: 'delegation-request', objective: '整理行程', parentSessionId: 'p1', childSessionId: 'c1' } } as never;
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [
      msg({ id: 'b1', sequence: 2, authorKind: 'bot', authorBotId: 'xiaoman', authorName: '小满', content: '开了一条任务', task }),
      msg({ id: 'b2', sequence: 3, authorKind: 'bot', authorBotId: 'gone', authorName: '离开的伙伴', content: '我也开了', task }),
    ] }) });
    renderView();
    const cards = await screen.findAllByTestId('bot-group-task');
    // Only a current member's teammate is looked up on this computer; unknown authors stay snapshots.
    expect(cards.map((card) => card.getAttribute('data-owned'))).toEqual(['true', 'false']);
  });

  it('cancels an interrupted close and does not animate or later close the newly selected thread', async () => {
    const motion = mockThreadMotion('200ms');
    try {
      vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
      const user = userEvent.setup();
      renderView();
      const triggers = await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' });
      await user.click(triggers[0]!);
      await act(async () => motion.animations[0]!.finish());
      await user.click(screen.getByRole('button', { name: 'bots.close' }));
      const closing = motion.animations[1]!;
      await user.click(triggers[1]!);
      await screen.findByText('Reply to b1');
      expect(closing.cancel).toHaveBeenCalled();
      expect(motion.animate).toHaveBeenCalledTimes(2);
      await act(async () => closing.finish());
      expect(screen.getByRole('complementary').textContent).toContain('Reply to b1');
      expect(screen.getByRole('complementary').inert).not.toBe(true);
    } finally { cleanup(); motion.restore(); }
  });

  it('cancels closing when Enter reopens the same thread and restores its input and draft', async () => {
    const motion = mockThreadMotion('200ms');
    try {
      vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
      const user = userEvent.setup();
      renderView();
      const trigger = (await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!;
      await user.click(trigger);
      await act(async () => motion.animations[0]!.finish());
      const panel = screen.getByRole('complementary');
      const input = within(panel).getByRole('textbox');
      await user.type(input, 'Still editing');
      await user.keyboard('{Escape}');
      const closing = motion.animations[1]!;
      expect(panel.inert).toBe(true);
      expect(document.activeElement).toBe(trigger);
      await user.keyboard('{Enter}');
      expect(closing.cancel).toHaveBeenCalled();
      expect(panel.inert).toBe(false);
      expect(document.activeElement).toBe(input);
      expect(motion.animate).toHaveBeenCalledTimes(2);
      await act(async () => closing.finish());
      expect(screen.getByRole('complementary')).toBe(panel);
      await user.keyboard(' now');
      expect((input as HTMLTextAreaElement).value).toBe('Still editing now');
      await user.click(within(panel).getByRole('button', { name: 'bots.close' }));
      await act(async () => motion.animations[2]!.finish());
      expect(screen.queryByRole('complementary')).toBeNull();
    } finally { cleanup(); motion.restore(); }
  });

  describe('thread width resizing', () => {
    let available = 1200;
    const observed = new Map<Element, ResizeObserverCallback>();
    let restoreGeometry: () => void;

    beforeEach(() => {
      available = 1200;
      observed.clear();
      vi.stubGlobal('ResizeObserver', class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(element: Element) { observed.set(element, this.callback); }
        disconnect() {}
      });
      vi.stubGlobal('PointerEvent', class extends MouseEvent {
        pointerId: number;
        isPrimary: boolean;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 1;
          this.isPrimary = init.isPrimary ?? true;
        }
      });
      const original = HTMLElement.prototype.getBoundingClientRect;
      const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.tagName === 'ASIDE') return new DOMRect(0, 0, Number.parseFloat(this.style.width) || 448, 800);
        if (this.querySelector(':scope > main')) return new DOMRect(0, 0, available, 800);
        return original.call(this);
      });
      restoreGeometry = () => geometry.mockRestore();
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    });
    afterEach(() => { restoreGeometry(); });

    async function openResizableThread() {
      renderView();
      const triggers = await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' });
      fireEvent.click(triggers[0]!);
      await screen.findByText('Reply to u1');
      const panel = screen.getByRole('complementary');
      const handle = within(panel).getByRole('separator', { name: 'diffPanel.shell.resizeHandleAria' });
      Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
      return { panel, handle, triggers };
    }

    it('only changes the width, keeping both inputs, message rows and scrolling in place', async () => {
      const { panel, handle } = await openResizableThread();
      const main = screen.getByRole('main');
      const groupInput = within(main).getByRole('textbox');
      const replyInput = within(panel).getByRole('textbox');
      const message = screen.getByText('周六 8:10 有票').closest('article');
      const timeline = screen.getByTestId('bot-group-timeline');
      timeline.scrollTop = 25;
      fireEvent.change(groupInput, { target: { value: 'Group draft' } });
      fireEvent.change(replyInput, { target: { value: 'Reply draft' } });
      expect(panel.style.width).toBe('');
      expect(panel.style.maxWidth).toBe('');
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 752 });
      fireEvent.pointerMove(handle, { pointerId: 2, clientX: 100 });
      expect(panel.style.width).toBe('');
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 552 });
      expect(panel.style.width).toBe('648px');
      expect(panel.style.maxWidth).toBe('none');
      expect(handle.getAttribute('aria-valuenow')).toBe('648');
      fireEvent.pointerUp(handle, { pointerId: 1 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 });
      expect(panel.style.width).toBe('648px');
      expect(within(main).getByRole('textbox')).toBe(groupInput);
      expect(within(panel).getByRole('textbox')).toBe(replyInput);
      expect((groupInput as HTMLTextAreaElement).value).toBe('Group draft');
      expect((replyInput as HTMLTextAreaElement).value).toBe('Reply draft');
      expect(screen.getByText('周六 8:10 有票').closest('article')).toBe(message);
      expect(screen.getByTestId('bot-group-timeline')).toBe(timeline);
      expect(timeline.scrollTop).toBe(25);
      // Dragging must not acquire a CSS transition that would lag behind the pointer.
      expect(panel.className).not.toMatch(/transition/);
    });

    it('bounds both columns, adapts to container resizing, and ends cancelled pointer gestures', async () => {
      const { panel, handle } = await openResizableThread();
      fireEvent.pointerDown(handle, { button: 2, clientX: 752 });
      fireEvent.pointerMove(handle, { clientX: 100 });
      expect(panel.style.width).toBe('');
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 752 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: -1000 });
      expect(panel.style.width).toBe('800px');
      fireEvent.pointerCancel(handle, { pointerId: 1 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 2000 });
      expect(panel.style.width).toBe('800px');
      const layout = panel.parentElement!;
      available = 600;
      act(() => observed.get(layout)!([], {} as ResizeObserver));
      expect(panel.style.width).toBe('360px');
      available = 1200;
      act(() => observed.get(layout)!([], {} as ResizeObserver));
      expect(panel.style.width).toBe('800px');
      fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX: 400 });
      fireEvent.pointerMove(handle, { pointerId: 3, clientX: 2000 });
      expect(panel.style.width).toBe('280px');
      fireEvent.lostPointerCapture(handle, { pointerId: 3 });
      fireEvent.pointerMove(handle, { pointerId: 3, clientX: 0 });
      expect(panel.style.width).toBe('280px');
    });

    it('keeps the chosen width when switching topics and reopening, with the existing open/close motion', async () => {
      const motion = mockThreadMotion('200ms');
      try {
        const { panel, handle, triggers } = await openResizableThread();
        fireEvent.keyDown(handle, { key: 'ArrowLeft' });
        expect(motion.animations[0]!.cancel).toHaveBeenCalled();
        expect(panel.style.width).toBe('464px');
        fireEvent.keyDown(handle, { key: 'ArrowRight' });
        expect(panel.style.width).toBe('448px');
        fireEvent.keyDown(handle, { key: 'ArrowLeft' });
        fireEvent.click(triggers[1]!);
        await screen.findByText('Reply to b1');
        const switched = screen.getByRole('complementary');
        expect(switched.style.width).toBe('464px');
        fireEvent.click(within(switched).getByRole('button', { name: 'bots.close' }));
        await act(async () => motion.animations[1]!.finish());
        expect(screen.queryByRole('complementary')).toBeNull();
        fireEvent.click(triggers[0]!);
        const reopened = screen.getByRole('complementary');
        expect(reopened.style.width).toBe('464px');
        expect(motion.animate).toHaveBeenLastCalledWith([{ width: '0px' }, { width: '464px' }], expect.anything());
      } finally { cleanup(); motion.restore(); }
    });
  });

  it('expands a sibling thread panel, keeps the group usable, switches threads and restores the layout on close', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    const user = userEvent.setup();
    renderView();
    const main = (await screen.findByText('周六 8:10 有票')).closest('main')!;
    const composer = within(main).getByRole('textbox');
    const triggers = within(main).getAllByRole('button', { name: 'bots.groupChat.server.startTopic' });
    await user.click(triggers[0]!);
    const panel = screen.getByRole('complementary', { name: 'bots.groupChat.server.topic' });
    expect(panel.parentElement).toBe(main.parentElement);
    expect(main.parentElement?.className).toContain('flex');
    expect(main.className).toContain('flex-1');
    expect(panel.className).not.toMatch(/fixed|absolute/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(main.closest('[aria-hidden="true"]')).toBeNull();
    await screen.findByText('Reply to u1');
    await user.click(composer);
    await user.type(composer, 'Group remains editable');
    expect((composer as HTMLTextAreaElement).value).toBe('Group remains editable');
    await user.click(triggers[1]!);
    await screen.findByText('Reply to b1');
    expect(screen.queryByText('Reply to u1')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'bots.close' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(triggers[1]);
    expect(within(main).getByRole('textbox')).toBe(composer);
    await user.click(triggers[0]!);
    expect(await screen.findByText('Reply to u1')).toBeTruthy();
  });

  it('focuses the reply input without trapping Tab; closes by keyboard and ignores IME Escape', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    const user = userEvent.setup();
    renderView();
    const trigger = (await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!;
    await user.click(trigger);
    const panel = screen.getByRole('complementary');
    const input = within(panel).getByRole('textbox');
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true, keyCode: 229 });
    expect(screen.getByRole('complementary')).toBe(panel);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    for (const key of ['{Enter}', ' ']) {
      await user.click(trigger);
      const close = screen.getByRole('button', { name: 'bots.close' });
      close.focus();
      await user.tab({ shift: true });
      expect(screen.getByRole('main').contains(document.activeElement)).toBe(true);
      close.focus();
      await user.keyboard(key);
      expect(screen.queryByRole('complementary')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    }
  });

  it('closes the thread with Escape after clicking or tabbing into the main group, respecting IME and consumed events', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    const user = userEvent.setup();
    renderView();
    const trigger = (await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!;
    const main = trigger.closest('main')!;
    const composer = within(main).getByRole('textbox');
    for (const path of ['click', 'tab']) {
      await user.click(trigger);
      const panel = screen.getByRole('complementary');
      if (path === 'click') await user.click(composer);
      else {
        within(panel).getByRole('button', { name: 'bots.close' }).focus();
        await user.tab({ shift: true });
      }
      const focused = document.activeElement!;
      expect(main.contains(focused)).toBe(true);
      fireEvent.keyDown(focused, { key: 'Escape', isComposing: true, keyCode: 229 });
      expect(screen.getByRole('complementary')).toBe(panel);
      const consumed = createEvent.keyDown(focused, { key: 'Escape', bubbles: true, cancelable: true });
      consumed.preventDefault();
      fireEvent(focused, consumed);
      expect(screen.getByRole('complementary')).toBe(panel);
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('complementary')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    }
  });

  it('closes with Escape after clicking message text or empty timeline space, respecting IME and consumed events', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    const user = userEvent.setup();
    renderView();
    const message = await screen.findByText('周六 8:10 有票');
    const main = message.closest('main')!;
    const trigger = within(main).getAllByRole('button', { name: 'bots.groupChat.server.startTopic' })[0]!;
    for (const target of [message, main]) {
      await user.click(trigger);
      const panel = screen.getByRole('complementary');
      await user.click(target);
      expect(document.activeElement).toBe(document.body);
      fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true, keyCode: 229 });
      expect(screen.getByRole('complementary')).toBe(panel);
      const consumed = createEvent.keyDown(document.body, { key: 'Escape', bubbles: true, cancelable: true });
      consumed.preventDefault();
      fireEvent(document.body, consumed);
      expect(screen.getByRole('complementary')).toBe(panel);
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('complementary')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    }
  });

  it('keeps main composer focus and both drafts when leaving thread image sharing', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    const user = userEvent.setup();
    renderView();
    const trigger = (await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!;
    const main = trigger.closest('main')!;
    await user.click(trigger);
    const panel = screen.getByRole('complementary');
    await user.type(within(panel).getByRole('textbox'), 'Thread draft');
    await user.click((await within(panel).findAllByRole('button', { name: 'chat.messageActionBar.moreActions' }))[0]!);
    await user.click(await screen.findByRole('menuitem', { name: 'chat.shareImage.entry' }));
    expect(within(panel).queryByRole('textbox')).toBeNull();
    const composer = within(main).getByRole('textbox');
    await user.type(composer, 'Main draft');
    act(() => shareSelectionStore.exit());
    expect(document.activeElement).toBe(composer);
    expect((within(panel).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Thread draft');
    await user.keyboard(' continues');
    expect((composer as HTMLTextAreaElement).value).toBe('Main draft continues');
  });

  it.each(['main', 'thread'])('lets %s image selection consume Escape before the thread', async scope => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    const user = userEvent.setup();
    renderView();
    const trigger = (await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!;
    await user.click(trigger);
    const panel = screen.getByRole('complementary');
    await user.type(within(panel).getByRole('textbox'), 'Thread draft');
    const owner = scope === 'main' ? screen.getByRole('main') : panel;
    await user.click(within(owner).getAllByRole('button', { name: 'chat.messageActionBar.moreActions' })[0]!);
    await user.click(await screen.findByRole('menuitem', { name: 'chat.shareImage.entry' }));
    expect(shareSelectionStore.getActiveSessionId()).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(shareSelectionStore.getActiveSessionId()).toBeNull();
    expect(screen.getByRole('complementary')).toBe(panel);
    expect((within(panel).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Thread draft');
    await user.click(within(panel).getByRole('textbox'));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes with Escape from the separate group header, yielding to consumed and IME events', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    const user = userEvent.setup();
    renderView();
    const trigger = (await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!;
    const header = screen.getByTestId('content-header');
    for (const button of within(header).getAllByRole('button')) {
      await user.click(trigger);
      const panel = screen.getByRole('complementary');
      button.focus();
      expect(panel.parentElement?.contains(button)).toBe(false);
      if (button.getAttribute('aria-label') === 'bots.groupChat.settings.open') await screen.findByRole('tooltip');
      fireEvent.keyDown(button, { key: 'Escape', isComposing: true, keyCode: 229 });
      const consumed = createEvent.keyDown(button, { key: 'Escape', bubbles: true, cancelable: true });
      consumed.preventDefault();
      fireEvent(button, consumed);
      expect(screen.getByRole('complementary')).toBe(panel);
      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('complementary')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    }
  });

  it.each(['image', 'text-trigger', 'text-control', 'text-body'])('lets %s attachment preview close first with Escape and retains the thread draft', async kind => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true, messages: [msg({
      attachments: [{ id: 'attachment', name: kind === 'image' ? 'photo.png' : 'note.md', category: kind === 'image' ? 'image' : 'text',
        mimeType: kind === 'image' ? 'image/png' : 'text/markdown', size: 10,
        url: kind === 'image' ? 'cindy-media://blobs/photo.png' : null, path: kind === 'image' ? null : '/tmp/note.md' }],
    })] }) });
    Object.assign(window.electronAPI, { readTextFilePreview: vi.fn().mockResolvedValue({ success: true, data: 'Preview note content', size: 20 }) });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.server.startTopic' }));
    const panel = screen.getByRole('complementary');
    await user.type(within(panel).getByRole('textbox'), 'Unsent thread reply');
    if (kind === 'image') fireEvent.load(screen.getByAltText('photo.png'));
    await user.click(screen.getByRole('button', { name: kind === 'image' ? 'photo.png' : 'note.md' }));
    const preview = kind === 'image' ? document.activeElement! : document.querySelector('[data-text-lightbox-overlay]')!;
    if (kind !== 'image') {
      await screen.findByText('Preview note content');
      if (kind === 'text-control') within(preview as HTMLElement).getAllByRole('button', { name: 'chat.lightbox.close' })[0]!.focus();
      else if (kind === 'text-body') {
        await user.click(screen.getByText('Preview note content'));
        expect(document.activeElement).toBe(document.body);
      } else expect(screen.getByRole('main').contains(document.activeElement)).toBe(true);
    }
    await user.keyboard('{Escape}');
    expect(screen.getByRole('complementary')).toBe(panel);
    expect((within(panel).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Unsent thread reply');
    await waitFor(() => expect(document.contains(preview)).toBe(false));
    if (kind !== 'image') expect(window.electronAPI.readTextFilePreview).toHaveBeenCalledTimes(1);
    within(panel).getByRole('textbox').focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('lets the actual Mermaid preview consume Escape before the thread and preserves its draft', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    const user = userEvent.setup();
    renderView();
    const trigger = (await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!;
    const main = trigger.closest('main')!;
    await user.click(trigger);
    const panel = screen.getByRole('complementary');
    await user.type(within(panel).getByRole('textbox'), 'Unsent diagram reply');
    const container = document.createElement('div');
    main.append(container);
    render(<MarkdownMermaidBlock raw="graph TD; A-->B" />, { container });
    const diagram = await within(container).findByRole('button', { name: 'chat.mermaid.clickToZoom' });
    await user.click(diagram);
    await screen.findByRole('button', { name: 'chat.mermaidLightbox.close' });
    expect(document.activeElement).toBe(diagram);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'chat.mermaidLightbox.close' })).toBeNull());
    expect(screen.getByRole('complementary')).toBe(panel);
    expect((within(panel).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Unsent diagram reply');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('lets Escape dismiss a portalled reaction picker without closing the thread', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    const user = userEvent.setup();
    renderView();
    await user.click((await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!);
    const panel = screen.getByRole('complementary');
    await user.click((await within(panel).findAllByRole('button', { name: 'bots.groupChat.server.addReaction' }))[0]!);
    const reaction = await screen.findByRole('button', { name: '🎉' });
    reaction.focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: '🎉' })).toBeNull();
    expect(screen.getByRole('complementary')).toBe(panel);
  });

  it('updates an attachment on an earlier page when its download finishes', async () => {
    let arrived = false;
    const latest = msg({ id: 'latest', sequence: 300, content: 'Latest question' });
    const older = () => msg({ id: 'older', sequence: 4, content: 'Earlier picture', attachments: [arrived
      ? { id: 'old', name: 'old.png', category: 'image', mimeType: 'image/png', size: 1, url: 'cindy-media://blobs/old.png', path: null }
      : { id: 'old', name: 'old.png', category: 'file', mimeType: '', size: 0, url: null, path: null, state: 'loading' }] });
    mocks.getBotGroup.mockImplementation(async (_id: string, options?: { beforeSequence?: number }) => ({ ok: true, group: options?.beforeSequence
      ? detail({ messages: [older()], hasMoreBefore: false })
      : detail({ messages: [latest], hasMoreBefore: true }) }));
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    expect(await screen.findByText('chat.imageMissing.loading')).toBeTruthy();
    arrived = true;
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    expect(await screen.findByAltText('old.png')).toBeTruthy();
    expect(screen.queryByText('chat.imageMissing.loading')).toBeNull();
    expect(mocks.getBotGroup.mock.calls.map(([, options]) => (options as { beforeSequence?: number } | undefined)?.beforeSequence))
      .toEqual([undefined, 300, undefined, 5]);
  });

  it('retries an attachment that failed on an earlier page when a later change arrives', async () => {
    let attempt: 'failed' | 'ready' = 'failed';
    const older = () => msg({ id: 'older', sequence: 4, content: 'Earlier picture', attachments: [attempt === 'ready'
      ? { id: 'old', name: 'old.png', category: 'image', mimeType: 'image/png', size: 1, url: 'cindy-media://blobs/old.png', path: null }
      : { id: 'old', name: 'old.png', category: 'file', mimeType: '', size: 0, url: null, path: null, state: 'unavailable' }] });
    mocks.getBotGroup.mockImplementation(async (_id: string, options?: { beforeSequence?: number }) => ({ ok: true, group: options?.beforeSequence
      ? detail({ messages: [older()], hasMoreBefore: false })
      : detail({ messages: [msg({ id: 'latest', sequence: 300, content: 'Latest question' })], hasMoreBefore: true }) }));
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    expect(await screen.findByText('chat.imageMissing.unavailable')).toBeTruthy();
    // Main's backoff is over and the retried download succeeded; any later change re-reads that page.
    attempt = 'ready';
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    expect(await screen.findByAltText('old.png')).toBeTruthy();
    expect(screen.queryByText('chat.imageMissing.unavailable')).toBeNull();
  });

  it('updates loading attachments on six separate earlier pages after a single change push', async () => {
    let arrived = false;
    const olderSequences = [600, 500, 400, 300, 200, 100];
    const older = (sequence: number) => msg({ id: `older-${sequence}`, sequence, content: `Earlier ${sequence}`, attachments: [arrived
      ? { id: `a${sequence}`, name: `a${sequence}.png`, category: 'image', mimeType: 'image/png', size: 1, url: `cindy-media://blobs/a${sequence}.png`, path: null }
      : { id: `a${sequence}`, name: `a${sequence}.png`, category: 'file', mimeType: '', size: 0, url: null, path: null, state: 'loading' }] });
    // "Load earlier" asks before the oldest shown message; a refresh asks before a loading one (+1).
    mocks.getBotGroup.mockImplementation(async (_id: string, options?: { beforeSequence?: number }) => {
      const before = options?.beforeSequence;
      if (!before) return { ok: true, group: detail({ messages: [msg({ id: 'latest', sequence: 700, content: 'Latest question' })], hasMoreBefore: true }) };
      const sequence = before % 100 === 1 ? before - 1 : before - 100;
      return { ok: true, group: detail({ messages: [older(sequence)], hasMoreBefore: sequence > 100 }) };
    });
    renderView();
    for (const sequence of olderSequences) {
      fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
      await screen.findByText(`Earlier ${sequence}`);
    }
    expect(screen.getAllByText('chat.imageMissing.loading')).toHaveLength(6);
    arrived = true;
    // One coalesced push for all six downloads, and nothing after it.
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    for (const sequence of olderSequences) expect(await screen.findByAltText(`a${sequence}.png`)).toBeTruthy();
    expect(screen.queryByText('chat.imageMissing.loading')).toBeNull();
    const refreshReads = mocks.getBotGroup.mock.calls.map(([, options]) => (options as { beforeSequence?: number } | undefined)?.beforeSequence)
      .filter((before): before is number => before !== undefined && before % 100 === 1);
    expect(refreshReads).toEqual([601, 501, 401, 301, 201, 101]);
  });

  it('keeps a newer push failure snapshot when a stale older-page request finishes later', async () => {
    const latest = msg({ id: 'latest', sequence: 100, content: 'Latest question' });
    const source = msg({ id: 'older', sequence: 4, content: 'Earlier question' });
    const failure = { executionId: 'older', epoch: 1, sourceMessageId: source.id, botId: 'bot', botName: 'Bot', code: 'AUTH_REQUIRED' as const, planId: null };
    let finish: ((result: { ok: true; group: BotGroupDetail }) => void) | undefined;
    const pending = new Promise<{ ok: true; group: BotGroupDetail }>(resolve => { finish = resolve; });
    mocks.getBotGroup.mockResolvedValueOnce({ ok: true, group: detail({ messages: [latest], hasMoreBefore: true, executionFailures: [failure] }) })
      .mockReturnValueOnce(pending)
      .mockResolvedValue({ ok: true, group: detail({ name: 'Fresh group', messages: [{ ...latest, content: 'Fresh question' }], executionFailures: [] }) });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'round' })));
    await screen.findByText('Fresh group');
    await act(async () => finish?.({ ok: true, group: detail({ messages: [source], messageUpdates: [latest], executionFailures: [failure] }) }));
    expect(screen.getByText('Earlier question')).toBeTruthy();
    expect(screen.getByText('Fresh question')).toBeTruthy();
    expect(screen.queryByText('Latest question')).toBeNull();
    expect(screen.queryByText('bots.groupChat.notice.runtimeFailure.AUTH_REQUIRED:Bot')).toBeNull();
  });

  // PR #7242: latest-page tests did not cover a reset first discovered by pagination,
  // or an in-flight page from the previous generation. Unit: exercise the real view.
  it('discards the entire visible history when an older page reports a new history revision', async () => {
    const latest = msg({ id: 'latest', sequence: 100, content: 'Old latest' });
    const older = msg({ id: 'older', sequence: 50, content: 'Old earlier' });
    let finish: ((result: { ok: true; group: BotGroupDetail }) => void) | undefined;
    let finishStaleRefresh: ((result: { ok: true; group: BotGroupDetail }) => void) | undefined;
    const pending = new Promise<{ ok: true; group: BotGroupDetail }>(resolve => { finish = resolve; });
    const staleRefresh = new Promise<{ ok: true; group: BotGroupDetail }>(resolve => { finishStaleRefresh = resolve; });
    mocks.getBotGroup.mockResolvedValueOnce({ ok: true, group: detail({ historyRevision: 'a', messages: [latest], hasMoreBefore: true }) })
      .mockResolvedValueOnce({ ok: true, group: detail({ historyRevision: 'a', messages: [older], hasMoreBefore: true }) })
      .mockReturnValueOnce(staleRefresh)
      .mockResolvedValueOnce({ ok: true, group: detail({ historyRevision: 'b', messages: [], hasMoreBefore: false }) })
      .mockReturnValueOnce(pending);
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await screen.findByText('Old earlier');
    // The independent display cache can still hold the revoked window while delta sync resets.
    mocks.cachedGroup = detail({ historyRevision: 'a', messages: [latest], hasMoreBefore: true });
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' })));
    expect(screen.queryByText('Old earlier')).toBeNull();
    expect(screen.queryByText('Old latest')).toBeNull();
    expect(mocks.getBotGroup.mock.calls.at(-1)).toEqual(['g1', undefined]);
    await act(async () => finishStaleRefresh?.({ ok: true, group: detail({ historyRevision: 'a', messages: [latest], hasMoreBefore: true }) }));
    expect(screen.queryByText('Old latest')).toBeNull();
    await act(async () => finish?.({ ok: true, group: detail({ historyRevision: 'b', messages: [msg({ id: 'new', content: 'New history' })] }) }));
    expect(screen.getByText('New history')).toBeTruthy();
    expect(screen.queryByText('Old latest')).toBeNull();
  });

  it('ignores a late older page from a previous history revision even when the anchor survives', async () => {
    const latest = msg({ id: 'latest', sequence: 100, content: 'Old latest' });
    let finish: ((result: { ok: true; group: BotGroupDetail }) => void) | undefined;
    const pending = new Promise<{ ok: true; group: BotGroupDetail }>(resolve => { finish = resolve; });
    mocks.getBotGroup.mockResolvedValueOnce({ ok: true, group: detail({ historyRevision: 'a', messages: [latest], hasMoreBefore: true }) })
      .mockReturnValueOnce(pending)
      .mockResolvedValue({ ok: true, group: detail({ historyRevision: 'b', messages: [{ ...latest, content: 'New latest' }], hasMoreBefore: true }) });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    await screen.findByText('New latest');
    await act(async () => finish?.({ ok: true, group: detail({ historyRevision: 'a', messages: [msg({ id: 'old', content: 'Revoked history' })] }) }));
    expect(screen.queryByText('Revoked history')).toBeNull();
    expect(screen.getByText('New latest')).toBeTruthy();
    expect(mocks.getBotGroup).toHaveBeenCalledTimes(3);
  });

  it('applies pagination message updates to both the latest page and previously loaded history', async () => {
    const latest = msg({ id: 'latest', sequence: 100, content: 'Unedited latest' });
    const older = msg({ id: 'older', sequence: 50, content: 'Undeleted earlier' });
    mocks.getBotGroup.mockResolvedValueOnce({ ok: true, group: detail({ historyRevision: 'a', messages: [latest], hasMoreBefore: true }) })
      .mockResolvedValueOnce({ ok: true, group: detail({ historyRevision: 'a', messages: [older], hasMoreBefore: true }) })
      .mockResolvedValueOnce({ ok: true, group: detail({ historyRevision: 'a', messages: [], messageUpdates: [
        { ...latest, content: 'Edited latest' }, { ...older, content: '', deleted: true },
      ] }) });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await screen.findByText('Undeleted earlier');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' })));
    expect(screen.queryByText('Undeleted earlier')).toBeNull();
    expect(screen.queryByText('Unedited latest')).toBeNull();
    expect(screen.getByText('Edited latest')).toBeTruthy();
  });

  it('drops an older page that answers after the latest page started over', async () => {
    const latest = msg({ id: 'latest', sequence: 100, content: 'Latest question' });
    const source = msg({ id: 'older', sequence: 4, content: 'Earlier question' });
    const far = msg({ id: 'far', sequence: 300, content: 'Far question' });
    let finish: ((result: { ok: true; group: BotGroupDetail }) => void) | undefined;
    const pending = new Promise<{ ok: true; group: BotGroupDetail }>(resolve => { finish = resolve; });
    mocks.getBotGroup.mockResolvedValueOnce({ ok: true, group: detail({ messages: [latest], hasMoreBefore: true }) })
      .mockReturnValueOnce(pending)
      .mockResolvedValue({ ok: true, group: detail({ messages: [far], hasMoreBefore: true }) });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    // More than a page arrives while the older page is still on its way: the timeline starts over.
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'round' })));
    await screen.findByText('Far question');
    await act(async () => finish?.({ ok: true, group: detail({ messages: [source], hasMoreBefore: false }) }));
    expect(screen.queryByText('Earlier question')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await waitFor(() => expect(mocks.getBotGroup.mock.calls.at(-1)?.[1]).toMatchObject({ beforeSequence: 300 }));
  });

  it.each([false, true])('clears retried failures on an older timeline page when the newest page is refreshed (initial failure: %s)', async initialFailure => {
    const source = msg({ id: 'older-source', sequence: 4, content: 'Earlier question' });
    const failure = { executionId: 'older', epoch: 1, sourceMessageId: source.id, botId: 'bot', botName: 'Bot', code: 'AUTH_REQUIRED' as const, planId: null };
    const latest = msg({ id: 'latest-source', sequence: 100, content: 'Latest question' });
    mocks.getBotGroup.mockResolvedValueOnce({ ok: true, group: detail({ messages: [latest], hasMoreBefore: true, executionFailures: initialFailure ? [failure] : [] }) })
      .mockResolvedValueOnce({ ok: true, group: detail({ messages: [source], hasMoreBefore: false, executionFailures: [failure] }) })
      .mockResolvedValue({ ok: true, group: detail({ messages: [latest], executionFailures: [] }) });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await screen.findByText('bots.groupChat.notice.runtimeFailure.AUTH_REQUIRED:Bot');
    act(() => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'round' })));
    await waitFor(() => expect(screen.queryByText('bots.groupChat.notice.runtimeFailure.AUTH_REQUIRED:Bot')).toBeNull());
    expect(screen.getByText('Earlier question')).toBeTruthy();
    expect(screen.getByText('Latest question')).toBeTruthy();
    expect(mocks.getBotGroup.mock.calls.at(-1)).toEqual(['g1', { sourceMessageIds: [source.id, latest.id] }]);
  });

  it('shows another human as a named participant instead of the current user bubble', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [
      msg({ id: 'guest', authorKind: 'user', isSelf: false, authorName: 'Invited human', content: 'Hello from another account' }),
    ] }) });
    renderView();
    expect(await screen.findByText('Invited human')).toBeTruthy();
    expect(screen.getByText('Hello from another account').closest('article')?.className).not.toContain('justify-end');
  });

  it.each([true, false])('preserves the reader position when the notice changes (pinned=%s)', async (pinned) => {
    const view = renderView();
    await screen.findByRole('textbox');
    const scroller = view.container.querySelector('main > div') as HTMLDivElement;
    const main = scroller.parentElement!;
    let top = 0;
    // jsdom has no layout. Model a fixed content height and the viewport consumed
    // by the mounted notice; scrollTop follows the browser's clamping behavior.
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, get: () => 1600 },
      clientHeight: {
        configurable: true,
        get: () => main.querySelector('[data-controlled-banner-chip]') ? 564
          : main.querySelector('[data-controlled-banner="collapsed"]') ? 572 : 600,
      },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => { top = Math.min(value, scroller.scrollHeight - scroller.clientHeight); },
      },
    });
    scroller.scrollTop = pinned ? 1000 : 180;
    fireEvent.scroll(scroller);
    act(() => mocks.controlledPush?.({ controllers: [{ deviceId: 'studio', name: 'Mac Studio' }] }));
    expect(scroller.scrollTop).toBe(pinned ? 1036 : 180);
    fireEvent.click(screen.getByRole('button', { name: 'remoteDevice.collapseControlledNotice' }));
    expect(scroller.scrollTop).toBe(pinned ? 1028 : 180);
    fireEvent.click(screen.getByRole('button', { name: 'remoteDevice.expandControlledNotice' }));
    expect(scroller.scrollTop).toBe(pinned ? 1036 : 180);
    act(() => mocks.controlledPush?.({ controllers: [] }));
    expect(scroller.scrollTop).toBe(pinned ? 1000 : 180);
  });

  it('reuses the composer close and restore controls with independent group state', async () => {
    mocks.getBotGroup.mockImplementation(async () => ({ ok: true, group: detail({ id: mocks.groupId }) }));
    mocks.getControlledState.mockResolvedValue({
      controlledBy: [{ deviceId: 'studio', name: 'Mac Studio' }],
    });
    const fallback = render(<ControlledBanner />);
    let groupView = renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'remoteDevice.collapseControlledNotice' }));
    expect(groupView.container.querySelector('[data-controlled-banner-chip]')).toBeNull();
    expect(screen.getByRole('button', { name: 'remoteDevice.expandControlledNotice' })).toBeTruthy();
    expect(fallback.container.childElementCount).toBe(0);
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.sendBotGroupMessage).not.toHaveBeenCalled();
    groupView.unmount();

    // A task with the same raw ID must not inherit the group's collapse state.
    const task = render(<ControlledBanner placement="composer" sessionId="g1" />);
    expect(task.container.querySelector('[data-controlled-banner-chip]')).toBeTruthy();
    task.unmount();
    mocks.groupId = 'g2';
    groupView = renderView();
    await screen.findByRole('textbox');
    expect(groupView.container.querySelector('[data-controlled-banner-chip]')).toBeTruthy();
    groupView.unmount();

    mocks.groupId = 'g1';
    groupView = renderView();
    await screen.findByRole('textbox');
    expect(groupView.container.querySelector('[data-controlled-banner-chip]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'remoteDevice.expandControlledNotice' }));
    expect(groupView.container.querySelector('[data-controlled-banner-chip]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'remoteDevice.revokeAccess' })).toBeTruthy();
    expect(fallback.container.childElementCount).toBe(0);
  });

  it('hosts the connection notice before the composer and restores the global fallback on exit', async () => {
    mocks.getControlledState.mockResolvedValue({
      controlledBy: [{ deviceId: 'studio', name: 'Mac Studio' }],
    });
    const fallback = render(<ControlledBanner />);
    const view = renderView();
    const input = await screen.findByRole('textbox');
    await waitFor(() => expect(fallback.container.childElementCount).toBe(0));
    expect(screen.getAllByText('remoteDevice.controlledBy:Mac Studio')).toHaveLength(1);
    const chip = view.container.querySelector('[data-controlled-banner-chip]')!;
    expect(chip).toBeTruthy();
    expect(chip.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chip.closest('main')).toBe(input.closest('main'));
    expect(screen.getByRole('button', { name: 'remoteDevice.revokeAccess' })).toBeTruthy();

    fireEvent.change(input, { target: { value: '第一行\n第二行\n第三行' } });
    expect(view.container.querySelector('[data-controlled-banner-chip]')).toBe(chip);
    expect(fallback.container.childElementCount).toBe(0);
    expect(mocks.sendBotGroupMessage).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();

    view.unmount();
    expect(fallback.container.querySelector('[data-controlled-banner-chip]')).toBeTruthy();
  });

  it('adds and removes the inline notice as connections change without leaving an empty row', async () => {
    const fallback = render(<ControlledBanner />);
    const view = renderView();
    await screen.findByRole('textbox');
    const main = view.container.querySelector('main')!;
    const originalRows = main.childElementCount;
    expect(main.querySelector('[data-controlled-banner-chip]')).toBeNull();
    act(() => mocks.controlledPush?.({ controllers: [{ deviceId: 'studio', name: 'Mac Studio' }] }));
    expect(main.childElementCount).toBe(originalRows + 1);
    expect(main.querySelector('[data-controlled-banner-chip]')).toBeTruthy();
    expect(fallback.container.childElementCount).toBe(0);
    act(() => mocks.controlledPush?.({ controllers: [] }));
    expect(main.childElementCount).toBe(originalRows);
    expect(document.querySelector('[data-controlled-banner-chip]')).toBeNull();
  });

  it('renders a joined member as a localized system line without message actions', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [msg({ id: 'join', kind: 'notice',
      authorKind: 'system', authorName: 'Taylor', authorBotId: null, noticeCode: 'member-joined', content: 'Fallback text' })] }) });
    renderView();
    const notice = await screen.findByText('bots.groupChat.notice.memberJoined:Taylor');
    expect(notice.tagName).toBe('P');
    expect(notice.closest('article')).toBeNull();
    expect(screen.queryByText('Fallback text')).toBeNull();
    expect(mocks.sendBotGroupMessage).not.toHaveBeenCalled();
  });

  it('renders user, teammate, notice and round-end rows with the header lockup', async () => {
    renderView();
    expect(await screen.findByText('周六 8:10 有票')).toBeTruthy();
    // The user's own message is a right-aligned bubble rendered as Markdown.
    expect(screen.getByTestId('bot-group-self-bubble').textContent).toBe('@小满 帮我查余票');
    expect(screen.getByTestId('bot-group-self-bubble').querySelector('[data-markdown]')).toBeTruthy();
    expect(screen.getByText('bots.groupChat.notice.memberTimeout:咪咪')).toBeTruthy();
    expect(screen.getByText('bots.groupChat.timeline.roundEnded')).toBeTruthy();
    const header = screen.getByTestId('content-header');
    expect(header.textContent).toContain('周末出游');
    // The line under the name reads the group's size, not every member; the names stay in the tooltip.
    expect(within(header).getByTestId('bot-group-header-summary').textContent).toBe('bots.groupChat.memberCount:2');
    expect(header.querySelector('button[title]')?.getAttribute('title')).toBe('咪咪bots.groupChat.memberSeparator小满');
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.settings.open' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/g1?groupSettings=1');
  });

  it('continues only from the latest continuable round end', async () => {
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.continue' }));
    await waitFor(() => expect(mocks.continueBotGroupRound).toHaveBeenCalledWith('g1'));
    await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
  });

  it('hides continue when main says the round cannot continue', async () => {
    mocks.getBotGroup.mockResolvedValue({
      ok: true,
      group: detail({ round: { status: 'idle', speakers: [], canContinue: false } }),
    });
    renderView();
    await screen.findByText('bots.groupChat.timeline.roundEnded');
    expect(screen.queryByRole('button', { name: 'bots.groupChat.timeline.continue' })).toBeNull();
  });

  it('shows the speaking teammate and turns send into stop while a round runs', async () => {
    mocks.getBotGroup.mockResolvedValue({
      ok: true,
      group: detail({
        speakingBotIds: ['mimi'],
        round: {
          status: 'running',
          speakers: [{ botId: 'mimi', sessionId: 'lane-mimi', activity: 'reply' }],
          canContinue: false,
        },
      }),
    });
    renderView();
    const speaking = await screen.findByTestId('bot-group-speaking');
    expect(speaking.textContent).toContain('咪咪');
    expect(speaking.textContent).toContain('phase:processing');
    expect(screen.getByTestId('pending-interaction').textContent).toBe('lane-mimi');
    expect(screen.queryByRole('button', { name: 'bots.groupChat.timeline.continue' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.composer.stop' }));
    await waitFor(() => expect(mocks.stopBotGroupRound).toHaveBeenCalledWith('g1'));

    // Typing turns the button back into send: interrupting starts a new round.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '换个方案' } });
    expect(screen.getByRole('button', { name: 'bots.send' })).toBeTruthy();
  });

  it('shows every teammate thinking at once in a parallel circle', async () => {
    mocks.getBotGroup.mockResolvedValue({
      ok: true,
      group: detail({
        speakingBotIds: ['mimi', 'xiaoman'],
        round: {
          status: 'running',
          speakers: [
            { botId: 'mimi', sessionId: 'lane-mimi', activity: 'reply' },
            { botId: 'xiaoman', sessionId: 'lane-xiaoman', activity: 'reply' },
          ],
          canContinue: false,
        },
      }),
    });
    renderView();
    await screen.findAllByTestId('bot-group-speaking');
    const rows = screen.getAllByTestId('bot-group-speaking');
    expect(rows.map((row) => row.textContent?.includes('咪咪') ? 'mimi' : row.textContent?.includes('小满') ? 'xiaoman' : '?'))
      .toEqual(['mimi', 'xiaoman']);
    expect(screen.getAllByTestId('pending-interaction').map((node) => node.textContent))
      .toEqual(['lane-mimi', 'lane-xiaoman']);
  });

  it('sends with Enter, parses mentions, and re-reads after main accepts', async () => {
    renderView();
    const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@咪咪 规划一下', selectionStart: 8 } });
    // IME confirmation must not send.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(mocks.sendBotGroupMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
    const [input0] = mocks.sendBotGroupMessage.mock.calls[0] as [Record<string, unknown>];
    expect(input0).toMatchObject({
      groupId: 'g1',
      text: '@咪咪 规划一下',
      mentions: { all: false, botIds: ['mimi'] },
    });
    expect(typeof input0.clientId).toBe('string');
    expect(input.value).toBe('');
    await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
  });

  it('opens the @ picker with Everyone first and inserts the chosen teammate', async () => {
    renderView();
    const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '查一下 @', selectionStart: 5 } });
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'bots.groupChat.mention.allbots.groupChat.mention.allHint',
      '咪咪',
      '小满',
    ]);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('查一下 @小满 ');
    expect(mocks.sendBotGroupMessage).not.toHaveBeenCalled();
  });

  it('keeps a selected target and its draft across roster removal and a rejected retry', async () => {
    const namesakes = [
      { ...detail().members[0]!, botId: 'picked', name: 'Ann' },
      { ...detail().members[1]!, botId: 'other', name: 'Ann' },
    ];
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ members: namesakes }) });
    mocks.sendBotGroupMessage.mockResolvedValue({ ok: false, errorCode: 'MENTION_UNAVAILABLE', message: '' });
    renderView();
    const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '@', selectionStart: 1 } });
    const options = await screen.findAllByRole('option');
    fireEvent.click(options[1]!);
    expect(input.value).toBe('@Ann ');
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ members: namesakes.slice(1) }) });
    act(() => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
    for (let attempt = 1; attempt <= 2; attempt++) {
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(attempt));
      await waitFor(() => expect(input.value).toBe('@Ann '));
      expect(mocks.sendBotGroupMessage.mock.calls.at(-1)![0].mentions).toEqual({ all: false, botIds: ['picked'] });
    }
    expect(mocks.toastError).toHaveBeenCalledWith('bots.groupChat.errors.mentionUnavailable');
    const originalClientId = mocks.sendBotGroupMessage.mock.calls[0]![0].clientId;
    expect(mocks.sendBotGroupMessage.mock.calls[1]![0].clientId).toBe(originalClientId);
    fireEvent.change(input, { target: { value: '@', selectionStart: 1 } });
    const remaining = await screen.findAllByRole('option');
    fireEvent.click(remaining[1]!);
    mocks.sendBotGroupMessage.mockResolvedValue({ ok: true, messageId: 'accepted' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(3));
    expect(mocks.sendBotGroupMessage.mock.calls.at(-1)![0].mentions).toEqual({ all: false, botIds: ['other'] });
    expect(mocks.sendBotGroupMessage.mock.calls.at(-1)![0].clientId).not.toBe(originalClientId);
  });

  it('drops a deleted selected mention before a namesake is manually mentioned again', async () => {
    const namesakes = [
      { ...detail().members[0]!, botId: 'picked', name: 'Ann' },
      { ...detail().members[1]!, botId: 'other', name: 'Ann' },
    ];
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ members: namesakes }) });
    renderView();
    const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '@', selectionStart: 1 } });
    fireEvent.click((await screen.findAllByRole('option'))[1]!);
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ members: namesakes.slice(1) }) });
    act(() => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
    fireEvent.change(input, { target: { value: 'hello', selectionStart: 5 } });
    fireEvent.change(input, { target: { value: '@Ann hello', selectionStart: 10 } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
    expect(mocks.sendBotGroupMessage.mock.calls[0]![0].mentions).toEqual({ all: false, botIds: ['other'] });
  });

  it.each(['picked', 'manual'])('removes only the %s token identity when same-name mentions coexist', async removed => {
    const namesakes = [
      { ...detail().members[0]!, botId: 'picked', name: 'Ann' },
      { ...detail().members[1]!, botId: 'other', name: 'Ann' },
    ];
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ members: namesakes }) });
    mocks.sendBotGroupMessage.mockResolvedValue({ ok: false, errorCode: 'MENTION_UNAVAILABLE' });
    renderView();
    const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '  @', selectionStart: 3 } });
    fireEvent.click((await screen.findAllByRole('option'))[1]!);
    fireEvent.change(input, { target: { value: '  @Ann @Ann', selectionStart: 11 } });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ members: namesakes.slice(1) }) });
    act(() => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
    input.setSelectionRange(removed === 'picked' ? 2 : 6, removed === 'picked' ? 7 : 11);
    fireEvent.select(input);
    fireEvent.change(input, { target: { value: '  @Ann', selectionStart: removed === 'picked' ? 2 : 6 } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
    expect(mocks.sendBotGroupMessage.mock.calls[0]![0].mentions).toEqual({ all: false, botIds: [removed === 'picked' ? 'other' : 'picked'] });
  });

  describe('while the timeline loads', () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((done) => { resolve = done; });
      return { promise, resolve };
    }
    /** The sidebar list as main reports it; the view only borrows the row for its header. */
    async function listGroups(groups: BotGroupDetail[]) {
      resetBotGroupStoreForTests();
      window.electronAPI.maker.listBotGroups = vi.fn(async () => ({ ok: true as const, groups }));
      refreshBotGroups();
      await waitFor(() => expect(getBotGroupListSnapshot().loaded).toBe(true));
    }
    afterEach(() => resetBotGroupStoreForTests());

    it('shows the listed header at once and a progress indicator only for a slow read', async () => {
      await listGroups([detail({ messages: [] })]);
      const read = deferred<{ ok: true; group: BotGroupDetail }>();
      mocks.getBotGroup.mockReturnValue(read.promise);
      renderView();
      const header = screen.getByTestId('content-header');
      expect(header.textContent).toContain('周末出游');
      expect(within(header).getByTestId('bot-group-header-summary').textContent).toBe('bots.groupChat.memberCount:2');
      expect(screen.queryByTestId('bot-group-timeline-loading')).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(await screen.findByRole('status', { name: 'ccAgent.common.loading' })).toBeTruthy();
      await act(async () => read.resolve({ ok: true, group: detail() }));
      expect(await screen.findByText('周六 8:10 有票')).toBeTruthy();
      expect(screen.queryByTestId('bot-group-timeline-loading')).toBeNull();
      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    it('never shows a fast read’s progress indicator', async () => {
      await listGroups([detail()]);
      renderView();
      expect(await screen.findByText('周六 8:10 有票')).toBeTruthy();
      await new Promise((done) => setTimeout(done, 250));
      expect(screen.queryByTestId('bot-group-timeline-loading')).toBeNull();
    });

    it('keeps a quickly left group’s late timeline and header out of the next group', async () => {
      await listGroups([detail(), detail({ id: 'g2', name: '读书会', members: [{ botId: 'ajie', name: '阿杰', avatar: '', avatarColor: 'green', status: 'active' }] })]);
      const first = deferred<{ ok: true; group: BotGroupDetail }>();
      const second = deferred<{ ok: true; group: BotGroupDetail }>();
      mocks.getBotGroup.mockImplementation((id: string) => (id === 'g1' ? first.promise : second.promise));
      const view = renderView();
      expect(screen.getByTestId('content-header').textContent).toContain('周末出游');
      mocks.groupId = 'g2';
      view.rerender(
        <Tooltip.Provider>
        <FeatureSidebarSlotProvider isCollapsed={false}>
          <HeaderSlot />
          <BotGroupChatView />
        </FeatureSidebarSlotProvider>
        </Tooltip.Provider>,
      );
      const header = screen.getByTestId('content-header');
      expect(header.textContent).toContain('读书会');
      expect(header.textContent).not.toContain('周末出游');
      await act(async () => first.resolve({ ok: true, group: detail() }));
      expect(screen.queryByText('周六 8:10 有票')).toBeNull();
      expect(header.textContent).not.toContain('周末出游');
      await act(async () => second.resolve({ ok: true, group: detail({ id: 'g2', name: '读书会', messages: [msg({ id: 'r1', content: '这周读哪本' })] }) }));
      expect(await screen.findByText('这周读哪本')).toBeTruthy();
      expect(screen.queryByText('周六 8:10 有票')).toBeNull();
    });

    it('opens the route-owned settings from the loading header without re-reading the timeline', async () => {
      await listGroups([detail()]);
      mocks.getBotGroup.mockReturnValue(new Promise(() => {}));
      renderView();
      fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.settings.open' }));
      expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/g1?groupSettings=1');
      expect(mocks.getBotGroup).toHaveBeenCalledTimes(1);
    });

    it('shows only the second visit’s read after A → B → A', async () => {
      await listGroups([detail(), detail({ id: 'g2', name: '读书会' })]);
      const reads: Array<{ id: string; resolve: (value: { ok: true; group: BotGroupDetail }) => void }> = [];
      mocks.getBotGroup.mockImplementation((id: string) => new Promise((resolve) => { reads.push({ id, resolve }); }));
      const view = renderView();
      const rerender = (id: string) => {
        mocks.groupId = id;
        view.rerender(
          <Tooltip.Provider>
          <FeatureSidebarSlotProvider isCollapsed={false}>
            <HeaderSlot />
            <BotGroupChatView />
          </FeatureSidebarSlotProvider>
          </Tooltip.Provider>,
        );
      };
      rerender('g2');
      rerender('g1');
      expect(reads.map((read) => read.id)).toEqual(['g1', 'g2', 'g1']);
      await act(async () => reads[0]!.resolve({ ok: true, group: detail({ messages: [msg({ id: 'old', content: '第一次打开的旧回包' })] }) }));
      await act(async () => reads[1]!.resolve({ ok: true, group: detail({ id: 'g2', name: '读书会', messages: [msg({ id: 'b', content: '读书会的回包' })] }) }));
      expect(screen.queryByText('第一次打开的旧回包')).toBeNull();
      expect(screen.queryByText('读书会的回包')).toBeNull();
      expect(screen.getByTestId('content-header').textContent).toContain('周末出游');
      await act(async () => reads[2]!.resolve({ ok: true, group: detail() }));
      expect(await screen.findByText('周六 8:10 有票')).toBeTruthy();
    });

    it('keeps the header with a retry when the first read fails', async () => {
      await listGroups([detail()]);
      mocks.getBotGroup.mockResolvedValueOnce({ ok: false, errorCode: 'REQUEST_TIMEOUT', message: '' });
      vi.useFakeTimers();
      try {
        await act(async () => { renderView(); });
        expect(screen.getByText('bots.groupChat.loadFailedTitle')).toBeTruthy();
        expect(screen.getByTestId('content-header').textContent).toContain('周末出游');
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(mocks.getBotGroup).toHaveBeenCalledTimes(1);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /bots.retry/ })); });
        expect(screen.getByText('周六 8:10 有票')).toBeTruthy();
      } finally { cleanup(); vi.useRealTimers(); }
    });

    it('shows no header for a group that is no longer listed, then the unavailable state', async () => {
      await listGroups([]);
      mocks.getBotGroup.mockResolvedValue({ ok: false, errorCode: 'NOT_FOUND', message: '' });
      renderView();
      expect(screen.getByTestId('content-header').textContent).toBe('');
      expect(await screen.findByText('bots.groupChat.unavailableTitle')).toBeTruthy();
      expect(screen.getByTestId('content-header').textContent).toBe('');
    });
  });

  it('refreshes on a push for this group and shows the unavailable state after delete', async () => {
    renderView();
    await screen.findByText('周六 8:10 有票');
    act(() => mocks.pushes.forEach((push) => push({ groupId: 'other', change: 'messages' })));
    expect(mocks.getBotGroup).toHaveBeenCalledTimes(1);
    act(() => mocks.pushes.forEach((push) => push({ groupId: 'g1', change: 'messages' })));
    await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
    act(() => mocks.pushes.forEach((push) => push({ groupId: 'g1', change: 'deleted' })));
    expect(await screen.findByText('bots.groupChat.unavailableTitle')).toBeTruthy();
  });

  describe('failed timeline read recovery', () => {
    afterEach(() => {
      cleanup();
      vi.useRealTimers();
      mocks.ownerGeneration = { dataOwnerId: 'account-a', generation: 1 };
    });

    // The completion push is already consumed: no later event can rescue the stale page.
    // Exercise the real timeline component, including its single-flight read queue.
    it.each(['response', 'exception'] as const)('recovers completed work without another push after a failed %s', async (failure) => {
      const running = plan({ status: 'running', currentStep: 0,
        steps: [{ ...plan().steps[0]!, status: 'running' }, plan().steps[1]!] });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(running) });
      renderView();
      await screen.findByText('bots.groupChat.header.stepRunning:咪咪');
      vi.useFakeTimers();
      if (failure === 'response') mocks.getBotGroup.mockResolvedValueOnce({ ok: false, errorCode: 'REQUEST_TIMEOUT', message: '' });
      else mocks.getBotGroup.mockRejectedValueOnce(new Error('read failed'));
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(plan({ status: 'done' }),
        [msg({ id: 'result', sequence: 11, content: '分工结果已就绪' })]) });
      await act(async () => { mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'plan' })); });
      expect(screen.getByText('bots.groupChat.header.stepRunning:咪咪')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(screen.getByText('分工结果已就绪')).toBeTruthy();
      expect(screen.queryByText('bots.groupChat.header.stepRunning:咪咪')).toBeNull();
      const reads = mocks.getBotGroup.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(mocks.getBotGroup).toHaveBeenCalledTimes(reads);
    });

    it('keeps recovery reads serialized and lets a newer push cancel the pending retry', async () => {
      renderView();
      await screen.findByText('周六 8:10 有票');
      vi.useFakeTimers();
      mocks.getBotGroup.mockResolvedValue({ ok: false, errorCode: 'REQUEST_TIMEOUT', message: '' });
      await act(async () => { mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })); });
      let finish!: (value: { ok: true; group: BotGroupDetail }) => void;
      mocks.getBotGroup.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(mocks.getBotGroup).toHaveBeenCalledTimes(3);
      await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
      expect(mocks.getBotGroup).toHaveBeenCalledTimes(3);
      await act(async () => { finish({ ok: true, group: detail() }); });
      mocks.getBotGroup.mockResolvedValueOnce({ ok: false, errorCode: 'SERVICE_ERROR', message: '' });
      await act(async () => { mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })); });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [msg({ content: '推送已恢复' })] }) });
      await act(async () => { mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })); });
      expect(screen.getByText('推送已恢复')).toBeTruthy();
      const reads = mocks.getBotGroup.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(mocks.getBotGroup).toHaveBeenCalledTimes(reads);
    });

    it('recovers a failed queued refresh before the initial snapshot has rendered', async () => {
      let first!: (value: { ok: true; group: BotGroupDetail }) => void;
      mocks.getBotGroup.mockImplementationOnce(() => new Promise(resolve => { first = resolve; }));
      mocks.getBotGroup.mockResolvedValueOnce({ ok: false, errorCode: 'REQUEST_TIMEOUT', message: '' });
      renderView();
      vi.useFakeTimers();
      await act(async () => {
        mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'plan' }));
        first({ ok: true, group: detail() });
      });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [msg({ content: '排队读取已恢复' })] }) });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(screen.getByText('排队读取已恢复')).toBeTruthy();
    });

    it.each(['unmount', 'delete', 'owner', 'not-found'] as const)('stops pending recovery after %s', async (boundary) => {
      const view = renderView();
      await screen.findByText('周六 8:10 有票');
      vi.useFakeTimers();
      mocks.getBotGroup.mockResolvedValue({ ok: false, errorCode: 'REQUEST_TIMEOUT', message: '' });
      await act(async () => { mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })); });
      if (boundary === 'unmount') view.unmount();
      else if (boundary === 'delete') act(() => { mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'deleted' })); });
      else if (boundary === 'owner') mocks.ownerGeneration = { dataOwnerId: 'account-b', generation: 2 };
      else {
        mocks.getBotGroup.mockResolvedValue({ ok: false, errorCode: 'NOT_FOUND', message: '' });
        await act(async () => { mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })); });
        expect(screen.getByText('bots.groupChat.unavailableTitle')).toBeTruthy();
      }
      const reads = mocks.getBotGroup.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(mocks.getBotGroup).toHaveBeenCalledTimes(reads);
    });
  });

  describe('乐观显示', () => {
    /** A send main has not answered yet; the test decides when and how. */
    function pendingSend() {
      let resolve!: (result: unknown) => void;
      const promise = new Promise((res) => {
        resolve = res;
      });
      mocks.sendBotGroupMessage.mockImplementationOnce(() => promise);
      return { resolve: (result: unknown) => act(async () => { resolve(result); await promise; }) };
    }
    const outboxItems = () => screen.queryAllByTestId('bot-group-outbox');
    const withSelf = (id: string, sequence: number, content: string) =>
      detail({ messages: [...detail().messages, msg({ id, sequence, content })] });
    const pushMessages = (groupId = 'g1') =>
      act(() => mocks.pushes.forEach((push) => push({ groupId, change: 'messages' })));

    it('shows and settles the message when an older local route opens a migrated group', async () => {
      // The route still carries the local id; main answers with the group's server room id.
      const send = pendingSend();
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ id: 'room-1' }) });
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '迁移后的群' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(outboxItems()).toHaveLength(1);
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
      expect((mocks.sendBotGroupMessage.mock.calls[0]![0] as { groupId: string }).groupId).toBe('room-1');

      mocks.getBotGroup.mockResolvedValue({
        ok: true,
        group: detail({ id: 'room-1', messages: [...detail().messages, msg({ id: 'u2', sequence: 5, content: '迁移后的群' })] }),
      });
      await send.resolve({ ok: true, messageId: 'u2' });
      await waitFor(() => expect(getBotGroupOutbox('room-1')).toHaveLength(0));
      expect(screen.getAllByText('迁移后的群')).toHaveLength(1);
    });

    it('shows the message as soon as it is sent and swaps in the real one without a duplicate', async () => {
      const send = pendingSend();
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '@咪咪 慢一点', selectionStart: 7 } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(input.value).toBe('');
      expect(outboxItems()).toHaveLength(1);
      expect(outboxItems()[0]!.textContent).toContain('慢一点');
      // Pending and confirmed messages use the same Markdown/highlight renderer.
      const bubble = within(outboxItems()[0]!).getByText('@咪咪 慢一点');
      const row = bubble.closest('[data-bot-group-message-id]');
      expect(bubble).toBeTruthy();
      expect(within(outboxItems()[0]!).queryByRole('status')).toBeNull();
      expect(await screen.findByText('bots.groupChat.outbox.sending', {}, { timeout: 2000 })).toBeTruthy();
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));

      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withSelf('u2', 5, '@咪咪 慢一点') });
      await send.resolve({ ok: true, messageId: 'u2' });
      pushMessages();
      await waitFor(() => expect(outboxItems()).toHaveLength(0));
      expect(screen.getAllByText('@咪咪 慢一点')).toHaveLength(1);
      expect(screen.getByText('@咪咪 慢一点').closest('[data-bot-group-message-id]')).toBe(row);
      expect(screen.queryByText('bots.groupChat.outbox.sending')).toBeNull();
    });

    it('does not show the message twice when a push re-read lands before the receipt', async () => {
      const send = pendingSend();
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '早到的推送' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));

      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withSelf('u2', 5, '早到的推送') });
      pushMessages();
      await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(outboxItems()).toHaveLength(0));
      expect(screen.getAllByText('早到的推送')).toHaveLength(1);

      // The receipt settles against the timeline already on screen, with no further push.
      await send.resolve({ ok: true, messageId: 'u2' });
      await waitFor(() => expect(getBotGroupOutbox('g1')).toHaveLength(0));
      pushMessages();
      await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(3));
      expect(screen.getAllByText('早到的推送')).toHaveLength(1);
      expect(outboxItems()).toHaveLength(0);
    });

    it('keeps a failed message where it was sent, above messages that came after it', async () => {
      const first = pendingSend();
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '先发的' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
      fireEvent.change(input, { target: { value: '后发的' } });
      await first.resolve({ ok: false, errorCode: 'SERVICE_ERROR', message: '' });
      expect(outboxItems()[0]!.getAttribute('data-status')).toBe('failed');

      mocks.sendBotGroupMessage.mockResolvedValueOnce({ ok: true, messageId: 'u2' });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withSelf('u2', 5, '后发的') });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(screen.getAllByText('后发的')).toHaveLength(1));
      await waitFor(() => expect(outboxItems()).toHaveLength(1));
      const order = [...document.querySelectorAll('article')]
        .map((article) => article.textContent ?? '')
        .filter((text) => text.includes('先发的') || text.includes('后发的'))
        .map((text) => (text.includes('先发的') ? '先发的' : '后发的'));
      expect(order).toEqual(['先发的', '后发的']);
    });

    it('keeps a later failed message below an earlier one that went out', async () => {
      const first = pendingSend();
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '先发的' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
      fireEvent.change(input, { target: { value: '后发的' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      // New text in the input keeps the failed message on the timeline.
      fireEvent.change(input, { target: { value: '还在写' } });

      mocks.sendBotGroupMessage.mockResolvedValueOnce({ ok: false, errorCode: 'SERVICE_ERROR', message: '' });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withSelf('u2', 5, '先发的') });
      await first.resolve({ ok: true, messageId: 'u2' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getAllByText('先发的')).toHaveLength(1));
      await waitFor(() => expect(outboxItems().map((item) => item.getAttribute('data-status'))).toEqual(['failed']));
      const order = [...document.querySelectorAll('article')]
        .map((article) => article.textContent ?? '')
        .filter((text) => text.includes('先发的') || text.includes('后发的'))
        .map((text) => (text.includes('先发的') ? '先发的' : '后发的'));
      expect(order).toEqual(['先发的', '后发的']);
    });

    it('takes the next message while the first is still out, and sends them in order', async () => {
      const first = pendingSend();
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '同一句' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.change(input, { target: { value: '同一句' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(outboxItems().map((item) => item.textContent)).toEqual(['同一句', '同一句']);
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
      mocks.sendBotGroupMessage.mockResolvedValueOnce({ ok: true, messageId: 'u3' });
      await first.resolve({ ok: true, messageId: 'u2' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(2));
      const [firstSend, secondSend] = mocks.sendBotGroupMessage.mock.calls.map(([call]) => call as Record<string, unknown>);
      // Same text, two messages: each keeps its own identity.
      expect(firstSend!.clientId).not.toBe(secondSend!.clientId);

      mocks.getBotGroup.mockResolvedValue({
        ok: true,
        group: detail({ messages: [...detail().messages, msg({ id: 'u2', sequence: 5, content: '同一句' }), msg({ id: 'u3', sequence: 6, content: '同一句' })] }),
      });
      pushMessages();
      await waitFor(() => expect(outboxItems()).toHaveLength(0));
      expect(screen.getAllByText('同一句')).toHaveLength(2);
    });

    it('keeps a failed message in place while new text is in the input; 重试 reuses its clientId and 编辑 waits for an empty input', async () => {
      const send = pendingSend();
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '第一条' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
      fireEvent.change(input, { target: { value: '正在写的' } });
      await send.resolve({ ok: false, errorCode: 'INTERNAL', message: '' });

      expect(mocks.toastError).toHaveBeenCalledWith('bots.groupChat.composer.sendFailed');
      expect(input.value).toBe('正在写的');
      const failed = await screen.findByTestId('bot-group-outbox');
      expect(failed.getAttribute('data-status')).toBe('failed');
      expect(within(failed).getByText('bots.groupChat.outbox.failed')).toBeTruthy();
      // Nothing goes out again on its own.
      expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1);

      fireEvent.click(within(failed).getByRole('button', { name: 'bots.groupChat.outbox.edit' }));
      expect(mocks.toastWarning).toHaveBeenCalledWith('bots.groupChat.outbox.editBlocked');
      expect(input.value).toBe('正在写的');

      mocks.sendBotGroupMessage.mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' });
      fireEvent.click(within(failed).getByRole('button', { name: /bots\.retry/ }));
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(2));
      const [firstAttempt, retry] = mocks.sendBotGroupMessage.mock.calls.map(([call]) => call as Record<string, unknown>);
      expect(retry!.clientId).toBe(firstAttempt!.clientId);
      await waitFor(() => expect(screen.getByTestId('bot-group-outbox').getAttribute('data-status')).toBe('failed'));

      fireEvent.change(input, { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.outbox.edit' }));
      expect(input.value).toBe('第一条');
      expect(outboxItems()).toHaveLength(0);
      mocks.sendBotGroupMessage.mockResolvedValueOnce({ ok: true, messageId: 'u2' });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(3));
      expect(lastSend().clientId).toBe(firstAttempt!.clientId);
    });

    it.each([
      { archived: true, dissolvedAt: undefined },
      { archived: false, dissolvedAt: '2026-10-15T00:00:00.000Z' },
    ])('keeps terminal outbox messages readable without retry or edit: %j', async (terminal) => {
      const send = pendingSend();
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '待重试的消息' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
      fireEvent.change(input, { target: { value: '保留的草稿' } });
      await send.resolve({ ok: false, errorCode: 'INTERNAL', message: '' });
      const failed = await screen.findByTestId('bot-group-outbox');

      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true, ...terminal }) });
      pushMessages();
      await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
      expect(within(failed).getByText('待重试的消息')).toBeTruthy();
      const edit = within(failed).getByRole('button', { name: 'bots.groupChat.outbox.edit' }) as HTMLButtonElement;
      const retry = within(failed).getByRole('button', { name: /bots\.retry/ }) as HTMLButtonElement;
      expect(edit.disabled).toBe(true);
      expect(retry.disabled).toBe(true);
      fireEvent.click(edit);
      fireEvent.click(retry);
      expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1);
      expect(getBotGroupOutbox('g1')).toHaveLength(1);
    });

    it('keeps the local image on screen while the server copy of a confirmed message is still loading', async () => {
      const send = pendingSend();
      renderView();
      await screen.findByRole('textbox');
      pickFiles([diskFile('photo.png', 'image/png')]);
      await screen.findByAltText('photo.png');
      fireEvent.click(screen.getByRole('button', { name: 'bots.send' }));
      // Out of the tray and into the pending bubble at once.
      expect(within(outboxItems()[0]!).getByAltText('photo.png')).toBeTruthy();
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));

      const image = { id: 's1', name: 'photo.png', category: 'image' as const, mimeType: 'image/png', size: 7 };
      mocks.getBotGroup.mockResolvedValue({
        ok: true,
        group: detail({ messages: [...detail().messages, msg({ id: 'u2', sequence: 5, attachments: [{ ...image, url: null, path: null }] })] }),
      });
      await send.resolve({ ok: true, messageId: 'u2' });
      pushMessages();
      await waitFor(() => expect(outboxItems()).toHaveLength(0));
      expect(screen.getAllByAltText('photo.png')).toHaveLength(1);
      expect(screen.getByAltText('photo.png').getAttribute('src')).toContain('photo.png');

      mocks.getBotGroup.mockResolvedValue({
        ok: true,
        group: detail({ messages: [...detail().messages, msg({ id: 'u2', sequence: 5, attachments: [{ ...image, url: 'cindy-media://blobs/server.png', path: null }] })] }),
      });
      pushMessages();
      await waitFor(() => expect(screen.getByAltText('photo.png').getAttribute('src')).toContain('server.png'));
      expect(screen.getAllByAltText('photo.png')).toHaveLength(1);
    });

    it('puts a message that failed while the group was closed back into its empty composer on return', async () => {
      const send = pendingSend();
      const view = renderView();
      const tree = () => (
        <Tooltip.Provider>
          <FeatureSidebarSlotProvider isCollapsed={false}>
            <HeaderSlot />
            <BotGroupChatView />
          </FeatureSidebarSlotProvider>
        </Tooltip.Provider>
      );
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '离开时失败的' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
      mocks.groupId = 'g2';
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ id: 'g2', name: '另一个群' }) });
      view.rerender(tree());
      await screen.findByText('另一个群');
      await send.resolve({ ok: false, errorCode: 'INTERNAL', message: '' });
      // Nothing of g1 shows here, and g2's composer is not touched.
      expect(outboxItems()).toHaveLength(0);
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');

      mocks.groupId = 'g1';
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail() });
      view.rerender(tree());
      await screen.findByText('周六 8:10 有票');
      await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('离开时失败的'));
      expect(outboxItems()).toHaveLength(0);
      expect(mocks.toastError).toHaveBeenCalledWith('bots.groupChat.composer.sendFailed');
      // Sending it again is the same attempt.
      mocks.sendBotGroupMessage.mockResolvedValueOnce({ ok: true, messageId: 'u2' });
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(2));
      expect(mocks.sendBotGroupMessage.mock.calls[1]![0].clientId).toBe(mocks.sendBotGroupMessage.mock.calls[0]![0].clientId);
    });

    it('settles the local preview of a message pushed off the latest page once an older page shows it', async () => {
      const send = pendingSend();
      renderView();
      await screen.findByRole('textbox');
      pickFiles([diskFile('photo.png', 'image/png')]);
      await screen.findByAltText('photo.png');
      fireEvent.click(screen.getByRole('button', { name: 'bots.send' }));
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
      // The receipt comes back; the next read's latest page no longer holds the message.
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ hasMoreBefore: true }) });
      await send.resolve({ ok: true, messageId: 'u-old' });
      pushMessages();
      await waitFor(() => expect(getBotGroupOutbox('g1')).toEqual([]));
      expect(getBotGroupOutboxPreviews('g1').size).toBe(1);

      const image = { id: 's1', name: 'photo.png', category: 'image' as const, mimeType: 'image/png', size: 7, url: 'cindy-media://blobs/server.png', path: null };
      mocks.getBotGroup.mockResolvedValueOnce({
        ok: true,
        group: detail({ messages: [msg({ id: 'u-old', sequence: 0, attachments: [image] })], hasMoreBefore: false }),
      });
      fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
      await waitFor(() => expect(getBotGroupOutboxPreviews('g1').size).toBe(0));
    });

    it('drops the outbox of a group that reads as gone', async () => {
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      mocks.sendBotGroupMessage.mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' });
      fireEvent.change(input, { target: { value: '没发出去' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.change(input, { target: { value: '正在写' } });
      await waitFor(() => expect(getBotGroupOutbox('g1').map((entry) => entry.status)).toEqual(['failed']));
      mocks.getBotGroup.mockResolvedValue({ ok: false, errorCode: 'NOT_FOUND', message: '' });
      pushMessages();
      expect(await screen.findByText('bots.groupChat.unavailableTitle')).toBeTruthy();
      expect(getBotGroupOutbox('g1')).toEqual([]);
    });

    it('keeps a late receipt out of the next group and shows the message when coming back', async () => {
      const send = pendingSend();
      const view = renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '离开前发的' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));

      mocks.groupId = 'g2';
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ id: 'g2', name: '另一个群' }) });
      view.rerender(
        <Tooltip.Provider>
          <FeatureSidebarSlotProvider isCollapsed={false}>
            <HeaderSlot />
            <BotGroupChatView />
          </FeatureSidebarSlotProvider>
        </Tooltip.Provider>,
      );
      await screen.findByText('另一个群');
      await send.resolve({ ok: true, messageId: 'u2' });
      expect(outboxItems()).toHaveLength(0);
      expect(screen.queryByText('离开前发的')).toBeNull();

      mocks.groupId = 'g1';
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withSelf('u2', 5, '离开前发的') });
      view.rerender(
        <Tooltip.Provider>
          <FeatureSidebarSlotProvider isCollapsed={false}>
            <HeaderSlot />
            <BotGroupChatView />
          </FeatureSidebarSlotProvider>
        </Tooltip.Provider>,
      );
      await waitFor(() => expect(screen.getAllByText('离开前发的')).toHaveLength(1));
      expect(outboxItems()).toHaveLength(0);
    });
  });

  describe('引用回复', () => {
    const quoteOf = (messageId: string, overrides: Partial<NonNullable<BotGroupMessageView['quote']>> = {}) => ({
      messageId, authorName: '小满', authorKind: 'bot' as const, excerpt: '周六 8:10 有票', attachmentCount: 0, attachmentName: null, sequence: 2, ...overrides,
    });
    const quoteButton = async (id = 'b1') => {
      await screen.findAllByText('周六 8:10 有票');
      const row = document.querySelector(`[data-bot-group-message-id="${id}"]`) as HTMLElement;
      return within(row).getByRole('button', { name: 'bots.groupChat.server.quoteReply' });
    };
    beforeEach(() => {
      vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('quotes into the composer without opening a 话题, and removing it keeps the text', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(await quoteButton());
      const preview = screen.getByTestId('bot-group-quote-preview');
      expect(preview.textContent).toContain('bots.groupChat.quote.replyingTo:小满');
      expect(preview.textContent).toContain('周六 8:10 有票');
      expect(screen.queryByRole('complementary')).toBeNull();
      const composer = screen.getByRole('textbox', { name: 'bots.groupChat.composer.label' });
      expect(document.activeElement).toBe(composer);
      await user.type(composer, '那就这班');
      await user.click(within(preview).getByRole('button', { name: 'bots.groupChat.quote.remove' }));
      expect(screen.queryByTestId('bot-group-quote-preview')).toBeNull();
      expect((composer as HTMLTextAreaElement).value).toBe('那就这班');
      expect(document.activeElement).toBe(composer);
    });

    it('Esc takes the quote off before anything else and keeps the draft', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(await quoteButton());
      await user.keyboard('草稿{Escape}');
      expect(screen.queryByTestId('bot-group-quote-preview')).toBeNull();
      expect((screen.getByRole('textbox', { name: 'bots.groupChat.composer.label' }) as HTMLTextAreaElement).value).toBe('草稿');
    });

    it('sends only the quoted id in the current timeline, with a new idempotency key per quote', async () => {
      const user = userEvent.setup();
      mocks.sendBotGroupMessage.mockResolvedValueOnce({ ok: false, errorCode: 'SERVICE_ERROR' }).mockResolvedValue({ ok: true, messageId: 'u2' });
      renderView();
      await user.click(await quoteButton());
      await user.keyboard('就这班{Enter}');
      expect(lastSend()).toMatchObject({ groupId: 'g1', text: '就这班', quote: { messageId: 'b1' }, mentions: { all: false, botIds: [] } });
      // A failed send puts the quote back with the text; the retry reuses the attempt.
      await waitFor(() => expect(screen.getByTestId('bot-group-quote-preview')).toBeTruthy());
      const failedId = lastSend().clientId;
      await user.keyboard('{Enter}');
      expect(lastSend()).toMatchObject({ clientId: failedId, quote: { messageId: 'b1' } });
      await waitFor(() => expect(screen.queryByTestId('bot-group-quote-preview')).toBeNull());
      // The same words quoting another message are a different send.
      await user.click(await quoteButton('u1'));
      await user.keyboard('就这班{Enter}');
      expect(lastSend()).toMatchObject({ quote: { messageId: 'u1' } });
      expect(lastSend().clientId).not.toBe(failedId);
    });

    it('never attaches a failed send\'s quote to text typed while it was on its way', async () => {
      const user = userEvent.setup();
      let fail!: () => void;
      mocks.sendBotGroupMessage.mockImplementation(() => new Promise((resolve) => {
        fail = () => resolve({ ok: false, errorCode: 'SERVICE_ERROR' });
      }));
      renderView();
      await user.click(await quoteButton());
      await user.keyboard('就这班{Enter}');
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledOnce());
      const composer = screen.getByRole('textbox', { name: 'bots.groupChat.composer.label' }) as HTMLTextAreaElement;
      await user.type(composer, '另一件事');
      await act(async () => fail());
      expect(composer.value).toBe('另一件事');
      expect(screen.queryByTestId('bot-group-quote-preview')).toBeNull();
    });

    it('shows the quote on the message while it is still on its way', async () => {
      const user = userEvent.setup();
      mocks.sendBotGroupMessage.mockImplementation(() => new Promise(() => undefined));
      renderView();
      await user.click(await quoteButton());
      await user.keyboard('就这班{Enter}');
      const pending = await screen.findByTestId('bot-group-outbox');
      expect(within(pending).getByTestId('bot-group-quote').textContent).toContain('周六 8:10 有票');
      expect(pending.textContent).toContain('就这班');
      expect(screen.queryByTestId('bot-group-quote-preview')).toBeNull();
    });

    it('puts the text back without an unavailable quote', async () => {
      const user = userEvent.setup();
      mocks.sendBotGroupMessage.mockResolvedValue({ ok: false, errorCode: 'QUOTE_UNAVAILABLE' });
      renderView();
      await user.click(await quoteButton());
      await user.keyboard('就这班{Enter}');
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('bots.groupChat.errors.quoteUnavailable'));
      expect((screen.getByRole('textbox', { name: 'bots.groupChat.composer.label' }) as HTMLTextAreaElement).value).toBe('就这班');
      expect(screen.queryByTestId('bot-group-quote-preview')).toBeNull();
    });

    it('keeps a message whose original became unavailable for 编辑 only, never 重试', async () => {
      const user = userEvent.setup();
      let refuse!: () => void;
      mocks.sendBotGroupMessage.mockImplementation(() => new Promise((resolve) => {
        refuse = () => resolve({ ok: false, errorCode: 'QUOTE_UNAVAILABLE' });
      }));
      renderView();
      await user.click(await quoteButton());
      await user.keyboard('就这班{Enter}');
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledOnce());
      await user.type(screen.getByRole('textbox', { name: 'bots.groupChat.composer.label' }), '另一件事');
      await act(async () => refuse());
      const failed = await screen.findByTestId('bot-group-outbox');
      await waitFor(() => expect(failed.getAttribute('data-status')).toBe('failed'));
      expect(within(failed).getByRole('button', { name: 'bots.groupChat.outbox.edit' })).toBeTruthy();
      expect(within(failed).queryByRole('button', { name: /bots\.retry/ })).toBeNull();
    });

    it('offers no 引用回复 on a local group, a notice or a round divider', async () => {
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail() });
      renderView();
      await screen.findByText('周六 8:10 有票');
      expect(screen.queryAllByRole('button', { name: 'bots.groupChat.server.quoteReply' })).toHaveLength(0);
      cleanup();
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
      renderView();
      await screen.findByText('周六 8:10 有票');
      // Only the two chat messages; the notice and the divider have no toolbar.
      expect(screen.getAllByRole('button', { name: 'bots.groupChat.server.quoteReply' })).toHaveLength(2);
    });

    it('jumps to and highlights a loaded original', async () => {
      const user = userEvent.setup();
      const base = detail({ serverBacked: true });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: { ...base, messages: [...base.messages,
        msg({ id: 'q1', sequence: 5, content: '那就这班', quote: quoteOf('b1', { excerpt: 'snapshot text' }) })] } });
      renderView();
      const block = await screen.findByRole('button', { name: 'bots.groupChat.quote.jumpLabel:小满' });
      // The loaded original wins over the stored snapshot.
      expect(block.textContent).toContain('周六 8:10 有票');
      expect(block.textContent).not.toContain('snapshot text');
      await user.click(block);
      const target = document.querySelector('[data-bot-group-message-id="b1"]') as HTMLElement;
      await waitFor(() => expect(target.className).toContain('search-match-bg'));
      expect(document.activeElement).toBe(target);
      expect(screen.queryByRole('complementary')).toBeNull();
    });

    it('shows a deleted original without its snapshot and never jumps', async () => {
      const base = detail({ serverBacked: true });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: { ...base, messages: [
        msg({ id: 'b1', sequence: 2, authorKind: 'bot', authorBotId: 'xiaoman', authorName: '小满', deleted: true, content: '（消息已删除）' }),
        msg({ id: 'q1', sequence: 5, content: '那就这班', quote: quoteOf('b1', { excerpt: '私密的原文' }) })] } });
      renderView();
      const block = await screen.findByTestId('bot-group-quote');
      expect(block.getAttribute('data-quote-state')).toBe('deleted');
      expect(block.tagName).toBe('DIV');
      expect(block.textContent).toContain('bots.groupChat.quote.deleted');
      expect(document.body.textContent).not.toContain('私密的原文');
    });

    it('pages back to an original that is not loaded yet', async () => {
      const user = userEvent.setup();
      const base = detail({ serverBacked: true, hasMoreBefore: true });
      mocks.getBotGroup.mockImplementation(async (_id: string, options?: { beforeSequence?: number }) => options?.beforeSequence
        ? { ok: true, group: { ...base, hasMoreBefore: false, messages: [msg({ id: 'old1', sequence: 1, authorKind: 'bot', authorBotId: 'xiaoman', authorName: '小满', content: '很早的原文' })] } }
        : { ok: true, group: { ...base, messages: [msg({ id: 'q1', sequence: 50, content: '那就这班', quote: quoteOf('old1', { excerpt: '很早的原文', sequence: 1 }) })] } });
      renderView();
      await user.click(await screen.findByRole('button', { name: 'bots.groupChat.quote.jumpLabel:小满' }));
      await waitFor(() => expect((document.querySelector('[data-bot-group-message-id="old1"]') as HTMLElement | null)?.className).toContain('search-match-bg'));
      expect(mocks.getBotGroup).toHaveBeenCalledWith('g1', expect.objectContaining({ beforeSequence: 50 }));
    });

    it('re-reads an original on an older page before jumping, and stops when it was deleted meanwhile', async () => {
      const user = userEvent.setup();
      const base = detail({ serverBacked: true, hasMoreBefore: true });
      const original = msg({ id: 'old1', sequence: 1, authorKind: 'bot', authorBotId: 'xiaoman', authorName: '小满', content: '很早的原文' });
      let deleted = false;
      mocks.getBotGroup.mockImplementation(async (_id: string, options?: { beforeSequence?: number }) => options?.beforeSequence
        ? { ok: true, group: { ...base, hasMoreBefore: false, messages: [deleted ? { ...original, deleted: true, content: '（消息已删除）' } : original] } }
        : { ok: true, group: { ...base, messages: [msg({ id: 'q1', sequence: 50, content: '那就这班', quote: quoteOf('old1', { excerpt: '很早的原文', sequence: 1 }) })] } });
      renderView();
      await user.click(await screen.findByRole('button', { name: 'bots.groupChat.quote.jumpLabel:小满' }));
      await waitFor(() => expect((document.querySelector('[data-bot-group-message-id="old1"]') as HTMLElement | null)?.className).toContain('search-match-bg'));
      // Deleted on another client after it was paged in: the push re-read leaves older pages as they were.
      deleted = true;
      await user.click(screen.getByRole('button', { name: 'bots.groupChat.quote.jumpLabel:小满' }));
      await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledWith('bots.groupChat.quote.deleted'));
      expect(mocks.getBotGroup).toHaveBeenLastCalledWith('g1', expect.objectContaining({ beforeSequence: 2 }));
      expect(screen.getByTestId('bot-group-quote').getAttribute('data-quote-state')).toBe('deleted');
      expect(document.body.textContent).not.toContain('很早的原文');
    });

    it('re-reads the opened older page after reacting to a message on it', async () => {
      const user = userEvent.setup();
      const older = msg({ id: 'old1', sequence: 1, authorKind: 'bot', authorBotId: 'xiaoman', authorName: '小满', content: '很早的消息',
        reactions: [{ emoji: '👍', count: 1, me: false }] });
      const latest = msg({ id: 'new1', sequence: 50, content: '最近的消息' });
      let server = [older];
      const base = detail({ serverBacked: true, hasMoreBefore: true });
      mocks.getBotGroup.mockImplementation(async (_id: string, options?: { beforeSequence?: number }) => options?.beforeSequence
        ? { ok: true, group: { ...base, hasMoreBefore: false, messages: server } }
        : { ok: true, group: { ...base, messages: [latest] } });
      const react = vi.fn(async () => { server = [{ ...older, reactions: [{ emoji: '👍', count: 2, me: true }] }]; return { ok: true }; });
      Object.assign((window.electronAPI as unknown as { maker: { chatServer: Record<string, unknown> } }).maker.chatServer, { react });
      renderView();
      await user.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
      const chip = await screen.findByRole('button', { name: 'bots.groupChat.server.reactionCount' });
      expect(chip.getAttribute('aria-pressed')).toBe('false');
      mocks.getBotGroup.mockClear();
      await user.click(chip);
      await waitFor(() => expect(screen.getByRole('button', { name: 'bots.groupChat.server.reactionCount' }).getAttribute('aria-pressed')).toBe('true'));
      expect(screen.getByRole('button', { name: 'bots.groupChat.server.reactionCount' }).textContent).toContain('2');
      expect(react).toHaveBeenCalledWith({ groupId: 'g1', messageId: 'old1', emoji: '👍', present: true });
      // The latest page as always, then only the page holding the changed message.
      expect(mocks.getBotGroup.mock.calls.map(([, options]) => options?.beforeSequence)).toEqual([undefined, 2]);
    });

    describe('quoted originals on older pages after a push', () => {
      const original = msg({ id: 'old1', sequence: 1, authorKind: 'bot', authorBotId: 'xiaoman', authorName: '小满', content: '很早的原文' });
      const latest = msg({ id: 'q1', sequence: 50, content: '那就这班', quote: quoteOf('old1', { excerpt: '快照摘要', sequence: 1 }) });
      /** The server's current page for `beforeSequence`, and a way to run the page loader. */
      function serve(older: () => Promise<BotGroupMessageView[]>) {
        const base = detail({ serverBacked: true, hasMoreBefore: true });
        mocks.getBotGroup.mockImplementation(async (_id: string, options?: { beforeSequence?: number }) => options?.beforeSequence
          ? { ok: true, group: { ...base, hasMoreBefore: false, messages: await older() } }
          : { ok: true, group: { ...base, messages: [latest] } });
      }
      const quoteState = () => screen.getByTestId('bot-group-quote').getAttribute('data-quote-state');
      const push = () => act(async () => { mocks.pushes.forEach((listener) => listener({ groupId: 'g1', change: 'messages' })); });

      it('drops a deleted original from the quote on a push, without a click', async () => {
        const user = userEvent.setup();
        let server = [original];
        serve(async () => server);
        renderView();
        await user.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
        await waitFor(() => expect(screen.getByTestId('bot-group-quote').textContent).toContain('很早的原文'));
        expect(quoteState()).toBe('live');
        server = [{ ...original, deleted: true, content: '（消息已删除）' }];
        await push();
        await waitFor(() => expect(quoteState()).toBe('deleted'));
        expect(document.body.textContent).not.toContain('很早的原文');
        expect(mocks.getBotGroup).toHaveBeenLastCalledWith('g1', { beforeSequence: 2 });
      });

      it('follows an edited original on a push', async () => {
        const user = userEvent.setup();
        let server = [original];
        serve(async () => server);
        renderView();
        await user.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
        await waitFor(() => expect(screen.getByTestId('bot-group-quote').textContent).toContain('很早的原文'));
        server = [{ ...original, content: '改过的原文' }];
        await push();
        await waitFor(() => expect(screen.getByTestId('bot-group-quote').textContent).toContain('改过的原文'));
        expect(quoteState()).toBe('live');
      });

      it('falls back to the snapshot and never jumps when the original cannot be re-read', async () => {
        const user = userEvent.setup();
        let fail = false;
        serve(async () => { if (fail) throw new Error('offline'); return [original]; });
        renderView();
        await user.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
        await waitFor(() => expect(quoteState()).toBe('live'));
        fail = true;
        await push();
        await waitFor(() => expect(quoteState()).toBe('snapshot'));
        expect(screen.getByTestId('bot-group-quote').textContent).toContain('快照摘要');
        await user.click(screen.getByTestId('bot-group-quote'));
        await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('bots.groupChat.timeline.loadEarlierFailed'));
        expect(document.querySelector('[class*="search-match-bg"]')).toBeNull();
      });

      it('re-checks every quoted original across all opened pages on a single push', async () => {
        const user = userEvent.setup();
        const originals = [400, 300, 200, 100].map((sequence, index) => msg({ id: `o${index}`, sequence, authorKind: 'bot',
          authorBotId: 'xiaoman', authorName: '小满', content: `原文${index}` }));
        const quotes = originals.map((original, index) => msg({ id: `q${index}`, sequence: 501 + index, content: `回复${index}`,
          quote: quoteOf(original.id, { excerpt: `快照${index}`, sequence: original.sequence }) }));
        let server = originals;
        const base = detail({ serverBacked: true, hasMoreBefore: true });
        // One message per page, so each original sits on its own opened page.
        mocks.getBotGroup.mockImplementation(async (_id: string, options?: { beforeSequence?: number }) => {
          if (!options?.beforeSequence) return { ok: true, group: { ...base, messages: quotes } };
          const page = server.filter((message) => message.sequence < options.beforeSequence!).slice(0, 1);
          return { ok: true, group: { ...base, hasMoreBefore: page[0]!.sequence > 100, messages: page } };
        });
        renderView();
        for (let page = 0; page < 4; page += 1) {
          await user.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
          await screen.findByText(`原文${page}`, { selector: '[data-markdown]' });
        }
        server = originals.map((original, index) => index % 2 === 0
          ? { ...original, deleted: true, content: '（消息已删除）' } : { ...original, content: `改过${index}` });
        mocks.getBotGroup.mockClear();
        await push();
        await waitFor(() => expect(screen.getAllByTestId('bot-group-quote').map((block) => block.getAttribute('data-quote-state')))
          .toEqual(['deleted', 'live', 'deleted', 'live']));
        const blocks = screen.getAllByTestId('bot-group-quote');
        expect(blocks[1]!.textContent).toContain('改过1');
        expect(blocks[3]!.textContent).toContain('改过3');
        expect(document.body.textContent).not.toMatch(/原文0|原文2/);
        // One read for the latest page, then one per original's page; nothing beyond what was opened.
        expect(mocks.getBotGroup.mock.calls.map(([, options]) => options?.beforeSequence).filter(Boolean)).toEqual([401, 301, 201, 101]);
      });

      it('shows a 话题 root\'s quote from the same verified messages', async () => {
        const user = userEvent.setup();
        let server = [original];
        serve(async () => server);
        mocks.thread.mockImplementation(async () => ({ ok: true, root: latest, replies: [], hasMore: false }));
        renderView();
        await user.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
        await waitFor(() => expect(quoteState()).toBe('live'));
        server = [{ ...original, deleted: true, content: '（消息已删除）' }];
        await push();
        await waitFor(() => expect(quoteState()).toBe('deleted'));
        const row = document.querySelector('[data-bot-group-message-id="q1"]') as HTMLElement;
        await user.click(within(row).getByRole('button', { name: 'bots.groupChat.server.startTopic' }));
        const panel = await screen.findByRole('complementary');
        await waitFor(() => expect(within(panel).getByTestId('bot-group-quote').getAttribute('data-quote-state')).toBe('deleted'));
        expect(panel.textContent).not.toContain('快照摘要');
      });

      it('lets a newer push win over an older re-read that answers late', async () => {
        const user = userEvent.setup();
        const pending: Array<(page: BotGroupMessageView[]) => void> = [];
        let paging = true;
        serve(() => paging ? Promise.resolve([original]) : new Promise((resolve) => pending.push(resolve)));
        renderView();
        await user.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
        await waitFor(() => expect(quoteState()).toBe('live'));
        paging = false;
        await push();
        await waitFor(() => expect(pending).toHaveLength(1));
        await push();
        await waitFor(() => expect(pending).toHaveLength(2));
        await act(async () => pending[1]!([{ ...original, deleted: true, content: '（消息已删除）' }]));
        await waitFor(() => expect(quoteState()).toBe('deleted'));
        // The superseded read arrives last with the pre-deletion copy; it must not bring the text back.
        await act(async () => pending[0]!([original]));
        expect(quoteState()).toBe('deleted');
        expect(document.body.textContent).not.toContain('很早的原文');
      });
    });

    it('says the original is out of reach instead of jumping elsewhere', async () => {
      const user = userEvent.setup();
      const base = detail({ serverBacked: true, hasMoreBefore: true });
      mocks.getBotGroup.mockImplementation(async (_id: string, options?: { beforeSequence?: number }) => options?.beforeSequence
        ? { ok: true, group: { ...base, hasMoreBefore: false, messages: [msg({ id: 'other', sequence: 3, content: '别的消息' })] } }
        : { ok: true, group: { ...base, messages: [msg({ id: 'q1', sequence: 50, content: '那就这班', quote: quoteOf('gone', { excerpt: '看不到的原文', sequence: 2 }) })] } });
      renderView();
      await user.click(await screen.findByRole('button', { name: 'bots.groupChat.quote.jumpLabel:小满' }));
      await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledWith('bots.groupChat.quote.unavailable'));
      expect(document.querySelector('[class*="search-match-bg"]')).toBeNull();
    });

    it('keeps a quote draft inside its own group', async () => {
      const user = userEvent.setup();
      let view = renderView();
      await user.click(await quoteButton());
      expect(screen.getByTestId('bot-group-quote-preview')).toBeTruthy();
      view.unmount();
      mocks.groupId = 'g2';
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ id: 'g2', serverBacked: true }) });
      view = renderView();
      await screen.findByText('周六 8:10 有票');
      expect(screen.queryByTestId('bot-group-quote-preview')).toBeNull();
      await user.keyboard('x');
      expect(screen.queryByTestId('bot-group-quote-preview')).toBeNull();
    });
  });

  describe('分工', () => {
    // A server's queue migration marks every older plan kind=work: it stays a division of work.
    it.each([undefined, 'work'] as const)('shows the organizer’s plan card and starts or skips the open plan (kind=%s)', async (kind) => {
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(plan(kind ? { kind } : {})) });
      renderView();
      const card = await screen.findByTestId('bot-group-plan');
      expect(card.textContent).toContain('bots.groupChat.plan.intro');
      expect(card.textContent).toContain('想清楚这页讲什么');
      expect(card.textContent).toContain('画设计稿');
      // The organizer tag sits next to the plan card's author.
      expect(within(card.closest('article')!).getByText('bots.groupChat.organizer')).toBeTruthy();
      expect(screen.getByText('bots.groupChat.plan.editHint')).toBeTruthy();
      expect(screen.getByText('bots.groupChat.plan.pauseNote')).toBeTruthy();
      expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe(
        'bots.groupChat.composer.placeholderPlanProposed',
      );

      fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.plan.start' }));
      await waitFor(() => expect(mocks.startBotGroupPlan).toHaveBeenCalledWith({ groupId: 'g1', planId: 'p1' }));
      await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));

      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'bots.groupChat.plan.dismiss' }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.plan.dismiss' }));
      await waitFor(() => expect(mocks.dismissBotGroupPlan).toHaveBeenCalledWith({ groupId: 'g1', planId: 'p1' }));
    });

    it.each([true, false])('renders a human-signed plan with organizer and controls (self=%s)', async (isSelf) => {
      const group = withPlan(plan());
      group.messages = group.messages.map(message => message.kind === 'plan'
        ? { ...message, authorKind: 'user', authorBotId: null, authorName: 'Human creator', isSelf } : message);
      mocks.getBotGroup.mockResolvedValue({ ok: true, group });
      renderView();
      const card = await screen.findByTestId('bot-group-plan');
      expect(card.closest('article')?.textContent).toContain('咪咪');
      expect(card.closest('article')?.textContent).not.toContain('Human creator');
      fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.plan.start' }));
      await waitFor(() => expect(mocks.startBotGroupPlan).toHaveBeenCalledWith({ groupId: 'g1', planId: 'p1' }));
      await waitFor(() => expect((screen.getByRole('button', { name: 'bots.groupChat.plan.dismiss' }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.plan.dismiss' }));
      await waitFor(() => expect(mocks.dismissBotGroupPlan).toHaveBeenCalledWith({ groupId: 'g1', planId: 'p1' }));
    });

    it('keeps human-signed superseded plans visible and read-only', async () => {
      const group = withPlan(plan({ status: 'superseded' }));
      group.messages = group.messages.map(message => message.kind === 'plan' ? { ...message, authorKind: 'user', authorBotId: null } : message);
      mocks.getBotGroup.mockResolvedValue({ ok: true, group });
      renderView();
      expect(await screen.findByText('bots.groupChat.plan.superseded')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'bots.groupChat.plan.start' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'bots.groupChat.plan.dismiss' })).toBeNull();
    });

    it('explains a failed plan action and re-reads the group', async () => {
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(plan()) });
      mocks.startBotGroupPlan.mockResolvedValue({ ok: false, errorCode: 'PLAN_CLOSED', message: '' });
      renderView();
      fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.plan.start' }));
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('bots.groupChat.errors.planClosed'));
      await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
    });

    it('hands a step to another teammate or removes it from the step menu', async () => {
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(plan()) });
      renderView();
      const steps = await screen.findAllByTestId('bot-group-plan-step');
      fireEvent.pointerDown(steps[1]!, { button: 0, ctrlKey: false });
      expect(await screen.findByText('bots.groupChat.plan.stepMenuTitle')).toBeTruthy();
      fireEvent.click(screen.getByRole('menuitem', { name: '咪咪' }));
      await waitFor(() =>
        expect(mocks.editBotGroupPlanStep).toHaveBeenCalledWith({
          groupId: 'g1',
          planId: 'p1',
          position: 1,
          action: 'reassign',
          botId: 'mimi',
        }),
      );

      await waitFor(() =>
        expect((screen.getAllByTestId('bot-group-plan-step')[0] as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.pointerDown(screen.getAllByTestId('bot-group-plan-step')[0]!, { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'bots.groupChat.plan.removeStep' }));
      await waitFor(() =>
        expect(mocks.editBotGroupPlanStep).toHaveBeenLastCalledWith({
          groupId: 'g1',
          planId: 'p1',
          position: 0,
          action: 'remove',
        }),
      );
    });

    it('keeps the last step: removing it is disabled with a reason', async () => {
      const single = plan({ steps: [plan().steps[0]!] });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(single) });
      renderView();
      const [step] = await screen.findAllByTestId('bot-group-plan-step');
      fireEvent.pointerDown(step!, { button: 0, ctrlKey: false });
      const remove = await screen.findByRole('menuitem', { name: /bots\.groupChat\.plan\.removeStep/ });
      expect(remove.getAttribute('aria-disabled')).toBe('true');
      expect(remove.textContent).toContain('bots.groupChat.plan.keepOneStep');
    });

    // bot-group-chat.md §7: a server queue stands on its own (no organizer authorship) and folds
    // a long queue to the turns around the current one; a short queue shows every turn.
    it.each([
      ['a short queue', 2, 2, false],
      ['a long queue after its first five turns', 7, 3, true],
    ] as const)('shows %s on its own, folded to the turns that matter', async (_label, count, shown, foldable) => {
      const base = plan().steps;
      // Waiting for 继续: after the first turn of a short queue, or after the five that run by themselves.
      const done = count > 5 ? 5 : 1;
      const queue = plan({
        status: 'waiting', currentStep: done - 1, kind: 'talk', canManage: true,
        steps: Array.from({ length: count }, (_, position) => ({ ...base[position % 2]!, position, task: '',
          status: position < done ? 'done' as const : 'pending' as const })),
      });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(queue) });
      renderView();
      const card = await screen.findByTestId('bot-group-arrangement');
      expect(card.closest('article')).toBeNull();
      expect(card.textContent).not.toContain('bots.groupChat.plan.intro');
      expect(card.textContent).toContain('bots.groupChat.plan.talkTurn');
      expect(card.querySelectorAll('li')).toHaveLength(shown);
      expect(screen.getByTestId('bot-group-plan-follow-up')).toBeTruthy();
      const fold = screen.queryByTestId('bot-group-plan-fold');
      expect(!!fold).toBe(foldable);
      if (fold) {
        fireEvent.click(fold);
        expect(card.querySelectorAll('li')).toHaveLength(count);
      }
    });

    // Only the creator, an owner or an admin may change who speaks next in a waiting queue.
    it.each([[true, 1], [false, 0]] as const)('offers reassigning a waiting queue turn only to a manager (canManage=%s)', async (canManage, menus) => {
      const base = plan().steps;
      const queue = plan({
        status: 'waiting', currentStep: 0, kind: 'talk', canManage,
        steps: [{ ...base[0]!, task: '', status: 'done' }, { ...base[1]!, task: '', status: 'pending' }],
      });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(queue) });
      renderView();
      const card = await screen.findByTestId('bot-group-arrangement');
      const pending = within(card).getAllByTestId('bot-group-plan-step')[1]!;
      fireEvent.pointerDown(pending, { button: 0, ctrlKey: false });
      expect(screen.queryAllByRole('menu')).toHaveLength(menus);
    });

    it('offers the next step after a hand-off and opens its files inside the work directory', async () => {
      const waiting = plan({
        status: 'waiting',
        currentStep: 0,
        workDir: '/work/site',
        steps: [
          { ...plan().steps[0]!, status: 'done' },
          { ...plan().steps[1]!, status: 'pending' },
        ],
      });
      const handoff = msg({
        id: 'h1',
        sequence: 11,
        authorKind: 'bot',
        authorBotId: 'mimi',
        authorName: '咪咪',
        content: '想好了，页面分三段',
        planId: 'p1',
        files: ['docs/页面想法.md', '../secret.txt'],
      });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(waiting, [handoff]) });
      renderView();

      const row = await screen.findByTestId('bot-group-plan-follow-up');
      expect(row.textContent).toContain('bots.groupChat.timeline.nextStep');
      expect(row.textContent).toContain('小满');
      expect(row.textContent).toContain('画设计稿');
      // Started plans are read-only: no 开始, and the done step is ticked.
      expect(screen.queryByRole('button', { name: 'bots.groupChat.plan.start' })).toBeNull();
      expect(screen.getByTestId('bot-group-plan').textContent).toContain('bots.groupChat.plan.stepDone');
      expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe(
        'bots.groupChat.composer.placeholderPlanWaiting:咪咪',
      );

      fireEvent.click(screen.getByRole('button', { name: '页面想法.md' }));
      await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith('/work/site/docs/页面想法.md'));
      // An entry that would leave the work directory never reaches the OS.
      fireEvent.click(screen.getByRole('button', { name: 'secret.txt' }));
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('bots.groupChat.files.openFailed'));
      expect(mocks.openPath).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.timeline.continuePlan' }));
      await waitFor(() => expect(mocks.continueBotGroupPlan).toHaveBeenCalledWith({ groupId: 'g1', planId: 'p1' }));
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'bots.groupChat.timeline.endPlan' }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.timeline.endPlan' }));
      await waitFor(() => expect(mocks.dismissBotGroupPlan).toHaveBeenCalledWith({ groupId: 'g1', planId: 'p1' }));
    });

    it('lets a step that did not finish change hands before 重试, without removing steps', async () => {
      const failed = plan({
        status: 'waiting',
        currentStep: 1,
        steps: [
          { ...plan().steps[0]!, status: 'done' },
          { ...plan().steps[1]!, status: 'failed' },
        ],
      });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(failed) });
      renderView();
      const steps = await screen.findAllByTestId('bot-group-plan-step');
      expect(steps[0]!.tagName).toBe('DIV');
      expect(steps[1]!.tagName).toBe('BUTTON');
      fireEvent.pointerDown(steps[1]!, { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole('menuitem', { name: '咪咪' }));
      await waitFor(() =>
        expect(mocks.editBotGroupPlanStep).toHaveBeenCalledWith({
          groupId: 'g1',
          planId: 'p1',
          position: 1,
          action: 'reassign',
          botId: 'mimi',
        }),
      );
      fireEvent.pointerDown(screen.getAllByTestId('bot-group-plan-step')[1]!, { button: 0, ctrlKey: false });
      await screen.findByText('bots.groupChat.plan.stepMenuTitle');
      expect(screen.queryByRole('menuitem', { name: /bots\.groupChat\.plan\.removeStep/ })).toBeNull();
    });

    it('offers a retry when a step did not finish', async () => {
      const failed = plan({
        status: 'waiting',
        currentStep: 1,
        steps: [
          { ...plan().steps[0]!, status: 'done' },
          { ...plan().steps[1]!, status: 'failed' },
        ],
      });
      const notice = msg({
        id: 'n-step',
        sequence: 12,
        kind: 'notice',
        authorKind: 'system',
        authorName: '小满',
        noticeCode: 'member-timeout',
        planId: 'p1',
      });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(failed, [notice]) });
      renderView();
      const row = await screen.findByTestId('bot-group-plan-follow-up');
      expect(row.textContent).toContain('bots.groupChat.timeline.stepFailed:小满');
      // A member notice inside a plan talks about the step, not a chat reply.
      expect(screen.getByText('bots.groupChat.notice.stepTimeout:小满')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.timeline.retryStep' }));
      await waitFor(() => expect(mocks.retryBotGroupPlan).toHaveBeenCalledWith({ groupId: 'g1', planId: 'p1' }));
    });

    it('closes a finished plan with a divider and shows plan notices', async () => {
      const done = plan({
        status: 'done',
        currentStep: 1,
        steps: plan().steps.map((step) => ({ ...step, status: 'done' as const })),
      });
      const extra = [
        msg({ id: 'end', sequence: 13, kind: 'plan-end', authorKind: 'system', planId: 'p1' }),
        msg({ id: 'nf', sequence: 14, kind: 'notice', authorKind: 'system', authorName: '咪咪', noticeCode: 'plan-failed' }),
        msg({ id: 'ns', sequence: 15, kind: 'notice', authorKind: 'system', noticeCode: 'plan-stopped' }),
        msg({
          id: 'nw',
          sequence: 16,
          kind: 'notice',
          authorKind: 'system',
          authorName: '小满',
          noticeCode: 'workdir-unavailable',
          planId: 'p1',
        }),
      ];
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(done, extra) });
      renderView();
      expect((await screen.findByTestId('bot-group-plan-end')).textContent).toBe('bots.groupChat.timeline.planDone');
      expect(screen.getByText('bots.groupChat.notice.planFailed:咪咪')).toBeTruthy();
      expect(screen.getByText(/^bots\.groupChat\.notice\.planStopped/)).toBeTruthy();
      expect(screen.getByText('bots.groupChat.notice.workdirUnavailable:小满')).toBeTruthy();
      expect(screen.queryByTestId('bot-group-plan-follow-up')).toBeNull();
      expect(screen.getByTestId('bot-group-plan').getAttribute('data-plan-status')).toBe('done');
      expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('bots.groupChat.composer.placeholder');
    });

    it('marks replaced and skipped plans instead of offering actions', async () => {
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(plan({ status: 'superseded' })) });
      renderView();
      expect(await screen.findByText('bots.groupChat.plan.superseded')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'bots.groupChat.plan.start' })).toBeNull();
      expect(screen.queryAllByRole('button').some((button) => button.dataset.testid === 'bot-group-plan-step')).toBe(false);
    });

    it('shows who is planning or doing a step, with the step’s pending confirmation', async () => {
      mocks.getBotGroup.mockResolvedValue({
        ok: true,
        group: detail({
          speakingBotIds: ['mimi', 'xiaoman'],
          round: {
            status: 'running',
            speakers: [
              { botId: 'mimi', sessionId: null, activity: 'planning' },
              { botId: 'xiaoman', sessionId: 'plan-xiaoman', activity: 'step' },
            ],
            canContinue: false,
          },
        }),
      });
      renderView();
      const rows = await screen.findAllByTestId('bot-group-speaking');
      expect(rows.map((row) => row.getAttribute('data-activity'))).toEqual(['planning', 'step']);
      // The row already names the Bot; planning has no Session phase, a step shows its live phase.
      expect(rows[0]!.textContent).toContain('bots.groupChat.speaking.planning');
      expect(rows[0]!.textContent).not.toContain('bots.groupChat.speaking.planning:');
      expect(rows[1]!.textContent).not.toContain('bots.groupChat.speaking.planning');
      expect(screen.getAllByTestId('pending-interaction').map((node) => node.textContent)).toEqual(['plan-xiaoman']);
    });

    it('sends a message tagged 安排分工 with division: true and clears the tag', async () => {
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.pointerDown(screen.getByRole('button', { name: 'bots.groupChat.composer.more' }), {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.click(await screen.findByRole('menuitem', { name: /^bots\.groupChat\.composer\.division/ }));
      expect(screen.getByTestId('bot-group-division-tag').textContent).toContain('bots.groupChat.composer.divisionTag');
      expect(input.getAttribute('placeholder')).toBe('bots.groupChat.composer.placeholderDivision');

      fireEvent.change(input, { target: { value: '做一个官网介绍页' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
      expect(mocks.sendBotGroupMessage.mock.calls[0]![0]).toMatchObject({
        groupId: 'g1',
        text: '做一个官网介绍页',
        division: true,
      });
      expect(screen.queryByTestId('bot-group-division-tag')).toBeNull();

      // Without the tag the flag is not sent at all.
      fireEvent.change(input, { target: { value: '谢谢' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(2));
      expect(mocks.sendBotGroupMessage.mock.calls[1]![0]).not.toHaveProperty('division');
    });

    it('puts the draft and its tag back when main refuses a second plan', async () => {
      mocks.sendBotGroupMessage.mockResolvedValue({ ok: false, errorCode: 'PLAN_OPEN', message: '' });
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.pointerDown(screen.getByRole('button', { name: 'bots.groupChat.composer.more' }), {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.click(await screen.findByRole('menuitem', { name: /^bots\.groupChat\.composer\.division/ }));
      fireEvent.change(input, { target: { value: '再排一次' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('bots.groupChat.errors.planOpen'));
      expect(input.value).toBe('再排一次');
      expect(screen.getByTestId('bot-group-division-tag')).toBeTruthy();
    });

    it('disables 安排分工 with a reason while a plan is under way', async () => {
      const running = plan({
        status: 'running',
        currentStep: 0,
        steps: [{ ...plan().steps[0]!, status: 'running' }, plan().steps[1]!],
      });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(running) });
      renderView();
      const input = await screen.findByRole('textbox');
      expect(input.getAttribute('placeholder')).toBe('bots.groupChat.composer.placeholderPlanRunning:咪咪');
      fireEvent.pointerDown(screen.getByRole('button', { name: 'bots.groupChat.composer.more' }), {
        button: 0,
        ctrlKey: false,
      });
      const item = await screen.findByRole('menuitem', { name: /^bots\.groupChat\.composer\.division/ });
      expect(item.getAttribute('aria-disabled')).toBe('true');
      expect(item.textContent).toContain('bots.groupChat.composer.divisionBusy');
    });

    it('re-reads the timeline on a plan change', async () => {
      renderView();
      await screen.findByText('周六 8:10 有票');
      act(() => mocks.pushes.forEach((push) => push({ groupId: 'g1', change: 'plan' })));
      await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
    });
  });

  describe('附件', () => {
    it('offers 添加文件、图片或视频… above 安排分工 and puts the picked files in the tray', async () => {
      renderView();
      await screen.findByRole('textbox');
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput.multiple).toBe(true);
      const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
      try {
        fireEvent.pointerDown(screen.getByRole('button', { name: 'bots.groupChat.composer.more' }), {
          button: 0,
          ctrlKey: false,
        });
        const items = await screen.findAllByRole('menuitem');
        expect(items.map((item) => item.textContent)).toEqual([
          'extraDirs.addFiles',
          expect.stringContaining('bots.groupChat.composer.division'),
        ]);
        fireEvent.click(items[0]!);
        expect(click).toHaveBeenCalledTimes(1);
        expect(click.mock.contexts[0]).toBe(fileInput);
      } finally {
        click.mockRestore();
      }

      pickFiles([diskFile('report.pdf', 'application/pdf'), diskFile('photo.png', 'image/png')]);
      expect(await screen.findByText('report.pdf')).toBeTruthy();
      expect((await screen.findByAltText('photo.png')).getAttribute('src')).toBe('cindy-media://blobs/photo.png');
      // Images go through the normal cache path under the group's own scope.
      expect(mocks.cacheImageFromPath).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'bot-group:g1', sourcePath: '/tmp/photo.png' }),
      );
    });

    it('attaches pasted files and screenshots and leaves plain text to the input', async () => {
      renderView();
      const input = await screen.findByRole('textbox');
      const onDisk = diskFile('notes.md', 'text/markdown');
      const bitmap = new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });
      const paste = createEvent.paste(input, {
        clipboardData: { items: [clipboardFileItem(onDisk), clipboardFileItem(bitmap)], getData: () => '' },
      });
      fireEvent(input, paste);
      expect(paste.defaultPrevented).toBe(true);
      expect(await screen.findByText('notes.md')).toBeTruthy();
      await waitFor(() =>
        expect(mocks.cacheImageFromBuffer).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'bot-group:g1', mimeType: 'image/png' }),
        ),
      );
      expect(await screen.findByAltText(/^clipboard-\d+\.png$/)).toBeTruthy();

      const textPaste = createEvent.paste(input, {
        clipboardData: { items: [{ kind: 'string', type: 'text/plain' }], getData: () => '你好' },
      });
      fireEvent(input, textPaste);
      expect(textPaste.defaultPrevented).toBe(false);
    });

    it('sends the attachments with the text and takes them out of the tray once main has them', async () => {
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      pickFiles([diskFile('report.pdf', 'application/pdf')]);
      await screen.findByText('report.pdf');
      fireEvent.change(input, { target: { value: '@咪咪 看看这份', selectionStart: 9 } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
      expect(lastSend()).toMatchObject({
        groupId: 'g1',
        text: '@咪咪 看看这份',
        mentions: { all: false, botIds: ['mimi'] },
        attachments: [
          {
            name: 'report.pdf',
            originalName: 'report.pdf',
            path: '/tmp/report.pdf',
            ext: '.pdf',
            category: 'pdf',
            mimeType: 'application/pdf',
          },
        ],
      });
      // The tray is empty; the optimistic copy of the message shows the file until main's copy arrives.
      await waitFor(() => expect(within(input.parentElement!).queryByText('report.pdf')).toBeNull());
      expect(getDraft(botGroupAttachmentScope('g1'))?.attachments ?? []).toEqual([]);
    });

    it('sends attachments without text, even while a round runs', async () => {
      mocks.getBotGroup.mockResolvedValue({
        ok: true,
        group: detail({ round: { status: 'running', speakers: [], canContinue: false } }),
      });
      renderView();
      await screen.findByRole('textbox');
      expect(screen.getByRole('button', { name: 'bots.groupChat.composer.stop' })).toBeTruthy();
      pickFiles([diskFile('photo.png', 'image/png')]);
      await screen.findByAltText('photo.png');
      fireEvent.click(screen.getByRole('button', { name: 'bots.send' }));
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
      expect(lastSend()).toMatchObject({
        text: '',
        attachments: [
          { name: 'photo.png', category: 'image', url: 'cindy-media://blobs/photo.png', path: '/tmp/photo.png' },
        ],
      });
      expect(mocks.stopBotGroupRound).not.toHaveBeenCalled();
    });

    it('keeps the text and attachments when the send fails, and retries with the same clientId', async () => {
      mocks.sendBotGroupMessage
        .mockResolvedValueOnce({ ok: false, errorCode: 'INVALID_PARAMS', message: '' })
        .mockResolvedValueOnce({ ok: true, messageId: 'u2' });
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      pickFiles([diskFile('report.pdf', 'application/pdf')]);
      await screen.findByText('report.pdf');
      fireEvent.change(input, { target: { value: '看看' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith('bots.groupChat.composer.attachmentsFailed'),
      );
      expect(input.value).toBe('看看');
      expect(screen.getByText('report.pdf')).toBeTruthy();
      expect(getDraft(botGroupAttachmentScope('g1'))?.attachments.map((file) => file.name)).toEqual(['report.pdf']);
      const firstClientId = lastSend().clientId;

      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(2));
      expect(lastSend().clientId).toBe(firstClientId);
      // The tray is empty; the optimistic copy of the message shows the file until main's copy arrives.
      await waitFor(() => expect(within(input.parentElement!).queryByText('report.pdf')).toBeNull());
    });

    it('holds a message over the attachment limit with a hint', async () => {
      renderView();
      await screen.findByRole('textbox');
      pickFiles(Array.from({ length: 21 }, (_, index) => diskFile(`part-${index}.txt`, 'text/plain')));
      await screen.findByText('part-20.txt');
      expect(screen.getByText('bots.groupChat.composer.tooManyAttachments')).toBeTruthy();
      const send = screen.getByRole('button', { name: 'bots.send' }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
    });

    it('takes files dropped anywhere on the page and explains that folders cannot be attached', async () => {
      const view = renderView();
      await screen.findByRole('textbox');
      const main = view.container.querySelector('main')!;
      const file = diskFile('data.csv', 'text/csv');
      const folder = diskFile('assets', '');
      const dataTransfer = {
        types: ['Files'],
        files: [file, folder],
        items: [clipboardFileItem(file), clipboardFileItem(folder, true)],
        getData: () => '',
        dropEffect: 'none',
      };
      fireEvent.dragEnter(main, { dataTransfer });
      expect(screen.getByTestId('bot-group-drop-hint')).toBeTruthy();
      fireEvent.drop(main, { dataTransfer });
      expect(screen.queryByTestId('bot-group-drop-hint')).toBeNull();
      expect(await screen.findByText('data.csv')).toBeTruthy();
      expect(screen.queryByText('assets')).toBeNull();
      expect(mocks.toastWarning).toHaveBeenCalledWith('bots.groupChat.composer.folderNotSupported');
    });

    it('keeps a sent message’s text, image and file in one bubble', async () => {
      mocks.getBotGroup.mockResolvedValue({
        ok: true,
        group: detail({
          messages: [
            msg({
              id: 'u9',
              content: '',
              attachments: [
                {
                  id: 'a1',
                  name: '截图.png',
                  category: 'image',
                  mimeType: 'image/png',
                  size: 10,
                  url: 'cindy-media://blobs/abc.png',
                  path: null,
                },
                {
                  id: 'a2',
                  name: '报告.pdf',
                  category: 'pdf',
                  mimeType: 'application/pdf',
                  size: 20,
                  url: null,
                  path: '/Users/me/报告.pdf',
                },
              ],
            }),
            msg({
              id: 'u10',
              sequence: 2,
              content: '再看这张',
              attachments: [
                {
                  id: 'a3',
                  name: '草图.png',
                  category: 'image',
                  mimeType: 'image/png',
                  size: 10,
                  url: 'cindy-media://blobs/def.png',
                  path: null,
                },
              ],
            }),
          ],
        }),
      });
      renderView();
      const image = await screen.findByAltText('截图.png');
      expect(image.getAttribute('src')).toBe('cindy-media://blobs/abc.png');
      const bubble = image.closest('[data-testid="bot-group-self-bubble"]')!;
      const chip = screen.getByRole('button', { name: '报告.pdf' });
      expect(bubble.contains(chip)).toBe(true);
      // A PDF is not text: it opens in the system app, as from a task's chip.
      fireEvent.click(chip);
      await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith('/Users/me/报告.pdf'));

      const withText = screen.getByAltText('草图.png').closest('article')!;
      const textBubbles = withText.querySelectorAll('[data-testid="bot-group-self-bubble"]');
      expect(textBubbles).toHaveLength(1);
      expect(textBubbles[0].textContent).toContain('再看这张');
      expect(textBubbles[0].contains(screen.getByAltText('草图.png'))).toBe(true);
    });

    it('keeps a server attachment in place while it loads or fails, beside the sender’s own text and someone else’s', async () => {
      mocks.getBotGroup.mockResolvedValue({
        ok: true,
        group: detail({
          messages: [
            msg({
              id: 'u11',
              content: '这个Thread的问题很大...',
              isSelf: true,
              attachments: [
                { id: 'p1', name: 'clipboard-1791878467493.png', category: 'file', mimeType: '', size: 0, url: null, path: null, state: 'loading' },
                { id: 'p2', name: 'spec.pdf', category: 'file', mimeType: '', size: 0, url: null, path: null, state: 'unavailable' },
              ],
            }),
            msg({
              id: 'h1',
              sequence: 2,
              authorKind: 'user',
              isSelf: false,
              authorName: 'chris',
              content: '',
              attachments: [
                { id: 'p3', name: 'photo.png', category: 'image', mimeType: 'image/png', size: 1, url: 'cindy-media://blobs/photo.png', path: null },
                { id: 'p4', name: '', category: 'file', mimeType: '', size: 0, url: null, path: null, state: 'unavailable' },
              ],
            }),
          ],
        }),
      });
      renderView();
      const own = (await screen.findByText('这个Thread的问题很大...')).closest('article')!;
      expect(within(own).getByText('chat.imageMissing.loading')).toBeTruthy();
      expect(within(own).getByText('clipboard-1791878467493.png')).toBeTruthy();
      expect(within(own).getByRole('status', { name: 'spec.pdf, bots.groupChat.files.unavailable' })).toBeTruthy();
      expect(within(own).getByTestId('bot-group-self-bubble').contains(within(own).getByTestId('bot-group-message-attachments'))).toBe(true);
      const other = screen.getByAltText('photo.png').closest('article')!;
      expect(within(other).getByTestId('bot-group-message-attachments').className).toContain('items-start');
      // A media reference without a caption still says something was attached.
      expect(within(other).getByRole('status', { name: 'bots.groupChat.files.untitled, bots.groupChat.files.unavailable' })).toBeTruthy();
      expect(document.body.textContent).not.toContain('[附件:');
    });
  });
});

it('keeps copy/share in each author row\'s more menu and shares only message content through the standard selection flow', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [
    msg({ id: 'bot-share', authorKind: 'bot', authorName: '咪咪', content: 'Share this answer' }),
    msg({ id: 'mine-share', sequence: 2, content: 'My question' }),
    msg({ id: 'notice', sequence: 3, kind: 'notice', authorKind: 'system', content: 'Group notice' }),
  ] }) });
  const view = renderView();
  try {
    const article = (await screen.findByText('Share this answer')).closest('article')!;
    fireEvent.pointerDown(within(article).getByRole('button', { name: 'chat.messageActionBar.moreActions' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: 'chat.messageActionBar.copy' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.shareImage.entry' }));
    expect(shareSelectionStore.getSelectedIds()).toEqual(['bot-share']);
    expect(queryShareableMessageIds('bot-group:g1')).toEqual(['bot-share', 'mine-share']);
    expect(within(article).getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'chat.shareImage.copy' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'chat.shareImage.cancel' }));
    expect(shareSelectionStore.getActiveSessionId()).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  } finally { view.unmount(); vi.unstubAllGlobals(); }
});

 it.each(['bot', 'guest'] as const)('acknowledges visible %s replies at the tail and preserves new replies while reading above it', async (sender) => {
  resetBotReadStateForTests();
  const incoming = sender === 'bot' ? { authorKind: 'bot' as const } : { authorKind: 'user' as const, isSelf: false };
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  markBotRead(botGroupReadKey('g1'), 100);
  mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [
    msg({ id: 'b', ...incoming, content: 'First reply', createdAt: 200 }),
    msg({ id: 'u', sequence: 2, content: 'My message', createdAt: 900 }),
  ] }) });
  const view = renderView();
  try {
    await screen.findByText('First reply');
    act(() => window.dispatchEvent(new Event('focus')));
    expect(getBotLastReadAt(botGroupReadKey('g1'))).toBe(200);
    const scroll = view.container.querySelector('.overflow-y-auto.px-5') as HTMLElement;
    Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } });
    scroll.scrollTop = 0; fireEvent.scroll(scroll);
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [msg({ id: 'new', sequence: 3, ...incoming, content: 'New reply', createdAt: 1200 })] }) });
    act(() => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    await screen.findByText('New reply');
    act(() => window.dispatchEvent(new Event('focus')));
    expect(getBotLastReadAt(botGroupReadKey('g1'))).toBe(200);
    expect(scroll.scrollTop).toBe(0);
    expect(screen.getByRole('button', { name: 'chat.newMessageIndicator.aria' })).toBeTruthy();
    scroll.scrollTop = 900; fireEvent.scroll(scroll);
    expect(getBotLastReadAt(botGroupReadKey('g1'))).toBe(1200);
  } finally { focus.mockRestore(); resetBotReadStateForTests(); }
});

it('acknowledges a Bot’s plan card at the tail, the same range the unread badge counts', async () => {
  resetBotReadStateForTests();
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  markBotRead(botGroupReadKey('g1'), 100);
  mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(plan(), [], { messages: [
    msg({ id: 'b', authorKind: 'bot', content: 'First reply', createdAt: 200 }),
    { ...planCard, createdAt: 300 },
  ] }) });
  const view = renderView();
  try {
    await screen.findByTestId('bot-group-plan');
    act(() => window.dispatchEvent(new Event('focus')));
    expect(getBotLastReadAt(botGroupReadKey('g1'))).toBe(300);
  } finally { focus.mockRestore(); resetBotReadStateForTests(); view.unmount(); }
});

describe('Telegram / Slack-grade timeline', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }
  const push = (change: BotGroupChangedPayload['change'] = 'messages') =>
    act(async () => { mocks.pushes.forEach((listener) => listener({ groupId: 'g1', change })); });
  const own = (id: string, sequence: number, content: string, createdAt = 1_700_000_000_000) =>
    msg({ id, sequence, content, createdAt, isSelf: true });

  it('shows a sent message at once and swaps in main’s copy in place', async () => {
    const sent = deferred<{ ok: true; messageId: string }>();
    mocks.sendBotGroupMessage.mockReturnValue(sent.promise);
    renderView();
    const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '在吗' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('');
    const bubble = await screen.findByText('在吗');
    const row = bubble.closest('[data-bot-group-message-id]') as HTMLElement;
    expect(row.dataset.botGroupMessageId).toMatch(/^pending:/);
    expect(row.querySelector('article')?.getAttribute('aria-busy')).toBe('true');
    // The pending copy has no toolbar: it cannot be quoted, shared or answered yet.
    expect(within(row).queryByRole('button', { name: 'chat.messageActionBar.moreActions' })).toBeNull();
    const base = detail();
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: { ...base, messages: [...base.messages, own('u9', 5, '在吗')] } });
    await act(async () => sent.resolve({ ok: true, messageId: 'u9' }));
    await waitFor(() => expect(row.dataset.botGroupMessageId).toBe('u9'));
    // Same row element: no remount, no flash.
    expect(document.contains(row)).toBe(true);
    expect(screen.getAllByText('在吗')).toHaveLength(1);
  });

  it('takes the pending copy back and restores the draft when the send fails', async () => {
    mocks.sendBotGroupMessage.mockResolvedValue({ ok: false, errorCode: 'SERVICE_ERROR', message: '' });
    renderView();
    const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '没发出去' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe('没发出去'));
    expect(document.querySelector('[data-bot-group-message-id^="pending:"]')).toBeNull();
  });

  it('collapses pushes during a read into one follow-up read and shows every result', async () => {
    renderView();
    await screen.findByText('周六 8:10 有票');
    const first = deferred<{ ok: true; group: BotGroupDetail }>();
    const second = deferred<{ ok: true; group: BotGroupDetail }>();
    mocks.getBotGroup.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await push();
    await push();
    await push();
    // One read in flight; the later pushes wait for it instead of discarding it.
    expect(mocks.getBotGroup).toHaveBeenCalledTimes(2);
    const base = detail();
    await act(async () => first.resolve({ ok: true, group: { ...base, messages: [...base.messages, msg({ id: 'x1', sequence: 5, authorKind: 'bot', authorBotId: 'xiaoman', authorName: '小满', content: '第一条回复' })] } }));
    expect(screen.getByText('第一条回复')).toBeTruthy();
    await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(3));
    await act(async () => second.resolve({ ok: true, group: { ...base, messages: [...base.messages,
      msg({ id: 'x1', sequence: 5, authorKind: 'bot', authorBotId: 'xiaoman', authorName: '小满', content: '第一条回复' }),
      msg({ id: 'x2', sequence: 6, authorKind: 'bot', authorBotId: 'mimi', authorName: '咪咪', content: '第二条回复' })] } }));
    expect(screen.getByText('第一条回复')).toBeTruthy();
    expect(screen.getByText('第二条回复')).toBeTruthy();
    expect(mocks.getBotGroup).toHaveBeenCalledTimes(3);
  });

  it('keeps messages pushed out of the newest page on screen', async () => {
    const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) =>
      msg({ id: `r${from + index}`, sequence: from + index, authorKind: 'bot', authorBotId: 'xiaoman', authorName: '小满', content: `第${from + index}条` }));
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: rows(1, 3), hasMoreBefore: true }) });
    renderView();
    await screen.findByText('第1条');
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: rows(3, 5), hasMoreBefore: true }) });
    await push();
    await screen.findByText('第5条');
    expect(screen.getByText('第1条')).toBeTruthy();
    expect(screen.getByText('第2条')).toBeTruthy();
    // Older history is still offered above them.
    expect(screen.getByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' })).toBeTruthy();
  });

  it('merges consecutive messages by one author and divides days', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 30, 0, 0);
    const bot = (id: string, sequence: number, createdAt: number, content: string) =>
      msg({ id, sequence, createdAt, content, authorKind: 'bot', authorBotId: 'xiaoman', authorName: '小满' });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [
      bot('a', 1, yesterday.getTime(), '昨天第一条'),
      bot('b', 2, yesterday.getTime() + 60_000, '昨天第二条'),
      bot('c', 3, today.getTime(), '今天第一条'),
    ] }) });
    renderView();
    await screen.findByText('今天第一条');
    const article = (text: string) => screen.getByText(text).closest('article')!;
    expect(article('昨天第一条').querySelector('[data-avatar]')).toBeTruthy();
    expect(within(article('昨天第一条')).getByText('小满')).toBeTruthy();
    // The merged line has no avatar or name, only a time in its gutter.
    expect(article('昨天第二条').querySelector('[data-avatar]')).toBeNull();
    expect(within(article('昨天第二条')).queryByText('小满')).toBeNull();
    expect(article('昨天第二条').querySelector('time')).toBeTruthy();
    // A new day starts a new block under its own date line.
    expect(article('今天第一条').querySelector('[data-avatar]')).toBeTruthy();
    expect(screen.getAllByTestId('bot-group-date-divider')).toHaveLength(2);
  });

  it('keeps the unsent text with the group across a remount', async () => {
    let view = renderView();
    const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '写了一半的话\n第二行' } });
    view.unmount();
    view = renderView();
    expect(((await screen.findByRole('textbox')) as HTMLTextAreaElement).value).toBe('写了一半的话\n第二行');
    view.unmount();
    // Another group starts empty.
    mocks.groupId = 'g2';
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ id: 'g2' }) });
    renderView();
    expect(((await screen.findByRole('textbox')) as HTMLTextAreaElement).value).toBe('');
  });

  it('shows the organizer deciding about a split in the header and as a speaking line', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({
      speakingBotIds: ['mimi'],
      planningBotId: 'mimi',
      round: { status: 'running', speakers: [{ botId: 'mimi', sessionId: null, activity: 'planning' }], canContinue: false },
    }) });
    renderView();
    const row = await screen.findByTestId('bot-group-speaking');
    expect(row.getAttribute('data-activity')).toBe('planning');
    expect(row.textContent).toContain('咪咪');
    expect(row.textContent).toContain('bots.groupChat.speaking.planning');
    expect(screen.getByTestId('content-header').textContent).toContain('bots.groupChat.header.planning:咪咪');
  });

  it('does not pin the progress strip for an organizer still deciding about a split', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({
      speakingBotIds: ['mimi'],
      planningBotId: 'mimi',
      round: { status: 'running', speakers: [{ botId: 'mimi', sessionId: null, activity: 'planning' }], canContinue: false },
    }) });
    // Well past the few seconds after which a speaking teammate would pin the strip.
    mocks.activity = { compactDetail: '', startedAtMs: Date.now() - 5_000, phase: 'running' };
    try {
      renderView();
      const row = await screen.findByTestId('bot-group-speaking');
      expect(row.getAttribute('data-activity')).toBe('planning');
      expect(screen.queryByTestId('bot-group-progress')).toBeNull();
    } finally {
      mocks.activity = null;
    }
  });

  // bot-group-chat.md §7.0: a queue turn is someone speaking, not a numbered step with an empty task.
  it('labels a running queue turn as speaking in the progress strip', async () => {
    const turn = plan({
      status: 'running', currentStep: 0, kind: 'talk', updatedAt: Date.now() - 125_000,
      steps: [{ ...plan().steps[0]!, task: '', status: 'running' }, { ...plan().steps[1]!, task: '' }],
    });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(turn, [], {
      speakingBotIds: ['mimi'],
      round: { status: 'running', speakers: [{ botId: 'mimi', sessionId: 'plan-mimi', activity: 'step' }], canContinue: false },
    }) });
    renderView();
    const strip = await screen.findByTestId('bot-group-progress');
    expect(strip.textContent).toContain('phase:processing');
    expect(strip.textContent).not.toContain('bots.groupChat.progress.step');
  });

  it('pins a progress strip above the composer while a plan step runs', async () => {
    const running = plan({
      status: 'running',
      currentStep: 0,
      updatedAt: Date.now() - 125_000,
      steps: [{ ...plan().steps[0]!, status: 'running' }, plan().steps[1]!],
    });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(running, [], {
      speakingBotIds: ['mimi'],
      round: { status: 'running', speakers: [{ botId: 'mimi', sessionId: 'plan-mimi', activity: 'step', startedAt: Date.now() - 125_000 }], canContinue: false },
    }) });
    renderView();
    const strip = await screen.findByTestId('bot-group-progress');
    expect(strip.textContent).toContain('bots.groupChat.progress.step');
    expect(strip.textContent).toContain('想清楚这页讲什么');
    expect(strip.textContent).toContain('bots.groupChat.progress.elapsed');
    // The strip stands in for the step's speaking line; its confirmations stay in the timeline.
    expect(screen.queryByTestId('bot-group-speaking')).toBeNull();
    expect(screen.getByTestId('pending-interaction').textContent).toBe('plan-mimi');
    // It sits between the timeline and the composer.
    expect(strip.compareDocumentPosition(screen.getByRole('textbox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('content-header').textContent).toContain('bots.groupChat.header.stepRunning:咪咪');
    // The running step shows how long it has been going.
    expect(screen.getByTestId('bot-group-plan').textContent).toContain('bots.groupChat.elapsed.minutes');
    fireEvent.click(within(strip).getByRole('button', { name: 'bots.groupChat.progress.stop' }));
    await waitFor(() => expect(mocks.stopBotGroupRound).toHaveBeenCalledWith('g1'));
  });

  it('does not show the silence marker as the running step’s current action', async () => {
    const running = plan({
      status: 'running',
      currentStep: 0,
      steps: [{ ...plan().steps[0]!, status: 'running' }, plan().steps[1]!],
    });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(running, [], {
      speakingBotIds: ['mimi'],
      round: { status: 'running', speakers: [{ botId: 'mimi', sessionId: 'plan-mimi', activity: 'step' }], canContinue: false },
    }) });
    mocks.activity = { compactDetail: 'NO_REPLY', startedAtMs: Date.now() - 5_000, phase: 'running' };
    try {
      renderView();
      const strip = await screen.findByTestId('bot-group-progress');
      expect(strip.textContent).toContain('想清楚这页讲什么');
      expect(strip.textContent).not.toContain('NO_REPLY');
      mocks.activity = { compactDetail: '正在读 README.md', startedAtMs: Date.now() - 5_000, phase: 'running' };
      fireEvent.click(within(strip).getByRole('button', { name: 'bots.groupChat.progress.viewProcess' }));
      expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/plan-mimi');
      expect(mocks.stopBotGroupRound).not.toHaveBeenCalled();
    } finally {
      mocks.activity = null;
    }
  });

  it('highlights @mentions of members in teammates’ messages too', async () => {
    const registry = new Map<string, { ranges: Range[] }>();
    vi.stubGlobal('Highlight', class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } });
    const originalCss = globalThis.CSS;
    vi.stubGlobal('CSS', { ...(originalCss ?? {}), highlights: registry });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [
      msg({ id: 'u1', sequence: 1, content: '@小满 帮我查余票' }),
      msg({ id: 'b1', sequence: 2, authorKind: 'bot', authorBotId: 'xiaoman', authorName: '小满', content: '@咪咪 你来订 `@nobody`' }),
    ] }) });
    renderView();
    await screen.findByText('@小满 帮我查余票');
    await waitFor(() => expect(registry.get('bot-group-mention')?.ranges.map((range) => range.toString()).sort()).toEqual(['@咪咪', '@小满']));
  });

  it('shows a 话题 reply at once and keeps one copy when the server’s reply arrives', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const sent = deferred<{ ok: true; messageId: string }>();
    const reply = vi.fn(() => sent.promise);
    Object.assign((window.electronAPI as unknown as { maker: { chatServer: Record<string, unknown> } }).maker.chatServer, { reply });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    const user = userEvent.setup();
    renderView();
    await user.click((await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!);
    const panel = screen.getByRole('complementary');
    await within(panel).findByText('Reply to u1');
    const input = within(panel).getByRole('textbox') as HTMLTextAreaElement;
    await user.type(input, '我也去{Enter}');
    expect(input.value).toBe('');
    expect(within(panel).getByText('我也去')).toBeTruthy();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'g1', rootId: 'u1', text: '我也去' }));
    mocks.thread.mockResolvedValue({ ok: true, root: msg({ id: 'u1', content: 'Thread root u1' }),
      replies: [msg({ id: 'reply-u1', content: 'Reply to u1' }), msg({ id: 'r9', sequence: 2, content: '我也去', isSelf: true })], hasMore: false });
    await act(async () => sent.resolve({ ok: true, messageId: 'r9' }));
    await waitFor(() => expect(panel.querySelector('[data-bot-group-message-id="r9"]')).toBeTruthy());
    expect(within(panel).getAllByText('我也去')).toHaveLength(1);
  });
});

describe('thread previews and posting to the main chat', () => {
  afterEach(() => { mocks.ownerGeneration = { dataOwnerId: 'account-a', generation: 1 }; });
  const t = (name: string) => `bots.groupChat.server.thread.${name}`;
  const preview = (id: string, authorName: string, text: string, extra: Record<string, unknown> = {}) => ({
    id, authorKind: 'bot' as const, authorBotId: 'xiaoman', authorName, text, attachments: [], createdAt: 1_700_000_000_000, ...extra });
  const share = (overrides: Partial<NonNullable<BotGroupMessageView['threadShare']>> = {}): NonNullable<BotGroupMessageView['threadShare']> => ({
    messageId: 'reply-u1', threadRootId: 'u1', status: 'available', authorKind: 'bot', authorBotId: 'xiaoman', authorName: '小满',
    sharedByAuthor: false, content: '原话：@咪咪 周六见', attachments: [], createdAt: 1_700_000_000_000, edited: false, ...overrides });
  function group(messages: BotGroupMessageView[]) {
    return detail({ serverBacked: true, messages });
  }
  beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });

  // Unit: opening a downloaded topic must show it before IPC completes; a permission
  // failure must erase that preview. Existing tests never reopened with a pending read.
  it('shows a reopened topic immediately and clears its cached replies when access is revoked', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true, historyRevision: 'topic-warm' }) });
    const value = { ok: true, historyRevision: 'topic-warm', root: msg({ id: 'u1', content: 'Root' }),
      replies: [msg({ id: 'r1', content: 'Cached topic reply' })], hasMore: false };
    mocks.thread.mockResolvedValue(value);
    const user = userEvent.setup(); renderView();
    await user.click((await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!);
    await within(screen.getByRole('complementary')).findByText('Cached topic reply');
    await user.keyboard('{Escape}');
    let finish!: (result: unknown) => void;
    mocks.thread.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await user.click((await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!);
    expect(within(screen.getByRole('complementary')).getByText('Cached topic reply')).toBeTruthy();
    await act(async () => finish({ ok: false, errorCode: 'NOT_MEMBER' }));
    expect(screen.queryByText('Cached topic reply')).toBeNull();
    await user.keyboard('{Escape}');
    await user.click((await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!);
    expect(screen.queryByText('Cached topic reply')).toBeNull();
  });

  it('repairs loaded topic history and rejects an old page after a room generation reset', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    const root = msg({ id: 'u1', content: 'Root' });
    const latest = msg({ id: 'r100', sequence: 100, content: 'Latest reply' });
    const old = msg({ id: 'r50', sequence: 50, content: 'Old reply' });
    const value = { ok: true, historyRevision: 'topic-before', root, replies: [latest], hasMore: true };
    mocks.thread.mockResolvedValueOnce(value).mockResolvedValueOnce({ ...value, replies: [old] });
    const user = userEvent.setup(); renderView();
    await user.click((await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!);
    const panel = screen.getByRole('complementary');
    await within(panel).findByText('Latest reply');
    await user.click(within(panel).getByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await within(panel).findByText('Old reply');
    mocks.thread.mockResolvedValue({ ...value, messageUpdates: [{ ...old, content: 'Edited old reply' }] });
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    await within(panel).findByText('Edited old reply');
    let finish!: (result: unknown) => void;
    mocks.thread.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ ...value, historyRevision: 'topic-after', replies: [{ ...latest, content: 'New history reply' }], hasMore: false });
    await user.click(within(panel).getByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    await within(panel).findByText('New history reply');
    await act(async () => finish({ ...value, replies: [msg({ id: 'r1', sequence: 1, content: 'Revoked reply' })] }));
    expect(within(panel).queryByText('Edited old reply')).toBeNull();
    expect(within(panel).queryByText('Revoked reply')).toBeNull();
    expect(within(panel).queryByText('Latest reply')).toBeNull();
  });

  // Unit, PR #7396: topic pagination was tested for history resets, but not failure
  // snapshots overtaken by a latest-page refresh. Newly added replies still need
  // their own notices, without restoring a cleared notice on an already shown source.
  it('keeps failures for newly loaded topic replies when a newer refresh overtakes pagination', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    const root = msg({ id: 'u1', content: 'Root' });
    const latest = msg({ id: 'r100', sequence: 100, content: 'Latest reply' });
    const older = msg({ id: 'r50', sequence: 50, content: 'Earlier reply' });
    const failure = (source: string, name: string) => ({ executionId: `failure-${source}`, epoch: 1,
      sourceMessageId: source, botId: name, botName: name, code: 'AUTH_REQUIRED' as const, planId: null });
    const rootFailure = failure(root.id, 'Root bot');
    const latestFailure = failure(latest.id, 'Latest bot');
    const olderFailure = failure(older.id, 'Earlier bot');
    const page = { ok: true, historyRevision: 'topic-failures', root, replies: [latest], hasMore: true };
    let finishOlder!: (value: unknown) => void;
    let finishRecheck!: (value: unknown) => void;
    mocks.thread.mockResolvedValueOnce({ ...page, executionFailures: [rootFailure] })
      .mockImplementationOnce(() => new Promise(resolve => { finishOlder = resolve; }))
      .mockResolvedValueOnce({ ...page, executionFailures: [latestFailure] })
      .mockImplementation(() => new Promise(resolve => { finishRecheck = resolve; }));
    const user = userEvent.setup(); renderView();
    await user.click((await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!);
    const panel = screen.getByRole('complementary');
    await within(panel).findByText('Latest reply');
    await user.click(within(panel).getByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    await within(panel).findByText('bots.groupChat.notice.runtimeFailure.AUTH_REQUIRED:Latest bot');
    await act(async () => finishOlder({ ...page, replies: [older], executionFailures: [olderFailure, rootFailure] }));
    expect(within(panel).getByText('Earlier reply')).toBeTruthy();
    expect(within(panel).getByText('bots.groupChat.notice.runtimeFailure.AUTH_REQUIRED:Earlier bot')).toBeTruthy();
    expect(within(panel).getByText('bots.groupChat.notice.runtimeFailure.AUTH_REQUIRED:Latest bot')).toBeTruthy();
    expect(within(panel).queryByText('bots.groupChat.notice.runtimeFailure.AUTH_REQUIRED:Root bot')).toBeNull();
    expect(mocks.thread.mock.calls.at(-1)?.[0].sourceMessageIds).toContain(older.id);
    // The extra reconciliation is scoped to newly visible sources and can clear their old notice.
    await act(async () => finishRecheck({ ...page, executionFailures: [latestFailure] }));
    expect(within(panel).queryByText('bots.groupChat.notice.runtimeFailure.AUTH_REQUIRED:Earlier bot')).toBeNull();
    expect(within(panel).getByText('Earlier reply')).toBeTruthy();
  });

  // Unit: a reset discovered by pagination must clear even the latest page while
  // its replacement is in flight, instead of displaying a mixed history window.
  it('clears the topic window when an older page first discovers a history reset', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true }) });
    const value = { ok: true, historyRevision: 'before-pagination', root: msg({ id: 'u1', content: 'Old root' }),
      replies: [msg({ id: 'r100', sequence: 100, content: 'Old visible reply' })], hasMore: true };
    let finish!: (result: unknown) => void;
    mocks.thread.mockResolvedValueOnce(value).mockResolvedValueOnce({ ...value, historyRevision: 'after-pagination', replies: [] })
      .mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const user = userEvent.setup(); renderView();
    await user.click((await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!);
    const panel = screen.getByRole('complementary');
    await within(panel).findByText('Old visible reply');
    await user.click(within(panel).getByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(within(panel).queryByText('Old root')).toBeNull();
    expect(within(panel).queryByText('Old visible reply')).toBeNull();
    await act(async () => finish({ ...value, historyRevision: 'after-pagination', root: msg({ content: 'New root' }),
      replies: [], hasMore: false }));
    expect(within(panel).getByText('New root')).toBeTruthy();
  });

  // Unit: two owners may open the same room/root; display caching must not cross login boundaries.
  it('never restores another account’s warm topic window', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true, historyRevision: 'same-room' }) });
    mocks.thread.mockResolvedValue({ ok: true, historyRevision: 'same-room', root: msg({ id: 'u1' }),
      replies: [msg({ id: 'r1', content: 'Account A reply' })], hasMore: false });
    const user = userEvent.setup(); const view = renderView();
    await user.click((await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!);
    await within(screen.getByRole('complementary')).findByText('Account A reply');
    view.unmount();
    mocks.ownerGeneration = { dataOwnerId: 'account-b', generation: 2 };
    mocks.thread.mockImplementation(() => new Promise(() => {}));
    renderView();
    await user.click((await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!);
    expect(within(screen.getByRole('complementary')).queryByText('Account A reply')).toBeNull();
  });

  it('describes the newest replies on the thread entry under the root and opens the thread from it', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: group([
      msg({ id: 'u1', content: '去哪玩', replyCount: 3, threadPreview: { replies: [
        preview('r2', '小满', '爬山吧，带上相机'),
        preview('r3', '咪咪', '', { attachments: [{ name: 'map.png', category: 'image' }, { name: 'list.pdf', category: 'file' }] }),
      ] } }),
    ]) });
    const user = userEvent.setup();
    renderView();
    const card = await screen.findByRole('button', { name: t('open') });
    // The entry shows the count; the newest replies are read out as its description, not shown.
    const description = document.getElementById(card.getAttribute('aria-describedby')!)!;
    expect(description.className).toContain('sr-only');
    expect(description.textContent).toContain('小满');
    expect(description.textContent).toContain('爬山吧，带上相机');
    // An attachment-only reply still says what it carried.
    expect(description.textContent).toContain(t('attachmentsSummary'));
    expect(card.textContent).toContain('bots.groupChat.server.replyCount');
    // Export the selected root, without its independently selectable thread replies.
    const exported = prepareShareMessageClone(card.closest('article')!)!;
    expect(exported.textContent).toContain('去哪玩');
    expect(exported.textContent).not.toContain('爬山吧，带上相机');
    expect(exported.textContent).not.toContain('map.png');
    expect(exported.querySelector('[data-thread-preview]')).toBeNull();
    // The count lives in the preview; the toolbar keeps a plain reply icon.
    const toolbarReply = screen.getByRole('button', { name: 'bots.groupChat.server.openTopic' });
    expect(toolbarReply.textContent).toBe('');
    await user.click(card);
    expect(await screen.findByRole('complementary')).toBeTruthy();
    expect(mocks.thread).toHaveBeenCalledWith(expect.objectContaining({ rootId: 'u1' }));
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(card);
  });

  it('keeps the original author and the sharer apart, and jumps from a share to its reply', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: group([
      msg({ id: 'u1', content: '去哪玩' }),
      msg({ id: 's-other', sequence: 2, authorKind: 'user', isSelf: false, authorName: 'Alice', content: '↪ 小满: fallback', threadShare: share() }),
      msg({ id: 's-own', sequence: 3, content: '↪ 我: fallback', threadShare: share({ messageId: 'reply-u1', authorKind: 'user', authorBotId: null, authorName: '我', sharedByAuthor: true, content: '我自己的回复' }) }),
      msg({ id: 's-gone', sequence: 4, authorKind: 'user', isSelf: false, authorName: 'Alice', content: '↪ x: fallback', threadShare: share({ status: 'unavailable', authorName: '', content: '' }) }),
    ]) });
    const user = userEvent.setup();
    renderView();
    const other = (await screen.findByText(`${t('sharedReplyFrom')}:小满`)).closest('article')!;
    expect(within(other).getByText('Alice')).toBeTruthy();
    expect(within(other).getByText('原话：@咪咪 周六见')).toBeTruthy();
    expect(within(other).queryByText('↪ 小满: fallback')).toBeNull();
    // A selected share keeps the quoted reply and authors, but not navigation controls.
    const exported = prepareShareMessageClone(other)!;
    expect(exported.textContent).toContain('Alice');
    expect(exported.textContent).toContain('小满');
    expect(exported.textContent).toContain('原话：@咪咪 周六见');
    expect(exported.textContent).not.toContain(t('viewThread'));
    const own = screen.getByText(t('alsoSent')).closest('article')!;
    expect(within(own).getByText('我自己的回复')).toBeTruthy();
    expect(screen.getByText(t('sourceUnavailable'))).toBeTruthy();
    // An unverified card's own thread ID leads nowhere.
    const gone = screen.getByText(t('sourceUnavailable')).closest('article')!;
    expect(within(gone).queryByRole('button', { name: t('viewThread') })).toBeNull();
    await user.click(within(other).getByRole('button', { name: t('viewThread') }));
    const panel = await screen.findByRole('complementary');
    await waitFor(() => expect(within(panel).getByText('Reply to u1').closest('article')!.className).toContain('ring-2'));
    // The reply is already in the main chat: say so and lead back to it.
    expect(within(panel).getByRole('button', { name: t('postedBySelf') })).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: t('postedBySelf') }));
    expect(own.className).toContain('ring-2');
  });

  it('sends to the thread only by default, and to both places when asked', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: group([msg({ id: 'u1', content: '去哪玩' })]) });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.server.startTopic' }));
    const panel = await screen.findByRole('complementary');
    const toggle = within(panel).getByRole('checkbox', { name: t('alsoSend') });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.type(within(panel).getByRole('textbox'), 'thread only{Enter}');
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(1));
    expect(mocks.shareToMain).not.toHaveBeenCalled();
    await user.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    mocks.reply.mockResolvedValueOnce({ ok: true, messageId: 'reply-2' });
    await user.type(within(panel).getByRole('textbox'), '@咪咪 both{Enter}');
    await waitFor(() => expect(mocks.shareToMain).toHaveBeenCalledWith({ groupId: 'g1', messageId: 'reply-2' }));
    expect(mocks.reply).toHaveBeenCalledTimes(2);
    expect(mocks.reply.mock.calls[1][0]).toMatchObject({ rootId: 'u1', text: '@咪咪 both' });
    // Each send starts from the default again.
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  });

  it('retries only the main-chat copy after the reply already reached the thread', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: group([msg({ id: 'u1', content: '去哪玩' })]) });
    mocks.shareToMain.mockResolvedValueOnce({ ok: false, errorCode: 'SERVICE_ERROR' });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.server.startTopic' }));
    const panel = await screen.findByRole('complementary');
    await user.click(within(panel).getByRole('checkbox', { name: t('alsoSend') }));
    await user.type(within(panel).getByRole('textbox'), 'both{Enter}');
    const retry = await within(panel).findByRole('button', { name: t('retryPost') });
    // A thread refresh must not hide the retry.
    act(() => { for (const push of mocks.pushes) push({ groupId: 'g1', change: 'messages' }); });
    await waitFor(() => expect(mocks.thread.mock.calls.length).toBeGreaterThan(1));
    expect(within(panel).getByText(t('alsoSendFailed'))).toBeTruthy();
    await user.click(retry);
    await waitFor(() => expect(within(panel).queryByRole('button', { name: t('retryPost') })).toBeNull());
    expect(mocks.shareToMain.mock.calls).toEqual([[{ groupId: 'g1', messageId: 'new-reply' }], [{ groupId: 'g1', messageId: 'new-reply' }]]);
    expect(mocks.reply).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('drops an unavailable main-chat copy and reports why (after transient failure: %s)', async retrying => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: group([msg({ id: 'u1', content: '去哪玩' })]) });
    if (retrying) mocks.shareToMain.mockResolvedValueOnce({ ok: false, errorCode: 'SERVICE_ERROR' });
    mocks.shareToMain.mockResolvedValueOnce({ ok: false, errorCode: 'SHARE_UNAVAILABLE' });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.server.startTopic' }));
    const panel = await screen.findByRole('complementary');
    await user.click(within(panel).getByRole('checkbox', { name: t('alsoSend') }));
    await user.type(within(panel).getByRole('textbox'), 'both{Enter}');
    if (retrying) await user.click(await within(panel).findByRole('button', { name: t('retryPost') }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t('shareUnavailable')));
    expect(within(panel).queryByRole('button', { name: t('retryPost') })).toBeNull();
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(mocks.shareToMain).toHaveBeenCalledTimes(retrying ? 2 : 1);
  });

  it('keeps one send identity across a failed reply and never posts to the main chat before it lands', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: group([msg({ id: 'u1', content: '去哪玩' })]) });
    mocks.reply.mockResolvedValueOnce({ ok: false, errorCode: 'SERVICE_ERROR' });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.server.startTopic' }));
    const panel = await screen.findByRole('complementary');
    await user.click(within(panel).getByRole('checkbox', { name: t('alsoSend') }));
    await user.type(within(panel).getByRole('textbox'), 'both{Enter}');
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(1));
    expect(mocks.shareToMain).not.toHaveBeenCalled();
    expect(within(panel).getByRole('checkbox', { name: t('alsoSend') }).getAttribute('aria-checked')).toBe('true');
    await user.click(within(panel).getByRole('button', { name: 'bots.groupChat.server.sendReply' }));
    await waitFor(() => expect(mocks.shareToMain).toHaveBeenCalledTimes(1));
    expect(mocks.reply.mock.calls[1][0].clientId).toBe(mocks.reply.mock.calls[0][0].clientId);
  });

  it('does not carry the choice into another thread', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: group([msg({ id: 'u1', content: 'A' }), msg({ id: 'u2', sequence: 2, content: 'B' })]) });
    const user = userEvent.setup();
    renderView();
    const [first, second] = await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' });
    await user.click(first!);
    await user.click(within(await screen.findByRole('complementary')).getByRole('checkbox', { name: t('alsoSend') }));
    await user.click(second!);
    await screen.findByText('Reply to u2');
    expect(within(screen.getByRole('complementary')).getByRole('checkbox', { name: t('alsoSend') }).getAttribute('aria-checked')).toBe('false');
  });

  it('posts an existing reply, including someone else’s, from its menu', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: group([msg({ id: 'u1', content: '去哪玩' })]) });
    mocks.thread.mockResolvedValue({ ok: true, root: msg({ id: 'u1', content: '去哪玩' }), hasMore: false,
      replies: [msg({ id: 'alice-reply', authorKind: 'user', isSelf: false, authorName: 'Alice', content: 'Alice says hi' })] });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.server.startTopic' }));
    const reply = (await within(await screen.findByRole('complementary')).findByText('Alice says hi')).closest('article')!;
    fireEvent.pointerDown(within(reply).getByRole('button', { name: 'chat.messageActionBar.moreActions' }), { button: 0, ctrlKey: false });
    await user.click(await screen.findByRole('menuitem', { name: t('postToMain') }));
    expect(mocks.shareToMain).toHaveBeenCalledWith({ groupId: 'g1', messageId: 'alice-reply' });
    expect(await within(reply).findByRole('button', { name: t('postedBySelf') })).toBeTruthy();
    expect(mocks.reply).not.toHaveBeenCalled();
  });
});

describe('thread share follow-ups', () => {
  const t = (name: string) => `bots.groupChat.server.thread.${name}`;
  const share = (overrides: Partial<NonNullable<BotGroupMessageView['threadShare']>> = {}): NonNullable<BotGroupMessageView['threadShare']> => ({
    messageId: 'reply-x', threadRootId: 'u1', status: 'available', authorKind: 'bot', authorBotId: 'xiaoman', authorName: '小满',
    sharedByAuthor: false, content: '服务器上的原文', attachments: [], createdAt: 1_700_000_000_000, edited: false, ...overrides });
  beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });

  it('shows a loading placeholder, never the card text, while the reply is read', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true, messages: [
      msg({ id: 's1', authorKind: 'user', isSelf: false, authorName: 'Alice', content: '↪ 冒充: 卡片文字', threadShare: share({ status: 'loading', authorName: '', content: '' }) }),
    ] }) });
    renderView();
    expect(await screen.findByText(t('loadingSource'))).toBeTruthy();
    expect(screen.queryByText('↪ 冒充: 卡片文字')).toBeNull();
  });

  it.each(['unavailable', 'available'] as const)('keeps a %s share as a quote when it is the thread root', async status => {
    const root = msg({ id: 's1', authorKind: 'user', isSelf: false, authorName: 'Alice', content: '↪ 冒充: 卡片文字', replyCount: 1,
      threadShare: share(status === 'available'
        ? { attachments: [{ id: 'f1', name: '路线.pdf', category: 'file', mimeType: 'application/pdf', size: 1, url: null, path: '/tmp/路线.pdf' }] }
        : { status: 'unavailable', authorName: '', content: '' }) });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true, messages: [root] }) });
    mocks.thread.mockResolvedValue({ ok: true, root, replies: [], hasMore: false });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.server.openTopic' }));
    const panel = await screen.findByRole('complementary');
    await waitFor(() => expect(within(panel).getAllByRole('figure').length).toBe(1));
    expect(within(panel).queryByText('↪ 冒充: 卡片文字')).toBeNull();
    if (status === 'available') {
      expect(within(panel).getByText('服务器上的原文')).toBeTruthy();
      expect(within(panel).getByText('路线.pdf')).toBeTruthy();
    } else expect(within(panel).getByText(t('sourceUnavailable'))).toBeTruthy();
  });

  it('keeps the share it got back and says when that share is on an older page', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true, messages: [msg({ id: 'u1', content: '去哪玩' })] }) });
    mocks.thread.mockResolvedValue({ ok: true, root: msg({ id: 'u1', content: '去哪玩' }), hasMore: false,
      replies: [msg({ id: 'alice-reply', authorKind: 'user', isSelf: false, authorName: 'Alice', content: 'Alice says hi' })] });
    mocks.shareToMain.mockResolvedValue({ ok: true, messageId: 'old-share', alreadyShared: false });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.server.startTopic' }));
    const reply = (await within(await screen.findByRole('complementary')).findByText('Alice says hi')).closest('article')!;
    fireEvent.pointerDown(within(reply).getByRole('button', { name: 'chat.messageActionBar.moreActions' }), { button: 0, ctrlKey: false });
    await user.click(await screen.findByRole('menuitem', { name: t('postToMain') }));
    const badge = await within(reply).findByRole('button', { name: t('postedBySelf') });
    expect((badge as HTMLButtonElement).disabled).toBe(false);
    await user.click(badge);
    expect(mocks.toastInfo).toHaveBeenCalledWith(t('shareNotLoaded'));
    fireEvent.pointerDown(within(reply).getByRole('button', { name: 'chat.messageActionBar.moreActions' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: t('viewInMain') })).toBeTruthy();
  });

  it('stops offering to post a reply whose existing share cannot be located', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true, messages: [msg({ id: 'u1', content: '去哪玩' })] }) });
    mocks.thread.mockResolvedValue({ ok: true, root: msg({ id: 'u1', content: '去哪玩' }), hasMore: false,
      replies: [msg({ id: 'alice-reply', authorKind: 'user', isSelf: false, authorName: 'Alice', content: 'Alice says hi' })] });
    // The server already has this person's share but could not say which message it is.
    mocks.shareToMain.mockResolvedValue({ ok: true, messageId: null, alreadyShared: true });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.server.startTopic' }));
    const reply = (await within(await screen.findByRole('complementary')).findByText('Alice says hi')).closest('article')!;
    fireEvent.pointerDown(within(reply).getByRole('button', { name: 'chat.messageActionBar.moreActions' }), { button: 0, ctrlKey: false });
    await user.click(await screen.findByRole('menuitem', { name: t('postToMain') }));
    const badge = await within(reply).findByRole('button', { name: t('postedBySelf') });
    expect((badge as HTMLButtonElement).disabled).toBe(true);
    // With nothing else to offer for this reply, the menu itself may be gone.
    const more = within(reply).queryByRole('button', { name: 'chat.messageActionBar.moreActions' });
    if (more) {
      fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
      await screen.findAllByRole('menuitem');
    }
    expect(screen.queryByRole('menuitem', { name: t('postToMain') })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: t('viewInMain') })).toBeNull();
    expect(mocks.shareToMain).toHaveBeenCalledTimes(1);
  });

  it("shows the reader's own share over another member's that the main chat has loaded", async () => {
    const bobShare = msg({ id: 'bob-share', sequence: 2, authorKind: 'user', isSelf: false, authorBotId: 'bob', authorName: 'Bob', content: '↪ 卡片',
      threadShare: { messageId: 'alice-reply', threadRootId: 'u1', status: 'available', authorKind: 'user', authorBotId: null, authorName: 'Alice',
        sharedByAuthor: false, content: 'Alice says hi', attachments: [], createdAt: 1, edited: false } });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true, messages: [msg({ id: 'u1', content: '去哪玩' }), bobShare] }) });
    mocks.thread.mockResolvedValue({ ok: true, root: msg({ id: 'u1', content: '去哪玩' }), hasMore: false,
      replies: [msg({ id: 'alice-reply', authorKind: 'user', isSelf: false, authorName: 'Alice', content: 'Alice says hi' })] });
    // The reader's earlier share of the same reply sits on a page the main chat has not loaded.
    mocks.shareToMain.mockResolvedValue({ ok: true, messageId: 'my-old-share', alreadyShared: true });
    const user = userEvent.setup();
    renderView();
    await user.click((await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!);
    const panel = await screen.findByRole('complementary');
    const reply = (await within(panel).findByText('Alice says hi')).closest('article')!;
    expect(await within(reply).findByRole('button', { name: t('postedToMain') })).toBeTruthy();
    fireEvent.pointerDown(within(reply).getByRole('button', { name: 'chat.messageActionBar.moreActions' }), { button: 0, ctrlKey: false });
    await user.click(await screen.findByRole('menuitem', { name: t('postToMain') }));
    expect(await within(reply).findByRole('button', { name: t('postedBySelf') })).toBeTruthy();
    fireEvent.pointerDown(within(reply).getByRole('button', { name: 'chat.messageActionBar.moreActions' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: t('viewInMain') })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: t('postToMain') })).toBeNull();
  });

  it('does not count a share the server could not resolve in its claimed thread as posted', async () => {
    // The reader's own card names the right reply but the wrong thread, so it resolved as unavailable.
    const misplaced = msg({ id: 'my-bad-share', sequence: 2, content: '↪ 卡片',
      threadShare: share({ messageId: 'alice-reply', threadRootId: 'elsewhere', status: 'unavailable', authorName: '', content: '' }) });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true, messages: [msg({ id: 'u1', content: '去哪玩' }), misplaced] }) });
    mocks.thread.mockResolvedValue({ ok: true, root: msg({ id: 'u1', content: '去哪玩' }), hasMore: false,
      replies: [msg({ id: 'alice-reply', authorKind: 'user', isSelf: false, authorName: 'Alice', content: 'Alice says hi' })] });
    const user = userEvent.setup();
    renderView();
    await user.click((await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' }))[0]!);
    const reply = (await within(await screen.findByRole('complementary')).findByText('Alice says hi')).closest('article')!;
    expect(within(reply).queryByRole('button', { name: t('postedBySelf') })).toBeNull();
    expect(within(reply).queryByRole('button', { name: t('postedToMain') })).toBeNull();
    fireEvent.pointerDown(within(reply).getByRole('button', { name: 'chat.messageActionBar.moreActions' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: t('postToMain') })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: t('viewInMain') })).toBeNull();
  });

  it('keeps every failed main-chat copy retryable, across switching threads', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true, messages: [msg({ id: 'u1', content: 'A' }), msg({ id: 'u2', sequence: 2, content: 'B' })] }) });
    mocks.reply.mockResolvedValueOnce({ ok: true, messageId: 'first' }).mockResolvedValueOnce({ ok: true, messageId: 'second' });
    mocks.shareToMain.mockResolvedValue({ ok: false, errorCode: 'SERVICE_ERROR' });
    const user = userEvent.setup();
    renderView();
    const [first, second] = await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' });
    await user.click(first!);
    let panel = await screen.findByRole('complementary');
    for (const text of ['one', 'two']) {
      await user.click(within(panel).getByRole('checkbox', { name: t('alsoSend') }));
      await user.type(within(panel).getByRole('textbox'), `${text}{Enter}`);
      await waitFor(() => expect(mocks.shareToMain).toHaveBeenCalledWith({ groupId: 'g1', messageId: text === 'one' ? 'first' : 'second' }));
    }
    await within(panel).findByRole('button', { name: t('retryPost') });
    await user.click(second!);
    await screen.findByText('Reply to u2');
    expect(within(screen.getByRole('complementary')).queryByRole('button', { name: t('retryPost') })).toBeNull();
    await user.click(first!);
    panel = await screen.findByRole('complementary');
    const retry = await within(panel).findByRole('button', { name: t('retryPost') });
    mocks.shareToMain.mockClear().mockResolvedValue({ ok: true, messageId: 'share', alreadyShared: false });
    await user.click(retry);
    await waitFor(() => expect(within(panel).queryByRole('button', { name: t('retryPost') })).toBeNull());
    expect(mocks.shareToMain.mock.calls.map(([input]) => input.messageId)).toEqual(['first', 'second']);
    expect(mocks.reply).toHaveBeenCalledTimes(2);
  });

  // The copy fails while the reader is in another thread, or after they came back to this one.
  it.each(['away', 'back'] as const)('keeps a main-chat copy retryable when it fails after leaving the thread (reader %s)', async (where) => {
    // The queue outlives a panel by design, so each case uses threads of its own.
    const [rootA, rootB] = [`${where}-a`, `${where}-b`];
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true, messages: [msg({ id: rootA, content: 'A' }), msg({ id: rootB, sequence: 2, content: 'B' })] }) });
    mocks.reply.mockResolvedValue({ ok: true, messageId: 'first' });
    let fail!: () => void;
    mocks.shareToMain.mockReturnValueOnce(new Promise(resolve => { fail = () => resolve({ ok: false, errorCode: 'SERVICE_ERROR' }); }));
    const user = userEvent.setup();
    renderView();
    const [first, second] = await screen.findAllByRole('button', { name: 'bots.groupChat.server.startTopic' });
    await user.click(first!);
    const panel = await screen.findByRole('complementary');
    await user.click(within(panel).getByRole('checkbox', { name: t('alsoSend') }));
    await user.type(within(panel).getByRole('textbox'), 'one{Enter}');
    await waitFor(() => expect(mocks.shareToMain).toHaveBeenCalledTimes(1));
    // The copy is still on its way when the reader moves to another thread.
    await user.click(second!);
    await screen.findByText(`Reply to ${rootB}`);
    if (where === 'away') await act(async () => fail());
    await user.click(first!);
    const reopened = await screen.findByRole('complementary');
    await within(reopened).findByText(`Reply to ${rootA}`);
    if (where === 'back') {
      expect(within(reopened).queryByRole('button', { name: t('retryPost') })).toBeNull();
      await act(async () => fail());
    }
    expect(await within(reopened).findByRole('button', { name: t('retryPost') })).toBeTruthy();
  });
});

describe('shares on older pages', () => {
  const t = (name: string) => `bots.groupChat.server.thread.${name}`;
  beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });

  it('follows the reply after an edit or deletion without a click or reopen', async () => {
    const oldShare = msg({ id: 'old-share', sequence: 1, authorKind: 'user', isSelf: false, authorBotId: 'alice-actor', authorName: 'Alice', content: '↪ 冒充: 卡片文字',
      threadShare: { messageId: 'old-reply', threadRootId: 'old-root', status: 'available', authorKind: 'bot', authorBotId: 'xiaoman', authorName: '小满',
        sharedByAuthor: false, content: '加载时的原文', attachments: [], createdAt: 1, edited: false } });
    const latest = detail({ serverBacked: true, hasMoreBefore: true, messages: [msg({ id: 'new', sequence: 50, content: '最新' })] });
    mocks.getBotGroup
      .mockResolvedValueOnce({ ok: true, group: latest })
      .mockResolvedValueOnce({ ok: true, group: { ...latest, hasMoreBefore: false, messages: [oldShare] } })
      .mockResolvedValue({ ok: true, group: { ...latest, threadShareUpdates: { 'old-share': { ...oldShare.threadShare!, status: 'unavailable', authorName: '', content: '' } } } });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    expect(await screen.findByText('加载时的原文')).toBeTruthy();
    act(() => { for (const push of mocks.pushes) push({ groupId: 'g1', change: 'messages' }); });
    expect(await screen.findByText(t('sourceUnavailable'))).toBeTruthy();
    expect(screen.queryByText('加载时的原文')).toBeNull();
    expect(screen.queryByText('↪ 冒充: 卡片文字')).toBeNull();
    expect(mocks.getBotGroup).toHaveBeenLastCalledWith('g1', expect.objectContaining({
      shownShares: [{ id: 'old-share', messageId: 'old-reply', threadRootId: 'old-root', sharerId: 'alice-actor' }] }));
  });

  // The reply is edited while an older page is on its way; either read may land first.
  it.each(['refresh', 'page'] as const)('checks the shares of an older page that races an edit refresh (%s lands first)', async (first) => {
    const share = { messageId: 'old-reply', threadRootId: 'old-root', status: 'available' as const, authorKind: 'bot' as const, authorBotId: 'xiaoman', authorName: '小满',
      sharedByAuthor: false, content: '编辑前的原文', attachments: [], createdAt: 1, edited: false, version: 1 };
    const oldShare = msg({ id: 'old-share', sequence: 1, authorKind: 'user', isSelf: false, authorBotId: 'alice-actor', authorName: 'Alice', content: '↪ 卡片文字', threadShare: share });
    const latest = detail({ serverBacked: true, hasMoreBefore: true, threadShareVersion: 1, messages: [msg({ id: 'new', sequence: 50, content: '最新' })] });
    let finishPage!: (result: { ok: true; group: BotGroupDetail }) => void;
    let finishRefresh!: (result: { ok: true; group: BotGroupDetail }) => void;
    mocks.getBotGroup
      .mockResolvedValueOnce({ ok: true, group: latest })
      .mockReturnValueOnce(new Promise(resolve => { finishPage = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { finishRefresh = resolve; }))
      .mockImplementation(async (_groupId: string, options?: { shownShares?: Array<{ id: string }> }) => ({ ok: true, group: { ...latest, threadShareVersion: 2,
        ...(options?.shownShares?.some(item => item.id === 'old-share')
          ? { threadShareUpdates: { 'old-share': { ...share, content: '编辑后的原文', edited: true, version: 2 } } } : {}) } }));
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(3));
    const page = () => finishPage({ ok: true, group: { ...latest, hasMoreBefore: false, messages: [oldShare] } });
    const refresh = () => finishRefresh({ ok: true, group: { ...latest, threadShareVersion: 2 } });
    for (const land of first === 'refresh' ? [refresh, page] : [page, refresh]) await act(async () => land());
    expect(await screen.findByText('编辑后的原文')).toBeTruthy();
    expect(screen.queryByText('编辑前的原文')).toBeNull();
  });

  it('checks each new version once without looping when a source cannot be confirmed', async () => {
    const share = { messageId: 'old-reply', threadRootId: 'old-root', status: 'available' as const, authorKind: 'bot' as const, authorBotId: 'xiaoman', authorName: '小满',
      sharedByAuthor: false, content: '原文', attachments: [], createdAt: 1, edited: false, version: 1 };
    const oldShare = msg({ id: 'old-share', sequence: 1, authorKind: 'user', isSelf: false, authorBotId: 'alice-actor', authorName: 'Alice', content: '↪ 卡片文字', threadShare: share });
    let version = 1;
    // The server cannot confirm this share for now, so every refresh leaves it stale.
    mocks.getBotGroup.mockImplementation(async (_groupId: string, options?: { beforeSequence?: number }) => ({ ok: true, group: detail({ serverBacked: true,
      threadShareVersion: version, ...(options?.beforeSequence ? { hasMoreBefore: false, messages: [oldShare] } : { hasMoreBefore: true, messages: [msg({ id: 'new', sequence: 50, content: '最新' })] }) }) }));
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await screen.findByText('原文');
    const settle = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); }); };
    version = 2;
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    await settle();
    const afterFirstEdit = mocks.getBotGroup.mock.calls.length;
    // A later edit is checked again; unchanged stale data never causes a refresh loop.
    version = 3;
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    await settle();
    expect(mocks.getBotGroup.mock.calls.length - afterFirstEdit).toBe(2);
    await settle();
    expect(mocks.getBotGroup.mock.calls.length - afterFirstEdit).toBe(2);
  });

  it('waits for a follow-up before another, whatever else commits meanwhile', async () => {
    const share = { messageId: 'old-reply', threadRootId: 'old-root', status: 'available' as const, authorKind: 'bot' as const, authorBotId: 'xiaoman', authorName: '小满',
      sharedByAuthor: false, content: '原文', attachments: [], createdAt: 1, edited: false, version: 1 };
    const oldShare = msg({ id: 'old-share', sequence: 20, authorKind: 'user', isSelf: false, authorBotId: 'alice-actor', authorName: 'Alice', content: '↪ 卡片文字', threadShare: share });
    const latest = detail({ serverBacked: true, hasMoreBefore: true, threadShareVersion: 2, messages: [msg({ id: 'new', sequence: 50, content: '最新' })] });
    const followUps: Array<() => void> = [];
    mocks.getBotGroup.mockImplementation((_groupId: string, options?: { beforeSequence?: number; shownShares?: unknown[] }) => {
      if (options?.beforeSequence === 50) return Promise.resolve({ ok: true, group: { ...latest, messages: [oldShare] } });
      if (options?.beforeSequence) return Promise.resolve({ ok: true, group: { ...latest, hasMoreBefore: false, messages: [msg({ id: 'oldest', sequence: 1, content: '更早' })] } });
      // A follow-up checking the stale share stays in flight until released.
      if (options?.shownShares?.length) return new Promise(resolve => followUps.push(() => resolve({ ok: true, group: latest })));
      return Promise.resolve({ ok: true, group: latest });
    });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await waitFor(() => expect(followUps).toHaveLength(1));
    // Another older page lands while that follow-up is still in flight.
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await screen.findByText('更早');
    await act(async () => { await Promise.resolve(); });
    expect(followUps).toHaveLength(1);
  });
});

describe('more older shares than one refresh re-reads', () => {
  const t = (name: string) => `bots.groupChat.server.thread.${name}`;
  beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });

  it.each(['source', 'attachment'] as const)('settles every older %s after overlapping completion pushes', { timeout: 20_000 }, async (pending) => {
    const older = Array.from({ length: 201 }, (_, i) => msg({ id: `share-${i}`, sequence: i + 1, content: 'card fallback',
      threadShare: { messageId: `reply-${i}`, threadRootId: 'root', status: pending === 'source' ? 'loading' : 'available',
        authorKind: 'user', authorBotId: null, authorName: 'Alice', sharedByAuthor: true, content: pending === 'source' ? '' : `原文 ${i}`,
        attachments: pending === 'attachment' ? [{ id: `file-${i}`, name: `pending-${i}.pdf`, category: 'file', mimeType: 'application/pdf', size: 0, url: null, path: null, state: 'loading' }] : [],
        createdAt: 1, edited: false, version: 2 } }));
    const latest = detail({ serverBacked: true, hasMoreBefore: true, threadShareVersion: 2, messages: [msg({ id: 'new', sequence: 500, content: '最新' })] });
    const finish: Array<() => void> = [];
    mocks.getBotGroup.mockImplementation((_groupId: string, options?: { beforeSequence?: number; shownShares?: Array<{ id: string }> }) => {
      if (options?.beforeSequence) return Promise.resolve({ ok: true, group: { ...latest, hasMoreBefore: false, messages: older } });
      if (!options?.shownShares?.length) return Promise.resolve({ ok: true, group: latest });
      const updates = Object.fromEntries(options.shownShares.map(ref => {
        const i = Number(ref.id.slice(6));
        return [ref.id, { ...older[i]!.threadShare!, status: 'available', content: `核对 ${i}`, attachments: [] }];
      }));
      return new Promise(resolve => finish.push(() => resolve({ ok: true, group: { ...latest, threadShareUpdates: updates } })));
    });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await waitFor(() => expect(document.querySelectorAll('[data-share-message-id]').length).toBeGreaterThan(200));
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    await act(async () => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    // The optimized reader coalesces pushes while a read is in flight. Its follow-up
    // must still reconcile every loaded share, including those beyond one server batch.
    expect(finish).toHaveLength(1);
    await act(async () => finish[0]!());
    await waitFor(() => expect(finish).toHaveLength(2));
    await act(async () => finish[1]!());
    expect(await screen.findByText('核对 0')).toBeTruthy();
    expect(screen.getByText('核对 200')).toBeTruthy();
    expect(screen.queryByText(t('loadingSource'))).toBeNull();
    expect(screen.queryByText('pending-0.pdf')).toBeNull();
    expect(finish).toHaveLength(2);
  });

  it('checks all loaded shares in one refresh, including the oldest deleted source', { timeout: 20_000 }, async () => {
    type Share = NonNullable<BotGroupMessageView['threadShare']>;
    const shareOf = (i: number, extra: Partial<Share> = {}): Share => ({ messageId: `reply-${i}`, threadRootId: 'root', status: 'available', authorKind: 'bot',
      authorBotId: 'xiaoman', authorName: '小满', sharedByAuthor: false, content: `原文 ${i}`, attachments: [], createdAt: 1, edited: false, version: 1, ...extra });
    const older = Array.from({ length: 201 }, (_, i) => msg({ id: `share-${i}`, sequence: i + 1, authorKind: 'user', isSelf: false, authorBotId: 'alice',
      authorName: 'Alice', content: `↪ 卡片 ${i}`, threadShare: shareOf(i) }));
    const latest = detail({ serverBacked: true, hasMoreBefore: true, threadShareVersion: 1, messages: [msg({ id: 'new', sequence: 500, content: '最新' })] });
    let version = 1;
    const refreshes: Array<string[]> = [];
    mocks.getBotGroup.mockImplementation(async (_groupId: string, options?: { beforeSequence?: number; shownShares?: Array<{ id: string; messageId: string }> }) => {
      if (options?.beforeSequence) return { ok: true, group: { ...latest, hasMoreBefore: false, messages: older } };
      refreshes.push((options?.shownShares ?? []).map(share => share.id));
      // The oldest share's reply has been deleted on the server since it was shown.
      const threadShareUpdates = Object.fromEntries((options?.shownShares ?? []).map(share => [share.id, share.messageId === 'reply-0'
        ? shareOf(0, { status: 'unavailable', authorName: '', content: '', version }) : shareOf(Number(share.messageId.slice(6)), { version })]));
      return { ok: true, group: { ...latest, threadShareVersion: version, threadShareUpdates } };
    });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    expect(await screen.findByText('原文 0')).toBeTruthy();
    version = 2;
    act(() => { for (const push of mocks.pushes) push({ groupId: 'g1', change: 'messages' }); });
    await screen.findByText(t('sourceUnavailable'));
    await waitFor(() => expect(screen.queryByText(t('loadingSource'))).toBeNull());
    expect(screen.queryByText('原文 0')).toBeNull();
    expect(screen.getAllByText(t('sourceUnavailable')).length).toBe(1);
    // Initial load and one push refresh: no per-batch follow-ups.
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]).toHaveLength(201);
    expect(screen.queryByText('↪ 卡片 0')).toBeNull();
  });

  it('checks a stale share even when a full batch of newer ones is still loading', { timeout: 20_000 }, async () => {
    type Share = NonNullable<BotGroupMessageView['threadShare']>;
    const shareOf = (i: number, extra: Partial<Share> = {}): Share => ({ messageId: `reply-${i}`, threadRootId: 'root', status: 'available', authorKind: 'bot',
      authorBotId: 'xiaoman', authorName: '小满', sharedByAuthor: false, content: `原文 ${i}`, attachments: [], createdAt: 1, edited: false, version: 2, ...extra });
    // The newest 200 are still being read by the main process; the oldest predates an edit.
    const older = Array.from({ length: 201 }, (_, i) => msg({ id: `share-${i}`, sequence: i + 1, authorKind: 'user', isSelf: false, authorBotId: 'alice',
      authorName: 'Alice', content: `↪ 卡片 ${i}`, threadShare: i === 0 ? shareOf(0, { version: 1 }) : shareOf(i, { status: 'loading', authorName: '', content: '' }) }));
    const latest = detail({ serverBacked: true, hasMoreBefore: true, threadShareVersion: 2, messages: [msg({ id: 'new', sequence: 500, content: '最新' })] });
    const refreshes: Array<string[]> = [];
    mocks.getBotGroup.mockImplementation(async (_groupId: string, options?: { beforeSequence?: number; shownShares?: Array<{ id: string; messageId: string }> }) => {
      if (options?.beforeSequence) return { ok: true, group: { ...latest, hasMoreBefore: false, messages: older } };
      refreshes.push((options?.shownShares ?? []).map(share => share.id));
      const threadShareUpdates = Object.fromEntries((options?.shownShares ?? []).map(share => [share.id, share.messageId === 'reply-0'
        ? shareOf(0, { content: '核对后的原文' }) : shareOf(Number(share.messageId.slice(6)), { status: 'loading', authorName: '', content: '' })]));
      return { ok: true, group: { ...latest, threadShareUpdates } };
    });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    expect(await screen.findByText('核对后的原文')).toBeTruthy();
    // The first refresh that checks older shares already takes the stale one.
    expect(refreshes.find(ids => ids.length)).toContain('share-0');
    expect(refreshes.find(ids => ids.length)).toHaveLength(201);
  });
});

describe('pending main-chat copies across accounts', () => {
  const t = (name: string) => `bots.groupChat.server.thread.${name}`;
  beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
  afterEach(() => { mocks.ownerGeneration = { dataOwnerId: 'account-a', generation: 1 }; });

  it('does not offer one account\'s failed copy to the next account in the same group', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true, messages: [msg({ id: 'u1', content: 'A' })] }) });
    mocks.shareToMain.mockResolvedValue({ ok: false, errorCode: 'SERVICE_ERROR' });
    const user = userEvent.setup();
    const view = renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.server.startTopic' }));
    let panel = await screen.findByRole('complementary');
    await user.click(within(panel).getByRole('checkbox', { name: t('alsoSend') }));
    await user.type(within(panel).getByRole('textbox'), 'from account A{Enter}');
    await within(panel).findByRole('button', { name: t('retryPost') });
    view.unmount();
    // Another account opens the same server group and thread.
    mocks.ownerGeneration = { dataOwnerId: 'account-b', generation: 2 };
    renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.server.startTopic' }));
    panel = await screen.findByRole('complementary');
    await within(panel).findByText('Reply to u1');
    expect(within(panel).queryByRole('button', { name: t('retryPost') })).toBeNull();
  });

  it('keeps failed copies across same-owner repair and ignores an old-generation retry result', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ serverBacked: true, messages: [msg({ id: 'u1', content: 'A' })] }) });
    let finishOldRetry!: (result: { ok: true; messageId: string; alreadyShared: boolean }) => void;
    mocks.shareToMain.mockResolvedValueOnce({ ok: false, errorCode: 'SERVICE_ERROR' })
      .mockImplementationOnce(() => new Promise(resolve => { finishOldRetry = resolve; }));
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: 'bots.groupChat.server.startTopic' }));
    const panel = await screen.findByRole('complementary');
    await user.click(within(panel).getByRole('checkbox', { name: t('alsoSend') }));
    await user.type(within(panel).getByRole('textbox'), 'copy me{Enter}');
    await user.click(await within(panel).findByRole('button', { name: t('retryPost') }));
    expect(mocks.shareToMain).toHaveBeenCalledTimes(2);

    // Runtime repair leaves the same account and panel mounted, but replaces generation.
    mocks.ownerGeneration = { dataOwnerId: 'account-a', generation: 2 };
    await user.type(within(panel).getByRole('textbox'), 'next draft');
    expect(within(panel).getByRole('button', { name: t('retryPost') })).toBeTruthy();
    await act(async () => { finishOldRetry({ ok: true, messageId: 'old-share', alreadyShared: false }); });
    expect(within(panel).getByRole('button', { name: t('retryPost') })).toBeTruthy();

    await user.click(within(panel).getByRole('button', { name: t('retryPost') }));
    await waitFor(() => expect(within(panel).queryByRole('button', { name: t('retryPost') })).toBeNull());
    expect(mocks.shareToMain.mock.calls).toEqual(Array.from({ length: 3 }, () => [{ groupId: 'g1', messageId: 'new-reply' }]));
    expect(mocks.reply).toHaveBeenCalledTimes(1);
  });
});

// #6550: actual timeline must project a bot's component body before Markdown rendering.
it('renders component body as readable text without changing the message', async () => {
  const content = 'Before\n\n```cindy-ui\n' + JSON.stringify({ seq: 1, version: 1, op: 'create', id: 'body', kind: 'text', props: { text: 'Readable answer' } }) + '\n```\n\nAfter';
  const reply = msg({ id: 'rich-body', sequence: 1, authorKind: 'bot', authorBotId: 'a', content });
  mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [reply] }) });
  renderView();
  await screen.findByText(/Readable answer/);
  const body = screen.getByTestId('bot-group-timeline');
  expect(body.textContent).toContain('Before');
  expect(body.textContent).toContain('After');
  expect(body.textContent).not.toContain('"op":"create"');
  expect(reply.content).toBe(content);
});

// Regression: tool boundaries clear streaming text; keep this turn's public progress,
// without reviving old turns, private replies or reasoning. Unit tier, no clock waits.
it('keeps only the current public progress note between tool calls', () => {
  const note = { clientId: 'public-progress', role: 'assistant', content: 'Checking the result', assistantPhase: 'commentary', createdAt: '2026-10-26T01:00:01Z' };
  const state = { streamingText: '', messages: [note], agentStatus: { startedAt: Date.parse('2026-10-26T01:00:00Z') } } as Parameters<typeof botGroupWorkPreview>[0];
  expect(botGroupWorkPreview(state, 2)).toBe('Checking the result');
  for (const patch of [{ botPrivateReply: true }, { failedSamplingAttempt: true }, { assistantPhase: 'analysis' }, { createdAt: '2026-10-25T01:00:00Z' }]) {
    expect(botGroupWorkPreview({ ...state, messages: [{ ...note, ...patch }] } as Parameters<typeof botGroupWorkPreview>[0], 2)).toBe('');
  }
  expect(botGroupWorkPreview({ ...state, streamingText: 'NO_REPLY' }, 2)).toBe('');
});

// #7583, unit: missing start timestamps must not turn a stale waiting execution
// into a newly started timer. Existing progress cases all supplied a timestamp.
it('keeps waiting work inspectable without inventing an elapsed time', async () => {
  mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ speakingBotIds: ['mimi'], round: {
    status: 'running', canContinue: false, speakers: [
      { botId: 'mimi', activity: 'reply', executionId: 'waiting', sessionId: 'lane-mimi', executionStatus: 'needs_input' },
    ],
  } }) });
  renderView();
  const strip = await screen.findByTestId('bot-group-progress');
  expect(strip.textContent).toContain('bots.groupChat.waitingConfirm');
  expect(strip.textContent).not.toContain('bots.groupChat.progress.elapsed');
  expect(screen.queryByTestId('bot-group-speaking')).toBeNull();
  fireEvent.click(within(strip).getByRole('button', { name: 'bots.groupChat.progress.viewProcess' }));
  expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/lane-mimi');
});

// Group work identity: the source computer returns two concurrent executions of the
// same companion. Open only the requested execution on its original host (unit tier).
it('opens the exact remote execution and leaves other members’ private tasks unavailable', async () => {
  resetCompanionCloudStoreForTests({ enabled: true, selfDeviceId: 'here', humanActorId: 'me', demotedBotIds: [], actors: [{
    id: 'actor-mimi', externalId: 'mimi', name: '咪咪', avatar: null, homeDeviceId: 'studio',
    homeDevice: { deviceId: 'studio', name: 'Studio', online: true, isSelf: false, remoteControlEnabled: true },
  }] });
  mocks.remoteInvoke.mockResolvedValue({ ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'g1' }, blocks: [{ primitive: 'bot-group-chat', data: {
    id: 'g1', round: { speakers: [{ executionId: 'other-thread', sessionId: 'wrong-lane' }, { executionId: 'this-turn', sessionId: 'correct-lane' }] },
  } }] });
  mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ speakingBotIds: ['mimi', 'xiaoman'], round: {
    status: 'running', canContinue: false, speakers: [
      { botId: 'mimi', activity: 'reply', executionId: 'this-turn', sessionId: null, startedAt: Date.now() - 10_000 },
      { botId: 'xiaoman', activity: 'reply', executionId: 'theirs', sessionId: null, startedAt: Date.now() - 10_000 },
    ],
  } }) });
  renderView();
  const process = await screen.findByRole('button', { name: 'bots.groupChat.progress.viewProcess' });
  expect(screen.getAllByTestId('bot-group-progress')).toHaveLength(2);
  fireEvent.click(process);
  expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/correct-lane?device=studio');
  expect(mocks.remoteInvoke.mock.calls.every(([device]) => device === 'studio')).toBe(true);
});

// A stopping last row must not disable the group control while an earlier
// execution is still stoppable (Greptile review #4375066338).
it.each([false, true])('keeps the group stop control enabled for another running execution (admin: %s)', async admin => {
  mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({
    canStopAll: admin,
    speakingBotIds: ['mimi', 'xiaoman'],
    round: { status: 'running', canContinue: false, othersActive: admin, speakers: [
      { botId: 'mimi', activity: 'reply', executionId: 'first-running', sessionId: 'lane-mimi', startedAt: Date.now() - 10_000, executionStatus: 'running' },
      { botId: 'xiaoman', activity: 'reply', executionId: 'last-stopping', sessionId: 'lane-xiaoman', startedAt: Date.now() - 10_000, executionStatus: 'stopping', stopping: true },
    ] },
  }) });
  renderView();
  const buttons = await screen.findAllByRole('button', { name: 'bots.groupChat.progress.stop' });
  expect(buttons).toHaveLength(1);
  expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
  if (admin) {
    fireEvent.pointerDown(buttons[0]!, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: /^bots\.groupChat\.progress\.stopAll/ }));
    await waitFor(() => expect(mocks.stopBotGroupRound).toHaveBeenCalledWith('g1', 'all'));
  } else {
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(mocks.stopBotGroupRound).toHaveBeenCalledWith('g1'));
  }
});
