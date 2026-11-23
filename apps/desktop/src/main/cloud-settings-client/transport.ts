export function isCloudLoginAttemptId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:[A-Za-z0-9_-]{24}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/u.test(
      value,
    )
  );
}
import type { CloudClientErrorCode } from '../../shared/cloudSettingsClient';
import { cloudRefusal } from '../../shared/cloudSettingsErrors';

export class CloudClientError extends Error {
  constructor(readonly code: CloudClientErrorCode) {
    super(code);
  }
}
// Only normalized login codes cross the native presentation boundary.
const loginCodes = new Set([
  'RATE_LIMITED', 'INVALID_CODE', 'CODE_EXPIRED', 'CAPTCHA_REQUIRED', 'CAPTCHA_INVALID',
  'LOGIN_OWNERSHIP_MISMATCH', 'LOGIN_METHOD_UNAVAILABLE', 'LOGIN_STATE_INVALID',
  'LOGIN_ATTEMPT_EXPIRED', 'LOGIN_ATTEMPT_ACTIVE', 'LOGIN_VERIFICATION_LIMIT',
  'LOGIN_AUTH_UPGRADE_REQUIRED', 'LOGIN_STATE_CONFLICT', 'ORG_NOT_FOUND', 'ORG_SSO_NOT_FOUND',
]);
export class CloudLoginRemoteError extends Error {
  constructor(readonly code: string) { super(code); }
}
export interface CloudClientIdentity {
  key: string;
  generation: number;
  baseUrl: string;
  accessToken: string;
}
export interface CloudClientHttp {
  cancelLogin?(baseUrl: string, attemptId: string, attemptSecret: string): Promise<void>;
  request(
    identity: CloudClientIdentity,
    path: string,
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    body: unknown,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<unknown>;
}

export function createCloudClientHttp(fetcher: typeof fetch): CloudClientHttp {
  return {
    async cancelLogin(baseUrl, attemptId, attemptSecret) {
      const base = new URL(baseUrl);
      if (
        base.protocol !== 'https:' ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        !isCloudLoginAttemptId(attemptId) ||
        !/^[A-Za-z0-9_-]{32,256}$/u.test(attemptSecret)
      )
        throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
      // Only the old attempt capability is needed after a local account switch.
      // No old/new account token or renderer-supplied URL is forwarded.
      const response = await fetcher(
        `${base.origin}${base.pathname.replace(/\/$/u, '')}/instance-login/api/attempts/${attemptId}/cancel`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attemptSecret }),
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: AbortSignal.timeout(8000),
        },
      );
      await response.body?.cancel();
      if (!response.ok) throw new CloudClientError('CLOUD_SETTINGS_UNAVAILABLE');
    },
    async request(identity, path, method, body, signal, assertCurrent) {
      assertCurrent();
      let base: URL;
      try {
        base = new URL(identity.baseUrl);
      } catch {
        throw new CloudClientError('CLOUD_SETTINGS_NOT_READY');
      }
      if (
        base.protocol !== 'https:' ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        !path.startsWith('/') ||
        path.startsWith('//') ||
        path.includes('..')
      )
        throw new CloudClientError('CLOUD_SETTINGS_NOT_READY');
      const url = `${base.origin}${base.pathname.replace(/\/$/u, '')}${path}`;
      let response: Response;
      try {
        response = await fetcher(url, {
          method,
          headers: {
            Authorization: `Bearer ${identity.accessToken}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
        });
        assertCurrent();
        if (!response.ok) {
          const attempts = /^\/instance-login\/api\/attempts(?:\/|$)/u.test(path);
          // A refusal (not authorized, suspended, over a limit, transferred) keeps its own code.
          if (attempts || response.status === 403 || response.status === 409) {
            const reader = response.body?.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;
            if (reader) try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > 8192) { await reader.cancel(); break; }
                chunks.push(chunk.value);
              }
            } finally { reader.releaseLock(); }
            assertCurrent();
            let code: unknown;
            try { code = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error?.code; } catch { /* sanitized below */ }
            if (attempts && typeof code === 'string' && loginCodes.has(code)) throw new CloudLoginRemoteError(code);
            const refusal = cloudRefusal(code);
            if (refusal) throw new CloudClientError(refusal);
            if (attempts && response.status === 404 && path.endsWith('/prepare-code'))
              throw new CloudLoginRemoteError('LOGIN_AUTH_UPGRADE_REQUIRED');
          }
          if (!response.bodyUsed) await response.body?.cancel();
          throw new CloudClientError(
            (response.status === 404 || response.status === 410) &&
              /^\/instance-login\/api\/attempts\/[^/]+\/status$/u.test(path)
              ? 'CLOUD_SETTINGS_NOT_READY'
              : response.status === 404 || response.status === 501
                ? 'CLOUD_SETTINGS_UNSUPPORTED'
                : response.status === 409 &&
                    (method === 'PATCH' || /^\/instances\/[^/]+\/maintenance\/upgrade$/u.test(path))
                  ? 'CLOUD_SETTINGS_CONFLICT'
                  : response.status === 401 || response.status === 403 || response.status === 409
                    ? 'CLOUD_SETTINGS_SCOPE_CHANGED'
                    : response.status === 429
                      ? 'CLOUD_SETTINGS_BUSY'
                      : 'CLOUD_SETTINGS_UNAVAILABLE',
          );
        }
        if (response.status === 204) return undefined;
        const reader = response.body?.getReader();
        if (!reader) throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > (path === '/instance-login/api/manage/instances' ? 512 * 1024 : 64 * 1024)) {
              await reader.cancel();
              throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        assertCurrent();
        try {
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
        }
      } catch (error) {
        assertCurrent();
        if (error instanceof CloudClientError || error instanceof CloudLoginRemoteError) throw error;
        // Never relay network errors, response bodies or credentials to the UI.
        throw new CloudClientError('CLOUD_SETTINGS_UNAVAILABLE');
      }
    },
  };
}
