import { CindyAuthClient, type AuthMe, type AuthTokenPair } from '@cindy/auth-client';
import { resolveClientEndpointsStrict, type ClientEndpointMap } from '@cindy/maker-shared/client-endpoints';
import type { HeadlessConfigStore, HeadlessManagedModel } from './config.js';
import { MemorySecretStore, type HeadlessSecretStore } from './secret-store.js';

const MANIFEST_URLS = {
  cn: 'https://hotfix.cindy.com.cn/cindy/endpoint.json',
  global: 'https://hotfix.cindy.app/cindy/endpoint.json',
} as const;

/** Stable credential-store reference; the config only stores account routing metadata. */
export const CINDY_ACCOUNT_REFRESH_SECRET_REF = 'cindy_account_refresh';

export interface HeadlessAccountState {
  authenticated: boolean;
  membership?: { id: string; name: string; email: string | null };
  /** False means the refresh credential is memory-only and is lost on restart. */
  persistent?: boolean;
  error?: string;
}

/**
 * Cindy account integration for an unattended Linux host.  It owns no Agent
 * OAuth: the short-lived access token and gateway key stay in memory.  The
 * refresh credential is held only by an injected encrypted secret store, so a
 * service restart can restore the Cindy account without ever writing a token
 * into config, logs, command lines, or the working tree.
 */
export class HeadlessCindyAccountService {
  private gatewayKey: string | null = null;
  private gatewayEndpoint: string | null = null;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private endpoints: ClientEndpointMap | null = null;
  private state: HeadlessAccountState = { authenticated: false };
  private refreshInFlight: Promise<AuthTokenPair> | null = null;
  private refreshTokenIsPersistent = false;

  constructor(
    private readonly config: HeadlessConfigStore,
    private readonly fetchImpl: typeof fetch = fetch,
    // The memory default keeps isolated unit tests credential-free. Production
    // injects the daemon's durable credential store from the composition root.
    private readonly secrets: HeadlessSecretStore = new MemorySecretStore(),
  ) {}

  async restore(): Promise<HeadlessAccountState> {
    const config = await this.config.read();
    this.resetRuntime();
    if (!config.account) return this.state = { authenticated: false };
    try {
      this.endpoints = await resolveCindyEndpoints(config.account.region, this.fetchImpl);
      const refreshToken = await this.secrets.get(CINDY_ACCOUNT_REFRESH_SECRET_REF);
      if (!refreshToken) {
        // Do not expose an unauthenticated relay route. This can occur after
        // migrating an old config whose secret was never persisted.
        this.resetRuntime();
        return this.state = {
          authenticated: false,
          error: 'Cindy login needs its saved refresh credential. Run cindy login again to restore this Linux host.',
        };
      }
      this.refreshToken = refreshToken;
      this.refreshTokenIsPersistent = true;
      await this.refreshTokens(config.account.region, config.account.deviceId);
      return await this.loadAuthenticatedState(config.account.region, config.account.deviceId);
    } catch (error) {
      this.resetRuntime();
      return this.state = { authenticated: false, error: accountError('restore', error) };
    }
  }

  getState(): HeadlessAccountState { return { ...this.state }; }
  getGatewayKey(): string | null { return this.gatewayKey; }
  getGatewayEndpoint(): string | null { return this.gatewayEndpoint; }
  getDeviceLinkApiBase(): string | null { return this.endpoints?.deviceLinkApiBaseUrl || null; }

  /**
   * Called at the model proxy boundary. It refreshes a near-expiry Cindy token
   * and replaces a gateway key only when needed; agent runtimes never see the
   * Cindy refresh credential.
   */
  async ensureGatewayRoute(): Promise<{ endpoint: string; apiKey: string } | null> {
    const config = await this.config.read();
    if (!config.account || !this.refreshToken || !this.endpoints) return null;
    try {
      if (!this.gatewayKey || !this.gatewayEndpoint || !this.accessToken || this.isAccessTokenExpiring(this.accessToken)) {
        await this.refreshTokens(config.account.region, config.account.deviceId);
        await this.refreshGatewayResources(config);
      }
      return this.gatewayKey && this.gatewayEndpoint
        ? { endpoint: this.gatewayEndpoint, apiKey: this.gatewayKey }
        : null;
    } catch (error) {
      this.state = { authenticated: false, error: accountError('refresh', error) };
      return null;
    }
  }

  /** Used by Device Link reconnects; refreshes before an expiring JWT is handed to the relay. */
  async getRelayToken(): Promise<string | null> {
    const config = await this.config.read();
    if (!config.account || !this.endpoints || !this.refreshToken) return null;
    if (this.accessToken && !this.isAccessTokenExpiring(this.accessToken)) return this.accessToken;
    try {
      await this.refreshTokens(config.account.region, config.account.deviceId);
      return this.accessToken;
    } catch (error) {
      this.state = { authenticated: false, error: error instanceof Error ? error.message : String(error) };
      return null;
    }
  }

