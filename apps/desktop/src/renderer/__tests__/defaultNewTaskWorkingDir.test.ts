// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  getDefaultNewTaskWorkingDir,
  setDefaultNewTaskWorkingDir,
} from '@/state/defaultNewTaskWorkingDir';

beforeEach(() => localStorage.clear());

describe('default new task working directory preference', () => {
  it('isolates owners, normalizes a selected directory and clears the override', () => {
    setDefaultNewTaskWorkingDir('owner-a', 'C:\\Projects\\Cindy\\');
    expect(getDefaultNewTaskWorkingDir('owner-a')).toBe('C:/Projects/Cindy');
    expect(getDefaultNewTaskWorkingDir('owner-b')).toBeNull();

    setDefaultNewTaskWorkingDir('owner-a', null);
    expect(getDefaultNewTaskWorkingDir('owner-a')).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('ignores malformed stored paths and refuses relative paths', () => {
    expect(() => setDefaultNewTaskWorkingDir('owner-a', 'relative/project')).toThrow();
    localStorage.setItem('xdt:defaultNewTaskWorkingDir:v1:owner-a', 'relative/project');
    expect(getDefaultNewTaskWorkingDir('owner-a')).toBeNull();
  });

  it('shows the repository root when a managed worktree is selected', () => {
    setDefaultNewTaskWorkingDir('owner-a', '/projects/cindy/.cindy-worktrees/task-a');
    expect(getDefaultNewTaskWorkingDir('owner-a')).toBe('/projects/cindy');
    expect(localStorage.getItem('xdt:defaultNewTaskWorkingDir:v1:owner-a')).toBe('/projects/cindy');
  });
});
