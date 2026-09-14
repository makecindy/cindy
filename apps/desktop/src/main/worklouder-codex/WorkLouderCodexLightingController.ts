import {
  WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
  WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
  WORKLOUDER_CODEX_KEYCAP_ACTIONS,
  WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS,
  WORKLOUDER_HID_AG_CODES,
  normalizeWorkLouderCreatorTaskKeys,
  buildCreatorMicro2AgentKeymap,
  cloneWorkLouderCodexSettings,
  createWorkLouderCodexDefaultSettings,
  creatorCommandAssignment,
  isWorkLouderCodexVoiceAssignment,
  isWorkLouderCreatorProgrammableKey,
  resolveWorkLouderHidRole,
  workLouderCodexAutoDimMs,
  workLouderLayoutMerges,
  workLouderMergeForKey,
  workLouderShouldMuteKeyZone,
  type WorkLouderCodexAction,
  type WorkLouderCodexAgentSlotState,
  type WorkLouderCodexAnalogDirection,
  type WorkLouderCodexCommandSlot,
  type WorkLouderCodexConnectionReason,
  type WorkLouderCodexConnectionStatus,
  type WorkLouderCodexDeviceState,
  type WorkLouderCodexPreviewInput,
  type WorkLouderCodexPreviewPart,
  type WorkLouderCodexRendererAction,
  type WorkLouderCodexSettings,
  type WorkLouderCodexState,
  type WorkLouderCodexTaskOption,
} from '../../shared/workLouderCodex.js';
import {
  applyWorkLouderCodexLightingBrightness,
  createWorkLouderCodexOffFrame,
  createWorkLouderCodexLightingFrame,
  createWorkLouderCodexWindowRevealFrame,
  muteWorkLouderCodexKeyZone,
  foldOrcaWorkerActivityOntoLeads,
  isWorkLouderCodexLightingFrameOff,
  type WorkLouderCodexHidEvent,
  type WorkLouderCodexJoystickEvent,
  type WorkLouderCodexLightingFrame,
  type WorkLouderCodexSessionActivity,
} from './protocol.js';
import type { WorkLouderCodexTaskCatalog } from './taskSlots.js';
import {
  WORKLOUDER_JOYSTICK_ACTIVATION_DISTANCE,
  normalizeJoystickIntensity,
} from '../../shared/workLouderCodexScroll.js';

const TASK_SLOT_REFRESH_DEBOUNCE_MS = 250;
const AGENT_KEY_DOUBLE_TAP_MS = 350;
const ENCODER_LONG_PRESS_MS = 500;
/** How long the window-reopen greeting stays on the board. */
const WINDOW_REVEAL_MS = 2_000;
/**
 * How long a held stick may go silent before we give up on it.
 *
 * Measured against the hardware: a stick held still reports nothing at all,
 * with gaps of two seconds and more between updates. Release has its own
 * signal (distance drops to zero), so this is only a backstop for the device
 * going away mid-push — unplugged, asleep, or a dropped packet. It has to sit
 * well above the silent gaps or it would read "held" as "let go".
 */
const JOYSTICK_RELEASE_TIMEOUT_MS = 10_000;
type Timer = ReturnType<typeof setTimeout>;

export interface WorkLouderCodexLightingSink {
  update(frame: WorkLouderCodexLightingFrame): void;
  /** Legacy Agent-only hook retained for old host fakes and compatibility tests. */
  setAgentKeyPressHandler(handler: ((slot: number) => void) | null): void;
  setDeviceActivityHandler(handler: (() => void) | null): void;
  setConnectionStatusHandler(
    handler: ((status: WorkLouderCodexConnectionStatus) => void) | null,
  ): void;
  setHidInputHandler?(handler: ((event: WorkLouderCodexHidEvent) => void) | null): void;
  setJoystickInputHandler?(handler: ((event: WorkLouderCodexJoystickEvent) => void) | null): void;
  setDeviceStateHandler?(handler: ((device: WorkLouderCodexDeviceState) => void) | null): void;
  setConnectionReasonHandler?(
    handler: ((reason: WorkLouderCodexConnectionReason) => void) | null,
  ): void;
  setDeviceEnabled?(enabled: boolean): void;
  rebindCreatorKeymap?(keymap: string[][]): void;
  setPresenceHandler?(
    handler: ((
      present: boolean,
      identity?: {
        deviceType: 'codex-micro' | 'creator-micro-2';
        isUsbConnection: boolean;
      },
    ) => void) | null,
  ): void;
  dispose(): Promise<void>;
}

type TaskCatalogLoader = () => Promise<WorkLouderCodexTaskCatalog | readonly string[]>;
type WorkerSessionLoader = (
  leadSessionIds: readonly string[],
) => Promise<Readonly<Record<string, readonly string[]>>>;

