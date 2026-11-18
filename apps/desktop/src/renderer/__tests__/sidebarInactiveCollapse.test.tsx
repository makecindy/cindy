// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import { SidebarActivityClock, useSidebarActivityNow } from '../features/cc-agent/sidebar/SidebarActivityClock';
import { ProjectNode, type ProjectNodeProps } from '../features/cc-agent/sidebar/sections/ProjectNode';
import { SessionEntryList, type SessionEntryListProps } from '../features/cc-agent/sidebar/SessionEntryList';

const translate = (key: string) => key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }));
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: React.ReactNode }) => children }));
// Row presentation and unopened project settings are unrelated to folding. The
// real ProjectNode, SessionEntryList, grouping, toggle and clock remain loaded.
vi.mock('../features/cc-agent/sidebar/SessionItem', () => ({
  SessionItem: ({ session }: { session: Session }) => <button>{session.title}</button>,
}));
vi.mock('../features/cc-agent/sidebar/SessionCard', () => ({
  SessionCard: ({ session }: { session: Session }) => <button>{session.title}</button>,
}));
vi.mock('../features/cc-agent/sidebar/AutomationSessionGroupItem', () => ({ AutomationSessionGroupItem: () => null }));
vi.mock('../features/cc-agent/sidebar/ProjectSettingsDialog', () => ({ ProjectSettingsDialog: () => null }));

// #11233: real list/project entry points must change visible rows with time and
// header clicks. Existing collapse-reset tests do not exercise idle folding or
// project controls. Minimal failure: one 31m-old task in an expanded project.
// Tier: unit/jsdom; fake timers, no task IPC or external I/O.
// Standalone Vitest duration: 2.23s (2026-11-18).
const now = Date.parse('2026-11-18T04:00:00Z');
const expand = 'ccAgent.sidebar.expandAllSessions';
const fold = 'ccAgent.sidebar.collapseInactiveSessions';
const hostListeners = new Set<(hidden: boolean) => void>();
const noop = () => {};
function task(id: string, ageMinutes = 31, extra: Partial<Session> = {}): Session {
  const date = new Date(now - ageMinutes * 60_000).toISOString();
  return { id, title: id, status: 'active', source: 'manual', workspaceKind: 'dialogue',
    createdAt: date, updatedAt: date, lastActivityAt: date, pinnedAt: null, ...extra } as Session;
}
function listProps(sessions: Session[]): SessionEntryListProps {
  return { sessions, collapsible: true, notifications: new Set(), runningSessionIds: new Set(),
    attachedSessionIds: new Set(), scheduleSessionIndex: new Map(), onSessionClick: noop,
    onAction: noop, onRename: noop, onTogglePin: noop, onScheduleAction: noop };
}
function projectProps(id: string): ProjectNodeProps {
  return { ...listProps([task(`${id}-old`)]),
    project: { projectKey: `local:/${id}`, workingDir: `/${id}`, displayName: id, scope: 'local',
      sessions: [task(`${id}-old`)], latestActivityAt: '', segments: 1 } as ProjectNodeProps['project'],
    statusFilter: 'active', isCollapsed: false, parentSectionCollapsed: false,
    disableSessionCollapse: false, isProjectPinned: false, onToggle: vi.fn(),
    onToggleProjectPin: noop, onRenameProject: async () => {}, onRemoveFromSidebar: noop,
    onCreateInProject: noop, onOpenConversationSearch: noop, onOpenInExplorer: noop,
    onImportFromTools: noop, onBrowseFiles: noop, onArchiveAll: noop };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    platform: 'darwin',
    onWindowHiddenChange: (listener: (hidden: boolean) => void) => {
      hostListeners.add(listener);
      return () => hostListeners.delete(listener);
    },
  } });
});
afterEach(() => {
  cleanup();
  hostListeners.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('sidebar idle folding interactions', () => {
  it('keeps only current, pinned, running and attention tasks in an idle list', () => {
    const sessions = ['old', 'current', 'pinned', 'running', 'attention'].map((id) =>
      task(id, 31, id === 'pinned' ? { pinnedAt: new Date(now).toISOString() } : {}));
    render(<SessionEntryList {...listProps(sessions)} activeSessionId="current"
      runningSessionIds={new Set(['running'])} notifications={new Set(['attention'])} />);
    expect(screen.queryByText('old')).toBeNull();
    for (const id of ['current', 'pinned', 'running', 'attention']) expect(screen.getByText(id)).toBeTruthy();
  });

  it('folds across the time boundary without input, but preserves a manual expand-all', () => {
    render(<SidebarActivityClock enabled><SessionEntryList {...listProps([task('expires', 29.5), task('old')])} /></SidebarActivityClock>);
    expect(screen.getByText('expires')).toBeTruthy();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText('expires')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.showAllSessions' }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('expires')).toBeTruthy();
    expect(screen.getByText('old')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: fold }));
    expect(screen.queryByText('old')).toBeNull();
  });

  it('lets project headers expand and refold independently without collapsing the project', () => {
    const a = projectProps('A');
    const b = projectProps('B');
    render(<><section aria-label="A"><ProjectNode {...a} /></section><section aria-label="B"><ProjectNode {...b} /></section></>);
    const left = within(screen.getByRole('region', { name: 'A' }));
    const right = within(screen.getByRole('region', { name: 'B' }));
    expect(left.queryByText('A-old')).toBeNull();
    expect(right.queryByText('B-old')).toBeNull();
    fireEvent.click(left.getByRole('button', { name: expand }));
    expect(left.getByText('A-old')).toBeTruthy();
    expect(right.queryByText('B-old')).toBeNull();
    fireEvent.click(left.getAllByRole('button', { name: fold })[0]);
    expect(left.queryByText('A-old')).toBeNull();
    expect(a.onToggle).not.toHaveBeenCalled();
  });

  it('stops the single clock for hidden windows and refreshes immediately on return', () => {
    function Clock() { return <output>{useSidebarActivityNow()}</output>; }
    const interval = vi.spyOn(globalThis, 'setInterval');
    const rendered = render(<SidebarActivityClock enabled><Clock /><Clock /></SidebarActivityClock>);
    expect(interval).toHaveBeenCalledTimes(1);
    act(() => { for (const listener of hostListeners) listener(true); });
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getAllByText(String(now))).toHaveLength(2);
    act(() => { for (const listener of hostListeners) listener(false); });
    expect(screen.getAllByText(String(now + 60_000))).toHaveLength(2);
    rendered.unmount();
    expect(hostListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
