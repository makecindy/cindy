// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CindyMakeTestCard } from '../CindyMakeTestCard';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { CindyMakeCompletionMeta } from '../../../../shared/cindyMakeSession';
import type { CindyMakeMergeState } from '../../../../shared/cindyMakeMerge';
const h = vi.hoisted(() => ({
  api: vi.fn(),
  patch: vi.fn(),
  navigate: vi.fn(),
  confirm: vi.fn(async () => true),
  merge: undefined as CindyMakeMergeState | undefined,
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm }),
}));
vi.mock('@/lib/cindyMakeState', () => ({ useCindyMakeState: () => ({ upstreamMerge: h.merge }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { step?: string }) =>
      options?.step ? key + ': ' + options.step : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { updateSystemCardData: h.patch } }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => undefined,
}));
const meta: CindyMakeCompletionMeta = { reportedAt: 123, commit: 'a'.repeat(40), changedFiles: 2 };
const view = () =>
  render(<CindyMakeTestCard sessionId="session" completionId="completion" meta={meta} />);
beforeEach(() => {
  vi.clearAllMocks();
  h.merge = undefined;
  setDataOwnerGeneration('test-owner');
  h.api.mockResolvedValue(meta);
  vi.stubGlobal('electronAPI', { cindyMakeTest: h.api });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('completion card in the input area', () => {
  it.each(['conflict', 'resolving', 'failed'] as const)(
    'blocks generation while source update is %s and unlocks after resolution',
    async (status) => {
      h.merge = {
        id: 'source-update',
        status,
        ref: 'main',
        upstreamCommit: 'a'.repeat(40),
        hasWorkspace: true,
      };
      const { rerender } = view();
      await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
      const generate = screen.getByRole('button', { name: 'cindyMake.personal.generate' });
      expect(generate.hasAttribute('disabled')).toBe(true);
      fireEvent.click(generate);
      expect(h.api).toHaveBeenCalledExactlyOnceWith('session', 'completion', 'status');
      h.merge = { ...h.merge, status: 'merged', hasWorkspace: false };
      rerender(<CindyMakeTestCard sessionId="session" completionId="completion" meta={meta} />);
      expect(generate.hasAttribute('disabled')).toBe(false);
      fireEvent.click(generate);
      await waitFor(() => expect(h.api).toHaveBeenCalledWith('session', 'completion', 'build'));
    },
  );
  it.each(['matching', 'other-task', 'other-round', 'other-account'])(
    'does not restore a legacy merge button in the build progress area: %s',
    async (binding) => {
      h.merge = {
        id: 'merge',
        status: 'failed',
        error: 'interrupted',
        ref: 'personal',
        upstreamCommit: 'a'.repeat(40),
        sessionId: 'resolver',
        ownedByAnotherAccount: binding === 'other-account',
        feature: {
          runId: 'run',
          taskSessionId: binding === 'other-task' ? 'elsewhere' : 'session',
          completionId: binding === 'other-round' ? 'other' : 'completion',
          action: 'integrate',
          taskTree: 'a'.repeat(40),
          steps: [],
          nextStep: 0,
        },
      };
      render(
        <CindyMakeTestCard
          sessionId="session"
          completionId="completion"
          meta={{
            ...meta,
            lastAction: 'build',
            personal: { status: 'failed', error: 'interrupted', buildId: 'build' },
          }}
        />,
      );
      await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
      const link = screen.queryByRole('button', { name: 'cindyMake.merge.openTask' });
      expect(link).toBeNull();
      expect(h.navigate).not.toHaveBeenCalled();
      expect(h.api).toHaveBeenCalledExactlyOnceWith('session', 'completion', 'status');
    },
  );
  it.each([false, true])(
    'keeps a failed test stop actionable during generation (structured=%s)',
    async (structured) => {
      const current = { ...meta, test: { status: 'ready' as const } };
      render(<CindyMakeTestCard sessionId="session" completionId="completion" meta={current} />);
      await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
      const failure = new Error('[PRECONDITION_FAILED] stopFailed');
      if (structured) Object.assign(failure, { code: 'PRECONDITION_FAILED' });
      h.api.mockRejectedValueOnce(failure);
      fireEvent.click(screen.getByRole('button', { name: 'cindyMake.personal.generate' }));
      expect((await screen.findByRole('alert')).textContent).toBe(
        'cindyMake.test.errors.stopFailed',
      );
      expect(
        (screen.getByRole('button', { name: 'cindyMake.test.continue' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      expect(
        (screen.getByRole('button', { name: 'cindyMake.personal.generate' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    },
  );

  it('releases input only after Continue Editing succeeds', async () => {
    const onContinue = vi.fn();
    render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={meta}
        onContinue={onContinue}
      />,
    );
    await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
    h.api.mockRejectedValueOnce(new Error('unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.test.continue' }));
    await screen.findByRole('alert');
    expect(onContinue).not.toHaveBeenCalled();
    h.api.mockResolvedValueOnce({ ...meta, continuedAt: 456 });
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.test.continue' }));
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce());
    expect(h.patch).toHaveBeenLastCalledWith('session', 'completion', {
      ...meta,
      continuedAt: 456,
    });
  });
  it('keeps the current test progress and failure ahead of an older personal build receipt', async () => {
    const personal = { buildId: 'previous-build', status: 'ready' as const };
    const history = vi.fn().mockResolvedValue({ build: personal });
    vi.stubGlobal('electronAPI', { cindyMakeTest: h.api, getCindyMakeHistory: history });
    const { rerender } = render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{
          ...meta,
          lastAction: 'test',
          personal,
          test: { status: 'starting', step: 'assets' },
        }}
      />,
    );
    await waitFor(() => expect(history).toHaveBeenCalledOnce());
    expect(
      screen.getByText('cindyMake.test.currentStep: cindyMake.test.steps.assets'),
    ).toBeDefined();
    expect(screen.queryByText('cindyMake.personal.status.ready')).toBeNull();
    rerender(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{
          ...meta,
          lastAction: 'test',
          personal,
          test: { status: 'failed', step: 'assets', error: 'launchFailed' },
        }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('cindyMake.test.errors.launchFailed');
    expect(
      screen.getByText('cindyMake.test.failedStep: cindyMake.test.steps.assets'),
    ).toBeDefined();
  });
  it('starts retry progress at waiting without carrying over the failed build log', async () => {
    render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{
          ...meta,
          lastAction: 'build',
          personal: {
            status: 'failed',
            error: 'checksFailed',
            logs: [
              { step: 'environment', at: 1 },
              { step: 'original', at: 2 },
              { step: 'merging', at: 3 },
              { step: 'checking-dependencies', at: 4 },
            ],
          },
        }}
      />,
    );

    await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
    h.api.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.personal.generate' }));
    expect(h.api).toHaveBeenLastCalledWith('session', 'completion', 'build');
    expect(screen.getAllByText('cindyMake.personal.status.waiting')).toHaveLength(2);
    expect(
      screen.getByText('cindyMake.history.progress.waiting').getAttribute('aria-current'),
    ).toBe('step');
    expect(screen.getByText('cindyMake.history.progress.merging').className).not.toContain(
      '--status-success',
    );
    expect(
      screen.queryByText('cindyMake.personal.buildLog.steps.checking-dependencies'),
    ).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('shows live startup steps, blocks editing, and offers retry with the failed step', async () => {
    const { rerender } = render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{ ...meta, test: { status: 'starting', step: 'dependencies' } }}
      />,
    );
    await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
    expect(
      screen.getByText('cindyMake.test.currentStep: cindyMake.test.steps.dependencies'),
    ).toBeDefined();
    expect(screen.getByText('cindyMake.test.startingHint')).toBeDefined();
    expect(screen.queryByText('cindyMake.test.description')).toBeNull();
    const continueButton = screen.getByRole('button', { name: 'cindyMake.test.continue' });
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(continueButton);
    expect(h.api.mock.calls.every(([, , action]) => action === 'status')).toBe(true);
    rerender(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{ ...meta, test: { status: 'starting', step: 'launching' } }}
      />,
    );
    expect(
      screen.getByText('cindyMake.test.currentStep: cindyMake.test.steps.launching'),
    ).toBeDefined();
    rerender(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{ ...meta, test: { status: 'failed', step: 'launching', error: 'timeout' } }}
      />,
    );
    expect(
      screen.getByText('cindyMake.test.failedStep: cindyMake.test.steps.launching'),
    ).toBeDefined();
    expect(screen.getByRole('alert').textContent).toBe('cindyMake.test.errors.timeout');
    expect((continueButton as HTMLButtonElement).disabled).toBe(false);
    h.api.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.test.start' }));
    expect(h.api).toHaveBeenLastCalledWith('session', 'completion', 'start');
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByText('cindyMake.test.currentStep: cindyMake.test.steps.waiting'),
    ).toBeDefined();
  });
  it('supports older starting records without a step and unlocks editing after readiness', () => {
    const { rerender } = render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{ ...meta, test: { status: 'starting' } }}
      />,
    );
    expect(
      screen.getByText('cindyMake.test.currentStep: cindyMake.test.steps.waiting'),
    ).toBeDefined();
    rerender(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{ ...meta, test: { status: 'ready' } }}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'cindyMake.test.continue' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      screen.queryByText('cindyMake.test.currentStep: cindyMake.test.steps.waiting'),
    ).toBeNull();
  });
  it('opens a Settings-generated legacy installer through its own receipt', async () => {
    const build = { buildId: 'settings-build', status: 'packaging' };
    const history = vi.fn().mockResolvedValue({ build });
    const open = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('electronAPI', {
      cindyMakeTest: h.api,
      getCindyMakeHistory: history,
      openCindyMakeHistoryBuild: open,
    });
    view();
    await screen.findByRole('button', { name: 'cindyMake.history.stop' });
    history.mockResolvedValue({ build: { ...build, status: 'ready', artifactName: 'Cindy.exe' } });
    fireEvent(window, new Event('focus'));
    fireEvent.click(await screen.findByRole('button', { name: 'cindyMake.personal.open' }));
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(
      h.api.mock.calls.some(([, , action]) => action === 'build' || action === 'open-build'),
    ).toBe(false);
  });
  it('does not show a previous account build after changing owners', async () => {
    const history = vi
      .fn()
      .mockResolvedValue({ build: { buildId: 'other-owner', status: 'packaging' } });
    vi.stubGlobal('electronAPI', { cindyMakeTest: h.api, getCindyMakeHistory: history });
    const { rerender } = view();
    await screen.findByRole('button', { name: 'cindyMake.history.stop' });
    history.mockResolvedValue({});
    setDataOwnerGeneration('next-owner');
    rerender(<CindyMakeTestCard sessionId="session" completionId="completion" meta={meta} />);
    expect(screen.queryByRole('button', { name: 'cindyMake.history.stop' })).toBeNull();
  });
  it('reopens a Settings build and stops the same build without continuing the task', async () => {
    const build = { buildId: 'settings-build', status: 'packaging' as const };
    const history = vi.fn().mockResolvedValue({ items: [], busy: true, canBuild: false, build });
    const cancel = vi.fn().mockResolvedValue({ build: { ...build, stopping: true } });
    vi.stubGlobal('electronAPI', {
      cindyMakeTest: h.api,
      getCindyMakeHistory: history,
      cancelCindyMakePersonal: cancel,
    });
    const first = view();
    await screen.findByRole('button', { name: 'cindyMake.history.stop' });
    first.unmount();
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'cindyMake.history.stop' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('settings-build'));
    expect(
      (
        (await screen.findByRole('button', {
          name: 'cindyMake.history.stopping',
        })) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(h.api.mock.calls.every(([, , action]) => action === 'status')).toBe(true);
    history.mockResolvedValue({ build: { ...build, status: 'failed', error: 'cancelled' } });
    fireEvent(window, new Event('focus'));
    await screen.findByText('cindyMake.personal.errors.cancelled');
    expect(
      (screen.getByRole('button', { name: 'cindyMake.personal.generate' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
  it('uses terminal completion updates ahead of an older polled build progress', async () => {
    const build = { buildId: 'card-build', status: 'packaging' as const };
    vi.stubGlobal('electronAPI', {
      cindyMakeTest: h.api,
      getCindyMakeHistory: vi.fn().mockResolvedValue({ build }),
    });
    const { rerender } = render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{ ...meta, personal: build }}
      />,
    );
    await screen.findByRole('button', { name: 'cindyMake.history.stop' });
    rerender(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{ ...meta, personal: { ...build, status: 'failed', error: 'checksFailed' } }}
      />,
    );
    expect(screen.getByText('cindyMake.personal.errors.checksFailed')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'cindyMake.history.stop' })).toBeNull();
  });
  it('only reads status on mount and starts the isolated build after the user clicks', async () => {
    view();
    await waitFor(() => expect(h.api).toHaveBeenCalledWith('session', 'completion', 'status'));
    expect(h.api).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox')).toBeNull();
    h.api.mockResolvedValueOnce({ ...meta, test: { status: 'starting' } });
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.test.start' }));
    await waitFor(() => expect(h.api).toHaveBeenCalledWith('session', 'completion', 'start'));
  });
  it('does not let a delayed status read undo the acknowledged launch', async () => {
    let status!: (value: CindyMakeCompletionMeta) => void;
    h.api.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          status = resolve;
        }),
    );
    h.api.mockResolvedValueOnce({ ...meta, test: { status: 'starting' } });
    view();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.test.start' }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledOnce());
    await act(async () => status(meta));
    expect(h.patch).toHaveBeenCalledOnce();
    expect(h.patch.mock.calls[0][2].test.status).toBe('starting');
  });
  it('keeps the card when continuing is rejected and persists continuation only after acknowledgment', async () => {
    view();
    await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
    h.api.mockRejectedValueOnce(new Error('rejected'));
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.test.continue' }));
    await screen.findByRole('alert');
    expect(h.patch.mock.calls.some(([, , value]) => value.continuedAt)).toBe(false);
    h.api.mockResolvedValueOnce({ ...meta, continuedAt: 456 });
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.test.continue' }));
    await waitFor(() =>
      expect(h.patch).toHaveBeenCalledWith('session', 'completion', { ...meta, continuedAt: 456 }),
    );
  });
  it('prevents duplicate launches while the first request is pending', async () => {
    view();
    await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
    let resolve!: (value: CindyMakeCompletionMeta) => void;
    h.api.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const start = screen.getByRole('button', { name: 'cindyMake.test.start' });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(h.api.mock.calls.filter(([, , action]) => action === 'start')).toHaveLength(1);
    await act(async () => resolve({ ...meta, test: { status: 'starting' } }));
  });
  it('does not offer a launch without a verified commit', () => {
    render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{ reportedAt: 123 }}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'cindyMake.test.start' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('cindyMake.test.errors.unavailable');
    expect(
      (screen.getByRole('button', { name: 'cindyMake.personal.generate' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it('offers all three choices and generates a personal installer only on click', async () => {
    view();
    await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'cindyMake.test.continue' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'cindyMake.test.start' })).toBeDefined();
    h.api.mockResolvedValueOnce({ ...meta, lastAction: 'build', personal: { status: 'waiting' } });
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.personal.generate' }));
    await waitFor(() => expect(h.api).toHaveBeenCalledWith('session', 'completion', 'build'));
    expect(h.patch).toHaveBeenCalledWith(
      'session',
      'completion',
      expect.objectContaining({ personal: { status: 'waiting' } }),
    );
  });
  it('shows personal build progress and disables every action until it finishes', () => {
    render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{
          ...meta,
          lastAction: 'build',
          personal: { status: 'packaging', logs: [{ step: 'packaging', at: 123 }] },
        }}
      />,
    );
    expect(screen.getAllByText('cindyMake.personal.status.packaging')).toHaveLength(2);
    expect(screen.getByText('cindyMake.personal.buildLog.title · 1')).toBeDefined();
    expect(screen.getByText('cindyMake.personal.buildLog.steps.packaging')).toBeDefined();
    expect(
      screen
        .getByText('cindyMake.personal.buildLog.title · 1')
        .closest('details')
        ?.hasAttribute('open'),
    ).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'cindyMake.test.continue' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'cindyMake.test.start' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'cindyMake.personal.generate' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.test.continue' }));
    expect(h.api.mock.calls.some(([, , action]) => action !== 'status')).toBe(false);
  });
  it('shows the preparation detail and structured generation record', () => {
    render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{
          ...meta,
          lastAction: 'build',
          personal: {
            status: 'waiting',
            preparationStep: 'environment',
            logs: [{ step: 'environment', at: 123 }],
          },
        }}
      />,
    );
    expect(screen.getAllByText('cindyMake.personal.preparationStep.environment')).toHaveLength(2);
    expect(screen.getByText('cindyMake.personal.buildLog.steps.environment')).toBeDefined();
    expect(
      screen
        .getByText('cindyMake.personal.buildLog.title · 1')
        .closest('details')
        ?.hasAttribute('open'),
    ).toBe(false);
  });
  it('offers the installer when ready and gives failed builds a retry', async () => {
    const { rerender } = render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{
          ...meta,
          lastAction: 'build',
          personal: { status: 'ready', artifactName: 'Cindy.exe' },
        }}
      />,
    );
    await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
    expect(
      screen.getAllByRole('button').every((button) => !(button as HTMLButtonElement).disabled),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.personal.open' }));
    await waitFor(() => expect(h.api).toHaveBeenCalledWith('session', 'completion', 'open-build'));
    rerender(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{
          ...meta,
          lastAction: 'build',
          personal: {
            status: 'failed',
            error: 'checksFailed',
            logs: [
              { step: 'merging', at: 123 },
              { step: 'checking-tests', at: 124 },
              { step: 'failed', at: 125 },
            ],
          },
        }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'cindyMake.personal.failedStep: cindyMake.personal.buildLog.steps.checking-tests',
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'cindyMake.personal.errors.checksFailed',
    );
    expect(
      screen
        .getByText('cindyMake.personal.buildLog.title · 3')
        .closest('details')
        ?.hasAttribute('open'),
    ).toBe(false);
    expect(
      screen.getAllByRole('button').every((button) => !(button as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'cindyMake.personal.generate' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
  it('offers personal regeneration after a personal version is ready', async () => {
    render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{
          ...meta,
          lastAction: 'build',
          personal: { status: 'ready', versionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
        }}
      />,
    );
    const regenerate = await screen.findByRole('button', {
      name: 'cindyMake.history.regeneratePersonal',
    });
    fireEvent.click(regenerate);
    await waitFor(() => expect(h.api).toHaveBeenCalledWith('session', 'completion', 'build'));
  });
  it('uses the single personal version from an old completion instead of switching to its historical build', async () => {
    h.merge = {
      id: 'source-update',
      status: 'conflict',
      ref: 'main',
      upstreamCommit: 'a'.repeat(40),
      hasWorkspace: true,
    };
    const switchVersion = vi.fn().mockResolvedValue({
      currentId: 'original',
      selectedId: 'original',
      versions: [],
      switching: true,
    });
    vi.stubGlobal('electronAPI', {
      cindyMakeTest: h.api,
      getCindyVersions: vi.fn().mockResolvedValue({
        currentId: 'original',
        selectedId: 'original',
        versions: [{ id: 'personal', kind: 'personal', available: true, compatible: true }],
        switching: false,
      }),
      actCindyVersion: switchVersion,
    });
    render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{
          ...meta,
          lastAction: 'build',
          personal: { status: 'ready', versionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
        }}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'cindyMake.versions.switchPersonal' }),
    );
    await waitFor(() => expect(switchVersion).toHaveBeenCalledWith('switch', 'personal'));
    expect(h.api.mock.calls.some(([, , action]) => action === 'open-build')).toBe(false);
  });
  it('offers regeneration after the personal version was deleted instead of reviving a historical build', async () => {
    vi.stubGlobal('electronAPI', {
      cindyMakeTest: h.api,
      getCindyVersions: vi.fn().mockResolvedValue({
        currentId: 'original',
        selectedId: 'original',
        switching: false,
        versions: [{ id: 'original', kind: 'original', available: true, compatible: true }],
      }),
      actCindyVersion: vi.fn(),
    });
    render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{
          ...meta,
          lastAction: 'build',
          personal: { status: 'ready', versionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
        }}
      />,
    );
    const generate = await screen.findByRole('button', { name: 'cindyMake.personal.generate' });
    expect(screen.getByText('cindyMake.versions.empty')).toBeTruthy();
    fireEvent.click(generate);
    await waitFor(() => expect(h.api).toHaveBeenCalledWith('session', 'completion', 'build'));
    expect(window.electronAPI.actCindyVersion).not.toHaveBeenCalled();
  });
  it('allows a new completion to generate after the previous personal build is already in use', async () => {
    vi.stubGlobal('electronAPI', {
      cindyMakeTest: h.api,
      getCindyVersions: vi.fn().mockResolvedValue({
        currentId: 'personal',
        selectedId: 'personal',
        personalUpdateAvailable: false,
        switching: false,
        versions: [{ id: 'personal', kind: 'personal', available: true, compatible: true }],
      }),
      actCindyVersion: vi.fn(),
    });
    const { rerender } = render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{
          ...meta,
          lastAction: 'build',
          personal: { status: 'ready', versionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
        }}
      />,
    );
    expect(
      (
        (await screen.findByRole('button', {
          name: 'cindyMake.versions.using',
        })) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    rerender(
      <CindyMakeTestCard
        sessionId="session"
        completionId="next-completion"
        meta={{ ...meta, commit: 'b'.repeat(40) }}
      />,
    );
    const generate = screen.getByRole('button', { name: 'cindyMake.personal.generate' });
    expect((generate as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(generate);
    await waitFor(() => expect(h.api).toHaveBeenCalledWith('session', 'next-completion', 'build'));
    expect(window.electronAPI.actCindyVersion).not.toHaveBeenCalled();
  });
});
