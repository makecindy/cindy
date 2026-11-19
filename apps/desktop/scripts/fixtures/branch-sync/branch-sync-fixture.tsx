import { useState } from 'react';
import { BranchWorktreeChip } from '../../../src/renderer/components/new-chat/WorktreeChipsRow';
import { ExistingWorktreePicker } from '../../../src/renderer/components/new-chat/ExistingWorktreePicker';
import type { WorktreeMeta } from '../../../src/renderer/lib/worktree.types';
import { mountPage, type UiPageContext } from '../../ui-page/harness';
import type { BranchSyncRequest, BranchSyncStatus } from '../../../src/shared/worktreeBranchSync';
const branches = ['main', 'feature/search', 'origin/main'];
function Fixture({ ctx }: { ctx: UiPageContext }) {
  const [branch, setBranch] = useState('main');
  const [checked, setChecked] = useState(ctx.case !== 'unchecked');
  const [selected, setSelected] = useState<WorktreeMeta | null>(null);
  return (
    <main className="p-6 pt-16">
      <BranchWorktreeChip
        baseRepo="/projects/cindy"
        branchLabel={selected?.branch ?? branch}
        reuseWorktree={!!selected}
        deviceId={ctx.case === 'old-host' ? 'old-pc' : undefined}
        remoteDefaultBranch={ctx.case === 'old-host' ? undefined : 'refs/remotes/origin/main'}
        branches={branches}
        branchesLoading={false}
        branchesFailed={false}
        onRetryBranches={() => {}}
        checked={checked}
        worktreePicker={ctx.case === 'reuse' && checked ? <ExistingWorktreePicker baseRepo="/projects/cindy" selected={selected} onSelect={setSelected} /> : undefined}
        branchSourceSelected
        branchInteractive={!selected}
        onPick={setBranch}
        onOpenRequested={() => {}}
        onToggle={setChecked}
        compact={ctx.case === 'worker'}
        branchOnly={ctx.case === 'worker'}
      />
    </main>
  );
}
mountPage({
  host: (ctx) => {
    const read = (req: BranchSyncRequest): BranchSyncStatus => ({
      branch: req.branch,
      remote: 'origin',
      remoteBranch: 'main',
      remoteOnly: req.branch.startsWith('refs/'),
      ahead: ['diverged', 'ahead'].includes(ctx.case) ? 1 : 0,
      behind: ctx.case === 'ahead' ? 0 : ctx.case === 'default' ? 3 : 1,
      dirtyFiles: ctx.case === 'diverged' ? 2 : ctx.case === 'default' ? 3 : 1,
      checkoutPath: '/projects/cindy',
      ...(ctx.case === 'diverged' || ctx.case === 'conflict' ? { blocked: ctx.case } : {}),
    });
    return {
      deviceLink: {
        invoke: async () => {
          throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] Old host');
        },
      },
      worktreeBranchSyncStatus: async (req: BranchSyncRequest) => read(req),
      worktreeListAll: async () => [{ sessionId: 'owner', name: 'merry-edison', baseRepo: '/projects/cindy',
        path: '/projects/cindy/.cindy-worktrees/merry-edison', branch: 'cindy/merry-edison', sourceBranch: 'main', createdAt: '2026-11-17' }],
      worktreeSyncBranch: async (req: BranchSyncRequest) => ({
        status: { ...read(req), behind: 0 },
        updated: ctx.case === 'ahead' ? 0 : ctx.case === 'worker' ? 1 : 3,
      }),
    };
  },
  render: (ctx) => <Fixture ctx={ctx} />,
});
