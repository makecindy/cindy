import { dialog, ipcMain, screen, BrowserWindow, type Display, type OpenDialogOptions } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { release as getOsRelease } from 'node:os';
import { SESSION_ACTIVITY_CHANNEL, type SessionActivityPayload } from '@cindy/device-link';
import {
  isTerminalAgentErrorEvent,
  type AgentEvent,
  type InteractionDecision,
  type InteractionRequest,
} from '@cindy/maker-core';
import type { SchedulerEvent } from '@cindy/maker-scheduler';
import { BRAND_NAME } from '@cindy/maker-shared/branding';
import {
  projectSessionActivity,
  type SessionActivitySnapshot,
  type SessionActivityTransition,
} from '@cindy/maker-shared/session-activity';
import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';
import {
  isProductTurnCompletionTailEvent,
  isTurnContinuationBoundaryEvent,
} from '@cindy/maker-shared/turn-continuation';
import type { ApplicationMenuCommand } from '../../shared/applicationMenuCommands.js';

import {
  clearSessionAttention as clearAppBadgeSessionAttention,
  hasSessionAttention as hasAppBadgeSessionAttention,
} from '../appBadgeService.js';
import { openMainWindowSession, openMainWindowChatMessage } from '../deepLink.js';
import { groupChatIslandId, type AgentIslandGroupChatInput } from './groupChat.js';
import {
  AGENT_ISLAND_CONSUME_ENTRY_ALERT_CHANNEL,
  AGENT_ISLAND_MAX_RESIZABLE_WIDTH,
  AGENT_ISLAND_GET_DISPLAY_OPTIONS_CHANNEL,
  AGENT_ISLAND_PREVIEW_SOUND_CHANNEL,
  AGENT_ISLAND_SCREEN_EDGE_GUTTER,
  AGENT_ISLAND_SET_DISPLAY_TARGET_CHANNEL,
  AGENT_ISLAND_SET_ENABLED_CHANNEL,
  AGENT_ISLAND_SET_MASCOT_SKIN_CHANNEL,
  AGENT_ISLAND_SET_REMOTE_SESSIONS_CHANNEL,
  AGENT_ISLAND_SET_COMPANION_CHATS_CHANNEL,
  AGENT_ISLAND_READ_COMPANION_CHAT_CHANNEL,
  parseAgentIslandCompanionChats,
  type AgentIslandCompanionChatInput,
  AGENT_ISLAND_SET_SOUND_SETTINGS_CHANNEL,
  AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL,
  AGENT_ISLAND_SELECT_SOUND_FILE_CHANNEL,
  DEFAULT_AGENT_ISLAND_DISPLAY_TARGET,
  DEFAULT_AGENT_ISLAND_MASCOT_SKIN,
  cloneAgentIslandDisplayTarget,
  cloneAgentIslandSoundSettings,
  createDefaultAgentIslandDisplayConfig,
  createEmptyAgentIslandPillSnapshot,
  getAgentIslandDefaultContentWidth,
  getAgentIslandMinimumContentWidth,
  isAgentIslandMascotSkin,
  isAgentIslandSoundChoice,
  isAgentIslandSoundId,
  isAgentIslandSupportedPlatform,
  isSilentAgentIslandSoundChoice,
  normalizeAgentIslandDisplayTarget,
  normalizeAgentIslandSoundChoice,
  normalizeAgentIslandSoundSettings,
  parseAgentIslandRemoteSessions,
  snapAgentIslandCompactHardwareContentWidth,
  AGENT_ISLAND_SESSION_SNAPSHOTS_CHANNEL,
  type AgentIslandDisplayOption,
  type AgentIslandDisplayState,
  type AgentIslandPillSnapshot,
  type AgentIslandRemoteSessionInput,
  type AgentIslandCompanionSnapshot,
  type AgentIslandSessionActivity,
  type AgentIslandSessionSnapshot,
  type AgentIslandDisplayTarget,
  type AgentIslandMascotSkin,
  type AgentIslandStrings,
  type AgentIslandSoundChoice,
  type AgentIslandSoundEvent,
  type AgentIslandSoundSettings,
  type AgentIslandScreenLayoutMetrics,
} from '../../shared/agentIsland.js';
import { getSessionRowSnapshot, patchSessionMetaInDb } from '../localDb/ipc/sessions.js';
import { isSessionNotificationsMutedSync } from '../localDb/sessionFlagRegistry';
import { withSessionRouteLock } from '../localDb/sessionRouteLock.js';
import { confirmIslandArchive } from './archiveConfirmation.js';
import { remoteInvoke } from '../device-link/index.js';
import { bindingStore } from '../im/binding.js';
import { setAgentIslandCompanionChangeSink } from '../localDb/agentIslandSessionPatch.js';
import {
  companionAvatarHasArtwork,
  companionAvatarThumbnail,
  companionSnapshotWithoutArtwork,
  readAgentIslandCompanion,
  type AgentIslandCompanionIdentity,
} from './companionIdentity.js';
import { createLogger } from '../logger.js';
import { t } from '../i18n.js';
import { isAppContentWindow, isFocusedAppContentWindow } from '../windowFocusClassifier.js';
import {
  acknowledgeAgentIslandSessionRead,
  agentIslandCompletionToken,
  readAgentIslandUnreadTerminalStamp,
  applyAgentIslandEvent,
  syncAgentIslandGroupChat,
  revealAgentIslandGroupChat,
  applyAgentIslandInteractionDismissed,
  applyAgentIslandInteractionRequest,
  applyAgentIslandUserPrompt,
  buildAgentIslandDisplayState,
  buildAgentIslandTaskOverview,
  buildAllSessionActivitySnapshots,
  closeAgentIslandSessionPreservingUnread,
  completeAgentIslandSessionWithoutAttention,
  completedReplySummary,
  createAgentIslandUserPromptRollbackToken,
  createAgentIslandState,
  dismissAgentIslandActiveReveal,
  getNextAgentIslandTimerAt,
  hasAgentIslandSessionAttention,
  isAgentIslandDeviceSession,
  isAgentIslandPendingFocusAck,
  markAgentIslandSessionAttention,
  requestAgentIslandManualCollapse,
  requestAgentIslandManualExpand,
  patchAgentIslandMetadata,
  removeAgentIslandSession,
  resetAgentIslandState,
  rollbackAgentIslandUserPrompt,
  requestAgentIslandSessionFocus,
  setAgentIslandAppFocused,
  setAgentIslandLayoutDragActive,
  setAgentIslandMeasuredContentHeight,
  setAgentIslandPointerZones,
  setAgentIslandSessionDisplaySuppressed,
  setAgentIslandStrings,
  setAgentIslandToolWording,
  setAgentIslandVisibleSession,
  syncAgentIslandDeviceSessions,
  type AgentIslandDeviceSessionEvent,
  type AgentIslandUserPromptRollbackToken,
} from './state.js';
import { createLocalizedToolRowWording } from './toolWording.js';
import {
  type AgentIslandDisplayIdentity,
  type AgentIslandLayoutPreference,
  computeAgentIslandCarrierSize,
  computeAgentIslandWindowBounds,
} from './geometry.js';
import {
  MacAgentIslandNativeHost,
  type AgentIslandNativeFrame,
  type AgentIslandNativeScreenMetrics,
} from './MacAgentIslandNativeHost.js';
import { AGENT_ISLAND_DISPLAY_CONFIG } from './displayConfig.js';
import {
  readAgentIslandDetachedLayoutPreferences,
  readAgentIslandLayoutPreferences,
  writeAgentIslandLayoutPreference,
  writeAgentIslandLayoutPreferences,
} from './layoutPreferenceStore.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { getActiveAppSession } from '../appSessionState.js';
import { isDataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import {
  beginProtectedFolderCheck,
  detectProtectedFolderEperm,
  endProtectedFolderCheck,
  markEpermGuidanceShown,
  openFolderPrivacySettings,
  probeProtectedFolderAccess,
  releaseEpermGuidance,
  type ProtectedFolderKind,
} from '../file-access/permissions.js';
import { SessionActivityRelay } from './sessionActivityRelay.js';

const log = createLogger('agent-island');
const HARDWARE_NOTCH_CENTER_TOLERANCE_PX = 2;
const SILENCED_COMPLETION_CLEAR_MS = 2_000;
const LAYOUT_PREFERENCE_WRITE_DEBOUNCE_MS = 150;
const STREAMING_PREVIEW_PUBLISH_DEBOUNCE_MS = 50;
const REMOTE_DAEMON_CLOSED_REASON = 'remote_daemon_closed';
// Remote close can legitimately consume the full 15s RPC timeout before the
// renderer waits another 1.5s and resends. Keep the fallback beyond that window.
const REMOTE_AUTH_ERROR_FALLBACK_MS = 30_000;
// 点击卡片到主窗导航落地之间可能隔着一次 renderer 冷加载,与主窗导航保留同量级。
const ISLAND_ENTRY_ALERT_TTL_MS = 60_000;
const MAX_ISLAND_ENTRY_SESSION_ID_LENGTH = 128;
const REMOTE_COMPANION_ARTWORK_RETRY_MS = 60_000;
const MAX_ISLAND_ENTRY_ID_LENGTH = 32;

interface AgentIslandSessionMeta {
  sessionId: string;
  agentKind?: string;
  workingDir?: string | null;
  projectDir?: string | null;
  workspaceKind?: string | null;
}

interface AgentIslandCachedMetadata {
  title: string | null;
  workingDir: string | null;
  projectDir?: string | null;
  workspaceKind: string | null;
  /** undefined until the Session row has been read; null for non-companion Sessions. */
  companion?: AgentIslandCompanionIdentity | null;
}

interface AgentIslandPermissionAction {
  requestId: string;
  action: 'allow' | 'allowForSession' | 'deny';
}

interface AgentIslandUserPromptDebugMeta {
  source?: string;
  clientId?: string;
  notifiedAt?: number;
  /** The prompt replaces a failed turn whose terminal event was intentionally withheld. */
  replacesCurrentTurn?: boolean;
}

export interface AgentIslandServiceDeps {
  isCompletionHandledByTeammate?: (sessionId: string) => Promise<boolean>;
  getMainWindow: () => BrowserWindow | null;
  nativeHost?: AgentIslandNativeRenderer;
  /** Main-process upgrade window used to classify remote daemon shutdowns. */
  isPlannedRemoteDaemonClose?: (sessionId: string) => boolean;
  /** Optional process-local consumer for task activity, such as hardware status lighting. */
  onSessionActivityChange?: (activity: readonly AgentIslandSessionActivity[]) => void;
  /** 其它设备任务的状态跃迁。灵动岛开启时由岛面展示;关闭时才交给这里发桌面通知。 */
  onDeviceSessionEvent?: (event: AgentIslandDeviceSessionEvent) => void;
}

interface AgentIslandNativeRenderer {
  readonly failed: boolean;
  readonly available?: boolean;
  readonly headless?: boolean;
  prepare?(): void;
  publish(
    state: AgentIslandDisplayState,
    frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[],
    statesByDisplayId?: Record<string, AgentIslandDisplayState>,
  ): boolean;
  playSound?(sound: AgentIslandSoundChoice): boolean;
  suspend?(): void;
}

type AgentIslandPermissionDecision = Extract<InteractionDecision, { kind: 'permission' }>;

const HEADLESS_AGENT_ISLAND_NATIVE_HOST: AgentIslandNativeRenderer = {
  failed: false,
  headless: true,
  publish: () => true,
  playSound: () => true,
  suspend: () => undefined,
};

let serviceSingleton: AgentIslandService | null = null;

/**
 * Creates the process-wide Agent Island activity coordinator.
 *
 * On platforms without the native island UI we still keep the state machine
 * alive in headless mode because remote session lists use the same compact
 * activity snapshots.
 */
export function initAgentIslandService(deps: AgentIslandServiceDeps): AgentIslandService | null {
  if (serviceSingleton) return serviceSingleton;
  const supportsNativeIsland = isAgentIslandSupportedPlatform(process.platform, getOsRelease());
  serviceSingleton = new AgentIslandService({
    ...deps,
    nativeHost: deps.nativeHost ?? (supportsNativeIsland ? undefined : HEADLESS_AGENT_ISLAND_NATIVE_HOST),
  });
  setAgentIslandCompanionChangeSink({
    companionChanged: (botId) => serviceSingleton?.handleCompanionProfileChanged(botId),
    groupChanged: (groupId) => serviceSingleton?.handleBotGroupChanged(groupId),
  });
  // 远程任务同步与原生岛面无关:无原生岛的平台也要靠它发桌面通知。
  serviceSingleton.registerDeviceSessionIpc();
  if (supportsNativeIsland) {
    serviceSingleton.registerIpc();
  } else {
    serviceSingleton.setEnabled(false);
  }
  return serviceSingleton;
}

export function getAgentIslandService(): AgentIslandService | null {
  return serviceSingleton;
}

function sessionActivitySnapshotsEqual(
  left: AgentIslandSessionActivity,
  right: AgentIslandSessionActivity,
): boolean {
  return left.sessionId === right.sessionId
    && left.completionToken === right.completionToken
    && left.workingPhase === right.workingPhase
    && left.phase === right.phase
    && left.currentTurnActive === right.currentTurnActive
    && left.recordStatus === right.recordStatus
    && left.startedAtMs === right.startedAtMs
    && left.lastActivityAtMs === right.lastActivityAtMs
    && left.currentActionSummary === right.currentActionSummary
    && left.interactionKind === right.interactionKind
    && left.attention === right.attention
    && left.workflow?.key === right.workflow?.key
    && left.workflow?.label === right.workflow?.label
    && left.workflow?.waitingOn === right.workflow?.waitingOn
    && left.turnGeneration === right.turnGeneration
    && left.gracefulStopState === right.gracefulStopState
    && left.source === right.source;
}

function safeSessionActionSummary(snapshot: AgentIslandSessionSnapshot): string {
  if (snapshot.phase === 'needs-interaction') {
    if (snapshot.interactionKind === 'permission') return '等待权限确认';
    if (snapshot.interactionKind === 'ask_user_question') return '等待用户回答';
    if (snapshot.interactionKind === 'plan_review') return '等待计划确认';
    if (snapshot.interactionKind === 'plugin_setup') return '等待插件配置';
    if (snapshot.interactionKind === 'input_handoff') return '等待代输入';
    return '等待用户确认';
  }
  if (snapshot.phase === 'completed') return '运行已正常结束';
  if (snapshot.phase === 'error') return '运行出错';
  const latestKind = snapshot.activityLines.at(-1)?.kind;
  if (latestKind === 'tool') return '正在运行工具';
  if (latestKind === 'assistant') return '正在生成回复';
  if (latestKind === 'user') return '正在处理新消息';
  return '正在运行';
}

function canonicalSessionActivity(
  activity: AgentIslandSessionActivity,
): SessionActivitySnapshot {
  const { compactDetail: _compactDetail, summaryFormat: _summaryFormat, ...snapshot } = activity;
  return {
    ...snapshot,
    workflow: snapshot.workflow ? { ...snapshot.workflow } : null,
  };
}

/**
 * Owns Agent Island display arbitration in main. Rendering is macOS-native:
 * the Swift/AppKit helper owns the system-level panel, shape, shadow and hover
 * tracking while TypeScript owns product state and session prioritization.
 */
export class AgentIslandService {
  private attentionCount = 0;
  private readonly attentionCountListeners = new Set<(count: number) => void>();
  private readonly taskOverviewListeners = new Set<() => void>();
  private readonly sessionActivityListeners = new Set<
    (transition: SessionActivityTransition) => void
  >();
  private sessionActivitySubscriptionCursor = new Map<string, AgentIslandSessionActivity>();
  private readonly state = createAgentIslandState();
  private companionChats = new Map<string, {
    input: AgentIslandCompanionChatInput;
    companion: AgentIslandCompanionSnapshot;
    token: string;
  }>();
  private readonly nativeHost: AgentIslandNativeRenderer;
  private readonly headless: boolean;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly metadataCache = new Map<string, AgentIslandCachedMetadata>();
  private readonly metadataLoading = new Set<string>();
  private readonly remoteCompanions = new Map<string, { snapshot: AgentIslandCompanionSnapshot; retryAt: number | null }>();
  private readonly remoteCompanionKeysInUse = new Set<string>();
  /** Latest identity read per Session: an older read that finishes late never overwrites a newer one. */
  private readonly companionReadSeq = new Map<string, number>();
  /** Bumped by every companion or group change, so reads already in flight know they may be stale. */
  private companionChangeEpoch = 0;
  private lastDeviceSessionInputs: readonly AgentIslandRemoteSessionInput[] = [];
  private readonly layoutPreferencesByDisplayId: Map<number, AgentIslandLayoutPreference>;
  private readonly detachedLayoutPreferences: AgentIslandLayoutPreference[];
  private nativeFailureLogged = false;
  private enabled = false;
  private enabledSynced = false;
  private hiddenPublished = false;
  private readonly screenMetricsByDisplayId = new Map<number, AgentIslandNativeScreenMetrics>();
  private screenMetricsSignature = '';
  private nativePreferredDisplayId: number | null = null;
  private soundSettings: AgentIslandSoundSettings = createDefaultAgentIslandDisplayConfig().soundSettings;
  private mascotSkin: AgentIslandMascotSkin = DEFAULT_AGENT_ISLAND_MASCOT_SKIN;
  private displayTarget: AgentIslandDisplayTarget = DEFAULT_AGENT_ISLAND_DISPLAY_TARGET;
  private lastSoundDisplayState: AgentIslandDisplayState | null = null;
  private readonly soundCooldownUntilByEvent = new Map<AgentIslandSoundEvent, number>();
  private readonly silencedRunSessionIds = new Map<string, string>();
  private readonly silencedSessionRunIds = new Map<string, string>();
  private readonly silencedRunHadAttention = new Map<string, boolean>();
  private readonly silencedRunClearTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly mutedCompletionSoundSessionIds = new Set<string>();
  /** 本轮同步首次出现的其它设备任务:进列表但不响铃。publish 后清空。 */
  private readonly baselineSoundSessionIds = new Set<string>();
  private readonly stoppedSessionIds = new Set<string>();
  private readonly replacementTurnPendingSessionIds = new Set<string>();
  private readonly replacementTurnDispatchingSessionIds = new Set<string>();
  private readonly stoppedProviderTurnIdBySession = new Map<string, string>();
  private readonly interactionEpochBySession = new Map<string, number>();
  private interactionEpochSequence = 0;
  /**
   * 每条会话的未读代。新一轮 completed/error 未读会自增;异步 not-found 回执带着
   * 入队时的代,回来后对不上就作废,避免清掉后来才挂上的绿点/红点。
   */
  private unreadAttentionGenerationBySession = new Map<string, number>();
  private readonly sessionHadAttentionAtRunStart = new Map<string, boolean>();
  /**
   * 最近一次灵动岛卡片点击:点击编号 + 点击时那张卡的身份(readAgentIslandUnreadTerminalStamp)。
   * 只留最新一次 —— 任何新点击都会取代它,包括同一任务的再次点击。只给「目标页没有处置
   * 控件」的入口用(群专线、只读历史、不可用的委派任务):renderer 在目标地址真正提交后
   * 带上这次的点击编号调 consumeIslandEntryAlert,编号与卡片身份都一致才按 explicit 处置。
   */
  private islandEntryAlert: { sessionId: string; entryId: string; stamp: string; until: number } | null = null;
  private islandEntrySequence = 0;
  private readonly userPromptRollbackTokens = new Map<string, {
    state: AgentIslandUserPromptRollbackToken;
    attention: { existed: boolean; value: boolean };
    interactionEpoch: { existed: boolean; value: number };
    wasStopped: boolean;
    wasReplacementTurnPending: boolean;
    wasReplacementTurnDispatching: boolean;
  }>();
  private readonly deferredCompletions = new Map<string, { event: AgentEvent; suppressAttention: boolean }>();
  private readonly deferredRemoteAuthErrors = new Map<string, {
    meta: AgentIslandSessionMeta;
    event: AgentEvent;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly pendingLayoutPreferenceWrites = new Map<number, AgentIslandLayoutPreference>();
  private readonly permissionRequests = new Map<string, {
    sessionId: string;
    request: Extract<InteractionRequest, { kind: 'permission' }>;
  }>();
  private readonly sessionActivityRelay: SessionActivityRelay;
  private permissionResolver: ((requestId: string, decision: AgentIslandPermissionDecision) => boolean) | null = null;
  private shouldDeferCompletion: ((sessionId: string) => boolean) | null = null;
  private layoutPreferenceWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private streamingPreviewPublishTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: AgentIslandServiceDeps) {
    this.sessionActivityRelay = new SessionActivityRelay((payload) => {
      tapWindowBroadcast(SESSION_ACTIVITY_CHANNEL, payload);
    }, { isCompletionHandledByTeammate: deps.isCompletionHandledByTeammate });
    // lazy t() 闭包跟随 locale 运行时切换,注入一次即可(strings 仍每次 publish 重建)。
    setAgentIslandToolWording(this.state, createLocalizedToolRowWording());
    this.layoutPreferencesByDisplayId = readAgentIslandLayoutPreferences();
    this.detachedLayoutPreferences = readAgentIslandDetachedLayoutPreferences();
    this.nativeHost = deps.nativeHost ?? new MacAgentIslandNativeHost({
      onPointerZones: (zones) => this.handleNativePointerZones(zones),
      onExpand: (displayId) => this.handleNativeExpand(displayId),
      onCollapse: () => this.handleNativeCollapse(),
      onFocusSession: (sessionId) => this.focusSession(sessionId),
      onCompletionAction: (sessionId, action, token) => this.handleCompletionAction(sessionId, action, token),
      onOpenSettings: () => this.dispatchMainWindowCommand('open-agent-island-settings', { playSelectSound: true }),
      onNewMessage: () => this.dispatchMainWindowCommand('new-maker', { playSelectSound: true }),
      onToggleSound: () => this.dispatchMainWindowCommand('toggle-agent-island-sound'),
      onPermissionAction: (action) => this.handlePermissionAction(action),
      onOutsideClick: () => this.handleOutsideClick(),
      onLayoutDragActive: (active) => this.handleNativeLayoutDragActive(active),
      onLayoutPreference: (preference) => this.handleNativeLayoutPreference(preference),
      onContentHeight: (height) => this.handleNativeContentHeight(height),
      onScreenMetrics: (metrics) => this.handleNativeScreenMetrics(metrics),
    });
    this.headless = this.nativeHost.headless === true;
  }

  setPermissionResolver(
    resolver: ((requestId: string, decision: AgentIslandPermissionDecision) => boolean) | null,
  ): void {
    this.permissionResolver = resolver;
  }

  setCompletionDeferResolver(resolver: ((sessionId: string) => boolean) | null): void {
    this.shouldDeferCompletion = resolver;
  }

  /**
   * Holds a remote authentication error while the renderer decides whether its
   * built-in reconnect can retry the turn. Paired completion events are ignored
  * until the retry either starts, fails explicitly, or reaches the fallback.
  */
  deferRemoteAuthRetryError(meta: AgentIslandSessionMeta, event: AgentEvent): void {
    this.clearDeferredRemoteAuthError(meta.sessionId);
    const timer = setTimeout(() => {
      this.resolveDeferredRemoteAuthRetryError(meta.sessionId);
    }, REMOTE_AUTH_ERROR_FALLBACK_MS);
    this.deferredRemoteAuthErrors.set(meta.sessionId, { meta, event, timer });
  }

  /** Surfaces a deferred auth error after retry is rejected or fails. */
  resolveDeferredRemoteAuthRetryError(sessionId: string): boolean {
    const pending = this.deferredRemoteAuthErrors.get(sessionId);
    if (!pending) return false;
    this.deferredRemoteAuthErrors.delete(sessionId);
    clearTimeout(pending.timer);
    this.handleAgentEvent(pending.meta, pending.event);
    return true;
  }

  /**
   * 当某会话的排队工作因 INPUT_REMOVE / INPUT_CLEAR_SESSION 被清空(而非被派发)、
   * 或 Orca Lead 的最后一份 Worker 回报已结清时调用。若该会话有待补发的完成事件
   * (之前因推迟判定成立而被压住),且现在推迟判定已不成立,则立即补发。
   */
  notifyQueueEmptied(sessionId: string): void {
    const deferred = this.deferredCompletions.get(sessionId);
    if (!deferred) return;
    if (this.shouldDeferCompletion?.(sessionId) === true) return;
    this.deferredCompletions.delete(sessionId);
    const { event, suppressAttention } = deferred;
    if (suppressAttention) {
      // 延后完成已被标记为「应压制注意力」:silencedSessionRunIds 可能已被清除,
      // 不能再通过 isCompletionEventSilenced 重新判断,直接使用快照值。
      const hydrated = this.hydrateMeta({ sessionId });
      const now = Date.now();
      setAgentIslandStrings(this.state, buildAgentIslandStrings());
      const changed = applyAgentIslandEvent(this.state, hydrated, event, now, {
        suppressCompletionAttention: true,
        preserveCompletionAttention: this.hadAttentionBeforeSilencedRun(sessionId),
      });
      if (!changed) return;
      this.mutedCompletionSoundSessionIds.add(sessionId);
      this.ensureMetadata(sessionId);
      this.clearStreamingPreviewPublishTimer();
      this.publish();
    } else {
      this.handleAgentEvent({ sessionId }, event);
    }
  }

  handlePermissionAction(action: AgentIslandPermissionAction): void {
    const requestId = action.requestId.trim();
    if (!requestId) return;
    const entry = this.permissionRequests.get(requestId);
    if (!entry) {
      log.warn('Agent Island permission action ignored: request not found', { requestId, action: action.action });
      return;
    }
    if (!this.permissionResolver) {
      log.warn('Agent Island permission action ignored: resolver not registered', { requestId, action: action.action });
      return;
    }

    const sessionUpdates = filterSessionScopedPermissionSuggestions(entry.request.suggestions);
    const decision: AgentIslandPermissionDecision = action.action === 'deny'
      ? {
          kind: 'permission',
          behavior: 'deny',
          reason: 'User denied',
        }
      : {
          kind: 'permission',
          behavior: 'allow',
          permissionUpdates: action.action === 'allowForSession' && sessionUpdates.length > 0
            ? sessionUpdates
            : undefined,
        };

    if (!this.permissionResolver(requestId, decision)) {
      log.warn('Agent Island permission action ignored: resolver rejected request', {
        requestId,
        action: action.action,
      });
      return;
    }

    this.handleInteractionDismissed(entry.sessionId, requestId);
  }

  /** 各平台都注册(含无原生岛的 headless):灵动岛关闭时远程任务靠它发桌面通知。 */
  registerDeviceSessionIpc(): void {
    ipcMain.handle(AGENT_ISLAND_SET_COMPANION_CHATS_CHANNEL, (event, raw: unknown) => {
      assertTrustedAppRendererEvent(event);
      if (event.sender !== this.deps.getMainWindow()?.webContents) return { ok: true };
      if (!isDataOwnerPushStamp(raw)) throwIpcError('INVALID_PARAMS', 'Companion chats require an owner stamp');
      const owner = getActiveAppSession();
      if (!owner.dataOwnerId || raw.dataOwnerId !== owner.dataOwnerId || raw.ownerGeneration !== owner.generation) return { ok: true };
      const payload = raw as typeof raw & { chats?: unknown };
      const chats = parseAgentIslandCompanionChats(payload.chats);
      if (!chats) {
        throwIpcError('INVALID_PARAMS', 'Invalid companion chat snapshot');
      }
      this.setCompanionChats(chats);
      return { ok: true };
    });
    ipcMain.handle('agent-island:completion-action', (event, sessionId: unknown, action: unknown, token: unknown) => {
      if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
      if (typeof sessionId !== 'string' || !sessionId || (action !== 'archive' && action !== 'mark-read')
        || typeof token !== 'string' || !token || token.length > 128) {
        throwIpcError('INVALID_PARAMS', 'Invalid completion action');
      }
      return this.applyOwnedCompletionAction(sessionId, action, token);
    });
    ipcMain.handle(AGENT_ISLAND_SET_REMOTE_SESSIONS_CHANNEL, (event, raw: unknown) => {
      assertTrustedAppRendererEvent(event);
      // 只认主窗:副窗也挂侧栏,多份输入会让跃迁判定来回抖动。
      const mainWindow = this.deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents !== event.sender) {
        return { ok: true };
      }
      const inputs = parseAgentIslandRemoteSessions(raw);
      if (!inputs) {
        throwIpcError('INVALID_PARAMS', 'remote sessions payload is invalid');
      }
      this.setDeviceSessions(inputs);
      return { ok: true };
    });
  }

  registerIpc(): void {
    ipcMain.handle(AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL, (event, sessionId: unknown) => {
      const sourceWindow = BrowserWindow.fromWebContents(event.sender);
      if (!sourceWindow || sourceWindow.isDestroyed()) {
        return { ok: true };
      }
      const nextSessionId = parseVisibleSessionPayload(sessionId);
      if (!sourceWindow.isFocused() && !isAgentIslandPendingFocusAck(this.state, nextSessionId)) {
        return { ok: true };
      }
      const now = Date.now();
      let changed = setAgentIslandVisibleSession(this.state, nextSessionId, now);
      for (const visibleSessionId of getVisibleSessionIdsForReadAck(nextSessionId)) {
        // passive:仅凭「路由停在该会话 + 窗口聚焦」不足以证明用户看到了报错,
        // 未读 error 会话在 state 层对被动 ack 免疫(见 acknowledgeAgentIslandSessionRead)。
        changed = acknowledgeAgentIslandSessionRead(this.state, visibleSessionId, now, { source: 'passive' }) === 'cleared' || changed;
      }
      if (changed) {
        this.publish();
      }
      return { ok: true };
    });

    ipcMain.handle(AGENT_ISLAND_CONSUME_ENTRY_ALERT_CHANNEL, (event, rawSessionId: unknown, rawEntryId: unknown) => {
      assertTrustedAppRendererEvent(event);
      // 导航只发生在主窗;副窗也挂 MainLayout 级组件,不能替主窗处置提醒。
      const mainWindow = this.deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents !== event.sender) {
        return { ok: true, consumed: false };
      }
      const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
      if (!sessionId || sessionId.length > MAX_ISLAND_ENTRY_SESSION_ID_LENGTH) {
        throwIpcError('INVALID_PARAMS', 'sessionId is invalid');
      }
      if (typeof rawEntryId !== 'string' || !rawEntryId || rawEntryId.length > MAX_ISLAND_ENTRY_ID_LENGTH) {
        throwIpcError('INVALID_PARAMS', 'entryId is invalid');
      }
      return { ok: true, consumed: this.consumeIslandEntryAlert(sessionId, rawEntryId) };
    });

    ipcMain.handle(AGENT_ISLAND_SET_ENABLED_CHANNEL, (_event, enabled: unknown) => {
      if (typeof enabled !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'enabled must be boolean');
      }
      this.setEnabled(enabled);
      return { ok: true };
    });

    ipcMain.handle(AGENT_ISLAND_SET_SOUND_SETTINGS_CHANNEL, (_event, rawSettings: unknown) => {
      this.setSoundSettings(normalizeAgentIslandSoundSettings(rawSettings));
      return { ok: true };
    });

    ipcMain.handle(AGENT_ISLAND_SET_MASCOT_SKIN_CHANNEL, (_event, rawSkin: unknown) => {
      if (!isAgentIslandMascotSkin(rawSkin)) {
        throwIpcError('INVALID_PARAMS', 'mascot skin is invalid');
      }
      this.setMascotSkin(rawSkin);
      return { ok: true };
    });

    ipcMain.handle(AGENT_ISLAND_SET_DISPLAY_TARGET_CHANNEL, (_event, rawTarget: unknown) => {
      this.setDisplayTarget(normalizeAgentIslandDisplayTarget(rawTarget));
      return { ok: true };
    });

    ipcMain.handle(AGENT_ISLAND_GET_DISPLAY_OPTIONS_CHANNEL, () => {
      this.nativeHost.prepare?.();
      const displays = this.getAvailableDisplays();
      const selectedDisplay = this.resolveSelectedDisplay(displays);
      if (selectedDisplay) {
        const resolvedTarget = this.displayTargetForDisplay(displays, selectedDisplay);
        if (!sameAgentIslandDisplayTarget(this.displayTarget, resolvedTarget)) {
          // Electron display ids are runtime-scoped. Only rewrite the persisted
          // target after its saved identity resolves to a current display.
          this.displayTarget = resolvedTarget;
        }
      }
      return {
        ok: true,
        options: this.getDisplayOptions(),
        target: cloneAgentIslandDisplayTarget(this.displayTarget),
      };
    });

    ipcMain.handle(AGENT_ISLAND_PREVIEW_SOUND_CHANNEL, (_event, rawSound: unknown) => {
      const sound = parseAgentIslandSoundChoice(rawSound);
      if (!sound || isSilentAgentIslandSoundChoice(sound)) {
        return { ok: true };
      }
      this.nativeHost.playSound?.(sound);
      return { ok: true };
    });

    ipcMain.handle(AGENT_ISLAND_SELECT_SOUND_FILE_CHANNEL, async (event) => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? this.deps.getMainWindow();
      const options: OpenDialogOptions = {
        properties: ['openFile'],
        filters: [
          {
            name: 'Audio',
            extensions: ['mp3', 'wav', 'wave', 'aiff', 'aif', 'm4a', 'caf'],
          },
        ],
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      const filePath = result.canceled ? null : (result.filePaths[0] ?? null);
      return {
        ok: true,
        path: filePath,
        name: filePath ? path.basename(filePath) : null,
      };
    });
  }

  setEnabled(enabled: boolean): void {
    const wasSynced = this.enabledSynced;
    if (wasSynced && this.enabled === enabled) return;
    const now = Date.now();
    this.enabledSynced = true;
    this.enabled = enabled;
    this.hiddenPublished = false;
    if (!wasSynced && !enabled) {
      this.mutedCompletionSoundSessionIds.clear();
      this.hiddenPublished = true;
      // Windows / headless 永远走这条:岛 UI 关着,但远程未读 TTL 仍要自己触发。
      this.publish();
      return;
    }
    if (enabled) {
      this.syncAppContentFocusState(now);
    }
    this.publish();
  }

  /** Main-process consumers use this to avoid duplicating Agent Island completion UI. */
  isEnabled(): boolean {
    return this.enabledSynced && this.enabled;
  }

  refreshLocalization(): void {
    setAgentIslandStrings(this.state, buildAgentIslandStrings());
    this.publish();
  }

  setSoundSettings(settings: AgentIslandSoundSettings): void {
    this.soundSettings = cloneAgentIslandSoundSettings(settings);
    this.publish();
  }

  setMascotSkin(skin: AgentIslandMascotSkin): void {
    this.mascotSkin = skin;
    this.publish();
  }

  setDisplayTarget(target: AgentIslandDisplayTarget): void {
    const next = cloneAgentIslandDisplayTarget(target);
    if (sameAgentIslandDisplayTarget(this.displayTarget, next)) return;
    this.displayTarget = next;
    this.publish();
  }

  /**
   * 覆盖岛上的其它设备任务(renderer 已按侧栏「任务范围」裁剪)。这些条目不进入
   * 本机活动快照,也就不会被 relay 当作本机任务再推给控制端。
   */
  setDeviceSessions(inputs: readonly AgentIslandRemoteSessionInput[]): void {
    this.lastDeviceSessionInputs = inputs;
    this.remoteCompanionKeysInUse.clear();
    setAgentIslandStrings(this.state, buildAgentIslandStrings());
    const result = syncAgentIslandDeviceSessions(
      this.state,
      inputs,
      Date.now(),
      (input) => this.remoteCompanionSnapshot(input),
    );
    // Keep exactly the identities this input still names: bounded by the input itself, and a
    // large roster can never evict entries it is about to read again in the same pass.
    for (const key of this.remoteCompanions.keys()) {
      if (!this.remoteCompanionKeysInUse.has(key)) this.remoteCompanions.delete(key);
    }
    for (const input of inputs) {
      if (input.phase === 'completed' && input.completionNotification === 'silent') {
        this.mutedCompletionSoundSessionIds.add(input.sessionId);
      }
    }
    for (const sessionId of result.baselineSessionIds) this.baselineSoundSessionIds.add(sessionId);
    if (result.changed) this.publish();
    if (this.isEnabled()) return;
    for (const event of result.events) {
      try {
        this.deps.onDeviceSessionEvent?.(event);
      } catch (error) {
        log.warn('device session event consumer failed', {
          sessionId: event.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Mirror existing chat read positions, without publishing synthetic runtime activity. */
  setCompanionChats(inputs: readonly AgentIslandCompanionChatInput[]): void {
    const previous = this.companionChats;
    this.companionChats = new Map(inputs.map((input) => {
      const old = previous.get(input.sessionId);
      const entry = old && JSON.stringify(old.input) === JSON.stringify(input) ? old : {
        input, token: randomUUID(),
        companion: old && old.input.deviceId === input.deviceId
          && JSON.stringify(old.input.companion) === JSON.stringify(input.companion)
          ? old.companion : companionSnapshotWithoutArtwork(input.companion),
      };
      const live = this.state.sessions.get(input.sessionId);
      // Restoring history is silent; a just-completed runtime turn still gets its configured sound
      // when the chat query catches up with the terminal event.
      if (!live?.revealUntil || live.revealUntil <= Date.now()) this.baselineSoundSessionIds.add(input.sessionId);
      return [input.sessionId, entry];
    }));
    for (const [id, entry] of this.companionChats) {
      if (entry.companion.imageJpeg || !entry.input.visible || !companionAvatarHasArtwork(entry.input.companion.avatar)) continue;
      void companionAvatarThumbnail(entry.input.companion.avatar, entry.input.deviceId).then((imageJpeg) => {
        if (!imageJpeg || this.companionChats.get(id) !== entry) return;
        entry.companion = { ...entry.companion, imageJpeg };
        this.publish();
      });
    }
    this.publish();
  }

  setGroupChat(groupId: string, input: AgentIslandGroupChatInput | null): void {
    const sessionId = groupChatIslandId(groupId);
    const previous = this.state.sessions.get(sessionId)?.groupChat;
    if (!input && !previous) return;
    if (input && previous && JSON.stringify(previous.input) === JSON.stringify(input)) return;
    const avatars = input?.members.map((member, index) => {
      const old = previous?.input.members[index];
      return old && JSON.stringify(old) === JSON.stringify(member) ? previous!.avatars[index]!
        : companionSnapshotWithoutArtwork(member);
    }) ?? [];
    syncAgentIslandGroupChat(this.state, groupId, input, avatars, t('bots.groupChat.server.thread.mentionedYou'), Date.now());
    const chat = this.state.sessions.get(sessionId)?.groupChat;
    this.publish();
    if (!input || !chat) return;
    for (const [index, member] of input.members.entries()) {
      if (avatars[index]?.imageJpeg || !companionAvatarHasArtwork(member.avatar)) continue;
      void companionAvatarThumbnail(member.avatar).then(imageJpeg => {
        if (!imageJpeg || this.state.sessions.get(sessionId)?.groupChat !== chat) return;
        chat.avatars[index] = { ...chat.avatars[index]!, imageJpeg };
        this.publish();
      }).catch(() => undefined);
    }
  }

  /** True means this surface owns the alert; otherwise the caller uses the OS notification. */
  notifyGroupChat(groupId: string): boolean {
    if (!this.isEnabled() || this.headless || this.nativeHost.failed || this.nativeHost.available === false) return false;
    const chat = this.state.sessions.get(groupChatIslandId(groupId))?.groupChat;
    if (!chat) return false;
    const window = this.deps.getMainWindow();
    // Thread reads are authoritative; merely being on the group's URL does not read a thread.
    if (!chat.input.threadRootId && window?.isFocused() && window.isVisible()) {
      try {
        if (new URL(window.webContents.getURL()).hash.split('?')[0] === `#/bots/groups/${groupId}`) return true;
      } catch { /* A loading window is not a visible chat. */ }
    }
    revealAgentIslandGroupChat(this.state, groupId, Date.now());
    this.publish();
    return !this.nativeHost.failed && !this.nativeFailureLogged;
  }

  private companionChatProjections() {
    return [...this.companionChats.values()].map(({ input, companion, token }) => ({ ...input, companion, token }));
  }

  /**
   * A remote companion's identity is drawn at once with its tint and glyph; its artwork is
   * read through this computer's avatar copy and swapped in when ready. One object per
   * identity, so an unchanged companion never republishes the island.
   */
  private remoteCompanionSnapshot(input: AgentIslandRemoteSessionInput): AgentIslandCompanionSnapshot | null {
    const identity = input.companion;
    if (!identity) return null;
    const key = JSON.stringify([input.deviceId, identity.name, identity.avatar, identity.avatarColor]);
    this.remoteCompanionKeysInUse.add(key);
    const cached = this.remoteCompanions.get(key);
    if (cached) {
      // A failed read stays a glyph, but the next sync after the pause tries again; the
      // avatar copy keeps its own failure backoff, so this never hammers the other computer.
      if (cached.retryAt !== null && cached.retryAt <= Date.now()) this.loadRemoteCompanionArtwork(key, input, cached.snapshot);
      return cached.snapshot;
    }
    const base = companionSnapshotWithoutArtwork(identity);
    this.remoteCompanions.set(key, { snapshot: base, retryAt: null });
    this.loadRemoteCompanionArtwork(key, input, base);
    return base;
  }

  private loadRemoteCompanionArtwork(
    key: string,
    input: AgentIslandRemoteSessionInput,
    base: AgentIslandCompanionSnapshot,
  ): void {
    const avatar = input.companion?.avatar;
    if (!avatar || !companionAvatarHasArtwork(avatar)) return;
    const entry = this.remoteCompanions.get(key);
    if (!entry || entry.retryAt === Number.POSITIVE_INFINITY) return;
    // Marks the read as in flight until it settles.
    entry.retryAt = Number.POSITIVE_INFINITY;
    void companionAvatarThumbnail(avatar, input.deviceId).then((imageJpeg) => {
      const current = this.remoteCompanions.get(key);
      if (!current || current.snapshot !== base) return;
      if (!imageJpeg) {
        current.retryAt = Date.now() + REMOTE_COMPANION_ARTWORK_RETRY_MS;
        return;
      }
      this.remoteCompanions.set(key, { snapshot: { ...base, imageJpeg }, retryAt: null });
      this.setDeviceSessions(this.lastDeviceSessionInputs);
    });
  }

  waitForCompletionNotification(sessionId: string): Promise<boolean> | undefined {
    return this.sessionActivityRelay.waitForCompletionNotification(sessionId);
  }

  resetRuntimeState(): void {
    this.clearPublishTimer();
    this.clearStreamingPreviewPublishTimer();
    this.flushLayoutPreferenceWrites();
    this.sessionActivityRelay.reset();
    for (const runId of Array.from(this.silencedRunClearTimers.keys())) {
      this.clearSilencedRunTimer(runId);
    }
    resetAgentIslandState(this.state);
    this.companionChats.clear();
    this.publishAttentionCount(0);
    this.islandEntryAlert = null;
    this.emitSessionActivityTransitions([], Date.now());
    this.metadataCache.clear();
    this.metadataLoading.clear();
    this.remoteCompanions.clear();
    this.remoteCompanionKeysInUse.clear();
    this.companionReadSeq.clear();
    this.companionChangeEpoch = 0;
    this.lastDeviceSessionInputs = [];
    this.lastSoundDisplayState = null;
    this.soundCooldownUntilByEvent.clear();
    this.silencedRunSessionIds.clear();
    this.silencedSessionRunIds.clear();
    this.silencedRunHadAttention.clear();
    this.mutedCompletionSoundSessionIds.clear();
    this.baselineSoundSessionIds.clear();
    this.stoppedSessionIds.clear();
    this.replacementTurnPendingSessionIds.clear();
    this.replacementTurnDispatchingSessionIds.clear();
    this.stoppedProviderTurnIdBySession.clear();
    this.interactionEpochBySession.clear();
    this.sessionHadAttentionAtRunStart.clear();
    this.unreadAttentionGenerationBySession.clear();
    this.userPromptRollbackTokens.clear();
    this.deferredCompletions.clear();
    for (const sessionId of this.deferredRemoteAuthErrors.keys()) {
      this.clearDeferredRemoteAuthError(sessionId);
    }
    this.nativeFailureLogged = false;
    this.enabled = false;
    this.enabledSynced = this.headless;
    this.hiddenPublished = true;
    if (this.nativeHost.suspend) {
      this.nativeHost.suspend();
    } else {
      this.publishHidden(Date.now());
    }
    this.notifySessionActivityConsumer([]);
  }

  setAppFocused(focused: boolean): void {
    const now = Date.now();
    if (focused) {
      // Window focus can arrive before the focused renderer reports its route.
      // Drop the previous focused window's sessions so app focus cannot
      // smart-suppress a completion for a session the user is no longer viewing.
      setAgentIslandVisibleSession(this.state, null, now);
    }
    setAgentIslandAppFocused(this.state, focused, now);
    this.publish();
  }

  private syncAppContentFocusState(now: number): void {
    const focused = BrowserWindow.getAllWindows().some((win) => isFocusedAppContentWindow(win));
    if (focused) {
      setAgentIslandVisibleSession(this.state, null, now);
    }
    setAgentIslandAppFocused(this.state, focused, now);
  }

  handleAgentEvent(
    meta: AgentIslandSessionMeta,
    event: AgentEvent,
  ): void {
    const hydrated = this.hydrateMeta(meta);
    const providerTurnId = providerTurnIdFromAgentEvent(event);
    const replacementPending =
      this.replacementTurnPendingSessionIds.has(hydrated.sessionId);
    const stoppedProviderTurnId =
      this.stoppedProviderTurnIdBySession.get(hydrated.sessionId);
    if (isCompletionDoneEvent(event) && providerTurnId && stoppedProviderTurnId) {
      if (providerTurnId === stoppedProviderTurnId) return;
      // A different provider turn id proves this terminal event belongs to the
      // replacement even if its running status has not reached Desktop yet.
      this.stoppedProviderTurnIdBySession.delete(hydrated.sessionId);
      if (replacementPending) {
        this.replacementTurnPendingSessionIds.delete(hydrated.sessionId);
        this.replacementTurnDispatchingSessionIds.delete(hydrated.sessionId);
      }
    }
    // Stop is applied synchronously by the main-process abort path. A provider
    // cancellation that arrives inside that boundary is only its terminal tail.
    // Outside a Stop/replacement boundary, cancellation can also be the sole
    // terminal event (for example Codex permission tightening), so it must close
    // the visible run without treating it as a successful completion.
    if (isCancelledTerminalEvent(event)) {
      if (this.stoppedSessionIds.has(hydrated.sessionId)) return;
      if (
        this.replacementTurnPendingSessionIds.has(hydrated.sessionId) &&
        !this.replacementTurnDispatchingSessionIds.has(hydrated.sessionId)
      ) return;
      this.handleSessionStopped(hydrated.sessionId, providerTurnId);
      return;
    }
    // Provider aborts can drain ordinary status/done events after the user has
    // already stopped the turn. Keep those tails from recreating a completed
    // island entry until a replacement prompt begins the restart handshake.
    if (this.stoppedSessionIds.has(hydrated.sessionId)) return;
    // Claude Code queues a new turn's running status behind any remaining
    // completion tail from the interrupted turn. Keep completion suppressed
    // after the replacement prompt until that FIFO start marker arrives.
    if (this.replacementTurnPendingSessionIds.has(hydrated.sessionId)) {
      if (isCompletionDoneEvent(event)) return;
      if (isRunningStatusEvent(event)) {
        this.replacementTurnPendingSessionIds.delete(hydrated.sessionId);
        this.replacementTurnDispatchingSessionIds.delete(hydrated.sessionId);
      }
    }
    if (this.deferredRemoteAuthErrors.has(hydrated.sessionId)) {
      // The failed turn's status Done/done tail is bookkeeping, not a user-visible
      // completion. A running status proves the replacement turn was accepted.
      if (isCompletionDoneEvent(event)) return;
      if (isRunningStatusEvent(event)) {
        this.clearDeferredRemoteAuthError(hydrated.sessionId);
      }
    }
    const now = Date.now();
    setAgentIslandStrings(this.state, buildAgentIslandStrings());
    this.prunePermissionRequestsForAgentEvent(hydrated.sessionId, event);
    if (
      isCompletionDoneEvent(event) &&
      this.shouldDeferCompletion?.(hydrated.sessionId) === true &&
      // Thread 2 fix: silenced completions carry no attention/sound regardless of
      // queue state, so there is no need to defer them — apply with no-attention
      // immediately. Linger 只挂 scheduler 的 completed && silenced;中间 agent done
      // 不得开 linger,否则续 turn 会清掉标记。这里仍跳过 defer,免得 completed 先到
      // 排了 linger 后,队列排空重放时标记已退场、被当成普通完成。
      !this.isCompletionEventSilenced(hydrated.sessionId, event)
    ) {
      if (event.type === 'done') {
        this.deletePermissionRequestsForSession(hydrated.sessionId);
      }
      this.deferredCompletions.set(hydrated.sessionId, { event, suppressAttention: false });
      this.clearStreamingPreviewPublishTimer();
      this.publish();
      return;
    }
    if (!isCompletionDoneEvent(event)) {
      this.clearCompletedSilencedRunForNewActivity(hydrated.sessionId);
      this.deferredCompletions.delete(hydrated.sessionId);
    }
    if (process.platform === 'darwin' && event.type === 'tool_result_full') {
      const data = event.data as { fullText?: string; isError?: boolean } | undefined;
      // Codex marks successful results explicitly; Claude Code currently omits isError.
      // Skip only a known success so Claude Code EPERM output still receives guidance.
      const folderKind = data?.isError !== false && data?.fullText
        ? detectProtectedFolderEperm(data.fullText)
        : null;
      if (folderKind) {
        void this.resolveProtectedFolderDenial(folderKind).catch((error: unknown) => {
          log.warn('protected folder guidance flow failed', { kind: folderKind, error });
        });
      }
    }
    const suppressCompletionAttention = this.isCompletionEventSilenced(hydrated.sessionId, event);
    if (isCompletionDoneEvent(event) && event.type === 'status') {
      this.sessionActivityRelay.awaitCompletionTerminal(hydrated.sessionId);
    }
    const changed = applyAgentIslandEvent(this.state, hydrated, event, now, {
      suppressCompletionAttention,
      // Direct IM sends bypass handleUserPrompt. Running preserves unread in the
      // live state/ledger, so use that state (including any intervening read ack).
      preserveCompletionAttention: suppressCompletionAttention && !this.isGroupLaneEvent(hydrated.sessionId, event) && (
        event.turnOrigin?.surface === 'im'
          ? hasAgentIslandSessionAttention(this.state, hydrated.sessionId)
          : this.hadAttentionBeforeSilencedCompletion(hydrated.sessionId)
      ),
      allowCompletionAfterTerminalError:
        isRemoteDaemonClosedErrorEvent(event) &&
        this.deps.isPlannedRemoteDaemonClose?.(hydrated.sessionId) === true,
    });
    if (suppressCompletionAttention) {
      this.mutedCompletionSoundSessionIds.add(hydrated.sessionId);
    }
    if (isCompletionDoneEvent(event) && event.type === 'done') {
      this.sessionActivityRelay.completeTerminal(hydrated.sessionId);
    }
    if (!changed) return;
    this.ensureMetadata(hydrated.sessionId);
    if (!suppressCompletionAttention) {
      this.syncSessionAttention(hydrated.sessionId);
    }
    if (this.state.remoteUnreadTerminals.has(hydrated.sessionId)) {
      this.bumpUnreadAttentionGeneration(hydrated.sessionId);
    }
    if (isStreamingPreviewEvent(event)) {
      this.scheduleStreamingPreviewPublish();
      return;
    }
    this.clearStreamingPreviewPublishTimer();
    this.publish();
  }

  handleScheduleEvent(event: SchedulerEvent): void {
    if (event.type === 'silenced') {
      this.markSilencedScheduleRun(event.runId, event.sessionId);
      return;
    }
    if (event.type === 'notified') {
      this.clearSilencedScheduleRun(event.runId);
      return;
    }
    if (event.type === 'completed' && event.silenced) {
      const hadPreviousAttention = event.sessionId ? this.hadAttentionBeforeSilencedCompletion(event.sessionId) : false;
      if (event.sessionId) this.markSilencedScheduleRun(event.runId, event.sessionId);
      const changed = event.sessionId
        ? completeAgentIslandSessionWithoutAttention(this.state, event.sessionId, Date.now(), {
          preserveAttention: hadPreviousAttention,
        })
        : false;
      if (event.sessionId && hadPreviousAttention) this.bumpUnreadAttentionGeneration(event.sessionId);
      if (event.sessionId) this.sessionHadAttentionAtRunStart.delete(event.sessionId);
      // 若该会话有延后完成事件(之前因队列非空被推迟),标记为应压制注意力,
      // 防止队列排空后 notifyQueueEmptied 重放时 silencedSessionRunIds 已被清除、
      // 误触发 reveal/sound。
      if (event.sessionId) {
        const deferred = this.deferredCompletions.get(event.sessionId);
        if (deferred) {
          this.deferredCompletions.set(event.sessionId, { ...deferred, suppressAttention: true });
        }
      }
      this.scheduleSilencedRunClear(event.runId, SILENCED_COMPLETION_CLEAR_MS);
      if (changed) this.publish();
      return;
    }
    if (event.type === 'completed' || event.type === 'failed' || event.type === 'deferred') {
      this.clearSilencedScheduleRun(event.runId);
    }
  }

  handleUserPrompt(meta: AgentIslandSessionMeta, prompt: string, debugMeta: AgentIslandUserPromptDebugMeta = {}): boolean {
    const receivedAt = Date.now();
    const hydrated = this.hydrateMeta(meta);
    const rollbackKey = this.userPromptRollbackKey(hydrated.sessionId, debugMeta.clientId);
    // 入队预览和 persist 预览共用 clientId。已经预览过的第二次只确认,不再追加
    // activity、不推进 epoch,否则岛上同一条消息出现两遍、开始音效对应的回滚基线也会被冲掉。
    if (rollbackKey && this.userPromptRollbackTokens.has(rollbackKey)) {
      return true;
    }
    const previousInteractionEpoch = this.interactionEpochBySession.get(hydrated.sessionId);
    const wasStopped = this.stoppedSessionIds.has(hydrated.sessionId);
    const wasReplacementTurnPending = this.replacementTurnPendingSessionIds.has(hydrated.sessionId);
    const wasReplacementTurnDispatching =
      this.replacementTurnDispatchingSessionIds.has(hydrated.sessionId);
    const startsReplacementTurn = debugMeta.replacesCurrentTurn === true;
    const deferInteractionEpochUntilDispatch =
      startsReplacementTurn || wasStopped || wasReplacementTurnPending;
    if (!deferInteractionEpochUntilDispatch) {
      this.advanceInteractionEpoch(hydrated.sessionId);
    }
    if (wasStopped) {
      this.stoppedSessionIds.delete(hydrated.sessionId);
    }
    if (wasStopped || startsReplacementTurn) {
      this.replacementTurnPendingSessionIds.add(hydrated.sessionId);
    }
    if (deferInteractionEpochUntilDispatch) {
      this.replacementTurnDispatchingSessionIds.delete(hydrated.sessionId);
    }
    if (rollbackKey) {
      this.userPromptRollbackTokens.set(rollbackKey, {
        state: createAgentIslandUserPromptRollbackToken(this.state, hydrated.sessionId),
        attention: this.sessionHadAttentionAtRunStart.has(hydrated.sessionId)
          ? { existed: true, value: this.sessionHadAttentionAtRunStart.get(hydrated.sessionId) ?? false }
          : { existed: false, value: false },
        interactionEpoch: previousInteractionEpoch === undefined
          ? { existed: false, value: 0 }
          : { existed: true, value: previousInteractionEpoch },
        wasStopped,
        wasReplacementTurnPending,
        wasReplacementTurnDispatching,
      });
    }
    this.clearCompletedSilencedRunForNewActivity(hydrated.sessionId);
    this.sessionHadAttentionAtRunStart.set(
      hydrated.sessionId,
      hasAgentIslandSessionAttention(this.state, hydrated.sessionId),
    );
    const changed = applyAgentIslandUserPrompt(this.state, hydrated, prompt, receivedAt);
    if (!changed) {
      if (rollbackKey) this.userPromptRollbackTokens.delete(rollbackKey);
      if (wasStopped) {
        this.stoppedSessionIds.add(hydrated.sessionId);
      }
      if (!wasReplacementTurnPending) {
        this.replacementTurnPendingSessionIds.delete(hydrated.sessionId);
      }
      if (wasReplacementTurnDispatching) {
        this.replacementTurnDispatchingSessionIds.add(hydrated.sessionId);
      } else {
        this.replacementTurnDispatchingSessionIds.delete(hydrated.sessionId);
      }
      this.restoreInteractionEpoch(hydrated.sessionId, previousInteractionEpoch);
      return false;
    }
    this.ensureMetadata(hydrated.sessionId);
    this.syncSessionAttention(hydrated.sessionId);
    this.publish();
    return true;
  }

  commitUserPrompt(sessionId: string, clientId: string | undefined): void {
    const rollbackKey = this.userPromptRollbackKey(sessionId, clientId);
    if (!rollbackKey) return;
    this.userPromptRollbackTokens.delete(rollbackKey);
  }

  rollbackUserPrompt(sessionId: string, clientId: string | undefined): void {
    const rollbackKey = this.userPromptRollbackKey(sessionId, clientId);
    if (!rollbackKey) return;
    const snapshot = this.userPromptRollbackTokens.get(rollbackKey);
    if (!snapshot) return;
    this.userPromptRollbackTokens.delete(rollbackKey);
    rollbackAgentIslandUserPrompt(this.state, snapshot.state);
    if (snapshot.attention.existed) {
      this.sessionHadAttentionAtRunStart.set(sessionId, snapshot.attention.value);
    } else {
      this.sessionHadAttentionAtRunStart.delete(sessionId);
    }
    if (snapshot.wasStopped) this.stoppedSessionIds.add(sessionId);
    else this.stoppedSessionIds.delete(sessionId);
    if (snapshot.wasReplacementTurnPending) this.replacementTurnPendingSessionIds.add(sessionId);
    else this.replacementTurnPendingSessionIds.delete(sessionId);
    if (snapshot.wasReplacementTurnDispatching) {
      this.replacementTurnDispatchingSessionIds.add(sessionId);
    } else {
      this.replacementTurnDispatchingSessionIds.delete(sessionId);
    }
    this.restoreInteractionEpoch(
      sessionId,
      snapshot.interactionEpoch.existed ? snapshot.interactionEpoch.value : undefined,
    );
    this.publish();
  }

  /**
   * Captures the current user-turn boundary before interaction delivery. A
   * prompt dispatch or Stop advances the epoch, allowing an earlier request to
   * be rejected before it is surfaced.
   */
  captureInteractionEpoch(sessionId: string): number {
    const current = this.interactionEpochBySession.get(sessionId);
    if (current !== undefined) return current;
    return this.advanceInteractionEpoch(sessionId);
  }

  /**
   * Advances the replacement turn's interaction boundary at the last
   * synchronous point before Session invokes vendor code. A callback from the
   * stopped turn that began while the replacement was only previewed keeps the
   * older epoch; a callback from the dispatched replacement captures the new
   * one even if its running status has not reached Desktop yet.
   */
  handleUserPromptDispatching(sessionId: string): void {
    if (!this.replacementTurnPendingSessionIds.has(sessionId)) return;
    this.advanceInteractionEpoch(sessionId);
    this.replacementTurnDispatchingSessionIds.add(sessionId);
  }

  isInteractionCurrent(sessionId: string, interactionEpoch: number): boolean {
    if (this.interactionEpochBySession.get(sessionId) !== interactionEpoch) return false;
    if (this.stoppedSessionIds.has(sessionId)) return false;
    return (
      !this.replacementTurnPendingSessionIds.has(sessionId) ||
      this.replacementTurnDispatchingSessionIds.has(sessionId)
    );
  }

  handleInteractionRequest(
    meta: AgentIslandSessionMeta,
    request: InteractionRequest,
    interactionEpoch: number,
  ): void {
    const hydrated = this.hydrateMeta(meta);
    if (!this.isInteractionCurrent(hydrated.sessionId, interactionEpoch)) return;
    if (request.kind === 'permission') {
      this.permissionRequests.set(request.requestId, { sessionId: hydrated.sessionId, request });
    }
    setAgentIslandStrings(this.state, buildAgentIslandStrings());
    applyAgentIslandInteractionRequest(this.state, hydrated, request, Date.now());
    this.ensureMetadata(hydrated.sessionId);
    this.syncSessionAttention(hydrated.sessionId);
    this.publish();
  }

  handleInteractionDismissed(sessionId: string, requestId: string): void {
    this.permissionRequests.delete(requestId);
    const now = Date.now();
    applyAgentIslandInteractionDismissed(this.state, sessionId, requestId, now);
    this.restorePendingPermissionRequest(sessionId, now);
    this.publish();
  }

  /** Host-owned waits (plugin setup, input handoff) shown as attention until dismissed. */
  handlePluginSetupInteraction(
    sessionId: string,
    requestId: string,
    detail: string,
    kind: 'plugin_setup' | 'input_handoff' = 'plugin_setup',
  ): void {
    const hydrated = this.hydrateMeta({ sessionId });
    setAgentIslandStrings(this.state, buildAgentIslandStrings());
    // If the requestId is already pending (revision update from the coordinator),
    // only update the detail string without resetting the dismissal state.
    const existing = this.state.sessions.get(hydrated.sessionId);
    if (existing?.pendingInteractionIds.has(requestId)) {
      existing.pendingInteractionDetails.set(requestId, detail);
      this.publish();
      return;
    }
    applyAgentIslandInteractionRequest(
      this.state,
      hydrated,
      kind === 'input_handoff'
        ? { kind: 'input_handoff', requestId, detail }
        : { kind: 'plugin_setup', requestId, detail },
      Date.now(),
    );
    this.ensureMetadata(hydrated.sessionId);
    this.syncSessionAttention(hydrated.sessionId);
    this.publish();
  }

  handleInteractionDismissedByRequestId(requestId: string): boolean {
    const entry = this.permissionRequests.get(requestId);
    if (!entry) return false;
    this.handleInteractionDismissed(entry.sessionId, requestId);
    return true;
  }

  private restorePendingPermissionRequest(sessionId: string, now: number): void {
    let pending: Extract<InteractionRequest, { kind: 'permission' }> | null = null;
    for (const entry of this.permissionRequests.values()) {
      if (entry.sessionId === sessionId) {
        pending = entry.request;
        break;
      }
    }
    if (!pending) return;
    applyAgentIslandInteractionRequest(this.state, { sessionId }, pending, now);
  }

  private prunePermissionRequestsForAgentEvent(sessionId: string, event: AgentEvent): void {
    if (isTurnContinuationBoundaryEvent(event)) return;
    if (event.type === 'done' || isTerminalAgentErrorEvent(event)) {
      this.deletePermissionRequestsForSession(sessionId);
      return;
    }
    if (event.type !== 'tool_use' && event.type !== 'tool_result') return;
    for (const requestId of permissionRequestIdsFromAgentEvent(event)) {
      const entry = this.permissionRequests.get(requestId);
      if (entry?.sessionId === sessionId) {
        this.permissionRequests.delete(requestId);
      }
    }
  }

  private deletePermissionRequestsForSession(sessionId: string): void {
    for (const [requestId, entry] of this.permissionRequests.entries()) {
      if (entry.sessionId === sessionId) {
        this.permissionRequests.delete(requestId);
      }
    }
  }

  /**
   * 「消息免打扰」发生变化:只影响展示面(岛面 / 菜单栏 / 提示音)。重发一次即可 ——
   * 抑制集合在 publish() 里从同步索引重新对齐。静音任务的 Agent 事件仍照常进状态机,
   * 侧栏卡片的实时活动、等待交互态与远端活动镜像不受影响。
   */
  handleNotificationMuteChanged(): void {
    // 取消静音会让任务重新进入展示面。若它在此期间还在跑 / 已完成 / 报错 / 等确认,
    // 逐帧比较会把「重新出现」当成一次新转移,补播一次 start / complete / error /
    // attention 提示音。把刚解除抑制的任务记进本帧的声音基线,只为旧状态重发一次画面。
    if (this.enabledSynced && this.enabled) {
      for (const sessionId of this.state.sessions.keys()) {
        if (
          this.state.displaySuppressedSessionIds.has(sessionId) &&
          !isSessionNotificationsMutedSync(sessionId)
        ) {
          this.baselineSoundSessionIds.add(sessionId);
        }
      }
    }
    this.publish();
  }

  /**
   * @param options.reason
   *   `'discarded'`(默认)= 这条记录不该再存在(会话归档 / 删除、Orca worker 被策略
   *   清除),条目硬删。
   *   `'process-closed'` = 只是 agent 进程收了(典型:临时会话调度 run 终态后的
   *   closeSession),仍在展示的完成 / 错误卡片必须留着走完 dwell,否则刚弹出的卡片会
   *   当场消失。见 `closeAgentIslandSessionPreservingUnread`。
   */
  handleSessionClosed(
    sessionId: string,
    options: { reason?: 'discarded' | 'process-closed' } = {},
  ): void {
    this.stoppedSessionIds.delete(sessionId);
    this.replacementTurnPendingSessionIds.delete(sessionId);
    this.replacementTurnDispatchingSessionIds.delete(sessionId);
    this.stoppedProviderTurnIdBySession.delete(sessionId);
    this.interactionEpochBySession.delete(sessionId);
    this.clearSilencedRunForSession(sessionId);
    this.sessionHadAttentionAtRunStart.delete(sessionId);
    for (const key of this.userPromptRollbackTokens.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.userPromptRollbackTokens.delete(key);
      }
    }
    this.deferredCompletions.delete(sessionId);
    // Remote auth retry closes the failed session before the renderer reports
    // whether its replacement turn started, so keep that deferred error here.
    if (options.reason === 'process-closed') {
      closeAgentIslandSessionPreservingUnread(this.state, sessionId, Date.now());
    } else {
      this.unreadAttentionGenerationBySession.delete(sessionId);
      removeAgentIslandSession(this.state, sessionId);
    }
    this.deletePermissionRequestsForSession(sessionId);
    this.publish();
  }

  /**
   * Applies the user-visible Stop boundary before provider-specific abort tails
   * arrive. A stopped turn is neither a success nor an error, so it leaves no
   * completion card, unread attention, or completion sound behind.
   */
  handleSessionStopped(sessionId: string, providerTurnId: string | null = null): void {
    this.advanceInteractionEpoch(sessionId);
    this.stoppedProviderTurnIdBySession.delete(sessionId);
    if (providerTurnId) {
      this.stoppedProviderTurnIdBySession.set(sessionId, providerTurnId);
    }
    this.stoppedSessionIds.add(sessionId);
    this.replacementTurnPendingSessionIds.delete(sessionId);
    this.replacementTurnDispatchingSessionIds.delete(sessionId);
    this.clearSilencedRunForSession(sessionId);
    this.sessionHadAttentionAtRunStart.delete(sessionId);
    this.unreadAttentionGenerationBySession.delete(sessionId);
    for (const key of this.userPromptRollbackTokens.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.userPromptRollbackTokens.delete(key);
      }
    }
    this.deferredCompletions.delete(sessionId);
    this.clearDeferredRemoteAuthError(sessionId);
    this.deletePermissionRequestsForSession(sessionId);
    const hadSession = this.state.sessions.has(sessionId);
    const hadUnread = this.state.remoteUnreadTerminals.has(sessionId);
    removeAgentIslandSession(this.state, sessionId);
    if (hadSession || hadUnread) this.publish();
  }

  private advanceInteractionEpoch(sessionId: string): number {
    this.interactionEpochSequence += 1;
    this.interactionEpochBySession.set(sessionId, this.interactionEpochSequence);
    return this.interactionEpochSequence;
  }

  private restoreInteractionEpoch(sessionId: string, epoch: number | undefined): void {
    if (epoch === undefined) {
      this.interactionEpochBySession.delete(sessionId);
      return;
    }
    this.interactionEpochBySession.set(sessionId, epoch);
  }

  /**
   * badge 桥接来的会话已读信号(renderer → appBadgeService → 这里)。
   * source 默认 'passive'(fail-safe):renderer 未声明意图的清除一律当被动信号,
   * 未读 error 条目免疫;只有处置路径(用户操作报错横幅 / 全部标为已读 /
   * pending-alerts 派生收敛)显式带 'explicit' 才能清掉未处理的报错。
   */
  handleSessionAttentionCleared(sessionId: string, source: 'explicit' | 'passive' = 'passive'): void {
    if (isAgentIslandDeviceSession(this.state, sessionId)) {
      // 其它设备的任务:只收本机岛面的未读,本机 relay 账本与它无关。
      if (acknowledgeAgentIslandSessionRead(this.state, sessionId, Date.now(), { source }) === 'cleared') {
        this.publish();
      }
      return;
    }
    const ack = acknowledgeAgentIslandSessionRead(this.state, sessionId, Date.now(), { source });
    // 未读 error 对 passive 免疫:state / 独立账本都未动,也**不能**给远端发收尾包。
    if (ack === 'error-immune') return;
    if (ack === 'not-found') {
      // 内存账本没有这条:典型是进程重启。只对**本机拥有**的会话补收尾包。
      // 查询是异步的,必须带入队时代;回来时若已有新一轮未读或 live 条目,旧回执作废。
      const generation = this.unreadAttentionGenerationBySession.get(sessionId) ?? 0;
      void getSessionRowSnapshot(sessionId)
        .then((row) => {
          if ((this.unreadAttentionGenerationBySession.get(sessionId) ?? 0) !== generation) {
            log.debug(`session read ack: session=${sessionId} source=${source} state=not-found; superseded`);
            return;
          }
          if (this.state.sessions.has(sessionId) || this.state.remoteUnreadTerminals.has(sessionId)) {
            log.debug(`session read ack: session=${sessionId} source=${source} state=not-found; live-or-unread returned, withheld`);
            return;
          }
          if (!row) {
            log.debug(`session read ack: session=${sessionId} source=${source} state=not-found; no local row, withheld`);
            return;
          }
          this.sessionActivityRelay.ensureSessionTerminalClear(sessionId);
          log.debug(`session read ack: session=${sessionId} source=${source} state=not-found; local row found, terminal clear ensured`);
        })
        .catch(() => undefined);
      return;
    }
    if (this.sessionHadAttentionAtRunStart.has(sessionId)) {
      this.sessionHadAttentionAtRunStart.set(sessionId, false);
    }
    this.unreadAttentionGenerationBySession.delete(sessionId);
    // 收尾包兜底必须在 publish() **之前**。ensure 只在 relay 没有该会话条目时补发;
    // 已有 entry(live 或刚发出的未读终态)不动,由 publish() 把账本投影出去。
    this.sessionActivityRelay.ensureSessionTerminalClear(sessionId);
    if (ack === 'cleared') this.publish();
    log.debug(`session read ack: session=${sessionId} source=${source} state=${ack}`);
  }

  handleSessionAttentionMarked(sessionId: string): void {
    if (!markAgentIslandSessionAttention(this.state, sessionId)) return;
    this.publish();
  }

  handleSessionMetadataPatch(
    sessionId: string,
    patch: { title?: string | null; workingDir?: string | null; projectDir?: string | null; workspaceKind?: string | null },
  ): void {
    const current: AgentIslandCachedMetadata = this.metadataCache.get(sessionId) ?? {
      title: null,
      workingDir: null,
      workspaceKind: null,
    };
    const next = {
      ...current,
      title: patch.title !== undefined ? patch.title : current.title,
      workingDir: patch.workingDir !== undefined ? patch.workingDir : current.workingDir,
      projectDir: patch.projectDir !== undefined ? patch.projectDir : current.projectDir,
      workspaceKind: patch.workspaceKind !== undefined ? patch.workspaceKind : current.workspaceKind,
    };
    this.commitMetadata(sessionId, next);
  }

  /** A companion's name or avatar changed: redraw the Sessions that speak as it. */
  handleCompanionProfileChanged(botId: string): void {
    this.companionChangeEpoch += 1;
    this.refreshCompanionSessions((identity) => identity.botId === botId);
  }

  /** A group was renamed or removed: redraw the group lanes that show its name. */
  handleBotGroupChanged(groupId: string): void {
    this.companionChangeEpoch += 1;
    this.refreshCompanionSessions((identity) => identity.groupId === groupId);
  }

  /**
   * The only way a companion identity is read (first load and refresh alike). Invariant: what a
   * Session shows is the result of a read that started after the latest identity change.
   *  - A read is superseded (undefined) when a newer read for the same Session started, so an
   *    older, slower one never overwrites it.
   *  - A change that lands while a read is in flight (even before the Session's companion is
   *    known, so no refresh could target it) bumps the epoch; that read is repeated until a read
   *    finishes with no change during it. Each repeat needs a new user edit, so this is not a
   *    loop that can spin on its own, and giving up would leave an older identity on the card.
   */
  private async readCompanionIdentityFresh(sessionId: string): Promise<AgentIslandCompanionIdentity | null | undefined> {
    const seq = (this.companionReadSeq.get(sessionId) ?? 0) + 1;
    this.companionReadSeq.set(sessionId, seq);
    for (;;) {
      const epoch = this.companionChangeEpoch;
      const identity = await readAgentIslandCompanion(sessionId);
      if (this.companionReadSeq.get(sessionId) !== seq) return undefined;
      if (epoch === this.companionChangeEpoch) return identity;
    }
  }

  private refreshCompanionSessions(matches: (identity: AgentIslandCompanionIdentity) => boolean): void {
    for (const [sessionId, cached] of this.metadataCache) {
      if (!cached.companion || !matches(cached.companion)) continue;
      void this.readCompanionIdentityFresh(sessionId)
        .then((companion) => {
          if (companion === undefined) return;
          const latest = this.metadataCache.get(sessionId);
          if (latest) this.commitMetadata(sessionId, { ...latest, companion });
        })
        .catch((err) => {
          log.warn('companion identity refresh failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }

  /**
   * 按需重放当前会话活动快照。`emit` 由调用方(bootstrap)注入定向 sink 时,
   * 快照只投给刚完成 sessions 订阅的那一台控制端;不传则沿默认广播通道扇出。
   */
  replaySessionActivity(emit?: (payload: SessionActivityPayload) => void): void {
    this.sessionActivityRelay.replay(this.buildSessionActivityPayload(), emit);
  }

  /**
   * 会话元数据的**唯一写出口**:落 cache + patch state + 发布。
   *
   * 这里**只存原始标题**,不做本地化投影 —— 投影统一推迟到 {@link localizeDisplayState}
   * (构建送给 native 的 payload 那一刻)。两个理由:
   *
   *   - `metadataCache` 必须是原始值 —— {@link ensureMetadata} 靠
   *     `isPlaceholderSessionTitle(cached.title)` 判断「还没拿到权威标题、需要重拉」。
   *     把本地化文案写进 cache 会让该判定恒为 false,权威标题永远不会再被加载。
   *   - `state` 也必须是原始值 —— 否则切换应用语言时,`refreshLocalization()` 只重建
   *     `state.strings` 并 republish,不会重新投影 metadata,灵动岛会一直显示旧语言的
   *     兜底文案,直到下一次 metadata 事件才纠正(PR #1031 review P1)。存原始值 +
   *     publish 时投影,切语言后的那次 republish 自然就是新语言,不需要任何重投影逻辑。
   */
  private commitMetadata(sessionId: string, meta: AgentIslandCachedMetadata): void {
    this.metadataCache.set(sessionId, meta);
    const { companion, ...rest } = meta;
    if (!patchAgentIslandMetadata(this.state, {
      sessionId,
      ...rest,
      ...(companion !== undefined ? { companion: companion?.companion ?? null } : {}),
    })) return;
    // Fast group replies can finish before identity resolves. The reply's chat read position
    // owns completion attention; running, failure and approval cards remain runtime-owned.
    if (companion?.groupId && this.state.sessions.get(sessionId)?.phase === 'completed') {
      completeAgentIslandSessionWithoutAttention(this.state, sessionId, Date.now(), { preserveAttention: false });
    }
    this.publish();
  }

  private hydrateMeta(
    meta: AgentIslandSessionMeta,
  ): AgentIslandSessionMeta & { title?: string | null; companion?: AgentIslandCompanionSnapshot | null } {
    const cached = this.metadataCache.get(meta.sessionId);
    return {
      ...meta,
      // 原始标题:投影只在 publish 构建 payload 时做(见 commitMetadata 的说明)。
      title: cached?.title ?? null,
      workingDir: cached?.workingDir ?? meta.workingDir,
      // A persisted clear must win over stale event metadata as well.
      projectDir: cached?.projectDir !== undefined ? cached.projectDir : meta.projectDir,
      workspaceKind: cached?.workspaceKind ?? meta.workspaceKind,
      ...(cached?.companion !== undefined ? { companion: cached.companion?.companion ?? null } : {}),
    };
  }

  /**
   * agent 输出里的关键词只是粗筛,真相由 Main 亲自向系统核实一次:
   *
   * - 读得动 → 那条 EPERM 与 TCC 无关(agent 常常只是读到了**写着这个词的文件内容**),
   *   什么都不做,也不消耗该目录的提醒名额。
   * - 读不动 → 确认被拒,才提示用户。这次探测同时把 TCC 归因落到 Cindy.app 上,系统
   *   自己的授权弹窗有机会出现;用户在系统弹窗里点了允许,readdir 随即成功,这里就不再
   *   叠一个自制弹窗。只有系统确实不肯再问(此前被拒过)才走到引导去系统设置这一步。
   */
  private async resolveProtectedFolderDenial(kind: ProtectedFolderKind): Promise<void> {
    if (!beginProtectedFolderCheck(kind)) return;
    try {
      const access = await probeProtectedFolderAccess(kind);
      if (access !== 'denied') {
        log.debug(`protected folder guidance skipped: kind=${kind} access=${access}`);
        return;
      }
      markEpermGuidanceShown(kind);
      try {
        await this.showFolderEpermGuidance(kind);
      } catch (error) {
        releaseEpermGuidance(kind);
        log.warn('failed to show folder access guidance', { kind, error });
      }
    } finally {
      endProtectedFolderCheck(kind);
    }
  }

  private async showFolderEpermGuidance(kind: ProtectedFolderKind): Promise<void> {
    const folderName = t(`fileAccess.epermGuidance.folderNames.${kind.toLowerCase()}`);
    const options = {
      type: 'warning' as const,
      title: t('fileAccess.epermGuidance.title'),
      message: t('fileAccess.epermGuidance.message').replace('{{folder}}', folderName),
      detail: t('fileAccess.epermGuidance.detail'),
      buttons: [
        t('fileAccess.epermGuidance.openSystemSettings'),
        t('fileAccess.epermGuidance.cancel'),
      ],
      defaultId: 0,
      cancelId: 1,
    };
    const mainWindow = this.deps.getMainWindow();
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) {
      await openFolderPrivacySettings(kind);
    }
  }

  private ensureMetadata(sessionId: string): void {
    const cached = this.metadataCache.get(sessionId);
    if (
      this.metadataLoading.has(sessionId)
      || (cached && cached.companion !== undefined && !isPlaceholderSessionTitle(cached.title))
    ) return;
    this.metadataLoading.add(sessionId);
    void getSessionRowSnapshot(sessionId)
      .then(async (row) => {
        // Only Bot Sessions can speak as a companion; others skip the extra lookup.
        const companion = row?.source === 'bot'
          ? await this.readCompanionIdentityFresh(sessionId).catch((err) => {
            log.warn('companion identity load failed', {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
            return null;
          })
          : null;
        // Superseded: a newer read of this Session owns the result.
        if (companion === undefined) return;
        this.commitMetadata(sessionId, {
          title: row?.title ?? null,
          workingDir: row?.workingDir ?? null,
          projectDir: row?.projectDir ?? null,
          workspaceKind: row?.workspaceKind ?? null,
          companion,
        });
      })
      .catch((err) => {
        log.warn('session metadata load failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.metadataLoading.delete(sessionId);
      });
  }

  private playSoundForDisplayTransition(
    previous: AgentIslandDisplayState | null,
    next: AgentIslandDisplayState,
    now: number,
  ): void {
    if (!next.visible || next.smartSuppressed) return;
    const baseline = this.baselineSoundSessionIds;
    const event = getAgentIslandSoundEventForTransition(
      previous,
      baseline.size > 0
        ? { ...next, sessions: next.sessions.filter((session) => !baseline.has(session.sessionId)) }
        : next,
      this.mutedCompletionSoundSessionIds,
      new Set(this.silencedSessionRunIds.keys()),
    );
    if (!event) return;
    this.playConfiguredSound(event, now);
  }

  private playConfiguredSound(event: AgentIslandSoundEvent, now: number): void {
    if (!this.soundSettings.enabled) return;
    const sound = this.soundSettings.sounds[event];
    if (!sound || isSilentAgentIslandSoundChoice(sound)) return;
    const cooldownUntil = this.soundCooldownUntilByEvent.get(event) ?? 0;
    if (cooldownUntil > now) return;
    this.soundCooldownUntilByEvent.set(event, now + soundCooldownMsForAgentIslandEvent(event));
    this.nativeHost.playSound?.(sound);
  }

  private markSilencedScheduleRun(runId: string, sessionId: string): void {
    if (!runId || !sessionId) return;
    const previousRunId = this.silencedSessionRunIds.get(sessionId);
    if (previousRunId && previousRunId !== runId) {
      this.clearSilencedScheduleRun(previousRunId);
    }
    this.clearSilencedRunTimer(runId);
    this.silencedRunSessionIds.set(runId, sessionId);
    this.silencedSessionRunIds.set(sessionId, runId);
    this.silencedRunHadAttention.set(runId, hasAgentIslandSessionAttention(this.state, sessionId));
  }

  private isCompletionEventSilenced(sessionId: string, event: AgentEvent): boolean {
    if (!isCompletionDoneEvent(event)) return false;
    return event.agentMeta?.botTaskCoordination === true
      || this.isGroupLaneEvent(sessionId, event)
      || event.turnOrigin?.surface === 'im' || this.silencedSessionRunIds.has(sessionId);
  }

  private isGroupLaneEvent(sessionId: string, event: AgentEvent): boolean {
    // Accepted-input provenance reaches this event independently of avatar loading.
    return event.agentMeta?.botGroupLane === true || !!this.metadataCache.get(sessionId)?.companion?.groupId;
  }

  private hadAttentionBeforeSilencedRun(sessionId: string): boolean {
    const runId = this.silencedSessionRunIds.get(sessionId);
    return runId ? this.silencedRunHadAttention.get(runId) === true : false;
  }

  private hadAttentionBeforeSilencedCompletion(sessionId: string): boolean {
    if (this.silencedSessionRunIds.has(sessionId)) return this.hadAttentionBeforeSilencedRun(sessionId);
    return this.sessionHadAttentionAtRunStart.get(sessionId) === true;
  }

  private userPromptRollbackKey(sessionId: string, clientId: string | undefined): string | null {
    return clientId ? `${sessionId}:${clientId}` : null;
  }

  private scheduleSilencedRunClear(runId: string, delayMs: number): void {
    if (!this.silencedRunSessionIds.has(runId)) return;
    if (this.silencedRunClearTimers.has(runId)) return;
    const timer = setTimeout(() => {
      this.silencedRunClearTimers.delete(runId);
      this.clearSilencedScheduleRun(runId);
    }, Math.max(0, delayMs));
    this.silencedRunClearTimers.set(runId, timer);
  }

  private clearCompletedSilencedRunForNewActivity(sessionId: string): void {
    const runId = this.silencedSessionRunIds.get(sessionId);
    if (!runId || !this.silencedRunClearTimers.has(runId)) return;
    this.clearSilencedScheduleRun(runId);
  }

  private clearSilencedRunForSession(sessionId: string): void {
    const runId = this.silencedSessionRunIds.get(sessionId);
    if (runId) this.clearSilencedScheduleRun(runId);
  }

  private clearSilencedScheduleRun(runId: string): void {
    this.clearSilencedRunTimer(runId);
    const sessionId = this.silencedRunSessionIds.get(runId);
    this.silencedRunSessionIds.delete(runId);
    this.silencedRunHadAttention.delete(runId);
    if (sessionId && this.silencedSessionRunIds.get(sessionId) === runId) {
      this.silencedSessionRunIds.delete(sessionId);
    }
  }

  private clearSilencedRunTimer(runId: string): void {
    const timer = this.silencedRunClearTimers.get(runId);
    if (!timer) return;
    clearTimeout(timer);
    this.silencedRunClearTimers.delete(runId);
  }

  private clearDeferredRemoteAuthError(sessionId: string): void {
    const pending = this.deferredRemoteAuthErrors.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.deferredRemoteAuthErrors.delete(sessionId);
  }

  private syncSessionAttention(sessionId: string): void {
    if (hasAppBadgeSessionAttention(sessionId)) {
      markAgentIslandSessionAttention(this.state, sessionId);
    }
  }

  private bumpUnreadAttentionGeneration(sessionId: string): void {
    const next = (this.unreadAttentionGenerationBySession.get(sessionId) ?? 0) + 1;
    this.unreadAttentionGenerationBySession.set(sessionId, next);
  }

  /**
   * 把 per-session 活动快照(轻量子集)广播给 renderer,供侧栏置顶卡片/列表显示
   * 任务执行中的逐步活动 + 等待交互态。与原生灵动岛同源数据,enabled/disabled 都发。
   *
   * 数据取 live sessions ∪ 独立未读账本(buildAllSessionActivitySnapshots),不是
   * 灵动岛展示面 displayState.sessions。过了岛面 TTL 的完成/出错未读仍从账本带
   * attention=true 投给远程侧栏,直到真正已读。
   */
  private buildSessionActivityPayload(): AgentIslandSessionActivity[] {
    return buildAllSessionActivitySnapshots(this.state).map((s) => ({
      ...(s.completionToken ? { completionToken: s.completionToken } : {}),
      ...(s.completionNotification ? { completionNotification: s.completionNotification } : {}),
      ...projectSessionActivity({
        sessionId: s.sessionId,
        recordStatus: 'active',
        title: s.title,
        source: 'live',
        livePhase: s.phase,
        startedAtMs: s.startedAt,
        lastActivityAtMs: s.lastActivityAt,
        currentActionSummary: safeSessionActionSummary(s),
        interactionKind: s.interactionKind,
        attention: s.attention,
      }),
      phase: s.phase,
      interactionKind: s.interactionKind,
      // 完成后这份摘要只给其它设备的完成卡片用(本机岛面直接读展示快照)。
      compactDetail: s.phase === 'completed' ? completedReplySummary(s) : s.compactDetail,
      summaryFormat: 'plain-text',
      workingPhase: s.workingPhase,
    }));
  }

  /** Current public activity only; avoids scanning historical Bot Session links. */
  getSessionActivitySnapshots(): SessionActivitySnapshot[] {
    return this.buildSessionActivityPayload().map(canonicalSessionActivity);
  }

  /** Read the same canonical snapshot used by sidebar and device-list relays. */
  getSessionActivitySnapshot(sessionId: string): SessionActivitySnapshot | null {
    const activity = this.buildSessionActivityPayload()
      .find((item) => item.sessionId === sessionId);
    return activity ? canonicalSessionActivity(activity) : null;
  }

  /**
   * Whether a foreground tool call is between tool_use and tool_result. A long
   * tool (e.g. a build) emits no activity until it returns; Bot follow-up uses
   * this public boolean so a healthy long call is not judged stuck. Never
   * exposes the tool name or arguments.
   */
  isToolCallInFlight(sessionId: string): boolean {
    const session = this.state.sessions.get(sessionId);
    return !!session && session.running && session.phase === 'running'
      && (session.currentToolUseId !== null || session.workingTools.size > 0);
  }

  /**
   * Subscribe to canonical activity transitions. Future Bot consumers attach here;
   * this service remains unaware of Bot/runtime implementations.
   */
  subscribeSessionActivity(
    listener: (transition: SessionActivityTransition) => void,
  ): () => void {
    this.sessionActivityListeners.add(listener);
    return () => this.sessionActivityListeners.delete(listener);
  }

  /** The island's final attention projection, including restored companion chats. */
  getAttentionCount(): number {
    return this.attentionCount;
  }

  getTaskOverview(): AgentIslandSessionSnapshot[] {
    return buildAgentIslandTaskOverview(this.state, Date.now(), this.companionChatProjections());
  }

  subscribeTaskOverview(listener: () => void): () => void {
    this.taskOverviewListeners.add(listener);
    return () => this.taskOverviewListeners.delete(listener);
  }

  /** Menu-bar entry uses the same device/companion navigation and read acknowledgement. */
  openTaskOverviewSession(sessionId: string): void {
    this.focusSession(sessionId);
  }

  subscribeAttentionCount(listener: (count: number) => void): () => void {
    this.attentionCountListeners.add(listener);
    return () => this.attentionCountListeners.delete(listener);
  }

  private publishAttentionCount(count: number): void {
    // Content can change without changing the count (including restored companion chats).
    for (const listener of this.taskOverviewListeners) {
      try { listener(); } catch (error) {
        log.warn('task overview listener failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (count === this.attentionCount) return;
    this.attentionCount = count;
    for (const listener of this.attentionCountListeners) {
      try {
        listener(count);
      } catch (error) {
        log.warn('attention count listener failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private emitSessionActivityTransitions(
    list: readonly AgentIslandSessionActivity[],
    changedAtMs: number,
  ): void {
    const next = new Map(list.map((snapshot) => [snapshot.sessionId, snapshot]));
    const sessionIds = new Set([
      ...this.sessionActivitySubscriptionCursor.keys(),
      ...next.keys(),
    ]);
    for (const sessionId of sessionIds) {
      const previous = this.sessionActivitySubscriptionCursor.get(sessionId) ?? null;
      const current = next.get(sessionId) ?? null;
      if (previous && current && sessionActivitySnapshotsEqual(previous, current)) continue;
      for (const listener of this.sessionActivityListeners) {
        try {
          listener({
            sessionId,
            previous: previous ? canonicalSessionActivity(previous) : null,
            current: current ? canonicalSessionActivity(current) : null,
            changedAtMs,
          });
        } catch (error) {
          log.warn('session activity listener failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    this.sessionActivitySubscriptionCursor = next;
  }

  private emitSessionActivityToRenderer(): void {
    const payload = this.buildSessionActivityPayload();
    this.sessionActivityRelay.publish(payload);
    this.emitSessionActivityTransitions(payload, Date.now());
    this.notifySessionActivityConsumer(payload);
    // 广播给所有 app content window(含「在新窗口打开」的副窗),不只主窗 —— 副窗也有侧栏、
    // 也订阅同一频道,只发主窗会让副窗卡片预览停在陈旧 summary(PR #246 review)。
    const windows = BrowserWindow.getAllWindows().filter(isAppContentWindow);
    if (windows.length === 0) return;
    for (const win of windows) {
      const wc = win.webContents;
      if (wc && !wc.isDestroyed()) wc.send(AGENT_ISLAND_SESSION_SNAPSHOTS_CHANNEL, payload);
    }
  }

  private notifySessionActivityConsumer(activity: readonly AgentIslandSessionActivity[]): void {
    try {
      this.deps.onSessionActivityChange?.(activity);
    } catch (error) {
      log.warn('process-local session activity consumer failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 把「消息免打扰」从同步索引对齐到展示面抑制集合。放在每次 publish 的开头：账号
   * 切换、索引重载、直接改库都能自愈，不靠某一条写库路径记得来登记。
   */
  private syncDisplaySuppression(): void {
    for (const [sessionId, session] of this.state.sessions) {
      // 静音标记属于本机那行任务：其它设备投影进来的条目（sourceDeviceId 非空）可能与它
      // 同 id（还原/复制过的库），不能拿本机标记去压远端的卡片与提示音。
      setAgentIslandSessionDisplaySuppressed(
        this.state,
        sessionId,
        session.sourceDeviceId === null && isSessionNotificationsMutedSync(sessionId),
      );
    }
  }

  private publish(): void {
    this.syncDisplaySuppression();
    const now = Date.now();
    if (!this.enabledSynced) {
      this.mutedCompletionSoundSessionIds.clear();
      // 开关尚未同步时没有上一帧可比:首次出现的设备任务保留静音,等第一次真正 publish。
      this.clearStreamingPreviewPublishTimer();
      this.clearPublishTimer();
      return;
    }
    // Sounds follow real runtime transitions. Chat read/visibility filters only own
    // the rendered unread projection and must neither mute a fresh turn nor replay history.
    const soundDisplayState = withAgentIslandConfig(
      buildAgentIslandDisplayState(this.state, now), this.soundSettings, this.mascotSkin,
    );
    const chatDisplayState = this.companionChats.size > 0
      ? withAgentIslandConfig(
        buildAgentIslandDisplayState(this.state, now, this.companionChatProjections()),
        this.soundSettings, this.mascotSkin,
      )
      : soundDisplayState;
    if (!this.enabled) {
      this.mutedCompletionSoundSessionIds.clear();
      this.baselineSoundSessionIds.clear();
      this.clearStreamingPreviewPublishTimer();
      this.lastSoundDisplayState = soundDisplayState;
      this.publishAttentionCount(chatDisplayState.pillSnapshot.attentionCount);
      // 侧栏卡片的逐步活动不依赖灵动岛开关:即便岛 UI 关闭,状态机仍累积,照常广播给 renderer。
      this.emitSessionActivityToRenderer();
      // Windows / headless / 用户关掉岛面时,仍要按 TTL 把完整会话迁到轻量未读账本。
      // 不排 timer 的话,终态后再无事件,活动文本会无限留在 state.sessions。
      this.scheduleNextPublish(now);
      if (!this.hiddenPublished) {
        if (this.nativeHost.suspend) {
          this.nativeHost.suspend();
        } else {
          this.publishHidden(now);
        }
        this.hiddenPublished = true;
      }
      return;
    }

    this.hiddenPublished = false;
    const displayState = this.localizeDisplayState(chatDisplayState);
    this.publishAttentionCount(displayState.pillSnapshot.attentionCount);
    this.emitSessionActivityToRenderer();
    this.scheduleNextPublish(now);
    this.playSoundForDisplayTransition(this.lastSoundDisplayState, soundDisplayState, now);
    this.mutedCompletionSoundSessionIds.clear();
    this.baselineSoundSessionIds.clear();
    this.lastSoundDisplayState = soundDisplayState;

    if (this.nativeHost.failed) {
      this.logNativeRendererUnavailable(displayState);
      return;
    }

    const update = this.computeNativeDisplayUpdate(displayState);
    if (!this.nativeHost.publish(
      displayState,
      update.frames.length === 1 ? update.frames[0] : update.frames,
      update.statesByDisplayId,
    )) {
      this.logNativeRendererUnavailable(displayState);
    }
  }

  /**
   * 哨兵标题 → 本地化文案的**唯一投影点**:构建送给 native 的 payload 那一刻。
   *
   * 不变量:`metadataCache` 与 `state` 一律存**原始**标题,只有这里把哨兵换成兜底文案。
   *
   * 放在这里(而不是写 cache / 写 state 时)换来两个性质:
   *   - **切语言即时生效**:`refreshLocalization()` 只重建 `strings` 再 publish,而 publish
   *     每次都重新走本函数,所以那次 republish 自然带新语言 —— 不需要「本地化刷新时重投影
   *     metadata」这类额外逻辑(PR #1031 review P1)。
   *   - **判定不被污染**:`ensureMetadata` 仍能用 `isPlaceholderSessionTitle(cached.title)`
   *     判断该不该重拉权威标题。
   *
   * 只投影哨兵;真实标题与 null 原样透传(null 由 native 走它自己的空标题分支)。
   */
  private localizeDisplayState(state: AgentIslandDisplayState): AgentIslandDisplayState {
    if (!state.sessions.some((s) => isDefaultDraftSessionTitle(s.title) || s.groupChat?.mentionLabel)) return state;
    return {
      ...state,
      sessions: state.sessions.map(session => ({ ...session,
        ...(isDefaultDraftSessionTitle(session.title) ? { title: t('ccAgent.common.unnamedSession') } : {}),
        ...(session.groupChat?.mentionLabel ? { groupChat: { ...session.groupChat, mentionLabel: t('bots.groupChat.server.thread.mentionedYou') } } : {}),
      })),
    };
  }

  private scheduleNextPublish(now: number): void {
    this.clearPublishTimer();
    const nextAt = getNextAgentIslandTimerAt(this.state, now);
    if (!nextAt) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publish();
    }, Math.max(0, nextAt - now + 20));
  }

  private clearPublishTimer(): void {
    if (!this.publishTimer) return;
    clearTimeout(this.publishTimer);
    this.publishTimer = null;
  }

  private scheduleStreamingPreviewPublish(): void {
    if (this.streamingPreviewPublishTimer) return;
    this.streamingPreviewPublishTimer = setTimeout(() => {
      this.streamingPreviewPublishTimer = null;
      this.publish();
    }, STREAMING_PREVIEW_PUBLISH_DEBOUNCE_MS);
  }

  private clearStreamingPreviewPublishTimer(): void {
    if (!this.streamingPreviewPublishTimer) return;
    clearTimeout(this.streamingPreviewPublishTimer);
    this.streamingPreviewPublishTimer = null;
  }

  private publishHidden(now: number): void {
    if (this.nativeHost.failed) return;
    const displayState = withAgentIslandConfig(buildHiddenAgentIslandDisplayState({
      now,
      appFocused: this.state.appFocused,
    }), this.soundSettings, this.mascotSkin);
    const update = this.computeNativeDisplayUpdate(displayState);
    if (!this.nativeHost.publish(
      displayState,
      update.frames.length === 1 ? update.frames[0] : update.frames,
      update.statesByDisplayId,
    )) {
      this.logNativeRendererUnavailable(displayState);
    }
  }

  private handleNativePointerZones(zones: { menuBar: boolean; panel: boolean; displayId?: number | null }): void {
    const changed = setAgentIslandPointerZones(this.state, zones, Date.now());
    if (changed) this.publish();
  }

  private handleNativeExpand(displayId?: number | null): void {
    const now = Date.now();
    this.playConfiguredSound('select', now);
    if (requestAgentIslandManualExpand(this.state, displayId)) {
      this.publish();
    }
  }

  private handleNativeCollapse(): void {
    const now = Date.now();
    if (!requestAgentIslandManualCollapse(this.state, now)) return;
    this.playConfiguredSound('select', now);
    this.publish();
  }

  private handleNativeLayoutDragActive(active: boolean): void {
    if (!active) {
      this.flushLayoutPreferenceWrites();
    }
    if (setAgentIslandLayoutDragActive(this.state, active)) {
      this.publish();
    }
  }

  private handleNativeContentHeight(height: number): void {
    if (setAgentIslandMeasuredContentHeight(this.state, height)) {
      this.publish();
    }
  }

  private handleOutsideClick(): void {
    const now = Date.now();
    const changed = dismissAgentIslandActiveReveal(this.state, now);
    if (changed) {
      this.publish();
    }
  }

  private handleNativeLayoutPreference(preference: AgentIslandLayoutPreference): void {
    const displays = this.getAvailableDisplays();
    this.reconcileLayoutPreferencesForDisplays(displays);
    const nativeDisplayId = typeof preference.displayId === 'number' && Number.isFinite(preference.displayId)
      ? preference.displayId
      : this.getTargetDisplay(displays).id;
    const display = this.displayForNativeId(nativeDisplayId, displays);
    if (!display) return;
    const displayId = display.id;
    const current = this.layoutPreferencesByDisplayId.get(displayId) ?? {};
    const next: AgentIslandLayoutPreference = {
      ...current,
      ...(display ? this.displayIdentityForDisplay(display, displays) : {}),
    };
    if (typeof preference.centerXRatio === 'number' && Number.isFinite(preference.centerXRatio)) {
      next.centerXRatio = preference.centerXRatio;
    }
    if (typeof preference.compactContentWidth === 'number' && Number.isFinite(preference.compactContentWidth)) {
      next.compactContentWidth = preference.compactContentWidth;
    }
    if (typeof preference.expandedContentWidth === 'number' && Number.isFinite(preference.expandedContentWidth)) {
      next.expandedContentWidth = preference.expandedContentWidth;
    }
    if (
      next.centerXRatio === current.centerXRatio
      && next.compactContentWidth === current.compactContentWidth
      && next.expandedContentWidth === current.expandedContentWidth
      && next.displayName === current.displayName
      && next.displayIndex === current.displayIndex
      && next.displayInternal === current.displayInternal
      && sameDisplayBounds(next.displayBounds, current.displayBounds)
    ) {
      return;
    }
    this.layoutPreferencesByDisplayId.set(displayId, next);
    if (this.state.layoutDragActive) {
      this.scheduleLayoutPreferenceWrite(displayId, next);
    } else {
      this.writeLayoutPreferenceSafely(displayId, next);
    }
    this.publish();
  }

  private scheduleLayoutPreferenceWrite(displayId: number, preference: AgentIslandLayoutPreference): void {
    this.pendingLayoutPreferenceWrites.set(displayId, { ...preference });
    if (this.layoutPreferenceWriteTimer) return;
    this.layoutPreferenceWriteTimer = setTimeout(() => {
      this.flushLayoutPreferenceWrites();
    }, LAYOUT_PREFERENCE_WRITE_DEBOUNCE_MS);
  }

  private flushLayoutPreferenceWrites(): void {
    if (this.layoutPreferenceWriteTimer) {
      clearTimeout(this.layoutPreferenceWriteTimer);
      this.layoutPreferenceWriteTimer = null;
    }
    const entries = Array.from(this.pendingLayoutPreferenceWrites.entries());
    this.pendingLayoutPreferenceWrites.clear();
    for (const [displayId, preference] of entries) {
      this.writeLayoutPreferenceSafely(displayId, preference);
    }
  }

  private writeLayoutPreferenceSafely(displayId: number, preference: AgentIslandLayoutPreference): void {
    try {
      writeAgentIslandLayoutPreference(displayId, preference);
    } catch (error) {
      log.warn('agent island layout preference write failed', {
        displayId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleNativeScreenMetrics(metrics: {
    screens: AgentIslandNativeScreenMetrics[];
    preferredDisplayId: number | null;
    forceRefresh: boolean;
  }): void {
    const signature = metrics.screens
      .map((item) => [
        item.displayId,
        item.signature,
        item.hasNotch ? 'notch' : 'plain',
        Math.round(item.notchWidth),
        Math.round(item.topBarHeight),
      ].join(':'))
      .join('|');
    if (
      !metrics.forceRefresh
      && signature === this.screenMetricsSignature
      && metrics.preferredDisplayId === this.nativePreferredDisplayId
    ) {
      return;
    }
    this.screenMetricsByDisplayId.clear();
    for (const item of metrics.screens) {
      this.screenMetricsByDisplayId.set(item.displayId, item);
    }
    this.screenMetricsSignature = signature;
    this.nativePreferredDisplayId = metrics.preferredDisplayId;
    this.publish();
  }

  private computeNativeDisplayUpdate(displayState: AgentIslandDisplayState): {
    frames: AgentIslandNativeFrame[];
    statesByDisplayId?: Record<string, AgentIslandDisplayState>;
  } {
    const availableDisplays = this.getAvailableDisplays();
    this.reconcileLayoutPreferencesForDisplays(availableDisplays);
    const displays = this.getTargetDisplays(availableDisplays);
    const statesByDisplayId = this.computeDisplayStatesByDisplayId(displayState, displays);
    const frames = displays.map((display) => {
      const stateForDisplay = statesByDisplayId?.[String(display.id)] ?? displayState;
      return this.computeNativeFrame(stateForDisplay, display);
    });
    return { frames, statesByDisplayId };
  }

  private computeDisplayStatesByDisplayId(
    displayState: AgentIslandDisplayState,
    displays: Display[],
  ): Record<string, AgentIslandDisplayState> | undefined {
    if (
      displayState.mode !== 'expanded'
      || displayState.displayPolicy !== 'manualExpanded'
      || typeof displayState.expandedDisplayId !== 'number'
      || displays.length <= 1
    ) {
      return undefined;
    }
    const expandedDisplay = displays.some((display) => display.id === displayState.expandedDisplayId);
    if (!expandedDisplay) return undefined;
    const compactState = collapseManualExpandedStateForInactiveDisplay(displayState);
    return Object.fromEntries(displays.map((display) => [
      String(display.id),
      display.id === displayState.expandedDisplayId ? displayState : compactState,
    ]));
  }

  private computeNativeFrame(displayState: AgentIslandDisplayState, display: Display): AgentIslandNativeFrame {
    const layoutPreference = this.getLayoutPreferenceForDisplay(display);
    const expanded = displayState.notchStatus === 'expanded';
    const hasSession = displayState.totalCount > 0;
    const contentWidthFor = (mode: { expanded: boolean; hasSession: boolean }) => this.computeNativeContentWidth({
      displayState,
      display,
      layoutPreference,
      ...mode,
    });
    const contentWidth = contentWidthFor({ expanded, hasSession });
    // The carrier keeps one size for both modes: macOS animates every window resize
    // while Mission Control is open, which made expanding and collapsing jump. The
    // expanded width assumes a session so the first task does not resize it either.
    const carrierContentWidth = Math.max(
      expanded ? contentWidthFor({ expanded: false, hasSession }) : contentWidth,
      contentWidthFor({ expanded: true, hasSession: true }),
    );
    return {
      ...computeAgentIslandWindowBounds(display, {
        expanded: true,
        centerXRatio: layoutPreference.centerXRatio,
        contentWidth: carrierContentWidth,
        minimumContentWidth: carrierContentWidth,
      }),
      displayId: display.id,
      displayBounds: display.bounds,
      contentWidth,
    };
  }

  private computeNativeContentWidth(input: {
    displayState: AgentIslandDisplayState;
    display: Display;
    layoutPreference: AgentIslandLayoutPreference;
    expanded: boolean;
    hasSession: boolean;
  }): number {
    const { displayState, display, layoutPreference, expanded, hasSession } = input;
    const screenMetrics = this.getEffectiveScreenLayoutMetrics({
      display,
      expanded,
      layoutPreference,
      screenMetrics: this.getScreenLayoutMetrics(display),
    });
    const rawPreferredContentWidth = expanded
      ? layoutPreference.expandedContentWidth
      : layoutPreference.compactContentWidth;
    const defaultContentWidth = getAgentIslandDefaultContentWidth({
      expanded,
      hasSession,
      displayWidth: display.bounds.width,
      screenMetrics,
      // Keep the carrier wide enough for the native count badge; without this the
      // native side's own reservation gets clamped away and the badge is clipped.
      pillSnapshot: displayState.pillSnapshot,
    });
    const minimumContentWidth = getAgentIslandMinimumContentWidth({
      expanded,
      screenMetrics,
    });
    const preferredContentWidth = typeof rawPreferredContentWidth === 'number'
      ? this.normalizePreferredContentWidth({
        desiredWidth: rawPreferredContentWidth,
        expanded,
        hasSession,
        display,
        screenMetrics,
        minimumContentWidth,
        pillSnapshot: displayState.pillSnapshot,
      })
      : null;
    return computeAgentIslandCarrierSize(
      display,
      expanded,
      undefined,
      preferredContentWidth ?? defaultContentWidth,
      defaultContentWidth,
      minimumContentWidth,
    ).contentWidth;
  }

  private getTargetDisplays(displays = this.getAvailableDisplays()): Display[] {
    if (this.displayTarget.mode === 'display') {
      const selectedDisplay = this.resolveSelectedDisplay(displays);
      if (!selectedDisplay) {
        // A temporary disconnect uses the current fallback for rendering only;
        // keep the saved identity so reconnecting restores the user's choice.
        return [this.getTargetDisplay(displays)];
      }
      const resolvedTarget = this.displayTargetForDisplay(displays, selectedDisplay);
      if (!sameAgentIslandDisplayTarget(this.displayTarget, resolvedTarget)) {
        this.displayTarget = resolvedTarget;
      }
      return [selectedDisplay];
    }
    return displays;
  }

  private getLayoutPreferenceForDisplay(display: Display): AgentIslandLayoutPreference {
    const preference = this.layoutPreferencesByDisplayId.get(display.id);
    if (!preference) return {};
    if (hasPersistedLayoutIdentity(preference)) return preference;

    // 0.1.31 and earlier stored only the runtime display id. On a multi-display
    // setup that id can be reused by another monitor, so an old wide compact
    // width and center are unsafe to apply to a centered hardware-notch
    // display. Preserve the expanded preference, but let compact layout derive
    // its current notch-safe defaults until the next native drag records identity.
    const displays = this.getAvailableDisplays();
    const metrics = this.getScreenLayoutMetrics(display);
    if (displays.length > 1 && metrics?.hasNotch) {
      return {
        ...preference,
        centerXRatio: undefined,
        compactContentWidth: undefined,
      };
    }
    return preference;
  }

  private reconcileLayoutPreferencesForDisplays(displays: Display[]): void {
    const entries = Array.from(this.layoutPreferencesByDisplayId.entries());
    if (
      (entries.length === 0 && this.detachedLayoutPreferences.length === 0) ||
      displays.length === 0
    )
      return;

    const next = new Map<number, AgentIslandLayoutPreference>();
    const nextDetached: AgentIslandLayoutPreference[] = [];
    const claimedDisplayIds = new Set<number>();
    const assignedPreferences = new Set<AgentIslandLayoutPreference>();
    const identityEntries = [
      ...entries
        .filter(([, preference]) => hasPersistedLayoutIdentity(preference))
        .map(([storedDisplayId, preference]) => ({ storedDisplayId, preference })),
      ...this.detachedLayoutPreferences.map((preference) => ({
        storedDisplayId: null,
        preference,
      })),
    ];

    // Keep an identity-bearing preference on its current id when the identity
    // still resolves there. This is the common case and also makes collisions
    // deterministic before looking for migrated ids.
    for (const { storedDisplayId, preference } of identityEntries) {
      if (storedDisplayId === null) continue;
      const direct = this.displayById(displays, storedDisplayId);
      const resolved = findDisplayByIdentity(displays, preference);
      if (!direct || !resolved || resolved.id !== direct.id) continue;
      next.set(direct.id, {
        ...preference,
        ...this.displayIdentityForDisplay(direct, displays),
      });
      claimedDisplayIds.add(direct.id);
      assignedPreferences.add(preference);
    }

    // Resolve the remaining identity-bearing entries as a one-to-one batch.
    // Do not mutate the live map while iterating: two exchanged runtime ids
    // must be able to swap without one migration overwriting the other.
    for (const { preference } of identityEntries) {
      if (assignedPreferences.has(preference)) continue;
      const resolved = findDisplayByIdentity(displays, preference);
      if (!resolved || claimedDisplayIds.has(resolved.id)) continue;
      next.set(resolved.id, {
        ...preference,
        ...this.displayIdentityForDisplay(resolved, displays),
      });
      claimedDisplayIds.add(resolved.id);
      assignedPreferences.add(preference);
    }

    // Identity-bearing preferences that cannot currently resolve remain
    // detached from runtime ids. This preserves a disconnected display even
    // when another online display reuses its previous id.
    for (const { preference } of identityEntries) {
      if (!assignedPreferences.has(preference)) {
        nextDetached.push(preference);
      }
    }

    // Keep old id-only entries for backwards compatibility when their id still
    // names an unclaimed display. If an identity-bearing entry already claims
    // that id, the ambiguous legacy value must not overwrite the safer match.
    for (const [storedDisplayId, preference] of entries) {
      if (hasPersistedLayoutIdentity(preference)) continue;
      const direct = this.displayById(displays, storedDisplayId);
      if (direct && !claimedDisplayIds.has(direct.id)) {
        next.set(direct.id, preference);
        claimedDisplayIds.add(direct.id);
        continue;
      }
      // Keep disconnected legacy entries so a future display with the same id
      // can still use the old preference; no physical identity exists to do a
      // safer reconnect migration yet.
      if (!direct && !next.has(storedDisplayId)) {
        next.set(storedDisplayId, preference);
      }
    }

    if (
      sameLayoutPreferenceMap(this.layoutPreferencesByDisplayId, next) &&
      sameLayoutPreferenceList(this.detachedLayoutPreferences, nextDetached)
    ) {
      return;
    }
    this.clearPendingLayoutPreferenceWrites();
    this.layoutPreferencesByDisplayId.clear();
    for (const [displayId, preference] of next) {
      this.layoutPreferencesByDisplayId.set(displayId, preference);
    }
    this.detachedLayoutPreferences.splice(
      0,
      this.detachedLayoutPreferences.length,
      ...nextDetached,
    );
    this.writeLayoutPreferencesSafely(next, nextDetached);
  }

  private clearPendingLayoutPreferenceWrites(): void {
    this.pendingLayoutPreferenceWrites.clear();
    if (this.layoutPreferenceWriteTimer) {
      clearTimeout(this.layoutPreferenceWriteTimer);
      this.layoutPreferenceWriteTimer = null;
    }
  }

  private writeLayoutPreferencesSafely(
    preferences: Map<number, AgentIslandLayoutPreference>,
    detachedPreferences: readonly AgentIslandLayoutPreference[],
  ): void {
    try {
      writeAgentIslandLayoutPreferences(preferences, detachedPreferences);
    } catch (error) {
      log.warn('agent island layout preferences migration write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private displayForNativeId(displayId: number | null, displays: Display[]): Display | null {
    if (typeof displayId !== 'number' || !Number.isFinite(displayId)) return null;
    const direct = this.displayById(displays, displayId);
    // AppKit and Electron expose the same system display id, while their frame
    // coordinates use different vertical origins. A matching id is therefore
    // stronger evidence than a full-bounds comparison.
    if (direct) return direct;
    const metrics = this.screenMetricsByDisplayId.get(displayId);
    if (!metrics) return null;
    const exactBounds = displays.filter((display) => sameDisplayBounds(display.bounds, metrics.frame));
    if (exactBounds.length === 1) return exactBounds[0] ?? null;
    const sameSize = displays.filter((display) => (
      display.bounds.width === metrics.frame.width
      && display.bounds.height === metrics.frame.height
    ));
    return sameSize.length === 1 ? (sameSize[0] ?? null) : null;
  }

  private displayIdentityForDisplay(display: Display, displays: Display[]): AgentIslandDisplayIdentity {
    return {
      displayName: typeof display.label === 'string' && display.label.trim()
        ? display.label.trim()
        : undefined,
      displayIndex: displays.findIndex((item) => item.id === display.id) + 1,
      displayInternal: Boolean(display.internal),
      displayBounds: { ...display.bounds },
    };
  }

  private resolveSelectedDisplay(displays: Display[]): Display | null {
    if (this.displayTarget.mode !== 'display') return null;
    if (hasPersistedDisplayIdentity(this.displayTarget)) {
      // Runtime ids can be reassigned to a different physical monitor after a
      // reboot, so a saved identity must win over an apparently valid old id.
      return this.findDisplayByPersistedIdentity(displays, this.displayTarget);
    }
    return this.displayById(displays, this.displayTarget.displayId);
  }

  private displayTargetForDisplay(
    displays: Display[],
    display: Display,
  ): Extract<AgentIslandDisplayTarget, { mode: 'display' }> {
    return {
      mode: 'display',
      displayId: display.id,
      displayName: typeof display.label === 'string' && display.label.trim()
        ? display.label.trim()
        : undefined,
      displayIndex: displays.findIndex((item) => item.id === display.id) + 1,
      displayInternal: Boolean(display.internal),
      displayBounds: { ...display.bounds },
    };
  }

  private findDisplayByPersistedIdentity(
    displays: Display[],
    target: Extract<AgentIslandDisplayTarget, { mode: 'display' }>,
  ): Display | null {
    return findDisplayByIdentity(displays, target);
  }

  private normalizePreferredContentWidth(input: {
    desiredWidth: number;
    expanded: boolean;
    hasSession: boolean;
    display: Display;
    screenMetrics: AgentIslandScreenLayoutMetrics | null;
    minimumContentWidth: number;
    pillSnapshot?: AgentIslandPillSnapshot | null;
  }): number {
    if (input.expanded) {
      return input.desiredWidth;
    }
    const maxWidth = Math.min(
      Math.max(0, input.display.bounds.width - AGENT_ISLAND_SCREEN_EDGE_GUTTER),
      AGENT_ISLAND_MAX_RESIZABLE_WIDTH,
    );
    const minWidth = Math.min(input.minimumContentWidth, maxWidth);
    const clampedWidth = Math.min(maxWidth, Math.max(minWidth, input.desiredWidth));
    return snapAgentIslandCompactHardwareContentWidth({
      desiredWidth: input.desiredWidth,
      clampedWidth,
      maxWidth,
      hasSession: input.hasSession,
      screenMetrics: input.screenMetrics,
      pillSnapshot: input.pillSnapshot,
    });
  }

  private getTargetDisplay(displays = screen.getAllDisplays()): Display {
    const mainWindow = this.deps.getMainWindow();
    const mainWindowDisplay = mainWindow && !mainWindow.isDestroyed()
      ? screen.getDisplayMatching(mainWindow.getBounds())
      : null;
    const nativePreferred = this.displayForNativeId(this.nativePreferredDisplayId, displays);
    if (AGENT_ISLAND_DISPLAY_CONFIG.selectionMode === 'native-preferred-then-xdmaker-window') {
      if (nativePreferred) return nativePreferred;
      if (mainWindowDisplay) return mainWindowDisplay;
    }
    if (AGENT_ISLAND_DISPLAY_CONFIG.selectionMode === 'xdmaker-window-then-native-preferred') {
      if (mainWindowDisplay) return mainWindowDisplay;
      if (nativePreferred) return nativePreferred;
    }
    if (AGENT_ISLAND_DISPLAY_CONFIG.preferHardwareNotchFallback) {
      const notchDisplay = displays.find((display) => this.screenMetricsForDisplay(display)?.hasNotch);
      if (notchDisplay) return notchDisplay;
    }
    if (AGENT_ISLAND_DISPLAY_CONFIG.preferInternalDisplayFallback) {
      const internalDisplay = displays.find((display) => display.internal);
      if (internalDisplay) return internalDisplay;
    }
    return screen.getPrimaryDisplay();
  }

  private getAvailableDisplays(): Display[] {
    const displays = screen.getAllDisplays();
    return displays.length > 0 ? displays : [screen.getPrimaryDisplay()];
  }

  private getDisplayOptions(): AgentIslandDisplayOption[] {
    const primaryDisplayId = screen.getPrimaryDisplay().id;
    return this.getAvailableDisplays().map((display, index) => ({
      id: display.id,
      index: index + 1,
      name: typeof display.label === 'string' ? display.label.trim() : '',
      isPrimary: display.id === primaryDisplayId,
      internal: Boolean(display.internal),
      bounds: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
      },
    }));
  }

  private displayById(displays: Display[], displayId: number | null): Display | null {
    if (typeof displayId !== 'number') return null;
    return displays.find((display) => display.id === displayId) ?? null;
  }

  private getScreenLayoutMetrics(display: Display): AgentIslandScreenLayoutMetrics | null {
    const metrics = this.screenMetricsForDisplay(display);
    if (!metrics) return null;
    return {
      hasNotch: metrics.hasNotch,
      notchWidth: metrics.notchWidth,
    };
  }

  private screenMetricsForDisplay(display: Display): AgentIslandNativeScreenMetrics | null {
    const direct = this.screenMetricsByDisplayId.get(display.id);
    if (direct) return direct;
    const exactBounds = Array.from(this.screenMetricsByDisplayId.values()).filter((metrics) => (
      sameDisplayBounds(display.bounds, metrics.frame)
    ));
    if (exactBounds.length === 1) return exactBounds[0] ?? null;
    const sameSize = Array.from(this.screenMetricsByDisplayId.values()).filter((metrics) => (
      metrics.frame.width === display.bounds.width
      && metrics.frame.height === display.bounds.height
    ));
    if (sameSize.length === 1) return sameSize[0] ?? null;
    return null;
  }

  private getEffectiveScreenLayoutMetrics(input: {
    display: Display;
    expanded: boolean;
    layoutPreference: AgentIslandLayoutPreference;
    screenMetrics: AgentIslandScreenLayoutMetrics | null;
  }): AgentIslandScreenLayoutMetrics | null {
    const { screenMetrics } = input;
    if (!screenMetrics?.hasNotch) return screenMetrics;
    if (this.isHardwareNotchLayoutEnabled(input)) return screenMetrics;
    return null;
  }

  private isHardwareNotchLayoutEnabled(input: {
    display: Display;
    expanded: boolean;
    layoutPreference: AgentIslandLayoutPreference;
    screenMetrics: AgentIslandScreenLayoutMetrics | null;
  }): boolean {
    if (!input.screenMetrics?.hasNotch) return false;
    const ratio = typeof input.layoutPreference.centerXRatio === 'number'
      && Number.isFinite(input.layoutPreference.centerXRatio)
      ? input.layoutPreference.centerXRatio
      : 0.5;
    const centerX = input.display.bounds.x + input.display.bounds.width * Math.min(1, Math.max(0, ratio));
    const screenCenterX = input.display.bounds.x + input.display.bounds.width / 2;
    return Math.abs(centerX - screenCenterX) <= HARDWARE_NOTCH_CENTER_TOLERANCE_PX;
  }

  private logNativeRendererUnavailable(displayState: AgentIslandDisplayState): void {
    if (!displayState.visible || this.nativeFailureLogged) return;
    this.nativeFailureLogged = true;
    log.warn('native Agent Island renderer unavailable; island will remain hidden');
  }

  private focusSession(sessionId: string): void {
    const nextSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
    if (!nextSessionId) return;
    const group = this.state.sessions.get(nextSessionId)?.groupChat;
    if (group) {
      // Navigation never acknowledges a group: reading the destination updates the server read position.
      requestAgentIslandManualCollapse(this.state, Date.now());
      this.publish();
      openMainWindowChatMessage(group.input.groupId, group.input.messageId, group.input.threadRootId);
      return;
    }
    const now = Date.now();
    const islandEntryId = this.recordIslandEntryAlert(nextSessionId, now);
    const deviceId = this.state.sessions.get(nextSessionId)?.sourceDeviceId
      ?? this.companionChats.get(nextSessionId)?.input.deviceId;
    const target = { ...(islandEntryId ? { islandEntryId } : {}), ...(deviceId ? { deviceId } : {}) };
    this.playConfiguredSound('select', now);
    if (this.state.appFocused && this.state.visibleSessionIds.has(nextSessionId)) {
      const focusChanged = requestAgentIslandSessionFocus(this.state, nextSessionId, now);
      if (focusChanged) this.publish();
      // 已在看的目标未必能处置这张卡(如只读历史):这次点击仍要交给 renderer,
      // 入口导航器发现目标地址已提交时直接按点击编号申请处置,不会再导航一次。
      if (islandEntryId) openMainWindowSession(nextSessionId, target);
      return;
    }

    const focusChanged = requestAgentIslandSessionFocus(this.state, nextSessionId, now);
    if (focusChanged) this.publish();
    // Reuse the primary-window handoff: it retains navigation while the
    // renderer reloads and restores macOS app focus. A one-shot notification
    // sent during loading is lost before MainLayout can acknowledge the task.
    openMainWindowSession(nextSessionId, Object.keys(target).length ? target : undefined);
  }

  private readonly completionActionsPending = new Set<string>();

  async handleCompletionAction(sessionId: string, action: 'mark-read' | 'archive', token: string): Promise<boolean> {
    const chat = this.companionChats.get(sessionId);
    if (chat) {
      const live = this.state.sessions.get(sessionId);
      const window = this.deps.getMainWindow();
      if (token !== chat.token || action !== 'mark-read' || !chat.input.visible || !chat.input.unread || !window || window.isDestroyed()
        || (live && live.phase !== 'completed')) return false;
      const owner = getActiveAppSession();
      window.webContents.send(AGENT_ISLAND_READ_COMPANION_CHAT_CHANNEL,
        { ...chat.input, readThroughAt: chat.input.lastMessageAt },
        { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation });
      chat.input = { ...chat.input, unread: false };
      if (live && !chat.input.deviceId) {
        clearAppBadgeSessionAttention(sessionId, 'explicit');
        this.handleSessionAttentionCleared(sessionId, 'explicit');
      }
      // This computer's chat read position owns the action, even for an offline remote home.
      this.publish();
      return true;
    }
    const session = this.state.sessions.get(sessionId);
    if (!session || !token || agentIslandCompletionToken(session) !== token || this.completionActionsPending.has(sessionId)) return false;
    // Companion main tasks have their own lifecycle; only their notification may be read here.
    if (action === 'archive' && session.companion) return false;
    this.completionActionsPending.add(sessionId);
    try {
      if (action === 'archive' && !await confirmIslandArchive(sessionId, session.sourceDeviceId)) return false;
      if (this.state.sessions.get(sessionId) !== session || agentIslandCompletionToken(session) !== token) return false;
      if (session.sourceDeviceId) {
        const result = await remoteInvoke(session.sourceDeviceId, 'agent-island:completion-action', [sessionId, action, token]);
        if (!result.ok) throw new Error(result.error.message);
        if (result.result !== true) return false;
        const current = this.state.sessions.get(sessionId);
        if (current && (current !== session || agentIslandCompletionToken(current) !== token)) return false;
        clearAppBadgeSessionAttention(sessionId, 'explicit');
        this.handleSessionAttentionCleared(sessionId, 'explicit');
        return true;
      }
      return await this.applyOwnedCompletionAction(sessionId, action, token);
    } catch (error) {
      log.warn('island completion action failed', { action, error });
      void dialog.showMessageBox({ type: 'error', message: t('agentIsland.native.actionFailed') });
      return false;
    } finally {
      this.completionActionsPending.delete(sessionId);
    }
  }

  /** A tunneled action is never forwarded again or downgraded to an unguarded write. */
  private async applyOwnedCompletionAction(sessionId: string, action: 'mark-read' | 'archive', token: string): Promise<boolean> {
    return withSessionRouteLock(sessionId, async () => {
      const session = this.state.sessions.get(sessionId);
      const isCurrent = () => !!session && !session.sourceDeviceId
        && this.state.sessions.get(sessionId) === session && agentIslandCompletionToken(session) === token
        && (action !== 'archive' || !bindingStore.findByTarget(sessionId));
      if (!isCurrent() || (action === 'archive' && session?.companion)) return false;
      if (action === 'archive') {
        await patchSessionMetaInDb(sessionId, { status: 'archived' }, {
          routeLockHeld: true,
          // The DB writer invokes this again after its worktree/resource waits.
          beforeWrite: () => {
            if (!isCurrent()) throwIpcError('PRECONDITION_FAILED', 'Completed card changed');
          },
        });
      }
      // Archiving may remove this projection. The route lock still excludes a new send.
      if (this.state.sessions.has(sessionId) && !isCurrent()) return false;
      clearAppBadgeSessionAttention(sessionId, 'explicit');
      this.handleSessionAttentionCleared(sessionId, 'explicit');
      return true;
    });
  }

  /** 记下这次点击并取代之前的任何一次;被点的卡不是未读完成 / 报错时不留可处置记录。 */
  private recordIslandEntryAlert(sessionId: string, now: number): string | null {
    const stamp = readAgentIslandUnreadTerminalStamp(this.state, sessionId);
    if (!stamp) {
      this.islandEntryAlert = null;
      return null;
    }
    const entryId = String(++this.islandEntrySequence);
    this.islandEntryAlert = { sessionId, entryId, stamp, until: now + ISLAND_ENTRY_ALERT_TTL_MS };
    return entryId;
  }

  /**
   * 处置用户最近一次点的那张卡,且只处置那一张:不是这次点击(被新点击取代,含同一任务的
   * 再次点击)、已过期、或点击后又有新活动(新一轮 / 新报错 / 新完成)都不动,新的提醒照常
   * 留着。一次点击只处置一次。走 appBadge 的 explicit 清除:岛卡、Dock 角标与远程回执即刻
   * 收掉,重打点也唤不回这张卡;按 cindy-bots-runtime.md 6.2 的合同,任务记录、失败状态与
   * 错误行都不动 —— 错误尾行派生的侧栏红点在报错被横幅 / 重试真正处理前仍会如实出现。
   */
  consumeIslandEntryAlert(sessionId: string, entryId: string, now = Date.now()): boolean {
    const entry = this.islandEntryAlert;
    if (!entry || entry.sessionId !== sessionId || entry.entryId !== entryId) return false;
    this.islandEntryAlert = null;
    if (entry.until <= now) return false;
    if (readAgentIslandUnreadTerminalStamp(this.state, sessionId) !== entry.stamp) return false;
    clearAppBadgeSessionAttention(sessionId, 'explicit');
    return true;
  }

  private dispatchMainWindowCommand(
    command: ApplicationMenuCommand,
    options: { playSelectSound?: boolean } = {},
  ): void {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (options.playSelectSound) {
      this.playConfiguredSound('select', Date.now());
    }
    // Toggling the island sound is a background preference change. Keep the
    // renderer command delivery, but do not interrupt the user's foreground
    // app by restoring, showing, or focusing Cindy's main window.
    if (command !== 'toggle-agent-island-sound') {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    mainWindow.webContents.send('app-menu:command', command);
  }
}

function buildHiddenAgentIslandDisplayState(input: {
  now: number;
  appFocused: boolean;
}): AgentIslandDisplayState {
  return {
    visible: false,
    mode: 'compact',
    notchStatus: 'closed',
    displayPolicy: 'closed',
    displaySurface: 'collapsed',
    layoutMode: 'compact',
    appFocused: input.appFocused,
    smartSuppressed: false,
    shadowVisible: false,
    currentSessionId: null,
    expandedDisplayId: null,
    pillSnapshot: createEmptyAgentIslandPillSnapshot(),
    sessions: [],
    totalCount: 0,
    measuredContentHeight: 0,
    ...createDefaultAgentIslandDisplayConfig(),
    updatedAt: input.now,
  };
}

function withAgentIslandConfig(
  displayState: AgentIslandDisplayState,
  soundSettings: AgentIslandSoundSettings,
  mascotSkin: AgentIslandMascotSkin,
): AgentIslandDisplayState {
  return {
    ...displayState,
    strings: buildAgentIslandStrings(),
    soundSettings: cloneAgentIslandSoundSettings(soundSettings),
    mascotSkin,
  };
}

function collapseManualExpandedStateForInactiveDisplay(displayState: AgentIslandDisplayState): AgentIslandDisplayState {
  return {
    ...displayState,
    mode: 'compact',
    notchStatus: displayState.currentSessionId ? 'peek' : 'closed',
    displayPolicy: displayState.currentSessionId ? 'peek' : 'closed',
    displaySurface: 'collapsed',
    layoutMode: 'compact',
    shadowVisible: false,
    expandedDisplayId: null,
  };
}

function buildAgentIslandStrings(): AgentIslandStrings {
  return {
    appName: BRAND_NAME,
    markRead: t('agentIsland.native.markRead'),
    archive: t('agentIsland.native.archive'),
    newConversationTitle: t('agentIsland.native.newConversationTitle'),
    newConversationHint: t('agentIsland.native.newConversationHint'),
    muteSound: t('agentIsland.native.muteSound'),
    enableSound: t('agentIsland.native.enableSound'),
    settings: t('agentIsland.native.settings'),
    newMessage: t('agentIsland.native.newMessage'),
    review: t('agentIsland.native.review'),
    needsInput: t('agentIsland.native.needsInput'),
    completed: t('agentIsland.native.completed'),
    error: t('agentIsland.native.error'),
    outputLimit: t('logic.errors.outputLimit'),
    input: t('agentIsland.native.input'),
    done: t('agentIsland.native.done'),
    running: t('agentIsland.native.running'),
    networkReconnecting: t('agentIsland.native.networkReconnecting'),
    updatingTasks: t('agentIsland.native.updatingTasks'),
    awaitingPermission: t('agentIsland.native.awaitingPermission'),
    awaitingQuestion: t('agentIsland.native.awaitingQuestion'),
    awaitingPlan: t('agentIsland.native.awaitingPlan'),
    permissionPromptTitle: t('agentIsland.native.permissionPromptTitle'),
    allowOnce: t('agentIsland.native.allowOnce'),
    alwaysAllowForSession: t('agentIsland.native.alwaysAllowForSession'),
    deny: t('agentIsland.native.deny'),
  };
}

function parseAgentIslandSoundChoice(raw: unknown): AgentIslandSoundChoice | null {
  if (isAgentIslandSoundId(raw)) {
    return { type: 'builtin', id: raw };
  }
  if (!isAgentIslandSoundChoice(raw)) {
    return null;
  }
  return normalizeAgentIslandSoundChoice(raw, { type: 'builtin', id: 'none' });
}

function filterSessionScopedPermissionSuggestions(suggestions?: readonly unknown[]): unknown[] {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.filter((suggestion) =>
    !!suggestion
    && typeof suggestion === 'object'
    && !Array.isArray(suggestion)
    && (suggestion as Record<string, unknown>).destination === 'session'
  );
}

function parseVisibleSessionPayload(raw: unknown): string | string[] | null {
  if (typeof raw === 'string') {
    return raw.trim() ? raw : null;
  }
  if (!Array.isArray(raw)) return null;
  const sessionIds = raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return sessionIds.length > 0 ? sessionIds : null;
}

function getVisibleSessionIdsForReadAck(sessionId: string | string[] | null): string[] {
  const rawSessionIds = Array.isArray(sessionId) ? sessionId : [sessionId];
  const normalized = new Set<string>();
  for (const raw of rawSessionIds) {
    const next = typeof raw === 'string' ? raw.trim() : '';
    if (next) normalized.add(next);
  }
  return Array.from(normalized);
}

function hasPersistedDisplayIdentity(
  target: Extract<AgentIslandDisplayTarget, { mode: 'display' }>,
): boolean {
  return Boolean(target.displayName?.trim())
    || typeof target.displayIndex === 'number'
    || typeof target.displayInternal === 'boolean'
    || target.displayBounds !== undefined;
}

function hasPersistedLayoutIdentity(preference: AgentIslandLayoutPreference): boolean {
  return Boolean(preference.displayName?.trim())
    || typeof preference.displayIndex === 'number'
    || typeof preference.displayInternal === 'boolean'
    || preference.displayBounds !== undefined;
}

function findDisplayByIdentity(
  displays: Display[],
  identity: AgentIslandDisplayIdentity,
): Display | null {
  let candidates = displays;
  const name = identity.displayName?.trim();
  if (name) {
    candidates = candidates.filter((display) => (
      typeof display.label === 'string' && display.label.trim() === name
    ));
  }

  if (typeof identity.displayInternal === 'boolean') {
    candidates = candidates.filter((display) => (
      Boolean(display.internal) === identity.displayInternal
    ));
  }

  const persistedBounds = identity.displayBounds;
  if (persistedBounds) {
    const exactBounds = candidates.filter((display) => (
      sameDisplayBounds(display.bounds, persistedBounds)
    ));
    if (exactBounds.length === 1) return exactBounds[0] ?? null;
    if (exactBounds.length > 1) {
      candidates = exactBounds;
    } else {
      const sameSize = candidates.filter((display) => (
        display.bounds.width === persistedBounds.width
        && display.bounds.height === persistedBounds.height
      ));
      if (sameSize.length === 1) return sameSize[0] ?? null;
      if (sameSize.length > 1) candidates = sameSize;
    }
  }

  // Display enumeration order is runtime-local and may change after reconnect,
  // reboot, or topology changes. An index must never break an otherwise
  // ambiguous physical-identity match; failing closed keeps the preference
  // detached instead of assigning it to the wrong monitor.
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function sameLayoutPreferenceMap(
  a: Map<number, AgentIslandLayoutPreference>,
  b: Map<number, AgentIslandLayoutPreference>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [displayId, preference] of a) {
    const other = b.get(displayId);
    if (!other || !sameLayoutPreference(preference, other)) return false;
  }
  return true;
}

function sameLayoutPreferenceList(
  a: readonly AgentIslandLayoutPreference[],
  b: readonly AgentIslandLayoutPreference[],
): boolean {
  return (
    a.length === b.length &&
    a.every((preference, index) => sameLayoutPreference(preference, b[index] ?? {}))
  );
}

function sameLayoutPreference(
  a: AgentIslandLayoutPreference,
  b: AgentIslandLayoutPreference,
): boolean {
  return a.displayId === b.displayId
    && a.centerXRatio === b.centerXRatio
    && a.compactContentWidth === b.compactContentWidth
    && a.expandedContentWidth === b.expandedContentWidth
    && a.displayName === b.displayName
    && a.displayIndex === b.displayIndex
    && a.displayInternal === b.displayInternal
    && sameDisplayBounds(a.displayBounds, b.displayBounds);
}

function sameDisplayBounds(
  a: { x: number; y: number; width: number; height: number } | null | undefined,
  b: { x: number; y: number; width: number; height: number } | null | undefined,
): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height;
}

function sameAgentIslandDisplayTarget(a: AgentIslandDisplayTarget, b: AgentIslandDisplayTarget): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === 'all') return true;
  if (b.mode !== 'display' || a.displayId !== b.displayId) return false;
  return a.displayName === b.displayName
    && a.displayIndex === b.displayIndex
    && a.displayInternal === b.displayInternal
    && a.displayBounds?.x === b.displayBounds?.x
    && a.displayBounds?.y === b.displayBounds?.y
    && a.displayBounds?.width === b.displayBounds?.width
    && a.displayBounds?.height === b.displayBounds?.height;
}

function getAgentIslandSoundEventForTransition(
  previous: AgentIslandDisplayState | null,
  next: AgentIslandDisplayState,
  mutedCompletionSessionIds: ReadonlySet<string> = new Set(),
  mutedStartSessionIds: ReadonlySet<string> = new Set(),
): AgentIslandSoundEvent | null {
  const previousById = new Map(previous?.sessions.map((session) => [session.sessionId, session]) ?? []);
  for (const session of next.sessions) {
    if (!session.attention || session.phase !== 'needs-interaction') continue;
    const prev = previousById.get(session.sessionId);
    if (prev?.phase !== 'needs-interaction') return 'attention';
  }
  for (const session of next.sessions) {
    if (!session.attention || session.phase !== 'error') continue;
    const prev = previousById.get(session.sessionId);
    if (prev?.phase !== 'error') return 'error';
  }
  // Visual smart suppression controls unread/reveal state, not configured completion sounds.
  for (const session of next.sessions) {
    if (session.phase !== 'completed') continue;
    if (session.groupChat) continue;
    if (mutedCompletionSessionIds.has(session.sessionId)) continue;
    const prev = previousById.get(session.sessionId);
    if (prev?.phase !== 'completed') return 'complete';
  }
  for (const session of next.sessions) {
    if (session.phase !== 'running') continue;
    if (mutedStartSessionIds.has(session.sessionId)) continue;
    const prev = previousById.get(session.sessionId);
    if (!prev || prev.phase !== 'running') return 'start';
  }
  return null;
}

function isCompletionDoneEvent(event: AgentEvent): boolean {
  return event.turnScope !== 'background' && isProductTurnCompletionTailEvent(event);
}

function isCancelledTerminalEvent(event: AgentEvent): boolean {
  if (isTurnContinuationBoundaryEvent(event)) return false;
  if (event.type !== 'done' && event.type !== 'status') return false;
  const data = event.data as { cancelled?: unknown } | undefined;
  return data?.cancelled === true;
}

function isRunningStatusEvent(event: AgentEvent): boolean {
  if (event.type !== 'status' || event.turnScope === 'background') return false;
  const data = event.data as { isRunning?: unknown } | undefined;
  return data?.isRunning === true;
}

function providerTurnIdFromAgentEvent(event: AgentEvent): string | null {
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return null;
  const data = event.data as { turnId?: unknown; raw?: unknown };
  if (typeof data.turnId === 'string' && data.turnId) return data.turnId;
  if (!data.raw || typeof data.raw !== 'object' || Array.isArray(data.raw)) return null;
  const rawId = (data.raw as { id?: unknown }).id;
  return typeof rawId === 'string' && rawId ? rawId : null;
}

function isRemoteDaemonClosedErrorEvent(event: AgentEvent): boolean {
  if (event.type !== 'error') return false;
  const data = event.data as { reason?: unknown } | undefined;
  return data?.reason === REMOTE_DAEMON_CLOSED_REASON;
}

function isStreamingPreviewEvent(event: AgentEvent): boolean {
  if (event.type !== 'text') return false;
  const data = event.data as { isFinal?: unknown; text?: unknown } | undefined;
  return data?.isFinal !== true && typeof data?.text === 'string' && data.text.length > 0;
}

function permissionRequestIdsFromAgentEvent(event: AgentEvent): string[] {
  const data = event.data as { id?: unknown; toolUseId?: unknown; toolUseIds?: unknown } | undefined;
  if (!data) return [];
  if (Array.isArray(data.toolUseIds)) {
    return data.toolUseIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  }
  if (typeof data.toolUseId === 'string' && data.toolUseId.length > 0) return [data.toolUseId];
  return typeof data.id === 'string' && data.id.length > 0 ? [data.id] : [];
}

function soundCooldownMsForAgentIslandEvent(event: AgentIslandSoundEvent): number {
  switch (event) {
    case 'attention':
    case 'complete':
    case 'error':
      return 1_500;
    case 'start':
      return 800;
    case 'select':
      return 200;
  }
}

function isPlaceholderSessionTitle(title: string | null): boolean {
  if (!title) return true;
  const normalized = title.trim().toLowerCase();
  return normalized === '' || normalized === 'new maker' || normalized === 'untitled';
}
