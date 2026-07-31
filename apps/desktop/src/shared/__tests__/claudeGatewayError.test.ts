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
    agentKind: 'claude-code',
    modelId: 'claude-opus-5',
    providerId: null,
    observedDefaultRoute: 'gateway',
    error: planError,
    terminal: true,
    remote: false,
    ...overrides,
  });
}

describe('classifyClaudeGatewayError', () => {
  it('attributes the misleading Pro-plan error when a default-route Opus request used XD Gateway', () => {
    expect(classify()).toBe(CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON);
  });

  it('also attributes an explicitly selected XD source', () => {
    expect(classify({ providerId: 'xd', observedDefaultRoute: null })).toBe(
      CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON,
    );
  });

  it.each([
    { label: 'Claude.ai subscription route', observedDefaultRoute: 'subscription' as const },
    { label: 'unknown default route', observedDefaultRoute: null },
    { label: 'Anthropic source', providerId: 'anthropic' },
    { label: 'non-Opus model', modelId: 'claude-sonnet-5' },
    { label: 'non-terminal retry', terminal: false },
    { label: 'remote session', remote: true },
    { label: 'unrelated error', error: 'model unavailable' },
  ])('does not guess for $label', ({ label: _label, ...overrides }) => {
    expect(classify(overrides)).toBeNull();
  });
});