  /**
   * Accepts a just-completed local login over the daemon's owner-only Unix
   * socket. The daemon injects a persistent encrypted store in production;
   * unit tests retain the memory-only default.
   */
  async activateLogin(input: {
    region: 'cn' | 'global'; deviceId: string; accessToken: string; refreshToken: string;
  }): Promise<HeadlessAccountState> {
    try {
      this.endpoints = await resolveCindyEndpoints(input.region, this.fetchImpl);
      this.accessToken = input.accessToken;
      this.refreshToken = input.refreshToken;
      const me = await createAuthClient(this.endpoints, input.region, input.deviceId, this.fetchImpl).getMe(input.accessToken);
      const { endpoint, apiKey, models } = await this.fetchGatewayResources(input.region, input.deviceId, false);
      // The refresh token is never written to config or a plaintext fallback.
      // Persist account routing metadata only when the credential store
      // accepted it, so a restart cannot falsely claim that this login is
      // recoverable.
      this.refreshTokenIsPersistent = await this.persistRefreshToken(input.refreshToken);
      const config = await this.config.read();
      await this.config.write({
        ...config,
        account: this.refreshTokenIsPersistent ? { region: input.region, deviceId: input.deviceId } : undefined,
        managedModels: this.refreshTokenIsPersistent ? models : [],
        // A completed Cindy login makes XD the ready managed provider. This
        // keeps mobile/Desktop provider pickers and headless routing aligned.
        providerProfiles: this.refreshTokenIsPersistent
          ? enableManagedProvider(config.providerProfiles ?? [], 'xd')
          : config.providerProfiles,
      });
      this.gatewayEndpoint = endpoint;
      this.gatewayKey = apiKey;
      return this.state = membershipState(me, this.refreshTokenIsPersistent);
    } catch (error) {
      this.resetRuntime();
      return this.state = { authenticated: false, error: accountError('login', error) };
    }
  }

  async clearLogin(): Promise<void> {
    await this.secrets.delete(CINDY_ACCOUNT_REFRESH_SECRET_REF);
    this.resetRuntime();
    const config = await this.config.read();
    await this.config.write({ ...config, account: undefined, managedModels: [] });
    this.state = { authenticated: false };
  }

  private async refreshTokens(region: 'cn' | 'global', deviceId: string): Promise<AuthTokenPair> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      if (!this.endpoints || !this.refreshToken) throw new Error('Cindy account refresh is unavailable');
      const tokens = await createAuthClient(this.endpoints, region, deviceId, this.fetchImpl).refresh(this.refreshToken);
      if (this.refreshTokenIsPersistent) {
        // A durable login must persist a rotated credential before making it
        // authoritative in memory. Memory-only sessions intentionally skip
        // the OS store and remain explicitly non-persistent.
        await this.secrets.set(CINDY_ACCOUNT_REFRESH_SECRET_REF, tokens.refreshToken);
      }
      this.accessToken = tokens.accessToken;
      this.refreshToken = tokens.refreshToken;
      return tokens;
    })();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async loadAuthenticatedState(region: 'cn' | 'global', deviceId: string): Promise<HeadlessAccountState> {
    if (!this.endpoints || !this.accessToken) throw new Error('Cindy account refresh did not return an access token');
    const me = await createAuthClient(this.endpoints, region, deviceId, this.fetchImpl).getMe(this.accessToken);
    const config = await this.config.read();
    await this.refreshGatewayResources(config);
    return this.state = membershipState(me);
  }

  private async refreshGatewayResources(config: Awaited<ReturnType<HeadlessConfigStore['read']>>): Promise<void> {
    if (!config.account || !this.endpoints || !this.accessToken) throw new Error('Cindy account is not connected');
    const { endpoint, apiKey, models } = await this.fetchGatewayResources(config.account.region, config.account.deviceId, true);
    this.gatewayEndpoint = endpoint;
    this.gatewayKey = apiKey;
    await this.config.write({ ...config, managedModels: models });
  }

  private async fetchGatewayResources(
    region: 'cn' | 'global',
    deviceId: string,
    retryUnauthorized: boolean,
  ): Promise<{ endpoint: string; apiKey: string; models: HeadlessManagedModel[] }> {
    if (!this.endpoints || !this.accessToken) throw new Error('Cindy account is not connected');
    try {
      const [credentials, models] = await Promise.all([
        fetchGatewayCredentials(this.endpoints, this.accessToken, this.fetchImpl),
        fetchGatewayModels(this.endpoints, this.accessToken, this.fetchImpl),
      ]);
      return { ...credentials, models };
    } catch (error) {
      if (!retryUnauthorized || !isUnauthorized(error)) throw error;
      await this.refreshTokens(region, deviceId);
      return this.fetchGatewayResources(region, deviceId, false);
    }
  }

  private resetRuntime(): void {
    this.gatewayKey = null;
    this.gatewayEndpoint = null;
    this.accessToken = null;
    this.refreshToken = null;
    this.endpoints = null;
    this.refreshInFlight = null;
    this.refreshTokenIsPersistent = false;
  }

  private async persistRefreshToken(refreshToken: string): Promise<boolean> {
    try {
      await this.secrets.set(CINDY_ACCOUNT_REFRESH_SECRET_REF, refreshToken);
      return true;
    } catch (error) {
      if (isSecretServiceUnavailable(error)) return false;
      throw error;
    }
  }

  private isAccessTokenExpiring(token: string): boolean {
    const segment = token.split('.')[1];
    if (!segment) return false;
    try {
      const text = Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const exp = (JSON.parse(text) as { exp?: unknown }).exp;
      return typeof exp === 'number' && exp * 1000 - Date.now() <= 30_000;
    } catch { return false; }
  }
}

