// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';

import { Tooltip } from '@/components/ui/tooltip';
import type { Session } from '@/lib/ccAgent.types';
import { setProvisionalDraftTaskId } from '../lib/provisionalDraftTaskId';
import { ProjectTaskSwitcher } from '../ProjectTaskSwitcher';

const state = vi.hoisted(() => ({
  useSessions: vi.fn(),
  worktrees: vi.fn(),
  observedWorktree: vi.fn(),
  botProfiles: vi.fn(),
  stickyOrigin: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key.split('.').at(-1) }) }));
vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktrees: state.worktrees,
  useObservedWorktreeForSession: state.observedWorktree,
}));
vi.mock('@/features/bots/botStore', () => ({ useBotProfiles: state.botProfiles }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({ getStickySessionDeviceId: state.stickyOrigin }));
vi.mock('@/hooks/useCCSessions', () => ({ useCCSessions: state.useSessions }));
vi.mock('@/lib/makerTransport', () => ({ getSessionFor: state.getSession, orcaWorkflowsFor: vi.fn() }));

function task(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    workingDir: 'D:\\Code\\Ledger',
    workspaceKind: 'project',
    status: 'active',
    userSendAt: '2026-11-06T10:00:00Z',
    ...patch,
  } as Session;
}

function CurrentRoute() {
  return <output aria-label="route">{useLocation().pathname}</output>;
}

function renderSwitcher(current: Session = task('Current task')) {
  return render(
    <Tooltip.Provider>
      <MemoryRouter initialEntries={['/cc-agent/current']}>
        <ProjectTaskSwitcher session={current} runningSessionIds={new Set(['Running task'])} />
        <CurrentRoute />
      </MemoryRouter>
    </Tooltip.Provider>,
  );
}

function openSwitcher() {
  const trigger = screen.getByRole('button', { name: 'switchProjectTask' });
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return trigger;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('electronAPI', { platform: 'win32' });
  state.useSessions.mockReturnValue({ sessions: [], isLoading: false, error: null });
  state.worktrees.mockReturnValue({});
  state.observedWorktree.mockReturnValue(null);
  state.botProfiles.mockReturnValue([]);
  state.stickyOrigin.mockReset();
});

afterEach(() => {
  cleanup();
  setProvisionalDraftTaskId(null);
  vi.unstubAllGlobals();
});

