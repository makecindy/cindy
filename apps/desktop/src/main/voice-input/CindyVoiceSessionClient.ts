import { app } from 'electron';
import {
  LEGACY_MANAGED_REFINE_REQUEST_LIMIT,
  resolveManagedRefineRequestLimit,
  type RefineRequestBudget,
} from '@cindy/voice-input-core';

import * as authManager from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { outboundFetch } from '../maker-host/outbound-fetch.desktop.js';
import { ServerApiError, serverApiFetch } from '../serverApiClient.desktop.js';
import { getAppCapabilities, requireAppCapability } from '../appCapabilities.js';
import { createLogger } from '../logger.js';

const log = createLogger('voice-input:cindy-voice-session');

const VOICE_SESSION_REQUEST_TIMEOUT_MS = 10_000;
const VOICE_REFINE_WARMUP_TIMEOUT_MS = 10_000;
export const DEFAULT_CINDY_VOICE_MAX_SESSION_MS = 180_000;

/**
 * Delegates refiner model choice and failover to voice-server: the session is
 * created with this marker and refine targets carry it as the provider, so
 * the server runs its own configured model chain (see cindy-server
 * docs/voice-server.md).
 */
export const CINDY_MANAGED_REFINER_PROVIDER = 'auto';

export type CindyVoiceAsrHandshakeMode = 'ticket' | 'direct-upgrade';

/**
 * Data-plane connection descriptor returned by CindyVoiceRunContext.
 *
 * Defaults to the live 2-step `ticket` handshake (`POST /api/voice/sessions` ->
 * WS connect), while reserving optional headers, server-reported session limits,
 * and `onUpgradeResponse` header parsing so a future voice-server single-step
 * WS Upgrade endpoint can negotiate session metadata in one round trip with
 * zero provider-layer rewrites.
 */
export type CindyVoiceAsrConnection = {
  websocketUrl: string;
  authorizationToken: string;
  headers?: Record<string, string>;
  maxSessionMs?: number;
  handshakeMode?: CindyVoiceAsrHandshakeMode;
  onUpgradeResponse?: (headers: Record<string, string | string[] | undefined>) => void;
};

export type CindyVoiceAsrSession = {
  sessionId: string;
  ticket: string;
  expiresAt: string;
  /** Optional server-reported session ceiling in milliseconds (live default 180_000). */
  maxSessionMs?: number;
  asr: {
    provider: string;
    websocketUrl: string;
    protocolProfile:
      | 'volcengine-sauc-duration'
      | 'qwen-asr-server-vad'
      | 'openai-transcription-manual';
    sampleRate: number;
    model?: string;
    resourceId?: string;
  };
  /** `maxRefineRequests` is absent on servers from before pause-time refinement. */
  refiner: { enabled: boolean; provider?: string; maxRefineRequests?: number };
};

