import type { RoutingDecision } from '@cindy/anthropic-compat-proxy';
import { readFileSync } from 'node:fs';
import type { HeadlessConfigStore, HeadlessProviderProfile } from './config.js';
import type { HeadlessSecretStore } from './secret-store.js';
import type { HeadlessSessionStorageContract } from './session-types.js';
import type { HeadlessCindyAccountService } from './cindy-account.js';

const PROXY_PLACEHOLDER_KEY = 'cindy-headless-proxy-placeholder';
const MISSING_PROVIDER_KEY = 'cindy-headless-missing-provider-key';

/**
 * Resolves a Claude Code request to the provider selected by its Cindy
 * session.  Credentials are read only at the loopback boundary and are never
 * copied into session metadata, the catalog, process arguments, or logs.
 */
export class HeadlessProviderRouter {
  private readonly claudeSdkToSession = new Map<string, string>();
  private readonly codexThreadToSession = new Map<string, string>();

  constructor(
    private readonly sessions: HeadlessSessionStorageContract,
    private readonly config: HeadlessConfigStore,
    private readonly secrets: HeadlessSecretStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly cindyAccount?: HeadlessCindyAccountService,
  ) {}

  registerClaudeSdkSession(sessionId: string, sdkSessionId: string): void {
    if (sessionId && sdkSessionId) this.claudeSdkToSession.set(sdkSessionId, sessionId);
  }

  forgetSession(sessionId: string): void {
    for (const [sdkSessionId, mappedSessionId] of this.claudeSdkToSession) {
      if (mappedSessionId === sessionId) this.claudeSdkToSession.delete(sdkSessionId);
    }
    for (const [threadId, mappedSessionId] of this.codexThreadToSession) {
      if (mappedSessionId === sessionId) this.codexThreadToSession.delete(threadId);
    }
  }

  registerCodexThread(sessionId: string, threadId: string): void {
    if (sessionId && threadId) this.codexThreadToSession.set(threadId, sessionId);
  }

  forgetCodexThread(threadId: string): void {
    this.codexThreadToSession.delete(threadId);
  }

  /** Claude gets a non-secret placeholder; this router replaces it per request. */
  proxyAuthEnv(): Record<string, string> {
    return { ANTHROPIC_API_KEY: PROXY_PLACEHOLDER_KEY };
  }

  async hasClaudeCredential(): Promise<boolean> {
    if (this.cindyAccount?.getGatewayKey()) return true;
    if (this.systemClaudeKey()) return true;
    const config = await this.config.read();
    for (const profile of config.providerProfiles ?? []) {
      if (!profile.enabled || !profile.secretRef || !supportsClaude(profile)) continue;
      if (await this.secrets.get(profile.secretRef)) return true;
    }
    return false;
  }

  async hasCodexProviderCredential(): Promise<boolean> {
    if (this.cindyAccount?.getGatewayKey()) return true;
    const config = await this.config.read();
    for (const profile of config.providerProfiles ?? []) {
      if (!profile.enabled || !profile.secretRef || !profile.custom?.runtimes.codex) continue;
      if (await this.secrets.get(profile.secretRef)) return true;
    }
    return false;
  }

  async routeClaudeRequest(sdkSessionId: string | undefined): Promise<RoutingDecision | null> {
    if (!sdkSessionId) return null;
    const sessionId = this.claudeSdkToSession.get(sdkSessionId);
    if (!sessionId) return null;
    const session = await this.sessions.get(sessionId);
    if (!session || session.agentKind !== 'claude-code') return null;

    const config = await this.config.read();
    const profile = session.providerId
      ? (config.providerProfiles ?? []).find((candidate) => candidate.id === session.providerId)
      : undefined;
    if (session.providerId === 'xd') return this.cindyGatewayRoute('claude-code');
    const route = claudeRouteFor(profile);
    if (!route) return null;
    const secret = await this.resolveSecret(profile);
    return {
      ...(route.upstream ? { upstreamOverride: route.upstream } : {}),
      headerOverride: {
        ...route.headers,
        // Set both header forms because Anthropic-compatible gateways vary.
        'x-api-key': secret ?? MISSING_PROVIDER_KEY,
        authorization: `Bearer ${secret ?? MISSING_PROVIDER_KEY}`,
      },
    };
  }

