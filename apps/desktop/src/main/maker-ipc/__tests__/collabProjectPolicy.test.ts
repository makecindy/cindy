import { describe, expect, it } from 'vitest';

import { assertCollabProjectEnabled } from '../collabProjectPolicy.js';

describe('assertCollabProjectEnabled', () => {
  const project = {
    workingDir: 'C:\\projects\\cindy',
    workspaceKind: 'project',
    remoteHostId: null,
  } as const;

  it('allows an enabled local project', () => {
    expect(() => assertCollabProjectEnabled(project, () => true)).not.toThrow();
  });

  it('rejects a project with collab disabled', () => {
    expect(() => assertCollabProjectEnabled(project, () => false)).toThrow(
      '[PRECONDITION_FAILED] collaboration is disabled for this project',
    );
  });

  it('trims the working directory before checking the project policy', () => {
    let checkedPath: string | undefined;
    expect(() =>
      assertCollabProjectEnabled(
        { ...project, workingDir: '  C:\\projects\\cindy  ' },
        (_pluginId, workingDir) => {
          checkedPath = workingDir;
          return true;
        },
      ),
    ).not.toThrow();
    expect(checkedPath).toBe('C:\\projects\\cindy');
  });

  it('rejects dialogue and remote sessions before checking plugin policy', () => {
    const isPluginEnabled = () => {
      throw new Error('must not query project policy for an ineligible session');
    };

    expect(() =>
      assertCollabProjectEnabled(
        { workingDir: null, workspaceKind: 'dialogue', remoteHostId: null },
        isPluginEnabled,
      ),
    ).toThrow('[PRECONDITION_FAILED] collaboration requires an enabled local project session');

    expect(() =>
      assertCollabProjectEnabled(
        { ...project, remoteHostId: 'remote-device' },
        isPluginEnabled,
      ),
    ).toThrow('[PRECONDITION_FAILED] collaboration requires an enabled local project session');
  });
});
