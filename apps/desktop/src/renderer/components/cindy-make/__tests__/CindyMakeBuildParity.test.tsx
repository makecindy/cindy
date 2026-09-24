// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { CindyMakePersonalBuildState } from '../../../../shared/cindyMakeSession';
import { CindyMakeHistoryPanel } from '../CindyMakeHistoryPanel';
import { CindyMakeTestCard } from '../CindyMakeTestCard';
import { CindyMakeBuildProgress } from '../CindyMakeBuildProgress';

const navigation = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { step?: string }) =>
      options?.step ? key + ': ' + options.step : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigation }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('@/lib/cindyMakeState', () => {
  const state = {};
  return { useCindyMakeState: () => state };
});
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { updateSystemCardData: vi.fn() },
}));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => undefined,
}));

afterEach(() => {
  cleanup();
  navigation.mockClear();
  vi.unstubAllGlobals();
});

it('replaces the single live line on progress, falls back at stage changes, and clears at completion', () => {
  const { rerender } = render(
    <CindyMakeBuildProgress
      build={{ status: 'checking', checkStep: 'tests', outputLine: 'Test Files 12 passed' }}
    />,
  );
  expect(screen.getByRole('status').textContent).toBe('Test Files 12 passed');
  rerender(
    <CindyMakeBuildProgress
      build={{ status: 'checking', checkStep: 'tests', outputLine: 'Test Files 57 passed' }}
    />,
  );
  expect(screen.queryByText('Test Files 12 passed')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Test Files 57 passed');
  rerender(<CindyMakeBuildProgress build={{ status: 'packaging' }} />);
  expect(screen.getByRole('status').textContent).toBe('cindyMake.personal.status.packaging');
  rerender(
    <CindyMakeBuildProgress
      build={{ status: 'packaging', outputLine: 'Old output', stopping: true }}
    />,
  );
  expect(screen.getByRole('status').textContent).toBe('cindyMake.history.stopping');
  rerender(<CindyMakeBuildProgress build={{ status: 'ready', outputLine: 'Old output' }} />);
  expect(screen.queryByRole('status')).toBeNull();
});

it('adds the optional latest-source step only to builds that captured the enabled setting', () => {
  const { rerender } = render(
    <CindyMakeBuildProgress build={{ status: 'syncing', syncLatestSource: true }} />,
  );
  expect(screen.getByText('cindyMake.history.progress.syncing')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('cindyMake.personal.status.syncing');

  rerender(<CindyMakeBuildProgress build={{ status: 'merging' }} />);
  expect(screen.queryByText('cindyMake.history.progress.syncing')).toBeNull();
});

it.each(['merging', 'failed', 'ready'] as const)(
  'shows live status only during an active build, without a merge navigation button: %s',
  (status) => {
    const mergeAction = vi.fn();
    vi.stubGlobal('electronAPI', { cindyMakeMerge: mergeAction });
    render(
      <CindyMakeBuildProgress
        build={{ status, mergeSessionId: 'merge-task', outputLine: 'Merging changes' }}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    if (status === 'merging')
      expect(screen.getByRole('status').textContent).toBe('Merging changes');
    else expect(screen.queryByRole('status')).toBeNull();
    expect(navigation).not.toHaveBeenCalled();
    expect(mergeAction).not.toHaveBeenCalled();
  },
);

it.each(['failed', 'ready'] as const)(
  'does not restore a merge button or live output on the actual %s history panel',
  async (status) => {
    setDataOwnerGeneration('history-link-owner');
    const mergeAction = vi.fn();
    vi.stubGlobal('electronAPI', {
      cindyMakeMerge: mergeAction,
      getCindyMakeHistory: vi.fn(async () => ({
        items: [],
        busy: false,
        canBuild: true,
        build: {
          status,
          buildId: 'build',
          mergeSessionId: 'merge-task',
          outputLine: 'Previous build output',
        },
      })),
    });
    render(<CindyMakeHistoryPanel />);
    await waitFor(() => expect(window.electronAPI.getCindyMakeHistory).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'cindyMake.merge.openTask' })).toBeNull();
    expect(screen.queryByText('Previous build output')).toBeNull();
    expect(navigation).not.toHaveBeenCalled();
    expect(mergeAction).not.toHaveBeenCalled();
  },
);

it('keeps the session and history headings and stage indicators in sync as the shared build advances', async () => {
  setDataOwnerGeneration('build-parity-owner');
  const meta = { reportedAt: 1, commit: 'a'.repeat(40) };
  let build: CindyMakePersonalBuildState = { status: 'waiting', buildId: 'shared-build' };
  vi.stubGlobal('electronAPI', {
    cindyMakeTest: vi.fn(async () => meta),
    getCindyMakeHistory: vi.fn(async () => ({
      items: [],
      busy: true,
      canBuild: false,
      build,
    })),
  });
  render(
    <>
      <CindyMakeHistoryPanel />
      <CindyMakeTestCard sessionId="session" completionId="completion" meta={meta} />
    </>,
  );
  const history = screen.getByRole('region', { name: 'cindyMake.history.title' });
  const session = screen.getByRole('region', { name: 'cindyMake.test.title' });
  await within(session).findAllByText('cindyMake.personal.status.waiting');

  const stages: Array<{ state: CindyMakePersonalBuildState; heading: string; completed: number }> =
    [
      {
        state: { status: 'waiting', preparationStep: 'original' },
        heading: 'preparationStep.original',
        completed: 0,
      },
      { state: { status: 'merging' }, heading: 'status.merging', completed: 1 },
      {
        state: { status: 'merging', mergeStep: 'conflicts' },
        heading: 'mergeStep.conflicts',
        completed: 2,
      },
      {
        state: { status: 'merging', mergeStep: 'cleanup' },
        heading: 'mergeStep.cleanup',
        completed: 2,
      },
      {
        state: { status: 'checking', checkStep: 'dependencies' },
        heading: 'checkStep.dependencies',
        completed: 2,
      },
      {
        state: { status: 'checking', checkStep: 'tests' },
        heading: 'checkStep.tests',
        completed: 2,
      },
      {
        state: { status: 'checking', checkStep: 'types' },
        heading: 'checkStep.types',
        completed: 2,
      },
      { state: { status: 'packaging' }, heading: 'status.packaging', completed: 3 },
      { state: { status: 'publishing' }, heading: 'status.publishing', completed: 4 },
    ];
  for (const { state, heading, completed } of stages) {
    build = { ...state, buildId: 'shared-build' };
    fireEvent(window, new Event('focus'));
    await waitFor(() => {
      for (const surface of [history, session]) {
        expect(within(surface).getAllByText('cindyMake.personal.' + heading)).toHaveLength(2);
        const current = surface.querySelectorAll('[aria-current="step"]');
        expect(current).toHaveLength(1);
        expect(current[0].textContent).toBe(
          state.mergeStep
            ? 'cindyMake.personal.buildLog.steps.' +
                (state.mergeStep === 'conflicts' ? 'resolving-conflicts' : 'cleaning-merge')
            : 'cindyMake.history.progress.' + state.status,
        );
        expect(surface.querySelectorAll('li[class*="--status-success"]')).toHaveLength(completed);
      }
    });
  }
  build = { ...build, stopping: true };
  fireEvent(window, new Event('focus'));
  await waitFor(() => {
    for (const surface of [history, session]) {
      expect(within(surface).getAllByText('cindyMake.history.stopping')).toHaveLength(3);
      expect(surface.querySelector('[aria-current="step"]')?.textContent).toBe(
        'cindyMake.history.progress.publishing',
      );
    }
  });

  for (const error of ['checksFailed', 'cancelled', undefined] as const) {
    build = {
      status: 'failed',
      buildId: 'shared-build',
      error,
      logs: [
        { step: 'checking-tests', at: 123 },
        { step: error === 'cancelled' ? 'cancelled' : 'failed', at: 124 },
      ],
    };
    fireEvent(window, new Event('focus'));
    await waitFor(() => {
      for (const surface of [history, session]) {
        const alert = within(surface).getByRole('alert');
        expect(alert.textContent).toContain(
          'cindyMake.personal.errors.' + (error ?? 'unavailable'),
        );
        expect(alert.closest('details')).toBeNull();
        if (error === 'cancelled') {
          expect(alert.textContent).not.toContain('cindyMake.personal.failedStep');
        } else {
          expect(alert.textContent).toContain(
            'cindyMake.personal.failedStep: cindyMake.personal.buildLog.steps.checking-tests',
          );
        }
        const details = within(surface)
          .getByText('cindyMake.personal.buildLog.title · 2')
          .closest('details');
        expect(details?.open).toBe(false);
      }
    });
  }
});
