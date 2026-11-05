import { useState } from 'react';
import { mountPage, forbid } from '../../ui-page/harness';
import { WorktreeChipsRow } from '../../../src/renderer/components/new-chat/WorktreeChipsRow';
import { ToastContainer } from '../../../src/renderer/components/ui/toast/ToastContainer';
import { Button } from '../../../src/renderer/components/ui/button';
import { Tooltip } from '../../../src/renderer/components/ui/tooltip';

// The isolated fixture origin lacks secure-context randomUUID. These IDs only
// identify in-memory checkout responses; no repository is opened or changed.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

function Page({ switching }: { switching: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [source, setSource] = useState('release');
  return (
    <Tooltip.Provider>
      <div className="p-4 pt-44 text-foreground" data-ui-page-subject>
        <div
          className={`flex items-center gap-2${switching ? ' justify-end' : ''}`}
          data-testid="checkout-controls-row"
        >
          <Button size="sm" variant="secondary" className="h-[30px]" data-testid="checkout-project">
            1-basic
          </Button>
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
        <textarea
          aria-label="fixture input"
          data-testid="checkout-input"
          className="mt-3 h-24 w-full rounded-xl border border-border bg-background p-3"
          readOnly
          value=""
        />
      </div>
      <ToastContainer />
    </Tooltip.Provider>
  );
}
void mountPage({
  host: (ctx) => {
    let current = 'main';
    let saved = false;
    return {
      worktreeDetectCwd: async () => ({
        gitInstalled: true,
        isGitRepo: true,
        isInsideWorktree: false,
        currentBranch: 'main',
        repoRoot: '/fixture',
        supportsCheckout: true,
      }),
      worktreeListBranches: async () => ({
        current,
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
        // Hold only this in-memory reply so the real row stays in its pending state.
        if (req.action === 'switch' && ctx.case === 'switching') return new Promise(() => {});
        if (req.action === 'switch' && ['success', 'saved'].includes(ctx.case)) {
          current = req.branch!;
          saved = ctx.case === 'saved';
        } else if (req.action !== 'status') return forbid('unexpected fixture mutation')();
        return {
          ...(req.action === 'switch'
            ? {
                receipt: {
                  id: 'fixture-receipt',
                  from: 'main',
                  to: current,
                  strategy: 'carry',
                  hadChanges: false,
                  sessions: [{ id: 'idle', name: '修复登录页面', running: false }],
                },
              }
            : {}),
          status: {
            current,
            head: 'fixture-head',
            fingerprint: 'fixture-fingerprint',
            files: ['dirty', 'conflict'].includes(ctx.case)
              ? Array.from({ length: 30 }, (_, i) => `src/components/example-${i}.tsx`)
              : [],
            sessions: ['busy', 'idle', 'dirty', 'worktree'].includes(ctx.case)
              ? [
                  {
                    id: 'task-a',
                    name: '修复登录页面',
                    running: ['busy', 'worktree'].includes(ctx.case),
                  },
                ]
              : [],
            occupied: ['release'],
            carryAllowed: ctx.case !== 'conflict',
            stashes: saved ? [{ id: 'saved', branch: current }] : [],
            ...(['busy', 'worktree'].includes(ctx.case) ? { blocked: 'busy' } : {}),
            ...(ctx.case === 'ignored' && req.branch === 'feature'
              ? {
                  blocked: 'conflict',
                  carryAllowed: false,
                  ignoredCollision: {
                    branch: 'feature',
                    paths: ['private/collision', 'other-file'],
                  },
                }
              : {}),
          },
        };
      },
    };
  },
  render: (ctx) => <Page switching={ctx.case === 'switching'} />,
});
