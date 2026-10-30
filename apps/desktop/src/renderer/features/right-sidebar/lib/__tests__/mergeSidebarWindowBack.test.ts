// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mergeSidebarWindowBack } from '../mergeSidebarWindowBack';

const mocks = vi.hoisted(() => ({
  getTabSnapshot: vi.fn(),
}));

vi.mock('../../store', () => ({ getTabSnapshot: mocks.getTabSnapshot }));

describe('mergeSidebarWindowBack', () => {
  let setDetached: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocks.getTabSnapshot.mockReset();
    setDetached = vi.fn().mockResolvedValue({ detached: false, lastOpen: true, open: false });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      rightSidebarWindow: { setDetached },
    };
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('hands a memory-only tab snapshot to the main window', async () => {
    const snapshot = {
      sessionId: 'lead-1',
      tabs: [{ id: 'orca-tab', kind: 'orca-workers', state: {} }],
      activeTabId: 'orca-tab',
      persistable: false,
    };
    mocks.getTabSnapshot.mockReturnValue(snapshot);

    await mergeSidebarWindowBack('lead-1');

    expect(mocks.getTabSnapshot).toHaveBeenCalledWith('lead-1');
    expect(setDetached).toHaveBeenCalledWith(false, { snapshots: [snapshot] });
  });

  it('merges without a handoff when the tabs are persisted', async () => {
    mocks.getTabSnapshot.mockReturnValue(null);

    await mergeSidebarWindowBack('lead-1');

    expect(setDetached).toHaveBeenCalledWith(false, undefined);
  });

  it('surfaces a failed merge to the caller', async () => {
    mocks.getTabSnapshot.mockReturnValue(null);
    setDetached.mockRejectedValueOnce(new Error('merge failed'));

    await expect(mergeSidebarWindowBack(null)).rejects.toThrow('merge failed');
  });
});
