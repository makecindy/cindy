export type RuntimeCredentialRemovalResult = 'removed' | 'stale' | 'missing';

export type RuntimeCompatibilityRemovalResult = 'deleted' | 'changed' | 'failed';

export interface RuntimeCredentialVault<Realm extends string = string> {
  activeAccountKey: string | null;
  resources: Record<string, { realm: Realm; refreshToken: string }>;
}

function removeRejectedCompatibilityValue(
  expectedValues: readonly string[],
  removeIfUnchanged: (expected: string) => RuntimeCompatibilityRemovalResult,
): RuntimeCompatibilityRemovalResult {
  let outcome: RuntimeCompatibilityRemovalResult = 'changed';
  for (const expected of expectedValues) {
    outcome = removeIfUnchanged(expected);
    if (outcome !== 'changed') break;
  }
  return outcome;
}

/**
 * Compare-and-delete one rejected runtime generation across the account vault
 * and the compatibility projections. A changed compatibility value is a newer
 * generation written by another client, even when the vault CAS already
 * removed its rejected copy, so it supersedes the expiry.
 */
export async function removeRejectedRuntimeCredentialCopies<Realm extends string>(input: {
  realm: Realm;
  rejectedRefreshTokens: readonly string[];
  validateBeforeWrite: () => void;
  mutateVault: (
    operation: (vault: RuntimeCredentialVault<Realm>) => RuntimeCredentialRemovalResult,
  ) => Promise<RuntimeCredentialRemovalResult>;
  serializeSession: (realm: Realm, refreshToken: string) => string;
  removeSessionIfUnchanged: (expected: string) => RuntimeCompatibilityRemovalResult;
  removeLegacyIfUnchanged?: (expected: string) => RuntimeCompatibilityRemovalResult;
}): Promise<RuntimeCredentialRemovalResult> {
  const rejectedRefreshTokens = new Set(input.rejectedRefreshTokens);
  const vaultOutcome = await input.mutateVault((vault) => {
    input.validateBeforeWrite();
    const activeKey = vault.activeAccountKey;
    const activeResource = activeKey ? vault.resources[activeKey] : undefined;
    if (!activeKey || !activeResource) return 'missing';
    if (
      activeResource.realm !== input.realm ||
      !rejectedRefreshTokens.has(activeResource.refreshToken)
    ) {
      return 'stale';
    }
    delete vault.resources[activeKey];
    vault.activeAccountKey = null;
    return 'removed';
  });
  if (vaultOutcome === 'stale') return 'stale';

  const sessionOutcome = removeRejectedCompatibilityValue(
    input.rejectedRefreshTokens.map((token) => input.serializeSession(input.realm, token)),
    input.removeSessionIfUnchanged,
  );
  if (sessionOutcome === 'changed') return 'stale';

  if (input.removeLegacyIfUnchanged) {
    const legacyOutcome = removeRejectedCompatibilityValue(
      input.rejectedRefreshTokens,
      input.removeLegacyIfUnchanged,
    );
    if (legacyOutcome === 'changed') return 'stale';
  }
  return vaultOutcome;
}

export interface RuntimeAuthExpiryCommitGuards {
  validateBeforeCommit: () => boolean;
  shouldClearOnFailure: () => boolean;
  markSelfCleared: () => void;
}

/**
 * Keep a definitive refresh failure attached to the auth identity that
 * observed it across credential-store and owner-teardown awaits.
 */
export async function runGuardedRuntimeAuthExpiry(input: {
  isCurrent: () => boolean;
  removeRejectedCredentials?: () => Promise<RuntimeCredentialRemovalResult>;
  commit: (guards: RuntimeAuthExpiryCommitGuards) => Promise<void>;
}): Promise<'expired' | 'stale-credential' | 'superseded'> {
  if (!input.isCurrent()) return 'superseded';
  if (input.removeRejectedCredentials) {
    const removal = await input.removeRejectedCredentials();
    if (!input.isCurrent()) return 'superseded';
    if (removal === 'stale') return 'stale-credential';
  }
  if (!input.isCurrent()) return 'superseded';
  let selfCleared = false;
  await input.commit({
    validateBeforeCommit: input.isCurrent,
    shouldClearOnFailure: () => selfCleared || input.isCurrent(),
    markSelfCleared: () => {
      selfCleared = true;
    },
  });
  return 'expired';
}
