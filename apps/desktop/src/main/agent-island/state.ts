import {
  parseReconnectAttemptMessage,
  type AgentEvent,
  type InteractionRequest,
} from '@cindy/maker-core';
import { DEFAULT_TOOL_ROW_WORDING, type ToolRowWording } from '@cindy/maker-shared/message-presentation';
import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';

import { LIVE_TASK_PRIORITY, liveTaskPriorityRank } from '../../shared/liveTaskPriority';
import { stripTrailingPathSeparators } from '../../shared/pathText';

import { formatIslandToolDetail } from './toolDetail.js';
import {
  appendActivityTextStream,
  cloneActivityTextStreamState,
  createActivityTextStreamState,
  normalizeActivityText,
  type ActivityTextStreamState,
} from './activityTextStream.js';

import {
  createDefaultAgentIslandDisplayConfig,
  DEFAULT_AGENT_ISLAND_STRINGS,
  type AgentIslandActivityLine,
  type AgentIslandActivityLineKind,
  type AgentIslandDisplayPolicy,
  type AgentIslandDisplaySurface,
  type AgentIslandDisplayState,
  type AgentIslandInteractionKind,
  type AgentIslandLayoutMode,
  type AgentIslandNotchStatus,
  type AgentIslandPillSnapshot,
  type AgentIslandStrings,
  type AgentIslandSessionPhase,
  type AgentIslandSessionSnapshot,
} from '../../shared/agentIsland.js';

export type AgentIslandInteractionRequest =
  | InteractionRequest
  | {
      kind: 'plugin_setup';
      requestId: string;
      detail: string;
    };

export const AGENT_ISLAND_COMPLETION_DWELL_MS = 5_000;
export const AGENT_ISLAND_ERROR_DWELL_MS = 12_000;
export const AGENT_ISLAND_REVEAL_DWELL_MS = 5_000;
// 12s → 8s:完成卡片的 dwell 现在能真正走完(临时会话调度 run 收尾时的 closeSession
// 不再抹掉条目,见 closeAgentIslandSessionPreservingUnread),不需要再用更长的上限去弥补
// 「随时可能被整条删掉」。
export const AGENT_ISLAND_COMPLETION_REVEAL_DWELL_MS = 8_000;
export const AGENT_ISLAND_ERROR_REVEAL_DWELL_MS = 12_000;
export const AGENT_ISLAND_EXPANDED_MIN_DWELL_MS = 1_000;
export const AGENT_ISLAND_HOVER_EXPAND_DELAY_MS = 500;
export const AGENT_ISLAND_MOUSE_LEAVE_COLLAPSE_DELAY_MS = 150;
export const AGENT_ISLAND_HOVER_SHORT_COOLDOWN_MS = 300;
export const AGENT_ISLAND_TOOL_DETAIL_LINGER_MS = 2_000;
export const AGENT_ISLAND_MESSAGE_PREVIEW_MIN_DWELL_MS = 1_600;
export const AGENT_ISLAND_FOCUS_VERIFY_TIMEOUT_MS = 1_500;
const AGENT_ISLAND_FOCUS_NAVIGATION_TIMEOUT_MS = 60_000;
// 未读的 completed / error 在**灵动岛浮窗**里驻留的上限;超过后即便用户没 ack,
// 也不再占用展开列表。岛 state 会按 TTL prune;远程绿/红点改订独立的
// remoteUnreadTerminals 账本,不跟完整会话(含活动文本)一起留下。
export const AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS = 4 * 60 * 60 * 1_000;
const AGENT_ISLAND_COMPACT_CURRENT_MIN_DWELL_MS = 1_200;
const AGENT_ISLAND_MEASURED_HEIGHT_MAX = 2_000;
const AGENT_ISLAND_ACTIVITY_MAX_LINES = 3;
const AGENT_ISLAND_COMPACT_TITLE_MAX_LENGTH = 28;
const AGENT_ISLAND_COMPACT_DETAIL_MAX_LENGTH = 120;

type AgentIslandDisplayIntent =
  | { kind: 'closed' }
  | { kind: 'peek'; sessionId: string }
  | { kind: 'manualExpand'; sessionId: string | null }
  | { kind: 'blocking'; sessionId: string }
  | { kind: 'transient'; sessionId: string }
  | { kind: 'deferredReveal'; sessionId: string }
  | { kind: 'collapse'; reason: 'manual' | 'autoTransient' };

type AgentIslandDecisionSurface =
  | { kind: 'closed'; current: AgentIslandSessionState | null }
  | { kind: 'peek'; current: AgentIslandSessionState }
  | { kind: 'manualExpanded'; current: AgentIslandSessionState | null }
  | { kind: 'blocking'; current: AgentIslandSessionState }
  | { kind: 'transient'; current: AgentIslandSessionState };

interface AgentIslandDisplayDecision {
  intent: AgentIslandDisplayIntent;
  surface: AgentIslandDecisionSurface;
  mode: AgentIslandDisplayState['mode'];
  displayPolicy: AgentIslandDisplayPolicy;
  smartSuppressed: boolean;
  manualExpanded: boolean;
  autoReveal: boolean;
}

interface AgentIslandSessionMeta {
  sessionId: string;
  agentKind?: string;
  workingDir?: string | null;
  title?: string | null;
  workspaceKind?: string | null;
}

interface ApplyAgentIslandEventOptions {
  suppressCompletionAttention?: boolean;
  preserveCompletionAttention?: boolean;
  /** Snapshot that permits this terminal error's paired completion event. */
  allowCompletionAfterTerminalError?: boolean;
}

interface AgentIslandSessionState {
  sessionId: string;
  title: string | null;
  projectName: string | null;
  detail: string;
  detailSource: 'tool' | 'status' | 'interaction' | null;
  /** Localized transient reconnect progress; kept separate from tool/interaction detail. */
  reconnectStatus: string | null;
  currentToolUseId: string | null;
  toolDetailUntil: number | null;
  phase: AgentIslandSessionPhase;
  agentKind: string;
  interactionKind?: AgentIslandInteractionKind;
  pendingInteractionIds: Set<string>;
  pendingInteractionKinds: Map<string, AgentIslandInteractionKind>;
  pendingInteractionDetails: Map<string, string>;
  pendingPermissionCanAllowForSession: Map<string, boolean>;
  permissionRequestId: string | null;
  permissionCanAllowForSession: boolean;
  running: boolean;
  completedUntil: number | null;
  errorUntil: number | null;
  /** Whether this terminal error belongs to a flow that deliberately emits a paired done. */
  completionAllowedAfterTerminalError: boolean;
  revealUntil: number | null;
  visibleInteractionSuppressedUntil: number | null;
  interactionRevealDismissed: boolean;
  deferredReveal: boolean;
  deferredRevealReason: 'visible-session' | 'app-focus' | 'queued' | 'manual-dismiss' | null;
  queuedRevealDwellMs: number | null;
  unread: boolean;
  activityLines: AgentIslandActivityLine[];
  activitySeq: number;
  assistantStreamLineId: string | null;
  assistantStream: ActivityTextStreamState;
  messagePreview: {
    line: AgentIslandActivityLine;
    until: number;
  } | null;
  messagePreviewQueue: AgentIslandActivityLine[];
  startedAt: number;
  /**
   * Sidebar-style sort clock: the latest user/scheduler prompt accepted for
   * this session. Agent replies, streaming text and tool progress must not
   * bump it. Sessions first observed through an agent event use startedAt as
   * the same fallback role as the sidebar's `userSendAt ?? updatedAt`.
   */
  sortActivityAt: number;
  lastActivityAt: number;
}

export interface AgentIslandUserPromptRollbackToken {
  sessionId: string;
  session: AgentIslandSessionState | null;
}

/**
 * Mutable reducer state for the island. It stays in main so the renderer only
 * receives a display-ready snapshot and does no product-state arbitration.
 */
export interface AgentIslandState {
  sessions: Map<string, AgentIslandSessionState>;
  isMouseInMenuBarZone: boolean;
  isMouseInExpandedPanel: boolean;
  hoverDisplayId: number | null;
  hoverIntentAt: number | null;
  hoverExpanded: boolean;
  hoverCooldownUntil: number | null;
  collapseAt: number | null;
  measuredContentHeight: number;
  appFocused: boolean;
  visibleSessionId: string | null;
  visibleSessionIds: Set<string>;
  layoutDragActive: boolean;
  expandedSessionOrder: string[] | null;
  activeTransientSessionId: string | null;
  transientRevealQueue: string[];
  pendingFocusSessionId: string | null;
  // Short grace for a renderer ack before OS focus settles. Navigation itself
  // may take longer (for example a renderer reload); its bounded deadline is
  // derived from this timestamp by pendingFocusNavigationExpiresAt.
  pendingFocusUntil: number | null;
  lastDisplayMode: AgentIslandDisplayState['mode'] | null;
  lastDisplayPolicy: AgentIslandDisplayPolicy | null;
  lastDisplaySurface: AgentIslandDisplaySurface | null;
  lastDisplaySessionId: string | null;
  expandedProtectUntil: number | null;
  protectedDismissPending: boolean;
  compactCurrentSessionId: string | null;
  compactCurrentUntil: number | null;
  strings: AgentIslandStrings;
  /** 工具状态文案的措辞实现:默认共享包中文表,service 注入本地化版(lazy t())。 */
  toolWording: ToolRowWording;
  /**
   * 远程侧栏绿/红点的未读账本。岛面 TTL 只决定浮窗还显不显,不删这里。
   * 条目只保留 phase / lastActivityAt,不含活动文本;resetRuntimeState 会清掉
   * (进程重启后靠 localDb 兜底补发收尾包)。
   */
  remoteUnreadTerminals: Map<string, AgentIslandRemoteUnreadTerminal>;
}

export interface AgentIslandRemoteUnreadTerminal {
  sessionId: string;
  phase: 'completed' | 'error';
  lastActivityAt: number;
}

export function createAgentIslandState(): AgentIslandState {
  return {
    sessions: new Map(),
    isMouseInMenuBarZone: false,
    isMouseInExpandedPanel: false,
    hoverDisplayId: null,
    hoverIntentAt: null,
    hoverExpanded: false,
    hoverCooldownUntil: null,
    collapseAt: null,
    measuredContentHeight: 0,
    appFocused: false,
    visibleSessionId: null,
    visibleSessionIds: new Set(),
    layoutDragActive: false,
    expandedSessionOrder: null,
    activeTransientSessionId: null,
    transientRevealQueue: [],
    pendingFocusSessionId: null,
    pendingFocusUntil: null,
    lastDisplayMode: null,
    lastDisplayPolicy: null,
    lastDisplaySurface: null,
    lastDisplaySessionId: null,
    expandedProtectUntil: null,
    protectedDismissPending: false,
    compactCurrentSessionId: null,
    compactCurrentUntil: null,
    strings: { ...DEFAULT_AGENT_ISLAND_STRINGS },
    toolWording: DEFAULT_TOOL_ROW_WORDING,
    remoteUnreadTerminals: new Map(),
  };
}

export function resetAgentIslandState(state: AgentIslandState): void {
  const fresh = createAgentIslandState();
  state.sessions = fresh.sessions;
  state.isMouseInMenuBarZone = fresh.isMouseInMenuBarZone;
  state.isMouseInExpandedPanel = fresh.isMouseInExpandedPanel;
  state.hoverDisplayId = fresh.hoverDisplayId;
  state.hoverIntentAt = fresh.hoverIntentAt;
  state.hoverExpanded = fresh.hoverExpanded;
  state.hoverCooldownUntil = fresh.hoverCooldownUntil;
  state.collapseAt = fresh.collapseAt;
  state.measuredContentHeight = fresh.measuredContentHeight;
  state.appFocused = fresh.appFocused;
  state.visibleSessionId = fresh.visibleSessionId;
  state.visibleSessionIds = fresh.visibleSessionIds;
  state.layoutDragActive = fresh.layoutDragActive;
  state.expandedSessionOrder = fresh.expandedSessionOrder;
  state.activeTransientSessionId = fresh.activeTransientSessionId;
  state.transientRevealQueue = fresh.transientRevealQueue;
  state.pendingFocusSessionId = fresh.pendingFocusSessionId;
  state.pendingFocusUntil = fresh.pendingFocusUntil;
  state.lastDisplayMode = fresh.lastDisplayMode;
  state.lastDisplayPolicy = fresh.lastDisplayPolicy;
  state.lastDisplaySurface = fresh.lastDisplaySurface;
  state.lastDisplaySessionId = fresh.lastDisplaySessionId;
  state.expandedProtectUntil = fresh.expandedProtectUntil;
  state.protectedDismissPending = fresh.protectedDismissPending;
  state.compactCurrentSessionId = fresh.compactCurrentSessionId;
  state.compactCurrentUntil = fresh.compactCurrentUntil;
  state.strings = fresh.strings;
  state.remoteUnreadTerminals = fresh.remoteUnreadTerminals;
  // toolWording 是注入的配置(非会话状态),reset 时保留,避免退回默认中文表。
}

