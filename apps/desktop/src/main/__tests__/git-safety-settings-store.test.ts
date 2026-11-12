import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cindy-git-safety-settings-test' },
}));

import { __testing } from '../maker-host/git-safety-settings-store';

describe('git safety settings migration', () => {
  it('defaults new installs to existing Git projects', () => {
    expect(__testing.normalize({})).toEqual({ mode: 'existing-git' });
  });

  it('preserves the old disabled boolean', () => {
    expect(__testing.normalize({ autoSnapshotEnabled: false })).toEqual({ mode: 'off' });
  });

  it('preserves the old enabled boolean including empty-project bootstrap', () => {
    expect(__testing.normalize({ autoSnapshotEnabled: true })).toEqual({ mode: 'all-projects' });
  });

  it('accepts each new mode', () => {
    expect(__testing.normalize({ mode: 'off' })).toEqual({ mode: 'off' });
    expect(__testing.normalize({ mode: 'existing-git' })).toEqual({ mode: 'existing-git' });
    expect(__testing.normalize({ mode: 'all-projects' })).toEqual({ mode: 'all-projects' });
  });

  it('keeps an explicit selection of the current default mode', () => {
    expect(
      __testing.mergeOverrides({
        patch: { mode: 'existing-git' },
        next: { mode: 'existing-git' },
        overrides: { mode: 'off' },
      }),
    ).toEqual({ mode: 'existing-git' });
  });
});