/** Keeps task LEDs, physical controls, and the settings projection on one state machine. */
export class WorkLouderCodexLightingController {
  private lastFrameKey = '';
  private slotSessionIds: string[] = [];
  private latestActivity: readonly WorkLouderCodexSessionActivity[] = [];
  private workersByLead: Readonly<Record<string, readonly string[]>> = {};
  private taskCatalog: WorkLouderCodexTaskCatalog = { sidebar: [], lastSent: [], options: [] };
  private agentSlots: WorkLouderCodexAgentSlotState[] = emptyAgentSlots();
  private slotRefreshVersion = 0;
  private taskSlotsEnabled = false;
  private slotRefreshTimer: Timer | null = null;
  private slotRefreshInFlight: Promise<void> | null = null;
  private slotRefreshInFlightVersion: number | null = null;
  private slotRefreshQueued = false;
  private settings: WorkLouderCodexSettings = createWorkLouderCodexDefaultSettings();
  private connectionStatus: WorkLouderCodexConnectionStatus = 'disabled';
  private connectionReason: WorkLouderCodexConnectionReason = null;
  private devicePresent: boolean | null = null;
  private device: WorkLouderCodexDeviceState = {
    ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
    inputMonitoringPermission: process.platform === 'darwin' ? 'unknown' : 'not-required',
  };
  private stateListeners = new Set<(state: WorkLouderCodexState) => void>();
  private autoDimTimer: Timer | null = null;
  private lightingDimmed = false;
  private windowRevealTimer: Timer | null = null;
  private lastBaseFrameKey = '';
  private pendingAgentKeyTap: { slot: number; at: number } | null = null;
  private encoderLongPressTimer: Timer | null = null;
  private encoderPressed = false;
  private encoderLongPressed = false;
  private joystickDirection: WorkLouderCodexAnalogDirection | null = null;
  private joystickReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollActive = false;
  private started = false;
  private layoutPreviewActive = false;
  private inputActionsEnabled = false;
  private joystickNeedsCenter = false;
  private voicePressed = false;
  /** First switch down under a 2U cap; its release ends the press. The other switch is ignored. */
  private mergeWinner = new Map<string, string>();

  constructor(
    private readonly sink: WorkLouderCodexLightingSink,
    private readonly activateSession: (sessionId: string, focus?: boolean) => void,
    private readonly loadTaskCatalog: TaskCatalogLoader = async () => [],
    private readonly dispatchRendererAction: (action: WorkLouderCodexRendererAction) => void = () =>
      undefined,
    private readonly dispatchPreviewInput: (input: WorkLouderCodexPreviewInput) => void = () =>
      undefined,
    private readonly loadWorkerSessions: WorkerSessionLoader = async () => ({}),
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.sink.setConnectionStatusHandler((status) => this.handleConnectionStatus(status));
    this.sink.setConnectionReasonHandler?.((reason) => this.handleConnectionReason(reason));
    this.sink.setDeviceStateHandler?.((device) => this.handleDeviceState(device));
    this.sink.setPresenceHandler?.((present, identity) =>
      this.handleDevicePresence(present, identity),
    );
    this.sink.setDeviceActivityHandler(() => this.handleDeviceActivity());
    this.sink.setDeviceEnabled?.(this.settings.deviceEnabled);
    if (this.sink.setHidInputHandler) {
      this.sink.setAgentKeyPressHandler(null);
      this.sink.setHidInputHandler((event) => this.handleHidInput(event));
      this.sink.setJoystickInputHandler?.((event) => this.handleJoystickInput(event));
    } else {
      this.sink.setAgentKeyPressHandler((slot) => this.handleAgentKeyPress(slot));
    }
  }

  updateSessionActivity(activity: readonly WorkLouderCodexSessionActivity[]): void {
    this.latestActivity = activity;
    if (this.settings.agentSource === 'priority') this.publishAgentSlots();
    this.updateLightingFrame(true);
    this.scheduleTaskSlotRefresh();
  }

  getState(): WorkLouderCodexState {
    return {
      connectionStatus: this.connectionStatus,
      connectionReason: this.connectionReason,
      devicePresent: this.devicePresent,
      device: { ...this.device },
      settings: cloneWorkLouderCodexSettings(this.settings),
      agentSlots: this.agentSlots.map((slot) => ({
        ...slot,
        action: cloneAction(slot.action),
      })),
      taskOptions: this.taskCatalog.options.map((task) => ({ ...task })),
      agentSlotCount: this.agentSlots.length,
    };
  }

