// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MakeDoctorReportCard } from '../CindyMakeDoctorCard';
import { SystemCard } from '../SystemCard';
import { startMakeDoctorInStream } from '@/lib/cindyMakeDoctorStream';
import { cancelMakeDoctor } from '@/lib/cindyMakeDoctor';
import { MAKE_DOCTOR_CHECK_IDS, type MakeDoctorReport } from '../../../../shared/cindyMakeDoctor';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/cindyMakeDoctorStream', () => ({ startMakeDoctorInStream: vi.fn() }));
vi.mock('@/lib/cindyMakeDoctor', () => ({ cancelMakeDoctor: vi.fn(async () => {}) }));
vi.mock('@/features/bots/useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('@/features/learn/LearnStatusCard', () => ({ LearnStatusCard: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Make upstream step', () => {
  const ready: MakeDoctorReport = {
    ...report,
    mode: 'prepare',
    checks: MAKE_DOCTOR_CHECK_IDS.map((id) => ({ id, status: 'passed' })),
    upstream: { status: 'notFound', items: [] },
  };
  it('shows both steps in the same card, with environment details collapsed and no Back action', () => {
    const choose = vi.fn();
    render(
      <MakeDoctorReportCard
        report={ready}
        onStop={vi.fn()}
        onRecheck={vi.fn()}
        onChoose={choose}
      />,
    );
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(screen.getByText('cindyMake.stepEnvironment')).toBeTruthy();
    expect(screen.getByText('cindyMake.stepUpstream')).toBeTruthy();
    expect(screen.queryByText('cindyMakeDoctor.checks.git')).toBeNull();
    expect(screen.getByText('cindyMake.upstream.notFound')).toBeTruthy();
    expect(screen.queryByText('cindyMake.upstream.notFoundHint')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.expand' }));
    expect(screen.getByText('cindyMake.upstream.notFoundHint')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /back|上一步/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.personal' }));
    expect(choose).toHaveBeenCalledWith('personal');
    fireEvent.click(screen.getByText('cindyMakeDoctor.details'));
    expect(screen.getByText('cindyMakeDoctor.checks.git')).toBeTruthy();
  });
  it('offers Stop during search, then retry for failure without offering a build', () => {
    const stop = vi.fn();
    const retry = vi.fn();
    const view = render(
      <MakeDoctorReportCard
        report={{ ...ready, status: 'running', upstream: { status: 'searching', items: [] } }}
        onStop={stop}
        onRecheck={retry}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.prepare.stop' }));
    expect(stop).toHaveBeenCalledOnce();
    view.rerender(
      <MakeDoctorReportCard
        report={{ ...ready, upstream: { status: 'failed', failure: 'rateLimit', items: [] } }}
        onStop={stop}
        onRecheck={retry}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.expand' }));
    expect(screen.getByText('cindyMake.upstream.failure.rateLimit')).toBeTruthy();
    expect(screen.queryByText('cindyMake.upstream.personal')).toBeNull();
    expect(screen.queryByText('cindyMake.upstream.notFoundHint')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it('shows a missing request without creating an input flow', () => {
    const search = vi.fn();
    render(
      <MakeDoctorReportCard
        report={{ ...ready, upstream: { status: 'needsRequest', items: [] } }}
        onStop={vi.fn()}
        onRecheck={vi.fn()}
        onSearch={search}
      />,
    );
    expect(screen.getByText('cindyMake.upstream.needRequest')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });
  it('renders upstream content collapsed by default and expands on demand', () => {
    render(
      <MakeDoctorReportCard
        report={{
          ...ready,
          upstream: {
            status: 'found',
            items: [
              {
                number: 12,
                title: '<b>scrolling</b>',
                htmlUrl: 'https://github.com/makecindy/cindy/pull/12',
                kind: 'pr',
                state: 'open',
                author: 'contributor',
                summary: '<script>literal</script>',
              },
            ],
          },
        }}
        onStop={vi.fn()}
        onRecheck={vi.fn()}
        decision="personal"
      />,
    );
    expect(screen.queryByText('cindyMake.upstream.resultHint')).toBeNull();
    expect(screen.getByText('cindyMake.upstream.count')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.expand' }));
    expect(screen.getByRole('link').querySelector('b')).toBeNull();
    expect(screen.getByText('<script>literal</script>').querySelector('script')).toBeNull();
    expect(screen.getByText('cindyMake.upstream.resultHint')).toBeTruthy();
    expect(screen.getByText('cindyMake.upstream.decisionHint.personal')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'cindyMake.upstream.personal' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.collapse' }));
    expect(screen.queryByText('cindyMake.upstream.resultHint')).toBeNull();
  });
});
const report: MakeDoctorReport = {
  runId: 'run',
  platform: 'win32',
  arch: 'x64',
  status: 'completed',
  checks: [{ id: 'git', status: 'passed', version: '2.55.0' }],
};

describe('doctor card interactions', () => {
  it('shows download progress and retries preparation after a checksum failure in the same card', () => {
    const retry = vi.fn();
    const view = render(
      <MakeDoctorReportCard
        report={{
          ...report,
          mode: 'prepare',
          status: 'running',
          checks: [
            {
              id: 'node',
              status: 'downloading',
              progress: { loaded: 50, total: 100, percent: 50 },
            },
          ],
        }}
        onStop={vi.fn()}
        onRecheck={retry}
      />,
    );
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText('cindyMake.prepare.stop')).toBeTruthy();
    expect(screen.queryByText('cindyMakeDoctor.scope')).toBeNull();
    view.rerender(
      <MakeDoctorReportCard
        report={{
          ...report,
          mode: 'prepare',
          checks: [{ id: 'node', status: 'failed', reason: 'checksum' }],
        }}
        onStop={vi.fn()}
        onRecheck={retry}
      />,
    );
    expect(screen.getByText('cindyMake.prepare.errors.checksum')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.click(screen.getByText('cindyMake.prepare.retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['win32', 'windows'],
    ['darwin', 'mac'],
    ['linux', 'linux'],
  ])('shows installation guidance for missing %s system tools', (platform, kind) => {
    render(
      <MakeDoctorReportCard
        report={{
          ...report,
          platform,
          mode: 'prepare',
          checks: [{ id: 'native', status: 'missing' }],
        }}
        onStop={vi.fn()}
        onRecheck={vi.fn()}
      />,
    );
    expect(screen.getByText(`cindyMake.prepare.guidance.${kind}`)).toBeTruthy();
    expect(screen.getByText('cindyMake.prepare.installGuide')).toBeTruthy();
  });
  it('has no continue action when all checks pass; detail and collapse controls work', () => {
    render(<MakeDoctorReportCard report={report} onStop={vi.fn()} onRecheck={vi.fn()} />);
    expect(screen.queryByText('cindyMakeDoctor.recheck')).toBeNull();
    expect(screen.queryByText('cindyMakeDoctor.requirements.git')).toBeNull();
    fireEvent.click(screen.getByText('cindyMakeDoctor.details'));
    expect(screen.getByText('cindyMakeDoctor.requirements.git')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMakeDoctor.title' }));
    expect(screen.queryByText('cindyMakeDoctor.checks.git')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('cindyMakeDoctor.passed');
  });
  it('shows the incompatible status alongside the version and permits rechecking', () => {
    const recheck = vi.fn();
    render(
      <MakeDoctorReportCard
        report={{ ...report, checks: [{ id: 'node', status: 'incompatible', version: '20.0.0' }] }}
        onStop={vi.fn()}
        onRecheck={recheck}
      />,
    );
    expect(screen.getByText(/20.0.0.*cindyMakeDoctor.checkStatus.incompatible/)).toBeTruthy();
    expect(screen.getByText('cindyMakeDoctor.requirements.node')).toBeTruthy();
    fireEvent.click(screen.getByText('cindyMakeDoctor.recheck'));
    expect(recheck).toHaveBeenCalledTimes(1);
  });
  it('offers stop while running and recheck after cancellation', () => {
    const stop = vi.fn();
    const props = { onStop: stop, onRecheck: vi.fn() };
    const view = render(
      <MakeDoctorReportCard {...props} report={{ ...report, status: 'running' }} />,
    );
    fireEvent.click(screen.getByText('cindyMakeDoctor.stop'));
    expect(stop).toHaveBeenCalledTimes(1);
    view.rerender(<MakeDoctorReportCard {...props} report={{ ...report, status: 'cancelled' }} />);
    expect(screen.queryByText('cindyMakeDoctor.stop')).toBeNull();
    expect(screen.getByText('cindyMakeDoctor.recheck')).toBeTruthy();
  });

  it('renders through the message-stream SystemCard and routes actions to the originating run', async () => {
    const view = render(
      <SystemCard
        cardType="cindy-make-doctor"
        sessionId="origin-task"
        data={{ report: { ...report, status: 'running' } }}
      />,
    );
    expect(screen.getByRole('region', { name: 'cindyMakeDoctor.title' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'cindyMakeDoctor.dismiss' })).toBeNull();
    fireEvent.click(screen.getByText('cindyMakeDoctor.stop'));
    expect(cancelMakeDoctor).toHaveBeenCalledWith('run', undefined);

    view.rerender(
      <SystemCard
        cardType="cindy-make-doctor"
        sessionId="origin-task"
        data={{ report: { ...report, status: 'cancelled' } }}
      />,
    );
    fireEvent.click(screen.getByText('cindyMakeDoctor.recheck'));
    await waitFor(() =>
      expect(startMakeDoctorInStream).toHaveBeenCalledWith('origin-task', { retryRunId: 'run' }),
    );
  });

  it('renders Make requests as plain text and preserves them when collapsed and expanded', () => {
    const request = '修复滚动\n<b>literal HTML</b>';
    const view = render(
      <SystemCard cardType="cindy-make" sessionId="origin-task" data={{ report, request }} />,
    );
    const content = screen.getByText(/literal HTML/);
    expect(content.textContent).toBe(request);
    expect(content.querySelector('b')).toBeNull();
    expect(screen.getByText('cindyMake.request')).toBeTruthy();
    expect(screen.queryByText('cindyMakeDoctor.recheck')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(2); // Collapse and details only.
    fireEvent.click(screen.getByRole('button', { name: 'cindyMakeDoctor.title' }));
    expect(screen.queryByText(/literal HTML/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMakeDoctor.title' }));
    expect(screen.getByText(/literal HTML/).textContent).toBe(request);
    view.rerender(
      <SystemCard cardType="cindy-make" sessionId="origin-task" data={{ report, request: '' }} />,
    );
    expect(screen.queryByText('cindyMake.request')).toBeNull();
  });
});