export function setAgentIslandStrings(state: AgentIslandState, strings: AgentIslandStrings): void {
  state.strings = { ...strings };
}

export function setAgentIslandToolWording(state: AgentIslandState, wording: ToolRowWording): void {
  state.toolWording = wording;
}

export function setAgentIslandAppFocused(state: AgentIslandState, focused: boolean, now = Date.now()): boolean {
  const previousFocused = state.appFocused;
  state.appFocused = focused;
  const changed = previousFocused !== focused;
  if (focused) {
    suppressRevealForVisibleSession(state, now);
  }
  syncVisibleInteractionSuppression(state, now);
  return changed;
}

export function setAgentIslandVisibleSession(
  state: AgentIslandState,
  sessionId: string | readonly string[] | null,
  now = Date.now(),
): boolean {
  const nextSessionIds = normalizeVisibleSessionIds(sessionId);
  const nextSessionId = nextSessionIds[0] ?? null;
  const previousSessionId = state.visibleSessionId;
  const previousSessionIds = state.visibleSessionIds;
  state.visibleSessionId = nextSessionId;
  state.visibleSessionIds = new Set(nextSessionIds);
  if (state.appFocused) {
    suppressRevealForVisibleSession(state, now);
  }
  syncVisibleInteractionSuppression(state, now);
  const focusChanged = applyVerifiedFocusIfMatched(state, now);
  const visibleSessionsChanged = previousSessionIds.size !== state.visibleSessionIds.size
    || nextSessionIds.some((id) => !previousSessionIds.has(id));
  return previousSessionId !== nextSessionId || visibleSessionsChanged || focusChanged;
}

export function setAgentIslandMeasuredContentHeight(
  state: AgentIslandState,
  measuredContentHeight: number,
): boolean {
  if (!Number.isFinite(measuredContentHeight)) return false;
  const next = Math.max(0, Math.min(AGENT_ISLAND_MEASURED_HEIGHT_MAX, Math.ceil(measuredContentHeight)));
  if (Math.abs(state.measuredContentHeight - next) < 1) return false;
  state.measuredContentHeight = next;
  return true;
}

export function setAgentIslandHovered(state: AgentIslandState, hovered: boolean, now: number): boolean {
  return setAgentIslandPointerZones(state, { menuBar: hovered, panel: false }, now);
}

export function setAgentIslandPointerZones(
  state: AgentIslandState,
  zones: { menuBar: boolean; panel: boolean; displayId?: number | null },
  now: number,
): boolean {
  if (state.layoutDragActive) return false;
  const wasPointerInside = isPointerInsideIsland(state);
  const previousHoverIntentAt = state.hoverIntentAt;
  const previousCollapseAt = state.collapseAt;
  const previousHoverExpanded = state.hoverExpanded;
  const previousCooldownUntil = state.hoverCooldownUntil;
  const previousMenuBarZone = state.isMouseInMenuBarZone;
  const previousExpandedPanel = state.isMouseInExpandedPanel;
  const previousHoverDisplayId = state.hoverDisplayId;

  state.isMouseInMenuBarZone = zones.menuBar;
  state.isMouseInExpandedPanel = zones.panel;

  if (isPointerInsideIsland(state)) {
    if (typeof zones.displayId === 'number' && Number.isFinite(zones.displayId)) {
      state.hoverDisplayId = zones.displayId;
    }
    state.collapseAt = null;
    if (state.hoverExpanded || state.isMouseInExpandedPanel) {
      state.hoverIntentAt = null;
    } else if (
      state.isMouseInMenuBarZone
      && !isHoverExpansionSuppressedByReminder(state, now)
      && (!state.hoverCooldownUntil || state.hoverCooldownUntil <= now)
    ) {
      state.hoverIntentAt = now + AGENT_ISLAND_HOVER_EXPAND_DELAY_MS;
    } else {
      state.hoverIntentAt = null;
    }
  } else {
    state.hoverIntentAt = null;
    if (state.hoverExpanded) {
      state.collapseAt = now + AGENT_ISLAND_MOUSE_LEAVE_COLLAPSE_DELAY_MS;
    } else {
      state.collapseAt = null;
      state.hoverDisplayId = null;
    }
    state.hoverCooldownUntil = now + AGENT_ISLAND_HOVER_SHORT_COOLDOWN_MS;
  }

  return wasPointerInside !== isPointerInsideIsland(state)
    || previousHoverIntentAt !== state.hoverIntentAt
    || previousCollapseAt !== state.collapseAt
    || previousHoverExpanded !== state.hoverExpanded
    || previousCooldownUntil !== state.hoverCooldownUntil
    || previousMenuBarZone !== state.isMouseInMenuBarZone
    || previousExpandedPanel !== state.isMouseInExpandedPanel
    || previousHoverDisplayId !== state.hoverDisplayId;
}

export function setAgentIslandLayoutDragActive(
  state: AgentIslandState,
  active: boolean,
): boolean {
  const previous = state.layoutDragActive;
  state.layoutDragActive = active;
  if (active) {
    state.hoverIntentAt = null;
    state.collapseAt = null;
    state.hoverDisplayId = null;
  }
  return previous !== active;
}

export function requestAgentIslandManualExpand(state: AgentIslandState, displayId?: number | null): boolean {
  if (state.layoutDragActive) return false;
  const nextDisplayId = typeof displayId === 'number' && Number.isFinite(displayId)
    ? displayId
    : state.hoverDisplayId;
  const changed = !state.hoverExpanded
    || state.hoverIntentAt !== null
    || state.collapseAt !== null
    || state.hoverCooldownUntil !== null
    || state.hoverDisplayId !== nextDisplayId;
  state.hoverIntentAt = null;
  state.hoverExpanded = true;
  state.hoverDisplayId = nextDisplayId;
  state.collapseAt = null;
  state.hoverCooldownUntil = null;
  return changed;
}

export function requestAgentIslandManualCollapse(state: AgentIslandState, now: number): boolean {
  if (state.layoutDragActive) return false;
  const changed = state.hoverExpanded
    || state.hoverIntentAt !== null
    || state.collapseAt !== null
    || state.protectedDismissPending;
  state.hoverIntentAt = null;
  state.hoverExpanded = false;
  state.collapseAt = null;
  state.protectedDismissPending = false;
  state.hoverCooldownUntil = now + AGENT_ISLAND_HOVER_SHORT_COOLDOWN_MS;
  // Keep current pointer-zone flags. Hover expand only re-arms after leave+re-enter,
  // so clicking the original compact position does not immediately pop the island open again.
  return changed;
}

export function applyAgentIslandMetadata(
  state: AgentIslandState,
  meta: AgentIslandSessionMeta,
  now: number,
): void {
  const session = getOrCreateSession(state, meta, now);
  applyMeta(session, meta);
}

export function patchAgentIslandMetadata(
  state: AgentIslandState,
  meta: AgentIslandSessionMeta,
): boolean {
  const session = state.sessions.get(meta.sessionId);
  if (!session) return false;
  const previousTitle = session.title;
  const previousProjectName = session.projectName;
  const previousAgentKind = session.agentKind;
  applyMeta(session, meta);
  return previousTitle !== session.title
    || previousProjectName !== session.projectName
    || previousAgentKind !== session.agentKind;
}

export function applyAgentIslandUserPrompt(
  state: AgentIslandState,
  meta: AgentIslandSessionMeta,
  prompt: string,
  now: number,
): boolean {
  const text = normalizeActivityText(prompt);
  if (!text) return false;
  const session = getOrCreateSession(state, meta, now);
  applyMeta(session, meta);
  markSessionRunning(state, session, now);
  session.phase = 'running';
  session.interactionKind = undefined;
  session.detail = '';
  session.detailSource = null;
  session.reconnectStatus = null;
  session.currentToolUseId = null;
  session.toolDetailUntil = null;
  clearAssistantStream(session);
  const line = appendActivityLine(session, 'user', text);
  if (line) enqueueMessagePreview(session, line, now);
  session.sortActivityAt = now;
  session.lastActivityAt = now;
  return true;
}

export function createAgentIslandUserPromptRollbackToken(
  state: AgentIslandState,
  sessionId: string,
): AgentIslandUserPromptRollbackToken {
  const session = state.sessions.get(sessionId);
  return {
    sessionId,
    session: session ? cloneSession(session) : null,
  };
}

export function rollbackAgentIslandUserPrompt(
  state: AgentIslandState,
  token: AgentIslandUserPromptRollbackToken,
): void {
  // 只还原该 session 自己的条目和它自己的 reveal 归属。禁止整份写回
  // activeTransientSessionId / reveal queue,否则会盖掉其它 session。
  if (token.session) {
    const restored = cloneSession(token.session);
    state.sessions.set(token.sessionId, restored);
    restoreSessionScopedReveal(state, restored, Date.now());
    return;
  }
  state.sessions.delete(token.sessionId);
  removeQueuedTransientReveal(state, token.sessionId);
}

function restoreSessionScopedReveal(
  state: AgentIslandState,
  session: AgentIslandSessionState,
  now: number,
): void {
  const sessionId = session.sessionId;
  const wantsActive = session.revealUntil != null
    && session.revealUntil > now
    && session.deferredReveal !== true;
  const wantsQueued = session.deferredRevealReason === 'queued';
  if (!wantsActive && !wantsQueued) return;

  if (wantsActive) {
    if (!state.activeTransientSessionId || state.activeTransientSessionId === sessionId) {
      state.activeTransientSessionId = sessionId;
      state.transientRevealQueue = state.transientRevealQueue.filter(
        (queuedSessionId) => queuedSessionId !== sessionId,
      );
      return;
    }
    if (!state.transientRevealQueue.includes(sessionId)) {
      state.transientRevealQueue.push(sessionId);
    }
    session.deferredReveal = true;
    session.deferredRevealReason = 'queued';
    session.revealUntil = null;
    return;
  }

  if (state.activeTransientSessionId === sessionId) return;
  if (!state.transientRevealQueue.includes(sessionId)) {
    state.transientRevealQueue.push(sessionId);
  }
}

