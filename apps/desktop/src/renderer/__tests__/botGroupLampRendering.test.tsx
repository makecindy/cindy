// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStartingSessionIds, markSessionStarting, resetSessionStartingStoreForTests, useStartingSessionIds } from '@/lib/sessionStartingStore';
import type { Session } from '@/lib/ccAgent.types';
import {
  applyRemoteSessionActivity,
  clearRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';
import { ProjectsSection, type ProjectsSectionProps } from '../features/cc-agent/sidebar/sections/ProjectsSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/features/device-link/useMachineSwitcher', () => ({ useEffectiveSelectedMachineId: () => 'all' }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));
vi.mock('@/hooks/useSidebarCardMode', () => ({ useSidebarMainViewMode: () => ({ mode: 'text' }) }));
vi.mock('../features/cc-agent/hooks/useRemoteHostProjectOrders', () => ({
  projectOrderWriteScopeForSelection: () => ({ kind: 'viewer' }),
  useLocalHostProjectOrder: () => ({ snapshot: { manualProjectOrder: [] } }),
  useRemoteHostProjectOrders: () => ({ orders: new Map() }),
}));
vi.mock('../features/cc-agent/sidebar/MainListScopeHeader', () => ({ MainListScopeHeader: ({ fold }: { fold: { label: string; onClick: () => void } | null }) => fold ? <button onClick={fold.onClick}>{fold.label}</button> : null }));
vi.mock('@/components/sidebar/SortableList', () => ({ SortableList: () => null }));
vi.mock('../features/cc-agent/sidebar/sections/ProjectNode', () => ({ ProjectNode: () => null }));
// main 633e27c76 起设备段头包了远程桌面快捷入口(挂 device-link presence 订阅,需要
// preload 桥);本文件只验证段头灯语与折叠豁免,段头壳层直接透传子节点。
vi.mock('../features/cc-agent/sidebar/DeviceSectionHeader', () => ({
  DeviceSectionHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../features/cc-agent/sidebar/sections/UnclassifiedSection', () => ({ UnclassifiedSection: () => null }));
vi.mock('@/features/bots/BotAvatar', () => ({ BotAvatar: () => <span>Bot avatar</span> }));
// Keep ProjectsSection, its private SessionGroupNode, SessionEntryList, collapse model,
// lamp aggregation and remote store real. Only unrelated services/leaf rows are stubbed.
vi.mock('../features/cc-agent/sidebar/SessionItem', () => ({
  SessionItem: ({ session, onClick }: { session: Session; onClick: (id: string) => void }) => <button data-testid={`row-${session.id}`} onClick={() => onClick(session.id)}>{session.title}</button>,
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
    onOpenInExplorer: vi.fn(), onLinkCodexProject: vi.fn(), linkingCodexProject: null, onBrowseFiles: vi.fn(),
    onArchiveAll: vi.fn(), onCreateDialogue: vi.fn(),
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
afterEach(() => { cleanup(); resetSessionStartingStoreForTests(); vi.useRealTimers(); clearRemoteSessionActivity(); localStorage.clear(); });

const phases = ['running', 'needs-interaction', 'error', 'completed'] as const;
function activity(phase: typeof phases[number]) {
  applyRemoteSessionActivity('remote', { sessionId: 'lit', phase, attention: true, compactDetail: '' });
}

describe.each([false, true])('Bot groups with device grouping %s', (groupDevice) => {
  it.each(phases)('renders the Bot header lamp for remote %s', (phase) => {
    activity(phase);
    render(<ProjectsSection {...props(groupDevice)} />);
    expect(Boolean(screen.queryByText('Remote device'))).toBe(groupDevice);
    const header = screen.getByText('Demo Bot').closest('[role="button"]')!;
    if (phase === 'running') {
      expect(header.querySelector('.session-status-breathing')).not.toBeNull();
      // 伙伴头像不吃 wrapper 的 currentColor,运行色必须以静态描边落在 wrapper 上,
      // 减弱动效(动画被全局关掉)时仍可见(Codex review)。
      const marker = header.querySelector('[data-running-marker]')!;
      expect(marker.getAttribute('data-running-marker')).toBe('ring');
      expect(marker.className).toContain('ring-[var(--status-bar-accent)]');
    } else {
      expect(header.querySelector('[data-running-marker]')).toBeNull();
      const tone = phase === 'needs-interaction' ? 'awaiting' : phase === 'error' ? 'error' : 'done';
      expect(header.querySelector(`[class*="--card-status-${tone}"]`)).not.toBeNull();
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

  it('updates the rendered group on remote activity and retains its lamp across collapse/expand', () => {
    render(<ProjectsSection {...props(groupDevice)} />);
    expect(screen.queryByTestId('row-lit')).toBeNull();
    const header = screen.getByText('Demo Bot').closest('[role="button"]')!;
    expect(header.querySelector('.session-status-breathing')).toBeNull();
    act(() => activity('running'));
    expect(screen.queryByTestId('row-lit')).not.toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.querySelector('.session-status-breathing')).not.toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
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
    expect(Boolean(header.querySelector(`[class*="--card-status-${tone}"]`))).toBe(tone === expected);
  }
}

describe.each([false, true])('Bot starting lifecycle, device grouping %s', (groupDevice) => {
  for (const first of ['running', 'needs-interaction'] as const) {
    it.each(['completed', 'error'] as const)(`${first} settles starting before %s without waiting for TTL`, (terminal) => {
      vi.useFakeTimers();
      const p = props(groupDevice);
      markSessionStarting('lit');
      render(<StartingSidebar {...p} />);
      expectLamp(botHeader(), 'running');
      act(() => activity(first));
      expect.soft(getStartingSessionIds().has('lit')).toBe(false);
      act(() => activity(terminal));
      expectLamp(botHeader(), terminal);
      if (groupDevice) expectLamp(deviceHeader('Remote device'), terminal);
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
  it.each(phases)('keeps %s lamps and exempt rows on the owning device', (phase) => {
    const p = multiDeviceProps();
    render(<ProjectsSection {...p} />);
    act(() => applyRemoteSessionActivity('b', { sessionId: 'lit', phase, attention: true, compactDetail: '' }));
    expectLamp(deviceHeader('Device A'), null);
    const a = deviceHeader('Device A').parentElement!;
    const b = deviceHeader('Device B').parentElement!;
    expectLamp(deviceHeader('Device B'), phase);
    expectLamp(botHeader(a), null);
    expectLamp(botHeader(b), phase);
    expect(within(a).queryByTestId('row-lit')).toBeNull();
    expect(within(b).getByTestId('row-lit')).toBeTruthy();
    expect(screen.getAllByText('Demo Bot')).toHaveLength(2);
    expect(within(a).getAllByTestId(/^row-/)).toHaveLength(1);
    expect(within(b).getAllByTestId(/^row-/)).toHaveLength(2);
    fireEvent.click(within(b).getByTestId('row-lit'));
    expect(p.onSessionClick).toHaveBeenCalledWith('lit');
    fireEvent.click(within(b).getByRole('button', { name: 'bots.sidebar.newTaskWith' }));
    expect(p.onOpenBot).toHaveBeenCalledWith('demo');
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
