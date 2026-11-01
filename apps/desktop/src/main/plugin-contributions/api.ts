import { app, net } from 'electron';
import type { z } from 'zod';
import * as wire from '../../shared/pluginContributionContract.js';
import { getAccessToken, getActiveAuthRealm, getAuthState, refresh } from '../authManager.js';
import { getClientEndpoint, getClientEndpointForRealm } from '../clientEndpointsService.js';
import { ServerApiError, serverApiFetch } from '../serverApiClient.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { assertContributionOwner, contributionOwnerKey } from './prepared.js';

const issuerCache = new Map<string, { issuer: string; until: number }>();

/** Discover issuer only from the Host's trusted auth endpoint, never from an unverified token URL. */
async function trustedIssuer(endpoint: string): Promise<string> {
  const cached = issuerCache.get(endpoint);
  if (cached && cached.until > Date.now()) return cached.issuer;
  const response = await net.fetch(
    `${endpoint.replace(/\/+$/, '')}/.well-known/openid-configuration`,
    {
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    },
  );
  if (!response.ok)
    throwIpcError('PRECONDITION_FAILED', 'Unable to resolve trusted contribution issuer');
  const value: unknown = await response.json();
  const issuer = value && typeof value === 'object' && 'issuer' in value ? value.issuer : null;
  if (typeof issuer !== 'string' || !/^https?:\/\//.test(issuer))
    throwIpcError('PRECONDITION_FAILED', 'Invalid trusted issuer configuration');
  issuerCache.set(endpoint, { issuer, until: Date.now() + 300_000 });
  return issuer;
}

export class ContributionApi {
  constructor(private readonly assertCaller?: () => Promise<void>) {}
  readonly owner = contributionOwnerKey();
  private readonly endpoint = getClientEndpoint('pluginApiBaseUrl');
  private readonly authEndpoint = getClientEndpointForRealm(getActiveAuthRealm(), 'authApiBaseUrl');
  private subject: wire.ContributionSubject | null = null;

  private async token(): Promise<string> {
    assertContributionOwner(this.owner);
    const token = getAccessToken();
    if (!token) throwIpcError('ACCOUNT_REAUTH_REQUIRED', 'Login required');
    const issuer = await trustedIssuer(this.authEndpoint);
    assertContributionOwner(this.owner);
    // Claims here only bind the response to the Host session. Plugin Server
    // authenticates the signature; decoded claims never grant submission rights.
    let claims: { iss?: string; sub?: string; ctx?: string };
    try {
      claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    } catch {
      throwIpcError('ACCOUNT_REAUTH_REQUIRED', 'Invalid account session');
    }
    if (
      claims.iss !== issuer ||
      typeof claims.sub !== 'string' ||
      claims.sub !== getAuthState().user?.id ||
      claims.ctx !== getAuthState().user?.membershipKind
    ) {
      throwIpcError('ACCOUNT_REAUTH_REQUIRED', 'Account session issuer or identity mismatch');
    }
    this.subject = { authority: issuer, membershipId: claims.sub };
    return token;
  }

  async request<S extends z.ZodTypeAny>(
    route: string,
    schema: S,
    method = 'GET',
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<z.infer<S>> {
    const run = async () => {
      const token = await this.token();
      assertContributionOwner(this.owner);
      await this.assertCaller?.();
      assertContributionOwner(this.owner);
      const value = await serverApiFetch<unknown>(`/api/plugin-contributions${route}`, {
        baseUrl: this.endpoint,
        token,
        method,
        body,
        headers: { ...headers, 'x-cindy-version': app.getVersion() },
        cache: 'no-store',
        timeoutMs: 20_000,
        skipAutoRefresh: true,
        skipSessionInvalidation: true,
        redactErrorDetails: true,
        logLabel: '/api/plugin-contributions',
        allowedRedactedErrorCodes: [
          ...wire.CONTRIBUTION_ERROR_CODES,
          'UNAUTHORIZED',
          'INVALID_TOKEN',
          'TOKEN_EXPIRED',
        ],
      });
      assertContributionOwner(this.owner);
      const parsed = schema.safeParse(value);
      if (!parsed.success) throwIpcError('PRECONDITION_FAILED', 'Invalid contribution response');
      const result = parsed.data;
      const subject = wire.contributionSubject.safeParse((result as { subject?: unknown }).subject);
      if (
        !subject.success ||
        subject.data.authority !== this.subject?.authority ||
        subject.data.membershipId !== this.subject?.membershipId
      ) {
        throwIpcError('OWNER_CHANGED', 'Contribution response subject mismatch');
      }
      return result;
    };
    try {
      return await run();
    } catch (error) {
      assertContributionOwner(this.owner);
      if (
        error instanceof ServerApiError &&
        error.statusCode === 401 &&
        ['UNAUTHORIZED', 'INVALID_TOKEN', 'TOKEN_EXPIRED'].includes(error.code)
      ) {
        await refresh();
        assertContributionOwner(this.owner);
        return run();
      }
      throw error;
    }
  }

  preflight(input: { pluginId: string | null; ghostId: string; version: string; hasReleaseNotes: boolean }) {
    return this.request(
      `/preflight?${new URLSearchParams({ ghostId: input.ghostId, version: input.version, hasReleaseNotes: String(input.hasReleaseNotes), ...(input.pluginId ? { pluginId: input.pluginId } : {}) })}`,
      wire.contributionPreflight,
    );
  }
  cancelReview(pluginId: string, expectedRelease: z.infer<typeof wire.releaseRevision>) {
    return this.request(
      `/plugins/${encodeURIComponent(pluginId)}/releases/${encodeURIComponent(expectedRelease.releaseId)}/cancel-review`,
      wire.cancelledReview,
      'POST',
      { expectedRelease },
    );
  }
  prepare(body: wire.ContributionRequest, key: string) {
    return this.request(
      '/prepare',
      wire.preparedResponse,
      'POST',
      wire.contributionRequest.parse(body),
      { 'Idempotency-Key': key },
    );
  }
  commit(id: string) {
    return this.request(
      `/operations/${encodeURIComponent(id)}/commit`,
      wire.commitResponse,
      'POST',
      {},
    );
  }
  operation(id: string) {
    return this.request(`/operations/${encodeURIComponent(id)}`, wire.contributionOperation);
  }
  changes() {
    return this.request('/changes', wire.contributionChanges);
  }
  list(input: { query: string; filter: string; cursor?: string }) {
    const params = new URLSearchParams({
      query: input.query.trim(),
      filter: input.filter,
      limit: '20',
    });
    if (input.cursor) params.set('cursor', input.cursor);
    return this.request(`/plugins?${params}`, wire.myPluginList);
  }
  detail(id: string) {
    return this.request(`/plugins/${encodeURIComponent(id)}`, wire.myPluginDetail);
  }
  setAnonymity(id: string, anonymous: boolean) {
    return this.request(`/plugins/${encodeURIComponent(id)}/author-settings`, wire.myPluginDetail, 'PATCH', { anonymous });
  }
  history(id: string, cursor: string) {
    return this.request(
      `/plugins/${encodeURIComponent(id)}/history?${new URLSearchParams({ cursor, limit: '20' })}`,
      wire.myPluginHistory,
    );
  }
  releases(id: string, version?: string, cursor?: string) {
    return this.request(
      `/plugins/${encodeURIComponent(id)}/releases?${new URLSearchParams({ ...(version ? { version } : {}), ...(cursor ? { cursor } : {}), limit: '50' })}`,
      wire.myPluginReleases,
    );
  }
  submission(pluginId: string, submissionId: string) {
    return this.request(
      `/plugins/${encodeURIComponent(pluginId)}/submissions/${encodeURIComponent(submissionId)}`,
      wire.mySubmissionDetail,
    );
  }
}
