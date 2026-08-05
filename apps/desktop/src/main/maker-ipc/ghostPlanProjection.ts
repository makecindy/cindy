/** Build the existing Codex update_plan event shape for Ghost Plan projection. */

import type { AgentEvent } from '@cindy/maker-core';

import type { GhostPipePlanUpdate } from '../../shared/ghost.js';

/** Stable within each session because message persistence state is already session-scoped. */
export const GHOST_PLAN_TOOL_USE_ID = 'ghost-plan-current';

export type GhostPlanProjectionEvent = AgentEvent & {
  type: 'tool_use';
  source: 'codex';
  data: {
    toolUseId: typeof GHOST_PLAN_TOOL_USE_ID;
    toolName: 'update_plan';
    input: Omit<GhostPipePlanUpdate, 'type'>;
  };
};

export function buildGhostPlanProjectionEvent(
  update: Omit<GhostPipePlanUpdate, 'type'>,
): GhostPlanProjectionEvent {
  return {
    type: 'tool_use',
    source: 'codex',
    data: {
      toolUseId: GHOST_PLAN_TOOL_USE_ID,
      toolName: 'update_plan',
      input: update,
    },
  };
}
