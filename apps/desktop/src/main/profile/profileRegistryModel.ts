import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { AuthRegion } from '@cindy/auth-client';

/** Local mode has no server membership, so it uses one stable synthetic owner. */
export const LOCAL_PROFILE_DATA_OWNER_ID = 'local-v1';

const PROFILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProfileId = string & { readonly __profileId: unique symbol };
export type ProfileMode = 'local' | 'cloud';
export type ProfileStatus = 'active' | 'signed_out' | 'needs_login' | 'deleting';
export type ProfileStorageMode = 'legacy_user_db' | 'profile_dir';

/**
 * The allow-listed fields that may be persisted in the machine registry.
 *
 * Tokens and other credentials intentionally have no representation here. The
 * registry is a machine-level coordination database, not a secret store.
 */
export interface ProfileDescriptor {
  profileId: ProfileId;
  mode: ProfileMode;
  authRealm: AuthRegion | null;
  dataOwnerId: string;
  displayName: string;
  status: ProfileStatus;
  storageMode: ProfileStorageMode;
  /** Kept while a legacy database remains the canonical storage location. */
  legacyUserId: string | null;
  createdAt: number;
  lastOpenedAt: number | null;
  lastVerifiedAt: number | null;
}

/** This is the exact row-shaped payload the future SQLite registry may store. */
export type ProfileRegistryRecord = ProfileDescriptor;

export interface ProfileRegistryState {
  profiles: readonly ProfileDescriptor[];
  defaultProfileId: ProfileId | null;
}

export interface ProfileDbPathContext {
  userDataDir: string;
  dbFilePrefix: string;
}

export interface ProfileIdentity {
  mode: ProfileMode;
  authRealm: AuthRegion | null;
  dataOwnerId: string;
}

export function createProfileId(): ProfileId {
  return randomUUID() as ProfileId;
}

export function isProfileId(value: unknown): value is ProfileId {
  return typeof value === 'string' && PROFILE_ID_RE.test(value);
}

export function parseProfileId(value: unknown): ProfileId {
  if (!isProfileId(value)) throw new Error('invalid profileId');
  return value;
}

/**
 * Build the registry uniqueness key. JSON tuple encoding avoids delimiter
 * collisions while preserving the documented `(auth_realm, data_owner_id)`
 * uniqueness constraint.
 */
export function profileIdentityKey(identity: ProfileIdentity): string {
  return JSON.stringify([identity.authRealm, identity.dataOwnerId]);
}

export function profileDescriptorIdentity(profile: ProfileDescriptor): ProfileIdentity {
  return {
    mode: profile.mode,
    authRealm: profile.authRealm,
    dataOwnerId: profile.dataOwnerId,
  };
}

function assertSafePathSegment(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    /[\\/\0]/.test(value)
  ) {
    throw new Error(`${field} must be a single safe path segment`);
  }
}

