export interface MobileAuthOwnerGeneration {
  readonly accountId: string;
  readonly generation: number;
}

let current: MobileAuthOwnerGeneration = {
  accountId: '',
  generation: 0,
};

/** Publish the account owner synchronously, before React state updates settle. */
export function setMobileAuthOwner(accountId: string | null | undefined): void {
  const normalized = accountId?.trim() ?? '';
  if (current.accountId === normalized) return;
  current = {
    accountId: normalized,
    generation: current.generation + 1,
  };
}

export function getMobileAuthOwner(): MobileAuthOwnerGeneration {
  return current;
}

export function isMobileAuthOwnerCurrent(
  owner: MobileAuthOwnerGeneration,
): boolean {
  return (
    current.accountId === owner.accountId
    && current.generation === owner.generation
  );
}

export const __testing = {
  reset(): void {
    current = { accountId: '', generation: 0 };
  },
};
