// @vitest-environment jsdom
import { readTeammatesViewMode, writeTeammatesViewMode } from '../teammatesSectionPrefs';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotGroupOpenPlanSummary, BotGroupSummary } from '../../../../shared/botGroupChat';
import { botGroupReadKey, markBotRead, resetBotReadStateForTests } from '../botReadState';

vi.mock('@/hooks/useProviderOnboarding', () => ({
  useProviderOnboarding: () => ({ visible: false }),
}));
vi.mock('@/components/onboarding/ConnectProviderCard', () => ({
  ConnectProviderCard: () => null,
}));
// The shared creation entry reads the owner for import; this sidebar test does
// not mount the application authentication/provider runtime.
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: 'owner' }),
}));

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { resolvedLanguage: 'en' } }),
}));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openWindow: vi.fn(async () => undefined),
  profiles: [] as unknown[],
  groups: [] as BotGroupSummary[],
  params: {} as { botId?: string; groupId?: string },
  pathname: '/bots',
  islandActivity: new Map<string, { sessionId: string; phase: string; workingPhase?: string }>(),
  confirm: vi.fn(),
  manage: vi.fn(),
  refreshGroups: vi.fn(),
  ownerGeneration: 1,
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ dataOwnerId: 'owner', generation: mocks.ownerGeneration }),
  isDataOwnerGenerationCurrent: (owner: { generation: number }) => owner.generation === mocks.ownerGeneration,
}));

vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [],
}));
vi.mock('@/state/agentIslandActivity', () => ({
  useAgentIslandActivityMap: () => mocks.islandActivity,
}));
vi.mock('react-router-dom', async importOriginal => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: mocks.pathname, search: '', hash: '' }),
  useParams: () => mocks.params,
}));
vi.mock('../botStore', () => ({
  useBotProfiles: () => mocks.profiles,
  hasLoadedBotProfiles: () => true,
  useBotProfilesLoadState: () => 'ready',
  useBotUnreadCounts: () => ({}),
  refreshBotProfiles: vi.fn(),
  setBotHidden: vi.fn(),
  setBotPinned: vi.fn(),
  duplicateBotProfile: vi.fn(),
  canonicalBotSessionId: (bot: { sessions?: Array<{ id: string; role?: string }> }) =>
    bot.sessions?.find((session) => session.role === 'canonical')?.id,
}));
vi.mock('../botGroupStore', () => ({
  useBotGroupList: () => ({ groups: mocks.groups, loaded: true }),
  refreshBotGroups: mocks.refreshGroups,
}));
vi.mock('../BotDeleteDialog', () => ({ BotDeleteDialog: () => null }));
vi.mock('../BotGroupCreateDialog', () => ({
  BotGroupCreateDialog: () => <div role="dialog">create-group-dialog</div>,
}));
vi.mock('../BotRosterView', () => ({
  BotRosterView: () => <div role="dialog">create-teammate-dialog</div>,
}));
vi.mock('../ChatInviteDialog', () => ({
  ChatInviteDialog: ({ groupId, initialLink, onJoined }: { groupId?: string; initialLink?: string; onJoined?: (id: string) => void }) =>
    <div role="dialog"><span>{`join-dialog:${groupId ?? ''}:${initialLink ?? ''}`}</span>
      <button type="button" onClick={() => onJoined?.('joined-room')}>joined</button></div>,
}));
vi.mock('../BotGenerationLabel', () => ({
  BotGenerationLabel: ({ sessionId }: { sessionId?: string }) => <span>{`generation:${sessionId}`}</span>,
}));

import { TeammatesSection } from '../TeammatesSection';

function bot(id: string, name: string, extraSessions: unknown[] = []) {
  return {
    id,
    name,
    description: '',
    avatar: '🧭',
    avatarColor: 'violet',
    enabled: true,
    status: 'active',
    skills: [],
    capabilities: {},
    createdAt: 0,
    lastMessagePreview: `${name} private preview`,
    sessions: [{ id: `${id}-chat`, kind: 'chat', role: 'canonical', title: name }, ...extraSessions],
  };
}

function group(overrides: Partial<BotGroupSummary> = {}): BotGroupSummary {
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
    lastMessage: { authorKind: 'bot', authorName: '阿布', preview: '下午\n有小概率阵雨', createdAt: 10 },
    speakingBotIds: [],
    planningBotId: null,
    openPlan: null,
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  };
}

function openPlan(overrides: Partial<BotGroupOpenPlanSummary> = {}): BotGroupOpenPlanSummary {
  return {
    id: 'p1',
    status: 'waiting',
    currentStep: 0,
    stepCount: 3,
    currentBotName: '咪咪',
    currentStepStatus: 'done',
    ...overrides,
  };
}

