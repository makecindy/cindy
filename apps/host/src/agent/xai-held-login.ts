/**
 * Coexistence plan A (reviewer, 2026-11-17): the xAI (SuperGrok) login while a Cindy desktop app
 * running on its own uses this profile.
 *
 * The login is one JSON blob in the profile's safe-storage (provider secret `xai`, or the generic
 * OAuth slot of an added xAI account; grok-oauth-login.ts readBlob), the same file the desktop reads
 * and writes, and its binding is in the same profile. Two things write it: renewing a token about to
 * expire (getGrokAccessToken → refreshIfNeeded), and the forced renewal after an upstream rejection,
 * which signs out and unbinds when it cannot renew (recoverGrokAuthAfterRejection → logoutGrok). Two
 * processes renewing one login rotate each other's refresh token out.
 *
 * While held, this wrapper of the Host's one Grok service (provider-config.ts; the subscription
 * bridge, the Codex proxy's xAI observer, provider OAuth token reads and auto-review all use it):
 * - does not renew: a token about to expire fails with a reason;
 * - after an upstream rejection renews, signs out and unbinds nothing; the rejection is remembered in
 *   this process and requests with the same token fail with a reason, not reaching the upstream again;
 * - once released forgets everything and behaves as the service does.
 */
import { HOST_PROFILE_IN_USE_BY_DESKTOP } from './profile-coexistence.js';
import type { createGrokOAuthService } from '../../../desktop/src/main/maker-host/grok-oauth-login.js';

type GrokService = ReturnType<typeof createGrokOAuthService>;

/** grok-oauth-login.ts REFRESH_MARGIN_SEC; a guard test keeps the two equal. */
export const GROK_REFRESH_MARGIN_SEC = 120;

export function holdGrokLoginWrites(service: GrokService, ports: {
  isProfileHeld(): boolean;
  /** The stored blob of an xAI login, as grok-oauth-login.ts readBlob reads it. */
  readStoredLogin(providerId: string): string | null;
}): GrokService {
  const rejected = new Map<string, string>();
  const held = () => ports.isProfileHeld();
  const expiresAt = (providerId: string): number | null => {
    try {
      const value = JSON.parse(ports.readStoredLogin(providerId) ?? 'null')?.expires_at;
      return typeof value === 'number' ? value : null;
    } catch { return null; }
  };
  const refusal = (what: string) => new Error(`${HOST_PROFILE_IN_USE_BY_DESKTOP}: ${what} while a Cindy desktop app running on its own `
    + 'uses this data (both would renew the same sign-in). Quit that app, then try again.');
  return {
    ...service,
    async getGrokAccessToken(providerId = 'xai') {
      if (!held()) { rejected.clear(); return service.getGrokAccessToken(providerId); }
      const token = service.peekGrokAccessToken(providerId);
      if (token && rejected.get(providerId) === token) throw refusal('xAI rejected this SuperGrok sign-in, and it is not renewed or signed out');
      if (token) rejected.delete(providerId);
      const exp = expiresAt(providerId);
      // As grok-oauth-login.ts isExpired: without an expiry the service does not renew early either.
      if (token && exp !== null && Date.now() >= exp - GROK_REFRESH_MARGIN_SEC * 1000)
        throw refusal('the SuperGrok sign-in has expired, and it is not renewed');
      return service.getGrokAccessToken(providerId);
    },
    async recoverGrokAuthAfterRejection(rejectedAccessToken: string, providerId = 'xai') {
      if (!held()) { rejected.clear(); return service.recoverGrokAuthAfterRejection(rejectedAccessToken, providerId); }
      // As the service: a rejection of a token that is no longer current changes nothing.
      if (service.peekGrokAccessToken(providerId) !== rejectedAccessToken) return 'superseded';
      rejected.set(providerId, rejectedAccessToken);
      return 'unchanged';
    },
  };
}
