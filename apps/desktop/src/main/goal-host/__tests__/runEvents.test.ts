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
    lifecycleId: 'g1',
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

  it('keeps insertion order across independent sessions at the same timestamp', () => {
    const rec = createRunEventRecorder();
    rec.record(evt({
      type: 'turn-dispatched',
      goalSessionId: 'b',
      lifecycleId: 'g2',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'terminal',
      goalSessionId: 'a',
      lifecycleId: 'g1',
      turnIndex: 1,
      to: 'complete',
      at: 1000,
    }));
    expect(rec.snapshot().map((e) => e.goalSessionId)).toEqual(['b', 'a']);
  });

  it('still orders same-session replacements by lifecycle sequence at the same timestamp', () => {
    const rec = createRunEventRecorder();
    rec.record(evt({
      type: 'turn-dispatched',
      goalSessionId: 's1',
      lifecycleId: 'g2',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'terminal',
      goalSessionId: 's1',
      lifecycleId: 'g1',
      turnIndex: 4,
      to: 'complete',
      at: 1000,
    }));
    expect(rec.snapshot().map((e) => e.lifecycleId)).toEqual(['g1', 'g2']);
    expect(rec.snapshot().map((e) => e.type)).toEqual(['terminal', 'turn-dispatched']);
  });

  it('keeps a transitive order when two A lifecycles interleave with session B at the same timestamp', () => {
    const rec = createRunEventRecorder();
    rec.record(evt({
      type: 'turn-dispatched',
      goalSessionId: 'a',
      lifecycleId: 'g3',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'turn-dispatched',
      goalSessionId: 'b',
      lifecycleId: 'g2',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'terminal',
      goalSessionId: 'a',
      lifecycleId: 'g1',
      turnIndex: 4,
      to: 'complete',
      at: 1000,
    }));
    expect(rec.snapshot().map((e) => e.lifecycleId)).toEqual(['g1', 'g3', 'g2']);
    expect(rec.snapshot().map((e) => e.goalSessionId)).toEqual(['a', 'a', 'b']);
  });

  it('does not pull a later session B dispatch in front of an earlier A closeout pair', () => {
    const rec = createRunEventRecorder();
    rec.record(evt({
      type: 'turn-dispatched',
      goalSessionId: 'a',
      lifecycleId: 'g1',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'turn-dispatched',
      goalSessionId: 'b',
      lifecycleId: 'g2',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'turn-finalized',
      goalSessionId: 'a',
      lifecycleId: 'g1',
      turnIndex: 1,
      at: 1000,
    }));
    expect(rec.snapshot().map((e) => `${e.goalSessionId}:${e.type}`)).toEqual([
      'a:turn-dispatched',
      'b:turn-dispatched',
      'a:turn-finalized',
    ]);
  });

  it('encodes same-lifecycle dispatch-before-closeout into keys without a comparator cycle',
    () => {
    const rec = createRunEventRecorder();
    rec.record(evt({
      type: 'turn-finalized',
      goalSessionId: 'a',
      lifecycleId: 'g1',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'turn-dispatched',
      goalSessionId: 'b',
      lifecycleId: 'g2',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'turn-dispatched',
      goalSessionId: 'a',
      lifecycleId: 'g1',
      turnIndex: 1,
      at: 1000,
    }));
    expect(rec.snapshot().map((e) => `${e.goalSessionId}:${e.type}`)).toEqual([
      'a:turn-dispatched',
      'a:turn-finalized',
      'b:turn-dispatched',
    ]);
  });

  it('keeps same-lifecycle dispatch before closeout after a cross-lifecycle key move', () => {
    const rec = createRunEventRecorder();
    rec.record(evt({
      type: 'turn-dispatched',
      goalSessionId: 's1',
      lifecycleId: 'g2',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'turn-dispatched',
      goalSessionId: 's1',
      lifecycleId: 'g1',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'terminal',
      goalSessionId: 's1',
      lifecycleId: 'g1',
      turnIndex: 1,
      to: 'complete',
      at: 1000,
    }));
    expect(rec.snapshot().map((e) => `${e.lifecycleId}:${e.type}`)).toEqual([
      'g1:turn-dispatched',
      'g1:terminal',
      'g2:turn-dispatched',
    ]);
  });

  it('keeps old-lifecycle closeout before a later same-timestamp new dispatch after same-lifecycle key moves', () => {
    const rec = createRunEventRecorder();
    rec.record(evt({
      type: 'turn-dispatched',
      goalSessionId: 's1',
      lifecycleId: 'g1',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'turn-finalized',
      goalSessionId: 's1',
      lifecycleId: 'g2',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'terminal',
      goalSessionId: 's1',
      lifecycleId: 'g1',
      turnIndex: 1,
      to: 'complete',
      at: 1000,
    }));
    rec.record(evt({
      type: 'turn-dispatched',
      goalSessionId: 's1',
      lifecycleId: 'g2',
      turnIndex: 1,
      at: 1000,
    }));
    expect(rec.snapshot().map((e) => `${e.lifecycleId}:${e.type}`)).toEqual([
      'g1:turn-dispatched',
      'g1:terminal',
      'g2:turn-dispatched',
      'g2:turn-finalized',
    ]);
  });

  it('moves an old closeout before a newer dispatch when keys are equal', () => {
    const rec = createRunEventRecorder();
    rec.record(evt({
      type: 'turn-dispatched',
      lifecycleId: 'g1',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'turn-dispatched',
      lifecycleId: 'g2',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'turn-finalized',
      lifecycleId: 'g3',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'turn-finalized',
      lifecycleId: 'g1',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'turn-finalized',
      lifecycleId: 'g2',
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'turn-dispatched',
      lifecycleId: 'g3',
      turnIndex: 1,
      at: 1000,
    }));
    expect(rec.snapshot().map((e) => `${e.lifecycleId}:${e.type}`)).toEqual([
      'g1:turn-dispatched',
      'g1:turn-finalized',
      'g2:turn-dispatched',
      'g2:turn-finalized',
      'g3:turn-dispatched',
      'g3:turn-finalized',
    ]);
  });

  it('moves an old pause closeout before a later same-timestamp resume transition', () => {
    const rec = createRunEventRecorder();
    rec.record(evt({
      type: 'turn-dispatched',
      lifecycleId: 'g1',
      generation: 1,
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'state-transition',
      lifecycleId: 'g2',
      generation: 2,
      turnIndex: 1,
      from: 'paused',
      to: 'active',
      reason: 'manual-resume',
      at: 1000,
    }));
    rec.record(evt({
      type: 'resumed',
      lifecycleId: 'g2',
      generation: 2,
      turnIndex: 1,
      from: 'paused',
      to: 'active',
      at: 1000,
    }));
    rec.record(evt({
      type: 'turn-dispatched',
      lifecycleId: 'g2',
      generation: 2,
      turnIndex: 1,
      at: 1000,
    }));
    rec.record(evt({
      type: 'state-transition',
      lifecycleId: 'g1',
      generation: 1,
      turnIndex: 1,
      from: 'active',
      to: 'paused',
      reason: 'paused by user',
      at: 1000,
    }));
    expect(rec.snapshot().map((e) => `${e.lifecycleId}:${e.type}:${e.to ?? ''}`)).toEqual([
      'g1:turn-dispatched:',
      'g1:state-transition:paused',
      'g2:state-transition:active',
      'g2:resumed:active',
      'g2:turn-dispatched:',
    ]);
  });
});