  subscribeState(listener: (state: WorkLouderCodexState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }

  setLayoutPreviewActive(active: boolean): void {
    if (active && !this.layoutPreviewActive) this.releaseHeldHardwareGestures();
    this.layoutPreviewActive = active;
    if (!active) this.pendingAgentKeyTap = null;
  }

  applySettings(settings: WorkLouderCodexSettings): void {
    const turningOff = this.settings.deviceEnabled && !settings.deviceEnabled;
    this.settings = cloneWorkLouderCodexSettings(settings);
    this.pendingAgentKeyTap = null;
    this.lightingDimmed = false;
    this.clearWindowRevealTimer();
    if (turningOff) this.releaseHeldHardwareGestures();
    this.sink.setDeviceEnabled?.(settings.deviceEnabled);
    if (!settings.deviceEnabled) this.connectionStatus = 'disabled';
    this.publishAgentSlots();
    if (settings.layout.taskKeys) {
      this.sink.rebindCreatorKeymap?.(buildCreatorMicro2AgentKeymap(settings.layout.taskKeys));
    }
    const frame = this.updateLightingFrame();
    this.resetAutoDimTimer(frame);
    this.emitState();
  }

  /**
   * Flash a greeting when Cindy's window comes back after being hidden.
   *
   * Status lighting is paused for the duration so a running task's snake
   * does not overwrite the hello mid-sweep. Device activity or a settings
   * change also ends it early.
   */
  playWindowReveal(): void {
    this.lightingDimmed = false;
    this.clearWindowRevealTimer();
    // Same greeting twice in a row would otherwise be dropped as a duplicate.
    this.lastFrameKey = '';
    this.windowRevealTimer = setTimeout(() => {
      this.windowRevealTimer = null;
      this.updateLightingFrame();
    }, WINDOW_REVEAL_MS);
    this.windowRevealTimer.unref?.();
    const frame = this.updateLightingFrame();
    this.resetAutoDimTimer(frame);
  }

  async refreshTaskSlots(): Promise<void> {
    if (!this.taskSlotsEnabled) return;
    if (this.slotRefreshInFlight) {
      this.slotRefreshQueued = true;
      return this.slotRefreshInFlight;
    }

    const refreshVersion = ++this.slotRefreshVersion;
    const refresh = (async () => {
      try {
        const catalog = normalizeTaskCatalog(await this.loadTaskCatalog());
        if (!this.taskSlotsEnabled || refreshVersion !== this.slotRefreshVersion) return;
        this.taskCatalog = catalog;
        await this.refreshWorkerSessions(refreshVersion);
        if (!this.taskSlotsEnabled || refreshVersion !== this.slotRefreshVersion) return;
        this.publishAgentSlots();
        this.updateLightingFrame(true);
        this.emitState();
      } finally {
        if (this.slotRefreshInFlightVersion !== refreshVersion) return;
        this.slotRefreshInFlight = null;
        this.slotRefreshInFlightVersion = null;
        if (this.slotRefreshQueued) {
          this.slotRefreshQueued = false;
          this.scheduleTaskSlotRefresh(true);
        }
      }
    })();
    this.slotRefreshInFlight = refresh;
    this.slotRefreshInFlightVersion = refreshVersion;
    return refresh;
  }

  async resumeTaskSlots(): Promise<void> {
    this.start();
    this.clearSlotRefreshTimer();
    const refreshVersion = ++this.slotRefreshVersion;
    try {
      const catalog = normalizeTaskCatalog(await this.loadTaskCatalog());
      if (refreshVersion !== this.slotRefreshVersion) return;
      this.taskCatalog = catalog;
    } catch (error) {
      if (refreshVersion !== this.slotRefreshVersion) return;
      this.taskCatalog = { sidebar: [], lastSent: [], options: [] };
      this.taskSlotsEnabled = true;
      this.inputActionsEnabled = true;
      this.publishAgentSlots();
      this.updateLightingFrame(true);
      this.scheduleTaskSlotRefresh();
      throw error;
    }
    this.taskSlotsEnabled = true;
    this.inputActionsEnabled = true;
    await this.refreshWorkerSessions(refreshVersion);
    if (refreshVersion !== this.slotRefreshVersion) return;
    this.publishAgentSlots();
    this.updateLightingFrame(true);
    this.emitState();
  }

  suspendTaskSlots(): void {
    this.clearSlotRefreshTimer();
    this.clearEncoderLongPressTimer();
    this.encoderPressed = false;
    this.encoderLongPressed = false;
    this.releaseHeldHardwareGestures();
    this.slotRefreshVersion += 1;
    this.taskSlotsEnabled = false;
    this.inputActionsEnabled = false;
    this.slotRefreshQueued = false;
    this.taskCatalog = { sidebar: [], lastSent: [], options: [] };
    this.agentSlots = emptyAgentSlots();
    this.slotSessionIds = [];
    this.workersByLead = {};
    this.pendingAgentKeyTap = null;
    this.joystickNeedsCenter = this.joystickDirection !== null;
    this.joystickDirection = null;
    this.clearAutoDimTimer();
    this.clearWindowRevealTimer();
    this.lightingDimmed = false;
    this.updateLightingFrame();
    this.emitState();
  }

  dispose(): Promise<void> {
    this.clearSlotRefreshTimer();
    this.clearEncoderLongPressTimer();
    this.clearAutoDimTimer();
    this.clearWindowRevealTimer();
    this.releaseHeldHardwareGestures();
    this.slotRefreshVersion += 1;
    this.taskSlotsEnabled = false;
    this.inputActionsEnabled = false;
    this.slotRefreshQueued = false;
    this.started = false;
    this.sink.setAgentKeyPressHandler(null);
    this.sink.setHidInputHandler?.(null);
    this.sink.setJoystickInputHandler?.(null);
    this.sink.setDeviceStateHandler?.(null);
    this.sink.setPresenceHandler?.(null);
    this.sink.setConnectionReasonHandler?.(null);
    this.sink.setDeviceActivityHandler(null);
    this.sink.setConnectionStatusHandler(null);
    this.stateListeners.clear();
    return this.sink.dispose();
  }

  private handleHidInput(event: WorkLouderCodexHidEvent): void {
    this.handleDeviceActivity();
    if (event.key.startsWith('ENC')) {
      this.emitEncoderPreview(event);
    } else {
      this.emitKeyPreview(this.previewPartForEvent(event.key), event.act);
    }
    if (this.layoutPreviewActive) return;
    if (!this.inputActionsEnabled) {
      this.releaseHeldVoiceFromEvent(event);
      return;
    }
    const creatorRole = this.settings.layout.taskKeys
      ? resolveWorkLouderHidRole(event.key, this.settings.layout.taskKeys, this.device.deviceType)
      : null;
    if (creatorRole?.role === 'task') {
      if (event.act === 1) this.handleAgentKeyPress(creatorRole.slot);
      return;
    }
    if (creatorRole?.role === 'command') {
      const merge = workLouderMergeForKey(
        workLouderLayoutMerges(this.settings.layout),
        creatorRole.physical,
      );
      this.handleCommandKeyInput(event, merge?.origin ?? creatorRole.physical);
      return;
    }
    const agentMatch = /^AG(0[0-9]|1[0-2])$/.exec(event.key);
    if (agentMatch) {
      if (event.act === 1) this.handleAgentKeyPress(Number(agentMatch[1]));
      return;
    }
    if (event.key.startsWith('ENC')) {
      this.handleEncoderInput(event);
      return;
    }
    if (/^ACT(?:0[6-9]|1[0-2])$/.test(event.key)) this.handleCommandKeyInput(event);
  }

  private previewPartForEvent(key: string): WorkLouderCodexPreviewPart | null {
    const merge = workLouderMergeForKey(workLouderLayoutMerges(this.settings.layout), key);
    if (merge) return merge.origin as WorkLouderCodexPreviewPart;
    if (this.settings.layout.taskKeys) {
      const role = resolveWorkLouderHidRole(
        key,
        this.settings.layout.taskKeys,
        this.device.deviceType,
      );
      if (role) return role.physical as WorkLouderCodexPreviewPart;
    }
    return previewPartForHidKey(key);
  }

  private handleAgentKeyPress(slot: number): void {
    this.handleDeviceActivity();
    if (!this.taskSlotsEnabled || slot < 0 || slot >= this.agentSlots.length) return;
    const action = this.agentSlots[slot]?.action;
    if (!action) {
      this.dispatchRendererAction({ type: 'command', commandId: 'newTask' });
      void this.refreshTaskSlots().catch(() => undefined);
      return;
    }
    if (action.type === 'task') {
      const now = Date.now();
      const previous = this.pendingAgentKeyTap;
      const isDoubleTap = previous?.slot === slot && now - previous.at <= AGENT_KEY_DOUBLE_TAP_MS;
      this.pendingAgentKeyTap = isDoubleTap ? null : { slot, at: now };
      this.activateSession(action.sessionId, this.settings.singleTapAgentKeys || isDoubleTap);
    } else {
      this.pendingAgentKeyTap = null;
      this.executeAction(action, true);
    }
    void this.refreshTaskSlots().catch(() => {
      // The current press always uses the published mapping; refresh affects later presses only.
    });
  }

  private handleCommandKeyInput(
    event: WorkLouderCodexHidEvent,
    physical?: string,
  ): void {
    const slot = physical ?? this.commandSlotForKey(event.key);
    if (!slot) return;
    const assignment = isWorkLouderCreatorProgrammableKey(slot)
      ? creatorCommandAssignment(this.settings.layout, slot)
      : this.settings.layout.slots[slot as WorkLouderCodexCommandSlot];
    const merge = workLouderMergeForKey(workLouderLayoutMerges(this.settings.layout), slot);
    if (merge && (event.act === 0 || event.act === 1)) {
      if (!this.claimMergeSwitch(merge.origin, event.key, event.act === 1)) return;
    }
    // Voice speaks through a printed MIC keycap (Codex) or a bound voice
    // action (Creator's blank caps). A short click starts and stays recording.
    if (isWorkLouderCodexVoiceAssignment(assignment)) {
      if (event.act === 1) {
        if (this.voicePressed) return;
        this.voicePressed = true;
        this.dispatchRendererAction({ type: 'voice', phase: 'press' });
      } else if (event.act === 0 && this.voicePressed) {
        this.voicePressed = false;
        this.dispatchRendererAction({ type: 'voice', phase: 'release' });
      }
      return;
    }
    if (event.act !== 1) return;
    const action =
      assignment.action ?? WORKLOUDER_CODEX_KEYCAP_ACTIONS[assignment.keycapId] ?? null;
    if (action) this.executeAction(action, true);
  }

  private commandSlotForKey(key: string): string | null {
    const merge = workLouderMergeForKey(workLouderLayoutMerges(this.settings.layout), key);
    if (merge) return merge.origin;
    if (isWorkLouderCreatorProgrammableKey(key)) return key;
    return /^ACT(?:0[6-9]|1[0-2])$/.test(key) ? key : null;
  }

  private handleEncoderInput(event: WorkLouderCodexHidEvent): void {
    if (event.act === 2 && (event.key === 'ENC_CW' || event.key === 'ENC_CC')) {
      const clockwise = event.key === 'ENC_CW';
      switch (this.settings.layout.encoderMode) {
        case 'custom':
          this.executeNullableAction(
            this.settings.layout.encoder[clockwise ? 'right' : 'left'],
            true,
          );
          break;
        case 'reasoning':
          this.dispatchRendererAction({
            type: 'command',
            commandId: clockwise
              ? 'composer.decreaseReasoningEffort'
              : 'composer.increaseReasoningEffort',
          });
          break;
        case 'conversation-scroll':
          this.dispatchRendererAction({
            type: 'command',
            commandId: clockwise ? 'conversation.scrollUp' : 'conversation.scrollDown',
          });
          break;
        case 'session-switch':
          // The knob follows the list on screen: left walks up the sidebar,
          // right walks down. Note ENC_CW is the *up* direction on this
          // hardware — `conversation-scroll` above maps it to scrollUp for the
          // same reason. The firmware's naming is not a guide to which way the
          // user is actually turning.
          this.dispatchRendererAction({
            type: 'command',
            commandId: clockwise ? 'session.selectPrevious' : 'session.selectNext',
          });
          break;
        case 'composer-navigation':
          this.dispatchRendererAction({
            type: 'keyboard',
            key: clockwise ? 'ArrowUp' : 'ArrowDown',
          });
          break;
      }
      return;
    }
    if (event.act === 1 && !this.encoderPressed) {
      this.encoderPressed = true;
      this.encoderLongPressed = false;
      this.clearEncoderLongPressTimer();
      this.encoderLongPressTimer = setTimeout(() => {
        this.encoderLongPressTimer = null;
        if (!this.encoderPressed) return;
        this.encoderLongPressed = true;
        if (this.settings.layout.encoderMode === 'custom') {
          this.executeNullableAction(this.settings.layout.encoder.longPress, true);
        } else {
          this.dispatchRendererAction({ type: 'command', commandId: 'settings' });
        }
      }, ENCODER_LONG_PRESS_MS);
      this.encoderLongPressTimer.unref?.();
      return;
    }
    if (event.act !== 0 || !this.encoderPressed) return;
    this.encoderPressed = false;
    this.clearEncoderLongPressTimer();
    if (this.encoderLongPressed) {
      this.encoderLongPressed = false;
      return;
    }
    switch (this.settings.layout.encoderMode) {
      case 'custom':
        this.executeNullableAction(this.settings.layout.encoder.click, true);
        break;
      case 'conversation-scroll':
        this.dispatchRendererAction({ type: 'command', commandId: 'conversation.scrollBottom' });
        break;
      case 'session-switch':
      case 'composer-navigation':
      case 'reasoning':
        this.dispatchRendererAction({ type: 'keyboard', key: 'Enter' });
        break;
    }
  }

  private handleJoystickInput(event: WorkLouderCodexJoystickEvent): void {
    this.handleDeviceActivity();
    const direction = joystickDirection(event);
    this.emitStickPreview(event);
    if (this.joystickNeedsCenter && !direction) {
      this.joystickNeedsCenter = false;
    }
    if (this.layoutPreviewActive || !this.inputActionsEnabled) return;
    if (this.joystickNeedsCenter) return;

    // Scrolling follows the stick continuously — held means keep scrolling, and
    // pushing further means faster — so it cannot go through the one-shot path
    // below, which only fires as the stick crosses into a direction.
    const scrollDirection = direction ? this.scrollDirectionFor(direction) : null;
    if (scrollDirection) {
      this.joystickDirection = direction;
      this.armJoystickReleaseWatchdog();
      this.scrollActive = true;
      this.dispatchRendererAction({
        type: 'scroll',
        direction: scrollDirection,
        intensity: normalizeJoystickIntensity(event.distance),
      });
      return;
    }

    // Anything else (including the stick returning to centre) ends a scroll.
    this.stopJoystickScroll();

    if (direction === this.joystickDirection) return;
    this.joystickDirection = direction;
    if (!direction) return;
    this.executeNullableAction(this.settings.layout.analogStick[direction], true);
  }

  /**
   * The scroll direction this stick axis drives, or null if it is bound to
   * something else. Rebinding up/down to an ordinary command keeps the
   * one-shot behaviour — only actual scrolling wants to repeat.
   */
  private scrollDirectionFor(direction: WorkLouderCodexAnalogDirection): 'up' | 'down' | null {
    const action = this.settings.layout.analogStick[direction];
    if (action?.type !== 'command') return null;
    if (action.commandId === 'conversation.scrollUp') return 'up';
    if (action.commandId === 'conversation.scrollDown') return 'down';
    return null;
  }

  /**
   * Stop scrolling if the stick goes quiet.
   *
   * The SDK hook is `onJoystickMove`, so a stick held perfectly still may stop
   * reporting entirely — and a release event can be missed outright if the
   * device sleeps or is unplugged mid-push. Without this the page would scroll
   * forever.
   */
  private armJoystickReleaseWatchdog(): void {
    if (this.joystickReleaseTimer) clearTimeout(this.joystickReleaseTimer);
    this.joystickReleaseTimer = setTimeout(() => {
      this.joystickReleaseTimer = null;
      this.joystickDirection = null;
      this.stopJoystickScroll();
    }, JOYSTICK_RELEASE_TIMEOUT_MS);
    this.joystickReleaseTimer.unref?.();
  }

  private releaseHeldVoiceFromEvent(event: WorkLouderCodexHidEvent): void {
    if (event.act !== 0) return;
    const creatorRole = this.settings.layout.taskKeys
      ? resolveWorkLouderHidRole(event.key, this.settings.layout.taskKeys, this.device.deviceType)
      : null;
    const slot =
      creatorRole?.role === 'command'
        ? creatorRole.physical
        : this.commandSlotForKey(event.key);
    if (!slot) return;
    const assignment = isWorkLouderCreatorProgrammableKey(slot)
      ? creatorCommandAssignment(this.settings.layout, slot)
      : this.settings.layout.slots[slot as WorkLouderCodexCommandSlot];
    if (!isWorkLouderCodexVoiceAssignment(assignment)) return;
    this.releaseHeldVoice();
  }

  private releaseHeldHardwareGestures(): void {
    this.stopJoystickScroll();
    this.releaseHeldVoice();
    this.mergeWinner.clear();
  }

  private releaseHeldVoice(): void {
    if (!this.voicePressed) return;
    this.voicePressed = false;
    this.mergeWinner.clear();
    this.dispatchRendererAction({ type: 'voice', phase: 'release' });
  }

  /** First switch under a 2U cap wins; its release counts. The other switch is dropped. */
  private claimMergeSwitch(origin: string, hidKey: string, down: boolean): boolean {
    const winner = this.mergeWinner.get(origin);
    if (down) {
      if (winner) return false;
      this.mergeWinner.set(origin, hidKey);
      return true;
    }
    if (winner !== hidKey) return false;
    this.mergeWinner.delete(origin);
    return true;
  }

  private stopJoystickScroll(): void {
    if (this.joystickReleaseTimer) {
      clearTimeout(this.joystickReleaseTimer);
      this.joystickReleaseTimer = null;
    }
    if (!this.scrollActive) return;
    this.scrollActive = false;
    this.dispatchRendererAction({ type: 'scroll-stop' });
  }

  private executeNullableAction(action: WorkLouderCodexAction | null, focusTask: boolean): void {
    if (action) this.executeAction(action, focusTask);
  }

  private executeAction(action: WorkLouderCodexAction, focusTask: boolean): void {
    if (action.type === 'task') {
      this.activateSession(action.sessionId, focusTask);
    } else if (action.type === 'keycap') {
      const resolved = WORKLOUDER_CODEX_KEYCAP_ACTIONS[action.keycapId];
      if (resolved) this.executeAction(resolved, focusTask);
    } else if (action.type === 'voice') {
      // Voice is hold-to-talk: it is driven by key press/release events in
      // handleCommandKeyInput, never by a one-shot action execution.
    } else {
      this.dispatchRendererAction(action);
    }
  }

  private publishAgentSlots(): void {
    const actions = this.agentActionsForCurrentSource();
    const titleById = new Map(
      this.taskCatalog.options.map((task) => [task.id, task.title] as const),
    );
    const slotCount = this.settings.layout.taskKeys?.length ?? WORKLOUDER_CODEX_AGENT_SLOT_COUNT;
    this.agentSlots = Array.from({ length: slotCount }, (_, slot) => {
      const action = actions[slot] ?? null;
      const sessionId = action?.type === 'task' ? action.sessionId : null;
      return {
        slot,
        sessionId,
        title: sessionId ? (titleById.get(sessionId) ?? sessionId) : actionTitle(action),
        action: cloneAction(action),
      };
    });
    const sessionIdsByTaskSlot = this.agentSlots.map((slot) => slot.sessionId ?? '');
    const taskKeys = normalizeWorkLouderCreatorTaskKeys(this.settings.layout.taskKeys);
    if (this.device.deviceType === 'codex-micro') {
      this.slotSessionIds = WORKLOUDER_HID_AG_CODES.slice(0, WORKLOUDER_CODEX_AGENT_SLOT_COUNT).map(
        (physical) => {
          if (!isWorkLouderCreatorProgrammableKey(physical)) return '';
          const slot = taskKeys.indexOf(physical);
          return slot >= 0 ? (sessionIdsByTaskSlot[slot] ?? '') : '';
        },
      );
      return;
    }
    this.slotSessionIds = Array.from(
      { length: WORKLOUDER_CODEX_AGENT_SLOT_COUNT },
      (_, slot) => sessionIdsByTaskSlot[slot] ?? '',
    );
  }

  private agentActionsForCurrentSource(): Array<WorkLouderCodexAction | null> {
    const slotCount = this.settings.layout.taskKeys?.length ?? WORKLOUDER_CODEX_AGENT_SLOT_COUNT;
    if (this.settings.agentSource === 'custom') {
      return Array.from({ length: slotCount }, (_, slot) => {
        if (slot < this.settings.customAgentKeys.length) {
          return cloneAction(this.settings.customAgentKeys[slot] ?? null);
        }
        const task = this.taskCatalog.options[slot];
        return task ? { type: 'task', sessionId: task.id } : null;
      });
    }
    const primary =
      this.settings.agentSource === 'last-sent'
        ? this.taskCatalog.lastSent
        : this.settings.agentSource === 'priority'
          ? this.priorityTasks()
          : this.taskCatalog.sidebar;
    const used = new Set(primary.map((task) => task.id));
    const filler = this.taskCatalog.options.filter((task) => !used.has(task.id));
    const tasks = [...primary, ...filler];
    return Array.from({ length: slotCount }, (_, slot) => {
      const task = tasks[slot];
      return task ? { type: 'task', sessionId: task.id } : null;
    });
  }

  private priorityTasks(): WorkLouderCodexTaskOption[] {
    const optionById = new Map(this.taskCatalog.options.map((task) => [task.id, task] as const));
    const recentRank = new Map(
      this.taskCatalog.options.map((task, index) => [task.id, index] as const),
    );
    const prioritized = this.lightingActivity()
      .filter((activity) => optionById.has(activity.sessionId))
      .toSorted((left, right) => {
        const scoreDiff = activityPriority(right) - activityPriority(left);
        return (
          scoreDiff ||
          (recentRank.get(left.sessionId) ?? 999) - (recentRank.get(right.sessionId) ?? 999)
        );
      })
      .map((activity) => optionById.get(activity.sessionId)!)
      .filter((task, index, rows) => rows.findIndex((row) => row.id === task.id) === index);
    const included = new Set(prioritized.map((task) => task.id));
    return [...prioritized, ...this.taskCatalog.sidebar.filter((task) => !included.has(task.id))];
  }

  private lightingThreadCount(): number {
    return WORKLOUDER_CODEX_AGENT_SLOT_COUNT;
  }

  private lightingActivity(): WorkLouderCodexSessionActivity[] {
    return foldOrcaWorkerActivityOntoLeads(this.latestActivity, this.workersByLead);
  }

  private async refreshWorkerSessions(refreshVersion: number): Promise<void> {
    const leadIds = catalogLeadSessionIds(this.taskCatalog);
    const workersByLead = await this.loadWorkerSessions(leadIds);
    if (refreshVersion !== this.slotRefreshVersion) return;
    this.workersByLead = workersByLead;
  }

  private updateLightingFrame(wakeOnBaseFrameChange = false): WorkLouderCodexLightingFrame {
    const threadCount = this.lightingThreadCount();
    const projected = createWorkLouderCodexLightingFrame(
      this.lightingActivity(),
      this.slotSessionIds,
      threadCount,
    );
    const baseFrame = workLouderShouldMuteKeyZone(this.settings.layout.taskKeys)
      ? muteWorkLouderCodexKeyZone(projected)
      : projected;
    const baseFrameKey = JSON.stringify(baseFrame);
    const baseFrameChanged = baseFrameKey !== this.lastBaseFrameKey;
    this.lastBaseFrameKey = baseFrameKey;
    if (wakeOnBaseFrameChange && baseFrameChanged) this.lightingDimmed = false;
    const brightnessAdjusted = applyWorkLouderCodexLightingBrightness(
      baseFrame,
      this.settings.lightingBrightness,
    );
    const overlay = this.windowRevealTimer
      ? applyWorkLouderCodexLightingBrightness(
          createWorkLouderCodexWindowRevealFrame(threadCount),
          this.settings.lightingBrightness,
        )
      : null;
    const frame = this.lightingDimmed
      ? createWorkLouderCodexOffFrame(threadCount)
      : (overlay ?? brightnessAdjusted);
    const frameKey = JSON.stringify(frame);
    if (frameKey !== this.lastFrameKey) {
      this.lastFrameKey = frameKey;
      this.sink.update(frame);
    }
    if (wakeOnBaseFrameChange && baseFrameChanged) this.resetAutoDimTimer(brightnessAdjusted);
    return brightnessAdjusted;
  }

  private scheduleTaskSlotRefresh(immediate = false): void {
    if (!this.taskSlotsEnabled) return;
    if (immediate) this.clearSlotRefreshTimer();
    if (this.slotRefreshTimer) return;
    if (immediate) {
      void this.refreshTaskSlots().catch(() => undefined);
      return;
    }
    this.slotRefreshTimer = setTimeout(() => {
      this.slotRefreshTimer = null;
      void this.refreshTaskSlots().catch(() => undefined);
    }, TASK_SLOT_REFRESH_DEBOUNCE_MS);
  }

  private clearSlotRefreshTimer(): void {
    if (!this.slotRefreshTimer) return;
    clearTimeout(this.slotRefreshTimer);
    this.slotRefreshTimer = null;
  }

  private clearEncoderLongPressTimer(): void {
    if (!this.encoderLongPressTimer) return;
    clearTimeout(this.encoderLongPressTimer);
    this.encoderLongPressTimer = null;
  }

  private handleConnectionStatus(status: WorkLouderCodexConnectionStatus): void {
    if (!this.settings.deviceEnabled && status !== 'disabled') return;
    if (status === this.connectionStatus) return;
    this.connectionStatus = status;
    if (status !== 'connected') this.releaseHeldHardwareGestures();
    if (status === 'connected') {
      this.connectionReason = null;
      this.devicePresent = true;
      if (process.platform === 'darwin') {
        this.device = { ...this.device, inputMonitoringPermission: 'granted' };
      }
    } else if (status === 'not-detected') {
      this.devicePresent = false;
      // Drop live telemetry so the settings card does not keep a stale battery
      // next to "Not detected". Keep firmware identity: occupancy keys off it,
      // and wiping it here would disable HID on the next accessories sync.
      this.device = {
        ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
        deviceType: this.device.deviceType,
        isUsbConnection: this.device.isUsbConnection,
        inputMonitoringPermission: this.device.inputMonitoringPermission,
      };
    } else if (status !== 'disabled') {
      // HID contention reports as `error` / `device-in-use`. Occupancy keys
      // off firmware identity, so wiping it here would disable the host and
      // restart the bind loop. Drop live telemetry only.
      this.device = {
        ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
        deviceType: this.device.deviceType,
        isUsbConnection: this.device.isUsbConnection,
        inputMonitoringPermission: this.device.inputMonitoringPermission,
      };
    }
    this.emitState();
  }

  private handleConnectionReason(reason: WorkLouderCodexConnectionReason): void {
    if (reason === this.connectionReason) return;
    this.connectionReason = reason;
    if (reason === 'permission-required' && process.platform === 'darwin') {
      this.device = { ...this.device, inputMonitoringPermission: 'denied' };
    }
    this.emitState();
  }

  private handleDeviceState(device: WorkLouderCodexDeviceState): void {
    const previousType = this.device.deviceType;
    this.device = { ...device };
    if (device.deviceType) this.devicePresent = true;
    if (previousType !== this.device.deviceType) {
      this.publishAgentSlots();
      this.updateLightingFrame();
    }
    this.emitState();
  }

  private handleDevicePresence(
    present: boolean,
    identity?: {
      deviceType: 'codex-micro' | 'creator-micro-2';
      isUsbConnection: boolean;
    },
  ): void {
    const previousType = this.device.deviceType;
    this.devicePresent = present;
    if (!present) {
      this.device = {
        ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
        inputMonitoringPermission: this.device.inputMonitoringPermission,
      };
    } else if (identity) {
      this.device = {
        ...this.device,
        deviceType: identity.deviceType,
        isUsbConnection: identity.isUsbConnection,
      };
    }
    if (previousType !== this.device.deviceType) {
      this.publishAgentSlots();
      this.updateLightingFrame();
    }
    this.emitState();
  }

  private handleDeviceActivity(): void {
    this.lightingDimmed = false;
    this.clearWindowRevealTimer();
    const frame = this.updateLightingFrame();
    this.resetAutoDimTimer(frame);
  }

  private resetAutoDimTimer(frame: WorkLouderCodexLightingFrame): void {
    this.clearAutoDimTimer();
    const delayMs = workLouderCodexAutoDimMs(this.settings.lightingAutoDim);
    if (delayMs === null || isWorkLouderCodexLightingFrameOff(frame)) return;
    this.autoDimTimer = setTimeout(() => {
      this.autoDimTimer = null;
      this.lightingDimmed = true;
      this.updateLightingFrame();
    }, delayMs);
    this.autoDimTimer.unref?.();
  }

  private clearAutoDimTimer(): void {
    if (!this.autoDimTimer) return;
    clearTimeout(this.autoDimTimer);
    this.autoDimTimer = null;
  }

  private clearWindowRevealTimer(): void {
    if (!this.windowRevealTimer) return;
    clearTimeout(this.windowRevealTimer);
    this.windowRevealTimer = null;
  }

  private emitState(): void {
    const state = this.getState();
    for (const listener of this.stateListeners) listener(state);
  }

  private emitKeyPreview(part: WorkLouderCodexPreviewPart | null, act: number): void {
    if (!part) return;
    if (act !== 0 && act !== 1) return;
    this.dispatchPreviewInput({ part, pressed: act === 1 });
  }

  private emitEncoderPreview(event: WorkLouderCodexHidEvent): void {
    if (event.act === 2 && (event.key === 'ENC_CW' || event.key === 'ENC_CC')) {
      this.dispatchPreviewInput({
        part: 'encoder',
        pressed: this.encoderPressed,
        turn: event.key === 'ENC_CW' ? 1 : -1,
      });
      return;
    }
    if (event.act !== 0 && event.act !== 1) return;
    this.dispatchPreviewInput({ part: 'encoder', pressed: event.act === 1 });
  }

  private emitStickPreview(event: WorkLouderCodexJoystickEvent): void {
    this.dispatchPreviewInput({
      part: 'analog',
      pressed: event.distance > 0,
      angle: event.angle,
      distance: event.distance,
    });
  }
}

function previewPartForHidKey(key: string): WorkLouderCodexPreviewPart | null {
  if (/^AG0[0-5]$/.test(key)) return key as WorkLouderCodexPreviewPart;
  if (key.startsWith('ENC')) return 'encoder';
  if (/^ACT(?:0[6-9]|1[0-2])$/.test(key)) return key as WorkLouderCodexPreviewPart;
  return null;
}

function emptyAgentSlots(): WorkLouderCodexAgentSlotState[] {
  return Array.from({ length: WORKLOUDER_CODEX_AGENT_SLOT_COUNT }, (_, slot) => ({
    slot,
    sessionId: null,
    title: null,
    action: null,
  }));
}

function catalogLeadSessionIds(catalog: WorkLouderCodexTaskCatalog): string[] {
  return [
    ...new Set(
      [...catalog.options, ...catalog.sidebar, ...catalog.lastSent]
        .map((task) => task.id)
        .filter(Boolean),
    ),
  ];
}

function normalizeTaskCatalog(
  value: WorkLouderCodexTaskCatalog | readonly string[],
): WorkLouderCodexTaskCatalog {
  if (isTaskCatalog(value)) {
    return {
      sidebar: value.sidebar.map((task) => ({ ...task })),
      lastSent: value.lastSent.map((task) => ({ ...task })),
      options: value.options.map((task) => ({ ...task })),
    };
  }
  const options = value.map((id) => ({ id, title: id, pinned: false }));
  return {
    sidebar: options.slice(0, WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS.length),
    lastSent: options.slice(0, WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS.length),
    options,
  };
}

function isTaskCatalog(
  value: WorkLouderCodexTaskCatalog | readonly string[],
): value is WorkLouderCodexTaskCatalog {
  return !Array.isArray(value);
}

function cloneAction(action: WorkLouderCodexAction | null): WorkLouderCodexAction | null {
  return action ? { ...action } : null;
}

function actionTitle(action: WorkLouderCodexAction | null): string | null {
  if (!action) return null;
  switch (action.type) {
    case 'command':
      return action.commandId;
    case 'skill':
      return action.name;
    case 'keycap':
      return action.keycapId;
    case 'composer-text':
      return action.text;
    case 'external-url':
      return action.url;
    case 'voice':
      return null;
    case 'task':
      return action.sessionId;
  }
}

function activityPriority(activity: WorkLouderCodexSessionActivity): number {
  if (activity.phase === 'needs-interaction') return 5;
  if (activity.attention) return 4;
  if (activity.phase === 'error') return 3;
  if (activity.phase === 'running') return 2;
  return 1;
}

function joystickDirection(
  event: WorkLouderCodexJoystickEvent,
): WorkLouderCodexAnalogDirection | null {
  if (event.distance < WORKLOUDER_JOYSTICK_ACTIVATION_DISTANCE) return null;
  if (event.angle >= 0.625 && event.angle < 0.875) return 'up';
  if (event.angle >= 0.125 && event.angle < 0.375) return 'down';
  if (event.angle >= 0.375 && event.angle < 0.625) return 'left';
  return 'right';
}
