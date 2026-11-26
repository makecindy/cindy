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
/**
 * Refreshing a login reads and rewrites the vault and the active session together.
 * Both stay readable on a locked phone so an answer given from a notification can
 * renew the login in the background; one without the other fails the refresh early.
 */
export const LOGIN_CREDENTIAL_STORAGE = { whileLocked: true } as const;

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
  /**
   * Group chat draft generation per account key (random, never reused). A group draft is readable only under its
   * account's current generation, so removing an entry here voids that account's drafts in the same write that
   * ended its session. Absent until a group chat first needs one; never part of any credential decision.
   */
  groupDraftEpochs?: Record<string, string>;
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

export class InvalidMobileAccountVaultError extends Error {}

function parseMobileAccountVaultRecord(
  raw: string | null,
  options: { allowInvalidChildren?: boolean } = {},
): MobileAccountVault {
  if (raw === null) return emptyMobileAccountVault();
  let value: Partial<MobileAccountVault> | null;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidMobileAccountVaultError('Saved account credentials are not valid JSON');
  }
  if (
    !value ||
    value.version !== 1 ||
    !value.resources ||
    typeof value.resources !== 'object' ||
    Array.isArray(value.resources) ||
    !value.passports ||
    typeof value.passports !== 'object' ||
    Array.isArray(value.passports)
  ) {
    throw new InvalidMobileAccountVaultError('Saved account credentials could not be read safely');
  }
  const resources: Record<string, MobileStoredResourceSession> = {};
  for (const [key, candidate] of Object.entries(value.resources)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      if (options.allowInvalidChildren) continue;
      throw new InvalidMobileAccountVaultError('Saved resource credential could not be read safely');
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
      throw new InvalidMobileAccountVaultError('Saved resource credential could not be read safely');
    }
    resources[key] = item as MobileStoredResourceSession;
  }
  const passports: Record<string, MobileStoredPassportSession> = {};
  for (const [key, candidate] of Object.entries(value.passports)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      if (options.allowInvalidChildren) continue;
      throw new InvalidMobileAccountVaultError('Saved Passport credential could not be read safely');
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
      throw new InvalidMobileAccountVaultError('Saved Passport credential could not be read safely');
    }
    const memberships = item.memberships.filter(isStoredAccountMetadata);
    if (
      !options.allowInvalidChildren &&
      memberships.length !== item.memberships.length
    ) {
      throw new InvalidMobileAccountVaultError('Saved Passport membership could not be read safely');
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
    ...groupDraftEpochsField(parseGroupDraftEpochs(value.groupDraftEpochs)),
  };
}

/** Lenient on purpose: a damaged draft field drops only the drafts, never the credentials around it. */
function parseGroupDraftEpochs(value: unknown): Record<string, string> {
  const epochs: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return epochs;
  for (const [accountKey, epoch] of Object.entries(value)) {
    if (accountKey && typeof epoch === 'string' && epoch) epochs[accountKey] = epoch;
  }
  return epochs;
}

function groupDraftEpochsField(epochs: Record<string, string>): { groupDraftEpochs?: Record<string, string> } {
  return Object.keys(epochs).length > 0 ? { groupDraftEpochs: epochs } : {};
}

/** Accounts that can still continue: a saved Resource session, or a membership listed under a saved passport. */
function continuableAccountKeys(vault: MobileAccountVault): Set<string> {
  const keys = new Set(Object.keys(vault.resources));
  for (const passport of Object.values(vault.passports)) {
    for (const membership of passport.memberships) keys.add(accountVaultKey(passport.realm, membership.membershipId));
  }
  return keys;
}

export interface InvalidatedGroupDraftEpoch {
  accountKey: string;
  epoch: string;
}

/**
 * Pure: the group draft generations after one account-record write.
 *
 * - An account that could continue before the write and cannot after it (its last Resource session and passport
 *   listing are gone) loses its generation.
 * - Orphan session: installing a session record while none exists, on a record that names a current account and
 *   is not signed out, means that account's session was ended (session termination deletes only the session
 *   record). Its generation goes. Signing out leaves `signedOutAt`, so it never counts.
 * - `invalidate` lists accounts whose session ended without changing the record (termination).
 *
 * Generations are only removed here, never created: an account gets a new one when a group chat first needs it.
 */
