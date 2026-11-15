import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { InboundAdmissionCtx, InboundRejection } from '@cindy/anthropic-compat-proxy';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { createAnthropicCompatProxyHost, type AnthropicCompatProxyHostPorts } from '../../../desktop/src/main/maker-host/anthropicCompatProxyHostCore.js';
import { CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY } from '../../../desktop/src/main/maker-host/claude-gateway-config.js';
import { forgetClaudeSessionRoute } from '../../../desktop/src/main/maker-host/claude-session-route-registry.js';
import { clearClaudeSessionBackgroundActivity } from '../../../desktop/src/main/maker-host/claude-session-background-activity.js';
import { createAttachmentRecoveryService } from '../../../desktop/src/main/maker-host/oversizedAttachmentRecoveryCore.js';
import { authenticatePiProxySession, registerPiProxySession } from '../../../desktop/src/main/maker-host/pi-proxy-session-auth.js';
import { createSilentEncryptedRetryStore } from '../../../desktop/src/main/maker-host/silentEncryptedRetryCore.js';
import { isClaudeSubscriptionProviderId, isXaiSubscriptionProviderId } from '../../../desktop/src/main/maker-host/subscription-account-kind.js';
import type { createSubscriptionFastRequestPolicy } from '../../../desktop/src/main/maker-host/subscriptionFastRequestCore.js';
import type { createAnthropicResponsesBridgeHost } from '../../../desktop/src/main/maker-host/anthropicResponsesBridgeHostCore.js';
import type { createPiSubscriptionWebSocket } from '../../../desktop/src/main/maker-host/piSubscriptionWebSocketCore.js';
import { hostBlobStore, hostMediaIngest, hostMediaJournal } from '../media-store.js';
import { hostOutbound, resolveHostOutboundProxy } from '../outbound.mjs';

type HttpResponse = { headersSent?: boolean; writeHead(status: number, headers: Record<string, string>): unknown; end(body: string): unknown };

/** Without a Codex runtime there is no subscription bridge: refuse instead of using the gateway. */
function refuseSubscriptionRoute(res: HttpResponse): void {
  if (res.headersSent) return;
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', code: 'subscription_route_unavailable',
    message: 'Subscription routes are not available without the Codex runtime in this Cindy Host.' } }));
}

