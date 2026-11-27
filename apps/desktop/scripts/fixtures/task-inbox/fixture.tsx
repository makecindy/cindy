import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { useState } from 'react';
import { WorktreeProvider } from '../../../src/renderer/contexts/WorktreeContext';
import { ctx, mountPage, subscription } from '../../ui-page/harness';
import { ProjectsSection } from '../../../src/renderer/features/cc-agent/sidebar/sections/ProjectsSection';
import { PinnedSection, type PinnedSidebarEntry } from '../../../src/renderer/features/cc-agent/sidebar/sections/PinnedSection';
import { ProjectNode } from '../../../src/renderer/features/cc-agent/sidebar/sections/ProjectNode';
import { useSidebarFilter } from '../../../src/renderer/features/cc-agent/hooks/useSidebarFilter';
import { filterSidebarTasks } from '../../../src/renderer/features/cc-agent/lib/sidebarTaskFilters';
import { groupSessions } from '../../../src/renderer/features/cc-agent/lib/projectGrouping';
import { TaskInbox } from '../../../src/renderer/features/cc-agent/sidebar/TaskInbox';
import { useInboxUnread } from '../../../src/renderer/features/cc-agent/sidebar/useInboxUnread';
import { TaskListModeToggle } from '../../../src/renderer/components/sidebar/TaskListModeToggle';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import type { TeammateInboxEntry } from '../../../src/renderer/features/bots/teammateInbox';
import {
  projectSessionWithOfflineInboxIntent,
  type OfflineInboxIntent,
} from '@cindy/maker-shared/offline-inbox-intent';
import {
  getOfflineInboxIntent,
  queueOfflineInboxComplete,
  removeOfflineInboxIntent,
  useOfflineInboxIntentsRevision,
} from '../../../src/renderer/features/device-link/offlineInboxIntentsStore';
setDataOwnerGeneration('fixture', 1);
const noop = () => {};
const hidden = new Set<string>();
const snapshot = {
  dataOwnerId: 'fixture',
  ownerGeneration: 1,
  pinnedOrderIsAuthoritative: true,
  pinnedOrder: [],
  hiddenProjectKeys: [],
  hiddenMainViewGhostIds: [],
};
const now = Date.now();
const sessions = [
  ['ready', '本周工作总结，等你看一眼'],
  ['waiting', '需要你确认发布范围'],
  ['running', '正在整理调研结果'],
  ['following', '自动跟进 PR，等待下次检查'],
  ['later', '明天继续的设计方案'],
  ['done', '已确认的会议记录'],
].map(([id, title]) => ({
  id,
  title,
  status: id === 'done' ? 'archived' : 'active',
  source: 'desktop',
  createdAt: new Date(now - 60000).toISOString(),
  updatedAt: new Date(now).toISOString(),
  snoozedAt: id === 'later' ? new Date(now).toISOString() : null,
  snoozedUntil: id === 'later' ? new Date(now + 3600000).toISOString() : null,
  agentKind: 'codex',
  pinnedAt: id === 'waiting' ? new Date(now).toISOString() : null,
  sdkSessionId: null,
  remoteHostId: null,
  deviceLinkDeviceId: null,
  workspaceKind: id === 'waiting' ? 'dialogue' : 'project',
  workingDir: id === 'waiting' ? '/dialogue/runtime' : (id === 'ready' || id === 'done' ? '/workspace/Cindy/.cindy-worktrees/topic' : '/workspace/Website'),
  _count: { messages: 5 },
})) as Session[];
const runningSessionIds = new Set(['running', 'waiting']);
const priorityContext = {
  runningSessionIds,
  waitingSessionIds: new Set(['waiting']),
  attentionSessionIds: new Set(['ready', 'waiting']),
};
declare global {
  interface Window { __replyToReady?: () => void }
}
// The reply case has more pending tasks, so Working starts below the fold.
const replySessions = ctx.case === 'reply'
  ? [...sessions, ...[1, 2, 3, 4, 5].map((n) => ({ ...sessions[0], id: `note-${n}`, title: `待看的结果 ${n}` }))]
  : sessions;
