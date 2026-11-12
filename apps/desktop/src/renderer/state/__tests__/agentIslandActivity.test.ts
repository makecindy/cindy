// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentIslandSessionActivity } from '../../../shared/agentIsland';

type ActivityListener = (list: AgentIslandSessionActivity[]) => void;

let pushActivity: ActivityListener | null = null;

function activity(
  sessionId: string,
  phase: AgentIslandSessionActivity['phase'],
): AgentIslandSessionActivity {
  return { sessionId, phase, attention: false } as AgentIslandSessionActivity;
}

describe('isSessionCompletionHeldByAgentIsland', () => {
  beforeEach(() => {
    vi.resetModules();
    pushActivity = null;
    Object.assign(window, {
      electronAPI: {
        agentIsland: {
          onSessionActivity: (cb: ActivityListener) => {
            pushActivity = cb;
            return () => undefined;
          },
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('follows the phase Main keeps for a session after its turn ended', async () => {
    const store = await import('../agentIslandActivity');
    store.ensureAgentIslandActivitySubscribed();

    pushActivity?.([activity('lead', 'running'), activity('done', 'completed')]);

    expect(store.isSessionCompletionHeldByAgentIsland('lead', false)).toBe(true);
    expect(store.isSessionCompletionHeldByAgentIsland('done', false)).toBe(false);
    expect(store.isSessionCompletionHeldByAgentIsland('unknown', false)).toBe(false);
  });

  it('does not hold a session whose own paused queue keeps the island running', async () => {
    const store = await import('../agentIslandActivity');
    store.ensureAgentIslandActivitySubscribed();

    pushActivity?.([activity('paused', 'running')]);

    expect(store.isSessionCompletionHeldByAgentIsland('paused', true)).toBe(false);
  });
});
