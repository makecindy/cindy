// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CindyMakeComposerMask } from '../CindyMakeComposerMask';
import { getCindyMakeComposerPhase } from '@/lib/cindyMakeComposer';
import type { MakeDoctorReport } from '../../../../shared/cindyMakeDoctor';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => undefined,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const report: MakeDoctorReport = {
  runId: 'make-run',
  status: 'running',
  platform: 'win32',
  arch: 'x64',
  checks: [],
  task: { sessionId: 'make-session', title: 'Personal Cindy', phase: 'dependencies' },
};

describe('Cindy Make input replacement', () => {
  it('keeps input unavailable while the preparation snapshot is loading', () => {
    const view = render(<CindyMakeComposerMask phase="waiting" />);
    expect(screen.getByRole('status').textContent).toContain('cindyMake.code.phases.waiting');
    expect(screen.getByText('cindyMake.code.inputLocked.hint')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(view.container.querySelector('[contenteditable="true"]')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the full preparation card in place of the editor and stops the preparation', async () => {
    const cancel = vi.fn(async () => ({ success: true }));
    vi.stubGlobal('electronAPI', { cancelCindyMakeTask: cancel });
    const view = render(<CindyMakeComposerMask phase="dependencies" report={report} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('[make] Personal Cindy')).toBeTruthy();
    expect(screen.getByText('cindyMake.code.dependencyActivity.starting')).toBeTruthy();
    expect(screen.queryByText('cindyMake.code.inputLocked.hint')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(view.container.querySelector('[contenteditable="true"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.prepare.stop' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(report.runId));
  });

  it('restores ordinary input while the first editing turn is still running', () => {
    const content = (value: MakeDoctorReport) => {
      const phase = getCindyMakeComposerPhase({
        session: {
          id: 'make-session',
          source: 'cindy-make',
          clearedAt: null,
          lastTurnEndedAt: null,
          interruptedTurnStartedAt: null,
        },
        report: value,
        messages: [],
        historyLoaded: true,
        busy: true,
        error: null,
      });
      return phase ? (
        <CindyMakeComposerMask phase={phase} report={value} />
      ) : (
        <textarea aria-label="Chat input" />
      );
    };
    const view = render(content(report));
    expect(screen.queryByRole('textbox')).toBeNull();
    view.rerender(
      content({ ...report, status: 'completed', task: { ...report.task!, phase: 'completed' } }),
    );
    expect(screen.queryByRole('list')).toBeNull();
    const input = screen.getByRole('textbox', { name: 'Chat input' });
    fireEvent.change(input, { target: { value: 'another change' } });
    expect((input as HTMLTextAreaElement).value).toBe('another change');
  });

  it.each(['failed', 'cancelled'] as const)(
    'retries %s preparation directly from the composer with the original request',
    async (phase) => {
      const start = vi.fn(async () => 'make-session');
      vi.stubGlobal('electronAPI', { startCindyMakeTask: start });
      render(
        <CindyMakeComposerMask
          phase={phase}
          report={{ ...report, status: phase }}
          request="original request"
        />,
      );
      expect(screen.queryByRole('textbox')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'cindyMake.prepare.retry' }));
      await waitFor(() =>
        expect(start).toHaveBeenCalledWith({
          originSessionId: undefined,
          runId: report.runId,
          request: 'original request',
          title: '[make] Personal Cindy',
        }),
      );
    },
  );

  it.each(['running', 'failed', 'cancelled'] as const)(
    'keeps remote or read-only %s preparation visible without local actions',
    (status) => {
      render(
        <CindyMakeComposerMask
          phase={status === 'running' ? 'dependencies' : status}
          report={{ ...report, status }}
          request="original request"
          readOnly
        />,
      );
      expect(screen.getAllByRole('listitem')).toHaveLength(5);
      expect(screen.queryByRole('button')).toBeNull();
    },
  );
});
