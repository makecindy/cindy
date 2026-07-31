/**
 * useCCAgentChat — thin subscription layer over `makerChatStore`.
 * ---------------------------------------------------------------------------
 * All CC Agent chat state now lives in `makerChatStore`, keyed by sessionId.
 * This hook is a view — it subscribes to the slice for the current sessionId
 * via `useSyncExternalStore`, ensures the initial history is fetched, and
 * forwards imperative actions (`sendMessage`, `stopSession`, etc.) to the
 * store.
 *
 * CRITICAL: this hook no longer calls `stopCCAgentSession` on cleanup /
 * session switch. That call was the root cause of the session-isolation
 * bug: switching away from an in-flight session killed its SDK query.
 *
 * F-CHAT-1, F-CHAT-2, F-CHAT-3, F-SDK-3, F-SYNC-1, F-SYNC-2 are all preserved
 * inside the store.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';

import {
  makerChatStore,
  EMPTY_SESSION_STATE,
  EMPTY_TASK_UPDATES,
  type AgentStatus,
  type AgentSwitchIntentRecord,
  type AgentTaskUpdate,
  type AskUserDraft,
  type AskUserViewerState,
  type ChatMessage,
  type PendingPermission,
  type PendingAskUser,
  type PendingPluginSetup,
  type PluginSetupCommandInFlight,
  type PluginSetupInlineFormValues,
  type PluginSetupViewerState,
  type PendingIssueConfirm,
  type PendingRenameSessionsConfirm,
  type PendingGhostGrantConfirm,
  type PendingPlanReview,
  type PlanViewerState,
  type QueuedMessage,
  type SessionChatLightState,
  type SessionChatState,
} from '@/lib/makerChatStore';
import type { ChatDisplaySnapshot } from '@/components/chat/ChatDisplaySnapshotContext';
import type { AttachedFile, MentionedResource } from '@/lib/fileTypes';
import type { PastedTextRange, SlashCommandRange } from '@/lib/imageRef';
import type { AgentInputReference } from '@cindy/maker-shared/agent-input-projection';
import { createLogger } from '@/lib/logger';
import type { UsageLimitRecoveryHint } from '@/lib/usageLimitRecovery';

const log = createLogger('UseCCAgentChat');

export type {
  AgentStatus,
  AgentTaskUpdate,
  AskUserDraft,
  AskUserViewerState,
  ChatMessage,
  PendingPermission,
  PendingAskUser,
  PendingPlanReview,
  PendingRenameSessionsConfirm,
  PendingGhostGrantConfirm,
  PlanViewerState,
  QueuedMessage,
};

interface UseCCAgentChatReturn {
  /** 仅用于乐观展示的下一次发送切换目标。 */
  agentSwitchIntent: AgentSwitchIntentRecord | null;
  messages: ChatMessage[];
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate>;
  agentStatus: AgentStatus;
  isStreaming: boolean;
  /**
   * F-QUEUE-1: "agent 忙"的派生判据。未暂停的队列会继续自动 drain,所以也算忙,
   * 用来避免 done → drain 下一条 dispatch 的间隙里 Stop 按钮闪烁。Stop 暂停
   * 队列后不能继续算忙,否则当前任务已经停止,按钮却会卡在 Stop 状态。
   */
  isAgentBusy: boolean;
  /** F-QUEUE-1: 当前排队未派发的消息数（含正在 streaming 的那条不计入）。 */
  pendingQueueLength: number;
  /** F-QUEUE-DEFER: 队列里"还没进消息流"的全部消息(头→尾,head=最先派发)。 */
  pendingQueue: QueuedMessage[];
  /** 正在尝试插话投递的队列项 clientId。 */
  steeringQueueClientIds: string[];
  /** Queue was paused by Stop and resumes only after the user clicks Continue. */
  queuePaused: boolean;
  /** F-QUEUE-DEFER: 队列面板是否显示三条以后的尾部，仅影响展示。 */
  queueExpanded: boolean;
  /** F-QUEUE-DEFER: 切换队列面板的展开 / 折叠态，仅影响展示。 */
  setQueueExpanded: (expanded: boolean) => void;
  /** Resume a queue paused by Stop. */
  resumeQueue: () => void;
  /** Reorder a queued row by moving it to the requested insertion index. */
  moveQueueItem: (clientId: string, targetIndex: number) => void;
  /** Protect the whole queue from auto-drain while row order is being changed. */
  setQueueInteractionLock: (lockId: string, locked: boolean) => void;
  /** Protect one queued row from dispatch while its text is being edited. */
  setQueueEditLock: (clientId: string, locked: boolean) => void;
  /** F-QUEUE-DEFER: 从队列中移除一条未派发消息(行尾 ✕)。已在派发的不可移除。 */
  removeFromQueue: (clientId: string) => void;
  /** F-QUEUE-DEFER: 修改一条未派发消息的文本(行尾 ✏️)。空文本/找不到/未变化时 no-op。 */
  updateQueueItem: (clientId: string, newText: string) => void;
  sendMessage: (
    text: string,
    model: string,
    effort: string,
    permissionMode: string,
    workingDir: string,
    files?: AttachedFile[],
    mentions?: MentionedResource[],
    opts?: {
      vendorOptions?: Record<string, unknown>;
      quotesEncoded?: boolean;
      agentReferences?: AgentInputReference[];
      pastedTextRanges?: PastedTextRange[];
      slashCommandRanges?: SlashCommandRange[];
    },
  ) => Promise<boolean>;
  compactSession: (
    model: string,
    effort: string,
    permissionMode: string,
    workingDir: string,
    opts?: { vendorOptions?: Record<string, unknown> },
  ) => Promise<boolean>;
  steerMessage: (
    text: string,
    model: string,
    effort: string,
    permissionMode: string,
    workingDir: string,
    files?: AttachedFile[],
    mentions?: MentionedResource[],
    opts?: {
      vendorOptions?: Record<string, unknown>;
      quotesEncoded?: boolean;
      agentReferences?: AgentInputReference[];
      pastedTextRanges?: PastedTextRange[];
      slashCommandRanges?: SlashCommandRange[];
    },
  ) => Promise<boolean>;
  steerQueuedMessage: (clientId: string) => Promise<boolean>;
  /** User-initiated stop: aborts the current SDK query and clears streaming state */
  stopSession: () => void;
  /** F-CLEAR-1: Clear conversation — hides old messages, resets SDK context, stays on same session */
  clearSession: () => void;
  /** Dismiss the error banner without retrying. */
  clearError: () => void;
  /** Retry the main-owned typed recovery target. */
  retryLastError: () => void;
  /** silent-stop 耗尽横幅「继续」:清横幅并发隐藏续跑指令(充值守卫额度)。 */
  continueAfterSilentStop: () => void;
  /** F-CMD: Insert a local-only system card */
  insertSystemCard: (
    cardType: 'help' | 'cost' | 'context' | 'pwd' | 'status' | 'cmd' | 'learn',
    data?: Record<string, unknown>,
  ) => string | null;
  /** F-CMD: Patch the latest local-only system card in place */
  updateLastSystemCardData: (patch: Record<string, unknown>) => void;
  /** F-CMD: Patch a specific local-only system card in place */
  updateSystemCardData: (clientId: string, patch: Record<string, unknown>) => void;
  error: string | null;
  /** 可恢复的账号用量限制；resetAtMs 识别失败时为 null。 */
  usageLimitRecovery: UsageLimitRecoveryHint | null;
  /** 当前 terminal error 的稳定 reason key(如 'silent-stop-exhausted');ErrorBanner
   *  据此渲染专用 action。仅 error 非空时有意义。 */
  errorReason: string | null;
  /** error 是非终止 recoverableError(turn 在跑,daemon 自动重试中):ErrorBanner
   *  网络分支据此显示「正在自动重试…」而非「可点击重试」。 */
  errorIsRecoverable: boolean;
  /** Explicit retry target for ErrorBanner; null means retry is unsafe or unavailable. */
  errorRetryText: string | null;
  /** 凭证切换等待态(main 透传):挡路会话结束后自动重发,渲染等待横幅。 */
  credentialSwitchWait: { clientId?: string; blockedBySessionIds: string[] } | null;
  /** 已离队、正在 coordinator dispatch/turn 边界内的 Continue clientId。 */
  continuationInFlightClientId: string | null;
  /** F-SYNC-2: Load older messages (prepend to top) */
  loadOlderMessages: () => void;
  isLoadingMore: boolean;
  hasMoreMessages: boolean;
  /** F-PERM-2: Currently pending permission request */
  pendingPermission: PendingPermission | null;
  /** F-PERM-2: Respond to a pending permission request */
  respondToPermission: (result: CCAgentPermissionResult) => void;
  /** F7.2: Currently pending ask-user-question */
  pendingAskUser: PendingAskUser | null;
  /** Host-owned plugin setup snapshot. */
  pendingPluginSetup: PendingPluginSetup | null;
  pluginSetupViewerState: PluginSetupViewerState;
  pluginSetupCommandInFlight: PluginSetupCommandInFlight | null;
  setPluginSetupViewerState: (next: PluginSetupViewerState) => void;
  respondToPluginSetup: (
    requestId: string,
    action: 'run_action' | 'submit_form' | 'cancel',
    actionId?: string,
    values?: PluginSetupInlineFormValues,
  ) => void;
  /** F-AUQ-MIN-1: Current AskUserQuestion viewer state (expanded / minimized). */
  askUserViewerState: AskUserViewerState;
  /** F-AUQ-MIN-2/4: Switch the AskUserQuestion viewer between expanded and minimized. */
  setAskUserViewerState: (next: AskUserViewerState) => void;
  /** F-AUQ-DRAFT: In-progress wizard answers (currentIndex + answers map), or null. */
  askUserDraft: AskUserDraft | null;
  /** F-AUQ-DRAFT: Persist in-progress wizard state for the current question batch. */
  setAskUserDraft: (next: AskUserDraft | null) => void;
  /** F7.4/F7.5: Answer a pending ask-user-question */
  answerUserQuestion: (requestId: string, answers: Record<string, string>) => void;
  /** FP-3: Currently pending plan review */
  pendingPlanReview: PendingPlanReview | null;
  /** FP-3: Respond to a pending plan review */
  respondToPlanReview: (requestId: string, approved: boolean, feedback?: string) => void;
  /** 取消本次计划审阅:关卡片、气泡标 cancelled,结束本轮计划循环(不修订、不编码,下一条消息回常规模式)。 */
  cancelPlanReview: (requestId: string) => void;
  /** issue_confirm: Currently pending GitHub issue confirm card */
  pendingIssueConfirm: PendingIssueConfirm | null;
  /** issue_confirm: Respond to the pending issue confirm card */
  respondToIssueConfirm: (
    result:
      | {
          confirmed: true;
          title: string;
          body: string;
          type: 'bug' | 'feature';
          publicName?: string;
          uiLanguage: string;
        }
      | { confirmed: false },
  ) => void;
  /** rename_sessions_confirm: Currently pending batch rename confirm card */
  pendingRenameSessionsConfirm: PendingRenameSessionsConfirm | null;
  /** rename_sessions_confirm: Respond to the pending batch rename confirm card */
  respondToRenameSessionsConfirm: (result: { confirmed: true } | { confirmed: false }) => void;
  /** ghost_grant_confirm: Currently pending ghost file-grant confirm card */
  pendingGhostGrantConfirm: PendingGhostGrantConfirm | null;
  /** ghost_grant_confirm: Respond to the pending ghost file-grant confirm card */
  respondToGhostGrantConfirm: (
    result: { confirmed: true; allowDirs?: boolean } | { confirmed: false },
  ) => void;
  /** FP-3: Current plan viewer display state */
  planViewerState: PlanViewerState;
  /** FP-3: Change plan viewer display state */
  setPlanViewerState: (state: PlanViewerState) => void;
  /**
   * FP-edit: update the editable plan content. Updates the in-memory pending
   * plan synchronously, and debounces a 500ms disk write through the main
   * process. Returns the failure (if any) of the most recent write via the
   * `onWriteError` callback so the UI can surface it.
   */
  updatePlanContent: (
    requestId: string,
    planFilePath: string,
    content: string,
    onWriteError?: (message: string) => void,
  ) => void;
  /** FP-5: Last non-minimized state — target for the "+" restore button */
  lastExpandedPlanViewerState: 'expanded' | 'half' | 'edit';
  /** Whether the initial message history has been fetched for this session */
  historyLoaded: boolean;
  /** True when no message has ever been sent in this session (pre-clear sessions are false) */
  isFirstMessage: boolean;
  /** Fast Mode toggle state — session-level, OFF by default. */
  fastMode: boolean;
  /** Toggle Fast Mode ON/OFF; captured device ID pins remote routing across relay reconnects. */
  setFastMode: (enabled: boolean, sourceRemoteDeviceId?: string) => Promise<void>;
  /** Reset Fast Mode to OFF (server-first, used on model switch away from Opus 4.6). */
  resetFastMode: () => Promise<void>;
  /** 计划模式一级开关状态(与 permissionMode 正交); 计划批准后经 plan_mode_changed 回流自动变 false。 */
  planModeEnabled: boolean;
  /** 切换计划模式(server-first: 落库 → store → maker runtime)。 */
  setPlanMode: (enabled: boolean) => Promise<void>;
  /** Hidden-pane-safe heavy snapshot shared by MessageStream descendants. */
  chatDisplaySnapshot: ChatDisplaySnapshot;
}

