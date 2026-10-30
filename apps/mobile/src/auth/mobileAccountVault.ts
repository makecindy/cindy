import {
  accountVaultKey,
  isStoredAccountMetadata,
  passportVaultKey,
  reconcileSavedAccountMetadata,
  storedAccountMetadataFromMembership,
  type AccountMembership,
  type AuthMembership,
  type AuthRegion,
  type AuthSessionRecord,
  type AuthTokenPair,
  type StoredAccountMetadata,
} from '@cindy/auth-client';

import { deleteSecureItem, getSecureItem, setSecureItem } from './secureStorage';

export const MOBILE_ACCOUNT_VAULT_KEY = 'cindy.mobile.auth.accounts.v1';

export interface MobileStoredResourceSession {
  realm: AuthRegion;
  refreshToken: string;
  metadata: StoredAccountMetadata;
  lastUsedAt: number;
}

export interface MobileStoredPassportSession {
  realm: AuthRegion;
  passportId: string;
  accountRefreshToken: string;
  memberships: StoredAccountMetadata[];
}

export interface MobileAccountVault {
  version: 1;
  activeAccountKey: string | null;
  resources: Record<string, MobileStoredResourceSession>;
  passports: Record<string, MobileStoredPassportSession>;
  signedOutAt?: number;
}

export interface MobileSavedAccount extends StoredAccountMetadata {
  accountKey: string;
  realm: AuthRegion;
  isCurrent: boolean;
  lastUsedAt: number;
}

let mutation = Promise.resolve();

function enqueueMobileVaultOperation<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutation.then(operation);
  mutation = run.then(() => undefined, () => undefined);
  return run;
}

export function emptyMobileAccountVault(): MobileAccountVault {
  return { version: 1, activeAccountKey: null, resources: {}, passports: {} };
}

function parseMobileAccountVaultRecord(
  raw: string | null,
  options: { allowInvalidChildren?: boolean } = {},
): MobileAccountVault {
  if (raw === null) return emptyMobileAccountVault();
  const value = JSON.parse(raw) as Partial<MobileAccountVault>;
  if (
    value.version !== 1 ||
    !value.resources ||
    typeof value.resources !== 'object' ||
    Array.isArray(value.resources) ||
    !value.passports ||
    typeof value.passports !== 'object' ||
    Array.isArray(value.passports)
  ) {
    throw new Error('Saved account credentials could not be read safely');
  }
  const resources: Record<string, MobileStoredResourceSession> = {};
  for (const [key, candidate] of Object.entries(value.resources)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      if (options.allowInvalidChildren) continue;
      throw new Error('Saved resource credential could not be read safely');
    }
    const item = candidate as Partial<MobileStoredResourceSession>;
    if (
      (item.realm !== 'cn' && item.realm !== 'global') ||
      typeof item.refreshToken !== 'string' ||
      !item.refreshToken ||
      !isStoredAccountMetadata(item.metadata) ||
      typeof item.lastUsedAt !== 'number'
    ) {
      if (options.allowInvalidChildren) continue;
      throw new Error('Saved resource credential could not be read safely');
    }
    resources[key] = item as MobileStoredResourceSession;
  }
  const passports: Record<string, MobileStoredPassportSession> = {};
  for (const [key, candidate] of Object.entries(value.passports)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      if (options.allowInvalidChildren) continue;
      throw new Error('Saved Passport credential could not be read safely');
    }
    const item = candidate as Partial<MobileStoredPassportSession>;
    if (
      (item.realm !== 'cn' && item.realm !== 'global') ||
      typeof item.passportId !== 'string' ||
      typeof item.accountRefreshToken !== 'string' ||
      !item.accountRefreshToken ||
      !Array.isArray(item.memberships)
    ) {
      if (options.allowInvalidChildren) continue;
      throw new Error('Saved Passport credential could not be read safely');
    }
    const memberships = item.memberships.filter(isStoredAccountMetadata);
    if (
      !options.allowInvalidChildren &&
      memberships.length !== item.memberships.length
    ) {
      throw new Error('Saved Passport membership could not be read safely');
    }
    passports[key] = {
      realm: item.realm,
      passportId: item.passportId,
      accountRefreshToken: item.accountRefreshToken,
      memberships,
    };
  }
  const active = typeof value.activeAccountKey === 'string' ? value.activeAccountKey : null;
  return {
    version: 1,
    activeAccountKey: active && resources[active] ? active : null,
    resources,
    passports,
    ...(typeof value.signedOutAt === 'number'
      ? { signedOutAt: value.signedOutAt }
      : {}),
  };
}

