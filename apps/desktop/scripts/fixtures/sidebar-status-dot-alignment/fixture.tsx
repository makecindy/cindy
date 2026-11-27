import { useMemo, useState } from 'react';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { WorktreeProvider } from '../../../src/renderer/contexts/WorktreeContext';
import { MainViewHistoryProvider } from '../../../src/renderer/contexts/MainViewHistoryContext';
import { SidebarTopNav } from '../../../src/renderer/components/sidebar/SidebarTopNav';
import { ProjectsSection } from '../../../src/renderer/features/cc-agent/sidebar/sections/ProjectsSection';
import { TaskInbox } from '../../../src/renderer/features/cc-agent/sidebar/TaskInbox';
import { groupSessions } from '../../../src/renderer/features/cc-agent/lib/projectGrouping';
import { useSidebarFilter } from '../../../src/renderer/features/cc-agent/hooks/useSidebarFilter';
import {
  DIALOGUE_GROUP_ALL_KEY,
  GROUP_AUTOMATION_KEY,
  GROUP_DEVICE_KEY,
  GROUP_DIALOGUE_KEY,
  persistDeviceGroupCollapsedKeys,
  persistDialogueGroupCollapsedKeys,
} from '../../../src/renderer/features/cc-agent/hooks/helpers/sidebarFilterCore';
import {
  AUTOMATIONS_GROUP_KEY,
  CINDY_MAKE_GROUP_KEY,
} from '../../../src/renderer/features/cc-agent/lib/mainListModel';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import type { AutomationScheduleSessionInfo } from '../../../src/renderer/features/cc-agent/lib/automationSidebarGrouping';
import type { TeammateInboxEntry } from '../../../src/renderer/features/bots/teammateInbox';
import { ctx, mountPage, subscription } from '../../ui-page/harness';

setDataOwnerGeneration('fixture', 1);
const noop = () => {};
const hiddenProjectKeys = new Set<string>();
const sidebarSettingsSnapshot = {
  dataOwnerId: 'fixture',
  ownerGeneration: 1,
  pinnedOrderIsAuthoritative: true,
  pinnedOrder: [],
  hiddenProjectKeys: [],
  hiddenMainViewGhostIds: [],
};
const isList = ctx.case === 'list' || ctx.case === 'devices-list';
const isDevices = ctx.case === 'devices' || ctx.case === 'devices-list';
const isInbox = ctx.case === 'inbox-list';

function seedSidebarStorage() {
  localStorage.setItem('sidebar.mainListMode', isList || isInbox ? 'list' : 'text');
  localStorage.setItem(GROUP_DIALOGUE_KEY, 'true');
  localStorage.setItem(GROUP_AUTOMATION_KEY, String(!isDevices));
  localStorage.setItem(GROUP_DEVICE_KEY, String(isDevices));

  // Seed collapsed state for automations, dialogue, and Cindy Make groups before render.
  const scopeKey = isDevices ? 'local' : DIALOGUE_GROUP_ALL_KEY;
  persistDialogueGroupCollapsedKeys(
    new Set([
      scopeKey,
      `${AUTOMATIONS_GROUP_KEY}:${scopeKey}`,
      `${CINDY_MAKE_GROUP_KEY}:${scopeKey}`,
      'remote-open',
      `${AUTOMATIONS_GROUP_KEY}:remote-open`,
    ]),
  );
  persistDeviceGroupCollapsedKeys(new Set(isDevices ? ['local', 'remote-collapsed'] : []));
}

