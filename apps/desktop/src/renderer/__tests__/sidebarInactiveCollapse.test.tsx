// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '@/lib/ccAgent.types';
import { TaskTagEditor } from '@/features/task-tags/TaskTags';
import {
  SidebarActivityClock,
  useSidebarActivityNow,
  useSidebarIdleCollapse,
} from '../features/cc-agent/sidebar/SidebarActivityClock';
import { SIDEBAR_IDLE_COLLAPSE_KEY } from '../features/cc-agent/lib/sidebarCollapseConfig';
import { SessionEntryList, type SessionEntryListProps } from '../features/cc-agent/sidebar/SessionEntryList';
import { railPanelStore } from '../features/cc-agent/sidebar/railPanelStore';

const translate = (key: string, options?: { count?: number }) =>
  options?.count === undefined ? key : `${key}: ${options.count}`;
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } }),
}));
vi.mock('../features/cc-agent/sidebar/SessionItem', () => ({
  SessionItem: ({ session }: { session: Session }) => <button>{session.title}</button>,
}));
vi.mock('../features/cc-agent/sidebar/SessionCard', () => ({
  SessionCard: ({ session }: { session: Session }) => <button>{session.title}</button>,
}));

// #11233 idle folding through the real SessionEntryList and clock (unit/jsdom, fake timers).
const now = Date.parse('2026-11-18T04:00:00Z');
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
function weeklyScheduleIndex(runs: Session[]) {
  const schedule = {
    scheduleId: 'weekly',
    scheduleName: 'Weekly automation',
    scheduleStatus: 'active' as const,
    unreadRunIds: [],
    unreadFailedRunIds: [],
    hasUnreadRun: false,
  };
  return new Map(runs.map((run) => [run.id, schedule] as const));
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
  railPanelStore.closeAll();
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
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.showAllSessions: 2' }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('expires')).toBeTruthy();
    expect(screen.getByText('old')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: fold }));
    expect(screen.queryByText('old')).toBeNull();
  });

  // #11233: an explicit filter shows every idle match without folding controls.
  it('shows every filtered match without idle folding controls', () => {
    render(<SessionEntryList {...listProps([task('recent', 5), task('idle')])} disableCollapse />, { wrapper: Preview });
    expect(screen.getByText('idle')).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: /showAllSessions|collapseInactiveSessions/ })).toHaveLength(0);
  });

  // #11282: switching the preference off restores the legacy count floor at once.
  it('restores the legacy list immediately when idle folding is switched off', () => {
    function PreferenceControl() {
      const { setIdleCollapseEnabled } = useSidebarIdleCollapse();
      return <button onClick={() => setIdleCollapseEnabled(false)}>Turn idle folding off</button>;
    }
    render(<><PreferenceControl /><SessionEntryList {...listProps([task('recent', 5), task('idle')])} /></>, { wrapper: Preview });
    expect(screen.queryByText('idle')).toBeNull();
    expect(screen.getByRole('button', { name: 'ccAgent.sidebar.showAllSessions: 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn idle folding off' }));
    expect(screen.getByText('idle')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ccAgent.sidebar.showAllSessions: 2' })).toBeNull();
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

  // #11282: a row crossing the cutoff must not move while the pointer is inside.
  it('defers automatic folding until the pointer leaves the sidebar', () => {
    render(<SessionEntryList {...listProps([task('hovered', 29.5)])} />, { wrapper: Preview });
    const sidebar = screen.getByTestId('sidebar-clock-area');
    fireEvent.pointerEnter(sidebar);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('hovered')).toBeTruthy();
    fireEvent.pointerLeave(sidebar);
    expect(screen.queryByText('hovered')).toBeNull();
  });

  // #11252: an open portalled dialog (tags, export) keeps its row and unsaved input.
  it('preserves an unsaved tag while the owning task crosses the idle cutoff', async () => {
    Object.assign(window.electronAPI, {
      localDb: { taskTags: { execute: vi.fn().mockResolvedValue({ tags: [], sessions: [] }) } },
    });
    const session = task('tagged-task', 29.5);
    function TaggableTask() {
      const [open, setOpen] = useState(false);
      if (useSidebarActivityNow() >= now + 30_000) return null;
      return <>
        <button onClick={() => setOpen(true)}>Edit tags</button>
        {open && <TaskTagEditor session={session} onClose={() => setOpen(false)} />}
      </>;
    }

    render(<TaggableTask />, { wrapper: Preview });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Edit tags' })));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'taskTags.add' }));
    const name = within(dialog).getByRole('textbox', { name: 'taskTags.name' });
    fireEvent.change(name, { target: { value: 'Unsaved tag' } });
    act(() => vi.advanceTimersByTime(60_000));
    expect(within(screen.getByRole('dialog')).getByDisplayValue('Unsaved tag')).toBe(name);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByRole('button', { name: 'Edit tags' })).toBeNull();
  });

  // #11252: a rail update after the cutoff used to unmount the hovered row.
  it('keeps the rail snapshot stable until reopening, while running tasks stay visible', () => {
    const sessions = [task('rail-recent', 29.5), task('rail-old'), task('rail-running')];
    const props = listProps(sessions);
    const trigger = document.createElement('button');
    const openRail = () => act(() => railPanelStore.openSection('dialogues', { right: 0, top: 0 }, trigger));
    const view = (notifications: Set<string>) => (
      <SidebarActivityClock enabled={false}>
        {createPortal(
          <SessionEntryList {...props} notifications={notifications} runningSessionIds={new Set(['rail-running'])} />,
          document.body,
        )}
      </SidebarActivityClock>
    );

    openRail();
    const rendered = render(view(new Set()));
    const recent = screen.getByRole('button', { name: 'rail-recent' });
    expect(screen.queryByRole('button', { name: 'rail-old' })).toBeNull();
    act(() => vi.advanceTimersByTime(60_000));
    rendered.rerender(view(new Set(['rail-old'])));
    expect(screen.getByRole('button', { name: 'rail-recent' })).toBe(recent);
    expect(screen.getByRole('button', { name: 'rail-old' })).toBeTruthy();

    act(() => railPanelStore.closeAll());
    openRail();
    expect(screen.queryByRole('button', { name: 'rail-recent' })).toBeNull();
    expect(screen.getByRole('button', { name: 'rail-running' })).toBeTruthy();
  });

  // #11252: an open automation folder menu survives its latest run going idle.
  it('keeps an automation folder menu open after its latest run becomes idle', () => {
    const runs = [
      task('weekly-run', 29.5, { source: 'scheduler' }),
      task('previous-run', 90, { source: 'scheduler' }),
    ];
    const onScheduleAction = vi.fn();
    render(
      <MemoryRouter>
        <SessionEntryList
          {...listProps(runs)}
          onScheduleAction={onScheduleAction}
          scheduleSessionIndex={weeklyScheduleIndex(runs)}
        />
      </MemoryRouter>,
      { wrapper: Preview },
    );

    const more = screen.getByRole('button', { name: 'ccAgent.sidebar.automationGroup.menu.more' });
    act(() => more.focus());
    vi.setSystemTime(now + 60_000);
    fireEvent.keyDown(more, { key: 'Enter' });
    const menu = screen.getByRole('menu');
    expect(menu.contains(document.activeElement)).toBe(true);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole('menu')).toBe(menu);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'ccAgent.sidebar.automationGroup.menu.edit' }));
    expect(onScheduleAction).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: 'weekly' }), 'edit');
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
      more.blur();
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByText('Weekly automation')).toBeNull();
  });

  // #11252: nested 24h run history uses the same interaction-protected clock.
  it('uses the same protected clock for automation run history', () => {
    const runs = [
      ...Array.from({ length: 5 }, (_, index) => task(`recent-run-${index}`, index + 1, { source: 'scheduler' })),
      task('historical-run', 24 * 60 - 0.5, { source: 'scheduler' }),
    ];
    const props = { ...listProps(runs), scheduleSessionIndex: weeklyScheduleIndex(runs) };
    const view = (notifications: Set<string>) => (
      <MemoryRouter><SessionEntryList {...props} notifications={notifications} /></MemoryRouter>
    );
    const rendered = render(view(new Set()), { wrapper: Preview });
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.automationGroup.expand' }));
    const historyRun = screen.getByRole('button', { name: 'historical-run' });
    const sidebar = screen.getByTestId('sidebar-clock-area');
    fireEvent.pointerEnter(sidebar);
    act(() => vi.advanceTimersByTime(60_000));
    rendered.rerender(view(new Set(['recent-run-0'])));
    expect(screen.getByRole('button', { name: 'historical-run' })).toBe(historyRun);

    fireEvent.pointerLeave(sidebar);
    expect(screen.queryByRole('button', { name: 'historical-run' })).toBeNull();
  });

  it('keeps the default 24h behavior without scheduling a periodic refresh', () => {
    localStorage.removeItem(SIDEBAR_IDLE_COLLAPSE_KEY);
    const interval = vi.spyOn(globalThis, 'setInterval');
    render(<SessionEntryList {...listProps([task('hour-old', 60)])} collapseLimit={0} />, { wrapper: Preview });
    expect(screen.getByText('hour-old')).toBeTruthy();
    expect(interval).not.toHaveBeenCalled();
  });
});