async function renderSidebar() {
  const view = render(<TeammatesSection />);
  await waitFor(() => expect(view.container.querySelector('button')).not.toBeNull());
  return view;
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.openWindow.mockClear();
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.manage.mockReset().mockResolvedValue({ ok: true });
  mocks.refreshGroups.mockReset();
  mocks.ownerGeneration = 1;
  mocks.params = {};
  mocks.pathname = '/bots';
  mocks.groups = [];
  mocks.islandActivity = new Map();
  mocks.profiles = [
    bot('mimi', '咪咪', [{ id: 'lane-mimi', kind: 'group', role: 'group', title: 'group lane' }]),
    bot('xiaoman', '小满'),
  ];
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: { localDb: { messages: { onCreated: () => () => undefined } }, maker: { openSessionInNewWindow: mocks.openWindow, chatServer: {
      manage: mocks.manage, status: async () => ({ enabled: false }),
    } } },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TeammatesSection group chats', () => {
  // #10822 / unit: exercise the real group row with an already-read server
  // group and a retained hidden error. Earlier sidebar cases omit this overlap.
  it('uses the server group result after stopping while preserving new failures and decisions', async () => {
    mocks.profiles = [bot('mimi', '咪咪', [{ id: 'failed-step', kind: 'group', role: 'group', groupId: 'g1' }])];
    mocks.islandActivity = new Map([['failed-step', { sessionId: 'failed-step', phase: 'error' }]]);
    mocks.groups = [group({ serverBacked: true, serverUnread: { count: 0, mentioned: false },
      teammateActivity: { phase: 'error' } })];
    const view = await renderSidebar();
    const status = () => view.container.querySelector('[data-bot-group-id="g1"] [data-teammate-status]')?.getAttribute('data-teammate-status');
    expect(status()).toBe('error');
    mocks.groups = [{ ...mocks.groups[0]!, teammateActivity: { phase: 'idle' } }];
    view.rerender(<TeammatesSection />);
    expect(status()).toBeUndefined();
    // The original Session may already have disappeared; it is not needed to settle the group.
    mocks.profiles = [];
    view.rerender(<TeammatesSection />);
    expect(status()).toBeUndefined();
    mocks.groups = [{ ...mocks.groups[0]!, teammateActivity: { phase: 'error' } }];
    view.rerender(<TeammatesSection />);
    expect(status()).toBe('error');
    mocks.groups = [{ ...mocks.groups[0]!, teammateActivity: { phase: 'needs-interaction' } }];
    view.rerender(<TeammatesSection />);
    expect(status()).toBe('awaiting');
  });

  // 归档的群不在段内列出,经侧栏总搜索找回(见 teammateSearchResults.test.tsx)。
  it('leaves archived groups out of the section', async () => {
    mocks.groups = [group(), group({ id: 'saved', name: '已完成的旅行', archived: true })];
    const view = await renderSidebar();
    expect(screen.getByText('周末出游')).toBeTruthy();
    expect(screen.queryByText('已完成的旅行')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    mocks.groups = mocks.groups.map(item => ({ ...item, archived: false }));
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('已完成的旅行')).toBeTruthy();
  });

  it('shows the add entry when only archived groups remain and no teammates exist', async () => {
    mocks.profiles = [];
    mocks.groups = [group({ archived: true })];
    await renderSidebar();
    expect(document.querySelector('[data-bot-group-id]')).toBeNull();
    expect(screen.getByText('bots.add')).toBeTruthy();
  });

  const managedGroup = (archived = false) => group({ serverBacked: true, archived, revision: 7,
    members: [{ ...group().members[0]!, isOwned: true, role: 'owner' }],
  });
  const archiveKey = 'bots.groupChat.server.settings.archive';
  async function selectArchive() {
    fireEvent.contextMenu(screen.getByRole('button', { name: '周末出游' }), { clientX: 20, clientY: 30 });
    fireEvent.click(await screen.findByRole('menuitem', { name: archiveKey }));
  }
  const firstSectionButton = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('[data-sidebar-section="teammates"] button');

  it('confirms archive with the current revision and drops the row after refresh', async () => {
    mocks.groups = [managedGroup()];
    const view = await renderSidebar();
    await selectArchive();
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'g1', action: {
      type: 'archive', archived: true, expectedRevision: 7,
    } }));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: archiveKey,
      confirmText: archiveKey, description: 'bots.groupChat.server.settings.archiveHint',
    }));
    expect(mocks.refreshGroups).toHaveBeenCalledOnce();
    expect(screen.getByText('周末出游')).toBeTruthy();
    mocks.groups = [managedGroup(true)];
    view.rerender(<TeammatesSection />);
    expect(screen.queryByText('周末出游')).toBeNull();
  });

  it('keeps focus inside the section after keyboard archive removes the row', async () => {
    mocks.groups = [managedGroup()];
    const view = await renderSidebar();
    const row = screen.getByRole('button', { name: '周末出游' });
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    fireEvent.click(await screen.findByRole('menuitem', { name: archiveKey }));
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());
    mocks.groups = [managedGroup(true)];
    view.rerender(<TeammatesSection />);
    await waitFor(() => expect(document.activeElement).toBe(firstSectionButton(view.container)));
  });

  it.each([false, true])('recovers focus when settings archives the selected group (route already cleared: %s)', async cleared => {
    mocks.params = { groupId: 'g1' };
    mocks.pathname = '/bots/groups/g1';
    mocks.groups = [managedGroup()];
    const view = await renderSidebar();
    mocks.groups = [managedGroup(true)];
    if (cleared) { mocks.params = {}; mocks.pathname = '/bots/list'; }
    view.rerender(<TeammatesSection />);
    await waitFor(() => expect(document.activeElement).toBe(firstSectionButton(view.container)));
  });

  it('keeps a new sidebar selection when settings archive finishes', async () => {
    mocks.params = { groupId: 'g1' };
    mocks.pathname = '/bots/groups/g1';
    mocks.groups = [managedGroup()];
    const view = await renderSidebar();
    const next = screen.getByText('咪咪').closest('button')!;
    act(() => next.focus());
    mocks.groups = [managedGroup(true)];
    mocks.params = {};
    mocks.pathname = '/bots/list';
    view.rerender(<TeammatesSection />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
    expect(document.activeElement).toBe(next);
  });

  it('restores the original row after archive confirmation is cancelled', async () => {
    let settle!: (accepted: boolean) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise<boolean>(resolve => { settle = resolve; }));
    mocks.groups = [managedGroup()];
    await renderSidebar();
    const row = screen.getByRole('button', { name: '周末出游' });
    row.focus();
    await selectArchive();
    await waitFor(() => expect(document.activeElement).toBe(row));
    row.blur();
    await act(async () => { settle(false); });
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(mocks.manage).not.toHaveBeenCalled();
    expect(mocks.refreshGroups).not.toHaveBeenCalled();
  });

  // #13097 review / standard: the existing list test missed the collapsed subtree in icon view.
  it.each(['list', 'icons'] as const)('shows an archive error and restores the group focus in %s view', async mode => {
    writeTeammatesViewMode('owner', mode);
    try {
      let settle!: (result: { ok: false; errorCode: string }) => void;
      mocks.manage.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
      mocks.groups = [managedGroup()];
      await renderSidebar();
      const row = screen.getByRole('button', { name: '周末出游' });
      row.focus();
      await selectArchive();
      await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());
      row.blur();
      await act(async () => { settle({ ok: false, errorCode: 'REVISION_CONFLICT' }); });
      expect(screen.getByRole('alert').textContent).toBe('bots.groupChat.server.settings.conflict');
      await waitFor(() => expect(document.activeElement).toBe(row));
      expect(mocks.refreshGroups).not.toHaveBeenCalled();
    } finally {
      writeTeammatesViewMode('owner', 'list');
    }
  });

  it('keeps cancelled archives untouched and blocks old-account confirmations and responses', async () => {
    mocks.groups = [managedGroup()];
    mocks.confirm.mockResolvedValueOnce(false);
    await renderSidebar();
    await selectArchive();
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    expect(mocks.manage).not.toHaveBeenCalled();
    mocks.confirm.mockImplementationOnce(async () => { mocks.ownerGeneration += 1; return true; });
    await selectArchive();
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(2));
    expect(mocks.manage).not.toHaveBeenCalled();
    mocks.manage.mockImplementationOnce(async () => { mocks.ownerGeneration += 1; return { ok: true }; });
    await selectArchive();
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());
    expect(mocks.refreshGroups).not.toHaveBeenCalled();
    expect(screen.getByText('周末出游')).toBeTruthy();
  });

  it('blocks duplicate archive triggers while a confirmation is pending', async () => {
    mocks.groups = [managedGroup()];
    let accept!: (value: boolean) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
    await renderSidebar();
    await selectArchive();
    fireEvent.contextMenu(screen.getByRole('button', { name: '周末出游' }));
    const action = await screen.findByRole('menuitem', { name: archiveKey });
    expect(action.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(action);
    expect(mocks.confirm).toHaveBeenCalledOnce();
    await act(async () => { accept(true); });
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());
  });

  it.each(['list', 'icons'] as const)('opens the targeted group in a separate window from the %s view', async mode => {
    writeTeammatesViewMode('owner', mode);
    try {
      mocks.groups = [group({ id: 'week/end' })];
      await renderSidebar();
      fireEvent.contextMenu(screen.getByRole('button', { name: '周末出游' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'rightSidebar.tabs.contextMenu.openInWindow' }));
      expect(mocks.openWindow).toHaveBeenCalledExactlyOnceWith('/bots/groups/week%2Fend');
      expect(mocks.navigate).not.toHaveBeenCalled();
    } finally {
      writeTeammatesViewMode('owner', 'list');
    }
  });

  it('offers settings but no archive for ordinary members, with keyboard access', async () => {
    mocks.groups = [group({ serverBacked: true, revision: 1 })];
    await renderSidebar();
    fireEvent.keyDown(screen.getByRole('button', { name: '周末出游' }), { key: 'F10', shiftKey: true });
    expect(screen.queryByRole('menuitem', { name: archiveKey })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'bots.groupChat.settings.title' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/g1?groupSettings=1');
  });

  it.each([false, true])('keeps dissolved groups out of archive actions (archived: %s)', async archived => {
    mocks.groups = [{ ...managedGroup(archived), dissolvedAt: '2026-10-15T12:00:00Z' }];
    await renderSidebar();
    if (archived) expect(screen.queryByText('周末出游')).toBeNull();
    else {
      fireEvent.keyDown(screen.getByRole('button', { name: '周末出游' }), { key: 'F10', shiftKey: true });
      expect(screen.queryByRole('menuitem', { name: archiveKey })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'bots.groupChat.server.settings.unarchive' })).toBeNull();
      expect(await screen.findByRole('menuitem', { name: 'bots.groupChat.settings.title' })).toBeTruthy();
    }
    expect(mocks.manage).not.toHaveBeenCalled();
  });

  it('lists groups alongside teammates with an author preview and opens them', async () => {
    mocks.groups = [group(), group({ id: 'g2', name: '读书会', lastMessage: null, updatedAt: 1 })];
    mocks.pathname = '/bots/groups/g1';
    await renderSidebar();
    expect(screen.queryByText('bots.groupChat.sidebar.title')).toBeNull();
    const rows = screen.getAllByRole('button', { current: 'page' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('aria-label')).toBe('周末出游');
    expect(
      screen.getByText('bots.groupChat.sidebar.preview:{"name":"阿布","text":"下午 有小概率阵雨"}'),
    ).toBeTruthy();
    expect(screen.getByText('bots.groupChat.sidebar.empty')).toBeTruthy();
    fireEvent.click(screen.getByText('读书会'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/g2');

    fireEvent.keyDown(screen.getByRole('button', { name: 'bots.list.createMenu' }), { key: 'Enter' });
    expect(screen.getByRole('menuitem', { name: 'bots.list.createTeammate' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'bots.groupChat.create.title' }));
    expect(screen.getByRole('dialog').textContent).toBe('create-group-dialog');
  });

  it('keeps only the plus menu in the header and offers pasting an invitation as a separate fallback', async () => {
    await renderSidebar();
    expect(screen.queryByRole('button', { name: 'bots.groupChat.server.join' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'bots.list.createMenu' }), { key: 'Enter' });
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'bots.list.createTeammate', 'bots.groupChat.create.title', 'bots.list.joinWithLink',
    ]);
    expect(screen.getAllByRole('separator')).toHaveLength(1);
    fireEvent.click(screen.getByRole('menuitem', { name: 'bots.list.joinWithLink' }));
    expect(screen.getByRole('dialog').textContent).toContain('join-dialog::');
    expect(screen.queryByText('create-group-dialog')).toBeNull();
    expect(screen.queryByText('create-teammate-dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'joined' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/joined-room');
  });

  it('opens teammate creation from the same plus menu', async () => {
    await renderSidebar();
    fireEvent.keyDown(screen.getByRole('button', { name: 'bots.list.createMenu' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'bots.list.createTeammate' }));
    expect(screen.getByRole('dialog').textContent).toBe('create-teammate-dialog');
  });

  it('moves a group above older private chats on a new message while preserving pins', async () => {
    mocks.profiles = [{ ...bot('mimi', '咪咪'), lastMessageAt: 20 },
      { ...bot('xiaoman', '小满'), pinnedAt: 1 }];
    mocks.groups = [group()];
    const view = await renderSidebar();
    const order = () => Array.from(view.container.querySelectorAll('button'))
      .map(row => ['咪咪', '小满', '周末出游'].find(name => (name === '周末出游' ? row.getAttribute('aria-label') === name : screen.getByText(name).closest('button') === row)))
      .filter(Boolean);
    expect(order()).toEqual(['小满', '咪咪', '周末出游']);
    mocks.groups = [group({ lastMessage: { ...group().lastMessage!, createdAt: 30 } })];
    view.rerender(<TeammatesSection />);
    expect(order()).toEqual(['小满', '周末出游', '咪咪']);
  });

  it('keeps joined groups visible when the account has no local teammates', async () => {
    mocks.profiles = [];
    mocks.groups = [group()];
    await renderSidebar();
    expect(screen.getByRole('button', { name: /周末出游/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'bots.add' })).toBeNull();
  });

  it('keeps showing the latest message on the group while a teammate executes, without leaking onto the teammate’s own row', async () => {
    mocks.groups = [group({ speakingBotIds: ['mimi', 'xiaoman'], lastMessage: { authorKind: 'bot', authorName: '咪咪', preview: '周六去莫干山', createdAt: 10 } })];
    mocks.islandActivity = new Map([
      ['lane-mimi', { sessionId: 'lane-mimi', phase: 'running', workingPhase: 'searching' }],
    ]);
    await renderSidebar();
    expect(screen.queryByTestId('bot-group-running')).toBeNull();
    expect(screen.getByText('bots.groupChat.sidebar.preview:{"name":"咪咪","text":"周六去莫干山"}')).toBeTruthy();
    expect(screen.queryByText('generation:lane-mimi')).toBeNull();
    // The teammate row keeps its private-chat preview.
    expect(screen.getByText('咪咪 private preview')).toBeTruthy();
  });

  it('previews a plan waiting for 开始 or for 继续 / 重试 instead of the latest message', async () => {
    mocks.groups = [
      group({ id: 'g1', name: '官网', openPlan: openPlan({ status: 'proposed', currentStep: null }) }),
      group({ id: 'g2', name: '周报', updatedAt: 9, openPlan: openPlan() }),
      group({
        id: 'g3',
        name: '海报',
        updatedAt: 8,
        openPlan: openPlan({ currentStep: 1, currentBotName: '小满', currentStepStatus: 'failed' }),
      }),
      group({
        id: 'g4',
        name: '旧版',
        updatedAt: 7,
        openPlan: openPlan({ currentBotName: null, currentStepStatus: null }),
      }),
    ];
    await renderSidebar();
    expect(screen.getByText('bots.groupChat.sidebar.planProposed:{"name":"咪咪"}')).toBeTruthy();
    expect(screen.getByText('bots.groupChat.sidebar.planStepDone:{"name":"咪咪"}')).toBeTruthy();
    expect(screen.getByText('bots.groupChat.sidebar.planStepFailed:{"name":"小满"}')).toBeTruthy();
    expect(screen.getByText('bots.groupChat.sidebar.planWaitingAnonymous')).toBeTruthy();
    // The latest message only comes back once no plan needs the user.
    expect(screen.queryByText(/sidebar\.preview:/)).toBeNull();
    expect(screen.queryByTestId('bot-group-running')).toBeNull();
  });

  it('keeps showing the latest message when a plan step or planning is in progress', async () => {
    mocks.groups = [
      group({
        id: 'g1',
        name: '官网',
        speakingBotIds: ['mimi'],
        openPlan: openPlan({ status: 'running', currentStep: 1, currentStepStatus: 'running' }),
      }),
      group({
        id: 'g2',
        name: '周报',
        updatedAt: 9,
        speakingBotIds: ['xiaoman'],
        planningBotId: 'xiaoman',
        lastMessage: { authorKind: 'bot', authorName: '小满', preview: '开始整理', createdAt: 9 },
      }),
    ];
    mocks.islandActivity = new Map([
      ['lane-mimi', { sessionId: 'lane-mimi', phase: 'running', workingPhase: 'editing' }],
    ]);
    await renderSidebar();
    expect(screen.queryByTestId('bot-group-running')).toBeNull();
    expect(document.querySelector('[data-teammate-row-status] [data-teammate-status="running"]')).toBeNull();
    expect(screen.getByText('bots.groupChat.sidebar.preview:{"name":"阿布","text":"下午 有小概率阵雨"}')).toBeTruthy();
    expect(screen.getByText('bots.groupChat.sidebar.preview:{"name":"小满","text":"开始整理"}')).toBeTruthy();
  });

  it('keeps the confirmation hint when the teammate doing a step waits for the user', async () => {
    mocks.groups = [
      group({
        speakingBotIds: ['mimi'],
        openPlan: openPlan({ status: 'running', currentStepStatus: 'running' }),
      }),
    ];
    mocks.islandActivity = new Map([['lane-mimi', { sessionId: 'lane-mimi', phase: 'needs-interaction' }]]);
    await renderSidebar();
    const running = screen.getByTestId('bot-group-running');
    expect(running.textContent).toContain('咪咪');
    expect(running.textContent).toContain('bots.groupChat.sidebar.waiting');
  });
});