const now = Date.now();
const makeSession = (
  id: string,
  title: string,
  extra: Partial<Session> = {},
): Session =>
  ({
    id,
    title,
    status: 'active',
    source: 'manual',
    createdAt: new Date(now - 120_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
    agentKind: 'codex',
    pinnedAt: null,
    sdkSessionId: null,
    remoteHostId: null,
    deviceLinkDeviceId: null,
    workspaceKind: 'project',
    workingDir: '/Projects/Cindy',
    _count: { messages: 4 },
    ...extra,
  }) as Session;

const localProjectSessions = [
  makeSession('proj-collapsed-done', '整理侧栏对齐细节', {
    workingDir: '/Projects/Cindy',
    updatedAt: new Date(now - 10_000).toISOString(),
  }),
  makeSession('proj-open-done', '检查所有状态点对齐', {
    workingDir: '/Projects/Toolkit',
    updatedAt: new Date(now - 20_000).toISOString(),
  }),
];

const automationSessions = [
  makeSession('auto-group-1', '每早同步汇报 #1', {
    source: 'schedule',
    workspaceKind: 'dialogue',
    workingDir: '/dialogues/auto-1',
    updatedAt: new Date(now - 5_000).toISOString(),
  }),
  makeSession('auto-group-2', '每早同步汇报 #2', {
    source: 'schedule',
    workspaceKind: 'dialogue',
    workingDir: '/dialogues/auto-2',
    updatedAt: new Date(now - 15_000).toISOString(),
  }),
  makeSession('routine-group-1', '定时同步汇总 #1', {
    source: 'bot',
    workspaceKind: 'project',
    workingDir: '/Projects/Toolkit',
    companion: { id: 'demo-bot', role: 'routine', routineId: 'routine-1', routineName: '定时同步汇总' } as Session['companion'],
    updatedAt: new Date(now - 18_000).toISOString(),
  }),
  makeSession('routine-group-2', '定时同步汇总 #2', {
    source: 'bot',
    workspaceKind: 'project',
    workingDir: '/Projects/Toolkit',
    companion: { id: 'demo-bot', role: 'routine', routineId: 'routine-1', routineName: '定时同步汇总' } as Session['companion'],
    updatedAt: new Date(now - 19_000).toISOString(),
  }),
];

const dialogueSessions = [
  makeSession('dialogue-done', '随手聊一段需求', {
    workspaceKind: 'dialogue',
    workingDir: '/dialogues/d1',
    updatedAt: new Date(now - 30_000).toISOString(),
  }),
  makeSession('make-done', '交互原型页面', {
    source: 'cindy-make',
    workspaceKind: 'dialogue',
    workingDir: '/dialogues/make-1',
    updatedAt: new Date(now - 25_000).toISOString(),
  }),
];

const remoteSessions = isDevices
  ? [
      makeSession('remote-collapsed-done', '远端折叠设备任务', {
        deviceLinkDeviceId: 'remote-collapsed',
        deviceLinkDeviceName: 'Studio',
        workingDir: '/Remote/StudioApp',
        updatedAt: new Date(now - 8_000).toISOString(),
      }),
      makeSession('remote-open-dialogue', '远端展开设备的对话', {
        deviceLinkDeviceId: 'remote-open',
        deviceLinkDeviceName: 'Workstation',
        workspaceKind: 'dialogue',
        workingDir: '/Remote/Dialogues',
        updatedAt: new Date(now - 12_000).toISOString(),
      }),
      makeSession('remote-open-proj', '远端项目任务', {
        deviceLinkDeviceId: 'remote-open',
        deviceLinkDeviceName: 'Workstation',
        workingDir: '/Remote/Repo',
        updatedAt: new Date(now - 14_000).toISOString(),
      }),
    ]
  : [];

const allSessions = [
  ...localProjectSessions,
  ...automationSessions,
  ...dialogueSessions,
  ...remoteSessions,
];

const notifications = new Set(allSessions.map((s) => s.id));
const scheduleSessionIndex = new Map<string, AutomationScheduleSessionInfo>([
  [
    'auto-group-1',
    {
      scheduleId: 'sched-1',
      scheduleName: '每日同步汇报',
      scheduleStatus: 'active',
    },
  ],
  [
    'auto-group-2',
    {
      scheduleId: 'sched-1',
      scheduleName: '每日同步汇报',
      scheduleStatus: 'active',
    },
  ],
]);

const remoteDeviceIndex = isDevices
  ? new Map([
      ['remote-collapsed', { name: 'Studio', online: true }],
      ['remote-open', { name: 'Workstation', online: true }],
    ])
  : null;

const inboxTeammates: TeammateInboxEntry[] = [
  {
    key: 'teammate:local:qa',
    name: '阿澈',
    status: 'done',
    snooze: { snoozedUntil: null, snoozedAt: null, userSendAt: null },
    sessionId: 'chat-qa',
    activityAt: now,
    route: '/bots/qa',
    bot: { id: 'qa', name: '阿澈', avatar: '', avatarColor: 'teal', lastMessageAt: now },
  } as TeammateInboxEntry,
];

function SidebarSpecimen() {
  const filter = useSidebarFilter(hiddenProjectKeys, sidebarSettingsSnapshot);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(['local:/Projects/Cindy', 'device-link:remote-open:/Remote/Repo']),
  );
  const grouped = useMemo(() => groupSessions(allSessions), []);
  const projects = grouped.projects;
  const dialogues = grouped.dialogues;

  if (isInbox) {
    return (
      <aside
        data-ui-page-subject
        className="flex h-screen flex-col gap-2 overflow-y-auto bg-sidebar pt-2 pb-4 text-foreground"
        style={{ scrollbarGutter: 'stable' }}
      >
        <TaskInbox
          sessionVariant="list"
          sessions={[localProjectSessions[0]]}
          teammates={inboxTeammates}
          priorityContext={{
            runningSessionIds: new Set(),
            waitingSessionIds: new Set(),
            attentionSessionIds: new Set([localProjectSessions[0].id]),
          }}
          runningSessionIds={new Set()}
          attachedSessionIds={new Set()}
          notifications={new Set([localProjectSessions[0].id])}
          onSessionClick={noop}
          onAction={noop}
          onRename={noop}
          onTogglePin={noop}
          onScheduleAction={noop}
        />
      </aside>
    );
  }

  return (
    <aside
      data-ui-page-subject
      className="flex h-screen flex-col gap-2 overflow-y-auto bg-sidebar pt-2 pb-4 text-foreground"
      style={{ scrollbarGutter: 'stable' }}
    >
      <SidebarTopNav section="scrollable" />
      <ProjectsSection
        unclassified={[]}
        projects={projects}
        dialogues={dialogues}
        allKnownProjects={projects}
        dialogueCount={dialogues.length}
        allProjectKeysForOrder={projects.map((p) => p.projectKey)}
        filter={filter}
        collapsed={collapsed}
        isAllCollapsed={false}
        runningSessionIds={new Set()}
        attachedSessionIds={new Set()}
        notifications={notifications}
        scheduleSessionIndex={scheduleSessionIndex}
        remoteDeviceIndex={remoteDeviceIndex}
        onSessionClick={noop}
        onAction={noop}
        onRename={noop}
        onTogglePin={noop}
        onScheduleAction={noop}
        onToggleProject={(projectKey) =>
          setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(projectKey)) next.delete(projectKey);
            else next.add(projectKey);
            return next;
          })
        }
        onSettings={noop}
        onRenameProject={async () => {}}
        onCollapseAll={noop}
        onExpandAll={noop}
        onCreateProject={noop}
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