export function parseMobileAccountVault(raw: string | null): MobileAccountVault {
  try {
    return parseMobileAccountVaultRecord(raw, { allowInvalidChildren: true });
  } catch {
    // Read-only projections may fall back, but mutations use the strict parser
    // below so malformed encrypted content can never be overwritten.
    return emptyMobileAccountVault();
  }
}

export async function readMobileAccountVault(): Promise<MobileAccountVault> {
  await mutation;
  const raw = await getSecureItem(MOBILE_ACCOUNT_VAULT_KEY);
  return parseMobileAccountVault(raw);
}

async function writeMobileAccountVault(vault: MobileAccountVault): Promise<void> {
  await setSecureItem(MOBILE_ACCOUNT_VAULT_KEY, JSON.stringify(vault));
}

export function transactMobileAccountVault<T>(
  operation: (vault: MobileAccountVault) => T | Promise<T>,
  afterPersist: (result: T) => void | Promise<void> = () => undefined,
  options: { recoverInvalidForExplicitLogin?: boolean } = {},
): Promise<T> {
  return enqueueMobileVaultOperation(async () => {
    // A SecureStore read failure is not an empty vault. Propagate it so a
    // transient keychain error can never turn the next mutation into a write
    // that erases every saved credential.
    const raw = await getSecureItem(MOBILE_ACCOUNT_VAULT_KEY);
    let vault: MobileAccountVault;
    try {
      vault = parseMobileAccountVaultRecord(raw);
    } catch (error) {
      if (!options.recoverInvalidForExplicitLogin) throw error;
      // A completed explicit login supplies a newly verified Resource session,
      // so it is the only mutation allowed to recover malformed content. Keep
      // every valid child we can parse; malformed top-level JSON starts fresh.
      vault = parseMobileAccountVault(raw);
    }
    const result = await operation(vault);
    await writeMobileAccountVault(vault);
    try {
      // Keep the vault queue owned until every related durable write and
      // cancellation check has committed. A failure restores the exact prior
      // encrypted record before another mutation can observe partial state.
      await afterPersist(result);
    } catch (error) {
      if (raw === null) await deleteSecureItem(MOBILE_ACCOUNT_VAULT_KEY);
      else await setSecureItem(MOBILE_ACCOUNT_VAULT_KEY, raw);
      throw error;
    }
    return result;
  });
}

export interface ReconciledMobileAuthState {
  vault: MobileAccountVault;
  session: AuthSessionRecord | null;
  refreshCandidates: AuthSessionRecord[];
}

/**
 * Reconcile the compatibility session with the active Resource record before
 * refresh. A missing projection is repaired from the vault, but divergent
 * generations are both returned: rollback builds can rotate only the legacy
 * projection, while an interrupted new-build commit can leave the vault newer.
 * Only a definitive server response can identify the stale generation.
 */
export function reconcileMobileActiveAuthSession(input: {
  readPersistedSession: () => Promise<AuthSessionRecord | null>;
  writePersistedSession: (
    refreshToken: string,
    realm: AuthRegion,
  ) => Promise<void>;
  clearPersistedSession: () => Promise<void>;
}): Promise<ReconciledMobileAuthState> {
  return enqueueMobileVaultOperation(async () => {
    const raw = await getSecureItem(MOBILE_ACCOUNT_VAULT_KEY);
    const vault = parseMobileAccountVaultRecord(raw);
    let session = await input.readPersistedSession();

    if (typeof vault.signedOutAt === 'number') {
      if (session) await input.clearPersistedSession();
      return { vault, session: null, refreshCandidates: [] };
    }

    const activeResource = vault.activeAccountKey
      ? vault.resources[vault.activeAccountKey]
      : undefined;
    const activeSession: AuthSessionRecord | null = activeResource
      ? {
          version: 1,
          realm: activeResource.realm,
          refreshToken: activeResource.refreshToken,
        }
      : null;
    if (!session && activeSession) {
      await input.writePersistedSession(
        activeSession.refreshToken,
        activeSession.realm,
      );
      session = activeSession;
    }
    const refreshCandidates = session ? [session] : [];
    if (
      activeSession &&
      !refreshCandidates.some(
        (candidate) =>
          candidate.realm === activeSession.realm &&
          candidate.refreshToken === activeSession.refreshToken,
      )
    ) {
      refreshCandidates.push(activeSession);
    }
    return { vault, session, refreshCandidates };
  });
}

export function mutateMobileAccountVault<T>(
  operation: (vault: MobileAccountVault) => T | Promise<T>,
): Promise<T> {
  return transactMobileAccountVault(operation);
}

