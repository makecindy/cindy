import { gzipSync } from 'node:zlib';

import type { ResponseObserverCtx } from '@cindy/anthropic-compat-proxy';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON,
  CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON,
} from '../../../shared/claudeGatewayError.js';
import {
  consumeClaudeOpusPlanMismatch,
  createClaudeGatewayErrorObserver,
  resetClaudeGatewayErrorObserverForTest,
} from '../claude-gateway-error-observer.js';
import {
  noteClaudeSessionRequest,
  recordClaudeRequestRoute,
  resetClaudeSessionRouteRegistryForTest,
} from '../claude-session-route-registry.js';

const planError = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request',
    message: 'Claude Opus is not available with the Claude Pro plan.',
  },
});

function ctx(overrides: Partial<ResponseObserverCtx> = {}): ResponseObserverCtx {
  return {
    reqId: 1,
    method: 'POST',
    url: '/v1/messages',
    upstreamBase: 'https://gateway.example.com',
    status: 400,
    requestHeaders: { 'x-claude-code-session-id': 'sdk-1' },
    responseHeaders: {},
    requestBody: Buffer.from(JSON.stringify({ model: 'claude-opus-5' })),
    ...overrides,
  };
}

function drive(c: ResponseObserverCtx, body: Buffer): boolean {
  const sink = createClaudeGatewayErrorObserver()(c);
  if (!sink) return false;
  sink.onData?.(body);
  sink.onEnd?.();
  return true;
}

describe('Claude gateway error observer', () => {
  beforeEach(() => {
    resetClaudeSessionRouteRegistryForTest();
    resetClaudeGatewayErrorObserverForTest();
  });

  it('records evidence from the exact latest gateway Opus 400 response', () => {
    recordClaudeRequestRoute(1, 's1', 'gateway');

    expect(drive(ctx(), Buffer.from(planError))).toBe(true);
    expect(consumeClaudeOpusPlanMismatch('s1')).toBe(CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON);
    expect(consumeClaudeOpusPlanMismatch('s1')).toBeNull();
  });

  it('decodes compressed gateway error bodies', () => {
    recordClaudeRequestRoute(1, 's1', 'gateway');

    expect(
      drive(ctx({ responseHeaders: { 'content-encoding': 'gzip' } }), gzipSync(planError)),
    ).toBe(true);
    expect(consumeClaudeOpusPlanMismatch('s1')).toBe(CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON);
  });

  it('records evidence from the exact direct Claude.ai subscription Opus 400 response', () => {
    recordClaudeRequestRoute(1, 's1', 'subscription');

    expect(drive(ctx(), Buffer.from(planError))).toBe(true);
    expect(consumeClaudeOpusPlanMismatch('s1')).toBe(CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON);
  });

  it.each([
    { label: 'non-400 response', route: 'gateway' as const, status: 429 },
    { label: 'non-Opus request', route: 'gateway' as const, model: 'claude-sonnet-5' },
    { label: 'unrelated error', route: 'gateway' as const, body: '{"error":"busy"}' },
  ])(
    'does not record evidence for $label',
    ({ route, status = 400, model = 'claude-opus-5', body = planError }) => {
      recordClaudeRequestRoute(1, 's1', route);

      drive(
        ctx({ status, requestBody: Buffer.from(JSON.stringify({ model })) }),
        Buffer.from(body),
      );
      expect(consumeClaudeOpusPlanMismatch('s1')).toBeNull();
    },
  );

  it('invalidates old evidence when a later session request starts', () => {
    recordClaudeRequestRoute(1, 's1', 'gateway');
    drive(ctx(), Buffer.from(planError));
    noteClaudeSessionRequest('s1', 2);

    expect(consumeClaudeOpusPlanMismatch('s1')).toBeNull();
  });

  it('does not record a response that becomes stale before its body completes', () => {
    recordClaudeRequestRoute(1, 's1', 'gateway');
    const sink = createClaudeGatewayErrorObserver()(ctx());
    expect(sink).toBeTruthy();
    sink?.onData?.(Buffer.from(planError));
    noteClaudeSessionRequest('s1', 2);
    sink?.onEnd?.();

    expect(consumeClaudeOpusPlanMismatch('s1')).toBeNull();
  });
});