describe('ProjectTaskSwitcher', () => {
  it('loads only on open and shows this project’s active and archived tasks across worktrees', async () => {
    setProvisionalDraftTaskId('Unsent named task');
    state.useSessions.mockReturnValue({
      sessions: [
        task('Archived worktree', { workingDir: 'D:/CODE/LEDGER/.claude/worktrees/old', status: 'archived' }),
        task('Running task', { workingDir: 'D:/other-checkouts/billing', projectDir: 'd:/code/ledger/' }),
        task('Sibling project', { workingDir: 'D:/Code/Ledger-copy' }),
        task('SSH project', { remoteHostId: 'remote' }),
        task('Mirrored project', { deviceLinkDeviceId: 'device' }),
        task('Local copy of remote task'),
        task('Private legacy task'),
        task('Companion', { source: 'bot' }),
        task('Private side chat', { source: 'side-chat' }),
        task('Review', { source: 'review' }),
        task('Dialogue', { workspaceKind: 'dialogue' }),
        task('Hidden plug-in task', { source: 'plugin', hiddenAt: '2026-11-05T10:00:00Z' }),
        task('Orca worker', { orcaRole: 'worker' }),
        task('Deleted task', { status: 'deleted' }),
        task('Empty task', { title: DEFAULT_DRAFT_SESSION_TITLE, userSendAt: null }),
        task('Unsent named task'),
      ],
      isLoading: false,
      error: null,
    });
    state.botProfiles.mockReturnValue([{ sessions: [{ id: 'Private legacy task', role: 'thread' }] }]);
    state.stickyOrigin.mockImplementation((id: string) => id === 'Local copy of remote task' ? 'device' : undefined);
    state.worktrees.mockReturnValue({
      'Running task': { path: 'D:/other-checkouts/billing', name: 'billing', branch: 'cindy/billing' },
    });
    state.observedWorktree.mockImplementation((id: string) => id === 'Archived worktree'
      ? { workdir: 'D:/CODE/LEDGER/.claude/worktrees/old', branch: 'fix/history' } : null);
    renderSwitcher();
    expect(state.useSessions).not.toHaveBeenCalled();
    expect(state.worktrees).not.toHaveBeenCalled();

    openSwitcher();
    const rows = await screen.findAllByRole('menuitemradio');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toBe('Current task');
    expect(rows[0].getAttribute('aria-checked')).toBe('true');
    expect(rows[1].textContent).toBe('Running taskrunning· billing · cindy/billing');
    expect(rows[2].textContent).toBe('Archived worktreearchived· old · fix/history');
    expect(state.useSessions).toHaveBeenCalledWith({ includeArchived: 'all' });
    expect(state.getSession).not.toHaveBeenCalled();
  });

  it('opens from a teammate routine and lists the same project’s archived channel task', async () => {
    const routine = task('Teammate routine', { source: 'bot', companion: { id: 'bot', role: 'routine' } });
    state.useSessions.mockReturnValue({
      sessions: [
        routine,
        task('Archived channel', { source: 'bot', status: 'archived', companion: { id: 'bot', role: 'channel' } }),
        task('Private teammate thread', { source: 'bot', companion: { id: 'bot', role: 'thread' } }),
        task('Remote routine', { source: 'bot', remoteHostId: 'ssh', companion: { id: 'bot', role: 'routine' } }),
      ],
      isLoading: false,
      error: null,
    });
    renderSwitcher(routine);
    openSwitcher();

    const rows = await screen.findAllByRole('menuitemradio');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe('Teammate routine');
    expect(rows[0].getAttribute('aria-checked')).toBe('true');
    expect(rows[1].textContent).toBe('Archived channelarchived');
  });

  it('restores focus on Escape and opens the selected archived task with the keyboard', async () => {
    state.useSessions.mockReturnValue({
      sessions: [task('old-task', { title: 'Older task', status: 'archived' })], isLoading: false, error: null,
    });
    renderSwitcher(task('current'));
    const trigger = openSwitcher();
    await screen.findByRole('menu');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(trigger);

    openSwitcher();
    const current = await screen.findByRole('menuitemradio', { name: 'current' });
    await waitFor(() => expect(document.activeElement).toBe(current));
    fireEvent.keyDown(current, { key: 'ArrowDown' });
    const archived = screen.getByRole('menuitemradio', { name: /Older task/ });
    await waitFor(() => expect(document.activeElement).toBe(archived));
    fireEvent.keyDown(archived, { key: 'Enter' });
    await waitFor(() => expect(screen.getByLabelText('route').textContent).toBe('/cc-agent/old-task'));
    expect(state.getSession).not.toHaveBeenCalled();
  });

  it('hides the switcher for a dialogue that happens to use a project directory', () => {
    renderSwitcher(task('Dialogue', { workspaceKind: 'dialogue' }));
    expect(screen.queryByRole('button', { name: 'switchProjectTask' })).toBeNull();
    expect(state.useSessions).not.toHaveBeenCalled();
  });

  it('does not navigate when a listed task acquires a remote origin before selection', async () => {
    state.useSessions.mockReturnValue({
      sessions: [task('ambiguous')], isLoading: false, error: null,
    });
    renderSwitcher(task('current'));
    openSwitcher();
    const target = await screen.findByRole('menuitemradio', { name: 'ambiguous' });

    state.stickyOrigin.mockImplementation((id: string) => id === 'ambiguous' ? 'device' : undefined);
    fireEvent.keyDown(target, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(screen.getByLabelText('route').textContent).toBe('/cc-agent/current');
    expect(state.getSession).not.toHaveBeenCalled();
  });
});