export function applyAgentIslandEvent(
  state: AgentIslandState,
  meta: AgentIslandSessionMeta,
  event: AgentEvent,
  now: number,
  options: ApplyAgentIslandEventOptions = {},
): boolean {
  if (!isIslandRelevantEvent(event)) return false;
  // A claimed done/status pair only seals one SDK turn. The product turn is
  // still running, so do not create/update an island entry or trigger any
  // completion transition here; the unclaimed terminal tail will do that.
  if (isTurnContinuationBoundaryEvent(event)) return false;
  const assistantText = event.type === 'text' ? assistantTextFromEvent(event) : null;
  if (event.type === 'text' && !assistantText) return false;

  const session = getOrCreateSession(state, meta, now);
  applyMeta(session, meta);
  if (event.type !== 'error') {
    session.reconnectStatus = null;
  }
  session.lastActivityAt = now;

  if (event.type === 'text') {
    clearToolDetail(session);
    const isFinal = asRecord(event.data)?.isFinal === true;
    const line = applyAssistantTextLine(session, assistantText ?? '', isFinal);
    if (line && !session.messagePreviewQueue.some((queued) => queued.id === line.id)
      && session.messagePreview?.line.id !== line.id) {
      enqueueMessagePreview(session, line, now);
    }
    return true;
  }

  if (event.type === 'status') {
    const data = asRecord(event.data);
    const isRunning = data?.isRunning;
    const status = typeof data?.status === 'string' ? data.status : null;
    if (event.turnScope === 'background') {
      if (status && !session.currentToolUseId && !session.toolDetailUntil) {
        session.detail = status;
        session.detailSource = 'status';
      }
      return true;
    }
    if (isRunning === true) {
      markSessionRunning(state, session, now);
      if (session.pendingInteractionIds.size === 0) {
        session.phase = 'running';
        session.interactionKind = undefined;
      }
      if (status && !session.currentToolUseId && !session.toolDetailUntil) {
        session.detail = status;
        session.detailSource = 'status';
      }
      return true;
    }
    if (isRunning === false) {
      session.running = false;
      session.currentToolUseId = null;
      session.toolDetailUntil = null;
      if (session.detailSource === 'tool') {
        session.detail = '';
        session.detailSource = null;
      }
      if (session.pendingInteractionIds.size === 0 && status === 'Done') {
        completeAgentIslandSession(state, session, now, {
          suppressAttention: options.suppressCompletionAttention === true,
          preserveAttention: options.preserveCompletionAttention === true,
        });
      }
      return true;
    }
  }

  if (event.type === 'tool_use') {
    clearAssistantStream(session);
    const data = asRecord(event.data);
    const toolName = firstNonEmptyString(data?.toolName, data?.name);
    const toolUseId = toolUseIdsFromEvent(event)[0] ?? null;
    const toolInput = data?.input;
    const toolDescription = toolName
      ? formatIslandToolDetail(toolName, toolInput, { wording: state.toolWording }, data ?? undefined)
      : firstNonEmptyString(data?.description, data?.toolDescription);
    markSessionRunning(state, session, now);
    if (toolUseId) {
      dismissPendingInteraction(state, session, toolUseId, now, { requirePending: true });
    }
    if (session.pendingInteractionIds.size > 0) {
      session.currentToolUseId = null;
      session.toolDetailUntil = null;
      return true;
    }
    session.phase = 'running';
    session.interactionKind = undefined;
    session.currentToolUseId = toolUseId;
    session.toolDetailUntil = null;
    if (toolDescription || toolName) {
      session.detail = toolDescription || toolName || '';
      session.detailSource = 'tool';
    }
    return true;
  }

  if (event.type === 'tool_result') {
    const toolUseIds = toolUseIdsFromEvent(event);
    if (
      session.currentToolUseId
      && (toolUseIds.length === 0 || toolUseIds.includes(session.currentToolUseId))
    ) {
      session.currentToolUseId = null;
      session.toolDetailUntil = session.detail ? now + AGENT_ISLAND_TOOL_DETAIL_LINGER_MS : null;
    }
    for (const toolUseId of toolUseIds) {
      dismissPendingInteraction(state, session, toolUseId, now, { requirePending: true });
    }
    return true;
  }

  if (event.type === 'done') {
    clearAssistantStream(session);
    session.running = false;
    session.currentToolUseId = null;
    session.toolDetailUntil = null;
    // Codex ask_user / plan_review can outlive a successful turn. Permission
    // cards belong to the dead turn and must not keep the island waiting.
    for (const [requestId, kind] of [...session.pendingInteractionKinds.entries()]) {
      if (kind === 'ask_user_question' || kind === 'plan_review') continue;
      dismissPendingInteraction(state, session, requestId, now, {
        requirePending: true,
        pruneIfIdle: false,
      });
    }
    if (session.pendingInteractionIds.size > 0) {
      session.phase = 'needs-interaction';
      restorePendingInteractionKind(session);
      session.detail = session.interactionKind
        ? (session.pendingInteractionDetails.get(
            [...session.pendingInteractionIds][0] ?? '',
          ) ?? session.detail)
        : session.detail;
      session.detailSource = 'interaction';
      session.completedUntil = null;
      session.lastActivityAt = now;
      return true;
    }
    session.permissionRequestId = null;
    session.permissionCanAllowForSession = false;
    session.detailSource = null;
    completeAgentIslandSession(state, session, now, {
      suppressAttention: options.suppressCompletionAttention === true,
      preserveAttention: options.preserveCompletionAttention === true,
    });
    return true;
  }

  if (event.type === 'error') {
    const data = asRecord(event.data);
    const isTerminal = typeof data?.isTerminal === 'boolean'
      ? data.isTerminal
      : typeof data?.willRetry === 'boolean'
        ? !data.willRetry
        : true;
    if (!isTerminal) {
      const message = typeof data?.message === 'string' ? data.message : '';
      const reconnectAttempt = parseReconnectAttemptMessage(message);
      session.reconnectStatus = reconnectAttempt
        ? formatReconnectStatus(
            state.strings.networkReconnecting,
            reconnectAttempt.attempt,
            reconnectAttempt.maxAttempts,
          )
        : null;
      return true;
    }
    session.reconnectStatus = null;
    clearAssistantStream(session);
    session.running = false;
    session.phase = 'error';
    session.interactionKind = undefined;
    session.pendingInteractionIds.clear();
    clearPendingInteractionMetadata(session);
    session.permissionRequestId = null;
    session.permissionCanAllowForSession = false;
    session.interactionRevealDismissed = false;
    session.currentToolUseId = null;
    session.toolDetailUntil = null;
    // Tool-loop terminal errors carry a maker-core diagnostic message for logs and
    // the chat transcript, but Agent Island has its own localized string bundle.
    // Do not surface the producer's Chinese/internal category in this main-side
    // display path; other terminal errors keep their existing detail behavior.
    const isToolLoopError = data?.reason === 'tool_use_loop_detected';
    session.detail = isToolLoopError
      ? state.strings.error
      : typeof data?.message === 'string' && data.message.trim()
        ? data.message.trim()
        : '';
    session.detailSource = session.detail ? 'status' : null;
    if (session.detail) appendActivityLine(session, 'status', session.detail);
    session.errorUntil = now + AGENT_ISLAND_ERROR_DWELL_MS;
    session.completionAllowedAfterTerminalError = options.allowCompletionAfterTerminalError === true;
    session.completedUntil = null;
    // 报错必须挂未读:smart suppress(用户正停在该会话)只抑制自动展开,不代表
    // 用户真的看到了报错内容。unread 只能由显式已读 ack(renderer 确认报错 UI
    // 真实展示给用户)清除,否则条目会在 errorUntil 过期后被 prune 静默删除。
    requestAttentionReveal(state, session, now, AGENT_ISLAND_ERROR_REVEAL_DWELL_MS, { forceUnread: true });
    syncRemoteUnreadTerminal(state, session);
    return true;
  }

  return true;
}

export function applyAgentIslandInteractionRequest(
  state: AgentIslandState,
  meta: AgentIslandSessionMeta,
  request: AgentIslandInteractionRequest,
  now: number,
): void {
  const session = getOrCreateSession(state, meta, now);
  applyMeta(session, meta);
  session.reconnectStatus = null;
  session.pendingInteractionIds.add(request.requestId);
  session.pendingInteractionKinds.set(request.requestId, request.kind);
  session.pendingInteractionDetails.set(request.requestId, detailForInteraction(request, state.toolWording));
  markSessionRunning(state, session, now);
  session.completionAllowedAfterTerminalError = false;
  const activateRequest = request.kind !== 'permission' || session.permissionRequestId === null;
  if (request.kind === 'permission') {
    const canAllowForSession = hasSessionScopedPermissionSuggestion(request.suggestions);
    session.pendingPermissionCanAllowForSession.set(request.requestId, canAllowForSession);
    if (activateRequest) {
      session.permissionRequestId = request.requestId;
      session.permissionCanAllowForSession = canAllowForSession;
    }
  } else {
    session.permissionRequestId = null;
    session.permissionCanAllowForSession = false;
    session.pendingPermissionCanAllowForSession.delete(request.requestId);
  }
  if (!activateRequest) {
    session.lastActivityAt = now;
    return;
  }
  session.phase = 'needs-interaction';
  session.interactionKind = request.kind;
  session.detail = session.pendingInteractionDetails.get(request.requestId) ?? '';
  session.detailSource = 'interaction';
  session.currentToolUseId = null;
  session.toolDetailUntil = null;
  session.completedUntil = null;
  session.errorUntil = null;
  session.visibleInteractionSuppressedUntil = null;
  session.interactionRevealDismissed = false;
  deferActiveTransientReveal(state, 'queued');
  requestAttentionReveal(state, session, now, AGENT_ISLAND_REVEAL_DWELL_MS);
  syncVisibleInteractionSuppression(state, now);
  session.lastActivityAt = now;
}

export function applyAgentIslandInteractionDismissed(
  state: AgentIslandState,
  sessionId: string,
  requestId: string,
  now: number,
): void {
  const session = state.sessions.get(sessionId);
  if (!session) return;
  // Dismissal broadcasts can arrive after the turn has already completed
  // (plugin setup intentionally keeps terminal UI visible for a short grace).
  // A request that is no longer pending must not clear newer completion/error
  // attention.
  dismissPendingInteraction(state, session, requestId, now, { requirePending: true });
}

function dismissPendingInteraction(
  state: AgentIslandState,
  session: AgentIslandSessionState,
  requestId: string,
  now: number,
  options: { requirePending?: boolean; pruneIfIdle?: boolean } = {},
): void {
  if (options.requirePending === true && !session.pendingInteractionIds.has(requestId)) return;
  session.pendingInteractionIds.delete(requestId);
  session.pendingInteractionKinds.delete(requestId);
  session.pendingInteractionDetails.delete(requestId);
  session.pendingPermissionCanAllowForSession.delete(requestId);
  if (session.permissionRequestId === requestId) {
    restorePendingPermissionAction(session);
  }
  session.lastActivityAt = now;
  if (session.pendingInteractionIds.size > 0) {
    restorePendingInteractionKind(session);
    return;
  }
  session.interactionKind = undefined;
  session.visibleInteractionSuppressedUntil = null;
  session.interactionRevealDismissed = false;
  // 未读归属 error 本身而非交互请求:错误善后时 maker 侧会撤销 pending 权限/提问,
  // 这里若无条件清 unread,刚挂上的 error 未读会被吞掉、条目随后被静默删除;
  // 同理,error 的自动展开(12s reveal)也不该被交互撤销打断。
  const preserveErrorUnread = session.phase === 'error' && session.unread;
  if (!preserveErrorUnread) {
    session.revealUntil = null;
    session.deferredReveal = false;
    session.deferredRevealReason = null;
    session.queuedRevealDwellMs = null;
  }
  session.unread = preserveErrorUnread;
  if (session.running) {
    session.phase = 'running';
    if (session.detailSource === 'interaction') {
      session.detail = '';
      session.detailSource = null;
    } else {
      session.detail = session.detail || '';
    }
    return;
  }
  if (session.completedUntil && session.completedUntil > now) {
    session.phase = 'completed';
    return;
  }
  if (session.errorUntil && session.errorUntil > now) {
    session.phase = 'error';
    return;
  }
  // errorUntil 已过期但未读的 error 账本仍在,不能删 —— 岛面 TTL 只影响展示。
  if (preserveErrorUnread) return;
  // done 会先清死 turn 的 permission，再记 completed。这里若立刻 prune，
  // 后续 complete 只能改到已脱离 state.sessions 的孤儿对象，岛面丢完成态。
  if (options.pruneIfIdle === false) return;
  state.sessions.delete(session.sessionId);
}

/**
 * 已读 ack 的处理结果。原 boolean 返回把「state 有变化」与「为什么没变化」压成一个值,
 * 调用方无法区分「会话不存在(可以给远端发收尾包)」和「error 免疫(绝不能发收尾包,
 * 否则手机端红点被 passive 清掉)」——已读回执的确定性收敛(service 层
 * forceClearSession)依赖这个区分。
 *   - 'cleared'      有未读 / dwell / reveal 状态被清掉,调用方应 publish。
 *   - 'noop'         会话在但本来就没有可清的状态(重复 ack 等),无需 publish。
 *   - 'not-found'    state 里没有该会话(重启丢失 / 条目已过期删除)。
 *   - 'error-immune' 未读 error 对 passive ack 免疫,state 未动。
 */
export type AgentIslandSessionReadAckResult = 'cleared' | 'noop' | 'not-found' | 'error-immune';

export function acknowledgeAgentIslandSessionRead(
  state: AgentIslandState,
  sessionId: string,
  now: number,
  options: { source?: 'passive' | 'explicit' } = {},
): AgentIslandSessionReadAckResult {
  const session = state.sessions.get(sessionId);
  const unread = state.remoteUnreadTerminals.get(sessionId);
  // 未读 error 订账本,不订当前 live phase。新一轮 running 时 session.phase 已不是
  // error,但用户仍可能没看过那次报错;passive 必须先看账本,否则聚焦/路由可见会把
  // 旧红点清掉。
  if (options.source === 'passive' && (
    unread?.phase === 'error' || (session?.phase === 'error' && session.unread)
  )) {
    return 'error-immune';
  }
  if (!session) {
    if (!unread) return 'not-found';
    clearRemoteUnreadTerminal(state, sessionId);
    return 'cleared';
  }

  const wasUnread = session.unread;
  const hadDeferredReveal = session.deferredReveal;
  const hadReveal = session.revealUntil !== null;
  const hadCompletionDwell = session.completedUntil !== null;
  const hadErrorDwell = session.errorUntil !== null;

  session.unread = false;
  clearRemoteUnreadTerminal(state, sessionId);
  session.deferredReveal = false;
  session.deferredRevealReason = null;
  session.revealUntil = null;
  removeQueuedTransientReveal(state, sessionId);
  if (session.phase === 'completed') session.completedUntil = null;
  if (session.phase === 'error') session.errorUntil = null;

  if (!isSessionVisible(session, now)) {
    state.sessions.delete(sessionId);
    return 'cleared';
  }

  return wasUnread || hadDeferredReveal || hadReveal || hadCompletionDwell || hadErrorDwell
    ? 'cleared'
    : 'noop';
}

