// @vitest-environment jsdom

import type { ReactNode } from 'react';
import Sortable, { type SortableEvent } from 'sortablejs';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
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

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
// The teammate data adapter owns auth/presence. This fixture exercises task mode switching.
vi.mock('@/features/bots/useTeammateInboxEntries', () => ({ useTeammateInboxEntries: () => [] }));
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
vi.mock('../features/cc-agent/sidebar/sections/UnclassifiedSection', () => ({ UnclassifiedSection: () => null }));
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

function remoteSessions(): Session[] {
  return ['first', 'idle', 'lit'].map((id, i) => ({
    id, title: id, status: 'active', createdAt: `2026-09-0${3 - i}T00:00:00Z`,
    updatedAt: `2026-09-0${3 - i}T00:00:00Z`, deviceLinkDeviceId: 'remote',
  } as Session));
}

// 极简侧栏(2026-11-19)后不再有竖向设备分段;groupDevice 只是残留的本地设置,
// 默认关闭,仅在「旧设置不再切段」的用例里打开。
function props(groupDevice = false): ProjectsSectionProps {
  return {
    unclassified: [], projects: [], dialogues: [], allKnownProjects: [], allProjectKeysForOrder: ['local:known-project'],
    filter: {
      creators: 'all', creatorOptions: [], toggleCreator: vi.fn(), setCreatorsAll: vi.fn(), setCreatorsNone: vi.fn(),
      hideAutomations: false, setHideAutomations: vi.fn(),
      groupBy: 'project', groupDialogue: true, groupAutomation: false, groupDevice, sortBy: 'recency',
      pinnedSortBy: 'manual', setPinnedSortBy: vi.fn(),
      projectOrder: 'activity', manualProjectOrder: [], projects: 'all', status: 'active', isFilterActive: false,
      projectsAsSet: null, isSessionContentFiltered: false, vendor: 'all', lastActivity: 'all', manualPinnedOrder: [],
      setStatus: vi.fn(), toggleProject: vi.fn(), ensureProjectIncluded: vi.fn(), setProjectsAll: vi.fn(), gc: vi.fn(),
      setVendor: vi.fn(), setLastActivity: vi.fn(), setGroupBy: vi.fn(), setGroupDialogue: vi.fn(), setGroupAutomation: vi.fn(), setGroupDevice: vi.fn(),
      setSortBy: vi.fn(), setProjectOrder: vi.fn(), resetContentFilters: vi.fn(), setManualProjectOrder: vi.fn(),
      setManualPinnedOrder: vi.fn(), promotePin: vi.fn(), removePin: vi.fn(),
    },
    collapsed: new Set(), isAllCollapsed: false, runningSessionIds: new Set(), attachedSessionIds: new Set(),
    notifications: new Set(), scheduleSessionIndex: new Map(),
    remoteDeviceIndex: new Map([['remote', { name: 'Remote device', online: true }]]),
    onSessionClick: vi.fn(), onAction: vi.fn(), onRename: vi.fn(), onTogglePin: vi.fn(), onScheduleAction: vi.fn(),
    onToggleProject: vi.fn(), onSettings: vi.fn(), onRenameProject: vi.fn(),
    onCollapseAll: vi.fn(), onExpandAll: vi.fn(), onCreateInProject: vi.fn(), onOpenConversationSearch: vi.fn(),
    onOpenInExplorer: vi.fn(), onBrowseFiles: vi.fn(),
    onArchiveAll: vi.fn(), onCreateDialogue: vi.fn(),
    onSearchDialogues: vi.fn(), onArchiveAllDialogues: vi.fn(),
  };
}

/** Three remote tasks in the shared dialogue group (limit 1, so two rows fold). */
function groupProps(): ProjectsSectionProps {
  return { ...props(), dialogues: remoteSessions() };
}

/**
 * 对话组在「对话」标签里不画组头(标签本身就是组);仍带组头、可收起的共享组是 Cindy Make。
 * 同三条远程任务改成 Make 来源，复用同一份组头聚合灯与折叠豁免。
 */
