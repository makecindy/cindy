import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addOrFocusSingletonTab: vi.fn(),
  ensureHydrated: vi.fn(),
  patchTabState: vi.fn(),
  routeSidebarCommand: vi.fn(),
  requestRightSidebarVisibility: vi.fn(),
}));

vi.mock('../../store', () => ({
  addOrFocusSingletonTab: mocks.addOrFocusSingletonTab,
  ensureHydrated: mocks.ensureHydrated,
  patchTabState: mocks.patchTabState,
}));

vi.mock('../detachedSidebarRouting', () => ({
  routeSidebarCommand: mocks.routeSidebarCommand,
}));

vi.mock('../sidebarCommands', () => ({
  requestRightSidebarVisibility: mocks.requestRightSidebarVisibility,
}));

import { openCommitReview } from '../openCommitReview';

// Tier: unit — verifies the detached route handoff and the pinned commit descriptor.
describe('openCommitReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.routeSidebarCommand.mockResolvedValue('attached');
    mocks.addOrFocusSingletonTab.mockResolvedValue({ id: 'review-tab' });
    mocks.ensureHydrated.mockResolvedValue(undefined);
    mocks.patchTabState.mockImplementation(
      async (_sessionId: string, _tabId: string, update: (current: unknown) => unknown) =>
        update({ branchBaseRef: 'origin/main' }),
    );
  });

  it('opens the review tab pinned to the selected commit', async () => {
    await openCommitReview('session-1', 'a'.repeat(40));

    expect(mocks.addOrFocusSingletonTab).toHaveBeenCalledWith('session-1', 'review', null);
    const update = mocks.patchTabState.mock.calls[0]?.[2] as (
      current: unknown,
    ) => Record<string, unknown>;
    expect(update({ branchBaseRef: 'origin/main' })).toEqual({
      branchBaseRef: 'origin/main',
      descriptor: { kind: 'commit', commitOid: 'a'.repeat(40) },
      commitSourcePinned: true,
    });
    expect(mocks.requestRightSidebarVisibility).toHaveBeenCalledWith('open', {
      sessionId: 'session-1',
    });
  });

  it('hands the command to a detached sidebar without touching the local store', async () => {
    mocks.routeSidebarCommand.mockResolvedValue('routed');

    await openCommitReview('session-1', 'b'.repeat(40));

    expect(mocks.addOrFocusSingletonTab).not.toHaveBeenCalled();
    expect(mocks.requestRightSidebarVisibility).toHaveBeenCalledWith('open', {
      sessionId: 'session-1',
    });
  });
});
