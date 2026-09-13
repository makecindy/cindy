export type RuntimeCredentialRemovalResult = 'removed' | 'stale' | 'missing';

export interface RuntimeAuthExpiryCommitGuards {
  validateBeforeCommit: () => boolean;
  shouldClearOnFailure: () => boolean;
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
  await input.commit({
    validateBeforeCommit: input.isCurrent,
    shouldClearOnFailure: input.isCurrent,
  });
  return 'expired';
}
