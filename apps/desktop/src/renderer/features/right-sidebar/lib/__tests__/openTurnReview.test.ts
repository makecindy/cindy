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

import { openTurnReview } from '../openTurnReview';

describe('openTurnReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.routeSidebarCommand.mockResolvedValue('attached');
    mocks.addOrFocusSingletonTab.mockResolvedValue({ id: 'review-tab' });
    mocks.ensureHydrated.mockResolvedValue(undefined);
    mocks.patchTabState.mockImplementation(
      async (_sessionId: string, _tabId: string, update: (current: unknown) => unknown) =>
        update({
          diffsExpanded: false,
          branchBaseRef: 'origin/release',
          turnTarget: { legacy: true },
        }),
    );
  });

  it('writes a descriptor and independent jump target into the singleton review tab', async () => {
    await openTurnReview('worker-session', ['set-1'], {
      hostSessionId: 'lead-session',
      selectedDiffId: 'unstaged:src/a.ts',
      selectedPath: 'src/a.ts',
      requestNonce: 12,
    });

    expect(mocks.ensureHydrated).toHaveBeenCalledWith('lead-session');
    expect(mocks.addOrFocusSingletonTab).toHaveBeenCalledWith('lead-session', 'review', null);
    const update = mocks.patchTabState.mock.calls[0]?.[2] as (
      current: unknown,
    ) => Record<string, unknown>;
    expect(
      update({
        diffsExpanded: false,
        branchBaseRef: 'origin/release',
        turnTarget: { legacy: true },
      }),
    ).toEqual({
      diffsExpanded: false,
      branchBaseRef: 'origin/release',
      descriptor: {
        kind: 'turn-set',
        changeSetIds: ['set-1'],
        targetSessionId: 'worker-session',
      },
      messageSnapshot: {
        kind: 'turn-set',
        changeSetIds: ['set-1'],
        targetSessionId: 'worker-session',
      },
      jumpTarget: {
        diffId: 'unstaged:src/a.ts',
        path: 'src/a.ts',
        nonce: 12,
      },
    });
  });
});