export function completeAgentIslandSessionWithoutAttention(
  state: AgentIslandState,
  sessionId: string,
  now: number,
  options: { preserveAttention: boolean },
): boolean {
  const session = state.sessions.get(sessionId);
  if (!session) return false;

  session.running = false;
  session.pendingInteractionIds.clear();
  clearPendingInteractionMetadata(session);
  session.permissionRequestId = null;
  session.permissionCanAllowForSession = false;
  session.currentToolUseId = null;
  session.toolDetailUntil = null;
  session.detailSource = null;
  completeAgentIslandSession(state, session, now, {
    suppressAttention: true,
    preserveAttention: options.preserveAttention,
  });

  if (!isSessionVisible(session, now)) {
    if (isUnreadTerminalLedger(session)) syncRemoteUnreadTerminal(state, session);
    state.sessions.delete(sessionId);
    removeQueuedTransientReveal(state, sessionId);
  }
  return true;
}

export function markAgentIslandSessionAttention(
  state: AgentIslandState,
  sessionId: string,
): boolean {
  const session = state.sessions.get(sessionId);
  if (!session || session.unread) return false;
  session.unread = true;
  syncRemoteUnreadTerminal(state, session);
  return true;
}

export function hasAgentIslandSessionAttention(
  state: AgentIslandState,
  sessionId: string,
): boolean {
  if (state.remoteUnreadTerminals.has(sessionId)) return true;
  const session = state.sessions.get(sessionId);
  return session ? session.unread || isAttentionSession(session) : false;
}

function forgetAgentIslandSession(state: AgentIslandState, sessionId: string): void {
  state.sessions.delete(sessionId);
  if (state.visibleSessionIds.delete(sessionId) && state.visibleSessionId === sessionId) {
    state.visibleSessionId = state.visibleSessionIds.values().next().value ?? null;
  }
  removeQueuedTransientReveal(state, sessionId);
  if (state.pendingFocusSessionId === sessionId) {
    state.pendingFocusSessionId = null;
    state.pendingFocusUntil = null;
  }
}

export function removeAgentIslandSession(state: AgentIslandState, sessionId: string): void {
  clearRemoteUnreadTerminal(state, sessionId);
  forgetAgentIslandSession(state, sessionId);
}

/**
 * 会话**进程**关闭:落下运行态,但保留仍需展示的通知条目。
 *
 * 为什么不能直接删:临时会话调度(非 heartbeat、非 persistentSession)在 run 终态之后
 * 立刻 closeSession(`scheduler-host/runner.ts` 的 fire finally),而完成卡片本该在岛上
 * 停留数秒。直接删条目会让刚弹出的卡片当场消失 —— 而且不是被别的内容顶掉,是整条记录
 * 没了,用户看到的就是「弹了一下就收起」。通知是**已发生事件的记录**,生命周期不该绑在
 * agent session 句柄上。
 *
 * 判据复用 `isSessionVisible`:仍需在岛上展示(TTL 内的未读终态 / dwell 未走完 /
 * 有 pending 交互)就留着。过了岛面 TTL 的未读终态会先写入独立账本再删岛 state;
 * 若岛条目已经不在(TTL 已 prune / 仅剩账本),close 不得再清账本 —— 远程绿/红点
 * 要等到真正已读。
 *
 * 会话被归档 / 删除、或 Orca worker 被策略清除时**不走这里** —— 那些语义是「这条记录
 * 不该再存在」,继续用 `removeAgentIslandSession` 硬删。
 */
export function closeAgentIslandSessionPreservingUnread(
  state: AgentIslandState,
  sessionId: string,
  now: number,
): void {
  const session = state.sessions.get(sessionId);
  if (!session) {
    // 岛面已 prune,独立账本仍可能挂着未读。进程关闭不等于已读。
    return;
  }
  // 进程已经没了,运行态必须落下来,否则 pill 会一直转着 working 动画。
  session.running = false;
  session.currentToolUseId = null;
  session.toolDetailUntil = null;
  // pending 交互随进程一起失效(service 侧同时会 deletePermissionRequestsForSession)。
  // 留着会让用户对着一张永远不会被响应的审批卡片点按钮。岛条目可以丢,但旧的
  // completed/error 账本不是这次审批,进程关闭不等于已读。
  if (session.pendingInteractionIds.size > 0) {
    if (state.remoteUnreadTerminals.has(sessionId)) {
      forgetAgentIslandSession(state, sessionId);
      return;
    }
    removeAgentIslandSession(state, sessionId);
    return;
  }
  if (isSessionVisible(session, now)) return;
  if (isUnreadTerminalLedger(session)) {
    syncRemoteUnreadTerminal(state, session);
    forgetAgentIslandSession(state, sessionId);
    return;
  }
  if (state.remoteUnreadTerminals.has(sessionId)) {
    forgetAgentIslandSession(state, sessionId);
    return;
  }
  removeAgentIslandSession(state, sessionId);
}

export function requestAgentIslandSessionFocus(
  state: AgentIslandState,
  sessionId: string,
  now: number,
): boolean {
  const nextSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
  if (!nextSessionId) return false;
  if (state.visibleSessionIds.has(nextSessionId)) {
    const dismissed = dismissFocusedSessionReveal(state, nextSessionId, now);
    const collapsed = collapseAgentIslandToCompact(state, now);
    state.pendingFocusSessionId = null;
    state.pendingFocusUntil = null;
    return dismissed || collapsed;
  }
  const previousSessionId = state.pendingFocusSessionId;
  const previousUntil = state.pendingFocusUntil;
  state.pendingFocusSessionId = nextSessionId;
  state.pendingFocusUntil = now + AGENT_ISLAND_FOCUS_VERIFY_TIMEOUT_MS;
  return previousSessionId !== state.pendingFocusSessionId || previousUntil !== state.pendingFocusUntil;
}

export function isAgentIslandPendingFocusAck(
  state: AgentIslandState,
  sessionId: string | readonly string[] | null,
  now = Date.now(),
): boolean {
  if (!state.pendingFocusSessionId || !state.pendingFocusUntil || state.pendingFocusUntil <= now) return false;
  return normalizeVisibleSessionIds(sessionId).includes(state.pendingFocusSessionId);
}

export function dismissAgentIslandActiveReveal(state: AgentIslandState, now: number): boolean {
  if (isExpandedProtected(state, now) && (hasActiveTransientReveal(state, now) || hasActiveBlockingReveal(state, now))) {
    return false;
  }
  const dismissedTransientReveal = dismissPublishedTransientReveal(state);
  const dismissedBlockingReveal = dismissPublishedBlockingReveal(state, now);
  if (dismissedTransientReveal || dismissedBlockingReveal) {
    const collapsed = applyAgentIslandDismiss(state, now);
    return dismissedTransientReveal || dismissedBlockingReveal || collapsed;
  }
  if (isExpandedProtected(state, now)) {
    state.protectedDismissPending = true;
    state.hoverIntentAt = null;
    state.collapseAt = state.expandedProtectUntil;
    state.hoverCooldownUntil = state.expandedProtectUntil;
    return true;
  }
  return applyAgentIslandDismiss(state, now);
}

function applyAgentIslandDismiss(state: AgentIslandState, now: number): boolean {
  let changed = false;
  state.hoverIntentAt = null;
  state.protectedDismissPending = false;
  if (state.hoverDisplayId !== null) {
    state.hoverDisplayId = null;
    changed = true;
  }
  if (state.isMouseInMenuBarZone) {
    state.isMouseInMenuBarZone = false;
    changed = true;
  }
  if (state.isMouseInExpandedPanel) {
    state.isMouseInExpandedPanel = false;
    changed = true;
  }
  if (state.hoverExpanded) {
    state.hoverExpanded = false;
    changed = true;
  }
  if (state.collapseAt !== null) {
    state.collapseAt = null;
    changed = true;
  }
  state.hoverCooldownUntil = now + AGENT_ISLAND_HOVER_SHORT_COOLDOWN_MS;

  return changed;
}

export function pruneAgentIslandSessions(state: AgentIslandState, now: number): void {
  updateHoverLifecycle(state, now);
  updateToolDetailLifecycle(state, now);
  updateMessagePreviewLifecycle(state, now);
  updateFocusVerificationLifecycle(state, now);
  const preserveExpiredTransient = isPointerInsideIsland(state) || state.hoverExpanded || isCollapsePending(state, now);
  for (const [sessionId, session] of state.sessions.entries()) {
    if (isSessionVisible(session, now, preserveExpiredTransient)) continue;
    // 过了岛面 TTL 的未读终态先写入独立账本,再删岛 state。远程绿/红点订账本,
    // 不再跟完整 AgentIslandSessionState(含活动文本)绑在一起。
    if (isUnreadTerminalLedger(session)) syncRemoteUnreadTerminal(state, session);
    state.sessions.delete(sessionId);
    removeQueuedTransientReveal(state, sessionId);
  }
}

export function buildAgentIslandDisplayState(
  state: AgentIslandState,
  now: number,
): AgentIslandDisplayState {
  pruneAgentIslandSessions(state, now);
  updateHoverLifecycle(state, now);
  const manualExpanded = state.hoverExpanded
    || (
      !isHoverExpansionSuppressedByReminder(state, now)
      && (state.isMouseInExpandedPanel || isCollapsePending(state, now))
    );
  promoteNextTransientReveal(state, now, manualExpanded);
  const sortedSessions = Array.from(state.sessions.values())
    .filter((session) => shouldDisplaySession(
      state,
      session,
      now,
      isPointerInsideIsland(state) || state.hoverExpanded || isCollapsePending(state, now),
    ))
    .sort((a, b) => compareSessionsForDisplay(state, a, b, now));
  const activeTransient = getActiveTransientSession(state, now);
  const orderedSessions = orderSessionsForCurrentSurface(
    state,
    orderSessionsForAutomaticTransientStack(sortedSessions, activeTransient, manualExpanded),
    manualExpanded,
    now,
  );
  const decision = buildDisplayDecision(state, orderedSessions, manualExpanded, now);
  const current = decision.surface.current;
  const mode = decision.mode;
  const notchStatus = getNotchStatus(current, mode);
  const displayPolicy = decision.displayPolicy;
  const surfaceOrderedSessions = orderSessionsForDecisionSurface(decision, orderedSessions);
  const displaySessions = getDisplaySessionsForSurface(decision, surfaceOrderedSessions, now);
  const displaySurface = getDisplaySurface(decision, displaySessions, now);
  updateExpandedProtection(state, mode, displayPolicy, displaySurface, current?.sessionId ?? null, now);
  const layoutMode = getLayoutMode(notchStatus);
  const pointerInside = isPointerInsideIsland(state);
  const shadowVisible = shouldShowShadow(current, manualExpanded, pointerInside);
  const pillSnapshot = buildPillSnapshot(surfaceOrderedSessions, current);

  return {
    visible: true,
    mode,
    notchStatus,
    displayPolicy,
    displaySurface,
    layoutMode,
    appFocused: state.appFocused,
    smartSuppressed: decision.smartSuppressed,
    shadowVisible,
    currentSessionId: current?.sessionId ?? null,
    expandedDisplayId: displayPolicy === 'manualExpanded' ? state.hoverDisplayId : null,
    pillSnapshot,
    sessions: displaySessions.map((session) => toSnapshot(session)),
    totalCount: displaySessions.length,
    measuredContentHeight: state.measuredContentHeight,
    ...createDefaultAgentIslandDisplayConfig(),
    updatedAt: now,
  };
}

/**
 * 侧栏活动广播专用:对**全部**已跟踪 session 生成 per-session 活动快照,不经灵动岛
 * 展示面(getDisplaySessionsForSurface)过滤。
 *
 * 为什么不用 buildAgentIslandDisplayState 的 displaySessions:展示面在岛显示
 * transient 完成/错误卡时只保留可堆叠的 transient 会话,会过滤掉其它运行中/等待中的
 * 会话;而 renderer 的 agentIslandActivity store 把每次 payload 当**整体替换**,用过滤
 * 后的子集会把这些会话从活动 map 里丢掉、卡片回退陈旧 summary,直到岛面切换
 * (PR #246 review)。侧栏卡片按 sessionId 各取所需,故这里取 state.sessions 全集。
 *
 * 仅做读取映射;session 的增删与过期裁剪由 buildAgentIslandDisplayState 负责,调用方
 * 应在其后调用本函数(此时 state.sessions 已裁剪)。过了岛面 TTL 的未读终态已迁到
 * remoteUnreadTerminals,这里把账本补进快照,远程侧栏才能继续看到绿/红点。
 */
