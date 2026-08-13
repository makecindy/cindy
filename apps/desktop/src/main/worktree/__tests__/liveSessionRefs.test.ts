import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    status: string | null;
    workspaceKind: 'project' | 'dialogue' | null;
    workingDir: string | null;
    worktreePath: string | null;
  }>,
}));

vi.mock('../../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => harness.rows,
        }),
      }),
    },
  }),
}));

import { loadLiveSessionPathKeys, pathKey } from '../liveSessionRefs';

describe('live session path references', () => {
  beforeEach(() => {
    harness.rows.length = 0;
  });

  it('excludes dialogue history from capability retention when requested', async () => {
    harness.rows.push(
      {
        id: 'project-session',
        status: 'active',
        workspaceKind: 'project',
        workingDir: '/repo/project',
        worktreePath: '/repo/project/.cindy-worktrees/live',
      },
      {
        id: 'dialogue-session',
        status: 'active',
        workspaceKind: 'dialogue',
        workingDir: '/repo/historical-project',
        worktreePath: '/repo/historical-project/.cindy-worktrees/stale',
      },
    );

    const keys = await loadLiveSessionPathKeys({ excludeDialoguePaths: true });

    expect(keys).toEqual(
      new Set([pathKey('/repo/project'), pathKey('/repo/project/.cindy-worktrees/live')]),
    );
  });

  it('keeps dialogue paths by default for conservative deletion guards', async () => {
    harness.rows.push({
      id: 'dialogue-session',
      status: 'active',
      workspaceKind: 'dialogue',
      workingDir: '/repo/historical-project',
      worktreePath: '/repo/historical-project/.cindy-worktrees/stale',
    });

    const keys = await loadLiveSessionPathKeys();

    expect(keys).toEqual(
      new Set([
        pathKey('/repo/historical-project'),
        pathKey('/repo/historical-project/.cindy-worktrees/stale'),
      ]),
    );
  });
});