// One teammate conversation per inbox state; the idle one must not be listed.
const noSnooze = { snoozedUntil: null, snoozedAt: null, userSendAt: null };
const teammate = (id: string, name: string, status: TeammateInboxEntry['status'], extra: Partial<TeammateInboxEntry> = {}) => ({
  key: `teammate:local:${id}`, name, status, snooze: noSnooze, sessionId: `chat-${id}`, activityAt: now, route: `/bots/${id}`,
  bot: { id, name, avatar: '', avatarColor: 'teal', lastMessageAt: now },
  ...extra,
}) as TeammateInboxEntry;
const teammates = ctx.case === 'teammates' ? [
  teammate('pm', '小满', 'awaiting'),
  teammate('qa', '阿澈', 'unread', { deviceLabel: '书房的电脑' }),
  teammate('momo', '默默', 'running'),
  teammate('older', '旧电脑上的伙伴', 'unread', { snooze: null, deviceLabel: 'Studio' }),
  teammate('lulu', '露露', 'done', { snooze: { snoozedUntil: new Date(now + 7200000).toISOString(), snoozedAt: new Date(now).toISOString(), userSendAt: null } }),
  teammate('idle', '闲着的伙伴', 'idle'),
] : undefined;
function Specimen() {
  const [items, setItems] = useState(replySessions);
  const [selected, setSelected] = useState<string>();
  // The open task gets a reply: it starts running and its result is read.
  const [replied, setReplied] = useState(false);
  window.__replyToReady = () => setReplied(true);
  const running = replied ? new Set([...runningSessionIds, 'ready']) : runningSessionIds;
  const context = replied
    ? { ...priorityContext, runningSessionIds: running, attentionSessionIds: new Set(['waiting']) }
    : priorityContext;
  return (
    // The reply case scrolls inside a short sidebar, so a scroll after the moved row would show.
    <div
      data-inbox-scroller=""
      className={ctx.case === 'reply' ? 'h-[260px] overflow-y-auto bg-sidebar text-foreground p-2' : 'min-h-screen bg-sidebar text-foreground p-2'}
    >
      <TaskInbox
        sessionVariant={ctx.case === 'list' ? 'list' : 'text'}
        sessions={items}
        teammates={teammates}
        priorityContext={context}
        runningSessionIds={running}
        attachedSessionIds={new Set()}
        notifications={replied ? new Set<string>() : new Set(['ready'])}
        activeSessionId={selected}
        onSessionClick={setSelected}
        onRename={noop}
        onTogglePin={noop}
        onScheduleAction={noop}
        onAction={(id, action) =>
          setItems((previous) =>
            previous.map((s) =>
              s.id === id
                ? {
                    ...s,
                    status: action === 'unarchive' ? 'active' : 'archived',
                    archivedAt: action === 'unarchive' ? null : new Date().toISOString(),
                  }
                : s,
            ),
          )
        }
      />
    </div>
  );
}
/** Offline remote computer tasks support queueing Done, Snooze, and Undo locally. */
function OfflineSpecimen() {
  useOfflineInboxIntentsRevision();
  const [selected, setSelected] = useState<string>();
  const offlineRaw: Session[] = [
    {
      ...sessions[0],
      id: 'offline-done-target',
      title: '离线电脑上的发布整理',
      deviceLinkDeviceId: 'offline-mac',
      deviceLinkDeviceName: '书房的 Mac',
      deviceLinkConnectionStatus: 'disconnected',
    },
    {
      ...sessions[0],
      id: 'offline-snooze-target',
      title: '离线电脑上的周报初稿',
      deviceLinkDeviceId: 'offline-mac',
      deviceLinkDeviceName: '书房的 Mac',
      deviceLinkConnectionStatus: 'disconnected',
    },
  ];
  const projected = offlineRaw.map((session) => {
    const intent = getOfflineInboxIntent(session.deviceLinkDeviceId, session.id);
    return intent ? projectSessionWithOfflineInboxIntent(session, intent) : session;
  });
  const offlinePriority = {
    runningSessionIds: new Set<string>(),
    waitingSessionIds: new Set<string>(),
    attentionSessionIds: new Set(['offline-done-target', 'offline-snooze-target']),
  };
  return (
    <div data-inbox-scroller="" className="min-h-screen bg-sidebar text-foreground p-2">
      <TaskInbox
        sessionVariant="text"
        sessions={projected}
        priorityContext={offlinePriority}
        runningSessionIds={new Set()}
        attachedSessionIds={new Set()}
        notifications={offlinePriority.attentionSessionIds}
        activeSessionId={selected}
        onSessionClick={setSelected}
        onRename={noop}
        onTogglePin={noop}
        onScheduleAction={noop}
        onAction={(id, action) => {
          const target = offlineRaw.find((s) => s.id === id);
          if (!target?.deviceLinkDeviceId) return;
          if (action === 'complete' || action === 'archive') {
            void queueOfflineInboxComplete(target.deviceLinkDeviceId, target.id, target);
          } else if (action === 'unarchive') {
            void removeOfflineInboxIntent(target.deviceLinkDeviceId, target.id);
          }
        }}
      />
    </div>
  );
}