export function buildAllSessionActivitySnapshots(
  state: AgentIslandState,
): AgentIslandSessionSnapshot[] {
  const snapshots = Array.from(state.sessions.values()).map((session) => toSnapshot(session));
  const seen = new Set(snapshots.map((snapshot) => snapshot.sessionId));
  for (const unread of state.remoteUnreadTerminals.values()) {
    if (seen.has(unread.sessionId)) continue;
    snapshots.push(toRemoteUnreadSnapshot(unread));
  }
  return snapshots;
}

export function getNextAgentIslandTimerAt(state: AgentIslandState, now: number): number | null {
  let next: number | null = null;
  for (const value of [
    state.hoverIntentAt,
    state.collapseAt,
    state.hoverCooldownUntil && isPointerInsideIsland(state) ? state.hoverCooldownUntil : null,
    pendingFocusNavigationExpiresAt(state),
    state.expandedProtectUntil && state.protectedDismissPending ? state.expandedProtectUntil : null,
  ]) {
    if (value && value > now && (next === null || value < next)) {
      next = value;
    }
  }
  for (const session of state.sessions.values()) {
    for (const value of [
      session.completedUntil,
      session.errorUntil,
      session.revealUntil,
      session.visibleInteractionSuppressedUntil,
      session.toolDetailUntil,
      session.messagePreview?.until,
      unreadIslandTtlAt(session),
    ]) {
      if (value && value > now && (next === null || value < next)) {
        next = value;
      }
    }
  }
  return next;
}

function updateHoverLifecycle(state: AgentIslandState, now: number): void {
  if (state.layoutDragActive) return;
  if (state.hoverIntentAt && state.hoverIntentAt <= now) {
    if ((!state.hoverCooldownUntil || state.hoverCooldownUntil <= now)
      && !isHoverExpansionSuppressedByReminder(state, now)) {
      state.hoverExpanded = state.isMouseInMenuBarZone || state.isMouseInExpandedPanel;
      state.collapseAt = null;
    }
    state.hoverIntentAt = null;
  }
  if (state.collapseAt && state.collapseAt <= now) {
    if (isExpandedProtected(state, now)) {
      state.collapseAt = state.expandedProtectUntil;
      state.protectedDismissPending = true;
    } else if (state.protectedDismissPending) {
      applyAgentIslandDismiss(state, now);
    } else {
      state.collapseAt = null;
      state.hoverExpanded = false;
      state.hoverDisplayId = null;
      state.protectedDismissPending = false;
    }
  }
}

function isHoverExpansionSuppressedByReminder(state: AgentIslandState, now: number): boolean {
  if (state.hoverExpanded) return false;
  if (hasBlockingSession(state, now)) return true;
  const activeTransient = getActiveTransientSession(state, now);
  return Boolean(activeTransient && !shouldSmartSuppressSession(state, activeTransient));
}

function updateExpandedProtection(
  state: AgentIslandState,
  mode: AgentIslandDisplayState['mode'],
  displayPolicy: AgentIslandDisplayPolicy,
  surface: AgentIslandDisplaySurface,
  sessionId: string | null,
  now: number,
): void {
  const expandedIdentityChanged = state.lastDisplayMode === 'expanded'
    && (
      state.lastDisplayPolicy !== displayPolicy
      || state.lastDisplaySurface !== surface
      || state.lastDisplaySessionId !== sessionId
    );
  if (mode === 'expanded' && (state.lastDisplayMode !== 'expanded' || expandedIdentityChanged)) {
    state.expandedProtectUntil = now + AGENT_ISLAND_EXPANDED_MIN_DWELL_MS;
    state.protectedDismissPending = false;
  }
  if (mode !== 'expanded' && state.lastDisplayMode === 'expanded') {
    state.expandedProtectUntil = null;
    state.protectedDismissPending = false;
  }
  state.lastDisplayMode = mode;
  state.lastDisplayPolicy = displayPolicy;
  state.lastDisplaySurface = surface;
  state.lastDisplaySessionId = sessionId;
}

function isExpandedProtected(state: AgentIslandState, now: number): boolean {
  return Boolean(state.expandedProtectUntil && state.expandedProtectUntil > now);
}

function updateToolDetailLifecycle(state: AgentIslandState, now: number): void {
  for (const session of state.sessions.values()) {
    if (session.currentToolUseId || !session.toolDetailUntil || session.toolDetailUntil > now) continue;
    session.toolDetailUntil = null;
    if (session.phase === 'running') {
      session.detail = '';
      session.detailSource = null;
    }
  }
}

function clearToolDetail(session: AgentIslandSessionState): void {
  if (session.detailSource !== 'tool') return;
  session.currentToolUseId = null;
  session.toolDetailUntil = null;
  session.detail = '';
  session.detailSource = null;
}

function updateMessagePreviewLifecycle(state: AgentIslandState, now: number): void {
  for (const session of state.sessions.values()) {
    while (session.messagePreview && session.messagePreview.until <= now) {
      const nextLine = session.messagePreviewQueue.shift();
      session.messagePreview = nextLine
        ? { line: nextLine, until: now + AGENT_ISLAND_MESSAGE_PREVIEW_MIN_DWELL_MS }
        : null;
    }
  }
}

function completionRevealDwellMs(session: AgentIslandSessionState, now: number): number {
  const remainingPreviewMs = session.messagePreview
    ? Math.max(0, session.messagePreview.until - now)
      + session.messagePreviewQueue.length * AGENT_ISLAND_MESSAGE_PREVIEW_MIN_DWELL_MS
    : 0;
  return Math.max(AGENT_ISLAND_COMPLETION_REVEAL_DWELL_MS, remainingPreviewMs + AGENT_ISLAND_REVEAL_DWELL_MS);
}

function pendingFocusNavigationExpiresAt(state: AgentIslandState): number | null {
  return state.pendingFocusUntil === null
    ? null
    : state.pendingFocusUntil - AGENT_ISLAND_FOCUS_VERIFY_TIMEOUT_MS + AGENT_ISLAND_FOCUS_NAVIGATION_TIMEOUT_MS;
}

function updateFocusVerificationLifecycle(state: AgentIslandState, now: number): void {
  const expiresAt = pendingFocusNavigationExpiresAt(state);
  if (expiresAt === null || expiresAt > now) return;
  // Allow slow renderer loading, but do not let an abandoned navigation turn a
  // much later ordinary visit into an acknowledgement of the old island click.
  state.pendingFocusSessionId = null;
  state.pendingFocusUntil = null;
}

function markSessionRunning(
  state: AgentIslandState,
  session: AgentIslandSessionState,
  now: number,
): void {
  if (!session.running) session.startedAt = now;
  session.running = true;
  session.completedUntil = null;
  session.errorUntil = null;
  session.completionAllowedAfterTerminalError = false;
  session.revealUntil = null;
  if (session.pendingInteractionIds.size === 0) {
    session.interactionRevealDismissed = false;
  }
  session.deferredReveal = false;
  session.deferredRevealReason = null;
  session.queuedRevealDwellMs = null;
  // Keep prior unread attention through a new running turn. The flag only
  // surfaces for completed/error sessions, and scheduler silence may arrive
  // after the running transition needs to snapshot that prior attention.
  removeQueuedTransientReveal(state, session.sessionId);
}

function completeAgentIslandSession(
  state: AgentIslandState,
  session: AgentIslandSessionState,
  now: number,
  options: { suppressAttention: boolean; preserveAttention: boolean },
): void {
  // Failed turns deliberately keep their trailing status Done + done so usage
  // and cost accounting can close. Those bookkeeping events must not replace
  // the user-visible terminal error. The caller snapshots whether this specific
  // terminal error belongs to a verified flow that intentionally pairs a done.
  if (session.phase === 'error' && !session.completionAllowedAfterTerminalError) return;

  session.phase = 'completed';
  session.interactionKind = undefined;
  session.interactionRevealDismissed = false;
  session.detail = '';
  session.detailSource = null;
  appendCompletionPlaceholderIfNeeded(session, state.strings);
  session.errorUntil = null;
  session.completionAllowedAfterTerminalError = false;

  if (options.suppressAttention) {
    session.completedUntil = null;
    session.revealUntil = null;
    session.deferredReveal = false;
    session.deferredRevealReason = null;
    session.queuedRevealDwellMs = null;
    session.unread = options.preserveAttention;
    syncRemoteUnreadTerminal(state, session);
    removeQueuedTransientReveal(state, session.sessionId);
    if (state.activeTransientSessionId === session.sessionId) {
      state.activeTransientSessionId = null;
    }
    return;
  }

  session.completedUntil = now + AGENT_ISLAND_COMPLETION_DWELL_MS;
  requestAttentionReveal(state, session, now, completionRevealDwellMs(session, now));
  syncRemoteUnreadTerminal(state, session);
}

function requestAttentionReveal(
  state: AgentIslandState,
  session: AgentIslandSessionState,
  now: number,
  dwellMs: number,
  options: { forceUnread?: boolean } = {},
): void {
  session.unread = options.forceUnread === true || !shouldSmartSuppressSession(state, session);
  session.queuedRevealDwellMs = dwellMs;
  if (session.phase === 'needs-interaction') {
    session.revealUntil = now + dwellMs;
    session.deferredReveal = false;
    session.deferredRevealReason = null;
    return;
  }
  if (shouldSmartSuppressSession(state, session)) {
    deferSessionReveal(state, session, 'visible-session');
    return;
  }
  enqueueTransientReveal(state, session, now, dwellMs);
}

function enqueueTransientReveal(
  state: AgentIslandState,
  session: AgentIslandSessionState,
  now: number,
  dwellMs: number,
): void {
  removeQueuedTransientReveal(state, session.sessionId);
  if (state.activeTransientSessionId === session.sessionId) {
    session.revealUntil = now + dwellMs;
    session.deferredReveal = false;
    session.deferredRevealReason = null;
    return;
  }

  const active = getActiveTransientSession(state, now);
  if (active) {
    state.transientRevealQueue.push(session.sessionId);
    session.revealUntil = null;
    session.deferredReveal = true;
    session.deferredRevealReason = 'queued';
    return;
  }

  state.activeTransientSessionId = session.sessionId;
  session.revealUntil = now + dwellMs;
  session.deferredReveal = false;
  session.deferredRevealReason = null;
}

function promoteNextTransientReveal(
  state: AgentIslandState,
  now: number,
  manualExpanded: boolean,
): void {
  const active = getActiveTransientSession(state, now);
  if (active) return;

  if (state.activeTransientSessionId) {
    const expired = state.sessions.get(state.activeTransientSessionId);
    if (expired) {
      expired.revealUntil = null;
      if (expired.deferredRevealReason !== 'queued') {
        expired.deferredReveal = false;
        expired.deferredRevealReason = null;
      }
    }
    state.activeTransientSessionId = null;
  }

  if (manualExpanded || hasBlockingSession(state, now) || hasDisplayableDismissedBlockingSession(state, now)) return;

  while (state.transientRevealQueue.length > 0) {
    const nextSessionId = state.transientRevealQueue.shift();
    if (!nextSessionId) continue;
    const next = state.sessions.get(nextSessionId);
    if (!next || !isSessionVisible(next, now)) continue;
    if (shouldSmartSuppressSession(state, next)) {
      deferSessionReveal(state, next, 'visible-session');
      continue;
    }
    state.activeTransientSessionId = next.sessionId;
    next.revealUntil = now + (next.queuedRevealDwellMs ?? AGENT_ISLAND_REVEAL_DWELL_MS);
    next.deferredReveal = false;
    next.deferredRevealReason = null;
    return;
  }
}

function getActiveTransientSession(state: AgentIslandState, now: number): AgentIslandSessionState | null {
  const activeSessionId = state.activeTransientSessionId;
  if (!activeSessionId) return null;
  const active = state.sessions.get(activeSessionId);
  if (!active?.revealUntil || active.revealUntil <= now) return null;
  return active;
}

function deferActiveTransientReveal(
  state: AgentIslandState,
  reason: AgentIslandSessionState['deferredRevealReason'],
): void {
  const activeSessionId = state.activeTransientSessionId;
  if (!activeSessionId) return;
  const active = state.sessions.get(activeSessionId);
  state.activeTransientSessionId = null;
  if (!active?.revealUntil) return;
  active.revealUntil = null;
  active.deferredReveal = active.unread;
  active.deferredRevealReason = active.unread ? reason : null;
  if (active.unread) {
    state.transientRevealQueue = [
      active.sessionId,
      ...state.transientRevealQueue.filter((sessionId) => sessionId !== active.sessionId),
    ];
  }
}

