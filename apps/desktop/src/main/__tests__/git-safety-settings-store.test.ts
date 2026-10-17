import { promises as fs, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cindy-git-safety-settings-test' },
}));

import {
  __testing,
  hasDeclinedNonEmptyProjectGit,
  recordDeclinedNonEmptyProjectGit,
  resetGitSafetySettings,
} from '../maker-host/git-safety-settings-store';

const canSymlink = (() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-git-consent-probe-'));
  try {
    mkdirSync(path.join(dir, 'project'));
    symlinkSync(path.join(dir, 'project'), path.join(dir, 'alias'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe('git safety settings migration', () => {
  it('defaults new installs to existing Git projects', () => {
    expect(__testing.normalize({})).toEqual({ mode: 'existing-git', declinedNonEmptyProjects: [] });
  });

  it('preserves the old disabled boolean', () => {
    expect(__testing.normalize({ autoSnapshotEnabled: false })).toEqual({
      mode: 'off',
      declinedNonEmptyProjects: [],
    });
  });

  it('preserves the old enabled boolean including empty-project bootstrap', () => {
    expect(__testing.normalize({ autoSnapshotEnabled: true })).toEqual({
      mode: 'all-projects',
      declinedNonEmptyProjects: [],
    });
  });

  it('accepts each new mode', () => {
    expect(__testing.normalize({ mode: 'off' })).toEqual({
      mode: 'off',
      declinedNonEmptyProjects: [],
    });
    expect(__testing.normalize({ mode: 'existing-git' })).toEqual({
      mode: 'existing-git',
      declinedNonEmptyProjects: [],
    });
    expect(__testing.normalize({ mode: 'all-projects' })).toEqual({
      mode: 'all-projects',
      declinedNonEmptyProjects: [],
    });
  });

  it('keeps an explicit selection of the current default mode', () => {
    expect(
      __testing.mergeOverrides({
        patch: { mode: 'existing-git' },
        next: { mode: 'existing-git', declinedNonEmptyProjects: [] },
        overrides: { mode: 'off' },
      }),
    ).toEqual({ mode: 'existing-git' });
  });

  it('persists project-specific declines without changing the selected mode', () => {
    expect(
      __testing.mergeOverrides({
        patch: { declinedNonEmptyProjects: ['/example/project'] },
        next: { mode: 'all-projects', declinedNonEmptyProjects: ['/example/project'] },
        overrides: { mode: 'all-projects' },
      }),
    ).toEqual({ mode: 'all-projects', declinedNonEmptyProjects: ['/example/project'] });
  });

  it.skipIf(!canSymlink)('recognizes a declined project through a symlink', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-git-consent-'));
    try {
      const project = path.join(dir, 'project');
      const alias = path.join(dir, 'alias');
      await fs.mkdir(project);
      await fs.symlink(project, alias, 'dir');
      resetGitSafetySettings();
      await recordDeclinedNonEmptyProjectGit(alias);
      expect(hasDeclinedNonEmptyProjectGit(project)).toBe(true);
    } finally {
      resetGitSafetySettings();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
