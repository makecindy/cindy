/**
 * CCAgentFeature 的 Sidebar 上半内容。
 * ---------------------------------------------------------------------------
 * 产品版本：对齐 ccagent-projects-sidebar V1.7（F-PJ-1~7 P0）。
 *
 * Sidebar 上半三层结构：
 *   1. Top Actions     — "+ New" 按钮
 *   2. Sidebar Scroll  — Pinned 段 + Projects 段（含 Unclassified + Project 树）
 *   3. Section Title 由各段组件自带（"Pinned" / "Projects"）
 *
 * 折叠态：只显示 + 图标，列表整块隐藏。
 *
 * v12 (2026-04-20): Search 入口整块移除（暂无搜索功能，避免空 UI 占位）。
 *
 * F-SB-7: Session 状态指示器（运行态 + 完成通知）保持不变；
 * F-PJ-1~7：分组数据来自 useProjectGroups + useCollapsedProjects。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import type { SchedulerEvent } from '@cindy/maker-scheduler';
import { createPortal } from 'react-dom';
import {
  Archive,
  ChevronRight,
  CircleAlert,
  CirclePlus,
  Folder,
  Loader2,
  Plug,
  RefreshCw,
  SquarePen,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import { useNavigate, useMatch } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { useCCSessions } from '@/hooks/useCCSessions';
import { refreshPendingAlerts, usePendingAlertAttention } from '@/hooks/usePendingAlertAttention';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { useModifierHold } from '@/hooks/useModifierHold';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { getAppShortcutCombos, getAppShortcutPlatform } from '@/lib/appShortcutStore';
import {
  formatAppShortcutCombo,
  matchesKeyboardEvent,
  SWITCH_SESSION_SHORTCUT_IDS,
} from '../../../shared/appShortcuts';
import { WORKLOUDER_CODEX_AGENT_SLOT_COUNT } from '../../../shared/workLouderCodex';
import { setSessionOrdinalBadges } from './sidebar/sessionOrdinalBadges';
import { useOwnTopNavScrollableRows, useSidebarCollapsedState } from '../feature-context';
import { SidebarTopNav } from '@/components/sidebar/SidebarTopNav';
import { SidebarFilterPopover } from './sidebar/SidebarFilterPopover';
import { MainListScopeHeader } from './sidebar/MainListScopeHeader';
import { stripTrailingPathSeparators } from '../../../shared/pathText';
import { useRefreshWorktrees } from '@/contexts/WorktreeContext';
import {
  SessionAttentionUrgencyProvider,
  useSessionAttentionUrgencySet,
} from './contexts/SessionAttentionUrgencyContext';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip, Tooltip } from '@/components/ui/tooltip';
import * as sessionService from '@/lib/sessionService';
import { makerChatStore } from '@/lib/makerChatStore';
import { discardDraft as discardComposerDraft } from '@/lib/composerDraftStore';
import { cleanupSessionLayoutPrefs } from '@/lib/sessionLayoutPrefs';
import {
  countDirtyWorktreesForRemoval,
  resolveWorktreeRemovalPreflight,
} from '@/lib/worktreeRemovalWarning';
import { useSessionRunningStatus } from '@/hooks/useSessionRunningStatus';
import { useBackgroundActivitySessionIds } from '@/lib/sessionBackgroundActivityStore';
import { useStartingSessionIds } from '@/lib/sessionStartingStore';
import { useAttachedSessionIds } from '@/hooks/useAttachedSessionIds';
import { useActiveMainView } from '@/hooks/useActiveMainView';
import { useAnyGhostUnread } from '@/cindy-brain/ghostUnreadStore';
import { GhostPanelRestoreEntry } from '@/cindy-brain/GhostPanelRestoreEntry';
import { getNotificationsEnabled } from '@/hooks/useNotificationSettings';
import { getFeishuNotificationsEnabled } from '@/hooks/useFeishuNotificationSettings';
import { getAgentIslandEnabled, isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';
import type { Session } from '@/lib/ccAgent.types';
import {
  clearSessionAttentionMany,
  clearSystemSessionAttention,
  useSessionAttentionKinds,
  useSessionAttentionSnapshot,
} from '@/lib/sessionAttentionStore';
import { patchDraft as patchNewMakerDraft } from '@/state/newMakerDraft';
import { consumePendingProjectFocus, usePendingProjectFocus } from '@/state/pendingProjectFocus';
import { requestConversationSearch, useConversationSearchRequest } from '@/state/conversationSearchRequest';
import { searchDevicesFromSwitcher } from '@/lib/conversationSearchFanout';

import { emitRefresh, onPatch } from '@/lib/sessionsBus';

import { useProjectGroups } from './hooks/useProjectGroups';
import { useProjectAliases } from './hooks/useProjectAliases';
import { useCollapsedProjects } from './hooks/useCollapsedProjects';
import { useOrcaLeadWorkerMap } from './hooks/useOrcaLeadWorkerMap';
import { useOrcaWorkerAttentionWatcher } from './hooks/useOrcaWorkerAttentionWatcher';
import { useAutomationScheduleSessionIndex } from './hooks/useAutomationScheduleSessionIndex';
import {
  markAllScheduleRunsReadAndSync,
  markScheduleRunsReadAndSync,
} from '../scheduler/lib/scheduleRunReadSync';
import { useSessionLifecycleActions } from './hooks/useSessionLifecycleActions';
import { useSidebarFilter, type UseSidebarFilterReturn } from './hooks/useSidebarFilter';
import { useHiddenProjects, type UseHiddenProjectsReturn } from './hooks/useHiddenProjects';
import {
  normalizeProjectKey,
  normalizeWorkingDir,
  projectIdentityKey,
  projectIdentityKeyForSession,
  pinnedSessionIdsInDisplayOrder,
  type ProjectNode,
} from './lib/projectGrouping';
import { projectDisplayLabelWithMachine } from './lib/remoteProjectIdentity';
import {
  projectBulkArchiveActionForStatus,
  selectProjectBulkArchiveCandidates,
} from './lib/projectBulkArchiveAction';
import { sessionActivityMs } from './lib/dateSessionGrouping';
import { matchesSidebarSessionStatus } from './lib/sidebarSessionStatusFilter';
import { sortProjectsForSidebar, sortSessionsForSidebar } from './lib/sidebarProjectSorting';
import { resolveDisplayedProjectOrder } from '@cindy/maker-shared/project-order-sync';
import {
  controllerManualOrderForDevice,
  projectOrderWriteScopeForSelection,
  useLocalHostProjectOrder,
  useRemoteHostProjectOrders,
} from './hooks/useRemoteHostProjectOrders';
import { isOrcaWorkerSession, resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import {
  buildProjectKeyComparisonSet,
  isProjectHidden,
  projectKeyComparisonSetHas,
  sidebarSessionsWithHiddenProjectsAsDialogues,
  visibleSidebarProjects,
} from './lib/sidebarProjectVisibility';
import {
  collectRestorableProjectKeys,
  registerSidebarProjectRestoreHandler,
  restoreHiddenProjectIfPresent,
  restoreSelectedHiddenProject,
} from './lib/sidebarProjectRestore';
import { PinnedSection, type PinnedSidebarEntry } from './sidebar/sections/PinnedSection';
import { ProjectNode as ProjectNodeView } from './sidebar/sections/ProjectNode';
import { compareDialogueSessions, type DialogueSortBy } from './sidebar/sections/DialogueSection';
import { holdSidebarViewedPriority, ProjectsSection } from './sidebar/sections/ProjectsSection';
import { isAutomationGeneratedSession } from './lib/scheduledSessionGrouping';
import { toStoredSessionTitle } from './lib/sessionDisplayTitle';
import {
  getVisibleSidebarSessionIds,
  pickSessionIdAfterRemoval,
} from './lib/sessionRemovalNavigation';
import { onRequestSessionSwitch, pickAdjacentSessionId } from './lib/sessionSwitchCommands';
import type {
  AutomationScheduleAction,
  AutomationScheduleSessionInfo,
  AutomationSessionGroup,
} from './lib/automationSidebarGrouping';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import {
  getRemoteSessionActivity,
  useRemoteSessionActivity,
  useRemoteSessionActivityRevision,
} from '@/features/device-link/remoteSessionActivityStore';
import { resolveCollapsedProjectAttentionTone } from './sidebar/projectCollapsedAttention';
import { WorkdirBrowseSidebar } from './workdir-browse/WorkdirBrowseSidebar';
import {
  buildDocModeSwitchProjects,
  resolveDocModeFilesSession,
} from './workdir-browse/lib/docModeSwitchProjects';
import { ConversationSearchBox, SearchResultsBody } from './sidebar/ConversationSearchBox';
import { useConversationSearchContext } from './sidebar/conversationSearchContext';
import {
  SidebarIconButton,
  SIDEBAR_RAIL_ICON_BUTTON_CLASS,
} from '@/components/sidebar/SidebarIconButton';
import { RailNav, remoteLampOf } from './sidebar/RailNav';
import {
  panelHasBlockingOverlay,
  panelHasEditingFocus,
  railPanelStore,
} from './sidebar/railPanelStore';
import { SessionEntryList } from './sidebar/SessionEntryList';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import {
  getDialogueCollapseLimit,
  getProjectCollapseLimit,
  getProjectSessionCollapseLimit,
} from './lib/sidebarCollapseConfig';
import { getSessionListCollapseView } from './lib/sessionListCollapse';
import { hasSessionSelectionModifier, type SessionClickModifiers } from './sidebar/SessionItem';
import type { SessionMoveTarget } from './sidebar/sessionMoveTarget';
import {
  DIALOGUE_FILTER_KEY,
  projectFilterIncludes,
  mergeVisibleReorder,
  normalizeManualPinnedOrder,
} from './hooks/helpers/sidebarFilterCore';
import {
  activePinnedSidebarEntryIds,
  pinnedProjectEntryId,
  projectKeyFromPinnedEntryId,
} from './lib/pinnedSidebarOrder';
import { createLogger } from '@/lib/logger';
import { useProjectPickerOptions } from '@/hooks/useProjectPickerOptions';
import { evictDeviceCapabilities, prefetchDeviceCapabilities } from '@/hooks/useAgentCapabilities';
import { evictDeviceProviders, prefetchDeviceProviders } from '@/hooks/useDeviceProviders';
import {
  evictDeviceGitSafetySettings,
  prefetchDeviceGitSafetySettings,
} from '@/hooks/useGitSafetySettings';
import { recentWorkdirsStore } from '@/lib/recentWorkdirsStore';
import {
  requestRemoteSessionStatus,
  useRemoteArchivedFailedDeviceIds,
  useRemoteArchivedLoadedDeviceIds,
  useRemoteArchivedLoadingDeviceIds,
  useRemoteDevices,
  isRemoteDeviceMarkedDisconnected,
  useRemoteProjectSessions,
} from '@/features/device-link/remoteProjectsStore';
import {
  selectVisibleSessions,
  setSelectedMachineIdTransient,
  MACHINE_ALL,
  MACHINE_LOCAL,
} from '@/features/device-link/selectedMachineStore';
import {
  isDeviceLinkWriteBlocked,
  isRemoteSessionWriteBlocked,
} from './lib/remoteSessionWriteGuard';
import {
  selectRemoteSessionBootstrapFailures,
  selectRemoteSessionBootstrapLoadingDevices,
  useEffectiveSelectedMachineId,
  useRemoteSessionBootstrapFailures,
  useRemoteSessionBootstrapLoading,
  useRemoteSessionBootstrapLoadingDevices,
  useSelectedMachineConnecting,
  useSwitcherDevices,
} from '@/features/device-link/useMachineSwitcher';
import {
  retryDeviceLinkDeviceList,
  useDeviceLinkDeviceListSettled,
  useDeviceLinkDeviceListRequestState,
} from '@/features/device-link/useDeviceLinkDeviceList';
import {
  useDeleteScheduleWithSessions,
  type DeletedScheduleGeneratedSessionResult,
} from '@/features/scheduler/hooks/useDeleteScheduleWithSessions';
import { resolveDialogueDeviceTarget, type DialogueDeviceTarget } from './lib/dialogueCreateTarget';
import { makeDialogueNewMakerRouteState } from './lib/newMakerRouteState';

const log = createLogger('CCAgentSidebarUpper');
// perf-baseline(与 MessageStream 的 perf/session-switch 探针同通道):
// sidebar:click 打点补上「点击时刻 → stream:mount」这段既有探针的盲区,
// 三条日志(click / mount / first-paint)按 sid + 时间戳对齐即得端到端耗时。
const perfLog = createLogger('perf/session-switch');

function makeNewMakerRouteState(workspacePrompt: 'generic' | 'dialogue') {
  return { workspacePrompt };
}

/** Last segment of a workdir path. Cross-platform safe (POSIX or Win backslash). */
function basenameOfPath(p: string): string {
  if (!p) return '';
  const norm = stripTrailingPathSeparators(p);
  const slash = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  return slash < 0 ? norm : norm.slice(slash + 1);
}

const LAST_ACTIVITY_DAY_COUNTS: Record<
  Exclude<UseSidebarFilterReturn['lastActivity'], 'all'>,
  number
> = {
  '1d': 1,
  '3d': 3,
  '7d': 7,
  '30d': 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;

type BulkSessionAction = 'archive' | 'delete';

function RemoteSidebarLoadNotice({
  kind,
  status,
  deviceLabel,
  partial,
  onRetry,
}: {
  kind: 'tasks' | 'devices';
  status: 'loading' | 'error';
  deviceLabel?: string;
  partial: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const isError = status === 'error';
  // tasks 的读取失败有完整自动恢复链路(10s 起对账退避重试 + 熔断探测恢复后自动重新
  // bootstrap),失败态只是「自动重试进行中」的状态说明,不是要求用户行动的告警——
  // 用中性样式 + role=status,且**不提供手动按钮**(2026-08 弱网实测反馈:重连必须
  // 全自动,红色 alert + 按钮读起来像必须人工干预)。devices 目录失败没有等价的
  // 自动重试,保持告警 + 手动重试。
  const autoRetrying = isError && kind === 'tasks';
  const alarming = isError && !autoRetrying;
  const messageKey =
    kind === 'tasks'
      ? status === 'loading'
        ? 'ccAgent.sidebar.machineSwitcher.tasksLoading'
        : partial
          ? 'ccAgent.sidebar.machineSwitcher.tasksPartiallyFailed'
          : 'ccAgent.sidebar.machineSwitcher.tasksLoadFailed'
      : status === 'loading'
        ? 'ccAgent.sidebar.machineSwitcher.devicesLoading'
        : partial
          ? 'ccAgent.sidebar.machineSwitcher.devicesPartiallyFailed'
          : 'ccAgent.sidebar.machineSwitcher.devicesLoadFailed';
  return (
    <div
      role={alarming ? 'alert' : 'status'}
      className={cn(
        'border',
        alarming
          ? 'border-[var(--error-border)] bg-[var(--error-bg)] text-[var(--error-fg)]'
          : 'border-[var(--border-default)] bg-[var(--surface-chip)] text-[var(--text-secondary)]',
        partial
          ? 'mx-3 flex items-start gap-2 rounded-[8px] px-3 py-2'
          : 'mx-3 flex flex-col items-center gap-3 rounded-[12px] px-4 py-8 text-center',
      )}
    >
      {isError ? (
        <CircleAlert size={partial ? 14 : 20} className="shrink-0" />
      ) : (
        <span className="inline-flex shrink-0 animate-spinner motion-reduce:animate-none">
          <Loader2 size={partial ? 14 : 20} />
        </span>
      )}
      <div className={cn('min-w-0', partial && 'flex-1')}>
        <p className={cn(partial ? 'text-11 leading-[1.45]' : 'text-xs leading-relaxed')}>
          {t(messageKey, { device: deviceLabel })}
        </p>
      </div>
      {alarming && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full font-medium',
            'text-[var(--error-fg-strong)] transition-colors hover:bg-[var(--surface-hover)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
            partial ? 'h-6 px-2 text-11' : 'h-7 px-3 text-xs',
          )}
        >
          <RefreshCw size={12} />
          {t('ccAgent.sidebar.machineSwitcher.retryDevices')}
        </button>
      )}
    </div>
  );
}

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function cutoffForLastActivity(
  lastActivity: UseSidebarFilterReturn['lastActivity'],
): number | null {
  if (lastActivity === 'all') return null;
  return Date.now() - LAST_ACTIVITY_DAY_COUNTS[lastActivity] * DAY_MS;
}

/* ============================== Root ============================== */