function dismissPublishedTransientReveal(state: AgentIslandState): boolean {
  if (state.lastDisplayMode !== 'expanded' || state.lastDisplayPolicy !== 'transient') return false;
  const transientSessionIds = [
    state.activeTransientSessionId,
    ...state.transientRevealQueue,
  ].filter((sessionId): sessionId is string => Boolean(sessionId));

  if (transientSessionIds.length === 0) return false;

  state.activeTransientSessionId = null;
  state.transientRevealQueue = [];

  let changed = false;
  for (const sessionId of transientSessionIds) {
    const session = state.sessions.get(sessionId);
    if (!session) continue;
    if (session.revealUntil !== null) {
      session.revealUntil = null;
      changed = true;
    }
    if (session.deferredReveal !== session.unread) {
      session.deferredReveal = session.unread;
      changed = true;
    }
    const nextReason = session.unread ? 'manual-dismiss' : null;
    if (session.deferredRevealReason !== nextReason) {
      session.deferredRevealReason = nextReason;
      changed = true;
    }
  }

  return changed || transientSessionIds.length > 0;
}

function hasActiveTransientReveal(state: AgentIslandState, now: number): boolean {
  return Boolean(getActiveTransientSession(state, now));
}

function dismissPublishedBlockingReveal(state: AgentIslandState, now: number): boolean {
  if (state.lastDisplaySurface !== 'interactionCard') return false;
  const session = getActiveBlockingReveal(state, now);
  if (!session) return false;
  if (state.lastDisplaySessionId !== session.sessionId) return false;
  let changed = false;
  if (!session.interactionRevealDismissed) {
    session.interactionRevealDismissed = true;
    changed = true;
  }
  if (session.revealUntil !== null) {
    session.revealUntil = null;
    changed = true;
  }
  return changed;
}

function hasActiveBlockingReveal(state: AgentIslandState, now: number): boolean {
  return getActiveBlockingReveal(state, now) !== null;
}

function getActiveBlockingReveal(state: AgentIslandState, now: number): AgentIslandSessionState | null {
  return Array.from(state.sessions.values())
    .filter((session) => isBlockingSession(session) && !isBlockingRevealSuppressed(state, session))
    .sort((a, b) => compareSessionsForDisplay(state, a, b, now))[0] ?? null;
}

function deferSessionReveal(
  state: AgentIslandState,
  session: AgentIslandSessionState,
  reason: AgentIslandSessionState['deferredRevealReason'],
): void {
  session.revealUntil = null;
  session.deferredReveal = session.unread;
  session.deferredRevealReason = session.unread ? reason : null;
  if (state.activeTransientSessionId === session.sessionId) {
    state.activeTransientSessionId = null;
  }
  removeQueuedTransientReveal(state, session.sessionId);
}

function suppressRevealForVisibleSession(state: AgentIslandState, now: number): void {
  for (const visibleSessionId of state.visibleSessionIds) {
    const session = state.sessions.get(visibleSessionId);
    if (!session?.revealUntil || session.revealUntil <= now) continue;
    deferSessionReveal(state, session, 'visible-session');
  }
}

function syncVisibleInteractionSuppression(state: AgentIslandState, now: number): void {
  for (const session of state.sessions.values()) {
    if (!isBlockingSession(session) || isPermissionApprovalSession(session)) {
      session.visibleInteractionSuppressedUntil = null;
      continue;
    }
    const visibleAndFocused = state.appFocused && state.visibleSessionIds.has(session.sessionId);
    if (!visibleAndFocused) {
      session.visibleInteractionSuppressedUntil = null;
      continue;
    }
    if (session.visibleInteractionSuppressedUntil === null) {
      session.visibleInteractionSuppressedUntil = now + AGENT_ISLAND_COMPLETION_DWELL_MS;
    }
  }
}

function removeQueuedTransientReveal(state: AgentIslandState, sessionId: string): void {
  if (state.activeTransientSessionId === sessionId) {
    state.activeTransientSessionId = null;
  }
  state.transientRevealQueue = state.transientRevealQueue.filter((queuedSessionId) => queuedSessionId !== sessionId);
}

function shouldSmartSuppressSession(state: AgentIslandState, session: AgentIslandSessionState): boolean {
  if (isPermissionApprovalSession(session)) return false;
  return state.appFocused && state.visibleSessionIds.has(session.sessionId);
}

function hasBlockingSession(state: AgentIslandState, now: number): boolean {
  for (const session of state.sessions.values()) {
    if (!isBlockingSession(session)) continue;
    if (isBlockingRevealInactive(state, session, now)) continue;
    return true;
  }
  return false;
}

function hasDisplayableDismissedBlockingSession(state: AgentIslandState, now: number): boolean {
  for (const session of state.sessions.values()) {
    if (
      isBlockingSession(session)
      && session.interactionRevealDismissed
      && shouldDisplaySession(state, session, now)
    ) {
      return true;
    }
  }
  return false;
}

function isBlockingRevealSuppressed(
  state: AgentIslandState,
  session: AgentIslandSessionState,
): boolean {
  return session.interactionRevealDismissed || shouldSmartSuppressSession(state, session);
}

function isBlockingRevealInactive(
  state: AgentIslandState,
  session: AgentIslandSessionState,
  now: number,
): boolean {
  return session.interactionRevealDismissed || isVisibleInteractionSuppressed(state, session, now);
}

function isPointerInsideIsland(state: AgentIslandState): boolean {
  return state.isMouseInMenuBarZone || state.isMouseInExpandedPanel;
}

function isCollapsePending(state: AgentIslandState, now: number): boolean {
  return Boolean(state.collapseAt && state.collapseAt > now);
}

function orderSessionsForCurrentSurface(
  state: AgentIslandState,
  sortedSessions: AgentIslandSessionState[],
  manualExpanded: boolean,
  now: number,
): AgentIslandSessionState[] {
  if (!manualExpanded) {
    state.expandedSessionOrder = null;
    return sortedSessions;
  }

  if (!state.expandedSessionOrder) {
    state.expandedSessionOrder = sortedSessions.map((session) => session.sessionId);
    return sortedSessions;
  }

  const rank = new Map(state.expandedSessionOrder.map((sessionId, index) => [sessionId, index]));
  const ordered = sortedSessions.slice().sort((a, b) => {
    const priorityDelta =
      islandDisplayPriorityRank(state, a, now) - islandDisplayPriorityRank(state, b, now);
    if (priorityDelta !== 0) return priorityDelta;
    const aRank = rank.get(a.sessionId);
    const bRank = rank.get(b.sessionId);
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
    if (aRank !== undefined) return -1;
    if (bRank !== undefined) return 1;
    return 0;
  });
  state.expandedSessionOrder = ordered.map((session) => session.sessionId);
  return ordered;
}

function orderSessionsForAutomaticTransientStack(
  sortedSessions: AgentIslandSessionState[],
  activeTransient: AgentIslandSessionState | null,
  manualExpanded: boolean,
): AgentIslandSessionState[] {
  if (manualExpanded || !activeTransient || sortedSessions.some(isBlockingSession)) return sortedSessions;
  return [
    activeTransient,
    ...sortedSessions.filter((session) => session.sessionId !== activeTransient.sessionId),
  ];
}

function buildDisplayDecision(
  state: AgentIslandState,
  orderedSessions: AgentIslandSessionState[],
  manualExpanded: boolean,
  now: number,
): AgentIslandDisplayDecision {
  const current = orderedSessions[0] ?? null;
  if (manualExpanded) {
    return {
      intent: { kind: 'manualExpand', sessionId: current?.sessionId ?? null },
      surface: { kind: 'manualExpanded', current },
      mode: 'expanded',
      displayPolicy: 'manualExpanded',
      smartSuppressed: Boolean(current?.deferredReveal),
      manualExpanded: true,
      autoReveal: false,
    };
  }

  if (!current) {
    return {
      intent: { kind: 'closed' },
      surface: { kind: 'closed', current: null },
      mode: 'compact',
      displayPolicy: 'closed',
      smartSuppressed: false,
      manualExpanded: false,
      autoReveal: false,
    };
  }

  const blocking = orderedSessions.find(isBlockingSession) ?? null;
  const blockingSmartSuppressed = blocking ? isBlockingRevealSuppressed(state, blocking) : false;
  if (blocking && !blockingSmartSuppressed) {
    return {
      intent: { kind: 'blocking', sessionId: blocking.sessionId },
      surface: { kind: 'blocking', current: blocking },
      mode: 'expanded',
      displayPolicy: 'blocking',
      smartSuppressed: false,
      manualExpanded: false,
      autoReveal: Boolean(blocking.revealUntil && blocking.revealUntil > now),
    };
  }

  const activeTransient = getActiveTransientSession(state, now);
  if (activeTransient && !shouldSmartSuppressSession(state, activeTransient)) {
    return {
      intent: { kind: 'transient', sessionId: activeTransient.sessionId },
      surface: { kind: 'transient', current: activeTransient },
      mode: 'expanded',
      displayPolicy: 'transient',
      smartSuppressed: false,
      manualExpanded: false,
      autoReveal: true,
    };
  }

  const compactCurrent = current;
  const stableCompactCurrent = selectStableCompactCurrent(state, orderedSessions, compactCurrent, now);
  const compactSmartSuppressed = Boolean(stableCompactCurrent.deferredReveal)
    || (isBlockingSession(stableCompactCurrent) && isBlockingRevealSuppressed(state, stableCompactCurrent));
  return {
    intent: stableCompactCurrent.deferredReveal
      ? { kind: 'deferredReveal', sessionId: stableCompactCurrent.sessionId }
      : { kind: 'peek', sessionId: stableCompactCurrent.sessionId },
    surface: { kind: 'peek', current: stableCompactCurrent },
    mode: 'compact',
    displayPolicy: getCompactDisplayPolicy(stableCompactCurrent),
    smartSuppressed: compactSmartSuppressed,
    manualExpanded: false,
    autoReveal: false,
  };
}

function selectStableCompactCurrent(
  state: AgentIslandState,
  orderedSessions: AgentIslandSessionState[],
  candidate: AgentIslandSessionState,
  now: number,
): AgentIslandSessionState {
  const previous = state.compactCurrentSessionId
    ? orderedSessions.find((session) => session.sessionId === state.compactCurrentSessionId) ?? null
    : null;

  if (
    previous?.running
    && candidate.running
    && previous.sessionId !== candidate.sessionId
    && state.compactCurrentUntil
    && state.compactCurrentUntil > now
  ) {
    return previous;
  }

  state.compactCurrentSessionId = candidate.sessionId;
  state.compactCurrentUntil = candidate.running
    ? now + AGENT_ISLAND_COMPACT_CURRENT_MIN_DWELL_MS
    : null;
  return candidate;
}

function orderSessionsForDecisionSurface(
  decision: AgentIslandDisplayDecision,
  orderedSessions: AgentIslandSessionState[],
): AgentIslandSessionState[] {
  if (decision.surface.kind !== 'peek') return orderedSessions;
  const currentId = decision.surface.current.sessionId;
  if (orderedSessions[0]?.sessionId === currentId) return orderedSessions;
  const current = orderedSessions.find((session) => session.sessionId === currentId);
  if (!current) return orderedSessions;
  return [
    current,
    ...orderedSessions.filter((session) => session.sessionId !== currentId),
  ];
}

function getDisplaySurface(
  decision: AgentIslandDisplayDecision,
  displaySessions: AgentIslandSessionState[],
  now: number,
): AgentIslandDisplaySurface {
  if (decision.mode !== 'expanded') return 'collapsed';
  switch (decision.surface.kind) {
    case 'manualExpanded':
      return 'sessionList';
    case 'blocking':
      return 'interactionCard';
    case 'transient':
      if (countStackedTransientSessions(displaySessions, now) > 1) {
        return 'sessionList';
      }
      return 'completionCard';
    default:
      return 'collapsed';
  }
}

function getDisplaySessionsForSurface(
  decision: AgentIslandDisplayDecision,
  orderedSessions: AgentIslandSessionState[],
  now: number,
): AgentIslandSessionState[] {
  if (decision.surface.kind !== 'transient') return orderedSessions;
  const transientSessions = orderedSessions.filter((session) => isStackableTransientSession(session, now));
  return transientSessions.length > 0 ? transientSessions : orderedSessions;
}

function countStackedTransientSessions(sessions: AgentIslandSessionState[], now: number): number {
  let count = 0;
  for (const session of sessions) {
    if (isStackableTransientSession(session, now)) count += 1;
  }
  return count;
}

function isStackableTransientSession(session: AgentIslandSessionState, now: number): boolean {
  if (session.phase !== 'completed' && session.phase !== 'error') return false;
  return session.unread
    || Boolean(session.revealUntil && session.revealUntil > now)
    || Boolean(session.completedUntil && session.completedUntil > now)
    || Boolean(session.errorUntil && session.errorUntil > now);
}

