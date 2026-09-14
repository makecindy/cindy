import { describe, expect, it } from 'vitest';

import { classifyClaudeSubagentModelAccess } from '../subagent-model-access-policy.js';

const xdModel = (id: string) => ({ id, agents: ['claude-code' as const] });

function classify(overrides: Partial<Parameters<typeof classifyClaudeSubagentModelAccess>[0]> = {}) {
  return classifyClaudeSubagentModelAccess({
    providerId: 'xd',
    credentialMode: 'gateway-key',
    model: 'sonnet',
    gatewayKeyAvailable: true,
    xdSnapshot: {
      authoritative: true,
      models: [xdModel('codex/gpt-5.6-sol')],
      paymentRequiredModelIds: [],
    },
    providers: [],
    ...overrides,
  });
}

describe('Claude subagent model access', () => {
  it('denies an absent alias only from the current authoritative XD snapshot', () => {
    expect(classify()).toEqual({ status: 'denied' });
    expect(classify({
      xdSnapshot: {
        authoritative: false,
        models: [xdModel('claude-sonnet-4-6')],
        paymentRequiredModelIds: [],
      },
    }))
      .toEqual({ status: 'unknown' });
  });

  it('accepts aliases, full ids, and the [1m] suffix from the XD snapshot', () => {
    const snapshot = {
      authoritative: true,
      models: [xdModel('claude-sonnet-4-6'), xdModel('xai/grok-4.6')],
      paymentRequiredModelIds: [],
    };
    expect(classify({ model: 'sonnet', xdSnapshot: snapshot })).toEqual({ status: 'allowed' });
    expect(classify({ model: 'CLAUDE-SONNET-4-6[1m]', xdSnapshot: snapshot }))
      .toEqual({ status: 'allowed' });
    expect(classify({ model: 'xai/grok-4.6', xdSnapshot: snapshot }))
      .toEqual({ status: 'allowed' });
  });

  it('denies a payment-required model from the authoritative XD snapshot', () => {
    expect(classify({
      model: 'sonnet',
      xdSnapshot: {
        authoritative: true,
        models: [{
          ...xdModel('claude-sonnet-4-6'),
          availability: 'requires_payment',
        }],
        paymentRequiredModelIds: ['claude-sonnet-4-6'],
      },
    })).toEqual({ status: 'denied' });
  });

  it('keeps a payment denial while the XD snapshot is non-authoritative', () => {
    expect(classify({
      model: 'claude-sonnet-4-6',
      xdSnapshot: {
        authoritative: false,
        models: [],
        paymentRequiredModelIds: ['claude-sonnet-4-6'],
      },
    })).toEqual({ status: 'denied' });
  });

  it('denies an ambiguous alias when any matching XD generation requires payment', () => {
    expect(classify({
      model: 'sonnet',
      xdSnapshot: {
        authoritative: true,
        models: [xdModel('claude-sonnet-4-5')],
        paymentRequiredModelIds: ['claude-sonnet-4-6'],
      },
    })).toEqual({ status: 'denied' });
    expect(classify({
      model: 'claude-sonnet-4-5',
      xdSnapshot: {
        authoritative: true,
        models: [xdModel('claude-sonnet-4-5')],
        paymentRequiredModelIds: ['claude-sonnet-4-6'],
      },
    })).toEqual({ status: 'allowed' });
  });

  it('does not treat a static or stale non-XD catalog absence as denial', () => {
    expect(classify({
      providerId: 'anthropic',
      credentialMode: 'oauth-bearer',
      gatewayKeyAvailable: true,
      providers: [{
        id: 'anthropic',
        connected: true,
        models: { 'claude-code': [] },
      }],
    })).toEqual({ status: 'unknown' });
  });

  it('re-evaluates sequential account snapshots instead of retaining a denial', () => {
    expect(classify()).toEqual({ status: 'denied' });
    expect(classify({
      xdSnapshot: {
        authoritative: true,
        models: [xdModel('claude-sonnet-4-6')],
        paymentRequiredModelIds: [],
      },
    })).toEqual({ status: 'allowed' });
  });

  it('uses the default XD route for OAuth spawn when a gateway key is active', () => {
    expect(classify({
      providerId: null,
      credentialMode: 'oauth-bearer',
      gatewayKeyAvailable: true,
    })).toEqual({ status: 'denied' });
  });
});