it('localizes the join preview without presenting its subject as a chat author', async () => {
  mocks.groups = [group({ lastMessage: { authorKind: 'system', authorName: 'Taylor',
    noticeCode: 'member-joined', preview: 'Fallback text', createdAt: 30 } })];
  await renderSidebar();
  expect(screen.getByText('bots.groupChat.notice.memberJoined:{"name":"Taylor"}')).toBeTruthy();
  expect(screen.queryByText(/Fallback text/)).toBeNull();
});

it('shows unread counts for current hosts and the one-message fallback for older hosts', async () => {
  window.localStorage.clear();
  resetBotReadStateForTests();
  markBotRead(botGroupReadKey('g1'), 15);
  markBotRead(botGroupReadKey('g2'), 15);
  const at = (ms: number) => new Date(ms).toISOString();
  mocks.groups = [
    group({ teammateActivity: { phase: 'idle' }, lastReplyAt: 30, incomingMessageTimes: [at(10), at(20), at(30)] } as Partial<BotGroupSummary>),
    group({ id: 'g2', name: '读书会', teammateActivity: { phase: 'idle' }, lastReplyAt: 30 }),
  ];
  try {
    await renderSidebar();
    expect(Array.from(document.querySelectorAll('[data-teammate-unread-count]'), node => node.textContent)).toEqual(['2', '1']);
  } finally {
    resetBotReadStateForTests();
    window.localStorage.clear();
  }
});
it.each([[false, 'bots.groupChat.sidebar.sharedReply:{"name":"Alice"}'], [true, 'bots.groupChat.sidebar.sharedReplyYou']] as const)(
  'names who shared a thread reply without quoting any card text (self: %s)', async (isSelf, label) => {
    mocks.groups = [group({ lastMessage: { authorKind: 'user', isSelf, authorName: 'Alice', threadShare: true,
      preview: '↪ 冒充: 卡片文字', createdAt: 30 } })];
    await renderSidebar();
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText(/冒充|卡片文字/)).toBeNull();
  });

