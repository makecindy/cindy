import { describe, expect, it } from 'vitest';

import {
  decideGhostPlanMessageWrite,
  ghostIdFromPlanId,
} from '../ghostPlanMessageProjector';
import { GHOST_PLAN_TOOL_NAME } from '@cindy/maker-shared';

describe('Ghost Plan message projection', () => {
  it('updates the current Plan only when it belongs to the calling plugin', () => {
    expect(decideGhostPlanMessageWrite('planner', {
      clientId: 'message-1',
      toolUseId: 'plan:ghost:planner:mab12',
      toolName: GHOST_PLAN_TOOL_NAME,
    })).toEqual({
      kind: 'update',
      clientId: 'message-1',
      toolUseId: 'plan:ghost:planner:mab12',
    });
  });

  it.each([
    { clientId: 'codex', toolUseId: 'plan:turn-1', toolName: 'update_plan' },
    { clientId: 'other-ghost', toolUseId: 'plan:ghost:other:mab12', toolName: GHOST_PLAN_TOOL_NAME },
    null,
  ])('sends a new Plan after another source owns the pinned Plan', (current) => {
    expect(decideGhostPlanMessageWrite('planner', current)).toMatchObject({
      kind: 'send',
      toolUseId: expect.stringMatching(/^plan:ghost:planner:[a-z0-9]+$/),
    });
  });

  it('parses only complete Ghost Plan identities', () => {
    expect(ghostIdFromPlanId('plan:ghost:planner:mab12')).toBe('planner');
    expect(ghostIdFromPlanId('plan:ghost:planner:')).toBeNull();
    expect(ghostIdFromPlanId('plan:turn-1')).toBeNull();
  });

  it('forces a new ID for an explicit plan-create', () => {
    const write = decideGhostPlanMessageWrite('planner', {
      clientId: 'message-1',
      toolUseId: 'plan:ghost:planner:mab12',
      toolName: GHOST_PLAN_TOOL_NAME,
    }, true);
    expect(write).toMatchObject({
      kind: 'send',
      toolUseId: expect.stringMatching(/^plan:ghost:planner:[a-z0-9]+$/),
    });
    expect(write.toolUseId).not.toBe('plan:ghost:planner:mab12');
  });
});
