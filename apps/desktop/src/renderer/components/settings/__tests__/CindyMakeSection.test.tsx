// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CindyMakeSection } from '../CindyMakeSection';
import { startMakeDoctor } from '@/lib/cindyMakeDoctor';
import { setCindyMakeForceManagedTools } from '@/lib/cindyMakeSettings';
import type { MakeDoctorReport } from '../../../../shared/cindyMakeDoctor';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

type Api = Parameters<typeof startMakeDoctor>[1];
type Listener = Parameters<NonNullable<Api>['onDesktopCommandTriggered']>[0];
type Result = Awaited<ReturnType<NonNullable<Api>['executeDesktopCommand']>>;

function harness() {
  const listeners = new Set<Listener>();
  const runs = new Map<string, (result: Result) => void>();
  const api = {
    openCindyMakeToolsDir: vi.fn(async () => ({ success: true })),
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
  vi.stubGlobal('electronAPI', { maker: api, openCindyMakeToolsDir: api.openCindyMakeToolsDir });
  const starts = () => api.executeDesktopCommand.mock.calls.filter(([, ctx]) => !ctx.doctorAction);
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
  return { api, starts, complete, listeners };
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
    expect(screen.getByText('22.23.2')).toBeTruthy();
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
