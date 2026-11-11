/**
 * Minimal JWT helpers (no signature verification — the server stays the source of truth). Used
 * to proactively decide whether a cached access token is close enough to expiry that we should
 * refresh it before handing it to a path that has no 401-retry of its own (notably the
 * device-link WebSocket upgrade, which the relay rejects with 401 on an expired token).
 *
 * Dependency-free and RN-free so it unit-tests under node/vitest.
 */

/** Refresh the token once it is within this window of its real expiry. */
export const ACCESS_TOKEN_EXPIRY_SKEW_MS = 30_000;

function base64UrlDecode(segment: string): string | null {
  const decode = (globalThis as { atob?: (input: string) => string }).atob;
  if (typeof decode !== 'function') return null;
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    return decode(padded);
  } catch {
    return null;
  }
}

/** 读取 access token 的组织稳定标识；个人身份、旧 token 或解码失败返回 null。 */
export function decodeJwtOrgSlug(token: string): string | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const json = base64UrlDecode(parts[1]);
  if (json === null) return null;
  try {
    const payload = JSON.parse(json) as { orgSlug?: unknown };
    return typeof payload.orgSlug === 'string' && payload.orgSlug.length > 0
      ? payload.orgSlug
      : null;
  } catch {
    return null;
  }
}

/** The token's `exp` claim in epoch milliseconds, or null when it can't be determined. */
export function decodeJwtExpMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const json = base64UrlDecode(parts[1]);
  if (json === null) return null;
  try {
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

/**
 * True when the access token is expired or within the skew window of expiry. An unknown or
 * unparseable `exp` returns false — we don't force a refresh, since REST calls still recover
 * via their own 401 retry; this only adds proactive refresh where the exp is actually known.
 */
export function isAccessTokenExpiring(token: string, nowMs: number = Date.now()): boolean {
  const expMs = decodeJwtExpMs(token);
  if (expMs === null) return false;
  return expMs - nowMs <= ACCESS_TOKEN_EXPIRY_SKEW_MS;
}
