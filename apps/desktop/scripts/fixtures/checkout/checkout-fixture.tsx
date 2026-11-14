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

function Page({
  switching,
  defaultSource,
  syncOff,
}: {
  switching: boolean;
  defaultSource: boolean;
  syncOff: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [source, setSource] = useState(syncOff ? 'main' : defaultSource ? '' : 'release');
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
    let saved = [
      'recover',
      'restored',
      'recover-busy',
      'recover-missing',
      'recover-changed',
    ].includes(ctx.case);
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
        branches: [
          ...(ctx.case === 'operation' ? ['main'] : []),
          'feature',
          'release',
          ...(['busy', 'busy-two', 'operation', 'idle', 'idle-menu', 'recover'].includes(ctx.case)
            ? Array.from({ length: 60 }, (_, i) => `branch-${i}`)
            : []),
          ...(ctx.case === 'operation' ? [] : ['main']),
        ],
        remoteDefaultBranch: 'refs/remotes/origin/main',
      }),
      worktreeSuggestName: async () => ({ name: 'fixture' }),
      worktreeBranchSyncStatus: async () => ({
        branch: 'main',
        remote: 'origin',
        remoteBranch: 'main',
        remoteOnly: false,
        ahead: 0,
        behind: ctx.case === 'sync-off' ? 3 : 0,
        dirtyFiles: 0,
        ...(ctx.case === 'sync-off' ? {} : { blocked: 'no-remote' }),
      }),
      worktreeSyncBranch:
        ctx.case === 'sync-off'
          ? async () => ({
              status: {
                branch: 'main',
                remote: 'origin',
                remoteBranch: 'main',
                remoteOnly: false,
                ahead: 0,
                behind: 0,
                dirtyFiles: 0,
              },
              updated: 3,
            })
          : forbid('worktreeSyncBranch'),
      worktreeCheckout: async (req: { action: string; branch?: string }) => {
        if (ctx.case === 'recover-busy' && req.action === 'restore') return new Promise(() => {});
        if (['recover-missing', 'recover-changed'].includes(ctx.case) && req.action === 'restore') {
          saved = false;
          if (ctx.case === 'recover-changed') current = 'feature';
        }
        // Hold only this in-memory reply so the real row stays in its pending state.
        if (req.action === 'switch' && ctx.case === 'switching') return new Promise(() => {});
        if (
          req.action === 'switch' &&
          ['success', 'saved', 'ordinary', 'carried', 'fetched', 'stashed', 'undone'].includes(
            ctx.case,
          )
        ) {
          current = req.branch!;
          saved = ctx.case === 'saved';
        } else if (req.action === 'restore' && ctx.case === 'restored') saved = false;
        else if (req.action === 'undo' && ctx.case === 'undone') current = 'main';
        else if (
          req.action !== 'status' &&
          !(['recover-missing', 'recover-changed'].includes(ctx.case) && req.action === 'restore')
        )
          return forbid('unexpected fixture mutation')();
        return {
          ...(['recover-missing', 'recover-changed'].includes(ctx.case) && req.action === 'restore'
            ? { blocked: 'changed' }
            : {}),
          ...(req.action === 'switch'
            ? {
                receipt: {
                  id: 'fixture-receipt',
                  from: 'main',
                  to: current,
                  strategy: ctx.case === 'stashed' ? 'stash' : 'carry',
                  hadChanges: ['carried', 'stashed'].includes(ctx.case),
                  ...(ctx.case === 'fetched' ? { fetchedCommits: 3 } : {}),
                  sessions: ['success', 'saved', 'undone'].includes(ctx.case)
                    ? [{ id: 'idle', name: '修复登录页面', running: false }]
                    : [],
                },
              }
            : {}),
          status: {
            current,
            head: 'fixture-head',
            fingerprint: 'fixture-fingerprint',
            files:
              ['dirty', 'conflict', 'many-files', 'dirty-idle', 'stashed'].includes(ctx.case) ||
              (ctx.case === 'carried' && current === 'main')
                ? Array.from({ length: ctx.case === 'many-files' ? 60 : 3 }, (_, i) =>
                    ctx.case === 'many-files' && i === 3
                      ? `src/${'long-directory/'.repeat(12)}component.tsx`
                      : `src/components/example-${i}.tsx`,
                  )
                : [],
            fileDetails: {
              'src/components/example-0.tsx': { added: 1, removed: 1 },
              'src/components/example-1.tsx': { kind: 'new' },
              'src/components/example-2.tsx': { kind: 'deleted' },
            },
            sessions: ['busy', 'busy-two', 'idle', 'idle-menu', 'dirty-idle'].includes(ctx.case)
              ? [
                  {
                    id: 'task-a',
                    name: '修复登录页面',
                    running: ['busy', 'busy-two'].includes(ctx.case),
                  },
                  ...(ctx.case === 'busy-two'
                    ? [{ id: 'task-b', name: 'Update tests', running: true }]
                    : []),
                ]
              : [],
            occupied: ['release'],
            carryAllowed: ctx.case !== 'conflict',
            stashes: saved ? [{ id: 'saved', branch: current }] : [],
            ...(ctx.case.startsWith('error-') && req.branch === 'feature'
              ? {
                  blocked: ctx.case
                    .slice(6)
                    .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
                }
              : {}),
            ...(ctx.case === 'operation' ? { blocked: 'operation' } : {}),
            ...(['busy', 'busy-two'].includes(ctx.case) ? { blocked: 'busy' } : {}),
            ...(ctx.case === 'occupied' && req.branch === 'release' ? { blocked: 'occupied' } : {}),
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
  render: (ctx) => (
    <Page
      switching={ctx.case === 'switching'}
      defaultSource={ctx.case === 'default-source'}
      syncOff={ctx.case === 'sync-off'}
    />
  ),
});
