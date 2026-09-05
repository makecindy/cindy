import { describe, expect, it } from 'vitest';

import {
  BOT_FAILURE_REASONS,
  classifyBotFailureReason,
  isBotFailureAttentionWorthy,
} from '../botFailureReason';

describe('Hermes Bot failure reasons', () => {
  it('keeps the closed reason vocabulary stable', () => {
    expect([...BOT_FAILURE_REASONS]).toEqual([
      'runtime_offline',
      'queued_expired',
      'delivery_timeout',
      'agent_blocked',
      'cancelled',
      'provider_auth_or_access',
      'provider_quota_limit',
      'provider_rate_limit',
      'provider_server_error',
      'context_overflow',
      'missing_config',
      'model_unavailable',
      'unknown',
    ]);
  });

  it.each([
    ['Error code: 403 - forbidden', 'provider_auth_or_access'],
    ['authentication_error: account is out of funds', 'provider_auth_or_access'],
    ['Error code: 402 - payment required', 'provider_quota_limit'],
    ['quota exceeded for this billing period', 'provider_quota_limit'],
    ['Error code: 429 - Too Many Requests', 'provider_rate_limit'],
    ['Error code: 529 - overloaded_error', 'provider_server_error'],
    ['maximum context length is 128000 tokens', 'context_overflow'],
    ['No LLM provider configured', 'missing_config'],
    ['No access token found for profile', 'missing_config'],
    ["model 'gpt-9' not found", 'model_unavailable'],
    ['agent is blocked awaiting approval', 'agent_blocked'],
  ] as const)('classifies %s', (text, expected) => {
    expect(classifyBotFailureReason(text)).toBe(expected);
  });

  it('passes typed codes through and does not classify bare incidental numbers', () => {
    expect(classifyBotFailureReason({ reason: 'delivery_timeout' })).toBe('delivery_timeout');
    expect(classifyBotFailureReason('gate failed at line 502')).toBe('unknown');
    expect(classifyBotFailureReason('took 429 ms')).toBe('unknown');
  });

  it('only keeps durable user-action failures in needs-attention', () => {
    for (const reason of [
      'agent_blocked',
      'missing_config',
      'provider_auth_or_access',
      'provider_quota_limit',
    ] as const) {
      expect(isBotFailureAttentionWorthy(reason)).toBe(true);
    }
    for (const reason of BOT_FAILURE_REASONS.filter(
      (reason) => !['agent_blocked', 'missing_config', 'provider_auth_or_access', 'provider_quota_limit'].includes(reason),
    )) {
      expect(isBotFailureAttentionWorthy(reason)).toBe(false);
    }
  });
});
