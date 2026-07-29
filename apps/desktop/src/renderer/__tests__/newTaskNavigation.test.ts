import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDraftPresence: vi.fn(),
  patchDraft: vi.fn(),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  getDraftPresence: mocks.getDraftPresence,
}));

vi.mock('@/state/newMakerDraft', () => ({
  patchDraft: mocks.patchDraft,
}));

import { prepareGlobalNewTask } from '@/features/cc-agent/prepareGlobalNewTask';

beforeEach(() => {
  mocks.getDraftPresence.mockReset();
  mocks.patchDraft.mockReset();
});

describe('prepareGlobalNewTask', () => {
  it('resets only workspace-scoped state for a fresh task', () => {
    mocks.getDraftPresence.mockReturnValue(false);

    expect(prepareGlobalNewTask()).toBe('fresh');
    expect(mocks.patchDraft).toHaveBeenCalledWith({
      workingDir: null,
      remoteHostId: null,
      deviceLinkDeviceId: null,
      deviceLinkDeviceName: null,
      extraDirs: [],
    });
  });

  it('preserves the original workspace when an unsent draft exists', () => {
    mocks.getDraftPresence.mockReturnValue(true);

    expect(prepareGlobalNewTask()).toBe('resume-draft');
    expect(mocks.patchDraft).not.toHaveBeenCalled();
  });
});
