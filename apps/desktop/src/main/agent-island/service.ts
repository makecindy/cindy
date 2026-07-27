import { dialog, ipcMain, screen, BrowserWindow, type Display, type OpenDialogOptions } from 'electron';
import path from 'node:path';
import { release as getOsRelease } from 'node:os';
import { SESSION_ACTIVITY_CHANNEL } from '@cindy/device-link';
import type { AgentEvent, InteractionDecision, InteractionRequest } from '@cindy/maker-core';
import type { SchedulerEvent } from '@cindy/maker-scheduler';
import { BRAND_NAME } from '@cindy/maker-shared/branding';
import type { ApplicationMenuCommand } from '../../shared/applicationMenuCommands.js';

import { hasSessionAttention as hasAppBadgeSessionAttention } from '../appBadgeService.js';
import {
  AGENT_ISLAND_MAX_RESIZABLE_WIDTH,
  AGENT_ISLAND_GET_DISPLAY_OPTIONS_CHANNEL,
  AGENT_ISLAND_PREVIEW_SOUND_CHANNEL,
  AGENT_ISLAND_SCREEN_EDGE_GUTTER,
  AGENT_ISLAND_SET_DISPLAY_TARGET_CHANNEL,
  AGENT_ISLAND_SET_ENABLED_CHANNEL,
  AGENT_ISLAND_SET_MASCOT_SKIN_CHANNEL,
  AGENT_ISLAND_SET_SOUND_SETTINGS_CHANNEL,
  AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL,
  AGENT_ISLAND_SELECT_SOUND_FILE_CHANNEL,
  DEFAULT_AGENT_ISLAND_DISPLAY_TARGET,
  DEFAULT_AGENT_ISLAND_MASCOT_SKIN,
  cloneAgentIslandDisplayTarget,
  cloneAgentIslandSoundSettings,
  computeAgentIslandContentHeight,
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
  snapAgentIslandCompactHardwareContentWidth,
  AGENT_ISLAND_SESSION_SNAPSHOTS_CHANNEL,
  type AgentIslandDisplayOption,
  type AgentIslandDisplayState,
  type AgentIslandPillSnapshot,
  type AgentIslandSessionActivity,
  type AgentIslandDisplayTarget,
  type AgentIslandMascotSkin,
  type AgentIslandStrings,
  type AgentIslandSoundChoice,
  type AgentIslandSoundEvent,
  type AgentIslandSoundSettings,
  type AgentIslandScreenLayoutMetrics,
} from '../../shared/agentIsland.js';
import { getSessionRowSnapshot } from '../localDb/ipc/sessions.js';
import { createLogger } from '../logger.js';
import { t } from '../i18n.js';
import { isAppContentWindow, isFocusedAppContentWindow } from '../windowFocusClassifier.js';
import {
  acknowledgeAgentIslandSessionRead,
  applyAgentIslandEvent,
  applyAgentIslandInteractionDismissed,
  applyAgentIslandInteractionRequest,
  applyAgentIslandUserPrompt,
  buildAgentIslandDisplayState,
  buildAllSessionActivitySnapshots,
  completeAgentIslandSessionWithoutAttention,
  createAgentIslandUserPromptRollbackToken,
  createAgentIslandState,
  dismissAgentIslandActiveReveal,
  getNextAgentIslandTimerAt,
  hasAgentIslandSessionAttention,
  isAgentIslandPendingFocusAck,
  markAgentIslandSessionAttention,
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
  setAgentIslandStrings,
  setAgentIslandToolWording,
  setAgentIslandVisibleSession,
  type AgentIslandUserPromptRollbackToken,
} from './state.js';
import { createLocalizedToolRowWording } from './toolWording.js';
import {
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
  readAgentIslandLayoutPreferences,
  writeAgentIslandLayoutPreference,
} from './layoutPreferenceStore.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import {
  detectProtectedFolderEperm,
  openFolderPrivacySettings,
  releaseEpermGuidance,
  shouldShowEpermGuidance,
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

interface AgentIslandSessionMeta {
  sessionId: string;
  agentKind?: string;
  workingDir?: string | null;
  workspaceKind?: string | null;
}

interface AgentIslandPermissionAction {
  requestId: string;
  action: 'allow' | 'allowForSession' | 'deny';
}

