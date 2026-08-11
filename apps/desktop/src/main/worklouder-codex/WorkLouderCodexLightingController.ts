import type { AgentIslandSessionActivity } from '../../shared/agentIsland.js';
import {
  WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
  WORKLOUDER_CODEX_DEFAULT_SETTINGS,
  workLouderCodexAutoDimMs,
  type WorkLouderCodexConnectionStatus,
  type WorkLouderCodexSettings,
  type WorkLouderCodexState,
} from '../../shared/workLouderCodex.js';
import {
  applyWorkLouderCodexLightingBrightness,
  createWorkLouderCodexOffFrame,
  createWorkLouderCodexLightingFrame,
  isWorkLouderCodexLightingFrameOff,
  type WorkLouderCodexLightingFrame,
} from './protocol.js';

const TASK_SLOT_REFRESH_DEBOUNCE_MS = 250;
const AGENT_KEY_DOUBLE_TAP_MS = 500;
type Timer = ReturnType<typeof setTimeout>;

export interface WorkLouderCodexLightingSink {
  update(frame: WorkLouderCodexLightingFrame): void;
  setAgentKeyPressHandler(handler: ((slot: number) => void) | null): void;
  setDeviceActivityHandler(handler: (() => void) | null): void;
  setConnectionStatusHandler(
    handler: ((status: WorkLouderCodexConnectionStatus) => void) | null,
  ): void;
  dispose(): Promise<void>;
}

/** Keeps task LEDs and their physical key targets on the same six-slot projection. */
export class WorkLouderCodexLightingController {
  private lastFrameKey = '';
  private slotSessionIds: string[] = [];
  private latestActivity: readonly AgentIslandSessionActivity[] = [];
  private slotRefreshVersion = 0;
  private taskSlotsEnabled = false;
  private slotRefreshTimer: Timer | null = null;
  private slotRefreshInFlight: Promise<void> | null = null;
  private slotRefreshInFlightVersion: number | null = null;
  private slotRefreshQueued = false;
  private settings: WorkLouderCodexSettings = { ...WORKLOUDER_CODEX_DEFAULT_SETTINGS };
  private connectionStatus: WorkLouderCodexConnectionStatus = 'connecting';
  private stateListeners = new Set<(state: WorkLouderCodexState) => void>();
  private autoDimTimer: Timer | null = null;
  private lightingDimmed = false;
  private lastBaseFrameKey = '';
  private pendingAgentKeyTap: { slot: number; at: number } | null = null;

  constructor(
    private readonly sink: WorkLouderCodexLightingSink,
    private readonly activateSession: (sessionId: string) => void,
    private readonly loadSlotSessionIds: () => Promise<readonly string[]> = async () => [],
  ) {
    sink.setConnectionStatusHandler((status) => this.handleConnectionStatus(status));
    sink.setDeviceActivityHandler(() => this.handleDeviceActivity());
    sink.setAgentKeyPressHandler((slot) => this.handleAgentKeyPress(slot));
  }

  updateSessionActivity(activity: readonly AgentIslandSessionActivity[]): void {
    this.latestActivity = activity;
    this.updateLightingFrame(true);
    this.scheduleTaskSlotRefresh();
  }

  getState(): WorkLouderCodexState {
    return {
      connectionStatus: this.connectionStatus,
      settings: { ...this.settings },
      agentSource: 'recent',
      agentSlotCount: WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
    };
  }

