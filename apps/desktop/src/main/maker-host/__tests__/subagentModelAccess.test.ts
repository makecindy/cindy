import { describe, expect, it } from 'vitest';

import {
  applyExecutionPolicyToClaudeAccess,
  classifyClaudeSubagentModelAccess,
} from '../subagent-model-access-policy.js';

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

  describe('Host execution policy overlay', () => {
    const availabilityAllowed = { status: 'allowed' as const };
    const availabilityUnknown = { status: 'unknown' as const };

    it('preserves fixed-model execution without requiring a cross-model approval', () => {
      expect(applyExecutionPolicyToClaudeAccess({
        availability: availabilityAllowed,
        policyAllowed: false,
        model: 'claude-sonnet-4-6',
        parentModel: 'CLAUDE-SONNET-4-6[1m]',
      })).toEqual({ status: 'allowed' });
    });

    it('denies cross-model when the policy denies, with the policy reason', () => {
      expect(applyExecutionPolicyToClaudeAccess({
        availability: availabilityAllowed,
        policyAllowed: false,
        policyReason: 'route "xd/xai/grok-4.6" is not in this session\'s model execution allow-list',
        model: 'xai/grok-4.6',
        parentModel: 'claude-sonnet-4-6',
      })).toEqual({ status: 'denied', reason: 'route "xd/xai/grok-4.6" is not in this session\'s model execution allow-list' });
    });

    it('keeps availability unknown when the policy allows (hook treats unknown as routable)', () => {
      expect(applyExecutionPolicyToClaudeAccess({
        availability: availabilityUnknown,
        policyAllowed: true,
        model: 'claude-opus-4-6',
        parentModel: 'claude-sonnet-4-6',
      })).toEqual({ status: 'unknown' });
    });

    it('availability denial (payment tombstone) wins even when the policy allows', () => {
      expect(applyExecutionPolicyToClaudeAccess({
        availability: { status: 'denied' },
        policyAllowed: true,
        model: 'claude-opus-4-6',
        parentModel: 'claude-sonnet-4-6',
      })).toEqual({ status: 'denied' });
    });

    it('denies an alias cross-model unless the full id is allow-listed (no alias drift)', () => {
      // 若 alias 不同于父模型,policy 精确匹配必拒(允许名单里是全名),
      // 不靠 alias 猜测最终 generation —— 这是 Phase A 禁动态跨模型的一部分。
      expect(applyExecutionPolicyToClaudeAccess({
        availability: availabilityAllowed,
        policyAllowed: false,
        model: 'opus',
        parentModel: 'claude-sonnet-4-6',
      }).status).toBe('denied');
    });
  });
});