export function settleGroupDraftEpochs(input: {
  before: MobileAccountVault;
  after: MobileAccountVault;
  sessionRecordPresent?: boolean;
  invalidate?: readonly string[];
}): { epochs: Record<string, string>; invalidated: InvalidatedGroupDraftEpoch[] } {
  const epochs = { ...(input.after.groupDraftEpochs ?? {}) };
  const ended = new Set(input.invalidate ?? []);
  const continuableAfter = continuableAccountKeys(input.after);
  for (const accountKey of continuableAccountKeys(input.before)) {
    if (!continuableAfter.has(accountKey)) ended.add(accountKey);
  }
  if (
    input.sessionRecordPresent === false &&
    typeof input.before.signedOutAt !== 'number' &&
    input.before.activeAccountKey
  ) {
    ended.add(input.before.activeAccountKey);
  }
  const invalidated: InvalidatedGroupDraftEpoch[] = [];
  for (const accountKey of ended) {
    const epoch = epochs[accountKey];
    if (!epoch) continue;
    delete epochs[accountKey];
    invalidated.push({ accountKey, epoch });
  }
  return { epochs, invalidated };
}

/** Never throws into a credential write: if settling fails the drafts go, the credentials do not. */
function applyGroupDraftEpochs(
  vault: MobileAccountVault,
  settle: () => ReturnType<typeof settleGroupDraftEpochs>,
): InvalidatedGroupDraftEpoch[] {
  try {
    const { epochs, invalidated } = settle();
    if (Object.keys(epochs).length > 0) vault.groupDraftEpochs = epochs;
    else delete vault.groupDraftEpochs;
    return invalidated;
  } catch {
    const lost = Object.entries(vault.groupDraftEpochs ?? {}).map(([accountKey, epoch]) => ({ accountKey, epoch }));
    delete vault.groupDraftEpochs;
    return lost;
  }
}

type GroupDraftEpochListener = (invalidated: readonly InvalidatedGroupDraftEpoch[]) => void;
const groupDraftEpochListeners = new Set<GroupDraftEpochListener>();

/** Called after a write that voided generations has committed (including `afterPersist`); never before. */
export function onMobileGroupDraftEpochsInvalidated(listener: GroupDraftEpochListener): () => void {
  groupDraftEpochListeners.add(listener);
  return () => groupDraftEpochListeners.delete(listener);
}

