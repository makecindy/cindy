import { useState } from 'react';
import { mountPage, forbid } from '../../ui-page/harness';
import { WorktreeChipsRow } from '../../../src/renderer/components/new-chat/WorktreeChipsRow';
import { Tooltip } from '../../../src/renderer/components/ui/tooltip';

function Page() {
  const [enabled, setEnabled] = useState(false);
  const [source, setSource] = useState('release');
  return (
    <Tooltip.Provider>
      <div className="p-6 text-foreground" data-ui-page-subject>
        <WorktreeChipsRow
          cwd="/fixture"
          enabled={enabled}
          onEnabledChange={setEnabled}
          sourceBranch={source}
          onSourceBranchChange={setSource}
          variant="advancedOnly"
          compact
        />
      </div>
    </Tooltip.Provider>
  );
}
void mountPage({
  host: (ctx) => ({
    worktreeDetectCwd: async () => ({
      gitInstalled: true,
      isGitRepo: true,
      isInsideWorktree: false,
      currentBranch: 'main',
      repoRoot: '/fixture',
      supportsCheckout: true,
    }),
    worktreeListBranches: async () => ({
      current: 'main',
      branches: ['main', 'feature', 'release'],
      remoteDefaultBranch: 'refs/remotes/origin/main',
    }),
    worktreeSuggestName: async () => ({ name: 'fixture' }),
    worktreeBranchSyncStatus: async () => ({
      branch: 'main',
      remoteOnly: false,
      ahead: 0,
      behind: 0,
      dirtyFiles: 0,
      blocked: 'no-remote',
    }),
    worktreeSyncBranch: forbid('worktreeSyncBranch'),
    worktreeCheckout: async (req: { action: string; branch?: string }) => {
      if (req.action !== 'status') return forbid('checkout mutation')();
      return {
        status: {
          current: 'main',
          head: 'fixture-head',
          fingerprint: 'fixture-fingerprint',
          files: ['dirty', 'conflict'].includes(ctx.case)
            ? Array.from({ length: 30 }, (_, i) => `src/components/example-${i}.tsx`)
            : [],
          sessions: ['busy', 'idle', 'dirty'].includes(ctx.case)
            ? [{ id: 'task-a', name: '修复登录页面', running: ctx.case === 'busy' }]
            : [],
          occupied: ['release'],
          carryAllowed: ctx.case !== 'conflict',
          stashes: [],
          ...(ctx.case === 'busy' ? { blocked: 'busy' } : {}),
          ...(ctx.case === 'ignored' && req.branch === 'feature'
            ? {
                blocked: 'conflict',
                carryAllowed: false,
                ignoredCollision: { branch: 'feature', paths: ['private/collision', 'other-file'] },
              }
            : {}),
        },
      };
    },
  }),
  render: () => <Page />,
});
