/**
 * Production entry: Claude routing -> real Responses handler -> captured fetch.
 * Regression: disabling Fast while bridge authentication awaits must affect this
 * still-unsent request. Earlier exit tests did not enter the async bridge.
 * Unit tier: synthetic auth, in-memory response, no sockets or user credentials.
 * Load the real speed clamp directly; unrelated Agent bootstraps in the core
 * barrel are outside this routing/handler regression. Review finding R1.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  allowed: true,
  afterAuth: () => {},
  bodies: [] as Record<string, unknown>[],
}));
vi.mock('../outbound-fetch.js', () => ({ outboundFetch: vi.fn() }));
vi.mock('@cindy/maker-core', async () => {
  const { standardSpeedRequest } = await import(
    '../../../../../../packages/maker-core/src/agents/shared/fast-mode-policy.js'
  );
  return { standardSpeedRequest };
});
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: true }),
}));
vi.mock('../runtime-configs', () => ({ claudeUpstreamEndpoint: () => 'https://gateway.invalid' }));
vi.mock('../silent-encrypted-retry-store', () => ({
  readSilentEncryptedRetrySettings: () => ({ enabled: false }),
}));
vi.mock('../logger-adapter', () => {
  const logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };
  return { createMakerLogger: () => logger, desktopMakerLogger: logger };
});
vi.mock('../subscription-fast-policy.js', () => ({
  createSubscriptionFastPolicy: () => ({ isAllowed: () => state.allowed }),
}));
vi.mock('../anthropic-responses-bridge-host', async () => {
  const { createResponsesHandler } = await import('@cindy/anthropic-responses-bridge');
  return {
    getResponsesBridgeHandler: () =>
      createResponsesHandler({
        providers: [
          {
            prefix: 'chatgpt/',
            upstreamBase: 'https://subscription.invalid',
            fastServiceTier: 'priority',
            buildHeaders: async () => {
              await Promise.resolve();
              state.afterAuth();
              return { authorization: 'Bearer fixture-not-a-token' };
            },
          },
        ],
        fetchImpl: async (_url, init) => {
          state.bodies.push(JSON.parse(String(init?.body)));
          return new Response('fixture upstream rejection', { status: 400 });
        },
      }),
    getPiNativeSubscriptionHandler: () => undefined,
  };
});

import {
  createModelRoutingTransform,
  setClaudeProxyGatewayKeyReader,
  setClaudeProxySessionIdResolver,
} from '../anthropic-compat-proxy-host';
import { setPendingCredentialSwitchReader } from '../provider-route';
import { setSessionProvider, clearSessionProvider } from '../session-provider-store';
import { setSessionFastMode } from '../session-effort-store';

afterEach(() => {
  state.allowed = true;
  state.afterAuth = () => {};
  state.bodies = [];
  clearSessionProvider('bridge-fast-task');
  setSessionFastMode('bridge-fast-task', false);
  setClaudeProxySessionIdResolver(() => null);
});

describe('ChatGPT subscription Fast at the Claude bridge exit', () => {
  it.each([false, true])(
    'rechecks after authentication when policy tightens=%s',
    async (tighten) => {
      setClaudeProxyGatewayKeyReader(() => 'fixture-gateway-key');
      setPendingCredentialSwitchReader(() => undefined);
      setClaudeProxySessionIdResolver(() => 'bridge-fast-task');
      setSessionProvider('bridge-fast-task', 'openai');
      setSessionFastMode('bridge-fast-task', true);
      state.afterAuth = () => {
        if (tighten) state.allowed = false;
      };
      const body = {
        model: 'chatgpt/gpt-6.1-sol',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'fixture' }],
      };
      const ctx = {
        reqId: 1,
        method: 'POST',
        url: '/v1/messages',
        headers: { 'x-claude-code-session-id': 'sdk-fast-task' },
      };
      const route = await createModelRoutingTransform()(body, ctx);
      expect(route?.localHandler).toBeTypeOf('function');
      const res = Object.assign(new EventEmitter(), {
        headersSent: false,
        writeHead() {
          return res;
        },
        end() {
          return res;
        },
      });
      await route!.localHandler!({
        parsedBody: body,
        rawBody: Buffer.from(JSON.stringify(body)),
        ctx,
        res: res as never,
      });
      expect(state.bodies).toHaveLength(1);
      expect(state.bodies[0].service_tier).toBe(tighten ? undefined : 'priority');
      expect(state.bodies[0].model).toBe('gpt-6.1-sol');
    },
  );
});