function notifyGroupDraftEpochsInvalidated(invalidated: readonly InvalidatedGroupDraftEpoch[]): void {
  if (invalidated.length === 0) return;
  for (const listener of groupDraftEpochListeners) {
    try {
      listener(invalidated);
    } catch {
      // Draft cleanup is best effort; it never fails the credential write that already committed.
    }
  }
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

export async function readMobileAccountVault(options: { strict?: boolean } = {}): Promise<MobileAccountVault> {
  await mutation;
  const raw = await getSecureItem(MOBILE_ACCOUNT_VAULT_KEY);
  return options.strict ? parseMobileAccountVaultRecord(raw) : parseMobileAccountVault(raw);
}

async function writeMobileAccountVault(vault: MobileAccountVault): Promise<void> {
  await setSecureItem(MOBILE_ACCOUNT_VAULT_KEY, JSON.stringify(vault), LOGIN_CREDENTIAL_STORAGE);
}

export function transactMobileAccountVault<T>(
  operation: (vault: MobileAccountVault) => T | Promise<T>,
  afterPersist: (result: T) => void | Promise<void> = () => undefined,
  options: {
    recoverInvalidForExplicitLogin?: boolean;
    /** Set by writes that install a session record: whether one existed before (see settleGroupDraftEpochs). */
    sessionRecordPresent?: boolean;
    invalidateGroupDrafts?: readonly string[];
  } = {},
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
    const before = parseMobileAccountVault(raw);
    const result = await operation(vault);
    const invalidated = applyGroupDraftEpochs(vault, () => settleGroupDraftEpochs({
      before,
      after: vault,
      sessionRecordPresent: options.sessionRecordPresent,
      invalidate: options.invalidateGroupDrafts,
    }));
    await writeMobileAccountVault(vault);
    try {
      // Keep the vault queue owned until every related durable write and
      // cancellation check has committed. A failure restores the exact prior
      // encrypted record before another mutation can observe partial state.
      await afterPersist(result);
    } catch (error) {
      if (raw === null) await deleteSecureItem(MOBILE_ACCOUNT_VAULT_KEY);
      else await setSecureItem(MOBILE_ACCOUNT_VAULT_KEY, raw, LOGIN_CREDENTIAL_STORAGE);
      throw error;
    }
    notifyGroupDraftEpochsInvalidated(invalidated);
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
      // Orphan session: the record names a current account but its session record is gone, which is what
      // session termination leaves. Void that account's group drafts before the session comes back; only when
      // it has a generation, so a launch without group drafts writes exactly as before.
      const repaired: MobileAccountVault = { ...vault };
      const invalidated = applyGroupDraftEpochs(repaired, () => settleGroupDraftEpochs({
        before: vault,
        after: repaired,
        sessionRecordPresent: false,
      }));
      if (invalidated.length > 0) {
        await writeMobileAccountVault(repaired);
        notifyGroupDraftEpochsInvalidated(invalidated);
      }
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
    // Signing out keeps group draft generations: the same account in the same realm gets its drafts back.
    Object.assign(vault, groupDraftEpochsField(parseMobileAccountVault(raw).groupDraftEpochs ?? {}));
    await writeMobileAccountVault(vault);
    try {
      await afterPersist();
    } catch (error) {
      if (raw === null) await deleteSecureItem(MOBILE_ACCOUNT_VAULT_KEY);
      else await setSecureItem(MOBILE_ACCOUNT_VAULT_KEY, raw, LOGIN_CREDENTIAL_STORAGE);
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
  options: { sessionRecordPresent?: boolean } = {},
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
    { recoverInvalidForExplicitLogin: true, sessionRecordPresent: options.sessionRecordPresent },
  );
}

export async function commitMobileSavedAccountActivation(
  accountKey: string,
  commitTransition: () => void | Promise<void>,
  options: { sessionRecordPresent?: boolean } = {},
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
    { sessionRecordPresent: options.sessionRecordPresent },
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

/** Current group draft generations, or null when the record cannot be read (never a guessed default). */
export async function readMobileGroupDraftEpochs(): Promise<Record<string, string> | null> {
  try {
    const vault = await readMobileAccountVault({ strict: true });
    return { ...(vault.groupDraftEpochs ?? {}) };
  } catch {
    return null;
  }
}

/**
 * This account's group draft generation, creating one only when it has none. Null when the account cannot
 * continue, the device is signed out, or the record cannot be read or written: the caller then keeps drafts in
 * memory only. A missing generation is never filled with a default, so a voided one cannot come back.
 */
export async function ensureMobileGroupDraftEpoch(
  accountKey: string,
  createEpoch: () => string,
): Promise<string | null> {
  if (!accountKey) return null;
  let current: MobileAccountVault;
  try {
    current = await readMobileAccountVault({ strict: true });
  } catch {
    return null;
  }
  if (typeof current.signedOutAt === 'number' || !continuableAccountKeys(current).has(accountKey)) return null;
  const existing = current.groupDraftEpochs?.[accountKey];
  if (existing) return existing;
  try {
    return await transactMobileAccountVault((vault) => {
      if (typeof vault.signedOutAt === 'number' || !continuableAccountKeys(vault).has(accountKey)) return null;
      const stored = vault.groupDraftEpochs?.[accountKey];
      if (stored) return stored;
      const epoch = createEpoch();
      vault.groupDraftEpochs = { ...(vault.groupDraftEpochs ?? {}), [accountKey]: epoch };
      return epoch;
    });
  } catch {
    return null;
  }
}

/**
 * Voids these accounts' group drafts for a session that ended without changing the record (termination). Writes
 * only when one of them has a generation. Callers must not wait on it before clearing credentials: if it fails,
 * the orphan-session rule voids the generation when a session for the account is installed again.
 */
export async function invalidateMobileGroupDraftEpochs(accountKeys: readonly string[]): Promise<void> {
  const keys = accountKeys.filter(Boolean);
  if (keys.length === 0) return;
  const epochs = await readMobileGroupDraftEpochs();
  if (epochs && !keys.some(key => epochs[key])) return;
  await transactMobileAccountVault(() => undefined, () => undefined, { invalidateGroupDrafts: keys });
}