/** Derives a `wss://`/`ws://` origin hint from `voiceApiBaseUrl` for parallel proxy resolution. */
export function getVoiceApiWebSocketOriginHint(): string | undefined {
  const baseUrl = getClientEndpoint('voiceApiBaseUrl');
  if (!baseUrl) return undefined;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    else if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    else if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function parsePositiveHeaderInteger(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): number | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readHeaderString(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

/** Session-scoped bridge from Cindy identity to one-shot voice data-plane tickets. */
export class CindyVoiceRunContext {
  private latestSessionId: string | null = null;
  // A client-side ASR candidate can time out while its session allocation is
  // still in flight. Do not let that late response overwrite the session used
  // by a newer fallback candidate (which would attach refinement to the wrong
  // upstream run).
  private connectionGeneration = 0;
  /**
   * Set when session allocation had to drop the 'auto' refiner marker for a
   * voice-server that predates the delegated-refinement contract. Dictation
   * must keep working on such servers; only refinement degrades (raw ASR text
   * stays), so refine/warmup calls fail fast instead of hitting the server.
   */
  private refinerUnavailableOnServer = false;
  private latestRefineRequestLimit = LEGACY_MANAGED_REFINE_REQUEST_LIMIT;
  private latestMaxSessionMs = DEFAULT_CINDY_VOICE_MAX_SESSION_MS;

  constructor(
    private readonly sourceLanguage: string | undefined,
    private readonly refinerProvider: string | undefined,
  ) {}

  async createAsrConnection(asrProvider: string): Promise<CindyVoiceAsrConnection> {
    const requestGeneration = ++this.connectionGeneration;
    const allocationStartedAt = performance.now();
    let session: CindyVoiceAsrSession;
    let usedLegacyRefinerFallback = false;
    try {
      session = await createCindyVoiceSession({
        asrProvider,
        refinerProvider: this.refinerUnavailableOnServer ? undefined : this.refinerProvider,
        sourceLanguage: this.sourceLanguage,
      });
    } catch (error) {
      // A voice-server that has not deployed the 'auto' contract rejects the
      // whole session with 400 — which would kill dictation, not just
      // refinement. Retry once without managed refinement so ASR still works.
      const legacyServerRejection = this.refinerProvider === CINDY_MANAGED_REFINER_PROVIDER
        && !this.refinerUnavailableOnServer
        && error instanceof ServerApiError
        && error.statusCode === 400;
      if (!legacyServerRejection) throw error;
      // The flag is only set after the no-refiner retry SUCCEEDS: a 400 that
      // was actually about this ASR candidate (not the 'auto' marker) fails
      // the retry too, and the next ASR candidate on this same run context
      // must still attempt managed refinement.
      session = await createCindyVoiceSession({
        asrProvider,
        refinerProvider: undefined,
        sourceLanguage: this.sourceLanguage,
      });
      usedLegacyRefinerFallback = true;
    }
    if (requestGeneration !== this.connectionGeneration) {
      throw new Error('Cindy voice ASR session allocation was superseded by a newer provider attempt.');
    }
    if (usedLegacyRefinerFallback) this.refinerUnavailableOnServer = true;
    this.latestSessionId = session.sessionId;
    this.latestRefineRequestLimit = resolveManagedRefineRequestLimit(session.refiner?.maxRefineRequests);
    if (typeof session.maxSessionMs === 'number' && Number.isFinite(session.maxSessionMs) && session.maxSessionMs > 0) {
      this.latestMaxSessionMs = Math.round(session.maxSessionMs);
    }
    // Session allocation is the HTTP half of managed ASR startup; the socket
    // handshake that follows is timed separately by the provider. Splitting the
    // two is what makes a slow start attributable.
    log.debug('asr session allocated', {
      asrProvider,
      elapsedMs: Math.round(performance.now() - allocationStartedAt),
      legacyRefinerFallback: usedLegacyRefinerFallback,
    });
    return {
      websocketUrl: session.asr.websocketUrl,
      authorizationToken: session.ticket,
      maxSessionMs: this.latestMaxSessionMs,
      handshakeMode: 'ticket',
      onUpgradeResponse: (headers) => {
        if (requestGeneration !== this.connectionGeneration) return;
        const headerSessionId = readHeaderString(headers, 'x-voice-session-id');
        if (headerSessionId) this.latestSessionId = headerSessionId;
        const headerMaxSessionMs = parsePositiveHeaderInteger(headers, 'x-voice-max-session-ms');
        if (headerMaxSessionMs) this.latestMaxSessionMs = headerMaxSessionMs;
        const headerMaxRefineRequests = parsePositiveHeaderInteger(headers, 'x-voice-max-refine-requests');
        if (headerMaxRefineRequests) {
          this.latestRefineRequestLimit = resolveManagedRefineRequestLimit(headerMaxRefineRequests);
        }
      },
    };
  }

  /**
   * Maximum ASR session duration reported by the voice service (default 180s).
   * Used by VoiceInputController to schedule proactive seamless session rotation.
   */
  maxSessionMs(): number {
    return this.latestMaxSessionMs;
  }

  /**
   * Refinement requests the current session accepts. Refines target the latest
   * session, so a reconnect (new session id) starts a fresh count.
   */
  refineRequestBudget(): RefineRequestBudget {
    return { sessionKey: this.latestSessionId ?? '', limit: this.latestRefineRequestLimit };
  }

  async createRefinerTarget(
    refinerProvider: string,
    options?: { forceRefresh?: boolean },
  ): Promise<{
    url: string;
    authorization: string;
  }> {
    if (this.refinerUnavailableOnServer) {
      throw new Error('Cindy voice service on this server does not support managed refinement yet.');
    }
    // Captured before any await: the controller counts this request against
    // refineRequestBudget() in the same tick, so a reconnect during the token
    // refresh must not move the request to the new session.
    const sessionId = this.latestSessionId;
    if (!sessionId) throw new Error('Voice ASR session is not connected yet.');
    let token = authManager.getAccessToken();
    if (!token || options?.forceRefresh) {
      await authManager.refresh();
      token = authManager.getAccessToken();
    }
    if (!token) throw new Error('Cindy login is required for voice refinement.');
    const baseUrl = getClientEndpoint('voiceApiBaseUrl');
    if (!baseUrl) throw new Error('Cindy voice service is unavailable in this region.');
    return {
      url: `${baseUrl}/api/voice/sessions/${encodeURIComponent(sessionId)}/refine?provider=${encodeURIComponent(refinerProvider)}`,
      authorization: `Bearer ${token}`,
    };
  }

  /**
   * Fire-and-forget prompt-cache warmup. Called right after the ASR session
   * exists with a request that shares the real refinement's prompt prefix
   * (empty dictationText), so the upstream cache is hot before the user stops
   * speaking. Failures are swallowed by the caller: warmup must never affect
   * the dictation flow, and the refine allowance is not consumed server-side.
   */
  async warmRefiner(input: {
    system: string;
    user: unknown;
    promptCacheKey: string;
  }): Promise<void> {
    if (this.refinerUnavailableOnServer) {
      throw new Error('Cindy voice service on this server does not support managed refinement yet.');
    }
    const sessionId = this.latestSessionId;
    if (!sessionId) throw new Error('Voice ASR session is not connected yet.');
    const token = authManager.getAccessToken();
    if (!token) throw new Error('Cindy login is required for voice refinement.');
    const baseUrl = getClientEndpoint('voiceApiBaseUrl');
    if (!baseUrl) throw new Error('Cindy voice service is unavailable in this region.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VOICE_REFINE_WARMUP_TIMEOUT_MS);
    try {
      const response = await outboundFetch(
        `${baseUrl}/api/voice/sessions/${encodeURIComponent(sessionId)}/refine-warmup`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt_cache_key: input.promptCacheKey,
            messages: [
              { role: 'system', content: input.system },
              { role: 'user', content: JSON.stringify(input.user) },
            ],
          }),
        },
      );
      if (!response.ok) throw new Error(`Voice refine warmup failed with status ${response.status}`);
      await response.arrayBuffer().catch(() => undefined);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function isCindyVoiceServiceReady(): boolean {
  return Boolean(
    getAppCapabilities().canUseCindyAccountServices
    && getClientEndpoint('voiceApiBaseUrl')
    && authManager.getAccessToken(),
  );
}

async function createCindyVoiceSession(input: {
  asrProvider: string;
  refinerProvider?: string;
  sourceLanguage?: string;
}): Promise<CindyVoiceAsrSession> {
  requireAppCapability('canUseCindyAccountServices', 'Cindy voice requires a Cindy account.');
  if (!getClientEndpoint('voiceApiBaseUrl')) {
    throw new Error('Cindy voice service is unavailable in this region.');
  }
  const request = {
    baseUrl: () => getClientEndpoint('voiceApiBaseUrl'),
    method: 'POST',
    body: {
      mode: 'dictation',
      language: input.sourceLanguage,
      client: 'desktop',
      clientVersion: app.getVersion(),
      asrProvider: input.asrProvider,
      refinerProvider: input.refinerProvider,
    },
    timeoutMs: VOICE_SESSION_REQUEST_TIMEOUT_MS,
  } as const;
  let session: CindyVoiceAsrSession;
  try {
    session = await serverApiFetch<CindyVoiceAsrSession>('/api/voice/sessions', request);
  } catch (error) {
    // serverApiFetch already handles TOKEN_EXPIRED. A plain 401 can still
    // indicate a revoked cached access token, so refresh once and retry the
    // allocation before surfacing the auth failure.
    if (!(error instanceof ServerApiError) || error.statusCode !== 401 || error.code !== 'UNAUTHORIZED') {
      throw error;
    }
    if (!await authManager.refresh()) throw error;
    session = await serverApiFetch<CindyVoiceAsrSession>('/api/voice/sessions', request);
  }
  if (
    session.asr.provider !== input.asrProvider
    || !session.ticket
    || !session.sessionId
    || !/^wss?:\/\//.test(session.asr.websocketUrl)
  ) {
    throw new Error('Cindy voice service returned an invalid session.');
  }
  return session;
}
