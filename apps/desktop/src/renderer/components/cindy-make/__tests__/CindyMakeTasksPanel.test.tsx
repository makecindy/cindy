// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  confirm: vi.fn(),
  get: vi.fn(),
  restore: vi.fn(),
  prepend: vi.fn(),
  refresh: vi.fn(),
  manage: vi.fn(),
  error: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm }),
}));
vi.mock('@/lib/sessionService', () => ({ get: h.get, restoreIfArchived: h.restore }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { prependCreated: h.prepend } }));
vi.mock('@/lib/cindyMakeState', () => ({ cindyMakeState: { refresh: h.refresh } }));
vi.mock('@/lib/toast', () => ({ toast: { error: h.error } }));
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { MakeDoctorReport } from '../../../../shared/cindyMakeDoctor';
import { CindyMakeTasksPanel } from '../CindyMakeTasksPanel';

function report(
  index: number,
  extra: Partial<NonNullable<MakeDoctorReport['task']>> = {},
): MakeDoctorReport {
  return {
    runId: 'run-' + index,
    platform: 'win32',
    arch: 'x64',
    status: 'completed',
    checks: [],
    task: {
      sessionId: 'session-' + index,
      title: 'Build ' + index,
      request: 'Request ' + index,
      phase: 'completed',
      sessionStatus: 'active',
      ...extra,
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('make-tasks-test');
  h.confirm.mockResolvedValue(true);
  h.manage.mockResolvedValue(undefined);
  h.refresh.mockResolvedValue(undefined);
  h.get.mockResolvedValue({ id: 'session-1', status: 'active', source: 'cindy-make' });
  h.restore.mockResolvedValue({ id: 'session-1', status: 'active', source: 'cindy-make' });
  vi.stubGlobal('electronAPI', { manageCindyMakeTask: h.manage });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Cindy Make settings task list', () => {
  it('shows one detail for many tasks, with search and no completed preparation steps', () => {
    render(<CindyMakeTasksPanel reports={Array.from({ length: 100 }, (_, i) => report(i))} />);
    expect(screen.getByText('Request 0')).toBeTruthy();
    expect(screen.queryByText('Request 50')).toBeNull();
    expect(screen.queryByText('cindyMake.code.phases.environment')).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Build 50' } });
    expect(screen.getByText('Request 50')).toBeTruthy();
    expect(screen.queryByText('Request 0')).toBeNull();
  });
  it('does not show finished tasks and preserves selection when another record disappears', () => {
    const view = render(
      <CindyMakeTasksPanel reports={[report(1), report(2), report(3, { finished: true })]} />,
    );
    expect(screen.queryByText('Build 3')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Build 2/ }));
    view.rerender(<CindyMakeTasksPanel reports={[report(2)]} />);
    expect(screen.getByText('Request 2')).toBeTruthy();
  });
  it('opens an active task without starting another execution', async () => {
    render(<CindyMakeTasksPanel reports={[report(1)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.code.open' }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/cc-agent/session-1'));
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.manage).not.toHaveBeenCalled();
  });
  it('restores archived tasks before navigating', async () => {
    const archived = {
      id: 'session-1',
      status: 'archived',
      workingDir: '/make/run',
      workspaceKind: 'project',
    };
    h.get.mockResolvedValue(archived);
    let resolve!: (value: unknown) => void;
    h.restore.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<CindyMakeTasksPanel reports={[report(1, { sessionStatus: 'archived' })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.cindyMake.tasks.restore' }));
    await waitFor(() => expect(h.restore).toHaveBeenCalledWith('session-1', archived));
    expect(h.navigate).not.toHaveBeenCalled();
    await act(async () => resolve({ ...archived, status: 'active' }));
    expect(h.navigate).toHaveBeenCalledWith('/cc-agent/session-1');
  });
  it('does not revive a deleted task or continue after an account switch', async () => {
    h.get.mockResolvedValue({ id: 'session-1', status: 'deleted' });
    render(<CindyMakeTasksPanel reports={[report(1)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.code.open' }));
    await waitFor(() => expect(h.error).toHaveBeenCalled());
    expect(h.navigate).not.toHaveBeenCalled();
    h.confirm.mockImplementation(async () => {
      setDataOwnerGeneration('another-owner');
      return true;
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.cindyMake.tasks.delete' }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalled());
    expect(h.manage).not.toHaveBeenCalled();
  });
  it('requires confirmation before deleting and refreshes only after the operation settles', async () => {
    h.confirm.mockResolvedValueOnce(false);
    render(<CindyMakeTasksPanel reports={[report(1)]} />);
    const remove = screen.getByRole('button', { name: 'settings.cindyMake.tasks.delete' });
    fireEvent.click(remove);
    await waitFor(() => expect(remove.hasAttribute('disabled')).toBe(false));
    expect(h.manage).not.toHaveBeenCalled();
    fireEvent.click(remove);
    await waitFor(() => expect(h.manage).toHaveBeenCalledWith('session-1', 'delete'));
    expect(h.confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmVariant: 'destructive' }),
    );
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
  });
  it('keeps cleanup retry available without offering to reopen a deleted task', async () => {
    render(<CindyMakeTasksPanel reports={[report(1, { sessionStatus: 'deleted' })]} />);
    expect(screen.queryByRole('button', { name: 'cindyMake.code.open' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'settings.cindyMake.tasks.retryCleanup' }));
    await waitFor(() => expect(h.manage).toHaveBeenCalledWith('session-1', 'delete'));
    expect(h.confirm).not.toHaveBeenCalled();
  });
  it('shows cleanup progress and keeps an actionable failure beside the retry button', async () => {
    let reject!: (error: Error) => void;
    h.manage.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const view = render(
      <CindyMakeTasksPanel reports={[report(1, { sessionStatus: 'deleted' })]} />,
    );
    const button = screen.getByRole('button', { name: 'settings.cindyMake.tasks.retryCleanup' });
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'));
    expect(button.hasAttribute('disabled')).toBe(true);
    await act(async () => reject(new Error('[PRECONDITION_FAILED] directoryBusy')));
    view.rerender(
      <CindyMakeTasksPanel
        reports={[report(1, { sessionStatus: 'deleted' })]}
        taskActions={{
          'session-1': { action: 'delete', status: 'failed', error: 'directoryBusy' },
        }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'settings.cindyMake.tasks.errors.directoryBusy',
    );
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-busy')).toBeNull();
  });
  it('shows global cleanup after leaving and reopening settings, then retains its failure', () => {
    const props = {
      reports: [report(1, { sessionStatus: 'deleted' })],
      taskActions: { 'session-1': { action: 'delete' as const, status: 'running' as const } },
    };
    const first = render(<CindyMakeTasksPanel {...props} />);
    first.unmount();
    const next = render(<CindyMakeTasksPanel {...props} />);
    const retry = screen.getByRole('button', { name: 'settings.cindyMake.tasks.retryCleanup' });
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect(retry.hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByText('settings.cindyMake.tasks.status.cleaning')).toHaveLength(2);
    fireEvent.click(retry);
    expect(h.manage).not.toHaveBeenCalled();
    next.unmount();
    render(
      <CindyMakeTasksPanel
        reports={props.reports}
        taskActions={{
          'session-1': { action: 'delete', status: 'failed', error: 'directoryBusy' },
        }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'settings.cindyMake.tasks.errors.directoryBusy',
    );
    expect(
      screen
        .getByRole('button', { name: 'settings.cindyMake.tasks.retryCleanup' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });
});
