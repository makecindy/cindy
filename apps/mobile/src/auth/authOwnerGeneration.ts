import { accountVaultKey, type AuthRegion } from '@cindy/auth-client';

export interface MobileAuthOwnerGeneration {
  /** Bare membership ID retained for creation guards and recovery ledgers. */
  readonly accountId: string;
  /** Canonical realm-qualified key for new account-scoped storage. */
  readonly accountKey: string;
  readonly generation: number;
}

const listeners = new Set<() => void>();
export function subscribeMobileAuthOwner(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}

let current: MobileAuthOwnerGeneration = {
  accountId: '',
  accountKey: '',
  generation: 0,
};

/** Publish the account owner synchronously, before React state updates settle. */
export function setMobileAuthOwner(
  accountId: string | null | undefined,
  realm: AuthRegion = 'global',
): void {
  const normalized = accountId?.trim() ?? '';
  const accountKey = normalized ? accountVaultKey(realm, normalized) : '';
  if (current.accountKey === accountKey) return;
  current = {
    accountId: normalized,
    accountKey,
    generation: current.generation + 1,
  };
  for (const listener of listeners) listener();
}

export function getMobileAuthOwner(): MobileAuthOwnerGeneration {
  return current;
}

export function isMobileAuthOwnerCurrent(
  owner: MobileAuthOwnerGeneration,
): boolean {
  return (
    current.accountKey === owner.accountKey
    && current.generation === owner.generation
  );
}

export const __testing = {
  reset(): void {
    current = { accountId: '', accountKey: '', generation: 0 };
  },
};
