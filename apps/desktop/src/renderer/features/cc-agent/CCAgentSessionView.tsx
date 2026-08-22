/**
 * CCAgentSessionView
 * ---------------------------------------------------------------------------
 * Session view for `/cc-agent/:sessionId`.
 *
 * 单一布局: MessageStream (空 / 有消息) + 底部 ChatInput + StatusBar。
 * 历史上曾有"空 session → NewChatView (logo + 居中输入框)"分支, 2026-05 已移除 ——
 * 实际命中场景几乎只有 draft route 跳转过程中的一两帧闪烁, 反而成了 UX 噪音;
 * 真正能创建 worktree session 的入口已经收敛到 NewMakerDraftRoute /cc-agent/new。
 *
 * F-CHAT-1: Message sending flow
 * F-SDK-3:  Running Status Bar data display
 * F-FP-5:   workingDir read-only display
 */

import {
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { dbToMakerAgentKind, normalizeDbAgentKind } from '../../../shared/agentKindConversion';
import { useTranslation } from 'react-i18next';
import {
  isCodexResumeNotReadyProjectionError,
  type AgentInputReference,
} from '@cindy/maker-shared/agent-input-projection';
import { connectedProvidersForAgent, providerOffersModel } from '@cindy/model-providers';
import type { SubagentRunsListResponse } from '@cindy/maker-shared/subagent-workspace';
import { useProportionalWidth } from '@/hooks/useProportionalWidth';
import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  Brain,
  Check,
  CornerUpLeft,
  Layers,
  Monitor,
  Sparkles,
  Square,
  X,
} from 'lucide-react';

