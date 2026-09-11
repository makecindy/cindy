// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CindyMakeSection } from '../CindyMakeSection';
import { startMakeDoctor } from '@/lib/cindyMakeDoctor';
import { setCindyMakeForceManagedTools } from '@/lib/cindyMakeSettings';
import type { MakeDoctorReport, MakeSourceStatus } from '../../../../shared/cindyMakeDoctor';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({
    confirm: vi.fn(async () => true),
  }),
}));

type Api = Parameters<typeof startMakeDoctor>[1];
type Listener = Parameters<NonNullable<Api>['onDesktopCommandTriggered']>[0];
type Result = Awaited<ReturnType<NonNullable<Api>['executeDesktopCommand']>>;

function harness() {
  const listeners = new Set<Listener>();
  const sourceListeners = new Set<(status: MakeSourceStatus) => void>();
  const runs = new Map<string, (result: Result) => void>();
  const api = {
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
    maker: api,
    openCindyMakeToolsDir: api.openCindyMakeToolsDir,
    getCindyMakeSourceStatus: api.getCindyMakeSourceStatus,
    openCindyMakeSourceDir: api.openCindyMakeSourceDir,
    onCindyMakeSourceStatus: api.onCindyMakeSourceStatus,
    cancelCindyMakeSource: api.cancelCindyMakeSource,
  });
  const starts = () => api.executeDesktopCommand.mock.calls.filter(([, ctx]) => !ctx.doctorAction);
  /** Main's global source broadcast, whichever window or workflow drives the job. */
  const pushSource = async (status: MakeSourceStatus) => {
    await act(async () => {
      for (const listener of sourceListeners) listener(status);
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
  return { api, starts, complete, listeners, pushSource };
}

beforeEach(() => {
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
  it('checks on each entry without creating a task or starting preparation, and allows recheck after all passed', async () => {
    const h = harness();
    const first = render(<CindyMakeSection />);
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
    render(<CindyMakeSection />);
    expect(h.starts()).toHaveLength(3);
    expect(h.starts().every(([name]) => name === 'cindy-make-doctor')).toBe(true);
  });

  it('opens Cindy’s managed tools folder from the section header', async () => {
    const h = harness();
    render(<CindyMakeSection />);
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
    };
    h.api.getCindyMakeSourceStatus = vi.fn(async () => source);
    h.api.openCindyMakeSourceDir = vi.fn(async () => ({ success: true }));
    vi.stubGlobal('electronAPI', {
      maker: h.api,
      openCindyMakeToolsDir: h.api.openCindyMakeToolsDir,
      getCindyMakeSourceStatus: h.api.getCindyMakeSourceStatus,
      openCindyMakeSourceDir: h.api.openCindyMakeSourceDir,
      onCindyMakeSourceStatus: h.api.onCindyMakeSourceStatus,
      cancelCindyMakeSource: h.api.cancelCindyMakeSource,
    });
    render(<CindyMakeSection />);
    await waitFor(() => expect(screen.getByText('0123456789abcdef')).toBeTruthy());
    const sourceCard = screen.getByRole('region', { name: 'settings.cindyMake.source.title' });
    const statusLine = within(sourceCard).getByRole('status');
    const footer = statusLine.parentElement!;
    const openButton = within(sourceCard).getByText('settings.cindyMake.source.openDir');
    const updateButton = within(sourceCard).getByText('settings.cindyMake.source.update');
    const resetButton = within(sourceCard).getByText('settings.cindyMake.source.reset');
    expect(statusLine.textContent).toBe('settings.cindyMake.source.status.ready');
    expect(footer.contains(openButton)).toBe(true);
    expect(footer.contains(updateButton)).toBe(true);
    expect(footer.contains(resetButton)).toBe(true);

    fireEvent.click(
      within(sourceCard).getByRole('button', { name: 'settings.cindyMake.source.title' }),
    );
    expect(within(sourceCard).queryByText('0123456789abcdef')).toBeNull();
    expect(within(sourceCard).getByRole('status')).toBeTruthy();
    expect(within(sourceCard).getByText('settings.cindyMake.source.openDir')).toBeTruthy();

    fireEvent.click(openButton);
    expect(h.api.openCindyMakeSourceDir).toHaveBeenCalledTimes(1);
  });

  it('shows a source job started elsewhere and stops it from Settings', async () => {
    const h = harness();
    h.api.getCindyMakeSourceStatus.mockResolvedValue({
      status: 'preparing',
      path: 'C:\\managed\\source',
      ref: 'main',
      phase: 'cloning',
    });
    render(<CindyMakeSection />);
    const sourceCard = await screen.findByRole('region', {
      name: 'settings.cindyMake.source.title',
    });
    expect(within(sourceCard).getByText(/cindyMake.source.phase.cloning/)).toBeTruthy();
    expect(within(sourceCard).queryByText('settings.cindyMake.source.prepare')).toBeNull();
    expect(within(sourceCard).queryByText('settings.cindyMake.source.reset')).toBeNull();
    fireEvent.click(within(sourceCard).getByText('settings.cindyMake.source.stop'));
    expect(h.api.cancelCindyMakeSource).toHaveBeenCalledTimes(1);
    // Settings itself never started a doctor run for this job.
    expect(h.starts().filter(([name]) => name === 'cindy-make')).toHaveLength(0);
    await h.pushSource({ status: 'cancelled', path: 'C:\\managed\\source', error: 'cancelled' });
    expect(within(sourceCard).getByText('settings.cindyMake.source.prepare')).toBeTruthy();
    expect(within(sourceCard).getByText('settings.cindyMake.source.reset')).toBeTruthy();
  });

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
      maker: h.api,
      openCindyMakeToolsDir: h.api.openCindyMakeToolsDir,
      getCindyMakeSourceStatus: h.api.getCindyMakeSourceStatus,
      openCindyMakeSourceDir: vi.fn(async () => ({ success: true })),
      onCindyMakeSourceStatus: h.api.onCindyMakeSourceStatus,
      cancelCindyMakeSource: h.api.cancelCindyMakeSource,
    });
    render(<CindyMakeSection />);
    await waitFor(() => expect(screen.getByText('cindyMake.source.errors.dirty')).toBeTruthy());
    const sourceCard = screen.getByRole('region', { name: 'settings.cindyMake.source.title' });
    expect(within(sourceCard).getByText('settings.cindyMake.source.reset')).toBeTruthy();
  });

  it('prepares missing source and updates an existing source through the shared Make action', async () => {
    const h = harness();
    const source: MakeSourceStatus = {
      status: 'missing',
      path: 'C:\\Users\\test\\cindy-make\\source',
    };
    h.api.getCindyMakeSourceStatus = vi.fn(async () => source);
    vi.stubGlobal('electronAPI', {
      maker: h.api,
      openCindyMakeToolsDir: h.api.openCindyMakeToolsDir,
      getCindyMakeSourceStatus: h.api.getCindyMakeSourceStatus,
      openCindyMakeSourceDir: h.api.openCindyMakeSourceDir,
      onCindyMakeSourceStatus: h.api.onCindyMakeSourceStatus,
      cancelCindyMakeSource: h.api.cancelCindyMakeSource,
    });
    render(<CindyMakeSection />);
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
      maker: h.api,
      openCindyMakeToolsDir: h.api.openCindyMakeToolsDir,
      getCindyMakeSourceStatus: h.api.getCindyMakeSourceStatus,
      openCindyMakeSourceDir: h.api.openCindyMakeSourceDir,
      onCindyMakeSourceStatus: h.api.onCindyMakeSourceStatus,
      cancelCindyMakeSource: h.api.cancelCindyMakeSource,
    });
    render(<CindyMakeSection />);
    await waitFor(() => expect(screen.getByText('settings.cindyMake.source.update')).toBeTruthy());
    fireEvent.click(screen.getByText('settings.cindyMake.source.update'));
    expect(h.starts()).toHaveLength(4);
    expect(h.starts()[3][0]).toBe('cindy-make');
    expect(h.starts()[3][1].makeAction).toBe('prepare-source');
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
      maker: h.api,
      openCindyMakeToolsDir: h.api.openCindyMakeToolsDir,
      getCindyMakeSourceStatus: h.api.getCindyMakeSourceStatus,
      openCindyMakeSourceDir: h.api.openCindyMakeSourceDir,
      onCindyMakeSourceStatus: h.api.onCindyMakeSourceStatus,
      cancelCindyMakeSource: h.api.cancelCindyMakeSource,
    });
    render(<CindyMakeSection />);
    await waitFor(() => expect(screen.getByText('settings.cindyMake.source.reset')).toBeTruthy());
    fireEvent.click(screen.getByText('settings.cindyMake.source.reset'));
    await waitFor(() => expect(h.starts()).toHaveLength(2));
    expect(h.starts()[1][0]).toBe('cindy-make');
    expect(h.starts()[1][1].makeAction).toBe('clear-source');
  });

  it('keeps environment results while the source card progresses, fails and retries', async () => {
    const h = harness();
    const source: MakeSourceStatus = { status: 'ready', path: 'C:\\managed\\source', ref: 'main' };
    h.api.getCindyMakeSourceStatus.mockResolvedValue(source);
    render(<CindyMakeSection />);
    await h.complete(h.starts()[0][1].doctorRunId!, '22.23.2', [
      { id: 'node', status: 'passed', version: '22.23.2' },
      { id: 'native', status: 'missing' },
    ]);
    const environmentCard = screen.getByRole('region', { name: 'cindyMakeDoctor.title' });
    const previousEnvironment = environmentCard.textContent;
    const sourceCard = screen.getByRole('region', { name: 'settings.cindyMake.source.title' });
    fireEvent.click(within(sourceCard).getByText('settings.cindyMake.source.update'));
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
    expect(environmentCard.textContent).toBe(previousEnvironment);
    await h.pushSource({ ...source, status: 'failed', error: 'gitUnavailable' });
    expect(within(sourceCard).getByText('cindyMake.source.errors.gitUnavailable')).toBeTruthy();
    expect(within(sourceCard).queryByRole('progressbar')).toBeNull();
    expect(environmentCard.textContent).toBe(previousEnvironment);
    fireEvent.click(within(sourceCard).getByText('settings.cindyMake.source.prepare'));
    expect(h.starts()).toHaveLength(3);
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
    render(<CindyMakeSection />);
    await waitFor(() => expect(screen.getByText('settings.cindyMake.source.prepare')).toBeTruthy());
    fireEvent.click(screen.getByText('settings.cindyMake.source.prepare'));
    expect(h.starts()).toHaveLength(2);
    expect(
      h.api.executeDesktopCommand.mock.calls.some(([, ctx]) => ctx.doctorAction === 'cancel'),
    ).toBe(false);
    await h.complete(h.starts()[0][1].doctorRunId!, '22.23.2');
    expect(
      within(screen.getByRole('region', { name: 'cindyMakeDoctor.title' })).getByRole('status')
        .textContent,
    ).toContain('cindyMakeDoctor.passed');
    expect(screen.getByText('settings.cindyMake.source.stop')).toBeTruthy();
    fireEvent.click(screen.getByText('cindyMakeDoctor.recheck'));
    expect(h.starts()).toHaveLength(3);
    expect(h.starts()[2][0]).toBe('cindy-make-doctor');
    expect(
      h.api.executeDesktopCommand.mock.calls.some(([, ctx]) => ctx.doctorAction === 'cancel'),
    ).toBe(false);
  });

  it('changing the switch cancels the old check, ignores late results, and carries the option into the chat command', async () => {
    const h = harness();
    const view = render(<CindyMakeSection />);
    const oldRun = h.starts()[0][1].doctorRunId!;
    fireEvent.click(screen.getByRole('switch'));
    expect(h.api.executeDesktopCommand).toHaveBeenCalledWith('cindy-make-doctor', {
      doctorRunId: oldRun,
      doctorAction: 'cancel',
    });
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

  it('leaving the page cancels only its own check and removes the progress subscription immediately', () => {
    const h = harness();
    const view = render(<CindyMakeSection />);
    const runId = h.starts()[0][1].doctorRunId;
    expect(h.listeners.size).toBe(1);
    view.unmount();
    expect(h.listeners.size).toBe(0);
    expect(h.api.executeDesktopCommand).toHaveBeenLastCalledWith('cindy-make-doctor', {
      doctorRunId: runId,
      doctorAction: 'cancel',
    });
  });

  it('keeps the environment page but hides and disables the test switch in production', () => {
    vi.stubEnv('DEV', false);
    setCindyMakeForceManagedTools(true);
    const h = harness();
    render(<CindyMakeSection />);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(h.starts()).toHaveLength(1);
    expect(h.starts()[0][1]).not.toHaveProperty('forceManagedTools');
  });
});
