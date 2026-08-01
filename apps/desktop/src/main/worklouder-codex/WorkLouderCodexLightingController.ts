import type { AgentIslandSessionActivity } from '../../shared/agentIsland.js';
import {
  createWorkLouderCodexLightingFrame,
  type WorkLouderCodexLightingFrame,
} from './protocol.js';

export interface WorkLouderCodexLightingSink {
  update(frame: WorkLouderCodexLightingFrame): void;
  dispose(): Promise<void>;
}

/** Keeps hardware writes deduplicated while Agent Island publishes rich task updates. */
export class WorkLouderCodexLightingController {
  private lastFrameKey = '';

  constructor(private readonly sink: WorkLouderCodexLightingSink) {}

  updateSessionActivity(activity: readonly AgentIslandSessionActivity[]): void {
    const frame = createWorkLouderCodexLightingFrame(activity);
    const frameKey = JSON.stringify(frame);
    if (frameKey === this.lastFrameKey) return;
    this.lastFrameKey = frameKey;
    this.sink.update(frame);
  }

  dispose(): Promise<void> {
    return this.sink.dispose();
  }
}