// #8047: list summaries carry the execution snapshot, even before a lane starts;
// the sidebar keeps showing the latest message instead of queued/running status.
it.each(['reply', 'step'] as const)('keeps showing the latest message when a %s is queued in the group', async activity => {
  mocks.groups = [group({ speakingBotIds: ['mimi'],
    ...(activity === 'step' ? { openPlan: openPlan({ status: 'running', currentStepStatus: 'running' }) } : {}),
    round: { status: 'running', canContinue: false, speakers: [{ botId: 'mimi', activity,
      executionId: 'queued', executionStatus: 'queued', sessionId: null }] },
  })];
  mocks.islandActivity = new Map([['lane-mimi', { sessionId: 'lane-mimi', phase: 'running', workingPhase: 'searching' }]]);
  await renderSidebar();
  expect(screen.queryByTestId('bot-group-running')).toBeNull();
  expect(screen.getByText('bots.groupChat.sidebar.preview:{"name":"阿布","text":"下午 有小概率阵雨"}')).toBeTruthy();
  expect(screen.queryByText('generation:lane-mimi')).toBeNull();
});

it.each([false, true])('keeps showing the latest message and real message timestamp while teammates execute (plan: %s)', async hasPlan => {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  mocks.groups = [group({ speakingBotIds: ['mimi', 'xiaoman'],
    lastMessage: { authorKind: 'bot', authorName: '咪咪', preview: '周六去莫干山', createdAt: twoHoursAgo },
    ...(hasPlan ? { openPlan: openPlan({ status: 'running', currentStepStatus: 'running' }) } : {}),
    round: { status: 'running', canContinue: false, speakers: [
      { botId: 'mimi', activity: hasPlan ? 'step' : 'reply', executionStatus: 'queued', sessionId: null },
      { botId: 'xiaoman', activity: 'reply', executionStatus: 'running', sessionId: 'lane-xiaoman' },
    ] },
  })];
  const view = await renderSidebar();
  expect(screen.queryByTestId('bot-group-running')).toBeNull();
  expect(screen.getByText('bots.groupChat.sidebar.preview:{"name":"咪咪","text":"周六去莫干山"}')).toBeTruthy();
  const row = view.container.querySelector('[data-bot-group-id="g1"]')!;
  expect(row.querySelector('[data-teammate-timestamp]')?.textContent).not.toBe('bots.list.justNow');
});

