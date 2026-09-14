// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LearnRunPublic } from '../../../../shared/learnTypes';

const useLearnRunMock = vi.hoisted(() => vi.fn());

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

vi.mock('../LearnReviewPanel', () => ({
  LearnReviewPanel: () => null,
}));

import { LearnStatusCard } from '../LearnStatusCard';

afterEach(() => {
  cleanup();
  useLearnRunMock.mockReset();
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
