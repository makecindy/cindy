// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Session } from '@/lib/ccAgent.types';
import {
  applyRemoteSessionActivity,
  clearRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  getStartingSessionIds,
  markSessionStarting,
  resetSessionStartingStoreForTests,
  useStartingSessionIds,
} from '@/lib/sessionStartingStore';
import {
  PinnedSection,
  type PinnedSectionProps,
  type PinnedSidebarEntry,
} from '../sections/PinnedSection';

const view = vi.hoisted(() => ({ mode: 'text' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }));
vi.mock('@/hooks/useSidebarCardMode', () => ({
  useSidebarCardMode: () => ({ mode: view.mode, setMode: vi.fn() }),
}));
vi.mock('../SessionItem', () => ({ SessionItem: ({ session }: { session: Session }) => <span>{session.id}</span> }));
vi.mock('../SessionCard', () => ({ SessionCard: () => null }));
vi.mock('../CardMasonry', () => ({ CardMasonry: () => null }));
vi.mock('@/components/sidebar/SortableList', () => ({ SortableList: ({ items, renderItem }: { items: PinnedSidebarEntry[]; renderItem: (item: PinnedSidebarEntry, index: number) => ReactNode }) => <>{items.map((item, index) => <div key={item.id}>{renderItem(item, index)}</div>)}</> }));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
}));

const session = (id: string, deviceLinkDeviceId: string | null = null) =>
  ({ id, deviceLinkDeviceId }) as Session;
const entry = (s: Session): PinnedSidebarEntry => ({ kind: 'session', id: s.id, session: s });
const props = (entries: PinnedSidebarEntry[], running: string[] = []): PinnedSectionProps => ({
  entries,
  allKnownProjects: [],
  renderProject: () => null,
  runningSessionIds: new Set(running),
  attachedSessionIds: new Set(),
  notifications: new Set(),
  onSessionClick: vi.fn(),
  onAction: vi.fn(),
  onRename: vi.fn(),
  onTogglePin: vi.fn(),
  onReorder: vi.fn(),
});
afterEach(() => {
  cleanup();
  clearRemoteSessionActivity();
  resetSessionStartingStoreForTests();
  remoteProjectsStore.__resetPinnedOriginsForTest();
  view.mode = 'text';
  // The section's collapse is remembered; each case starts expanded.
  localStorage.clear();
});

describe('pinned section remote starting settlement', () => {
  it.each(['session', 'project'] as const)(
    'settles remote optimistic starting for a collapsed pinned %s',
    (kind) => {
      const task = session('optimistic', 'device-a');
      remoteProjectsStore.pinSessionOrigin('device-a', task.id);
      const entries: PinnedSidebarEntry[] =
        kind === 'session'
          ? [entry(task)]
          : [
              {
                kind: 'project',
                id: 'remote-project',
                project: { sessions: [task] },
                displaySessions: [task],
              } as PinnedSidebarEntry,
            ];
      function StartingPinned() {
        const starting = useStartingSessionIds();
        return <PinnedSection {...props([...entries])} runningSessionIds={starting} />;
      }
      markSessionStarting(task.id);
      render(<StartingPinned />);
      fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.pinned' }));
      act(() => applyRemoteSessionActivity('device-b', { sessionId: task.id, phase: 'running' }));
      expect(getStartingSessionIds().has(task.id)).toBe(true);
      act(() => applyRemoteSessionActivity('device-a', { sessionId: task.id, phase: 'running' }));
      expect(getStartingSessionIds().has(task.id)).toBe(false);
      act(() =>
        applyRemoteSessionActivity('device-a', { sessionId: task.id, phase: 'needs-interaction' }),
      );
      // Answering an existing interaction must keep the new send's prelight.
      act(() => markSessionStarting(task.id));
      expect(getStartingSessionIds().has(task.id)).toBe(true);
      act(() =>
        applyRemoteSessionActivity('device-b', { sessionId: 'unrelated', phase: 'running' }),
      );
      expect(getStartingSessionIds().has(task.id)).toBe(true);
      act(() => applyRemoteSessionActivity('device-a', { sessionId: task.id, phase: 'running' }));
      expect(getStartingSessionIds().has(task.id)).toBe(false);
      act(() =>
        applyRemoteSessionActivity('device-a', {
          sessionId: task.id,
          phase: 'completed',
          attention: true,
        }),
      );
      // A new send discards the old terminal mirror and keeps its optimistic lamp.
      act(() => markSessionStarting(task.id));
      expect(getStartingSessionIds().has(task.id)).toBe(true);
      act(() =>
        applyRemoteSessionActivity('device-a', { sessionId: task.id, phase: 'needs-interaction' }),
      );
      expect(getStartingSessionIds().has(task.id)).toBe(false);
    },
  );
});

// Collapse previously hid notifications together with ordinary pins. Unit: two pins,
// unread removal and remote waiting arrival must change visible rows without reopening.
it('keeps unread pins visible and reacts to remote feedback while collapsed', () => {
  const local = session('local');
  const remote = session('remote', 'device-a');
  const base = props([entry(local), entry(remote)]);
  const page = render(<PinnedSection {...base} notifications={new Set(['local'])} />);
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.pinned' }));
  expect(screen.getByText('local')).toBeTruthy();
  expect(screen.queryByText('remote')).toBeNull();
  act(() => applyRemoteSessionActivity('device-a', { sessionId: 'remote', phase: 'needs-interaction' }));
  expect(screen.getByText('remote')).toBeTruthy();
  page.rerender(<PinnedSection {...base} />);
  expect(screen.queryByText('local')).toBeNull();
  expect(screen.getByText('remote')).toBeTruthy();
  act(() => clearRemoteSessionActivity());
  expect(screen.queryByText('remote')).toBeNull();
  const header = screen.getByRole('button', { name: 'ccAgent.sidebar.pinned' });
  expect(header.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(header);
  expect(screen.getByText('local')).toBeTruthy();
});

// Unit regression for review #4555472387: a read persisted interruption must
// remain reachable without notification/activity mirrors. Existing cases only
// cover those volatile mirrors. One task, direct or project pin, local or remote.
it.each([
  ['session', null], ['session', 'device-a'],
  ['project', null], ['project', 'device-a'],
] as const)('keeps persisted interruptions in collapsed %s pins (device: %s)', (kind, deviceId) => {
  const interrupted = {
    ...session('interrupted', deviceId), status: 'active',
    activeTurnStartedAt: 1000, interruptedTurnStartedAt: 1000, lastTurnEndedAt: 900,
  } as Session;
  const entries = (task: Session): PinnedSidebarEntry[] => kind === 'session'
    ? [entry(task)]
    : [{ kind: 'project', id: 'project', project: { sessions: [task] }, displaySessions: [task] } as PinnedSidebarEntry];
  const page = render(<PinnedSection {...props(entries(interrupted))} />);
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.pinned' }));
  expect(screen.getByText('interrupted')).toBeTruthy();
  page.rerender(<PinnedSection {...props(entries({ ...interrupted, lastTurnEndedAt: 1000 }))} />);
  expect(screen.queryByText('interrupted')).toBeNull();
});
