/**
 * runEvents.test.ts — Goal run 结构化观测事件 (#2105 P0)
 * ---------------------------------------------------------------------------
 * 覆盖 createRunEventRecorder:环形容量、sink 旁路、snapshot/clear、事件字段完整性。
 * controller 埋点的端到端断言在 controller.test.ts 的
 * "Goal run observation events (#2105)" describe 中。
 */
import { describe, expect, it, vi } from 'vitest';

import { createRunEventRecorder, type GoalRunEvent } from '../runEvents';

function evt(partial: Partial<GoalRunEvent> = {}): GoalRunEvent {
  return {
    type: 'turn-dispatched',
    goalSessionId: 's1',
    generation: 1,
    turnIndex: 1,
    budget: {
      tokensUsed: 0,
      turnsUsed: 0,
      noProgressStreak: 0,
      budgetTokens: null,
      maxTurns: null,
      noProgressLimit: null,
    },
    at: 1000,
    ...partial,
  };
}

describe('createRunEventRecorder', () => {
  it('records events in order and snapshots them', () => {
    const rec = createRunEventRecorder();
    rec.record(evt({ type: 'turn-dispatched', turnIndex: 1 }));
    rec.record(evt({ type: 'turn-finalized', turnIndex: 1, to: 'active' }));
    const snap = rec.snapshot();
    expect(snap.map((e) => e.type)).toEqual(['turn-dispatched', 'turn-finalized']);
    expect(snap).toContainEqual(expect.objectContaining({ type: 'turn-finalized', to: 'active' }));
  });

  it('keeps only the latest N events (ring capacity)', () => {
    const rec = createRunEventRecorder(3);
    for (let i = 0; i < 5; i += 1) rec.record(evt({ turnIndex: i + 1 }));
    const snap = rec.snapshot();
    expect(snap).toHaveLength(3);
    expect(snap[0].turnIndex).toBe(3);
    expect(snap[2].turnIndex).toBe(5);
  });

  it('forwards to the external sink when provided', () => {
    const sink = vi.fn();
    const rec = createRunEventRecorder(10, sink);
    const e = evt({ type: 'terminal', to: 'complete' });
    rec.record(e);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(e);
  });

  it('clear() empties the ring', () => {
    const rec = createRunEventRecorder();
    rec.record(evt());
    rec.clear();
    expect(rec.snapshot()).toHaveLength(0);
  });

  it('carries generation + turnIndex + budget snapshot for auditability', () => {
    const rec = createRunEventRecorder();
    rec.record(
      evt({
        type: 'state-transition',
        generation: 3,
        turnIndex: 7,
        from: 'active',
        to: 'budgetLimited',
        reason: 'budget limit reached',
        budget: { tokensUsed: 500, turnsUsed: 7, noProgressStreak: 0, budgetTokens: 400, maxTurns: null, noProgressLimit: 3 },
      }),
    );
    const e = rec.snapshot()[0];
    expect(e.generation).toBe(3);
    expect(e.turnIndex).toBe(7);
    expect(e.budget?.tokensUsed).toBe(500);
    expect(e.budget?.budgetTokens).toBe(400);
  });
});
