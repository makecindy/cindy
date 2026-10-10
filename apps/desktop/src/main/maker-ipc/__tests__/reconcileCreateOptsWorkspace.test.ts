import { describe, expect, it, vi } from 'vitest';
import { reconcileCreateOptsWorkspace } from '../reconcileCreateOptsWorkspace';
import type { MakerSessionCreateOpts } from '../sessionRequest';
import { createWorkingDirectoryRecovery } from '../workingDirectoryRecovery';

describe('reconcileCreateOptsWorkspace', () => {
  it('keeps an independent worktree binding and its selected recovery workspace', async () => {
    const original = '/project/.worktrees/task';
    const fallback = '/dialogues/worktree-recovery/task';
    const recovery = createWorkingDirectoryRecovery(
      { stat: async () => ({ isDirectory: () => true }), mkdir: async () => {} },
      async () => fallback,
    );
    await recovery.recover('task', original, undefined, [], 'unrestored-worktree');
    const row = { workingDir: original, workspaceKind: 'project', remoteHostId: null };
    const opts: MakerSessionCreateOpts = {
      agentKind: 'codex',
      model: 'gpt-5.5',
      workingDir: '/project',
    };

    reconcileCreateOptsWorkspace('task', opts, row, recovery.resolve);

    expect(opts.workingDir).toBe(fallback);
    expect(row.workingDir).toBe(original);
  });

  it('does not reuse the previous project recovery workspace after a move', async () => {
    const recovery = createWorkingDirectoryRecovery(
      { stat: async () => ({ isDirectory: () => true }), mkdir: async () => {} },
      async () => '/dialogues/recovery/old-project',
    );
    await recovery.recover('task', '/old-project', undefined, [], 'unrestored-worktree');
    const opts: MakerSessionCreateOpts = {
      agentKind: 'codex',
      model: 'gpt-5.5',
      workingDir: '/dialogues/recovery/old-project',
      workspaceKind: 'project',
    };

    reconcileCreateOptsWorkspace(
      'task',
      opts,
      {
        workingDir: '/new-project',
        workspaceKind: 'dialogue',
        remoteHostId: null,
      },
      recovery.resolve,
    );

    expect(opts).toMatchObject({ workingDir: '/new-project', workspaceKind: 'dialogue' });
    expect(recovery.peek('task')).toBeNull();
  });

  it.each(['caller', 'database'] as const)(
    'preserves remote paths identified by the %s',
    (source) => {
      const opts: MakerSessionCreateOpts = {
        agentKind: 'codex',
        model: 'gpt-5.5',
        workingDir: '/remote/project',
        remoteHostId: source === 'caller' ? 'host' : undefined,
      };
      const resolve = vi.fn();

      reconcileCreateOptsWorkspace(
        'task',
        opts,
        {
          workingDir: '/local/project',
          workspaceKind: 'project',
          remoteHostId: source === 'database' ? 'host' : null,
        },
        resolve,
      );

      expect(opts.workingDir).toBe('/remote/project');
      expect(resolve).not.toHaveBeenCalled();
    },
  );
});
