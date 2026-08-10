import { describe, expect, it } from 'vitest';

import type { AgentIslandSessionActivity } from '../../../shared/agentIsland.js';
import {
  createWorkLouderCodexLightingFrame,
  isWorkLouderCodexHostMessage,
  isWorkLouderCodexLightingFrameOff,
  parseWorkLouderCodexAgentKeyPress,
  WorkLouderLightingEffect,
} from '../protocol.js';

function activity(
  sessionId: string,
  phase: AgentIslandSessionActivity['phase'],
  attention = false,
): AgentIslandSessionActivity {
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
});
