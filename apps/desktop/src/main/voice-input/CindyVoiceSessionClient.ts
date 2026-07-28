import { app } from 'electron';

import * as authManager from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import { ServerApiError, serverApiFetch } from '../serverApiClient.js';
import { getAppCapabilities, requireAppCapability } from '../appCapabilities.js';

const VOICE_SESSION_REQUEST_TIMEOUT_MS = 10_000;
const VOICE_REFINE_WARMUP_TIMEOUT_MS = 10_000;

/**
 * Delegates refiner model choice and failover to voice-server: the session is
 * created with this marker and refine targets carry it as the provider, so
 * the server runs its own configured model chain (see cindy-server
 * docs/voice-server.md).
 */
export const CINDY_MANAGED_REFINER_PROVIDER = 'auto';

export type CindyVoiceAsrSession = {
  sessionId: string;
  ticket: string;
  expiresAt: string;
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
  refiner: { enabled: boolean; provider?: string };
};

/** Session-scoped bridge from Cindy identity to one-shot voice data-plane tickets. */
export class CindyVoiceRunContext {
  private latestSessionId: string | null = null;
  /**
   * Set when session allocation had to drop the 'auto' refiner marker for a
   * voice-server that predates the delegated-refinement contract. Dictation
   * must keep working on such servers; only refinement degrades (raw ASR text
   * stays), so refine/warmup calls fail fast instead of hitting the server.
   */
  private refinerUnavailableOnServer = false;

  constructor(
    private readonly sourceLanguage: string | undefined,
    private readonly refinerProvider: string | undefined,
  ) {}

  async createAsrConnection(asrProvider: string): Promise<{
    websocketUrl: string;
    authorizationToken: string;
  }> {
    let session: CindyVoiceAsrSession;
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
      this.refinerUnavailableOnServer = true;
    }
    this.latestSessionId = session.sessionId;
    return { websocketUrl: session.asr.websocketUrl, authorizationToken: session.ticket };
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
  const baseUrl = getClientEndpoint('voiceApiBaseUrl');
  if (!baseUrl) throw new Error('Cindy voice service is unavailable in this region.');
  const request = {
    baseUrl,
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
