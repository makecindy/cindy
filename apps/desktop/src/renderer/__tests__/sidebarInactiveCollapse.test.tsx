// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, type ReactNode } from 'react';
import type { Session } from '@/lib/ccAgent.types';
import {
  SidebarActivityClock,
  useSidebarActivityNow,
  useSidebarIdleCollapse,
} from '../features/cc-agent/sidebar/SidebarActivityClock';
import { SIDEBAR_IDLE_COLLAPSE_KEY } from '../features/cc-agent/lib/sidebarCollapseConfig';
import { ProjectNode, type ProjectNodeProps } from '../features/cc-agent/sidebar/sections/ProjectNode';
import { SessionEntryList, type SessionEntryListProps } from '../features/cc-agent/sidebar/SessionEntryList';

const translate = (key: string, options?: { count?: number }) =>
  options?.count === undefined ? key : `${key}: ${options.count}`;
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
  localStorage.setItem(SIDEBAR_IDLE_COLLAPSE_KEY, 'true');
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
  localStorage.removeItem(SIDEBAR_IDLE_COLLAPSE_KEY);
  localStorage.removeItem('sidebar.collapse.projectSessionLimit');
  hostListeners.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Preview({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  return <SidebarActivityClock enabled interactionRoot={root}>
    <div ref={root} data-testid="sidebar-clock-area">{children}</div>
  </SidebarActivityClock>;
}

describe('sidebar idle folding interactions', () => {
  it('keeps only current, pinned, running and attention tasks in an idle list', () => {
    const sessions = ['old', 'current', 'pinned', 'running', 'attention'].map((id) =>
      task(id, 31, id === 'pinned' ? { pinnedAt: new Date(now).toISOString() } : {}));
    render(<SessionEntryList {...listProps(sessions)} activeSessionId="current"
      runningSessionIds={new Set(['running'])} notifications={new Set(['attention'])} />, { wrapper: Preview });
    expect(screen.queryByText('old')).toBeNull();
    for (const id of ['current', 'pinned', 'running', 'attention']) expect(screen.getByText(id)).toBeTruthy();
  });

  it('folds across the time boundary without input, but preserves a manual expand-all', () => {
    render(<SidebarActivityClock enabled><SessionEntryList {...listProps([task('expires', 29.5), task('old')])} /></SidebarActivityClock>);
    expect(screen.getByText('expires')).toBeTruthy();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText('expires')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.showMoreSessions: 2' }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('expires')).toBeTruthy();
    expect(screen.getByText('old')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: fold }));
    expect(screen.queryByText('old')).toBeNull();
  });

  it('lets project headers expand and refold independently without collapsing the project', () => {
    const a = projectProps('A');
    const b = projectProps('B');
    render(<><section aria-label="A"><ProjectNode {...a} /></section><section aria-label="B"><ProjectNode {...b} /></section></>, { wrapper: Preview });
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

  // A filtered project with an idle match has no folding action. The existing
  // unfiltered project cases cannot catch a button that does nothing in this mode.
  it('hides the project folding action while showing all filtered matches', () => {
    const props = projectProps('A');
    const { rerender } = render(<ProjectNode {...props} />, { wrapper: Preview });
    fireEvent.click(screen.getByRole('button', { name: expand }));

    rerender(<ProjectNode {...props} disableSessionCollapse />);
    expect(screen.getByText('A-old')).toBeTruthy();
    expect(screen.queryByRole('button', { name: fold })).toBeNull();
    expect(screen.queryByRole('button', { name: expand })).toBeNull();

    rerender(<ProjectNode {...props} />);
    expect(screen.getByRole('button', { name: fold })).toBeTruthy();
  });

  // #11282: toggle the production preference while a project still has a
  // legacy hidden row. The title action disappears and the old footer works.
  it('hides the title action immediately when idle folding is switched off', () => {
    localStorage.setItem('sidebar.collapse.projectSessionLimit', '0');
    function PreferenceControl() {
      const { setIdleCollapseEnabled } = useSidebarIdleCollapse();
      return <button onClick={() => setIdleCollapseEnabled(false)}>Turn idle folding off</button>;
    }
    const props = projectProps('A');
    props.project.sessions = [task('A-older', 24 * 60 + 1)];
    render(<><PreferenceControl /><ProjectNode {...props} /></>, { wrapper: Preview });
    expect(screen.getByRole('button', { name: expand })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Turn idle folding off' }));
    expect(screen.queryByRole('button', { name: expand })).toBeNull();
    expect(screen.queryByRole('button', { name: fold })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.showMoreSessions: 1' }));
    expect(screen.getByText('A-older')).toBeTruthy();
  });

  // #11282: recent rows and an exempt idle task make the action a no-op.
  // Exercise the real header in both modes using the same list as its body.
  it('only offers the idle action when collapsing can actually hide a row', () => {
    const props = projectProps('A');
    const retained = Array.from({ length: 5 }, (_, index) => task(`retained-${index}`, 5));
    const sixth = task('sixth');
    props.project.sessions = [...retained, sixth];
    const view = render(<ProjectNode {...props} />, { wrapper: Preview });
    expect(screen.queryByText('sixth')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: expand }));
    expect(screen.getByText('sixth')).toBeTruthy();
    expect(screen.getByRole('button', { name: fold })).toBeTruthy();

    view.rerender(<ProjectNode {...props} notifications={new Set(['sixth'])} />);
    expect(screen.getByText('sixth')).toBeTruthy();
    expect(screen.queryByRole('button', { name: fold })).toBeNull();
    expect(screen.queryByRole('button', { name: expand })).toBeNull();
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

  // #11282: one row crossing the cutoff exercises the production timer and
  // pointer listeners; the unguarded clock test cannot catch row movement.
  it('defers automatic folding until the pointer leaves the sidebar', () => {
    render(<SessionEntryList {...listProps([task('hovered', 29.5)])} />, { wrapper: Preview });
    const sidebar = screen.getByTestId('sidebar-clock-area');
    fireEvent.pointerEnter(sidebar);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('hovered')).toBeTruthy();
    fireEvent.pointerLeave(sidebar);
    expect(screen.queryByText('hovered')).toBeNull();
  });

  it('keeps the default 24h behavior without scheduling a periodic refresh', () => {
    localStorage.removeItem(SIDEBAR_IDLE_COLLAPSE_KEY);
    const interval = vi.spyOn(globalThis, 'setInterval');
    render(<SessionEntryList {...listProps([task('hour-old', 60)])} collapseLimit={0} />, { wrapper: Preview });
    expect(screen.getByText('hour-old')).toBeTruthy();
    expect(interval).not.toHaveBeenCalled();
  });
});
