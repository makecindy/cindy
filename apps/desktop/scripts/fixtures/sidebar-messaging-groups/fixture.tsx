import { mountPage, subscription } from '../../ui-page/harness';
import { ProjectsSection } from '../../../src/renderer/features/cc-agent/sidebar/sections/ProjectsSection';
import { WorktreeProvider } from '../../../src/renderer/contexts/WorktreeContext';
import { useSidebarFilter } from '../../../src/renderer/features/cc-agent/hooks/useSidebarFilter';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';

// 主列表的「按消息平台」分组(docs/product-rules/sidebar-redesign-plan.md §3.1):
// 一个项目、几条本机对话,加上飞书与 Slack 来的无项目任务。分组开关由场景的 localStorage 决定。
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

const base = Date.UTC(2026, 10, 20);
function task(
  index: number,
  title: string,
  source: Session['source'],
  project: string | null = null,
): Session {
  const timestamp = new Date(base - index * 3_600_000).toISOString();
  return {
    id: 'messaging-' + index,
    title,
    preview: '',
    status: 'active',
    source,
    agentKind: 'cc',
    createdAt: timestamp,
    updatedAt: timestamp,
    workspaceKind: project ? 'project' : 'dialogue',
    workingDir: project ? '/Projects/' + project : null,
    _count: { messages: 3 },
  } as Session;
}

const projectTasks = [
  task(2, '整理发布说明', 'desktop', 'cindy'),
  // 消息平台上发起、但落在项目里的任务:留在项目里,不进平台组。
  task(5, '[飞书·群] 修复登录页的错别字', 'feishu', 'cindy'),
];
const projects = [
  {
    projectKey: 'local:/Projects/cindy',
    workingDir: '/Projects/cindy',
    displayName: 'cindy',
    scope: 'local' as const,
    remoteHostId: null,
    deviceLinkDeviceId: null,
    deviceLinkDeviceName: null,
    deviceLinkConnectionStatus: null,
    segments: 1,
    latestActivityAt: '',
    sessions: projectTasks,
  },
];
const dialogues = [
  task(0, '[飞书·DM] 帮我看一下周报初稿', 'feishu'),
  task(1, '讨论下周的计划', 'desktop'),
  task(3, '[飞书·群] 确认发布排期', 'feishu'),
  task(4, 'Slack · #release 同步变更', 'slack'),
  task(6, '[飞书·DM] 报销流程怎么走', 'feishu'),
  task(7, '整理读书笔记', 'desktop'),
];
const empty = new Set<string>();

function List() {
  const filter = useSidebarFilter(empty, snapshot);
  return (
    // 固定成侧栏的宽度:菜单场景的窗口更宽,右侧留给展开的子菜单(真实窗口里侧栏右边就是内容区)。
    <aside
      className="min-h-screen bg-sidebar pr-2 pt-3 text-foreground"
      style={{ width: 348 }}
      data-ui-page-subject
    >
      <ProjectsSection
        projects={projects}
        allKnownProjects={projects}
        unclassified={[]}
        dialogues={dialogues}
        filter={filter}
        collapsed={empty}
        isAllCollapsed={false}
        allProjectKeysForOrder={projects.map((project) => project.projectKey)}
        runningSessionIds={empty}
        notifications={empty}
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
        autoIcon: async () => ({ image: null, kind: 'local', source: '', candidate: false }),
      },
    },
  },
  render: () => (
    <WorktreeProvider>
      <List />
    </WorktreeProvider>
  ),
});