export function CCAgentSidebarUpper() {
  const { t } = useTranslation();
  const localPlatform = window.electronAPI.platform;
  const isCollapsed = useSidebarCollapsedState();
  // 展开态由本 Feature 在自己的列表滚动区里渲染顶部导航的可滚动段(自动任务 /
  // 插件 / 搜索 / 远程机器),shell 顶部只留固定的「新建」——列表上滚时这些行一起
  // 滚走(2026-08-12 用户裁决,对齐 Codex)。rail 态没有该滚动区,交回 shell 整块渲染。
  useOwnTopNavScrollableRows(!isCollapsed);
  // 错误红点的派生真源:拉取存在未处理告警(中断 ∪ 未 dismissed 错误尾行)的会话
  // 并在收敛触发点重算 —— 横幅不被处置,红点就不消失。
  usePendingAlertAttention();
  // F-PJ-10：filter.status 决定后端 fetch 时是否带 ?status=archived|all
  const hiddenProjects = useHiddenProjects();
  const { hiddenProjectKeys, initialSnapshot: sidebarSettingsSnapshot } = hiddenProjects;
  const filter = useSidebarFilter(hiddenProjectKeys, sidebarSettingsSnapshot);
  const includeArchived = filter.status;
  const sessionsHook = useCCSessions({ includeArchived });
  const { sessions: allSessionsForAttention } = useCCSessions({ includeArchived: 'all' });
  const remoteProjectSessions = useRemoteProjectSessions();
  const remoteDevices = useRemoteDevices();
  const selectedMachineId = useEffectiveSelectedMachineId();
  const searchProjectSessions = useMemo(
    () =>
      selectVisibleSessions(
        allSessionsForAttention,
        remoteProjectSessions,
        selectedMachineId,
      ).filter((session) => !isOrcaWorkerSession(session)),
    [allSessionsForAttention, remoteProjectSessions, selectedMachineId],
  );
  const projectAliases = useProjectAliases();
  const searchProjectGroups = useProjectGroups(searchProjectSessions, projectAliases.aliases);
  const restorableSelectionProjectKeys = useMemo(
    () => new Set(searchProjectGroups.projects.map((project) => project.projectKey)),
    [searchProjectGroups.projects],
  );
  const restorableSelectionProjectKeysRef = useRef(restorableSelectionProjectKeys);
  restorableSelectionProjectKeysRef.current = restorableSelectionProjectKeys;
  useLayoutEffect(
    () =>
      registerSidebarProjectRestoreHandler((projectKey) =>
        restoreSelectedHiddenProject({
          projectKey,
          hiddenProjectKeys,
          setProjectHidden: hiddenProjects.setProjectHidden,
          getCurrentProjectKeys: () => restorableSelectionProjectKeysRef.current,
          ensureProjectIncluded: filter.ensureProjectIncluded,
          localPlatform,
        }),
      ),
    [
      filter.ensureProjectIncluded,
      hiddenProjectKeys,
      hiddenProjects.setProjectHidden,
      localPlatform,
    ],
  );
  const visibleSearchProjects = useMemo(
    () => visibleSidebarProjects(searchProjectGroups.projects, hiddenProjectKeys, localPlatform),
    [searchProjectGroups.projects, hiddenProjectKeys, localPlatform],
  );
  const visibleSearchSessionIds = useMemo(
    () =>
      sidebarSessionsWithHiddenProjectsAsDialogues(
        searchProjectSessions,
        hiddenProjectKeys,
        localPlatform,
      ).map((session) => session.id),
    [searchProjectSessions, hiddenProjectKeys, localPlatform],
  );
  const attentionNotifications = useSessionAttentionSnapshot();
  const scheduleSessionIndex = useAutomationScheduleSessionIndex();
  // 侧栏右侧 urgent 红点的"额外"来源:定时任务未读且失败(status != 'success')。
  // sessionAttentionStore 只跟踪 chat 内 attention;schedule 未读通过 sidebarNotifications
  // 合并进 hasAttentionNotification,但 attentionKind 缺失导致默认走绿(见 SessionItem
  // 三档优先级)。这里独立算一份"失败 schedule session ids",通过 context 让 SessionItem
  // 把它们提到 urgent 红档,避免"失败的 automation 被涂成 Completed"的误导。
  const unreadFailedScheduleSessionIds = useMemo(() => {
    const next = new Set<string>();
    for (const [sessionId, info] of scheduleSessionIndex) {
      if (info.hasUnreadFailedRun) next.add(sessionId);
    }
    return next;
  }, [scheduleSessionIndex]);
  const navigate = useNavigate();
  const automationAttentionSessionIds = useMemo(
    () =>
      allSessionsForAttention
        .filter(
          (s) =>
            isAutomationGeneratedSession(s) &&
            (attentionNotifications.has(s.id) ||
              scheduleSessionIndex.get(s.id)?.hasUnreadRun === true),
        )
        .map((s) => s.id),
    [allSessionsForAttention, attentionNotifications, scheduleSessionIndex],
  );
  // automationAttentionSessionIds 仅供下方「全部标为已读」右键菜单使用;导航栏 /
  // rail 的自动化入口不再显示未读 dot(未读 / 运行状态改由各 schedule 组头承载)。

  // Automations 按钮右键菜单：复用 TaskListCell 的 "controlled DropdownMenu + 不可见 trigger 跟坐标"模式，
  // state 提到 root —— 折叠/展开两个视图都用同一个 button 概念,菜单只渲染一次,避免两份重复 state。
  const [automationsMenuPos, setAutomationsMenuPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const handleAutomationsContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAutomationsMenuPos({ x: e.clientX, y: e.clientY });
  }, []);
  const handleMarkAllAutomationsRead = useCallback(async () => {
    setAutomationsMenuPos(null);
    // 先清 done / awaiting(passive,store 对 error 免疫):这部分是纯未读标记,
    // 展示过就算已读,不需要落库处置。
    clearSessionAttentionMany(automationAttentionSessionIds);
    // error 红点是未处理告警的派生投影,**必须先落库处置再清点**:此前是乐观先清、
    // 失败只记日志,一旦 dismissPendingAlerts 拒绝或只处理了部分会话,横幅仍在库里
    // 而红点已经消失(还连带发了 explicit 桥接 / 远程回执),正是本 PR 要消灭的割裂。
    // 现在成功才 explicit 清,失败则重算把仍存在的告警点恢复回来。
    try {
      const { processed, failed } = await window.electronAPI.localDb.sessions.dismissPendingAlerts(
        automationAttentionSessionIds,
      );
      // 只清 main 侧**确切回报处置成功**的会话。不能用「不在 failed 里」推断成功:
      // 请求集合里可能有本 IPC 根本不处理的告警来源(如 WorktreeRestoreBanner 打的
      // 红点),那些会话既不成功也不失败,误清后重算也恢复不了(worktree 告警不进
      // 那条查询)。
      clearSessionAttentionMany(processed, { intent: 'explicit' });
      if (failed.length > 0) log.warn('some pending alerts were not dismissed', failed);
    } catch (e) {
      log.warn('dismiss pending alerts failed', e);
    }
    // 成功与失败都重算一次:成功路径收敛掉残留,失败路径把红点恢复成库里的真实告警。
    void refreshPendingAlerts();
    try {
      const updated = await markAllScheduleRunsReadAndSync();
      if (updated > 0) {
        toast.success(t('ccAgent.layout.markedAsRead', { count: updated }));
      }
    } catch (e) {
      toast.error(
        t('ccAgent.layout.markAllReadFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }, [automationAttentionSessionIds, t]);

  // Sidebar is rendered outside the :sessionId route, so useParams won't work.
  // Use useMatch to extract the active session id from the URL.
  const match = useMatch('/cc-agent/:sessionId');
  const orcaMatch = useMatch('/cc-agent/orca/:sessionId');
  const activeSessionId = orcaMatch?.params.sessionId ?? match?.params.sessionId;

  // Workdir-browse mode (skillhub Market sidebar pattern). When the user
  // clicked the file-text button on a Project, we swap sidebar contents to
  // the lazy file tree of that session's workdir.
  const filesMatch = useMatch('/cc-agent/files/:sessionId');
  const filesSessionId = filesMatch?.params.sessionId;
  const filesSession = useMemo(
    () => resolveDocModeFilesSession(allSessionsForAttention, filesSessionId),
    [allSessionsForAttention, filesSessionId],
  );
  const hiddenProjectComparisonKeys = useMemo(
    () => buildProjectKeyComparisonSet(hiddenProjectKeys, localPlatform),
    [hiddenProjectKeys, localPlatform],
  );
  const docModeSwitchProjects = useMemo(() => {
    const switchableSessions = allSessionsForAttention.filter((s) => !isOrcaWorkerSession(s));
    return buildDocModeSwitchProjects(switchableSessions).filter(
      (project) =>
        !projectKeyComparisonSetHas(hiddenProjectComparisonKeys, project.projectKey, localPlatform),
    );
  }, [allSessionsForAttention, hiddenProjectComparisonKeys, localPlatform]);
  const filesProjectKey = filesSession ? projectIdentityKeyForSession(filesSession) : null;

  // Refresh sessions only when a NEW session appears (e.g. after index redirect
  // creates a new session via its own hook instance). Clicking an existing
  // session in the list must NOT trigger a list refresh (avoids updatedAt re-sort).
  const { refreshSessions } = sessionsHook;
  const prevSessionRef = useRef(activeSessionId);
  useEffect(() => {
    if (activeSessionId && activeSessionId !== prevSessionRef.current) {
      prevSessionRef.current = activeSessionId;
      // Only refresh if the new session isn't already in the list (= just created)
      const isInList = sessionsHook.sessions.some((s) => s.id === activeSessionId);
      if (!isInList) {
        refreshSessions();
      }
    }
  }, [activeSessionId, refreshSessions, sessionsHook.sessions]);

  // rail / reorder 与展开态(ExpandedView)同口径:都把 device-link 远程会话并进来——
  // 否则置顶的远程会话一拖进 rail 模式就消失、也无法从 rail 打开(codex review)。
  // 机器切换栏选中某机器后按 selectedMachineId 整体过滤(本机 → 只本地;远程 → 只该机器),
  // rail 与展开态共用同一选择态,保证 rail 折叠后仍尊重选中机器。
  useEffect(() => {
    if (filter.status === 'active') return;
    const selectedRemoteIds =
      selectedMachineId === MACHINE_ALL
        ? null
        : new Set(selectedMachineId.filter((deviceId) => deviceId !== MACHINE_LOCAL));
    for (const device of remoteDevices) {
      if (!device.connected) continue;
      if (selectedRemoteIds && !selectedRemoteIds.has(device.deviceId)) continue;
      requestRemoteSessionStatus(device.deviceId, 'archived');
    }
  }, [filter.status, remoteDevices, selectedMachineId]);
  const sessionsWithRemote = useMemo(
    () => selectVisibleSessions(sessionsHook.sessions, remoteProjectSessions, selectedMachineId),
    [sessionsHook.sessions, remoteProjectSessions, selectedMachineId],
  );
  const statusFilteredSessionsWithRemote = useMemo(
    () =>
      sessionsWithRemote.filter((session) =>
        matchesSidebarSessionStatus(session, filter.status, sessionsHook.effectiveIncludeArchived),
      ),
    [filter.status, sessionsHook.effectiveIncludeArchived, sessionsWithRemote],
  );
  const visibleSessionsWithRemote = useMemo(
    () =>
      sidebarSessionsWithHiddenProjectsAsDialogues(
        statusFilteredSessionsWithRemote,
        hiddenProjectKeys,
        localPlatform,
      ),
    [statusFilteredSessionsWithRemote, hiddenProjectKeys, localPlatform],
  );

  /* Codex Micro 的 6 个任务键跟侧栏走。主进程只能查本地 sessions 表,看不见被控
   * 机器上的任务(它们只活在渲染端的 remote store 里),也不知道用户当前选了哪台
   * 机器 —— 光靠主进程投影,连着远程用时 6 个键会全是空的。所以由这里上报。
   *
   * 顺序取真实渲染顺序(与 mod+1..9、旋钮切任务同一个口径),不是
   * visibleSessionsWithRemote 那份扁平的「按最近更新排序」列表 —— 后者不含置顶区
   * 与项目分组,和用户眼里看到的顺序对不上,AG00 会指向列表里根本不在第一行的任务。
   * 不限定容器:展开态与 rail 折叠态是两个不同组件,扫整个 document 才能两种形态
   * 都覆盖。只送键盘需要的三个字段,不整份 session 过 IPC。 */
  const publishedTaskKeyRef = useRef<string>('');
  const publishSidebarTasks = useCallback(() => {
    if (isSecondaryWindow()) return;
    const renderedIds = getVisibleSidebarSessionIds();
    const sidebarOrder = new Map(renderedIds.map((id, index) => [id, index] as const));
    // 空可见列表也要上报:换机器、折叠或搜索把可见行清掉时,侧栏映射必须让位,
    // 否则 AG 键还会打开上一份已经看不见的任务。完整活动表仍要带上,最近发送
    // / 优先 / 自定义不能被折叠裁掉。
    const catalogSessions = sessionsWithRemote.filter((session) => session.status === 'active');
    const visibleProjection = visibleSessionsWithRemote
      .filter((session) => !catalogSessions.some((active) => active.id === session.id))
      .slice(0, WORKLOUDER_CODEX_AGENT_SLOT_COUNT);
    const remainingCatalogSlots = Math.max(0, 100 - visibleProjection.length);
    const tasks = [...visibleProjection, ...catalogSessions.slice(0, remainingCatalogSlots)].map((session) => {
      const pinnedAtMs = session.pinnedAt ? Date.parse(session.pinnedAt) : Number.NaN;
      const userSendAtMs = session.userSendAt ? Date.parse(session.userSendAt) : Number.NaN;
      const order = sidebarOrder.get(session.id);
      const isActiveCatalog = session.status === 'active';
      return {
        id: session.id,
        title: session.title ?? null,
        pinnedAt: Number.isFinite(pinnedAtMs) ? pinnedAtMs : null,
        userSendAt: Number.isFinite(userSendAtMs) ? userSendAtMs : null,
        ...(order === undefined ? {} : { sidebarOrder: order }),
        ...(isActiveCatalog ? {} : { catalogEligible: false }),
      };
    });
    // 侧栏会因为各种无关状态重算;内容没变就不打扰主进程。
    const key = JSON.stringify(tasks);
    if (key === publishedTaskKeyRef.current) return;
    publishedTaskKeyRef.current = key;
    void window.electronAPI?.workLouderCodex?.publishTasks?.(tasks)?.catch(() => {
      // 键盘没接或 IPC 不可用都不影响侧栏本身。
      publishedTaskKeyRef.current = '';
    });
  }, [sessionsWithRemote, visibleSessionsWithRemote]);
  useEffect(() => {
    publishSidebarTasks();
    // 展开/折叠项目、分组重排这类纯 UI 变化不会动 visibleSessionsWithRemote,
    // 但会改渲染顺序 —— 跟序号徽标同样的做法,靠 DOM 变化跟住。
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    // 观察面是整个 document(展开态与 rail 是两个组件),流式输出时 mutation 会非常
    // 密集 —— 每帧最多重算一次,别让它变成热路径。
    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        publishSidebarTasks();
      });
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'aria-hidden'],
    });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [publishSidebarTasks]);

  // rail 未读集与展开态(ExpandedView.sidebarNotifications)同口径:把"定时任务有未读运行"的
  // 会话并入 attention 未读集。否则 rail 模式下,靠 scheduleSessionIndex 恢复的定时任务
  // 完成未读(如重启后 attention store 还没填充)会丢绿点(codex review)。
  const railNotifications = useMemo(() => {
    const unread = new Set<string>();
    for (const [sessionId, info] of scheduleSessionIndex) {
      if (info.hasUnreadRun) unread.add(sessionId);
    }
    if (unread.size === 0) return attentionNotifications;
    return new Set([...attentionNotifications, ...unread]);
  }, [attentionNotifications, scheduleSessionIndex]);

  useOrcaWorkerAttentionWatcher(sessionsHook.sessions, activeSessionId);

  // rail 置顶瓷砖拖拽:与展开态 handlePinnedReorder 同一持久化语义(全量
  // baseline GC + 可见子集原位 merge)。rail 可见子集按机器切换过滤
  // (sessionsWithRemote),merge 保证其它机器的置顶不丢位、不被挪去末尾。
  const handleRailPinnedReorder = useCallback(
    (visibleNewOrder: string[]) => {
      const pinnedSessionIds = pinnedSessionIdsInDisplayOrder([
        ...sessionsHook.sessions,
        ...remoteProjectSessions,
      ]);
      const fullActivePinnedIds = activePinnedSidebarEntryIds(
        filter.manualPinnedOrder,
        pinnedSessionIds,
      );
      const baseOrder = normalizeManualPinnedOrder(filter.manualPinnedOrder, fullActivePinnedIds);
      const merged = mergeVisibleReorder(baseOrder, visibleNewOrder);
      void filter.setManualPinnedOrder(merged, fullActivePinnedIds, baseOrder).catch((err) => {
        log.warn('failed to persist rail pinned order', err);
        toast.error(t('ccAgent.sidebar.pinFailed'));
      });
    },
    [sessionsHook.sessions, remoteProjectSessions, filter, t],
  );

  return (
    // F-PJ-7 Tooltip.Provider 顶层包一次：所有 SessionItem / ProjectNode / Toggle 共享 500ms delay。
    // skipDelayDuration 放宽到 1500ms(默认 200):tip 弹出过之后在列表行间移动
    // 保持"热态"即时切换——PR tips 行间穿插着无 tip 的普通行,默认窗口太短,
    // 路过几行热态就丢了,体感退回"每行都要重新等 500ms"(session-git-pr-context)。
    <Tooltip.Provider skipDelayDuration={1500}>
      <SessionAttentionUrgencyProvider urgentSessionIds={unreadFailedScheduleSessionIds}>
        <div className="relative flex flex-1 flex-col overflow-hidden">
          {/* Expanded — fade out when collapsed.
          min-w-0 让内层跟着外层 aside 的实际宽度走，配合 SessionItem 里的
          `min-w-0 flex-1 truncate` 才能正确截断。原来写死 min-w-[260px] 是
          为了避免 collapse 动画期间 text reflow，但当用户把侧边栏拖到
          260 以下时，这个固定宽会让内容超出可视区被 overflow-hidden 砍掉，
          表现为 SessionItem 文字被右侧裁切。 */}
          <div
            className={cn(
              'absolute inset-0 min-w-0 flex flex-col overflow-hidden',
              'transition-opacity duration-200 ease-in-out',
              isCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100',
            )}
          >
            {/* SSH remote 会话不再被排除:WorkdirBrowseSidebar 已支持 remoteHostId
              (P1 解禁),旧门控留着会让 doc 模式对 SSH 会话退回项目列表、无
              远端文件树入口。 */}
            {filesSession && filesSession.workingDir ? (
              <WorkdirBrowseSidebar
                sessionId={filesSession.id}
                workdir={filesSession.workingDir}
                remoteHostId={filesSession.remoteHostId ?? null}
                deviceId={getSessionDeviceId(filesSession.id) ?? null}
                displayName={basenameOfPath(filesSession.workingDir)}
                projectKey={filesProjectKey}
                switchProjects={docModeSwitchProjects}
              />
            ) : null}
            {/* ExpandedView 在 doc 模式下也保持挂载(display:none):折叠 rail 的
              项目/对话面板(RailPanels)由它渲染且是唯一挂载点,doc 模式卸载会让
              files 路由 + 折叠时 rail 入口变成永远弹不出面板的死按钮(codex
              review)。面板经 portal 渲染到 body,不受隐藏 wrapper 影响;files
              路由下 activeSessionId 为 undefined,ExpandedView 的路由驱动
              effects 全部自然停摆,不与 WorkdirBrowseSidebar 抢行为。 */}
            <div
              className={cn(
                'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
                filesSession && filesSession.workingDir && 'hidden',
              )}
              aria-hidden={filesSession && filesSession.workingDir ? true : undefined}
            >
              <ExpandedView
                sessionsHook={sessionsHook}
                navigate={navigate}
                activeSessionId={activeSessionId}
                // 兜底直接用路由参数而非 filesSession?.id:filesSession 只从本地
                // 会话表解析,device-link 远程会话的文件视图(WorkdirBrowseRoute
                // 按远程镜像解析)会解析不到,面板豁免/高亮与重定向判定就会丢
                // (codex review)。id 相等性语义不需要完整 Session 对象。
                viewedSessionId={activeSessionId ?? filesSessionId}
                filter={filter}
                hiddenProjects={hiddenProjects}
                projectAliases={projectAliases}
                scheduleSessionIndex={scheduleSessionIndex}
              />
            </div>
          </div>

          {/* Collapsed — fade in when collapsed */}
          <div
            className={cn(
              'absolute inset-0 flex flex-col overflow-hidden',
              'transition-opacity duration-200 ease-in-out',
              isCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none',
            )}
          >
            <CollapsedView
              navigate={navigate}
              onAutomationsContextMenu={handleAutomationsContextMenu}
              allSearchProjects={visibleSearchProjects}
              searchableSessionIds={visibleSearchSessionIds}
              hiddenProjectKeys={hiddenProjectKeys}
              sessions={visibleSessionsWithRemote}
              activeSessionId={activeSessionId}
              notifications={railNotifications}
              manualPinnedOrder={filter.manualPinnedOrder}
              onReorderPinned={handleRailPinnedReorder}
            />
          </div>

          {/* Automations 按钮右键菜单 —— 折叠/展开两份按钮共用此渲染。trigger 跟着 click 坐标定位。 */}
          <DropdownMenu
            open={automationsMenuPos !== null}
            onOpenChange={(open) => {
              if (!open) setAutomationsMenuPos(null);
            }}
          >
            <DropdownMenuTrigger asChild>
              <span
                aria-hidden
                style={{
                  position: 'fixed',
                  left: automationsMenuPos?.x ?? 0,
                  top: automationsMenuPos?.y ?? 0,
                  width: 0,
                  height: 0,
                  pointerEvents: 'none',
                }}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={2}
              className={cn(
                'min-w-[180px] rounded-xl p-1 overflow-hidden',
                'bg-[var(--cmd-palette-bg)]',
                'border border-[var(--cmd-palette-border)]',
                'shadow-[var(--shadow-menu)]',
              )}
            >
              <DropdownMenuItem
                onSelect={() => void handleMarkAllAutomationsRead()}
                className="cursor-pointer text-sm text-[var(--msg-assistant-text)] hover:bg-[var(--cmd-palette-item-hover)]"
              >
                {t('ccAgent.layout.markAllAsRead')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </SessionAttentionUrgencyProvider>
    </Tooltip.Provider>
  );
}
/* ============================== Types ============================== */

type SessionsHook = ReturnType<typeof useCCSessions>;

/* ============================== Expanded ============================== */

interface ExpandedProps {
  sessionsHook: SessionsHook;
  navigate: ReturnType<typeof useNavigate>;
  activeSessionId: string | undefined;
  /** 「正在被用户注视」的会话 —— 供 attention 语义(running-status 通知豁免 /
   *  已读回执 / 系统角标清理)。files 路由下 activeSessionId 为 undefined 但用户
   *  正看着该会话的文件视图,完成/待回复不该按后台记未读(codex review);
   *  与 activeSessionId 分开传:后者还承担选中高亮与「点击同会话早退」语义,
   *  files 模式下从面板点击该会话仍要能导航回聊天视图。 */
  viewedSessionId: string | undefined;
  filter: UseSidebarFilterReturn;
  hiddenProjects: UseHiddenProjectsReturn;
  projectAliases: ReturnType<typeof useProjectAliases>;
  scheduleSessionIndex: ReturnType<typeof useAutomationScheduleSessionIndex>;
}

/** rail 未分类隐藏态的空列表(引用稳定,免得 lampScope 发布 effect 空转)。 */
const EMPTY_SESSION_LIST: Session[] = [];

/** State for the delete/archive confirm dialog. */
interface ConfirmState {
  open: boolean;
  sessionId: string;
  action: 'delete' | 'archive';
  /** P1: 会话 worktree 有未提交更改 → 确认文案追加警告(打开前预检)。 */
  dirtyWorktree: boolean;
}

const CONFIRM_INITIAL: ConfirmState = {
  open: false,
  sessionId: '',
  action: 'delete',
  dirtyWorktree: false,
};

function ExpandedView({
  sessionsHook,
  navigate,
  activeSessionId,
  viewedSessionId,
  filter,
  hiddenProjects,
  projectAliases,
  scheduleSessionIndex,
}: ExpandedProps) {
  const { t, i18n } = useTranslation();
  const localPlatform = window.electronAPI.platform;
  const { sessions, refreshSessions, patchLocal, effectiveIncludeArchived } = sessionsHook;
  const {
    hiddenProjectKeys,
    setProjectHidden,
    initialSnapshot: sidebarSettingsSnapshot,
  } = hiddenProjects;
  const refreshWorktrees = useRefreshWorktrees();
  const projectPickerOptions = useProjectPickerOptions();

  // 自动化任务本身仍在顶部 Automations 入口管理；自动化任务 fire 后创建出的
  // session 是普通会话,按 project/dialogue 与普通排序/红点逻辑进入 sidebar。
  const onScheduleMatch = useMatch('/cc-agent/scheduled');
  // SidebarTopNav 的“+ New”导航到 /cc-agent/new,而本组件跨 draft 路由常驻挂载,
  // 它不像项目内/对话内新建那样先清选择;据此在落到新建页时清掉残留的批量选择,
  // 避免批量操作条停留在 new-maker 屏上(PR #246 review)。对齐下方 onScheduleMatch 清理。
  const onNewMakerMatch = useMatch('/cc-agent/new');
  // "在此项目内搜索":搜索框已上移到 shell 的 SidebarTopNav,经全局 store 通信
  // (内部自增 requestId,SidebarTopNav 的搜索框据此打开并锁定该 project)。
  const handleOpenConversationSearch = useCallback((project: ProjectNode) => {
    requestConversationSearch({
      projectKey: project.projectKey,
      projectName: projectDisplayLabelWithMachine(project),
      sessionIds: project.sessions.map((session) => session.id),
      workingDir: project.workingDir,
      deviceLinkDeviceId: project.deviceLinkDeviceId,
    });
  }, []);
  // Archived All（右键菜单）走全局 ConfirmDialogProvider —— 与单条 archive 的 inline
  // ConfirmDialog 解耦，避免共用 confirm state 时语义混乱。
  const { confirm: confirmDialog } = useConfirmDialog();
  const handleScheduleDeleted = useCallback(
    async ({ disposition, affectedSessionIds }: DeletedScheduleGeneratedSessionResult) => {
      await refreshSessions();
      void refreshWorktrees();
      // 重定向判定用 viewedSessionId(files 路由兜底,与其余归档/删除 handler
      // 同口径):从面板删 schedule 连带清掉正在浏览的会话时也要跳离文件视图。
      if (
        disposition !== 'keep' &&
        viewedSessionId &&
        affectedSessionIds.includes(viewedSessionId)
      ) {
        navigate('/cc-agent');
      }
    },
    [viewedSessionId, navigate, refreshSessions, refreshWorktrees],
  );
  const { requestDeleteSchedule, deleteScheduleDialog } = useDeleteScheduleWithSessions({
    onDeleted: handleScheduleDeleted,
  });

  const pendingRunCleanupsRef = useRef<Map<string, () => void>>(new Map());
  // busy guard：fired 事件到达前阻止同 schedule 重复调用 runNow，避免双发 run/session。
  const pendingRunNowIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    return () => {
      pendingRunCleanupsRef.current.forEach((c) => c());
      pendingRunCleanupsRef.current.clear();
      pendingRunNowIdsRef.current.clear();
    };
  }, []);

  const handleScheduleAction = useCallback(
    async (group: AutomationSessionGroup, action: AutomationScheduleAction) => {
      if (!group.scheduleId) return;
      const scheduleId = group.scheduleId;
      const scheduleName = group.title;

      if (action === 'edit') {
        navigate(`/cc-agent/scheduled?focus=${encodeURIComponent(scheduleId)}&edit=${Date.now()}`);
        return;
      }

      if (action === 'run') {
        // [必改] per-schedule busy guard：fired 事件到达前阻止同 schedule 重复调用
        // runNow，避免双发 run/session，对齐 SchedulerPage 的 per-schedule busy 语义。
        if (pendingRunNowIdsRef.current.has(scheduleId)) return;
        pendingRunNowIdsRef.current.add(scheduleId);
        // 取消同一 schedule 的旧订阅，避免双击竞态
        pendingRunCleanupsRef.current.get(scheduleId)?.();
        // [必改] 关键时序：fired 事件在 runner.fire 中（session 创建前）触发，携带
        // runId；session-bound 随后到达，携带相同 runId + sessionId。先订阅事件：
        // (1) 收到 fired → 捕获 runId，释放 busy guard（允许用户再次点击）
        // (2) 收到 session-bound（runId 匹配）→ 导航到新 session
        // capturedRunId 为 null 时不导航，避免接受旧 run 的 session-bound 事件。
        // 15s 兜底超时，失败/静默/不 bind 场景不挂订阅。
        let capturedRunId: string | null = null;
        let done = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          if (done) return;
          done = true;
          pendingRunCleanupsRef.current.delete(scheduleId);
          pendingRunNowIdsRef.current.delete(scheduleId);
          off();
          if (timer) clearTimeout(timer);
        };
        const off = window.electronAPI.maker.schedule.onEvent((raw, ownerStamp) => {
          if (!isDataOwnerPushCurrent(ownerStamp)) return;
          const event = raw as SchedulerEvent;
          if (done) return;
          // 全局事件不含 scheduleId，提前过滤。
          if (event.type === 'all-read' || event.type === 'ready' || event.type === 'runtime-state')
            return;
          if (event.scheduleId !== scheduleId) return;
          if (event.type === 'fired') {
            // 捕获本次 run 的 runId，并释放 busy guard（run 已 fire，允许用户再次点击）
            capturedRunId = event.runId;
            pendingRunNowIdsRef.current.delete(scheduleId);
            return;
          }
          if (event.type !== 'session-bound') return;
          if (!event.sessionId) return;
          // fired 未到达前 capturedRunId 为 null，不导航（避免接受旧 run 的事件）
          if (capturedRunId === null) return;
          if (event.runId !== capturedRunId) return;
          const sessionId = event.sessionId;
          cleanup();
          void (async () => {
            const target = sessionsRef.current.find((s) => s.id === sessionId);
            navigate(await resolveSessionRoute(sessionId, target));
          })();
        });
        timer = setTimeout(cleanup, 15_000);
        pendingRunCleanupsRef.current.set(scheduleId, cleanup);
        try {
          await window.electronAPI.maker.schedule.runNow(scheduleId);
          // runNow 已成功返回但 session-bound 未在此期间到达（run 被 defer/skip）:
          // 立即清理，避免 15s 窗口内同 schedule 的其他 session-bound 触发误导航。
          // cleanup() 内部有 done guard —— 若 session-bound 已被处理，此调用为 no-op。
          cleanup();
        } catch (e) {
          cleanup();
          toast.error(
            t('scheduler.toast.runFailed', { error: e instanceof Error ? e.message : String(e) }),
          );
        }
        return;
      }

      if (action === 'toggle-pause') {
        try {
          if (group.scheduleStatus === 'paused') {
            await window.electronAPI.maker.schedule.resume(scheduleId);
            return;
          }
          if (group.scheduleStatus === 'expired') return;
          const inflight = await window.electronAPI.maker.schedule
            .getInflightCount(scheduleId)
            .catch(() => 0);
          if (inflight > 0) {
            const ok = await confirmDialog({
              title: t('scheduler.confirm.pause.title', { name: scheduleName }),
              description: t('scheduler.confirm.pause.withInflight', { count: inflight }),
              confirmText: t('scheduler.confirm.pause.confirm'),
              cancelText: t('scheduler.confirm.pause.cancel'),
            });
            if (!ok) return;
          }
          await window.electronAPI.maker.schedule.pause(scheduleId);
        } catch (e) {
          toast.error(
            t('scheduler.toast.actionFailed', {
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
        return;
      }

      requestDeleteSchedule({
        id: scheduleId,
        name: scheduleName,
        source: group.scheduleSource,
        workingDir: group.workingDir,
        projectConfigId: group.projectConfigId,
        knownSessionIds: group.sessions.map((session) => session.id),
      });
    },
    [confirmDialog, navigate, requestDeleteSchedule, t],
  );

  const [confirm, setConfirm] = useState<ConfirmState>(CONFIRM_INITIAL);

  // 系统级通知触发：sessions 数组每次渲染都新引用，但 hook 用 ref 转储 callback，
  // 不会因此重跑 transition effect。
  // 静音 + 失焦 gate 在这里，主进程不持有 enabled 状态。
  // Dock/taskbar 角标不是外发通知通道：App 在后台时即使桌面/飞书通知关闭,
  // 也要标记当前 session 需要关注；真正的 toast / 飞书仍然服从各自开关。
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // 通知文案里的「尚未起名」兜底。走 ref 与 sessionsRef 同款:fireSessionNotification
  // 是 `[]` 依赖的稳定回调,直接闭包 t 会钉住首次渲染的语言。
  const unnamedLabelRef = useRef('');
  unnamedLabelRef.current = t('ccAgent.common.unnamedSession');
  const fireSessionNotification = useCallback(
    (sessionId: string, kind: 'done' | 'error' | 'needs-reply') => {
      // 灵动岛启用时,完成提示由灵动岛承载,不再走系统 toast,避免同一事件双重打扰;
      // 灵动岛未启用(或平台不支持)时,继续用系统通知。飞书是独立外发通道,不受影响。
      const islandActive = isAgentIslandSupported() && getAgentIslandEnabled();
      const desktopEnabled = getNotificationsEnabled() && !islandActive;
      const feishuEnabled = getFeishuNotificationsEnabled();
      // 失焦才推 —— 见上注释。
      if (typeof document !== 'undefined' && document.hasFocus()) return;
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      // Orca worker 自身状态翻转不发独立通知 —— 等 lead 接到 worker_report 处理完
      // 再以 lead 名义统一推一条，避免同一事件双重打扰。语义上用户应回到 lead 主对话
      // 查看，而非跳到 worker 实现细节；与 effectiveRunningSessionIds 的角色聚合口径一致。
      if (session && isOrcaWorkerSession(session)) return;
      void window.electronAPI.notificationMarkSessionAttention(sessionId);
      // 哨兵过投影:toast / 飞书 / 手机推送里都不能出现内部哨兵 "New Maker"。
      // (手机推送用的是**桌面侧**语言 —— 标题在 wire payload 里是字面量,让手机按自己
      //  locale 投影要改协议,超出本 PR 范围;但无论如何都比露出哨兵好。)
      const title = projectDraftSessionTitle(session?.title, unnamedLabelRef.current);
      // mobile 通道恒开:桌面侧不设第二个开关,是否收到由手机端注册/注销推送 token
      // 决定;发送侧防打扰(远程正在看该会话 / 去重 / relay 能力)在 main 收口。
      // 因此桌面/飞书都关时也要 invoke(不再提前 return)。
      void window.electronAPI.notificationShowSessionEvent({
        sessionId,
        title,
        kind,
        channels: {
          desktop: desktopEnabled,
          feishu: feishuEnabled,
          mobile: true,
        },
      });
    },
    [],
  );
  const handleSessionDone = useCallback(
    (sessionId: string) => fireSessionNotification(sessionId, 'done'),
    [fireSessionNotification],
  );
  const handleSessionError = useCallback(
    (sessionId: string) => fireSessionNotification(sessionId, 'error'),
    [fireSessionNotification],
  );
  const handleSessionNeedsReply = useCallback(
    (sessionId: string) => fireSessionNotification(sessionId, 'needs-reply'),
    [fireSessionNotification],
  );

  // /ctr 接管中的 sessionIds 集合 — SessionItem 用这个把左侧 vendor icon
  // 切成 RadioTower (radio-tower) 表"被远程接管"。detach 后自动切回 vendor。
  const attachedSessionIds = useAttachedSessionIds();

  // F-SB-7: Session status indicators — running state + attention notifications
  // 「active」按 viewedSessionId:files 路由下用户注视的是该会话的文件视图,
  // 完成/待回复不能按后台会话记未读、发通知(codex review)。
  const { runningSessionIds, notifications, clearNotification } = useSessionRunningStatus(
    viewedSessionId,
    {
      onSessionDone: handleSessionDone,
      onSessionError: handleSessionError,
      onSessionNeedsReply: handleSessionNeedsReply,
    },
  );
  const attentionKinds = useSessionAttentionKinds();
  const urgentSet = useSessionAttentionUrgencySet();
  const unreadScheduleSessionIds = useMemo(() => {
    const next = new Set<string>();
    for (const [sessionId, info] of scheduleSessionIndex) {
      if (info.hasUnreadRun) next.add(sessionId);
    }
    return next;
  }, [scheduleSessionIndex]);
  const sidebarNotifications = useMemo(() => {
    if (unreadScheduleSessionIds.size === 0) return notifications;
    return new Set([...notifications, ...unreadScheduleSessionIds]);
  }, [notifications, unreadScheduleSessionIds]);
  const remoteActivityRevision = useRemoteSessionActivityRevision();

  const markAutomationSessionRunsRead = useCallback(
    (sessionId: string) => {
      const info = scheduleSessionIndex.get(sessionId);
      if (!info?.unreadRunIds.length) return;
      // …AndSync:settle 后无条件触发 renderer 本地刷新。跨实例场景下这些 runId
      // 可能在 DB 里早已被另一实例标为已读(main no-op 且不广播),没有本地刷新
      // 通道的话,这里的过期未读快照永远等不到事件、红点无法自愈。
      void markScheduleRunsReadAndSync(info.unreadRunIds);
    },
    [scheduleSessionIndex],
  );
  const orcaLeadWorkerMap = useOrcaLeadWorkerMap(sessions);
  const effectiveRunningSessionIds = useMemo(() => {
    const next = new Set(runningSessionIds);
    for (const [leadSessionId, workerSessionIds] of orcaLeadWorkerMap) {
      for (const workerSessionId of workerSessionIds) {
        if (runningSessionIds.has(workerSessionId)) {
          next.add(leadSessionId);
          break;
        }
      }
    }
    return next;
  }, [orcaLeadWorkerMap, runningSessionIds]);
  // 后台子任务活跃会话(turn 已结束但 CC 子进程仍在调模型)也点亮同一个呼吸指示。
  // 单独一个**纯视觉**集合:effectiveRunningSessionIds 除了喂列表显示还是
  // handleMoveSession 的运行中拦截闸门,后台活动不得静默扩大行为闸门的口径
  // (move / 归档 / 通知语义都保持只认真 running)。
  const backgroundActivitySessionIds = useBackgroundActivitySessionIds();
  // 刚发送尚未 isRunning 的任务并进 display running:排序与呼吸点马上进运行中档,
  // 但不扩大 effectiveRunningSessionIds 的归档 / 移动闸门。
  const startingSessionIds = useStartingSessionIds(runningSessionIds);
  const displayRunningSessionIds = useMemo(() => {
    if (backgroundActivitySessionIds.size === 0 && startingSessionIds.size === 0) {
      return effectiveRunningSessionIds;
    }
    const next = new Set(effectiveRunningSessionIds);
    for (const id of backgroundActivitySessionIds) next.add(id);
    for (const id of startingSessionIds) next.add(id);
    for (const [leadSessionId, workerSessionIds] of orcaLeadWorkerMap) {
      if (next.has(leadSessionId)) continue;
      for (const workerSessionId of workerSessionIds) {
        if (
          backgroundActivitySessionIds.has(workerSessionId) ||
          startingSessionIds.has(workerSessionId)
        ) {
          next.add(leadSessionId);
          break;
        }
      }
    }
    return next;
  }, [
    effectiveRunningSessionIds,
    backgroundActivitySessionIds,
    startingSessionIds,
    orcaLeadWorkerMap,
  ]);
  const collapsedAttentionToneFor = useCallback(
    (sessions: readonly Session[]) =>
      resolveCollapsedProjectAttentionTone({
        sessions,
        runningSessionIds: displayRunningSessionIds,
        notifications: sidebarNotifications,
        attentionKinds,
        urgentSessionIds: urgentSet,
        remotePhaseOf: (sessionId) => getRemoteSessionActivity(sessionId)?.phase,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remoteActivityRevision 代表 getRemoteSessionActivity 读到的整表内容
    [
      displayRunningSessionIds,
      sidebarNotifications,
      attentionKinds,
      urgentSet,
      remoteActivityRevision,
    ],
  );

  // 本地会话用 effectiveIncludeArchived（snapshot 实际所属桶）避免切桶时先闪空；
  // device-link 远程镜像同时持有 active / archived 两桶，必须独立按 filter.status 筛选，
  // 否则本地 archived/all 请求慢或失败时会把已加载的远程归档行持续隐藏。
  //
  // 单 status 桶为何要按桶 status 显式过滤(而不是直接信任桶内全是同 status):
  // patchLocal 是跨桶 in-place mutation —— doc 模式归档(WorkdirBrowseRoute)
  // 用自己的 'all' 桶 refresh, sidebar 持有的 'active' 桶不会被刷,
  // patchLocal 留下的 status='archived' 污染就一直挂在 active 桶里,
  // 没有这道过滤就会带着 Archive 图标漏到 project 列表里。
  // device-link 跨设备远程控制:被控设备的会话(内存层,已打 deviceLinkDeviceId 标记)
  // 与本地会话一视同仁并入同一份列表 → groupSessions 自动归到独立 device: 远程项目。
  // 远端会话不在本地 DB,故走独立 store,不污染 sessionsStore / 本地链路。
  const remoteProjectSessions = useRemoteProjectSessions();
  // 机器切换栏选中机器后整体过滤:本机 → 只本地会话;远程 → 只该机器会话。
  // 过滤在源头做,下游 grouping / pinned / projects / dialogues / date-grouped / search 自动继承。
  const selectedMachineId = useEffectiveSelectedMachineId();
  const localHostProjectOrder = useLocalHostProjectOrder({
    custom: filter.projectOrder === 'custom',
    keys: filter.manualProjectOrder,
  });
  const { orders: remoteHostProjectOrders } = useRemoteHostProjectOrders(selectedMachineId);
  const switcherDevices = useSwitcherDevices();
  // E 期「按设备分组」:远程设备顺序 + 名称/在线状态(设备切换栏同序同源)。
  // 空 map = 没有远程设备 → ProjectsSection 隐藏该分组选项、不切段。
  const remoteDeviceIndex = useMemo(() => {
    const index = new Map<string, { name: string; online: boolean }>();
    for (const device of switcherDevices) {
      if (device.status === 'rejected') continue;
      // connecting 含两种:真在连,以及断线缓存。后者不能撑开设备分组,
      // 否则最后一台远程掉线后仍会留下「本机」段头;重连后偏好自动恢复。
      if (device.status === 'connecting' && isRemoteDeviceMarkedDisconnected(device.deviceId)) {
        continue;
      }
      index.set(device.deviceId, {
        name: device.name,
        online: device.status === 'connected',
      });
    }
    return index;
  }, [switcherDevices]);
  const deviceListSettled = useDeviceLinkDeviceListSettled();
  const selectedDialogueDeviceResolution = useMemo(
    () => resolveDialogueDeviceTarget(selectedMachineId, switcherDevices, deviceListSettled),
    [selectedMachineId, switcherDevices, deviceListSettled],
  );
  const dialogueCreatePending = selectedDialogueDeviceResolution.status === 'pending';
  // 「所有」或含远程设备的作用域还要等 device-link 首次 sessions snapshot；
  // 否则本地 sessions 先完成时会把尚未知的远程空数组误报成真实空态。
  const activeRemoteSessionBootstrapLoading = useRemoteSessionBootstrapLoading(selectedMachineId);
  const activeRemoteSessionBootstrapLoadingDevices =
    useRemoteSessionBootstrapLoadingDevices(selectedMachineId);
  const activeRemoteSessionBootstrapFailures = useRemoteSessionBootstrapFailures(selectedMachineId);
  const archivedLoadingDeviceIds = useRemoteArchivedLoadingDeviceIds();
  const archivedFailedDeviceIds = useRemoteArchivedFailedDeviceIds();
  const archivedLoadedDeviceIds = useRemoteArchivedLoadedDeviceIds();
  const archivedRemoteSessionLoadingDevices = useMemo(
    () =>
      selectRemoteSessionBootstrapLoadingDevices({
        selectedMachineId,
        devices: switcherDevices,
        bootstrapLoadingDeviceIds: archivedLoadingDeviceIds,
      }),
    [archivedLoadingDeviceIds, selectedMachineId, switcherDevices],
  );
  const archivedRemoteSessionFailures = useMemo(
    () =>
      selectRemoteSessionBootstrapFailures({
        selectedMachineId,
        devices: switcherDevices,
        bootstrapFailedDeviceIds: archivedFailedDeviceIds,
      }),
    [archivedFailedDeviceIds, selectedMachineId, switcherDevices],
  );
  const activeArchivedPrerequisiteLoadingDevices = useMemo(
    () =>
      activeRemoteSessionBootstrapLoadingDevices.filter(
        (device) => !archivedLoadedDeviceIds.has(device.deviceId),
      ),
    [activeRemoteSessionBootstrapLoadingDevices, archivedLoadedDeviceIds],
  );
  const activeArchivedPrerequisiteFailures = useMemo(
    () =>
      activeRemoteSessionBootstrapFailures.filter(
        (device) => !archivedLoadedDeviceIds.has(device.deviceId),
      ),
    [activeRemoteSessionBootstrapFailures, archivedLoadedDeviceIds],
  );
  const remoteSessionBootstrapLoadingDevices = useMemo(() => {
    if (filter.status === 'active') return activeRemoteSessionBootstrapLoadingDevices;
    if (filter.status === 'archived') {
      return [
        ...new Map(
          [...activeArchivedPrerequisiteLoadingDevices, ...archivedRemoteSessionLoadingDevices].map(
            (device) => [device.deviceId, device],
          ),
        ).values(),
      ];
    }
    return [
      ...new Map(
        [...activeRemoteSessionBootstrapLoadingDevices, ...archivedRemoteSessionLoadingDevices].map(
          (device) => [device.deviceId, device],
        ),
      ).values(),
    ];
  }, [
    activeArchivedPrerequisiteLoadingDevices,
    activeRemoteSessionBootstrapLoadingDevices,
    archivedRemoteSessionLoadingDevices,
    filter.status,
  ]);
  const remoteSessionBootstrapFailures = useMemo(() => {
    if (filter.status === 'active') return activeRemoteSessionBootstrapFailures;
    if (filter.status === 'archived') {
      return [
        ...new Map(
          [...activeArchivedPrerequisiteFailures, ...archivedRemoteSessionFailures].map(
            (device) => [device.deviceId, device],
          ),
        ).values(),
      ];
    }
    return [
      ...new Map(
        [...activeRemoteSessionBootstrapFailures, ...archivedRemoteSessionFailures].map(
          (device) => [device.deviceId, device],
        ),
      ).values(),
    ];
  }, [
    activeArchivedPrerequisiteFailures,
    activeRemoteSessionBootstrapFailures,
    archivedRemoteSessionFailures,
    filter.status,
  ]);
  const remoteSessionBootstrapLoading =
    filter.status === 'active'
      ? activeRemoteSessionBootstrapLoading
      : filter.status === 'archived'
        ? remoteSessionBootstrapLoadingDevices.length > 0
        : activeRemoteSessionBootstrapLoading || archivedRemoteSessionLoadingDevices.length > 0;
  const deviceListRequestState = useDeviceLinkDeviceListRequestState();
  const remoteDeviceDirectoryRelevant =
    selectedMachineId === MACHINE_ALL ||
    selectedMachineId.some((deviceId) => deviceId !== MACHINE_LOCAL);
  const remoteDeviceDirectoryStatus = remoteDeviceDirectoryRelevant
    ? deviceListRequestState.status
    : 'ready';
  const loadingRemoteDeviceLabel = useMemo(
    () =>
      new Intl.ListFormat(i18n.language, { style: 'short', type: 'conjunction' }).format(
        remoteSessionBootstrapLoadingDevices.map((device) => device.name),
      ),
    [i18n.language, remoteSessionBootstrapLoadingDevices],
  );
  const failedRemoteDeviceLabel = useMemo(
    () =>
      new Intl.ListFormat(i18n.language, { style: 'short', type: 'conjunction' }).format(
        remoteSessionBootstrapFailures.map((device) => device.name),
      ),
    [i18n.language, remoteSessionBootstrapFailures],
  );
  const isLoadingSidebarSessions =
    sessionsHook.isLoading ||
    remoteSessionBootstrapLoading ||
    remoteDeviceDirectoryStatus === 'loading';
  // 选中的远程机器尚在连接中(会话未同步)→ 用「连接中」占位替换空列表的「暂无对话」。
  const selectedMachineConnecting = useSelectedMachineConnecting();
  // orca worker + status 过滤(**不含**机器过滤)—— 抽出给「机器过滤后渲染」与「全量项目宇宙」共用。
  const passesOrcaAndStatus = useCallback(
    (s: Session) => {
      if (isOrcaWorkerSession(s)) return false;
      return matchesSidebarSessionStatus(s, filter.status, effectiveIncludeArchived);
    },
    [filter.status, effectiveIncludeArchived],
  );
  const scopedSidebarSessions = useMemo(
    () =>
      selectVisibleSessions(sessions, remoteProjectSessions, selectedMachineId).filter(
        passesOrcaAndStatus,
      ),
    [sessions, remoteProjectSessions, selectedMachineId, passesOrcaAndStatus],
  );
  const sidebarSessions = useMemo(
    () =>
      sidebarSessionsWithHiddenProjectsAsDialogues(
        scopedSidebarSessions,
        hiddenProjectKeys,
        localPlatform,
      ),
    [scopedSidebarSessions, hiddenProjectKeys, localPlatform],
  );

  const activityFilteredSessions = useMemo(() => {
    const cutoff = cutoffForLastActivity(filter.lastActivity);
    if (cutoff === null) return sidebarSessions;
    return sidebarSessions.filter((s) => sessionActivityMs(s) >= cutoff);
  }, [sidebarSessions, filter.lastActivity]);

  /* ---- Grouping & collapse ---- */
  const allGroups = useProjectGroups(sidebarSessions, projectAliases.aliases);
  const groups = useProjectGroups(activityFilteredSessions, projectAliases.aliases);
  // 普通项目目录也需要保留「所有会话都已单独置顶」的项目身份，供用户继续
  // 从 ProjectNode 菜单置顶整个项目；实际项目子行在渲染前仍会排除已置顶会话。
  const groupsWithPinnedProjects = useProjectGroups(
    activityFilteredSessions,
    projectAliases.aliases,
    true,
  );
  // Project pinning is independent from conversation pinning. This catalogue
  // keeps pinned conversations inside their project solely for project identity
  // and project-level actions; the normal project tree above remains deduped.
  const allProjectGroups = useProjectGroups(sidebarSessions, projectAliases.aliases, true);
  const activeWorkingDirs = useMemo(
    () => allProjectGroups.projects.map((p) => p.projectKey),
    [allProjectGroups.projects],
  );
  const collapse = useCollapsedProjects(activeWorkingDirs, sidebarSettingsSnapshot.dataOwnerId);

  // 项目过滤 GC 的「宇宙」用**全量**(不按机器过滤)项目键 —— 否则在某机器作用域下 remount,
  // gcProjectsAgainstActive 会把其它机器的项目从已保存的项目过滤里误删(它们只是被切换栏隐藏、
  // 并非不存在;codex)。collapse 仍用机器过滤后的 activeWorkingDirs(collapseAll / isAllCollapsed
  // 针对当前可见项目),渲染也仍走机器过滤后的 allGroups / groups。
  const unfilteredProjectSessions = useMemo(
    () => [...sessions, ...remoteProjectSessions].filter(passesOrcaAndStatus),
    [sessions, remoteProjectSessions, passesOrcaAndStatus],
  );
  const projectUniverse = useProjectGroups(unfilteredProjectSessions, projectAliases.aliases, true);
  // Visibility is a negative overlay only. Keep the raw universe above for
  // filter/manual-order GC, and expose a separate catalogue to sidebar UI.
  const visibleProjectUniverse = useMemo(
    () => visibleSidebarProjects(projectUniverse.projects, hiddenProjectKeys, localPlatform),
    [projectUniverse.projects, hiddenProjectKeys, localPlatform],
  );

  // 内联会话搜索:输入行在 SidebarTopNav 末行,状态经 ConversationSearchProvider 共享;
  // query 非空时同一份顶部导航 sticky 钉住,结果替换下方列表,不再用 overlay 盖输入框。
  const { search, openSignal } = useConversationSearchContext();
  const gcProjectKeys = useMemo(
    () => projectUniverse.projects.map((p) => p.projectKey),
    [projectUniverse.projects],
  );

  /* ---- cindy://project/<workingDir>(历史 xdt-maker:// 同)深度链接消费 ----
   * MainLayout 在收到 deep-link payload 后调 requestProjectFocus(workingDir),
   * 这里订阅 pending 信号, 等 sessions 加载到位再决定 expand / scroll / toast。
   *
   * 等待时序: sessions 还在 fetch (isLoading=true) 时不动作, effect 在
   * groups.projects 变化时会再跑一次。loaded 之后:
   *   - workingDir 命中 → collapse.expand + scrollIntoView + consume
   *   - 不命中但被机器切换栏过滤掉了 → 先回落「所有」再判定(不消费,等 effect 重跑)
   *   - 仍不命中 → toast 提示 + consume(避免 effect 循环)
   */
  const pendingFocus = usePendingProjectFocus();
  const isLoadingSessions = sessionsHook.isLoading;
  useEffect(() => {
    if (!pendingFocus) return;
    if (isLoadingSessions) return; // 等首次加载完
    const targetDir = pendingFocus.workingDir;
    const targetKey = normalizeProjectKey(targetDir) ?? `local:${targetDir}`;
    const exists = groupsWithPinnedProjects.projects.some((p) => p.projectKey === targetKey);
    if (exists) {
      collapse.expand(targetKey);
      // RAF 等 expand 触发的 re-render 完成 (project header DOM 在折叠态下已渲染,
      // 这里 RAF 主要给"刚 mount"的场景一帧时间让 querySelector 拿到节点)。
      requestAnimationFrame(() => {
        const node = document.querySelector(`[data-project-workingdir="${CSS.escape(targetKey)}"]`);
        if (node) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    } else if (selectedMachineId !== MACHINE_ALL) {
      // 目标项目可能在别的机器 / 本机,被机器切换栏过滤掉了 —— 深链是「跳到这个项目」的明确意图,
      // 应越过当前过滤:回落「所有」让它重新可见,**不消费**;selectedMachineId 变 → groups.projects
      // 重算 → 本 effect 重跑,这次命中就 expand+scroll,真不存在才走下面的 toast 分支。
      // 走 Transient(只改内存不落盘):这是系统性回落、不是用户对勾选集的表态,
      // 不能把用户持久化的机器多选集永久冲掉(重启后仍恢复原勾选)。
      setSelectedMachineIdTransient(MACHINE_ALL);
      return;
    } else {
      toast.warning(t('ccAgent.sidebar.deepLink.projectNotFound'));
    }
    consumePendingProjectFocus();
  }, [
    pendingFocus,
    groupsWithPinnedProjects.projects,
    collapse,
    isLoadingSessions,
    selectedMachineId,
    t,
  ]);

  /* ---- 自动展开：首条消息把 session 从未分类挪进 Project 时，
   *      若目标 Project 当前折叠，幂等展开它，避免新会话视觉上"消失"。
   *      触发条件：cc-session-patch 携带 workingDir（chatStore 只在 wasFirst
   *      时才把 workingDir 塞进 patch，正好对应"首次入组"时刻）。
   */
  useEffect(
    () =>
      onPatch((id, patch) => {
        if (!patch.workingDir) return;
        const dir = normalizeWorkingDir(patch.workingDir);
        // remoteHostId 优先用 patch 自带(chatStore 在 wasFirst 时透传);缺失时从最新
        // sessions 兜底查 —— 走 sessionsRef 读最新值,避免把 sessions 放进 deps 导致每条
        // 消息/状态 tick 都重订阅(busy 会话下开销可观)。
        const sessionRemoteHostId =
          patch.remoteHostId ?? sessionsRef.current.find((s) => s.id === id)?.remoteHostId ?? null;
        if (dir != null) {
          collapse.expand(
            projectIdentityKey(sessionRemoteHostId ? 'remote' : 'local', dir, sessionRemoteHostId),
          );
        }
      }),
    [collapse],
  );

  /* ---- F-PJ-10: filter GC ----
   * 等"至少 1 个 project 出现"再触发一次 filter.gc(activeWorkingDirs) 即可 ——
   * 这一条件天然蕴含"sessions 已加载"。ref guard 保证只跑一次
   * （ADR-6：避免循环依赖，GC 由编排层显式触发）。
   */
  const gcDoneRef = useRef(false);
  useEffect(() => {
    if (gcDoneRef.current) return;
    if (projectUniverse.projects.length === 0) return;
    // 用**全量**项目键 GC,不用机器过滤后的 activeWorkingDirs —— 否则某机器作用域下会把其它机器的
    // 项目从已保存的项目过滤里误删(它们只是被隐藏、并非不存在)。
    filter.gc(gcProjectKeys);
    gcDoneRef.current = true;
  }, [projectUniverse.projects.length, gcProjectKeys, filter]);

  /* ---- F-PJ-10: 在 render 阶段把 filter.projects 应用到 ProjectNode 列表 ---- */
  const visibleProjects = useMemo(() => {
    const notHidden = visibleSidebarProjects(
      groupsWithPinnedProjects.projects,
      hiddenProjectKeys,
      localPlatform,
    );
    if (filter.projectsAsSet === null) return notHidden;
    const allowed = filter.projectsAsSet;
    return notHidden.filter((project) =>
      projectFilterIncludes(allowed, project.projectKey, localPlatform),
    );
  }, [groupsWithPinnedProjects.projects, hiddenProjectKeys, filter.projectsAsSet, localPlatform]);

  /* ---- M41: Vendor 过滤 — 应用到 pinned / unclassified / project sessions ---- */
  const vendorPredicate = useMemo(() => {
    if (filter.vendor === 'all') return null;
    const v = filter.vendor;
    return (s: { agentKind?: string | null }) => (s.agentKind ?? 'cc') === v;
  }, [filter.vendor]);

  const pinnedProjectKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const entryId of filter.manualPinnedOrder) {
      const projectKey = projectKeyFromPinnedEntryId(entryId);
      if (projectKey) keys.add(projectKey);
    }
    return keys;
  }, [filter.manualPinnedOrder]);

  const restorableProjectKeys = useMemo(
    () =>
      collectRestorableProjectKeys({
        sessions: scopedSidebarSessions,
        lastActivityCutoff: cutoffForLastActivity(filter.lastActivity),
        pinnedProjectKeys,
        vendorPredicate,
      }),
    [filter.lastActivity, pinnedProjectKeys, scopedSidebarSessions, vendorPredicate],
  );
  const restorableProjectKeysRef = useRef(restorableProjectKeys);
  restorableProjectKeysRef.current = restorableProjectKeys;
  const hiddenProjectComparisonKeys = useMemo(
    () => buildProjectKeyComparisonSet(hiddenProjectKeys, localPlatform),
    [hiddenProjectKeys, localPlatform],
  );

  const visiblePinnedSessions = useMemo(() => {
    // 置顶段用 allGroups.pinned(未经"最近活跃 N 天"筛选)。
    // **筛选一律不作用于置顶区**(设计文档 §3.3 定稿;2026-08-12 用户重申):
    // 状态 / 项目 / Agent / 最近活跃四个维度都不过滤置顶——用户主动置顶就是
    // 「我要一直看见它」,被筛选条件挑走会让人以为置顶丢了。置顶区只跟随设备范围
    // (scopedSidebarSessions 之外的设备切换在上游 allGroups 已收窄)。
    return allGroups.pinned;
  }, [allGroups.pinned]);

  const visiblePinnedProjects = useMemo(() => {
    // 同上:**筛选不作用于置顶区**——项目 / Agent 维度都不过滤置顶项目及其会话
    // (设计文档 §3.3 定稿;2026-08-12 用户重申)。仍然尊重「从侧栏移除项目」,
    // 那不是筛选而是用户对该项目的显式隐藏。
    return allProjectGroups.projects.flatMap((project) => {
      if (
        projectKeyComparisonSetHas(hiddenProjectComparisonKeys, project.projectKey, localPlatform)
      ) {
        return [];
      }
      if (!pinnedProjectKeys.has(project.projectKey)) return [];

      return [
        {
          project,
          // Individually pinned conversations stay as their own siblings in the
          // Pinned section; the project container only shows the remainder.
          displaySessions: project.sessions.filter((session) => session.pinnedAt == null),
        },
      ];
    });
  }, [allProjectGroups.projects, hiddenProjectComparisonKeys, localPlatform, pinnedProjectKeys]);

  const visiblePinnedEntries = useMemo<PinnedSidebarEntry[]>(() => {
    const entries: PinnedSidebarEntry[] = [
      ...visiblePinnedSessions.map((session) => ({
        kind: 'session' as const,
        id: session.id,
        session,
      })),
      ...visiblePinnedProjects.map(({ project, displaySessions }) => ({
        kind: 'project' as const,
        id: pinnedProjectEntryId(project.projectKey),
        project,
        displaySessions,
      })),
    ];

    // Entries in the persisted order rank first. Legacy pinned conversations
    // without a rank remain at the end in their existing pinnedAt order.
    const order = filter.manualPinnedOrder;
    if (order.length === 0) return entries;
    const rank = new Map<string, number>();
    order.forEach((id, idx) => rank.set(id, idx));
    return entries.sort((a, b) => {
      const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
  }, [visiblePinnedSessions, visiblePinnedProjects, filter.manualPinnedOrder]);

  const visibleUnclassified = useMemo(() => {
    const sessions = vendorPredicate
      ? groups.unclassified.filter(vendorPredicate)
      : groups.unclassified;
    return sortSessionsForSidebar(sessions, filter.sortBy);
  }, [groups.unclassified, vendorPredicate, filter.sortBy]);

  // rail 项目面板的未分类与展开态同一门控:选中具体项目筛选时隐藏
  // (ProjectsSection.unclassifiedHidden 同判定 filter.projects !== 'all'),
  // 否则折叠面板会展示并点亮展开态刻意隐藏的会话(codex review)。
  const railUnclassified = useMemo(
    () => (filter.projects === 'all' ? visibleUnclassified : EMPTY_SESSION_LIST),
    [filter.projects, visibleUnclassified],
  );

  const visibleDialogues = useMemo(() => {
    const sessions = vendorPredicate
      ? groups.dialogues.filter(vendorPredicate)
      : groups.dialogues;
    if (filter.projectsAsSet === null) return sessions;
    return filter.projectsAsSet.has(DIALOGUE_FILTER_KEY) ? sessions : [];
  }, [groups.dialogues, vendorPredicate, filter.projectsAsSet]);

  // 对话段排序状态提升到此处:DialogueSection(展开态)受控消费,rail 对话
  // 面板按同一排序渲染——否则折叠后面板的前 N 条/折叠溢出与展开态刚排好的
  // 顺序不一致(codex review)。
  const [dialogueSortBy, setDialogueSortBy] = useState<DialogueSortBy>('recency');
  const railDialogues = useMemo(
    () => visibleDialogues.slice().sort((a, b) => compareDialogueSessions(a, b, dialogueSortBy)),
    [visibleDialogues, dialogueSortBy],
  );

  const hostProjectSort = useMemo(() => {
    const scope = projectOrderWriteScopeForSelection(selectedMachineId);
    const hostSnapshot = scope.kind === 'host' && scope.deviceId === null
      ? localHostProjectOrder.snapshot
      : scope.kind === 'host' && scope.deviceId
        ? remoteHostProjectOrders.get(scope.deviceId)
        : undefined;
    const hostManual = scope.kind === 'host' && scope.deviceId === null
      ? localHostProjectOrder.snapshot.manualProjectOrder
      : scope.kind === 'host' && scope.deviceId
        ? controllerManualOrderForDevice(scope.deviceId, hostSnapshot) ?? []
        : [];
    const displayed = resolveDisplayedProjectOrder(
      scope,
      hostSnapshot,
      filter,
      hostManual,
    );
    return {
      order: displayed.manualProjectOrder,
      projectOrder: displayed.projectOrder,
      sortBy: filter.sortBy,
    };
  }, [
    filter.manualProjectOrder,
    filter.projectOrder,
    filter.sortBy,
    localHostProjectOrder.snapshot,
    remoteHostProjectOrders,
    selectedMachineId,
  ]);

  const visibleProjectsWithVendor = useMemo(() => {
    const unpinnedProjects = visibleProjects.filter(
      (project) => !pinnedProjectKeys.has(project.projectKey),
    );
    const projects = unpinnedProjects.flatMap((project) => {
      const matchingSessions = vendorPredicate
        ? project.sessions.filter(vendorPredicate)
        : project.sessions;
      if (matchingSessions.length === 0) return [];
      return [
        {
          ...project,
          sessions: matchingSessions.filter((session) => session.pinnedAt == null),
        },
      ];
    });
    return sortProjectsForSidebar(
      projects,
      hostProjectSort.sortBy,
      hostProjectSort.order,
      hostProjectSort.projectOrder,
    );
  }, [
    visibleProjects,
    pinnedProjectKeys,
    vendorPredicate,
    hostProjectSort,
  ]);

  // 折叠 rail 没有独立的 Pinned 项目瓷砖，因此项目面板必须保留置顶项目，
  // 否则侧栏折叠后这些项目及其取消置顶入口都会完全不可达。
  const visibleRailProjectsWithVendor = useMemo(() => {
    const projects = visibleProjects.flatMap((project) => {
      const matchingSessions = vendorPredicate
        ? project.sessions.filter(vendorPredicate)
        : project.sessions;
      if (matchingSessions.length === 0) return [];
      return [
        {
          ...project,
          sessions: matchingSessions.filter((session) => session.pinnedAt == null),
        },
      ];
    });
    return sortProjectsForSidebar(
      projects,
      hostProjectSort.sortBy,
      hostProjectSort.order,
      hostProjectSort.projectOrder,
    );
  }, [visibleProjects, vendorPredicate, hostProjectSort]);

  /**
   * Pinned 拖拽落定回调。SortableList 给的是当前 visible（含 vendor / projectsFilter
   * 过滤 + manualPinnedOrder 应用后）段内的新顺序 id 列表。
   *
   * fullActivePinnedIds 取**未过滤**的全量活跃置顶（本地 sessions + 全部远程，不受机器切换栏 /
   * vendor 过滤影响），让 normalizeManualPinnedOrder 顺手 GC 掉已取消置顶 / 已删除的旧 id；再用
   * mergeVisibleReorder 把可见子集的新顺序**原位** merge 回完整顺序 —— 不可见的置顶项（其它机器 /
   * vendor）保持原位:既不丢失（修 #331 机器过滤引入的持久化顺序丢失），也不被挪到末尾。
   */
  const handlePinnedReorder = useCallback(
    (visibleNewOrder: string[]) => {
      // baseline 与置顶段同序(pinnedSessionIdsInDisplayOrder 内部按 status→pinnedAt desc 排,含归档
      // 置顶),保证首次过滤态拖拽、manualPinnedOrder 还空时,隐藏置顶项不因 baseline 顺序不符而跳位。
      const pinnedSessionIds = pinnedSessionIdsInDisplayOrder([
        ...sessions,
        ...remoteProjectSessions,
      ]);
      const fullActivePinnedIds = activePinnedSidebarEntryIds(
        filter.manualPinnedOrder,
        pinnedSessionIds,
      );
      const baseOrder = normalizeManualPinnedOrder(filter.manualPinnedOrder, fullActivePinnedIds);
      const merged = mergeVisibleReorder(baseOrder, visibleNewOrder);
      void filter.setManualPinnedOrder(merged, fullActivePinnedIds, baseOrder).catch((err) => {
        log.warn('failed to persist pinned order', err);
        toast.error(t('ccAgent.sidebar.pinFailed'));
      });
    },
    [sessions, remoteProjectSessions, filter, t],
  );

  // D 期:按日期分组已删除(visibleDateSessions 随 DateGroupedSessionsSection 一并下线)。
  const hasVisibleSidebarContent =
    visiblePinnedEntries.length > 0 ||
    visibleUnclassified.length > 0 ||
    visibleProjectsWithVendor.length > 0 ||
    visibleDialogues.length > 0;
  // 与 ProjectsSection.deviceGroupingAvailable 同一门控:范围收窄到单台机器时
  // 「按设备分组」选项隐藏。占位分支也要挂范围标题,不能各写一份。
  const deviceGroupingAvailable =
    (remoteDeviceIndex?.size ?? 0) > 0 &&
    !(selectedMachineId !== MACHINE_ALL && selectedMachineId.length === 1);

  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  const [selectionAnchorSessionId, setSelectionAnchorSessionId] = useState<string | null>(null);
  // 这三个值 handleSessionClick 只在「点击那一刻」读一次。留在它的 deps 里会让
  // 每次点击(:setSelectionAnchorSessionId 必触发)和每次切换都重建 handler,
  // 行的 onClick 跟着换引用 → 整表 memo 失效重画一遍(SessionItem.tsx 不变量 #3)。
  // 经 ref 读还顺带避开闭包陈旧:拿到的是最新值而非渲染时快照。
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  // viewedSessionId 同理:handleActionClick 只在触发归档那一刻用它算重定向目标。
  const viewedSessionIdRef = useRef(viewedSessionId);
  viewedSessionIdRef.current = viewedSessionId;
  const selectedSessionIdsRef = useRef(selectedSessionIds);
  selectedSessionIdsRef.current = selectedSessionIds;
  const selectionAnchorSessionIdRef = useRef(selectionAnchorSessionId);
  selectionAnchorSessionIdRef.current = selectionAnchorSessionId;
  const [bulkActionPending, setBulkActionPending] = useState<BulkSessionAction | null>(null);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  /**
   * 顶部溢出渐隐(2026-08-12 用户反馈):滚动后列表首行会紧贴固定的「新建」被硬切,
   * 露出半截字。**只在真的滚动了才启用**——未滚动时不加 mask,首行 hover 胶囊 /
   * 焦点环不会被裁(与右栏 TabBar 的 side-aware fade 同一取舍,见其 edgeFade 注释)。
   * 用 mask-image(基于 alpha)而非叠色块:透出的是侧栏自身背景,light / dark /
   * 任意扩展主题天然正确,不需要按主题取色。
   */
  /**
   * 空白处右键打开的整理菜单(2026-08-12 用户裁决)。会话行 / 项目行 / 对话组头
   * 都在自己的 onContextMenu 里 stopPropagation,冒泡到滚动容器的必然是空白区域。
   */
  const [organizeMenuPos, setOrganizeMenuPos] = useState<{ x: number; y: number } | null>(null);
  const handleSidebarBlankContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setOrganizeMenuPos({ x: event.clientX, y: event.clientY });
  }, []);
  const [topFade, setTopFade] = useState(false);
  const searchActive = Boolean(search.trimmed);
  const searchActiveRef = useRef(searchActive);
  searchActiveRef.current = searchActive;
  // 搜索激活前持续记下列表 scrollTop:layout effect 跑时原列表已经 hidden,
  // 那时再读会被浏览器钳成 0。
  const lastListScrollTopRef = useRef(0);
  // 列表还原位置只记用户自己滚出来的偏移,不记程序化打开 / focus 带出来的滚动。
  // 「在此项目内搜索」先冻住再滚到顶部露出搜索行;没打字就点走 / 失焦则还原并解冻。
  const freezeListScrollOnOpenRef = useRef(false);
  const lastOpenSignalRef = useRef(openSignal);
  if (openSignal !== lastOpenSignalRef.current) {
    lastOpenSignalRef.current = openSignal;
    if (openSignal > 0 && !searchActive) {
      freezeListScrollOnOpenRef.current = true;
    }
  }
  useEffect(() => {
    const el = sidebarScrollRef.current;
    if (!el) return undefined;
    const update = () => {
      if (!searchActiveRef.current && !freezeListScrollOnOpenRef.current) {
        lastListScrollTopRef.current = el.scrollTop;
      }
      const next = el.scrollTop > 1;
      setTopFade((prev) => (prev === next ? prev : next));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    // jsdom 无 ResizeObserver(仓库同款 guard,见 TabBar / RolePillDropdown)。
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, []);
  const restoreListScroll = useCallback(() => {
    freezeListScrollOnOpenRef.current = false;
    sidebarScrollRef.current?.scrollTo({ top: lastListScrollTopRef.current });
  }, []);
  // 指针手势期间不还原滚动:按下的按钮会在 click 前被滚走,第一次点击被吞。
  // 空查询取消和有查询退出共用这一条,等 pointerup 后再还原。
  const pointerDownRef = useRef(false);
  const pendingRestoreRef = useRef(false);
  const restoreListScrollAfterPointer = useCallback(() => {
    if (pointerDownRef.current) {
      pendingRestoreRef.current = true;
      return;
    }
    pendingRestoreRef.current = false;
    restoreListScroll();
  }, [restoreListScroll]);
  useEffect(() => {
    const onPointerDown = () => {
      pointerDownRef.current = true;
    };
    const onPointerEnd = () => {
      pointerDownRef.current = false;
      if (!pendingRestoreRef.current) return;
      pendingRestoreRef.current = false;
      window.setTimeout(() => restoreListScroll(), 0);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerEnd, true);
    window.addEventListener('pointercancel', onPointerEnd, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerEnd, true);
      window.removeEventListener('pointercancel', onPointerEnd, true);
    };
  }, [restoreListScroll]);
  useLayoutEffect(() => {
    if (openSignal === 0 || searchActive || !freezeListScrollOnOpenRef.current) return;
    sidebarScrollRef.current?.scrollTo({ top: 0 });
  }, [openSignal, searchActive]);
  useEffect(() => {
    if (searchActive || !freezeListScrollOnOpenRef.current) return undefined;
    const isOutsideSearch = (event: Event) => {
      const target = event.target as Element | null;
      if (!target) return false;
      if (target.closest('[data-conversation-search-surface]')) return false;
      if (target.closest('[data-radix-popper-content-wrapper]')) return false;
      return true;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!isOutsideSearch(event)) return;
      restoreListScrollAfterPointer();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!isOutsideSearch(event) || pointerDownRef.current) return;
      restoreListScroll();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [openSignal, searchActive, restoreListScroll, restoreListScrollAfterPointer]);
  // 搜索结果替换同一滚动容器里的列表:打开 / 换词 / 换筛选时滚回顶部;
  // 清查询时还原搜索前记下的列表位置。
  const wasSearchActiveRef = useRef(false);
  const searchProjectKey =
    search.projectSelection === 'all' ? 'all' : search.projectSelection.join('\0');
  useLayoutEffect(() => {
    const el = sidebarScrollRef.current;
    if (!el) return;
    if (searchActive) {
      freezeListScrollOnOpenRef.current = false;
      pendingRestoreRef.current = false;
      el.scrollTo({ top: 0 });
    } else if (wasSearchActiveRef.current) {
      restoreListScrollAfterPointer();
    }
    wasSearchActiveRef.current = searchActive;
  }, [
    searchActive,
    search.trimmed,
    search.statusFilter,
    search.agentFilter,
    search.lastActivityFilter,
    search.sortBy,
    searchProjectKey,
    restoreListScrollAfterPointer,
  ]);
  // 含远程会话:device-link 远程行也渲染在可选行里,bulk 选择/归档/删除必须能解析到它们
  // (否则选中远程行 → 计数加了但 archive/delete 查 sessionsById 落空、静默忽略)。
  const sessionsById = useMemo(
    () => new Map([...sessions, ...remoteProjectSessions].map((session) => [session.id, session])),
    [sessions, remoteProjectSessions],
  );
  // 与 sessionsRef 同理:行级 handler 只在「点击那一刻」查表,不该因为表换了引用就
  // 重建自身 —— 否则 SessionItem 的 memo 会被整表打穿(SessionItem.tsx 不变量第 3 条)。
  const sessionsByIdRef = useRef(sessionsById);
  sessionsByIdRef.current = sessionsById;
  // 同理:归档预检只在点击那一刻查一次 attached 集合。每次 binding:changed 都会
  // 换一个新 Set 引用,放进 handleActionClick 的 deps 会让整表行 handler 重建。
  const attachedSessionIdsRef = useRef(attachedSessionIds);
  attachedSessionIdsRef.current = attachedSessionIds;
  const selectedSessions = useMemo(
    () =>
      [...selectedSessionIds]
        .map((id) => sessionsById.get(id))
        .filter((session): session is (typeof sessions)[number] => session != null),
    [selectedSessionIds, sessionsById],
  );
  const selectedActiveSessionCount = useMemo(
    () => selectedSessions.filter((session) => session.status === 'active').length,
    [selectedSessions],
  );

  const resolveSessionRemovalRedirect = useCallback(
    async (
      removedSessionIds: ReadonlySet<string>,
      anchorSessionId: string,
      orderedSessionIds = getVisibleSidebarSessionIds(sidebarScrollRef.current),
    ): Promise<string | null> => {
      const nextSessionId = pickSessionIdAfterRemoval(
        orderedSessionIds,
        removedSessionIds,
        anchorSessionId,
      );
      if (nextSessionId) {
        return resolveSessionRoute(nextSessionId, sessionsById.get(nextSessionId));
      }
      return orderedSessionIds.includes(anchorSessionId) ? '/cc-agent/new' : null;
    },
    [sessionsById],
  );

  const pruneSelectionToRenderedRows = useCallback(() => {
    const renderedSessionIds = new Set(getVisibleSidebarSessionIds(sidebarScrollRef.current));
    setSelectedSessionIds((prev) => {
      const next = new Set([...prev].filter((id) => renderedSessionIds.has(id)));
      return sameStringSet(prev, next) ? prev : next;
    });
    setSelectionAnchorSessionId((prev) => (prev && renderedSessionIds.has(prev) ? prev : null));
  }, []);

  useEffect(() => {
    pruneSelectionToRenderedRows();
  });

  useEffect(() => {
    const root = sidebarScrollRef.current;
    if (!root) return undefined;
    const observer = new MutationObserver(pruneSelectionToRenderedRows);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pruneSelectionToRenderedRows]);

  const handleClearSelection = useCallback(() => {
    setSelectedSessionIds((prev) => (prev.size === 0 ? prev : new Set()));
    setSelectionAnchorSessionId((prev) => (prev === null ? prev : null));
  }, []);

  useEffect(() => {
    if (onScheduleMatch || onNewMakerMatch) handleClearSelection();
  }, [onScheduleMatch, onNewMakerMatch, handleClearSelection]);

  const [linkingCodexProject, setLinkingCodexProject] = useState<string | null>(null);

  // 远程会话的已读回执有两类首发即失的场景,都靠本 memo 的 key 变化驱动重跑补发:
  //  1. 恢复 / 深链直开:effect 先于 remoteProjectsStore 完成 sessionId→deviceId 起源
  //     解析,首次清点只走了本机 IPC(key: undefined → `${deviceId}:...`)。
  //  2. 目标设备断线中打开:回执 invoke 失败被吞,重连后仅连接状态变化——把
  //     deviceLinkConnectionStatus 并入 key(`...:disconnected` → `...:connected`),
  //     重连即重跑补发。本机 IPC / run 标已读重发均幂等。
  // 整段回执/清角标语义按 viewedSessionId(= activeSessionId,files 路由下兜底
  // 到被浏览文件的会话):用户看着哪个会话,哪个会话就不该积未读。
  const activeSessionRemoteReceiptKey = useMemo(() => {
    if (!viewedSessionId) return undefined;
    const deviceId = getSessionDeviceId(viewedSessionId);
    if (!deviceId) return undefined;
    const remote = remoteProjectSessions.find((s) => s.id === viewedSessionId);
    return `${deviceId}:${remote?.deviceLinkConnectionStatus ?? 'unknown'}`;
  }, [viewedSessionId, remoteProjectSessions]);
  // 注视中完成的远程 turn:被控端推来 attention=true 的活动包,但上面的 key 只含
  // 设备与连接态,不会重跑回执 effect。触发条件用**活动签名变化且 attention=true**
  // (与手机端 / 咽喉重定基同语义):仅凭 false→true 布尔沿会漏掉「attention 一直为
  // true 但内容更新」的场景(前一次收尾包丢失 / 延迟时,新 completed/error/
  // needs-interaction 到来布尔值不变)。attention 回落不计——那通常是本回执生效后
  // relay 推回的收尾包,重发只是无谓 invoke。
  const activeRemoteActivity = useRemoteSessionActivity(viewedSessionId ?? '');
  const activeRemoteAttention = activeRemoteActivity?.attention === true;
  const activeRemoteActivitySig = activeRemoteActivity
    ? `${activeRemoteActivity.phase}|${activeRemoteActivity.attention === true ? 1 : 0}|${activeRemoteActivity.interactionKind ?? ''}|${activeRemoteActivity.compactDetail}`
    : 'none';
  const [activeRemoteAttentionRev, setActiveRemoteAttentionRev] = useState(0);
  const prevActiveRemoteActivitySigRef = useRef<string | null>(null);
  useEffect(() => {
    const prevSig = prevActiveRemoteActivitySigRef.current ?? activeRemoteActivitySig;
    if (activeRemoteAttention && activeRemoteActivitySig !== prevSig) {
      setActiveRemoteAttentionRev((rev) => rev + 1);
    }
    prevActiveRemoteActivitySigRef.current = activeRemoteActivitySig;
  }, [activeRemoteActivitySig, activeRemoteAttention]);
  useEffect(() => {
    if (!viewedSessionId) return;
    markAutomationSessionRunsRead(viewedSessionId);
    clearSystemSessionAttention(viewedSessionId);
  }, [
    viewedSessionId,
    activeSessionRemoteReceiptKey,
    activeRemoteAttentionRev,
    markAutomationSessionRunsRead,
  ]);

  // 用户从 Dock badge / taskbar flash 点回 app 时,如果 viewedSessionId 没变,
  // route-driven effect 不会重跑,系统角标会残留。监听 window focus 兜底清当前
  // 注视中会话的角标,正好覆盖这一回流场景。
  useEffect(() => {
    if (!viewedSessionId) return;
    const handler = () => {
      clearSystemSessionAttention(viewedSessionId);
    };
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [viewedSessionId]);

  const handleSessionClick = useCallback(
    async (id: string, modifiers?: SessionClickModifiers) => {
      if (hasSessionSelectionModifier(modifiers)) {
        if (modifiers?.shiftKey) {
          const visibleIds = getVisibleSidebarSessionIds(sidebarScrollRef.current);
          const visibleIdSet = new Set(visibleIds);
          const anchorSessionId = selectionAnchorSessionIdRef.current;
          const anchor =
            anchorSessionId && visibleIds.includes(anchorSessionId) ? anchorSessionId : id;
          const anchorIndex = visibleIds.indexOf(anchor);
          const targetIndex = visibleIds.indexOf(id);
          const rangeIds =
            anchorIndex >= 0 && targetIndex >= 0
              ? visibleIds.slice(
                  Math.min(anchorIndex, targetIndex),
                  Math.max(anchorIndex, targetIndex) + 1,
                )
              : [id];
          setSelectedSessionIds((prev) => {
            const next = modifiers.metaKey || modifiers.ctrlKey ? new Set(prev) : new Set<string>();
            for (const rangeId of rangeIds) {
              if (visibleIdSet.has(rangeId)) next.add(rangeId);
            }
            return next;
          });
          setSelectionAnchorSessionId((prev) => prev ?? id);
          return;
        }

        setSelectedSessionIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
        setSelectionAnchorSessionId(id);
        return;
      }

      if (selectedSessionIdsRef.current.size > 0) {
        setSelectedSessionIds(new Set());
      }
      setSelectionAnchorSessionId(id);
      // 清点会先于路由更新抹掉 attention。必须先按当前档位钉住,否则
      // ProjectsSection 首次 hold 只能读到 rest,刚打开的完成未读仍会立刻沉底。
      const waiting = new Set(urgentSet);
      for (const [sessionId, kind] of attentionKinds) {
        if (kind === 'awaiting' || kind === 'error') waiting.add(sessionId);
      }
      holdSidebarViewedPriority(id, {
        runningSessionIds,
        attentionSessionIds: sidebarNotifications,
        waitingSessionIds: waiting,
      });
      // F-SB-7: Clear done notification on click
      clearNotification(id);
      markAutomationSessionRunsRead(id);
      clearSystemSessionAttention(id);
      if (id === activeSessionIdRef.current) return; // No duplicate navigate.
      if (import.meta.env.DEV) perfLog.debug(`sidebar:click sid=${id}`); // 纯诊断,生产剔除
      const target = sessionsRef.current.find((s) => s.id === id);
      navigate(await resolveSessionRoute(id, target));
    },
    [
      navigate,
      clearNotification,
      markAutomationSessionRunsRead,
      urgentSet,
      attentionKinds,
      runningSessionIds,
      sidebarNotifications,
    ],
  );

  /* ---- mod+1..9 快速切换对话 + 按住修饰键浮现序号徽标(复刻 Codex 桌面版) ----
   * 序号口径 = getVisibleSidebarSessionIds 的渲染顺序(含置顶区),与 shift 范围
   * 多选 / 删除后跳转同一权威实现。副窗不启用:副窗侧栏默认折叠,快捷键切副窗
   * 自己的列表反直觉。搜索 overlay 打开(search.trimmed 非空)时同样让路:
   * overlay 盖住列表,槽位仍指向被盖住的行会无提示跳到看不见的目标,徽标也
   * 被遮住。折叠态自然失效:隐藏 wrapper 里的行被可见性过滤剔除,handler
   * 拿不到目标返回 false 让路。 */
  const sessionSwitchEnabled = !isSecondaryWindow() && !search.trimmed;
  const handleSwitchSessionSlot = useCallback(
    (slotIndex: number) => {
      const visibleIds = getVisibleSidebarSessionIds(sidebarScrollRef.current);
      const id = visibleIds[slotIndex];
      if (!id) return false;
      // 复用行点击唯一入口,继承清通知 / 同对话去重 / Orca 角色路由。
      void handleSessionClick(id);
      return true;
    },
    [handleSessionClick],
  );
  /* Codex Micro 旋钮:左转沿侧栏列表往上,右转往下 —— 跟着屏幕上的列表走,
   * 不是抽象的"上一个/下一个"。序号口径与 mod+1..9 完全相同:都取
   * getVisibleSidebarSessionIds 的真实渲染顺序,所以分组、置顶区、折叠与搜索
   * 过滤天然一致,所见即所得。「新建」是列表最上面那一站(它在 SidebarTopNav
   * 里、不是会话行,所以由 pickAdjacentSessionId 单独补进序列)。到头停住不
   * 回绕:旋钮是连续控件,从末尾绕回开头会把用户甩到看不见的地方,还感觉不到
   * 列表已经到边。 */
  const onNewMakerMatchRef = useRef(onNewMakerMatch);
  onNewMakerMatchRef.current = onNewMakerMatch;
  useEffect(() => {
    if (!sessionSwitchEnabled) return;
    return onRequestSessionSwitch((direction) => {
      const visibleIds = getVisibleSidebarSessionIds(sidebarScrollRef.current);
      // 已经停在新建页时按"第 0 站"计,这样右转能进入列表第一条。
      const activeId = onNewMakerMatchRef.current ? null : (activeSessionIdRef.current ?? null);
      const target = pickAdjacentSessionId(visibleIds, activeId, direction);
      if (!target) return;
      if (target.kind === 'new-task') {
        navigate('/cc-agent/new');
        return;
      }
      // 同样复用行点击唯一入口,继承清通知 / 同对话去重 / Orca 角色路由。
      void handleSessionClick(target.sessionId);
    });
  }, [handleSessionClick, navigate, sessionSwitchEnabled]);

  useAppShortcut('switch-session-1', () => handleSwitchSessionSlot(0), {
    enabled: sessionSwitchEnabled,
  });
  useAppShortcut('switch-session-2', () => handleSwitchSessionSlot(1), {
    enabled: sessionSwitchEnabled,
  });
  useAppShortcut('switch-session-3', () => handleSwitchSessionSlot(2), {
    enabled: sessionSwitchEnabled,
  });
  useAppShortcut('switch-session-4', () => handleSwitchSessionSlot(3), {
    enabled: sessionSwitchEnabled,
  });
  useAppShortcut('switch-session-5', () => handleSwitchSessionSlot(4), {
    enabled: sessionSwitchEnabled,
  });
  useAppShortcut('switch-session-6', () => handleSwitchSessionSlot(5), {
    enabled: sessionSwitchEnabled,
  });
  useAppShortcut('switch-session-7', () => handleSwitchSessionSlot(6), {
    enabled: sessionSwitchEnabled,
  });
  useAppShortcut('switch-session-8', () => handleSwitchSessionSlot(7), {
    enabled: sessionSwitchEnabled,
  });
  useAppShortcut('switch-session-9', () => handleSwitchSessionSlot(8), {
    enabled: sessionSwitchEnabled,
  });

  // 按住态徽标 map:按当前可见顺序构建,并在按住期间用 MutationObserver 跟随
  // 列表变化重建 —— 后台事件(自动化会话冒顶、远程会话上线等)可实时重排列表,
  // 徽标必须与执行侧 handler 的实时取值保持同一口径,否则显示的序号会指向
  // 重排前的行。标签取生效组合的显示形(mac '⌘1' / win 'Ctrl+1',跟随用户
  // 改绑),删除绑定或让位后的槽位无徽标。写入 sessionOrdinalBadges 模块
  // store,由 SessionItem / SessionCard 精准订阅。
  const preserveSwitchHintOnKeyDown = useCallback(
    (event: KeyboardEvent) =>
      SWITCH_SESSION_SHORTCUT_IDS.some((shortcutId) =>
        getAppShortcutCombos(shortcutId).some((combo) => matchesKeyboardEvent(event, combo)),
      ),
    [],
  );
  const switchModifierHeld = useModifierHold({
    enabled: sessionSwitchEnabled,
    preserveOnKeyDown: preserveSwitchHintOnKeyDown,
  });
  useEffect(() => {
    if (!switchModifierHeld) return;
    let lastSerialized: string | null = null;
    const rebuild = () => {
      const visibleIds = getVisibleSidebarSessionIds(sidebarScrollRef.current);
      const platform = getAppShortcutPlatform();
      const badges = new Map<string, string>();
      SWITCH_SESSION_SHORTCUT_IDS.forEach((shortcutId, index) => {
        const sessionId = visibleIds[index];
        if (!sessionId) return;
        const combo = getAppShortcutCombos(shortcutId)[0];
        if (!combo) return;
        badges.set(sessionId, formatAppShortcutCombo(combo, platform));
      });
      // 内容级去重:徽标自身的插入/移除同样触发 observer 回调,相同内容不再
      // 写 store,切断 set → 渲染 → observe → set 的空转循环。
      const serialized = JSON.stringify([...badges]);
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      setSessionOrdinalBadges(badges);
    };
    rebuild();
    const root = sidebarScrollRef.current;
    const observer = root == null ? null : new MutationObserver(rebuild);
    if (root != null && observer != null) {
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'hidden'],
      });
    }
    return () => {
      observer?.disconnect();
      setSessionOrdinalBadges(null);
    };
  }, [switchModifierHeld]);

  /* ---- Project 行内的 + 按钮：对标顶部 "+ New"——预填该 project 的 workingDir 后进 draft 路由 ----
   * patchNewMakerDraft({ workingDir }) 把目录写进 transient draft store,
   * 然后 navigate('/cc-agent/new');NewMakerDraftRoute 渲染时 vendor 用 draft.vendor(用户上次选择)。
   */
  const handleCreateInProject = useCallback(
    (project: ProjectNode) => {
      if (isDeviceLinkWriteBlocked(project)) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      handleClearSelection();
      // device-link 远程项目:与本地一致先跳草稿页(主页)。草稿带上 deviceLink 目标
      // (workingDir + deviceId),草稿页显示"为远程设备新建"横幅,首条消息发出时再经
      // 隧道在被控端建会话(NewMakerDraftRoute 的 handleSend 远程分支)。
      // 与创建页两条换设备路径同口径:被控端的能力 / 供应商 / Git safety 快照「拉一次、无 TTL、
      // 只在设备下线才 evict」,它一直在线期间装了新模型或改了供应商,控制端不会知道 —— 草稿页
      // 挂载时 hook 直接命中旧缓存,composer 会显示并向它提交可能已不支持的 model / provider。
      // 这条路径是既有的(#807 未改动它),但缺口同类,一并补上,免得只有创建页那两条是对的。
      //
      // **evict 必须配对一次 fetch**(Codex review 第 32 轮 P1)。evict 不是幂等清理:
      // evictDeviceCapabilities / evictDeviceProviders 会 notify `{ status: 'loading' }`,好让已挂载
      // 的 hook 立刻知道旧快照失效。而两个 hook 的 fetch effect deps 是 `[agentKind, deviceId]` ——
      // 用户**已经在** /cc-agent/new 且目标就是这台设备时,patchNewMakerDraft 保持同一 deviceId、
      // navigate 到同一路由,deps 都不变,于是没有任何东西会去重拉:capabilitiesLoading 永久为真,
      // 发送与新建目标的 gate 永久拒绝创建,用户只能切设备或重进路由才能恢复。
      //
      // 这里选 prefetch 而不是「同设备就跳过 evict」:刷新本身正是这条路径想要的(见上一段),
      // 只是刷新 = 作废 + 重取,不能只做前一半。同款做法见 useDeviceLinkRemoteProjects 处理
      // `maker:provider:changed` push 的那段(evict 紧跟 prefetch),那是本仓这条规则的既有范例。
      //
      // gitSafety 的 evict 不 notify loading,所以它不会卡住发送;但它的 effect deps 也是
      // `[deviceId]`、同样不会自动重拉,不 prefetch 会让 Codex Rewind 的入口一直隐藏,
      // 所以三个一并补齐。fire-and-forget:三个 prefetch 内部都自行 swallow 错误。
      if (project.deviceLinkDeviceId) {
        const targetDeviceId = project.deviceLinkDeviceId;
        evictDeviceCapabilities(targetDeviceId);
        evictDeviceProviders(targetDeviceId);
        evictDeviceGitSafetySettings(targetDeviceId);
        void Promise.all([
          prefetchDeviceCapabilities(targetDeviceId),
          prefetchDeviceProviders(targetDeviceId),
          prefetchDeviceGitSafetySettings(targetDeviceId),
        ]);
      }
      patchNewMakerDraft({
        workingDir: project.workingDir,
        remoteHostId: project.deviceLinkDeviceId ? null : project.remoteHostId,
        deviceLinkDeviceId: project.deviceLinkDeviceId ?? null,
        deviceLinkDeviceName: project.deviceLinkDeviceName ?? null,
      });
      navigate('/cc-agent/new', { state: makeNewMakerRouteState('dialogue') });
    },
    [handleClearSelection, navigate, t],
  );

  const handleCreateProject = useCallback(async () => {
    const hiddenProjectKeysAtPickerOpen = new Set(hiddenProjectKeys);
    try {
      const result = await window.electronAPI.showOpenDirectoryDialog();
      if (result.canceled || !result.path) return;
      const localProjectKey = normalizeProjectKey(result.path);
      if (localProjectKey?.startsWith('local:')) {
        const restored = await restoreHiddenProjectIfPresent({
          projectKey: localProjectKey,
          wasHiddenAtPickerOpen: isProjectHidden(
            localProjectKey,
            hiddenProjectKeysAtPickerOpen,
            localPlatform,
          ),
          setProjectHidden,
          getCurrentProjectKeys: () => restorableProjectKeysRef.current,
          ensureProjectIncluded: filter.ensureProjectIncluded,
          localPlatform,
        });
        if (restored) return;
      }
      handleClearSelection();
      patchNewMakerDraft({ workingDir: result.path, remoteHostId: null });
      navigate('/cc-agent/new', { state: makeNewMakerRouteState('dialogue') });
    } catch (err) {
      log.warn('create project directory picker failed', err);
      toast.error(t('ccAgent.sidebar.createProjectFailed'));
    }
  }, [
    filter.ensureProjectIncluded,
    handleClearSelection,
    hiddenProjectKeys,
    navigate,
    setProjectHidden,
    t,
  ]);

  /**
   * 新建对话。目标设备两种来源:
   *   - 调用方给出显式目标(`deviceTarget` 传了值):按设备分组时对话组隶属于某个
   *     设备段,组头的新建就该落在该设备上(null = 本机段),不再看当前机器作用域
   *     (2026-08-12 用户裁决)。目标已确定,也就不受作用域解析的 pending 影响。
   *   - 未给(undefined):沿用作用域推断——仅当作用域唯一指向一台远程机器时继承它。
   */
  const handleCreateDialogue = useCallback(
    (deviceTarget?: DialogueDeviceTarget | null) => {
      let target: DialogueDeviceTarget | null;
      if (deviceTarget === undefined) {
        // 冷启动时 effective selection 会刻意保留持久化的唯一远端选择，但设备目录可能尚未
        // settle、switcherDevices 仍为空。此时不能把“尚未解析”当成“确认缺失”并回落本机；
        // 展开态段头与折叠 rail 面板共用这个 handler，因此在目标可判定前统一不创建。
        if (selectedDialogueDeviceResolution.status === 'pending') return;
        target = selectedDialogueDeviceResolution.target;
      } else {
        target = deviceTarget;
      }
      handleClearSelection();
      navigate('/cc-agent/new', {
        state: makeDialogueNewMakerRouteState(target),
      });
    },
    [handleClearSelection, navigate, selectedDialogueDeviceResolution],
  );

  const handleLinkCodexProject = useCallback(
    async (project: ProjectNode) => {
      if (linkingCodexProject) return;
      setLinkingCodexProject(project.projectKey);
      try {
        const result = await window.electronAPI.localDb.sessionImport.linkCodexProject(
          project.workingDir,
        );
        if (result.inserted > 0 || result.updated > 0) {
          toast.success(
            t('ccAgent.sidebar.projectAction.syncCodexDone', {
              inserted: result.inserted,
              updated: result.updated,
            }),
          );
          emitRefresh();
        } else if (result.matched > 0) {
          toast.warning(t('ccAgent.sidebar.projectAction.syncCodexAlreadyLinked'));
        } else {
          toast.warning(t('ccAgent.sidebar.projectAction.syncCodexNone'));
        }
      } catch (err) {
        log.error('[link codex project]', err);
        toast.error(
          t('ccAgent.sidebar.projectAction.syncCodexFailed', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        setLinkingCodexProject(null);
      }
    },
    [linkingCodexProject, t],
  );

  /* ---- Project 行内的 Open Explorer 按钮：在系统文件管理器中打开 workingDir ----
   * 复用现有 shell:open-path IPC（preload 暴露为 electronAPI.openPath），
   * 失败仅 toast 提示，不抛错——"打开文件夹失败" 一般是路径不存在/权限问题。
   */
  const handleOpenInExplorer = useCallback(
    async (workingDir: string) => {
      try {
        const result = await window.electronAPI.openPath(workingDir);
        if (!result.success) {
          toast.error(result.error || t('ccAgent.common.openFolderFailed'));
        }
      } catch (err) {
        log.error('[open in explorer]', err);
        toast.error(t('ccAgent.common.openFolderFailed'));
      }
    },
    [t],
  );

  /* ---- Project 行内的 Browse Files 按钮：进入 workdir 文件浏览模式 ----
   * 策略:
   *   1. 当前 active session 在该 project → 直接 navigate('/cc-agent/files/<active>')
   *      (chat rail 自然继承当前会话上下文,符合设计稿"继承当前打开的 session"行为)。
   *   2. 否则挑该 project 下最近活跃的非 archived session → navigate(...)
   *   3. 完全没有 session → toast 提示先建一个会话。
   * 二次确认对话框(设计稿里的 "switch session?" 弹窗)留待后续迭代,先以静默切换 + toast
   * 提示落地最小可用版。
   */
  const handleBrowseFiles = useCallback(
    (project: ProjectNode) => {
      const targetProjectKey = project.projectKey;
      const inProject = (s: (typeof sessions)[number]): boolean =>
        projectIdentityKeyForSession(s) === targetProjectKey && s.status !== 'deleted';
      const navigateToProjectSession = (id: string) => {
        if (project.scope === 'remote') {
          navigate(`/cc-agent/${id}`);
          return;
        }
        navigate(`/cc-agent/files/${id}`);
      };

      // 优先用 active session(若属于这个 project)。
      if (activeSessionId) {
        const active = sessions.find((s) => s.id === activeSessionId);
        if (active && inProject(active)) {
          navigateToProjectSession(activeSessionId);
          return;
        }
      }
      // 否则取该 project 下 updatedAt 最大的 session(sessions 已按 updatedAt desc 排好)。
      const fallback = sessions.find(inProject);
      if (fallback) {
        navigateToProjectSession(fallback.id);
        return;
      }
      toast.warning(t('ccAgent.sidebar.browseEmpty'));
    },
    [activeSessionId, sessions, navigate, t],
  );

  /* ---- Rename handler ---- */
  const handleRename = useCallback(
    async (sessionId: string, editedTitle: string) => {
      const session = sessionsByIdRef.current.get(sessionId);
      if (isRemoteSessionWriteBlocked(session)) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      // SessionItem / SessionCard 的重命名输入框预填的是**显示标题**(legacy automation
      // 会话已剥掉 `[Schedule] ` 前缀),直接落库会让它从 automation 分组里消失。提交前
      // 把前缀还原回去(PR #1031 review P1)。
      const newTitle = session ? toStoredSessionTitle(session, editedTitle) : editedTitle;
      // 取旧值用于失败回滚，乐观先 patch（不刷整列表，列表顺序保持稳定）
      // 保持读 sessions(而非 sessionsById):后者含 remoteProjectSessions,换源会连带
      // 改变远程会话的回滚行为,不在本次修复范围内。
      const oldTitle = sessionsRef.current.find((s) => s.id === sessionId)?.title;
      patchLocal(sessionId, { title: newTitle });
      try {
        // 远程会话:patch-meta 经隧道写被控端 → 广播 sessions:patched → applyPatch 更新远程分片(纯镜像)。
        await sessionService.patchMeta(sessionId, { title: newTitle });
      } catch (err) {
        log.error('[session rename]', err);
        toast.error(t('ccAgent.sidebar.renameFailed'));
        if (oldTitle !== undefined) patchLocal(sessionId, { title: oldTitle });
      }
    },
    [patchLocal, t],
  );

  const handleProjectAliasChange = useCallback(
    async (project: ProjectNode, alias: string) => {
      try {
        await projectAliases.updateAlias(project.projectKey, alias);
      } catch (err) {
        log.error('[project alias rename]', err);
        toast.error(t('ccAgent.sidebar.projectAlias.renameFailed'));
        throw err;
      }
    },
    [projectAliases, t],
  );

  const handleRemoveProjectFromSidebar = useCallback(
    async (project: ProjectNode) => {
      // Add Project currently restores local directories only, so remote
      // projects do not expose this action until they have a symmetric path.
      if (project.scope !== 'local') return;
      const confirmed = await confirmDialog({
        title: t('ccAgent.sidebar.projectAction.removeFromSidebarConfirmTitle', {
          name: project.displayName,
        }),
        description: t('ccAgent.sidebar.projectAction.removeFromSidebarConfirmDescription'),
        confirmText: t('ccAgent.sidebar.projectAction.removeFromSidebarConfirmAction'),
        autoFocusConfirm: true,
      });
      if (!confirmed) return;
      try {
        await setProjectHidden(project.projectKey, true);
        handleClearSelection();
        railPanelStore.closeAll();
      } catch (err) {
        log.warn('remove project from sidebar failed', err);
        toast.error(t('ccAgent.sidebar.projectAction.removeFromSidebarFailed'));
      }
    },
    [confirmDialog, handleClearSelection, setProjectHidden, t],
  );

  /* ---- Pin / Unpin handler ---- */
  const handleTogglePin = useCallback(
    async (sessionId: string, currentlyPinned: boolean) => {
      const session = sessionsByIdRef.current.get(sessionId);
      if (isRemoteSessionWriteBlocked(session)) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      // 同 handleRename:回滚值刻意仍读 sessions,不换成 sessionsById。
      const current = sessionsRef.current.find((s) => s.id === sessionId);
      const oldPinnedAt = current?.pinnedAt ?? null;
      const oldSummary = current?.summary ?? null;
      const newPinnedAt = currentlyPinned ? null : new Date().toISOString();
      patchLocal(
        sessionId,
        currentlyPinned ? { pinnedAt: null, summary: null } : { pinnedAt: newPinnedAt },
      );
      // pin / re-pin 时把它顶到 manualPinnedOrder 首位，否则带着老 rank 会卡回原位。
      // unpin 不主动从 order 里删（无害,下次 drag 触发的 normalize 会顺手 GC）。
      if (!currentlyPinned) {
        void filter.promotePin(sessionId).catch((err) => {
          log.warn('failed to persist pinned session order', err);
          toast.error(t('ccAgent.sidebar.pinFailed'));
        });
      }
      try {
        // 远程会话:patch-meta → 广播 sessions:patched → applyPatch 更新远程分片(纯镜像)。
        await sessionService.patchMeta(sessionId, { pinnedAt: newPinnedAt });
      } catch (err) {
        log.error('[session pin]', err);
        toast.error(t('ccAgent.sidebar.pinFailed'));
        patchLocal(
          sessionId,
          currentlyPinned
            ? { pinnedAt: oldPinnedAt, summary: oldSummary }
            : { pinnedAt: oldPinnedAt },
        );
      }
    },
    // 只依赖 filter.promotePin(useCallback 稳定),不要整个 filter ——
    // useSidebarFilter 每次调用都返回新对象字面量,带上它等于每渲染换引用。
    [filter.promotePin, patchLocal, t],
  );

  const handleToggleProjectPin = useCallback(
    async (project: ProjectNode, currentlyPinned: boolean) => {
      const entryId = pinnedProjectEntryId(project.projectKey);
      try {
        if (currentlyPinned) {
          await filter.removePin(entryId);
        } else {
          // New and re-pinned projects lead the unified project/conversation list.
          await filter.promotePin(entryId);
        }
      } catch (err) {
        log.warn('failed to persist project pin', err);
        toast.error(t('ccAgent.sidebar.pinFailed'));
      }
    },
    [filter, t],
  );

  const handleMoveSession = useCallback(
    async (sessionId: string, target: SessionMoveTarget) => {
      const session = sessionsByIdRef.current.get(sessionId);
      if (!session) return;
      if (session.remoteHostId || session.deviceLinkDeviceId) {
        toast.warning(t('ccAgent.sidebar.sessionMenu.moveToProjectRemoteUnsupported'));
        return;
      }
      if (effectiveRunningSessionIds.has(sessionId)) {
        toast.warning(t('ccAgent.sidebar.sessionMenu.moveToProjectRunningBlocked'));
        return;
      }
      try {
        const binding = await window.electronAPI.binding.resolveSession(sessionId);
        if (binding.attached) {
          toast.warning(t('ccAgent.sidebar.sessionMenu.moveToProjectAttachedBlocked'));
          return;
        }
      } catch {
        // resolveSession 失败时不阻断移动；它只是 IM 接管保护的额外检查。
      }

      let targetWorkingDir = target.kind === 'project' ? target.workingDir : undefined;
      if (target.kind === 'browseProject') {
        try {
          const result = await window.electronAPI.showOpenDirectoryDialog();
          if (result.canceled || !result.path) return;
          targetWorkingDir = result.path;
        } catch (err) {
          log.warn('[session move to project] directory picker failed', err);
          toast.error(t('ccAgent.sidebar.sessionMenu.moveToProjectFailed'));
          return;
        }
      }

      const oldPatch = {
        workingDir: session.workingDir,
        workspaceKind: session.workspaceKind,
      };
      if (target.kind !== 'dialogue' && !targetWorkingDir) return;
      const nextPatch =
        target.kind === 'dialogue'
          ? { workspaceKind: 'dialogue' as const }
          : { workingDir: targetWorkingDir, workspaceKind: 'project' as const };
      patchLocal(sessionId, nextPatch);
      let expandedProjectKey: string | null = null;
      let wasExpandedProjectCollapsed = false;
      if (targetWorkingDir) {
        const normalized = normalizeWorkingDir(targetWorkingDir);
        if (normalized) {
          expandedProjectKey = projectIdentityKey('local', normalized, null);
          wasExpandedProjectCollapsed = collapse.collapsed.has(expandedProjectKey);
          collapse.expand(expandedProjectKey);
        }
      }
      try {
        await sessionService.update(sessionId, nextPatch);
        if (target.kind !== 'dialogue') {
          void recentWorkdirsStore.forceRefresh().catch(() => undefined);
        }
        toast.success(
          t(
            target.kind === 'dialogue'
              ? 'ccAgent.sidebar.sessionMenu.moveToDialogueDone'
              : 'ccAgent.sidebar.sessionMenu.moveToProjectDone',
          ),
        );
      } catch (err) {
        log.error('[session move]', err);
        patchLocal(sessionId, oldPatch);
        if (expandedProjectKey && wasExpandedProjectCollapsed) {
          collapse.setCollapsed(expandedProjectKey, true);
        }
        toast.error(
          t(
            target.kind === 'dialogue'
              ? 'ccAgent.sidebar.sessionMenu.moveToDialogueFailed'
              : 'ccAgent.sidebar.sessionMenu.moveToProjectFailed',
          ),
        );
      }
    },
    // 同理只依赖用到的三个成员,不要整个 collapse —— useCollapsedProjects 也返回
    // 新对象字面量。collapsed 是 Set,仅用户手动折叠/展开时换引用,频率可忽略。
    [
      collapse.collapsed,
      collapse.expand,
      collapse.setCollapsed,
      effectiveRunningSessionIds,
      patchLocal,
      t,
    ],
  );

  /* ---- Delete / Archive / Unarchive action handlers ----
   * delete 走 ConfirmDialog —— 不可逆，必须确认；
   * archive / archive-now 都直接执行，不弹确认框：归档可逆（菜单里就有「恢复」），
   *   行内入口本身已经是两步确认，菜单入口再弹一次纯属多余摩擦。唯一例外是
   *   worktree 有未提交改动 —— 归档会顺带回收 worktree，这时升级到 ConfirmDialog
   *   展示 dirty warning；
   * unarchive 是 archive 的反向操作，无副作用，直接 patch 即可，不弹确认。
   *
   * 执行序列（关子进程 / 写库 / 乐观补丁 / 释放内存 / refresh / 跳转）抽在
   * useSessionLifecycleActions，与 SessionContentHeader 共用；本组件只保留
   * 前置检查（running / IM 接管拦截）与确认弹窗编排。
   */
  // includeArchived 跟随当前列表桶（filter.status）—— archived / all 桶里
  // 删除后要刷对应桶，否则已删行残留（见 hook 文件头注释）。
  const { runSessionAction, unarchiveSession } = useSessionLifecycleActions({
    includeArchived: filter.status,
  });

  const handleActionClick = useCallback(
    async (sessionId: string, action: 'delete' | 'archive' | 'archive-now' | 'unarchive') => {
      const session = sessionsByIdRef.current.get(sessionId);
      if (isRemoteSessionWriteBlocked(session)) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      const isArchiveLike = action === 'archive' || action === 'archive-now';
      // 执行中的 session 不允许归档 —— 让用户先停下当前任务
      if (isArchiveLike && runningSessionIds.has(sessionId)) {
        toast.warning(t('ccAgent.sidebar.archiveBlocked.running'));
        return;
      }
      // 被 IM 接管中的 session 不允许归档 —— 接管方还在操控，先收回再归档。
      // sidebar 常驻订阅的 attached 集合与 binding:resolve-session 同源
      // (binding:list-attached = 全量 resolve, binding:changed 驱动 refresh),
      // 命中就直接拦，连 IPC 都不用发。
      if (isArchiveLike && attachedSessionIdsRef.current.has(sessionId)) {
        toast.warning(t('ccAgent.sidebar.archiveBlocked.attached'));
        return;
      }
      // 本地集合没命中仍问一次 main 兜底(刚 attach 而 binding:changed 尚未到达
      // 时不能漏拦)。**先发不 await**:它与下面的 dirty 预检互不依赖,让两次 IPC
      // 在链路上重叠,归档前的等待从 sum(两次往返) 降到 max —— dirty 预检要在
      // main 侧跑 git status,串行叠加会明显拖长"点了归档、列表还没反应"的时间。
      // 失败降级为「未接管」(与改造前 catch 后继续归档同口径)。
      const attachedPromise = isArchiveLike
        ? window.electronAPI.binding
            .resolveSession(sessionId)
            .then((binding) => binding.attached)
            .catch(() => false)
        : null;
      const blockedByAttachment = async (): Promise<boolean> => {
        if (!(await attachedPromise)) return false;
        toast.warning(t('ccAgent.sidebar.archiveBlocked.attached'));
        return true;
      };
      // 归档一律不弹确认框:它是可逆的(菜单里就有「恢复」),菜单入口与行内
      // 快捷按钮同一口径直接执行 —— 行内那个本身已经是两步确认。
      // 唯一例外是 worktree 有未提交改动:归档会顺带回收 worktree,这时升级到
      // 确认弹窗展示 dirty warning,不让改动被静默带走。
      if (isArchiveLike) {
        // 接管拦截先结算:被接管时不该弹任何归档确认。
        if (await blockedByAttachment()) return;
        // **worktree 预检必须是最后一个前置条件**(codex review):它之后再 await
        // 任何东西(比如原来排在后面的接管查询),都会给「clean 结论」留一段失效
        // 窗口 —— 编辑器或收尾中的 agent 在那段时间写脏工作区,归档就不带警告地
        // 过去了。并行没有丢:菜单打开 / 亮出 Confirm 胶囊时的 prefetch 已经把查询
        // 发出去并热了 git cache,而这里 resolve 对 clean 一律重查(见
        // worktreeRemovalWarning 的非对称复用),拿到的是此刻的结论。
        //
        // 窗口不可能压到零 —— 从这次查询返回到 main 侧真正 `git worktree remove`
        // 之间还有写库和回收链;那一段由 main 在删除前重新检测 + auto-stash 兜住
        // (WorktreeManager.removeWorktreeForSession),renderer 这层负责的是「别拿
        // 明显过期的结论免掉确认」。
        const preflight = await resolveWorktreeRemovalPreflight(
          sessionId,
          session?.deviceLinkDeviceId,
        );
        // 免确认的判据是「**确认**干净」,不是「不是脏的」:'unknown'(预检失败)
        // 同样要弹确认框,否则归档会静默回收可能带着未提交改动的 worktree
        // (greptile review)。'unknown' 时不摆 dirty 警告文案 —— 那会谎称有改动,
        // 走的是普通归档确认。
        if (preflight !== 'clean') {
          setConfirm({
            open: true,
            sessionId,
            action: 'archive',
            dirtyWorktree: preflight === 'dirty',
          });
          return;
        }
        // 重定向判定用 viewedSessionId:files 路由下归档「正在浏览的会话」也要
        // 跳离失效的文件视图(codex review;正常路由下两者恒等)。经 ref 读:它随
        // 路由切换而变,留在 deps 里会让本 handler 每次切换都重建、打穿整表 memo。
        await runSessionAction(sessionId, 'archive', {
          activeSessionId: viewedSessionIdRef.current,
        });
        return;
      }
      if (action === 'delete') {
        // 删除不可逆,始终弹确认框 —— 所以这里用不到三态:预检失败时少一行警告文案,
        // 不会变成静默放行。
        // P1 预检:worktree 有未提交更改时确认文案追加警告(查询失败降级为不提示)
        const dirtyWorktree =
          (await resolveWorktreeRemovalPreflight(sessionId, session?.deviceLinkDeviceId)) ===
          'dirty';
        setConfirm({ open: true, sessionId, action, dirtyWorktree });
        return;
      }
      await unarchiveSession(sessionId);
    },
    [runningSessionIds, runSessionAction, unarchiveSession, t],
  );

  const handleConfirm = useCallback(async () => {
    const { sessionId, action } = confirm;
    const session = sessionsById.get(sessionId);
    if (isRemoteSessionWriteBlocked(session)) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      setConfirm(CONFIRM_INITIAL);
      return;
    }
    // 重定向判定统一用 viewedSessionId(files 路由下 = 被浏览文件的会话,
    // 正常路由下与 activeSessionId 恒等):从面板删除/归档正在浏览的会话时
    // 也要跳离失效的 /cc-agent/files/:id(codex review)。
    const deleteRedirectRoute =
      action === 'delete' && sessionId === viewedSessionId
        ? await resolveSessionRemovalRedirect(new Set([sessionId]), sessionId)
        : null;
    await runSessionAction(sessionId, action, {
      activeSessionId: viewedSessionId,
      deleteRedirectRoute,
    });
    setConfirm(CONFIRM_INITIAL);
  }, [viewedSessionId, confirm, resolveSessionRemovalRedirect, runSessionAction, sessionsById, t]);

  const handleCancelConfirm = useCallback(() => {
    setConfirm(CONFIRM_INITIAL);
  }, []);

  const handleBulkDelete = useCallback(async () => {
    if (bulkActionPending !== null) return;
    if (selectedSessions.some(isRemoteSessionWriteBlocked)) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    const candidates = selectedSessions.filter((session) => session.status !== 'deleted');
    if (candidates.length === 0) {
      handleClearSelection();
      return;
    }

    // P1 预检:统计有未提交更改 worktree 的会话数,确认文案追加警告
    const dirtyCount = await countDirtyWorktreesForRemoval(candidates);

    const ok = await confirmDialog({
      title: t('ccAgent.sidebar.bulkSelection.confirmDelete.title'),
      description:
        t('ccAgent.sidebar.bulkSelection.confirmDelete.description', {
          count: candidates.length,
        }) +
        (dirtyCount > 0
          ? ' ' +
            t('ccAgent.sidebar.bulkSelection.confirmDelete.dirtyWorktreeWarning', {
              count: dirtyCount,
            })
          : ''),
      confirmText: t('ccAgent.sidebar.bulkSelection.confirmDelete.confirm'),
      cancelText: t('ccAgent.sidebar.bulkSelection.confirmDelete.cancel'),
    });
    if (!ok) return;

    const orderedSessionIdsBeforeDelete = getVisibleSidebarSessionIds(sidebarScrollRef.current);
    setBulkActionPending('delete');
    const failed: string[] = [];
    try {
      for (const session of candidates) {
        makerChatStore.closeSessionQuery(session.id);
        try {
          // patchMeta 按来源路由:远程会话经隧道写被控端 patch-meta(allowlist 内),本地仍走 update。
          await sessionService.patchMeta(session.id, { status: 'deleted' });
          makerChatStore.purgeSession(session.id);
          discardComposerDraft(session.id);
          // RSB 布局偏好(fraction / treeWidth / collapsed)走 localStorage 是
          // 本机概念,本地 + 远程 session 都要清(被控端的 localStorage 由被控端自己处理)。
          cleanupSessionLayoutPrefs(session.id);
          // 图片缓存清理是本机概念;远程会话的图在被控端,由被控端自己的删除流程处理。
          if (!session.deviceLinkDeviceId) {
            void window.electronAPI.cleanupSessionImages(session.id).catch((err: unknown) => {
              log.warn('[bulk session delete] cleanup images failed', err);
            });
          }
        } catch (err) {
          log.error('[bulk session delete]', err);
          failed.push(session.id);
        }
      }

      const failedIds = new Set(failed);
      const succeededIds = new Set(
        candidates.filter((session) => !failedIds.has(session.id)).map((session) => session.id),
      );
      await refreshSessions();
      void refreshWorktrees();

      if (viewedSessionId && succeededIds.has(viewedSessionId)) {
        const redirectRoute = await resolveSessionRemovalRedirect(
          succeededIds,
          viewedSessionId,
          orderedSessionIdsBeforeDelete,
        );
        navigate(redirectRoute ?? '/cc-agent');
      }

      setSelectedSessionIds((prev) => {
        const next = new Set(prev);
        for (const id of succeededIds) next.delete(id);
        return next;
      });
      setSelectionAnchorSessionId((prev) => (prev && succeededIds.has(prev) ? null : prev));

      if (failed.length === 0) {
        toast.success(t('ccAgent.sidebar.bulkSelection.deleted', { count: succeededIds.size }));
      } else {
        toast.error(
          t('ccAgent.sidebar.bulkSelection.partialDeleteFailure', {
            ok: succeededIds.size,
            fail: failed.length,
          }),
        );
      }
    } finally {
      setBulkActionPending(null);
    }
  }, [
    viewedSessionId,
    bulkActionPending,
    confirmDialog,
    handleClearSelection,
    navigate,
    refreshSessions,
    refreshWorktrees,
    resolveSessionRemovalRedirect,
    selectedSessions,
    t,
  ]);

  const handleBulkArchive = useCallback(async () => {
    if (bulkActionPending !== null) return;
    if (selectedSessions.some(isRemoteSessionWriteBlocked)) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    const skippedNotActive = selectedSessions.filter(
      (session) => session.status !== 'active',
    ).length;
    const skippedRunning = selectedSessions.filter(
      (session) => session.status === 'active' && runningSessionIds.has(session.id),
    ).length;
    const preflightCandidates = selectedSessions.filter(
      (session) => session.status === 'active' && !runningSessionIds.has(session.id),
    );
    const attachedIds = new Set(
      (
        await Promise.all(
          preflightCandidates.map(async (session) => {
            try {
              const binding = await window.electronAPI.binding.resolveSession(session.id);
              return binding.attached ? session.id : null;
            } catch {
              // resolveSession 失败时与单条归档一致:不阻断归档。
              return null;
            }
          }),
        )
      ).filter((id): id is string => id != null),
    );
    const candidates = preflightCandidates.filter((session) => !attachedIds.has(session.id));

    if (candidates.length === 0) {
      toast.warning(t('ccAgent.sidebar.bulkSelection.archiveNone'));
      return;
    }

    const dirtyCount = await countDirtyWorktreesForRemoval(candidates);

    const skipNotes: string[] = [];
    if (skippedRunning > 0)
      skipNotes.push(t('ccAgent.sidebar.bulkSelection.skipRunning', { count: skippedRunning }));
    if (attachedIds.size > 0)
      skipNotes.push(t('ccAgent.sidebar.bulkSelection.skipAttached', { count: attachedIds.size }));
    if (skippedNotActive > 0)
      skipNotes.push(t('ccAgent.sidebar.bulkSelection.skipNotActive', { count: skippedNotActive }));
    const baseDescription =
      skipNotes.length > 0
        ? t('ccAgent.sidebar.bulkSelection.confirmArchive.descriptionWithSkip', {
            count: candidates.length,
            skip: skipNotes.join(t('ccAgent.sidebar.bulkSelection.skipSeparator')),
          })
        : t('ccAgent.sidebar.bulkSelection.confirmArchive.description', {
            count: candidates.length,
          });
    const description =
      baseDescription +
      (dirtyCount > 0
        ? ' ' +
          t('ccAgent.sidebar.bulkSelection.confirmArchive.dirtyWorktreeWarning', {
            count: dirtyCount,
          })
        : '');

    const ok = await confirmDialog({
      title: t('ccAgent.sidebar.bulkSelection.confirmArchive.title'),
      description,
      confirmText: t('ccAgent.sidebar.bulkSelection.confirmArchive.confirm'),
      cancelText: t('ccAgent.sidebar.bulkSelection.confirmArchive.cancel'),
    });
    if (!ok) return;

    setBulkActionPending('archive');
    const failed: string[] = [];
    try {
      for (const session of candidates) {
        makerChatStore.closeSessionQuery(session.id);
        try {
          // patchMeta 按来源路由:远程会话经隧道写被控端;本地仍走 update。
          await sessionService.patchMeta(session.id, { status: 'archived', pinnedAt: null });
          // 乐观本地 patch 只对本机会话;远程会话由隧道广播 sessions:patched → applyPatch 更新远程分片。
          if (!session.deviceLinkDeviceId) {
            patchLocal(session.id, { status: 'archived', pinnedAt: null });
          }
          makerChatStore.purgeSession(session.id);
          discardComposerDraft(session.id);
        } catch (err) {
          log.error('[bulk session archive]', err);
          failed.push(session.id);
        }
      }

      const failedIds = new Set(failed);
      const succeededIds = new Set(
        candidates.filter((session) => !failedIds.has(session.id)).map((session) => session.id),
      );
      await refreshSessions();
      void refreshWorktrees();

      if (viewedSessionId && succeededIds.has(viewedSessionId)) {
        navigate('/cc-agent');
      }

      setSelectedSessionIds((prev) => {
        const next = new Set(prev);
        for (const id of succeededIds) next.delete(id);
        return next;
      });
      setSelectionAnchorSessionId((prev) => (prev && succeededIds.has(prev) ? null : prev));

      if (failed.length === 0) {
        toast.success(t('ccAgent.sidebar.bulkSelection.archived', { count: succeededIds.size }));
      } else {
        toast.error(
          t('ccAgent.sidebar.bulkSelection.partialArchiveFailure', {
            ok: succeededIds.size,
            fail: failed.length,
          }),
        );
      }
    } finally {
      setBulkActionPending(null);
    }
  }, [
    viewedSessionId,
    bulkActionPending,
    confirmDialog,
    navigate,
    patchLocal,
    refreshSessions,
    refreshWorktrees,
    runningSessionIds,
    selectedSessions,
    t,
  ]);

  /* ---- Project 批量归档动作 ----
   * active / all 筛选：归档该 project 下所有可归档的 active session；
   * archived 筛选：恢复该 project 下所有 archived session。
   * 两个方向都逐条写入，单条失败不会阻断其余会话，最后统一 refresh。
   */
  const handleArchiveAllInProject = useCallback(
    async (project: ProjectNode) => {
      if (isDeviceLinkWriteBlocked(project)) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      const targetProjectKey = project.projectKey;
      const action = projectBulkArchiveActionForStatus(filter.status);
      const belongsToProject = (session: Session): boolean =>
        projectIdentityKeyForSession(session) === targetProjectKey;

      // 只对**本地** sessions 归档:device-link 远程会话的运行态不在本渲染进程(runningSessionIds 是
      // 本地 makerChatStore 的),无法像本地那样把「正在运行」的排除掉 —— 批量归档时可能把被控端正在
      // 跑的会话也归档掉。安全起见远程项目的「归档全部」维持 #331 前的本地口径(对纯远程项目即空操作);
      // 要安全支持远程批量归档需被控端侧的「运行态感知批量归档」命令,留作 follow-up。
      // pinned 是用户主动表达 "留住这个会话"，archive all 必须排除（跟 running 是两个独立维度）。
      // 既 pinned 又 running 的：归到 pinned 那类（用户意图明确，running 只是临时状态）。
      const { candidates, skippedPinned, skippedRunning } = selectProjectBulkArchiveCandidates(
        sessions,
        action,
        runningSessionIds,
        belongsToProject,
      );

      if (action === 'unarchive') {
        if (candidates.length === 0) {
          toast.warning(t('ccAgent.sidebar.unarchiveAll.empty'));
          return;
        }

        const ok = await confirmDialog({
          title: t('ccAgent.sidebar.unarchiveAll.title'),
          description: t('ccAgent.sidebar.unarchiveAll.description', { count: candidates.length }),
          confirmText: t('ccAgent.sidebar.unarchiveAll.confirm'),
          cancelText: t('ccAgent.sidebar.unarchiveAll.cancel'),
        });
        if (!ok) return;

        const failed: string[] = [];
        for (const session of candidates) {
          try {
            // 确认框是异步边界：由持久层在单条 UPDATE 中同时校验 archived 状态和
            // 原项目身份，避免 get + update 在两次异步调用之间仍可被并发写穿。
            const restored = await sessionService.restoreIfArchived(session.id, session);
            if (!restored) {
              failed.push(session.id);
              continue;
            }
            patchLocal(restored.id, { status: 'active' });
          } catch (err) {
            log.error('[unarchive all]', err);
            failed.push(session.id);
          }
        }

        const succeededCount = candidates.length - failed.length;
        await refreshSessions();
        // 批量恢复跨 archived → active 桶，强制刷新其余缓存桶，确保 active / all
        // 视图切换后立即看到恢复结果。
        emitRefresh();

        if (failed.length === 0) {
          toast.success(t('ccAgent.sidebar.unarchiveAll.unarchived', { count: succeededCount }));
        } else {
          toast.error(
            t('ccAgent.sidebar.unarchiveAll.partialFailure', {
              ok: succeededCount,
              fail: failed.length,
            }),
          );
        }
        return;
      }

      if (candidates.length === 0) {
        if (skippedPinned > 0 && skippedRunning > 0) {
          toast.warning(t('ccAgent.sidebar.archiveAll.allPinnedOrRunning'));
        } else if (skippedPinned > 0) {
          toast.warning(t('ccAgent.sidebar.archiveAll.allPinned'));
        } else if (skippedRunning > 0) {
          toast.warning(t('ccAgent.sidebar.archiveAll.allRunning'));
        } else {
          toast.warning(t('ccAgent.sidebar.archiveAll.empty'));
        }
        return;
      }

      const dirtyCount = await countDirtyWorktreesForRemoval(candidates);

      const skipNotes: string[] = [];
      if (skippedRunning > 0)
        skipNotes.push(t('ccAgent.sidebar.archiveAll.skipRunning', { count: skippedRunning }));
      if (skippedPinned > 0)
        skipNotes.push(t('ccAgent.sidebar.archiveAll.skipPinned', { count: skippedPinned }));
      const skipSep = t('ccAgent.sidebar.archiveAll.skipSeparator');
      const baseDescription =
        skipNotes.length > 0
          ? t('ccAgent.sidebar.archiveAll.descriptionWithSkip', {
              count: candidates.length,
              skip: skipNotes.join(skipSep),
            })
          : t('ccAgent.sidebar.archiveAll.description', { count: candidates.length });
      const description =
        baseDescription +
        (dirtyCount > 0
          ? ' ' +
            t('ccAgent.sidebar.bulkSelection.confirmArchive.dirtyWorktreeWarning', {
              count: dirtyCount,
            })
          : '');

      const ok = await confirmDialog({
        title: t('ccAgent.sidebar.archiveAll.title'),
        description,
        confirmText: t('ccAgent.sidebar.archiveAll.confirm'),
        cancelText: t('ccAgent.sidebar.archiveAll.cancel'),
      });
      if (!ok) return;

      // 失败的 id 收集起来，最后统一 toast；其余继续走完，不让一条失败拖累整批。
      const failed: string[] = [];
      for (const s of candidates) {
        // 关掉 SDK subprocess + 清 in-memory state，与单条 archive 行为一致
        makerChatStore.closeSessionQuery(s.id);
        try {
          await sessionService.setStatus(s.id, 'archived');
          // 跨 bucket 同步:见 handleConfirm 同位置注释。
          patchLocal(s.id, { status: 'archived', pinnedAt: null });
          makerChatStore.purgeSession(s.id);
          discardComposerDraft(s.id);
        } catch (err) {
          log.error('[archive all]', err);
          failed.push(s.id);
        }
      }

      const failedIds = new Set(failed);
      const succeededIds = new Set(candidates.filter((s) => !failedIds.has(s.id)).map((s) => s.id));

      await refreshSessions();
      void refreshWorktrees();

      // 当前注视中的 session 被归档了 → 走 /cc-agent 让 CCAgentIndexRedirect
      // 做 Orca-aware 的「选下一条 / 空则跳 new」决策(见 runSessionAction 同位置注释)。
      if (viewedSessionId && succeededIds.has(viewedSessionId)) {
        navigate('/cc-agent');
      }

      if (failed.length === 0) {
        toast.success(t('ccAgent.sidebar.archiveAll.archived', { count: succeededIds.size }));
      } else {
        toast.error(
          t('ccAgent.sidebar.archiveAll.partialFailure', {
            ok: succeededIds.size,
            fail: failed.length,
          }),
        );
      }
    },
    [
      sessions,
      runningSessionIds,
      confirmDialog,
      refreshSessions,
      refreshWorktrees,
      viewedSessionId,
      navigate,
      patchLocal,
      filter.status,
      t,
    ],
  );
  const bulkActionInProgressLabel = t('ccAgent.sidebar.bulkSelection.actionInProgress');
  const bulkArchiveActionLabel = t('ccAgent.sidebar.bulkSelection.archive');
  const bulkDeleteActionLabel = t('ccAgent.sidebar.bulkSelection.delete');
  const bulkClearActionLabel = t('ccAgent.sidebar.bulkSelection.clear');
  const bulkArchiveLabel =
    bulkActionPending !== null
      ? `${bulkArchiveActionLabel} — ${bulkActionInProgressLabel}`
      : selectedActiveSessionCount === 0
        ? t('ccAgent.sidebar.bulkSelection.archiveNone')
        : bulkArchiveActionLabel;
  const bulkDeleteLabel =
    bulkActionPending !== null
      ? `${bulkDeleteActionLabel} — ${bulkActionInProgressLabel}`
      : bulkDeleteActionLabel;
  const bulkClearLabel =
    bulkActionPending !== null
      ? `${bulkClearActionLabel} — ${bulkActionInProgressLabel}`
      : bulkClearActionLabel;
  const bulkArchiveDisabled = bulkActionPending !== null || selectedActiveSessionCount === 0;
  const bulkActionDisabled = bulkActionPending !== null;

  return (
    <>
      {/* 顶部动作(新建 / 搜索 / 自动任务)已上移到 shell 的 SidebarTopNav 常驻列表;
          这里直接从多选操作条 / 列表内容开始。 */}
      {selectedSessionIds.size > 0 && (
        <div className="px-3 pb-2">
          <div
            className={cn(
              'flex h-8 items-center gap-1 rounded-full px-2 pl-3',
              'bg-[var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)]',
              'border border-[var(--cmd-palette-border)]',
            )}
          >
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {t('ccAgent.sidebar.bulkSelection.selected', { count: selectedSessionIds.size })}
            </span>
            <Tip text={bulkArchiveLabel} side="bottom">
              <span
                role={bulkArchiveDisabled ? 'button' : undefined}
                aria-disabled={bulkArchiveDisabled ? true : undefined}
                aria-label={bulkArchiveDisabled ? bulkArchiveLabel : undefined}
                tabIndex={bulkArchiveDisabled ? 0 : undefined}
                className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
              >
                <button
                  type="button"
                  onClick={() => void handleBulkArchive()}
                  disabled={bulkArchiveDisabled}
                  aria-label={bulkArchiveLabel}
                  aria-hidden={bulkArchiveDisabled ? true : undefined}
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full',
                    'text-[var(--cmd-palette-item-meta)] hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--msg-assistant-text)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                    'disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--cmd-palette-item-meta)]',
                  )}
                >
                  <Archive size={13} strokeWidth={2} />
                </button>
              </span>
            </Tip>
            <Tip text={bulkDeleteLabel} side="bottom">
              <span
                role={bulkActionDisabled ? 'button' : undefined}
                aria-disabled={bulkActionDisabled ? true : undefined}
                aria-label={bulkActionDisabled ? bulkDeleteLabel : undefined}
                tabIndex={bulkActionDisabled ? 0 : undefined}
                className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
              >
                <button
                  type="button"
                  onClick={() => void handleBulkDelete()}
                  disabled={bulkActionDisabled}
                  aria-label={bulkDeleteLabel}
                  aria-hidden={bulkActionDisabled ? true : undefined}
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full',
                    'text-[var(--cmd-palette-item-meta)] hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--msg-assistant-text)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                    'disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--cmd-palette-item-meta)]',
                  )}
                >
                  <Trash2 size={13} strokeWidth={2} />
                </button>
              </span>
            </Tip>
            <Tip text={bulkClearLabel} side="bottom">
              <span
                role={bulkActionDisabled ? 'button' : undefined}
                aria-disabled={bulkActionDisabled ? true : undefined}
                aria-label={bulkActionDisabled ? bulkClearLabel : undefined}
                tabIndex={bulkActionDisabled ? 0 : undefined}
                className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
              >
                <button
                  type="button"
                  onClick={handleClearSelection}
                  disabled={bulkActionDisabled}
                  aria-label={bulkClearLabel}
                  aria-hidden={bulkActionDisabled ? true : undefined}
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full',
                    'text-[var(--cmd-palette-item-meta)] hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--msg-assistant-text)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                    'disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--cmd-palette-item-meta)]',
                  )}
                >
                  <X size={13} strokeWidth={2} />
                </button>
              </span>
            </Tip>
          </div>
        </div>
      )}

      {/* 侧栏内容区:单一滚动容器(顶部导航的可滚动段 + 置顶 + 项目 + 对话一起滚动)。
         「新建」仍固定在 shell 顶部;自动任务 / 插件 / 搜索随列表滚走
         (2026-08-12 用户裁决,对齐 Codex)。搜索有查询时只钉搜索行,
         结果替换下方列表 —— 输入框不卸载、也不会被结果盖住。 */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={sidebarScrollRef}
          className="flex flex-col gap-2 pt-0 pb-4 overflow-y-auto flex-1"
          // 空白处右键 = 打开整理菜单(2026-08-12 用户裁决)。命中会话行 / 项目行 /
          // 对话组头时不接管——那些行有各自的右键菜单,由它们 stopPropagation 后
          // 自行处理;这里只兜「没有任何行响应」的空白区域。
          onContextMenu={handleSidebarBlankContextMenu}
          style={
            {
              scrollbarGutter: 'stable',
              // 顶部溢出渐隐:滚动后首行不再紧贴「新建」被硬切(见 topFade 注释)。
              // 24px 与右栏 TabBar 的横向 fade 同幅度,保持同一套视觉语言。
              ...(topFade && !search.trimmed
                ? {
                    WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 24px)',
                    maskImage: 'linear-gradient(to bottom, transparent 0, black 24px)',
                  }
                : null),
            } as React.CSSProperties
          }
        >
          {/* 顶部导航可滚动段:置于列表最上方,一起滚动。搜索打开时由 TopNav
              只钉搜索行,输入框保持同一份实例,结果替换下方列表。 */}
          <SidebarTopNav section="scrollable" />
          {searchActive ? (
            <div
              data-conversation-search-surface
              data-conversation-search-overlay
              onContextMenu={(event) => event.stopPropagation()}
            >
              <SearchResultsBody
                trimmed={search.trimmed}
                status={search.status}
                results={search.results}
                onSelect={search.handleSelect}
              />
            </div>
          ) : null}
          {/* 搜索时原列表只隐藏、不卸载:置顶段折叠等本地 state 才能保住。 */}
          <div hidden={searchActive} className="flex flex-col gap-2">
          {remoteDeviceDirectoryStatus === 'error' && !hasVisibleSidebarContent ? (
            <>
              <MainListScopeHeader
                filter={filter}
                allKnownProjects={visibleProjectUniverse}
                dialogueCount={allGroups.dialogues.length}
                hasRemoteDevices={deviceGroupingAvailable}
              />
              <RemoteSidebarLoadNotice
                kind="devices"
                status="error"
                partial={false}
                onRetry={retryDeviceLinkDeviceList}
              />
            </>
          ) : remoteSessionBootstrapFailures.length > 0 && !hasVisibleSidebarContent ? (
            <>
              <MainListScopeHeader
                filter={filter}
                allKnownProjects={visibleProjectUniverse}
                dialogueCount={allGroups.dialogues.length}
                hasRemoteDevices={deviceGroupingAvailable}
              />
              <RemoteSidebarLoadNotice
                kind="tasks"
                status="error"
                deviceLabel={failedRemoteDeviceLabel}
                partial={false}
              />
            </>
          ) : remoteDeviceDirectoryStatus === 'loading' && !hasVisibleSidebarContent ? (
            <>
              <MainListScopeHeader
                filter={filter}
                allKnownProjects={visibleProjectUniverse}
                dialogueCount={allGroups.dialogues.length}
                hasRemoteDevices={deviceGroupingAvailable}
              />
              <RemoteSidebarLoadNotice kind="devices" status="loading" partial={false} />
            </>
          ) : remoteSessionBootstrapLoadingDevices.length > 0 && !hasVisibleSidebarContent ? (
            <>
              <MainListScopeHeader
                filter={filter}
                allKnownProjects={visibleProjectUniverse}
                dialogueCount={allGroups.dialogues.length}
                hasRemoteDevices={deviceGroupingAvailable}
              />
              <RemoteSidebarLoadNotice
                kind="tasks"
                status="loading"
                deviceLabel={loadingRemoteDeviceLabel}
                partial={false}
              />
            </>
          ) : selectedMachineConnecting ? (
            // 选中机器连接中:会话还没同步,显示「连接中」而非「暂无对话」。
            // 范围标题恒在,可从菜单切回「所有 / 本机」,不会被困在占位页。
            <>
              <MainListScopeHeader
                filter={filter}
                allKnownProjects={visibleProjectUniverse}
                dialogueCount={allGroups.dialogues.length}
                hasRemoteDevices={deviceGroupingAvailable}
              />
              <div className="flex flex-col items-center justify-center px-3 py-12 text-center">
                <span className="animate-pulse text-xs text-[var(--text-tertiary)]">
                  {t('ccAgent.sidebar.machineSwitcher.connecting')}
                </span>
              </div>
            </>
          ) : (
            <>
              {remoteDeviceDirectoryStatus === 'error' && (
                <RemoteSidebarLoadNotice
                  kind="devices"
                  status="error"
                  partial
                  onRetry={retryDeviceLinkDeviceList}
                />
              )}
              {remoteSessionBootstrapFailures.length > 0 && (
                <RemoteSidebarLoadNotice
                  kind="tasks"
                  status="error"
                  deviceLabel={failedRemoteDeviceLabel}
                  partial
                />
              )}
              {/*
               * 远程任务 / 设备目录的 loading 只在上面的「无内容」分支显示。
               * 这里可能已经有本地或旧的远程快照；把后台重拉提示插进普通文档流会让
               * 整个侧栏在 loading↔ready 间上下移动，造成可见闪烁。错误提示仍保留
               * 在列表前，便于用户知道已有内容不是本轮权威结果。
               */}
              <PinnedSection
                entries={visiblePinnedEntries}
                allKnownProjects={visibleProjectUniverse}
                renderProject={(
                  project,
                  displaySessions,
                  parentSectionCollapsed,
                  sessionVariant,
                ) => (
                  <ProjectNodeView
                    project={project}
                    displaySessions={displaySessions}
                    sessionVariant={sessionVariant}
                    statusFilter={filter.status}
                    isCollapsed={collapse.collapsed.has(project.projectKey)}
                    collapsedAttentionTone={
                      collapse.collapsed.has(project.projectKey)
                        ? collapsedAttentionToneFor(displaySessions ?? project.sessions)
                        : null
                    }
                    parentSectionCollapsed={parentSectionCollapsed}
                    activeSessionId={activeSessionId}
                    runningSessionIds={displayRunningSessionIds}
                    attachedSessionIds={attachedSessionIds}
                    notifications={sidebarNotifications}
                    scheduleSessionIndex={scheduleSessionIndex}
                    selectedSessionIds={selectedSessionIds}
                    disableSessionCollapse={false}
                    onToggle={collapse.toggle}
                    isProjectPinned
                    onToggleProjectPin={handleToggleProjectPin}
                    onRenameProject={handleProjectAliasChange}
                    onRemoveFromSidebar={handleRemoveProjectFromSidebar}
                    onSessionClick={handleSessionClick}
                    onAction={handleActionClick}
                    onRename={handleRename}
                    onTogglePin={handleTogglePin}
                    onMoveSession={handleMoveSession}
                    projectOptions={projectPickerOptions}
                    onScheduleAction={handleScheduleAction}
                    onCreateInProject={handleCreateInProject}
                    onOpenConversationSearch={handleOpenConversationSearch}
                    onOpenInExplorer={handleOpenInExplorer}
                    onLinkCodexProject={handleLinkCodexProject}
                    linkingCodexProject={linkingCodexProject === project.projectKey}
                    onBrowseFiles={handleBrowseFiles}
                    onArchiveAll={handleArchiveAllInProject}
                  />
                )}
                activeSessionId={activeSessionId}
                runningSessionIds={displayRunningSessionIds}
                attachedSessionIds={attachedSessionIds}
                notifications={sidebarNotifications}
                selectedSessionIds={selectedSessionIds}
                onSessionClick={handleSessionClick}
                onAction={handleActionClick}
                onRename={handleRename}
                onTogglePin={handleTogglePin}
                onMoveSession={handleMoveSession}
                projectOptions={projectPickerOptions}
                onReorder={handlePinnedReorder}
              />
              {/* D 期:主列表 = 混排模型(项目行 + 散排对话 / 对话组,ProjectsSection
                  内部按 mainListModel 统一排序)。按日期分组与固定 Dialogue 段已删除。 */}
              <ProjectsSection
                unclassified={visibleUnclassified}
                projects={visibleProjectsWithVendor}
                dialogues={visibleDialogues}
                allKnownProjects={visibleProjectUniverse}
                dialogueCount={allGroups.dialogues.length}
                allProjectKeysForOrder={gcProjectKeys}
                filter={filter}
                collapsed={collapse.collapsed}
                isAllCollapsed={collapse.isAllCollapsed}
                activeSessionId={activeSessionId}
                viewedSessionId={viewedSessionId}
                runningSessionIds={displayRunningSessionIds}
                attachedSessionIds={attachedSessionIds}
                notifications={sidebarNotifications}
                scheduleSessionIndex={scheduleSessionIndex}
                selectedSessionIds={selectedSessionIds}
                onSessionClick={handleSessionClick}
                onAction={handleActionClick}
                onRename={handleRename}
                onTogglePin={handleTogglePin}
                onMoveSession={handleMoveSession}
                projectOptions={projectPickerOptions}
                onScheduleAction={handleScheduleAction}
                onToggleProject={collapse.toggle}
                onToggleProjectPin={handleToggleProjectPin}
                onRenameProject={handleProjectAliasChange}
                onRemoveFromSidebar={handleRemoveProjectFromSidebar}
                onCollapseAll={collapse.collapseAll}
                onExpandAll={collapse.expandAll}
                onCreateProject={handleCreateProject}
                onCreateInProject={handleCreateInProject}
                onOpenConversationSearch={handleOpenConversationSearch}
                onOpenInExplorer={handleOpenInExplorer}
                onLinkCodexProject={handleLinkCodexProject}
                linkingCodexProject={linkingCodexProject}
                onBrowseFiles={handleBrowseFiles}
                onArchiveAll={handleArchiveAllInProject}
                remoteDeviceIndex={remoteDeviceIndex}
                onCreateDialogue={handleCreateDialogue}
                isCreateDialogueDisabled={dialogueCreatePending}
              />
            </>
          )}
          </div>
        </div>
      </div>

      {/* 空白处右键的整理菜单:与段头 sliders 按钮同一个组件、同一份内容,
          只是改用隐形定位 trigger 开在光标处(2026-08-12 用户裁决)。 */}
      <SidebarFilterPopover
        filter={filter}
        allKnownProjects={visibleProjectUniverse}
        dialogueCount={allGroups.dialogues.length}
        // 与段头实例同一门控:范围收窄到单台机器时「按设备分组」选项隐藏
        // (2026-08-13 用户定稿,详见 ProjectsSection.deviceGroupingAvailable)。
        hasRemoteDevices={deviceGroupingAvailable}
        contextMenuPos={organizeMenuPos}
        onContextMenuOpenChange={(open) => {
          if (!open) setOrganizeMenuPos(null);
        }}
      />

      {/* Delete / Archive confirm dialog */}
      <ConfirmDialog
        open={confirm.open}
        onOpenChange={(open) => {
          if (!open) handleCancelConfirm();
        }}
        title={
          confirm.action === 'delete'
            ? t('ccAgent.sidebar.confirmDelete.title')
            : t('ccAgent.sidebar.confirmArchive.title')
        }
        description={
          (confirm.action === 'delete'
            ? t('ccAgent.sidebar.confirmDelete.description')
            : t('ccAgent.sidebar.confirmArchive.description')) +
          (confirm.dirtyWorktree
            ? ' ' +
              (confirm.action === 'delete'
                ? t('ccAgent.sidebar.confirmDelete.dirtyWorktreeWarning')
                : t('ccAgent.sidebar.confirmArchive.dirtyWorktreeWarning'))
            : '')
        }
        confirmText={
          confirm.action === 'delete'
            ? t('ccAgent.sidebar.confirmDelete.confirm')
            : t('ccAgent.sidebar.confirmArchive.confirm')
        }
        cancelText={
          confirm.action === 'delete'
            ? t('ccAgent.sidebar.confirmDelete.cancel')
            : t('ccAgent.sidebar.confirmArchive.cancel')
        }
        onConfirm={handleConfirm}
        onCancel={handleCancelConfirm}
      />
      {/* 折叠 rail 的项目/对话二级面板 —— 瓷砖在 CollapsedView(RailNav),内容在
          本视图渲染(portal 不受隐藏 wrapper 影响):零复制复用展开态全套会话
          行为(hover 操作钮 / 右键菜单 / 重命名 / 移动 / schedule 操作 / 折叠上限
          与「显示全部」),见 railPanelStore 头注。 */}
      <RailPanels
        projects={visibleRailProjectsWithVendor}
        pinnedProjectKeys={pinnedProjectKeys}
        unclassified={railUnclassified}
        dialogues={railDialogues}
        activeSessionId={activeSessionId}
        viewedSessionId={viewedSessionId}
        runningSessionIds={displayRunningSessionIds}
        attachedSessionIds={attachedSessionIds}
        notifications={sidebarNotifications}
        scheduleSessionIndex={scheduleSessionIndex}
        selectedSessionIds={selectedSessionIds}
        onSessionClick={handleSessionClick}
        onAction={handleActionClick}
        onRename={handleRename}
        onTogglePin={handleTogglePin}
        onMoveSession={handleMoveSession}
        projectOptions={projectPickerOptions}
        onScheduleAction={handleScheduleAction}
        onCreateDialogue={handleCreateDialogue}
        isCreateDialogueDisabled={dialogueCreatePending}
        onCreateInProject={handleCreateInProject}
        onToggleProjectPin={handleToggleProjectPin}
        onRemoveProjectFromSidebar={handleRemoveProjectFromSidebar}
      />
      {deleteScheduleDialog}
    </>
  );
}