export async function clearMobileAccountVault(
  afterPersist: () => void | Promise<void> = () => undefined,
): Promise<void> {
  await enqueueMobileVaultOperation(async () => {
    // Explicit logout is the one mutation allowed to replace malformed vault
    // contents. Preserve the opaque record for rollback, but do not require it
    // to parse before publishing the fail-closed signed-out owner.
    const raw = await getSecureItem(MOBILE_ACCOUNT_VAULT_KEY);
    const vault = emptyMobileAccountVault();
    vault.signedOutAt = Date.now();
    await writeMobileAccountVault(vault);
    try {
      await afterPersist();
    } catch (error) {
      if (raw === null) await deleteSecureItem(MOBILE_ACCOUNT_VAULT_KEY);
      else await setSecureItem(MOBILE_ACCOUNT_VAULT_KEY, raw);
      throw error;
    }
  });
}

export async function clearMobileLoginCredentialsForLogout(input: {
  readSessionRaw(): Promise<string | null>;
  clearSession(): Promise<void>;
  restoreSessionRaw(raw: string | null): Promise<void>;
  clearReceipt(): Promise<void>;
}): Promise<void> {
  const previousSessionRaw = await input.readSessionRaw();
  await clearMobileAccountVault(async () => {
    await input.clearSession();
    try {
      await input.clearReceipt();
    } catch (error) {
      await input.restoreSessionRaw(previousSessionRaw);
      throw error;
    }
  });
}

export function listMobileSavedAccounts(
  vault: MobileAccountVault,
  activeAccountKey = vault.activeAccountKey,
): MobileSavedAccount[] {
  const byKey = new Map<string, MobileSavedAccount>();
  for (const [key, resource] of Object.entries(vault.resources)) {
    byKey.set(key, {
      ...resource.metadata,
      accountKey: key,
      realm: resource.realm,
      isCurrent: key === activeAccountKey,
      lastUsedAt: resource.lastUsedAt,
    });
  }
  for (const passport of Object.values(vault.passports)) {
    for (const metadata of passport.memberships) {
      const key = accountVaultKey(passport.realm, metadata.membershipId);
      if (byKey.has(key)) continue;
      byKey.set(key, {
        ...metadata,
        accountKey: key,
        realm: passport.realm,
        isCurrent: key === activeAccountKey,
        lastUsedAt: 0,
      });
    }
  }
  return [...byKey.values()].sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
    return right.lastUsedAt - left.lastUsedAt;
  });
}

export async function rememberMobileResourceSession(
  pair: AuthTokenPair,
  realm: AuthRegion,
  passportId = pair.membership.passportId,
  markActive = true,
  validateBeforeWrite: () => void = () => undefined,
): Promise<string | null> {
  if (!passportId) return null;
  const key = accountVaultKey(realm, pair.membership.id);
  await mutateMobileAccountVault((vault) => {
    validateBeforeWrite();
    delete vault.signedOutAt;
    vault.resources[key] = {
      realm,
      refreshToken: pair.refreshToken,
      metadata: storedAccountMetadataFromMembership(pair.membership, passportId),
      lastUsedAt: Date.now(),
    };
    if (markActive) vault.activeAccountKey = key;
  });
  return key;
}

export type MobileResourceSessionReplacementResult =
  | 'stored'
  | 'stale'
  | 'missing';

/**
 * Commit a runtime refresh only while it still owns that Resource generation.
 * A non-active compatibility account keeps its rotated replacement without
 * reclaiming `activeAccountKey`; only an active result publishes the
 * compatibility session in `afterPersist`. A missing entry may be recreated
 * after a proved refresh unless a logout-all tombstone forbids every write.
 */
