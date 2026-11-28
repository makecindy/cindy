import { useMemo, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { mountPage, subscription } from '../../ui-page/harness';
import { WorktreeProvider } from '../../../src/renderer/contexts/WorktreeContext';
import { OrcaRemoteLeadBadge } from '../../../src/renderer/features/cc-agent/OrcaRemoteLeadBadge';
import { SessionOriginChip } from '../../../src/renderer/features/cc-agent/SessionOriginChip';
import { SessionItem } from '../../../src/renderer/features/cc-agent/sidebar/SessionItem';
import { SessionCard } from '../../../src/renderer/features/cc-agent/sidebar/SessionCard';
import { SidebarFilterPopover } from '../../../src/renderer/features/cc-agent/sidebar/SidebarFilterPopover';
import { useSidebarFilter } from '../../../src/renderer/features/cc-agent/hooks/useSidebarFilter';
import { filterSidebarTasks } from '../../../src/renderer/features/cc-agent/lib/sidebarTaskFilters';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';

const snapshot = {
  dataOwnerId: 'fixture',
  ownerGeneration: 1,
  pinnedOrderIsAuthoritative: true,
  pinnedOrder: [],
  hiddenProjectKeys: [],
  hiddenMainViewGhostIds: [],
};

const base = {
  userId: '',
  workingDir: '/repo/cindy',
  projectDir: '/repo/cindy',
  workspaceKind: 'project' as const,
  model: 'claude-sonnet-4-6',
  effort: 'high' as const,
  permissionMode: 'ask' as const,
  status: 'active' as const,
  sdkSessionId: null,
  totalTokenUsage: 0,
  totalCostUsd: 0,
  contextTokens: 0,
  contextWindow: 0,
  fastMode: false,
  clearedAt: null,
  pinnedAt: null,
  userSendAt: '2026-11-26T10:00:00.000Z',
  lastActivityAt: '2026-11-26T10:00:00.000Z',
  agentKind: 'cc' as const,
  source: 'desktop' as const,
  orcaRole: null,
  parentSessionId: null,
  forkedAtMessageId: null,
  worktreePath: null,
  usedProjectContext: false,
  extraDirs: [],
  createdAt: '2026-11-26T10:00:00.000Z',
  updatedAt: '2026-11-26T10:00:00.000Z',
  _count: { messages: 4 },
};

const sampleTasks: Session[] = [
  {
    ...base,
    id: 'user-task',
    title: '优化侧边栏任务筛选体验',
    preview: '普通用户新建任务，侧边栏不增加额外来源图标。',
  },
  {
    ...base,
    id: 'task-created',
    title: '跟进 PR #1428 边界修复',
    preview: '由主任务经 send_to_session 打开的独立跟进任务。',
    createdBySession: {
      kind: 'session',
      sessionId: 'user-task',
      title: '发布前总检',
    },
  },
  {
    ...base,
    id: 'orca-remote',
    title: 'Windows 端打包与日志核验',
    preview: '来自另一台电脑协同 Lead 派发的远端 Worker。',
    orcaRemoteLead: {
      leadDeviceId: 'office-mac',
      leadDeviceName: 'Office Mac',
      leadSessionId: 'lead-1',
      leadTitle: '版本发布协同',
      workerLabel: 'worker-win',
    },
  },
  {
    ...base,
    id: 'legacy-sched',
    title: '[Schedule] 夜间依赖巡检',
    preview: '历史 [Schedule] 前缀自动化任务。',
  },
  {
    ...base,
    id: 'bot-routine',
    title: '晨间 Issue 汇总',
    preview: '伙伴例行任务，随「隐藏自动化任务」一并收起。',
    source: 'bot',
    companion: { id: 'cindy-default', role: 'routine', routineId: 'morning-digest' },
  },
];

const emptyCreators = new Map<string, ReadonlySet<string>>();
const noop = () => {};

function Fixture() {
  const hidden = useMemo(() => new Set<string>(), []);
  const filter = useSidebarFilter(hidden, snapshot, []);
  const [open, setOpen] = useState(false);
  const visible = useMemo(
    () => filterSidebarTasks(sampleTasks, filter, emptyCreators),
    [filter],
  );

  return (
    <MemoryRouter>
      <WorktreeProvider>
        <div className="flex h-full bg-[var(--content-area)] text-foreground">
        <aside className="flex w-[312px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-3">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-12 font-semibold text-[var(--text-secondary)]">任务列表</span>
            <SidebarFilterPopover
              filter={filter}
              allKnownProjects={[]}
              open={open}
              onOpenChange={setOpen}
            />
          </div>
          <div className="space-y-0.5" data-testid="text-rows">
            {visible.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isActive={session.id === 'task-created'}
                isRunning={false}
                hasAttentionNotification={false}
                onClick={noop}
                onAction={noop}
                onRename={noop}
                onTogglePin={noop}
              />
            ))}
          </div>
          <div className="mt-3 border-t border-sidebar-border pt-2" data-testid="list-rows">
            {visible.slice(0, 3).map((session, index) => (
              <SessionCard
                key={session.id}
                variant="list"
                isFirst={index === 0}
                session={session}
                isActive={session.id === 'orca-remote'}
                isRunning={false}
                hasAttentionNotification={false}
                onClick={noop}
                onAction={noop}
                onRename={noop}
                onTogglePin={noop}
              />
            ))}
          </div>
        </aside>
        <main className="flex flex-1 flex-col gap-3 p-4">
          <div className="flex h-10 items-center rounded-xl border border-border bg-[var(--surface-elevated)] px-3">
            <span className="truncate text-sm font-medium">{sampleTasks[1]!.title}</span>
            <SessionOriginChip session={sampleTasks[1]!} />
          </div>
          <div className="flex h-10 items-center rounded-xl border border-border bg-[var(--surface-elevated)] px-3">
            <span className="truncate text-sm font-medium">{sampleTasks[2]!.title}</span>
            <OrcaRemoteLeadBadge session={sampleTasks[2]!} />
          </div>
        </main>
      </div>
      </WorktreeProvider>
    </MemoryRouter>
  );
}

mountPage({
  host: () => {
    setDataOwnerGeneration('fixture', 1);
    return {
      authHasPersistedSessionHintSync: () => false,
      appearanceSettings: undefined,
      setApplicationMenuLocale: async () => {},
      setUpdateRelaunchTheme: async () => {},
      sidebarSettings: {
        loadSnapshot: () => snapshot,
        claimLegacyRendererOwner: () => ({
          ...snapshot,
          claimed: true,
          canInitialize: true,
          pinnedLegacyConsumed: true,
        }),
        onPinnedOrderChanged: subscription('pinned'),
      },
      maker: { onBotWorkbenchChanged: subscription('workbench') },
    };
  },
  render: () => <Fixture />,
});
