import { useEffect, useState } from 'react';
import {
  addSessionAttention,
  clearSessionAttention,
} from '../../../src/renderer/lib/sessionAttentionStore';
import {
  markWorkerAttention,
  clearWorkerAttention,
} from '../../../src/renderer/features/cc-agent/lib/workerAttentionStore';
import {
  RolePillDropdown,
  WorkerListToolbar,
} from '../../../src/renderer/features/cc-agent/RolePillDropdown';
import type { WorkerInfo } from '../../../src/renderer/features/cc-agent/hooks/useWorkers';
import { mountPage } from '../../ui-page/harness';
import {
  WorkerProjectField,
  useWorkerProjectSelection,
} from '../../../src/renderer/features/cc-agent/WorkerProjectField';
import type {
  WorkerProjectContext,
  WorkerProjectInfo,
} from '../../../src/shared/orca-worker-project';

const inherited: WorkerProjectInfo = {
  directory: '/projects/cindy/.cindy-worktrees/worker-picker',
  baseRepo: '/projects/cindy',
  branch: 'feat/worker-project-picker',
  headState: 'branch',
  exists: true,
  dirty: true,
  isWorktree: true,
};
const projects = [
  'cindy',
  'design-system',
  'mobile-app',
  'website',
  'notes',
  'missing-project',
].map((name) => ({
  path: `/projects/${name}`,
  name,
  description: `/projects/${name}`,
  missing: name === 'missing-project',
}));
function Fixture() {
  const selection = useWorkerProjectSelection(true, 'fixture-lead', true);
  return (
    <main className="mx-auto w-full max-w-[440px] p-4">
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
        <WorkerProjectField selection={selection} disabled={false} />
      </div>
    </main>
  );
}
const workers: WorkerInfo[] = ['frontend', 'reviewer'].map((role, index) => ({
  workerId: role,
  sessionId: role,
  role,
  agent: 'codex',
  model: 'gpt-5',
  effort: 'high',
  label: null,
  status: 'idle',
  focused: index === 0,
  idleSince: null,
}));
function WorkersFixture() {
  return (
    <main className="mx-auto w-full max-w-[440px] p-4">
      <RolePillDropdown
        worker={workers[0]}
        workers={workers}
        selectedWorkerId="frontend"
        activeWorkerCount={2}
        onSwitchFocus={() => {}}
        onArchiveWorker={() => {}}
      />
    </main>
  );
}
/** 真实 store 驱动提醒，Worker 运行状态始终 idle，以覆盖原来的漏报。 */
function AttentionFixture({ kind }: { kind: 'error' | 'awaiting' | 'done' }) {
  useEffect(() => {
    if (kind === 'done') markWorkerAttention('reviewer');
    else addSessionAttention('reviewer', kind);
    return () => {
      clearSessionAttention('reviewer', { intent: 'explicit' });
      clearWorkerAttention('reviewer');
    };
  }, [kind]);
  return (
    <main className="mx-auto w-full max-w-[480px] space-y-12 p-5">
      <section data-testid="attention-tabs">
        <WorkerListToolbar
          worker={workers[0]}
          workers={workers}
          selectedWorkerId="frontend"
          activeWorkerCount={2}
          softLimit={5}
          hardLimit={8}
          clearAttentionWhenVisible={false}
          onSwitchFocus={() => {}}
          onArchiveWorker={() => {}}
          onOpenCreate={() => {}}
          onOpenSettings={() => {}}
        />
      </section>
      <section data-testid="attention-dropdown">
        <RolePillDropdown
          worker={workers[0]}
          workers={workers}
          selectedWorkerId="frontend"
          activeWorkerCount={2}
          onSwitchFocus={() => {}}
          onArchiveWorker={() => {}}
        />
      </section>
    </main>
  );
}
const longNameWorkers: WorkerInfo[] = [
  { ...workers[0], workerId: 'long-cjk', sessionId: 'long-cjk', role: '超長中文角色名稱'.repeat(4), focused: false },
  { ...workers[0], workerId: 'long-latin', sessionId: 'long-latin', role: 'W'.repeat(32), focused: false },
  ...workers.map((worker) => ({ ...worker, focused: false })),
];
function LongNamesFixture() {
  const [selected, setSelected] = useState('long-latin');
  const [action, setAction] = useState('');
  useEffect(() => {
    addSessionAttention('long-cjk', 'error');
    addSessionAttention('long-latin', 'awaiting');
    return () => {
      clearSessionAttention('long-cjk', { intent: 'explicit' });
      clearSessionAttention('long-latin', { intent: 'explicit' });
    };
  }, []);
  return (
    <main className="p-4">
      <section className="flex w-[280px] max-w-full items-start gap-1 border border-[var(--border-default)] p-1" data-testid="long-names-sidebar">
        <WorkerListToolbar
          worker={longNameWorkers.find((worker) => worker.workerId === selected)!}
          workers={longNameWorkers}
          selectedWorkerId={selected}
          activeWorkerCount={longNameWorkers.length}
          softLimit={5}
          hardLimit={8}
          onSwitchFocus={setSelected}
          onArchiveWorker={(id) => setAction(`archive:${id}`)}
          onEditWorker={(id) => setAction(`edit:${id}`)}
          onOpenCreate={() => {}}
        />
      </section>
      <output data-testid="long-names-action">{action}</output>
    </main>
  );
}
void mountPage({
  host: (ctx) => ({
    notificationMarkSessionAttention: async () => {},
    notificationClearSessionAttention: async () => {},
    showOpenDirectoryDialog: async () => {
      if (ctx.case === 'same-repo') return { canceled: false, path: '/projects/cindy' };
      throw new Error('fixture dialog unavailable');
    },
    localDb: {
      orcaWorkflows: {
        projectLabel: async (id: string) =>
          id === 'frontend' ? { name: 'design-system', path: '/projects/design-system' } : null,
        projectContext: async (
          _id: string,
          directory?: string,
        ): Promise<WorkerProjectContext | WorkerProjectInfo> => {
          const lead =
            ctx.case === 'missing'
              ? {
                  ...inherited,
                  directory: '/projects/missing-project',
                  baseRepo: null,
                  branch: null,
                  exists: false,
                  isWorktree: false,
                  dirty: false,
                }
              : ctx.case === 'dialogue'
                ? {
                    ...inherited,
                    baseRepo: null,
                    branch: null,
                    directory: '/tasks/dialogue',
                    isWorktree: false,
                  }
                : ctx.case === 'empty'
                  ? {
                      ...inherited,
                      directory: '/projects/cindy',
                      branch: null,
                      headState: 'unborn' as const,
                      isWorktree: false,
                    }
                  : ctx.case === 'detached'
                    ? {
                        ...inherited,
                        branch: 'abcdef0123456789abcdef0123456789abcdef0123',
                        headState: 'detached' as const,
                      }
                    : inherited;
          const selected = directory
            ? {
                ...inherited,
                directory,
                baseRepo: directory,
                branch: ctx.case === 'detached' ? lead.branch : 'main',
                headState: ctx.case === 'detached' ? lead.headState : ('branch' as const),
                isWorktree: false,
              }
            : lead;
          if (directory) return selected;
          return {
            recordedDirectory: ctx.case === 'dialogue' ? lead.directory : '/projects/cindy',
            inherited: lead,
            selected,
            dialogue: ctx.case === 'dialogue',
            projects,
          };
        },
      },
    },
    worktreeBranchSyncStatus: async ({ branch }: { branch: string }) => ({
      branch,
      remote: 'origin',
      remoteBranch: branch,
      remoteOnly: false,
      ahead: 0,
      behind: 3,
      dirtyFiles: 2,
      checkoutPath: inherited.directory,
    }),
    worktreeSyncBranch: async ({ branch }: { branch: string }) => ({
      updated: 3,
      status: {
        branch,
        remote: 'origin',
        remoteBranch: branch,
        remoteOnly: false,
        ahead: 0,
        behind: 0,
        dirtyFiles: 2,
      },
    }),
    getNewMakerWorktreeBranchPreference: async (baseRepo: string) =>
      ['/projects/design-system', '/projects/cindy'].includes(baseRepo)
        ? { baseRepo, sourceBranch: 'release/v2', revision: 1 }
        : null,
    worktreeListBranches: async () => ({
      remoteDefaultBranch: 'refs/remotes/origin/main',
      branches: ['main', 'feat/worker-project-picker', 'release/v2'],
    }),
  }),
  render: (ctx) => {
    if (ctx.case === 'rows-long-names') {
      localStorage.setItem('orca-worker-list-layout-v1', 'rows');
      return <LongNamesFixture />;
    }
    if (ctx.case.startsWith('attention-')) {
      localStorage.setItem('orca-worker-list-layout-v1', 'tabs');
      return (
        <AttentionFixture
          kind={
            ctx.case === 'attention-error'
              ? 'error'
              : ctx.case === 'attention-awaiting'
                ? 'awaiting'
                : 'done'
          }
        />
      );
    }
    return ctx.case === 'workers' ? <WorkersFixture /> : <Fixture />;
  },
});
