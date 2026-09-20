// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';
import type {
  CindyMakeHistoryItem,
  CindyMakeHistoryState,
} from '../../../../shared/cindyMakeHistory';
import { CindyMakeHistoryPanel } from '../CindyMakeHistoryPanel';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  confirm: vi.fn<(options: ConfirmOptions) => Promise<boolean>>(async () => true),
  get: vi.fn(),
  restore: vi.fn(),
  prepend: vi.fn(),
  error: vi.fn(),
  make: {},
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));
vi.mock('@/lib/sessionService', () => ({ get: h.get, restoreIfArchived: h.restore }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { prependCreated: h.prepend } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/cindyMakeState', () => ({ useCindyMakeState: () => h.make }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: h.error } }));
function item(patch: Partial<CindyMakeHistoryItem> = {}): CindyMakeHistoryItem {
  return {
    schema: 1,
    runId: 'aaaa',
    sessionId: 'task-a',
    title: 'Blue background',
    request: 'Make the background blue',
    createdAt: 1,
    updatedAt: 2,
    completions: [],
    receipts: [],
    versions: [],
    lifecycle: 'ready',
    integration: 'unintegrated',
    actions: ['open', 'continue', 'test', 'integrate', 'end'],
    canHide: true,
    ...patch,
  };
}
function harness(items = [item()]) {
  let state: CindyMakeHistoryState = { items, busy: false, canBuild: true };
  const read = vi.fn(async () => state);
  const execute = vi.fn(async () => state);
  const build = vi.fn(async () => state);
  const cancel = vi.fn(async () => state);
  let onMessage: (() => void) | undefined;
  const unsubscribe = vi.fn();
  vi.stubGlobal('electronAPI', {
    getCindyMakeHistory: read,
    actCindyMakeHistory: execute,
    generateCindyMakePersonal: build,
    cancelCindyMakePersonal: cancel,
    localDb: {
      messages: {
        onCreated: (callback: () => void) => {
          onMessage = callback;
          return unsubscribe;
        },
      },
    },
  });
  return {
    read,
    execute,
    build,
    cancel,
    changed: () =>
      (onMessage as any)?.({
        sessionId: items[0]?.sessionId,
        message: { agentMeta: { cindyMakeCompletion: {} } },
      }),
    unsubscribe,
    set: (next: CindyMakeHistoryState) => {
      state = next;
    },
  };
}
beforeEach(() => {
  setDataOwnerGeneration('history-ui-owner');
  vi.clearAllMocks();
  h.get.mockResolvedValue({
    id: 'task-a',
    status: 'active',
    workingDir: '/make/task-a',
    workspaceKind: 'project',
    remoteHostId: null,
  });
  h.restore.mockResolvedValue({
    id: 'task-a',
    status: 'active',
    workingDir: '/make/task-a',
    workspaceKind: 'project',
    remoteHostId: null,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('Make history controls', () => {
  it('shares test failure, retry, live progress and exit state with the completion broadcast', async () => {
    const failed = item({ test: { status: 'failed', step: 'launching', error: 'launchFailed' } });
    const f = harness([failed]);
    const view = render(<CindyMakeHistoryPanel />);
    const retry = await screen.findByRole('button', { name: 'cindyMake.test.retry' });
    expect(screen.getByRole('alert').textContent).toBe('cindyMake.test.errors.launchFailed');
    expect(screen.getByText('cindyMake.test.failedStep')).toBeTruthy();
    expect(screen.queryByText('cindyMake.history.lifecycle.ready')).toBeNull();
    const starting = item({
      test: { status: 'starting', step: 'dependencies' },
      actions: ['open'],
      canHide: false,
    });
    f.set({ items: [starting], busy: true, canBuild: false });
    fireEvent.click(retry);
    await screen.findByText('cindyMake.test.currentStep');
    expect(f.execute).toHaveBeenCalledWith('aaaa', 'test');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.history.actions.continue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.history.cleanTask' })).toBeNull();
    f.set({
      items: [item({ test: { status: 'ready' }, actions: ['open', 'continue'], canHide: false })],
      busy: true,
      canBuild: false,
    });
    act(() => f.changed());
    await screen.findByRole('button', { name: 'cindyMake.history.actions.continue' });
    expect(screen.queryByText('cindyMake.test.currentStep')).toBeNull();
    f.set({ items: [item({ test: { status: 'stopped' } })], busy: false, canBuild: true });
    act(() => f.changed());
    await screen.findByRole('button', { name: 'cindyMake.test.retry' });
    view.unmount();
    expect(f.unsubscribe).toHaveBeenCalled();
  });
  it('refreshes a task-triggered build through checking steps to failure and allows retry', async () => {
    const task = item({ integration: 'integrated', actions: ['open', 'build'], needsBuild: true });
    const f = harness([task]);
    render(<CindyMakeHistoryPanel />);
    const build = await screen.findByRole('button', { name: 'cindyMake.history.actions.build' });
    await waitFor(() => expect(build.hasAttribute('disabled')).toBe(false));
    f.set({
      items: [{ ...task, actions: ['open'] }],
      busy: true,
      canBuild: false,
      build: { status: 'checking', checkStep: 'dependencies', buildId: 'build-1' },
    });
    fireEvent.click(build);
    await screen.findByText('cindyMake.personal.checkStep.dependencies');
    const stop = screen.getByRole('button', { name: 'cindyMake.history.stop' });
    expect(stop.hasAttribute('disabled')).toBe(false);
    fireEvent.click(stop);
    await waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    for (const checkStep of ['tests', 'types'] as const) {
      f.set({ items: [], busy: true, canBuild: false, build: { status: 'checking', checkStep } });
      fireEvent(window, new Event('focus'));
      await screen.findByText('cindyMake.personal.checkStep.' + checkStep);
    }
    f.set({
      items: [task],
      busy: false,
      canBuild: true,
      build: { status: 'failed', error: 'checksFailed' },
    });
    fireEvent(window, new Event('focus'));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'cindyMake.personal.errors.checksFailed',
    );
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.history.actions.build' }));
    await waitFor(() => expect(f.build).toHaveBeenCalledTimes(2));
  });
  it('shows the actual task build stage while removing mutation controls', async () => {
    const building = item({
      operation: 'build',
      build: { status: 'packaging' },
      actions: ['open'],
    });
    const f = harness([building]);
    f.set({ items: [building], busy: true, canBuild: false });
    render(<CindyMakeHistoryPanel />);
    expect(await screen.findByText('cindyMake.history.buildStatus.packaging')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'cindyMake.history.build' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'cindyMake.history.actions.integrate' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.history.actions.end' })).toBeNull();
  });
  it('exposes retry generation from a failed ended record', async () => {
    const failed = item({
      lifecycle: 'ended',
      integration: 'integrated',
      build: { status: 'failed', error: 'checksFailed' },
      actions: ['build'],
    });
    const f = harness([failed]);
    render(<CindyMakeHistoryPanel />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'cindyMake.history.actions.retryBuild' }),
    );
    await waitFor(() => expect(f.build).toHaveBeenCalledOnce());
  });
  it('offers the verified installer fallback when the source cannot produce a managed switchable version', async () => {
    const f = harness([]);
    const open = vi.fn(async () => {});
    vi.stubGlobal('electronAPI', { ...window.electronAPI, openCindyMakeHistoryBuild: open });
    f.set({
      items: [],
      busy: false,
      canBuild: true,
      build: { status: 'ready', buildId: 'build', artifactName: 'Cindy.exe' },
    });
    render(<CindyMakeHistoryPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'cindyMake.history.openInstaller' }));
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(screen.getByText('cindyMake.history.buildStatus.installerReady')).toBeTruthy();
    expect(screen.queryByText('cindyMake.history.buildStatus.ready')).toBeNull();
  });
  it('shows only operations admitted for the selected record and changes them after integration', async () => {
    const f = harness();
    render(<CindyMakeHistoryPanel />);
    expect(screen.getByRole('combobox', { name: 'cindyMake.history.filterLabel' })).toBeTruthy();
    expect((await screen.findByRole('button', { name: /Blue background/ })).className).toContain(
      'settings-menu-bg-selected',
    );
    const integrate = await screen.findByRole('button', {
      name: 'cindyMake.history.actions.integrate',
    });
    f.set({
      items: [
        item({
          integration: 'integrated',
          actions: ['open', 'continue', 'test', 'build', 'end', 'revert'],
          canHide: true,
          needsBuild: true,
        }),
      ],
      busy: false,
      canBuild: true,
    });
    fireEvent.click(integrate);
    expect(f.execute).toHaveBeenCalledWith('aaaa', 'integrate');
    expect(
      await screen.findByRole('button', { name: 'cindyMake.history.actions.revert' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'cindyMake.history.actions.integrate' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.history.actions.reapply' })).toBeNull();
    expect(screen.getByRole('button', { name: 'cindyMake.history.actions.open' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'cindyMake.history.actions.test' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'cindyMake.history.actions.build' })).toBeTruthy();
    expect(screen.getAllByText(/cindyMake.history.versionPending/)).toHaveLength(2);
    expect(screen.getByText('cindyMake.history.needsBuild')).toBeTruthy();
  });
  it('hands off the selected completion only after Main accepts Continue Editing', async () => {
    const f = harness([item({ completionId: 'done-a' })]);
    render(<CindyMakeHistoryPanel />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'cindyMake.history.actions.continue' }),
    );
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith('/cc-agent/task-a', {
        state: { cindyMakeEditing: { sessionId: 'task-a', completionId: 'done-a' } },
      }),
    );
    expect(f.execute).toHaveBeenCalledWith('aaaa', 'continue');
  });
  it('opens an active task and keeps it available in the sidebar', async () => {
    const f = harness([item({ actions: ['open'] })]);
    render(<CindyMakeHistoryPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'cindyMake.history.actions.open' }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/cc-agent/task-a'));
    expect(h.get).toHaveBeenCalledWith('task-a');
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.prepend).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-a' }));
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('restores an archived task before navigating to it', async () => {
    const archived = {
      id: 'task-a',
      status: 'archived',
      workingDir: '/make/task-a',
      workspaceKind: 'project',
      remoteHostId: null,
    };
    h.get.mockResolvedValue(archived);
    let resolve!: (value: typeof archived & { status: 'active' }) => void;
    h.restore.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const f = harness([item({ actions: ['open'] })]);
    render(<CindyMakeHistoryPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'cindyMake.history.actions.open' }));
    await waitFor(() => expect(h.restore).toHaveBeenCalledWith('task-a', archived));
    expect(h.navigate).not.toHaveBeenCalled();
    await act(async () => resolve({ ...archived, status: 'active' }));
    expect(h.prepend).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-a', status: 'active' }),
    );
    expect(h.navigate).toHaveBeenCalledWith('/cc-agent/task-a');
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('retains finished history and exposes retained undo without edit, test, or repeated cleanup actions', async () => {
    harness([
      item({
        lifecycle: 'ended',
        integration: 'integrated',
        endedAt: 3,
        actions: ['open', 'revert'],
      }),
    ]);
    render(<CindyMakeHistoryPanel />);
    expect(
      await screen.findByRole('button', { name: 'cindyMake.history.actions.revert' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'cindyMake.history.title · 1' })).toBeTruthy();
    for (const action of ['end', 'test', 'continue', 'integrate'])
      expect(
        screen.queryByRole('button', { name: 'cindyMake.history.actions.' + action }),
      ).toBeNull();
    expect(screen.getByRole('button', { name: 'cindyMake.history.actions.open' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'cindyMake.history.cleanTask' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.history.actions.revert' }));
    await waitFor(() =>
      expect(h.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'cindyMake.history.revertConfirm' }),
      ),
    );
  });
  it('opens the dedicated resolution task and does not offer unrelated integration actions during a conflict', async () => {
    const f = harness([
      item({ conflict: true, resolutionSessionId: 'conflict-task', actions: ['open', 'resolve'] }),
    ]);
    render(<CindyMakeHistoryPanel />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'cindyMake.history.actions.resolve' }),
    );
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/cc-agent/conflict-task'));
    expect(f.execute).toHaveBeenCalledWith('aaaa', 'resolve');
    expect(screen.queryByRole('button', { name: 'cindyMake.history.actions.end' })).toBeNull();
  });
  it('keeps a cancelled cleanup confirmation from mutating or hiding the record', async () => {
    const f = harness();
    h.confirm.mockResolvedValueOnce(false);
    render(<CindyMakeHistoryPanel />);
    const clean = await screen.findByRole('button', { name: 'cindyMake.history.cleanTask' });
    await act(async () => fireEvent.click(clean));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledOnce());
    expect(f.execute).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'cindyMake.history.title · 1' })).toBeTruthy();
    const confirmation = h.confirm.mock.calls[0][0];
    expect(confirmation).toMatchObject({
      title: 'cindyMake.history.cleanTitle',
      description: 'cindyMake.history.cleanConfirm',
      confirmVariant: 'destructive',
      describeContent: true,
    });
    render(<>{confirmation.content}</>);
    expect(screen.getByText('cindyMake.history.cleanWorkspace')).toBeTruthy();
    expect(screen.getByText('cindyMake.history.cleanKeep')).toBeTruthy();
  });
  it.each([0, 1])(
    'refreshes after cleanup with %i remaining records and ignores an older read',
    async (remaining) => {
      const next = item({ runId: 'bbbb', sessionId: 'task-b', title: 'Next task' });
      const f = harness(remaining ? [item(), next] : [item()]);
      render(<CindyMakeHistoryPanel />);
      await screen.findByRole('button', { name: /Blue background/ });
      await waitFor(() => expect(f.read).toHaveBeenLastCalledWith('aaaa'));
      let staleRead!: (value: CindyMakeHistoryState) => void;
      f.read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            staleRead = resolve;
          }),
      );
      fireEvent(window, new Event('focus'));
      let cleaned!: (value: CindyMakeHistoryState) => void;
      f.execute.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            cleaned = resolve;
          }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'cindyMake.history.cleanTask' }));
      await waitFor(() => expect(f.execute).toHaveBeenCalledWith('aaaa', 'hide'));
      f.read.mockClear();
      const fresh: CindyMakeHistoryState = {
        items: remaining ? [next] : [],
        busy: false,
        canBuild: true,
      };
      f.set(fresh);
      await act(async () =>
        cleaned({ ...fresh, items: fresh.items.map((row) => ({ ...row, actions: ['open'] })) }),
      );
      await waitFor(() => expect(f.read).toHaveBeenLastCalledWith(remaining ? 'bbbb' : undefined));
      expect(screen.queryByRole('button', { name: /Blue background/ })).toBeNull();
      expect(
        screen.getByRole('heading', { name: 'cindyMake.history.title · ' + remaining }),
      ).toBeTruthy();
      if (remaining) {
        expect(screen.getByRole('button', { name: /Next task/ }).getAttribute('aria-pressed')).toBe(
          'true',
        );
        expect(
          await screen.findByRole('button', { name: 'cindyMake.history.actions.test' }),
        ).toBeTruthy();
      } else {
        expect(screen.getByText('settings.cindyMake.tasks.noResults')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'cindyMake.history.cleanTask' })).toBeNull();
      }
      await act(async () => staleRead({ items: [item()], busy: false, canBuild: true }));
      expect(screen.queryByRole('button', { name: /Blue background/ })).toBeNull();
    },
  );
  it('keeps a failed cleanup visible and refreshes its retry state', async () => {
    const f = harness();
    f.execute.mockImplementationOnce(async () => {
      f.set({
        items: [item({ lifecycle: 'cleanup', actions: ['open', 'retry-cleanup'] })],
        busy: false,
        canBuild: true,
      });
      throw Object.assign(new Error('[PRECONDITION_FAILED] cleanupFailed'), {
        code: 'PRECONDITION_FAILED',
      });
    });
    render(<CindyMakeHistoryPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'cindyMake.history.cleanTask' }));
    expect(
      await screen.findByRole('button', { name: 'cindyMake.history.actions.retry-cleanup' }),
    ).toBeTruthy();
    expect(h.error).toHaveBeenCalledWith('settings.cindyMake.tasks.errors.cleanupFailed');
    expect(screen.getByRole('button', { name: /Blue background/ })).toBeTruthy();
  });
  it('shows the busy cleanup reason returned by Main', async () => {
    const f = harness([item({ actions: ['open', 'end'], canHide: true })]);
    f.execute.mockRejectedValueOnce(
      Object.assign(new Error('[PRECONDITION_FAILED] busy'), { code: 'PRECONDITION_FAILED' }),
    );
    render(<CindyMakeHistoryPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'cindyMake.history.cleanTask' }));
    await waitFor(() =>
      expect(h.error).toHaveBeenCalledWith('settings.cindyMake.tasks.errors.busy'),
    );
    expect(screen.getByRole('button', { name: /Blue background/ })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'cindyMake.history.cleanTask' }).hasAttribute('disabled'),
    ).toBe(false);
  });
  it('keeps history cleanup visible for a busy record and reports busy immediately', async () => {
    const f = harness([item({ actions: ['open'], actionReason: 'busy', canHide: true })]);
    f.execute.mockRejectedValueOnce(
      Object.assign(new Error('[PRECONDITION_FAILED] busy'), { code: 'PRECONDITION_FAILED' }),
    );
    render(<CindyMakeHistoryPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'cindyMake.history.cleanTask' }));
    await waitFor(() =>
      expect(h.error).toHaveBeenCalledWith('settings.cindyMake.tasks.errors.busy'),
    );
  });
  it('renders a busy tip when the current task has no mutation action', async () => {
    harness([item({ lifecycle: 'running', actions: ['open'], actionReason: 'busy' })]);
    render(<CindyMakeHistoryPanel />);
    expect(await screen.findByText('cindyMake.history.noActions.busy')).toBeTruthy();
  });
  it('does not replace a switched owner’s history with an older in-flight result', async () => {
    const f = harness();
    let old!: (state: CindyMakeHistoryState) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    );
    const view = render(<CindyMakeHistoryPanel />);
    setDataOwnerGeneration('new-history-owner');
    f.set({ items: [item({ title: 'New owner record' })], busy: false, canBuild: true });
    view.rerender(<CindyMakeHistoryPanel />);
    await screen.findByRole('button', { name: /New owner record/ });
    await act(async () =>
      old({ items: [item({ title: 'Private previous owner' })], busy: false, canBuild: true }),
    );
    expect(screen.queryByText(/Private previous owner/)).toBeNull();
  });
});
