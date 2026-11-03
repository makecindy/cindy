// @vitest-environment jsdom

import { useState, type ReactNode } from 'react';
import Sortable, { type SortableEvent } from 'sortablejs';
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStartingSessionIds, markSessionStarting, resetSessionStartingStoreForTests, useStartingSessionIds } from '@/lib/sessionStartingStore';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import type { Session } from '@/lib/ccAgent.types';
import { groupSessions } from '@/features/cc-agent/lib/projectGrouping';
import {
  applyRemoteSessionActivity,
  clearRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';
import { ProjectsSection, type ProjectsSectionProps } from '../features/cc-agent/sidebar/sections/ProjectsSection';
import { useConversationSearch } from '../features/cc-agent/sidebar/ConversationSearchBox';
import { SidebarInlineSearch } from '../features/cc-agent/sidebar/SidebarInlineSearch';
import { ConfirmDialogProvider, useConfirmDialog } from '@/components/ui/confirm-dialog-provider';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/features/device-link/useMachineSwitcher', () => ({ useEffectiveSelectedMachineId: () => 'all' }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));
vi.mock('@/hooks/useSidebarCardMode', () => ({ useSidebarMainViewMode: () => ({ mode: 'text' }) }));
vi.mock('@cindy/maker-shared/cindy-make-feature', () => ({ CINDY_MAKE_ENABLED: true }));
vi.mock('../features/cc-agent/hooks/useRemoteHostProjectOrders', () => ({
  projectOrderWriteScopeForSelection: () => ({ kind: 'viewer' }),
  useLocalHostProjectOrder: () => ({ snapshot: { manualProjectOrder: [] } }),
  useRemoteHostProjectOrders: () => ({ orders: new Map() }),
}));
vi.mock('../features/cc-agent/sidebar/MainListScopeHeader', () => ({ MainListScopeHeader: ({ fold }: { fold: { label: string; onClick: () => void } | null }) => fold ? <button onClick={fold.onClick}>{fold.label}</button> : null }));
// main 633e27c76 起设备段头包了远程桌面快捷入口(挂 device-link presence 订阅,需要
// preload 桥);本文件只验证段头灯语与折叠豁免,段头壳层直接透传子节点。
vi.mock('../features/cc-agent/sidebar/DeviceSectionHeader', () => ({
  DeviceSectionHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../features/cc-agent/sidebar/sections/UnclassifiedSection', () => ({ UnclassifiedSection: () => null }));
vi.mock('@/features/bots/BotAvatar', () => ({ BotAvatar: () => <span>Bot avatar</span> }));
// Keep ProjectsSection, its private SessionGroupNode, SessionEntryList, collapse model,
// lamp aggregation and remote store real. Only unrelated services/leaf rows are stubbed.
const leafRowRenders = vi.hoisted(() => new Map<string, number>());
vi.mock('../features/cc-agent/sidebar/SessionItem', () => ({
  SessionItem: ({ session, onClick }: { session: Session; onClick: (id: string) => void }) => {
    leafRowRenders.set(session.id, (leafRowRenders.get(session.id) ?? 0) + 1);
    return <button data-testid={`row-${session.id}`} onClick={() => onClick(session.id)}>{session.title}</button>;
  },
}));
vi.mock('../features/cc-agent/sidebar/SessionCard', () => ({ SessionCard: () => null }));
vi.mock('../features/cc-agent/sidebar/AutomationSessionGroupItem', () => ({ AutomationSessionGroupItem: () => null }));

function props(groupDevice: boolean): ProjectsSectionProps {
  const sessions = ['first', 'idle', 'lit'].map((id, i) => ({
    id, title: id, status: 'active', createdAt: `2026-09-0${3 - i}T00:00:00Z`,
    updatedAt: `2026-09-0${3 - i}T00:00:00Z`, deviceLinkDeviceId: 'remote',
  } as Session));
  return {
    unclassified: [], projects: [], dialogues: [], allKnownProjects: [], allProjectKeysForOrder: ['local:known-project'],
    bots: [{ botId: 'demo', displayName: 'Demo Bot', avatar: '', avatarColor: '', sessions, latestActivityAt: sessions[0].updatedAt }],
    filter: {
      creators: 'all', creatorOptions: [], toggleCreator: vi.fn(), setCreatorsAll: vi.fn(), setCreatorsNone: vi.fn(),
      groupBy: 'project', groupDialogue: true, groupDevice, sortBy: 'recency',
      projectOrder: 'activity', manualProjectOrder: [], projects: 'all', status: 'active', isFilterActive: false,
      projectsAsSet: null, isSessionContentFiltered: false, vendor: 'all', lastActivity: 'all', manualPinnedOrder: [],
      setStatus: vi.fn(), toggleProject: vi.fn(), ensureProjectIncluded: vi.fn(), setProjectsAll: vi.fn(), gc: vi.fn(),
      setVendor: vi.fn(), setLastActivity: vi.fn(), setGroupBy: vi.fn(), setGroupDialogue: vi.fn(), setGroupDevice: vi.fn(),
      setSortBy: vi.fn(), setProjectOrder: vi.fn(), resetContentFilters: vi.fn(), setManualProjectOrder: vi.fn(),
      setManualPinnedOrder: vi.fn(), promotePin: vi.fn(), removePin: vi.fn(),
    },
    collapsed: new Set(), isAllCollapsed: false, runningSessionIds: new Set(), attachedSessionIds: new Set(),
    notifications: new Set(), scheduleSessionIndex: new Map(),
    remoteDeviceIndex: new Map([['remote', { name: 'Remote device', online: true }]]),
    onSessionClick: vi.fn(), onAction: vi.fn(), onRename: vi.fn(), onTogglePin: vi.fn(), onScheduleAction: vi.fn(),
    onToggleProject: vi.fn(), onToggleProjectPin: vi.fn(), onRenameProject: vi.fn(), onRemoveFromSidebar: vi.fn(),
    onCollapseAll: vi.fn(), onExpandAll: vi.fn(), onCreateInProject: vi.fn(), onOpenConversationSearch: vi.fn(),
    onOpenInExplorer: vi.fn(), onImportFromTools: vi.fn(), onBrowseFiles: vi.fn(),
    onArchiveAll: vi.fn(), onCreateDialogue: vi.fn(),
    onSearchDialogues: vi.fn(), onArchiveAllDialogues: vi.fn(),
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('sidebar.collapse.projectSessionLimit', '1');
  // ProjectsSection 渲染时读 window.electronAPI.platform 做项目键比较(main 897de9031);
  // jsdom 没有 preload 桥,这里只补 platform 字段,与 windowCloseBehavior 用例同法。
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform: 'darwin' } as unknown as Window['electronAPI'],
  });
});
afterEach(() => { remoteProjectsStore.__resetPinnedOriginsForTest(); cleanup(); resetSessionStartingStoreForTests(); vi.useRealTimers(); clearRemoteSessionActivity(); localStorage.clear(); });

const phases = ['running', 'needs-interaction', 'error', 'completed'] as const;

// #7469, unit: actual ProjectsSection -> ProjectNode memo -> SessionEntryList.
// Existing lamp tests did not update a different project; two one-row projects
// expose needless subtree rendering while retaining live remote lamp updates.
it('skips an untouched project subtree on a title patch and still updates its remote lamp', () => {
  const p = props(false);
  const rows = p.bots![0].sessions.slice(0, 2).map((s, i) => ({
    ...s, workingDir: `/project-${i}`, workspaceKind: 'project' as const,
    userSendAt: s.updatedAt, _count: { messages: 1 },
  }));
  p.bots = [];
  p.projects = groupSessions(rows).projects;
  p.allKnownProjects = p.projects;
  const view = render(<ProjectsSection {...p} />);
  leafRowRenders.clear();
  const changed = { ...p.projects[0], sessions: [{ ...p.projects[0].sessions[0], title: 'Fresh title' }] };
  view.rerender(<ProjectsSection {...p} projects={[changed, p.projects[1]]} />);
  expect(screen.getByText('Fresh title')).toBeTruthy();
  expect(leafRowRenders.get(rows[1].id) ?? 0).toBe(0);
  const project = p.projects[1];
  view.rerender(<ProjectsSection {...p} projects={[changed, project]} collapsed={new Set([project.projectKey])} />);
  const header = () => screen.getByText(project.displayName).closest('[data-project-header]')!;
  act(() => applyRemoteSessionActivity('remote', {
    sessionId: rows[1].id, phase: 'needs-interaction', attention: true, compactDetail: '',
  }));
  expectLamp(header(), 'needs-interaction');
  act(() => clearRemoteSessionActivity());
  expectLamp(header(), null);
});

function activity(phase: typeof phases[number]) {
  applyRemoteSessionActivity('remote', { sessionId: 'lit', phase, attention: true, compactDetail: '' });
}

// Issue #6575: render real ProjectsSection headers and observe the contextmenu
// boundary that opens the ancestor's organize menu. Existing lamp/drag tests do
// not right-click headers. Minimal regression input: one grouped dialogue and a
// bubbling, cancelable contextmenu event. Reuse this unit fixture to cover both
// device layouts, shared Bot/Make headers and the real ProjectNode menu.
// Standalone: 6.47s including pnpm (Vitest 5.01s, 2.68s collection); reuses
// the existing component fixture without another jsdom file or module resets.
describe('Sidebar group context menus', () => {
  // Issue #6575 P1 / DESIGN §14.2: the actual header is distinct from Radix's
  // positioning anchor. Existing key tests dispatched to an unfocused header,
  // hiding the lost focus. Unit: real menu opened by either keyboard shortcut.
  it.each(['ContextMenu', 'F10'])('returns focus to the dialogue header after %s then Escape', async (key) => {
    const p = props(false);
    p.bots = [];
    p.dialogues = [{ id: 'dialogue', title: 'Dialogue task', status: 'active', workspaceKind: 'dialogue' } as Session];
    render(<ProjectsSection {...p} />);
    const header = screen.getByText('ccAgent.sidebar.dialogues').closest<HTMLElement>('[role="button"]')!;
    header.focus();
    fireEvent.keyDown(header, { key, shiftKey: key === 'F10' });
    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    // Radix schedules close-auto-focus after its focus scope unmounts.
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(header);
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(document.activeElement!, { key: ' ' });
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps focus in the search field opened by a dialogue menu action', async () => {
    const p = props(false);
    p.bots = [];
    p.dialogues = [{ id: 'dialogue', title: 'Dialogue task', status: 'active', workspaceKind: 'dialogue' } as Session];
    function SidebarWithSearch() {
      const [openSignal, setOpenSignal] = useState(0);
      const search = useConversationSearch({ enabled: true, navigate: vi.fn(), allKnownProjects: [] });
      return <>
        <ProjectsSection {...p} onSearchDialogues={() => setOpenSignal((value) => value + 1)} />
        <SidebarInlineSearch search={search} allKnownProjects={[]} openSignal={openSignal} />
      </>;
    }
    render(<SidebarWithSearch />);
    const header = screen.getByText('ccAgent.sidebar.dialogues').closest<HTMLElement>('[role="button"]')!;
    header.focus();
    fireEvent.keyDown(header, { key: 'ContextMenu' });
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByText('ccAgent.sidebar.dialogueAction.search'));
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'ccAgent.search.placeholder' }));
  });

  // #6641 / DESIGN §14.2: no-op/notification-only actions have no next focus
  // owner; a real confirmation or search input must keep its own focus.
  it('returns focus after an archive action opens no follow-up dialog', async () => {
    const p = props(false);
    p.bots = [];
    p.dialogues = [{ id: 'running', title: 'Running', status: 'active', workspaceKind: 'dialogue' } as Session];
    p.runningSessionIds = new Set(['running']);
    render(<ProjectsSection {...p} />);
    const header = screen.getByText('ccAgent.sidebar.dialogues').closest<HTMLElement>('[role="button"]')!;
    header.focus();
    fireEvent.keyDown(header, { key: 'ContextMenu' });
    fireEvent.click(within(await screen.findByRole('menu')).getByText('ccAgent.sidebar.projectAction.archivedAll'));
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    expect(p.onArchiveAllDialogues).toHaveBeenCalledWith(p.dialogues);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(header);
  });

  it('keeps focus in the confirmation opened by an archive action', async () => {
    const p = props(false);
    p.bots = [];
    p.dialogues = [{ id: 'dialogue', title: 'Dialogue task', status: 'active', workspaceKind: 'dialogue' } as Session];
    function SidebarWithConfirmation() {
      const { confirm } = useConfirmDialog();
      return <ProjectsSection {...p} onArchiveAllDialogues={() => {
        void confirm({ title: 'Archive sessions', description: 'Archive this group?', cancelText: 'Keep sessions' });
      }} />;
    }
    render(<ConfirmDialogProvider><SidebarWithConfirmation /></ConfirmDialogProvider>);
    const header = screen.getByText('ccAgent.sidebar.dialogues').closest<HTMLElement>('[role="button"]')!;
    header.focus();
    fireEvent.keyDown(header, { key: 'ContextMenu' });
    fireEvent.click(within(await screen.findByRole('menu')).getByText('ccAgent.sidebar.projectAction.archivedAll'));
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    expect(document.activeElement).toBe(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep sessions' }));
  });

  it('preserves focus on an outside input when the menu is dismissed', async () => {
    const p = props(false);
    p.bots = [];
    p.dialogues = [{ id: 'dialogue', title: 'Dialogue task', status: 'active', workspaceKind: 'dialogue' } as Session];
    render(<><ProjectsSection {...p} /><input aria-label="Outside search" /></>);
    const outside = screen.getByRole('textbox', { name: 'Outside search' });
    const header = screen.getByText('ccAgent.sidebar.dialogues').closest<HTMLElement>('[role="button"]')!;
    header.focus();
    fireEvent.keyDown(header, { key: 'ContextMenu' });
    await screen.findByRole('menu');
    fireEvent.pointerDown(outside, { pointerType: 'mouse', button: 0 });
    outside.focus();
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  // The dedicated menu must act on the full group, including folded rows, and
  // never expose project actions or silently archive a local subset of a mixed group.
  // #6641: pinned rows are absent from the visible list but remain searchable,
  // participate in remote guards and stay within their owning device section.
  it.each(['active', 'archived'] as const)('offers scoped search and bulk %s actions for local dialogues', async (status) => {
    const p = props(false);
    p.bots = [];
    p.filter.status = status;
    p.dialogues = ['first', 'folded'].map((id) => ({
      id, title: id, status, workspaceKind: 'dialogue', pinnedAt: null,
      createdAt: '2026-09-03', updatedAt: '2026-09-03',
    } as Session));
    const pinned = { ...p.dialogues[0], id: 'pinned', pinnedAt: '2026-10-21' };
    const make: Session = { ...p.dialogues[0], id: 'make', source: 'cindy-make' };
    p.dialogueActionSessions = [...p.dialogues, pinned, make];
    render(<ProjectsSection {...p} />);
    const header = screen.getByText('ccAgent.sidebar.dialogues').closest('[role="button"]')!;
    expect(screen.queryByTestId('row-folded')).toBeNull();
    expect(screen.queryByTestId('row-pinned')).toBeNull();
    fireEvent.contextMenu(header);
    let menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    fireEvent.click(within(menu).getByText('ccAgent.sidebar.dialogueAction.search'));
    expect(p.onSearchDialogues).toHaveBeenCalledWith([...p.dialogues, pinned]);
    fireEvent.contextMenu(header);
    menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByText(status === 'archived'
      ? 'ccAgent.sidebar.dialogueAction.restoreAll'
      : 'ccAgent.sidebar.projectAction.archivedAll'));
    expect(p.onArchiveAllDialogues).toHaveBeenCalledWith([...p.dialogues, pinned]);
  });

  it('disables bulk actions when the only remote member is pinned', async () => {
    const p = props(false);
    p.bots = [];
    p.dialogues = [{ id: 'local', title: 'Local', status: 'active', workspaceKind: 'dialogue' } as Session];
    const remotePinned = { ...p.dialogues[0], id: 'pinned-remote', pinnedAt: '2026-10-21', deviceLinkDeviceId: 'remote' };
    p.dialogueActionSessions = [...p.dialogues, remotePinned];
    render(<ProjectsSection {...p} />);
    fireEvent.contextMenu(screen.getByText('ccAgent.sidebar.dialogues').closest('[role="button"]')!);
    const menu = await screen.findByRole('menu');
    const archive = within(menu).getByRole('menuitem', { name: /ccAgent.sidebar.projectAction.archivedAll/ });
    expect(archive.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(archive);
    expect(p.onArchiveAllDialogues).not.toHaveBeenCalled();
    fireEvent.click(within(menu).getByText('ccAgent.sidebar.dialogueAction.search'));
    expect(p.onSearchDialogues).toHaveBeenCalledWith([...p.dialogues, remotePinned]);
  });

  it('keeps pinned members within their own device section for group actions', async () => {
    const p = props(true);
    p.bots = [];
    p.dialogues = [{ id: 'local', title: 'Local', status: 'active', workspaceKind: 'dialogue' } as Session];
    const localPinned = { ...p.dialogues[0], id: 'pinned-local', pinnedAt: '2026-10-21' };
    const remotePinned = { ...localPinned, id: 'pinned-remote', deviceLinkDeviceId: 'remote' };
    p.dialogueActionSessions = [...p.dialogues, localPinned, remotePinned];
    render(<ProjectsSection {...p} />);
    fireEvent.contextMenu(screen.getByText('ccAgent.sidebar.dialogues').closest('[role="button"]')!);
    fireEvent.click(within(await screen.findByRole('menu')).getByText('ccAgent.sidebar.projectAction.archivedAll'));
    expect(p.onArchiveAllDialogues).toHaveBeenCalledWith([...p.dialogues, localPinned]);
  });

  it.each([false, true])('disables bulk actions when a dialogue group contains remote tasks, mixed %s', async (mixed) => {
    const p = props(false);
    p.dialogues = [{ ...p.bots![0].sessions[0], id: 'remote-dialogue' }];
    p.bots = [];
    if (mixed) p.dialogues.push({ ...p.dialogues[0], id: 'local-dialogue', deviceLinkDeviceId: undefined });
    render(<ProjectsSection {...p} />);
    fireEvent.contextMenu(screen.getByText('ccAgent.sidebar.dialogues').closest('[role="button"]')!);
    const menu = await screen.findByRole('menu');
    const archive = within(menu).getByRole('menuitem', { name: /ccAgent.sidebar.projectAction.archivedAll/ });
    expect(archive.getAttribute('aria-disabled')).toBe('true');
    expect(within(menu).getByText('ccAgent.sidebar.dialogueAction.remoteBulkUnavailable')).toBeTruthy();
    fireEvent.click(archive);
    expect(p.onArchiveAllDialogues).not.toHaveBeenCalled();
    fireEvent.click(within(menu).getByText('ccAgent.sidebar.dialogueAction.search'));
    expect(p.onSearchDialogues).toHaveBeenCalledWith(p.dialogues);
  });

  it.each([false, true])('contains dialogue right-clicks and preserves its controls, device grouping %s', async (groupDevice) => {
    const p = props(groupDevice);
    p.dialogues = [{ ...p.bots![0].sessions[0], id: 'dialogue', title: 'Dialogue task' }];
    const onSidebarContextMenu = vi.fn();
    render(<div onContextMenu={onSidebarContextMenu}><ProjectsSection {...p} /></div>);
    const header = screen.getByText('ccAgent.sidebar.dialogues').closest<HTMLElement>('[role="button"]')!;
    const event = createEvent.contextMenu(header);
    fireEvent(header, event);
    expect(event.defaultPrevented).toBe(true);
    expect(onSidebarContextMenu).not.toHaveBeenCalled();
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(await screen.findByRole('menu'), { key: 'Escape' });

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(header, { key: ' ' });
    expect(header.getAttribute('aria-expanded')).toBe('false');

    const create = within(header).getByRole('button', { name: 'ccAgent.sidebar.newDialogue' });
    fireEvent.contextMenu(create);
    expect(onSidebarContextMenu).not.toHaveBeenCalled();
    fireEvent.click(create);
    expect(p.onCreateDialogue).toHaveBeenCalledWith(
      groupDevice ? { deviceId: 'remote', deviceName: 'Remote device' } : undefined,
    );
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  it('preserves shared Bot/Make headers, blank-area events and the project menu', async () => {
    const p = props(false);
    p.dialogues = [{ ...p.bots![0].sessions[0], id: 'make', source: 'cindy-make' }];
    p.projects = [{
      projectKey: 'local:/Project', workingDir: '/Project', displayName: 'Project',
      scope: 'local', sessions: [], segments: 1, latestActivityAt: '2026-09-03T00:00:00Z',
      remoteHostId: null, deviceLinkDeviceId: null,
      deviceLinkDeviceName: null, deviceLinkConnectionStatus: null,
    }];
    p.allKnownProjects = p.projects;
    p.allProjectKeysForOrder = p.projects.map((project) => project.projectKey);
    const onSidebarContextMenu = vi.fn();
    render(<div onContextMenu={onSidebarContextMenu}>
      <ProjectsSection {...p} />
      <span>Sidebar blank area</span>
    </div>);
    for (const title of ['Demo Bot', 'settings.cindyMake.title']) {
      const header = screen.getByText(title).closest<HTMLElement>('[role="button"]')!;
      const event = createEvent.contextMenu(header);
      fireEvent(header, event);
      expect(event.defaultPrevented).toBe(false);
    }
    fireEvent.contextMenu(screen.getByText('Sidebar blank area'));
    expect(onSidebarContextMenu).toHaveBeenCalledTimes(3);

    fireEvent.contextMenu(screen.getByText('Project').closest('[data-project-header]')!);
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(onSidebarContextMenu).toHaveBeenCalledTimes(3);
  });
});

// PR #6196 / manualProjectSortDrag: the historical handle/filter overlap made
// every project header reject drag start. Existing lamp tests use activity order,
// so they never mount SortableList. Reuse this real ProjectsSection/ProjectNode
// unit harness with two projects in custom order; selectors come from the actual
// SortableJS instance, and its real onEnd must persist the reordered projects.
describe('Manual project sorting', () => {
  it('leaves the real project header draggable and persists a completed reorder', () => {
    const p = props(false);
    p.bots = [];
    p.projects = ['First', 'Second'].map((name) => ({
      projectKey: 'local:/' + name, workingDir: '/' + name, displayName: name,
      scope: 'local', sessions: [], segments: 1, latestActivityAt: '2026-09-03T00:00:00Z',
      remoteHostId: null, deviceLinkDeviceId: null,
      deviceLinkDeviceName: null, deviceLinkConnectionStatus: null,
    }));
    p.allProjectKeysForOrder = p.projects.map((project) => project.projectKey);
    p.filter.projectOrder = 'custom';
    p.filter.manualProjectOrder = [...p.allProjectKeysForOrder];
    render(<ProjectsSection {...p} />);

    const header = screen.getByText('First').closest<HTMLElement>('[data-project-header]')!;
    const moved = header.closest<HTMLElement>('[data-sortable-id]')!;
    const list = moved.parentElement!;
    const sortable = Sortable.get(list)!;
    expect(sortable.option('disabled')).toBe(false);
    expect(header.matches(sortable.option('handle') as string)).toBe(true);
    expect(header.closest(sortable.option('filter') as string)).toBeNull();

    // Sortable owns pointer geometry; replay its drop boundary against the real
    // list and DOM move rather than copying its reorder or persistence logic.
    list.append(moved);
    act(() => {
      sortable.option('onEnd')!.call(sortable, Object.assign(new Event('end'), {
        item: moved, from: list, oldIndex: 0, newIndex: 1,
      }) as SortableEvent);
    });
    expect(p.filter.setManualProjectOrder).toHaveBeenCalledWith(
      ['local:/Second', 'local:/First'], p.allProjectKeysForOrder,
    );
  });
});

describe.each([false, true])('Bot groups with device grouping %s', (groupDevice) => {
  it.each(phases)('renders the collapsed Bot header lamp for remote %s', (phase) => {
    activity(phase);
    render(<ProjectsSection {...props(groupDevice)} />);
    expect(Boolean(screen.queryByText('Remote device'))).toBe(groupDevice);
    const header = screen.getByText('Demo Bot').closest('[role="button"]')!;
    expectLamp(header, null);
    fireEvent.click(header);
    if (phase === 'running') {
      expect(header.querySelector('.session-status-breathing')).not.toBeNull();
      // 伙伴头像不吃 wrapper 的 currentColor,运行色必须以静态描边落在 wrapper 上,
      // 减弱动效(动画被全局关掉)时仍可见(Codex review)。
      const marker = header.querySelector('[data-running-marker]')!;
      expect(marker.getAttribute('data-running-marker')).toBe('ring');
      expect(marker.className).toContain('ring-[var(--status-bar-accent)]');
    } else {
      expect(header.querySelector('[data-running-marker]')).toBeNull();
      expectLamp(header, phase);
    }
  });

  it.each(phases)('reveals the remote %s row beyond the group limit without Show all', (phase) => {
    activity(phase);
    render(<ProjectsSection {...props(groupDevice)} />);
    expect(screen.getByTestId('row-first')).toBeTruthy();
    expect(screen.queryByTestId('row-idle')).toBeNull();
    expect(screen.queryByTestId('row-lit')).not.toBeNull();
    expect(screen.getByText('ccAgent.sidebar.showAllSessions')).toBeTruthy();
  });

  it('updates the rendered group on remote activity and shows its header lamp only while collapsed', () => {
    render(<ProjectsSection {...props(groupDevice)} />);
    expect(screen.queryByTestId('row-lit')).toBeNull();
    const header = screen.getByText('Demo Bot').closest('[role="button"]')!;
    expect(header.querySelector('.session-status-breathing')).toBeNull();
    act(() => activity('running'));
    expect(screen.queryByTestId('row-lit')).not.toBeNull();
    expectLamp(header, null);
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.querySelector('.session-status-breathing')).not.toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expectLamp(header, null);
    expect(screen.queryByTestId('row-lit')).not.toBeNull();
    act(() => clearRemoteSessionActivity());
    expect(screen.queryByTestId('row-lit')).toBeNull();
    expect(header.querySelector('.session-status-breathing')).toBeNull();
  });
});

// Use the real starting store/hook as the parent display-running source. No fake
// absorption or direct prop replacement: ProjectsSection must settle it itself.
function StartingSidebar(p: ProjectsSectionProps) {
  const starting = useStartingSessionIds(p.runningSessionIds);
  return <ProjectsSection {...p} runningSessionIds={new Set([...p.runningSessionIds, ...starting])} />;
}
function botHeader(root: HTMLElement = document.body) {
  return within(root).getByText('Demo Bot').closest<HTMLElement>('[role="button"]')!;
}
function deviceHeader(name: string) { return screen.getByText(name).closest('button')!; }
function expectLamp(header: Element, phase: typeof phases[number] | null) {
  expect(Boolean(header.querySelector('.session-status-breathing'))).toBe(phase === 'running');
  for (const tone of ['awaiting', 'error', 'done']) {
    const expected = phase === 'needs-interaction' ? 'awaiting' : phase === 'completed' ? 'done' : phase;
    expect(Boolean(header.querySelector(`[class*="--card-status-${tone}"], [data-sidebar-right-status="${tone}"]`))).toBe(tone === expected);
  }
}

describe.each([false, true])('Bot starting lifecycle, device grouping %s', (groupDevice) => {
  for (const first of ['running', 'needs-interaction'] as const) {
    it.each(['completed', 'error'] as const)(`${first} settles starting before %s without waiting for TTL`, (terminal) => {
      vi.useFakeTimers();
      const p = props(groupDevice);
      remoteProjectsStore.pinSessionOrigin('remote', 'lit');
      markSessionStarting('lit');
      render(<StartingSidebar {...p} />);
      expectLamp(botHeader(), null);
      fireEvent.click(botHeader());
      expectLamp(botHeader(), 'running');
      act(() => activity(first));
      expect.soft(getStartingSessionIds().has('lit')).toBe(false);
      act(() => activity(terminal));
      expectLamp(botHeader(), terminal);
      if (groupDevice) expectLamp(deviceHeader('Remote device'), null);
      fireEvent.click(botHeader());
      expectLamp(botHeader(), null);
      expect(screen.getByTestId('row-lit')).toBeTruthy();
      // No timer advancement: the terminal UI must be correct immediately.
    });
  }

  it('settles when only the bots prop arrives after the remote activity', () => {
    vi.useFakeTimers();
    const p = props(groupDevice);
    markSessionStarting('lit');
    activity('running');
    const view = render(<StartingSidebar {...p} bots={[]} />);
    expect(getStartingSessionIds().has('lit')).toBe(true);
    view.rerender(<StartingSidebar {...p} />);
    expect(getStartingSessionIds().has('lit')).toBe(false);
    fireEvent.click(botHeader());
    act(() => activity('completed'));
    expectLamp(botHeader(), 'completed');
  });

  it('keeps the existing no-in-flight terminal fallback and local running settlement', () => {
    vi.useFakeTimers();
    const p = props(groupDevice);
    markSessionStarting('lit');
    activity('completed');
    const view = render(<StartingSidebar {...p} />);
    expect(getStartingSessionIds().has('lit')).toBe(true);
    view.rerender(<StartingSidebar {...p} runningSessionIds={new Set(['lit'])} />);
    expect(getStartingSessionIds().has('lit')).toBe(false);
  });
});

function multiDeviceProps(): ProjectsSectionProps {
  const p = props(true);
  const bot = p.bots![0];
  p.bots = [{ ...bot, sessions: [
    { ...bot.sessions[0], id: 'a-first', deviceLinkDeviceId: 'a' },
    { ...bot.sessions[1], id: 'a-idle', deviceLinkDeviceId: 'a' },
    { ...bot.sessions[0], id: 'b-first', deviceLinkDeviceId: 'b' },
    { ...bot.sessions[1], id: 'b-idle', deviceLinkDeviceId: 'b' },
    { ...bot.sessions[2], id: 'lit', deviceLinkDeviceId: 'b' },
  ] }];
  p.remoteDeviceIndex = new Map([['a', { name: 'Device A', online: true }], ['b', { name: 'Device B', online: true }]]);
  p.onOpenBot = vi.fn();
  return p;
}

describe('Bot groups across devices', () => {
  it('keeps awaiting visible in a collapsed project while its device is expanded', () => {
    const p = props(true);
    const session = p.bots![0].sessions[2];
    const projectKey = 'device-link:remote:/demo';
    p.bots = [];
    p.projects = [{
      projectKey, displayName: 'Demo project', workingDir: '/demo', scope: 'local',
      sessions: [session], remoteHostId: null, deviceLinkDeviceId: 'remote',
      deviceLinkDeviceName: 'Remote device', deviceLinkConnectionStatus: 'connected',
      segments: 1, latestActivityAt: session.updatedAt,
    }];
    p.collapsed = new Set([projectKey]);
    activity('needs-interaction');
    const view = render(<ProjectsSection {...p} />);
    const projectHeader = () => screen.getByText('Demo project').closest('[data-project-header]')!;
    expectLamp(deviceHeader('Remote device'), null);
    expectLamp(projectHeader(), 'needs-interaction');
    expect(screen.queryByTestId('row-lit')).toBeNull();
    fireEvent.click(deviceHeader('Remote device'));
    expectLamp(deviceHeader('Remote device'), 'needs-interaction');
    fireEvent.click(deviceHeader('Remote device'));
    expectLamp(deviceHeader('Remote device'), null);
    expectLamp(projectHeader(), 'needs-interaction');
    view.rerender(<ProjectsSection {...p} collapsed={new Set()} />);
    expectLamp(projectHeader(), null);
    expect(screen.getByTestId('row-lit')).toBeTruthy();
  });

  it.each(phases)('keeps %s lamps and exempt rows on the owning device', (phase) => {
    const p = multiDeviceProps();
    render(<ProjectsSection {...p} />);
    act(() => applyRemoteSessionActivity('b', { sessionId: 'lit', phase, attention: true, compactDetail: '' }));
    expectLamp(deviceHeader('Device A'), null);
    const a = deviceHeader('Device A').parentElement!;
    const b = deviceHeader('Device B').parentElement!;
    expectLamp(deviceHeader('Device B'), null);
    expectLamp(botHeader(a), null);
    expectLamp(botHeader(b), null);
    fireEvent.click(botHeader(b));
    expectLamp(botHeader(b), phase);
    fireEvent.click(botHeader(b));
    expectLamp(botHeader(b), null);
    expect(within(a).queryByTestId('row-lit')).toBeNull();
    expect(within(b).getByTestId('row-lit')).toBeTruthy();
    expect(screen.getAllByText('Demo Bot')).toHaveLength(2);
    expect(within(a).getAllByTestId(/^row-/)).toHaveLength(1);
    expect(within(b).getAllByTestId(/^row-/)).toHaveLength(2);
    fireEvent.click(within(b).getByTestId('row-lit'));
    expect(p.onSessionClick).toHaveBeenCalledWith('lit');
    fireEvent.click(within(b).getByRole('button', { name: 'bots.sidebar.newTaskWith' }));
    expect(p.onOpenBot).toHaveBeenCalledWith('demo');
    fireEvent.click(deviceHeader('Device B'));
    expect(deviceHeader('Device B').getAttribute('aria-expanded')).toBe('false');
    expectLamp(deviceHeader('Device B'), phase);
    fireEvent.click(deviceHeader('Device B'));
    expect(deviceHeader('Device B').getAttribute('aria-expanded')).toBe('true');
    expectLamp(deviceHeader('Device B'), null);
  });

  it('keeps show-all state per device and stable across task reorder and Bot rename', () => {
    const p = multiDeviceProps();
    const view = render(<ProjectsSection {...p} />);
    const a = deviceHeader('Device A').parentElement!;
    const b = deviceHeader('Device B').parentElement!;
    fireEvent.click(within(b).getByText('ccAgent.sidebar.showAllSessions'));
    expect(within(b).getAllByTestId(/^row-/)).toHaveLength(3);
    expect(within(a).getAllByTestId(/^row-/)).toHaveLength(1);
    const bHeader = botHeader(b);
    view.rerender(<ProjectsSection {...p} bots={[{ ...p.bots![0], displayName: 'Renamed Bot', sessions: [...p.bots![0].sessions].reverse() }]} />);
    expect(within(b).getByText('Renamed Bot').closest('[role="button"]')).toBe(bHeader);
    expect(within(b).getAllByTestId(/^row-/)).toHaveLength(3);
    expect(within(a).getAllByTestId(/^row-/)).toHaveLength(1);
  });

  it('folds Bot groups independently per device and includes them in fold-all', () => {
    vi.useFakeTimers();
    render(<ProjectsSection {...multiDeviceProps()} />);
    const a = deviceHeader('Device A').parentElement!;
    const b = deviceHeader('Device B').parentElement!;
    fireEvent.click(botHeader(a));
    expect(botHeader(a).getAttribute('aria-expanded')).toBe('false');
    expect(botHeader(b).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByText('ccAgent.sidebar.foldAll.collapseProjects'));
    expect(botHeader(b).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByText('ccAgent.sidebar.foldAll.collapseDevices'));
    expect(deviceHeader('Device A').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByText('ccAgent.sidebar.foldAll.expandAll'));
    expect(botHeader(a).getAttribute('aria-expanded')).toBe('true');
    expect(botHeader(b).getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps one Bot group with every task when device grouping is off', () => {
    const p = multiDeviceProps();
    p.filter.groupDevice = false;
    render(<ProjectsSection {...p} />);
    expect(screen.getAllByText('Demo Bot')).toHaveLength(1);
    expect(screen.queryByText('Device A')).toBeNull();
    fireEvent.click(screen.getByText('ccAgent.sidebar.showAllSessions'));
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(5);
  });
});