const sameSecret = (candidate: string, expected: string): boolean => {
  const a = Buffer.from(candidate), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const header = (headers: Readonly<Record<string, string>>, name: string): string | null => {
  const value = headers[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/**
 * The desktop Claude and Pi loopback proxy (anthropicCompatProxyHostCore.ts), assembled
 * with this owner's Node IO. The Host's loopback proxy requires inbound credentials:
 * a valid Pi session token, the current gateway key, or the per-runtime secret this
 * runtime gives its own Claude Code processes in place of the provider placeholder.
 */
export function createHostClaudeProxyRuntime(options: {
  profileDir: string;
  /** The account gateway, read on every request. */
  gateway: () => { credential?: string | null; endpoint?: string | null } | null | undefined;
  /** Shared with the Codex runtime: one subscription Fast policy instance per owner. */
  fastRequestPolicy: ReturnType<typeof createSubscriptionFastRequestPolicy>;
  isOpenAiSubscriptionProviderId(providerId?: string | null): boolean;
  /** The ChatGPT and SuperGrok bridge (codex-runtime.ts); absent when the Host has no Codex runtime. */
  subscriptions?: {
    bridge: ReturnType<typeof createAnthropicResponsesBridgeHost>;
    piWebSocket: ReturnType<typeof createPiSubscriptionWebSocket>;
  } | null;
  /** Claude Code session id (x-claude-code-session-id) → Cindy task id, from the live Maker. */
  resolveTaskId(sdkSessionId: string): string | null;
}) {
  const owner = activeOwnerScopeKey();
  let closed = false;
  const current = () => !closed && owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending();
  const getUserDataDir = () => { if (!current()) throw new Error('CLAUDE_PROXY_OWNER_CHANGED'); return options.profileDir; };
  const subscriptions = options.subscriptions ?? null;
  // 32 random bytes each, kept only in memory and handed to the CLI through its environment. One
  // stands for the provider placeholder, the other for the gateway key: the proxy routes each
  // request as the desktop routes the credential it replaces, and a gateway request always carries
  // the current key, so a running task survives a key change.
  const runtimeSecret = randomBytes(32).toString('base64url');
  const gatewaySecret = randomBytes(32).toString('base64url');
  const served = new Set<string>();
  const piRegistrations = new Set<() => void>();

  const rejection: InboundRejection = { status: 401, code: 'inbound_credentials_required',
    message: 'This local proxy only accepts requests from the agents Cindy started.' };
  // Shared-provider guests (remote tasks, M3) also carry a valid route token; the Host does not
  // run remote tasks yet, so it is not admitted here. Add it before remote tasks are enabled.
  const authorizeInbound = (ctx: InboundAdmissionCtx): InboundRejection | null => {
    if (!current()) return rejection;
    const piSessionId = header(ctx.headers, 'x-cindy-pi-session-id');
    if (piSessionId) {
      return authenticatePiProxySession(piSessionId, header(ctx.headers, 'x-cindy-pi-session-token')) ? null : rejection;
    }
    const key = header(ctx.headers, 'x-api-key');
    if (!key) return rejection;
    if (sameSecret(key, runtimeSecret)) {
      // The proxy routes this exactly as the provider placeholder the desktop CLI sends.
      ctx.headers['x-api-key'] = CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY;
      return null;
    }
    const gatewayKey = options.gateway()?.credential;
    if (sameSecret(key, gatewaySecret)) {
      // Routed as the desktop routes a CLI that holds the gateway key, with the key current now.
      if (!gatewayKey) return rejection;
      ctx.headers['x-api-key'] = gatewayKey;
      return null;
    }
    return gatewayKey && sameSecret(key, gatewayKey) ? null : rejection;
  };

  const silentRetry = createSilentEncryptedRetryStore({ getUserDataDir });
  const recovery = createAttachmentRecoveryService({ getUserDataDir,
    media: { ...hostBlobStore, ...hostMediaIngest, ...hostMediaJournal } });
  const ports: AnthropicCompatProxyHostPorts = {
    createAttachmentRecovery: (...args) => recovery.createAttachmentRecovery(...args),
    outboundFetch: (...args) => hostOutbound.outboundFetch(...args),
    resolveDesktopOutboundProxy: (...args) => resolveHostOutboundProxy(...args),
    isOpenAiSubscriptionProviderId: providerId => options.isOpenAiSubscriptionProviderId(providerId),
    isClaudeSubscriptionProviderId: (...args) => isClaudeSubscriptionProviderId(...args),
    isXaiSubscriptionProviderId: (...args) => isXaiSubscriptionProviderId(...args),
    subscriptionRequestAllowsFast: (...args) => options.fastRequestPolicy.subscriptionRequestAllowsFast(...args),
    withSubscriptionFastRequestPolicy: (...args) => options.fastRequestPolicy.withSubscriptionFastRequestPolicy(...args),
    claudeUpstreamEndpoint: () => (current() ? options.gateway()?.endpoint ?? '' : ''),
    readSilentEncryptedRetrySettings: () => silentRetry.readSilentEncryptedRetrySettings(),
    ...(subscriptions ? {
      getResponsesBridgeHandler: (...args) => subscriptions.bridge.getResponsesBridgeHandler(...args),
      getPiNativeSubscriptionHandler: (...args) => subscriptions.bridge.getPiNativeSubscriptionHandler(...args),
      resolvePiWebSocketUpstream: (...args) => subscriptions.piWebSocket.resolvePiWebSocketUpstream(...args),
      createPiWebSocketRequestPreparer: (...args) => subscriptions.piWebSocket.createPiWebSocketRequestPreparer(...args),
      piWebSocketTransforms: (...args) => subscriptions.piWebSocket.piWebSocketTransforms(...args),
    } satisfies Partial<AnthropicCompatProxyHostPorts> : {
      // An explicit local refusal, never a fall-through to the gateway.
      getResponsesBridgeHandler: () => ({ handle: async ({ res }) => refuseSubscriptionRoute(res) }),
      getPiNativeSubscriptionHandler: () => async ({ res }) => refuseSubscriptionRoute(res),
      // No WebSocket upstream: Pi falls back to HTTP, where the subscription handler refuses.
      resolvePiWebSocketUpstream: () => null,
      createPiWebSocketRequestPreparer: () => async () => { throw new Error('PI_WEBSOCKET_ROUTE_UNAVAILABLE'); },
      piWebSocketTransforms: () => { throw new Error('PI_WEBSOCKET_ROUTE_UNAVAILABLE'); },
    } satisfies Partial<AnthropicCompatProxyHostPorts>),
    authorizeInbound,
  };
  const proxy = createAnthropicCompatProxyHost(ports);
  // The desktop host wiring (maker-host/index.ts:1431, register.ts:8227-8233).
  proxy.setClaudeProxyGatewayKeyReader(() => (current() ? options.gateway()?.credential || null : null));
  proxy.setClaudeProxyOwnerBoundaryPendingChecker(isAppSessionBoundaryPending);
  proxy.setClaudeProxyOwnerScopeKeyReader(activeOwnerScopeKey);
  proxy.setClaudeProxySessionIdResolver((sdkSessionId) => {
    if (isAppSessionBoundaryPending()) return null;
    const taskId = options.resolveTaskId(sdkSessionId);
    if (taskId) served.add(taskId);
    return taskId;
  });

  return {
    ready: () => proxy.ensureAnthropicCompatProxyReady(),
    isReady: () => proxy.isAnthropicCompatProxyHandleReady(),
    /** The Claude and Pi endpoint: the loopback proxy once ready, else the upstream (with a log). */
    endpoint: () => proxy.getClaudeEndpoint(),
    piGatewayRequestAgent: proxy.piGatewayRequestAgent,
    /** What this runtime's Claude Code processes send instead of the provider placeholder. */
    inboundSecret: () => runtimeSecret,
    /** What this runtime's Claude Code processes send instead of the gateway key. */
    gatewayInboundSecret: () => gatewaySecret,
    registerPiProxySession: ((...args: Parameters<typeof registerPiProxySession>) => {
      if (!current()) throw new Error('CLAUDE_PROXY_OWNER_CHANGED');
      served.add(args[0]);
      const dispose = registerPiProxySession(...args);
      const release = () => { piRegistrations.delete(release); dispose(); };
      piRegistrations.add(release);
      return release;
    }) as typeof registerPiProxySession,
    /** A task's process closed: its background activity ends, as on the desktop (register.ts:6286). */
    closeSession(taskId: string) {
      clearClaudeSessionBackgroundActivity(taskId);
    },
    async close() {
      closed = true;
      for (const release of [...piRegistrations]) release();
      await proxy.disposeAnthropicCompatProxy();
      // The Host outlives owners: drop the route records of the tasks this runtime served.
      for (const taskId of served) {
        forgetClaudeSessionRoute(taskId);
        clearClaudeSessionBackgroundActivity(taskId);
      }
      served.clear();
    },
  };
}