  async routeCodexRequest(threadId: string | undefined): Promise<RoutingDecision | null> {
    if (!threadId) return null;
    const sessionId = this.codexThreadToSession.get(threadId);
    if (!sessionId) return null;
    const session = await this.sessions.get(sessionId);
    if (!session || session.agentKind !== 'codex' || !session.providerId) return null;
    const config = await this.config.read();
    if (session.providerId === 'xd') return this.cindyGatewayRoute('codex');
    const profile = (config.providerProfiles ?? []).find((candidate) => candidate.id === session.providerId);
    const runtime = profile?.enabled ? profile.custom?.runtimes.codex : undefined;
    if (!profile || !runtime) return null;
    const secret = await this.resolveSecret(profile);
    return {
      upstreamOverride: runtime.baseUrl,
      headerOverride: {
        ...(runtime.headers ?? {}),
        authorization: `Bearer ${secret ?? MISSING_PROVIDER_KEY}`,
      },
    };
  }

  private async resolveSecret(profile: HeadlessProviderProfile | undefined): Promise<string | null> {
    if (profile?.secretRef) return this.secrets.get(profile.secretRef);
    return this.systemClaudeKey();
  }

  private async cindyGatewayRoute(agent: 'claude-code' | 'codex'): Promise<RoutingDecision | null> {
    // Older in-process test/adapter shims only expose the synchronous gateway
    // accessors. Keep that compatibility while real account services refresh
    // a near-expiry Cindy credential before every routed request.
    const refreshRoute = this.cindyAccount && typeof this.cindyAccount.ensureGatewayRoute === 'function'
      ? await this.cindyAccount.ensureGatewayRoute()
      : null;
    const key = refreshRoute?.apiKey ?? this.cindyAccount?.getGatewayKey();
    const endpoint = refreshRoute?.endpoint ?? this.cindyAccount?.getGatewayEndpoint();
    if (!key || !endpoint) return null;
    return {
      // Cindy model-access returns the gateway root. Claude Code itself calls
      // `/v1/messages`, while Codex app-server calls `/responses` relative to
      // its configured base URL. Keep the former root unchanged, and give the
      // latter the OpenAI-compatible `/v1` base so it reaches `/v1/responses`.
      upstreamOverride: agent === 'codex' ? codexGatewayBaseUrl(endpoint) : endpoint,
      headerOverride: { 'x-api-key': key, authorization: `Bearer ${key}` },
    };
  }

  private systemClaudeKey(): string | null {
    const direct = this.env.CINDY_ANTHROPIC_API_KEY?.trim();
    if (direct) return direct;
    const directory = this.env.CREDENTIALS_DIRECTORY?.trim();
    if (!directory) return null;
    try {
      const value = readFileSync(`${directory}/anthropic_api_key`, 'utf8').trim();
      return value || null;
    } catch {
      return null;
    }
  }
}

/** Normalizes the server-issued Cindy gateway root for Codex Responses API. */
function codexGatewayBaseUrl(endpoint: string): string {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/v1') return url.toString().replace(/\/$/, '');
  url.pathname = `${path}/v1`;
  return url.toString().replace(/\/$/, '');
}

function supportsClaude(profile: HeadlessProviderProfile): boolean {
  return profile.id === 'anthropic' || Boolean(profile.custom?.runtimes['claude-code']);
}

function claudeRouteFor(profile: HeadlessProviderProfile | undefined): {
  upstream?: string;
  headers: Record<string, string>;
} | null {
  if (!profile) return { upstream: 'https://api.anthropic.com', headers: {} };
  if (!profile.enabled) return null;
  if (profile.id === 'anthropic') return { upstream: 'https://api.anthropic.com', headers: {} };
  const runtime = profile.custom?.runtimes['claude-code'];
  if (!runtime) return null;
  return { upstream: runtime.baseUrl, headers: { ...(runtime.headers ?? {}) } };
}