export async function commitMobileRuntimeResourceSession(input: {
  expectedRefreshToken: string;
  compatibilityRefreshTokens?: readonly string[];
  pair: AuthTokenPair;
  realm: AuthRegion;
  passportId: string;
  validateBeforeWrite?: () => void;
  afterPersist?: () => void | Promise<void>;
}): Promise<'active' | 'inactive' | 'stale'> {
  const key = accountVaultKey(input.realm, input.pair.membership.id);
  return transactMobileAccountVault(
    (vault) => {
      input.validateBeforeWrite?.();
      const current = vault.resources[key];
      const acceptedPreviousTokens = new Set([
        input.expectedRefreshToken,
        ...(input.compatibilityRefreshTokens ?? []),
      ]);
      if (current) {
        if (
          current.realm !== input.realm ||
          !acceptedPreviousTokens.has(current.refreshToken)
        ) {
          return 'stale';
        }
      } else if (typeof vault.signedOutAt === 'number') {
        return 'stale';
      }

      const ownsActiveAccount = vault.activeAccountKey === key;
      const canClaimUninitializedVault =
        !current && vault.activeAccountKey === null;
      vault.resources[key] = {
        realm: input.realm,
        refreshToken: input.pair.refreshToken,
        metadata: storedAccountMetadataFromMembership(
          input.pair.membership,
          input.passportId,
        ),
        lastUsedAt: Date.now(),
      };
      if (ownsActiveAccount || canClaimUninitializedVault) {
        delete vault.signedOutAt;
        vault.activeAccountKey = key;
        return 'active';
      }
      // A compatibility candidate can belong to a saved but non-active
      // account after an interrupted switch. Preserve its rotated token while
      // leaving the vault's active owner untouched; the caller must continue
      // until another candidate commits as active.
      return 'inactive';
    },
    async (result) => {
      if (result === 'active') await input.afterPersist?.();
    },
  );
}

/** Store a rotated Resource token only while its consumed generation is current. */
export async function replaceMobileResourceSessionIfCurrent(input: {
  accountKey: string;
  expectedRefreshToken: string;
  pair: AuthTokenPair;
  realm: AuthRegion;
  passportId: string;
  validateBeforeWrite?: () => void;
}): Promise<MobileResourceSessionReplacementResult> {
  return mutateMobileAccountVault((vault) => {
    input.validateBeforeWrite?.();
    const current = vault.resources[input.accountKey];
    if (!current) return 'missing';
    if (current.refreshToken !== input.expectedRefreshToken) return 'stale';
    delete vault.signedOutAt;
    vault.resources[input.accountKey] = {
      realm: input.realm,
      refreshToken: input.pair.refreshToken,
      metadata: storedAccountMetadataFromMembership(
        input.pair.membership,
        input.passportId,
      ),
      lastUsedAt: Date.now(),
    };
    return 'stored';
  });
}

export type MobileResourceSessionRemovalResult =
  | 'removed'
  | 'stale'
  | 'missing';

/** Delete only the Resource token generation that a request proved unusable. */
export async function removeMobileResourceSessionIfCurrent(input: {
  accountKey: string;
  expectedRefreshToken: string;
  validateBeforeWrite?: () => void;
}): Promise<MobileResourceSessionRemovalResult> {
  return mutateMobileAccountVault((vault) => {
    input.validateBeforeWrite?.();
    const current = vault.resources[input.accountKey];
    if (!current) return 'missing';
    if (current.refreshToken !== input.expectedRefreshToken) return 'stale';
    delete vault.resources[input.accountKey];
    if (vault.activeAccountKey === input.accountKey) {
      vault.activeAccountKey = null;
    }
    return 'removed';
  });
}

export async function rememberMobilePassportSession(input: {
  realm: AuthRegion;
  passportId: string;
  accountRefreshToken: string;
  memberships: readonly (AuthMembership | AccountMembership | StoredAccountMetadata)[];
}): Promise<void> {
  const memberships = input.memberships.map((membership) =>
    isStoredAccountMetadata(membership)
      ? membership
      : storedAccountMetadataFromMembership(membership, input.passportId),
  );
  await mutateMobileAccountVault((vault) => {
    delete vault.signedOutAt;
    vault.passports[passportVaultKey(input.realm, input.passportId)] = {
      realm: input.realm,
      passportId: input.passportId,
      accountRefreshToken: input.accountRefreshToken,
      memberships,
    };
    reconcileSavedAccountMetadata(vault, {
      realm: input.realm,
      passportId: input.passportId,
      memberships,
      passportMode: 'replace-passport',
    });
  });
}

export async function commitMobileLoginSessions(
  input: {
    pair: AuthTokenPair;
    realm: AuthRegion;
    passportId?: string;
    accountRefreshToken?: string | null;
    memberships: readonly (
      | AuthMembership
      | AccountMembership
      | StoredAccountMetadata
    )[];
  },
  afterPersist: () => void | Promise<void>,
): Promise<string | null> {
  const passportId = input.passportId;
  const key = passportId
    ? accountVaultKey(input.realm, input.pair.membership.id)
    : null;
  return transactMobileAccountVault(
    (vault) => {
      delete vault.signedOutAt;
      if (!passportId || !key) return null;
      const memberships = input.memberships.map((membership) =>
        isStoredAccountMetadata(membership)
          ? membership
          : storedAccountMetadataFromMembership(membership, passportId),
      );
      if (input.accountRefreshToken) {
        vault.passports[passportVaultKey(input.realm, passportId)] = {
          realm: input.realm,
          passportId,
          accountRefreshToken: input.accountRefreshToken,
          memberships,
        };
        reconcileSavedAccountMetadata(vault, {
          realm: input.realm,
          passportId,
          memberships,
          passportMode: 'replace-passport',
        });
      }
      vault.resources[key] = {
        realm: input.realm,
        refreshToken: input.pair.refreshToken,
        metadata: storedAccountMetadataFromMembership(
          input.pair.membership,
          passportId,
        ),
        lastUsedAt: Date.now(),
      };
      vault.activeAccountKey = key;
      return key;
    },
    afterPersist,
    { recoverInvalidForExplicitLogin: true },
  );
}

