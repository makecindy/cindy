// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';
import type { SelectProps } from '@/components/ui/select';
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
  success: vi.fn(),
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
vi.mock('@/lib/toast', () => ({ toast: { error: h.error, success: h.success } }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ label, value, options, onValueChange, disabled }: SelectProps) => (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
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
    actions: ['open', 'continue', 'test', 'integrate', 'end', 'build'],
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
  let onMessage: ((event?: { sessionId?: string; message?: unknown }) => void) | undefined;
  let onHistoryChanged:
    | ((stamp?: { dataOwnerId: string | null; ownerGeneration: number }) => void)
    | undefined;
  const unsubscribe = vi.fn();
  const unsubscribeHistory = vi.fn();
  vi.stubGlobal('electronAPI', {
    getCindyMakeHistory: read,
    actCindyMakeHistory: execute,
    generateCindyMakePersonal: build,
    cancelCindyMakePersonal: cancel,
    onCindyMakeHistoryChanged: (callback: typeof onHistoryChanged) => {
      onHistoryChanged = callback;
      return unsubscribeHistory;
    },
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
      onMessage?.({
        sessionId: items[0]?.sessionId,
        message: { agentMeta: { cindyMakeCompletion: {} } },
      }),
    historyChanged: () => {
      const owner = getDataOwnerGeneration();
      onHistoryChanged?.({
        dataOwnerId: owner.dataOwnerId,
        ownerGeneration: owner.generation,
      });
    },
    unsubscribe,
    unsubscribeHistory,
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
  it('does not restore an old failed build banner when opening an empty history', async () => {
    const f = harness([]);
    f.set({
      items: [],
      busy: false,
      canBuild: true,
      build: { status: 'failed', error: 'checksFailed', buildId: 'old-build' },
    });
    render(<CindyMakeHistoryPanel hasPersonalVersion />);
    await screen.findByText('settings.cindyMake.tasks.noResults');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'cindyMake.history.regeneratePersonal' })).toBeTruthy();
    expect(h.error).not.toHaveBeenCalled();
  });
  it('keeps the old failure details on its task after reopening history', async () => {
    const failedBuild = {
      status: 'failed' as const,
      error: 'checksFailed' as const,
      buildId: 'old-build',
    };
    const f = harness();
    f.set({
      items: [item({ build: failedBuild })],
      busy: false,
      canBuild: true,
      build: failedBuild,
    });
    render(<CindyMakeHistoryPanel hasPersonalVersion />);
    expect(await screen.findByText('cindyMake.personal.errors.checksFailed')).toBeTruthy();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(h.error).not.toHaveBeenCalled();
  });
  it('shows one tip when a build finishes and does not repeat it on refresh', async () => {
    const f = harness([]);
    f.set({
      items: [],
      busy: true,
      canBuild: false,
      build: { status: 'packaging', buildId: 'build-1' },
    });
    render(<CindyMakeHistoryPanel />);
    await screen.findAllByText('cindyMake.personal.status.packaging');
    f.set({
      items: [],
      busy: false,
      canBuild: true,
      build: { status: 'ready', buildId: 'build-1' },
    });
    act(() => f.historyChanged());
    await waitFor(() =>
      expect(h.success).toHaveBeenCalledWith('cindyMake.personal.status.ready'),
    );
    act(() => f.historyChanged());
    await waitFor(() => expect(f.read).toHaveBeenCalledTimes(3));
    expect(h.success).toHaveBeenCalledTimes(1);
    f.set({
      items: [],
      busy: false,
      canBuild: true,
      build: { status: 'ready', buildId: 'build-2' },
    });
    act(() => f.historyChanged());
    await waitFor(() => expect(h.success).toHaveBeenCalledTimes(2));
  });
  it('shows the failure reason once when a build fails', async () => {
    const f = harness([]);
    f.set({
      items: [],
      busy: true,
      canBuild: false,
      build: { status: 'checking', buildId: 'build-1' },
    });
    render(<CindyMakeHistoryPanel />);
    await screen.findAllByText('cindyMake.personal.status.checking');
    f.set({
      items: [],
      busy: false,
      canBuild: true,
      build: { status: 'failed', error: 'checksFailed', buildId: 'build-1' },
    });
    act(() => f.historyChanged());
    await waitFor(() =>
      expect(h.error).toHaveBeenCalledWith('cindyMake.personal.errors.checksFailed'),
    );
    act(() => f.historyChanged());
    await waitFor(() => expect(f.read).toHaveBeenCalledTimes(3));
    expect(h.error).toHaveBeenCalledTimes(1);
    f.set({
      items: [],
      busy: false,
      canBuild: true,
      build: { status: 'failed', error: 'cleanupFailed', buildId: 'build-2' },
    });
    act(() => f.historyChanged());
    await waitFor(() => expect(h.error).toHaveBeenCalledWith('cindyMake.personal.errors.cleanupFailed'));
  });
  it('keeps the running test visible when its stop fails', async () => {
    const f = harness([item({ test: { status: 'ready' }, actions: ['continue'] })]);
    f.execute.mockRejectedValueOnce(new Error('[PRECONDITION_FAILED] stopFailed'));
    render(<CindyMakeHistoryPanel />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'cindyMake.history.actions.continue' }),
    );
    await waitFor(() => expect(h.error).toHaveBeenCalledWith('cindyMake.test.errors.stopFailed'));
    expect(h.navigate).not.toHaveBeenCalled();
    expect(screen.getAllByText('cindyMake.test.status.ready')).not.toHaveLength(0);
  });

  it('shows the prompt inside each round and removes the duplicate task request', async () => {
    const firstPrompt = 'Make the background blue';
    const f = harness([
      item({
        request: firstPrompt,
        completions: [
          { id: 'round-a', reportedAt: 1, prompt: firstPrompt },
          { id: 'round-b', reportedAt: 2, prompt: 'Make the background red' },
        ],
      }),
    ]);
    render(<CindyMakeHistoryPanel />);
    await screen.findByText('cindyMake.history.rounds');
    expect(screen.queryByRole('heading', { name: firstPrompt })).toBeNull();
    expect(screen.getAllByText(firstPrompt, { exact: true })).toHaveLength(1);
    expect(screen.getByText('Make the background red', { exact: true })).toBeTruthy();
    expect(f.read).toHaveBeenCalled();
  });

  it('keeps an explicit retry for a failed integration without presenting it as generation', async () => {
    const f = harness([item({ actions: ['open', 'retry'], operationError: 'checksFailed' })]);
    render(<CindyMakeHistoryPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'cindyMake.history.actions.retry' }));
    await waitFor(() => expect(f.execute).toHaveBeenCalledWith('aaaa', 'retry'));
    expect(screen.queryByRole('button', { name: 'cindyMake.history.actions.build' })).toBeNull();
  });
  it('shares test failure, retry, live progress and exit state with the completion broadcast', async () => {
    const failed = item({ test: { status: 'failed', step: 'launching', error: 'launchFailed' } });
    const f = harness([failed]);
    const view = render(<CindyMakeHistoryPanel />);
    const retry = await screen.findByRole('button', { name: 'cindyMake.test.start' });
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
    await screen.findByRole('button', { name: 'cindyMake.test.start' });
    view.unmount();
    expect(f.unsubscribe).toHaveBeenCalled();
    expect(f.unsubscribeHistory).toHaveBeenCalled();
  });
  it('refreshes a task-triggered build immediately through its terminal state', async () => {
    const task = item({ integration: 'integrated', actions: ['open'], needsBuild: true });
    const f = harness([task]);
    render(<CindyMakeHistoryPanel hasPersonalVersion />);
    await screen.findByRole('button', { name: 'cindyMake.history.regeneratePersonal' });
    f.set({
      items: [{ ...task, actions: ['open'] }],
      busy: true,
      canBuild: false,
      build: { status: 'checking', checkStep: 'dependencies', buildId: 'build-1' },
    });
    act(() => f.historyChanged());
    expect(await screen.findAllByText('cindyMake.personal.checkStep.dependencies')).toHaveLength(2);
    const stop = screen.getByRole('button', { name: 'cindyMake.history.stop' });
    expect(stop.hasAttribute('disabled')).toBe(false);
    fireEvent.click(stop);
    await waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    for (const checkStep of ['tests', 'types'] as const) {
      f.set({ items: [], busy: true, canBuild: false, build: { status: 'checking', checkStep } });
      fireEvent(window, new Event('focus'));
      expect(await screen.findAllByText('cindyMake.personal.checkStep.' + checkStep)).toHaveLength(
        2,
      );
    }
    f.set({
      items: [task],
      busy: false,
      canBuild: true,
      build: { status: 'failed', error: 'checksFailed' },
    });
    act(() => f.historyChanged());
    expect((await screen.findByRole('alert')).textContent).toBe(
      'cindyMake.personal.errors.checksFailedcindyMake.personal.diagnostic.unavailable',
    );
    expect(screen.queryByRole('button', { name: 'cindyMake.history.actions.build' })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'cindyMake.history.regeneratePersonal' }),
    );
    await waitFor(() => expect(f.build).toHaveBeenCalledWith());
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
    expect(await screen.findAllByText('cindyMake.personal.status.packaging')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'cindyMake.history.build' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'cindyMake.history.actions.integrate' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.history.actions.end' })).toBeNull();
  });
  it('does not attach personal-version generation to a failed ended record', async () => {
    const failed = item({
      lifecycle: 'ended',
      integration: 'integrated',
      build: { status: 'failed', error: 'checksFailed' },
      actions: ['build'],
    });
    const f = harness([failed]);
    render(<CindyMakeHistoryPanel hasPersonalVersion />);
    expect(
      await screen.findByRole('button', { name: 'cindyMake.history.regeneratePersonal' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'cindyMake.history.actions.build' })).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
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
  it('keeps regeneration global and exposes plain-language removal for an integrated task', async () => {
    const f = harness([
      item({
        integration: 'integrated',
        actions: ['open', 'continue', 'test', 'build', 'end', 'revert'],
        canHide: true,
        needsBuild: true,
        title: '[aaaa] Blue background',
        request: 'Blue background',
      }),
    ]);
    render(<CindyMakeHistoryPanel hasPersonalVersion />);
    expect(screen.getByRole('combobox', { name: 'cindyMake.history.filterLabel' })).toBeTruthy();
    expect((await screen.findByRole('button', { name: /Blue background/ })).className).toContain(
      'settings-menu-bg-selected',
    );
    expect(screen.queryByText('Blue background')).toBeNull();
    const remove = screen.getByRole('button', { name: 'cindyMake.history.actions.revert' });
    expect(
      screen.queryByRole('button', { name: 'cindyMake.history.actions.integrate' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.history.actions.reapply' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.history.actions.build' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.history.actions.open' })).toBeNull();
    expect(screen.getByRole('button', { name: 'cindyMake.history.actions.continue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'cindyMake.test.start' })).toBeTruthy();
    fireEvent.click(remove);
    await waitFor(() => expect(f.execute).toHaveBeenCalledWith('aaaa', 'revert'));
    expect(h.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'cindyMake.history.actions.revert',
        description: 'cindyMake.history.revertConfirm',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'cindyMake.history.regeneratePersonal' }),
    );
    await waitFor(() => expect(f.build).toHaveBeenCalledWith());
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
  it('keeps finished history removable, navigable and cleanable', async () => {
    const f = harness([
      item({
        lifecycle: 'ended',
        integration: 'integrated',
        endedAt: 3,
        actions: ['open', 'revert'],
      }),
    ]);
    render(<CindyMakeHistoryPanel />);
    await screen.findByRole('button', { name: 'cindyMake.history.actions.open' });
    expect(
      screen.getByRole('heading', {
        name: 'cindyMake.history.title · cindyMake.history.taskCount',
      }),
    ).toBeTruthy();
    for (const action of ['end', 'test', 'continue', 'integrate', 'reapply', 'build'])
      expect(
        screen.queryByRole('button', { name: 'cindyMake.history.actions.' + action }),
      ).toBeNull();
    expect(screen.getByRole('button', { name: 'cindyMake.history.actions.open' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.history.actions.revert' }));
    await waitFor(() => expect(f.execute).toHaveBeenCalledWith('aaaa', 'revert'));
    expect(screen.getByRole('button', { name: 'cindyMake.history.cleanTask' })).toBeTruthy();
  });
  it('offers adding a previously removed task back to the personal version', async () => {
    const f = harness([
      item({
        lifecycle: 'ended',
        integration: 'reverted',
        actions: ['open', 'reapply'],
      }),
    ]);
    render(<CindyMakeHistoryPanel />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'cindyMake.history.actions.reapply' }),
    );
    await waitFor(() => expect(f.execute).toHaveBeenCalledWith('aaaa', 'reapply'));
    expect(h.confirm).not.toHaveBeenCalled();
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
    expect(
      screen.getByRole('heading', {
        name: 'cindyMake.history.title · cindyMake.history.taskCount',
      }),
    ).toBeTruthy();
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
        screen.getByRole('heading', {
          name: 'cindyMake.history.title · cindyMake.history.taskCount',
        }),
      ).toBeTruthy();
      if (remaining) {
        expect(screen.getByRole('button', { name: /Next task/ }).getAttribute('aria-pressed')).toBe(
          'true',
        );
        expect(await screen.findByRole('button', { name: 'cindyMake.test.start' })).toBeTruthy();
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

function selectableItem(runId: string, createdAt: number) {
  return item({
    runId,
    createdAt,
    title: runId,
    sessionId: 'task-' + runId,
    canSelectForBuild: true,
    completionId: 'done-' + runId,
    completions: [
      { id: 'done-' + runId, reportedAt: createdAt, commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    ],
  });
}
async function beginSelection() {
  fireEvent.change(await screen.findByRole('combobox', { name: 'cindyMake.history.filterLabel' }), {
    target: { value: 'pending' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'cindyMake.history.batch.make' }));
}

describe('pending history selection', () => {
  it('selects multiple pending records and confirms the chronological list before one build', async () => {
    const newer = selectableItem('newer', 20);
    const older = selectableItem('older', 10);
    const f = harness([
      newer,
      older,
      item({ runId: 'busy', actions: ['open'] }),
      item({ runId: 'merged', integration: 'integrated' }),
    ]);
    render(<CindyMakeHistoryPanel />);
    await beginSelection();
    expect(
      screen
        .getByRole('button', { name: 'cindyMake.history.batch.selected' })
        .hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'cindyMake.history.batch.selectAll' }));
    const checks = screen.getAllByRole('checkbox', {
      name: 'cindyMake.history.batch.selectItem',
    }) as HTMLInputElement[];
    expect(checks.map((checkbox) => checkbox.checked)).toEqual([true, true, false]);
    expect(checks[2].disabled).toBe(true);
    // Multi-select can also remove and re-add one entry without losing the others.
    fireEvent.click(checks[0]);
    expect(checks[1].checked).toBe(true);
    fireEvent.click(checks[0]);
    let approve!: (accepted: boolean) => void;
    h.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.history.batch.selected' }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledOnce());
    expect(f.build).not.toHaveBeenCalled();
    const confirmation = h.confirm.mock.calls[0][0];
    expect(confirmation).toMatchObject({
      description: 'cindyMake.history.batch.confirmDescription',
    });
    const preview = render(<>{confirmation.content}</>);
    expect(preview.container.textContent!.indexOf('older')).toBeLessThan(
      preview.container.textContent!.indexOf('newer'),
    );
    preview.unmount();
    await act(async () => approve(true));
    expect(f.build).toHaveBeenCalledOnce();
    expect(f.build).toHaveBeenCalledWith(
      [older, newer].map((record) => ({
        runId: record.runId,
        completionId: record.completionId,
        commit: record.completions[0].commit,
        tree: record.completions[0].tree,
      })),
    );
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('keeps selections after cancelling the second dialog and does not build', async () => {
    const f = harness([selectableItem('one', 1)]);
    h.confirm.mockResolvedValueOnce(false);
    render(<CindyMakeHistoryPanel />);
    await beginSelection();
    fireEvent.click(screen.getByRole('checkbox', { name: 'cindyMake.history.batch.selectAll' }));
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.history.batch.selected' }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledOnce());
    expect(f.build).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'cindyMake.history.batch.selectItem',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });
  it("does not submit another owner's selections after confirmation", async () => {
    const f = harness([selectableItem('one', 1)]);
    let approve!: (accepted: boolean) => void;
    h.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    );
    render(<CindyMakeHistoryPanel />);
    await beginSelection();
    fireEvent.click(screen.getByRole('checkbox', { name: 'cindyMake.history.batch.selectAll' }));
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.history.batch.selected' }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledOnce());
    setDataOwnerGeneration('other-history-owner');
    await act(async () => approve(true));
    expect(f.build).not.toHaveBeenCalled();
  });
  it('offers restart for the selected running isolated version', async () => {
    const f = harness([
      item({ test: { status: 'ready' }, actions: ['test', 'continue', 'build'] }),
    ]);
    render(<CindyMakeHistoryPanel />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'cindyMake.history.batch.restartTest' }),
    );
    await waitFor(() => expect(f.execute).toHaveBeenCalledWith('aaaa', 'test'));
  });
});