function isCompactActiveSession(session: AgentIslandSessionState): boolean {
  return session.phase === 'running' || session.phase === 'needs-interaction' || session.pendingInteractionIds.size > 0;
}

function isBlockingSession(session: AgentIslandSessionState): boolean {
  return session.phase === 'needs-interaction' || session.pendingInteractionIds.size > 0;
}

function applyVerifiedFocusIfMatched(
  state: AgentIslandState,
  now: number,
): boolean {
  // A route report can arrive before the expiry timer gets a chance to run.
  updateFocusVerificationLifecycle(state, now);
  const focusedSessionId = state.pendingFocusSessionId;
  if (!focusedSessionId || !state.visibleSessionIds.has(focusedSessionId)) return false;
  state.pendingFocusSessionId = null;
  state.pendingFocusUntil = null;
  const dismissed = dismissFocusedSessionReveal(state, focusedSessionId, now);
  const collapsed = collapseAgentIslandToCompact(state, now);
  return dismissed || collapsed;
}

function dismissFocusedSessionReveal(
  state: AgentIslandState,
  sessionId: string,
  now: number,
): boolean {
  if (state.lastDisplaySessionId !== sessionId) return false;
  let changed = false;
  if (state.lastDisplayPolicy === 'transient') {
    changed = dismissPublishedTransientReveal(state) || changed;
  }
  if (state.lastDisplaySurface === 'interactionCard') {
    changed = dismissPublishedBlockingReveal(state, now) || changed;
  }
  return changed;
}

function normalizeVisibleSessionIds(sessionId: string | readonly string[] | null): string[] {
  const rawSessionIds = Array.isArray(sessionId) ? sessionId : [sessionId];
  const normalized: string[] = [];
  for (const raw of rawSessionIds) {
    const next = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    if (next && !normalized.includes(next)) {
      normalized.push(next);
    }
  }
  return normalized;
}

function collapseAgentIslandToCompact(state: AgentIslandState, now: number): boolean {
  const changed = state.hoverExpanded
    || state.isMouseInMenuBarZone
    || state.isMouseInExpandedPanel
    || state.hoverDisplayId !== null
    || state.hoverIntentAt !== null
    || state.collapseAt !== null;
  state.isMouseInMenuBarZone = false;
  state.isMouseInExpandedPanel = false;
  state.hoverDisplayId = null;
  state.hoverIntentAt = null;
  state.hoverExpanded = false;
  state.collapseAt = null;
  state.hoverCooldownUntil = now + AGENT_ISLAND_HOVER_SHORT_COOLDOWN_MS;
  return changed;
}

function getNotchStatus(
  current: AgentIslandSessionState | null,
  mode: AgentIslandDisplayState['mode'],
): AgentIslandNotchStatus {
  if (mode === 'expanded') return 'expanded';
  return current ? 'peek' : 'closed';
}

function getCompactDisplayPolicy(current: AgentIslandSessionState): AgentIslandDisplayPolicy {
  if (current.phase === 'needs-interaction') return 'blocking';
  if (current.phase === 'completed' || current.phase === 'error') return 'transient';
  return 'peek';
}

function getLayoutMode(notchStatus: AgentIslandNotchStatus): AgentIslandLayoutMode {
  return notchStatus === 'expanded' ? 'normal' : 'compact';
}

function shouldShowShadow(
  current: AgentIslandSessionState | null,
  manualExpanded: boolean,
  pointerInside: boolean,
): boolean {
  return manualExpanded
    || pointerInside
    || Boolean(current && (current.pendingInteractionIds.size > 0 || current.phase === 'needs-interaction'));
}

function buildPillSnapshot(
  sessions: AgentIslandSessionState[],
  current: AgentIslandSessionState | null,
): AgentIslandPillSnapshot {
  let activeSessionCount = 0;
  let pendingInteractionCount = 0;
  let unreadCompletedCount = 0;
  let deferredRevealCount = 0;
  let attentionCount = 0;
  for (const session of sessions) {
    if (isCompactActiveSession(session)) activeSessionCount += 1;
    if (session.pendingInteractionIds.size > 0) pendingInteractionCount += 1;
    if (session.unread && (session.phase === 'completed' || session.phase === 'error')) {
      unreadCompletedCount += 1;
    }
    if (session.deferredReveal) deferredRevealCount += 1;
    if (isAttentionSession(session)) attentionCount += 1;
  }
  return {
    priorityId: current?.sessionId ?? null,
    priorityStatus: current?.phase ?? 'idle',
    priorityMicroTitle: current ? pillTitle(current, 'micro') : '',
    priorityCompactTitle: current ? pillTitle(current, 'compact') : '',
    sessionCount: sessions.length,
    activeSessionCount,
    pendingInteractionCount,
    unreadCompletedCount,
    deferredRevealCount,
    attentionCount,
  };
}

function pillTitle(session: AgentIslandSessionState, mode: 'micro' | 'compact'): string {
  const title = meaningfulSessionTitle(session)
    || session.projectName
    || latestUserActivityTitle(session)
    || session.sessionId.slice(0, 8);
  return truncateInlineText(title, mode === 'micro' ? 18 : AGENT_ISLAND_COMPACT_TITLE_MAX_LENGTH);
}

function compactDetailForSession(session: AgentIslandSessionState): string {
  if (session.phase === 'running' && session.reconnectStatus) {
    return truncateInlineText(session.reconnectStatus, AGENT_ISLAND_COMPACT_DETAIL_MAX_LENGTH);
  }
  const messagePreview = messagePreviewTextForSession(session);
  if (messagePreview) return truncateInlineText(messagePreview, AGENT_ISLAND_COMPACT_DETAIL_MAX_LENGTH);

  const detail = normalizeInlineText(session.detail);
  if (detail && !isGenericRunningStatusDetail(detail)) {
    return truncateInlineText(detail, AGENT_ISLAND_COMPACT_DETAIL_MAX_LENGTH);
  }

  const activity = session.activityLines
    .slice()
    .reverse()
    .find((line) => line.kind === 'assistant' || line.kind === 'status' || line.kind === 'tool');
  if (activity) return truncateInlineText(activity.text, AGENT_ISLAND_COMPACT_DETAIL_MAX_LENGTH);

  const userActivity = session.activityLines
    .slice()
    .reverse()
    .find((line) => line.kind === 'user');
  if (userActivity) return truncateInlineText(userActivity.text, AGENT_ISLAND_COMPACT_DETAIL_MAX_LENGTH);

  return detail ? truncateInlineText(detail, AGENT_ISLAND_COMPACT_DETAIL_MAX_LENGTH) : '';
}

function messagePreviewTextForSession(session: AgentIslandSessionState): string | null {
  if (session.phase === 'needs-interaction' || session.phase === 'error') return null;
  const line = session.messagePreview?.line;
  if (!line || (line.kind !== 'user' && line.kind !== 'assistant')) return null;
  const text = normalizeActivityText(line.text);
  return text || null;
}

function isGenericRunningStatusDetail(detail: string): boolean {
  const normalized = normalizeInlineText(detail)
    .toLowerCase()
    .replace(/\.+$/g, '')
    .trim();
  return normalized === 'generating'
    || normalized === 'thinking'
    || normalized === 'running'
    || normalized === 'still running';
}

function meaningfulSessionTitle(session: AgentIslandSessionState): string | null {
  const title = normalizeInlineText(session.title ?? '');
  if (!title) return null;
  const normalized = title.toLowerCase();
  if (normalized === 'new maker' || normalized === 'untitled') return null;
  if (normalized === 'codex' || normalized === 'claude' || normalized === 'claude code' || normalized === 'agent') {
    return null;
  }
  return title;
}

function latestUserActivityTitle(session: AgentIslandSessionState): string | null {
  const latestUserLine = session.activityLines
    .slice()
    .reverse()
    .find((line) => line.kind === 'user');
  if (!latestUserLine) return null;
  const text = normalizeActivityText(latestUserLine.text);
  if (!text) return null;
  return text.slice(0, 72);
}

function getOrCreateSession(
  state: AgentIslandState,
  meta: AgentIslandSessionMeta,
  now: number,
): AgentIslandSessionState {
  let session = state.sessions.get(meta.sessionId);
  if (session) return session;
  session = {
    sessionId: meta.sessionId,
    title: meta.title?.trim() || null,
    projectName: projectNameFromWorkingDir(meta.workingDir, meta.workspaceKind),
    detail: '',
    detailSource: null,
    reconnectStatus: null,
    currentToolUseId: null,
    toolDetailUntil: null,
    phase: 'running',
    agentKind: meta.agentKind ?? 'agent',
    pendingInteractionIds: new Set(),
    pendingInteractionKinds: new Map(),
    pendingInteractionDetails: new Map(),
    pendingPermissionCanAllowForSession: new Map(),
    permissionRequestId: null,
    permissionCanAllowForSession: false,
    running: false,
    completedUntil: null,
    errorUntil: null,
    completionAllowedAfterTerminalError: false,
    revealUntil: null,
    visibleInteractionSuppressedUntil: null,
    interactionRevealDismissed: false,
    deferredReveal: false,
    deferredRevealReason: null,
    queuedRevealDwellMs: null,
    unread: false,
    activityLines: [],
    activitySeq: 0,
    assistantStreamLineId: null,
    assistantStream: createActivityTextStreamState(),
    messagePreview: null,
    messagePreviewQueue: [],
    startedAt: now,
    sortActivityAt: now,
    lastActivityAt: now,
  };
  state.sessions.set(meta.sessionId, session);
  return session;
}

function cloneSession(session: AgentIslandSessionState): AgentIslandSessionState {
  return {
    ...session,
    pendingInteractionIds: new Set(session.pendingInteractionIds),
    pendingInteractionKinds: new Map(session.pendingInteractionKinds),
    pendingInteractionDetails: new Map(session.pendingInteractionDetails),
    pendingPermissionCanAllowForSession: new Map(session.pendingPermissionCanAllowForSession),
    activityLines: session.activityLines.map((line) => ({ ...line })),
    assistantStream: cloneActivityTextStreamState(session.assistantStream),
    messagePreview: session.messagePreview
      ? {
          line: { ...session.messagePreview.line },
          until: session.messagePreview.until,
        }
      : null,
    messagePreviewQueue: session.messagePreviewQueue.map((line) => ({ ...line })),
  };
}

function clearPendingInteractionMetadata(session: AgentIslandSessionState): void {
  session.pendingInteractionKinds.clear();
  session.pendingInteractionDetails.clear();
  session.pendingPermissionCanAllowForSession.clear();
}

function restorePendingPermissionAction(session: AgentIslandSessionState): void {
  let requestId: string | null = null;
  for (const [pendingRequestId, kind] of session.pendingInteractionKinds.entries()) {
    if (kind === 'permission') {
      requestId = pendingRequestId;
      break;
    }
  }
  session.permissionRequestId = requestId;
  session.permissionCanAllowForSession = requestId
    ? session.pendingPermissionCanAllowForSession.get(requestId) === true
    : false;
  if (requestId) {
    session.detail = session.pendingInteractionDetails.get(requestId) ?? session.detail;
    session.detailSource = 'interaction';
  }
}

function restorePendingInteractionKind(session: AgentIslandSessionState): void {
  if (session.permissionRequestId !== null) {
    session.interactionKind = 'permission';
    return;
  }
  let kind: AgentIslandInteractionKind | undefined;
  for (const pendingKind of session.pendingInteractionKinds.values()) {
    kind = pendingKind;
  }
  session.interactionKind = kind;
}

function applyMeta(session: AgentIslandSessionState, meta: AgentIslandSessionMeta): void {
  if (meta.agentKind) session.agentKind = meta.agentKind;
  const title = meta.title?.trim();
  if (title) session.title = title;
  if (meta.workingDir !== undefined || meta.workspaceKind !== undefined) {
    session.projectName = projectNameFromWorkingDir(meta.workingDir, meta.workspaceKind);
  }
}

function toSnapshot(session: AgentIslandSessionState): AgentIslandSessionSnapshot {
  const reconnectStatus = session.phase === 'running' ? session.reconnectStatus : null;
  return {
    sessionId: session.sessionId,
    title: session.title || session.projectName || session.sessionId.slice(0, 8),
    projectName: session.projectName,
    detail: reconnectStatus ?? session.detail,
    compactDetail: compactDetailForSession(session),
    messagePreview: session.messagePreview?.line ?? null,
    phase: session.phase,
    agentKind: session.agentKind,
    interactionKind: session.interactionKind,
    permissionAction: session.permissionRequestId
      ? {
          requestId: session.permissionRequestId,
          canAllowForSession: session.permissionCanAllowForSession,
        }
      : null,
    attention: isAttentionSession(session),
    activityLines: session.activityLines,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
  };
}