/* ============================== Collapsed ============================== */

interface CollapsedProps {
  navigate: ReturnType<typeof useNavigate>;
  onAutomationsContextMenu: (e: React.MouseEvent) => void;
  /** 全量项目(供 rail 搜索图标钮的 ConversationSearchBox 用)。 */
  allSearchProjects: ProjectNode[];
  searchableSessionIds: string[];
  hiddenProjectKeys: ReadonlySet<string>;
  /** rail 数据源——全量可见 sessions(本地 + 远程镜像合并),RailNav 内部切片。 */
  sessions: Session[];
  activeSessionId: string | undefined;
  /** 未读集 = attention 快照 ∪ 定时任务未读运行——段瓷砖/面板行角标依据。 */
  notifications: ReadonlySet<string>;
  /** 与展开态共用的置顶顺序(置顶面板同序)。 */
  manualPinnedOrder: readonly string[];
  /** 置顶瓷砖拖拽落定(写回 manualPinnedOrder,与展开态同一持久化语义)。 */
  onReorderPinned: (newOrderIds: string[]) => void;
}

/**
 * CollapsedView — 折叠态 64px rail(rail redesign v8:三段导航)。
 * 功能区(新建/搜索/自动化/插件)之下是「置顶 / 项目 / 对话」三段入口瓷砖
 * (RailNav):与展开态同构,hover 展开可交互二级面板(项目段再级联三级),
 * 段瓷砖聚合灯语(running 呼吸橙 / 最高优先级未读点)。见 sidebar/RailNav.tsx。
 */
