import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LOCAL_PROFILE_DATA_OWNER_ID,
  assertValidProfileDescriptor,
  createProfileId,
  emptyProfileRegistry,
  findProfileByIdentity,
  markProfileOpened,
  parseProfileDescriptor,
  profileIdentityKey,
  registerProfile,
  resolveProfileDbPath,
  serializeProfileDescriptor,
  setDefaultProfile,
  type ProfileDescriptor,
  type ProfileId,
} from '../profileRegistryModel.js';

const PROFILE_A = '00000000-0000-4000-8000-000000000001' as ProfileId;
const PROFILE_B = '00000000-0000-4000-8000-000000000002' as ProfileId;

function cloudProfile(overrides: Partial<ProfileDescriptor> = {}): ProfileDescriptor {
  return {
    profileId: PROFILE_A,
    mode: 'cloud',
    authRealm: 'global',
    dataOwnerId: 'owner-a',
    displayName: 'Account A',
    status: 'active',
    storageMode: 'profile_dir',
    legacyUserId: null,
    createdAt: 1,
    lastOpenedAt: null,
    lastVerifiedAt: null,
    ...overrides,
  };
}

describe('profile registry model', () => {
  it('creates opaque UUID profile ids and validates local identity', () => {
    expect(createProfileId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(() => assertValidProfileDescriptor(cloudProfile({ mode: 'local' }))).toThrow(
      'local profile cannot have an auth realm',
    );
    expect(() =>
      assertValidProfileDescriptor(
        cloudProfile({ mode: 'local', authRealm: null, dataOwnerId: 'owner-a' }),
      ),
    ).toThrow(`local profile must use ${LOCAL_PROFILE_DATA_OWNER_ID}`);
    expect(() =>
      assertValidProfileDescriptor(
        cloudProfile({
          mode: 'local',
          authRealm: null,
          dataOwnerId: LOCAL_PROFILE_DATA_OWNER_ID,
        }),
      ),
    ).not.toThrow();
  });

  it('uses (auth realm, data owner) as the account uniqueness key', () => {
    const state = registerProfile(emptyProfileRegistry(), cloudProfile());
    expect(
      findProfileByIdentity(state, { mode: 'cloud', authRealm: 'global', dataOwnerId: 'owner-a' }),
    ).toEqual(cloudProfile());
    expect(() =>
      registerProfile(
        state,
        cloudProfile({ profileId: PROFILE_B, displayName: 'Duplicate account' }),
      ),
    ).toThrow('already exists');

    const cnProfile = cloudProfile({ profileId: PROFILE_B, authRealm: 'cn' });
    expect(() => registerProfile(state, cnProfile)).not.toThrow();
    expect(profileIdentityKey({ mode: 'cloud', authRealm: 'cn', dataOwnerId: 'owner-a' })).not.toBe(
      profileIdentityKey({ mode: 'cloud', authRealm: 'global', dataOwnerId: 'owner-a' }),
    );
  });

  it('keeps legacy database paths unchanged and derives new paths from profileId', () => {
    const legacy = cloudProfile({
      storageMode: 'legacy_user_db',
      legacyUserId: 'user-123',
    });
    expect(resolveProfileDbPath(legacy, { userDataDir: '/user-data', dbFilePrefix: 'cindy' })).toBe(
      path.join('/user-data', 'cindy-user-123.db'),
    );

    const modern = cloudProfile({ storageMode: 'profile_dir', legacyUserId: 'old-user-123' });
    expect(resolveProfileDbPath(modern, { userDataDir: '/user-data', dbFilePrefix: 'cindy' })).toBe(
      path.join('/user-data', 'profiles', PROFILE_A, 'profile.db'),
    );
    expect(
      resolveProfileDbPath(modern, { userDataDir: '/user-data', dbFilePrefix: 'cindy' }),
    ).not.toContain('owner-a');
  });

  it('rejects path traversal in legacy ids and prefixes', () => {
    expect(() =>
      resolveProfileDbPath(
        cloudProfile({ storageMode: 'legacy_user_db', legacyUserId: '../other' }),
        { userDataDir: '/user-data', dbFilePrefix: 'cindy' },
      ),
    ).toThrow('legacyUserId');
    expect(() =>
      resolveProfileDbPath(cloudProfile(), { userDataDir: '/user-data', dbFilePrefix: '../cindy' }),
    ).toThrow('dbFilePrefix');
  });

  it('serializes only registry fields and never carries credentials', () => {
    const input = {
      ...cloudProfile(),
      accessToken: 'secret',
      refreshToken: 'secret',
    } as ProfileDescriptor & {
      accessToken: string;
      refreshToken: string;
    };
    const serialized = serializeProfileDescriptor(input);
    expect(serialized).not.toHaveProperty('accessToken');
    expect(serialized).not.toHaveProperty('refreshToken');

    const parsed = parseProfileDescriptor({ ...serialized, accessToken: 'secret' });
    expect(parsed).toEqual(cloudProfile());
    expect(parsed).not.toHaveProperty('accessToken');
  });

  it('rejects registry records without a required creation timestamp', () => {
    expect(() => parseProfileDescriptor({ ...cloudProfile(), createdAt: null })).toThrow(
      'createdAt must be a non-negative integer',
    );

    const state = registerProfile(emptyProfileRegistry(), cloudProfile());
    expect(() => markProfileOpened(state, PROFILE_A, null as unknown as number)).toThrow(
      'openedAt must be a non-negative integer',
    );
  });

  it('selects the first registered profile by default and permits explicit changes', () => {
    const state = registerProfile(emptyProfileRegistry(), cloudProfile());
    const withSecond = registerProfile(
      state,
      cloudProfile({ profileId: PROFILE_B, dataOwnerId: 'owner-b', displayName: 'Account B' }),
    );
    expect(withSecond.defaultProfileId).toBe(PROFILE_A);
    expect(setDefaultProfile(withSecond, PROFILE_B).defaultProfileId).toBe(PROFILE_B);
    expect(() =>
      setDefaultProfile(withSecond, '00000000-0000-4000-8000-000000000099' as ProfileId),
    ).toThrow('unknown profile');
  });

  it('never selects a deleting profile as the default', () => {
    const deletingFirst = registerProfile(
      emptyProfileRegistry(),
      cloudProfile({ status: 'deleting' }),
    );
    expect(deletingFirst.defaultProfileId).toBeNull();

    const withTwoProfiles = registerProfile(
      registerProfile(emptyProfileRegistry(), cloudProfile()),
      cloudProfile({ profileId: PROFILE_B, dataOwnerId: 'owner-b', displayName: 'Account B' }),
    );
    const afterDefaultDeletion = registerProfile(
      withTwoProfiles,
      cloudProfile({ status: 'deleting' }),
    );
    expect(afterDefaultDeletion.defaultProfileId).toBe(PROFILE_B);
  });
});