interface AgentIslandUserPromptDebugMeta {
  source?: string;
  clientId?: string;
  notifiedAt?: number;
}

export interface AgentIslandServiceDeps {
  getMainWindow: () => BrowserWindow | null;
  nativeHost?: AgentIslandNativeRenderer;
  /** Main-process upgrade window used to classify remote daemon shutdowns. */
  isPlannedRemoteDaemonClose?: (sessionId: string) => boolean;
}

interface AgentIslandNativeRenderer {
  readonly failed: boolean;
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

/**
 * Owns Agent Island display arbitration in main. Rendering is macOS-native:
 * the Swift/AppKit helper owns the system-level panel, shape, shadow and hover
 * tracking while TypeScript owns product state and session prioritization.
 */
export class AgentIslandService {
  private readonly state = createAgentIslandState();
  private readonly nativeHost: AgentIslandNativeRenderer;
  private readonly headless: boolean;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly metadataCache = new Map<string, {
    title: string | null;
    workingDir: string | null;
    workspaceKind: string | null;
  }>();
  private readonly metadataLoading = new Set<string>();
  private readonly layoutPreferencesByDisplayId: Map<number, AgentIslandLayoutPreference>;
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
  private readonly stoppedSessionIds = new Set<string>();
  private readonly replacementTurnPendingSessionIds = new Set<string>();
  private readonly replacementTurnDispatchingSessionIds = new Set<string>();
  private readonly stoppedProviderTurnIdBySession = new Map<string, string>();
  private readonly interactionEpochBySession = new Map<string, number>();
  private interactionEpochSequence = 0;
  private readonly sessionHadAttentionAtRunStart = new Map<string, boolean>();
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
  private readonly sessionActivityRelay = new SessionActivityRelay((payload) => {
    tapWindowBroadcast(SESSION_ACTIVITY_CHANNEL, payload);
  });
  private permissionResolver: ((requestId: string, decision: AgentIslandPermissionDecision) => boolean) | null = null;
  private shouldDeferCompletion: ((sessionId: string) => boolean) | null = null;
  private layoutPreferenceWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private streamingPreviewPublishTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: AgentIslandServiceDeps) {
    // lazy t() 闭包跟随 locale 运行时切换,注入一次即可(strings 仍每次 publish 重建)。
    setAgentIslandToolWording(this.state, createLocalizedToolRowWording());
    this.layoutPreferencesByDisplayId = readAgentIslandLayoutPreferences();
    this.nativeHost = deps.nativeHost ?? new MacAgentIslandNativeHost({
      onPointerZones: (zones) => this.handleNativePointerZones(zones),
      onExpand: (displayId) => this.handleNativeExpand(displayId),
      onFocusSession: (sessionId) => this.focusSession(sessionId),
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
   * 当某会话的排队工作因 INPUT_REMOVE / INPUT_CLEAR_SESSION 被清空(而非被派发)时调用。
   * 若该会话有待补发的完成事件(之前因队列非空而被推迟),且现在队列确实为空,则立即补发。
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
      this.scheduleSilencedRunClearForSession(sessionId, SILENCED_COMPLETION_CLEAR_MS);
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
      this.clearPublishTimer();
      this.hiddenPublished = true;
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

  resetRuntimeState(): void {
    this.clearPublishTimer();
    this.clearStreamingPreviewPublishTimer();
    this.flushLayoutPreferenceWrites();
    this.sessionActivityRelay.reset();
    for (const runId of Array.from(this.silencedRunClearTimers.keys())) {
      this.clearSilencedRunTimer(runId);
    }
    resetAgentIslandState(this.state);
    this.metadataCache.clear();
    this.metadataLoading.clear();
    this.lastSoundDisplayState = null;
    this.soundCooldownUntilByEvent.clear();
    this.silencedRunSessionIds.clear();
    this.silencedSessionRunIds.clear();
    this.silencedRunHadAttention.clear();
    this.mutedCompletionSoundSessionIds.clear();
    this.stoppedSessionIds.clear();
    this.replacementTurnPendingSessionIds.clear();
    this.replacementTurnDispatchingSessionIds.clear();
    this.stoppedProviderTurnIdBySession.clear();
    this.interactionEpochBySession.clear();
    this.sessionHadAttentionAtRunStart.clear();
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

  handleAgentEvent(meta: AgentIslandSessionMeta, event: AgentEvent): void {
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
      // immediately.  Deferring a silenced event risks silencedSessionRunIds being
      // cleared (after SILENCED_COMPLETION_CLEAR_MS) before notifyQueueEmptied
      // fires, which would cause the replayed event to be treated as normal and
      // show attention / play sound for a run that was explicitly silenced.
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
      if (folderKind && shouldShowEpermGuidance(folderKind)) {
        void this.showFolderEpermGuidance(folderKind).catch((error: unknown) => {
          releaseEpermGuidance(folderKind);
          log.warn('failed to show folder access guidance', { kind: folderKind, error });
        });
      }
    }
    const suppressCompletionAttention = this.isCompletionEventSilenced(hydrated.sessionId, event);
    const changed = applyAgentIslandEvent(this.state, hydrated, event, now, {
      suppressCompletionAttention,
      preserveCompletionAttention: suppressCompletionAttention && this.hadAttentionBeforeSilencedRun(hydrated.sessionId),
      allowCompletionAfterTerminalError:
        isRemoteDaemonClosedErrorEvent(event) &&
        this.deps.isPlannedRemoteDaemonClose?.(hydrated.sessionId) === true,
    });
    if (suppressCompletionAttention) {
      this.mutedCompletionSoundSessionIds.add(hydrated.sessionId);
      this.scheduleSilencedRunClearForSession(hydrated.sessionId, SILENCED_COMPLETION_CLEAR_MS);
    }
    if (!changed) return;
    this.ensureMetadata(hydrated.sessionId);
    if (!suppressCompletionAttention) {
      this.syncSessionAttention(hydrated.sessionId);
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

  handleUserPrompt(meta: AgentIslandSessionMeta, prompt: string, debugMeta: AgentIslandUserPromptDebugMeta = {}): void {
    const receivedAt = Date.now();
    const hydrated = this.hydrateMeta(meta);
    const previousInteractionEpoch = this.interactionEpochBySession.get(hydrated.sessionId);
    const wasStopped = this.stoppedSessionIds.has(hydrated.sessionId);
    const wasReplacementTurnPending = this.replacementTurnPendingSessionIds.has(hydrated.sessionId);
    const wasReplacementTurnDispatching =
      this.replacementTurnDispatchingSessionIds.has(hydrated.sessionId);
    const deferInteractionEpochUntilDispatch = wasStopped || wasReplacementTurnPending;
    if (!deferInteractionEpochUntilDispatch) {
      this.advanceInteractionEpoch(hydrated.sessionId);
    }
    if (wasStopped) {
      this.stoppedSessionIds.delete(hydrated.sessionId);
      this.replacementTurnPendingSessionIds.add(hydrated.sessionId);
    }
    if (deferInteractionEpochUntilDispatch) {
      this.replacementTurnDispatchingSessionIds.delete(hydrated.sessionId);
    }
    const rollbackKey = this.userPromptRollbackKey(hydrated.sessionId, debugMeta.clientId);
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
      return;
    }
    this.ensureMetadata(hydrated.sessionId);
    this.syncSessionAttention(hydrated.sessionId);
    this.publish();
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

  handlePluginSetupInteraction(
    sessionId: string,
    requestId: string,
    detail: string,
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
      { kind: 'plugin_setup', requestId, detail },
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
    if (event.type === 'done' || event.type === 'error') {
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

  handleSessionClosed(sessionId: string): void {
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
    removeAgentIslandSession(this.state, sessionId);
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
    for (const key of this.userPromptRollbackTokens.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.userPromptRollbackTokens.delete(key);
      }
    }
    this.deferredCompletions.delete(sessionId);
    this.clearDeferredRemoteAuthError(sessionId);
    this.deletePermissionRequestsForSession(sessionId);
    const hadSession = this.state.sessions.has(sessionId);
    removeAgentIslandSession(this.state, sessionId);
    if (hadSession) this.publish();
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
   * 未读 error 条目免疫;只有真实展示路径(useErrorReadAck / 全部标为已读等)
   * 显式带 'explicit' 才能清掉未读的报错。
   */
  handleSessionAttentionCleared(sessionId: string, source: 'explicit' | 'passive' = 'passive'): void {
    const ack = acknowledgeAgentIslandSessionRead(this.state, sessionId, Date.now(), { source });
    // 未读 error 对 passive 免疫:state 未动,也**不能**给远端发收尾包 —— 否则手机
    // 列表行的 error 红点会被导航级被动信号清掉,破坏「已读以真实展示为准」。
    if (ack === 'error-immune') return;
    if (ack === 'not-found') {
      // not-found(典型:重启后 state / relay 条目丢失,远端仍挂着旧未读)只对
      // **本机拥有**的会话补收尾包(localDb 有行 = 本机是 owner)。本机只是控制端
      // 时(查看别台设备的会话),该会话不在本机 localDb —— 不得替 owner 设备向
      // 本机 sessions topic 广播否定帧,否则同时订阅本机的第三方控制端会误删
      // owner 正在发布的 live / 未读条目;远程收敛由 renderer 的隧道回执直达
      // owner 设备负责。异步查行期间若会话恢复活跃,ensure 的「entries 有条目
      // 即不插手」语义天然防误清。
      //
      // passive 与 explicit 同权放行:重启后 error kind 的记忆(state / 角标)已
      // 丢失,owner 侧无从做 kind 级免疫;而到达这里的 passive 回执几乎只来自
      // 远程控制端,发起侧(sessionAttentionStore.flushPendingRemoteReceipt)已
      // 做过 error 免疫——error 未读时 passive 回执按下不发,镜像缺失时还有消息层
      // 终止错误探针兜底。若这里再扣发,桌面控制端的正常阅读路径(passive)将
      // 永远清不掉 owner 重启前留下的完成绿点,恰是本兜底要修的挂死场景。
      void getSessionRowSnapshot(sessionId)
        .then((row) => {
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
    // 收尾包兜底必须在 publish() **之前**:桌面重启(state / relay 条目丢失)或
    // 收尾包推送丢失后,远端列表行可能仍挂着 attention=true 的旧条目,而 relay
    // entries 已无记录,publish() 的隐式收敛不会为它发出任何帧,绿点永久挂死 ——
    // ensure 在 entries 无条目时补发一帧可重放的收尾包。entries 有条目(live 会话
    // 或活跃未读)时 ensure 不插手,由紧随的 publish() 正常收敛:live 帧继续、
    // 已读的未读终态走 clear 发收尾包,不产生误清与重复帧。
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
    patch: { title?: string | null; workingDir?: string | null; workspaceKind?: string | null },
  ): void {
    const current = this.metadataCache.get(sessionId) ?? {
      title: null,
      workingDir: null,
      workspaceKind: null,
    };
    const next = {
      title: patch.title !== undefined ? patch.title : current.title,
      workingDir: patch.workingDir !== undefined ? patch.workingDir : current.workingDir,
      workspaceKind: patch.workspaceKind !== undefined ? patch.workspaceKind : current.workspaceKind,
    };
    this.metadataCache.set(sessionId, next);
    if (!patchAgentIslandMetadata(this.state, { sessionId, ...next })) return;
    this.publish();
  }

  replaySessionActivity(): void {
    this.sessionActivityRelay.replay(this.buildSessionActivityPayload());
  }

  private hydrateMeta(meta: AgentIslandSessionMeta): AgentIslandSessionMeta & { title?: string | null } {
    const cached = this.metadataCache.get(meta.sessionId);
    return {
      ...meta,
      title: cached?.title ?? null,
      workingDir: cached?.workingDir ?? meta.workingDir,
      workspaceKind: cached?.workspaceKind ?? meta.workspaceKind,
    };
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
    if (this.metadataLoading.has(sessionId) || (cached && !isPlaceholderSessionTitle(cached.title))) return;
    this.metadataLoading.add(sessionId);
    void getSessionRowSnapshot(sessionId)
      .then((row) => {
        const metadata = {
          title: row?.title ?? null,
          workingDir: row?.workingDir ?? null,
          workspaceKind: row?.workspaceKind ?? null,
        };
        this.metadataCache.set(sessionId, metadata);
        if (patchAgentIslandMetadata(this.state, { sessionId, ...metadata })) {
          this.publish();
        }
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
    const event = getAgentIslandSoundEventForTransition(
      previous,
      next,
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
    return this.silencedSessionRunIds.has(sessionId);
  }

  private scheduleSilencedRunClearForSession(sessionId: string, delayMs: number): void {
    const runId = this.silencedSessionRunIds.get(sessionId);
    if (!runId) return;
    this.scheduleSilencedRunClear(runId, delayMs);
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
    this.clearSilencedRunTimer(runId);
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

  /**
   * 把 per-session 活动快照(轻量子集)广播给 renderer,供侧栏置顶卡片/列表显示
   * 任务执行中的逐步活动 + 等待交互态。与原生灵动岛同源数据,enabled/disabled 都发。
   *
   * 数据取 state.sessions **全集**(buildAllSessionActivitySnapshots),不是灵动岛展示面
   * displayState.sessions —— 后者在展示 transient 完成/错误卡时会过滤掉运行中/等待中的
   * 会话,而 renderer store 是整体替换,用子集会把这些会话从活动 map 丢掉、卡片回退陈旧
   * summary(PR #246 review)。两个调用方均在 buildAgentIslandDisplayState(已裁剪过期
   * session)之后调用本方法。
   */
  private buildSessionActivityPayload(): AgentIslandSessionActivity[] {
    return buildAllSessionActivitySnapshots(this.state).map((s) => ({
      sessionId: s.sessionId,
      phase: s.phase,
      compactDetail: s.compactDetail,
      interactionKind: s.interactionKind,
      attention: s.attention,
    }));
  }

  private emitSessionActivityToRenderer(): void {
    const payload = this.buildSessionActivityPayload();
    this.sessionActivityRelay.publish(payload);
    // 广播给所有 app content window(含「在新窗口打开」的副窗),不只主窗 —— 副窗也有侧栏、
    // 也订阅同一频道,只发主窗会让副窗卡片预览停在陈旧 summary(PR #246 review)。
    const windows = BrowserWindow.getAllWindows().filter(isAppContentWindow);
    if (windows.length === 0) return;
    for (const win of windows) {
      const wc = win.webContents;
      if (wc && !wc.isDestroyed()) wc.send(AGENT_ISLAND_SESSION_SNAPSHOTS_CHANNEL, payload);
    }
  }

  private publish(): void {
    const now = Date.now();
    if (!this.enabledSynced) {
      this.mutedCompletionSoundSessionIds.clear();
      this.clearStreamingPreviewPublishTimer();
      this.clearPublishTimer();
      return;
    }
    if (!this.enabled) {
      this.mutedCompletionSoundSessionIds.clear();
      this.clearStreamingPreviewPublishTimer();
      this.lastSoundDisplayState = withAgentIslandConfig(
        buildAgentIslandDisplayState(this.state, now),
        this.soundSettings,
        this.mascotSkin,
      );
      // 侧栏卡片的逐步活动不依赖灵动岛开关:即便岛 UI 关闭,状态机仍累积,照常广播给 renderer。
      this.emitSessionActivityToRenderer();
      this.clearPublishTimer();
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
    const displayState = withAgentIslandConfig(
      buildAgentIslandDisplayState(this.state, now),
      this.soundSettings,
      this.mascotSkin,
    );
    this.emitSessionActivityToRenderer();
    this.scheduleNextPublish(now);
    this.playSoundForDisplayTransition(this.lastSoundDisplayState, displayState, now);
    this.mutedCompletionSoundSessionIds.clear();
    this.lastSoundDisplayState = displayState;

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
    const displayId = typeof preference.displayId === 'number' && Number.isFinite(preference.displayId)
      ? preference.displayId
      : this.getTargetDisplay().id;
    const current = this.layoutPreferencesByDisplayId.get(displayId) ?? {};
    const next: AgentIslandLayoutPreference = { ...current };
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
    if (signature === this.screenMetricsSignature && metrics.preferredDisplayId === this.nativePreferredDisplayId) {
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
    const displays = this.getTargetDisplays();
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
    const rawScreenMetrics = this.getScreenLayoutMetrics(display);
    const layoutPreference = this.layoutPreferencesByDisplayId.get(display.id) ?? {};
    const expanded = displayState.notchStatus === 'expanded';
    const hasSession = displayState.totalCount > 0;
    const screenMetrics = this.getEffectiveScreenLayoutMetrics({
      display,
      expanded,
      layoutPreference,
      screenMetrics: rawScreenMetrics,
    });
    const contentHeight = computeAgentIslandContentHeight({
      mode: displayState.mode,
      displaySurface: displayState.displaySurface,
      hasSession,
      totalCount: displayState.totalCount,
      measuredContentHeight: displayState.measuredContentHeight,
    });
    const rawPreferredContentWidth = expanded
      ? layoutPreference.expandedContentWidth
      : layoutPreference.compactContentWidth;
    const expandedPreferredContentWidth = layoutPreference.expandedContentWidth;
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
    const contentWidth = preferredContentWidth !== null
      ? preferredContentWidth
      : defaultContentWidth;
    const expandedClampContentWidth = typeof expandedPreferredContentWidth === 'number'
      ? expandedPreferredContentWidth
      : getAgentIslandDefaultContentWidth({
        expanded: true,
        hasSession,
        displayWidth: display.bounds.width,
        screenMetrics,
      });
    const carrierSize = computeAgentIslandCarrierSize(
      display,
      expanded,
      contentHeight,
      contentWidth,
      defaultContentWidth,
      minimumContentWidth,
    );
    return {
      ...computeAgentIslandWindowBounds(display, {
        expanded,
        contentHeight,
        centerXRatio: layoutPreference.centerXRatio,
        contentWidth,
        defaultContentWidth,
        minimumContentWidth,
        expandedClampContentWidth,
      }),
      displayId: display.id,
      displayBounds: display.bounds,
      contentWidth: carrierSize.contentWidth,
    };
  }

  private getTargetDisplays(): Display[] {
    const displays = this.getAvailableDisplays();
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
    let candidates = displays;
    const name = target.displayName?.trim();
    if (name) {
      candidates = candidates.filter((display) => (
        typeof display.label === 'string' && display.label.trim() === name
      ));
    }

    if (typeof target.displayInternal === 'boolean') {
      candidates = candidates.filter((display) => (
        Boolean(display.internal) === target.displayInternal
      ));
    }

    const persistedBounds = target.displayBounds;
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

    if (typeof target.displayIndex === 'number' && target.displayIndex >= 1) {
      const byIndex = displays[target.displayIndex - 1];
      if (byIndex && candidates.includes(byIndex)) return byIndex;
    }

    return candidates.length === 1 ? (candidates[0] ?? null) : null;
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
    const nativePreferred = this.displayById(displays, this.nativePreferredDisplayId);
    if (AGENT_ISLAND_DISPLAY_CONFIG.selectionMode === 'native-preferred-then-xdmaker-window') {
      if (nativePreferred) return nativePreferred;
      if (mainWindowDisplay) return mainWindowDisplay;
    }
    if (AGENT_ISLAND_DISPLAY_CONFIG.selectionMode === 'xdmaker-window-then-native-preferred') {
      if (mainWindowDisplay) return mainWindowDisplay;
      if (nativePreferred) return nativePreferred;
    }
    if (AGENT_ISLAND_DISPLAY_CONFIG.preferHardwareNotchFallback) {
      const notchDisplay = displays.find((display) => this.screenMetricsByDisplayId.get(display.id)?.hasNotch);
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
    const metrics = this.screenMetricsByDisplayId.get(display.id);
    if (!metrics) return null;
    return {
      hasNotch: metrics.hasNotch,
      notchWidth: metrics.notchWidth,
    };
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
    const now = Date.now();
    this.playConfiguredSound('select', now);
    if (this.state.appFocused && this.state.visibleSessionIds.has(nextSessionId)) {
      const focusChanged = requestAgentIslandSessionFocus(this.state, nextSessionId, now);
      if (focusChanged) this.publish();
      return;
    }

    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const focusChanged = requestAgentIslandSessionFocus(this.state, nextSessionId, now);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('notification:focus-session', nextSessionId);
    if (focusChanged) this.publish();
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
    input: t('agentIsland.native.input'),
    done: t('agentIsland.native.done'),
    running: t('agentIsland.native.running'),
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

function sameDisplayBounds(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
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
  if (event.type === 'done') return true;
  if (event.type !== 'status') return false;
  const data = event.data as { isRunning?: unknown; status?: unknown } | undefined;
  return data?.isRunning === false && data.status === 'Done';
}

function isCancelledTerminalEvent(event: AgentEvent): boolean {
  if (event.type !== 'done' && event.type !== 'status') return false;
  const data = event.data as { cancelled?: unknown } | undefined;
  return data?.cancelled === true;
}

function isRunningStatusEvent(event: AgentEvent): boolean {
  if (event.type !== 'status') return false;
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