function CollapsedView({
  navigate,
  onAutomationsContextMenu,
  allSearchProjects,
  searchableSessionIds,
  hiddenProjectKeys,
  sessions,
  activeSessionId,
  notifications,
  manualPinnedOrder,
  onReorderPinned,
}: CollapsedProps) {
  const isCollapsed = useSidebarCollapsedState();
  const projectFilterRequest = useConversationSearchRequest();
  const selectedMachineId = useEffectiveSelectedMachineId();
  const switcherDevices = useSwitcherDevices();
  const searchDevices = useMemo(
    () => searchDevicesFromSwitcher(switcherDevices),
    [switcherDevices],
  );
  const { t } = useTranslation();
  // 只读 running 快照——**不传 options**：通知副作用（onSessionDone 等）由
  // ExpandedView 的实例独家持有，两个视图常驻挂载，双回调会重复发桌面通知。
  const { runningSessionIds } = useSessionRunningStatus(activeSessionId);
  // 后台子任务活跃会话同样点亮呼吸(与 ExpandedView 同口径,纯视觉合并)。
  const backgroundActivitySessionIds = useBackgroundActivitySessionIds();
  const startingSessionIds = useStartingSessionIds(runningSessionIds);
  // 瓷砖未读点颜色按 attention kind(done 绿 / awaiting TapTap 蓝 / error 红);组件层
  // 取一次,renderItem 里查表(renderItem 非组件,不能 per-item 用 hook)。
  const attentionKinds = useSessionAttentionKinds();
  // 失败 automation urgency 集合 —— rail 瓷砖也要按此把 failed schedule 涂红,不能
  // 让"失败的定时任务"落到默认绿色 done tone(否则和 SessionItem 不一致,
  // 折叠视图会把失败误传成"完成了")。
  const urgentSet = useSessionAttentionUrgencySet();
  // delayed-create:与 ExpandedView 同——单按钮 navigate transient draft 单例。
  // 与展开态 SidebarTopNav 的通用「新建」同口径:只 navigate,不清空 newMakerDraft,
  // 保留用户上次在草稿页选好的「对话或选择项目」(切走再回来不重置);清空语义只属于
  // 「新建对话」等显式入口(handleCreateDialogue)。
  const handleNewCCS = useCallback(() => {
    navigate('/cc-agent/new', { state: makeNewMakerRouteState('generic') });
  }, [navigate]);
  const handleNavScheduled = useCallback(() => {
    navigate('/cc-agent/scheduled');
  }, [navigate]);
  const onScheduleMatch = useMatch('/cc-agent/scheduled');
  // 主视图切换(Plugin / Skill 管理)——与展开态 SidebarTopNav 的管理入口同源:
  // 命中 Plugin 或 Skill 视图时高亮。折叠 rail 之前漏了这颗按钮,现保持两态一致。
  const { activeKey, navigateToView } = useActiveMainView();
  // 插件未读聚合(badge 槽)——与展开态同源同语义。
  const hasGhostUnread = useAnyGhostUnread();

  // 接管中的会话(/ctr)——面板行沿用 SessionStatusIcon 的 RadioTower 表达。
  const attachedSessionIds = useAttachedSessionIds();

  // rail 运行集 = agent running ∪ 后台意识活动,再做 Orca lead 晋升(worker 在跑
  // → lead 点亮)——与展开态 displayRunningSessionIds 同口径。RailNav 会滤掉
  // worker 行、只聚合 lead,不晋升会出现「面板里 lead 在跑、段灯与置顶瓷砖
  // 却不亮」(codex review)。
  const orcaLeadWorkerMap = useOrcaLeadWorkerMap(sessions);
  const railRunningIds = useMemo(() => {
    const next = new Set([
      ...runningSessionIds,
      ...backgroundActivitySessionIds,
      ...startingSessionIds,
    ]);
    for (const [leadSessionId, workerSessionIds] of orcaLeadWorkerMap) {
      if (next.has(leadSessionId)) continue;
      for (const workerSessionId of workerSessionIds) {
        if (next.has(workerSessionId)) {
          next.add(leadSessionId);
          break;
        }
      }
    }
    return next;
  }, [runningSessionIds, backgroundActivitySessionIds, startingSessionIds, orcaLeadWorkerMap]);

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col items-center gap-[3px] overflow-y-auto px-2 pt-3 pb-2',
        // rail 太窄，原生 scrollbar 会吃掉瓷砖宽度——隐藏，滚动靠 wheel/trackpad
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
      )}
    >
      {/* rail 图标(新建/搜索/自动化)统一用 rail 配色,与展开态/Tabbar 同套 idle/hover/active。
          rail 保留圆钮形状(SIDEBAR_RAIL_ICON_BUTTON_CLASS),不引入自动隐藏托盘。 */}
      <SidebarIconButton
        icon={CirclePlus}
        label={t('ccAgent.layout.new')}
        variant="rail"
        onClick={handleNewCCS}
      />
      {/* 自动化 rail 入口 —— 仅导航,不再显示未读 dot(与展开态 SidebarTopNav 一致,
          未读 / 运行状态由展开后的各 schedule 组头承载)。 */}
      <SidebarIconButton
        icon={Timer}
        label={t('ccAgent.layout.automations')}
        aria-label={t('ccAgent.layout.automations')}
        aria-current={onScheduleMatch ? 'page' : undefined}
        variant="rail"
        active={Boolean(onScheduleMatch)}
        onClick={handleNavScheduled}
        onContextMenu={onAutomationsContextMenu}
      />
      {/* 插件 rail 入口 —— 未读绿点与展开态 SidebarTopNav 对称(同一聚合语义:
          任一插件有未读就点亮,静态不呼吸)。 */}
      <SidebarIconButton
        icon={Plug}
        label={t('sidebar.tabs.plugins')}
        variant="rail"
        active={activeKey === 'plugins'}
        aria-current={activeKey === 'plugins' ? 'page' : undefined}
        showDot={hasGhostUnread}
        onClick={() => navigateToView('plugins')}
      />
      <GhostPanelRestoreEntry
        variant="rail"
        className={SIDEBAR_RAIL_ICON_BUTTON_CLASS}
      />
      <ConversationSearchBox
        navigate={navigate}
        allKnownProjects={allSearchProjects}
        allowedSessionIds={searchableSessionIds}
        hiddenProjectKeys={hiddenProjectKeys}
        projectFilterRequest={isCollapsed ? projectFilterRequest : null}
        machineSelection={selectedMachineId}
        searchDevices={searchDevices}
        triggerClassName={SIDEBAR_RAIL_ICON_BUTTON_CLASS}
      />

      <div className="my-[7px] h-px w-[22px] shrink-0 bg-sidebar-border" aria-hidden />

      {/* 置顶 / 项目 / 对话 三段导航(hover 出可交互二级面板,项目段三级级联)。 */}
      <RailNav
        navigate={navigate}
        sessions={sessions}
        activeSessionId={activeSessionId}
        manualPinnedOrder={manualPinnedOrder}
        runningSessionIds={railRunningIds}
        notifications={notifications}
        attentionKinds={attentionKinds}
        urgentSessionIds={urgentSet}
        attachedSessionIds={attachedSessionIds}
        onReorderPinned={onReorderPinned}
      />
    </div>
  );
}

