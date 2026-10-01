import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@cindy/maker-core';
import { beginQuietScheduledOutput, projectQuietScheduledOutput } from '../silent-output.js';

describe('quiet scheduled presentation boundary', () => {
  it.each(['codex', 'claude-code', 'pi'] as const)('preserves %s terminal accounting, errors and interactions', (source) => {
    const close = beginQuietScheduledOutput('check', 'run');
    const origin = { kind: 'scheduler' as const, scheduleId: 'check', scheduleName: 'Check', runId: 'run' };
    const done: AgentEvent = { type: 'done', source, turnOrigin: origin, data: { result: 'No changes', finalText: 'No changes', usage: { outputTokens: 7 } } };
    try {
      expect(projectQuietScheduledOutput(done)?.data).toEqual({ result: '', finalText: '', usage: { outputTokens: 7 } });
      expect(done.data).toMatchObject({ result: 'No changes' });
      for (const type of ['error', 'interaction', 'status'] as AgentEvent['type'][]) {
        const event: AgentEvent = { type, source, turnOrigin: origin, data: { message: 'Requires attention' } };
        expect(projectQuietScheduledOutput(event)).toBe(event);
      }
      const unrelated: AgentEvent = { type: 'text', source, turnOrigin: { ...origin, runId: 'other' }, data: { text: 'User reply' } };
      expect(projectQuietScheduledOutput(unrelated)).toBe(unrelated);
    } finally { close(); }
    expect(projectQuietScheduledOutput(done)).toBe(done);
  });
});
