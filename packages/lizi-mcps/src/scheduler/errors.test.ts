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
    // Message must contain the original diagnostic
    expect(result.message).toContain(`[${code}] safe diagnostic`);
  });

  it.each([
    'UTILITY_MODEL_NO_CANDIDATE',
    'UTILITY_MODEL_ALL_CANDIDATES_FAILED',
    'UTILITY_MODEL_EMPTY_RESPONSE',
    'UTILITY_MODEL_TIMEOUT',
  ] as const)('appends actionable hint for %s so agents can suggest passing script', (code) => {
    const result = classifySchedulerError(
      new Error(`[${code}] all candidates failed`),
    );

    // Must hint that passing "script" bypasses generation (#3317)
    expect(result.message).toContain('script');
    expect(result.message).toContain('bypass');
  });
});