function makeGroupProps(): ProjectsSectionProps {
  return { ...props(), dialogues: remoteSessions().map((s) => ({ ...s, source: 'cindy-make' })) };
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
  const rows = remoteSessions().slice(0, 2).map((s, i) => ({
    ...s, workingDir: `/project-${i}`, workspaceKind: 'project' as const,
    userSendAt: s.updatedAt, _count: { messages: 1 },
  }));
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
// boundary that opens the ancestor's organize menu. Minimal regression input: the
// shared Make header, a blank area and a project header with a bubbling,
// cancelable contextmenu event. The dialogue group header (and its menu) is gone
// since the chats tab became headerless (2026-11-19).
describe('Sidebar group context menus', () => {
  it('preserves the shared Make header, blank-area events and the project menu', async () => {
    const p = props(false);
    p.dialogues = [{ ...remoteSessions()[0], id: 'make', source: 'cindy-make' }];
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
    const header = screen.getByText('settings.cindyMake.title').closest<HTMLElement>('[role="button"]')!;
    const event = createEvent.contextMenu(header);
    fireEvent(header, event);
    expect(event.defaultPrevented).toBe(false);
    fireEvent.contextMenu(screen.getByText('Sidebar blank area'));
    expect(onSidebarContextMenu).toHaveBeenCalledTimes(2);

    fireEvent.contextMenu(screen.getByText('Project').closest('[data-project-header]')!);
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(onSidebarContextMenu).toHaveBeenCalledTimes(2);
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

function makeHeader() {
  return screen.getByText('settings.cindyMake.title').closest<HTMLElement>('[role="button"]')!;
}
/**
 * 极简侧栏的状态观测点:运行中 = 行尾转圈(data-sidebar-right-status="running");
 * 出错 / 等你回复 / 完成未读 = 加粗标题上的同名属性。一个组头最多只亮一种。
 */
function expectLamp(header: Element, phase: typeof phases[number] | null) {
  const tone = phase === 'needs-interaction' ? 'awaiting' : phase === 'completed' ? 'done' : phase;
  const kinds = Array.from(header.querySelectorAll('[data-sidebar-right-status]')).map((node) =>
    node.getAttribute('data-sidebar-right-status'),
  );
  expect(kinds).toEqual(tone ? [tone] : []);
  if (tone && tone !== 'running') {
    expect(header.querySelector(`[data-sidebar-right-status="${tone}"]`)!.className).toContain('font-semibold');
  }
}

describe('Chats tab', () => {
  it('lists dialogues only under the chats tab, without a group header', () => {
    localStorage.setItem('sidebar.collapse.projectSessionLimit', '10');
    const view = render(<ProjectsSection {...groupProps()} />);
    expect(screen.queryByTestId('row-first')).toBeNull();
    view.rerender(<ProjectsSection {...groupProps()} mainTab="chats" />);
    expect(screen.queryByText('ccAgent.sidebar.dialogues')).toBeNull();
    expect(screen.getAllByTestId(/^row-/).map((row) => row.textContent)).toEqual(['first', 'idle', 'lit']);
  });

  it.each(phases)('reveals the remote %s row beyond the group limit without Show all', (phase) => {
    activity(phase);
    render(<ProjectsSection {...groupProps()} mainTab="chats" />);
    expect(screen.getByTestId('row-first')).toBeTruthy();
    expect(screen.queryByTestId('row-idle')).toBeNull();
    expect(screen.queryByTestId('row-lit')).not.toBeNull();
    expect(screen.getByText('ccAgent.sidebar.showAllSessions')).toBeTruthy();
  });

  it('reveals and re-folds a row as its remote activity starts and clears', () => {
    const p = groupProps();
    render(<ProjectsSection {...p} mainTab="chats" />);
    expect(screen.queryByTestId('row-lit')).toBeNull();
    act(() => activity('running'));
    fireEvent.click(screen.getByTestId('row-lit'));
    expect(p.onSessionClick).toHaveBeenCalledWith('lit');
    act(() => clearRemoteSessionActivity());
    expect(screen.queryByTestId('row-lit')).toBeNull();
  });

  // 旧「按设备分组」设置留在本地时,对话仍是一份完整列表,不按电脑切段。
  it('keeps every device in one dialogue list with the legacy device grouping setting on', () => {
    const p = props(true);
    const sessions = remoteSessions();
    p.dialogues = [
      { ...sessions[0], id: 'a-first', deviceLinkDeviceId: 'a' },
      { ...sessions[1], id: 'a-idle', deviceLinkDeviceId: 'a' },
      { ...sessions[0], id: 'b-first', deviceLinkDeviceId: 'b' },
      { ...sessions[1], id: 'b-idle', deviceLinkDeviceId: 'b' },
      { ...sessions[2], id: 'lit', deviceLinkDeviceId: 'b' },
    ];
    p.remoteDeviceIndex = new Map([['a', { name: 'Device A', online: true }], ['b', { name: 'Device B', online: true }]]);
    render(<ProjectsSection {...p} mainTab="chats" />);
    expect(screen.queryByText('Device A')).toBeNull();
    expect(screen.queryByText('Device B')).toBeNull();
    fireEvent.click(screen.getByText('ccAgent.sidebar.showAllSessions'));
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(5);
  });
});

describe('Collapsed group header lamps', () => {
  it.each(phases)('renders the collapsed Make header lamp for remote %s', (phase) => {
    activity(phase);
    render(<ProjectsSection {...makeGroupProps()} />);
    const header = makeHeader();
    expectLamp(header, null);
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expectLamp(header, phase);
  });

  it('updates the collapsed header on remote activity and shows it only while collapsed', () => {
    render(<ProjectsSection {...makeGroupProps()} />);
    const header = makeHeader();
    act(() => activity('running'));
    expect(screen.queryByTestId('row-lit')).not.toBeNull();
    expectLamp(header, null);
    fireEvent.click(header);
    expectLamp(header, 'running');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expectLamp(header, null);
    expect(screen.queryByTestId('row-lit')).not.toBeNull();
    fireEvent.click(header);
    act(() => clearRemoteSessionActivity());
    expectLamp(header, null);
  });

  it('keeps awaiting on a collapsed project and hands it to the row once expanded', () => {
    const p = props();
    const session = remoteSessions()[2];
    const projectKey = 'device-link:remote:/demo';
    p.projects = [{
      projectKey, displayName: 'Demo project', workingDir: '/demo', scope: 'local',
      sessions: [session], remoteHostId: null, deviceLinkDeviceId: 'remote',
      deviceLinkDeviceName: 'Remote device', deviceLinkConnectionStatus: 'connected',
      segments: 1, latestActivityAt: session.updatedAt,
    }];
    p.allProjectKeysForOrder = [projectKey];
    p.collapsed = new Set([projectKey]);
    activity('needs-interaction');
    const view = render(<ProjectsSection {...p} />);
    const projectHeader = () => screen.getByText('Demo project').closest('[data-project-header]')!;
    expect(screen.queryByText('Remote device')).toBeNull();
    expectLamp(projectHeader(), 'needs-interaction');
    expect(screen.queryByTestId('row-lit')).toBeNull();
    view.rerender(<ProjectsSection {...p} collapsed={new Set()} />);
    expectLamp(projectHeader(), null);
    expect(screen.getByTestId('row-lit')).toBeTruthy();
  });
});

// Use the real starting store/hook as the parent display-running source. No fake
// absorption or direct prop replacement: ProjectsSection must settle it itself.
// Observed through the collapsed Make header, the remaining collapsible shared group.
function StartingSidebar(p: ProjectsSectionProps) {
  const starting = useStartingSessionIds(p.runningSessionIds);
  return <ProjectsSection {...p} runningSessionIds={new Set([...p.runningSessionIds, ...starting])} />;
}

describe('Shared group starting lifecycle', () => {
  for (const first of ['running', 'needs-interaction'] as const) {
    it.each(['completed', 'error'] as const)(`${first} settles starting before %s without waiting for TTL`, (terminal) => {
      vi.useFakeTimers();
      const p = makeGroupProps();
      remoteProjectsStore.pinSessionOrigin('remote', 'lit');
      markSessionStarting('lit');
      render(<StartingSidebar {...p} />);
      expectLamp(makeHeader(), null);
      fireEvent.click(makeHeader());
      expectLamp(makeHeader(), 'running');
      act(() => activity(first));
      expect.soft(getStartingSessionIds().has('lit')).toBe(false);
      act(() => activity(terminal));
      expectLamp(makeHeader(), terminal);
      fireEvent.click(makeHeader());
      expectLamp(makeHeader(), null);
      expect(screen.getByTestId('row-lit')).toBeTruthy();
      // No timer advancement: the terminal UI must be correct immediately.
    });
  }

  it('settles when only the dialogues prop arrives after the remote activity', () => {
    vi.useFakeTimers();
    const p = makeGroupProps();
    markSessionStarting('lit');
    activity('running');
    const view = render(<StartingSidebar {...p} dialogues={[]} />);
    expect(getStartingSessionIds().has('lit')).toBe(true);
    view.rerender(<StartingSidebar {...p} />);
    expect(getStartingSessionIds().has('lit')).toBe(false);
    fireEvent.click(makeHeader());
    act(() => activity('completed'));
    expectLamp(makeHeader(), 'completed');
  });

  // Bug 2026-11-18: a remote turn that ended without a running push (fast or read on
  // completion) stayed "starting" for the 2-minute TTL, so the inbox kept it in working.
  it('settles when the remote turn-end time advances, without a running push or TTL', () => {
    vi.useFakeTimers();
    const p = groupProps();
    const withEnded = (endedAt: number) =>
      p.dialogues.map((s) => (s.id === 'lit' ? { ...s, lastTurnEndedAt: endedAt } : s));
    markSessionStarting('lit');
    const view = render(<StartingSidebar {...p} dialogues={withEnded(100)} />);
    expect(getStartingSessionIds().has('lit')).toBe(true);
    view.rerender(<StartingSidebar {...p} dialogues={withEnded(100)} />);
    expect(getStartingSessionIds().has('lit')).toBe(true);
    view.rerender(<StartingSidebar {...p} dialogues={withEnded(200)} />);
    expect(getStartingSessionIds().has('lit')).toBe(false);
  });

  it('keeps the existing no-in-flight terminal fallback and local running settlement', () => {
    vi.useFakeTimers();
    const p = groupProps();
    markSessionStarting('lit');
    activity('completed');
    const view = render(<StartingSidebar {...p} />);
    expect(getStartingSessionIds().has('lit')).toBe(true);
    view.rerender(<StartingSidebar {...p} runningSessionIds={new Set(['lit'])} />);
    expect(getStartingSessionIds().has('lit')).toBe(false);
  });
});

// Unit: the two modes are exclusive; archived inbox tasks stay reachable under active tree filters.
it('switches between project navigation and inbox while retaining access to processed tasks', () => {
  const p = props(false);
  const task = { ...remoteSessions()[0], _count: { messages: 1 }, workingDir: '/inbox-layout', workspaceKind: 'project' as const };
  p.projects = groupSessions([task]).projects;
  p.allKnownProjects = p.projects;
  p.collapsed = new Set(p.projects.map(project => project.projectKey));
  p.inboxSessions = [task, { ...task, id: 'processed', title: 'Processed task', status: 'archived' }];
  render(<ProjectsSection {...p} />);
  const project = screen.getByText(p.projects[0].displayName).closest('[data-project-header]')!;
  expect(project).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^ccAgent.sidebar.inbox.inbox/ })).toBeNull();
  act(() => {
    localStorage.setItem('sidebar.taskListMode', 'inbox');
    window.dispatchEvent(new StorageEvent('storage', { key: 'sidebar.taskListMode' }));
  });
  expect(screen.getByRole('button', { name: /^ccAgent.sidebar.inbox.inbox/ })).toBeTruthy();
  expect(document.querySelector('[data-project-header]')).toBeNull();
  expect(screen.getByTestId(`row-${task.id}`)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^ccAgent.sidebar.inbox.archived/ }));
  expect(screen.getByTestId('row-processed')).toBeTruthy();
});
