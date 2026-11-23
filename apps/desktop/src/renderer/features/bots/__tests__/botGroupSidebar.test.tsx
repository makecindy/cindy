// @vitest-environment jsdom
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
import { BotCreateMenu } from '../BotCreateMenu';

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
    value: { localDb: { messages: { onCreated: () => () => undefined } }, maker: { chatServer: {
      manage: mocks.manage, status: async () => ({ enabled: false }),
    } } },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Each text row's outer element carries data-teammate-row / data-teammate-status;
// group rows also carry data-bot-group-id.
const groupStatus = (id = 'g1') =>
  document.querySelector(`[data-bot-group-id="${id}"]`)?.getAttribute('data-teammate-status');
const rowOf = (button: HTMLElement) => button.closest('[data-teammate-row]') as HTMLElement;
const hasSpinner = (row: Element | null) => !!row?.querySelector('[data-sidebar-right-status="running"]');
const isBold = (row: Element | null) => !!row?.querySelector('span[title]')?.className.includes('font-semibold');

describe('TeammatesSection group chats', () => {
  // #10822 / unit: exercise the real group row with an already-read server
  // group and a retained hidden error. Earlier sidebar cases omit this overlap.
  it('uses the server group result after stopping while preserving new failures and decisions', async () => {
    mocks.profiles = [bot('mimi', '咪咪', [{ id: 'failed-step', kind: 'group', role: 'group', groupId: 'g1' }])];
    mocks.islandActivity = new Map([['failed-step', { sessionId: 'failed-step', phase: 'error' }]]);
    mocks.groups = [group({ serverBacked: true, serverUnread: { count: 0, mentioned: false },
      teammateActivity: { phase: 'error' } })];
    const view = await renderSidebar();
    expect(groupStatus()).toBe('error');
    mocks.groups = [{ ...mocks.groups[0]!, teammateActivity: { phase: 'idle' } }];
    view.rerender(<TeammatesSection />);
    expect(groupStatus()).toBe('idle');
    // The original Session may already have disappeared; it is not needed to settle the group.
    mocks.profiles = [];
    view.rerender(<TeammatesSection />);
    expect(groupStatus()).toBe('idle');
    mocks.groups = [{ ...mocks.groups[0]!, teammateActivity: { phase: 'error' } }];
    view.rerender(<TeammatesSection />);
    expect(groupStatus()).toBe('error');
    mocks.groups = [{ ...mocks.groups[0]!, teammateActivity: { phase: 'needs-interaction' } }];
    view.rerender(<TeammatesSection />);
    expect(groupStatus()).toBe('awaiting');
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
    const next = screen.getByRole('button', { name: '咪咪' });
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

  it('restores the original row and shows the error after an archive request fails', async () => {
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
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(screen.getByRole('alert').textContent).toBe('bots.groupChat.server.settings.conflict');
    expect(mocks.refreshGroups).not.toHaveBeenCalled();
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

  it('lists groups alongside teammates, marks the open one and opens them', async () => {
    mocks.groups = [group(), group({ id: 'g2', name: '读书会', lastMessage: null, updatedAt: 1 })];
    mocks.pathname = '/bots/groups/g1';
    await renderSidebar();
    expect(screen.queryByText('bots.groupChat.sidebar.title')).toBeNull();
    const rows = screen.getAllByRole('button', { current: 'page' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('aria-label')).toBe('周末出游');
    expect(rowOf(rows[0]!).getAttribute('data-bot-group-id')).toBe('g1');
    fireEvent.click(screen.getByRole('button', { name: '读书会' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/g2');
  });

  // Unit regression: a group row drags into split view like the task rows.
  it('drags a group row as its chat route', async () => {
    mocks.groups = [group()];
    await renderSidebar();
    const data = new Map<string, string>();
    const row = screen.getByRole('button', { name: '周末出游' });
    expect(row.draggable).toBe(true);
    fireEvent.dragStart(row, { dataTransfer: { setData: (key: string, value: string) => data.set(key, value) } });
    expect([...data.values()]).toEqual(['/bots/groups/g1']);
  });

  it('opens teammate creation from the empty-roster entry', async () => {
    mocks.profiles = [];
    await renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'bots.add' }));
    expect(screen.getByRole('dialog').textContent).toBe('create-teammate-dialog');
  });

  it('moves a group above older private chats on a new message while preserving pins', async () => {
    mocks.profiles = [{ ...bot('mimi', '咪咪'), lastMessageAt: 20 },
      { ...bot('xiaoman', '小满'), pinnedAt: 1 }];
    mocks.groups = [group()];
    const view = await renderSidebar();
    const order = () => Array.from(view.container.querySelectorAll('[data-teammate-row] span[title]'), span => span.textContent);
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

  it('shows the running spinner on the group, not on the speaking teammate’s own row', async () => {
    mocks.groups = [group({ speakingBotIds: ['mimi'] })];
    mocks.islandActivity = new Map([
      ['lane-mimi', { sessionId: 'lane-mimi', phase: 'running', workingPhase: 'searching' }],
    ]);
    await renderSidebar();
    expect(groupStatus()).toBe('running');
    expect(hasSpinner(document.querySelector('[data-bot-group-id="g1"]'))).toBe(true);
    const mate = rowOf(screen.getByRole('button', { name: '咪咪' }));
    expect(mate.getAttribute('data-teammate-status')).toBe('idle');
    expect(hasSpinner(mate)).toBe(false);
  });

  it('marks a plan waiting for 开始 or for 继续 / 重试 as awaiting, not running', async () => {
    mocks.groups = [
      group({ id: 'g1', name: '官网', openPlan: openPlan({ status: 'proposed', currentStep: null }) }),
      group({ id: 'g2', name: '周报', updatedAt: 9, openPlan: openPlan() }),
    ];
    await renderSidebar();
    for (const id of ['g1', 'g2']) {
      const row = document.querySelector(`[data-bot-group-id="${id}"]`);
      expect(row?.getAttribute('data-teammate-status')).toBe('awaiting');
      expect(isBold(row)).toBe(true);
      expect(hasSpinner(row)).toBe(false);
    }
  });

  it('shows the organizer working out a plan as running', async () => {
    mocks.groups = [group({ speakingBotIds: ['xiaoman'], planningBotId: 'xiaoman' })];
    await renderSidebar();
    expect(groupStatus()).toBe('running');
  });

  it('turns a running step into awaiting when the teammate doing it waits for the user', async () => {
    mocks.profiles = [bot('mimi', '咪咪', [{ id: 'lane-mimi', kind: 'group', role: 'group', groupId: 'g1' }])];
    mocks.groups = [
      group({
        speakingBotIds: ['mimi'],
        openPlan: openPlan({ status: 'running', currentStepStatus: 'running' }),
      }),
    ];
    mocks.islandActivity = new Map([['lane-mimi', { sessionId: 'lane-mimi', phase: 'needs-interaction' }]]);
    await renderSidebar();
    expect(groupStatus()).toBe('awaiting');
    expect(isBold(document.querySelector('[data-bot-group-id="g1"]'))).toBe(true);
  });
});

it('bolds unread groups for current hosts and the one-message fallback for older hosts, without counts', async () => {
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
    for (const id of ['g1', 'g2']) {
      const row = document.querySelector(`[data-bot-group-id="${id}"]`);
      expect(row?.getAttribute('data-teammate-status')).toBe('unread');
      expect(isBold(row)).toBe(true);
    }
    expect(document.querySelector('[data-teammate-unread-count]')).toBeNull();
  } finally {
    resetBotReadStateForTests();
    window.localStorage.clear();
  }
});

describe('server group unread', () => {
  it.each([['idle', 'unread'], ['completed', 'done']] as const)('bolds a %s server group with unread messages and clears on read', async (phase, status) => {
    mocks.profiles = [];
    mocks.groups = [group({ teammateActivity: { phase }, serverUnread: { count: 12, mentioned: true } })];
    const view = await renderSidebar();
    expect(groupStatus()).toBe(status);
    expect(isBold(document.querySelector('[data-bot-group-id="g1"]'))).toBe(true);
    // No count or @ mark on the text row.
    expect(screen.getByRole('button', { name: `周末出游 · bots.avatarStatus.${status}` })).toBeTruthy();
    expect(view.container.textContent).toBe('周末出游');
    mocks.groups = [group({ teammateActivity: { phase }, serverUnread: { count: 0, mentioned: false } })];
    view.rerender(<TeammatesSection />);
    expect(groupStatus()).toBe('idle');
    expect(isBold(document.querySelector('[data-bot-group-id="g1"]'))).toBe(false);
  });

  it('keeps running ahead of unread on a group', async () => {
    mocks.profiles = [];
    mocks.groups = [group({ speakingBotIds: ['mimi'], serverUnread: { count: 2, mentioned: true } })];
    await renderSidebar();
    expect(groupStatus()).toBe('running');
    expect(hasSpinner(document.querySelector('[data-bot-group-id="g1"]'))).toBe(true);
  });
});

// The 「伙伴」 tab's plus (SidebarMainTabs) renders this same creation menu.
describe('teammate creation menu', () => {
  it('offers teammate, group and pasting an invitation as a separate fallback', async () => {
    render(<BotCreateMenu variant="header" />);
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

  it.each([
    ['bots.list.createTeammate', 'create-teammate-dialog'],
    ['bots.groupChat.create.title', 'create-group-dialog'],
  ])('opens %s from the menu', async (item, dialog) => {
    render(<BotCreateMenu variant="header" />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'bots.list.createMenu' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: item }));
    expect(screen.getByRole('dialog').textContent).toBe(dialog);
  });
});