void mountPage({
  route: '/cc-agent',
  host: {
    maker: {
      schedule: {
        list: async () => [],
        onEvent: subscription('schedules'),
      },
    },
    deviceLink: {
      getState: async () => ({ linkStatus: 'online' }),
      listDevices: async () => ({ devices: [] }),
      onPresenceChanged: subscription('presence'),
      onStatusChanged: subscription('linkStatus'),
      onControlTargetChanged: subscription('controlTarget'),
    },
    sidebarSettings: {
      loadSnapshot: () => sidebarSettingsSnapshot,
      claimLegacyRendererOwner: () => ({
        ...sidebarSettingsSnapshot,
        claimed: true,
        canInitialize: true,
        pinnedLegacyConsumed: true,
      }),
      onPinnedOrderChanged: subscription('pinned'),
      onHiddenProjectKeysChanged: subscription('hiddenProjects'),
      onHiddenMainViewGhostIdsChanged: subscription('hiddenMainViews'),
    },
    localDb: {
      sessions: {
        get: async (id: string) => allSessions.find((s) => s.id === id) ?? null,
      },
      projectAliases: {
        snapshot: async () => ({
          aliases: [],
          icons: {},
          platform: 'darwin',
          settingsSupported: true,
          settingsVersion: 5,
          ownerStamp: { dataOwnerId: 'fixture', ownerGeneration: 1 },
        }),
        onChanged: subscription('projectInfoChanged'),
      },
    },
  },
  render: () => {
    seedSidebarStorage();
    return (
      <MainViewHistoryProvider>
        <WorktreeProvider>
          <SidebarSpecimen />
        </WorktreeProvider>
      </MainViewHistoryProvider>
    );
  },
});