/** The first switch into the inbox on this computer opens the introduction. */
function IntroSpecimen() {
  return (
    <div className="min-h-screen w-[280px] bg-sidebar text-foreground">
      <div className="flex h-[46px] items-center justify-end pr-2">
        <TaskListModeToggle hasUnread={false} />
      </div>
    </div>
  );
}

function StructureSpecimen() {
  const filter = useSidebarFilter(hidden, snapshot);
  const task = {
    ...sessions[0],
    workingDir: '/workspace/Cindy',
    workspaceKind: 'project' as const,
  };
  const report: Session = { ...task, id: 'report', title: '每日自动巡检', source: 'scheduler' };
  const teammate: Session = { ...task, id: 'teammate', title: '伙伴的例行整理', source: 'bot',
    companion: { id: 'demo', role: 'routine', taskProjectDir: task.workingDir } };
  const source = [task, report, teammate];
  const inboxSessions = filterSidebarTasks([task, ...sessions.slice(1), report], filter.inbox, new Map());
  const inboxPriority = { ...priorityContext, attentionSessionIds: new Set(['report', 'waiting']) };
  const { hasUnread, now: inboxNow } = useInboxUnread(inboxSessions, [], inboxPriority, () => false);
  const allProjects = groupSessions(source).projects;
  const projects = groupSessions(filterSidebarTasks(source, filter, new Map())).projects;
  const [projectCollapsed, setProjectCollapsed] = useState(true);
  return (
    <div className="min-h-screen w-[320px] bg-sidebar text-foreground p-2">
      {/* Same placement as the sidebar's top chrome row (back / forward), right end. */}
      <div data-fixture-top-row="" className="flex h-[46px] items-center justify-end pr-2">
        <TaskListModeToggle hasUnread={hasUnread} />
      </div>
      <ProjectsSection
        unclassified={[]}
        projects={projects}
        dialogues={[]}
        inboxSessions={inboxSessions}
        inboxNow={inboxNow}
        allKnownProjects={allProjects}
        allProjectKeysForOrder={projects.map((p) => p.projectKey)}
        filter={{ ...filter, groupBy: 'project', groupDevice: true, groupDialogue: true }}
        collapsed={new Set(projectCollapsed ? projects.map((p) => p.projectKey) : [])}
        isAllCollapsed={projectCollapsed}
        priorityContext={inboxPriority}
        runningSessionIds={runningSessionIds}
        attachedSessionIds={new Set()}
        notifications={inboxPriority.attentionSessionIds}
        scheduleSessionIndex={new Map()}
        onSessionClick={noop}
        onAction={noop}
        onRename={noop}
        onTogglePin={noop}
        onScheduleAction={noop}
        onToggleProject={() => setProjectCollapsed(closed => !closed)}
        onToggleProjectPin={noop}
        onRenameProject={async () => {}}
        onRemoveFromSidebar={noop}
        onCollapseAll={noop}
        onExpandAll={noop}
        onCreateInProject={noop}
        onOpenConversationSearch={noop}
        onOpenInExplorer={noop}
        onImportFromTools={noop}
        onBrowseFiles={noop}
        onArchiveAll={noop}
        onCreateDialogue={noop}
        onSearchDialogues={noop}
        onArchiveAllDialogues={noop}
      />
    </div>
  );
}
/** Pinned items in inbox mode follow inbox display rules, without Snooze or Done buttons. */
function PinnedInboxSpecimen() {
  const pinnedProjectTask: Session = {
    ...sessions[0],
    id: 'pinned-ready',
    title: '置顶的发版检查清单',
    pinnedAt: new Date(now).toISOString(),
    source: 'scheduler',
    workingDir: '/workspace/Cindy',
    workspaceKind: 'project',
    preview: '已同步最新的发布步骤和回滚预案。',
  };
  const pinnedDialogueTask: Session = {
    ...sessions[1],
    id: 'pinned-dialogue',
    title: '置顶的日常备忘对话',
    pinnedAt: new Date(now - 30_000).toISOString(),
    workspaceKind: 'dialogue',
    workingDir: '/dialogue/runtime',
    preview: '整理下周评审前要确认的几个问题。',
  };
  const projectTask: Session = {
    ...sessions[2],
    id: 'pinned-project-child',
    title: '置顶项目里的构建跟进',
    workingDir: '/workspace/Website',
    workspaceKind: 'project',
    preview: '等待 CI 跑完静态资源检查。',
  };
  const allProjects = groupSessions([pinnedProjectTask, projectTask]).projects;
  const websiteProject = allProjects.find((p) => p.workingDir === '/workspace/Website')!;
  const pinnedEntries: PinnedSidebarEntry[] = [
    { kind: 'session', id: pinnedProjectTask.id, session: pinnedProjectTask },
    { kind: 'session', id: pinnedDialogueTask.id, session: pinnedDialogueTask },
    { kind: 'project', id: `project:${websiteProject.projectKey}`, project: websiteProject, displaySessions: [projectTask] },
  ];
  return (
    <div className="min-h-screen bg-sidebar text-foreground p-2 flex flex-col gap-3">
      <PinnedSection
        inboxMode
        sortBy="manual"
        onSortByChange={noop}
        entries={pinnedEntries}
        allKnownProjects={allProjects}
        renderProject={(project, displaySessions, parentSectionCollapsed, sessionVariant) => (
          <ProjectNode
            project={project}
            displaySessions={displaySessions}
            inboxMode
            hideInboxActions
            sessionVariant={sessionVariant}
            statusFilter="active"
            isCollapsed={false}
            parentSectionCollapsed={parentSectionCollapsed}
            runningSessionIds={new Set()}
            attachedSessionIds={new Set()}
            notifications={new Set()}
            scheduleSessionIndex={new Map()}
            disableSessionCollapse={false}
            onToggle={noop}
            onSettings={noop}
            onRenameProject={async () => {}}
            onSessionClick={noop}
            onAction={noop}
            onRename={noop}
            onTogglePin={noop}
            onScheduleAction={noop}
            onCreateInProject={noop}
            onOpenConversationSearch={noop}
            onOpenInExplorer={noop}
            onBrowseFiles={noop}
            onArchiveAll={noop}
          />
        )}
        runningSessionIds={new Set()}
        attachedSessionIds={new Set()}
        notifications={new Set(['pinned-ready'])}
        onSessionClick={noop}
        onAction={noop}
        onRename={noop}
        onTogglePin={noop}
        onReorder={noop}
      />
      <TaskInbox
        sessionVariant="list"
        sessions={sessions.slice(0, 2)}
        priorityContext={priorityContext}
        runningSessionIds={runningSessionIds}
        attachedSessionIds={new Set()}
        notifications={new Set(['ready'])}
        onSessionClick={noop}
        onAction={noop}
        onRename={noop}
        onTogglePin={noop}
        onScheduleAction={noop}
      />
    </div>
  );
}
if (ctx.case !== 'intro') localStorage.setItem('featureIntro.taskInbox.seen', '1');
if (ctx.case === 'pinned') localStorage.setItem('sidebar.cardMode', 'list');

