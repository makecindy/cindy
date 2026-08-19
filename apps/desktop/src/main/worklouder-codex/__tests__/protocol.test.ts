import { describe, expect, it } from 'vitest';

import {
  applyWorkLouderCodexLightingBrightness,
  createWorkLouderCodexOffFrame,
  createWorkLouderCodexLightingFrame,
  createWorkLouderCodexWindowRevealFrame,
  isWorkLouderCodexHostMessage,
  isWorkLouderCodexLightingFrameOff,
  parseWorkLouderCodexAgentKeyPress,
  projectWorkLouderCodexSlotActivity,
  type WorkLouderCodexSessionActivity,
  WorkLouderLightingEffect,
} from '../protocol.js';

function activity(
  sessionId: string,
  phase: WorkLouderCodexSessionActivity['phase'],
  attention = false,
): WorkLouderCodexSessionActivity {
  return { sessionId, phase, compactDetail: '', attention };
}

describe('createWorkLouderCodexLightingFrame', () => {
  it('keeps an idle keyboard off', () => {
    const frame = createWorkLouderCodexLightingFrame([]);

    expect(isWorkLouderCodexLightingFrameOff(frame)).toBe(true);
    expect(frame.threads).toHaveLength(6);
  });

  it('uses animated blue lighting while Cindy is running', () => {
    const frame = createWorkLouderCodexLightingFrame([activity('one', 'running')]);

    expect(frame.ambient.effect).toBe(WorkLouderLightingEffect.Snake);
    expect(frame.ambient.color).toBe(0x4c6fff);
    expect(frame.threads[0]).toMatchObject({
      id: 0,
      effect: WorkLouderLightingEffect.Breath,
      brightness: 0.8,
    });
  });

  it('prioritizes a user decision over concurrent running and error activity', () => {
    const frame = createWorkLouderCodexLightingFrame([
      activity('running', 'running'),
      activity('error', 'error', true),
      activity('question', 'needs-interaction'),
    ]);

    expect(frame.ambient.color).toBe(0xffa000);
  });

  it('shows unread terminal states and clears acknowledged ones', () => {
    const unread = createWorkLouderCodexLightingFrame([activity('done', 'completed', true)]);
    const acknowledged = createWorkLouderCodexLightingFrame([activity('done', 'completed', false)]);

    expect(unread.ambient.color).toBe(0x35c759);
    expect(isWorkLouderCodexLightingFrameOff(acknowledged)).toBe(true);
  });

  it('always sends six thread slots so stale device LEDs are cleared', () => {
    const frame = createWorkLouderCodexLightingFrame(
      Array.from({ length: 8 }, (_, index) => activity(String(index), 'running')),
    );

    expect(frame.threads.map((thread) => thread.id)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(frame.threads.every((thread) => thread.brightness > 0)).toBe(true);
  });

  it('keeps an activity LED on the same slot as its task key assignment', () => {
    const running = activity('running-task', 'running');
    const projected = projectWorkLouderCodexSlotActivity([running], ['idle-task', 'running-task']);
    const frame = createWorkLouderCodexLightingFrame([running], ['idle-task', 'running-task']);

    expect(projected).toEqual([undefined, running, undefined, undefined, undefined, undefined]);
    expect(frame.threads[0].brightness).toBe(0);
    expect(frame.threads[1].brightness).toBeGreaterThan(0);
  });
});

describe('Work Louder Agent key protocol', () => {
  it('maps only press events from the six Agent keys', () => {
    expect(parseWorkLouderCodexAgentKeyPress({ key: 'AG00', act: 1 })).toBe(0);
    expect(parseWorkLouderCodexAgentKeyPress({ key: 'AG05', act: 1, agent: 99 })).toBe(5);
    expect(parseWorkLouderCodexAgentKeyPress({ key: 'AG03', act: 0 })).toBeNull();
    expect(parseWorkLouderCodexAgentKeyPress({ key: 'ENC_CW', act: 2 })).toBeNull();
    expect(parseWorkLouderCodexAgentKeyPress({ key: 'AG06', act: 1 })).toBeNull();
  });

  it('accepts only in-range Agent key messages from the utility process', () => {
    expect(isWorkLouderCodexHostMessage({ kind: 'agent-key', slot: 0 })).toBe(true);
    expect(isWorkLouderCodexHostMessage({ kind: 'agent-key', slot: 5 })).toBe(true);
    expect(isWorkLouderCodexHostMessage({ kind: 'agent-key', slot: 6 })).toBe(false);
    expect(isWorkLouderCodexHostMessage({ kind: 'agent-key', slot: 1.5 })).toBe(false);
  });

  it('accepts the activity notification and rejects malformed variants', () => {
    expect(isWorkLouderCodexHostMessage({ kind: 'activity' })).toBe(true);
    expect(isWorkLouderCodexHostMessage({ kind: 'device-activity' })).toBe(false);
    expect(isWorkLouderCodexHostMessage(null)).toBe(false);
  });
});

describe('Work Louder lighting settings', () => {
  it('scales every zone without mutating the semantic frame', () => {
    const frame = createWorkLouderCodexLightingFrame([activity('one', 'running')]);
    const scaled = applyWorkLouderCodexLightingBrightness(frame, 50);

    expect(scaled.ambient.brightness).toBe(frame.ambient.brightness * 0.5);
    expect(scaled.keys.brightness).toBe(frame.keys.brightness * 0.5);
    expect(scaled.threads[0]?.brightness).toBe(frame.threads[0]?.brightness * 0.5);
    expect(frame.ambient.brightness).toBe(0.7);
  });

  it('creates a complete six-slot off frame', () => {
    const frame = createWorkLouderCodexOffFrame();

    expect(isWorkLouderCodexLightingFrameOff(frame)).toBe(true);
    expect(frame.threads.map((thread) => thread.id)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('greets a reopened window with a snake-and-breath sweep across every zone', () => {
    const frame = createWorkLouderCodexWindowRevealFrame();

    expect(frame.ambient.effect).toBe(WorkLouderLightingEffect.Snake);
    expect(frame.ambient.color).toBe(0xd0060c);
    expect(frame.keys.effect).toBe(WorkLouderLightingEffect.Breath);
    expect(frame.keys.color).toBe(0xd0060c);
    expect(frame.threads).toHaveLength(6);
    expect(frame.threads.every((thread) => thread.color === 0xd0060c)).toBe(true);
    expect(frame.threads.every((thread) => thread.effect === WorkLouderLightingEffect.Breath)).toBe(
      true,
    );
    expect(isWorkLouderCodexLightingFrameOff(frame)).toBe(false);
  });
});