export async function commitMobileSavedAccountActivation(
  accountKey: string,
  commitTransition: () => void | Promise<void>,
): Promise<void> {
  await transactMobileAccountVault(
    (vault) => {
      if (!vault.resources[accountKey]) {
        throw Object.assign(new Error('SAVED_ACCOUNT_NOT_FOUND'), {
          code: 'SAVED_ACCOUNT_NOT_FOUND',
        });
      }
      vault.activeAccountKey = accountKey;
    },
    commitTransition,
  );
}

/**
 * Store a rotated Passport only while the vault still contains the token that
 * started the request. Logout and concurrent refreshes therefore win over a
 * late response instead of having their newer state overwritten.
 */
export async function replaceMobilePassportSessionIfCurrent(input: {
  realm: AuthRegion;
  passportId: string;
  expectedAccountRefreshToken: string;
  accountRefreshToken: string;
  memberships: readonly (
    AuthMembership | AccountMembership | StoredAccountMetadata
  )[];
}): Promise<boolean> {
  const memberships = input.memberships.map((membership) =>
    isStoredAccountMetadata(membership)
      ? membership
      : storedAccountMetadataFromMembership(membership, input.passportId),
  );
  return mutateMobileAccountVault((vault) => {
    const key = passportVaultKey(input.realm, input.passportId);
    if (
      vault.passports[key]?.accountRefreshToken !==
      input.expectedAccountRefreshToken
    ) {
      return false;
    }
    vault.passports[key] = {
      realm: input.realm,
      passportId: input.passportId,
      accountRefreshToken: input.accountRefreshToken,
      memberships,
    };
    reconcileSavedAccountMetadata(vault, {
      realm: input.realm,
      passportId: input.passportId,
      memberships,
      passportMode: 'replace-passport',
    });
    return true;
  });
}

export async function patchMobileAccountMetadata(input: {
  realm: AuthRegion;
  passportId: string;
  memberships: readonly (AuthMembership | AccountMembership)[];
  replacePassport?: boolean;
}): Promise<void> {
  const memberships = input.memberships.map((membership) =>
    storedAccountMetadataFromMembership(membership, input.passportId),
  );
  await mutateMobileAccountVault((vault) => {
    reconcileSavedAccountMetadata(vault, {
      realm: input.realm,
      passportId: input.passportId,
      memberships,
      passportMode: input.replacePassport ? 'replace-passport' : 'patch-known',
    });
  });
}

export async function removeMobileSavedAccount(accountKey: string): Promise<void> {
  await mutateMobileAccountVault((vault) => {
    delete vault.resources[accountKey];
    if (vault.activeAccountKey === accountKey) vault.activeAccountKey = null;
  });
}

export async function removeMobilePassport(realm: AuthRegion, passportId: string): Promise<void> {
  await mutateMobileAccountVault((vault) => {
    delete vault.passports[passportVaultKey(realm, passportId)];
    for (const [key, resource] of Object.entries(vault.resources)) {
      if (resource.realm === realm && resource.metadata.passportId === passportId) {
        delete vault.resources[key];
        if (vault.activeAccountKey === key) vault.activeAccountKey = null;
      }
    }
  });
}

export async function removeMobilePassportSession(
  realm: AuthRegion,
  passportId: string,
): Promise<void> {
  await mutateMobileAccountVault((vault) => {
    delete vault.passports[passportVaultKey(realm, passportId)];
  });
}

/** Delete only the rejected Passport generation, never a concurrent replacement. */
export async function removeMobilePassportSessionIfCurrent(
  realm: AuthRegion,
  passportId: string,
  expectedAccountRefreshToken: string,
): Promise<boolean> {
  return mutateMobileAccountVault((vault) => {
    const key = passportVaultKey(realm, passportId);
    if (
      vault.passports[key]?.accountRefreshToken !== expectedAccountRefreshToken
    ) {
      return false;
    }
    delete vault.passports[key];
    return true;
  });
}
