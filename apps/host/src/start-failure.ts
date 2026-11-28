import { AuthApiError } from '@cindy/auth-client';
import { isDefinitiveRefreshError } from '../../desktop/src/main/authRefreshError.js';
import { OwnerDatabaseError } from '../../desktop/src/main/localDb/startupCore.js';
import type { HostStartFailureReason } from '../../desktop/src/shared/hostStartFailure.js';
import { HostProfileInUseError } from './agent/profile-coexistence.js';
import { HostRefreshDeferredError, HostSessionMissingError } from './auth/refresh.mjs';
import { HostCrossRegionPersonalAccountError } from './auth/region-policy.js';

/** The saved session's account is not the account of the data this Host opens. */
export class HostAccountMismatchError extends Error {
  constructor() {
    super('The signed-in account does not match the active Host profile');
    this.name = 'HostAccountMismatchError';
  }
}

/** There is account data but no saved session: an ordinary signed-out start, not a failure. */
export class HostSignInRequiredError extends Error {
  constructor() {
    super('Sign in with `cindy-host login` before opening account data');
    this.name = 'HostSignInRequiredError';
  }
}

/** A transport failure of the auth client (no response): the sign-in service was not reached. */
function isSignInServiceUnreachable(error: unknown): boolean {
  if (error instanceof HostRefreshDeferredError) return error.networkFailure;
  return error instanceof AuthApiError && error.statusCode === 0
    && (error.code === 'NETWORK_ERROR' || error.code === 'REQUEST_TIMEOUT');
}

/**
 * Why a start failed, for the windows (auth state `hostUnavailable`), or null when the start ended as an
 * ordinary signed-out state: no saved session, a session the server rejected or that is gone, a personal
 * account of another region. The same three are what ends a session at runtime (main.ts refreshAuthSession).
 * Decided only from error types and explicit codes, never from message text: the text can carry paths,
 * pids or account details and stays in `runtime.detail`.
 */
export function classifyHostStartFailure(error: unknown): HostStartFailureReason | null {
  if (error instanceof HostSignInRequiredError || error instanceof HostSessionMissingError
    || error instanceof HostCrossRegionPersonalAccountError || isDefinitiveRefreshError(error)) return null;
  if (error instanceof HostProfileInUseError) return 'HOST_PROFILE_IN_USE_BY_DESKTOP';
  if (error instanceof HostAccountMismatchError) return 'HOST_ACCOUNT_MISMATCH';
  if (error instanceof OwnerDatabaseError) {
    return error.code === 'DB_SCHEMA_LOCKED' ? 'HOST_DATABASE_LOCKED' : 'HOST_DATABASE_UNAVAILABLE';
  }
  if (isSignInServiceUnreachable(error)) return 'HOST_SIGN_IN_SERVICE_UNREACHABLE';
  return 'HOST_START_FAILED';
}
