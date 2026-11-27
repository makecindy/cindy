import { ctx, mountPage, subscription } from '../../ui-page/harness';
import { ProjectsSection } from '../../../src/renderer/features/cc-agent/sidebar/sections/ProjectsSection';
import { WorktreeProvider } from '../../../src/renderer/contexts/WorktreeContext';
import { useSidebarFilter } from '../../../src/renderer/features/cc-agent/hooks/useSidebarFilter';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';

const noop = () => {};
const snapshot = {
  dataOwnerId: 'fixture',
  ownerGeneration: 1,
  pinnedOrderIsAuthoritative: true,
  pinnedOrder: [],
  hiddenProjectKeys: [],
  hiddenMainViewGhostIds: [],
};
setDataOwnerGeneration('fixture', 1);
const examples = [
  [
    '调整任务列表，让较长的标题也能读完整',
    '这次保留了第二行最近消息，可以直接从列表了解任务进展。',
  ],
  ['检查桌面端的夜间构建结果', '本次构建已经完成，更新日志和测试结果都已整理。'],
  ['伙伴下线后继续处理未完成的任务', '正在检查断线恢复时的任务记录和设备状态。'],
  ['检查用量统计中的货币单位', '已经核对了金额的来源和显示时使用的单位。'],
  ['评估移动客户端的导航调整', '打开较窄的窗口后，标题和返回按钮仍然能够正常显示。'],
  ['整理消息列表的未读提醒', '已补充验证步骤，等待下一轮检查。'],
];
const base = Date.UTC(2026, 10, 20);
function task(index: number, title: string, preview: string, project: string | null): Session {
  const timestamp = new Date(base - index * 60000).toISOString();
  return {
    id: 'example-' + index,
    title,
    preview,
    status: 'active',
    source: 'desktop',
    agentKind: [1, 2, 4].includes(index) ? 'cc' : 'codex',
    createdAt: timestamp,
    updatedAt: timestamp,
    workspaceKind: project ? 'project' : 'dialogue',
    workingDir: project ? '/Projects/' + project : null,
    _count: { messages: 5 },
  } as Session;
}
const names = ['cindy', 'mobile-client'];
const tasks = examples.map(([title, preview], i) =>
  task(i, title, preview, names[Number(i === 4)]),
);
const projects = names.map((name) => ({
  projectKey: 'local:/Projects/' + name,
  workingDir: '/Projects/' + name,
  displayName: name,
  scope: 'local' as const,
  remoteHostId: null,
  deviceLinkDeviceId: null,
  deviceLinkDeviceName: null,
  deviceLinkConnectionStatus: null,
  segments: 1,
  latestActivityAt: '',
  sessions: tasks.filter((s) => s.workingDir === '/Projects/' + name),
}));
const dialogues = [
  task(6, '讨论一周的计划', '记录待办事项。', null),
  { ...task(7, '[Schedule] 每日检查', '已结束。', null), source: 'scheduler' } as Session,
];
const limitProjects = ['Atlas', 'Beacon'].map((name, projectIndex) => ({
  ...projects[projectIndex],
  projectKey: `local:/Projects/${name}`,
  workingDir: `/Projects/${name}`,
  displayName: name,
  sessions: Array.from({ length: 6 }, (_, index) => {
    const timestamp = new Date(Date.UTC(2020, 0, 30 - index)).toISOString();
    const row = task(10 + projectIndex * 6 + index, `${name} session ${index + 1}`, '', name);
    return { ...row, createdAt: timestamp, updatedAt: timestamp };
  }),
}));
const empty = new Set<string>();
const running = new Set(['example-2', 'example-4']);
const unread = new Set(['example-1', 'example-3']);
function List() {
  const filter = useSidebarFilter(empty, snapshot);
  const limitScenario = ctx.data.projectSessionLimit === true;
  const projectRows = limitScenario ? limitProjects : projects;
  return (
    <aside className={`min-h-screen bg-sidebar pr-2 pt-3 text-foreground${limitScenario ? ' w-80' : ''}`} data-ui-page-subject>
      <ProjectsSection
        projects={projectRows}
        allKnownProjects={projectRows}
        unclassified={[]}
        dialogues={limitScenario ? [] : dialogues}
        filter={filter}
        collapsed={empty}
        isAllCollapsed={false}
        allProjectKeysForOrder={projectRows.map((p) => p.projectKey)}
        activeSessionId={limitScenario ? 'example-10' : 'example-0'}
        runningSessionIds={limitScenario ? new Set(['example-21']) : running}
        notifications={limitScenario ? empty : unread}
        attachedSessionIds={empty}
        scheduleSessionIndex={new Map()}
        onAction={noop}
        onRename={noop}
        onSessionClick={noop}
        onTogglePin={noop}
        onScheduleAction={noop}
        onToggleProject={noop}
        onSettings={noop}
        onRenameProject={async () => {}}
        onCollapseAll={noop}
        onExpandAll={noop}
        onCreateInProject={noop}
        onOpenConversationSearch={noop}
        onOpenInExplorer={noop}
        onBrowseFiles={noop}
        onArchiveAll={noop}
        onSearchDialogues={noop}
        onArchiveAllDialogues={noop}
        onCreateDialogue={noop}
      />
    </aside>
  );
}
mountPage({
  route: '/cc-agent',
  host: {
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
    localDb: {
      projectAliases: {
        snapshot: async () => ({
          aliases: [],
          icons: {},
          platform: 'darwin',
          settingsSupported: true,
          settingsVersion: 5,
          ownerStamp: { dataOwnerId: 'fixture', ownerGeneration: 1 },
        }),
        onChanged: subscription('projects'),
        autoIcon: async ({ projectKey }: { projectKey: string }) => ({
          image: projectKey === 'local:/Projects/cindy' ? ctx.data.avatar : null,
          kind: 'local',
          source: 'assets/icon.png',
          candidate: false,
        }),
      },
    },
  },
  render: () => (
    <WorktreeProvider>
      <List />
    </WorktreeProvider>
  ),
});