function assertOptionalTimestamp(value: unknown, field: string): asserts value is number | null {
  if (value === null) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer or null`);
  }
}

function assertRequiredTimestamp(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

/** Validate invariants before a descriptor enters the registry. */
export function assertValidProfileDescriptor(profile: ProfileDescriptor): void {
  parseProfileId(profile.profileId);

  if (profile.mode !== 'local' && profile.mode !== 'cloud') {
    throw new Error('profile mode must be local or cloud');
  }
  if (profile.mode === 'local') {
    if (profile.authRealm !== null) throw new Error('local profile cannot have an auth realm');
    if (profile.dataOwnerId !== LOCAL_PROFILE_DATA_OWNER_ID) {
      throw new Error(`local profile must use ${LOCAL_PROFILE_DATA_OWNER_ID}`);
    }
  } else if (profile.authRealm !== 'cn' && profile.authRealm !== 'global') {
    throw new Error('cloud profile must have a valid auth realm');
  }

  if (typeof profile.dataOwnerId !== 'string' || !profile.dataOwnerId.trim()) {
    throw new Error('profile dataOwnerId is required');
  }
  if (typeof profile.displayName !== 'string' || !profile.displayName.trim()) {
    throw new Error('profile displayName is required');
  }
  if (
    profile.status !== 'active' &&
    profile.status !== 'signed_out' &&
    profile.status !== 'needs_login' &&
    profile.status !== 'deleting'
  ) {
    throw new Error('invalid profile status');
  }
  if (profile.storageMode !== 'legacy_user_db' && profile.storageMode !== 'profile_dir') {
    throw new Error('invalid profile storage mode');
  }
  if (profile.storageMode === 'legacy_user_db') {
    if (!profile.legacyUserId) throw new Error('legacy storage requires legacyUserId');
    assertSafePathSegment(profile.legacyUserId, 'legacyUserId');
  } else if (profile.legacyUserId !== null) {
    assertSafePathSegment(profile.legacyUserId, 'legacyUserId');
  }

  assertRequiredTimestamp(profile.createdAt, 'createdAt');
  assertOptionalTimestamp(profile.lastOpenedAt, 'lastOpenedAt');
  assertOptionalTimestamp(profile.lastVerifiedAt, 'lastVerifiedAt');
}

/**
 * Allow-list serialization for the future SQLite adapter. Unknown fields are
 * deliberately dropped, so a token accidentally attached by a caller cannot
 * become part of the registry record.
 */
export function serializeProfileDescriptor(profile: ProfileDescriptor): ProfileRegistryRecord {
  assertValidProfileDescriptor(profile);
  return {
    profileId: profile.profileId,
    mode: profile.mode,
    authRealm: profile.authRealm,
    dataOwnerId: profile.dataOwnerId,
    displayName: profile.displayName,
    status: profile.status,
    storageMode: profile.storageMode,
    legacyUserId: profile.legacyUserId,
    createdAt: profile.createdAt,
    lastOpenedAt: profile.lastOpenedAt,
    lastVerifiedAt: profile.lastVerifiedAt,
  };
}

/** Parse a registry row without allowing extra fields into the model. */
export function parseProfileDescriptor(raw: unknown): ProfileDescriptor {
  if (!raw || typeof raw !== 'object') throw new Error('invalid profile registry record');
  const value = raw as Record<string, unknown>;
  const profile: ProfileDescriptor = {
    profileId: parseProfileId(value.profileId),
    mode: value.mode as ProfileMode,
    authRealm: value.authRealm as AuthRegion | null,
    dataOwnerId: value.dataOwnerId as string,
    displayName: value.displayName as string,
    status: value.status as ProfileStatus,
    storageMode: value.storageMode as ProfileStorageMode,
    legacyUserId: value.legacyUserId as string | null,
    createdAt: value.createdAt as number,
    lastOpenedAt: value.lastOpenedAt as number | null,
    lastVerifiedAt: value.lastVerifiedAt as number | null,
  };
  assertValidProfileDescriptor(profile);
  return profile;
}

export function emptyProfileRegistry(): ProfileRegistryState {
  return { profiles: [], defaultProfileId: null };
}

export function findProfileById(
  state: ProfileRegistryState,
  profileId: ProfileId,
): ProfileDescriptor | null {
  return state.profiles.find((profile) => profile.profileId === profileId) ?? null;
}

export function findProfileByIdentity(
  state: ProfileRegistryState,
  identity: ProfileIdentity,
): ProfileDescriptor | null {
  const key = profileIdentityKey(identity);
  return (
    state.profiles.find(
      (profile) => profileIdentityKey(profileDescriptorIdentity(profile)) === key,
    ) ?? null
  );
}

/**
 * Insert or update a Profile while rejecting both identity and id collisions.
 * A duplicate identity must reuse the existing local Profile instead of
 * silently creating a second database for the same account.
 */
export function registerProfile(
  state: ProfileRegistryState,
  profile: ProfileDescriptor,
): ProfileRegistryState {
  const serialized = serializeProfileDescriptor(profile);
  const existingById = findProfileById(state, profile.profileId);
  const existingByIdentity = findProfileByIdentity(state, profileDescriptorIdentity(profile));

  if (
    existingById &&
    profileIdentityKey(profileDescriptorIdentity(existingById)) !==
      profileIdentityKey(profileDescriptorIdentity(profile))
  ) {
    throw new Error(`profileId ${profile.profileId} is already bound to another identity`);
  }
  if (existingByIdentity && existingByIdentity.profileId !== profile.profileId) {
    throw new Error(
      `profile identity ${profileIdentityKey(profileDescriptorIdentity(profile))} already exists`,
    );
  }

  const profiles = existingById
    ? state.profiles.map((item) => (item.profileId === profile.profileId ? serialized : item))
    : [...state.profiles, serialized];

  const currentDefault = state.defaultProfileId
    ? (profiles.find(
        (item) => item.profileId === state.defaultProfileId && item.status !== 'deleting',
      )?.profileId ?? null)
    : null;
  const firstSelectableProfile =
    profiles.find((item) => item.status !== 'deleting')?.profileId ?? null;

  return {
    profiles,
    defaultProfileId: currentDefault ?? firstSelectableProfile,
  };
}

export function setDefaultProfile(
  state: ProfileRegistryState,
  profileId: ProfileId,
): ProfileRegistryState {
  const profile = findProfileById(state, profileId);
  if (!profile) throw new Error(`cannot select unknown profile ${profileId}`);
  if (profile.status === 'deleting') throw new Error('deleting profile cannot be selected');
  return { ...state, defaultProfileId: profileId };
}

export function markProfileOpened(
  state: ProfileRegistryState,
  profileId: ProfileId,
  openedAt: number,
): ProfileRegistryState {
  const profile = findProfileById(state, profileId);
  if (!profile) throw new Error(`cannot open unknown profile ${profileId}`);
  assertRequiredTimestamp(openedAt, 'openedAt');
  return {
    ...state,
    profiles: state.profiles.map((item) =>
      item.profileId === profileId ? { ...item, lastOpenedAt: openedAt } : item,
    ),
  };
}

/**
 * Resolve the database path without ever using dataOwnerId as a filename.
 * Legacy profiles retain the exact `<prefix>-<userId>.db` path until a later,
 * independently verified physical migration.
 */
export function resolveProfileDbPath(
  profile: ProfileDescriptor,
  context: ProfileDbPathContext,
): string {
  assertValidProfileDescriptor(profile);
  assertSafePathSegment(context.dbFilePrefix, 'dbFilePrefix');
  if (!context.userDataDir.trim()) throw new Error('userDataDir is required');

  if (profile.storageMode === 'legacy_user_db') {
    return path.join(context.userDataDir, `${context.dbFilePrefix}-${profile.legacyUserId}.db`);
  }
  return path.join(context.userDataDir, 'profiles', profile.profileId, 'profile.db');
}
