import {
  parseSsoOrgHistory,
  rememberSsoOrgIdentifier as mergeSsoOrgIdentifier,
  serializeSsoOrgHistory,
} from '@cindy/auth-client';

const STORAGE_KEY = 'cindy.desktop.auth.sso-org-history.v1';

let volatileHistory: string[] = [];

function readCurrentHistory(): string[] {
  if (typeof window === 'undefined') return [...volatileHistory];
  try {
    const entries = parseSsoOrgHistory(window.localStorage.getItem(STORAGE_KEY));
    volatileHistory = entries;
    return [...entries];
  } catch {
    return [...volatileHistory];
  }
}

export function getSsoOrgHistory(): string[] {
  return readCurrentHistory();
}

/**
 * Re-reads localStorage before merging so another renderer's recent write is not
 * overwritten by a stale in-memory snapshot.
 */
export function rememberSsoOrgIdentifier(identifier: string): string[] {
  const next = mergeSsoOrgIdentifier(readCurrentHistory(), identifier);
  volatileHistory = next;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, serializeSsoOrgHistory(next));
    } catch {
      // Keep the current renderer's memory useful when persistence is unavailable.
    }
  }
  return [...next];
}

export const __testing = {
  storageKey: STORAGE_KEY,
  reset(): void {
    volatileHistory = [];
  },
};
