// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Session } from '@/lib/ccAgent.types';
import {
  applyRemoteSessionActivity,
  clearRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';
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
vi.mock('../SessionItem', () => ({ SessionItem: () => null }));
vi.mock('../SessionCard', () => ({ SessionCard: () => null }));
vi.mock('../CardMasonry', () => ({ CardMasonry: () => null }));
vi.mock('@/components/sidebar/SortableList', () => ({ SortableList: () => null }));
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
const pin = (container: HTMLElement) => container.querySelector('svg.lucide-pin')?.parentElement;
const isRunning = (container: HTMLElement) =>
  pin(container)?.classList.contains('session-status-breathing');
afterEach(() => {
  cleanup();
  clearRemoteSessionActivity();
  view.mode = 'text';
});

describe('pinned section running indicator', () => {
  it.each(['text', 'list', 'card'])('updates while expanded or collapsed in %s mode', (mode) => {
    view.mode = mode;
    const entries = [entry(session('pinned'))];
    const { container, rerender } = render(<PinnedSection {...props(entries)} />);
    expect(isRunning(container)).toBe(false);
    rerender(<PinnedSection {...props(entries, ['other'])} />);
    expect(isRunning(container)).toBe(false);
    rerender(<PinnedSection {...props(entries, ['pinned'])} />);
    expect(isRunning(container)).toBe(true);
    expect(container.querySelector('svg.session-status-breathing')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.pinned' }));
    expect(isRunning(container)).toBe(true);
    rerender(<PinnedSection {...props(entries)} />);
    expect(isRunning(container)).toBe(false);
    expect(pin(container)?.getAttribute('aria-hidden')).toBe('true');
  });

  it('includes project children beyond the visible collapse limit', () => {
    const children = Array.from({ length: 25 }, (_, i) => session(`child-${i}`));
    const projectEntry = {
      kind: 'project',
      id: 'project',
      project: { sessions: children },
      displaySessions: children,
    } as PinnedSidebarEntry;
    const { container, rerender } = render(
      <PinnedSection {...props([projectEntry], ['child-24'])} />,
    );
    expect(isRunning(container)).toBe(true);
    rerender(<PinnedSection {...props([], ['child-24'])} />);
    expect(container.innerHTML).toBe('');
  });

  it('tracks remote updates after collapse without confusing same-ID devices or local tasks', () => {
    const entries = [entry(session('same', 'device-a'))];
    const { container } = render(<PinnedSection {...props(entries, ['same'])} />);
    expect(isRunning(container)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.pinned' }));
    act(() => applyRemoteSessionActivity('device-b', { sessionId: 'same', phase: 'running' }));
    expect(isRunning(container)).toBe(false);
    act(() => applyRemoteSessionActivity('device-a', { sessionId: 'same', phase: 'running' }));
    expect(isRunning(container)).toBe(true);
    act(() =>
      applyRemoteSessionActivity('device-a', { sessionId: 'same', phase: 'needs-interaction' }),
    );
    expect(isRunning(container)).toBe(false);
    act(() => applyRemoteSessionActivity('device-a', { sessionId: 'same', phase: 'running' }));
    expect(isRunning(container)).toBe(true);
    act(() => clearRemoteSessionActivity());
    expect(isRunning(container)).toBe(false);
  });
});
