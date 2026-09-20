// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { isValidElement } from 'react';
import { CindyMakeSection } from '../CindyMakeSection';
import type { CindyMakeMergeState, CindyMakeMergeRequest } from '../../../../shared/cindyMakeMerge';
import { startMakeDoctor } from '@/lib/cindyMakeDoctor';
import { setCindyMakeForceManagedTools } from '@/lib/cindyMakeSettings';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import type {
  CindyMakeGlobalState,
  MakeDoctorReport,
  MakeSourceStatus,
} from '../../../../shared/cindyMakeDoctor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, values?: { resolved: number; reused: number; downloaded: number }) =>
      key === 'cindyMake.source.cacheProgress' && values
        ? `${key} ${values.resolved} / ${values.reused} / ${values.downloaded}`
        : key,
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/state/newMakerDraft', () => ({
  getDraft: () => ({
    vendor: 'codex',
    lastByVendor: { codex: { model: 'test-model', permissionMode: 'ask' } },
  }),
  getFastModeForModel: () => false,
}));
const confirmMerge = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({
    confirm: confirmMerge,
  }),
}));

type Api = Parameters<typeof startMakeDoctor>[1];
type Listener = Parameters<NonNullable<Api>['onDesktopCommandTriggered']>[0];
type Result = Awaited<ReturnType<NonNullable<Api>['executeDesktopCommand']>>;

function harness() {
  const listeners = new Set<Listener>();
  const sourceListeners = new Set<(status: MakeSourceStatus) => void>();
  const stateListeners = new Set<(state: CindyMakeGlobalState) => void>();
  let globalState: CindyMakeGlobalState = {};
  const runs = new Map<string, (result: Result) => void>();
  const api = {
    cindyMakeMerge: vi.fn(
      async (_request: CindyMakeMergeRequest): Promise<CindyMakeMergeState | undefined> =>
        undefined,
    ),
    getCindyMakeState: vi.fn(async (): Promise<CindyMakeGlobalState> => ({
      ...globalState,
      source: globalState.source ?? (await api.getCindyMakeSourceStatus()),
    })),
    onCindyMakeState: (listener: (state: CindyMakeGlobalState) => void) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    openCindyMakeToolsDir: vi.fn(async () => ({ success: true })),
    getCindyMakeSourceStatus: vi.fn(async () => undefined as MakeSourceStatus | undefined),
    openCindyMakeSourceDir: vi.fn(async () => ({ success: true })),
    onCindyMakeSourceStatus: (listener: (status: MakeSourceStatus) => void) => {
      sourceListeners.add(listener);
      return () => {
        sourceListeners.delete(listener);
      };
    },
    cancelCindyMakeSource: vi.fn(async () => ({ success: true })),
    onDesktopCommandTriggered: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    executeDesktopCommand: vi.fn<NonNullable<Api>['executeDesktopCommand']>((_name, ctx) => {
      if (ctx.doctorAction === 'cancel') return Promise.resolve({ success: true });
      return new Promise((resolve) => {
        runs.set(ctx.doctorRunId!, resolve);
      });
    }),
  };
  vi.stubGlobal('electronAPI', {
    getCindyMakeHistory: async () => ({
      busy: false,
      canBuild: false,
      items: Object.values(globalState.tasks ?? {})
        .filter((report) => report.task)
        .map((report) => ({
          schema: 1,
          runId: report.runId,
          sessionId: report.task!.sessionId,
          title: report.task!.title ?? '',
          request: report.task!.request ?? '',
          createdAt: 1,
          updatedAt: 1,
          completions: [],
          receipts: [],
          versions: [],
          lifecycle: 'editing',
          integration: 'unintegrated',
          actions: ['open'],
        })),
    }),
    cindyMakeMerge: api.cindyMakeMerge,
    maker: api,
    getCindyMakeState: api.getCindyMakeState,
    onCindyMakeState: api.onCindyMakeState,
    openCindyMakeToolsDir: api.openCindyMakeToolsDir,
    getCindyMakeSourceStatus: async () => {
      const source = await api.getCindyMakeSourceStatus();
      if (source) {
        globalState = { ...globalState, source };
        for (const listener of stateListeners) listener(globalState);
      }
      return source;
    },
    openCindyMakeSourceDir: api.openCindyMakeSourceDir,
    onCindyMakeSourceStatus: api.onCindyMakeSourceStatus,
    cancelCindyMakeSource: api.cancelCindyMakeSource,
  });
  const starts = () => api.executeDesktopCommand.mock.calls.filter(([, ctx]) => !ctx.doctorAction);
  /** Main's global source broadcast, whichever window or workflow drives the job. */
  const pushSource = async (status: MakeSourceStatus) => {
    await act(async () => {
      api.getCindyMakeSourceStatus.mockResolvedValue(status);
      for (const listener of sourceListeners) listener(status);
      globalState = { ...globalState, source: status };
      for (const listener of stateListeners) listener(globalState);
    });
  };
  const complete = async (
    runId: string,
    version: string,
    checks: MakeDoctorReport['checks'] = [{ id: 'node', status: 'passed', version }],
  ) => {
    const report: MakeDoctorReport = {
      runId,
      platform: 'win32',
      arch: 'x64',
      status: 'completed',
      checks,
    };
    await act(async () => {
      runs.get(runId)!({ success: true, doctorReport: report });
    });
  };
  const pushState = async (state: CindyMakeGlobalState) => {
    await act(async () => {
      globalState = state;
      for (const listener of stateListeners) listener(state);
    });
  };
  return { api, starts, complete, listeners, pushSource, pushState, stateListeners };
}

function renderVersions(ui: Parameters<typeof render>[0]) {
  return render(
    isValidElement(ui) && ui.type === MemoryRouter ? ui : <MemoryRouter>{ui}</MemoryRouter>,
  );
}

