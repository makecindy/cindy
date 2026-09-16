// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { cleanup, fireEvent, render as renderUI, screen, waitFor } from '@testing-library/react';
import { CindyMakeDoctorCard, MakeDoctorReportCard } from '../CindyMakeDoctorCard';
import { SystemCard } from '../SystemCard';
import {
  chooseMakeUpstream,
  startMakeCodeSession,
  startMakeDoctorInStream,
} from '@/lib/cindyMakeDoctorStream';
import { cancelMakeDoctor } from '@/lib/cindyMakeDoctor';
import { MAKE_DOCTOR_CHECK_IDS, type MakeDoctorReport } from '../../../../shared/cindyMakeDoctor';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/cindyMakeDoctorStream', () => ({
  startMakeDoctorInStream: vi.fn(),
  chooseMakeUpstream: vi.fn(),
  startMakeCodeSession: vi.fn(),
}));
vi.mock('@/lib/cindyMakeDoctor', () => ({ cancelMakeDoctor: vi.fn(async () => {}) }));
vi.mock('@/features/bots/useRemoteBots', () => ({ useRemoteBots: () => [] }));
// Partner task cards have their own integration suite; isolate this sibling variant.
vi.mock('@/features/bots/BotCollaborationCard', () => ({
  BotSessionTaskCard: () => null,
  BotSessionTaskMessageTrace: () => null,
}));
vi.mock('@/features/learn/LearnStatusCard', () => ({ LearnStatusCard: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));

const render = (ui: ReactElement) => renderUI(ui, { wrapper: MemoryRouter });
function Location() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('Make upstream step', () => {
  const ready: MakeDoctorReport = {
    ...report,
    mode: 'prepare',
    checks: MAKE_DOCTOR_CHECK_IDS.map((id) => ({ id, status: 'passed' })),
    upstream: { status: 'notFound', items: [] },
  };
  it('hides the numbered environment step when Settings renders the environment alone', () => {
    render(
      <MakeDoctorReportCard
        report={ready}
        showSteps={false}
        showSource={false}
        onStop={vi.fn()}
        onRecheck={vi.fn()}
      />,
    );
    expect(screen.queryByText('cindyMake.stepEnvironment')).toBeNull();
    expect(screen.getByRole('button', { name: 'cindyMakeDoctor.details' })).toBeTruthy();
  });

  it('keeps details left-aligned below environment and the three steps in execution order', () => {
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
    const environment = screen.getByText('cindyMake.stepEnvironment').closest('p')!;
    const details = screen.getByRole('button', { name: 'cindyMakeDoctor.details' });
    const source = screen.getByText('cindyMake.stepSource');
    const upstream = screen.getByText('cindyMake.stepUpstream');
    expect(environment.nextElementSibling).toBe(details);
    expect(details.className).toContain('text-left');
    expect(details.parentElement?.className).not.toContain('flex');
    expect(details.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      source.compareDocumentPosition(upstream) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText('cindyMakeDoctor.checks.git')).toBeNull();
    expect(screen.getByText('cindyMake.upstream.notFound')).toBeTruthy();
    expect(screen.getByText('cindyMake.upstream.notFoundHint')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'cindyMake.upstream.retry' })).toBeTruthy();
    expect(screen.queryByText('cindyMake.upstream.retry')).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.upstream.expand' })).toBeNull();
    expect(screen.queryByRole('button', { name: /back|上一步/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.personal' }));
    expect(choose).toHaveBeenCalledWith('personal');
    expect(screen.getByRole('button', { name: 'cindyMake.upstream.personal' }).className).toContain(
      'border-[var(--border-default)]',
    );
    fireEvent.click(screen.getByText('cindyMakeDoctor.details'));
    expect(screen.getByText('cindyMakeDoctor.checks.git')).toBeTruthy();
  });
  const stepHeading = (step: 'Environment' | 'Source' | 'Upstream') =>
    screen.getByText(`cindyMake.step${step}`).closest('p')!;
  const expectStep = (step: 'Environment' | 'Source' | 'Upstream', icon: string) => {
    expect(stepHeading(step).querySelector(icon)).not.toBeNull();
  };
  it.each(['found', 'notFound'] as const)(
    'advances spinners and checks in order, then shows the %s query result in the footer',
    (outcome) => {
      const props = { onStop: vi.fn(), onRecheck: vi.fn(), onChoose: vi.fn() };
      const workflow: MakeDoctorReport = {
        ...ready,
        status: 'running',
        upstream: { status: 'pending', items: [] },
      };
      const view = render(
        <MakeDoctorReportCard
          {...props}
          report={{
            ...workflow,
            checks: workflow.checks.map((check) =>
              check.id === 'git' ? { ...check, status: 'checking' } : check,
            ),
          }}
        />,
      );
      expectStep('Environment', '.animate-spinner');
      expectStep('Source', '.lucide-minus');
      expectStep('Upstream', '.lucide-minus');
      expect(screen.getByRole('status').textContent).toContain('7/8');
      const preparing: MakeDoctorReport = {
        ...workflow,
        source: { status: 'preparing', path: 'managed-source', phase: 'fetching' },
      };
      view.rerender(<MakeDoctorReportCard {...props} report={preparing} />);
      expectStep('Environment', '.lucide-check');
      expectStep('Source', '.animate-spinner');
      expectStep('Upstream', '.lucide-minus');
      expect(screen.getByRole('status').textContent).toBe('cindyMake.source.preparing');
      expect(screen.queryByRole('button', { name: 'cindyMake.upstream.personal' })).toBeNull();
      const searching: MakeDoctorReport = {
        ...workflow,
        source: { status: 'ready', path: 'managed-source', ref: 'main' },
        upstream: { status: 'searching', items: [] },
      };
      view.rerender(<MakeDoctorReportCard {...props} report={searching} />);
      expectStep('Environment', '.lucide-check');
      expectStep('Source', '.lucide-check');
      expectStep('Upstream', '.animate-spinner');
      expect(screen.getByRole('status').textContent).toBe('cindyMake.upstream.searching');
      expect(screen.getByRole('status').className).toContain('text-[var(--text-secondary)]');
      view.rerender(
        <MakeDoctorReportCard
          {...props}
          report={{
            ...searching,
            status: 'completed',
            upstream: { status: outcome, items: [] },
          }}
        />,
      );
      for (const step of ['Environment', 'Source', 'Upstream'] as const)
        expectStep(step, '.lucide-check');
      expect(document.querySelector('.animate-spinner')).toBeNull();
      expect(screen.getByRole('status').textContent).toBe(`cindyMake.upstream.${outcome}`);
      expect(screen.getByRole('status').className).toContain('text-[var(--status-success)]');
      expect(screen.getAllByText(`cindyMake.upstream.${outcome}`)).toHaveLength(1);
      expect(screen.queryByText('cindyMakeDoctor.checks.git')).toBeNull();
      expect(
        screen
          .getByRole('button', { name: 'cindyMakeDoctor.details' })
          .getAttribute('aria-expanded'),
      ).toBe('false');
      expect(screen.getByRole('button', { name: 'cindyMake.upstream.personal' })).toBeTruthy();
    },
  );
  it.each(['failed', 'cancelled'] as const)(
    'stops at source when it is %s and leaves upstream pending',
    (status) => {
      const retry = vi.fn();
      render(
        <MakeDoctorReportCard
          report={{
            ...ready,
            status,
            upstream: { status: 'pending', items: [] },
            source: {
              status,
              path: 'managed-source',
              error: status === 'failed' ? 'tagNotFound' : 'cancelled',
            },
          }}
          onStop={vi.fn()}
          onRecheck={retry}
          onChoose={vi.fn()}
        />,
      );
      expectStep('Environment', '.lucide-check');
      expectStep('Source', '.lucide-minus');
      expectStep('Upstream', '.lucide-minus');
      expect(document.querySelector('.animate-spinner')).toBeNull();
      expect(screen.getByRole('status').textContent).toBe(`cindyMake.source.${status}`);
      expect(screen.getByRole('status').className).toContain(
        status === 'failed' ? 'text-[var(--status-danger)]' : 'text-[var(--text-secondary)]',
      );
      expect(screen.queryByRole('button', { name: 'cindyMake.upstream.personal' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'cindyMake.prepare.retry' }));
      expect(retry).toHaveBeenCalledOnce();
    },
  );
  it.each(['failed', 'cancelled'] as const)(
    'keeps source successful without masking a %s query',
    (status) => {
      render(
        <MakeDoctorReportCard
          report={{
            ...ready,
            upstream: { status, items: [] },
            source: { status: 'ready', path: 'managed-source' },
          }}
          onStop={vi.fn()}
          onRecheck={vi.fn()}
          onChoose={vi.fn()}
        />,
      );
      expectStep('Environment', '.lucide-check');
      expectStep('Source', '.lucide-check');
      expectStep('Upstream', '.lucide-minus');
      expect(document.querySelector('.animate-spinner')).toBeNull();
      expect(screen.getByRole('status').textContent).toBe(`cindyMake.upstream.${status}`);
      expect(screen.getByRole('status').className).toContain(
        status === 'failed' ? 'text-[var(--status-danger)]' : 'text-[var(--text-secondary)]',
      );
      expect(screen.queryByRole('button', { name: 'cindyMake.upstream.personal' })).toBeNull();
    },
  );
  it('dismisses the card after choosing to wait with the source already prepared', async () => {
    const dismiss = vi.fn();
    vi.mocked(chooseMakeUpstream).mockResolvedValueOnce(null);
    render(
      <CindyMakeDoctorCard
        sessionId="origin-task"
        onDismiss={dismiss}
        data={{
          report: { ...ready, source: { status: 'ready', path: 'managed-source' } },
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.wait' }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledOnce());
    expect(chooseMakeUpstream).toHaveBeenCalledWith('origin-task', ready.runId, 'wait');
    expect(startMakeCodeSession).not.toHaveBeenCalled();
    expect(cancelMakeDoctor).not.toHaveBeenCalled();
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
  const found: MakeDoctorReport = {
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
          updatedAt: '2026-09-08T08:00:00Z',
          summary: '<script>literal</script>',
        },
        {
          number: 13,
          title: 'Scrolling on mobile',
          htmlUrl: 'https://github.com/makecindy/cindy/issues/13',
          kind: 'issue',
          state: 'open',
          summary: 'Second result details',
        },
      ],
    },
  };
  it('lists all titles and choices immediately, with independent, initially collapsed details', async () => {
    const choose = vi.fn();
    const openExternal = vi.fn(async () => ({ success: true }));
    vi.stubGlobal('electronAPI', { openExternal });
    render(
      <MakeDoctorReportCard
        report={found}
        onStop={vi.fn()}
        onRecheck={vi.fn()}
        onChoose={choose}
      />,
    );
    const first = screen.getByRole('button', { name: /#12/ });
    const second = screen.getByRole('button', { name: /#13/ });
    expect(first.querySelector('b')).toBeNull();
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(second.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('<script>literal</script>')).toBeNull();
    expect(screen.queryByText('Second result details')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.upstream.expand' })).toBeNull();
    expect(screen.getByText('cindyMake.upstream.count')).toBeTruthy();
    expect(screen.getByText('cindyMake.upstream.resultHint')).toBeTruthy();
    const status = screen.getByRole('status');
    const waitButton = screen.getByRole('button', { name: 'cindyMake.upstream.wait' });
    expect(status.parentElement?.contains(waitButton)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.personal' }));
    expect(choose).toHaveBeenCalledWith('personal');
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.wait' }));
    expect(choose).toHaveBeenCalledWith('wait');

    fireEvent.click(first);
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(second.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('<script>literal</script>').querySelector('script')).toBeNull();
    expect(screen.queryByText('Second result details')).toBeNull();
    fireEvent.click(screen.getByRole('link'));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(found.upstream!.items[0].htmlUrl),
    );
    expect(first.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(second);
    expect(screen.getByText('<script>literal</script>')).toBeTruthy();
    expect(screen.getByText('Second result details')).toBeTruthy();
    expect(first.getAttribute('aria-controls')).not.toBe(second.getAttribute('aria-controls'));
    fireEvent.click(first);
    expect(screen.queryByText('<script>literal</script>')).toBeNull();
    expect(screen.getByText('Second result details')).toBeTruthy();
    expect(second.getAttribute('aria-expanded')).toBe('true');
  });
  it('renders upstream results directly under the upstream step', () => {
    render(
      <MakeDoctorReportCard
        report={found}
        onStop={vi.fn()}
        onRecheck={vi.fn()}
        onChoose={vi.fn()}
      />,
    );
    const step = screen.getByText('cindyMake.stepUpstream');
    const count = screen.getByText('cindyMake.upstream.count');
    expect(step.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(count.compareDocumentPosition(step) & Node.DOCUMENT_POSITION_FOLLOWING).toBeFalsy();
  });
  it('shows a completed source status after choosing a personal build', () => {
    render(
      <MakeDoctorReportCard
        report={{
          ...found,
          source: { status: 'ready', path: 'C:\\cindy-make\\source' },
        }}
        decision="personal"
        onStop={vi.fn()}
        onRecheck={vi.fn()}
      />,
    );
    expect(screen.getAllByText('cindyMake.source.ready')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain('cindyMake.source.ready');
  });
  it('uses a spinner instead of a transient progress bar while preparing source', () => {
    render(
      <MakeDoctorReportCard
        report={{
          ...found,
          status: 'running',
          source: {
            status: 'preparing',
            phase: 'fetching',
            path: 'C:\\cindy-make\\source',
            progress: { stage: 'receiving', percent: 43 },
          },
        }}
        decision="personal"
        onStop={vi.fn()}
        onRecheck={vi.fn()}
      />,
    );
    expect(screen.getByText('cindyMake.source.gitProgress.receiving')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(document.querySelector('.animate-spinner')).toBeTruthy();
  });
  it('keeps the decision visible and resets item expansion when requerying or changing runs', () => {
    const props = { onStop: vi.fn(), onRecheck: vi.fn(), decision: 'personal' as const };
    const view = render(<MakeDoctorReportCard {...props} report={found} />);
    expect(screen.getByRole('status').textContent).toContain('cindyMake.upstream.choice.personal');
    expect(screen.queryByText('cindyMake.upstream.decisionHint.personal')).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.upstream.personal' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /#12/ }));
    view.rerender(
      <MakeDoctorReportCard
        {...props}
        report={{ ...found, upstream: { status: 'searching', items: [] } }}
      />,
    );
    view.rerender(<MakeDoctorReportCard {...props} report={found} />);
    expect(screen.getByRole('button', { name: /#12/ }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: /#12/ }));
    view.rerender(<MakeDoctorReportCard {...props} report={{ ...found, runId: 'next-run' }} />);
    expect(screen.getByRole('button', { name: /#12/ }).getAttribute('aria-expanded')).toBe('false');
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
    fireEvent.click(screen.getByText('cindyMakeDoctor.details'));
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
    fireEvent.click(screen.getByText('cindyMakeDoctor.details'));
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
    fireEvent.click(screen.getByText('cindyMakeDoctor.details'));
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

  it('opens the new code task after the personal choice completes', async () => {
    vi.mocked(chooseMakeUpstream).mockResolvedValueOnce('personal-task');
    render(
      <>
        <Location />
        <SystemCard
          cardType="cindy-make"
          sessionId="origin-task"
          data={{
            report: { ...report, upstream: { status: 'notFound', items: [] } },
            request: 'fix scrolling',
          }}
        />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.personal' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/cc-agent/personal-task'),
    );
    expect(chooseMakeUpstream).toHaveBeenCalledWith('origin-task', report.runId, 'personal');
  });

  it('opens the persisted task without creating or sending again, including after a failed send', () => {
    render(
      <>
        <Location />
        <SystemCard
          cardType="cindy-make"
          sessionId="origin-task"
          data={{
            report: { ...report, source: { status: 'ready', path: 'C:\\source' } },
            decision: 'personal',
            codeSessionId: 'existing-task',
            codeSessionError: true,
          }}
        />
      </>,
    );
    expect(screen.getByRole('status').textContent).toBe('cindyMake.code.sendFailed');
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.code.open' }));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/existing-task');
    expect(startMakeCodeSession).not.toHaveBeenCalled();
  });
});
