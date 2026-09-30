// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useCindyMakeState } from '@/lib/cindyMakeState';
import type { CindyMakeGlobalState, MakeDoctorReport } from '../../../../shared/cindyMakeDoctor';
import { CindyMakeTasksPanel } from '../CindyMakeTasksPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: async () => true }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

function report(index: number): MakeDoctorReport {
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
    },
  };
}

/** Use the same shared snapshot and conditional panel as Settings. */
function TaskList() {
  const state = useCindyMakeState();
  const reports = Object.values(state.tasks ?? {});
  return reports.length ? (
    <CindyMakeTasksPanel reports={reports} taskActions={state.taskActions} />
  ) : null;
}

beforeEach(() => setDataOwnerGeneration('make-task-list-state-test'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Cindy Make task list completion', () => {
  it.each(['end'] as const)(
    'removes a successful %s without waiting for another snapshot or reopening Settings',
    async (action) => {
      let push!: (state: CindyMakeGlobalState) => void;
      let complete!: () => void;
      const initial: CindyMakeGlobalState = { tasks: { 'run-1': report(1), 'run-2': report(2) } };
      const getState = vi
        .fn(() => new Promise<CindyMakeGlobalState>(() => {}))
        .mockResolvedValueOnce(initial);
      const manage = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      );
      vi.stubGlobal('electronAPI', {
        getCindyMakeState: getState,
        onCindyMakeState: (listener: typeof push) => {
          push = listener;
          return () => {};
        },
        manageCindyMakeTask: manage,
      });
      render(<TaskList />);
      fireEvent.click(await screen.findByRole('button', { name: /Build 2/ }));
      fireEvent.click(screen.getByRole('button', { name: 'settings.cindyMake.tasks.' + action }));
      await waitFor(() => expect(manage).toHaveBeenCalledWith('session-2', action));
      act(() =>
        push({
          ...initial,
          taskActions: { 'session-2': { action, status: 'running' } },
        }),
      );
      expect(screen.getAllByText('settings.cindyMake.tasks.status.cleaning')).toHaveLength(2);

      // Main has completed, but its final push is absent and the next read is still pending.
      await act(async () => complete());
      await waitFor(() => expect(screen.queryByRole('button', { name: /Build 2/ })).toBeNull());
      expect(
        screen.getByRole('heading', { name: 'settings.cindyMake.tasks.title · 1' }),
      ).toBeTruthy();
      expect(screen.getByText('Request 1')).toBeTruthy();
      expect(screen.queryByText('settings.cindyMake.tasks.status.cleaning')).toBeNull();
      expect(
        screen
          .getByRole('button', { name: 'settings.cindyMake.tasks.end' })
          .hasAttribute('disabled'),
      ).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'settings.cindyMake.tasks.end' }));
      await waitFor(() => expect(manage).toHaveBeenLastCalledWith('session-1', 'end'));
      await act(async () => complete());
      expect(screen.queryByRole('region', { name: 'settings.cindyMake.tasks.title' })).toBeNull();
    },
  );
});
