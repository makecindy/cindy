import { describe, expect, it } from 'vitest';

import {
  CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON,
  classifyClaudeGatewayError,
  type ClaudeGatewayErrorContext,
} from '../claudeGatewayError';

const planError =
  'Claude Opus is not available with the Claude Pro plan. If you have updated your subscription plan recently, run /logout and /login for the plan to take effect.';

function classify(overrides: Partial<ClaudeGatewayErrorContext> = {}) {
  return classifyClaudeGatewayError({
    modelId: 'claude-opus-5',
    requestRoute: 'gateway',
    status: 400,
    error: planError,
    ...overrides,
  });
}

describe('classifyClaudeGatewayError', () => {
  it('attributes the misleading Pro-plan error from the exact gateway Opus response', () => {
    expect(classify()).toBe(CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON);
  });

  it.each([
    { label: 'Claude.ai subscription route', requestRoute: 'subscription' as const },
    { label: 'non-400 response', status: 429 },
    { label: 'non-Opus model', modelId: 'claude-sonnet-5' },
    { label: 'unrelated error', error: 'model unavailable' },
  ])('does not guess for $label', ({ label: _label, ...overrides }) => {
    expect(classify(overrides)).toBeNull();
  });
});
