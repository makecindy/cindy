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

  // 2026-11-26 实测：Cindy AI 上的主任务把子代理设成 ChatGPT 订阅的 GPT，Agent 一启动就被这里拒绝。
  // 订阅前缀模型由本机 proxy 按请求转去订阅，与父任务的来源无关；最小输入：Cindy AI 父任务 + 连着的 ChatGPT 订阅。
  it('allows a subscription-prefixed model served by a connected subscription, whatever the parent source', () => {
    const openai = { id: 'openai', connected: true, suspended: false,
      models: { 'claude-code': [{ id: 'chatgpt/gpt-6.2-sol' }] } } as never;
    expect(classify({ model: 'chatgpt/gpt-6.2-sol', providers: [openai] })).toEqual({ status: 'allowed' });
    // Not connected: the parent's own source decides, as before.
    expect(classify({ model: 'chatgpt/gpt-6.2-sol', providers: [{ ...(openai as object), connected: false } as never] }))
      .toEqual({ status: 'denied' });
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
