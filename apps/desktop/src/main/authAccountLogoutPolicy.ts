import {
  accountVaultKey,
  passportVaultKey,
  type AuthRegion,
  type StoredAccountMetadata,
} from '@cindy/auth-client';

export interface LoggedOutAccountIdentity {
  accountKey: string;
  realm: AuthRegion;
  passportId: string;
}

interface LogoutPolicyResourceSession {
  realm: AuthRegion;
  metadata: StoredAccountMetadata;
}

interface LogoutPolicyPassportSession {
  realm: AuthRegion;
  passportId: string;
  memberships: StoredAccountMetadata[];
}

interface LogoutPolicyVault<
  TResource extends LogoutPolicyResourceSession,
  TPassport extends LogoutPolicyPassportSession,
> {
  activeAccountKey: string | null;
  resources: Record<string, TResource>;
  passports: Record<string, TPassport>;
  loggedOutAccountKeys?: string[];
}

export function loggedOutAccountKeySet(
  vault: { loggedOutAccountKeys?: string[] } & object,
): Set<string> {
  return new Set(vault.loggedOutAccountKeys ?? []);
}

export function isLoggedOutVaultAccount(
  vault: { loggedOutAccountKeys?: string[] } & object,
  accountKey: string,
): boolean {
  return loggedOutAccountKeySet(vault).has(accountKey);
}

export function restoreLoggedOutVaultAccount(
  vault: { loggedOutAccountKeys?: string[] } & object,
  accountKey: string,
): void {
  if (!vault.loggedOutAccountKeys?.includes(accountKey)) return;
  const remaining = vault.loggedOutAccountKeys.filter((key) => key !== accountKey);
  if (remaining.length > 0) {
    vault.loggedOutAccountKeys = remaining;
  } else {
    delete vault.loggedOutAccountKeys;
  }
}

/** Remove one saved membership while preserving credentials that can restore sibling memberships. */
export function removeLoggedOutVaultAccount<
  TResource extends LogoutPolicyResourceSession,
  TPassport extends LogoutPolicyPassportSession,
>(
  vault: LogoutPolicyVault<TResource, TPassport>,
  identity: LoggedOutAccountIdentity,
): TPassport | null {
  delete vault.resources[identity.accountKey];
  if (vault.activeAccountKey === identity.accountKey) vault.activeAccountKey = null;

  const loggedOutKeys = loggedOutAccountKeySet(vault);
  loggedOutKeys.add(identity.accountKey);
  vault.loggedOutAccountKeys = [...loggedOutKeys];

  const passportKey = passportVaultKey(identity.realm, identity.passportId);
  const passport = vault.passports[passportKey];
  if (!passport) return null;

  // Keep the legacy Passport projection downgrade-safe: older clients do not
  // understand loggedOutAccountKeys, so they must not find this membership in
  // the persisted membership list after a single-account logout.
  passport.memberships = passport.memberships.filter(
    (membership) =>
      accountVaultKey(identity.realm, membership.membershipId) !== identity.accountKey,
  );

  const hasRestorableSibling =
    passport.memberships.some((membership) => {
      const accountKey = accountVaultKey(identity.realm, membership.membershipId);
      return accountKey !== identity.accountKey && !loggedOutKeys.has(accountKey);
    }) ||
    Object.entries(vault.resources).some(
      ([accountKey, resource]) =>
        accountKey !== identity.accountKey &&
        resource.realm === identity.realm &&
        resource.metadata.passportId === identity.passportId &&
        !loggedOutKeys.has(accountKey),
    );
  if (hasRestorableSibling) return null;

  delete vault.passports[passportKey];
  return passport;
}
