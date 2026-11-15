import { afterEach, describe, expect, it, vi } from 'vitest';
import { zstdCompressSync } from 'node:zlib';
import type { RequestTransformCtx, RoutingDecision } from '@cindy/anthropic-compat-proxy';
import {
  restrictSubscriptionRequest,
  withSubscriptionFastRequestPolicy,
} from '../subscription-fast-request-policy.js';

const state = vi.hoisted(() => ({ allowed: true }));
vi.mock('../subscription-fast-policy.js', () => ({
  createSubscriptionFastPolicy: () => ({ isAllowed: () => state.allowed }),
}));
vi.mock('../active-catalog.js', () => ({
  getActiveCatalog: () => ({
    providers: [
      { id: 'subscription', auth: { method: 'oauth', native: 'codex' } },
      { id: 'claude', auth: { method: 'oauth', native: 'claude' } },
      { id: 'openai', auth: { method: 'apiKey' } },
    ],
  }),
}));
const identity = { sessionId: 'task', providerId: 'subscription' };
const ctx = {
  reqId: 1,
  method: 'POST',
  url: '/responses',
  headers: {},
} as RequestTransformCtx;
const bytes = (body: unknown) => Buffer.from(JSON.stringify(body));
afterEach(() => {
  state.allowed = true;
});

describe('subscription request speed policy at the actual exit', () => {
  it('decodes compressed subscription HTTP requests without affecting API routes', async () => {
    state.allowed = false;
    const decision = withSubscriptionFastRequestPolicy(null, identity, {
      ...ctx,
      headers: { 'content-encoding': 'zstd' },
    })!;
    const result = await decision.transformRequestBody!(
      zstdCompressSync(bytes({ input: [], service_tier: 'priority' })),
      ctx,
    );
    expect(JSON.parse(result.body.toString())).toEqual({ input: [], service_tier: 'default' });
    expect(decision.headerDelete).toContain('content-encoding');
  });
  it('keeps control and token counting endpoints unchanged', () => {
    state.allowed = false;
    const decision: RoutingDecision = { upstreamOverride: 'https://api.example.invalid' };
    expect(
      withSubscriptionFastRequestPolicy(decision, identity, {
        ...ctx,
        url: '/v1/messages/count_tokens',
      }),
    ).toBe(decision);
  });
  it('keeps custom API routes and bodies identical, including an API provider named openai', () => {
    state.allowed = false;
    const decision: RoutingDecision = { upstreamOverride: 'https://api.example.invalid' };
    expect(withSubscriptionFastRequestPolicy(decision, { ...identity, providerId: 'openai' })).toBe(
      decision,
    );
    expect(restrictSubscriptionRequest({ service_tier: 'priority' }, 'task', 'openai')).toBeNull();
  });

  it('clamps stale tool-loop payloads and rejects a captured Fast dispatch after policy tightens', async () => {
    const decision = withSubscriptionFastRequestPolicy(null, identity)!;
    const raw = bytes({ model: 'gpt', service_tier: 'priority', input: [] });
    expect((await decision.transformRequestBody!(raw, ctx)).body).toBe(raw);
    state.allowed = false;
    expect(decision.dispatchGenerationValid!()).toBe(false);
    const next = withSubscriptionFastRequestPolicy(null, identity)!;
    expect(JSON.parse((await next.transformRequestBody!(raw, ctx)).body.toString())).toMatchObject({
      service_tier: 'default',
      input: [],
    });
    expect(next.dispatchGenerationValid!()).toBe(true);
  });

  it('clamps after an asynchronous route body adapter, never before its changes', async () => {
    const decision = withSubscriptionFastRequestPolicy(
      {
        transformRequestBody: async () => {
          state.allowed = false;
          return { body: bytes({ service_tier: 'ultrafast', input: [] }) };
        },
      },
      identity,
    )!;
    expect(
      JSON.parse((await decision.transformRequestBody!(bytes({}), ctx)).body.toString())
        .service_tier,
    ).toBe('default');
  });

  it('keeps Claude payloads valid and handles native Pi compressed local dispatch', async () => {
    state.allowed = false;
    let seen: Parameters<NonNullable<RoutingDecision['localHandler']>>[0] | undefined;
    const decision = withSubscriptionFastRequestPolicy(
      {
        localHandler: async (args) => {
          seen = args;
        },
      },
      { ...identity, providerId: 'claude' },
    )!;
    await decision.localHandler!({
      rawBody: zstdCompressSync(bytes({ model: 'claude', messages: [], speed: 'fast' })),
      parsedBody: undefined,
      ctx: { ...ctx, headers: { 'content-encoding': 'zstd' } },
      res: {} as never,
    });
    expect(seen!.parsedBody).toEqual({ model: 'claude', messages: [], speed: 'standard' });
    expect(seen!.ctx.headers).not.toHaveProperty('content-encoding');
  });

  it('rewrites each WebSocket create payload against the live policy', () => {
    expect(
      restrictSubscriptionRequest(
        { type: 'response.create', service_tier: 'priority' },
        'task',
        'subscription',
      ),
    ).toBeNull();
    state.allowed = false;
    expect(
      restrictSubscriptionRequest(
        { type: 'response.create', service_tier: 'ultrafast' },
        'task',
        'subscription',
      ),
    ).toEqual({ type: 'response.create', service_tier: 'default' });
  });

  it.each(['session.update', 'conversation.item.create', 'response.cancel', 'ping'])(
    'leaves the WebSocket control event %s unchanged when Fast is forbidden',
    (type) => {
      state.allowed = false;
      expect(restrictSubscriptionRequest({ type }, 'task', 'subscription')).toBeNull();
    },
  );
});
