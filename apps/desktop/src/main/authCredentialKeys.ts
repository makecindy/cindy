/**
 * safeStorage record names shared by the Desktop main process and cindy-host.
 *
 * These strings are the on-disk identity of an existing login: renaming any of
 * them silently logs every user out, so they live in one Electron-free module
 * that both processes import. This module imports nothing.
 */

export const AUTH_SESSION_KEY = 'cindy_auth_session_v1';
export const AUTH_ACCOUNT_VAULT_KEY = 'cindy_auth_accounts_v1';
export const AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY = 'cindy_auth_account_logout_tombstones_v1';
export const LEGACY_RESOURCE_REFRESH_TOKEN_KEY = 'cindy_auth_refresh_token';
export const ACCOUNT_DELETION_RECEIPT_KEY = 'cindy_auth_account_deletion_receipt';
export const LEGACY_ACCOUNT_REFRESH_TOKEN_KEY = 'cindy_auth_account_refresh_token';
export const LEGACY_REFRESH_TOKEN_KEY = 'refresh_token';

/** Records whose presence proves an existing login attempt worth preserving. */
export const PERSISTED_AUTH_CREDENTIAL_KEYS = [
  AUTH_SESSION_KEY,
  AUTH_ACCOUNT_VAULT_KEY,
  AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY,
  LEGACY_RESOURCE_REFRESH_TOKEN_KEY,
  LEGACY_ACCOUNT_REFRESH_TOKEN_KEY,
  LEGACY_REFRESH_TOKEN_KEY,
] as const;
