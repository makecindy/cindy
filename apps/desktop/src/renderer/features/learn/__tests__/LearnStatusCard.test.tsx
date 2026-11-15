// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LearnRunPublic } from '../../../../shared/learnTypes';

const useLearnRunMock = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({
  getProposalDiff: vi.fn(), apply: vi.fn(), discard: vi.fn(),
}));
const learnApiForMock = vi.hoisted(() => vi.fn());
vi.mock('../learnTransport', () => ({ learnApiFor: learnApiForMock }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../useLearnRun', () => ({
  useLearnRun: useLearnRunMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ sessionId: 'session-1' }),
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: () => undefined,
  remoteProjectsStore: {
    subscribe: () => () => {},
    getDeviceName: () => undefined,
  },
}));

vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => undefined,
}));

vi.mock('@/features/device-link/refreshRemoteSessions', () => ({
  refreshRemoteDeviceSessions: vi.fn(),
}));

import { LearnStatusCard } from '../LearnStatusCard';
import { DiffPanelContainer } from '@/components/diff-panel/DiffPanelShell';

afterEach(() => {
  cleanup();
  useLearnRunMock.mockReset();
  vi.clearAllMocks();
});

// #10435: the card used to mount its real panel inside the unbounded message
// content. Existing tool-loop tests mocked that panel away. Unit tier: open via
// the card in a scrolling subtree, then exercise dismissal and service actions.
describe('LearnStatusCard proposal review', () => {
  function renderReview() {
    learnApiForMock.mockReturnValue(api);
    useLearnRunMock.mockReturnValue({ ...runWithError(undefined), status: 'awaiting-review', error: undefined });
    return render(
      <DiffPanelContainer data-testid="viewport">
        <div data-testid="messages" style={{ position: 'relative', height: 4000 }}>
          <LearnStatusCard data={{ runId: 'run-1' }} contextSessionId="remote-pane-session" />
        </div>
      </DiffPanelContainer>,
    );
  }

  it('opens outside the scrolling messages and closes through each existing affordance', async () => {
    api.getProposalDiff.mockResolvedValue({ targetExists: false, changes: [] });
    renderReview();
    const panel = screen.getByLabelText('learn.review.ariaLabel');
    expect(panel.parentElement).toBe(screen.getByTestId('viewport'));
    expect(screen.getByTestId('messages').contains(panel)).toBe(false);

    for (const dismiss of ['close', 'backdrop', 'escape']) {
      fireEvent.click(screen.getByText('learn.card.review'));
      await waitFor(() => expect((screen.getByText('learn.review.apply') as HTMLButtonElement).disabled).toBe(false));
      expect(panel.getAttribute('aria-hidden')).toBe('false');
      if (dismiss === 'close') fireEvent.click(screen.getByLabelText('diffPanel.shell.closeAria'));
      if (dismiss === 'backdrop') fireEvent.click(panel.previousElementSibling!);
      if (dismiss === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
      expect(panel.getAttribute('aria-hidden')).toBe('true');
    }
    expect(api.apply).not.toHaveBeenCalled();
    expect(api.discard).not.toHaveBeenCalled();
  });

  it('keeps loading and failure reviewable, and routes apply/discard with the card owner', async () => {
    let rejectDiff!: (error: Error) => void;
    api.getProposalDiff.mockImplementationOnce(() => new Promise((_, reject) => { rejectDiff = reject; }));
    api.apply.mockResolvedValue({ name: 'fixture' });
    api.discard.mockResolvedValue(undefined);
    renderReview();
    fireEvent.click(screen.getByText('learn.card.review'));
    expect(screen.getByText('skillhub.diffPanel.loading')).toBeTruthy();
    expect((screen.getByText('learn.review.apply') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { rejectDiff(new Error('fixture unavailable')); });
    expect(screen.getByText('fixture unavailable')).toBeTruthy();
    expect((screen.getByText('learn.review.apply') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('learn.review.discard'));
    await waitFor(() => expect(screen.getByLabelText('learn.review.ariaLabel').getAttribute('aria-hidden')).toBe('true'));

    api.getProposalDiff.mockResolvedValue({ targetExists: false, changes: [] });
    fireEvent.click(screen.getByText('learn.card.review'));
    await waitFor(() => expect((screen.getByText('learn.review.apply') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('learn.review.apply'));
    await waitFor(() => expect(screen.getByLabelText('learn.review.ariaLabel').getAttribute('aria-hidden')).toBe('true'));
    expect(api.apply).toHaveBeenCalledWith({ runId: 'run-1' });
    expect(api.discard).toHaveBeenCalledWith({ runId: 'run-1' });
    expect(learnApiForMock.mock.calls.every(([owner]) => owner === 'remote-pane-session')).toBe(true);
  });
});

function runWithError(toolLoop: unknown): LearnRunPublic {
  return {
    runId: 'run-1',
    status: 'failed',
    sourceKind: 'freetext',
    input: 'learn this',
    createdAt: Date.parse('2026-08-29T00:00:00.000Z'),
    updatedAt: Date.parse('2026-08-29T00:00:00.000Z'),
    usedSessionEvidence: false,
    error: 'missing_required_field: file_path',
    errorReason: 'tool_use_loop_detected',
    toolLoop: toolLoop as LearnRunPublic['toolLoop'],
  };
}

describe('LearnStatusCard tool-loop error projection', () => {
  it('uses localized structured copy and hides the internal terminal message', () => {
    useLearnRunMock.mockReturnValue(runWithError({ kind: 'contract', count: 3 }));

    render(<LearnStatusCard data={{ runId: 'run-1' }} contextSessionId="session-1" />);

    expect(screen.getByText('logic.errors.toolUseLoopDetectedWithCount:3')).toBeTruthy();
    expect(screen.queryByText('missing_required_field: file_path')).toBeNull();
  });

  it('fails closed to generic localized copy for malformed details', () => {
    useLearnRunMock.mockReturnValue(runWithError({ kind: 'contract', count: '3' }));

    render(<LearnStatusCard data={{ runId: 'run-1' }} contextSessionId="session-1" />);

    expect(screen.getByText('logic.errors.toolUseLoopDetected')).toBeTruthy();
    expect(screen.queryByText('missing_required_field: file_path')).toBeNull();
  });
});