/* ============================== Rail Panels ============================== */

/** rail 面板的「视为内部」白名单:面板本体、rail 触发瓷砖、Radix popper
 *  (右键菜单/子菜单)与 dialog/alertdialog(确认弹窗——ConfirmDialog 用
 *  alertdialog role,漏掉会在弹窗内按下鼠标时误关底层面板,review P1)。 */
const RAIL_PANEL_KEEPALIVE_SELECTOR =
  '[data-rail-panel],[data-rail-panel-trigger],[data-radix-popper-content-wrapper],[role="dialog"],[role="alertdialog"]';

/** 三级(项目会话)面板专属的保活白名单:三级面板本体与可能源自其行内的
 *  菜单/对话框浮层。一级面板的非项目区(头部/未分类/「显示全部」)**不在**
 *  其中——指针移出项目行后 projectCloseTimer 要照常走完收三级面板,否则
 *  上一个项目的三级面板会悬留到 hover 下一个项目为止(review P2)。 */
const RAIL_PROJECT_KEEPALIVE_SELECTOR =
  '[data-rail-panel-level="2"],[data-radix-popper-content-wrapper],[role="dialog"],[role="alertdialog"]';

/** rail 面板容器:portal + fixed + 视口钳制。mouseleave 时若指针落入 Radix
 *  popper / 对话框(行内右键菜单、移动子菜单、确认弹窗)不视为离开。 */
