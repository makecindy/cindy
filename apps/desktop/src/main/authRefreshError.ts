import { AuthApiError } from '@cindy/auth-client';

/** Definitive credential rejection; transport outages must not sign out an account. */
export function isDefinitiveRefreshError(error: unknown): boolean {
  return (
    error instanceof AuthApiError &&
    [
      'INVALID_REFRESH_TOKEN',
      'REFRESH_TOKEN_EXPIRED',
      'DEVICE_MISMATCH',
      'ACCOUNT_UNAVAILABLE',
      'MEMBERSHIP_DISABLED',
    ].includes(error.code)
  );
}

