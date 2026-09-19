// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type {
  CindyMakeHistoryItem,
  CindyMakeHistoryState,
} from '../../../../shared/cindyMakeHistory';
import { CindyMakeHistoryPanel } from '../CindyMakeHistoryPanel';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  confirm: vi.fn(async () => true),
  error: vi.fn(),
  make: {},
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));
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
    actions: ['continue', 'test', 'integrate', 'end'],
    ...patch,
  };
}
function harness(items = [item()]) {
  let state: CindyMakeHistoryState = { items, busy: false, canBuild: true };
  const read = vi.fn(async () => state);
  const execute = vi.fn(async () => state);
  const build = vi.fn(async () => state);
  const cancel = vi.fn(async () => state);
  vi.stubGlobal('electronAPI', {
    getCindyMakeHistory: read,
    actCindyMakeHistory: execute,
    generateCindyMakePersonal: build,
    cancelCindyMakePersonal: cancel,
  });
  return {
    read,
    execute,
    build,
    cancel,
    set: (next: CindyMakeHistoryState) => {
      state = next;
    },
  };
}
beforeEach(() => {
  setDataOwnerGeneration('history-ui-owner');
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('Make history controls', () => {
  it('refreshes a long-running global build through checking steps to failure and allows retry', async () => {
    const f = harness([]);
    render(<CindyMakeHistoryPanel />);
    const build = await screen.findByRole('button', { name: 'cindyMake.history.build' });
    await waitFor(() => expect(build.hasAttribute('disabled')).toBe(false));
    f.set({
      items: [],
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
      items: [],
      busy: false,
      canBuild: true,
      build: { status: 'failed', error: 'checksFailed' },
    });
    fireEvent(window, new Event('focus'));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'cindyMake.personal.errors.checksFailed',
    );
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.history.build' }));
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
    expect(
      screen.getByRole('button', { name: 'cindyMake.history.build' }).hasAttribute('disabled'),
    ).toBe(true);
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
          actions: ['continue', 'test', 'end', 'revert'],
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
    expect(screen.queryByRole('button', { name: 'cindyMake.history.actions.open' })).toBeNull();
    expect(screen.getByText('cindyMake.history.needsBuild')).toBeTruthy();
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
    fireEvent.click(await screen.findByRole('button', { name: 'cindyMake.history.actions.end' }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledOnce());
    expect(f.execute).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'cindyMake.history.title · 1' })).toBeTruthy();
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