/** Environment-specific cases explicitly enter the second tab after opening Settings. */
function renderEnvironment(ui: Parameters<typeof render>[0]) {
  const view = renderVersions(ui);
  fireEvent.click(screen.getByRole('tab', { name: 'settings.cindyMake.tabs.environment' }));
  return view;
}

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  setDataOwnerGeneration('settings-make-test-owner');
  vi.stubEnv('DEV', true);
  setCindyMakeForceManagedTools(false);
});
afterEach(() => {
  cleanup();
  setCindyMakeForceManagedTools(false);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Settings > Cindy Make', () => {
  it('opens version control first and preserves the keyboard tab order and scoped creation action', async () => {
    const h = harness();
    const getVersions = vi.fn(async () => ({
      currentId: 'original',
      selectedId: 'original',
      switching: false,
      versions: [
        { id: 'original', kind: 'original', available: true, compatible: true, version: '0.1.99' },
      ],
    }));
    vi.stubGlobal('electronAPI', { ...window.electronAPI, getCindyVersions: getVersions });
    render(
      <MemoryRouter>
        <CindyMakeSection />
      </MemoryRouter>,
    );
    await h.complete(h.starts()[0][1].doctorRunId!, '22.23.2');
    const environment = screen.getByRole('tab', { name: 'settings.cindyMake.tabs.environment' });
    const versions = screen.getByRole('tab', { name: 'settings.cindyMake.tabs.versions' });
    expect(screen.getAllByRole('tab')).toEqual([versions, environment]);
    expect(versions.getAttribute('aria-selected')).toBe('true');
    expect(versions.getAttribute('aria-controls')).toBe(
      screen.getByRole('tabpanel', { name: 'settings.cindyMake.tabs.versions' }).id,
    );
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(
      within(screen.getByRole('tabpanel', { name: 'settings.cindyMake.tabs.versions' })).getByRole(
        'region',
        { name: 'settings.cindyMake.source.title' },
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(await screen.findByText('0.1.99')).toBeTruthy();
    expect(
      within(
        screen.getByRole('tabpanel', { name: 'settings.cindyMake.tabs.versions' }),
      ).queryByRole('button', { name: 'settings.cindyMake.create.title' }),
    ).toBeNull();
    const source = screen.getByRole('region', { name: 'settings.cindyMake.source.title' });
    expect(
      source.parentElement?.contains(
        screen.getByRole('heading', { name: /cindyMake.versions.current/ }),
      ),
    ).toBe(true);

    expect(getVersions).toHaveBeenCalledTimes(1);
    versions.focus();
    fireEvent.keyDown(versions, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(environment);
    const environmentPanel = screen.getByRole('tabpanel', {
      name: 'settings.cindyMake.tabs.environment',
    });
    expect(environment.getAttribute('aria-selected')).toBe('true');
    expect(environment.getAttribute('aria-controls')).toBe(environmentPanel.id);
    expect(screen.queryByRole('region', { name: 'settings.cindyMake.source.title' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'cindyMake.versions.title' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.cindyMake.create.title' })).toBeNull();
    fireEvent.keyDown(environment, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(versions);
    await waitFor(() => expect(getVersions).toHaveBeenCalledTimes(2));
    fireEvent.keyDown(versions, { key: 'End' });
    expect(document.activeElement).toBe(environment);
    expect(screen.getByRole('tabpanel', { name: 'settings.cindyMake.tabs.environment' })).toBe(
      environmentPanel,
    );
    fireEvent.keyDown(environment, { key: 'Home' });
    expect(document.activeElement).toBe(versions);
    await waitFor(() => expect(getVersions).toHaveBeenCalledTimes(3));
    expect(h.starts()).toHaveLength(1);
  });
  it('keeps background preparation, expansion and task search intact while switching tabs', async () => {
    const h = harness();
    renderVersions(
      <MemoryRouter>
        <CindyMakeSection />
      </MemoryRouter>,
    );
    const checkRun = h.starts()[0][1].doctorRunId!;
    await h.complete(checkRun, '22.23.2');
    const task: MakeDoctorReport = {
      runId: 'personal-run',
      platform: 'win32',
      arch: 'x64',
      status: 'completed',
      checks: [],
      task: {
        sessionId: 'personal-task',
        title: 'Blue background',
        request: 'Make it blue',
        phase: 'completed',
      },
    };
    await h.pushState({
      source: {
        status: 'preparing',
        path: '/managed/source',
        ref: 'main',
        phase: 'cloning',
        progress: { stage: 'receiving', percent: 25 },
      },
      tasks: { 'personal-run': task },
    });
    const sourceCard = screen.getByRole('region', { name: 'settings.cindyMake.source.title' });
    expect(within(sourceCard).getByText('/managed/source')).toBeTruthy();
    expect(
      within(sourceCard).queryByRole('button', { name: 'cindyMake.overview.details' }),
    ).toBeNull();
    const tasks = screen.getByRole('region', { name: 'cindyMake.history.title' });
    fireEvent.change(within(tasks).getByRole('textbox'), { target: { value: 'Blue' } });
    fireEvent.click(screen.getByRole('tab', { name: 'settings.cindyMake.tabs.environment' }));
    expect(screen.queryByRole('region', { name: 'settings.cindyMake.source.title' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'cindyMake.history.title' })).toBeNull();
    await h.pushSource({
      status: 'preparing',
      path: '/managed/source',
      ref: 'main',
      phase: 'cloning',
      progress: { stage: 'receiving', percent: 75 },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'settings.cindyMake.tabs.versions' }));
    expect(screen.getByRole('region', { name: 'settings.cindyMake.source.title' })).toBe(
      sourceCard,
    );
    expect(within(sourceCard).getByText('/managed/source')).toBeTruthy();
    expect(within(sourceCard).getByRole('status').textContent).toContain('(75%)');
    expect((within(tasks).getByRole('textbox') as HTMLInputElement).value).toBe('Blue');
    expect(h.starts()).toHaveLength(1);
    expect(
      h.api.executeDesktopCommand.mock.calls.some(
        ([, context]) => context.doctorAction === 'cancel',
      ),
    ).toBe(false);
    expect(h.api.cancelCindyMakeSource).not.toHaveBeenCalled();
  });
  it('keeps only the update icon, confirms it and does nothing on cancel', async () => {
    const h = harness();
    const source: MakeSourceStatus = {
      status: 'ready',
      path: '/managed/source',
      ref: 'main',
      commit: 'a'.repeat(40),
    };
    h.api.getCindyMakeSourceStatus.mockResolvedValue(source);
    renderVersions(<CindyMakeSection />);
    const button = await screen.findByRole('button', { name: 'cindyMake.merge.getLatest' });
    expect(screen.getAllByRole('button', { name: 'cindyMake.merge.getLatest' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'settings.cindyMake.source.update' })).toBeNull();
    confirmMerge.mockResolvedValueOnce(false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(confirmMerge).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'cindyMake.merge.confirmTitle',
          description: 'cindyMake.merge.confirmDescription',
        }),
      ),
    );
    expect(h.api.cindyMakeMerge).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() =>
      expect(h.api.cindyMakeMerge).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'update',
          createOptions: expect.objectContaining({ agentKind: 'codex', model: 'test-model' }),
        }),
      ),
    );
    expect(h.starts().filter(([, ctx]) => ctx.makeAction === 'prepare-source')).toHaveLength(0);
  });
  it.each(['merged', 'failed'] as const)(
    'shows live progress, then a quiet success or actionable %s result on reentry',
    async (result) => {
      const h = harness();
      const source: MakeSourceStatus = { status: 'ready', path: '/managed/source', ref: 'main' };
      const previous: CindyMakeMergeState = {
        id: 'previous-update',
        status: 'merged',
        ref: 'main',
        upstreamCommit: 'a'.repeat(40),
      };
      h.api.getCindyMakeSourceStatus.mockResolvedValue(source);
      const view = renderVersions(<CindyMakeSection />);
      await h.pushState({ source, upstreamMerge: previous });
      let finish!: (state: CindyMakeMergeState) => void;
      h.api.cindyMakeMerge.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const card = screen.getByRole('region', { name: 'settings.cindyMake.source.title' });
      fireEvent.click(within(card).getByRole('button', { name: 'cindyMake.merge.getLatest' }));
      await waitFor(() => expect(h.api.cindyMakeMerge).toHaveBeenCalledOnce());
      expect(within(card).getByRole('status').textContent).toBe('cindyMake.merge.status.fetching');
      expect(within(card).queryByText('cindyMake.merge.status.merged')).toBeNull();
      const current = { ...previous, id: 'current-update' };
      for (const status of ['fetching', 'merging', 'checking'] as const) {
        await h.pushState({ source, upstreamMerge: { ...current, status } });
        expect(within(card).getAllByRole('status')).toHaveLength(1);
        expect(within(card).getByRole('status').textContent).toBe(
          'cindyMake.merge.status.' + status,
        );
        expect(within(card).queryByText('settings.cindyMake.source.status.ready')).toBeNull();
        expect(
          within(card)
            .getByRole('button', { name: 'cindyMake.merge.getLatest' })
            .getAttribute('aria-busy'),
        ).toBe('true');
      }
      const finalState: CindyMakeMergeState = {
        ...current,
        status: result,
        ...(result === 'failed' ? { error: 'gitFailed' as const } : {}),
      };
      await h.pushState({ source, upstreamMerge: finalState });
      if (result === 'failed')
        expect(within(card).getByText('cindyMake.merge.status.failed')).toBeTruthy();
      if (result === 'merged')
        h.api.getCindyMakeSourceStatus.mockRejectedValueOnce(new Error('refresh failed'));
      await act(async () => finish(finalState));
      const notify = result === 'merged' ? toast.success : toast.error;
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        result === 'merged' ? 'cindyMake.merge.status.merged' : 'cindyMake.merge.errors.gitFailed',
      );
      expect(result === 'merged' ? toast.error : toast.success).not.toHaveBeenCalled();
      await h.pushState({ source, upstreamMerge: finalState });
      view.unmount();
      renderVersions(<CindyMakeSection />);
      const reopened = screen.getByRole('region', { name: 'settings.cindyMake.source.title' });
      await waitFor(() =>
        expect(
          within(reopened).getByText(
            result === 'merged'
              ? 'cindyMake.overview.comparison.unknown'
              : 'cindyMake.merge.status.failed',
          ),
        ).toBeTruthy(),
      );
      expect(within(reopened).getAllByRole('status')).toHaveLength(1);
      expect(within(reopened).queryByText('settings.cindyMake.source.status.ready')).toBeNull();
      if (result === 'failed')
        expect(within(reopened).getByText('cindyMake.merge.errors.gitFailed')).toBeTruthy();
      expect(notify).toHaveBeenCalledTimes(1);
    },
  );
  it('shows the source card immediately and keeps local details visible while the latest lookup waits', async () => {
    const h = harness();
    let finish!: (source: MakeSourceStatus) => void;
    const pending = new Promise<MakeSourceStatus>((resolve) => {
      finish = resolve;
    });
    h.api.getCindyMakeSourceStatus.mockReturnValue(pending);
    renderVersions(<CindyMakeSection />);
    const card = screen.getByRole('region', { name: 'settings.cindyMake.source.title' });
    expect(within(card).getByText('settings.cindyMake.source.description')).toBeTruthy();
    expect(within(card).queryByRole('status')).toBeNull();
    expect(
      within(card).queryByRole('button', { name: 'settings.cindyMake.source.prepare' }),
    ).toBeNull();
    expect(within(card).queryByRole('button', { name: 'cindyMake.merge.getLatest' })).toBeNull();

    const source: MakeSourceStatus = {
      status: 'ready',
      path: '/managed/source',
      ref: 'main',
      mainCommit: 'a'.repeat(40),
    };
    await h.pushState({ source });
    expect(within(card).getByText(source.path)).toBeTruthy();
    expect(within(card).getByText('a'.repeat(12))).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'cindyMake.merge.getLatest' })).toBeTruthy();
    await act(async () =>
      finish({
        ...source,
        latestVersion: { status: 'unavailable', channel: 'dev' },
      }),
    );
    expect(screen.getByRole('region', { name: 'settings.cindyMake.source.title' })).toBe(card);
    expect(within(card).getByText('a'.repeat(12))).toBeTruthy();
    expect(within(card).getByText(/cindyMake.overview.lookupUnavailable/)).toBeTruthy();
  });
  it('offers conflict resolution only after a conflict and creates a task only on click', async () => {
    const h = harness();
    const source: MakeSourceStatus = { status: 'ready', path: '/managed/source', ref: 'main' };
    const merge: CindyMakeMergeState = {
      id: 'merge',
      status: 'conflict',
      ref: 'main',
      upstreamCommit: 'a'.repeat(40),
      hasWorkspace: true,
    };
    renderVersions(
      <MemoryRouter>
        <CindyMakeSection />
      </MemoryRouter>,
    );
    await h.pushState({ source, upstreamMerge: merge });
    expect(screen.getByText('cindyMake.merge.status.conflict')).toBeTruthy();
    expect(h.api.cindyMakeMerge).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'cindyMake.merge.getLatest' }).hasAttribute('disabled'),
    ).toBe(true);
    h.api.cindyMakeMerge.mockResolvedValue({
      ...merge,
      status: 'resolving',
      sessionId: 'merge-task',
    });
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.merge.resolve' }));
    await waitFor(() =>
      expect(h.api.cindyMakeMerge).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'resolve' }),
      ),
    );
  });
  it.each(['resolving', 'failed'] as const)(
    'keeps a %s upstream task outside the unfinished production list',
    async (status) => {
      const h = harness();
      const merge: CindyMakeMergeState = {
        id: 'abcd-merge',
        status,
        ref: 'main',
        upstreamCommit: 'a'.repeat(40),
        hasWorkspace: true,
        sessionId: 'merge-task',
      };
      h.api.getCindyMakeState.mockResolvedValue({ upstreamMerge: merge });
      renderVersions(
        <MemoryRouter>
          <CindyMakeSection />
        </MemoryRouter>,
      );
      expect(await screen.findByRole('button', { name: 'cindyMake.merge.openTask' })).toBeTruthy();
      fireEvent.click(screen.getByRole('tab', { name: 'settings.cindyMake.tabs.versions' }));
      expect(screen.getByRole('heading', { name: 'cindyMake.history.title · 0' })).toBeTruthy();
      const report: MakeDoctorReport = {
        runId: 'make-run',
        platform: 'win32',
        arch: 'x64',
        status: 'completed',
        checks: [],
        task: {
          sessionId: 'make-task',
          title: 'Personal feature',
          request: 'A change',
          phase: 'completed',
        },
      };
      await h.pushState({ upstreamMerge: merge, tasks: { 'make-run': report } });
      const panel = screen.getByRole('region', { name: 'cindyMake.history.title' });
      expect(
        await within(panel).findByRole('heading', { name: 'cindyMake.history.title · 1' }),
      ).toBeTruthy();
      expect(within(panel).getByRole('button', { name: /Personal feature/ })).toBeTruthy();
      expect(within(panel).queryByText('cindyMake.merge.taskTitle')).toBeNull();
      expect(within(panel).queryByRole('button', { name: 'cindyMake.merge.openTask' })).toBeNull();
      expect(h.api.cindyMakeMerge).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'passed'] as const)(
    'shows the new %s check instead of a completed preparation from before entry',
    async (status) => {
      const environment = harness();
      const preparation: MakeDoctorReport = {
        runId: 'historical-preparation',
        mode: 'prepare',
        platform: 'win32',
        arch: 'x64',
        status: status === 'missing' ? 'completed' : 'failed',
        checks: [{ id: 'node', status: status === 'missing' ? 'passed' : 'missing' }],
      };
      await environment.pushState({ environmentPrepare: { active: false, report: preparation } });
      renderEnvironment(<CindyMakeSection />);
      const runId = environment.starts()[0][1].doctorRunId!;
      await environment.complete(runId, '', [{ id: 'node', status }]);
      await environment.pushState({
        environmentPrepare: { active: false, report: preparation },
        environmentCheck: {
          active: false,
          report: {
            ...preparation,
            runId,
            mode: 'check',
            status: 'completed',
            checks: [{ id: 'node', status }],
          },
        },
      });
      expect(screen.getByRole('status').textContent).toContain(
        status === 'missing' ? 'cindyMakeDoctor.needsAttention' : 'cindyMakeDoctor.passed',
      );
      expect(screen.queryByText('cindyMake.prepare.passed')).toBeNull();
      expect(screen.queryByText('cindyMake.prepare.failed')).toBeNull();
    },
  );

  it('restores a background installation after reentry, keeps completion, and stops the real run', async () => {
    const environment = harness();
    const first = renderEnvironment(<CindyMakeSection />);
    await environment.complete(environment.starts()[0][1].doctorRunId!, '', [
      { id: 'node', status: 'missing' },
    ]);
    fireEvent.click(screen.getByText('cindyMake.prepare.install'));
    const preparationId = environment.starts()[1][1].doctorRunId!;
    const preparation: MakeDoctorReport = {
      runId: preparationId,
      mode: 'prepare',
      platform: 'win32',
      arch: 'x64',
      status: 'running',
      checks: [
        { id: 'node', status: 'downloading', progress: { loaded: 42, total: 100, percent: 42 } },
      ],
    };
    await environment.pushState({ environmentPrepare: { active: true, report: preparation } });
    first.unmount();
    expect(environment.stateListeners.size).toBe(0);
    const second = renderEnvironment(<CindyMakeSection />);
    await screen.findByText('cindyMake.prepare.stop');
    const reentryCheckId = environment.starts()[2][1].doctorRunId!;
    await environment.complete(reentryCheckId, '', [{ id: 'node', status: 'missing' }]);
    expect(screen.queryByText('cindyMake.prepare.install')).toBeNull();
    fireEvent.click(screen.getByText('cindyMakeDoctor.details'));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    expect(environment.stateListeners.size).toBe(1);
    expect(
      environment.api.executeDesktopCommand.mock.calls.some(
        ([, ctx]) => ctx.doctorAction === 'cancel',
      ),
    ).toBe(false);
    fireEvent.click(screen.getByText('cindyMake.prepare.stop'));
    expect(environment.api.executeDesktopCommand).toHaveBeenLastCalledWith('cindy-make', {
      doctorRunId: preparationId,
      doctorAction: 'cancel',
    });
    await environment.pushState({
      environmentPrepare: {
        active: false,
        report: {
          ...preparation,
          status: 'completed',
          checks: [{ id: 'node', status: 'passed', version: '24.16.0' }],
        },
      },
    });
    expect(screen.getByRole('status').textContent).toContain('cindyMake.prepare.passed');
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.click(screen.getByText('cindyMake.prepare.retry'));
    await environment.complete(environment.starts()[3][1].doctorRunId!, '', [
      { id: 'node', status: 'missing' },
    ]);
    expect(screen.getByText('cindyMake.prepare.install')).toBeTruthy();
    expect(environment.starts().filter(([command]) => command === 'cindy-make')).toHaveLength(1);
    second.unmount();
    expect(environment.stateListeners.size).toBe(0);
    await environment.complete(preparationId, '24.16.0');
  });

  it('ignores a stale initial snapshot after newer preparation progress arrives', async () => {
    const environment = harness();
    let resolveSnapshot!: (state: CindyMakeGlobalState) => void;
    environment.api.getCindyMakeState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    renderEnvironment(<CindyMakeSection />);
    const preparation: MakeDoctorReport = {
      runId: 'new-preparation',
      mode: 'prepare',
      platform: 'win32',
      arch: 'x64',
      status: 'running',
      checks: [{ id: 'node', status: 'installing' }],
    };
    await environment.pushState({ environmentPrepare: { active: true, report: preparation } });
    await act(async () =>
      resolveSnapshot({
        environmentPrepare: {
          active: true,
          report: { ...preparation, runId: 'old-preparation' },
        },
      }),
    );
    fireEvent.click(screen.getByText('cindyMake.prepare.stop'));
    expect(environment.api.executeDesktopCommand).toHaveBeenLastCalledWith('cindy-make', {
      doctorRunId: 'new-preparation',
      doctorAction: 'cancel',
    });
  });

  it('keeps the fresh check when an unobserved preparation completes before a stale active snapshot', async () => {
    const environment = harness();
    let resolveSnapshot!: (state: CindyMakeGlobalState) => void;
    environment.api.getCindyMakeState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    renderEnvironment(<CindyMakeSection />);
    const preparation: MakeDoctorReport = {
      runId: 'finishing-preparation',
      mode: 'prepare',
      platform: 'win32',
      arch: 'x64',
      status: 'completed',
      checks: [{ id: 'node', status: 'passed', version: '24.16.0' }],
    };
    await environment.pushState({ environmentPrepare: { active: false, report: preparation } });
    await environment.complete(environment.starts()[0][1].doctorRunId!, '', [
      { id: 'node', status: 'missing' },
    ]);
    await act(async () =>
      resolveSnapshot({
        environmentPrepare: {
          active: true,
          report: {
            ...preparation,
            status: 'running',
            checks: [{ id: 'node', status: 'installing' }],
          },
        },
      }),
    );
    expect(screen.getByRole('status').textContent).toContain('cindyMakeDoctor.needsAttention');
    expect(screen.getByText('cindyMake.prepare.install')).toBeTruthy();
    expect(screen.queryByText('cindyMake.prepare.stop')).toBeNull();
  });

  it('does not let a delayed initial snapshot undo an explicit recheck', async () => {
    const environment = harness();
    let resolveSnapshot!: (state: CindyMakeGlobalState) => void;
    environment.api.getCindyMakeState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    renderEnvironment(<CindyMakeSection />);
    const preparation: MakeDoctorReport = {
      runId: 'completed-preparation',
      mode: 'prepare',
      platform: 'win32',
      arch: 'x64',
      status: 'running',
      checks: [{ id: 'node', status: 'installing' }],
    };
    await environment.pushState({ environmentPrepare: { active: true, report: preparation } });
    await environment.pushState({
      environmentPrepare: {
        active: false,
        report: {
          ...preparation,
          status: 'completed',
          checks: [{ id: 'node', status: 'passed' }],
        },
      },
    });
    fireEvent.click(screen.getByText('cindyMake.prepare.retry'));
    await act(async () =>
      resolveSnapshot({ environmentPrepare: { active: true, report: preparation } }),
    );
    await environment.complete(environment.starts()[1][1].doctorRunId!, '', [
      { id: 'node', status: 'missing' },
    ]);
    expect(screen.getByText('cindyMake.prepare.install')).toBeTruthy();
    expect(screen.queryByText('cindyMake.prepare.retry')).toBeNull();
  });

  it('keeps the versions tab focused on existing versions without a creation entry', async () => {
    const environment = harness();
    renderEnvironment(
      <MemoryRouter>
        <CindyMakeSection />
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'settings.cindyMake.tabs.versions' }));
    });
    expect(screen.queryByRole('button', { name: 'settings.cindyMake.create.title' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(environment.starts()).toHaveLength(1);
    expect(environment.starts()[0][0]).toBe('cindy-make-doctor');
  });

  it('checks on each entry without creating a task or starting preparation, and allows recheck after all passed', async () => {
    const h = harness();
    const first = renderEnvironment(<CindyMakeSection />);
    expect(h.starts()).toHaveLength(1);
    expect(h.starts()[0][0]).toBe('cindy-make-doctor');
    await h.complete(h.starts()[0][1].doctorRunId!, '22.23.2');
    const environmentCard = screen.getByRole('region', { name: 'cindyMakeDoctor.title' });
    const status = within(environmentCard).getByRole('status');
    const footer = status.parentElement!;
    expect(status.textContent).toContain('cindyMakeDoctor.passed');
    expect(
      footer.contains(within(environmentCard).getByText('settings.cindyMake.openToolsDir')),
    ).toBe(true);
    expect(footer.contains(within(environmentCard).getByText('cindyMakeDoctor.recheck'))).toBe(
      true,
    );
    fireEvent.click(screen.getByText('cindyMakeDoctor.recheck'));
    expect(h.starts()).toHaveLength(2);
    first.unmount();
    renderEnvironment(<CindyMakeSection />);
    expect(h.starts()).toHaveLength(3);
    expect(h.starts().every(([name]) => name === 'cindy-make-doctor')).toBe(true);
  });

  it('opens Cindy’s managed tools folder from the section header', async () => {
    const h = harness();
    renderEnvironment(<CindyMakeSection />);
    await h.complete(h.starts()[0][1].doctorRunId!, '22.23.2');
    fireEvent.click(screen.getByText('settings.cindyMake.openToolsDir'));
    expect(h.api.openCindyMakeToolsDir).toHaveBeenCalledTimes(1);
  });

  it('shows the persisted source summary and opens its managed folder', async () => {
    const h = harness();
    const source: MakeSourceStatus = {
      status: 'ready',
      path: 'C:\\Users\\test\\cindy-make\\source',
      channel: 'dev',
      version: '0.0.0-dev',
      ref: 'main',
      commit: '0123456789abcdef',
      branch: 'cindy-personal',
      currentBranch: 'main',
      baseCommit: 'b'.repeat(40),
      mainCommit: 'c'.repeat(40),
      mainRemoteCommit: 'd'.repeat(40),
      mainBehind: 3,
      mainAhead: 0,
      latestVersion: {
        status: 'ready',
        channel: 'dev',
        ref: 'main',
        commit: 'f'.repeat(40),
        ahead: 0,
        behind: 6,
      },
    };
    h.api.getCindyMakeSourceStatus = vi.fn(async () => source);
    h.api.openCindyMakeSourceDir = vi.fn(async () => ({ success: true }));
    vi.stubGlobal('electronAPI', {
      cindyMakeMerge: h.api.cindyMakeMerge,
      maker: h.api,
      getCindyMakeState: h.api.getCindyMakeState,
      onCindyMakeState: h.api.onCindyMakeState,
      openCindyMakeToolsDir: h.api.openCindyMakeToolsDir,
      getCindyMakeSourceStatus: h.api.getCindyMakeSourceStatus,
      openCindyMakeSourceDir: h.api.openCindyMakeSourceDir,
      onCindyMakeSourceStatus: h.api.onCindyMakeSourceStatus,
      cancelCindyMakeSource: h.api.cancelCindyMakeSource,
    });
    renderVersions(<CindyMakeSection />);
    await waitFor(() => expect(screen.getByText('c'.repeat(12))).toBeTruthy());
    const sourceCard = screen.getByRole('region', { name: 'settings.cindyMake.source.title' });
    expect(within(sourceCard).getByText('0123456789ab')).toBeTruthy();
    expect(within(sourceCard).getByText(source.path)).toBeTruthy();
    expect(within(sourceCard).queryByText(source.baseCommit!.slice(0, 12))).toBeNull();
    const openButton = within(sourceCard).getByRole('button', {
      name: 'settings.cindyMake.source.openDir',
    });
    fireEvent.click(openButton);
    expect(h.api.openCindyMakeSourceDir).toHaveBeenCalledTimes(1);
    expect(
      within(sourceCard).queryByRole('button', { name: 'cindyMake.overview.details' }),
    ).toBeNull();
    expect(within(sourceCard).queryByText(source.baseCommit!.slice(0, 12))).toBeNull();
    await h.pushSource({ ...source, currentBranch: 'feature/next', mainCommit: 'e'.repeat(40) });
    expect(within(sourceCard).getByText(source.path)).toBeTruthy();
    expect(within(sourceCard).queryByText('feature/next')).toBeNull();
    expect(within(sourceCard).getByText('e'.repeat(12))).toBeTruthy();
    expect(
      within(sourceCard).getByRole('button', { name: 'cindyMake.merge.getLatest' }),
    ).toBeTruthy();
    expect(
      within(sourceCard).getByRole('button', { name: 'settings.cindyMake.source.reset' }),
    ).toBeTruthy();
  });

  it.each(['waiting', 'checkingRemote', 'checkingLocal', 'cloning', 'installing'] as const)(
    'shows a source job %s elsewhere and stops it from Settings',
    async (phase) => {
      const h = harness();
      h.api.getCindyMakeSourceStatus.mockResolvedValue({
        status: 'preparing',
        path: 'C:\\managed\\source',
        ref: 'main',
        phase,
      });
      renderVersions(<CindyMakeSection />);
      const sourceCard = await screen.findByRole('region', {
        name: 'settings.cindyMake.source.title',
      });
      expect(
        within(sourceCard).getByText(new RegExp('cindyMake.source.phase.' + phase)),
      ).toBeTruthy();
      expect(within(sourceCard).queryByText('settings.cindyMake.source.prepare')).toBeNull();
      expect(
        within(sourceCard).queryByRole('button', { name: 'settings.cindyMake.source.reset' }),
      ).toBeNull();
      fireEvent.click(within(sourceCard).getByText('settings.cindyMake.source.stop'));
      expect(h.api.cancelCindyMakeSource).toHaveBeenCalledTimes(1);
      // Settings itself never started a doctor run for this job.
      expect(h.starts().filter(([name]) => name === 'cindy-make')).toHaveLength(0);
      await h.pushSource({ status: 'cancelled', path: 'C:\\managed\\source', error: 'cancelled' });
      expect(within(sourceCard).getByText('settings.cindyMake.source.retry')).toBeTruthy();
      expect(
        within(sourceCard).getByRole('button', { name: 'settings.cindyMake.source.reset' }),
      ).toBeTruthy();
    },
  );

  it.each([
    ['failed', 'installFailed'],
    ['cancelled', 'cancelled'],
  ] as const)(
    'keeps a restored %s result visible when collapsed, until retry starts',
    async (status, error) => {
      const h = harness();
      const source: MakeSourceStatus = {
        status,
        error,
        path: '/managed/source',
        phase: 'caching',
        dependencies: { resolved: 21, reused: 12, downloaded: 9, added: 0 },
      };
      h.api.getCindyMakeSourceStatus.mockResolvedValue(source);
      renderVersions(<CindyMakeSection />);
      const sourceCard = await screen.findByRole('region', {
        name: 'settings.cindyMake.source.title',
      });
      expect(within(sourceCard).getByRole('status').textContent).toContain(
        'settings.cindyMake.source.status.' + status,
      );
      expect(within(sourceCard).getByRole('status').textContent).toContain(
        'cindyMake.source.errors.' + error,
      );
      fireEvent.click(within(sourceCard).getByText('settings.cindyMake.source.retry'));
      expect(within(sourceCard).getByRole('status').textContent).toBe(
        'settings.cindyMake.source.status.preparing',
      );
      await h.pushSource({ status: 'preparing', path: source.path, phase: 'checkingRemote' });
      expect(within(sourceCard).getByRole('status').textContent).toContain(
        'cindyMake.source.phase.checkingRemote',
      );
      expect(within(sourceCard).queryByText('cindyMake.source.errors.' + error)).toBeNull();
      const sourceReads = h.api.getCindyMakeSourceStatus.mock.calls.length;
      await h.pushSource({ status: 'ready', path: source.path });
      expect(h.api.getCindyMakeSourceStatus).toHaveBeenCalledTimes(sourceReads + 1);
      expect(within(sourceCard).getByRole('status').textContent).toBe(
        'cindyMake.overview.comparison.unknown',
      );
      expect(
        within(sourceCard).queryByRole('button', { name: 'cindyMake.merge.getLatest' }),
      ).toBeTruthy();
      expect(within(sourceCard).getByText(source.path)).toBeTruthy();
      expect(
        within(sourceCard).getByRole('button', { name: 'cindyMake.merge.getLatest' }),
      ).toBeTruthy();
    },
  );

  it('keeps the clear action for a failed checkout so a dirty tree has a way out', async () => {
    const h = harness();
    const source: MakeSourceStatus = {
      status: 'failed',
      path: 'C:\\Users\\test\\cindy-make\\source',
      channel: 'dev',
      version: '0.0.0-dev',
      ref: 'main',
      error: 'dirty',
    };
    h.api.getCindyMakeSourceStatus = vi.fn(async () => source);
    vi.stubGlobal('electronAPI', {
      cindyMakeMerge: h.api.cindyMakeMerge,
      maker: h.api,
      getCindyMakeState: h.api.getCindyMakeState,
      onCindyMakeState: h.api.onCindyMakeState,
      openCindyMakeToolsDir: h.api.openCindyMakeToolsDir,
      getCindyMakeSourceStatus: h.api.getCindyMakeSourceStatus,
      openCindyMakeSourceDir: vi.fn(async () => ({ success: true })),
      onCindyMakeSourceStatus: h.api.onCindyMakeSourceStatus,
      cancelCindyMakeSource: h.api.cancelCindyMakeSource,
    });
    renderVersions(<CindyMakeSection />);
    await waitFor(() => expect(screen.getByText('cindyMake.source.errors.dirty')).toBeTruthy());
    const sourceCard = screen.getByRole('region', { name: 'settings.cindyMake.source.title' });
    expect(
      within(sourceCard).getByRole('button', { name: 'settings.cindyMake.source.reset' }),
    ).toBeTruthy();
  });

  it('prepares missing source and updates an existing source through the shared Make action', async () => {
    const h = harness();
    const source: MakeSourceStatus = {
      status: 'missing',
      path: 'C:\\Users\\test\\cindy-make\\source',
    };
    h.api.getCindyMakeSourceStatus = vi.fn(async () => source);
    vi.stubGlobal('electronAPI', {
      cindyMakeMerge: h.api.cindyMakeMerge,
      maker: h.api,
      getCindyMakeState: h.api.getCindyMakeState,
      onCindyMakeState: h.api.onCindyMakeState,
      openCindyMakeToolsDir: h.api.openCindyMakeToolsDir,
      getCindyMakeSourceStatus: h.api.getCindyMakeSourceStatus,
      openCindyMakeSourceDir: h.api.openCindyMakeSourceDir,
      onCindyMakeSourceStatus: h.api.onCindyMakeSourceStatus,
      cancelCindyMakeSource: h.api.cancelCindyMakeSource,
    });
    renderVersions(<CindyMakeSection />);
    await waitFor(() => expect(screen.getByText('settings.cindyMake.source.prepare')).toBeTruthy());
    fireEvent.click(screen.getByText('settings.cindyMake.source.prepare'));
    expect(screen.getByText('settings.cindyMake.source.stop')).toBeTruthy();
    expect(h.starts()).toHaveLength(2);
    expect(h.starts()[1][0]).toBe('cindy-make');
    expect(h.starts()[1][1].makeAction).toBe('prepare-source');

    cleanup();
    const ready: MakeSourceStatus = { ...source, status: 'ready', commit: '0123456789abcdef' };
    h.api.getCindyMakeSourceStatus = vi.fn(async () => ready);
    vi.stubGlobal('electronAPI', {
      cindyMakeMerge: h.api.cindyMakeMerge,
      maker: h.api,
      getCindyMakeState: h.api.getCindyMakeState,
      onCindyMakeState: h.api.onCindyMakeState,
      openCindyMakeToolsDir: h.api.openCindyMakeToolsDir,
      getCindyMakeSourceStatus: h.api.getCindyMakeSourceStatus,
      openCindyMakeSourceDir: h.api.openCindyMakeSourceDir,
      onCindyMakeSourceStatus: h.api.onCindyMakeSourceStatus,
      cancelCindyMakeSource: h.api.cancelCindyMakeSource,
    });
    renderVersions(<CindyMakeSection />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'cindyMake.merge.getLatest' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.merge.getLatest' }));
    await waitFor(() =>
      expect(h.api.cindyMakeMerge).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'update' }),
      ),
    );
    expect(h.starts()).toHaveLength(3);
  });

  it('confirms and starts clearing the source without re-pulling it', async () => {
    const h = harness();
    const source: MakeSourceStatus = {
      status: 'ready',
      path: 'C:\\Users\\test\\cindy-make\\source',
      channel: 'dev',
      ref: 'main',
      commit: '0123456789abcdef',
    };
    h.api.getCindyMakeSourceStatus = vi.fn(async () => source);
    vi.stubGlobal('electronAPI', {
      cindyMakeMerge: h.api.cindyMakeMerge,
      maker: h.api,
      getCindyMakeState: h.api.getCindyMakeState,
      onCindyMakeState: h.api.onCindyMakeState,
      openCindyMakeToolsDir: h.api.openCindyMakeToolsDir,
      getCindyMakeSourceStatus: h.api.getCindyMakeSourceStatus,
      openCindyMakeSourceDir: h.api.openCindyMakeSourceDir,
      onCindyMakeSourceStatus: h.api.onCindyMakeSourceStatus,
      cancelCindyMakeSource: h.api.cancelCindyMakeSource,
    });
    renderVersions(<CindyMakeSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.cindyMake.source.reset' }));
    await waitFor(() => expect(h.starts()).toHaveLength(2));
    expect(h.starts()[1][0]).toBe('cindy-make');
    expect(h.starts()[1][1].makeAction).toBe('clear-source');
  });

  it('keeps environment results while the source card progresses, fails and retries', async () => {
    const h = harness();
    const source: MakeSourceStatus = { status: 'ready', path: 'C:\\managed\\source', ref: 'main' };
    h.api.getCindyMakeSourceStatus.mockResolvedValue(source);
    renderEnvironment(<CindyMakeSection />);
    await h.complete(h.starts()[0][1].doctorRunId!, '22.23.2', [
      { id: 'node', status: 'passed', version: '22.23.2' },
      { id: 'native', status: 'missing' },
    ]);
    const environmentCard = screen.getByRole('region', { name: 'cindyMakeDoctor.title' });
    const previousEnvironment = environmentCard.textContent;
    fireEvent.click(screen.getByRole('tab', { name: 'settings.cindyMake.tabs.versions' }));
    const sourceCard = screen.getByRole('region', { name: 'settings.cindyMake.source.title' });
    fireEvent.click(within(sourceCard).getByRole('button', { name: 'cindyMake.merge.getLatest' }));
    expect(within(sourceCard).getByText('settings.cindyMake.source.path')).toBeTruthy();
    expect(environmentCard.textContent).toBe(previousEnvironment);
    await h.pushSource({
      ...source,
      status: 'preparing',
      phase: 'fetching',
      progress: { stage: 'receiving', percent: 43 },
    });
    expect(within(sourceCard).queryByRole('progressbar')).toBeNull();
    expect(within(sourceCard).getByText('cindyMake.source.gitProgress.receiving')).toBeTruthy();
    expect(within(sourceCard).getByText(/cindyMake.source.phase.fetching/)).toBeTruthy();
    expect(within(sourceCard).getByRole('status').textContent).toContain('(43%)');
    await h.pushSource({
      ...source,
      status: 'preparing',
      phase: 'caching',
      dependencies: { resolved: 21, reused: 12, downloaded: 9, added: 0 },
    });
    expect(within(sourceCard).getByRole('status').textContent).toContain(
      'cindyMake.source.phase.caching',
    );
    expect(within(sourceCard).getByRole('status').textContent).toContain(
      'cindyMake.source.cacheProgress 21 / 12 / 9',
    );
    expect(within(sourceCard).queryByText('(43%)')).toBeNull();
    expect(within(sourceCard).queryByText('cindyMake.code.dependencyActivity.packages')).toBeNull();
    expect(environmentCard.textContent).toBe(previousEnvironment);
    await h.pushSource({ ...source, status: 'failed', error: 'gitUnavailable' });
    expect(within(sourceCard).getByText('cindyMake.source.errors.gitUnavailable')).toBeTruthy();
    expect(within(sourceCard).queryByRole('progressbar')).toBeNull();
    expect(environmentCard.textContent).toBe(previousEnvironment);
    fireEvent.click(within(sourceCard).getByText('settings.cindyMake.source.retry'));
    expect(within(sourceCard).queryByText('cindyMake.source.errors.gitUnavailable')).toBeNull();
    expect(h.starts()).toHaveLength(2);
    expect(
      h
        .starts()
        .slice(1)
        .every(([name, ctx]) => name === 'cindy-make' && ctx.makeAction === 'prepare-source'),
    ).toBe(true);
    expect(within(sourceCard).getByText('settings.cindyMake.source.stop')).toBeTruthy();
    expect(environmentCard.textContent).toBe(previousEnvironment);
  });

  it('does not cancel an initial environment check or restart source work when the environment is rechecked', async () => {
    const h = harness();
    h.api.getCindyMakeSourceStatus.mockResolvedValue({
      status: 'missing',
      path: 'C:\\managed\\source',
    });
    renderVersions(<CindyMakeSection />);
    await waitFor(() => expect(screen.getByText('settings.cindyMake.source.prepare')).toBeTruthy());
    fireEvent.click(screen.getByText('settings.cindyMake.source.prepare'));
    expect(h.starts()).toHaveLength(2);
    expect(
      h.api.executeDesktopCommand.mock.calls.some(([, ctx]) => ctx.doctorAction === 'cancel'),
    ).toBe(false);
    await h.complete(h.starts()[0][1].doctorRunId!, '22.23.2');
    expect(screen.getByText('settings.cindyMake.source.stop')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'settings.cindyMake.tabs.environment' }));
    expect(
      within(screen.getByRole('region', { name: 'cindyMakeDoctor.title' })).getByRole('status')
        .textContent,
    ).toContain('cindyMakeDoctor.passed');
    fireEvent.click(screen.getByText('cindyMakeDoctor.recheck'));
    expect(h.starts()).toHaveLength(3);
    expect(h.starts()[2][0]).toBe('cindy-make-doctor');
    fireEvent.click(screen.getByRole('tab', { name: 'settings.cindyMake.tabs.versions' }));
    expect(screen.getByText('settings.cindyMake.source.stop')).toBeTruthy();
    expect(
      h.api.executeDesktopCommand.mock.calls.some(([, ctx]) => ctx.doctorAction === 'cancel'),
    ).toBe(false);
  });

  it('does not restore a previously tracked completion after switching check modes back', async () => {
    const environment = harness();
    renderEnvironment(<CindyMakeSection />);
    await environment.complete(environment.starts()[0][1].doctorRunId!, '');
    const preparation: MakeDoctorReport = {
      runId: 'tracked-preparation',
      mode: 'prepare',
      platform: 'win32',
      arch: 'x64',
      status: 'running',
      checks: [{ id: 'node', status: 'installing' }],
    };
    await environment.pushState({ environmentPrepare: { active: true, report: preparation } });
    await environment.pushState({
      environmentPrepare: {
        active: false,
        report: { ...preparation, status: 'completed', checks: [{ id: 'node', status: 'passed' }] },
      },
    });
    expect(screen.getByRole('status').textContent).toContain('cindyMake.prepare.passed');
    fireEvent.click(screen.getByRole('switch'));
    await environment.complete(environment.starts()[1][1].doctorRunId!, '');
    fireEvent.click(screen.getByRole('switch'));
    await environment.complete(environment.starts()[2][1].doctorRunId!, '', [
      { id: 'node', status: 'missing' },
    ]);
    expect(screen.getByRole('status').textContent).toContain('cindyMakeDoctor.needsAttention');
    expect(screen.getByText('cindyMake.prepare.install')).toBeTruthy();
  });

  it('changing the switch leaves the old check running, ignores late results, and carries the option into the chat command', async () => {
    const h = harness();
    const view = renderEnvironment(<CindyMakeSection />);
    const oldRun = h.starts()[0][1].doctorRunId!;
    fireEvent.click(screen.getByRole('switch'));
    expect(
      h.api.executeDesktopCommand.mock.calls.some(([, ctx]) => ctx.doctorAction === 'cancel'),
    ).toBe(false);
    const latest = h.starts()[1][1];
    expect(latest.forceManagedTools).toBe(true);
    await h.complete(latest.doctorRunId!, '22.23.2', [
      { id: 'node', status: 'passed', version: '22.23.2' },
      { id: 'git', status: 'missing' },
    ]);
    await h.complete(oldRun, '18.0.0');
    fireEvent.click(screen.getByText('cindyMakeDoctor.details'));
    expect(screen.getByText('22.23.2')).toBeTruthy();
    expect(screen.queryByText('18.0.0')).toBeNull();
    fireEvent.click(screen.getByText('cindyMake.prepare.install'));
    expect(h.starts()).toHaveLength(3);
    expect(h.starts()[2][0]).toBe('cindy-make');
    expect(h.starts()[2][1].forceManagedTools).toBe(true);
    view.unmount();
    expect(h.listeners.size).toBe(0);
    const runId = startMakeDoctor(vi.fn(), h.api, 'cindy-make');
    expect(h.api.executeDesktopCommand).toHaveBeenLastCalledWith('cindy-make', {
      doctorRunId: runId,
      forceManagedTools: true,
    });
    await h.complete(runId, '22.23.2');
    setCindyMakeForceManagedTools(false);
    const normalRun = startMakeDoctor(vi.fn(), h.api, 'cindy-make');
    expect(h.api.executeDesktopCommand).toHaveBeenLastCalledWith('cindy-make', {
      doctorRunId: normalRun,
    });
    await h.complete(normalRun, '24.1.0');
  });

  it('leaving the page only removes its progress subscription and does not cancel the check', () => {
    const h = harness();
    const view = renderEnvironment(<CindyMakeSection />);
    const runId = h.starts()[0][1].doctorRunId;
    expect(h.listeners.size).toBe(1);
    view.unmount();
    expect(h.listeners.size).toBe(0);
    expect(h.api.executeDesktopCommand).not.toHaveBeenCalledWith('cindy-make-doctor', {
      doctorRunId: runId,
      doctorAction: 'cancel',
    });
  });

  it('keeps the environment page but hides and disables the test switch in production', () => {
    vi.stubEnv('DEV', false);
    setCindyMakeForceManagedTools(true);
    const h = harness();
    renderEnvironment(<CindyMakeSection />);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(h.starts()).toHaveLength(1);
    expect(h.starts()[0][1]).not.toHaveProperty('forceManagedTools');
  });
});
