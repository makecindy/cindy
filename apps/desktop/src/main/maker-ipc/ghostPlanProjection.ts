/** Build the existing Codex update_plan event shape for Ghost Plan projection. */

import type { AgentEvent } from '@cindy/maker-core';
import { createId } from '@paralleldrive/cuid2';

import type { GhostPipePlanUpdate } from '../../shared/ghost.js';

/** 每次完整快照使用新 id，确保它按消息顺序成为当前 Plan，而非改写较早的行。 */
export const GHOST_PLAN_TOOL_USE_ID_PREFIX = 'ghost-plan:';

export type GhostPlanProjectionEvent = AgentEvent & {
  type: 'tool_use';
  source: 'codex';
  data: {
    toolUseId: string;
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
      toolUseId: `${GHOST_PLAN_TOOL_USE_ID_PREFIX}${createId()}`,
      toolName: 'update_plan',
      input: update,
    },
  };
}