const NOOP_UNSUBSCRIBE = () => {};

interface UseCCAgentChatOptions {
  /**
   * Whether the heavy chat snapshot (messages/taskUpdates) should update in
   * real time. Hidden keep-alive Orca worker panes pass false so text deltas
   * keep advancing in makerChatStore without forcing MessageStream work.
   */
  chatRealtime?: boolean;
}

interface FrozenSnapshotRef {
  sessionId: string;
  snapshot: SessionChatState;
}

function useHeavyChatSnapshot(
  sessionId: string | undefined,
  chatRealtime: boolean,
): SessionChatState {
  const frozenRef = useRef<FrozenSnapshotRef | null>(null);
  const subscribeHeavy = useCallback(
    (cb: () => void) =>
      sessionId && chatRealtime ? makerChatStore.subscribe(sessionId, cb) : NOOP_UNSUBSCRIBE,
    [chatRealtime, sessionId],
  );
  const getHeavySnapshot = useCallback(() => {
    if (!sessionId) return EMPTY_SESSION_STATE;
    if (!chatRealtime) {
      const frozen = frozenRef.current;
      if (frozen?.sessionId === sessionId) return frozen.snapshot;
    }
    return makerChatStore.getSnapshot(sessionId);
  }, [chatRealtime, sessionId]);
  const state = useSyncExternalStore(subscribeHeavy, getHeavySnapshot, getHeavySnapshot);

  useLayoutEffect(() => {
    if (!sessionId) {
      frozenRef.current = null;
      return;
    }
    if (chatRealtime || frozenRef.current?.sessionId !== sessionId) {
      frozenRef.current = { sessionId, snapshot: state };
    }
  }, [chatRealtime, sessionId, state]);

  return state;
}

