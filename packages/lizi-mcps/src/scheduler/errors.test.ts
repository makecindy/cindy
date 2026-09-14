import { describe, expect, it } from 'vitest';

import { classifySchedulerError } from './errors.js';

describe('classifySchedulerError utility model diagnostics', () => {
  it.each([
    'UTILITY_MODEL_NO_CANDIDATE',
    'UTILITY_MODEL_ALL_CANDIDATES_FAILED',
    'UTILITY_MODEL_EMPTY_RESPONSE',
    'UTILITY_MODEL_TIMEOUT',
  ] as const)('preserves the shared %s code for MCP callers', (code) => {
    const result = classifySchedulerError(
      new Error(`[${code}] safe diagnostic`),
    );

    expect(result.code).toBe(code);
    expect(result.message).toContain(`[${code}] safe diagnostic`);
    expect(result.message).toContain('script');
    expect(result.message).toContain('bypass');
  });
});
