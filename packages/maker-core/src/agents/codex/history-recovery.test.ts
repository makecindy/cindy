import { describe, expect, it } from 'vitest';
import {
  CodexHistoryRecoveryRequiredError,
  isCodexHistoryRecoveryRequired,
} from './history-recovery.js';

describe('Codex native history recovery classification', () => {
  it.each([
    new CodexHistoryRecoveryRequiredError(),
    new Error(
      'failed to prepare paginated fork: thread history projection for thread-1 expected ordinal 15, got 3',
    ),
    new Error('Codex rollout not found for thread thread-1'),
    new Error(
      'codex app-server thread/resume error -32600: no rollout found for thread id thread-1',
    ),
  ])('recovers confirmed history failures: %s', (error) => {
    expect(isCodexHistoryRecoveryRequired(error)).toBe(true);
  });
  it.each([
    '401 Unauthorized',
    'quota exceeded',
    'RPC timeout: thread/fork',
    'cancelled',
    'disk full',
    'permission denied',
  ])('does not turn %s into a destructive reset or retry', (message) => {
    expect(isCodexHistoryRecoveryRequired(new Error(message))).toBe(false);
  });
});