let fixtureOfflineIntents: OfflineInboxIntent[] = [];
const fixtureOfflineListeners = new Set<(payload: { intents: OfflineInboxIntent[] }) => void>();
const notifyFixtureOfflineIntents = () => {
  const snapshot = fixtureOfflineIntents.slice();
  for (const listener of fixtureOfflineListeners) listener({ intents: snapshot });
};

void mountPage({
  route: '/cc-agent',
  host: {
    maker: {
      schedule: {
        list: async () => [
          { id: 'follow-pr', name: 'PR 跟进', status: 'active', targetSessionId: 'following', cronExpr: '*/5 * * * *', manual: false,
            preRunHook: { command: 'node pr-heartbeat-gate.mjs https://github.com/example/app/pull/42' } },
          // A routine automation bound to a task does not make it working.
          { id: 'routine', name: '例行巡检', status: 'active', targetSessionId: 'ready', cronExpr: '0 * * * *', manual: false },
        ],
        onEvent: subscription('schedules'),
      },
    },
    deviceLink: {
      getState: async () => ({ linkStatus: 'online' }),
      listDevices: async () => ({ devices: [] }),
      onPresenceChanged: subscription('presence'),
      onStatusChanged: subscription('linkStatus'),
      onControlTargetChanged: subscription('controlTarget'),
      offlineInboxIntents: {
        list: async () => fixtureOfflineIntents.slice(),
        upsert: async (intent: OfflineInboxIntent) => {
          fixtureOfflineIntents = [
            ...fixtureOfflineIntents.filter((x) => !(x.deviceId === intent.deviceId && x.sessionId === intent.sessionId)),
            intent,
          ];
          notifyFixtureOfflineIntents();
          return fixtureOfflineIntents.slice();
        },
        remove: async (deviceId: string, sessionId: string) => {
          fixtureOfflineIntents = fixtureOfflineIntents.filter(
            (x) => !(x.deviceId === deviceId && x.sessionId === sessionId),
          );
          notifyFixtureOfflineIntents();
          return fixtureOfflineIntents.slice();
        },
        clearDevice: async (deviceId: string) => {
          fixtureOfflineIntents = fixtureOfflineIntents.filter((x) => x.deviceId !== deviceId);
          notifyFixtureOfflineIntents();
          return fixtureOfflineIntents.slice();
        },
        onChanged: (cb: (payload: { intents: OfflineInboxIntent[] }) => void) => {
          fixtureOfflineListeners.add(cb);
          return () => { fixtureOfflineListeners.delete(cb); };
        },
      },
    },
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
        snapshot: async () => ({ aliases: [], icons: { 'local:/workspace/Cindy': 'symbol:Code:purple', 'local:/workspace/Website': 'text:WS:teal' },
          platform: 'darwin', settingsVersion: 3, ownerStamp: { dataOwnerId: 'fixture', ownerGeneration: 1 } }),
        onChanged: subscription('projectAliases'),
      },
      sessions: {
        get: async (id: string) => sessions.find((s) => s.id === id),
        update: async (id: string, patch: Partial<Session>) => {
          document.documentElement.dataset.snoozedUntil = patch.snoozedUntil ?? '';
          document.documentElement.dataset.snoozedSession = id;
          document.documentElement.dataset.patchKeys = Object.keys(patch).join(',');
          return { ...sessions.find((s) => s.id === id), ...patch };
        },
      },
    },
  },
  render: () => (
    <WorktreeProvider>
      {ctx.case === 'intro'
        ? <IntroSpecimen />
        : ctx.case === 'structure'
          ? <StructureSpecimen />
          : ctx.case === 'offline'
            ? <OfflineSpecimen />
            : ctx.case === 'pinned' ? <PinnedInboxSpecimen /> : <Specimen />}
    </WorktreeProvider>
  ),
});
