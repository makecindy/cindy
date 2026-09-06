// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerAttentionSnapshot } from '@/features/cc-agent/lib/workerAttentionStore';

const mocks = vi.hoisted(() => ({
  attention: new Map() as WorkerAttentionSnapshot,
  workers: [] as Array<{ workerId: string }>,
  attentionDot: vi.fn(() => null),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/features/cc-agent/hooks/workerProjectionStore', () => ({
  useWorkerProjection: () => ({ workers: mocks.workers }),
}));

vi.mock('@/features/cc-agent/lib/workerAttentionStore', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/features/cc-agent/lib/workerAttentionStore')
  >();
  return {
    ...actual,
    useWorkerAttentionSnapshot: () => mocks.attention,
  };
});

vi.mock('@/components/sidebar/AttentionDot', () => ({
  AttentionDot: mocks.attentionDot,
}));

import { OrcaWorkersAttentionIcon } from '@/features/right-sidebar/plugins/orca-workers/OrcaWorkersAttentionIcon';

describe('OrcaWorkersAttentionIcon reason semantics', () => {
  beforeEach(() => {
    mocks.attention = new Map();
    mocks.workers = [];
    mocks.attentionDot.mockClear();
  });

  afterEach(cleanup);

  it('prioritizes permission awaiting over done unread', () => {
    mocks.workers = [{ workerId: 'done-worker' }, { workerId: 'permission-worker' }];
    mocks.attention = new Map([
      ['done-worker', [{ kind: 'done' }]],
      ['permission-worker', [{ kind: 'permission', requestId: 'permission-1' }]],
    ]);

    render(createElement(OrcaWorkersAttentionIcon, { sessionId: 'lead-1', active: false }));

    expect(screen.getByLabelText('agentIsland.native.awaitingPermission')).toBeTruthy();
    expect(mocks.attentionDot).toHaveBeenCalledWith(
      expect.objectContaining({ size: 6, tone: 'awaiting' }),
      undefined,
    );
  });

  it('uses done semantics when no permission is pending', () => {
    mocks.workers = [{ workerId: 'done-worker' }];
    mocks.attention = new Map([['done-worker', [{ kind: 'done' }]]]);

    render(createElement(OrcaWorkersAttentionIcon, { sessionId: 'lead-1', active: false }));

    expect(screen.getByLabelText('orca.rolePill.unread')).toBeTruthy();
    expect(mocks.attentionDot).toHaveBeenCalledWith(
      expect.objectContaining({ size: 6, tone: 'done' }),
      undefined,
    );
  });

  it('hides aggregate attention while the Worker panel is active', () => {
    mocks.workers = [{ workerId: 'permission-worker' }];
    mocks.attention = new Map([
      ['permission-worker', [{ kind: 'permission', requestId: 'permission-1' }]],
    ]);

    render(createElement(OrcaWorkersAttentionIcon, { sessionId: 'lead-1', active: true }));

    expect(screen.queryByLabelText('agentIsland.native.awaitingPermission')).toBeNull();
    expect(mocks.attentionDot).not.toHaveBeenCalled();
  });
});
