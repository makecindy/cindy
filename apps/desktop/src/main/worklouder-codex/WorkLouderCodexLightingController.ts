import type { AgentIslandSessionActivity } from '../../shared/agentIsland.js';
import {
  createWorkLouderCodexLightingFrame,
  WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
  type WorkLouderCodexLightingFrame,
} from './protocol.js';

const TASK_SLOT_REFRESH_DEBOUNCE_MS = 250;
type Timer = ReturnType<typeof setTimeout>;

export interface WorkLouderCodexLightingSink {
  update(frame: WorkLouderCodexLightingFrame): void;
  setAgentKeyPressHandler(handler: ((slot: number) => void) | null): void;
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

  constructor(
    private readonly sink: WorkLouderCodexLightingSink,
    private readonly activateSession: (sessionId: string) => void,
    private readonly loadSlotSessionIds: () => Promise<readonly string[]> = async () => [],
  ) {
    sink.setAgentKeyPressHandler((slot) => this.handleAgentKeyPress(slot));
  }

  updateSessionActivity(activity: readonly AgentIslandSessionActivity[]): void {
    this.latestActivity = activity;
    this.updateLightingFrame();
    this.scheduleTaskSlotRefresh();
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
        this.updateLightingFrame();
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
      this.updateLightingFrame();
      this.scheduleTaskSlotRefresh();
      throw error;
    }
    this.taskSlotsEnabled = true;
    this.updateLightingFrame();
  }

  suspendTaskSlots(): void {
    this.clearSlotRefreshTimer();
    this.slotRefreshVersion += 1;
    this.taskSlotsEnabled = false;
    this.slotRefreshQueued = false;
    this.slotSessionIds = [];
    this.updateLightingFrame();
  }

  private updateLightingFrame(): void {
    const frame = createWorkLouderCodexLightingFrame(this.latestActivity, this.slotSessionIds);
    const frameKey = JSON.stringify(frame);
    if (frameKey === this.lastFrameKey) return;
    this.lastFrameKey = frameKey;
    this.sink.update(frame);
  }

  dispose(): Promise<void> {
    this.clearSlotRefreshTimer();
    this.slotRefreshVersion += 1;
    this.taskSlotsEnabled = false;
    this.slotRefreshQueued = false;
    this.sink.setAgentKeyPressHandler(null);
    return this.sink.dispose();
  }

  private handleAgentKeyPress(slot: number): void {
    if (!this.taskSlotsEnabled) return;
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
}
