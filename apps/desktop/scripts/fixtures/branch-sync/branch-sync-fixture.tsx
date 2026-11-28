import { useState } from 'react';
import { ChevronDown, FolderGit2 } from 'lucide-react';
import { BranchWorktreeChip } from '../../../src/renderer/components/new-chat/WorktreeChipsRow';
import { mountPage, type UiPageContext } from '../../ui-page/harness';
import type { BranchSyncRequest, BranchSyncStatus } from '../../../src/shared/worktreeBranchSync';
import type { WorkspaceClutterSummary } from '../../../src/shared/worktreeWorkspaceClutter';

const branches = ['main', 'feature/search', 'origin/main'];

function Fixture({ ctx }: { ctx: UiPageContext }) {
  const [branch, setBranch] = useState('main');
  const [checked, setChecked] = useState(ctx.case !== 'unchecked');
  const [resolvedInfo, setResolvedInfo] = useState<string | null>(null);
  const [cleanupInfo, setCleanupInfo] = useState<string | null>(null);

  return (
    <main className="p-5 pt-10">
      <div className="flex items-center justify-end gap-2">
        {ctx.case !== 'worker' && (
          <button
            type="button"
            className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-[var(--create-agent-control-border)] bg-[var(--create-agent-control-bg)] px-3 text-12 font-medium leading-[1.167] text-[var(--create-agent-control-text)]"
          >
            <FolderGit2
              size={13}
              strokeWidth={1.8}
              aria-hidden
              className="shrink-0 text-[var(--create-agent-control-icon)]"
            />
            <span>cindy-src</span>
            <ChevronDown
              size={12}
              strokeWidth={2}
              aria-hidden
              className="shrink-0 text-[var(--create-agent-control-icon)]"
            />
          </button>
        )}
        <BranchWorktreeChip
          baseRepo="/projects/cindy"
          branchLabel={branch}
          deviceId={ctx.case === 'old-host' ? 'old-pc' : undefined}
          remoteDefaultBranch={ctx.case === 'old-host' ? undefined : 'refs/remotes/origin/main'}
          branches={branches}
          branchesLoading={false}
          branchesFailed={false}
          onRetryBranches={() => {}}
          checked={checked}
          branchSourceSelected
          branchInteractive
          onPick={setBranch}
          onOpenRequested={() => {}}
          onToggle={setChecked}
          compact
          branchOnly={ctx.case === 'worker'}
          onResolveBranchConflict={
            ctx.case === 'diverged-conflict'
              ? (info) => setResolvedInfo(`${info.branch} -> ${info.remote}/${info.remoteBranch}`)
              : undefined
          }
          onOrganizeWorkspace={
            ctx.case === 'cleanup-urgent'
              ? (info) =>
                  setCleanupInfo(
                    `${info.baseRepo}:${info.protectedWorktreePaths.length}:${info.scopes.merged}`,
                  )
              : undefined
          }
        />
      </div>
      {resolvedInfo && (
        <p data-testid="resolved-handoff" className="mt-3 text-12 text-[var(--text-secondary)]">
          {resolvedInfo}
        </p>
      )}
      {cleanupInfo && (
        <p data-testid="cleanup-handoff" className="mt-3 text-12 text-[var(--text-secondary)]">
          {cleanupInfo}
        </p>
      )}
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
      ahead: ['diverged', 'diverged-rebase', 'diverged-conflict', 'ahead'].includes(ctx.case)
        ? ctx.case === 'diverged-rebase' || ctx.case === 'diverged-conflict'
          ? 2
          : 1
        : 0,
      behind:
        ctx.case === 'ahead' || ctx.case === 'guide' || ctx.case === 'cleanup-urgent'
          ? 0
          : ['default', 'diverged-rebase', 'diverged-conflict'].includes(ctx.case)
            ? 3
            : 1,
      dirtyFiles:
        ctx.case === 'diverged-rebase' ||
        ctx.case === 'diverged-conflict' ||
        ctx.case === 'guide' ||
        ctx.case === 'cleanup-urgent'
          ? 0
          : ctx.case === 'diverged'
            ? 2
            : ctx.case === 'default'
              ? 3
              : 1,
      checkoutPath: '/projects/cindy',
      ...(ctx.case === 'diverged' || ctx.case === 'conflict' ? { blocked: ctx.case } : {}),
      ...(ctx.case === 'diverged-rebase'
        ? { blocked: 'diverged' as const, divergedConflict: false }
        : {}),
      ...(ctx.case === 'diverged-conflict'
        ? {
            blocked: 'diverged' as const,
            divergedConflict: true,
            divergedConflictFiles: ['src/auth.ts', 'src/sync.ts'],
          }
        : {}),
    });

    const clutterSummary: WorkspaceClutterSummary =
      ctx.case === 'cleanup-urgent'
        ? {
            localBranchCount: 24,
            cindyBranchCount: 16,
            worktreeCount: 7,
            idleWorktreeCount: 6,
            activeWorktreeCount: 1,
            failedCleanupCount: 1,
            protectedWorktreePaths: ['/projects/cindy/.cindy-worktrees/live-task'],
            tier: 'urgent',
          }
        : {
            localBranchCount: 4,
            cindyBranchCount: 1,
            worktreeCount: 1,
            idleWorktreeCount: 0,
            activeWorktreeCount: 1,
            failedCleanupCount: 0,
            protectedWorktreePaths: ['/projects/cindy/.cindy-worktrees/live-task'],
            tier: 'healthy',
          };

    return {
      deviceLink: {
        invoke: async () => {
          throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] Old host');
        },
      },
      worktreeBranchSyncStatus: async (req: BranchSyncRequest) => read(req),
      worktreeSyncBranch: async (req: BranchSyncRequest) => ({
        status: {
          ...read(req),
          behind: 0,
          blocked: undefined,
          divergedConflict: undefined,
        },
        updated: ctx.case === 'ahead' ? 0 : ctx.case === 'worker' ? 1 : 3,
        ...(req.strategy === 'rebase' ? { syncedMode: 'rebase' as const } : {}),
      }),
      worktreeWorkspaceClutterSummary: async () => clutterSummary,
    };
  },
  render: (ctx) => <Fixture ctx={ctx} />,
});