function enableManagedProvider(
  profiles: NonNullable<Awaited<ReturnType<HeadlessConfigStore['read']>>['providerProfiles']>,
  id: string,
) {
  const index = profiles.findIndex((profile) => profile.id === id);
  if (index < 0) return [...profiles, { id, enabled: true }];
  return profiles.map((profile, current) => current === index ? { ...profile, enabled: true } : profile);
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof Error && /\(401\)/.test(error.message);
}

function accountError(stage: 'login' | 'restore' | 'refresh', error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Cindy account ${stage} failed: ${message}`;
}

export async function resolveCindyEndpoints(region: 'cn' | 'global', fetchImpl: typeof fetch = fetch): Promise<ClientEndpointMap> {
  const response = await fetchImpl(MANIFEST_URLS[region]);
  if (!response.ok) throw new Error(`Cindy endpoint manifest request failed (${response.status})`);
  const result = resolveClientEndpointsStrict(await response.text());
  if (!result.ok) throw new Error(`Cindy endpoint manifest is invalid (${result.reason})`);
  if (!result.endpoints.authApiBaseUrl || !result.endpoints.modelAccessApiBaseUrl) {
    throw new Error('Cindy endpoint manifest does not provide account or model access services');
  }
  return result.endpoints;
}

export function createAuthClient(endpoints: ClientEndpointMap, region: 'cn' | 'global', deviceId: string, fetchImpl: typeof fetch = fetch): CindyAuthClient {
  return new CindyAuthClient({
    baseUrl: endpoints.authApiBaseUrl,
    region,
    deviceId,
    // The auth service currently accepts desktop as its non-browser native client.
    clientType: 'desktop',
    fetch: async (input, init) => {
      const response = await fetchImpl(input, init as RequestInit);
      return { ok: response.ok, status: response.status, json: () => response.json() };
    },
  });
}

export async function fetchGatewayCredentials(endpoints: ClientEndpointMap, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<{ endpoint: string; apiKey: string }> {
  const response = await fetchImpl(`${endpoints.modelAccessApiBaseUrl}/api/model-access/credentials`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`Cindy AI credentials request failed (${response.status})`);
  if (!body || typeof body !== 'object') throw new Error('Cindy AI credentials response is invalid');
  const { endpoint, apiKey } = body as { endpoint?: unknown; apiKey?: unknown };
  if (typeof endpoint !== 'string' || !isHttpUrl(endpoint) || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Cindy AI credentials response is invalid');
  }
  return { endpoint, apiKey };
}

export async function fetchGatewayModels(endpoints: ClientEndpointMap, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<HeadlessManagedModel[]> {
  const response = await fetchImpl(`${endpoints.modelAccessApiBaseUrl}/api/model-access/models`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`Cindy AI models request failed (${response.status})`);
  const entries = body && typeof body === 'object' && Array.isArray((body as { models?: unknown }).models)
    ? (body as { models: unknown[] }).models : null;
  if (!entries) throw new Error('Cindy AI models response is invalid');
  const models: HeadlessManagedModel[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== 'string' || !value.id) continue;
    const agents = Array.isArray(value.agents)
      ? value.agents.filter((agent): agent is 'codex' | 'claude-code' => agent === 'codex' || agent === 'claude-code')
      : undefined;
    models.push({
      id: value.id,
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(agents?.length ? { agents } : {}),
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      ...(typeof value.contextWindow === 'number' && Number.isInteger(value.contextWindow) && value.contextWindow > 0 ? { contextWindow: value.contextWindow } : {}),
      ...(Array.isArray(value.efforts) ? { efforts: value.efforts.filter((effort): effort is NonNullable<HeadlessManagedModel['efforts']>[number] => typeof effort === 'string' && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) } : {}),
      ...(typeof value.defaultEffort === 'string' && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.defaultEffort) ? { defaultEffort: value.defaultEffort as NonNullable<HeadlessManagedModel['defaultEffort']> } : {}),
      ...(typeof value.supportsFastMode === 'boolean' ? { supportsFastMode: value.supportsFastMode } : {}),
    });
  }
  if (models.length === 0) throw new Error('Cindy AI returned no available chat models');
  return models;
}


function membershipState(me: AuthMe, persistent = true): HeadlessAccountState {
  return {
    authenticated: true,
    membership: { id: me.membership.id, name: me.membership.displayName || 'Cindy', email: me.membership.email },
    persistent,
  };
}

function isSecretServiceUnavailable(error: unknown): boolean {
  return error instanceof Error && /Secret Service is unavailable/i.test(error.message);
}

function isHttpUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; } catch { return false; }
}
