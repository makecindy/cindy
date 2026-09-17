// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CindyMakeTaskCard } from '../CindyMakeTaskCard';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import type { MakeDoctorReport } from '../../../../shared/cindyMakeDoctor';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: unknown) => key + (values ? ' ' + JSON.stringify(values) : ''),
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.mocked(getStickySessionDeviceId).mockReset();
  vi.unstubAllGlobals();
});
const report: MakeDoctorReport = {
  runId: 'make-run',
  status: 'running',
  checks: [],
  platform: 'win32',
  arch: 'x64',
  task: {
    title: 'Cindy Make: scrolling',
    sessionId: 'created',
    originSessionId: 'origin',
    phase: 'dependencies',
    dependencies: { resolved: 10, reused: 3, downloaded: 7, added: 10 },
  },
};

describe('Cindy Make preparation card', () => {
  it.each(['running', 'failed', 'cancelled'] as const)(
    'keeps a read-only %s card visible without controls or local navigation',
    (status) => {
      render(
        <CindyMakeTaskCard
          report={{ ...report, status }}
          request="original request"
          onOpenTask={vi.fn()}
          readOnly
        />,
      );
      expect(screen.getByRole('status')).toBeTruthy();
      expect(screen.queryByRole('button')).toBeNull();
    },
  );
  it.each(['created', 'origin'])('keeps remotely owned %s tasks read-only', (remoteSession) => {
    vi.mocked(getStickySessionDeviceId).mockImplementation((sessionId) =>
      sessionId === remoteSession ? 'remote-device' : undefined,
    );
    render(<CindyMakeTaskCard report={report} request="original request" onOpenTask={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it.each(['running', 'failed'] as const)(
    'rechecks device ownership before a %s action or navigation',
    (status) => {
      const cancel = vi.fn();
      const start = vi.fn();
      const open = vi.fn();
      vi.stubGlobal('electronAPI', { cancelCindyMakeTask: cancel, startCindyMakeTask: start });
      render(
        <CindyMakeTaskCard
          report={{ ...report, status }}
          request="original request"
          onOpenTask={open}
        />,
      );
      vi.mocked(getStickySessionDeviceId).mockReturnValue('remote-device');
      fireEvent.click(
        screen.getByRole('button', {
          name: status === 'running' ? 'cindyMake.prepare.stop' : 'cindyMake.prepare.retry',
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'cindyMake.code.open' }));
      expect(cancel).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    },
  );
  it('shows all stages and real dependency counts without a fake overall percentage', () => {
    render(<CindyMakeTaskCard report={report} request="original request" />);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByRole('status').textContent).toBe('cindyMake.code.phases.dependencies');
    expect(screen.getByText(/dependencyProgress/).textContent).toContain('"downloaded":7');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
  it('shows startup and script activity even when no package counts have arrived', () => {
    const initial = { ...report, task: { ...report.task!, dependencies: undefined } };
    const view = render(<CindyMakeTaskCard report={initial} />);
    expect(screen.getByText(/dependencyActivity.starting/)).toBeTruthy();
    expect(screen.queryByText(/dependencyProgress/)).toBeNull();
    view.rerender(
      <CindyMakeTaskCard
        report={{ ...initial, task: { ...initial.task, dependencies: { activity: 'scripts' } } }}
      />,
    );
    expect(screen.getByText(/dependencyActivity.scripts/)).toBeTruthy();
    expect(screen.queryByText(/dependencyProgress/)).toBeNull();
  });
  it('uses Main to cancel and does not invent a completed or cancelled report', async () => {
    const cancel = vi.fn(async () => ({ success: true }));
    vi.stubGlobal('electronAPI', { cancelCindyMakeTask: cancel });
    render(<CindyMakeTaskCard report={report} request="original request" />);
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.prepare.stop' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('make-run'));
    expect(screen.getByRole('status').textContent).toBe('cindyMake.code.phases.dependencies');
  });
  it('retries the same task using the preserved request', async () => {
    const start = vi.fn(async () => 'created');
    vi.stubGlobal('electronAPI', { startCindyMakeTask: start });
    render(
      <CindyMakeTaskCard report={{ ...report, status: 'failed' }} request="original request" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.prepare.retry' }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        originSessionId: 'origin',
        runId: 'make-run',
        request: 'original request',
        title: report.task!.title,
      }),
    );
  });
  it('has no dispatch action and shows automatic start only after Main acknowledges it', () => {
    const view = render(<CindyMakeTaskCard report={report} request="original request" />);
    view.rerender(
      <CindyMakeTaskCard
        report={{ ...report, status: 'completed', task: { ...report.task!, phase: 'completed' } }}
        request="original request"
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('cindyMake.code.prepared');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
