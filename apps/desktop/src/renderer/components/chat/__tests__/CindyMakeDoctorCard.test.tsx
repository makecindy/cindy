// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import {
  act,
  cleanup,
  fireEvent,
  render as renderUI,
  screen,
  waitFor,
} from '@testing-library/react';
import { CindyMakeDoctorCard, MakeDoctorReportCard } from '../CindyMakeDoctorCard';
import { SystemCard } from '../SystemCard';
import {
  chooseMakeUpstream,
  startMakeCodeSession,
  startMakeDoctorInStream,
} from '@/lib/cindyMakeDoctorStream';
import { cancelMakeDoctor } from '@/lib/cindyMakeDoctor';
import { useCindyMakeState } from '@/lib/cindyMakeState';
import { makerChatStore } from '@/lib/makerChatStore';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { MAKE_DOCTOR_CHECK_IDS, type MakeDoctorReport } from '../../../../shared/cindyMakeDoctor';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
const opening = vi.hoisted(() => ({
  get: vi.fn(),
  restore: vi.fn(),
  prepend: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/sessionService', () => ({
  get: opening.get,
  restoreIfArchived: opening.restore,
}));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { prependCreated: opening.prepend } }));
vi.mock('@/lib/toast', () => ({ toast: { error: opening.error } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/cindyMakeDoctorStream', () => ({
  startMakeDoctorInStream: vi.fn(),
  chooseMakeUpstream: vi.fn(),
  startMakeCodeSession: vi.fn(),
}));
vi.mock('@/lib/cindyMakeDoctor', () => ({ cancelMakeDoctor: vi.fn(async () => {}) }));
vi.mock('@/lib/cindyMakeState', () => ({ useCindyMakeState: vi.fn(() => ({})) }));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getSnapshot: vi.fn(() => ({ messages: [] })),
    updateSystemCardData: vi.fn(),
  },
}));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: vi.fn(),
}));
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