import { cn, basename } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { setRemoteReceiptDisplayReady } from '@/lib/sessionAttentionStore';
import { shortSessionId } from '@/lib/sessionId';
import { ChatInput } from '@/components/new-chat/ChatInput';
import { GoalIndicator } from '@/components/new-chat/GoalIndicator';
import { PinnedPlanPanel } from '@/components/new-chat/PinnedPlanPanel';
import { sessionsStore } from '@/lib/sessionsStore';
import { useStopOrcaCollab } from './hooks/useStopOrcaCollab';
import { useWorkerProjection, useWorkerProjectionOwner } from './hooks/workerProjectionStore';
import { CreateWorkerPopover, type CreateWorkerForm } from './CreateWorkerPopover';
import { createWorkerLabel } from './workerLabel';
import { TakeoverMask } from '@/components/new-chat/TakeoverMask';
import { WorktreeCreatingOverlay } from '@/components/new-chat/WorktreeCreatingOverlay';
import { PermissionPrompt } from '@/components/new-chat/PermissionPrompt';
import { IssueConfirmCard } from './IssueConfirmCard';
import { RenameSessionsConfirmCard } from './RenameSessionsConfirmCard';
import { GhostGrantConfirmCard } from './GhostGrantConfirmCard';
import { AskUserQuestionPrompt } from '@/components/new-chat/AskUserQuestionPrompt';
import { PluginSetupPrompt } from '@/components/new-chat/PluginSetupPrompt';
import { PlanViewerCard } from '@/components/new-chat/PlanViewerCard';
import { PlanActionCard } from '@/components/new-chat/PlanActionCard';
import { InteractionPromptHost } from '@/components/interaction-portal';
import { MessageStream, type InlinePlanVisibility } from '@/components/chat/MessageStream';
import {
  readSendFollowCancelGeneration,
  tryRequestFollowLatest,
} from '@/components/chat/autoFollowIntent';
import { measureComposerStackTopOffset } from '@/components/chat/messageStreamIndicatorPosition';
import { ShareSelectionBar } from '@/components/chat/ShareSelectionBar';
import {
  shareSelectionStore,
  useShareSelectionActive,
} from '@/components/chat/shareSelectionStore';
import { ErrorBanner } from '@/components/chat/ErrorBanner';
import {
  ErrorTailErrorBanner,
  InterruptedTurnBanner,
} from '@/components/chat/InterruptedTurnBanner';
import { useBackgroundBashTasks } from '@/hooks/useBackgroundBashTasks';
import { useSessionBackgroundActivity } from '@/hooks/useSessionBackgroundActivity';
import { VendorIcon } from '@/components/sidebar/VendorIcon';
import {
  APP_EXIT_INTERRUPTED_REASON,
  CONTINUE_AFTER_APP_EXIT_PROMPT,
  CONTINUE_AFTER_ERROR_PROMPT,
} from '../../../shared/interruptedTurn';
import { CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON } from '../../../shared/claudeGatewayError';
import { refreshPendingAlerts } from '@/hooks/usePendingAlertAttention';
import { CredentialSwitchWaitBanner } from '@/components/chat/CredentialSwitchWaitBanner';
import { UpgradeBanner } from '@/components/chat/UpgradeBanner';
import { WorktreeRestoreBanner } from '@/components/chat/WorktreeRestoreBanner';
import { ConnectProviderBanner } from '@/components/onboarding/ConnectProviderBanner';
import { Tip } from '@/components/ui/tooltip';
import { useAnimatedNumber } from '@/hooks/useAnimatedNumber';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useSilentEncryptedRetry } from '@/hooks/useSilentEncryptedRetry';
import { TodaySpendChip } from '@/components/status/TodaySpendChip';
import { TopRightChipStack, TopRightChipStackProvider } from '@/components/chat/TopRightChipStack';
import { ChatDisplaySnapshotProvider } from '@/components/chat/ChatDisplaySnapshotContext';
import { useCCAgentChat } from '@/hooks/useCCAgentChat';
import { ackErrorAlertHandled } from '@/lib/errorAlertAck';
import { useAttachments } from '@/hooks/useAttachments';
import { useCCSessions } from '@/hooks/useCCSessions';
import { SessionContentHeaderRegistration } from './SessionContentHeader';
import { useSessionBinding } from '@/hooks/useSessionBinding';
import { useVendorAuthGate } from '@/hooks/useVendorAuthGate';
import { useProviders } from '@/hooks/useProviders';
import { useAuth } from '@/contexts/AuthContext';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { canAccessBillingSettings } from '@/components/settings/billingVisibility';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { useAgentCapabilities, resolveManualCompactChannel } from '@/hooks/useAgentCapabilities';
import { useLiveErrorSourceProvider } from '@/hooks/useLiveErrorSourceProvider';
import { resolveFastSupported } from '@/lib/providerModels';
import { useRemoteSessionSync } from '@/features/cc-agent/hooks/useRemoteSessionSync';
import {
  createSessionScopedRequestGuard,
  type SessionScopedRequestGuard,
} from './sessionScopedRequestGuard';
import {
  useDeviceLinkConnectionIssue,
  useRemoteSessionConnection,
} from '@/features/cc-agent/hooks/useRemoteSessionConnection';
import { useRemoteSessionLoading } from '@/features/cc-agent/hooks/useRemoteSessionLoading';
import { RemoteSessionBanner } from './RemoteSessionBanner';
import { decideRemoteSessionExit } from './remoteSessionExit';
import { RemoteSessionLoading } from './RemoteSessionLoading';
import {
  ControlledBanner,
  useComposerCollapsed,
  useControlledBy,
} from '@/features/remote-device/ControlledBanner';
import {
  loadAllCommands,
  dispatchCommand,
  leadingSlashInvocation,
  PI_RUNTIME_SKILL_RETRY_DELAYS_MS,
  rebaseInlineRangesAfterSlashCommandRewrite,
  reconcilePiRuntimeCommandForDispatch,
  reconcilePiRuntimeCommandForDispatchWithRetry,
  rewriteAgentSkillInvocationForDispatch,
  type UnifiedCommand,
} from '@/lib/slashCommands';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import * as sessionService from '@/lib/sessionService';
import { emitRefresh } from '@/lib/sessionsBus';
import type { Session } from '@/lib/ccAgent.types';
import { toast } from '@/lib/toast';
import {
  buildCreateOptsForCurrentSession,
  decodeRemoteErrorMessage,
  makerChatStore,
  type AgentTaskUpdate,
  type MessageDeliveryMode,
} from '@/lib/makerChatStore';
import { openBackgroundTasksTab } from '@/features/right-sidebar/lib/openBackgroundTasksTab';
import { openSubagentsTab } from '@/features/right-sidebar/lib/openSubagentsTab';
import { isCurrentSubagentRunsChange } from '@/features/right-sidebar/plugins/subagents/subagentChangeFence';
import { startSubagentTabDiscovery } from './subagentTabDiscovery';
import { subscribeChatTaskFocus } from '@/features/right-sidebar/plugins/background-tasks/chatTaskFocusIntent';
import { canFocusWithoutJumpLoad } from '@/lib/searchJumpTargeting';
import { getMakerMemoryEnabled } from '@/lib/memorySettingsStore';
import { useWorktreeCreation, worktreeCreationStore } from '@/lib/worktreeCreationStore';
import {
  composerWorkingDirPath,
  formatWorktreeChipText,
  useTaskInfoWorktree,
} from '@/features/cc-agent/sidebar/sessionWorktreeInfo';
import {
  getSessionRouteOwnerId,
  isOrcaLeadSession,
  isOrcaWorkerSession,
  resolveSessionRoute,
} from '@/lib/orcaSessionIdentity';
import type { Effort, PermissionMode } from '@/lib/userPreferences.types';
import type { AttachedFile, MentionedResource } from '@/lib/fileTypes';
import { serializeAttachedFiles } from '@/lib/messageAttachmentPayload';
import type { PastedTextRange, SlashCommandRange } from '@/lib/imageRef';
import { createLogger } from '@/lib/logger';
import { subscribeWorkLouderCodexAction } from '@/lib/workLouderCodexActions';
import {
  copyCurrentTaskMarkdown,
  forkCurrentTaskFromKeyboard,
} from '@/lib/workLouderCodexTaskActions';
import { useSessionHardwareTaskActions } from './lib/sessionHardwareTaskActions';
import { isRemoteSessionWriteBlocked } from './lib/remoteSessionWriteGuard';
import { getModelById, getDefaultModelForVendor, getModelsForVendor } from '@/lib/modelDefinitions';
import { resolveDisplayContextWindow } from '@/lib/contextWindow';
import { formatRunningTokenCount, resolveRunningUsageMeta } from './lib/runningTokenUsage';
import { matchNavigationCommandName, tryHandleNavigationCommand } from '@/lib/navigationCommands';
import { extractIpcError } from '@/utils/ipcError';
import { listActiveRunsForSession } from '@/features/learn/useLearnRun';
import { subscribeLearnEvents } from '@/features/learn/learnTransport';
import { getUserPrompt } from '@/lib/userPromptStore';
import { makerApiForSticky } from '@/lib/makerTransport';
import {
  consumePending,
  consumePendingGoal,
  deliverRecoverableHandoff,
  takeRecoverableHandoff,
  type RecoverableHandoffKind,
} from '@/state/pendingFirstMessage';
import {
  saveDraft as saveComposerDraft,
  getDraftPresence as getComposerDraftPresence,
  plainTextToTiptapDoc,
  restoreRemoteOptimisticDraft,
} from '@/lib/composerDraftStore';
import { setLastWorkingDir } from '@/state/lastWorkingDir';
import { consumeComposerMentionDrop } from '@/lib/composerDrop';
import { hasSplitGroupSessionType } from './splitGroupDnd';
import { splitGroupStore } from './splitGroupStore';
import {
  attachGhostMediaToSession,
  getGhostMediaUriFromDataTransfer,
} from '@/cindy-brain/ghostMediaHandover';
import { isGlobalDropIntercepted } from '@/lib/globalDropIntercept';
import {
  classifyUnclassifiedDroppedItems,
  getDroppedFileItems,
  type DroppedFileItems,
} from '@/lib/fileDrop';
import { getCollaborationStartErrorMessage } from './collaborationErrors';
import { useCollabProjectPolicy } from './hooks/useCollabProjectPolicy';
import { resolveCollabEntryPolicy } from './collabEntryPolicy';
import { consumePendingRemoteCollab, enableRemoteCollabForSession } from './remoteCollabHandoff';
import {
  dispatchDeferredUiAssignment,
  getRecoverableDeferredUiAssignment,
  type DeferredUiAssignment,
} from './deferredUiAssignment';
import { shouldFallbackVendorModel } from './lib/vendorModelFallback';
import { localizeAgentStatus } from './lib/localizeAgentStatus';
import { createSessionRefreshSequence } from './lib/sessionRefreshSequence';
import { createSessionSnapshotPatchBuffer } from './lib/sessionSnapshotPatchBuffer';
import { readPanelCollapsedRecord } from '@/layout/collapsePrefs';
import {
  normalizeOrcaDisplayAgentKind,
  orcaAgentLabel,
  orcaVendorForAgentKind,
} from './lib/orcaAgentDisplay';
import {
  shouldRevealOrcaWorkersAfterPaint,
  shouldRevealOrcaWorkersBeforeFirstPaint,
} from './lib/orcaPassiveReveal';
import { didOpenOrcaWorkersTab, revealOrcaWorkersWithRetry } from './lib/orcaWorkersRevealRetry';
import { usageLimitScheduleNavigationState } from '@/features/scheduler/lib/usageLimitScheduleCreateIntent';
import {
  closeOrcaWorkersTabAfterTeamEnd,
  ensureOrcaWorkersTab,
  revealOrcaWorkersTab,
} from '@/features/right-sidebar/plugins/orca-workers/actions';
// device-link 跨设备远程控制:远程会话的元数据来自 remoteProjectsStore(本地 DB 没有)。
import {
  useRemoteProjectSessions,
  getSessionDeviceId,
  remoteProjectsStore,
} from '@/features/device-link/remoteProjectsStore';
import {
  isRemoteSessionActivityActive,
  useRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';
import {
  makeMirrorAccessors,
  replaceScope,
  clearScope,
  type RemoteModelMemorySnapshot,
} from '@/state/deviceLinkModelMirror';
import type { ModelMemoryAccessors } from '@/components/new-chat/ModelSelector';
// 完整对等:context-usage / extra-dirs / orca 等会话级操作按 sessionId 来源路由
// (本机走本地 maker,远程 device-link 会话走隧道)。
import {
  ackInterruptedTurnFor,
  goalApiFor,
  makerApiFor,
  orcaWorkflowsFor,
} from '@/lib/makerTransport';
// 协同 mutation 的归属取粘滞值:瞬断窗口内误判本机会在控制端建出/销毁 team,
// 而入口本身是按粘滞 remoteDeviceId 渲染的。
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
// fork / orca 在被控端建新 session 后,navigate 前先把该设备会话列表重拉进 store(避免 404 破窗)。
import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';
import {
  SessionNavigationModeProvider,
  type SessionNavigationIntentReporter,
  type SessionNavigationMode,
} from './embeddedSessionNavigation';
import {
  parseConversationSearchJump,
  type ConversationSearchJump,
} from '../../../shared/conversationSearchJump';

const log = createLogger('CCAgentSessionView');
/**
 * 子代理页签只登记、不抢占。
 *
 * 子代理在对话流里已经有自己的卡片,右栏再自动弹出会把同一件事讲两遍,还会抢走
 * 用户当时正在看的东西。入口保持可发现即可,展开留给用户点卡片或点右栏开关。
 * 两条登记路径(历史挂载 / 首个实时子代理)共用这一份参数,避免其中一条被单独改回
 * 自动展开。
 */
const SUBAGENT_TAB_REGISTER_ONLY = {
  focusTab: false,
  revealSidebar: false,
  userInitiated: false,
} as const;
// perf-baseline(与 MessageStream / sidebar 的 perf/session-switch 探针同通道):
// stream:profile 记录 MessageStream 子树每次 ≥50ms 的 React commit(phase +
// actualDuration),与 perf/interaction 的 longtask 时长对齐即可判定长任务
// 是消耗在 React 渲染内还是渲染外(store 监听器 / 布局等)。
const perfLog = createLogger('perf/session-switch');
const onStreamProfile = (
  _id: string,
  phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number,
): void => {
  if (actualDuration >= 50) {
    perfLog.debug(`stream:profile phase=${phase} actual=${Math.round(actualDuration)}ms`);
  }
};

interface HandoffFromState {
  kind: 'handoff';
  dispatcherSessionId: string;
  dispatcherTitle?: string | null;
}

interface OrcaWorkersRevealState {
  leadSessionId: string | null;
  focusWorkerSessionId: string | null;
}

function parseHandoffState(state: unknown): HandoffFromState | null {
  if (!state || typeof state !== 'object') return null;
  const from = (state as { from?: unknown }).from;
  if (!from || typeof from !== 'object') return null;
  const candidate = from as {
    kind?: unknown;
    dispatcherSessionId?: unknown;
    dispatcherTitle?: unknown;
  };
  if (candidate.kind !== 'handoff') return null;
  if (typeof candidate.dispatcherSessionId !== 'string' || !candidate.dispatcherSessionId) {
    return null;
  }
  return {
    kind: 'handoff',
    dispatcherSessionId: candidate.dispatcherSessionId,
    dispatcherTitle:
      typeof candidate.dispatcherTitle === 'string' ? candidate.dispatcherTitle : null,
  };
}

function parseSearchJumpState(state: unknown): ConversationSearchJump | null {
  if (!state || typeof state !== 'object') return null;
  return parseConversationSearchJump((state as { searchJump?: unknown }).searchJump);
}

function parseOrcaWorkersRevealState(state: unknown): OrcaWorkersRevealState | null {
  if (!state || typeof state !== 'object') return null;
  const candidate = (state as { orcaWorkersReveal?: unknown }).orcaWorkersReveal;
  if (!candidate || typeof candidate !== 'object') return null;
  const focusWorkerSessionId = (candidate as { focusWorkerSessionId?: unknown })
    .focusWorkerSessionId;
  const leadSessionId = (candidate as { leadSessionId?: unknown }).leadSessionId;
  return {
    leadSessionId: typeof leadSessionId === 'string' && leadSessionId ? leadSessionId : null,
    focusWorkerSessionId:
      typeof focusWorkerSessionId === 'string' && focusWorkerSessionId
        ? focusWorkerSessionId
        : null,
  };
}

interface CCAgentSessionViewProps {
  sessionIdProp?: string;
  /**
   * 显式声明内嵌实例是否接管当前窗口路由的 header / 右栏主权。默认不传时沿用
   * 历史判据：只有无 sessionIdProp 的全屏路由实例拥有主权。SplitGroup 用它在
   * 多个常驻会话 pane 之间转移主权，避免切活动 pane 时卸载重挂聊天视图。
   */
  routeOwner?: boolean;
  compact?: boolean;
  orcaMode?: boolean;
  /** 在输入区显示被控端提示。普通路由自动显示；完整态居中，折叠态位于 token 左侧。 */
  showControlledBanner?: boolean;
  /**
   * 工具行采用紧凑布局 (flex-wrap 兜底)。
   * 之前从 orcaMode 派生 — 但 OrcaSplitView 的 toggle layout 下 pane 是满宽的,
   * 不需要 wrap;只有真正分屏 (split layout) 才需要。所以独立成 prop,
   * 由 OrcaSplitView 按 layout 决定是否传 true,与 orcaMode (路由/可见性语义)
   * 解耦。
   */
  compactToolbar?: boolean;
  /**
   * 在非 ownsRoute 实例中也显示右栏开关按钮(Windows)。
   * 由 OrcaSplitView 传给 lead 实例,解决协同模式下 ownsRoute=false 导致
   * RSB toggle 不显示的问题。Mac 端由 MainLayout 浮层处理,不受此影响。
   */
  showRsbToggle?: boolean;
  /**
   * 本视图当前是否真实可见(挂载 ≠ 可见)。workdir 文件页的聊天 rail 折叠时
   * 视图仍挂载但宽度为 0。默认 true。
   * 注:红点不再依赖它 —— 展示与否都不影响「告警未处理」的判定(2026-07 统一);
   * 仍用于远程回执的 display-ready 门槛与其它按可见性收敛的逻辑。
   */
  viewVisible?: boolean;
  /**
   * 重型聊天流是否实时消费 makerChatStore snapshot。隐藏的 Orca worker pane
   * 仍 keep-alive，但这里传 false 避免每批 text delta 触发 Markdown/MessageStream。
   */
  chatRealtime?: boolean;
  /** RSB 协同 tab 注入的消息定位意图；detached 子窗不能依赖主窗 location.state。 */
  searchJumpProp?: ConversationSearchJump | null;
  onSearchJumpConsumed?: () => void;
  /** sidebar 子窗口内嵌视图不拥有 router，所有“打开其它会话”入口必须禁用。 */
  navigationMode?: SessionNavigationMode;
  /** split-pane 内部跳转前上报目标任务，让宿主替换发起跳转的 pane。 */
  onSessionNavigate?: SessionNavigationIntentReporter;
  /** 内嵌聊天触发侧栏动作时使用的可见 RSB bucket；消息身份仍由 sessionIdProp 决定。 */
  sidebarTargetSessionId?: string;
  /** 禁止该常驻视图在挂载时抢占键盘焦点（例如非 owner 的分屏 pane）。 */
  disableAutofocus?: boolean;
}

/**
 * 右栏「在场」声明器 —— 仅由「拥有当前路由的全屏聊天视图」条件挂载（见 ownsRoute
 * 判据，语义与 SessionContentHeaderRegistration 完全对称）。挂载 → 声明右栏在场，
 * MainLayout 渲染右栏面板；卸载（切走 / 退化成内嵌实例）→ 撤销在场，面板卸载，
 * 不会在 doc 模式等界面卡在展开态且无入口关闭。
 *
 * 为什么用条件挂载组件而非在 CCAgentSessionView 里无条件跑 effect：
 * CCAgentSessionView 会被多处内嵌复用（doc rail / 协同 worker 面板），无条件跑会
 * 让内嵌实例反复 true/false 抖动、或在内嵌实例上误声明在场。条件渲染本组件 =
 * 条件执行声明，卸载时自动撤销。用 useLayoutEffect 与槽位注册（feature-context）
 * 同步阶段语义一致，避免一帧闪烁。
 */
function RightSidebarAvailabilityRegistration({
  declare,
}: {
  declare: (available: boolean) => void;
}) {
  useLayoutEffect(() => {
    declare(true);
    return () => declare(false);
  }, [declare]);
  return null;
}

/**
 * 推当前 sessionId 给 MainLayout(Shell 据此从 store 拉对应桶持久化 tab 列表)。
 * 与 RightSidebarAvailabilityRegistration 同条件挂(ownsRoute 主实例),unmount 时
 * 推 null 让 Shell 退回空状态;sessionId 变化时 effect 重跑 declare 新值。
 */
function RightSidebarSessionIdRegistration({
  sessionId,
  subagentsAvailable,
  initialCollapsed,
  writeInitialCollapsedRecord = false,
  declare,
}: {
  sessionId: string;
  subagentsAvailable?: boolean;
  initialCollapsed?: boolean;
  writeInitialCollapsedRecord?: boolean;
  declare: (
    sessionId: string | null,
    opts?: {
      initialCollapsed?: boolean;
      writeInitialCollapsedRecord?: boolean;
      subagentsAvailable?: boolean;
    },
  ) => void;
}) {
  useLayoutEffect(() => {
    declare(sessionId, { initialCollapsed, writeInitialCollapsedRecord, subagentsAvailable });
    return () => declare(null);
  }, [sessionId, subagentsAvailable, initialCollapsed, writeInitialCollapsedRecord, declare]);
  return null;
}

/**
 * 同 RightSidebarSessionIdRegistration 形态;推当前 session 的 workingDir 给 MainLayout,
 * Shell 注入 plugin ctx,file-browser plugin 据此驱动文件树 / 内容预览。
 * workdir 为空(remote session / 刚加载尚未解析)时推空串,plugin 自己判断渲染占位。
 */
function RightSidebarWorkdirRegistration({
  workdir,
  remoteHostId,
  deviceLinkDeviceId,
  declare,
}: {
  workdir: string;
  /** 非空 = SSH remote 会话(workdir 为远端路径);plugin 据此走远端 file-service。 */
  remoteHostId: string | null;
  /** device-link 会话归属：null = 已确认本机，undefined = 尚未解析。 */
  deviceLinkDeviceId?: string | null;
  declare: (
    workdir: string,
    remoteHostId?: string | null,
    deviceLinkDeviceId?: string | null,
  ) => void;
}) {
  useLayoutEffect(() => {
    declare(workdir, remoteHostId, deviceLinkDeviceId);
    return () => declare('', null, undefined);
  }, [workdir, remoteHostId, deviceLinkDeviceId, declare]);
  return null;
}

/**
 * /workflows:从任务表挑最近的 local_workflow 任务。taskUpdates 里同一任务按
 * taskId / parentToolUseId 存多个别名键(指向同一 merged 对象),先按引用去重,
 * 再取 updatedAt/createdAt 最新的一个;时间缺失按 0 参与比较(平局取遍历靠后者)。
 */
function findLatestWorkflowTask(
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate>,
): AgentTaskUpdate | undefined {
  let latest: AgentTaskUpdate | undefined;
  let latestTs = Number.NEGATIVE_INFINITY;
  const seen = new Set<AgentTaskUpdate>();
  for (const update of taskUpdates.values()) {
    if (update.taskType !== 'local_workflow' || seen.has(update)) continue;
    seen.add(update);
    const raw = update.updatedAt ?? update.createdAt;
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    const ts = Number.isFinite(parsed) ? parsed : 0;
    if (ts >= latestTs) {
      latest = update;
      latestTs = ts;
    }
  }
  return latest;
}

export function CCAgentSessionView({
  sessionIdProp,
  routeOwner,
  compact,
  orcaMode,
  showControlledBanner = false,
  compactToolbar = false,
  showRsbToggle = false,
  viewVisible = true,
  chatRealtime = true,
  searchJumpProp,
  onSearchJumpConsumed,
  navigationMode = 'route-owner',
  onSessionNavigate,
  sidebarTargetSessionId,
  disableAutofocus = false,
}: CCAgentSessionViewProps = {}) {
  const { t } = useTranslation();
  const { sessionId: paramSessionId } = useParams<{ sessionId: string }>();
  const sessionId = sessionIdProp ?? paramSessionId;
  const navigate = useNavigate();
  const ownsWindowRoute = navigationMode === 'route-owner';
  const canNavigateSession = ownsWindowRoute || navigationMode === 'split-pane';
  const sessionNavigationVersionRef = useRef(0);
  useEffect(
    () => () => {
      sessionNavigationVersionRef.current += 1;
    },
    [navigationMode, sessionId],
  );
  const location = useLocation();
  useEffect(() => {
    return window.electronAPI.ghosts.onSetupNavigate((payload) => {
      // The session view owns the card even when it is embedded in a workdir
      // rail or Orca worker pane. Route parsing cannot identify those surfaces.
      if (!viewVisible || !sessionId || payload.sessionId !== sessionId) return;
      if (payload.target === 'plugin_settings') {
        navigate(`/plugins?ghost=${encodeURIComponent(payload.ghostId)}`);
        return;
      }
      navigate('/settings?tab=providers');
    });
  }, [navigate, sessionId, viewVisible]);

  // MainLayout 经 Outlet context 下发右栏相关能力(二级路由由 CCAgentFeatureLayout
  // 透传,否则这里会断链拿不到):
  //   - rightSidebarCollapsed:折叠态,用于 useProportionalWidth 的 compact 判定;
  //     真无 Outlet 祖先时兜底 true(折叠态)。
  //   - onToggleRightSidebar:右栏开关点击回调(切换折叠 + 展开时设宽=主区域一半)。
  //   - setRightSidebarAvailable:声明右栏「在场」——只有路由主实例(全屏聊天视图)
  //     该声明,MainLayout 据此渲染右栏面板。
  // 嵌入实例(OrcaSplitView / workdir-browse rail)经同一条透传链读到这些值,但因
  // 下方 ownsRoute 判据为 false,既不渲染开关也不声明在场。
  const outletContext = useOutletContext<{
    rightSidebarCollapsed?: boolean;
    onToggleRightSidebar?: () => void;
    rightSidebarSide?: 'left' | 'right';
    setRightSidebarAvailable?: (available: boolean) => void;
    setRightSidebarSessionId?: (
      sessionId: string | null,
      opts?: { initialCollapsed?: boolean; writeInitialCollapsedRecord?: boolean },
    ) => void;
    setRightSidebarWorkdir?: (
      workdir: string,
      remoteHostId?: string | null,
      deviceLinkDeviceId?: string | null,
    ) => void;
  } | null>();
  const rightSidebarCollapsed = outletContext?.rightSidebarCollapsed ?? true;
  const rightSidebarSide = outletContext?.rightSidebarSide ?? 'right';
  const setRightSidebarAvailable = outletContext?.setRightSidebarAvailable;
  const setRightSidebarSessionId = outletContext?.setRightSidebarSessionId;
  const setRightSidebarWorkdir = outletContext?.setRightSidebarWorkdir;
  const { enabled: silentEncryptedRetryEnabled } = useSilentEncryptedRetry();
  const [forkStripEncryptedRunning, setForkStripEncryptedRunning] = useState(false);
  // 从 Automations 的 RunHistoryCard 跳过来的 navigate 会带 state.from='automations'，
  // 在聊天区左上角显示一个返回按钮；点别的 session 入口（不带 state）时按钮自然消失。
  const navState = location.state as { from?: string } | null;
  const cameFromAutomations = navState?.from === 'automations';
  const handoffFrom = useMemo(() => parseHandoffState(location.state), [location.state]);
  const locationSearchJump = useMemo(() => parseSearchJumpState(location.state), [location.state]);
  const searchJump = searchJumpProp !== undefined ? searchJumpProp : locationSearchJump;
  const orcaWorkersReveal = useMemo(() => {
    const reveal = parseOrcaWorkersRevealState(location.state);
    return reveal?.leadSessionId && reveal.leadSessionId !== sessionId ? null : reveal;
  }, [location.state, sessionId]);
  const [focusedMessageTarget, setFocusedMessageTarget] = useState<{
    clientId: string;
    requestId: number;
  } | null>(null);
  const requestFocusMessage = useCallback((clientId: string) => {
    setFocusedMessageTarget((current) => ({
      clientId,
      requestId: (current?.requestId ?? 0) + 1,
    }));
  }, []);
  const clearSearchJumpState = useCallback(() => {
    if (searchJumpProp !== undefined) {
      onSearchJumpConsumed?.();
      return;
    }
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: {
        ...((location.state as Record<string, unknown> | null) ?? {}),
        searchJump: undefined,
      },
    });
  }, [
    location.pathname,
    location.search,
    location.state,
    navigate,
    onSearchJumpConsumed,
    searchJumpProp,
  ]);
  const [handoffPillDismissed, setHandoffPillDismissed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId 是会话切换重置触发器。
  useEffect(() => {
    setHandoffPillDismissed(false);
    setFocusedMessageTarget(null);
  }, [sessionId]);
  // workdir-browse 模式 (右侧 chat rail) 用 compact: true,padding 收到 10/0,
  // 让窄 rail 里的消息和输入框尽量铺满。
  const isCompactRail = compact ?? location.pathname.startsWith('/cc-agent/files/');
  const isOrcaMode = orcaMode ?? location.pathname.startsWith('/cc-agent/orca/');
  // 路由主实例判据(与 SessionContentHeaderRegistration 同款):默认只有全屏路由
  // 实例拥有右栏 / header 主权。SplitGroup 的常驻 pane 可用 routeOwner 显式转移
  // 主权；其它内嵌复用实例(doc rail / Orca worker)不传，行为保持不变。
  const ownsRoute = routeOwner ?? (!sessionIdProp && !isCompactRail && !isOrcaMode);
  // Header/right-sidebar ownership is narrower than hardware task actions.
  // A visible file-browse rail is still the open task, even when it is compact.
  // Split panes stay mounted together; only the route-owning pane may consume
  // hardware commands. The compact files rail is not a split pane.
  const ownsHardwareTaskActions =
    ownsRoute ||
    (Boolean(sessionId) &&
      viewVisible &&
      navigationMode !== 'sidebar-embedded' &&
      navigationMode !== 'split-pane');
  const showComposerControlledBanner = ownsRoute || showControlledBanner;
  const controlledBy = useControlledBy();
  const hasControlledBanner = showComposerControlledBanner && controlledBy.length > 0;
  const controlledBannerCollapsed = useComposerCollapsed(sessionId ?? null);
  const showExpandedControlledBanner = hasControlledBanner && !controlledBannerCollapsed;
  const isMac = window.electronAPI?.platform === 'darwin';
  // messageWidth：消息流容器宽度（视觉边距 50px / compact 20px）
  // inputWidth：ChatInput / 状态栏 / workingDir 行的宽度（视觉边距 40px / compact 10px）
  // doc rail 内嵌场景(isCompactRail)恒 compact;主会话不显式传 compact,由 hook
  // 自身按实测容器宽 `< AUTO_COMPACT_THRESHOLD`(700px)自动切 compact——右栏打开
  // 把主区压到阈值之下时, padding 50→20 平滑收紧,不臃肿。
  // 历史 caveat(已不再适用):早期尝试过按 `rightSidebarCollapsed` 布尔即时切 compact,
  // 右栏 250ms transition 期间 parent 还是 stale 宽度,messageWidth 先扩出去顶过
  // parent → mx-auto 失效 → padding 被压成 0 → 视觉上消息"先顶到最左再缩回来"。
  // 现在的方案由 hook 内 ResizeObserver 直接更新继承 CSS 宽度变量；React 只在
  // compact 阈值跨越时切换一次。这里继续只传 isCompactRail,不要再叠
  // rightSidebarCollapsed 进来。
  const {
    containerRef,
    messageWidth,
    inputWidth,
    inputPad,
    inputHalfWidth,
    isCompact,
    getMessageWidth,
  } = useProportionalWidth(914, { compact: isCompactRail });
  const controlledBannerMaxWidth = `min(${inputHalfWidth}, ${CONTROLLED_BANNER_MAX_WIDTH}px)`;
  const { sessions: allSessions, refreshSessions, patchLocal: patchLocalSession } = useCCSessions();
  // /ctr 接管态: attached=true 时把 ChatInput 替换为 TakeoverMask, 防止 desktop
  // 用户跟 IM 端 race; permission/ask/plan 三个 prompt 不替换 — 它们是 SDK 反向触
  // 发, 飞书那边的 setInteractionListener 会接管, 这里渲染保持兜底视觉一致
  // (实际接管期间 desktop renderer 收不到 INTERACTION_REQUEST 广播)。
  const sessionBinding = useSessionBinding(sessionId);

  // ---------------------------------------------------------------------------
  // Session data: always fetch from server on sessionId change (requirement 1).
  // sessionFromList provides instant rendering from cache while server responds.
  // ---------------------------------------------------------------------------
  const [serverSession, setServerSession] = useState<Session | null>(null);
  const [, bumpSessionPatchVersion] = useState(0);
  const sessionRefreshSequenceRef = useRef(createSessionRefreshSequence());
  const sessionSnapshotPatchBufferRef = useRef(createSessionSnapshotPatchBuffer<Session>());
  // commit 阶段同步切 scope：中断 render 不得提前丢弃旧 session 的在途状态；layout effect
  // 又会先于 fetch / push 的 passive effect 执行，旧异步闭包在新视图提交后仍无法污染它。
  useLayoutEffect(() => {
    sessionRefreshSequenceRef.current.setSession(sessionId ?? null);
    sessionSnapshotPatchBufferRef.current.setSession(sessionId ?? null);
  }, [sessionId]);
  // device-link:远程会话不在本地 DB(allSessions),从 remoteProjectsStore 找;该 store
  // 响应式,远程元数据(model/title 等)随 listing/push 刷新自动更新。
  const remoteProjectSessions = useRemoteProjectSessions();
  const sessionFromList = sessionId
    ? (allSessions.find((s) => s.id === sessionId) ??
      remoteProjectSessions.find((s) => s.id === sessionId) ??
      null)
    : null;
  // 切 session 后 effect 才清 state；同步按 id 过滤，避免旧 serverSession 污染新视图或作为 patch base。
  const currentServerSession = serverSession?.id === sessionId ? serverSession : null;
  const currentServerSessionRef = useRef<Session | null>(null);
  useLayoutEffect(() => {
    currentServerSessionRef.current = currentServerSession;
    if (currentServerSession && sessionId) {
      // merge 在 render 中保持纯读取；只在对应完整 snapshot 确实提交后确认该 revision。
      sessionSnapshotPatchBufferRef.current.acknowledgeCommitted(sessionId, currentServerSession);
    }
  }, [currentServerSession, sessionId]);
  // Prefer server-fetched data; fall back to cached list for instant first paint。初始 GET
  // 尚未到达时，暂存 patch 也覆盖到 list snapshot 上，但不把不完整 list 提升为 serverSession。
  // 远程会话 currentServerSession 恒为 null(下方 effect 跳过本地 get),故走 sessionFromList。
  const sessionBase = currentServerSession ?? sessionFromList ?? null;
  const session =
    sessionId && sessionBase
      ? sessionSnapshotPatchBufferRef.current.merge(sessionId, sessionBase)
      : null;
  const isOrcaLeadSessionView = session?.orcaRole === 'lead';

  // worktree-parallel-sessions:订阅当前 session 的 worktree 创建态(creating/failed)。
  // 触发源:NewMakerDraftRoute 的 worktree 异步创建路径。
  // 没有创建态时返回 undefined,workingDir chip 行走原 Monitor+basename 显示分支。
  const worktreeCreation = useWorktreeCreation(sessionId);
  // worktree meta:当前 session 跑在某个 worktree 里时返回 { baseRepo, name, branch, path };
  // 否则 null。workingDir chip 用这个把显示从单一 "feat-button-ui" 升级成
  // "xdt-maker (feat-button-ui)",一眼看出这是 baseRepo xdt-maker 上的 worktree。
  const liveWorktree = useTaskInfoWorktree(
    session ?? {
      id: sessionId ?? '',
      workingDir: null,
      worktreePath: null,
      deviceLinkDeviceId: undefined,
      remoteHostId: undefined,
    },
    Boolean(session),
    { observeTelemetry: true },
  );
  const isRemoteWorktreeSession = Boolean(session?.deviceLinkDeviceId || session?.remoteHostId);

  // Fetch fresh session data from server whenever sessionId changes.
  useEffect(() => {
    const refreshSequence = sessionRefreshSequenceRef.current;
    setServerSession(null); // reset so stale data from previous session doesn't linger
    if (!sessionId) return;
    // device-link 远程会话:跳过本地 DB get(会 404),元数据走 remoteProjectsStore。
    if (getSessionDeviceId(sessionId)) return;
    const requestSequence = refreshSequence.begin(sessionId);
    if (requestSequence === null) return;
    sessionService
      .get(sessionId)
      .then((s) => {
        if (!refreshSequence.isLatest(sessionId, requestSequence)) return;
        setServerSession(sessionSnapshotPatchBufferRef.current.merge(sessionId, s));
      })
      .catch(() => {});
    return () => {
      refreshSequence.invalidate(sessionId);
    };
  }, [sessionId]);

  // device-link streaming tier:进入远程会话时订阅该会话的 `session:<id>` topic → 被控端把该会话
  // 的实时流(heavy:maker:event/status/input/interaction/messages)经 push 流回 makerChatStore,
  // 并触发被控端"正在被控"横幅(订阅 session:<id> = 活跃控制)。离开 / 切走时取消订阅(停推流 + 清
  // 横幅)。listing tier 只订阅 'sessions'(列表,不开横幅),故只有真正打开会话才让对方看到被控。
  // 解析当前会话所属远程设备 id。store 有 origin 时取 store 值(随 store 变化更新,useMemo 让同设备
  // 返回同一字符串,避免下游 effect 无谓重跑)。
  const wasRemoteSessionRef = useRef(false);
  const lastRemoteSessionIdRef = useRef<string | undefined>(undefined);
  const storeRemoteDeviceId = useMemo(
    () => (sessionId ? getSessionDeviceId(sessionId) : undefined),
    [sessionId, remoteProjectSessions],
  );
  // 切会话:在 render 阶段同步重置"曾是远程会话"标记(不靠 effect,避免新会话首帧误判)。
  if (lastRemoteSessionIdRef.current !== sessionId) {
    lastRemoteSessionIdRef.current = sessionId;
    wasRemoteSessionRef.current = false;
  }
  // 粘滞:本机 relay 瞬时重连会 clear() 掉镜像(含当前会话 origin)。此时回退到最后已知 deviceId,
  // 让当前远程会话在重连窗口内不被判成"已结束"——视图保留、RemoteSessionBanner 显示「重连中」、
  // 同步引擎仍绑定该设备(relay 回 online 自动重订阅 + 对账),子组件继续按远程处理。
  //
  // 走共享的 stickySessionOrigin,而不是本视图自己记一份 ref(greptile P1):那份模块级缓存
  // 正是 makerApiForSticky 等消费方读的同一份,而它只在被查询时预热。视图各记各的,会出现
  // 「视图这份热了、模块那份还是冷的」—— 用户在**首次开启协同之前**撞上 relay 瞬断,
  // makerApiForSticky 就会退回本机,在控制端建出 team。一份缓存,不会有两份各自预热的问题。
  const remoteDeviceId = useMemo(
    () => (sessionId ? getStickySessionDeviceId(sessionId) : undefined),
    [sessionId, remoteProjectSessions],
  );
  // 右栏本地-only 能力需要区分三态：字符串=远端、null=已确认本机、undefined=归属尚未解析。
  // 冷启动 / bootstrap 竞态期间宁可暂时禁用系统文件打开，也不能把被控端 file:// 交给控制端。
  const rightSidebarDeviceLinkDeviceId =
    remoteDeviceId ?? session?.deviceLinkDeviceId ?? (session ? null : undefined);

  /**
   * Does this task own durable Pi Subagent runs?
   *
   * The entry used to be decided by the parent's *current* harness, which is
   * not what owns the children. Switching a Pi task to Claude Code or Codex
   * leaves its detached runners going — they hold credentials and write the
   * workspace, and `stopAgentTaskHandler` keeps a path to stop them — while the
   * sidebar tab that monitors them and offers the per-child stop disappeared
   * the moment the harness changed.
   */
  const [sessionOwningDurablePiRuns, setSessionOwningDurablePiRuns] = useState<string | null>(null);
  // Keyed by the session it was observed for, so navigating to another task
  // cannot inherit the previous one's answer while its own read is still out.
  const durablePiRunsPresent = Boolean(sessionId) && sessionOwningDurablePiRuns === sessionId;

  // A task that has Subagents owns one durable Subagent tab. Both on history
  // mount and on the first live child we only ensure the tab exists — never
  // stealing OS focus, replacing an already-active tab, or opening the sidebar.
  //
  // Not gated on `agentKind`: discovery decides by what is actually on disk. It
  // registers nothing for a task with no Pi runs, so widening the gate costs a
  // non-Pi task one list read (plus a session-filtered change subscription) and
  // opens no tab.
  //
  // The durable truth lives on the data-owning device, so a device-link task
  // must discover through `deviceLink.invoke`: the controller's own DB has no
  // row for it and answers `unsupported`, which used to leave the tab
  // unregistered forever even though the panel itself already reads remotely.
  // This effect sits below `remoteDeviceId` because it depends on it.
  useEffect(() => {
    if (!ownsWindowRoute || !viewVisible || !sessionId) return;
    const requestOwner = getDataOwnerGeneration();
    return startSubagentTabDiscovery({
      sessionId,
      deviceId: remoteDeviceId ?? null,
      listLocal: () => window.electronAPI.localDb.subagentRuns.list({ sessionId }),
      listRemote: async (deviceId) =>
        (await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:subagent-runs:list', [
          { sessionId },
        ])) as SubagentRunsListResponse,
      // The same predicate the panel uses, and deliberately not a local copy of
      // it. This one used to drop `runId === null`, which is exactly the
      // *whole-session invalidation* a `/clear` or a rewind past the Subagent's
      // start emits: the records go away and nothing here noticed, so a task
      // that switched to Claude Code or Codex kept declaring an entry whose
      // runs no longer existed. `sessionId` is always a real id on that
      // payload — only `runId` is nullable — so the scoping is unchanged.
      subscribeLocalChanges: (onChanged) =>
        window.electronAPI.localDb.subagentRuns.onChanged((payload, ownerStamp) => {
          if (!isCurrentSubagentRunsChange(payload, ownerStamp, sessionId)) return;
          onChanged();
        }),
      registerTab: () => openSubagentsTab(sessionId, SUBAGENT_TAB_REGISTER_ONLY),
      isRequestOwnerCurrent: () => isDataOwnerGenerationCurrent(requestOwner),
      onPresenceChange: (present) => setSessionOwningDurablePiRuns(present ? sessionId : null),
    });
  }, [ownsWindowRoute, remoteDeviceId, sessionId, viewVisible]);

  // device-link 远程会话:重 topic 订阅(含 WS 重连 / 被控端回在线时重建)+ 消息对账触发
  // (重连 / presence / turn 结束 / 窗口聚焦 / 手动)。修「控制端丢消息」—— 以被控端为准重新同步。
  // 本机会话(remoteDeviceId 为 undefined)整体 no-op。resync 供连接 banner 的「重新同步」按钮用。
  const remoteSync = useRemoteSessionSync(sessionId, remoteDeviceId);
  // 远程会话连接健康(本机断链重连中 / 被控端离线)→ 顶部 banner 提示 + 手动重新同步。
  const remoteConn = useRemoteSessionConnection(remoteDeviceId);
  const remoteLinkIssue = useDeviceLinkConnectionIssue(!!remoteDeviceId);
  const remoteSessionUnavailable = remoteConn === 'reconnecting' || remoteConn === 'host-offline';
  const remoteWritesBlocked = remoteSessionUnavailable || isRemoteSessionWriteBlocked(session);
  const showRemoteWriteBlockedToast = useCallback(() => {
    toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
  }, [t]);
  const { togglePin, archive } = useSessionHardwareTaskActions({
    session,
    remoteWritesBlocked,
    onRemoteWriteBlocked: showRemoteWriteBlockedToast,
    patchLocal: patchLocalSession,
  });
  // 列表级 activity 在重 topic 的 maker status 之前就可用。远程 turn 正在执行 / 等待
  // 交互时,session 行天然是 startedAt > endedAt,不能把这个正常在飞窗口误判成
  // 「应用退出中断」。直接门控首帧,再锁存本次视图,避免 activity 终态与 ended patch
  // 先后到达时横幅闪现。
  const remoteSessionActivity = useRemoteSessionActivity(sessionId ?? '');
  const remoteTurnActive = isRemoteSessionActivityActive(remoteSessionActivity);

  // device-link 远程会话:非选中行镜像**被控端自己的全局模型预设**。先 pull 一次,再订阅
  // NEW_MAKER_DRAFT_CHANGED 全量回流;本地控制端只显示 / 乐观更新镜像,绝不污染自己的预设。
  // 选中模型仍走远程 session 的 DB/runtime live 值,所以其它对话改同一模型预设时不会覆盖它。
  const remoteModelMemoryScopeKey = remoteDeviceId && sessionId ? `session:${sessionId}` : null;

  useEffect(() => {
    if (!remoteDeviceId || !remoteModelMemoryScopeKey) return;
    const deviceId = remoteDeviceId;
    const scopeKey = remoteModelMemoryScopeKey;
    const agent = dbToMakerAgentKind(session?.agentKind);
    const vendorSlot = agent === 'claude-code' ? 'claudeCode' : agent;
    let cancelled = false;

    const applySnapshot = (snapshot: RemoteModelMemorySnapshot | undefined) => {
      if (!cancelled) replaceScope(scopeKey, snapshot);
    };

    window.electronAPI.deviceLink
      .invoke(deviceId, 'maker:get-new-maker-defaults', [agent])
      .then((value) => {
        const defaults = value as { providerModelMemory?: RemoteModelMemorySnapshot } | null;
        applySnapshot(defaults?.providerModelMemory);
      })
      .catch(() => {
        // 旧版被控端无该 channel / 离线:保持空镜像,非选中行回落模型默认。
      });

    const off = window.electronAPI.deviceLink.onRemotePush((push, localOwnerStamp) => {
      if (push.deviceId !== deviceId || push.channel !== 'maker:new-maker-draft:changed') return;
      if (!isDeviceLinkRemotePushCurrent(push, localOwnerStamp)) return;
      const payload = push.payload as Record<
        string,
        { providerModelMemory?: RemoteModelMemorySnapshot } | undefined
      > | null;
      applySnapshot(payload?.[vendorSlot]?.providerModelMemory);
    });

    return () => {
      cancelled = true;
      off();
      clearScope(scopeKey);
    };
  }, [remoteDeviceId, remoteModelMemoryScopeKey, session?.agentKind]);

  const remoteModelMemoryOverride = useMemo<ModelMemoryAccessors | undefined>(() => {
    if (!remoteDeviceId || !remoteModelMemoryScopeKey) return undefined;
    const deviceId = remoteDeviceId;
    return makeMirrorAccessors(remoteModelMemoryScopeKey, (agent, providerId, model, patch) => {
      window.electronAPI.deviceLink
        .invoke(deviceId, 'maker:apply-new-maker-draft-pref', [
          {
            agent,
            providerId,
            modelId: model,
            active: false,
            ...(patch.markModelChoice !== undefined
              ? { markModelChoice: patch.markModelChoice }
              : {}),
            ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
            ...(patch.fast !== undefined ? { fast: patch.fast } : {}),
            ...(patch.thinking !== undefined ? { thinking: patch.thinking } : {}),
          },
        ])
        .catch(() => {
          // 旧版被控端 / 离线时仍保留控制端乐观镜像,不回退写本机预设。
        });
    });
  }, [remoteDeviceId, remoteModelMemoryScopeKey]);

  // device-link 边界:正在查看的远程会话 origin 从 remoteProjectsStore 消失 → 优雅退回 /cc-agent,
  // 避免停留在 session=null 的失效视图。但必须区分"消失"的来因(以 store 真相 + 本机链路状态判定):
  //   - 本机 relay 瞬时重连(remoteConn==='reconnecting'):origin 是被本机断链 clear() 清掉的,
  //     不是被控端没了 → **不退回**,保留视图让 banner 显示「重连中」,等 relay 回 online 再判定。
  //   - relay 在线但 origin 仍没了:会话/设备真没了 →「被控端设备分片是否仍在」区分后退回:
  //       · 会话被删/归档(分片仍在)→ 静默退回(删除流程自身已导航)。
  //       · 设备掉线/关被控(整片移除)→ 提示「远程设备已离线」并退回。
  useEffect(() => {
    if (!sessionId) return;
    if (storeRemoteDeviceId !== undefined) {
      wasRemoteSessionRef.current = true;
      return;
    }
    const dev0 = getStickySessionDeviceId(sessionId);
    const decision = decideRemoteSessionExit({
      hasOrigin: false,
      wasRemote: wasRemoteSessionRef.current,
      reconnecting: remoteConn === 'reconnecting',
      deviceStillOnline: dev0 ? remoteProjectsStore.getDeviceIds().includes(dev0) : false,
    });
    if (!decision.exit) return;
    wasRemoteSessionRef.current = false;
    if (decision.toastOffline) {
      toast.warning(t('settings.devices.toast.remoteSessionEnded'));
    }
    if (!ownsWindowRoute) {
      log.info('remote session exit ignored by embedded sidebar view', { sessionId });
      return;
    }
    navigate('/cc-agent', { replace: true });
  }, [sessionId, storeRemoteDeviceId, remoteConn, navigate, ownsWindowRoute, t]);

  // F-COLLAB / 通用 stale 修复: serverSession 只在 sessionId 变化时拉一次, 之后
  // 永不更新; 而 `session = serverSession ?? sessionFromList`, serverSession 一旦
  // 拉到就永远盖过 sessionFromList。这导致 main 端 broadcast 的 session patch
  // (典型: setSessionOrcaRole 改 orcaRole='lead', 或 archive 改 status) 即便 store
  // 端 patchLocal 已经响应, CCAgentSessionView 内的 serverSession 仍是初次快照,
  // collabEnabled 等派生状态不会重算 → MCP team 工具触发
  // 后 ChatInput pill / orcaMode effect 等都不响应。
  //
  // 修法: 订阅 sessions:patched 事件, 对应 sessionId 的 patch 同步合并到
  // serverSession。手动 toggle 路径不依赖本 effect (它走 navigate 触发 remount
  // 重拉 serverSession), MCP / 飞书等外部触发路径必须靠这条响应链。
  useEffect(() => {
    if (!sessionId) return;
    const sessionsPush = window.electronAPI?.localDb?.sessionsPush;
    if (!sessionsPush) return;
    const refreshSequence = sessionRefreshSequenceRef.current;
    const unsub = sessionsPush.onPatched(({ sessionId: patchedId, patch }, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      if (patchedId !== sessionId || !refreshSequence.isCurrentSession(patchedId)) return;
      const patchBuffer = sessionSnapshotPatchBufferRef.current;
      patchBuffer.stage(patchedId, patch);
      const fullSnapshot = currentServerSessionRef.current;
      if (fullSnapshot) {
        // 已有完整 snapshot：patch 比在途 GET 更新，失效旧 GET 后合并全部暂存字段。
        refreshSequence.invalidate(patchedId);
        setServerSession((prev) =>
          patchBuffer.merge(patchedId, prev?.id === patchedId ? prev : fullSnapshot),
        );
      } else {
        // 初始 GET 是当前唯一完整 row，不能因 list snapshot 中途出现而失效。先让派生
        // session 显示暂存 patch；若 GET 已 setState 尚未 render，functional update 也能合并。
        bumpSessionPatchVersion((version) => version + 1);
        setServerSession((prev) =>
          prev?.id === patchedId ? patchBuffer.merge(patchedId, prev) : prev,
        );
      }
      // 被控端本机:控制端远程切的 fastMode 经 persistSessionFields 广播到这里 → 镜像进 chat
      // in-memory,让本机打开的 fast 开关也即时跟随(以被控端为准;幂等,不碰本机乐观路径)。
      makerChatStore.mirrorSessionFields(patchedId, patch);
    });
    return unsub;
  }, [sessionId]);

  // 本机打开中的会话被外部(典型:控制端远程删除)置为 deleted → 主动退出该视图。
  // 否则会停留在已删会话里、还能继续发消息把它"写活"。仅对 deleted 强制退出;archived
  // 保持可浏览(与本机归档后仍可看 + 发消息自动恢复的既有语义一致)。本机自删走 navigate
  // 后视图已卸载,不会触发本 effect。
  useEffect(() => {
    if (!sessionId) return;
    if (session?.status === 'deleted') {
      makerChatStore.purgeSession(sessionId);
      // 分屏树同步收敛：已删任务的 pane 立即塌缩，持久化布局不再保留死节点；
      // 嵌入 pane 靠这一步退出（下方 return 不导航），owner 导航后也不会恢复它。
      splitGroupStore.removeSession(sessionId);
      if (!ownsWindowRoute) {
        log.info('deleted session navigation ignored by embedded sidebar view', { sessionId });
        return;
      }
      navigate('/cc-agent', { replace: true });
    }
  }, [session?.status, sessionId, navigate, ownsWindowRoute]);
  const vendorAuthGate = useVendorAuthGate();

  useEffect(() => {
    if (!sessionId || !searchJump) return;
    if (searchJump.sessionId !== sessionId) {
      if (!session) return;
      // 仅路由主权实例回收「跳转目标 ≠ 当前会话」的陈旧状态：分屏的嵌入 pane
      // sessionId 固定，跨会话跳转时它们天然不匹配，若也清理会把 owner 正在
      // 消费的跳转取消掉（异步 loadAround 被 cleanup 置为 cancelled）。
      if (!isOrcaMode && !isOrcaLeadSessionView && ownsWindowRoute) {
        clearSearchJumpState();
      }
      return;
    }
    let cancelled = false;
    const currentState = makerChatStore.getSnapshot(sessionId);
    // "目标已在 messages 里"不等于"窗口连续覆盖到它":先前一次补齐失败的跳转会把目标以
    // 孤岛形式 merge 进窗口(它与已加载的尾部之间隔着没加载的历史)。这时若直接 focus 就
    // 返回,store 侧的自愈补齐永远不会被触发,中间缺失一直修不回来(#676 review)。
    // 判定逻辑抽在 canFocusWithoutJumpLoad,由 searchJumpTargeting.test.ts 直接覆盖。
    if (canFocusWithoutJumpLoad(currentState, searchJump.messageClientId)) {
      requestFocusMessage(searchJump.messageClientId);
      clearSearchJumpState();
      return;
    }
    // 加载失败(取不到权威行 / 请求 reject)时的收口:目标只要**此刻**还渲染在窗口里,就直接
    // focus 它、不报错 —— 导航到一行已经在屏上的消息根本不需要网络(被控端临时离线时
    // invokeRemote 会 reject)。孤岛标记保留,留给下一次跳转再试修复。
    //
    // 必须查**实时**快照,不能用进 effect 时捕获的布尔值:请求飞行期间远程权威重建可能已经把
    // 那一行移除(并 bump 代际,正是 loadAround 返回 null 的原因之一),那时照旧 focus 一个已
    // 不存在的 clientId 会白吞掉这次跳转 —— 既不导航也不报错,MessageStream 还会在后续每次
    // 渲染里线性扫描这个找不到的 id(#676 review codex P1 + copilot)。
    const targetStillInWindow = (): boolean =>
      makerChatStore
        .getSnapshot(sessionId)
        .messages.some((message) => message.clientId === searchJump.messageClientId);
    const finishWithFallback = (): void => {
      if (targetStillInWindow()) {
        requestFocusMessage(searchJump.messageClientId);
      } else {
        toast.error(t('ccAgent.search.jumpFailed'));
      }
      clearSearchJumpState();
    };
    const loadAround =
      searchJump.messageIdKind === 'clientId'
        ? makerChatStore.loadAroundMessageClientId
        : makerChatStore.loadAroundMessage;
    void loadAround(sessionId, searchJump.messageId, { radius: 60 })
      .then((message) => {
        if (cancelled) return;
        if (message) {
          requestFocusMessage(message.clientId);
          clearSearchJumpState();
          return;
        }
        finishWithFallback();
      })
      .catch((err) => {
        if (!cancelled) {
          log.warn('Failed to load search hit context:', err);
          finishWithFallback();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    clearSearchJumpState,
    isOrcaLeadSessionView,
    isOrcaMode,
    ownsWindowRoute,
    requestFocusMessage,
    searchJump,
    session,
    sessionId,
    t,
  ]);

  // 后台任务面板行点击 → 聊天流定位对应任务卡:sessionId 匹配当前会话才消费;
  // 消息不在已加载窗口时先 loadAround 补上下文再定位(与搜索跳转同一收口)。
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const unsubscribe = subscribeChatTaskFocus((focusSessionId, clientId) => {
      if (cancelled || focusSessionId !== sessionId) return;
      const existing = makerChatStore
        .getSnapshot(sessionId)
        .messages.some((message) => message.clientId === clientId);
      if (existing) {
        requestFocusMessage(clientId);
        return;
      }
      void makerChatStore
        .loadAroundMessageClientId(sessionId, clientId, { radius: 60 })
        .then((message) => {
          if (cancelled) return;
          requestFocusMessage(message?.clientId ?? clientId);
          if (!message) toast.error(t('ccAgent.search.jumpFailed'));
        })
        .catch((err) => {
          if (cancelled) return;
          log.warn('Failed to load chat task focus context:', err);
          toast.error(t('ccAgent.search.jumpFailed'));
        });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [requestFocusMessage, sessionId, t]);

  // 选中一个 Worker session 时,如果当前是普通单 session 路由,自动跳到 Lead
  // 普通路由并用 worker query 作为协同 tab 的初始 hint。doc 模式 (`/cc-agent/files/...`) 下不跳——doc 应该一直
  // 是 doc,Worker session 就在 chat rail 里正常渲染。
  useEffect(() => {
    if (!ownsWindowRoute || !session || !sessionId || isOrcaMode || isCompactRail) return;
    if (!isOrcaWorkerSession(session)) return;
    let cancelled = false;
    void orcaWorkflowsFor(session.id)
      .getByWorkerSession(session.id)
      .then((workflow) => {
        if (!cancelled && workflow) {
          navigate(`/cc-agent/${workflow.leadSessionId}?worker=${sessionId}`, { replace: true });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isOrcaMode, isCompactRail, navigate, ownsWindowRoute, session, sessionId]);

  // F2: controlled folder picker open state
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  // ── Full-area drag-and-drop (F-FI-1 enhancement) ──
  // Attachments are managed here so the entire content area can act as a drop zone.
  // image-local-cache: pass sessionId so addFiles/addClipboardImage can cache
  // images into userData/cc-agent/images/{sessionId}/ via IPC.
  const attachmentState = useAttachments(sessionId);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const resetFullAreaDragState = useCallback(() => {
    dragCounterRef.current = 0;
    setIsDragOver(false);
  }, []);

  // ── Dynamic overlay height for MessageStream bottom padding ──
  // Callback ref: defensive against overlay DOM swap (e.g. Plan Viewer expand
  // mounts a different wrapper). A plain `useRef` + `useEffect([])` would leave
  // the observer bound to the dead node → stale `overlayHeight` → wrong
  // `bottomPadding` → MessageStream pins to the wrong "bottom".
  // A setState-based callback ref re-runs the observer effect on every node swap.
  const [overlayEl, setOverlayEl] = useState<HTMLDivElement | null>(null);
  const overlayRef = useCallback((node: HTMLDivElement | null) => {
    setOverlayEl(node);
  }, []);
  const [overlayHeight, setOverlayHeight] = useState(200);
  const [composerStackTopOffset, setComposerStackTopOffset] = useState<number | undefined>(
    undefined,
  );
  const [inlinePlanVisibilityState, setInlinePlanVisibilityState] = useState<{
    sessionId: string | undefined;
    value: InlinePlanVisibility | null;
  }>({ sessionId, value: null });
  const inlinePlanVisibility =
    inlinePlanVisibilityState.sessionId === sessionId ? inlinePlanVisibilityState.value : null;
  const handleInlinePlanVisibilityChange = useCallback(
    (value: InlinePlanVisibility | null) => {
      setInlinePlanVisibilityState((current) => {
        if (
          current.sessionId === sessionId &&
          current.value?.key === value?.key &&
          current.value?.visible === value?.visible
        ) {
          return current;
        }
        if (current.sessionId === sessionId && current.value === null && value === null) {
          return current;
        }
        return { sessionId, value };
      });
    },
    [sessionId],
  );

  useEffect(() => {
    if (!overlayEl) return;
    const measureOverlay = () => {
      // 状态行会动态出现 / 收起，overlay 总高度不等于 composer 栈顶边。
      // 直接量完整 composer 栈（含计划模式提示）到 overlay 底边的距离，
      // 让消息流悬浮按钮不受状态行或输入框内部状态高度影响。
      setOverlayHeight(overlayEl.offsetHeight);
      setComposerStackTopOffset(measureComposerStackTopOffset(overlayEl));
    };
    // Seed with the current height so the first paint after remount uses the
    // real value (not the stale state from the previous mount).
    measureOverlay();
    const ro = new ResizeObserver(measureOverlay);
    ro.observe(overlayEl);
    return () => ro.disconnect();
  }, [overlayEl]);

  // F-FP-5: 点击 workingDir → 在系统文件管理器里直接打开目录(复用 shell:open-path IPC)。
  // local only:remote session 的 chip 仅作展示,不响应点击(见下方 remoteHostId 早返 +
  // 渲染处的条件 onClick)。
  const handleOpenWorkingDir = useCallback(async () => {
    const wd = composerWorkingDirPath({
      workingDir: session?.workingDir,
      liveWorktree,
      isRemote: isRemoteWorktreeSession,
    });
    if (!wd) return;
    // SSH / device-link 的 workingDir 是远端路径,本机 openPath 会打开错误目录。
    // 远端文件能力接入前,remote chip 不响应点击(仅作信息展示)。
    if (isRemoteWorktreeSession) return;
    try {
      const result = await window.electronAPI.openPath(wd);
      if (!result.success) toast.error(result.error || t('ccAgent.common.openFolderFailed'));
    } catch (err) {
      log.error('[open workingDir]', err);
      toast.error(t('ccAgent.common.openFolderFailed'));
    }
  }, [session?.workingDir, isRemoteWorktreeSession, liveWorktree, t]);

  const handleReturnToDispatcher = useCallback(() => {
    if (!ownsWindowRoute) {
      log.info('handoff return ignored by embedded sidebar view', { sessionId });
      return;
    }
    const dispatcherSessionId = handoffFrom?.dispatcherSessionId;
    if (!dispatcherSessionId) return;
    void resolveSessionRoute(dispatcherSessionId).then((target) => {
      navigate(target);
    });
  }, [handoffFrom?.dispatcherSessionId, navigate, ownsWindowRoute, sessionId]);

  // #2194: 只有本端 composer 发出的 user 消息才强制回底；IM / 手机端 /
  // 定时任务注入的按普通新内容处理（贴底才跟随）。useCallback 稳定引用——
  // MessageStream 的未读 diff effect 依赖它，内联箭头会让父组件每次
  // re-render 都重跑一遍 O(n) diff（Copilot review nit）。sessionId 不可用
  // 的极短窗口按**非本端发送**处理：该窗口内本端发送会被 guard 早返、根本
  // 发不出去，能到达的 user 消息必然来自外部（Copilot review nit）。
  const isLocalUserSend = useCallback(
    (clientId: string) =>
      sessionId ? makerChatStore.isLocalSentUserMessage(sessionId, clientId) : false,
    [sessionId],
  );
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const requestFollowLatest = useCallback(
    (sourceSessionId: string | null | undefined, startGeneration: number) => {
      tryRequestFollowLatest({
        sourceSessionId,
        currentSessionId: sessionIdRef.current,
        startGeneration,
      });
    },
    [],
  );

  const handleOpenForkOrigin = useCallback(() => {
    if (!canNavigateSession) {
      log.info('fork origin navigation ignored by embedded sidebar view', { sessionId });
      return;
    }
    if (!session?.parentSessionId || !session.forkedAtMessageId) return;
    const parentSessionId = session.parentSessionId;
    const forkedAtMessageId = session.forkedAtMessageId;
    const navigationRequestVersion = ++sessionNavigationVersionRef.current;
    void resolveSessionRoute(parentSessionId).then((target) => {
      if (sessionNavigationVersionRef.current !== navigationRequestVersion) return;
      onSessionNavigate?.(parentSessionId, getSessionRouteOwnerId(target) ?? parentSessionId);
      navigate(target, {
        state: {
          searchJump: {
            kind: 'conversation-search',
            sessionId: parentSessionId,
            messageId: forkedAtMessageId,
            messageIdKind: 'clientId',
            messageClientId: forkedAtMessageId,
          },
        },
      });
    });
  }, [
    canNavigateSession,
    navigate,
    onSessionNavigate,
    session?.forkedAtMessageId,
    session?.parentSessionId,
    sessionId,
  ]);

  const forkOrigin = useMemo(
    () =>
      canNavigateSession && session?.parentSessionId && session.forkedAtMessageId
        ? {
            parentSessionId: session.parentSessionId,
            forkedAtMessageId: session.forkedAtMessageId,
            forkedSessionCreatedAt: session.createdAt,
          }
        : null,
    [canNavigateSession, session?.createdAt, session?.forkedAtMessageId, session?.parentSessionId],
  );

  // F-CMD /help: 拉三源(desktop + agent-builtin + agent-skill) palette 快照,
  // 供 dispatch 时识别 desktop 命令 + /help 卡片展示完整命令清单。
  const [allCommands, setAllCommands] = useState<UnifiedCommand[]>([]);
  const allCommandsRef = useRef(allCommands);
  allCommandsRef.current = allCommands;
  // remote session 的 workingDir 是远端主机上的路径:本地 slash skill 扫描 / @ 资源扫描 /
  // 设置页本地项目上下文都不该消费它(否则会读到本机同名目录的 skills/files)。在远端
  // 文件 / skills 能力落地前,remote 一律按"无本地 workingDir"处理。
  const isRemoteSession = !!session?.remoteHostId;
  useEffect(() => {
    let cancelled = false;
    const agentKind = dbToMakerAgentKind(session?.agentKind);
    // SSH remote 显式禁用控制端本机 skill 扫描；本地无 workingDir 时 Claude 仍扫全局 skills。
    const wd = session?.workingDir;
    // 先同步清空:切换会话(尤其 local→remote)时 loadAllCommands 是异步的,清空可避免
    // 刷新完成前 getHelpCommandsSnapshot / desktop 命令识别复用上一个项目的本地 skills。
    setAllCommands([]);
    // device-link 远程会话:传 remoteDeviceId,让 agent-builtin / agent-skill 从**被控端**该会话读
    // (与 ChatInput palette 同源)。否则此 cache 取的是控制端命令,maybeDispatchDesktopSlashCommand
    // 会把被控端 skill/builtin 影子掉的 /clear、/help 等误判成 desktop 命令、在控制端执行。
    // 本机会话 remoteDeviceId=undefined → 行为不变。desktop 命令始终本地(见 loadAllCommands)。
    loadAllCommands(
      agentKind,
      wd,
      {
        skipAgentSkills: isRemoteSession,
        sessionId: session?.id,
      },
      remoteDeviceId,
    )
      .then((cmds) => {
        if (!cancelled) setAllCommands(cmds);
      })
      .catch(() => {
        if (!cancelled) setAllCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.id, session?.agentKind, session?.workingDir, isRemoteSession, remoteDeviceId]);

  // Keep lastWorkingDir in sync so Settings can distinguish a real project
  // scope from「新对话默认值」. Standalone dialogues have an internal runtime
  // directory too, but it is not a stable project preference scope; caching it
  // here was the root cause of every new dialogue getting a fresh setting.
  // Remote workingDir is also not a local project path.
  useEffect(() => {
    // Embedded rails and Orca panes share this component but do not own the
    // active route. They must not overwrite the process-wide project scope
    // selected by the route-owned conversation.
    if (!ownsRoute) return;
    if (session?.workspaceKind === 'project' && session.workingDir && !isRemoteSession) {
      setLastWorkingDir(session.workingDir);
      return;
    }
    setLastWorkingDir(null);
  }, [ownsRoute, session?.workingDir, session?.workspaceKind, isRemoteSession]);

  // (订阅 desktop-command-triggered 的 useEffect 在下方 useCCAgentChat 解构出
  //  insertSystemCard / clearSession 之后才能挂, 见下面 "Desktop slash dispatch
  //  subscriber" 段。)

  // Pending send: stored when folder picker needs to open mid-send
  const pendingSendRef = useRef<{
    deliveryMode: MessageDeliveryMode;
    message: string;
    model: string;
    effort: Effort;
    permissionMode: PermissionMode;
    files?: AttachedFile[];
    mentions?: MentionedResource[];
    vendorOptions?: Record<string, unknown>;
    /** 正文前缀含「选中引用」编码块——补选目录后的派发同样要携带,否则该消息持久化后渲染不出胶囊。 */
    quotesEncoded?: boolean;
    agentReferences?: AgentInputReference[];
    pastedTextRanges?: PastedTextRange[];
    slashCommandRanges?: SlashCommandRange[];
    onRemoteOptimisticFailure?: (clientId: string, error?: unknown) => void;
    onDeferredAccepted?: () => void;
  } | null>(null);

  const handleTitleUpdate = useCallback(() => {
    refreshSessions();
  }, [refreshSessions]);

  const {
    agentSwitchIntent,
    messages,
    taskUpdates,
    agentStatus,
    isStreaming,
    isAgentBusy,
    sendMessage,
    compactSession,
    steerMessage,
    steerQueuedMessage,
    stopSession,
    clearSession,
    clearError,
    retryLastError,
    continueAfterSilentStop,
    errorReason,
    insertSystemCard,
    updateSystemCardData,
    error,
    usageLimitRecovery,
    errorIsRecoverable,
    errorRetryText,
    credentialSwitchWait,
    continuationInFlightClientId,
    continuationTurnClientId,
    continuationInFlightProjectionCapability,
    loadOlderMessages,
    isLoadingMore,
    hasMoreMessages,
    historyWindowHasIsland,
    pendingPermission,
    respondToPermission,
    pendingAskUser,
    answerUserQuestion,
    pendingPluginSetup,
    pluginSetupViewerState,
    pluginSetupCommandInFlight,
    setPluginSetupViewerState,
    respondToPluginSetup,
    askUserViewerState,
    setAskUserViewerState,
    askUserDraft,
    setAskUserDraft,
    pendingPlanReview,
    respondToPlanReview,
    cancelPlanReview,
    planViewerState,
    setPlanViewerState,
    pendingIssueConfirm,
    respondToIssueConfirm,
    pendingRenameSessionsConfirm,
    respondToRenameSessionsConfirm,
    pendingGhostGrantConfirm,
    respondToGhostGrantConfirm,
    lastExpandedPlanViewerState,
    updatePlanContent,
    historyLoaded,
    fastMode,
    setFastMode,
    resetFastMode,
    planModeEnabled,
    setPlanMode,
    // F-QUEUE-DEFER
    pendingQueue,
    steeringQueueClientIds,
    queuePaused,
    queueExpanded,
    setQueueExpanded,
    resumeQueue,
    moveQueueItem,
    setQueueInteractionLock,
    setQueueEditLock,
    removeFromQueue,
    updateQueueItem,
    chatDisplaySnapshot,
  } = useCCAgentChat(sessionId, handleTitleUpdate, { chatRealtime });
  useEffect(() => {
    if (!sessionId || !isOrcaLeadSessionView || !historyLoaded) return;
    const recoveredAssignment = getRecoverableDeferredUiAssignment({
      leadSessionId: sessionId,
      messages,
      deviceId: remoteDeviceId,
      remoteRouteUnavailable: remoteConn !== 'connected',
    });
    if (!recoveredAssignment) return;
    // Renderer may exit after the Lead input becomes durable but before the accepted callback
    // starts the second-stage Worker dispatch. A persisted pending receipt is safe to consume once
    // this Lead's history has loaded a user row; the main-side gate still enforces snapshot time.
    void dispatchDeferredUiAssignment(sessionId, undefined).catch((err) => {
      log.error('recover persisted deferred Worker assignment after session mount failed', err);
      toast.error(t('newChat.collaboration.assignmentFailed'));
    });
  }, [historyLoaded, isOrcaLeadSessionView, messages, remoteConn, remoteDeviceId, sessionId, t]);
  useEffect(() => {
    return subscribeWorkLouderCodexAction((action) => {
      if (action.type !== 'command') return false;
      if (!sessionId || !ownsHardwareTaskActions) return false;
      if (action.commandId === 'approval.approve') {
        if (pendingPermission) {
          respondToPermission({ behavior: 'allow' });
          return true;
        }
        if (pendingPlanReview) {
          respondToPlanReview(pendingPlanReview.requestId, true);
          return true;
        }
        return false;
      }
      if (action.commandId === 'approval.decline') {
        if (pendingPermission) {
          respondToPermission({
            behavior: 'deny',
            message: 'User denied',
            decisionClassification: 'user_reject',
          });
          return true;
        }
        if (pendingPlanReview) {
          cancelPlanReview(pendingPlanReview.requestId);
          return true;
        }
      }
      if (action.commandId === 'forkTask') {
        if (!canNavigateSession) return false;
        void forkCurrentTaskFromKeyboard(sessionId, {
          navigate,
          t,
        });
        return true;
      }
      if (action.commandId === 'copyConversationMarkdown') {
        void copyCurrentTaskMarkdown(sessionId, { navigate, t });
        return true;
      }
      if (action.commandId === 'toggleTaskPin') {
        void togglePin();
        return true;
      }
      if (action.commandId === 'archiveTask') {
        void archive();
        return true;
      }
      return false;
    });
  }, [
    archive,
    canNavigateSession,
    cancelPlanReview,
    ownsHardwareTaskActions,
    navigate,
    pendingPermission,
    pendingPlanReview,
    respondToPermission,
    respondToPlanReview,
    sessionId,
    t,
    togglePin,
  ]);
  // 展示引擎可乐观跟随 intent；真实 event reducer 仍只读 store.agentKind。
  const displayAgentKind = agentSwitchIntent?.target ?? dbToMakerAgentKind(session?.agentKind);
  // 真实会话 agentKind(pending switch intent 不影响)——压缩分流必须用它,
  // 否则 intent 乐观切到 pi 但真实会话仍在跑 claude-code 时会错调 compact-session(#1933 review)。
  const realAgentKind = dbToMakerAgentKind(session?.agentKind);
  const isCodex = displayAgentKind === 'codex';
  // 手动压缩通道判定(#1927/#1933 review):真实 Claude Code → maker:input:compact;
  // 其余 agent 声明 manualCompact.supported(当前仅 pi)→ maker:compact-session;其余无入口。
  // 能力取**真实 agent**(displayAgentKind 在 pending switch 期间可能乐观指向目标 agent,
  // 用它判定会与 realAgentKind 分流不一致);remoteDeviceId 让远程 pi 取被控端能力。
  const { capabilities: realSessionCaps } = useAgentCapabilities(realAgentKind, remoteDeviceId);
  const compactChannel = useMemo(
    () => resolveManualCompactChannel(realAgentKind, realSessionCaps),
    [realAgentKind, realSessionCaps],
  );
  // 最新 channel 的可变镜像:useCallback 闭包在创建后固定捕获 compactChannel,确认框
  // await 期间同会话切换 agent(跨窗口/远程,sessionId 不变)会产生新 render 但旧 async
  // 闭包还在跑——从闭包读到的还是旧 channel(greptile review)。ref 每次 render 同步,
  // 异步执行中读 ref.current 才能拿到切换后的最新通道,且无需重建回调。
  const compactChannelRef = useRef(compactChannel);
  compactChannelRef.current = compactChannel;
  // 最新 session 快照的可变镜像(与 compactChannelRef 同款):确认框 await 期间同会话
  // 切换 agent 后,model/effort/permissionMode/workingDir 全部可能变化——claude-input
  // 分支必须用切换后的快照,否则会用旧 Pi 的模型/权限去执行 Claude 的 /compact
  // (greptile P1 / codex P2 review)。compact-session 分支只依赖 sessionId,无需此快照。
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // 最新 running 状态的可变镜像(与 compactChannelRef / sessionRef 同款):render 闭包
  // 固定捕获 agentStatus.isRunning——确认框 await 期间 turn 可能已从其它窗口 / 远程
  // 启动,旧 async 闭包读不到;ref 每次 render 同步,确认后重读才能拦住「活跃 turn
  // 仍调 compact-session → pi 拒绝 → confirm 后吃 rejection toast」(codex P2)。
  const isRunningRef = useRef(agentStatus.isRunning);
  isRunningRef.current = agentStatus.isRunning;
  // live 供应商目录(含内置 + 自定义,按 agent 挂模型)—— vendor↔model 一致性校验的真源,
  // 与模型选择器同源(见下方 M35 vendor fallback effect)。本地 IPC 极快返回,有模块级缓存。
  // device-link 远程会话用被控端经隧道带来的 providers(per-provider,fast 判定与本地同口径)。
  const { providers: localProviders } = useProviders();
  const { mode: authMode, user: authUser } = useAuth();
  const { providers: deviceProviders } = useDeviceProviders(remoteDeviceId);
  const providers = remoteDeviceId ? deviceProviders : localProviders;
  const canSwitchToClaudeSubscription = useMemo(() => {
    if (remoteDeviceId || session?.remoteHostId || session?.agentKind !== 'cc' || !session.model) {
      return false;
    }
    return connectedProvidersForAgent(localProviders, 'claude-code').some(
      (provider) =>
        provider.id === 'anthropic' && providerOffersModel(provider, session.model, 'claude-code'),
    );
  }, [localProviders, remoteDeviceId, session?.agentKind, session?.model, session?.remoteHostId]);
  /**
   * 余额不足横幅的「查看余额」出口 —— 只在计费面对当前账号可见时提供（cloud +
   * personal，与设置页「用量和计费」同一判据）。org / local / 未登录账号在 Cindy 里
   * 没有余额页可跳，此时不传回调，ErrorBanner 会保持原样文案、不加按钮。
   */
  const canAccessBilling = canAccessBillingSettings({
    mode: authMode,
    membershipKind: authUser?.membershipKind ?? null,
  });
  const handleViewBalance = useCallback(() => {
    navigate('/settings?tab=billing');
  }, [navigate]);
  // live 错误的来源 provider 快照:错误出现时取值、任务切换时重置、错误存续期间
  // 切 provider 不跟随。语义与边界条件见 useLiveErrorSourceProvider 头注释。
  const liveErrorSourceProviderId = useLiveErrorSourceProvider(
    error,
    sessionId,
    session?.providerId ?? null,
  );
  // 该会话 agent 的能力(agent 级 hasFastMode + 旧被控端拍平回退用 availableModels);按 remoteDeviceId 作用域。
  const { capabilities: sessionCaps } = useAgentCapabilities(displayAgentKind, remoteDeviceId);
  // 这里曾有 useErrorReadAck:ErrorBanner 在视图内聚焦驻留 1.5s 即 explicit 清红点。
  // 2026-07 统一后展示不再产生已读 —— 横幅还在就说明告警未处理,红点必须留着。
  // 红角标现在只由用户处置横幅(handleRetry / handleSilentStopContinue /
  // handleDismissError 调 ackErrorAlertHandled)或 pending-alerts 派生收敛来清。

  // 后台子任务活动:turn 已结束但该会话的 CC 子进程仍在调模型(后台子 agent 持续
  // 消耗用量)。main 侧按 proxy 活动信号判定并推送;消费点是 RunningStatusBar 的
  // 后台模式(呼吸 + 「全部停止」);「全部停止」= 关闭常驻子进程(会话可续)。
  const backgroundActivity = useSessionBackgroundActivity(sessionId);
  // 后台 Bash 任务(run_in_background 的 Bash,taskType=local_bash):不调模型,
  // proxy 活动信号覆盖不到 —— 从 taskUpdates 事件流折算,并在挂载/重载后用 main
  // 快照补回存量。与上面的 proxy 信号一起点亮状态栏后台模式。
  const backgroundBash = useBackgroundBashTasks(sessionId, taskUpdates, historyLoaded);
  // 与运行态互斥(turn 一开跑 main 即广播熄灭,这里再加一道渲染守卫防瞬时竞态):
  // 只在「无 turn 在跑」时才把状态栏切到后台子任务模式。
  const backgroundTasksActive =
    (backgroundActivity.active || backgroundBash.tasks.length > 0) &&
    !agentStatus.isRunning &&
    !isStreaming &&
    Boolean(sessionId);

  // error-tail-banner:会话尾部停在未忽略的 role='error' 行 → 输入框上方显示
  // 可操作红条(与 live ErrorBanner 同风格;2026-07-05 产品决策统一——所有尾部
  // 错误都要有主操作 + 关闭按钮)。两种语义:
  //   - 中断标记行(reason=app-exit-interrupted,启动扫尾补写)→「继续任务/忽略」
  //   - 普通失败行(process exited / turn-failed 等,重启后 live 报错只剩历史行)
  //     →「重试/关闭」
  // 后面有新消息 = 任务已被推进,判定自然不命中。此时消息流内不重复渲染该行
  // (MessageStream 对尾部未忽略 error 行返回 null,由本条独家承载)。
  const errorTailMsg = useMemo(() => {
    const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
    return last && last.role === 'error' && !last.errorDismissed ? last : null;
  }, [messages]);
  // 队列里已有合成续跑项 = 用户已点过继续/重试、只是尚未被接受落库(排队被挡 /
  // 凭证切换等待):视为已推进,banner 抑制(review P2)—— 本地 hidden 态在重挂/
  // 重载后丢失,只看 messages 尾部时旧 error 行仍在,banner 会重现并允许对同一
  // 错误重复 enqueue 续跑。落库后合成行进 messages 尾部,由尾部判定接管。
  // 精确匹配两条续跑指令,不用共享前缀:其它 UI trigger(Mivo/图片动作等)排队
  // 并不推进失败/中断的 turn,前缀匹配会误抑制、让会话失去重试/继续入口(review P2)。
  const syntheticContinuationQueued = useMemo(
    () =>
      pendingQueue.some(
        (q) => q.text === CONTINUE_AFTER_APP_EXIT_PROMPT || q.text === CONTINUE_AFTER_ERROR_PROMPT,
      ),
    [pendingQueue],
  );
  // coordinator 在 dispatch 前先把队首移出 pendingQueue。只看 queued 会在
  // vendor running / durable session ack 尚未回投的窗口误判为「用户取消」，
  // 让旧横幅重新出现；active marker 把这段交接窗口纳入同一个抑制状态。
  const syntheticContinuationPending =
    syntheticContinuationQueued || continuationInFlightClientId !== null;
  const errorTailKind: 'interrupted' | 'error' =
    errorTailMsg?.errorReason === APP_EXIT_INTERRUPTED_REASON ? 'interrupted' : 'error';
  // 普通失败行传给 ErrorBanner 的错误文本:**保持 raw**(只解码 [REMOTE_*]
  // bracket code,不做 reason→i18n 转换,review P2)—— ErrorBanner 的门控判定
  // (codex thread not found / 401 / invalid-encrypted 等)靠对原文的正则命中,
  // i18n 化会让不可重试错误漏过门控;live 报错时 banner 显示的本来也是 raw
  // message,重载后同文案反而更一致。
  const errorTailText = useMemo(() => {
    if (!errorTailMsg || errorTailKind !== 'error') return '';
    return decodeRemoteErrorMessage(errorTailMsg.content);
  }, [errorTailKind, errorTailMsg]);
  // 本地隐藏态:点主按钮后立即隐藏,不等新消息入流(视觉连续性,规则 7)。
  // 「忽略/关闭」走 store 的乐观 errorDismissed 更新,无需本地态。
  // 按错误行 clientId 归属(不是 sessionId,review P2):续跑后同一会话再次以
  // **新的**错误行收尾时,hidden 态不匹配新行,新红条正常浮现。
  const [errorTailBannerHiddenFor, setErrorTailBannerHiddenFor] = useState<string | null>(null);
  const errorTailBannerHidden =
    errorTailBannerHiddenFor !== null && errorTailBannerHiddenFor === errorTailMsg?.clientId;
  /**
   * Claude Code captures the subscription token and plan metadata when its process is spawned.
   * Settings auth changes only affect future sessions, so a subscription-plan retry must first
   * use the existing soft-close path; the next dispatch then lazy-creates Claude with fresh auth.
   * preserveWorkspace keeps this recovery from triggering worktree cleanup, and makerApiFor
   * keeps the same behavior for device-link sessions.
   */
  const rebuildClaudeSubscriptionSessionBeforeRetry = useCallback(
    async (reason: string | null | undefined): Promise<void> => {
      if (
        !sessionId ||
        session?.agentKind !== 'cc' ||
        reason !== CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON
      ) {
        return;
      }
      await makerApiFor(sessionId).closeSession(sessionId, { preserveWorkspace: true });
    },
    [session?.agentKind, sessionId],
  );
  // 抑制交棒(review P2):本地 hidden 态只服务「点击 → enqueue 被接受」的短窗口;
  // 合成续跑项进入队列或 coordinator dispatch 边界后就释放 hidden 态，由
  // main projection 接管抑制。排队项被取消 / dispatch 前被 Ghost block 时，
  // queued 与 in-flight 都消失，旧 error 行的 banner 立即恢复；成功派发则由
  // 合成消息落库与 session/running 状态继续接管。
  useEffect(() => {
    if (syntheticContinuationPending && errorTailBannerHiddenFor !== null) {
      setErrorTailBannerHiddenFor(null);
    }
  }, [syntheticContinuationPending, errorTailBannerHiddenFor]);
  const handleErrorTailContinue = useCallback(async () => {
    if (!sessionId || !errorTailMsg) return;
    setErrorTailBannerHiddenFor(errorTailMsg.clientId);
    try {
      // 隐藏的英文续跑指令([UI_ACTION_TRIGGER] 前缀,消息流不渲染)——用户视角
      // 就是任务继续跑了。transcript 里已有原任务与(可能的)部分进展,模型自查
      // 进度接着做。send 失败恢复红条让用户能重试。
      await rebuildClaudeSubscriptionSessionBeforeRetry(
        errorTailKind === 'error' ? errorTailMsg.errorReason : null,
      );
      await makerChatStore.sendUiTrigger(
        sessionId,
        errorTailKind === 'interrupted'
          ? CONTINUE_AFTER_APP_EXIT_PROMPT
          : CONTINUE_AFTER_ERROR_PROMPT,
      );
      // sendUiTrigger 在 enqueue 成功后就 resolve,续跑消息**还没落库** —— 此刻重算
      // 仍会把原 error 行判为尾行并保留红点,而 syntheticContinuationPending 已经把
      // 横幅隐藏了(排队被暂停 / 阻塞时可能持续很久)。所以先临时清点让两者一致;
      // 排队项被取消或拒绝时,下方的 effect 会在 pending 落回 false 时重算恢复
      // (PR #879 review P1)。
      // 本机会话才清:远程会话的红点靠隧道回执清被控端,而本机库里没有它的行,
      // 重算恢复不了 —— 那条腿延后到 pending 落回 false 且横幅确实消失后再 ack。
      if (!remoteDeviceId) ackErrorAlertHandled(sessionId);
    } catch (err) {
      setErrorTailBannerHiddenFor(null);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [errorTailKind, errorTailMsg, rebuildClaudeSubscriptionSessionBeforeRetry, sessionId]);
  const handleErrorTailDismiss = useCallback(() => {
    if (!sessionId || !errorTailMsg) return;
    // store 乐观置 errorDismissed(banner 即刻熄灭、切会话回来不复现)+ 持久化
    // (main 侧 merge dismissed:true,不丢 sdkError 等原字段)。落库失败会回滚乐观态。
    // 必须**等落库完成**再重算:dismiss 落库无广播,而告警查询是纯 DB 读,
    // 抢在写入前读会仍判定告警存在 —— 横幅已熄灭、红点却卡住。
    void makerChatStore
      .dismissErrorTailMessage(sessionId, errorTailMsg.clientId)
      .then((persisted) => {
        // device-link 远程会话:dismiss 经隧道写到**被控端** DB,控制端本机库里没有
        // 这个会话的行,派生腿查不到、也从未认领它 —— 必须显式 ack(explicit 清本机
        // 角标 + 隧道回执清被控端未读)。删掉展示型 ack 后这是唯一的清除路径。
        // **只在落库成功时 ack**:隧道写失败时 store 已回滚乐观态、横幅重新出现,
        // 此时清红点会再造成「横幅在、红点没」(PR #879 review P1)。
        // 本机会话由下面的重算收敛,不重复 ack。
        if (persisted && remoteDeviceId) ackErrorAlertHandled(sessionId);
        return refreshPendingAlerts();
      });
  }, [errorTailMsg, remoteDeviceId, sessionId]);
  // interrupted-turn-resume(简化版):「疑似中断」由 session 行的双时间戳驱动
  // (startedAt > endedAt 且未被 /clear 越过,见 sessionActiveTurn.ts 文件头),
  // 不再依赖持久化中断消息行。判定是打开会话时的一次性快照:本窗口 turn 一旦
  // 跑起来(isRunning)或用户已操作(继续/忽略)即永久熄灭,不追 DB 实时状态。
  // 旧版本插入的中断行仍走上面的 errorTailMsg 行判定(优先),两者互斥渲染。
  const [sessionInterruptAcked, setSessionInterruptAcked] = useState(false);
  useEffect(() => {
    setSessionInterruptAcked(false);
  }, [sessionId]);
  // 与 errorTailBannerHiddenFor 相同的抑制交棒：点击后的本地 latch 只覆盖
  // enqueue 可见前的短窗口。续跑项进入队列或 coordinator dispatch 边界后由
  // main projection 抑制横幅；此时释放 latch，用户取消 / dispatch 前拦截后
  // marker 消失，旧中断横幅会立即恢复。
  useEffect(() => {
    if (syntheticContinuationPending && sessionInterruptAcked) {
      setSessionInterruptAcked(false);
    }
  }, [syntheticContinuationPending, sessionInterruptAcked]);
  // sessionId 必须在 deps 里:running→running 切会话时 isRunning 布尔值不变(true→true),
  // 只依赖它会漏掉新会话的"跑起来即熄灭"锁存——上面的 reset effect 把 acked 清成 false 后
  // 没人再置回。此时切入时拉的 session 快照天然 startedAt > endedAt(turn 在飞,ended 未写),
  // 用户点 stop 的瞬间 isRunning 落 false、ended 落库广播还没到,双时间戳判定短暂成立,
  // 「应用退出中断」横幅会闪现一帧(假阳性)。带上 sessionId 让每次切换后按新会话当前
  // isRunning 重新锁存。
  useEffect(() => {
    if (agentStatus.isRunning || remoteTurnActive) setSessionInterruptAcked(true);
  }, [sessionId, agentStatus.isRunning, remoteTurnActive]);
  const interruptedFromSession = useMemo(() => {
    if (sessionInterruptAcked || remoteTurnActive) return false;
    const started = session?.activeTurnStartedAt ?? null;
    if (!started) return false;
    const ended = session?.lastTurnEndedAt ?? 0;
    const cleared = session?.clearedAt ? Date.parse(session.clearedAt) : 0;
    return started > ended && started > cleared;
  }, [
    session?.activeTurnStartedAt,
    session?.lastTurnEndedAt,
    session?.clearedAt,
    sessionInterruptAcked,
    remoteTurnActive,
  ]);
  // 打开会话且中断判定不成立(peer 已忽略 / 续跑已完成 / 用户已操作)时重算告警:
  // 红点是 pending-alerts 的派生,这里只触发重查,由差分决定清不清 —— 不直接清点,
  // 否则会抹掉同一会话上仍未处理的错误尾行告警。
  useEffect(() => {
    if (sessionId && session && !interruptedFromSession) refreshPendingAlerts();
  }, [sessionId, session, interruptedFromSession]);
  // 排队中的续跑项消失(dispatch 成功 → 消息落库,或被取消 / 被拒绝 → 原横幅重现)
  // 时重算告警:两种结局都需要重新对账 —— 成功时原 error 已不是尾行、红点该灭;
  // 取消时告警仍在、红点该回来(本机会话的点在 enqueue 成功时被临时清掉了)。
  // 只在挂起状态由 true 落回 false 的边沿触发,不在挂起期间反复重算。
  // 边沿状态必须**连 sessionId 一起记**:本组件在会话间复用,若只记布尔值,「A 有排队项
  // (true)→ 切到 B(false)」会被误判成 A 的完成边沿,进而对 B 发 ack / 远程回执,
  // 清掉用户从未处置的 B 的红点(PR #879 review P1)。
  const prevSyntheticPendingRef = useRef<{ sessionId: string | undefined; pending: boolean }>({
    sessionId: undefined,
    pending: false,
  });
  // 边沿处理要读「横幅此刻是否还在」,但把这些值写进 deps 会让 effect 在挂起期间反复
  // 重跑;用 ref 持有最新值,effect 只由挂起状态驱动。
  const alertStillPresentRef = useRef(false);
  alertStillPresentRef.current = Boolean(errorTailMsg) || interruptedFromSession;
  useEffect(() => {
    const prev = prevSyntheticPendingRef.current;
    prevSyntheticPendingRef.current = { sessionId, pending: syntheticContinuationPending };
    // 跨会话不构成边沿:上一次记录属于别的会话,直接重新定基。
    if (prev.sessionId !== sessionId) return;
    const was = prev.pending;
    if (!was || syntheticContinuationPending) return;
    // 远程会话的 ack 延后到这里:本机库里没有它的行,重算无法恢复红点,所以必须先
    // 确认横幅**真的消失了**(dispatch 成功、续跑已落库)才发隧道回执;若横幅重现
    // (排队被取消 / 拒绝)就什么都不做,红点原样留着与横幅一致(review P1)。
    if (remoteDeviceId && sessionId && !alertStillPresentRef.current) {
      ackErrorAlertHandled(sessionId);
    }
    void refreshPendingAlerts();
  }, [syntheticContinuationPending, remoteDeviceId, sessionId]);
  const handleSessionInterruptContinue = useCallback(async () => {
    if (!sessionId) return;
    setSessionInterruptAcked(true);
    try {
      // main 侧把续跑项插到队首；durable ack 延后到 vendor dispatch 成功后，
      // 避免排队取消 / cancelled-before-dispatch 时旧中断提示被提前抹掉。
      // 续跑 turn 真正启动时会写更新的 started；若再次被 app 退出打断，仍会产生新提示。
      // 本视图先靠内存 acked 即时熄灭，peer 视图靠 dispatch 后的 ack 广播收敛。
      await makerChatStore.sendUiTrigger(sessionId, CONTINUE_AFTER_APP_EXIT_PROMPT);
      // 同 handleErrorTailContinue:enqueue 成功但续跑还没落库、durable ack 也要等
      // dispatch 成功,而横幅已隐藏 —— 先临时清点保持一致,排队被取消时由 pending
      // 落回 false 的 effect 重算恢复。远程会话同样延后(见那里的说明)。
      if (!remoteDeviceId) ackErrorAlertHandled(sessionId);
    } catch (err) {
      setSessionInterruptAcked(false);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);
  const handleSessionInterruptDismiss = useCallback(() => {
    if (!sessionId) return;
    setSessionInterruptAcked(true);
    void ackInterruptedTurnFor(sessionId)
      .then(() => {
        // 远程会话同 handleErrorTailDismiss:ack 落的是被控端 DB,控制端本机库里没有
        // 这个会话,派生腿管不到它的红点 —— 显式 ack。本机会话靠 ended 落库广播的
        // sessions:patched(lastTurnEndedAt)收敛,不重复 ack。
        if (remoteDeviceId) ackErrorAlertHandled(sessionId);
      })
      .catch((err) => {
        // 落库失败(典型:device-link 断连时忽略远程中断)必须复位闩锁 —— 否则横幅
        // 永久隐藏而中断并未被确认,红点还挂着,用户不离开再重进就没法重试
        // (PR #879 review P1)。与 handleSessionInterruptContinue 的失败处理一致。
        setSessionInterruptAcked(false);
        toast.error(err instanceof Error ? err.message : String(err));
      });
  }, [remoteDeviceId, sessionId]);
  // device-link 远程会话首屏:历史/元数据经隧道往返(网络),慢网下 historyLoaded=false
  // 期间消息区空白。仅远程 + 延迟防闪后给「正在从被控端加载」提示(本机会话恒 false)。
  // 冷缓存已经把最近一页画出来时(messages 非空)不再显示覆盖层 —— 它会盖住可读内容。
  const showRemoteLoading = useRemoteSessionLoading(
    remoteDeviceId,
    historyLoaded,
    messages.length > 0,
  );
  // 远程回执「真实展示」放行 + 本次访问的新鲜度对账。放行表示「视图挂载、真实可见
  // (viewVisible:rail 收起 / Orca 面板隐藏时为 false,挂载 ≠ 看得见)且历史已渲染」;
  // 回执真正发出还要求入队之后有一轮 sync 成功完成(sessionAttentionStore 的同步代数
  // 门槛)。historyLoaded 落地时触发一轮对账,正是给本次访问期间入队的回执提供新鲜代:
  // 复访(缓存残留)、首拉完成、以及对账失败后 focus / 重连 / turn-end 驱动的后续对账,
  // 都经同一代数机制自然收敛,无需在视图里区分场景。visible 翻 false 时收回放行,
  // 期间到达的回执重新挂起,重新可见后放行。
  useEffect(() => {
    if (!sessionId || !remoteDeviceId || !historyLoaded || !viewVisible) return undefined;
    setRemoteReceiptDisplayReady(sessionId, true);
    void makerChatStore.reconcileRemoteMessages(sessionId).catch(() => undefined);
    return () => setRemoteReceiptDisplayReady(sessionId, false);
  }, [historyLoaded, remoteDeviceId, sessionId, viewVisible]);
  // worktree 创建过程中禁用 ChatInput,防止用户在 worktree 还没就绪时继续派发消息。
  // 之前是扫 chat messages 找 SystemCard('worktree') status==='creating',现在直接
  // 读 worktreeCreationStore(已经在上面订阅 worktreeCreation 时拿到)。
  //
  // 用户体验优化 (2026-05): worktree 创建有时只要 ~200ms,store 一进一出导致
  // WorktreeCreatingOverlay 出现 1 帧就消失,视觉上像是闪了一下。这里把"creating"
  // 视觉态最少撑 1.6s —— 一旦进入 creating, 即便 store 已被 clear(创建完成),
  // overlay 也至少存在到首次进入后的第 1600ms。底层 store 仍按真实时间 clear,
  // 不影响 worktreeCreate 完成后的发送链路 (sendMessage 在 store.clear 同 tick
  // 触发, 走的是 makerChatStore 自己的队列, 不依赖 worktreePreparing)。
  const rawWorktreeCreating = worktreeCreation?.status === 'creating';
  const [smoothedWorktreeCreating, setSmoothedWorktreeCreating] = useState(rawWorktreeCreating);
  // 缓存 branchName: store clear 之后 worktreeCreation 就变 undefined, 拿不到 name 了,
  // 但 overlay 还需要继续显示 (min-duration 没到), 所以这里把进入 creating 时的 name
  // 镜像出来, 给 overlay 用。raw 重新回 true 再覆盖。
  const [smoothedBranchName, setSmoothedBranchName] = useState<string | null>(
    rawWorktreeCreating ? (worktreeCreation?.name ?? null) : null,
  );
  const creatingStartedAtRef = useRef<number | null>(rawWorktreeCreating ? Date.now() : null);
  useEffect(() => {
    if (rawWorktreeCreating) {
      if (creatingStartedAtRef.current === null) {
        creatingStartedAtRef.current = Date.now();
      }
      setSmoothedWorktreeCreating(true);
      if (worktreeCreation?.name) setSmoothedBranchName(worktreeCreation.name);
      return;
    }
    // raw 已经回 false; 没记录过 start (本会话从未进过 creating) → 直接同步
    if (creatingStartedAtRef.current === null) {
      setSmoothedWorktreeCreating(false);
      setSmoothedBranchName(null);
      return;
    }
    const elapsed = Date.now() - creatingStartedAtRef.current;
    const MIN_MS = 1600;
    if (elapsed >= MIN_MS) {
      setSmoothedWorktreeCreating(false);
      setSmoothedBranchName(null);
      creatingStartedAtRef.current = null;
      return;
    }
    const remaining = MIN_MS - elapsed;
    const timer = setTimeout(() => {
      setSmoothedWorktreeCreating(false);
      setSmoothedBranchName(null);
      creatingStartedAtRef.current = null;
    }, remaining);
    return () => clearTimeout(timer);
  }, [rawWorktreeCreating, worktreeCreation?.name, sessionId]);
  // 对外仍叫 worktreePreparing — 整段下游逻辑 (handleSend 拦截 / ChatInput.disabled /
  // overlay 渲染) 全部统一从这一个值读, 保证语义一致 (overlay 在 = 输入禁用)。
  const worktreePreparing = smoothedWorktreeCreating;

  // device-link 远程草稿的交接要等隧道往返(见下方 pending 消费):开协同要等被控端起
  // Worker,起目标另有 subscribe 与 setGoal —— 每一段都可能走到 30s 超时。期间会话看起来
  // 是空的,用户很容易以为没发出去而再打一条:那条会先进 Lead,草稿提交的首条反而排到它
  // 后面,消息顺序倒置,首轮还可能在协同尚未就绪时跑掉(codex review P2 ×2)。
  // 所以按 worktree 创建同款处理:交接**全程**锁住发送,而不只是开协同那一段。
  //
  // 命名刻意不叫 remoteCollabPreparing —— 它现在覆盖的是整条远程交接(含没开协同的
  // 起目标路径),叫 collab 会让下一个人以为只在开协同时为真。
  // 与 worktreePreparing 合成一个 sessionHandoffPreparing,下游只读这一个值,避免两个
  // "会话正在准备"的判据各自接一半闸门。
  const [remoteHandoffPreparing, setRemoteHandoffPreparing] = useState(false);
  const sessionHandoffPreparing = worktreePreparing || remoteHandoffPreparing;

  // ---------------------------------------------------------------------------
  // F-AUQ-MIN-1 / F-AUQ-MIN-5 验收第 4 条：会话切换后 askUserViewerState 重置为 'expanded'。
  // makerChatStore 按 sessionId 分片存储，A(minimized)→B→A 回到 A 时如果不重置，
  // store 里 A 的状态仍是 'minimized'。
  // setAskUserViewerState 来自 useCCAgentChat，依赖 [sessionId]，与 sessionId 同步变化，
  // 因此该 effect 实质上只在 sessionId 变更时触发一次（单会话内不会误触发）。
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!sessionId) return;
    setAskUserViewerState('expanded');
    setPluginSetupViewerState('expanded');
  }, [sessionId, setAskUserViewerState, setPluginSetupViewerState]);

  // ── F-DIFF-1: Session-wide change panel ──
  // Aggregate diffs once at this level and pass to both the toggle (for the
  // ── Desktop slash dispatch subscriber ─────────────────────────────────
  // 订阅 main 端 DesktopCommandRegistry execute 后的"做 UI 动作"广播 ——
  // /help → insertSystemCard('help', ...); /clear → clearSession()。
  // 命令"主权"在 main(决定 /help /clear 是不是 desktop 命令), renderer 只负责
  // 落实 UI 副作用; 这是 palette refactor 的核心约束: desktop commands 走 main 派发。
  // 必须放在 useCCAgentChat 解构之后, 才能拿到 insertSystemCard / clearSession。
  const getHelpCommandsSnapshot = useCallback(async (): Promise<UnifiedCommand[]> => {
    const cached = allCommandsRef.current;
    if (cached.length > 0) return cached;
    const agentKind = dbToMakerAgentKind(session?.agentKind);
    try {
      // device-link 远程会话同源:传 remoteDeviceId,fallback 快照也从被控端读(见上方 cache effect 说明)。
      return await loadAllCommands(
        agentKind,
        session?.workingDir,
        { skipAgentSkills: isRemoteSession, sessionId: session?.id },
        remoteDeviceId,
      );
    } catch {
      return [];
    }
  }, [session?.id, session?.agentKind, session?.workingDir, isRemoteSession, remoteDeviceId]);

  const insertHelpCard = useCallback(async () => {
    const commands = await getHelpCommandsSnapshot();
    insertSystemCard('help', {
      commands: commands.map((c) => ({
        name: c.name,
        description: 'description' in c ? c.description : undefined,
        // help 卡用 source 区分类目: agent-skill 透传原 source, 其余按 kind 简化
        source: c.kind === 'agent-skill' ? c.source : c.kind,
      })),
    });
  }, [getHelpCommandsSnapshot, insertSystemCard]);

  // /workflows 要在命令 handler 里读"当下"的任务表;走 ref 镜像,避免 taskUpdates
  // 高频变化把 IPC 命令监听反复重订阅。
  const taskUpdatesRef = useRef(taskUpdates);
  useEffect(() => {
    taskUpdatesRef.current = taskUpdates;
  }, [taskUpdates]);

  useEffect(() => {
    const unsub = window.electronAPI.maker.onDesktopCommandTriggered((payload) => {
      if (payload.sessionId && payload.sessionId !== sessionId) return;
      if (payload.command === 'help') {
        void insertHelpCard();
        return;
      }
      if (payload.command === 'clear') {
        clearSession();
        return;
      }
      if (payload.command === 'cmd') {
        // /cmd 的执行结果由 main 端在 payload.result 里送来; renderer 透传给 CmdCard
        // 渲染。result 缺失只可能是 main 端代码出 bug, 这里防御性 fallback。
        insertSystemCard('cmd', (payload.result ?? {}) as Record<string, unknown>);
        return;
      }
      if (payload.command === 'goal') {
        // /goal 成功(set/cleared)的可视反馈由 GoalIndicator(状态 push 驱动)承担,
        // 这里只 toast 用法 / 错误,以及一条轻量成功提示。
        if (payload.error === 'goal-usage') {
          toast.warning(t('goal.toast.usage'));
        } else if (payload.error === 'goal-no-session') {
          toast.warning(t('goal.toast.noSession'));
        } else if (payload.error === 'goal-failed') {
          toast.error(t('goal.toast.failed'));
        } else if (payload.error === 'remote-unsupported') {
          toast.warning(t('commands.toast.remoteUnsupported'));
        } else if (payload.goalAction === 'set') {
          toast.success(t('goal.toast.set'));
        } else if (payload.goalAction === 'cleared') {
          toast.success(t('goal.toast.cleared'));
        }
        return;
      }
      if (payload.command === 'learn') {
        // /learn 的蒸馏在独立后台 session 跑(learn-host);这里只反馈启动结果。
        // 进度与"待审查"入口由 learn:event 状态流驱动(审查面板见 features/learn)。
        if (payload.error === 'learn-usage') {
          toast.warning(t('learn.toast.usage'));
        } else if (payload.error === 'learn-busy') {
          toast.warning(t('learn.toast.busy'));
        } else if (payload.error === 'learn-failed') {
          toast.error(t('learn.toast.failed'));
        } else if (payload.error === 'remote-unsupported') {
          toast.warning(t('commands.toast.remoteUnsupported'));
        } else if (payload.learnRunId) {
          // 状态卡只存 runId,状态本体由卡片内 useLearnRun 订阅 learn:event 实时刷新。
          insertSystemCard('learn', { runId: payload.learnRunId });
        }
        return;
      }
      if (payload.command === 'workflows') {
        // workflow 的主视图在右栏「后台任务」面板:有 live workflow 任务则打开面板
        // 并定位其详情;没有(如重载后任务表已清空)也打开面板列表 —— 列表基于消息
        // 扫描,历史 workflow 行仍可见,比 toast「暂无」更符合命令语义。数据/展现
        // 全在本地,不回 SDK(原生 /workflows 在非交互 SDK 模式下不可用)。
        if (!sessionId) return;
        const latest = findLatestWorkflowTask(taskUpdatesRef.current);
        void openBackgroundTasksTab(sessionId, latest ? { focusTaskId: latest.taskId } : {});
        return;
      }
      // 'issue' 命令由下方独立 effect 处理(需要 handleSend,其声明在本 effect 之后)。
    });
    return unsub;
  }, [insertHelpCard, clearSession, insertSystemCard, sessionId, t]);

  // F-COLLAB: 协同模式真实状态。enabled 来自 session.orcaRole === 'lead';
  // worker(显示用)从 active workflow 的 Worker session 列表查到 agentKind。
  // 切换协同走 IPC enableOrca / disableOrca,失败时 toast。
  const [collabWorker, setCollabWorker] = useState<'cc' | 'codex' | 'pi'>('codex');
  // enableBusy 只盖"开启协同"路径;关闭走 useStopOrcaCollab hook 自己管 busy。
  const [enableBusy, setEnableBusy] = useState(false);
  const [createWorkerOpen, setCreateWorkerOpen] = useState(false);
  const collabEnabled = isOrcaLeadSessionView;
  const showOrcaLeadIdentityBar = ownsRoute && collabEnabled;
  const leadAgentKind = normalizeOrcaDisplayAgentKind(session?.agentKind);
  const leadVendor = orcaVendorForAgentKind(leadAgentKind);
  const leadPaneLabel = t('orca.split.leadLabel', {
    agent: orcaAgentLabel(leadAgentKind),
  });
  const passiveOrcaWorkersRevealSessionRef = useRef<string | null>(null);
  const routeWorkerHint = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const raw = params.get('worker');
    return {
      hasWorkerParam: params.has('worker'),
      workerSessionId: raw && raw !== 'new' ? raw : null,
    };
  }, [location.search]);
  const hasWorkerSearchJump = Boolean(
    searchJump?.sessionId && sessionId && searchJump.sessionId !== sessionId,
  );
  const hasExplicitOrcaWorkersReveal =
    routeWorkerHint.hasWorkerParam || !!orcaWorkersReveal || hasWorkerSearchJump;
  const rightSidebarCollapsedRecord = sessionId
    ? readPanelCollapsedRecord('right-tabs', { sessionId })
    : null;
  const shouldFirstFrameRevealOrcaWorkers = shouldRevealOrcaWorkersBeforeFirstPaint({
    collabEnabled,
    ownsRoute,
    isCompactRail,
    hasExplicitReveal: hasExplicitOrcaWorkersReveal,
    collapsedRecord: rightSidebarCollapsedRecord,
    hasSynchronousSessionIdentity: sessionFromList?.orcaRole === 'lead',
  });
  // 从 sidebar / deep-link 直接进 lead session 时, URL 停在 /cc-agent/<id>
  // 普通路由。检测到 lead session 已在协同时,自动确保右侧栏「协同」tab 存在。
  // worker deep link / 旧 /orca shim 带来的 ?worker= 在这里一次性翻译成 tab state,
  // 再清掉 URL 参数,主路由保持干净。
  // 新建 Maker 时 route state 的 orcaWorkersReveal 也在这里消费:必须等新会话成为
  // 当前右侧栏会话后再 reveal,否则 detached 子窗口只会写后台 collapsed 存档,不会开窗。
  // 被动切入普通 Orca Lead 路由时,如果该 session 从未记录过右栏折叠态,自动 reveal 一次:
  // 旧四栏时代开启的协同会话没有 right-sidebar-collapsed:<sessionId> 记录,切入时应展开协同 tab。
  // 已记录为开/关都尊重用户历史,只 ensure tab 存在,不抢 active tab。
  // doc rail (isCompactRail) 不在这里打开,由 WorkdirBrowseRoute 的 toggle 布局接管。
  useEffect(() => {
    if (!ownsRoute || !collabEnabled || isCompactRail || !sessionId) return;
    const shouldRevealForMissingCollapsedRecord =
      passiveOrcaWorkersRevealSessionRef.current !== sessionId &&
      shouldRevealOrcaWorkersAfterPaint({
        collabEnabled,
        ownsRoute,
        isCompactRail,
        hasExplicitReveal: hasExplicitOrcaWorkersReveal,
        collapsedRecord: rightSidebarCollapsedRecord,
      });
    const shouldPassiveRevealWorkersTab =
      shouldFirstFrameRevealOrcaWorkers || shouldRevealForMissingCollapsedRecord;
    if (shouldPassiveRevealWorkersTab) {
      passiveOrcaWorkersRevealSessionRef.current = sessionId;
    }
    const shouldRevealWorkersTab = hasExplicitOrcaWorkersReveal || shouldPassiveRevealWorkersTab;
    const focusWorkerSessionId = hasExplicitOrcaWorkersReveal
      ? routeWorkerHint.hasWorkerParam
        ? routeWorkerHint.workerSessionId
        : (orcaWorkersReveal?.focusWorkerSessionId ??
          (hasWorkerSearchJump ? (searchJump?.sessionId ?? null) : null))
      : null;
    const workerSearchJump =
      focusWorkerSessionId && searchJump?.sessionId === focusWorkerSessionId
        ? searchJump
        : undefined;
    let cancelled = false;
    let retryTimer: number | null = null;
    const clearConsumedIntent = () => {
      if (!routeWorkerHint.hasWorkerParam && !orcaWorkersReveal && !workerSearchJump) return;
      const params = new URLSearchParams(location.search);
      params.delete('worker');
      params.delete('workerAgent');
      const nextSearch = params.toString();
      navigate(`${location.pathname}${nextSearch ? `?${nextSearch}` : ''}`, {
        replace: true,
        state: {
          ...((location.state as Record<string, unknown> | null) ?? {}),
          orcaWorkersReveal: undefined,
          ...(workerSearchJump ? { searchJump: undefined } : {}),
        },
      });
    };
    const runAction = async (attempt = 0): Promise<void> => {
      const routeResult = shouldRevealWorkersTab
        ? await revealOrcaWorkersTab(sessionId, {
            focusWorkerSessionId,
            ...(workerSearchJump ? { searchJump: workerSearchJump } : {}),
            ...(shouldFirstFrameRevealOrcaWorkers ? { animate: false } : {}),
          })
        : await ensureOrcaWorkersTab(sessionId).then(() => 'attached' as const);
      if (cancelled) return;
      // route state 已属于目标 Lead，但 MainLayout→main 的 context IPC 可能晚一个事件循环。
      // stale 时保留 intent 并短暂重试；成功后才 CAS 式清 URL/state，避免 detached 丢 hint。
      if (routeResult === 'stale-context' && shouldRevealWorkersTab) {
        if (attempt >= 20) {
          log.warn('orca workers reveal context did not converge', { sessionId });
          return;
        }
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          void runAction(attempt + 1).catch((err) => {
            log.warn('ensure/reveal orca workers tab failed', err);
          });
        }, 50);
        return;
      }
      if (routeResult !== 'attached' && routeResult !== 'routed') return;
      clearConsumedIntent();
    };
    void runAction().catch((err) => {
      log.warn('ensure/reveal orca workers tab failed', err);
    });
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [
    collabEnabled,
    hasExplicitOrcaWorkersReveal,
    hasWorkerSearchJump,
    isCompactRail,
    location.pathname,
    location.search,
    location.state,
    navigate,
    orcaWorkersReveal,
    ownsRoute,
    rightSidebarCollapsedRecord,
    routeWorkerHint.hasWorkerParam,
    routeWorkerHint.workerSessionId,
    searchJump,
    sessionId,
    shouldFirstFrameRevealOrcaWorkers,
  ]);
  // Lead 允许 Claude / Codex 项目会话走 toggle,判定与新建草稿共用
  // resolveCollabEntryPolicy(issue #1170:两处各写一份判据,同一个 device-link 项目在
  // 草稿里没入口、进会话页又冒出来)。Codex 的 MCP bridge 通过 threadId -> business
  // sessionId 映射在工具调用时恢复 per-session ctx;SSH 远端会话 (codex / cc) 经
  // remote-forward 直连本机 MCP bridge、worker 创建继承 remoteHostId;device-link 会话的
  // Lead / Worker / team 真身都在被控端,enableOrca 与团队读写经隧道路由过去 ——
  // 三类都已接通,不再按 agent 或远端形态限流。
  // 注意:doc rail (isCompactRail) 也允许显示协同菜单项 —— WorkdirBrowseRoute 已经
  // 针对 Lead session 接入了 OrcaSplitView toggle 布局,普通 session 必须能从
  // ChatInput「+」菜单启用协同变成 Lead,否则 doc 模式下首次开启入口完全没有。
  const collabWorkspaceKind = session?.workspaceKind;
  const collabEntry = resolveCollabEntryPolicy({
    workspaceKind: collabWorkspaceKind,
    workingDir: session?.workingDir,
    orcaRole: session?.orcaRole,
    remoteHostId: session?.remoteHostId,
    // 粘滞归属:relay 瞬时重连清空注册表的窗口内不把远程会话误判成本机 —— 误判会让
    // 协同策略退回查控制端本机,读到的是另一台机器的开关。
    deviceLinkDeviceId: remoteDeviceId,
  });
  const collabPolicyEligible = !orcaMode && collabEntry.eligible;
  const collabPolicy = useCollabProjectPolicy(session?.workingDir, collabPolicyEligible, {
    workspaceKind: collabWorkspaceKind,
    // SSH 远端会话的 workingDir 是远端主机路径, 跳过项目级查询; 用户级/全局级 collab
    // 开关仍生效 (与 main 侧 remote 分支同口径)。
    skipQuery: collabEntry.skipProjectQuery,
    // device-link 会话:项目级开关的真相在被控端(那里 enable-orca 是本地会话, 走的正是
    // 本机项目级分支)。控制端拿被控端的路径查自己本机只会读到自己的用户级开关, 可能与
    // 被控端 main 的授权相反 —— 于是入口看着能点、真开时被拒(issue #1170)。
    deviceId: collabEntry.policyDeviceId ?? null,
  });
  const allowCollabToggle = !orcaMode && collabPolicyEligible;
  // 把 sessionId 抽出来给 useEffect 用 (linter 偏好稳定的标量依赖)
  const collabSessionId = sessionId;
  const collabProjectionLeadId = collabEnabled ? collabSessionId : undefined;
  useWorkerProjectionOwner(collabProjectionLeadId);
  const collabWorkerProjection = useWorkerProjection(collabProjectionLeadId);
  useEffect(() => {
    if (!collabProjectionLeadId) return;
    const activeWorker = collabWorkerProjection.workers[0]; // MVP: 假设最多 1 个 active Worker
    if (!activeWorker) return;
    // orca worker 创建面未开 pi;万一读到脏值也按 codex 收敛,不撑开 toggle 契约。
    const normalizedKind = normalizeDbAgentKind(activeWorker.agent);
    setCollabWorker(normalizedKind === 'cc' ? 'cc' : 'codex');
  }, [collabProjectionLeadId, collabWorkerProjection.workers]);

  // F-COLLAB: "外部触发" 协同状态变化时自动打开协同 tab (典型场景: MCP team
  // 工具, 未来也覆盖飞书等其它入口)。
  //
  // 手动 toggle 路径 (requestEnableCollab / useStopOrcaCollab) 自己已经
  // 同步打开 tab, effect 触发时 addOrFocusSingletonTab 会幂等聚焦已有 tab。
  // 用 ref 跟踪 prevCollabEnabled 只在边沿触发;已处于协同中的会话 mount 时由上方
  // 常驻 tab effect 打开协同 tab,这里不重复处理。
  // doc rail (isCompactRail) 完全跳过 — WorkdirBrowseRoute 已经按 orcaRole reactive
  // 自动切到 OrcaSplitView toggle 布局, 不需要 router-level navigate。
  const prevCollabEnabledRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevCollabEnabledRef.current === null) {
      prevCollabEnabledRef.current = collabEnabled;
      return;
    }
    const prev = prevCollabEnabledRef.current;
    prevCollabEnabledRef.current = collabEnabled;
    if (isCompactRail) return;
    if (!collabSessionId) return;

    // false → true 边沿:外部 MCP/team 刚开启协同，属于新的显式意图；即使该会话
    // 历史上收起过右栏，也应重新展开并聚焦协同 tab。mount 时 prev=null 已在上方返回。
    if (!prev && collabEnabled) {
      void revealOrcaWorkersTab(collabSessionId).catch((err) => {
        log.warn('revealOrcaWorkersTab after external enable failed', err);
      });
      return;
    }

    // true → false 边沿:关闭协同 tab;兼容 /orca 路由仍在场时, navigate 回单 session 路由。
    if (prev && !collabEnabled) {
      void closeOrcaWorkersTabAfterTeamEnd(collabSessionId).catch((err) => {
        log.warn('closeOrcaWorkersTabAfterTeamEnd failed', err);
      });
      if (isOrcaMode && ownsWindowRoute) {
        navigate(`/cc-agent/${collabSessionId}`, { replace: true });
      }
    }
  }, [collabEnabled, collabSessionId, isCompactRail, isOrcaMode, navigate, ownsWindowRoute]);

  // F-COLLAB: 关闭协同复用 useStopOrcaCollab hook(与 OrcaWorkflowRoute Worker pane × 同一份逻辑)。
  // navigate 触发条件:仅兼容 orca route 仍在场时需要跳回单 session 路由。
  // doc 模式 (isCompactRail=true) 下 OrcaSplitView 把 Lead pane 渲染为
  // <CCAgentSessionView ... orcaMode compact />,orcaMode 这里只是表"在 split-pane 里"的语义标,
  // 不能当 navigate 判据 —— 否则用户在 doc rail 的「+」菜单关闭协同会跳出 doc 模式。
  // disableOrca 后 lead.orcaRole 被清掉,WorkdirBrowseRoute 的 isOrcaLeadSession 自动 fallback
  // 到单 CCAgentSessionView,留在 doc 模式即可。
  const { requestStop: requestStopCollab } = useStopOrcaCollab({
    leadSessionId: collabSessionId,
    navigateOnSuccess: orcaMode && !isCompactRail,
  });

  // F-COLLAB: 开启协同 = 调 enableOrca IPC + (普通路由)打开右侧栏协同 tab。
  // doc 模式 (isCompactRail) 下不 navigate —— 留在 /cc-agent/files/<leadId>,
  // sessionsStore.forceRefresh 后 lead.orcaRole 翻成 'lead',WorkdirBrowseRoute 的
  // isOrcaLeadSession 检测到自动把 chat rail 切到 OrcaSplitView toggle 布局。
  // OrcaSplitView 没拿到 ?worker= 时会 fallback 用 listWorkersByLead 的第一个 worker
  // (MVP 假设最多 1 个 active Worker),所以 doc 模式不需要往 URL 写 worker search param。
  const requestEnableCollab = useCallback(
    async (form: CreateWorkerForm) => {
      if (!collabSessionId || enableBusy) return;
      setEnableBusy(true);
      const previousWorker = collabWorker;
      let workersTabOpened = false;
      const revealWorkersTab = !isCompactRail
        ? revealOrcaWorkersWithRetry({
            reveal: () => revealOrcaWorkersTab(collabSessionId),
          })
            .then((routeResult) => {
              workersTabOpened = didOpenOrcaWorkersTab(routeResult);
              if (routeResult === 'stale-context') {
                log.warn('revealOrcaWorkersTab remained stale after bounded retries', {
                  sessionId: collabSessionId,
                });
              }
            })
            .catch((err) => {
              log.warn('revealOrcaWorkersTab failed before enableOrca', err);
            })
        : Promise.resolve();
      try {
        const workerAgent = form.agent;
        const normalizedWorker = normalizeDbAgentKind(workerAgent);
        setCollabWorker(normalizedWorker === 'cc' ? 'cc' : 'codex');
        setCreateWorkerOpen(false);
        // 粘滞归属(codex review P2):入口与协同策略查询都按粘滞 remoteDeviceId 指向被控端,
        // mutation 必须同口径 —— 非粘滞的 makerApiFor 在 relay 瞬断窗口内会退回本机
        // enableOrca,在**控制端**建出一个 team(本机恰有同 id 会话时还会操作错对象)。
        const enableOptions = {
          workerAgent,
          role: form.role,
          label: createWorkerLabel(form.role, []),
          model: form.model,
          effort: form.effort as
            'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | undefined,
          fast: form.fast,
          // null(未显式选来源)不传字段:IPC 侧只认非空 string 为显式来源。
          providerId: form.providerId ?? undefined,
          delegateTask: form.initialTask || undefined,
          workerPermissionMode: form.workerPermissionMode,
        };
        const orcaDeviceId = getStickySessionDeviceId(collabSessionId);
        if (orcaDeviceId) {
          await enableRemoteCollabForSession({
            deviceId: orcaDeviceId,
            leadSessionId: collabSessionId,
            options: enableOptions,
            logTag: 'session enable collab',
          });
        } else {
          await window.electronAPI.maker.enableOrca(collabSessionId, enableOptions);
        }
        void sessionsStore.forceRefresh('active');
        // 远程会话:enableOrca 在被控端起了 worker session,先把该设备会话列表重拉进 store
        // (注册 worker sessionId),否则 orca split 视图按 ?worker= 加载会 404。
        // 归属同样取粘滞值:上面这次 enableOrca 已经按粘滞路由发到了被控端,这里若用非粘滞
        // 判定会在瞬断窗口内解析成 undefined、跳过回流,worker 永远进不了控制端注册表。
        if (orcaDeviceId) await refreshRemoteDeviceSessions(orcaDeviceId);
        await revealWorkersTab;
      } catch (err) {
        await revealWorkersTab;
        if (workersTabOpened) {
          void closeOrcaWorkersTabAfterTeamEnd(collabSessionId).catch((closeErr) => {
            log.warn('rollback closeOrcaWorkersTabAfterTeamEnd failed', closeErr);
          });
        }
        setCollabWorker(previousWorker);
        log.error('enableOrca failed', err);
        toast.error(
          getCollaborationStartErrorMessage(err, t, {
            remoteDevice: Boolean(remoteDeviceId),
          }),
        );
      } finally {
        setEnableBusy(false);
      }
    },
    [collabSessionId, collabWorker, enableBusy, isCompactRail, remoteDeviceId, t],
  );

  // "本次会话改动文件列表"已迁移到 RSB review tab(单一入口),原 SessionDiffPanel
  // 的 session-switch 重置 + Ctrl/Cmd+Shift+D 切换快捷键随之删除。若日后需要"跳到
  // review tab"的快捷键,应做成 RSB 的统一 tab 焦点切换,不在本变更范围内。

  // Refresh local serverSession after a mutation (model/effort/workingDir change).
  // 只更新本视图的 serverSession，绝不再"顺手 patch sidebar":
  // 服务端 GET 拿到的 row 可能落后于刚刚 emitPatch 的乐观值（典型场景：
  // handleWorkingDirChange 先 refreshServerSession 再 sendMessage —— 后者
  // 同步 emit { userSendAt: now } 到 sidebar，几十 ms 后 GET 回来的 row 还
  // 是 userSendAt: null，整段 spread 当 patch 派发会把 sidebar 已设的
  // userSendAt 擦回 null，session 被错判为草稿。
  // sidebar 关心的字段（workingDir / userSendAt / title）有各自的精确 emit
  // 路径，不需要这里的全量同步。
  const refreshServerSession = useCallback(async () => {
    if (!sessionId) return;
    const refreshSequence = sessionRefreshSequenceRef.current;
    const requestSequence = refreshSequence.begin(sessionId);
    // 旧 session 的异步 mutation 可能在切换视图后才调用这里；不要让它取消当前 GET。
    if (requestSequence === null) return;
    try {
      const refreshed = await sessionService.get(sessionId);
      if (refreshSequence.isLatest(sessionId, requestSequence)) {
        setServerSession(sessionSnapshotPatchBufferRef.current.merge(sessionId, refreshed));
      }
    } catch {
      // 保留当前 snapshot；后续 patch 或 refresh 仍可收敛。
    }
  }, [sessionId]);

  const handleFolderPickerOpenChange = useCallback((open: boolean) => {
    setFolderPickerOpen(open);
    // If user closed the popover without selecting, clear pending send
    if (!open) {
      pendingSendRef.current = null;
    }
  }, []);

  // F3: Model switch linkage — 切到不支持 Fast Mode 的模型时自动关闭。
  // Called AFTER server persist succeeds (ChatInput handles the server-first flow).
  // 是否支持来自 capabilities.hasFastMode + availableModels[].supportsFastMode, renderer 不再 startsWith 解析 id。
  const handleModelDidChange = useCallback(
    (newModelId: string) => {
      refreshServerSession();
      // contextWindow 仍取被控端能力(非 per-provider 概念)。
      const m = getModelById(newModelId, remoteDeviceId);
      if (sessionId) {
        makerChatStore.setContextWindow(sessionId, m?.contextWindow);
      }
      // fast 支持判定走统一 helper(per-provider,本地 + device-link 同口径);providerId 取该会话选中来源
      // (session.providerId,device-link 下镜像自被控端持久化值)。切到不支持 fast 的 (来源,模型) → 关掉。
      const supportsFast = resolveFastSupported({
        deviceId: remoteDeviceId,
        deviceProviders,
        localProviders,
        capabilities: sessionCaps,
        providerId: session?.providerId ?? null,
        modelId: newModelId,
        agentKind: dbToMakerAgentKind(session?.agentKind),
      });
      if (!supportsFast) {
        const currentFastMode = sessionId ? makerChatStore.getSnapshot(sessionId).fastMode : false;
        if (currentFastMode) {
          resetFastMode();
          toast.warning(t('ccAgent.layout.modelSwitchedFastModeOff'));
        }
      }
    },
    [
      sessionId,
      remoteDeviceId,
      deviceProviders,
      localProviders,
      sessionCaps,
      session?.providerId,
      session?.agentKind,
      resetFastMode,
      refreshServerSession,
      t,
    ],
  );

  // effort 已在 ChatInput 中落库成功；直接 merge 确切值回 SSoT，避免额外 GET
  // 读取到旧快照后把菜单选中态反向覆盖。ChatInput 不维护第二条 local state。
  const handleEffortDidChange = useCallback(
    (newEffort: Effort, sourceSessionId?: string, sourceRemoteDeviceId?: string) => {
      const targetSessionId = sourceSessionId ?? sessionId;
      const refreshSequence = sessionRefreshSequenceRef.current;
      // callback 自身也可能来自旧 render；必须对照最新 committed view 的当前 scope，
      // 不能只比较旧闭包里的 sessionId。
      if (!targetSessionId || !refreshSequence.isCurrentSession(targetSessionId)) return;
      // 远程会话由被控端 sessions:patched 镜像收敛；优先信任操作开始时捕获的稳定
      // device scope，relay origin 短暂缺失时也不能创建会盖住 remote store 的本地快照。
      if (sourceRemoteDeviceId || getSessionDeviceId(targetSessionId)) return;
      const patchBuffer = sessionSnapshotPatchBufferRef.current;
      patchBuffer.stage(targetSessionId, { effort: newEffort });
      const fullSnapshot = currentServerSessionRef.current;
      if (fullSnapshot) {
        // 已有完整 snapshot 时，任何在途 GET 都早于这个已确认写入，先失效再精确 merge。
        refreshSequence.invalidate(targetSessionId);
        setServerSession((prev) =>
          patchBuffer.merge(targetSessionId, prev?.id === targetSessionId ? prev : fullSnapshot),
        );
      } else {
        // 初始 GET 是唯一完整 row；保留请求并用暂存 effort 覆盖当前 list 派生值。
        bumpSessionPatchVersion((version) => version + 1);
        setServerSession((prev) =>
          prev?.id === targetSessionId ? patchBuffer.merge(targetSessionId, prev) : prev,
        );
      }
    },
    [sessionId],
  );

  const handlePermissionModeDidChange = useCallback(() => {
    refreshServerSession();
  }, [refreshServerSession]);

  // ─── Extra reference dirs(中途增删) ──────────────────────────────────────
  // 双 IPC 协调,跟 setModel 同模式:
  //   1. sessionService.update({ extraDirs }) → 落 DB(持久化)
  //   2. window.electronAPI.maker.setExtraDirs(sessionId, ...) → 推 closure
  //      (Claude / Codex 都在下一 turn 使用新值；session 已 close 时 no-op)
  //   3. refreshServerSession → 让本视图的 session.extraDirs 同步到最新值
  // 失败任一只 toast warn,不阻塞;乐观 UI 由 chip 数字角标已经反映。
  const handleExtraDirsChange = useCallback(
    async (next: string[]) => {
      if (!sessionId) return;
      // device-link 远程会话:被控端 row 不在本机库,sessionService.update 必抛(且 catch return
      // 会连带阻断后面的 setExtraDirs)。extraDirs 在 REMOTE_PERSIST_FIELDS → 被控端 set-extra-dirs
      // 经 dispatch persistRemoteSetting 落库 + 广播回流,所以远程只走 runtime 隧道、跳过本机 DB 写
      // (对齐 set-permission-mode 远程分支);本机会话保持 DB + runtime 双写。
      if (!getSessionDeviceId(sessionId)) {
        try {
          await sessionService.update(sessionId, { extraDirs: next });
        } catch (err) {
          log.warn('extraDirs DB update failed', err);
          toast.error('附加目录保存失败');
          return;
        }
      }
      try {
        await makerApiFor(sessionId).setExtraDirs(sessionId, next);
      } catch (err) {
        // 运行时推送失败不致命 — 下次 session 重启会从 DB 读新值。
        log.warn('extraDirs closure push failed (non-fatal)', err);
      }
      await refreshServerSession();
    },
    [sessionId, refreshServerSession],
  );

  // /issue 命令的 composer 附件不随命令 payload 走 main IPC 往返 —— AttachedFile 是
  // renderer 层类型(与 render/main 解耦一致),且发送后 composer 会 clearFiles。故在
  // dispatch 前于 renderer 侧快照,待 main 广播 DESKTOP_COMMAND_TRIGGERED 回流时取用。
  const pendingIssueFilesRef = useRef<AttachedFile[] | undefined>(undefined);

  const maybeDispatchDesktopSlashCommand = useCallback(
    async (
      message: string,
      files?: AttachedFile[],
      options?: {
        allowDesktopDispatch?: boolean;
        piRuntimeRetryDelaysMs?: readonly number[];
        workingDirOverride?: string;
        preparePiRuntime?: () => Promise<void>;
      },
    ): Promise<{ handled: boolean; accepted: boolean; message: string }> => {
      const slashMatch = message.match(/^\/(\S+)(?:\s+(.*))?$/s);
      const agentKind = dbToMakerAgentKind(session?.agentKind);
      const leading =
        !slashMatch && agentKind === 'pi' ? leadingSlashInvocation(message) : undefined;
      if (!slashMatch && !leading) return { handled: false, accepted: false, message };
      const cmdName = (slashMatch?.[1] ?? leading!.name).toLowerCase();
      const args = slashMatch?.[2] ?? '';
      const allowDesktopDispatch = options?.allowDesktopDispatch ?? true;
      const workingDir = options?.workingDirOverride ?? session?.workingDir;
      const cached = allCommandsRef.current;
      // A newly selected project changes command ownership, so do not let a
      // pre-selection global hit suppress the forced project catalog refresh.
      const commands = options?.workingDirOverride
        ? []
        : cached.length > 0
          ? cached
          : await getHelpCommandsSnapshot();
      const reconcileParams = {
        agentKind,
        sessionId: session?.id,
        commandName: cmdName,
        commands,
        reload: () =>
          loadAllCommands(
            agentKind,
            workingDir,
            {
              skipAgentSkills: isRemoteSession,
              sessionId: session?.id,
              forceReload: true,
            },
            remoteDeviceId,
          ),
      };
      const reconciled = options?.piRuntimeRetryDelaysMs
        ? await reconcilePiRuntimeCommandForDispatchWithRetry({
            ...reconcileParams,
            prepareRuntime: options.preparePiRuntime,
            retryDelaysMs: options.piRuntimeRetryDelaysMs,
          })
        : await reconcilePiRuntimeCommandForDispatch(reconcileParams);
      if (reconciled.commands !== commands) {
        allCommandsRef.current = reconciled.commands;
        setAllCommands(reconciled.commands);
      }
      const hit = reconciled.command;
      if (hit?.kind !== 'desktop') {
        return {
          handled: false,
          accepted: false,
          message:
            agentKind === 'pi' ? rewriteAgentSkillInvocationForDispatch(message, hit) : message,
        };
      }
      // Desktop commands stay `^/` only. A whitespace-prefixed `/help` is not a dispatch.
      if (!slashMatch) return { handled: false, accepted: false, message };
      if (!allowDesktopDispatch) return { handled: false, accepted: false, message };
      // Review is handed to Main immediately with this invocation's serialized
      // attachments. It must not depend on this React view remaining mounted,
      // nor share a mutable attachment ref with a later command.
      if (hit.name === 'review') {
        if (!sessionId) return { handled: true, accepted: false, message };
        if (remoteDeviceId || session?.remoteHostId) {
          // 轮 35 HIGH-2:SSH 远端会话同样不支持 /review —— 与 device-link 并列
          // 前置拦截, 避免命令进入 main 后被 UNSUPPORTED_CAPABILITY 拒绝。
          toast.warning(t('review.toast.remoteUnsupported'));
          return { handled: true, accepted: false, message };
        }
        const attachments = files?.length ? serializeAttachedFiles(files) : undefined;
        try {
          await window.electronAPI.maker.startReview({
            sourceSessionId: sessionId,
            ...(args.trim() ? { focus: args.trim() } : {}),
            ...(attachments?.length ? { attachments } : {}),
          });
          return { handled: true, accepted: true, message };
        } catch (err) {
          const ipcError = extractIpcError(err);
          toast.error(
            ipcError
              ? t('review.toast.failed')
              : err instanceof Error
                ? err.message
                : t('review.toast.failed'),
          );
          return { handled: true, accepted: false, message };
        }
      }
      // 仅 /issue 需要携带附件:snapshot 到 ref,DESKTOP_COMMAND_TRIGGERED 回流时消费。
      // 其它 desktop 命令(/help /clear /cmd ...)不涉及附件,不写 ref。
      if (hit.name === 'issue') {
        pendingIssueFilesRef.current = files && files.length > 0 ? files : undefined;
      }
      // device-link 远程会话:带上归属设备 id,main 侧 /goal /learn /cmd 据此把业务体
      // 经隧道路由到被控端执行(纯 UI 命令忽略该字段)。用视图的粘滞 remoteDeviceId
      // 而非现读快照:origin 注入 / 重连窗口内快照为 undefined,会误走本机路径
      // (/cmd 拿被控端路径本机 spawn、/goal /learn 在本机产生副作用;Codex review #548)。
      void dispatchCommand(hit, {
        ...(sessionId ? { sessionId } : {}),
        ...(workingDir ? { workingDir } : {}),
        ...(args ? { args } : {}),
        ...(remoteDeviceId ? { deviceId: remoteDeviceId } : {}),
      });
      return { handled: true, accepted: true, message };
    },
    [
      getHelpCommandsSnapshot,
      isRemoteSession,
      session?.agentKind,
      session?.id,
      session?.workingDir,
      sessionId,
      remoteDeviceId,
      t,
    ],
  );

  const handleWorkingDirChange = useCallback(
    (newDir: string | null) => {
      // ChatInput already persists workingDir to server; we just refresh our local copy.
      refreshServerSession();

      // Auto-continue: if there's a pending send and a valid dir was selected, execute step ③.
      // The first slash reconciliation ran before this directory existed, so refresh again with
      // the selected project before dispatching and keep inline metadata aligned with any alias rewrite.
      const pending = pendingSendRef.current;
      if (!newDir || !pending) return;
      pendingSendRef.current = null;
      void (async () => {
        try {
          const slashDispatch = await maybeDispatchDesktopSlashCommand(
            pending.message,
            pending.files,
            {
              allowDesktopDispatch: pending.deliveryMode !== 'steer',
              piRuntimeRetryDelaysMs: PI_RUNTIME_SKILL_RETRY_DELAYS_MS,
              workingDirOverride: newDir,
              preparePiRuntime: async () => {
                if (!sessionId || dbToMakerAgentKind(session?.agentKind) !== 'pi') return;
                const createOpts = {
                  id: sessionId,
                  ...buildCreateOptsForCurrentSession(
                    sessionId,
                    pending.model,
                    pending.effort,
                    pending.permissionMode,
                    newDir,
                    pending.vendorOptions ? { vendorOptions: pending.vendorOptions } : undefined,
                  ),
                  agentKind: 'pi' as const,
                  workingDir: newDir,
                  orcaRole: session?.orcaRole ?? null,
                };
                if (remoteDeviceId) {
                  await window.electronAPI.deviceLink.invoke(
                    remoteDeviceId,
                    'maker:create-session',
                    [createOpts],
                  );
                } else {
                  await window.electronAPI.maker.createSession(createOpts);
                }
              },
            },
          );
          if (slashDispatch.handled) {
            if (slashDispatch.accepted) {
              pending.onDeferredAccepted?.();
              const resumedSessionId = sessionId;
              if (resumedSessionId) {
                void dispatchDeferredUiAssignment(resumedSessionId, undefined, {
                  waitForLeadHistory: false,
                }).catch((err) => {
                  log.error('recover deferred Worker assignment after slash command failed', err);
                  toast.error(t('newChat.collaboration.assignmentFailed'));
                });
              }
            }
            return;
          }

          const pendingAgentReferences = pending.agentReferences
            ? rebaseInlineRangesAfterSlashCommandRewrite(
                pending.agentReferences,
                pending.message,
                slashDispatch.message,
              )
            : undefined;
          const pendingPastedTextRanges = pending.pastedTextRanges
            ? rebaseInlineRangesAfterSlashCommandRewrite(
                pending.pastedTextRanges,
                pending.message,
                slashDispatch.message,
              )
            : undefined;
          const pendingSlashCommandRanges =
            pending.slashCommandRanges !== undefined
              ? rebaseInlineRangesAfterSlashCommandRewrite(
                  pending.slashCommandRanges,
                  pending.message,
                  slashDispatch.message,
                )
              : undefined;
          const dispatch = pending.deliveryMode === 'steer' ? steerMessage : sendMessage;
          const followStartGeneration = readSendFollowCancelGeneration(sessionId);
          const accepted = await dispatch(
            slashDispatch.message,
            pending.model,
            pending.effort,
            pending.permissionMode,
            newDir,
            pending.files,
            pending.mentions,
            pending.quotesEncoded ||
              pending.vendorOptions !== undefined ||
              pendingAgentReferences?.length ||
              pendingPastedTextRanges?.length ||
              pendingSlashCommandRanges !== undefined ||
              pending.onRemoteOptimisticFailure !== undefined ||
              pending.onDeferredAccepted !== undefined
              ? {
                  ...(pending.vendorOptions ? { vendorOptions: pending.vendorOptions } : {}),
                  ...(pending.quotesEncoded ? { quotesEncoded: true } : {}),
                  ...(pendingAgentReferences?.length
                    ? { agentReferences: pendingAgentReferences }
                    : {}),
                  ...(pendingPastedTextRanges?.length
                    ? { pastedTextRanges: pendingPastedTextRanges }
                    : {}),
                  ...(pendingSlashCommandRanges !== undefined
                    ? { slashCommandRanges: pendingSlashCommandRanges }
                    : {}),
                  ...(pending.onRemoteOptimisticFailure
                    ? { onRemoteOptimisticFailure: pending.onRemoteOptimisticFailure }
                    : {}),
                  ...(pending.onDeferredAccepted
                    ? { onDeferredAccepted: pending.onDeferredAccepted }
                    : {}),
                }
              : undefined,
          );
          if (accepted) {
            pending.onDeferredAccepted?.();
            requestFollowLatest(sessionId, followStartGeneration);
            const resumedSessionId = sessionId;
            if (resumedSessionId) {
              void dispatchDeferredUiAssignment(resumedSessionId, undefined).catch((err) => {
                log.error('recover deferred Worker assignment after user message failed', err);
                toast.error(t('newChat.collaboration.assignmentFailed'));
              });
            }
          }
        } catch (error) {
          log.warn(
            'pending send after working directory selection failed:',
            error instanceof Error ? error.message : String(error),
          );
        }
      })();
    },
    [
      maybeDispatchDesktopSlashCommand,
      refreshServerSession,
      remoteDeviceId,
      session?.agentKind,
      session?.orcaRole,
      sessionId,
      requestFollowLatest,
      sendMessage,
      steerMessage,
    ],
  );

  const maybeShowContextUsage = useCallback(
    async (message: string): Promise<boolean> => {
      if (!/^\/context\s*$/i.test(message.trim())) return false;
      if (!sessionId) {
        insertSystemCard('context', { usage: null });
        return true;
      }
      if (session?.agentKind === 'codex') {
        insertSystemCard('context', {
          usage: null,
          error: t('chat.systemCard.context.unsupportedAgent', { agent: 'Codex' }),
        });
        return true;
      }
      const createOpts = session?.workingDir
        ? {
            agentKind: session.agentKind === 'pi' ? ('pi' as const) : ('claude-code' as const),
            workingDir: session.workingDir,
            model: session.model,
            orcaRole: session.orcaRole ?? null,
            effort: session.effort,
            fastMode,
            permissionMode: session.permissionMode,
            userPrompt: getUserPrompt(),
            // device-link executes on the target desktop, so let that runtime
            // own the setting. SSH remote follows the controller's global
            // setting like local sessions (memory scoped per hostId+remote
            // path on this machine, see maker-core buildMemoryScopeKey).
            ...(remoteDeviceId ? {} : { makerMemoryEnabled: getMakerMemoryEnabled() }),
            extraDirs: session.extraDirs ?? [],
            displayReasoning: 'summarized' as const,
            ...(session.remoteHostId ? { remoteHostId: session.remoteHostId } : {}),
            ...(session.sdkSessionId ? { resumeSessionId: session.sdkSessionId } : {}),
          }
        : undefined;
      const cardClientId = insertSystemCard('context', { usage: undefined });
      if (!cardClientId) return true;
      void makerApiFor(sessionId)
        .getContextUsage(sessionId, createOpts)
        .then((usage) => {
          updateSystemCardData(cardClientId, { usage });
        })
        .catch((err) => {
          const ipcError = extractIpcError(err);
          updateSystemCardData(cardClientId, {
            usage: null,
            error: ipcError?.message || (err instanceof Error ? err.message : String(err)),
          });
        });
      return true;
    },
    [fastMode, insertSystemCard, remoteDeviceId, session, sessionId, t, updateSystemCardData],
  );

  const handleSend = useCallback(
    async (
      message: string,
      model: string,
      effort: Effort,
      permissionMode: PermissionMode,
      files?: AttachedFile[],
      mentions?: MentionedResource[],
      opts?: {
        deliveryMode?: MessageDeliveryMode;
        quotesEncoded?: boolean;
        agentReferences?: AgentInputReference[];
        pastedTextRanges?: PastedTextRange[];
        slashCommandRanges?: SlashCommandRange[];
        onRemoteOptimisticFailure?: (clientId: string, error?: unknown) => void;
        onDeferredAccepted?: () => void;
      },
    ) => {
      const deliveryMode = opts?.deliveryMode ?? 'queue';
      const navigationRequestVersion =
        deliveryMode !== 'steer' && matchNavigationCommandName(message)
          ? ++sessionNavigationVersionRef.current
          : null;
      if (
        deliveryMode !== 'steer' &&
        (await tryHandleNavigationCommand(message, {
          navigate,
          t,
          allowNavigation: canNavigateSession,
          onSessionNavigate: navigationMode === 'split-pane' ? onSessionNavigate : undefined,
          isNavigationCurrent:
            navigationRequestVersion === null
              ? undefined
              : () => sessionNavigationVersionRef.current === navigationRequestVersion,
        }))
      ) {
        return;
      }

      if (deliveryMode !== 'steer' && (await maybeShowContextUsage(message))) {
        return;
      }

      // ── Slash command dispatch (palette refactor) ──
      // 三源 palette 命中:
      //   - desktop 命令(/help /clear ...) → executeDesktopCommand IPC,
      //     main 端 registry 跑 execute(), 副作用通过 DESKTOP_COMMAND_TRIGGERED
      //     广播回 renderer (上面 useEffect 订阅), 不发给 agent。
      //   - agent-builtin / agent-skill / 没命中任何已知命令 → 走默认 send,
      //     原文(含前导 `/`)直接送 agent, 由 SDK 自己识别 (/compact 等)。
      const originalMessage = message;
      const slashDispatch =
        deliveryMode === 'steer'
          ? await maybeDispatchDesktopSlashCommand(message, files, {
              allowDesktopDispatch: false,
              piRuntimeRetryDelaysMs: PI_RUNTIME_SKILL_RETRY_DELAYS_MS,
            })
          : await maybeDispatchDesktopSlashCommand(message, files, {
              piRuntimeRetryDelaysMs: PI_RUNTIME_SKILL_RETRY_DELAYS_MS,
            });
      if (slashDispatch.handled) {
        if (slashDispatch.accepted && sessionId) {
          void dispatchDeferredUiAssignment(sessionId, undefined, {
            waitForLeadHistory: false,
          }).catch((err) => {
            log.error('recover deferred Worker assignment after slash command failed', err);
            toast.error(t('newChat.collaboration.assignmentFailed'));
          });
        }
        return slashDispatch.accepted;
      }
      message = slashDispatch.message;
      if (message !== originalMessage && opts) {
        opts = {
          ...opts,
          ...(opts.agentReferences
            ? {
                agentReferences: rebaseInlineRangesAfterSlashCommandRewrite(
                  opts.agentReferences,
                  originalMessage,
                  message,
                ),
              }
            : {}),
          ...(opts.pastedTextRanges
            ? {
                pastedTextRanges: rebaseInlineRangesAfterSlashCommandRewrite(
                  opts.pastedTextRanges,
                  originalMessage,
                  message,
                ),
              }
            : {}),
          ...(opts.slashCommandRanges !== undefined
            ? {
                slashCommandRanges: rebaseInlineRangesAfterSlashCommandRewrite(
                  opts.slashCommandRanges,
                  originalMessage,
                  message,
                ),
              }
            : {}),
        };
      }

      // ① 本机会话维持既有 readiness gate。device-link 已建任务不把视图生命周期内
      // 的认证弹窗/导航闭包塞进 outbox：弱网时先建立稳定 clientId 的本地乐观消息，
      // 重连后由被控端 enqueue / steer 路径做权威校验。这样离开任务后旧 outbox 也不会
      // 再弹出旧页面的认证对话框或导航回旧路由。
      if (!remoteDeviceId) {
        const authVendor = displayAgentKind === 'pi' ? 'pi' : isCodex ? 'codex' : 'cc';
        const { proceed } = await vendorAuthGate.checkAndConfirm(authVendor, {
          // 已建会话:suspended 来源计入(停用不打断运行中会话,门禁只看凭证连接态,
          // PR #744 review 第十七轮)。
          existingSessionRoute: true,
        });
        if (!proceed) return false;
      }

      // Popover open → prevent re-entry
      if (folderPickerOpen) return false;
      // 会话交接尚未完成(建 worktree / 远程开协同)时不放行:否则新输入会插到
      // 草稿提交的首条之前,顺序倒置。
      if (sessionHandoffPreparing) return false;

      const orcaLeadVendorOptions =
        sessionId && session !== null && isOrcaLeadSession(session)
          ? { vendorOptions: { orcaRole: 'lead', orcaLeadSessionId: sessionId } }
          : undefined;

      // ② Working directory check
      if (!session?.workingDir) {
        pendingSendRef.current = {
          deliveryMode,
          message,
          model,
          effort,
          permissionMode,
          files,
          mentions,
          ...orcaLeadVendorOptions,
          ...(opts?.quotesEncoded ? { quotesEncoded: true } : {}),
          ...(opts?.agentReferences?.length ? { agentReferences: opts.agentReferences } : {}),
          ...(opts?.pastedTextRanges?.length ? { pastedTextRanges: opts.pastedTextRanges } : {}),
          ...(opts?.slashCommandRanges !== undefined
            ? { slashCommandRanges: opts.slashCommandRanges }
            : {}),
          ...(opts?.onRemoteOptimisticFailure
            ? { onRemoteOptimisticFailure: opts.onRemoteOptimisticFailure }
            : {}),
          ...(opts?.onDeferredAccepted ? { onDeferredAccepted: opts.onDeferredAccepted } : {}),
        };
        setFolderPickerOpen(true);
        return false;
      }

      // ③ Auto-unarchive: 在 archived session 中发消息视为"激活"——状态先落库到
      //    active，sidebar cell 立刻翻新（不再显示 Archive icon、菜单回到标准三件套）。
      //
      //    注意：ChatInput 现在会 await onSend，再根据 `result === false` 决定是否
      //    清空输入框；这个门禁失败或目录缺失时返回 false，就能保留用户已输入内容。
      //    这里仍采取"乐观本地翻状态 + 后台 PATCH + 广播 refresh"：
      //      a) 立刻 setServerSession + patchLocal → 本视图瞬时更新
      //      b) sessionService.update(...) 后台持久化
      //      c) PATCH 成功后 emitRefresh()，让 sidebar 那个独立 useCCSessions 实例重拉
      //         —— patchLocal 是 hook 实例级 state 不跨实例，sidebar filter='active'
      //         的列表里压根没这条 archived session，emitPatch 也无效，必须 refresh。
      if (sessionId && session?.status === 'archived') {
        setServerSession((prev) => (prev ? { ...prev, status: 'active' } : prev));
        patchLocalSession(sessionId, { status: 'active' });
        sessionService
          .setStatus(sessionId, 'active')
          .then(() => emitRefresh())
          .catch((err) => {
            log.error('[auto-unarchive on send]', err);
            // 不回滚 message 已在路上；下次 refresh 由服务端真值兜底
          });
      }

      // ④ Execute send — effort + permissionMode came straight from ChatInput (fresh value)
      const sendOptions = {
        ...orcaLeadVendorOptions,
        ...(opts?.quotesEncoded ? { quotesEncoded: true } : {}),
        ...(opts?.agentReferences?.length ? { agentReferences: opts.agentReferences } : {}),
        ...(opts?.pastedTextRanges?.length ? { pastedTextRanges: opts.pastedTextRanges } : {}),
        ...(opts?.slashCommandRanges !== undefined
          ? { slashCommandRanges: opts.slashCommandRanges }
          : {}),
        ...(opts?.onRemoteOptimisticFailure
          ? { onRemoteOptimisticFailure: opts.onRemoteOptimisticFailure }
          : {}),
        ...(opts?.onDeferredAccepted ? { onDeferredAccepted: opts.onDeferredAccepted } : {}),
      };
      if (deliveryMode === 'steer') {
        const followStartGeneration = readSendFollowCancelGeneration(sessionId);
        const accepted = await steerMessage(
          message,
          model,
          effort,
          permissionMode,
          session.workingDir,
          files,
          mentions,
          sendOptions,
        );
        if (accepted && sessionId) {
          requestFollowLatest(sessionId, followStartGeneration);
          void dispatchDeferredUiAssignment(sessionId, undefined).catch((err) => {
            log.error('recover deferred Worker assignment after user message failed', err);
            toast.error(t('newChat.collaboration.assignmentFailed'));
          });
        }
        return accepted;
      }
      const followStartGeneration = readSendFollowCancelGeneration(sessionId);
      const accepted = await sendMessage(
        message,
        model,
        effort,
        permissionMode,
        session.workingDir,
        files,
        mentions,
        sendOptions,
      );
      if (accepted && sessionId) {
        requestFollowLatest(sessionId, followStartGeneration);
        void dispatchDeferredUiAssignment(sessionId, undefined).catch((err) => {
          log.error('recover deferred Worker assignment after user message failed', err);
          toast.error(t('newChat.collaboration.assignmentFailed'));
        });
      }
      return accepted;
    },
    [
      maybeDispatchDesktopSlashCommand,
      maybeShowContextUsage,
      folderPickerOpen,
      isCodex,
      canNavigateSession,
      navigationMode,
      onSessionNavigate,
      patchLocalSession,
      sendMessage,
      steerMessage,
      requestFollowLatest,
      navigate,
      session,
      sessionId,
      t,
      vendorAuthGate,
      remoteDeviceId,
      sessionHandoffPreparing,
    ],
  );

  const handleStopSession = useCallback(() => {
    if (remoteSessionUnavailable) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    stopSession();
  }, [remoteSessionUnavailable, stopSession, t]);

  // ── Context ring click → confirm → silent compact ──
  // 仅 Claude 会话开放(codex 协议没有手动 compact 入口,见 codex/translator.ts
  // contextCompaction 注释)。确认后走 main 侧 silent compact intent:不插入用户
  // `/compact` 气泡,只等待 SDK 的 compact_boundary 事件渲染分割线。
  // /issue → 向当前会话注入整理指令,由 agent 对话式收集细节后调 submit_github_issue
  // 工具提交(提交前 main 弹确认卡片)。独立于上面的 desktop 命令 effect:它依赖
  // handleSend(声明在前一个 effect 之后),且守卫更严 —— 必须精确命中本视图的
  // sessionId,防止多视图(orca split / 多窗口)同时挂载时重复发送。
  useEffect(() => {
    const unsub = window.electronAPI.maker.onDesktopCommandTriggered((payload) => {
      if (payload.command !== 'issue') return;
      if (!payload.sessionId || payload.sessionId !== sessionId || !session) return;
      const details = payload.args?.trim()
        ? t('issueAgent.command.detailsPrefix', { details: payload.args.trim() })
        : '';
      // 取回该 /issue 命令 dispatch 前 snapshot 的 composer 附件,连同整理指令一起
      // 发给 agent(取用即清,避免污染下一次 /issue)。见 pendingIssueFilesRef 定义处。
      const issueFiles = pendingIssueFilesRef.current;
      pendingIssueFilesRef.current = undefined;
      void handleSend(
        t('issueAgent.command.instruction', { details }),
        session.model,
        session.effort as Effort,
        session.permissionMode as PermissionMode,
        issueFiles,
      );
    });
    return unsub;
  }, [sessionId, session, handleSend, t]);

  const { confirm: confirmDialog } = useConfirmDialog();
  // 防双击重入:ConfirmDialogProvider 是队列语义,弹窗 mount 前的连续点击会入队
  // 多个 confirm,逐个确认就会发多次 compact 请求。锁按 sessionId 隔离:A 的长请求不
  // 阻塞切换后的 B，A 的迟到 finally 也不能清掉 B 的锁。
  const compactRequestGuardRef = useRef<SessionScopedRequestGuard | null>(null);
  if (!compactRequestGuardRef.current) {
    compactRequestGuardRef.current = createSessionScopedRequestGuard();
  }
  const compactRequestGuard = compactRequestGuardRef.current;
  // commit 阶段切换当前会话:中断 render 不应提前作废旧视图请求；layout effect 又早于用户
  // 交互与异步回调。setup 也要重写 sessionId，确保 React StrictMode 的 setup→cleanup→setup
  // 重放后不会停在 null。
  useLayoutEffect(() => {
    const committedSessionId = sessionId ?? null;
    compactRequestGuard.setCurrentSession(committedSessionId);
    return () => {
      // session 变更 / 路由离开 / 登出后旧请求的确认结果与迟到响应立即失效。
      if (committedSessionId && compactRequestGuard.isCurrent(committedSessionId)) {
        compactRequestGuard.setCurrentSession(null);
      }
    };
  }, [compactRequestGuard, sessionId]);
  const handleCompactRequest = useCallback(async () => {
    const sourceSession = session;
    if (!sourceSession) return;
    // 必须在第一个 await 前捕获 scope/channel。确认框打开期间路由切换时，旧闭包不得
    // 从可变 ref 读取到新 sessionId 后把旧请求误认成当前请求。
    const sourceSessionId = sourceSession.id;
    const sourceCompactChannel = compactChannel;
    // 无通道(Codex 等)不弹确认框;workingDir 只对 claude-input 是硬前提——
    // compact-session(pi 原生压缩)不依赖 workingDir,不能被它挡掉(copilot review)。
    if (sourceCompactChannel === null) return;
    if (sourceCompactChannel === 'claude-input' && !sourceSession.workingDir) return;
    const begun = compactRequestGuard.tryBegin(sourceSessionId);
    if (!begun) return;
    try {
      const contextWindow = resolveDisplayContextWindow({
        sdkContextWindow: agentStatus.contextWindow,
        modelContextWindow: getModelContextWindow(
          sourceSession.model,
          sourceSession.agentKind ?? 'cc',
          remoteDeviceId,
        ),
      });
      const used = Math.min(agentStatus.contextTokens, contextWindow || Infinity);
      const pct = contextWindow > 0 ? Math.round((used / contextWindow) * 100) : 0;
      const ok = await confirmDialog({
        title: t('ccAgent.layout.contextRing.confirmTitle'),
        description: t('ccAgent.layout.contextRing.confirmDescription', {
          used: formatTokenCount(used),
          total: formatTokenCount(contextWindow),
          pct,
        }),
        confirmText: t('ccAgent.layout.contextRing.confirmAction'),
        cancelText: t('ccAgent.layout.contextRing.confirmCancel'),
      });
      // 代校验:sessionId 当前 + 请求代一致——切走再切回(换代)后旧请求不再生效
      // (greptile P1:否则旧确认结果/迟到 toast 会在重新进入的视图里弹)。
      if (!ok || !compactRequestGuard.isCurrent(sourceSessionId, begun.epoch)) return;
      // 确认框打开期间，同一会话可能已在其它窗口 / 远程控制器被切换 agent(sessionId
      // 不变):捕获的 sourceCompactChannel 已过期。必须读**最新** channel —— 从
      // compactChannelRef.current 取(useCallback 闭包固定捕获旧值,重新 render 也不影响
      // 正在 await 的旧 async 函数;ref 每次 render 同步,这里拿到的是切换后的通道)。
      // 否则 Pi→Claude 会静默 null、Claude→Pi 会误走 claude 专用通道(codex P1 / greptile)。
      const channelNow = compactChannelRef.current;
      if (channelNow === null) return;
      // 确认框期间 turn 可能已从其它窗口 / 远程启动:render 时的 isRunning 守卫已失效,
      // 重读最新 running——活跃 turn 的 pi 会拒绝压缩,直接放弃,避免 confirm 后吃
      // rejection toast(codex P2)。claude-input 保留旧行为。
      if (channelNow === 'compact-session' && isRunningRef.current) return;
      if (channelNow === 'compact-session') {
        // capability-aware 通道(pi 原生 compact):本地 IPC / device-link 隧道均可路由。
        // 用粘滞归属(makerApiForSticky)——relay 瞬时重连清空 origin 的窗口内仍隧道到
        // 被控端,不退回控制端本机(本机无该 live 会话,固定调本机必 null 静默失败,
        // greptile P1)。claude-code 分支继续走 inputCoordinator,不在此通道内。
        // pi 原生压缩不依赖 workingDir,这里不再校验(copilot review)。
        const maker = makerApiForSticky(sourceSessionId);
        try {
          const result = await maker.compactSession(sourceSessionId);
          // 在途期间切换会话 / 登出 / 切回(换代):旧响应不得在当前视图弹 toast。
          if (!compactRequestGuard.isCurrent(sourceSessionId, begun.epoch)) return;
          if (result?.noop) {
            // 良性:上下文太小,无可压缩内容。信息性提示,不是失败。
            toast.info(t('ccAgent.sidebar.sessionMenu.compactNothing'));
          } else if (result) {
            toast.success(t('ccAgent.sidebar.sessionMenu.compactSuccess'));
          }
          // null:会话无 live 进程 / 不支持(入口已按 gate 隐藏,极少走到)。静默即可。
        } catch (err) {
          if (!compactRequestGuard.isCurrent(sourceSessionId, begun.epoch)) return;
          // 失败给可理解提示,不泄漏裸 IPC 错误。
          log.warn('context ring compact-session failed', err);
          toast.warning(t('ccAgent.sidebar.sessionMenu.compactFailed'));
        }
        return;
      }
      // 真实 Claude Code:输入协调器的 maker:input:compact(旧行为不变)。
      if (channelNow !== 'claude-input') return;
      // 参数必须用**最新** session 快照(与 channel 同源):同会话切换 agent 后
      // model/effort/permissionMode/workingDir 已变化,旧快照会按错误配置执行压缩,
      // 且旧快照 workingDir 缺失时会在用户确认后静默放弃(greptile P1 / codex P2)。
      const sessionNow = sessionRef.current;
      if (!sessionNow?.workingDir) return; // claude 通道硬前提:输入协调器需要工作目录
      await compactSession(
        sessionNow.model,
        sessionNow.effort as Effort,
        sessionNow.permissionMode as PermissionMode,
        sessionNow.workingDir,
      );
    } finally {
      begun.release();
    }
  }, [
    agentStatus.contextTokens,
    agentStatus.contextWindow,
    compactChannel,
    compactRequestGuard,
    compactSession,
    confirmDialog,
    remoteDeviceId,
    session,
    t,
  ]);

  const handleBeforeVoiceInputStart = useCallback(async () => {
    const { proceed } = await vendorAuthGate.checkAndConfirm('codex', { purpose: 'voice-input' });
    return proceed;
  }, [vendorAuthGate]);

  // M32: Retry — ErrorBanner 的 retryText 现在只是兼容展示值。真正的
  // recovery target 由 main coordinator 持有，避免把已发出的文本重新走普通
  // send 路径并排到队尾。
  // interrupted-turn-resume:main 判定失败 turn 已有 assistant 产出时,会用隐藏的
  // 规范化续跑指令(CONTINUE_AFTER_ERROR_PROMPT)替代重发原文;零产出仍重发原文。
  // 判定与文案都在 main(规则 9),renderer 只发意图。
  // Retry / silent-stop 继续都**不在这里 ack 红点**(PR #879 review P1):点击时就清点
  // 会在恢复失败(retry 被拒 / 续跑入队失败)时留下
  // 「横幅还在、红点没了」,而 live-only 的错误没有任何重算能把它恢复。
  // 成功路径已经有更可靠的收敛点:turn 真正跑起来 → store 清掉终止错误 →
  // useSessionRunningStatus 在 running 上升沿把 orphan 的 error 角标 explicit 清掉。
  // 失败路径则天然保留红点,与仍在展示的横幅一致。
  const handleRetry = useCallback(() => {
    void rebuildClaudeSubscriptionSessionBeforeRetry(errorReason)
      .then(() => retryLastError())
      .catch((error) => {
        log.warn('retryLastError failed', error);
      });
  }, [errorReason, rebuildClaudeSubscriptionSessionBeforeRetry, retryLastError]);

  const handleSwitchToClaudeSubscription = useCallback(async (): Promise<void> => {
    if (!sessionId || !session || !canSwitchToClaudeSubscription) return;
    const model = session.model;
    const previousProviderId = session.providerId ?? null;

    await window.electronAPI.maker.setModel(sessionId, model, 'anthropic');
    try {
      await sessionService.update(sessionId, {
        model,
        providerId: 'anthropic',
      });
    } catch (error) {
      // runtime route 已先切换；若持久化失败就回滚，避免当前进程与 DB 对同一会话
      // 产生两个 provider 真源。
      await window.electronAPI.maker
        .setModel(sessionId, model, previousProviderId)
        .catch((rollbackError) => {
          log.warn('Claude subscription recovery rollback failed', rollbackError);
        });
      throw error;
    }

    await refreshServerSession();
    await retryLastError();
  }, [canSwitchToClaudeSubscription, refreshServerSession, retryLastError, session, sessionId]);

  const handleSilentStopContinue = useCallback(() => {
    continueAfterSilentStop();
  }, [continueAfterSilentStop]);

  const handleContinueAfterUsageReset = useCallback(() => {
    if (!sessionId || !usageLimitRecovery || remoteDeviceId) return;
    const requestId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${sessionId}:${Date.now()}`;
    navigate('/cc-agent/scheduled', {
      state: usageLimitScheduleNavigationState({
        kind: 'usage-limit-recovery',
        requestId,
        sessionId,
        agentKind:
          session?.agentKind === 'codex' || session?.agentKind === 'pi'
            ? session.agentKind
            : 'claude-code',
        resetAtMs: usageLimitRecovery.resetAtMs,
      }),
    });
  }, [navigate, remoteDeviceId, session?.agentKind, sessionId, usageLimitRecovery]);

  // 点击 Cancel 关闭报错 banner 同样是处置(用户选择不管它了)。
  const handleDismissError = useCallback(() => {
    if (sessionId) ackErrorAlertHandled(sessionId);
    clearError();
  }, [clearError, sessionId]);

  const handleForkStripEncrypted = useCallback(async () => {
    if (!sessionId || session?.agentKind !== 'codex') return;
    if (!canNavigateSession) {
      log.info('encrypted-session fork ignored by embedded sidebar view', { sessionId });
      return;
    }
    const forkStripNavigationVersion = ++sessionNavigationVersionRef.current;
    setForkStripEncryptedRunning(true);
    try {
      const newSession = await sessionService.forkStripEncrypted(sessionId);
      await refreshServerSession();
      // 远程会话:新会话在被控端,先重拉该设备会话列表注册新 sessionId 再 navigate(否则 404)。
      const deviceId = getSessionDeviceId(sessionId);
      if (deviceId) await refreshRemoteDeviceSessions(deviceId);
      if (sessionNavigationVersionRef.current !== forkStripNavigationVersion) return;
      onSessionNavigate?.(newSession.id, newSession.id);
      navigate(`/cc-agent/${newSession.id}`);
    } catch (err) {
      const ipcError = extractIpcError(err);
      const detail = ipcError?.message || (err instanceof Error ? err.message : String(err));
      toast.error(
        isCodexResumeNotReadyProjectionError(detail)
          ? t('chat.errorBanner.codexResumeNotReady')
          : ipcError?.code === 'FORK_UNSUPPORTED_HISTORY'
            ? t('chat.userMessage.forkErrors.unsupportedHistory')
            : detail,
      );
    } finally {
      setForkStripEncryptedRunning(false);
    }
  }, [
    canNavigateSession,
    navigate,
    onSessionNavigate,
    refreshServerSession,
    session?.agentKind,
    sessionId,
    t,
  ]);

  // M35: Vendor fallback —— 会话的 model 与它(固定不变的)agent vendor 明确错配时,
  // 回退到该 vendor 的默认模型。守的是「绕过模型选择器写入 session.model」的脏数据路径
  // (历史 DB 行 / 上古 model id),选择器主动选择的 happy path 由 provider 逻辑自己保证一致。
  //
  // 判定走 **live provider 目录(useProviders,按 agent 维度)**,与选择器同源 —— 不再走
  // maker-core 冻结快照(getModelsForVendor / getModelById)。后者把 cc/codex 压平 + first-wins
  // 去重、且不含自定义供应商,造成两类误判:
  //   - `gpt-5.4` 等两端同名 id 被 cc 抢走 → 在 codex 会话里误判跨 vendor;
  //   - 自定义(mimo 等)codex 模型冻结表里没有 → 误判非法 → reset 成 gpt(本次修复的 bug)。
  // 判定语义见 shouldFallbackVendorModel:仅当 model 明确属于另一 vendor 才回退;两端都不认识
  // (别名 / 脏数据 / 目录未加载的瞬间)一律不动,避免 load race 误杀。cc / codex 统一这一套。
  const sessionAgentKind = session?.agentKind;
  const sessionModel = session?.model;
  useEffect(() => {
    if (!sessionAgentKind || !sessionModel || !sessionId) return;
    // device-link 远程会话:vendor↔model 一致性由被控端权威保证。控制端不能替它"纠正"——
    // 远程模型可能只存在于被控端(本地目录查不到 → 误判跨 vendor),且本地 DB 没有该会话行,
    // sessionService.update 会写错 / refreshServerSession 对远程是 no-op。直接跳过(规则:host 为准)。
    if (getSessionDeviceId(sessionId)) return;
    const agent = displayAgentKind;
    if (!shouldFallbackVendorModel(providers, sessionModel, agent)) return;
    // 用三值化后的 agent 映射选默认模型:Pi 会话必须回退到 Pi 目录默认,而不是被
    // `isCodex ? 'codex' : 'cc'` 误写成 CC 首选(可能是更贵的 Opus)(codex review)。
    const defaultModel = getDefaultModelForVendor(
      agent === 'pi' ? 'pi' : agent === 'codex' ? 'codex' : 'cc',
    );
    sessionService
      .update(sessionId, { model: defaultModel.id })
      .then(() => refreshServerSession())
      .catch((err) => log.warn('vendor fallback patch failed:', err));
  }, [
    displayAgentKind,
    providers,
    refreshServerSession,
    sessionAgentKind,
    sessionId,
    sessionModel,
  ]);

  // 远程协同交接被 app 关闭打断时的兜底:把上次没能发出去的正文回填到输入框。
  // 只回填、不自动补发(理由见 pendingFirstMessage 的「可恢复副本」注释)。
  // 内存里还有 pending 时不该走这里 —— 那是正常交接,由下面的消费逻辑负责。
  const handoffRestoredRef = useRef<string | null>(null);
  const restoreRecoverableHandoff = useCallback(
    (kind: RecoverableHandoffKind) => {
      if (!sessionId) return;
      const restoreKey = `${sessionId}:${kind}`;
      if (handoffRestoredRef.current === restoreKey) return;
      // 输入框已经有内容时不动它:用户自己敲的东西优先级永远高于恢复。
      // 此时**不取走**副本,留给下一次输入框为空时再回填 —— 宁可晚一点恢复,
      // 也不能为了恢复把用户正在写的东西覆盖掉。
      if (getComposerDraftPresence(sessionId)) return;
      const text = takeRecoverableHandoff(sessionId, kind);
      if (text === null) return;
      handoffRestoredRef.current = restoreKey;
      // 非 silent:挂载中的 ChatInput 要靠这次 notify 把正文 setContent 进编辑器
      // (与 rewind / fork 预填同一条既有通道)。
      saveComposerDraft(sessionId, { text: plainTextToTiptapDoc(text), attachments: [] });
      toast.info(
        kind === 'goal'
          ? t('newChat.collaboration.handoffRecoveredGoal')
          : t('newChat.collaboration.handoffRecoveredMessage'),
      );
    },
    [sessionId, t],
  );

  // delayed-create:从 NewMakerDraftRoute 经 navigate 进来的首条消息,在 session
  // 完全 hydrate(historyLoaded + workingDir 就位)后自动 sendMessage。
  // 一次性消费 + ref guard,防 StrictMode 双 mount / 重渲染时重复发送。
  const pendingConsumedRef = useRef(false);
  useEffect(() => {
    if (!sessionId || !historyLoaded || !session) return;
    const workingDir = session.workingDir;
    if (!workingDir) return;
    if (pendingConsumedRef.current) return;
    const pending = consumePending(sessionId);
    if (!pending) {
      // 内存里没有 pending:可能本来就没有,也可能上次协同等待期间 app 被关掉了。
      restoreRecoverableHandoff('message');
      return;
    }
    pendingConsumedRef.current = true;
    void (async () => {
      let deferredUiAssignment = pending.deferredUiAssignment;
      // device-link 草稿开了协同:先把协同开起来,再发首轮 —— 否则 Lead 的第一个 turn
      // 拿不到 cindy_orca 工具。等待放在这里而不是 draft route,是为了不让「对端会话已
      // 建好、用户输入还只在内存里」的窗口跟着一次可能 30s 的隧道往返一起变长(见
      // remoteCollabHandoff 文件头)。开不起来时如实提示并照单会话继续。
      // 副本已在草稿路由登记 pending 的同一刻落下(见那里的注释),这里不再重复落 ——
      // 落在这里等于要求 effect 先跑起来,而这条 effect 要等 historyLoaded。
      //
      // 锁要覆盖**整条交接**(消费 pending → 首轮发出),不能只包住开协同那段 await:
      // 解锁后到 sendMessage 之间还有一次 await(命令派发),那个窗口里用户补发的消息
      // 会抢在草稿提交的首条之前。远程交接才上锁 —— 本机交接没有远程等待。
      const holdComposer = !!pending.remoteCollab;
      if (holdComposer) setRemoteHandoffPreparing(true);
      try {
        if (pending.remoteCollab) {
          const remoteCollab = await consumePendingRemoteCollab(pending.remoteCollab, {
            leadSessionId: sessionId,
            logTag: 'pending first message',
            onFailed: (err) =>
              toast.error(
                getCollaborationStartErrorMessage(err, t, {
                  remoteDevice: true,
                  continueAsSingleSession: true,
                }),
              ),
            onAssignmentUnconfirmed: () => toast.error(t('newChat.collaboration.assignmentFailed')),
          });
          if (remoteCollab.ok) {
            deferredUiAssignment = remoteCollab.deferredUiAssignment;
            void sessionsStore.forceRefresh('active');
            void revealOrcaWorkersTab(sessionId).catch((revealErr) => {
              log.warn('revealOrcaWorkersTab after pending collab failed', revealErr);
            });
          }
        }
        // 三处交接统一走 deliverRecoverableHandoff:交付成功才丢副本,
        // resolve false / 抛错都保留(见该函数注释)。
        let pendingText = pending.text;
        const slashDispatch = await maybeDispatchDesktopSlashCommand(pending.text, pending.files, {
          piRuntimeRetryDelaysMs: PI_RUNTIME_SKILL_RETRY_DELAYS_MS,
        });
        pendingText = slashDispatch.message;
        if (slashDispatch.handled) {
          if (!slashDispatch.accepted) {
            // NewMaker 已把源草稿移交并清空；Main 没受理 `/review` 时，把正文和附件
            // 一起放回新会话输入框。复用失败发送的 FIFO 恢复器，避免覆盖用户在
            // IPC 等待期间已经输入的新内容。恢复成功后 composer/draft 已成为新的
            // 可靠归宿，旧交接副本必须消费，避免下次空输入框再次恢复过期命令。
            restoreRemoteOptimisticDraft(sessionId, {
              clientId: `pending-review:${pending.createdAt}`,
              text: plainTextToTiptapDoc(pending.text),
              attachments: pending.files ?? [],
              browserComments: [],
            });
          }
          await deliverRecoverableHandoff(sessionId, () => true);
          if (slashDispatch.accepted) {
            void dispatchDeferredUiAssignment(sessionId, deferredUiAssignment, {
              // Desktop slash commands are consumed by their own handlers and intentionally do
              // not create a normal Lead user-history row. The command's accepted result is the
              // ordering boundary for the independent Worker assignment.
              waitForLeadHistory: false,
            }).catch((err) => {
              log.error('deferred Worker assignment after slash command failed', err);
              toast.error(t('newChat.collaboration.assignmentFailed'));
            });
          } else if (deferredUiAssignment) {
            toast.error(t('newChat.collaboration.assignmentFailed'));
          }
          return;
        }
        const pendingAgentReferences = pending.agentReferences
          ? rebaseInlineRangesAfterSlashCommandRewrite(
              pending.agentReferences,
              pending.text,
              pendingText,
            )
          : undefined;
        const pendingPastedTextRanges = pending.pastedTextRanges
          ? rebaseInlineRangesAfterSlashCommandRewrite(
              pending.pastedTextRanges,
              pending.text,
              pendingText,
            )
          : undefined;
        const pendingSlashCommandRanges =
          pending.slashCommandRanges !== undefined
            ? rebaseInlineRangesAfterSlashCommandRewrite(
                pending.slashCommandRanges,
                pending.text,
                pendingText,
              )
            : undefined;
        // 必须 await:sendMessage 在设备离线 / 访问被撤销 / 远端 enqueue 拒绝时不抛错,
        // 而是 resolve false —— 不等它就丢副本,正文会从界面和磁盘上一起消失(codex P1)。
        const followStartGeneration = readSendFollowCancelGeneration(sessionId);
        const delivered = await deliverRecoverableHandoff(sessionId, () =>
          sendMessage(
            pendingText,
            session.model,
            session.effort as Effort,
            session.permissionMode as PermissionMode,
            workingDir,
            pending.files,
            pending.mentions,
            pending.vendorOptions ||
              pending.quotesEncoded ||
              pendingAgentReferences?.length ||
              pendingPastedTextRanges?.length ||
              pendingSlashCommandRanges !== undefined
              ? {
                  ...(pending.vendorOptions ? { vendorOptions: pending.vendorOptions } : {}),
                  ...(pending.quotesEncoded ? { quotesEncoded: true } : {}),
                  ...(pendingAgentReferences?.length
                    ? { agentReferences: pendingAgentReferences }
                    : {}),
                  ...(pendingPastedTextRanges?.length
                    ? { pastedTextRanges: pendingPastedTextRanges }
                    : {}),
                  ...(pendingSlashCommandRanges !== undefined
                    ? { slashCommandRanges: pendingSlashCommandRanges }
                    : {}),
                }
              : undefined,
          ),
        );
        if (delivered) {
          requestFollowLatest(sessionId, followStartGeneration);
          void dispatchDeferredUiAssignment(sessionId, deferredUiAssignment).catch((err) => {
            log.error('deferred Worker assignment after first message failed', err);
            toast.error(t('newChat.collaboration.assignmentFailed'));
          });
        } else if (deferredUiAssignment) {
          toast.error(t('newChat.collaboration.assignmentFailed'));
        }
      } finally {
        if (holdComposer) setRemoteHandoffPreparing(false);
      }
    })();
  }, [
    historyLoaded,
    maybeDispatchDesktopSlashCommand,
    restoreRecoverableHandoff,
    requestFollowLatest,
    sendMessage,
    session,
    sessionId,
  ]);

  // 远程草稿「新建目标」交接:draft route 只建会话 + 登记 pendingGoal,goal 首轮
  // 在这里起(机制说明见 pendingFirstMessage.ts)。视图引擎的 subscribeHeavy 是
  // fire-and-forget,mount ≠ 被控端已注册订阅 —— 消费前再显式 await 一次
  // deviceLink.subscribe(session:<id>)拿注册 ack(refcount 按 windowId 记集合,
  // 同窗口重复 subscribe 幂等且「总是转发」,await 到 resolve 即被控端登记完成;
  // 不配对 unsubscribe —— 订阅生命周期归视图引擎,拆多了会把它的订阅一起退掉),
  // 之后才起 goal 首轮,首条 maker:event/status 推送必有订阅者(Codex review #548 ×2)。
  // goalApiFor 按会话来源路由,本机会话无订阅语义直接 setGoal。
  const pendingGoalConsumedRef = useRef(false);
  useEffect(() => {
    if (!sessionId || !historyLoaded) return;
    if (pendingGoalConsumedRef.current) return;
    const pendingGoal = consumePendingGoal(sessionId);
    if (!pendingGoal) {
      // 与首条消息同款兜底:上次目标没起成(app 被关 / setGoal 失败)时把目标正文捞回来。
      restoreRecoverableHandoff('goal');
      return;
    }
    pendingGoalConsumedRef.current = true;
    void (async () => {
      let deferredUiAssignment: DeferredUiAssignment | undefined;
      // 锁必须覆盖**从消费 pendingGoal 到 setGoal 结束**的全程,不能只包住开协同那段:
      // 前面的 subscribe 与后面的 setGoal 同样是隧道 invoke、同样可能走到 30s 超时,
      // 锁在它们之外的话,这两个窗口里用户补发的消息会抢在目标首轮之前跑
      // (codex P2 第四轮)。pendingGoal 只有远程草稿会登记,所以无条件上锁。
      setRemoteHandoffPreparing(true);
      try {
        // 归属必须走**粘滞**解析:relay 瞬断会 clear 掉 remoteProjectsStore 的注册表,
        // 非粘滞版此刻返回 undefined → 跳过订阅;而下面的 goalApiFor 走的是粘滞归属,
        // setGoal 照样发到被控端 —— 于是目标首轮的 maker:event/status 推送落在
        // 没有订阅者的窗口里(greptile P1)。这正是本 PR 不变量 #3 的一处漏网。
        const deviceId = getStickySessionDeviceId(sessionId);
        if (deviceId) {
          await window.electronAPI.deviceLink.subscribe(deviceId, [`session:${sessionId}`]);
        }
        // 与首条消息同款:目标首轮同样要排在协同之后(见上方 pending 消费的注释)。
        if (pendingGoal.remoteCollab) {
          const remoteCollab = await consumePendingRemoteCollab(pendingGoal.remoteCollab, {
            leadSessionId: sessionId,
            logTag: 'pending goal',
            onFailed: (err) =>
              toast.error(
                getCollaborationStartErrorMessage(err, t, {
                  remoteDevice: true,
                  continueAsSingleSession: true,
                }),
              ),
            onAssignmentUnconfirmed: () => toast.error(t('newChat.collaboration.assignmentFailed')),
          });
          if (remoteCollab.ok) {
            deferredUiAssignment = remoteCollab.deferredUiAssignment;
            void sessionsStore.forceRefresh('active');
            void revealOrcaWorkersTab(sessionId).catch((revealErr) => {
              log.warn('revealOrcaWorkersTab after pending goal collab failed', revealErr);
            });
          }
        }
        // 与首条消息同一条路:交付成功才丢副本。setGoal 失败会抛错,
        // deliver 里 forget 根本执行不到,副本自然保留 —— 目标正文是用户敲的,
        // 留着下次进本会话回填,比只弹一句"失败"更有用。
        const delivered = await deliverRecoverableHandoff(sessionId, async () => {
          await goalApiFor(sessionId).setGoal({
            sessionId,
            objective: pendingGoal.objective,
            limits: pendingGoal.limits,
          });
          return true;
        });
        if (delivered) {
          void dispatchDeferredUiAssignment(sessionId, deferredUiAssignment).catch((err) => {
            log.error('deferred Worker assignment after goal failed', err);
            toast.error(t('newChat.collaboration.assignmentFailed'));
          });
        }
        toast.success(t('goal.toast.set'));
      } catch (err) {
        log.warn('pending goal setGoal failed:', err);
        toast.error(t('goal.toast.failed'));
        if (deferredUiAssignment) {
          toast.error(t('newChat.collaboration.assignmentFailed'));
        }
      } finally {
        setRemoteHandoffPreparing(false);
      }
    })();
  }, [historyLoaded, restoreRecoverableHandoff, sessionId, t]);

  // learn 状态卡恢复:卡片是 ephemeral(不落库),app 重启后从 learn:list-runs
  // 把仍活跃(进行中 / 待审查)且与本会话相关的 run 重新插卡。注意 makerChatStore
  // 是模块级常驻的 —— 本视图卸载重挂(切去 SkillHub 再回来)时旧卡仍在 store 里,
  // 去重由 insertSystemCard 的 learn/runId 幂等保证。启动期 learn-host 可能尚未
  // 就绪(ready=false)—— 有界重试而非视为"无 run",否则空响应会永久抑制恢复
  // (Codex review 修正)。
  const learnCardsRestoredRef = useRef<string | null>(null);
  // guard key 带上归属设备:远程会话在 origin 注入前跑过一次(路由到本机、天然查不到
  // run)不该永久抑制恢复 —— 注入后 key 变化重跑,按被控端 learn-host 再对账一次。
  const learnRestoreKey = sessionId ? `${sessionId}:${remoteDeviceId ?? ''}` : null;
  useEffect(() => {
    if (!sessionId || !historyLoaded || !learnRestoreKey) return;
    if (learnCardsRestoredRef.current === learnRestoreKey) return;
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (cancelled) return;
        const { ready, runs } = await listActiveRunsForSession(sessionId);
        if (ready) {
          if (cancelled) return;
          learnCardsRestoredRef.current = learnRestoreKey;
          for (const run of runs) {
            insertSystemCard('learn', { runId: run.runId });
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [historyLoaded, insertSystemCard, sessionId, learnRestoreKey]);

  // learn 卡跟随最新叙述:提案就绪 / 每轮修订刷新(awaiting-review 的
  // state-changed)时把本会话的 learn 卡移到消息流末尾 —— 卡片是 /learn 发出
  // 时插入的,蒸馏长输出把用户视线带到底部后,顶部的「查看提案」入口会被
  // 错过、误以为已装好(Chris 实测反馈)。移动只调位置不换消息对象。
  useEffect(() => {
    if (!sessionId) return;
    // subscribeLearnEvents:本机走 learn:event IPC;device-link 远程会话经
    // onRemotePush 消费被控端转发的同名事件(learnTransport 内路由)。
    const off = subscribeLearnEvents(sessionId, (payload) => {
      if (payload.type !== 'state-changed') return;
      if (payload.run.status !== 'awaiting-review') return;
      if (payload.run.sessionId !== sessionId && payload.run.originSessionId !== sessionId) return;
      makerChatStore.moveLearnCardToEnd(sessionId, payload.run.runId);
    });
    return off;
  }, [sessionId]);

  // session 切换时 reset consumed guard(切到别的 session 后再回来,理论上 pending
  // 已被消费过、Map 也清掉了,但 ref 复用一份是为了 guard 可重入)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId 是会话切换重置触发器。
  useEffect(() => {
    pendingConsumedRef.current = false;
    pendingGoalConsumedRef.current = false;
  }, [sessionId]);

  // ── Single layout: ChatView ──
  // 之前还有一条"空 session → NewChatView (logo + 居中输入框)"分支(由
  // isFirstMessage && historyLoaded && !hasMessages 触发), 2026-05 已移除:
  //   - 实际命中场景几乎只有 draft route 跳转过程中 setPending → navigate → mount
  //     这一两帧的闪烁,反而成了 UX 噪音(用户看到"tabs → 没 tabs → 消息流"的三段)
  //   - worktree 创建入口已经收敛到 NewMakerDraftRoute (/cc-agent/new),session 内
  //     原本由 WorktreeChipsRow 提供的"在空 session 上开 worktree"路径几乎没人走
  //   - /clear 之后留在空 ChatView 已经在用,体验没问题,本来就跟"空 session"等价
  // 现在所有空消息流/有消息流都走同一套布局(全高 scroll container + sticky bottom
  // overlay),自然消除 view 翻转带来的 layout shift。
  const composerDir = composerWorkingDirPath({
    workingDir: session?.workingDir,
    liveWorktree,
    isRemote: isRemoteWorktreeSession,
  });
  const workingDirLabel = !session?.workingDir
    ? '\u00A0'
    : session.workspaceKind === 'dialogue'
      ? `${t('ccAgent.layout.dialogueLabel')} ${basename(session.workingDir).slice(0, 8)}`
      : liveWorktree
        ? formatWorktreeChipText(liveWorktree)
        : basename(composerDir ?? session.workingDir);
  const workingDirChipContent = (
    <>
      <Monitor size={12} className="shrink-0 text-[var(--workingdir-icon)]" />
      {/* Dialogue-mode workdir basename is a UUID; render as
          "<dialogueLabel> <first-8-chars>" so the chip carries
          semantic meaning while keeping inter-session distinguishability.
          Full path stays in the hover tip.
          Worktree-mode: 官方与识别出的非官方都走 repo (worktree) 两段式,
          例如 "cindy (steady-goodall)"。完整路径仍在 hover tip 里。 */}
      <span className="block min-w-0 truncate text-12 font-medium leading-none text-[var(--workingdir-text)]">
        {workingDirLabel}
      </span>
    </>
  );

  // ── 分享为图片:选择模式 ──
  // 底部操作条与 ChatInput 互斥(挑消息时不该还能发消息),所以状态在这里读一次,
  // 供下方输入区的 ternary 链分流。
  const shareSelectionActive = useShareSelectionActive(sessionId);
  // 输入区被更高优先级的态占走(远程接管 / 会话准备中 / 任何 pending 交互)时,
  // 底部操作条会随之卸载 —— 那样用户就失去了退出选择模式的入口(Esc 监听在条上)。
  // 所以这些态一出现就主动退出:分享是轻量的一次性动作,重新点一次即可。
  const shareSelectionBlocked =
    Boolean(sessionBinding.attached) ||
    worktreePreparing ||
    Boolean(
      pendingPlanReview ||
      pendingPermission ||
      pendingAskUser ||
      pendingPluginSetup ||
      pendingIssueConfirm ||
      pendingRenameSessionsConfirm ||
      pendingGhostGrantConfirm,
    );
  useEffect(() => {
    if (shareSelectionActive && shareSelectionBlocked) shareSelectionStore.exit();
  }, [shareSelectionActive, shareSelectionBlocked]);
  // 切会话不保留选择态(分享没有跨会话恢复语义)。
  useEffect(() => {
    shareSelectionStore.exitIfNotSession(sessionId);
  }, [sessionId]);

  // MessageStream 提成变量:perf/session-switch 的 <Profiler> 是纯诊断,只在 DEV
  // 包裹(见下方渲染处),生产直接渲染此 el,不引入多余 Profiler fiber。
  const messageStreamEl = (
    <MessageStream
      key={sessionId}
      sessionId={sessionId}
      sessionTitle={session?.title ?? null}
      // 透传 agentKind 让 UserMessage 能按 capabilities.fork / rewind 决定
      // 消息下方 Fork / Rewind icon 的显示 (Codex rewind=false → 隐藏)。
      agentKind={session?.agentKind}
      remoteHostId={session?.remoteHostId ?? null}
      // text-lightbox-trigger-extension F1/F2: cwd flows from session
      // owner down through MessageStream → AssistantMessage / UserMessage.
      // The spec guarantees `session.workingDir` is set; `?? ''` is purely
      // a TS-narrowing fallback, never expected to fire at runtime.
      workingDir={session?.workingDir ?? ''}
      messages={messages}
      historyLoaded={historyLoaded}
      taskUpdates={taskUpdates}
      isSessionStreaming={isStreaming}
      continuationTurnClientId={continuationTurnClientId}
      continuationInFlightProjectionCapability={continuationInFlightProjectionCapability}
      onLoadMore={loadOlderMessages}
      isLoadingMore={isLoadingMore}
      hasMoreMessages={hasMoreMessages}
      historyWindowHasIsland={historyWindowHasIsland}
      bottomPadding={overlayHeight}
      composerStackTopOffset={composerStackTopOffset}
      contentWidth={messageWidth}
      getContentWidth={getMessageWidth}
      focusMessageClientId={focusedMessageTarget?.clientId ?? null}
      focusMessageRequestId={focusedMessageTarget?.requestId ?? 0}
      forkOrigin={forkOrigin}
      onOpenForkOrigin={handleOpenForkOrigin}
      isLocalUserSend={isLocalUserSend}
      ownsHardwareScrollActions={ownsHardwareTaskActions}
      onInlinePlanVisibilityChange={handleInlinePlanVisibilityChange}
    />
  );

  const content = (
    // Layout: single scroll container (full height) + sticky input overlay at bottom.
    // FP-7: when the Plan Viewer is expanded/edit, the viewer needs to occupy
    // the full bottom region — we disable pointer-events-none on the overlay
    // in that case so the card catches scroll/click events without a wrapper
    // swap that would flash the layout.
    <>
      {/* ContentHeader 注入：仅 ownsRoute 实例注册。普通路由仍由历史判据获得主权；
          SplitGroup 则把主权交给活动 pane，非活动 pane 不覆盖 header。 */}
      {ownsRoute && session && (
        <SessionContentHeaderRegistration
          session={session}
          remoteSessionUnavailable={remoteSessionUnavailable}
        />
      )}
      {/* 右栏在场声明：与上方 header 注册同一「主实例」判据。仅全屏聊天视图声明，
          内嵌实例不声明（否则会在 doc rail / 协同面板上误开右栏）。 */}
      {ownsRoute && setRightSidebarAvailable && (
        <RightSidebarAvailabilityRegistration declare={setRightSidebarAvailable} />
      )}
      {ownsRoute && sessionId && setRightSidebarSessionId && (
        <RightSidebarSessionIdRegistration
          sessionId={sessionId}
          // A local Pi task always offers the tab, as before. A task that is no
          // longer on Pi keeps offering it for exactly as long as its durable
          // runs exist — terminal ones included, matching what a Pi task shows
          // — and stops once cleanup has removed them. `undefined` while the
          // session is unresolved stays untouched: the shell reads that as
          // "not known yet", not as "unavailable".
          //
          // `remoteHostId` mirrors the capability gate rather than adding one:
          // `agents/pi` computes `remote` as `Boolean(opts.remoteHostId)` and
          // skips installing the durable Subagent extension and runner for such
          // a session, so an SSH-hosted Pi task can never produce a run. Without
          // this the harness alone opened a tab that stays empty forever and
          // whose controls address the *local* filesystem, not the remote host.
          // This is not SSH-hosted Subagent support — that needs the wire
          // protocol to own the run files end-to-end and is out of scope here;
          // this only stops advertising an entry the capability gate disabled.
          //
          // `durablePiRunsPresent` is deliberately left ungated: device-link is
          // a supported path and discovers through `listRemote`, while an SSH
          // task has no deviceId (`remoteHostId` and `deviceLinkDeviceId` are
          // separate fields) so its local list is always empty and presence
          // always false — it cannot leak back in through this branch.
          subagentsAvailable={
            session
              ? (session.agentKind === 'pi' && !session.remoteHostId) || durablePiRunsPresent
              : undefined
          }
          initialCollapsed={shouldFirstFrameRevealOrcaWorkers ? false : undefined}
          writeInitialCollapsedRecord={shouldFirstFrameRevealOrcaWorkers}
          declare={setRightSidebarSessionId}
        />
      )}
      {/* workdir 透 plugin ctx;remote session 一并携带 remoteHostId(文件浏览经
          main 路由到远端 file-service,不再推空串禁用)。session 还没解析时
          workingDir 为 undefined → 推空串走兜底,不阻塞渲染。 */}
      {ownsRoute && setRightSidebarWorkdir && (
        <RightSidebarWorkdirRegistration
          workdir={session?.workingDir ?? ''}
          remoteHostId={session?.remoteHostId ?? null}
          deviceLinkDeviceId={rightSidebarDeviceLinkDeviceId}
          declare={setRightSidebarWorkdir}
        />
      )}
      <section
        className="relative flex h-full w-full flex-col bg-content-area"
        aria-label={t('ccAgent.layout.chatDropAreaAria')}
        onDragEnter={(e) => {
          if (hasSplitGroupSessionType(e.dataTransfer.types)) return;
          e.preventDefault();
          e.stopPropagation();
          dragCounterRef.current += 1;
          if (dragCounterRef.current === 1) setIsDragOver(true);
        }}
        onDragOver={(e) => {
          if (hasSplitGroupSessionType(e.dataTransfer.types)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(e) => {
          if (hasSplitGroupSessionType(e.dataTransfer.types)) return;
          e.preventDefault();
          e.stopPropagation();
          dragCounterRef.current -= 1;
          if (dragCounterRef.current === 0) setIsDragOver(false);
        }}
        onDrop={(e) => {
          if (hasSplitGroupSessionType(e.dataTransfer.types)) return;
          e.preventDefault();
          e.stopPropagation();
          dragCounterRef.current = 0;
          setIsDragOver(false);
          // .cindy / .cshare 已被窗口级 capture 接管(装入 / 导入链路),
          // 只清理拖拽 UI 状态,不当附件消费。
          if (isGlobalDropIntercepted(e.nativeEvent)) return;
          if (
            consumeComposerMentionDrop(e.dataTransfer, {
              addFileMention: attachmentState.addFileMention,
              addFolderPath: attachmentState.addFolderPath,
            })
          ) {
            return;
          }
          // 意识面板拖来的产物(cindy-ghost:// 媒体地址,不带 files):落在聊天区
          // 任意位置都算数,与 ChatInput 自己的 onDrop 同一条引渡链路——
          // main 验归属后图片落图片附件、视频落路径引用的 file 附件(托盘可见)。
          const ghostMediaUri = getGhostMediaUriFromDataTransfer(e.dataTransfer);
          if (ghostMediaUri) {
            if (sessionId) void attachGhostMediaToSession(ghostMediaUri, sessionId, t);
            return;
          }
          const attachDroppedItems = (items: Pick<DroppedFileItems, 'files' | 'directories'>) => {
            for (const directory of items.directories) {
              let folderPath = '';
              try {
                folderPath = window.electronAPI.getFilePath(directory);
              } catch {
                /* ignore */
              }
              if (folderPath) attachmentState.addFolderPath(folderPath);
            }
            if (items.files.length > 0) attachmentState.addFiles(items.files);
          };
          const droppedItems = getDroppedFileItems(e.dataTransfer);
          attachDroppedItems(droppedItems);
          if (droppedItems.unclassified.length > 0) {
            void classifyUnclassifiedDroppedItems(droppedItems.unclassified, {
              getFilePath: (file) => window.electronAPI.getFilePath(file),
              classifyPath: (path) =>
                window.electronAPI.localDb.sessionShare.classifyPath({ path }),
            }).then(attachDroppedItems);
          }
        }}
      >
        {showOrcaLeadIdentityBar && (
          <div className="flex h-8 shrink-0 select-none items-center border-b border-border/40 px-3 text-11 font-medium leading-none text-muted-foreground">
            <span className="min-w-0 flex flex-1 items-center gap-1.5 truncate">
              <VendorIcon
                vendor={leadVendor}
                size={leadVendor === 'cc' ? 14 : 13}
                className="text-current"
              />
              <span className="min-w-0 truncate">{leadPaneLabel}</span>
            </span>
          </div>
        )}

        {/* device-link 远程会话状态 banner:断链重连 / 被控离线 / 通路不稳定(degraded,弱网熔断)
          时提示 + 重新同步(以被控端为准重拉对账)。suspect-stall(链路在线但本轮久未更新且核实
          不到被控端)优先 —— 它可能在 connected 时触发,额外给「结束本轮」手动收尾。
          unstable 描述跨连接抖动,即使此刻 online 也要展示。connected / local 且无 stall 时不渲染。 */}
        {remoteSync.suspectStall ? (
          <RemoteSessionBanner
            status="suspect-stall"
            onResync={remoteSync.resync}
            onFinalize={remoteSync.forceFinalize}
          />
        ) : remoteConn === 'reconnecting' ||
          remoteConn === 'host-offline' ||
          remoteConn === 'degraded' ||
          remoteLinkIssue?.kind === 'unstable' ? (
          <RemoteSessionBanner
            status={
              remoteLinkIssue?.kind === 'unstable'
                ? 'reconnecting'
                : remoteConn === 'host-offline'
                  ? 'host-offline'
                  : remoteConn === 'degraded'
                    ? 'degraded'
                    : 'reconnecting'
            }
            issue={remoteLinkIssue}
            onResync={remoteSync.resync}
          />
        ) : null}

        {/* 远程会话首屏:等被控端经隧道返回历史/元数据期间的 loading(仅远程、延迟防闪)。 */}
        {showRemoteLoading && remoteConn === 'connected' && <RemoteSessionLoading />}

        {/* Full-area drop overlay.
          Keep the event-capture surface for the whole chat area, but leave the
          actual hint UI to ChatInput so the copy sits inside the composer card
          instead of floating over old messages. */}
        {isDragOver && (
          <div
            className="pointer-events-none absolute inset-0 z-50"
            style={{
              backgroundColor: 'var(--drop-overlay-bg)',
              border: '2px dashed var(--drop-overlay-border)',
            }}
          />
        )}

        {ownsWindowRoute && handoffFrom && !handoffPillDismissed && (
          <div className="shrink-0 px-4 pt-3">
            <div className="mx-auto" style={{ maxWidth: messageWidth ?? 880 }}>
              <HandoffSourcePill
                dispatcherSessionId={handoffFrom.dispatcherSessionId}
                dispatcherTitle={handoffFrom.dispatcherTitle}
                onReturn={handleReturnToDispatcher}
                onDismiss={() => setHandoffPillDismissed(true)}
              />
            </div>
          </div>
        )}

        {/* Scroll container — full height, bottom padding reserves space for input overlay.
           key={sessionId}: force a full remount on session switch so scroll state,
           refs, and ResizeObservers are fresh — guarantees per-session isolation. */}
        <div className="relative min-h-0 flex-1">
          {/* perf/session-switch 探针纯诊断:仅 DEV 用 Profiler 量 MessageStream commit,
            生产直接渲染 el(见上方 messageStreamEl),不引入多余 Profiler fiber。 */}
          {import.meta.env.DEV ? (
            <Profiler id="message-stream" onRender={onStreamProfile}>
              {messageStreamEl}
            </Profiler>
          ) : (
            messageStreamEl
          )}
        </div>

        {/* Input overlay — sticky at bottom with gradient fade.
           左右 padding 由 useProportionalWidth.inputPad 计算:默认 40,compact
           rail 为 0。inputWidth = messageWidth + 20,每侧多 10px,正好填满 overlay。 */}
        <div
          ref={overlayRef}
          style={{ left: inputPad, right: inputPad }}
          className="pointer-events-none absolute bottom-0 flex flex-col items-center"
        >
          {/* Gradient mask: transparent → content-area */}
          <div className="pointer-events-none h-8 w-full">
            <div className="h-full w-full bg-gradient-to-t from-[hsl(var(--content-area))] to-transparent" />
          </div>

          {/* Solid background zone */}
          <div className="pointer-events-auto flex w-full flex-col items-center bg-[hsl(var(--content-area))] pb-5">
            {/* 单行 composer 状态层：RunningStatusBar 与中央胶囊组合叠在同一个 grid row。
              展开态由「计划 + 完整被控提示」组成真实 flex 组合共同居中,被控提示会把计划
              向左挤且不会互相覆盖；折叠态计划恢复单独居中,呼吸灯移到 token 统计左侧。 */}
            <div
              className="mx-auto grid grid-cols-1 grid-rows-1 items-center"
              style={{ width: inputWidth }}
            >
              {(!pendingPlanReview || (hasControlledBanner && controlledBannerCollapsed)) && (
                <RunningStatusBar
                  key={sessionId}
                  status={agentStatus.status}
                  tokenUsage={agentStatus.tokenUsage}
                  outputTokens={agentStatus.outputTokens ?? 0}
                  generationDurationMs={agentStatus.generationDurationMs ?? 0}
                  generationReliable={agentStatus.generationReliable ?? true}
                  startedAt={agentStatus.startedAt}
                  visible={!pendingPlanReview && (agentStatus.isRunning || backgroundTasksActive)}
                  inputWidth={inputWidth}
                  sideTaskRunning={agentStatus.sideTaskRunning ?? false}
                  backgroundTasksRunning={backgroundTasksActive}
                  // 仅后台 Bash 在跑(无模型调用)时换专属文案 + 温和停止语义:
                  // 逐任务 stopTask,不关常驻子进程。proxy 信号在时维持原语义
                  // (关子进程止损,bash 任务随之终止,无需再逐个停)。
                  backgroundBashOnlyCount={
                    backgroundActivity.active ? 0 : backgroundBash.tasks.length
                  }
                  backgroundStopping={backgroundActivity.stopping || backgroundBash.stopping}
                  suppressContent={Boolean(pendingPlanReview)}
                  onStopBackgroundTasks={() => {
                    if (backgroundActivity.active) void backgroundActivity.stopAll();
                    else void backgroundBash.stopAll();
                  }}
                  rightLeadingSlot={
                    hasControlledBanner && controlledBannerCollapsed ? (
                      <ControlledBanner
                        placement="composer"
                        maxWidth={controlledBannerMaxWidth}
                        sessionId={sessionId ?? null}
                      />
                    ) : null
                  }
                  className="col-start-1 row-start-1"
                />
              )}
              <div
                data-composer-center-group="true"
                className="pointer-events-none relative z-10 col-start-1 row-start-1 flex max-w-full -translate-y-1 items-center justify-center gap-2"
              >
                <PinnedPlanPanel
                  sessionId={sessionId ?? null}
                  messages={messages}
                  animated={isStreaming}
                  streaming={isStreaming}
                  width={inputWidth}
                  inlinePlanVisibility={inlinePlanVisibility}
                  taskHistoryMayBeIncomplete={
                    !historyLoaded || hasMoreMessages || historyWindowHasIsland
                  }
                  visible={
                    !(
                      pendingPlanReview ||
                      pendingPermission ||
                      pendingAskUser ||
                      pendingPluginSetup ||
                      pendingIssueConfirm ||
                      pendingRenameSessionsConfirm ||
                      pendingGhostGrantConfirm
                    )
                  }
                  className="mb-0"
                />
                {showExpandedControlledBanner && (
                  <ControlledBanner
                    placement="composer"
                    maxWidth={controlledBannerMaxWidth}
                    sessionId={sessionId ?? null}
                  />
                )}
              </div>
            </div>

            {/* Error display.
              - agentKind 传到 ErrorBanner 让 codex 401 / Missing bearer 不仅在远端
                能 hide Retry (走 syncCodexAuth 引导), 本地 codex session 401 也能
                hide Retry + 显本地 fix 文案 (避免 retry 撞同样的 auth retry-loop)。
              - remoteHostId / deviceLinkDeviceId 始终标记真实执行端，避免控制端本机
                认证恢复入口误处理远端错误；SSH 同步按钮仍由 agentKind='codex' 单独门控。 */}
            {/* 凭证切换等待(非错误):消息保留在队首,挡路的本地 Codex 任务结束后
              main 自动重发;取消 = 删除队首消息。与下方 ErrorBanner 互斥渲染——
              等待态由 main 权威维护,error 为空。 */}
            {credentialSwitchWait && !error && (
              <CredentialSwitchWaitBanner
                blockedBySessionIds={credentialSwitchWait.blockedBySessionIds}
                onCancel={(() => {
                  // 取消目标 = 等待中的那条消息(clientId 绑定);老被控端缺省时回落队首。
                  const cancelId = credentialSwitchWait.clientId ?? pendingQueue[0]?.clientId;
                  return cancelId ? () => removeFromQueue(cancelId) : undefined;
                })()}
                style={{ width: inputWidth }}
                className="py-1"
              />
            )}

            {/* error-tail-banner:会话尾部错误行的可操作提示 —— 互斥渲染
              (live error / 凭证等待优先);会话跑起来即隐藏。两种语义:
              - 中断标记行 → InterruptedTurnBanner(继续任务/忽略);
              - 普通失败行 → 直接复用 ErrorBanner(review P2):它已内置
                thread not found / 401 / invalid-encrypted 等不可重试错误的
                Retry 门控与恢复路径(同步登录态 / fork 剥离),此前的简化红条
                一律显示重试会把用户带进同样的失败循环。onRetry 忽略 retryText
                (typed token),发隐藏续跑指令;onCancel = dismiss 持久化。 */}
            {errorTailMsg &&
              !errorTailBannerHidden &&
              !syntheticContinuationPending &&
              !error &&
              !credentialSwitchWait &&
              !isStreaming &&
              !agentStatus.isRunning &&
              sessionId &&
              (errorTailKind === 'interrupted' ? (
                <InterruptedTurnBanner
                  onContinue={handleErrorTailContinue}
                  onDismiss={handleErrorTailDismiss}
                  style={{ width: inputWidth }}
                  className="py-1"
                />
              ) : (
                <ErrorTailErrorBanner
                  errorText={errorTailText}
                  errorReason={errorTailMsg?.errorReason}
                  onContinue={handleErrorTailContinue}
                  onDismiss={handleErrorTailDismiss}
                  onSilentStopContinue={handleSilentStopContinue}
                  agentKind={session?.agentKind}
                  remoteHostId={session?.remoteHostId ?? undefined}
                  deviceLinkDeviceId={remoteDeviceId}
                  modelId={session?.model}
                  providerId={session?.providerId}
                  onViewBalance={canAccessBilling ? handleViewBalance : undefined}
                  errorSourceProviderId={errorTailMsg?.errorProviderId ?? null}
                  onSwitchToClaudeSubscription={
                    canSwitchToClaudeSubscription ? handleSwitchToClaudeSubscription : undefined
                  }
                  silentEncryptedRetryEnabled={silentEncryptedRetryEnabled}
                  onForkStripEncrypted={canNavigateSession ? handleForkStripEncrypted : undefined}
                  forkStripEncryptedRunning={forkStripEncryptedRunning}
                  style={{ width: inputWidth }}
                  className="py-1"
                />
              ))}

            {/* interrupted-turn-resume(简化版):session 双时间戳驱动的中断提示。
              历史中断行(上方 errorTailMsg 判定)优先;互斥条件与 error-tail 同款。 */}
            {!errorTailMsg &&
              interruptedFromSession &&
              !syntheticContinuationPending &&
              !error &&
              !credentialSwitchWait &&
              !isStreaming &&
              !agentStatus.isRunning &&
              sessionId && (
                <InterruptedTurnBanner
                  onContinue={handleSessionInterruptContinue}
                  onDismiss={handleSessionInterruptDismiss}
                  style={{ width: inputWidth }}
                  className="py-1"
                />
              )}

            {error && (
              <ErrorBanner
                error={error}
                errorReason={errorReason}
                isRecoverable={errorIsRecoverable}
                retryText={errorRetryText}
                onRetry={handleRetry}
                onSilentStopContinue={handleSilentStopContinue}
                onContinueAfterUsageReset={
                  usageLimitRecovery && !remoteDeviceId ? handleContinueAfterUsageReset : undefined
                }
                usageLimitRecovery={usageLimitRecovery}
                onCancel={handleDismissError}
                agentKind={session?.agentKind}
                remoteHostId={session?.remoteHostId ?? undefined}
                deviceLinkDeviceId={remoteDeviceId}
                modelId={session?.model}
                providerId={session?.providerId}
                onSwitchToClaudeSubscription={
                  canSwitchToClaudeSubscription ? handleSwitchToClaudeSubscription : undefined
                }
                onViewBalance={canAccessBilling ? handleViewBalance : undefined}
                errorSourceProviderId={liveErrorSourceProviderId}
                silentEncryptedRetryEnabled={silentEncryptedRetryEnabled}
                onForkStripEncrypted={canNavigateSession ? handleForkStripEncrypted : undefined}
                forkStripEncryptedRunning={forkStripEncryptedRunning}
                style={{ width: inputWidth }}
                className="py-1"
              />
            )}

            {/* worktree 恢复横幅(P1):worktree 已被回收(目录缺失、分支还在)时
              提供一键恢复。组件自查 restore-status,非 restorable 自渲染 null;
              与 error/streaming 互斥条件从轻——目录缺失是持续状态,不依赖错误出现。 */}
            {sessionId && !isStreaming && !agentStatus.isRunning && (
              <WorktreeRestoreBanner
                sessionId={sessionId}
                style={{ width: inputWidth }}
                className="py-1"
              />
            )}

            {/* cc-mgr / pi-manager 升级提示 — cc 与 pi remote session (agentKind +
              remoteHostId 在场)。轮 22:pi 复用同一 banner 通道(store 按 hostId +
              agent 区分 pending)。内部会订阅 ccMgrUpgradeStore, 该 host 无 pending
              时自渲染 null (零开销)。sessionId 传给 banner 用于 U3 — 升级完成后
              自动重发该 session 的 last user message。 */}
            {(session?.agentKind === 'cc' || session?.agentKind === 'pi') &&
              session?.remoteHostId && (
                <UpgradeBanner
                  hostId={session.remoteHostId}
                  agent={session.agentKind === 'pi' ? 'pi' : 'cc'}
                  sessionId={session.id}
                  style={{ width: inputWidth }}
                  className="py-1"
                />
              )}

            {/* 零可用模型引导条:与首屏引导卡共享判定与 dismiss(useProviderOnboarding),
              组件自判 visible、不可见渲染 null。device-link 远程会话不出——连接态在被控端。 */}
            {!remoteDeviceId && (
              <ConnectProviderBanner style={{ width: inputWidth }} className="py-1" />
            )}

            <div
              className="mx-auto flex flex-col items-center gap-[10px]"
              style={{ width: inputWidth }}
              data-chat-composer-stack
            >
              {/* FP-7 / F-PERM-2 / F7.4: mutually exclusive prompts.
                 Plan review takes precedence — the SDK won't interleave it with
                 other tool calls, but explicit priority guards against layout
                 races during state transitions.

                 InteractionPromptHost: 普通模式下行为不变(直接 inline 渲染)。
                 当外部 (workdir-browse 等窄 rail 场景) 挂了 InteractionPromptSlot
                 时,卡片会被 portal 出去,这里就显占位。 */}
              <InteractionPromptHost
                hasInteraction={
                  !!(
                    pendingPlanReview ||
                    pendingPermission ||
                    pendingAskUser ||
                    pendingPluginSetup ||
                    pendingIssueConfirm ||
                    pendingRenameSessionsConfirm ||
                    pendingGhostGrantConfirm
                  )
                }
                placeholder={
                  <div className="w-full rounded-xl border border-dashed border-[var(--cmd-palette-border)] bg-[hsl(var(--content-area))] px-4 py-3 text-center text-12 text-[var(--cmd-palette-item-meta)]">
                    {t('ccAgent.layout.waitForReply')}
                  </div>
                }
              >
                {pendingPlanReview ? (
                  <>
                    <PlanViewerCard
                      pending={pendingPlanReview}
                      viewerState={planViewerState}
                      workingDir={session?.workingDir ?? ''}
                      lastExpandedState={lastExpandedPlanViewerState}
                      onStateChange={setPlanViewerState}
                      onPlanContentChange={updatePlanContent}
                      onCancel={() => cancelPlanReview(pendingPlanReview.requestId)}
                    />
                    <PlanActionCard
                      requestId={pendingPlanReview.requestId}
                      onRespond={respondToPlanReview}
                      onCancel={cancelPlanReview}
                    />
                  </>
                ) : pendingPermission ? (
                  <PermissionPrompt
                    permission={pendingPermission}
                    onRespond={respondToPermission}
                  />
                ) : pendingAskUser ? (
                  <AskUserQuestionPrompt
                    pending={pendingAskUser}
                    onAnswer={answerUserQuestion}
                    viewerState={askUserViewerState}
                    onViewerStateChange={setAskUserViewerState}
                    draft={askUserDraft}
                    onDraftChange={setAskUserDraft}
                  />
                ) : pendingPluginSetup ? (
                  <PluginSetupPrompt
                    pending={pendingPluginSetup}
                    viewerState={pluginSetupViewerState}
                    commandInFlight={pluginSetupCommandInFlight}
                    remote={!!remoteDeviceId}
                    onViewerStateChange={setPluginSetupViewerState}
                    onCommand={respondToPluginSetup}
                  />
                ) : pendingIssueConfirm && sessionId ? (
                  <IssueConfirmCard
                    key={`${sessionId}:${pendingIssueConfirm.requestId}`}
                    sessionId={sessionId}
                    pending={pendingIssueConfirm}
                    onRespond={respondToIssueConfirm}
                  />
                ) : pendingRenameSessionsConfirm ? (
                  <RenameSessionsConfirmCard
                    pending={pendingRenameSessionsConfirm}
                    onRespond={respondToRenameSessionsConfirm}
                  />
                ) : pendingGhostGrantConfirm ? (
                  <GhostGrantConfirmCard
                    key={pendingGhostGrantConfirm.requestId}
                    pending={pendingGhostGrantConfirm}
                    onRespond={respondToGhostGrantConfirm}
                  />
                ) : null}
              </InteractionPromptHost>
              {/* 会话内 /goal 进行中状态条(composer 上方);无 goal 时返回 null 不占位。 */}
              <GoalIndicator sessionId={sessionId} />
              {/* 互斥:有任意 pending interaction 时,下方 takeover/overlay/ChatInput
                 全部静默 — 跟改造前 ternary 链 (Plan ? : Perm ? : Ask ? :
                 Takeover ? : ChatInput) 的语义一致。
                 优先级 (高 → 低):
                   1. attached (远程接管中)  → TakeoverMask  (90px)
                   2. worktreePreparing      → WorktreeCreatingOverlay (90px, 视觉同款)
                   3. 默认                    → ChatInput
                 两个 mask 共用 TakeoverMask 同款外形 (90px h / 12px round / sidebar
                 border), 切到 ChatInput 时高度变大, 与 takeover 收回回到 ChatInput
                 的体验一致。 */}
              {pendingPlanReview ||
              pendingPermission ||
              pendingAskUser ||
              pendingPluginSetup ||
              pendingIssueConfirm ||
              pendingRenameSessionsConfirm ||
              pendingGhostGrantConfirm ? null : sessionBinding.attached && sessionId ? (
                <TakeoverMask
                  sessionId={sessionId}
                  channel={sessionBinding.identity?.channel ?? 'feishu'}
                  userId={sessionBinding.identity?.userId ?? null}
                  displayName={sessionBinding.displayName}
                />
              ) : worktreePreparing && smoothedBranchName ? (
                <WorktreeCreatingOverlay branchName={smoothedBranchName} />
              ) : shareSelectionActive && sessionId ? (
                <ShareSelectionBar
                  sessionId={sessionId}
                  barWidth={inputWidth}
                  getContentWidth={getMessageWidth}
                />
              ) : (
                <ChatInput
                  onSend={handleSend}
                  onBeforeVoiceInputStart={handleBeforeVoiceInputStart}
                  sessionId={sessionId}
                  ownsHardwareComposerActions={ownsHardwareTaskActions}
                  // session=null 是冷启动 / 直链 GET 尚未回流的合法首帧；显式传 null，
                  // 让 ChatInput 暂不显示 Agent 身份，不能跟随 displayAgentKind 的 cc 回退。
                  runtimeAgentKind={session ? dbToMakerAgentKind(session.agentKind) : null}
                  // 协同会话不参与跨引擎切换；session 未加载时保留 undefined 未知态，
                  // 仅在完整元数据确认非 Orca 后传 null 开放入口。
                  sessionOrcaRole={session ? (session.orcaRole ?? null) : undefined}
                  initialWorkingDir={session?.workingDir}
                  remoteHostId={session?.remoteHostId ?? null}
                  deviceLinkDeviceId={rightSidebarDeviceLinkDeviceId}
                  modelMemoryOverride={remoteModelMemoryOverride}
                  initialModel={session?.model}
                  initialProviderId={session?.providerId ?? null}
                  initialEffort={session?.effort}
                  initialPermissionMode={session?.permissionMode}
                  planModeEnabled={planModeEnabled}
                  onPlanModeChange={setPlanMode}
                  fastMode={fastMode}
                  onFastModeChange={setFastMode}
                  onWorkingDirChange={handleWorkingDirChange}
                  isStreaming={isStreaming}
                  isAgentBusy={isAgentBusy}
                  onStop={handleStopSession}
                  pendingQueue={pendingQueue}
                  disabled={remoteHandoffPreparing || session?.source === 'review'}
                  settingsLocked={session?.source === 'review'}
                  queuePaused={queuePaused}
                  queueExpanded={queueExpanded}
                  onQueueExpandedChange={setQueueExpanded}
                  onQueueResume={resumeQueue}
                  onQueueRemove={removeFromQueue}
                  onQueueEdit={updateQueueItem}
                  onQueueSteer={steerQueuedMessage}
                  onQueueReorder={moveQueueItem}
                  onQueueInteractionLock={setQueueInteractionLock}
                  onQueueEditLock={setQueueEditLock}
                  steeringQueueClientIds={steeringQueueClientIds}
                  messages={messages}
                  placeholder={t('ccAgent.layout.chatPlaceholder')}
                  folderPickerOpen={folderPickerOpen}
                  onFolderPickerOpenChange={handleFolderPickerOpenChange}
                  showFolderPicker={false}
                  onModelDidChange={handleModelDidChange}
                  onEffortDidChange={handleEffortDidChange}
                  onPermissionModeDidChange={handlePermissionModeDidChange}
                  attachmentState={attachmentState}
                  externalDragOver={isDragOver}
                  onComposerDropHandled={resetFullAreaDragState}
                  vendorKey={normalizeDbAgentKind(displayAgentKind)}
                  extraDirs={session?.extraDirs ?? []}
                  onExtraDirsChange={handleExtraDirsChange}
                  compactToolbar={compactToolbar}
                  // doc rail (isCompactRail) 宽度受限 + 拖宽上限,工具行需要把字号/控件压一档。
                  denseToolbar={isCompactRail}
                  // doc 模式右栏:不抢焦点,避免 TipTap contenteditable 激活
                  // Windows 中文 IME 后,Ctrl+Shift+F 等组合键被 OS 层吞掉。
                  // 详见 ChatInput 的 disableAutofocus prop 注释。
                  disableAutofocus={isCompactRail || disableAutofocus}
                  focusOnStorageKeyChange={ownsRoute}
                  // F-COLLAB:「+」菜单里的协同模式项。普通 Lead 的项目/对话会话都渲染,
                  // 项目级与用户级策略范围由 collabEntry 决定;只排除 Worker 子会话
                  // (worker 自己不能再开协同)。
                  // orcaMode 路由下也保留显示 — ON 态菜单项本身就是
                  // 关闭按钮 (点击触发 onChange({enabled:false}),走 requestStopCollab)。
                  collaboration={
                    allowCollabToggle || (orcaMode && collabEnabled)
                      ? {
                          enabled: collabEnabled,
                          worker: collabWorker,
                          onChange: (next) => {
                            // enableBusy 只盖 enable;关闭走 hook 自己的 busy 重入保护。
                            if (collabEnabled && !next.enabled) {
                              void requestStopCollab();
                              return;
                            }
                            if (!collabEnabled && next.enabled) {
                              if (enableBusy) return;
                              setCollabWorker(next.worker);
                              setCreateWorkerOpen(true);
                              return;
                            }
                            // 同态切 worker 选择目前先不支持(需销毁重建 Worker),
                            // mvp 先吃掉这条事件,后续可加 "切换 Worker" 流程。
                          },
                          onOpenDetails: () => {
                            if (enableBusy) return;
                            setCreateWorkerOpen(true);
                          },
                          onDisabledActivate: collabPolicy.unavailable
                            ? () => {
                                if (enableBusy) return;
                                void collabPolicy.refresh().then((policy) => {
                                  if (policy.enabled && !policy.unavailable) {
                                    setCreateWorkerOpen(true);
                                  }
                                });
                              }
                            : undefined,
                          disabled:
                            !collabEnabled && (collabPolicy.loading || !collabPolicy.enabled),
                          // unsupported(被控端版本过旧、没有 maker:plugins:get-state)
                          // 排在 unavailable 之前:它是确定性的不支持,给「稍后重试」是
                          // 误导,上面的 onDisabledActivate 也只挂在 unavailable 上。
                          disabledReason: !collabEnabled
                            ? collabPolicy.loading
                              ? t('newChat.collaboration.loadingHint')
                              : collabPolicy.unsupported
                                ? t('newChat.collaboration.unsupportedRemoteHint')
                                : collabPolicy.unavailable || !collabPolicy.enabled
                                  ? t(
                                      collabPolicy.unavailable
                                        ? 'newChat.collaboration.unavailableHint'
                                        : 'newChat.collaboration.disabledHint',
                                    )
                                  : undefined
                            : undefined,
                        }
                      : undefined
                  }
                />
              )}

              {/* F-FP-5: workingDir — always rendered to prevent layout shift
                worktree-parallel-sessions:worktree 创建过程的反馈(creating/failed)
                也复用这一行 inline 显示,替换原 Monitor+basename chip。完成后 store
                自动 clear,UI 回到正常显示。设计参考用户反馈"把这部分的体验逻辑放到
                chatinput 底部 显示 work dir 的地方"——不再在 chat stream 插 SystemCard。 */}
              <div
                className={cn(
                  'mt-1.5 flex w-full items-center justify-between gap-3 px-1',
                  !session?.workingDir && !worktreeCreation && 'invisible',
                )}
              >
                {/* Left: workingDir — 点击在系统文件管理器中打开;
                  click 区域宽度与文本一致(不拉伸到整行) */}
                {worktreeCreation?.status === 'creating' ? (
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Spinner size={12} className="text-[var(--workingdir-icon)]" />
                    <span className="block min-w-0 truncate text-12 font-medium leading-none text-[var(--workingdir-text)]">
                      {t('ccAgent.layout.worktreeCreating', '正在创建 worktree')}{' '}
                      <code className="font-mono text-11 opacity-80">{worktreeCreation.name}</code>…
                    </span>
                  </div>
                ) : worktreeCreation?.status === 'failed' ? (
                  <Tip text={worktreeCreation.error} mono side="top">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <AlertCircle size={12} className="shrink-0 text-red-500 dark:text-red-400" />
                      <span className="block min-w-0 truncate text-12 font-medium leading-none text-red-500 dark:text-red-400">
                        {t('ccAgent.layout.worktreeFailed', 'Worktree 创建失败')}
                        {' — '}
                        {worktreeCreation.error}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (sessionId) worktreeCreationStore.clear(sessionId);
                        }}
                        className="shrink-0 rounded p-0.5 transition-colors hover:bg-foreground/10"
                        aria-label={t('common.dismiss', 'Dismiss')}
                      >
                        <X size={10} className="text-red-500/70 dark:text-red-400/70" />
                      </button>
                    </div>
                  </Tip>
                ) : (
                  <Tip
                    text={
                      composerDir ? (
                        session?.remoteHostId ? (
                          // 远端 session: Tip 顶部加一行 "Host: <alias>" 让用户在
                          // 同 workingDir 跨多 host 撞合场景下也能区分。hostId 即
                          // SSH alias (HostConfig.id), 不需要额外 lookup。
                          <>
                            <div>Host: {session.remoteHostId}</div>
                            <div>{composerDir}</div>
                          </>
                        ) : (
                          composerDir
                        )
                      ) : null
                    }
                    mono
                    side="top"
                  >
                    {isRemoteWorktreeSession ? (
                      <div className="flex min-w-0 items-center gap-1.5">
                        {workingDirChipContent}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left transition-opacity active:opacity-60"
                        onClick={handleOpenWorkingDir}
                        aria-label={t('ccAgent.layout.openWorkingDirAria')}
                      >
                        {workingDirChipContent}
                      </button>
                    )}
                  </Tip>
                )}

                {/* Right: Context capacity indicator */}
                <div className="flex shrink-0 items-center gap-3">
                  {session?.usedProjectContext && (
                    <Tip text={t('ccAgent.layout.projectContextLoaded')} side="top">
                      <Brain
                        size={14}
                        strokeWidth={1.75}
                        className="shrink-0 -translate-y-px text-foreground/70"
                        aria-label={t('ccAgent.layout.projectContextLoaded')}
                      />
                    </Tip>
                  )}
                  <TodaySpendChip
                    vendorKey={normalizeDbAgentKind(displayAgentKind)}
                    modelId={agentSwitchIntent?.model ?? session?.model ?? null}
                    providerId={
                      agentSwitchIntent
                        ? agentSwitchIntent.providerId
                        : (session?.providerId ?? null)
                    }
                    sessionId={sessionId}
                    sessionInitialMoney={session?.totalMoney ?? null}
                    sessionInitialCostUsd={session?.totalCostUsd ?? null}
                    sessionInitialTokens={session?.totalTokenUsage ?? null}
                    remoteHostId={session?.remoteHostId ?? null}
                    deviceLinkDeviceId={remoteDeviceId ?? null}
                  />
                  <ContextCapacityRing
                    contextTokens={agentStatus.contextTokens}
                    model={agentSwitchIntent?.model ?? session?.model ?? ''}
                    vendorKey={normalizeDbAgentKind(displayAgentKind)}
                    sdkContextWindow={agentStatus.contextWindow}
                    deviceId={remoteDeviceId}
                    onCompact={
                      // 按 agent 能力分流(#1927/#1933 review):claude-code 走 inputCoordinator,
                      // 其余声明 manualCompact.supported(当前仅 pi)走 compact-session 通道;
                      // codex 无手动 compact(上游自动压缩)保持纯展示。pi 的 SSH 远程会话
                      // (remoteHostId)无 compact-session 路由 → 不开放(与 SessionContentHeader
                      // 压缩菜单仅本地/device-link 一致);device-link 远程 pi 走隧道,照常开放。
                      // pi 回合运行中会拒绝压缩 → compact-session 通道在 running 时禁用
                      // (与 SessionContentHeader 的 runningSessionIds 一致,codex P1);
                      // claude-input 保留旧行为(turn 中可走 inputCoordinator)。
                      compactChannel !== null &&
                      !(realAgentKind === 'pi' && !!session?.remoteHostId) &&
                      session != null &&
                      agentStatus.contextTokens > 0 &&
                      !(compactChannel === 'compact-session' && agentStatus.isRunning)
                        ? handleCompactRequest
                        : undefined
                    }
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* TopRightChipStack:聊天视图右上 chip 浮层。
          Windows 固定侧栏入口由 MainLayout 承载；当入口位于右侧时在本栈第一行
          保留等尺寸占位，让消息跳转等 portal chip 自然落到下一行。
          MessageStream 内部的 PrevMessageJumpChip 通过 portal 挂入同一栈,自然落到下一行。
          "本次会话改动文件列表"已迁移到 RSB review tab,不再保留浮动按钮 + 滑入抽屉。 */}
        <TopRightChipStack>
          {!isMac &&
            (ownsRoute || showRsbToggle) &&
            rightSidebarCollapsed &&
            rightSidebarSide === 'right' && <div aria-hidden className="h-7 w-7 shrink-0" />}
        </TopRightChipStack>
      </section>
    </>
  );

  return (
    // isCompact 由 useProportionalWidth 按 effective compact 暴露:doc rail 恒 true,
    // 主消息流在容器宽 <AUTO_COMPACT_THRESHOLD 时为 true、回到宽态时回 false。
    // 挂 `chat-rail-compact` 让字号与 padding 同步缩放——doc rail 外层(OrcaSplitView /
    // WorkdirBrowseRoute)本身也挂这个类,主会话内层再挂一层是冗余但无害(CSS 规则幂等)。
    <div
      ref={containerRef}
      className={cn('relative h-full w-full', isCompact && 'chat-rail-compact')}
    >
      {/* TopRightChipStackProvider 必须包住 MessageStream(消费 slot 的后代)
          与 TopRightChipStack(提供 slot 的容器)二者的共同祖先,context 才
          能流到。content 内同时包含两者,所以包在外层即可。 */}
      <SessionNavigationModeProvider
        mode={navigationMode}
        onSessionNavigate={onSessionNavigate}
        sidebarTargetSessionId={sidebarTargetSessionId}
        // 路由主实例的 bucket 当前可见；可见 split pane 会在点击前先接管路由，
        // 因而自己的 bucket 对本次面板动作同样可达。其它内嵌实例(worker 面板 /
        // 文件浏览窄 rail / Orca split)仍传 undefined，让入口安全降级。
        sidebarPanelHostSessionId={
          ownsRoute || navigationMode === 'split-pane' ? sessionId : undefined
        }
      >
        <ChatDisplaySnapshotProvider value={chatDisplaySnapshot}>
          <TopRightChipStackProvider>{content}</TopRightChipStackProvider>
        </ChatDisplaySnapshotProvider>
      </SessionNavigationModeProvider>
      <CreateWorkerPopover
        open={createWorkerOpen}
        onClose={() => setCreateWorkerOpen(false)}
        onCreate={requestEnableCollab}
        title={t('orca.createWorker.enableCollabTitle')}
        submitLabel={t('orca.createWorker.enableCollabSubmit')}
        requireWorkerPermissionModeSupport
        deviceId={remoteDeviceId}
        // SSH 远程 Lead:worker 在远端 spawn,模型清单按 SSH 口径过滤(订阅直连 /
        // openai-chat 桥接 Codex 只挂在本地 proxy),与 main 侧 remote-worker
        // guard 同规则(codex review R28)。
        sshRemote={!!session?.remoteHostId}
      />

      {/* 来自 Automations 的入口浮动返回按钮：固定在聊天区左上角，
          上下随 MessageStream 滚动也不动；click 回 /cc-agent/scheduled。
          z-40：在拖拽 overlay (z-50) 之下，在普通内容之上。 */}
      {ownsWindowRoute && cameFromAutomations && (
        <button
          type="button"
          onClick={() => navigate('/cc-agent/scheduled')}
          aria-label={t('ccAgent.layout.backToAutomations')}
          className={cn(
            'absolute left-[14px] top-[14px] z-40 inline-flex items-center justify-center',
            'text-[var(--settings-section-desc)] transition-colors hover:text-foreground',
          )}
        >
          <ArrowLeft size={18} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

function HandoffSourcePill({
  dispatcherSessionId,
  dispatcherTitle,
  onReturn,
  onDismiss,
}: {
  dispatcherSessionId: string;
  dispatcherTitle?: string | null;
  onReturn: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const label = dispatcherTitle?.trim() || shortSessionId(dispatcherSessionId);

  return (
    <div
      className={cn(
        'flex h-10 w-full items-center rounded-[12px] border border-[var(--cmd-palette-border)] bg-[hsl(var(--content-area))]',
        'text-13 leading-none text-[#595959]',
      )}
    >
      <button
        type="button"
        onClick={onReturn}
        className={cn(
          'flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left',
          'transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground',
        )}
      >
        <CornerUpLeft size={14} strokeWidth={2} className="shrink-0" />
        <span className="min-w-0 truncate">
          {t('ccAgent.handoff.pill.fromDispatcher', { title: label })}
        </span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('ccAgent.handoff.pill.dismissAria')}
        className={cn(
          'mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]',
          'text-[#595959] transition-colors hover:bg-[var(--cmd-palette-bg)] hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground',
        )}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunningStatusBar
// ---------------------------------------------------------------------------

const STATUS_BAR_FADE_MS = 400;
const CONTROLLED_BANNER_MAX_WIDTH = 420;

function RunningStatusBar({
  status,
  tokenUsage,
  outputTokens = 0,
  generationDurationMs = 0,
  generationReliable = true,
  startedAt,
  visible,
  inputWidth,
  sideTaskRunning = false,
  backgroundTasksRunning = false,
  backgroundBashOnlyCount = 0,
  backgroundStopping = false,
  onStopBackgroundTasks,
  rightLeadingSlot = null,
  suppressContent = false,
  className,
}: {
  status: string;
  tokenUsage: number;
  outputTokens?: number;
  generationDurationMs?: number;
  generationReliable?: boolean;
  startedAt: number | null;
  visible: boolean;
  inputWidth?: CSSProperties['width'];
  /**
   * 当前是否处于 side-task (mivo MJ 按钮等不走 LLM 的后台任务) 运行态。
   * true 时隐藏右侧的 elapsed · rate 行 —— mivo 不消耗 token, 显示上一轮
   * 残留数字会误导用户。"Done" check icon 也不显示 (sideTaskRunning 期间永远
   * 把 status 当成进行中, 即便 status 文案恰好是 "Done")。
   */
  sideTaskRunning?: boolean;
  /**
   * 后台子任务模式:turn 已结束但该会话 CC 子进程仍在调模型(后台子 agent 持续
   * 消耗用量)。true 时状态栏保持点亮:左段换 Activity 图标 + 后台运行文案(shimmer
   * 呼吸沿用),右段把 elapsed / tokens 换成「全部停止」入口 —— 上一轮的残留计时 /
   * 计数在此语义下都是误导信息。替代原独立横幅(2026-07-13 假停止治理)。
   */
  backgroundTasksRunning?: boolean;
  /**
   * 后台模式细分:>0 表示当前只有后台 Bash 任务在跑(无模型调用)。左段换
   * 「后台任务运行中(N 个)」文案,「全部停止」tooltip 换成逐任务停止语义
   * (不关常驻子进程)。0 = 维持原「仍在调模型」文案与止损语义。
   */
  backgroundBashOnlyCount?: number;
  /** 全停请求在飞(按钮禁用,防连点)。 */
  backgroundStopping?: boolean;
  /** 「全部停止」入口(关闭常驻 CC 子进程,会话可续)。 */
  onStopBackgroundTasks?: () => void;
  /** 独立于运行态淡出的右侧前置槽位；折叠后的被控呼吸灯固定在 token 统计左侧。 */
  rightLeadingSlot?: ReactNode;
  /** 交互卡接管 composer 时立即隐藏旧运行文案/token，只保留折叠呼吸灯。 */
  suppressContent?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  // `showContent` controls whether real content is rendered. During the short
  // linger/fade window we keep the row's height stable; once it is fully idle the
  // component returns null below so the composer does not retain an empty line.
  const [showContent, setShowContent] = useState(visible);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (visible) {
      setShowContent(true);
      setFading(false);
    } else {
      // Linger 1s at full opacity, then fade, then swap to placeholder
      const lingerTimer = setTimeout(() => setFading(true), 1000);
      const hideTimer = setTimeout(() => setShowContent(false), 1000 + STATUS_BAR_FADE_MS);
      return () => {
        clearTimeout(lingerTimer);
        clearTimeout(hideTimer);
      };
    }
  }, [visible]);

  const [elapsed, setElapsed] = useState(0);

  // Local timer (F-SDK-3: render-side setInterval)
  useEffect(() => {
    if (!startedAt) {
      setElapsed(0);
      return;
    }

    setElapsed(Math.floor((Date.now() - startedAt) / 1000));

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [startedAt]);

  const isHidden = suppressContent || (!showContent && !visible);

  // side-task / 后台子任务运行中永远当成进行态 (即便上一轮 LLM 留下的 status 文案
  // 是 "Done", 此时任务还在跑, 显示 ✓ 完成图标会让用户以为已经做完)。
  const isDone = status === 'Done' && !sideTaskRunning && !backgroundTasksRunning;
  // 后台子任务模式的左段文案:上一轮残留的 status(多半是 "Done")在此语义下是
  // 误导信息,整体替换为后台运行提示。仅后台 Bash 时用带数量的专属文案 ——
  // 「模型用量仍在消耗」对不调模型的 bash 任务是错误陈述。
  const displayStatus = backgroundTasksRunning
    ? backgroundBashOnlyCount > 0
      ? t('chat.backgroundActivity.bashStatus', { count: backgroundBashOnlyCount })
      : t('chat.backgroundActivity.status')
    : localizeAgentStatus(status, t);
  // F-COMPACT-1: when SDK is auto-summarizing the conversation, give the
  // status bar a distinct icon so the user can tell "Compacting..." apart
  // from "Thinking..." — both share the shimmer animation by design, but
  // the icon answers "what is it doing right now".
  const isCompacting = typeof status === 'string' && status.toLowerCase().startsWith('compact');

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const elapsedText = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

  // Cadenced shimmer(DESIGN.md §14.4):status-shimmer 已是一次性动画,这里在
  // 每次真实动静(状态文案变化 / token 计数推进)时通过 key 重挂载触发一次呼吸。
  // 播放期间到达的动静只置 pending,onAnimationEnd 再连播一次 —— 产出密集时是
  // 连续呼吸(节奏 = 动画时长),静默期(长 thinking / 等待工具)常亮不动。
  // 视觉语义从「固定心跳 = 在运行」变为「呼吸 = 正在产出」;也让运行指示
  // 不再依赖 infinite 循环。
  const [shimmerCycle, setShimmerCycle] = useState(0);
  const shimmerPlayingRef = useRef(false);
  const shimmerPendingRef = useRef(false);
  const handleShimmerEnd = useCallback(() => {
    shimmerPlayingRef.current = false;
    if (shimmerPendingRef.current) {
      shimmerPendingRef.current = false;
      shimmerPlayingRef.current = true;
      setShimmerCycle((n) => n + 1);
    }
  }, []);
  useEffect(() => {
    // suppressContent 或 reduced-motion 期间 shimmer 类/动画被摘，
    // onAnimationEnd 不会到来。立即清零播放态，确保运行期关闭减弱动效后
    // 下一次真实动静能重新触发呼吸，不必等 visible 先变 false。
    if (!visible || suppressContent || reducedMotion) {
      // 运行结束把播放态清零,下一轮 turn 的首次动静立即触发而不是误判在播。
      shimmerPlayingRef.current = false;
      shimmerPendingRef.current = false;
      return;
    }
    if (shimmerPlayingRef.current) {
      shimmerPendingRef.current = true;
      return;
    }
    shimmerPlayingRef.current = true;
    setShimmerCycle((n) => n + 1);
  }, [visible, suppressContent, reducedMotion, status, tokenUsage, outputTokens, generationDurationMs]);

  // Animate the token counter so live mid-turn updates feel like a smoothly-
  // incrementing number. Rate does not use this: locally ticking the
  // denominator would make a paused model look like decaying speed.
  const animatedTokens = useAnimatedNumber(tokenUsage, 400);
  const usageMeta = resolveRunningUsageMeta({
    outputTokens,
    generationDurationMs,
    generationReliable,
    tokenUsage,
  });
  const tokenCountText = t('chat.runningStatus.tokenCount', {
    tokens: formatRunningTokenCount(animatedTokens),
  });
  const tokenCountTipText = t('chat.messageActionBar.turnTokens', {
    tokens: formatRunningTokenCount(animatedTokens),
  });
  const rateText =
    usageMeta.kind === 'rate' ? t('chat.runningStatus.tokenRate', { rate: usageMeta.rate }) : null;

  // 淡入淡出/隐藏占位样式 —— 同时作用于左(状态)、右(elapsed/tokens)两段。
  // visibility:hidden 只隐藏不收高,让 linger / fade 阶段稳定;淡出结束后整个
  // RunningStatusBar 才收起为 null。
  const fadeStyle: CSSProperties = {
    visibility: isHidden ? 'hidden' : 'visible',
    opacity: isHidden ? 0 : fading ? 0 : 1,
    transition: isHidden ? 'none' : `opacity ${STATUS_BAR_FADE_MS}ms ease-out`,
    pointerEvents: isHidden ? 'none' : 'auto',
  };
  // 空闲后真正收起,不再给输入框上方留下固定空行。overlay 的 ResizeObserver 会在
  // DOM 尺寸变化后补齐 MessageStream 的 bottomPadding,因此不靠硬编码高度制造跳变。
  if (isHidden && !rightLeadingSlot) return null;

  // 两段式布局:左(运行状态) / 右(elapsed·tokens)。
  // - 左段 min-w-0(可收缩):status 并非短枚举 —— turn-start 文案带用户名(可含中文长句)、
  //   claude tool 进度会拼成 `mcp__x__y running...` 长串,窄宽时左段靠 span truncate;
  // - 右段 justify-self-end + min-w-0:elapsed / token 是低优先级信息,必要时可溢出。
  return (
    <div
      className={cn(
        'mx-auto grid select-none grid-cols-[minmax(0,1fr)_auto] items-center px-2 py-[6px]',
        className,
      )}
      style={{ width: inputWidth }}
    >
      <div
        // cadenced shimmer:key 重挂载 = 重播一次呼吸(见上方 shimmerCycle 说明)。
        // 左段只有 icon + 一行文字,1.5s 一次的重挂载成本可忽略。
        key={shimmerCycle}
        onAnimationEnd={handleShimmerEnd}
        className={cn(
          // min-w-0(非 shrink-0):让内部 status span 的 truncate 真正生效 —— status 可变长
          // (turn-start 带用户名 / tool 进度长串),窄宽时左段截断而非把右段顶出界。
          'flex min-w-0 items-center gap-[6px]',
          // 隐藏时一律摘所有动画类:动画即便 visibility:hidden 不画也照算样式/合成层，
          // 长期累积会复刻 0f8fa84 那次 breathing 在 :root 的内存泄漏。
          // 非隐藏时 done 与 shimmer 区别对待:
          // - shimmer 现在是 cadenced 一次性呼吸(1 → 0.45 → 1),终态回满不会盖住
          //   fadeStyle 的 inline opacity;linger / fade 阶段照旧摘掉,保证淡出干净。
          // - done 是 0.4s 一次性 pop(keyframe 已去掉 opacity、只动 transform)，turn
          //   结束那一刻(isDone 必伴随 !visible)要弹一下，故保持 !isHidden gate;
          //   不动 opacity 所以不会盖 fade。
          isHidden ? '' : isDone ? 'status-bar-done' : visible ? 'status-bar-shimmer' : '',
        )}
        style={fadeStyle}
        aria-hidden={isHidden}
      >
        {isDone ? (
          <Check size={14} className="shrink-0" strokeWidth={2.5} />
        ) : // 后台子任务模式换 Activity 图标(与 Compacting 换 Layers 同一设计逻辑:
        // 图标回答"现在在干嘛")。优先于 isCompacting —— 后者按残留 status 文本
        // 判断,turn 在 compact 阶段结束时会错配出 Layers + 后台文案。
        backgroundTasksRunning ? (
          <Activity size={14} className="shrink-0 -translate-y-px" />
        ) : isCompacting ? (
          <Layers size={14} className="shrink-0 -translate-y-px" />
        ) : (
          // -translate-y-px: lucide Sparkles' visual center sits slightly below
          // its geometric center (the lower-right tail biases mass downward),
          // so flex items-center alignment looks off — nudging the icon up 1px
          // restores optical alignment with the text baseline.
          <Sparkles size={14} className="shrink-0 -translate-y-px" />
        )}
        <span className="truncate text-13 font-medium">{displayStatus}</span>
      </div>
      {/* 右侧先放不随运行态淡出的被控呼吸灯,再放 elapsed / · / arrow-down / tokens。
          side-task (mivo 等) 运行时只显示 elapsed, 不带 token 行 —— 这类任务不
          走 LLM, 显示残留 token 计数会误导用户以为也耗了 token。 */}
      <div className="flex min-w-0 items-center justify-self-end gap-2">
        {rightLeadingSlot}
        {!isHidden && (
          <div
            data-running-status-meta="true"
            className="flex min-w-0 items-center gap-[6px]"
            style={fadeStyle}
            aria-hidden={isHidden}
          >
            {backgroundTasksRunning ? (
              // 后台子任务模式:elapsed 是上一轮 turn 的残留计时、tokens 是残留计数,
              // 都不成立 —— 整段换成「全部停止」入口(原横幅唯一操作,横幅已删)。
              <button
                type="button"
                onClick={onStopBackgroundTasks}
                disabled={backgroundStopping || !onStopBackgroundTasks}
                className={cn(
                  'flex shrink-0 items-center gap-1 text-13 font-medium',
                  'text-[var(--text-primary)] hover:opacity-70 transition-opacity',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
                title={t(
                  backgroundBashOnlyCount > 0
                    ? 'chat.backgroundActivity.stopBashTitle'
                    : 'chat.backgroundActivity.stopAllTitle',
                )}
              >
                <Square size={12} />
                {backgroundStopping
                  ? t('chat.backgroundActivity.stopping')
                  : t('chat.backgroundActivity.stopAll')}
              </button>
            ) : (
              <>
                <span className="text-13 font-medium text-[var(--status-bar-meta)]">
                  {elapsedText}
                </span>
                {!sideTaskRunning && usageMeta.kind !== 'none' && (
                  <>
                    <span className="text-13 font-medium text-[var(--status-bar-meta)]">
                      &middot;
                    </span>
                    {rateText ? (
                      tokenUsage > 0 ? (
                        <Tip text={tokenCountTipText} side="top">
                          <span className="text-13 font-medium text-[var(--status-bar-meta)]">
                            {rateText}
                          </span>
                        </Tip>
                      ) : (
                        <span className="text-13 font-medium text-[var(--status-bar-meta)]">
                          {rateText}
                        </span>
                      )
                    ) : (
                      <>
                        <ArrowDown size={13} className="shrink-0 text-[var(--status-bar-meta)]" />
                        <span className="text-13 font-medium text-[var(--status-bar-meta)]">
                          {tokenCountText}
                        </span>
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ContextCapacityRing — circular token usage indicator
// ---------------------------------------------------------------------------

/** Format a token count with K/M suffix: 200000 → "200K", 1000000 → "1M". */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return n.toString();
}

/**
 * 从 maker capabilities cache 查模型 contextWindow。
 * 拿不到时返回 undefined，由 display resolver 兜底到 200K。
 */
function getModelContextWindow(
  model: string,
  vendorKey: 'cc' | 'codex' | 'pi',
  deviceId?: string,
): number | undefined {
  const found = getModelsForVendor(vendorKey, deviceId).find((m) => m.id === model);
  return found?.contextWindow;
}

function ContextCapacityRing({
  contextTokens,
  model,
  vendorKey,
  sdkContextWindow,
  deviceId,
  onCompact,
}: {
  contextTokens: number;
  model: string;
  vendorKey: 'cc' | 'codex' | 'pi';
  /** SDK-reported context window; 0 = not yet known → use hardcoded fallback. */
  sdkContextWindow: number;
  /** device-link 远程会话所属被控端 id;按被控端能力查 contextWindow(本机会话 undefined,行为不变)。 */
  deviceId?: string;
  /** 提供时圆环可点击 — 点击后(经用户确认)向 agent 发送 /compact 压缩上下文。 */
  onCompact?: () => void;
}) {
  const { t } = useTranslation();
  const contextWindow = resolveDisplayContextWindow({
    sdkContextWindow,
    modelContextWindow: getModelContextWindow(model, vendorKey, deviceId),
  });
  const pct =
    contextWindow > 0
      ? Math.min(Math.max(Math.round((contextTokens / contextWindow) * 100), 0), 100)
      : 0;

  // Ring geometry: outer diameter 20px, strokeWidth 2.5
  const size = 20;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2; // 8.75
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (circumference * pct) / 100;

  // Color thresholds per spec
  const fillColor = pct > 90 ? '#EF4444' : pct > 70 ? '#F59E0B' : 'var(--msg-tool-card-chevron)';

  const usedTokens = Math.min(contextTokens, contextWindow || Infinity);
  const tooltipText =
    contextWindow > 0
      ? `Context — ${formatTokenCount(usedTokens)} / ${formatTokenCount(contextWindow)} (${pct}%)`
      : 'No context data yet';

  const ringContent = (
    <>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="shrink-0"
        aria-hidden="true"
        focusable="false"
      >
        {/* Track (background circle) */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--msg-tool-card-border)"
          strokeWidth={strokeWidth}
        />
        {/* Fill arc — starts at 12 o'clock, sweeps clockwise */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={fillColor}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="text-12 font-medium leading-none" style={{ color: fillColor }}>
        {pct}%
      </span>
    </>
  );

  return (
    <Tip
      text={
        onCompact ? (
          <>
            <div>{tooltipText}</div>
            <div>{t('ccAgent.layout.contextRing.compactHint')}</div>
          </>
        ) : vendorKey === 'codex' ? (
          // codex 协议没有手动 compact 入口(server 侧自动压缩),圆环不可点击;
          // tooltip 里说明原因,避免用户疑惑为什么 Claude 能点 codex 不能。
          <>
            <div>{tooltipText}</div>
            <div>{t('ccAgent.layout.contextRing.codexAutoHint')}</div>
          </>
        ) : (
          tooltipText
        )
      }
    >
      {onCompact ? (
        <button
          type="button"
          onClick={onCompact}
          aria-label={t('ccAgent.layout.contextRing.compactHint')}
          className="flex shrink-0 cursor-pointer items-center gap-1 transition-opacity hover:opacity-75 active:opacity-60"
        >
          {ringContent}
        </button>
      ) : (
        <div className="flex shrink-0 items-center gap-1">{ringContent}</div>
      )}
    </Tip>
  );
}