describe('icon strip mentions', () => {
  const mentionLabel = 'bots.groupChat.server.thread.hintMentioned';
  // Icon/list is independent of collapse; preserve the existing status/overflow coverage.
  const switchView = () => {
    const wasIcons = readTeammatesViewMode('owner') === 'icons';
    fireEvent.keyDown(screen.getByRole('button', { name: 'ccAgent.sidebar.viewStyle' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: wasIcons ? 'ccAgent.sidebar.viewStyleListWide' : 'bots.list.viewIcons' }));
  };
  afterEach(() => window.localStorage.clear());

  it('keeps the blue group unread point for mentions even while a teammate executes in the group', async () => {
    mocks.groups = [
      group({ speakingBotIds: ['mimi'], serverUnread: { count: 2, mentioned: true } }),
      group({ id: 'g2', name: '读书会', teammateActivity: { phase: 'idle' }, serverUnread: { count: 1, mentioned: false } }),
    ];
    mocks.islandActivity = new Map([['lane-mimi', { sessionId: 'lane-mimi', phase: 'running' }]]);
    const view = await renderSidebar();
    switchView();
    // Executing inside a group never replaces unread with an orange running point.
    const marked = screen.getByRole('button', { name: new RegExp(`^周末出游 · bots\\.avatarStatus\\.(done|unread) · ${mentionLabel}$`) });
    expect(marked.querySelectorAll('[data-teammate-status]')).toHaveLength(1);
    const point = marked.querySelector<HTMLElement>('[data-teammate-mention]');
    expect(point?.getAttribute('data-teammate-status')).not.toBe('running');
    expect((point?.firstElementChild as HTMLElement)?.style.backgroundColor).toBe('var(--bot-unread-bg)');
    // Ordinary group unread uses blue in icon mode.
    const plain = screen.getByRole('button', { name: /^读书会 · / });
    expect(plain.getAttribute('aria-label')).not.toContain(mentionLabel);
    expect(plain.querySelector<HTMLElement>('[data-teammate-status] > span')?.style.backgroundColor).toBe('var(--bot-unread-bg)');
    expect(marked.querySelectorAll('[data-teammate-mention]')).toHaveLength(1);
    expect(plain.querySelectorAll('[data-teammate-mention]')).toHaveLength(0);
  });

  it.each([false, true])('keeps normal unread styling without running progress or dot while executing (mentioned: %s)', async mentioned => {
    mocks.profiles = [];
    mocks.groups = [group({ speakingBotIds: ['mimi'], teammateActivity: { phase: 'idle' }, serverUnread: { count: 2, mentioned } })];
    mocks.islandActivity = new Map([['lane-mimi', { sessionId: 'lane-mimi', phase: 'running' }]]);
    const view = await renderSidebar();
    const row = view.container.querySelector('[data-bot-group-id="g1"]')!;
    expect(screen.queryByTestId('bot-group-running')).toBeNull();
    expect(row.querySelector('[data-teammate-unread-count]')?.textContent).toBe('2');
    if (mentioned) {
      expect(row.querySelector('[data-teammate-unread-count] > span')?.className).toContain('bg-[var(--bot-unread-bg)]');
    } else {
      expect(row.querySelector('[data-teammate-unread-count] > span')?.className).not.toContain('bg-[var(--bot-unread-bg)]');
    }
    expect(row.querySelector('[data-teammate-status]')).toBeNull();
    mocks.groups = [group({ speakingBotIds: ['mimi'], teammateActivity: { phase: 'idle' }, serverUnread: { count: 0, mentioned: false } })];
    view.rerender(<TeammatesSection />);
    expect(row.querySelector('[data-teammate-unread-count]')).toBeNull();
    expect(screen.queryByTestId('bot-group-running')).toBeNull();
    switchView();
    expect(view.container.querySelector('[data-teammate-status="running"]')).toBeNull();
  });

  it.each(['completed', 'idle'] as const)('uses a blue count for list group mentions and a blue point in icon mode (%s)', async phase => {
    mocks.profiles = [];
    mocks.groups = [group({ teammateActivity: { phase }, serverUnread: { count: 12, mentioned: true } })];
    const view = await renderSidebar();
    const count = view.container.querySelector('[data-teammate-unread-count]')!;
    expect(count.textContent).toBe('12');
    expect(count.firstElementChild?.className).toContain('bg-[var(--bot-unread-bg)]');
    expect(count.firstElementChild?.className).toContain('text-[var(--bot-unread-fg)]');
    expect(count.firstElementChild?.getAttribute('aria-label')).toBe(
      `${translate('sidebar.teammateUnreadCount', { count: 12 })} · ${translate('bots.groupChat.server.thread.hintMentioned')}`,
    );
    expect(view.container.querySelector('[data-teammate-status]')).toBeNull();
    switchView();
    const point = screen.getByRole('button', { name: /^周末出游 ·/ }).querySelector<HTMLElement>('[data-teammate-mention]');
    expect((point?.firstElementChild as HTMLElement)?.style.backgroundColor).toBe('var(--bot-unread-bg)');
    expect(screen.getByRole('button', { name: /^周末出游 ·/ }).querySelector('[data-teammate-unread-count]')).toBeNull();
    mocks.groups = [group({ teammateActivity: { phase }, serverUnread: { count: 0, mentioned: false } })];
    view.rerender(<TeammatesSection />);
    switchView();
    expect(view.container.querySelector('[data-teammate-unread-count]')).toBeNull();
    expect(view.container.querySelector('[data-teammate-status]')).toBeNull();
  });

  it('shows ordinary group unread as an list count and icon blue point, clearing on read', async () => {
    mocks.groups = [group({ teammateActivity: { phase: 'idle' }, serverUnread: { count: 12, mentioned: false } })];
    const view = await renderSidebar();
    expect(view.container.querySelector('[data-teammate-unread-count]')?.textContent).toBe('12');
    switchView();
    const avatar = screen.getByRole('button', { name: /^周末出游 · / });
    expect(avatar.querySelector<HTMLElement>('[data-teammate-status] > span')?.style.backgroundColor).toBe('var(--bot-unread-bg)');
    expect(avatar.textContent).not.toContain('12');
    mocks.groups = [group({ teammateActivity: { phase: 'idle' }, serverUnread: { count: 0, mentioned: false } })];
    view.rerender(<TeammatesSection />);
    expect(view.container.querySelector('[data-teammate-status]')).toBeNull();
  });

  it('keeps only a green point for completed group unread in both layouts and clears on read', async () => {
    mocks.profiles = [];
    mocks.groups = [group({ teammateActivity: { phase: 'completed' }, serverUnread: { count: 3, mentioned: false } })];
    const view = await renderSidebar();
    const row = view.container.querySelector('[data-bot-group-id="g1"]')!;
    const status = row.querySelector('[data-teammate-row-status]')!;
    expect(status.querySelector('[data-teammate-unread-count]')).toBeNull();
    expect(status.querySelector<HTMLElement>('[data-teammate-status="done"] > span')?.style.backgroundColor).toBe('var(--card-status-done)');
    expect(row.querySelectorAll('[data-teammate-status]')).toHaveLength(1);
    switchView();
    const avatar = screen.getByRole('button', { name: /^周末出游 · / });
    expect(avatar.querySelector<HTMLElement>('[data-teammate-status="done"] > span')?.style.backgroundColor).toBe('var(--card-status-done)');
    expect(avatar.querySelector('[data-teammate-unread-count]')).toBeNull();
    mocks.groups = [group({ teammateActivity: { phase: 'completed' }, serverUnread: { count: 0, mentioned: false } })];
    view.rerender(<TeammatesSection />);
    expect(view.container.querySelector('[data-teammate-status]')).toBeNull();
    switchView();
    expect(view.container.querySelector('[data-teammate-unread-count]')).toBeNull();
  });

  it.each([['completed', 'done', 'var(--card-status-done)'], ['idle', 'unread', 'var(--bot-unread-bg)']] as const)('keeps %s unread groups visible in overflow and clears on read', async (phase, status, color) => {
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: { width: 48 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      mocks.groups = [group({ teammateActivity: { phase }, serverUnread: { count: 3, mentioned: false } })];
      const view = await renderSidebar();
      switchView();
      const more = screen.getByRole('button', { name: 'bots.list.sectionExpand · +3' });
      expect(more.querySelector<HTMLElement>(`[data-teammate-status="${status}"] > span`)?.style.backgroundColor).toBe(color);
      mocks.groups = [group({ teammateActivity: { phase }, serverUnread: { count: 0, mentioned: false } })];
      view.rerender(<TeammatesSection />);
      expect(more.querySelector('[data-teammate-status]')).toBeNull();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it('drops the mark once the mention is no longer unread', async () => {
    mocks.groups = [group({ serverUnread: { count: 0, mentioned: true } })];
    const view = await renderSidebar();
    switchView();
    expect(screen.getByRole('button', { name: '周末出游' })).toBeTruthy();
    expect(view.container.querySelector('[data-teammate-mention]')).toBeNull();
  });

  it('carries a hidden group mention onto the +N overflow entry', async () => {
    const original = globalThis.ResizeObserver;
    // One slot: every chat folds into +N.
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: { width: 48 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      mocks.groups = [group({ serverUnread: { count: 1, mentioned: true } })];
      await renderSidebar();
      switchView();
      const more = screen.getByRole('button', { name: `bots.list.sectionExpand · +3 · ${mentionLabel}` });
      expect(more.querySelector('[data-teammate-mention]')).not.toBeNull();
      // Mouse users read the same words as the accessible name.
      fireEvent.pointerEnter(more);
      fireEvent.pointerMove(more, { pointerType: 'mouse' });
      expect(await screen.findByRole('tooltip', { name: `bots.list.sectionExpand · +3 · ${mentionLabel}` })).toBeTruthy();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});


describe('topic reply sidebar entry', () => {
  const messageId = '40000000-0000-4000-8000-000000000002';
  const threadRootId = '40000000-0000-4000-8000-000000000001';
  it('labels thread replies as plain preview text without a separate clickable thread link', async () => {
    mocks.groups = [group({ lastMessage: { ...group().lastMessage!, messageId, threadRootId } })];
    const view = await renderSidebar();
    const label = screen.getByText('bots.groupChat.sidebar.threadReply');
    expect(label.closest('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /bots.groupChat.server.thread.viewThread/ })).toBeNull();
    expect(view.container.querySelectorAll('[data-bot-group-id="g1"] button')).toHaveLength(1);
    fireEvent.click(label);
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/groups/g1');
    fireEvent.click(screen.getByRole('button', { name: '周末出游' }));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/groups/g1');
  });

  it.each([undefined, null])('leaves main-chat and old-host previews unlabelled (root: %s)', async threadRootId => {
    mocks.groups = [group({ lastMessage: { ...group().lastMessage!, messageId, threadRootId, threadShare: true } })];
    await renderSidebar();
    expect(screen.queryByText('bots.groupChat.sidebar.threadReply')).toBeNull();
    expect(screen.queryByRole('button', { name: /bots.groupChat.server.thread.viewThread/ })).toBeNull();
  });

  it('keeps the thread reply preview while executing and hides it only for a confirmation hint', async () => {
    mocks.groups = [group({ speakingBotIds: ['mimi'], lastMessage: { ...group().lastMessage!, messageId, threadRootId } })];
    const view = await renderSidebar();
    expect(screen.queryByTestId('bot-group-running')).toBeNull();
    expect(screen.getByText('bots.groupChat.sidebar.threadReply')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /bots.groupChat.server.thread.viewThread/ })).toBeNull();
    mocks.islandActivity = new Map([['lane-mimi', { sessionId: 'lane-mimi', phase: 'needs-interaction' }]]);
    view.rerender(<TeammatesSection />);
    expect(screen.getByTestId('bot-group-running')).toBeTruthy();
    expect(screen.queryByText('bots.groupChat.sidebar.threadReply')).toBeNull();
  });
});

// Unit: in multi-user server groups, neither list view nor icon strip may show "working" when
// a peer or this account's own companion is active.
describe('server group own-agent working status', () => {
  const members = [
    { botId: 'cindy', actorKind: 'bot' as const, assistant: true, isOwned: false, name: 'Cindy', avatar: '', avatarColor: 'violet', status: 'active' as const },
    { botId: 'mimi', actorKind: 'bot' as const, isOwned: true, name: '咪咪', avatar: '', avatarColor: 'blue', status: 'active' as const },
    { botId: 'peer-bot', actorKind: 'bot' as const, isOwned: false, name: '别人伙伴', ownerName: 'Ann', avatar: '', avatarColor: 'emerald', status: 'active' as const },
  ];
  const switchView = () => {
    const wasIcons = readTeammatesViewMode('owner') === 'icons';
    fireEvent.keyDown(screen.getByRole('button', { name: 'ccAgent.sidebar.viewStyle' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: wasIcons ? 'ccAgent.sidebar.viewStyleListWide' : 'bots.list.viewIcons' }));
  };
  afterEach(() => window.localStorage.clear());

  it.each([
    { label: 'peer-requested Cindy', speaker: { botId: 'cindy', executionId: 'e1', isSelfRequested: false, executionStatus: 'running' as const, sessionId: null, activity: 'reply' as const } },
    { label: 'peer companion', speaker: { botId: 'peer-bot', executionId: 'e2', isSelfRequested: true, executionStatus: 'running' as const, sessionId: null, activity: 'reply' as const } },
  ])('hides working indicator in list and icon modes when only $label is running', async ({ speaker }) => {
    mocks.profiles = [];
    mocks.groups = [group({
      serverBacked: true,
      members,
      speakingBotIds: [speaker.botId],
      teammateActivity: { phase: 'idle' },
      round: { status: 'running', canContinue: false, othersActive: true, speakers: [speaker] },
    })];
    const view = await renderSidebar();
    expect(screen.queryByTestId('bot-group-running')).toBeNull();
    expect(view.container.querySelector('[data-teammate-status="running"]')).toBeNull();
    switchView();
    const button = screen.getByRole('button', { name: '周末出游' });
    expect(button.getAttribute('aria-label')).not.toContain('bots.avatarStatus.running');
    expect(view.container.querySelector('[data-teammate-status="running"]')).toBeNull();
  });

  it.each([
    { label: 'self-requested Cindy', speaker: { botId: 'cindy', executionId: 'e1', isSelfRequested: true, executionStatus: 'running' as const, sessionId: null, activity: 'reply' as const } },
    { label: 'own companion alongside peer Cindy', speaker: { botId: 'mimi', executionId: 'e2', isSelfRequested: false, executionStatus: 'running' as const, sessionId: 'lane-mimi', activity: 'reply' as const } },
  ])('keeps the group preview for own agents ($label)', async ({ speaker }) => {
    mocks.profiles = [];
    mocks.groups = [group({
      serverBacked: true,
      members,
      speakingBotIds: ['peer-bot', speaker.botId],
      teammateActivity: { phase: 'running' },
      round: { status: 'running', canContinue: false, othersActive: true, speakers: [
        { botId: 'peer-bot', executionId: 'e0', isSelfRequested: false, executionStatus: 'running', sessionId: null, activity: 'reply' },
        speaker,
      ] },
    })];
    const view = await renderSidebar();
    expect(screen.queryByTestId('bot-group-running')).toBeNull();
    switchView();
    expect(screen.getByRole('button', { name: '周末出游' })).toBeTruthy();
    expect(view.container.querySelector('[data-teammate-status="running"]')).toBeNull();
  });
});