function RailPanelShell({
  anchorRight,
  anchorTop,
  level,
  onEnter,
  onLeave,
  children,
}: {
  anchorRight: number;
  anchorTop: number;
  level: 1 | 2;
  onEnter: () => void;
  onLeave: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const desired = anchorTop - 6;
    setTop(Math.max(8, Math.min(desired, window.innerHeight - el.offsetHeight - 8)));
  }, [anchorTop, children]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-rail-panel="true"
      data-rail-panel-level={level}
      onMouseEnter={onEnter}
      onMouseLeave={(e) => {
        const next = e.relatedTarget instanceof Element ? e.relatedTarget : null;
        // 一级面板:落入面板体系内部(含三级/菜单)都不算离开;三级面板:只有
        // 落入自身或菜单/对话框浮层才不算——回到一级面板非项目区必须触发
        // onLeave 收三级,否则旧项目的三级面板悬留(codex review;项目行经
        // mouseenter → openProject 自会接管切换)。
        const keepalive =
          level === 1 ? RAIL_PANEL_KEEPALIVE_SELECTOR : RAIL_PROJECT_KEEPALIVE_SELECTOR;
        if (next?.closest(keepalive)) return;
        onLeave();
      }}
      className={cn(
        'fixed w-[264px] rounded-xl border border-sidebar-border bg-[var(--surface-elevated)] p-1.5',
        // 阴影走主题 token(AGENTS.md #16,与菜单同语言);z 必须低于 DropdownMenu
        // 的 z-50 —— 行内右键/移动菜单要画在面板之上(review P2)。
        'shadow-[var(--shadow-menu)]',
        level === 1 ? 'z-[48]' : 'z-[49]',
      )}
      style={{
        left: anchorRight + (level === 1 ? 12 : 8),
        top: top ?? anchorTop - 6,
        visibility: top === null ? 'hidden' : undefined,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

interface RailPanelsProps {
  projects: ProjectNode[];
  pinnedProjectKeys: ReadonlySet<string>;
  /** 未分类(草稿等)会话——展开态 UnclassifiedSection 同源,面板内平铺在项目列表之上。 */
  unclassified: Session[];
  dialogues: Session[];
  activeSessionId: string | undefined;
  /** 注视中的会话(files 路由下 activeSessionId 为 undefined 时兜底到被浏览
   *  文件的会话)——只用于折叠豁免与行高亮,导航语义(点击同会话早退等)仍
   *  由持有真实 activeSessionId 的 handler 闭包决定(codex review)。 */
  viewedSessionId: string | undefined;
  runningSessionIds: ReadonlySet<string>;
  attachedSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  scheduleSessionIndex: ReadonlyMap<string, AutomationScheduleSessionInfo>;
  selectedSessionIds?: ReadonlySet<string>;
  onSessionClick: Parameters<typeof SessionEntryList>[0]['onSessionClick'];
  onAction: Parameters<typeof SessionEntryList>[0]['onAction'];
  onRename: Parameters<typeof SessionEntryList>[0]['onRename'];
  onTogglePin: Parameters<typeof SessionEntryList>[0]['onTogglePin'];
  onMoveSession: Parameters<typeof SessionEntryList>[0]['onMoveSession'];
  projectOptions: Parameters<typeof SessionEntryList>[0]['projectOptions'];
  onScheduleAction: Parameters<typeof SessionEntryList>[0]['onScheduleAction'];
  /** 新建对话(对话面板头部 SquarePen)——展开态 DialogueSection 段头同源 handler。 */
  onCreateDialogue: () => void;
  isCreateDialogueDisabled: boolean;
  /** 在此项目内新建(项目行右键菜单 + 三级面板头部)——展开态 ProjectNode
   *  的 newInDirectory 主操作同源 handler(内置远程写保护)。 */
  onCreateInProject: (project: ProjectNode) => void;
  /** 折叠态项目菜单仍需提供置顶/取消置顶，避免置顶项目只能展开侧栏后管理。 */
  onToggleProjectPin: (project: ProjectNode, currentlyPinned: boolean) => void;
  /** 与展开态同源的本地项目侧栏移除动作。 */
  onRemoveProjectFromSidebar: (project: ProjectNode) => void;
}

/**
 * RailPanels — 折叠 rail「项目 / 对话」的二级(+项目三级)面板。
 * 由 ExpandedView 渲染以直连其全套会话 handler(见 railPanelStore 头注);
 * 会话行 = SessionEntryList 原装(SessionItem 全量行为 + 折叠上限 +
 * 「显示全部 N 项」页脚),与展开态零差异:
 *   - 对话面板:collapseLimit = getDialogueCollapseLimit()(默认 10,24h 活动豁免);
 *   - 项目内会话:collapseLimit = getProjectSessionCollapseLimit()(默认 5);
 *   - 项目列表:getProjectCollapseLimit()(默认 20)纯硬性上限 + 同款页脚。
 */
function RailPanels({
  projects,
  pinnedProjectKeys,
  unclassified,
  dialogues,
  activeSessionId,
  viewedSessionId,
  runningSessionIds,
  attachedSessionIds,
  notifications,
  scheduleSessionIndex,
  selectedSessionIds,
  onSessionClick,
  onAction,
  onRename,
  onTogglePin,
  onMoveSession,
  projectOptions,
  onScheduleAction,
  onCreateDialogue,
  isCreateDialogueDisabled,
  onCreateInProject,
  onToggleProjectPin,
  onRemoveProjectFromSidebar,
}: RailPanelsProps) {
  const { t } = useTranslation();
  const panelState = useSyncExternalStore(railPanelStore.subscribe, railPanelStore.getSnapshot);
  // 项目行右键菜单(「在此项目内新建」)——controlled DropdownMenu + 不可见
  // trigger 跟坐标(Automations 菜单同款模式)。
  const [projectMenu, setProjectMenu] = useState<{
    x: number;
    y: number;
    projectKey: string;
  } | null>(null);
  // 菜单关闭后把焦点还给唤起它的项目行:Radix 默认还焦到 trigger,但这里的
  // trigger 是零尺寸 aria-hidden span,不接管会让焦点掉到 document、打断
  // Shift+F10 之后的键盘导航(DESIGN.md §14.2 焦点回归契约;codex review)。
  const projectMenuAnchorRef = useRef<HTMLElement | null>(null);
  // 面板经 closeAll 路径(⌘B 隐藏/侧栏展开/触发器消失)关闭时不会走菜单的
  // onOpenChange —— openSection 离开 projects 就同步清掉菜单状态,否则组件常驻
  // (只是 return null),下次打开面板旧菜单会按旧坐标复现并引用旧项目(review)。
  // 与下方 showAllProjects 的复位同构。
  const attentionKinds = useSessionAttentionKinds();
  const urgentSet = useSessionAttentionUrgencySet();
  // 项目列表「显示全部」:面板关闭后复位(与 ProjectsSection 的段收起复位同语义)。
  const [showAllProjects, setShowAllProjects] = useState(false);
  useEffect(() => {
    if (panelState.openSection !== 'projects') {
      setShowAllProjects(false);
      setProjectMenu(null);
    }
  }, [panelState.openSection]);

  // 生命周期清理(review P1「Portal 面板跨视图残留」):
  // ① 折叠态解除(侧栏展开 / peek pin)→ 触发器消失,立即收面板;
  // ② 本组件卸载(离开 /cc-agent 域等;doc 模式下 ExpandedView 已改为隐藏
  //    挂载、不再卸载)→ 收面板,避免重挂载后按旧锚点复现;
  // ③ 面板打开期间全局 pointermove 兜底(useSidebarPeek 同款):指针落点不在
  //    白名单内 → 排收回,覆盖「rail 被 ⌘B 完全隐藏」等 mouseleave 收不到的路径。
  const isCollapsed = useSidebarCollapsedState();
  useEffect(() => {
    if (!isCollapsed) railPanelStore.closeAll();
  }, [isCollapsed]);
  useEffect(
    () => () => {
      railPanelStore.closeAll();
      railPanelStore.setLampScope(null);
    },
    [],
  );

  // 灯语取样范围发布:与面板实际展示的过滤后集合一致(项目组 + 未分类 + 对话),
  // RailNav 的段灯据此聚合(review P2「灯绕过筛选/截断」两条的根治)。
  useEffect(() => {
    railPanelStore.setLampScope({
      projectSessionIds: [
        ...projects.flatMap((p) => p.sessions.map((sess) => sess.id)),
        ...unclassified.map((sess) => sess.id),
      ],
      dialogueSessionIds: dialogues.map((sess) => sess.id),
    });
  }, [projects, unclassified, dialogues]);

  // 键盘打开(popover 焦点契约,DESIGN.md §14.2):焦点移入一级面板的首个
  // 可聚焦元素(对话面板=头部新建钮/项目面板=首行),Tab 不再穿越 portal 间隔
  // 的无关控件(codex review);关闭时还焦到触发瓷砖,键盘导航可继续。
  // 还焦前必须查**可见性**而非仅 isConnected:折叠/展开两视图常驻挂载,
  // 侧栏展开或 ⌘B 隐藏后 rail 瓷砖仍 connected 但 opacity-0 + pointer-events
  // -none,把焦点还给不可见元素会让键盘用户失联(codex review)。
  const focusIfVisible = (el: HTMLElement | null): void => {
    if (!el?.isConnected) return;
    if (
      typeof el.checkVisibility === 'function' &&
      !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    )
      return;
    el.focus();
  };
  const focusFirstIn = (selector: string): void => {
    document
      .querySelector(selector)
      ?.querySelector<HTMLElement>('button, [role="menuitem"], [tabindex]:not([tabindex="-1"])')
      ?.focus();
  };
  const keyboardFocusReturnRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!panelState.openedViaKeyboard || !panelState.openSection) return;
    keyboardFocusReturnRef.current = panelState.anchorEl;
    const raf = requestAnimationFrame(() => focusFirstIn('[data-rail-panel-level="1"]'));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelState.openedViaKeyboard, panelState.openSection]);
  useEffect(() => {
    if (panelState.openSection !== null) return;
    const returnTo = keyboardFocusReturnRef.current;
    keyboardFocusReturnRef.current = null;
    focusIfVisible(returnTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelState.openSection]);
  // 项目三级面板的同款契约(codex review:一级 effect 只观察 openSection,
  // 覆盖不到 openProjectKey):键盘展开 → 焦点入三级首个可聚焦;收起 → 还焦
  // 到展开它的项目行。
  const keyboardProjectReturnRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!panelState.projectOpenedViaKeyboard || !panelState.openProjectKey) return;
    const raf = requestAnimationFrame(() => focusFirstIn('[data-rail-panel-level="2"]'));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelState.projectOpenedViaKeyboard, panelState.openProjectKey]);
  useEffect(() => {
    if (panelState.openProjectKey !== null) return;
    const returnTo = keyboardProjectReturnRef.current;
    keyboardProjectReturnRef.current = null;
    focusIfVisible(returnTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelState.openProjectKey]);

  // 触发瓷砖可见性监测:⌘B 完全隐藏(aside w-0)、rail 滚出等任何"触发器
  // 消失"路径,即刻收面板——不依赖指针再动(review P1「键盘隐藏仍会残留」)。
  useEffect(() => {
    const el = panelState.anchorEl;
    if (!panelState.openSection || !el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting)) railPanelStore.closeAll();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [panelState.openSection, panelState.anchorEl]);
  useEffect(() => {
    if (!panelState.openSection) return;
    const onPointerMove = (event: PointerEvent) => {
      const el = event.target instanceof Element ? event.target : null;
      if (el?.closest(RAIL_PANEL_KEEPALIVE_SELECTOR)) {
        railPanelStore.cancelClose();
        // 三级计时器只对三级面板本体与菜单/对话框浮层保活(指针停在右键菜单上
        // 时,行 mouseleave 排下的 projectCloseTimer 不能收掉菜单的来源面板,
        // review P1);一级面板的非项目区不算——否则移出项目行后三级面板悬留
        // (review P2)。项目行自身经 mouseenter → openProject 清计时器。
        if (el.closest(RAIL_PROJECT_KEEPALIVE_SELECTOR)) {
          railPanelStore.cancelProjectClose();
        }
      } else {
        railPanelStore.scheduleClose();
      }
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, [panelState.openSection]);

  // Esc / 点击面板与瓷砖之外 → 关闭(Radix popper / 对话框视为面板内部)。
  useEffect(() => {
    if (!panelState.openSection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 行内重命名编辑中:Esc 归编辑器(取消编辑),不整面板收掉。
      if (panelHasEditingFocus()) return;
      // 有浮层挂载时:这一记 Esc 归浮层(Radix 自己会 dismiss),不能同帧把
      // 面板也收掉——否则触发行被卸载,还焦逻辑失效、焦点掉到 document
      // (codex review)。两路判定:菜单/子菜单看 popper 存在性(React 卸载
      // 发生在本事件处理之后,此刻必命中);ConfirmDialog 等弹窗看模态信号
      // (panelHasBlockingOverlay,copilot review)——不能按 role 全量匹配,
      // 否则 FindInPageBar 的常驻非模态 role="dialog" 会让 Esc 永远收不掉
      // 面板(#505 同款教训)。
      if (
        document.querySelector('[data-radix-popper-content-wrapper]') ||
        panelHasBlockingOverlay()
      )
        return;
      railPanelStore.closeAll();
    };
    const onDown = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest(RAIL_PANEL_KEEPALIVE_SELECTOR)) return;
      railPanelStore.closeAll();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [panelState.openSection]);

  // 行点击一律按普通导航处理:多选的范围剪枝按 sidebarScrollRef(展开态 DOM)
  // 计算,面板 portal 行不在其中,带修饰键会得到错误的选择集(review P2)——
  // 面板是导航面,多选留在展开态。点击**不**关面板:SessionItem 的双击重命名
  // 依赖「首击导航、行保持挂载、第二击早退、dblclick 进编辑」链路(见其头注),
  // 首击就 closeAll 会把行卸载、重命名永远进不去(codex review);面板由指针
  // 离开的 hover 宽限 / Esc / 外点自然收回,与展开态「点击不收侧栏」同语义。
  const handlePanelSessionClick = useCallback<NonNullable<RailPanelsProps['onSessionClick']>>(
    (id) => {
      onSessionClick(id);
    },
    [onSessionClick],
  );

  // 远程活动镜像整表版本号:项目行聚合灯 / 折叠豁免要跟上被控端 relay 推送。
  const remoteActivityRevision = useRemoteSessionActivityRevision();

  // 可见性口径的「当前会话」:files 路由下 activeSessionId 为 undefined,被浏览
  // 文件的会话若排在折叠上限外且无灯语会被折进「显示全部」(codex review)。
  // 只喂给折叠豁免(isActiveEntry)与行高亮;点击导航仍走真实 activeSessionId。
  const visibilityActiveId = activeSessionId ?? viewedSessionId;

  const projectAgg = useCallback(
    (list: readonly Session[]) => {
      let running = false;
      let best: 'error' | 'awaiting' | 'done' | null = null;
      const rank = { error: 3, awaiting: 2, done: 1 } as const;
      const consider = (tone: 'error' | 'awaiting' | 'done' | null) => {
        if (tone && (!best || rank[tone] > rank[best])) best = tone;
      };
      for (const s of list) {
        if (runningSessionIds.has(s.id)) running = true;
        // 远程会话灯语与 rail 段灯同源(remoteLampOf):本地 running/attention
        // 对被控端后台会话是盲区,不并入会出现「段灯亮、项目行不亮」(codex review)。
        const remote = remoteLampOf(s.id);
        if (remote) {
          if (remote.running) running = true;
          consider(remote.tone);
        }
        if (!notifications.has(s.id)) continue;
        const kind = attentionKinds.get(s.id);
        consider(
          kind === 'error' || urgentSet.has(s.id)
            ? 'error'
            : kind === 'awaiting'
              ? 'awaiting'
              : 'done',
        );
      }
      return { running, dotTone: best };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remoteActivityRevision 代表 remoteLampOf 读到的整表内容
    [runningSessionIds, notifications, attentionKinds, urgentSet, remoteActivityRevision],
  );

  // 面板未读集 = 本地 notifications ∪ 有远程活动条目的会话:折叠豁免
  // (getSessionListCollapseView / SessionEntryList 的 attention 豁免)只认这个
  // 集合,远程 error/awaiting/完成未读乃至 running 都只活在远程镜像里,不并入
  // 会出现「段灯点亮,面板却把该行折进显示全部」(codex review)。远程行的
  // 行内视觉由 SessionItem.remoteRightStatus 独立驱动,并集不会改变其展示。
  const panelNotifications = useMemo(() => {
    const remoteIds: string[] = [];
    const collect = (list: readonly Session[]) => {
      for (const s of list) if (remoteLampOf(s.id)) remoteIds.push(s.id);
    };
    collect(dialogues);
    collect(unclassified);
    for (const p of projects) collect(p.sessions);
    if (remoteIds.length === 0) return notifications;
    return new Set([...notifications, ...remoteIds]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remoteActivityRevision 代表 remoteLampOf 读到的整表内容
  }, [notifications, dialogues, unclassified, projects, remoteActivityRevision]);

  // 项目列表折叠:纯硬性上限(ProjectsSection 同口径,默认 20)+「显示全部 N 项」。
  const projectsView = useMemo(
    () =>
      getSessionListCollapseView({
        entries: projects,
        minVisibleCount: getProjectCollapseLimit(),
        showAll: showAllProjects,
        disableCollapse: false,
        isFiltering: false,
        isActiveEntry: (p) => p.sessions.some((s) => s.id === visibilityActiveId),
        // 豁免并入本地 running:第 20 名开外的项目若有会话在跑,rail 段灯已在
        // 呼吸,面板不能把它折进「显示全部」(codex review;远程 running 已随
        // panelNotifications 的远程条目并集覆盖)。
        hasAttentionEntry: (p) =>
          p.sessions.some((s) => panelNotifications.has(s.id) || runningSessionIds.has(s.id)),
      }),
    [projects, showAllProjects, visibilityActiveId, panelNotifications, runningSessionIds],
  );

  const entryListShared = {
    activeSessionId: visibilityActiveId,
    runningSessionIds,
    attachedSessionIds,
    notifications: panelNotifications,
    scheduleSessionIndex,
    selectedSessionIds,
    onSessionClick: handlePanelSessionClick,
    onAction,
    onRename,
    onTogglePin,
    onMoveSession,
    projectOptions,
    onScheduleAction,
  } as const;

  const panelHead = (title: string, count: number, action?: ReactNode) => (
    <div className="flex items-baseline gap-1.5 px-2.5 pb-1 pt-1.5">
      <span className="min-w-0 flex-1 truncate text-12 font-semibold text-foreground">{title}</span>
      <span className="shrink-0 text-10 text-[var(--text-tertiary)]">
        {t('ccAgent.sidebar.railNavCount', { count })}
      </span>
      {action}
    </div>
  );

  /** 面板头部的新建按钮(展开态段头 SquarePen 同款配色);创建动作导航去
   *  新建页,面板随之收起。disabled = 远程写保护(与展开态 ProjectAction
   *  同语义置灰,不收面板不丢上下文,codex review)。 */
  const panelHeadCreateButton = (
    actionLabel: string,
    onCreate: () => void,
    disabled = false,
    disabledReason?: string,
  ) => {
    const label =
      disabled && disabledReason ? `${actionLabel} — ${disabledReason}` : actionLabel;

    return (
      <Tip text={label} side="bottom">
        <span
          role={disabled ? 'button' : undefined}
          aria-disabled={disabled ? true : undefined}
          aria-label={disabled ? label : undefined}
          tabIndex={disabled ? 0 : undefined}
          className="inline-flex self-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <button
            type="button"
            aria-label={actionLabel}
            aria-hidden={disabled ? true : undefined}
            disabled={disabled}
            onClick={() => {
              railPanelStore.closeAll();
              onCreate();
            }}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md -my-1',
              'text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]',
              // globals.css 移除了 Chromium 默认 outline,键盘可达按钮必须自带
              // token 化 focus 环(DESIGN.md §10;codex review)。
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              'disabled:opacity-40 disabled:hover:text-[var(--text-tertiary)]',
            )}
          >
            <SquarePen size={14} strokeWidth={2} />
          </button>
        </span>
      </Tip>
    );
  };

  if (!panelState.openSection || !panelState.anchor) return null;

  const openProject =
    panelState.openSection === 'projects' && panelState.openProjectKey
      ? (projects.find((p) => p.projectKey === panelState.openProjectKey) ?? null)
      : null;

  return (
    <>
      <RailPanelShell
        anchorRight={panelState.anchor.right}
        anchorTop={panelState.anchor.top}
        level={1}
        onEnter={() => railPanelStore.cancelClose()}
        onLeave={() => railPanelStore.scheduleClose()}
      >
        {panelState.openSection === 'dialogues' && (
          <>
            {panelHead(
              t('ccAgent.sidebar.railNav.dialogues'),
              dialogues.length,
              panelHeadCreateButton(
                t('ccAgent.sidebar.newDialogue'),
                onCreateDialogue,
                isCreateDialogueDisabled,
                t('ccAgent.sidebar.creationInProgress'),
              ),
            )}
            <div className="max-h-[420px] overflow-y-auto [scrollbar-width:thin]">
              <SessionEntryList
                sessions={dialogues}
                {...entryListShared}
                collapsible
                collapseLimit={getDialogueCollapseLimit()}
              />
            </div>
          </>
        )}
        {panelState.openSection === 'projects' && (
          <>
            {panelHead(t('ccAgent.sidebar.railNav.projects'), projects.length)}
            <div className="max-h-[420px] overflow-y-auto [scrollbar-width:thin]">
              {/* 未分类(草稿等)会话:展开态渲染在项目树之前(UnclassifiedSection,
                  无标题纯列表),面板同形同序——折叠态不能让它们不可达(review P2)。 */}
              {unclassified.length > 0 && (
                <SessionEntryList
                  sessions={unclassified}
                  {...entryListShared}
                  collapsible
                  collapseLimit={getProjectSessionCollapseLimit()}
                />
              )}
              {projectsView.visibleEntries.map((p) => {
                const agg = projectAgg(p.sessions);
                const isOpen = panelState.openProjectKey === p.projectKey;
                const projectDisplayLabel = projectDisplayLabelWithMachine(p);
                return (
                  <button
                    key={p.projectKey}
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={isOpen}
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      railPanelStore.openProject(p.projectKey, {
                        right: rect.right,
                        top: rect.top,
                      });
                    }}
                    // 键盘可达:Tab 聚焦后 Enter/Space(原生 click)走与 hover
                    // 同一条 openProject 路径,否则三级面板只有鼠标能打开(codex review)。
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      // 键盘激活(detail===0)按 popover 契约展开三级并记录还焦行。
                      const viaKeyboard = e.detail === 0;
                      if (viaKeyboard) keyboardProjectReturnRef.current = e.currentTarget;
                      railPanelStore.openProject(
                        p.projectKey,
                        { right: rect.right, top: rect.top },
                        viaKeyboard,
                      );
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      projectMenuAnchorRef.current = e.currentTarget;
                      // 键盘唤起(Shift+F10/Menu 键)时浏览器报 clientX/Y=0,
                      // 菜单会飘到视口左上角——退回行矩形定位(codex review)。
                      const keyboardInvoked = e.clientX === 0 && e.clientY === 0;
                      const rect = e.currentTarget.getBoundingClientRect();
                      setProjectMenu({
                        x: keyboardInvoked ? rect.left + 12 : e.clientX,
                        y: keyboardInvoked ? rect.bottom - 2 : e.clientY,
                        projectKey: p.projectKey,
                      });
                    }}
                    onMouseLeave={() => railPanelStore.scheduleProjectClose()}
                    className={cn(
                      'flex h-8 w-full items-center gap-2 rounded-lg pl-2.5 pr-1.5 text-left',
                      isOpen ? 'bg-sidebar-item-hover' : 'hover:bg-sidebar-item-hover',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex shrink-0',
                        agg.running
                          ? 'text-[var(--status-bar-accent)] session-status-breathing'
                          : 'text-[var(--text-tertiary)]',
                      )}
                    >
                      <Folder size={13} strokeWidth={2} aria-hidden />
                    </span>
                    <span
                      title={projectDisplayLabel}
                      className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                    >
                      {projectDisplayLabel}
                    </span>
                    {agg.dotTone && (
                      <AttentionDot size={5} tone={agg.dotTone} className="shrink-0" />
                    )}
                    <span className="shrink-0 text-10 tabular-nums text-[var(--text-tertiary)]">
                      {p.sessions.length}
                    </span>
                    <ChevronRight
                      size={12}
                      strokeWidth={2}
                      className="shrink-0 text-[var(--text-tertiary)]"
                      aria-hidden
                    />
                  </button>
                );
              })}
              {projectsView.isOverflowing && (
                <button
                  type="button"
                  className={cn(
                    'flex h-6 w-full items-center justify-center rounded-full px-2 text-xs font-normal',
                    'text-[var(--cmd-palette-item-meta)] transition-colors hover:bg-sidebar-item-hover hover:text-foreground',
                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
                  )}
                  onClick={() => setShowAllProjects(true)}
                >
                  {t('ccAgent.sidebar.showAllSessions', { count: projectsView.totalCount })}
                </button>
              )}
            </div>
          </>
        )}
      </RailPanelShell>

      {openProject && panelState.projectAnchor && (
        <RailPanelShell
          anchorRight={panelState.projectAnchor.right}
          anchorTop={panelState.projectAnchor.top}
          level={2}
          onEnter={() => {
            railPanelStore.cancelClose();
            railPanelStore.cancelProjectClose();
          }}
          onLeave={() => {
            railPanelStore.scheduleProjectClose();
            railPanelStore.scheduleClose();
          }}
        >
          {panelHead(
            projectDisplayLabelWithMachine(openProject),
            openProject.sessions.length,
            panelHeadCreateButton(
              t('ccAgent.sidebar.projectAction.newInDirectory'),
              () => onCreateInProject(openProject),
              isDeviceLinkWriteBlocked(openProject),
              t('ccAgent.remoteSession.actionsUnavailable'),
            ),
          )}
          <div className="max-h-[420px] overflow-y-auto [scrollbar-width:thin]">
            {/* key 按项目:hover 直切另一项目时列表组件被复用,内部「显示全部」
                状态会泄漏给下一个项目、绕过折叠上限(codex review)——换 key 强制
                重挂载复位,与「面板关闭复位」同语义。 */}
            <SessionEntryList
              key={openProject.projectKey}
              sessions={openProject.sessions}
              {...entryListShared}
              collapsible
              collapseLimit={getProjectSessionCollapseLimit()}
            />
          </div>
        </RailPanelShell>
      )}

      {/* 项目行右键菜单 —— Automations 菜单同款「controlled + 坐标 trigger」;
          Radix 浮层在保活白名单内,阻断性浮层守卫保证面板不被 hover 宽限收掉。 */}
      <DropdownMenu
        open={projectMenu !== null}
        onOpenChange={(open) => {
          if (!open) setProjectMenu(null);
        }}
      >
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            style={{
              position: 'fixed',
              left: projectMenu?.x ?? 0,
              top: projectMenu?.y ?? 0,
              width: 0,
              height: 0,
              pointerEvents: 'none',
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={2}
          onCloseAutoFocus={(e) => {
            // 还焦到唤起菜单的项目行(而非零尺寸 trigger span)。行已被卸载
            // (面板关闭)时不抢焦点。
            e.preventDefault();
            const anchor = projectMenuAnchorRef.current;
            if (anchor?.isConnected) anchor.focus();
          }}
          className={cn(
            'min-w-[180px] rounded-xl p-1 overflow-hidden',
            'bg-[var(--cmd-palette-bg)]',
            'border border-[var(--cmd-palette-border)]',
            'shadow-[var(--shadow-menu)]',
          )}
        >
          {(() => {
            // 远程写保护项目:菜单项与展开态同语义禁用(codex review),不触发
            // closeAll 丢上下文。
            const menuTarget = projectMenu
              ? (projects.find((x) => x.projectKey === projectMenu.projectKey) ?? null)
              : null;
            const menuTargetBlocked = menuTarget != null && isDeviceLinkWriteBlocked(menuTarget);
            return (
              <>
                <DropdownMenuItem
                  disabled={menuTarget == null}
                  onSelect={() => {
                    setProjectMenu(null);
                    if (!menuTarget) return;
                    onToggleProjectPin(menuTarget, pinnedProjectKeys.has(menuTarget.projectKey));
                  }}
                  className="cursor-pointer text-sm text-[var(--msg-assistant-text)] hover:bg-[var(--cmd-palette-item-hover)]"
                >
                  {t(
                    menuTarget && pinnedProjectKeys.has(menuTarget.projectKey)
                      ? 'ccAgent.sidebar.projectAction.unpin'
                      : 'ccAgent.sidebar.projectAction.pin',
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={menuTarget == null || menuTargetBlocked}
                  onSelect={() => {
                    setProjectMenu(null);
                    if (!menuTarget || menuTargetBlocked) return;
                    railPanelStore.closeAll();
                    onCreateInProject(menuTarget);
                  }}
                  className="cursor-pointer text-sm text-[var(--msg-assistant-text)] hover:bg-[var(--cmd-palette-item-hover)]"
                >
                  {menuTargetBlocked
                    ? t('ccAgent.remoteSession.actionsUnavailable')
                    : t('ccAgent.sidebar.projectAction.newInDirectory')}
                </DropdownMenuItem>
                {menuTarget?.scope === 'local' && (
                  <>
                    <DropdownMenuSeparator className="my-1 h-px bg-[var(--cmd-palette-border)]" />
                    <DropdownMenuItem
                      onSelect={() => {
                        setProjectMenu(null);
                        onRemoveProjectFromSidebar(menuTarget);
                      }}
                      className="cursor-pointer text-sm text-[var(--msg-assistant-text)] hover:bg-[var(--cmd-palette-item-hover)]"
                    >
                      {t('ccAgent.sidebar.projectAction.removeFromSidebar')}
                    </DropdownMenuItem>
                  </>
                )}
              </>
            );
          })()}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