function useLiveChatLightState(sessionId: string | undefined): SessionChatLightState {
  return useSyncExternalStore(
    (cb) => (sessionId ? makerChatStore.subscribeLight(sessionId, cb) : NOOP_UNSUBSCRIBE),
    () => (sessionId ? makerChatStore.getLightSnapshot(sessionId) : EMPTY_SESSION_STATE),
    () => (sessionId ? makerChatStore.getLightSnapshot(sessionId) : EMPTY_SESSION_STATE),
  );
}

export function useCCAgentChat(
  sessionId: string | undefined,
  onTitleUpdate?: () => void,
  options: UseCCAgentChatOptions = {},
): UseCCAgentChatReturn {
  const chatRealtime = options.chatRealtime ?? true;
  const heavyState = useHeavyChatSnapshot(sessionId, chatRealtime);
  const lightState = useLiveChatLightState(sessionId);
  const chatDisplaySnapshot = useMemo<ChatDisplaySnapshot>(
    () => ({
      sessionId,
      chatRealtime,
      messages: heavyState.messages,
      historyLoaded: heavyState.historyLoaded,
      hasMoreMessages: heavyState.hasMoreMessages,
    }),
    [chatRealtime, heavyState, sessionId],
  );

  // Register the onTitleUpdate callback for this session. The store invokes
  // it on `done` events and on sendMessage auto-naming. It is re-registered
  // whenever sessionId or the callback identity changes. No store-level
  // stopSession on unmount — that would reintroduce the bug.
  useEffect(() => {
    if (!sessionId) return;
    makerChatStore.setTitleUpdateCallback(sessionId, onTitleUpdate);
    return () => {
      makerChatStore.setTitleUpdateCallback(sessionId, undefined);
    };
  }, [sessionId, onTitleUpdate]);

  // Fetch initial history once per session slice + track active view for soft eviction.
  useEffect(() => {
    if (!sessionId) return;
    const dispose = makerChatStore.enterView(sessionId);
    makerChatStore.ensureInitialMessages(sessionId);
    return dispose;
  }, [sessionId]);

  const sendMessage = useCallback(
    (
      text: string,
      model: string,
      effort: string,
      permissionMode: string,
      workingDir: string,
      files?: AttachedFile[],
      mentions?: MentionedResource[],
      opts?: {
        vendorOptions?: Record<string, unknown>;
        quotesEncoded?: boolean;
        agentReferences?: AgentInputReference[];
        pastedTextRanges?: PastedTextRange[];
        slashCommandRanges?: SlashCommandRange[];
      },
    ): Promise<boolean> => {
      if (!sessionId) return Promise.resolve(false);
      return makerChatStore.sendMessage(
        sessionId,
        text,
        model,
        effort,
        permissionMode,
        workingDir,
        files,
        mentions,
        opts,
      );
    },
    [sessionId],
  );

  const compactSession = useCallback(
    (
      model: string,
      effort: string,
      permissionMode: string,
      workingDir: string,
      opts?: { vendorOptions?: Record<string, unknown> },
    ) => {
      if (!sessionId) return Promise.resolve(false);
      return makerChatStore.compactSession(
        sessionId,
        model,
        effort,
        permissionMode,
        workingDir,
        opts,
      );
    },
    [sessionId],
  );

  const steerMessage = useCallback(
    (
      text: string,
      model: string,
      effort: string,
      permissionMode: string,
      workingDir: string,
      files?: AttachedFile[],
      mentions?: MentionedResource[],
      opts?: {
        vendorOptions?: Record<string, unknown>;
        quotesEncoded?: boolean;
        agentReferences?: AgentInputReference[];
        pastedTextRanges?: PastedTextRange[];
        slashCommandRanges?: SlashCommandRange[];
      },
    ) => {
      if (!sessionId) return Promise.resolve(false);
      return makerChatStore.steerMessage(
        sessionId,
        text,
        model,
        effort,
        permissionMode,
        workingDir,
        files,
        mentions,
        opts,
      );
    },
    [sessionId],
  );

  const steerQueuedMessage = useCallback(
    (clientId: string) => {
      if (!sessionId) return Promise.resolve(false);
      return makerChatStore.steerQueuedMessage(sessionId, clientId);
    },
    [sessionId],
  );

  const stopSession = useCallback(() => {
    if (!sessionId) return;
    // Queue Stop semantics (2026-06): if anything is queued, Stop means
    // "abort current turn and pause the whole queue", not "remove the newest
    // queued draft" or "shift immediately to the next one".
    const snap = makerChatStore.getSnapshot(sessionId);
    if (snap.pendingQueue.length > 0) {
      makerChatStore.stopSession(sessionId, { keepQueue: true, pauseQueue: true });
      return;
    }
    makerChatStore.stopSession(sessionId);
  }, [sessionId]);

  const clearSession = useCallback(() => {
    if (!sessionId) return;
    makerChatStore.clearSession(sessionId);
  }, [sessionId]);

  const clearError = useCallback(() => {
    if (!sessionId) return;
    makerChatStore.clearError(sessionId);
  }, [sessionId]);

  const continueAfterSilentStop = useCallback(() => {
    if (!sessionId) return;
    makerChatStore.continueAfterSilentStop(sessionId);
  }, [sessionId]);

  const retryLastError = useCallback(() => {
    if (!sessionId) return;
    makerChatStore.retryLastError(sessionId);
  }, [sessionId]);

  const insertSystemCard = useCallback(
    (
      cardType: 'help' | 'cost' | 'context' | 'pwd' | 'status' | 'cmd' | 'learn',
      data?: Record<string, unknown>,
    ) => {
      if (!sessionId) return null;
      return makerChatStore.insertSystemCard(sessionId, cardType, data);
    },
    [sessionId],
  );

  const updateLastSystemCardData = useCallback(
    (patch: Record<string, unknown>) => {
      if (!sessionId) return;
      makerChatStore.updateLastSystemCardData(sessionId, patch);
    },
    [sessionId],
  );

  const updateSystemCardData = useCallback(
    (clientId: string, patch: Record<string, unknown>) => {
      if (!sessionId) return;
      makerChatStore.updateSystemCardData(sessionId, clientId, patch);
    },
    [sessionId],
  );

  const loadOlderMessages = useCallback(() => {
    if (!sessionId) return;
    makerChatStore.loadOlderMessages(sessionId);
  }, [sessionId]);

  const respondToPermission = useCallback(
    (result: CCAgentPermissionResult) => {
      if (!sessionId) return;
      makerChatStore.respondToPermission(sessionId, result);
    },
    [sessionId],
  );

  const respondToIssueConfirm = useCallback(
    (
      result:
        | {
            confirmed: true;
            title: string;
            body: string;
            type: 'bug' | 'feature';
            publicName?: string;
            uiLanguage: string;
          }
        | { confirmed: false },
    ) => {
      if (!sessionId) return;
      makerChatStore.respondToIssueConfirm(sessionId, result);
    },
    [sessionId],
  );

  const respondToRenameSessionsConfirm = useCallback(
    (result: { confirmed: true } | { confirmed: false }) => {
      if (!sessionId) return;
      makerChatStore.respondToRenameSessionsConfirm(sessionId, result);
    },
    [sessionId],
  );

  const respondToGhostGrantConfirm = useCallback(
    (result: { confirmed: true; allowDirs?: boolean } | { confirmed: false }) => {
      if (!sessionId) return;
      makerChatStore.respondToGhostGrantConfirm(sessionId, result);
    },
    [sessionId],
  );

  const answerUserQuestion = useCallback(
    (requestId: string, answers: Record<string, string>) => {
      if (!sessionId) return;
      makerChatStore.answerUserQuestion(sessionId, requestId, answers);
    },
    [sessionId],
  );

  const respondToPluginSetup = useCallback(
    (
      requestId: string,
      action: 'run_action' | 'submit_form' | 'cancel',
      actionId?: string,
      values?: PluginSetupInlineFormValues,
    ) => {
      if (!sessionId) return;
      makerChatStore.respondToPluginSetup(sessionId, requestId, action, actionId, values);
    },
    [sessionId],
  );

  const cancelPlanReview = useCallback(
    (requestId: string) => {
      if (!sessionId) return;
      makerChatStore.cancelPlanReview(sessionId, requestId);
    },
    [sessionId],
  );

  const respondToPlanReview = useCallback(
    (requestId: string, approved: boolean, feedback?: string) => {
      if (!sessionId) return;
      makerChatStore.respondToPlanReview(sessionId, requestId, approved, feedback);
    },
    [sessionId],
  );

  const setPlanViewerState = useCallback(
    (next: PlanViewerState) => {
      if (!sessionId) return;
      makerChatStore.setPlanViewerState(sessionId, next);
    },
    [sessionId],
  );

  const setAskUserViewerState = useCallback(
    (next: AskUserViewerState) => {
      if (!sessionId) return;
      makerChatStore.setAskUserViewerState(sessionId, next);
    },
    [sessionId],
  );

  const setPluginSetupViewerState = useCallback(
    (next: PluginSetupViewerState) => {
      if (!sessionId) return;
      makerChatStore.setPluginSetupViewerState(sessionId, next);
    },
    [sessionId],
  );

  const setAskUserDraft = useCallback(
    (next: AskUserDraft | null) => {
      if (!sessionId) return;
      makerChatStore.setAskUserDraft(sessionId, next);
    },
    [sessionId],
  );

  // FP-edit: per-hook debounce timer for plan-file writes. We don't use
  // lodash here — a single mutable ref keeps the dependency surface small
  // and survives re-renders without being recreated.
  const planWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cleanup on unmount: flush any pending timer (we don't try to await the
  // write because the user may have left the screen — the latest in-memory
  // pending.plan is still authoritative for Approve).
  useEffect(() => {
    return () => {
      if (planWriteTimerRef.current) clearTimeout(planWriteTimerRef.current);
    };
  }, []);

  const updatePlanContent = useCallback(
    (
      requestId: string,
      planFilePath: string,
      content: string,
      onWriteError?: (message: string) => void,
    ) => {
      if (!sessionId) return;
      // 1) Sync update to the store immediately so Approve always sees the
      //    latest text even if the debounced write hasn't fired yet.
      makerChatStore.updatePendingPlanReviewContent(sessionId, requestId, content);

      // 2) Debounce the disk write — coalesce rapid keystrokes.
      if (planWriteTimerRef.current) clearTimeout(planWriteTimerRef.current);
      // Skip the IPC entirely when there's no path (defensive — shouldn't
      // happen in practice; ExitPlanMode always carries planFilePath).
      if (!planFilePath) return;
      planWriteTimerRef.current = setTimeout(() => {
        planWriteTimerRef.current = null;
        window.electronAPI.maker
          .writePlanFile({ requestId, planFilePath, content })
          .then((result) => {
            if (!result.success) {
              const msg = result.error || 'Failed to save plan';
              log.error('writePlanFile failed:', msg);
              onWriteError?.(msg);
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error('writePlanFile threw:', err);
            onWriteError?.(msg);
          });
      }, 500);
    },
    [sessionId],
  );

  const setFastMode = useCallback(
    async (enabled: boolean, sourceRemoteDeviceId?: string) => {
      if (!sessionId) return;
      await makerChatStore.setFastMode(sessionId, enabled, sourceRemoteDeviceId);
    },
    [sessionId],
  );

  const resetFastMode = useCallback(async () => {
    if (!sessionId) return;
    await makerChatStore.resetFastMode(sessionId);
  }, [sessionId]);

  const setPlanMode = useCallback(
    async (enabled: boolean) => {
      if (!sessionId) return;
      await makerChatStore.setPlanMode(sessionId, enabled);
    },
    [sessionId],
  );

  const pendingQueueLength = lightState.pendingQueue.length;
  // Codex 插话会先 interrupt 当前 turn，再等待 follow-up turn 真正启动。
  // 这个窗口里 SDK 可能已经上报 done / isRunning=false；只看运行态会把 Stop
  // 换成不可用的 Send，用户就失去取消这次插话的入口。
  const hasPendingSteer = lightState.steeringQueueClientIds.length > 0;
  const isAgentBusy =
    lightState.isStreaming ||
    lightState.agentStatus.isRunning ||
    hasPendingSteer ||
    (pendingQueueLength > 0 && !lightState.queuePaused);

  const setQueueExpanded = useCallback(
    (expanded: boolean) => {
      if (!sessionId) return;
      makerChatStore.setQueueExpanded(sessionId, expanded);
    },
    [sessionId],
  );

  const resumeQueue = useCallback(() => {
    if (!sessionId) return;
    makerChatStore.resumeQueue(sessionId);
  }, [sessionId]);

  const moveQueueItem = useCallback(
    (clientId: string, targetIndex: number) => {
      if (!sessionId) return;
      makerChatStore.moveQueueItem(sessionId, clientId, targetIndex);
    },
    [sessionId],
  );

  const setQueueInteractionLock = useCallback(
    (lockId: string, locked: boolean) => {
      if (!sessionId) return;
      makerChatStore.setQueueInteractionLock(sessionId, lockId, locked);
    },
    [sessionId],
  );

  const setQueueEditLock = useCallback(
    (clientId: string, locked: boolean) => {
      if (!sessionId) return;
      makerChatStore.setQueueEditLock(sessionId, clientId, locked);
    },
    [sessionId],
  );

  const removeFromQueue = useCallback(
    (clientId: string) => {
      if (!sessionId) return;
      makerChatStore.removeFromQueue(sessionId, clientId);
    },
    [sessionId],
  );

  const updateQueueItem = useCallback(
    (clientId: string, newText: string) => {
      if (!sessionId) return;
      makerChatStore.updateQueueItem(sessionId, clientId, newText);
    },
    [sessionId],
  );

  return {
    agentSwitchIntent: lightState.agentSwitchIntent,
    messages: heavyState.messages,
    taskUpdates: heavyState.taskUpdates ?? EMPTY_TASK_UPDATES,
    agentStatus: lightState.agentStatus,
    isStreaming: lightState.isStreaming,
    isAgentBusy,
    pendingQueueLength,
    pendingQueue: lightState.pendingQueue,
    steeringQueueClientIds: lightState.steeringQueueClientIds,
    queuePaused: lightState.queuePaused,
    queueExpanded: lightState.queueExpanded,
    setQueueExpanded,
    resumeQueue,
    moveQueueItem,
    setQueueInteractionLock,
    setQueueEditLock,
    removeFromQueue,
    updateQueueItem,
    sendMessage,
    compactSession,
    steerMessage,
    steerQueuedMessage,
    stopSession,
    clearSession,
    clearError,
    retryLastError,
    continueAfterSilentStop,
    insertSystemCard,
    updateLastSystemCardData,
    updateSystemCardData,
    error: lightState.error ?? lightState.recoverableError,
    usageLimitRecovery: lightState.error ? (lightState.usageLimitRecovery ?? null) : null,
    // 终止型沿用原语义(reason 只在 error 非空时有意义)。非终止型此前恒给 null ——
    // 那时 store 侧非终止分支也恒清 reason, 两边一致; 现在过载重投会在非终止态带上
    // 稳定 reason key(ErrorBanner 靠它渲染本地化重试进度), 必须透出, 否则 UI 只能
    // 回退到文案匹配。其它非终止 error 仍不带 reason, 取值仍是 null, 行为不变。
    errorReason:
      lightState.error != null
        ? (lightState.errorReason ?? null)
        : (lightState.recoverableError != null ? (lightState.errorReason ?? null) : null),
    // 当前 error 是非终止 recoverableError(turn 在跑,daemon 自动重试中):
    // ErrorBanner 网络分支据此显示「正在自动重试…」而非「可点击重试」。
    errorIsRecoverable: !lightState.error && lightState.recoverableError != null,
    errorRetryText: lightState.errorRetryText,
    credentialSwitchWait: lightState.credentialSwitchWait,
    continuationInFlightClientId: lightState.continuationInFlightClientId,
    loadOlderMessages,
    isLoadingMore: lightState.isLoadingMore,
    hasMoreMessages: lightState.hasMoreMessages,
    pendingPermission: lightState.pendingPermission,
    respondToPermission,
    pendingAskUser: lightState.pendingAskUser,
    pendingPluginSetup: lightState.pendingPluginSetup,
    pluginSetupViewerState: lightState.pluginSetupViewerState,
    pluginSetupCommandInFlight: lightState.pluginSetupCommandInFlight,
    setPluginSetupViewerState,
    respondToPluginSetup,
    askUserViewerState: lightState.askUserViewerState,
    setAskUserViewerState,
    askUserDraft: lightState.askUserDraft,
    setAskUserDraft,
    answerUserQuestion,
    pendingPlanReview: lightState.pendingPlanReview,
    respondToPlanReview,
    cancelPlanReview,
    pendingIssueConfirm: lightState.pendingIssueConfirm,
    respondToIssueConfirm,
    pendingRenameSessionsConfirm: lightState.pendingRenameSessionsConfirm,
    respondToRenameSessionsConfirm,
    pendingGhostGrantConfirm: lightState.pendingGhostGrantConfirm,
    respondToGhostGrantConfirm,
    planViewerState: lightState.planViewerState,
    setPlanViewerState,
    updatePlanContent,
    lastExpandedPlanViewerState: lightState.lastExpandedPlanViewerState,
    historyLoaded: lightState.historyLoaded,
    isFirstMessage: lightState.isFirstMessage,
    fastMode: lightState.fastMode,
    setFastMode,
    resetFastMode,
    planModeEnabled: lightState.planModeEnabled,
    setPlanMode,
    chatDisplaySnapshot,
  };
}
