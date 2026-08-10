import type { AgentIslandSessionActivity } from '../../shared/agentIsland.js';
import {
  createWorkLouderCodexLightingFrame,
  selectWorkLouderCodexSlotActivity,
  type WorkLouderCodexLightingFrame,
} from './protocol.js';

export interface WorkLouderCodexLightingSink {
  update(frame: WorkLouderCodexLightingFrame): void;
  setAgentKeyPressHandler(handler: ((slot: number) => void) | null): void;
  dispose(): Promise<void>;
}

/** Keeps task LEDs and their physical key targets on the same six-slot projection. */
export class WorkLouderCodexLightingController {
  private lastFrameKey = '';
  private slotSessionIds: string[] = [];

  constructor(
    private readonly sink: WorkLouderCodexLightingSink,
    private readonly activateSession: (sessionId: string) => void,
  ) {
    sink.setAgentKeyPressHandler((slot) => this.handleAgentKeyPress(slot));
  }

  updateSessionActivity(activity: readonly AgentIslandSessionActivity[]): void {
    this.slotSessionIds = selectWorkLouderCodexSlotActivity(activity).map((item) => item.sessionId);
    const frame = createWorkLouderCodexLightingFrame(activity);
    const frameKey = JSON.stringify(frame);
    if (frameKey === this.lastFrameKey) return;
    this.lastFrameKey = frameKey;
    this.sink.update(frame);
  }

  dispose(): Promise<void> {
    this.sink.setAgentKeyPressHandler(null);
    return this.sink.dispose();
  }

  private handleAgentKeyPress(slot: number): void {
    const sessionId = this.slotSessionIds[slot];
    if (sessionId) this.activateSession(sessionId);
  }
}
