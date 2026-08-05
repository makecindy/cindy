import { describe, expect, it } from 'vitest';

import { isRestorableQueuedMessage } from '../agentInputQueueSnapshots.js';

function queued(agentKind: 'claude-code' | 'codex' | 'pi') {
  return {
    clientId: 'client-1',
    text: 'continue',
    persistedContent: 'continue',
    chatMessage: { role: 'user', content: 'continue' },
    createOpts: { agentKind },
  };
}

describe('agent input queue snapshot restore', () => {
  it.each(['claude-code', 'codex', 'pi'] as const)('accepts the %s agent kind', (agentKind) => {
    expect(isRestorableQueuedMessage(queued(agentKind))).toBe(true);
  });

  it('rejects an unknown agent kind', () => {
    expect(
      isRestorableQueuedMessage({ ...queued('pi'), createOpts: { agentKind: 'unknown' } }),
    ).toBe(false);
  });
});