  subscribeState(listener: (state: WorkLouderCodexState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }

  applySettings(settings: WorkLouderCodexSettings): void {
    this.settings = { ...settings };
    this.pendingAgentKeyTap = null;
    this.lightingDimmed = false;
    const frame = this.updateLightingFrame();
    this.resetAutoDimTimer(frame);
    this.emitState();
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
        const sessionIds = await this.loadSlotSessionIds();
        if (!this.taskSlotsEnabled || refreshVersion !== this.slotRefreshVersion) return;
        this.slotSessionIds = sessionIds.slice(0, WORKLOUDER_CODEX_AGENT_SLOT_COUNT);
        this.updateLightingFrame(true);
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
    this.clearSlotRefreshTimer();
    const refreshVersion = ++this.slotRefreshVersion;
    try {
      const sessionIds = await this.loadSlotSessionIds();
      if (refreshVersion !== this.slotRefreshVersion) return;
      this.slotSessionIds = sessionIds.slice(0, WORKLOUDER_CODEX_AGENT_SLOT_COUNT);
    } catch (error) {
      if (refreshVersion !== this.slotRefreshVersion) return;
      // Keep the keyboard alive with an empty mapping. Later activity updates will retry
      // the account-scoped query instead of leaving the keys disabled for this login.
      this.slotSessionIds = [];
      this.taskSlotsEnabled = true;
      this.updateLightingFrame(true);
      this.scheduleTaskSlotRefresh();
      throw error;
    }
    this.taskSlotsEnabled = true;
    this.updateLightingFrame(true);
  }

  suspendTaskSlots(): void {
    this.clearSlotRefreshTimer();
    this.slotRefreshVersion += 1;
    this.taskSlotsEnabled = false;
    this.slotRefreshQueued = false;
    this.slotSessionIds = [];
    this.pendingAgentKeyTap = null;
    this.clearAutoDimTimer();
    this.lightingDimmed = false;
    this.updateLightingFrame();
  }

  private updateLightingFrame(wakeOnBaseFrameChange = false): WorkLouderCodexLightingFrame {
    const baseFrame = createWorkLouderCodexLightingFrame(this.latestActivity, this.slotSessionIds);
    const baseFrameKey = JSON.stringify(baseFrame);
    const baseFrameChanged = baseFrameKey !== this.lastBaseFrameKey;
    this.lastBaseFrameKey = baseFrameKey;
    if (wakeOnBaseFrameChange && baseFrameChanged) {
      this.lightingDimmed = false;
    }
    const brightnessAdjusted = applyWorkLouderCodexLightingBrightness(
      baseFrame,
      this.settings.lightingBrightness,
    );
    const frame = this.lightingDimmed ? createWorkLouderCodexOffFrame() : brightnessAdjusted;
    const frameKey = JSON.stringify(frame);
    if (frameKey !== this.lastFrameKey) {
      this.lastFrameKey = frameKey;
      this.sink.update(frame);
    }
    if (wakeOnBaseFrameChange && baseFrameChanged) this.resetAutoDimTimer(brightnessAdjusted);
    return brightnessAdjusted;
  }

  dispose(): Promise<void> {
    this.clearSlotRefreshTimer();
    this.clearAutoDimTimer();
    this.slotRefreshVersion += 1;
    this.taskSlotsEnabled = false;
    this.slotRefreshQueued = false;
    this.sink.setAgentKeyPressHandler(null);
    this.sink.setDeviceActivityHandler(null);
    this.sink.setConnectionStatusHandler(null);
    this.stateListeners.clear();
    return this.sink.dispose();
  }

  private handleAgentKeyPress(slot: number): void {
    this.handleDeviceActivity();
    if (!this.taskSlotsEnabled) return;
    if (!this.settings.singleTapAgentKeys) {
      const now = Date.now();
      const previous = this.pendingAgentKeyTap;
      this.pendingAgentKeyTap = { slot, at: now };
      if (!previous || previous.slot !== slot || now - previous.at > AGENT_KEY_DOUBLE_TAP_MS)
        return;
      this.pendingAgentKeyTap = null;
    }
    const sessionId = this.slotSessionIds[slot];
    if (sessionId) this.activateSession(sessionId);
    void this.refreshTaskSlots().catch(() => {
      // The pressed key always uses the published mapping; refresh only affects later presses.
    });
  }

  private scheduleTaskSlotRefresh(immediate = false): void {
    if (!this.taskSlotsEnabled) return;
    if (immediate) this.clearSlotRefreshTimer();
    if (this.slotRefreshTimer) return;
    if (immediate) {
      void this.refreshTaskSlots().catch(() => {
        // Keep the last published mapping if the account database is temporarily unavailable.
      });
      return;
    }
    this.slotRefreshTimer = setTimeout(() => {
      this.slotRefreshTimer = null;
      void this.refreshTaskSlots().catch(() => {
        // Keep the last published mapping if the account database is temporarily unavailable.
      });
    }, TASK_SLOT_REFRESH_DEBOUNCE_MS);
  }

  private clearSlotRefreshTimer(): void {
    if (!this.slotRefreshTimer) return;
    clearTimeout(this.slotRefreshTimer);
    this.slotRefreshTimer = null;
  }

  private handleConnectionStatus(status: WorkLouderCodexConnectionStatus): void {
    if (status === this.connectionStatus) return;
    this.connectionStatus = status;
    this.emitState();
  }

  private handleDeviceActivity(): void {
    this.lightingDimmed = false;
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

  private emitState(): void {
    const state = this.getState();
    for (const listener of this.stateListeners) listener(state);
  }
}