function isAttentionSession(session: AgentIslandSessionState): boolean {
  if (session.pendingInteractionIds.size > 0 || session.phase === 'needs-interaction') return true;
  return session.unread && (session.phase === 'completed' || session.phase === 'error');
}

function isIslandRelevantEvent(event: AgentEvent): boolean {
  return event.type === 'status'
    || event.type === 'text'
    || event.type === 'tool_use'
    || event.type === 'tool_result'
    || event.type === 'done'
    || event.type === 'error';
}

function shouldDisplaySession(
  state: AgentIslandState,
  session: AgentIslandSessionState,
  now: number,
  preserveExpiredTransient = false,
): boolean {
  return isSessionVisible(session, now, preserveExpiredTransient)
    && !isVisibleInteractionSuppressed(state, session, now);
}

function isUnreadTerminalLedger(
  session: AgentIslandSessionState,
): session is AgentIslandSessionState & { phase: 'completed' | 'error' } {
  return session.unread && (session.phase === 'completed' || session.phase === 'error');
}

function syncRemoteUnreadTerminal(state: AgentIslandState, session: AgentIslandSessionState): void {
  if (isUnreadTerminalLedger(session)) {
    state.remoteUnreadTerminals.set(session.sessionId, {
      sessionId: session.sessionId,
      phase: session.phase,
      lastActivityAt: session.lastActivityAt,
    });
    return;
  }
  // 新一轮 running / 等待交互不是已读。App badge 镜像会给 live session 打 unread,
  // 但不能据此把还没被看到的旧 completed/error 账本清掉。真正变成新的终态时,
  // 再按当前 unread 覆盖或清除。
  if (session.running || session.phase === 'needs-interaction' || session.pendingInteractionIds.size > 0) {
    return;
  }
  clearRemoteUnreadTerminal(state, session.sessionId);
}

function clearRemoteUnreadTerminal(state: AgentIslandState, sessionId: string): void {
  state.remoteUnreadTerminals.delete(sessionId);
}

function unreadIslandTtlAt(session: AgentIslandSessionState): number | null {
  if (!isUnreadTerminalLedger(session)) return null;
  return session.lastActivityAt + AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS;
}

function toRemoteUnreadSnapshot(unread: AgentIslandRemoteUnreadTerminal): AgentIslandSessionSnapshot {
  return {
    sessionId: unread.sessionId,
    title: unread.sessionId.slice(0, 8),
    projectName: null,
    detail: '',
    compactDetail: '',
    messagePreview: null,
    phase: unread.phase,
    agentKind: 'claude-code',
    interactionKind: undefined,
    permissionAction: null,
    attention: true,
    activityLines: [],
    startedAt: unread.lastActivityAt,
    lastActivityAt: unread.lastActivityAt,
  };
}

function isUnreadTerminalWithinIslandTtl(session: AgentIslandSessionState, now: number): boolean {
  return isUnreadTerminalLedger(session)
    && now - session.lastActivityAt < AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS;
}

function isSessionVisible(session: AgentIslandSessionState, now: number, preserveExpiredTransient = false): boolean {
  if (session.pendingInteractionIds.size > 0) return true;
  if (session.running) return true;
  // 岛面只在 TTL 内展示未读终态;过了 TTL prune 会把岛 state 删掉,未读迁到
  // remoteUnreadTerminals 给远程侧栏 / 已读回执。
  if (isUnreadTerminalWithinIslandTtl(session, now)) return true;
  if (session.completedUntil && session.completedUntil > now) return true;
  if (session.errorUntil && session.errorUntil > now) return true;
  // 不复活已过 TTL 的 unread 条目：preserveExpiredTransient 仅用于短 dwell 窗口内到期的
  // 非 unread 项（用户悬停时平滑体验），不应让 4h 前就应清理的陈旧 unread 重新出现。
  if (
    preserveExpiredTransient &&
    (session.phase === 'completed' || session.phase === 'error') &&
    !isUnreadTerminalLedger(session)
  )
    return true;
  return false;
}

function isVisibleInteractionSuppressed(
  state: AgentIslandState,
  session: AgentIslandSessionState,
  now: number,
): boolean {
  return isBlockingSession(session)
    && !isPermissionApprovalSession(session)
    && state.appFocused
    && state.visibleSessionIds.has(session.sessionId)
    && session.visibleInteractionSuppressedUntil !== null
    && session.visibleInteractionSuppressedUntil <= now;
}

function isPermissionApprovalSession(session: AgentIslandSessionState): boolean {
  return session.interactionKind === 'permission' && session.permissionRequestId !== null;
}

function compareSessionsForDisplay(
  state: AgentIslandState,
  a: AgentIslandSessionState,
  b: AgentIslandSessionState,
  now: number,
): number {
  const rankDelta = islandDisplayPriorityRank(state, a, now) - islandDisplayPriorityRank(state, b, now);
  if (rankDelta !== 0) return rankDelta;
  const activityDelta = b.sortActivityAt - a.sortActivityAt;
  if (activityDelta !== 0) return activityDelta;
  return b.startedAt - a.startedAt;
}

function isWaitingSession(session: AgentIslandSessionState, now: number): boolean {
  return (
    session.pendingInteractionIds.size > 0
    || session.phase === 'needs-interaction'
    || (session.phase === 'error' && (isUnreadTerminalWithinIslandTtl(session, now) || (session.errorUntil !== null && session.errorUntil > now)))
  );
}

function isUnreadCompletedSession(session: AgentIslandSessionState, now: number): boolean {
  return session.phase === 'completed' && (isUnreadTerminalWithinIslandTtl(session, now) || (session.completedUntil !== null && session.completedUntil > now));
}

function isTransientlyPinnedSession(
  state: AgentIslandState,
  session: AgentIslandSessionState,
  now: number,
): boolean {
  return (
    state.activeTransientSessionId === session.sessionId
    && session.revealUntil !== null
    && session.revealUntil > now
  );
}

/**
 * 岛上展示序 = 与侧栏共用的活任务档位,再叠一层「刚完成短暂置顶」。
 * 数字越小越靠前。短暂置顶只压过完成未读 / 运行中,压不过等你处理(含出错)。
 */
function islandDisplayPriorityRank(
  state: AgentIslandState,
  session: AgentIslandSessionState,
  now: number,
): number {
  const live = liveTaskPriorityRank({
    waiting: isWaitingSession(session, now),
    unread: isUnreadCompletedSession(session, now),
    running: session.running,
  });
  if (isTransientlyPinnedSession(state, session, now) && live > LIVE_TASK_PRIORITY.waiting) {
    return LIVE_TASK_PRIORITY.waiting + 0.5;
  }
  return live;
}

function detailForInteraction(
  request: AgentIslandInteractionRequest,
  wording: ToolRowWording,
): string {
  if (request.kind === 'plugin_setup') return request.detail;
  if (request.kind === 'permission') {
    // 权限确认:requireCommandVisible 保证用户批准的真实命令始终可见。
    return formatIslandToolDetail(request.toolName, request.input, { wording, requireCommandVisible: true }, {
      description: request.description,
      displayName: request.displayName,
    }) || request.displayName || request.toolName || '';
  }
  if (request.kind === 'plan_review') return '';
  return request.questions[0]?.header || request.questions[0]?.question || '';
}

function toolUseIdsFromEvent(event: AgentEvent): string[] {
  const data = asRecord(event.data);
  if (!data) return [];
  const toolUseIds = data.toolUseIds;
  if (Array.isArray(toolUseIds)) {
    return toolUseIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  }
  if (typeof data.toolUseId === 'string' && data.toolUseId.length > 0) return [data.toolUseId];
  return typeof data.id === 'string' && data.id.length > 0 ? [data.id] : [];
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function lastPathSegment(value: string): string {
  const trimmed = stripTrailingPathSeparators(value.trim());
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

function appendActivityLine(
  session: AgentIslandSessionState,
  kind: AgentIslandActivityLineKind,
  rawText: string,
): AgentIslandActivityLine | null {
  const text = normalizeActivityText(rawText);
  if (!text) return null;
  const previous = session.activityLines.at(-1);
  if (previous && previous.kind === kind && kind !== 'user' && kind !== 'assistant') {
    const line = { ...previous, text };
    session.activityLines = [
      ...session.activityLines.slice(0, -1),
      line,
    ];
    return line;
  }
  session.activitySeq += 1;
  const line = { id: String(session.activitySeq), kind, text };
  session.activityLines = [
    ...session.activityLines,
    line,
  ].slice(-AGENT_ISLAND_ACTIVITY_MAX_LINES);
  return line;
}

function applyAssistantTextLine(
  session: AgentIslandSessionState,
  rawText: string,
  isFinal: boolean,
): AgentIslandActivityLine | null {
  const text = isFinal
    ? normalizeActivityText(rawText)
    : appendActivityTextStream(session.assistantStream, rawText);
  if (!text) {
    if (isFinal) {
      clearAssistantStream(session);
    }
    return null;
  }

  const existingLineId = session.assistantStreamLineId;
  if (existingLineId) {
    const existingIndex = session.activityLines.findIndex((line) => line.id === existingLineId);
    if (existingIndex >= 0) {
      const line = { ...session.activityLines[existingIndex], text };
      session.activityLines = [
        ...session.activityLines.slice(0, existingIndex),
        line,
        ...session.activityLines.slice(existingIndex + 1),
      ];
      replaceMessagePreviewLine(session, line);
      if (isFinal) {
        clearAssistantStream(session);
      }
      return line;
    }
  }

  const line = appendActivityLine(session, 'assistant', text);
  if (!line) return null;
  if (isFinal) {
    clearAssistantStream(session);
  } else {
    session.assistantStreamLineId = line.id;
  }
  return line;
}

function replaceMessagePreviewLine(session: AgentIslandSessionState, line: AgentIslandActivityLine): void {
  if (session.messagePreview?.line.id === line.id) {
    session.messagePreview = { ...session.messagePreview, line };
  }
  session.messagePreviewQueue = session.messagePreviewQueue.map((queued) =>
    queued.id === line.id ? line : queued
  );
}

function clearAssistantStream(session: AgentIslandSessionState): void {
  session.assistantStreamLineId = null;
  session.assistantStream = createActivityTextStreamState();
}

function enqueueMessagePreview(
  session: AgentIslandSessionState,
  line: AgentIslandActivityLine,
  now: number,
): void {
  if (line.kind !== 'user' && line.kind !== 'assistant') return;
  if (!session.messagePreview || session.messagePreview.until <= now) {
    session.messagePreview = { line, until: now + AGENT_ISLAND_MESSAGE_PREVIEW_MIN_DWELL_MS };
    return;
  }
  session.messagePreviewQueue.push(line);
}

function appendCompletionPlaceholderIfNeeded(session: AgentIslandSessionState, strings: AgentIslandStrings): void {
  const last = session.activityLines.at(-1);
  if (!last || last.kind === 'user' || last.kind === 'tool') {
    appendActivityLine(session, 'status', strings.done);
  }
}

function assistantTextFromEvent(event: AgentEvent): string | null {
  const data = asRecord(event.data);
  return typeof data?.text === 'string' ? data.text : null;
}

function normalizeInlineText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ');
}

function formatReconnectStatus(template: string, attempt: number, maxAttempts: number): string {
  return template
    .replaceAll('{{attempt}}', String(attempt))
    .replaceAll('{{maxAttempts}}', String(maxAttempts));
}

function truncateInlineText(text: string, maxLength: number): string {
  const normalized = normalizeInlineText(text);
  const chars = Array.from(normalized);
  if (chars.length <= maxLength) return normalized;
  return `${chars.slice(0, Math.max(0, maxLength - 3)).join('')}...`;
}

function projectNameFromWorkingDir(workingDir: string | null | undefined, workspaceKind?: string | null): string | null {
  if (workspaceKind === 'dialogue') return null;
  const trimmed = workingDir?.trim();
  if (!trimmed) return null;
  const normalized = stripTrailingPathSeparators(trimmed);
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  const name = parts.at(-1) ?? normalized;
  if (looksLikeManagedDialogueDir(name)) return null;
  return name;
}

function looksLikeManagedDialogueDir(name: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)
    || /^[a-z0-9]{24,}$/i.test(name);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function hasSessionScopedPermissionSuggestion(suggestions?: readonly unknown[]): boolean {
  if (!Array.isArray(suggestions)) return false;
  return suggestions.some((suggestion) =>
    !!suggestion
    && typeof suggestion === 'object'
    && !Array.isArray(suggestion)
    && (suggestion as Record<string, unknown>).destination === 'session'
  );
}