beforeEach(() => {
  setDataOwnerGeneration('doctor-card-test');
  opening.get.mockReset();
  opening.restore.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(useCindyMakeState).mockReturnValue({});
  vi.mocked(getStickySessionDeviceId).mockReset();
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
        status === 'failed' ? 'text-[var(--error-fg)]' : 'text-[var(--text-secondary)]',
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
        status === 'failed' ? 'text-[var(--error-fg)]' : 'text-[var(--text-secondary)]',
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
  it('shows choices immediately and reveals results only on request, without nested scrolling', async () => {
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
    expect(screen.queryByRole('button', { name: /#12/ })).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText('cindyMake.upstream.count')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'cindyMake.upstream.personal' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'cindyMake.upstream.wait' })).toBeTruthy();
    const disclosure = screen.getByRole('button', { name: 'cindyMake.upstream.expand' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(disclosure);
    expect(screen.getByRole('list').className).not.toMatch(/overflow-y|max-h/);
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
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.collapse' }));
    expect(screen.queryByRole('button', { name: /#12/ })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: 'cindyMake.upstream.personal' })).toBeTruthy();
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
  it('shows PR state and runtime inclusion separately while leaving source details collapsed', () => {
    render(
      <MakeDoctorReportCard
        report={{
          ...found,
          upstream: {
            ...found.upstream!,
            runtime: {
              channel: 'dev',
              version: '0.0.0',
              commit: 'a'.repeat(40),
              confidence: 'unknown',
            },
            items: [{ ...found.upstream!.items[0], state: 'merged', inclusion: 'unknown' }],
            excludedIncluded: 2,
            hasMore: true,
          },
        }}
        onStop={vi.fn()}
        onRecheck={vi.fn()}
        onChoose={vi.fn()}
      />,
    );
    expect(screen.getByText('cindyMake.upstream.runtimeUnknown')).toBeTruthy();
    expect(screen.getByText('cindyMake.upstream.excludedIncluded')).toBeTruthy();
    expect(screen.getByText('cindyMake.upstream.limitedHint')).toBeTruthy();
    expect(screen.queryByText('cindyMake.upstream.runtimeVersion')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.expand' }));
    expect(screen.getByText('cindyMake.upstream.runtimeVersion')).toBeTruthy();
    const row = screen.getByRole('button', { name: /#12/ });
    expect(row.textContent).toContain('cindyMake.upstream.state.merged');
    expect(row.textContent).toContain('cindyMake.upstream.inclusion.unknown');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'cindyMake.upstream.personal' })).toBeTruthy();
  });
  it('explains an empty filtered result without claiming the search was exhaustive', () => {
    render(
      <MakeDoctorReportCard
        report={{
          ...found,
          upstream: { status: 'notFound', items: [], excludedIncluded: 5, hasMore: true },
        }}
        onStop={vi.fn()}
        onRecheck={vi.fn()}
        onChoose={vi.fn()}
      />,
    );
    expect(screen.getByText('cindyMake.upstream.excludedIncluded')).toBeTruthy();
    expect(screen.getByText('cindyMake.upstream.limitedHint')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'cindyMake.upstream.expand' })).toBeNull();
    expect(screen.getByRole('button', { name: 'cindyMake.upstream.personal' })).toBeTruthy();
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
    expect(screen.getAllByText('cindyMake.source.ready')).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toContain('cindyMake.source.ready');
  });
  it('keeps source readiness visible without repository details or paths in the workflow card', () => {
    render(
      <MakeDoctorReportCard
        report={{
          ...found,
          source: {
            status: 'ready',
            path: 'managed-source',
            ref: 'main',
            branch: 'cindy-personal',
            currentBranch: 'feature/current',
            commit: 'a'.repeat(40),
            baseCommit: 'b'.repeat(40),
            mainCommit: 'c'.repeat(40),
            mainRemoteCommit: 'd'.repeat(40),
            mainBehind: 5,
            mainAhead: 2,
          },
        }}
        onStop={vi.fn()}
        onRecheck={vi.fn()}
      />,
    );
    expect(screen.getByText('cindyMake.source.ready')).toBeTruthy();
    expect(screen.queryByText('cindy-personal')).toBeNull();
    expect(screen.queryByText('managed-source')).toBeNull();
    for (const prefix of ['b', 'c']) {
      expect(screen.queryByText(prefix.repeat(12))).toBeNull();
    }
    expect(screen.queryByText('feature/current')).toBeNull();
    expect(screen.queryByText('main')).toBeNull();
    expect(screen.queryByText('a'.repeat(12))).toBeNull();
    expect(screen.queryByText('a'.repeat(40))).toBeNull();
    expect(screen.queryByText('d'.repeat(12))).toBeNull();
  });
  it('shows cache warming and counters in preflight without claiming to install dependencies', () => {
    render(
      <MakeDoctorReportCard
        onStop={vi.fn()}
        onRecheck={vi.fn()}
        report={{
          ...found,
          status: 'running',
          source: {
            status: 'preparing',
            phase: 'caching',
            path: 'managed-source',
            dependencies: { resolved: 21, reused: 12, downloaded: 9, added: 0 },
          },
        }}
      />,
    );
    expect(screen.getByText('cindyMake.source.phase.caching')).toBeTruthy();
    expect(screen.getByText('cindyMake.source.cacheProgress')).toBeTruthy();
    expect(screen.queryByText('cindyMake.code.dependencyActivity.packages')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'cindyMake.upstream.personal' }).hasAttribute('disabled'),
    ).toBe(true);
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
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.expand' }));
    fireEvent.click(screen.getByRole('button', { name: /#12/ }));
    view.rerender(
      <MakeDoctorReportCard
        {...props}
        report={{ ...found, upstream: { status: 'searching', items: [] } }}
      />,
    );
    view.rerender(<MakeDoctorReportCard {...props} report={found} />);
    expect(screen.queryByRole('button', { name: /#12/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.expand' }));
    expect(screen.getByRole('button', { name: /#12/ }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: /#12/ }));
    view.rerender(<MakeDoctorReportCard {...props} report={{ ...found, runId: 'next-run' }} />);
    expect(screen.queryByRole('button', { name: /#12/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.upstream.expand' }));
    expect(screen.getByRole('button', { name: /#12/ }).getAttribute('aria-expanded')).toBe('false');
  });
  it('shows the live Git line compactly and clears stale progress once source is ready', () => {
    const source: NonNullable<MakeDoctorReport['source']> = {
      status: 'preparing',
      path: 'managed-source',
      phase: 'fetching',
      progress: {
        stage: 'receiving',
        percent: 43,
        message: 'Receiving objects: 43% (43/100), 1.00 MiB | 1.00 MiB/s',
      },
    };
    const props = { onStop: vi.fn(), onRecheck: vi.fn() };
    const view = render(
      <MakeDoctorReportCard {...props} report={{ ...found, status: 'running', source }} />,
    );
    const progressLine = screen.getByText(source.progress!.message!);
    expect(progressLine.className).toContain('truncate');
    expect(progressLine.getAttribute('title')).toBe(source.progress!.message);
    expect(screen.getByText('(43%)')).toBeTruthy();
    expect(screen.queryByText('cindyMake.source.phase.fetching')).toBeNull();
    view.rerender(
      <MakeDoctorReportCard
        {...props}
        report={{ ...found, source: { ...source, status: 'ready' } }}
      />,
    );
    expect(screen.getByText('cindyMake.source.ready')).toBeTruthy();
    expect(screen.queryByText(source.progress!.message!)).toBeNull();
    expect(screen.queryByText('cindyMake.source.gitProgress.receiving')).toBeNull();
    expect(screen.queryByText('cindyMake.source.phase.fetching')).toBeNull();
  });
});
const report: MakeDoctorReport = {
  runId: 'run',
  platform: 'win32',
  arch: 'x64',
  status: 'completed',
  checks: [{ id: 'git', status: 'passed', version: '2.55.0' }],
};

describe('Main-owned report recovery', () => {
  const persisted: MakeDoctorReport = {
    ...report,
    mode: 'prepare',
    status: 'running',
    upstream: { status: 'pending', items: [] },
    source: { status: 'preparing', phase: 'cloning', path: '/source' },
  };
  const completed: MakeDoctorReport = {
    ...persisted,
    status: 'completed',
    checks: MAKE_DOCTOR_CHECK_IDS.map((id) => ({ id, status: 'passed' })),
    source: { status: 'ready', path: '/source' },
    upstream: { status: 'notFound', items: [] },
  };
  it('uses the complete Main workflow after reload instead of the old running message', () => {
    vi.mocked(useCindyMakeState).mockReturnValue({ reports: { [report.runId]: completed } });
    render(
      <CindyMakeDoctorCard
        sessionId="origin"
        data={{ report: persisted, request: 'original request' }}
      />,
    );
    expect(screen.getByRole('button', { name: 'cindyMake.upstream.personal' })).toBeTruthy();
    expect(screen.getByText('cindyMake.upstream.notFoundHint')).toBeTruthy();
    expect(screen.queryByText('cindyMake.source.phase.cloning')).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.prepare.stop' })).toBeNull();
  });
  it('projects updated source and cancellation reports without writing a guessed message state', () => {
    const update = vi.spyOn(makerChatStore, 'updateSystemCardData').mockImplementation(() => {});
    vi.mocked(useCindyMakeState).mockReturnValue({
      reports: {
        [report.runId]: {
          ...persisted,
          source: { status: 'preparing', phase: 'installing', path: '/source' },
        },
      },
    });
    const view = render(<CindyMakeDoctorCard sessionId="origin" data={{ report: persisted }} />);
    expect(screen.getByText('cindyMake.source.phase.installing')).toBeTruthy();
    vi.mocked(useCindyMakeState).mockReturnValue({
      reports: {
        [report.runId]: {
          ...persisted,
          status: 'cancelled',
          source: { status: 'cancelled', path: '/source' },
        },
      },
    });
    view.rerender(<CindyMakeDoctorCard sessionId="origin" data={{ report: persisted }} />);
    expect(screen.getByRole('status').textContent).toBe('cindyMake.source.cancelled');
    expect(screen.getByRole('button', { name: 'cindyMake.prepare.retry' })).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });
  it('falls back to the saved report when Main has no matching run', () => {
    vi.mocked(useCindyMakeState).mockReturnValue({ reports: { other: completed } });
    render(<CindyMakeDoctorCard sessionId="origin" data={{ report: persisted }} />);
    expect(screen.getByText('cindyMake.source.phase.cloning')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'cindyMake.upstream.personal' })).toBeNull();
  });
  it.each(['choose', 'retry'] as const)(
    'syncs only the authoritative report before the legacy %s action checks its cached message',
    async (action) => {
      const authoritative: MakeDoctorReport =
        action === 'choose'
          ? completed
          : {
              ...persisted,
              status: 'cancelled',
              source: { status: 'cancelled', path: '/source' },
            };
      vi.mocked(useCindyMakeState).mockReturnValue({ reports: { [report.runId]: authoritative } });
      const request = 'original request\n  keep whitespace';
      const snapshot = {
        ...makerChatStore.getSnapshot('origin'),
        messages: [
          {
            clientId: 'original-card',
            role: 'assistant' as const,
            content: '',
            systemCardType: 'cindy-make' as const,
            systemCardData: { report: persisted, request },
          },
        ],
      };
      vi.spyOn(makerChatStore, 'getSnapshot').mockReturnValue(snapshot);
      const update = vi.spyOn(makerChatStore, 'updateSystemCardData').mockImplementation(() => {});
      render(<CindyMakeDoctorCard sessionId="origin" data={{ report: persisted, request }} />);
      fireEvent.click(
        screen.getByRole('button', {
          name: action === 'choose' ? 'cindyMake.upstream.personal' : 'cindyMake.prepare.retry',
        }),
      );
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith('origin', 'original-card', { report: authoritative }),
      );
      const command = action === 'choose' ? chooseMakeUpstream : startMakeDoctorInStream;
      await waitFor(() => expect(command).toHaveBeenCalledOnce());
      expect(update.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(command).mock.invocationCallOrder[0],
      );
      expect(snapshot.messages[0].systemCardData.request).toBe(request);
    },
  );
  it('does not replace a remote task report with a matching local run or expose local controls', () => {
    vi.mocked(getStickySessionDeviceId).mockReturnValue('remote-device');
    const remoteReport: MakeDoctorReport = {
      ...persisted,
      task: { sessionId: 'remote-task', originSessionId: 'remote-origin', phase: 'dependencies' },
    };
    vi.mocked(useCindyMakeState).mockReturnValue({
      reports: { [report.runId]: completed },
      tasks: {
        [report.runId]: {
          ...remoteReport,
          status: 'completed',
          task: { ...remoteReport.task!, phase: 'completed' },
        },
      },
    });
    render(
      <>
        <CindyMakeDoctorCard
          sessionId="remote-origin"
          data={{ report: remoteReport, request: 'request' }}
        />
        <Location />
      </>,
    );
    expect(screen.getByRole('status').textContent).toBe('cindyMake.code.phases.dependencies');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('location').textContent).toBe('/');
  });
  it('keeps remote legacy cards read-only and ignores local workflow reports', () => {
    vi.mocked(getStickySessionDeviceId).mockReturnValue('remote-device');
    vi.mocked(useCindyMakeState).mockReturnValue({ reports: { [report.runId]: completed } });
    const view = render(
      <CindyMakeDoctorCard sessionId="remote-origin" data={{ report: persisted }} />,
    );
    expect(screen.getByText('cindyMake.source.phase.cloning')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'cindyMake.prepare.stop' })).toBeNull();
    view.rerender(
      <CindyMakeDoctorCard
        sessionId="remote-origin"
        data={{ report: completed, decision: 'personal', codeSessionId: 'remote-task' }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'cindyMake.upstream.retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.code.open' })).toBeNull();
    expect(startMakeCodeSession).not.toHaveBeenCalled();
    expect(cancelMakeDoctor).not.toHaveBeenCalled();
  });
});

describe('doctor card interactions', () => {
  it('uses a compact worktree and dependency card inside the created task', () => {
    render(
      <CindyMakeDoctorCard
        sessionId="task-session"
        data={{
          request: '修复消息流闪烁',
          codeSessionId: 'task-session',
          report: {
            ...report,
            mode: 'prepare',
            status: 'running',
            checks: [],
            source: {
              status: 'ready',
              branch: 'cindy-make/task-run',
              path: 'C:/Cindy/worktrees/task-run',
            },
          },
        }}
      />,
    );
    expect(screen.getByText('cindyMake.code.taskName')).toBeTruthy();
    expect(screen.getByText('cindyMake.code.workspace')).toBeTruthy();
    expect(screen.getByText('C:/Cindy/worktrees/task-run')).toBeTruthy();
    expect(screen.getByText('cindyMake.code.preparingNpmDependencies')).toBeTruthy();
    expect(screen.queryByText('修复消息流闪烁')).toBeNull();
    expect(screen.queryByText('cindyMakeDoctor.scope')).toBeNull();
    expect(screen.queryByText('cindyMake.stepEnvironment')).toBeNull();
    expect(screen.queryByText('cindyMake.stepSource')).toBeNull();
    expect(screen.queryByText('cindyMake.stepUpstream')).toBeNull();
  });

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

  it('opens the persisted task without creating or sending again, including after a failed send', async () => {
    opening.get.mockResolvedValue({ id: 'existing-task', status: 'active' });
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
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/cc-agent/existing-task'),
    );
    expect(startMakeCodeSession).not.toHaveBeenCalled();
    expect(opening.restore).not.toHaveBeenCalled();
  });
});

describe.each(['task', 'legacy'] as const)('opening a %s preparation card', (kind) => {
  const archived = {
    id: 'existing-task',
    status: 'archived',
    workingDir: '/make/run',
    workspaceKind: 'project',
    remoteHostId: null,
  };
  const renderLink = (onDismiss = vi.fn()) => {
    const saved: MakeDoctorReport = {
      ...report,
      status: kind === 'task' ? 'cancelled' : 'completed',
      source: { status: 'ready', path: '/make/run' },
      ...(kind === 'task'
        ? { task: { sessionId: archived.id, phase: 'dependencies' as const } }
        : {}),
    };
    return render(
      <>
        <Location />
        <CindyMakeDoctorCard
          sessionId="origin-task"
          onDismiss={onDismiss}
          data={{ report: saved, decision: 'personal', codeSessionId: archived.id }}
        />
      </>,
    );
  };
  const clickOpen = () =>
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.code.open' }));

  it('restores the archived task before dismissing and navigating, without dispatching again', async () => {
    opening.get.mockResolvedValue(archived);
    let finishRestore!: (value: unknown) => void;
    opening.restore.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRestore = resolve;
        }),
    );
    const dismiss = vi.fn();
    renderLink(dismiss);
    clickOpen();
    clickOpen();
    await waitFor(() => expect(opening.restore).toHaveBeenCalledWith(archived.id, archived));
    expect(opening.restore).toHaveBeenCalledOnce();
    expect(dismiss).not.toHaveBeenCalled();
    expect(opening.prepend).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/');
    const restored = { ...archived, status: 'active' };
    await act(async () => finishRestore(restored));
    expect(opening.prepend).toHaveBeenCalledWith(restored);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/' + archived.id);
    expect(startMakeCodeSession).not.toHaveBeenCalled();
    expect(chooseMakeUpstream).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'changed'] as const)('does not open a %s task', async (state) => {
    opening.get.mockResolvedValue(
      state === 'deleted' ? { ...archived, status: 'deleted' } : archived,
    );
    opening.restore.mockResolvedValue(null);
    const dismiss = vi.fn();
    renderLink(dismiss);
    clickOpen();
    await waitFor(() =>
      expect(opening.error).toHaveBeenCalledWith('settings.cindyMake.tasks.errors.unavailable'),
    );
    expect(screen.getByTestId('location').textContent).toBe('/');
    expect(opening.prepend).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    if (state === 'deleted') expect(opening.restore).not.toHaveBeenCalled();
  });

  it.each(['owner', 'remote'] as const)(
    'does not restore after the %s changes during lookup',
    async (change) => {
      let finishGet!: (value: unknown) => void;
      opening.get.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishGet = resolve;
          }),
      );
      renderLink();
      clickOpen();
      await waitFor(() => expect(opening.get).toHaveBeenCalledOnce());
      if (change === 'owner') setDataOwnerGeneration('another-owner');
      else
        vi.mocked(getStickySessionDeviceId).mockImplementation((id) =>
          id === archived.id ? 'remote-device' : undefined,
        );
      await act(async () => finishGet(archived));
      expect(opening.restore).not.toHaveBeenCalled();
      expect(opening.prepend).not.toHaveBeenCalled();
      expect(screen.getByTestId('location').textContent).toBe('/');
    },
  );

  it('does not navigate after the originating card has unmounted', async () => {
    let finishGet!: (value: unknown) => void;
    opening.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishGet = resolve;
        }),
    );
    const dismiss = vi.fn();
    const view = renderLink(dismiss);
    clickOpen();
    await waitFor(() => expect(opening.get).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => finishGet(archived));
    expect(opening.restore).not.toHaveBeenCalled();
    expect(opening.prepend).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });
});
