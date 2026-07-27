import { afterEach, describe, expect, it } from 'vitest';

import { getLastWorkingDir, setLastWorkingDir } from '../state/lastWorkingDir';

describe('lastWorkingDir', () => {
  afterEach(() => setLastWorkingDir(null));

  it('preserves the active Cindy-managed worktree for cwd-scoped consumers', () => {
    setLastWorkingDir('D:\\projects\\cindy\\.cindy-worktrees\\task-123\\apps\\desktop');
    expect(getLastWorkingDir()).toBe(
      'D:/projects/cindy/.cindy-worktrees/task-123/apps/desktop',
    );

    setLastWorkingDir('/projects/cindy/.xdt-worktrees/task-456/apps/desktop');
    expect(getLastWorkingDir()).toBe('/projects/cindy/.xdt-worktrees/task-456/apps/desktop');
  });

  it('keeps ordinary project directories as the selected project scope', () => {
    setLastWorkingDir('D:\\projects\\cindy\\');
    expect(getLastWorkingDir()).toBe('D:/projects/cindy');
  });
});
