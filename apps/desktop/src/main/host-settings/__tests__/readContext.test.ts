import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveAppSession } from '../../appSessionState.js';
import type { CommittedAuthIdentity } from '../../authCommittedIdentity.js';

const mocks = vi.hoisted(() => ({
  session: null as ActiveAppSession | null,
  auth: null as CommittedAuthIdentity | null,
  boundary: false,
  profile: '',
  getPath: vi.fn(),
  peekSession: vi.fn(),
  peekAuth: vi.fn(),
  boundaryPending: vi.fn(),
  storageKey: vi.fn(),
  forbidden: vi.fn(() => { throw new Error('Forbidden loading, credential, or filesystem operation'); }),
}));

vi.mock('electron', () => ({ app: { getPath: mocks.getPath }, safeStorage: { decryptString: mocks.forbidden } }));
vi.mock('../../appSessionState.js', () => ({
  peekCommittedAppSession: mocks.peekSession,
  isAppSessionBoundaryPending: mocks.boundaryPending,
  dataOwnerStorageKey: mocks.storageKey,
  getActiveAppSession: mocks.forbidden,
  ownerScopedUserDataPath: mocks.forbidden,
  activeOwnerScopeKey: mocks.forbidden,
}));
vi.mock('../../authManager.js', () => ({
  peekCommittedAuthIdentity: mocks.peekAuth,
  getAuthState: mocks.forbidden,
  getAccessToken: mocks.forbidden,
  initialize: mocks.forbidden,
}));
vi.mock('node:fs', () => ({ readFileSync: mocks.forbidden, mkdirSync: mocks.forbidden, writeFileSync: mocks.forbidden }));

import { assertSettingsReadContext, getSettingsReadContext } from '../readContext.js';

// Recorded before any test resets the mocks: importing the module must not resolve or read anything.
const callsDuringImport = [mocks.getPath, mocks.peekSession, mocks.peekAuth, mocks.boundaryPending, mocks.storageKey, mocks.forbidden]
  .map((spy) => spy.mock.calls.length);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session = { mode: 'cloud', dataOwnerId: 'membership-test', generation: 7 };
  mocks.auth = { userId: 'membership-test', membershipKind: 'org', isAuthenticated: true };
  mocks.boundary = false;
  mocks.profile = path.resolve('/temporary-test-profile');
  mocks.getPath.mockImplementation((name: string) => {
    if (name !== 'userData') return mocks.forbidden();
    return mocks.profile;
  });
  mocks.peekSession.mockImplementation(() => mocks.session ? { ...mocks.session } : null);
  mocks.peekAuth.mockImplementation(() => mocks.auth ? { ...mocks.auth } : null);
  mocks.boundaryPending.mockImplementation(() => mocks.boundary);
  mocks.storageKey.mockImplementation((owner: string) => `hashed-${owner}`);
  mocks.forbidden.mockImplementation(() => { throw new Error('Forbidden loading, credential, or filesystem operation'); });
  vi.stubGlobal('fetch', mocks.forbidden);
});
afterEach(() => {
  expect(mocks.forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('settings committed read context', () => {
  it('does not resolve paths, inspect identity, or load state during module import', () => {
    expect(callsDuringImport.every((calls) => calls === 0)).toBe(true);
  });

  it('captures authenticated owner roots from the profile and pure storage key', () => {
    expect(getSettingsReadContext()).toEqual({
      mode: 'cloud', dataOwnerId: 'membership-test', generation: 7,
      userDataPath: mocks.profile, ownerRoot: path.join(mocks.profile, 'owners', 'hashed-membership-test'),
      isAuthenticated: true, membershipKind: 'org', platform: process.platform, arch: process.arch,
    });
    expect(mocks.getPath).toHaveBeenCalledWith('userData');
    expect(mocks.storageKey).toHaveBeenCalledWith('membership-test');
    expect(mocks.peekSession).toHaveBeenCalledTimes(2);
  });

  it('keeps personal membership context distinct from organization defaults', () => {
    mocks.auth!.membershipKind = 'personal';
    expect(getSettingsReadContext()).toMatchObject({ membershipKind: 'personal', isAuthenticated: true });
  });

  it('treats local app session as local data, never as cloud authentication', () => {
    mocks.session = { mode: 'local', dataOwnerId: 'local-owner', generation: 2 };
    expect(getSettingsReadContext()).toMatchObject({
      mode: 'local', dataOwnerId: 'local-owner', isAuthenticated: false, membershipKind: null,
      ownerRoot: path.join(mocks.profile, 'owners', 'hashed-local-owner'),
    });
    expect(mocks.peekAuth).not.toHaveBeenCalled();
  });

  it.each(['uninitialized', 'signed-out', 'no-owner', 'boundary'] as const)('fails closed for %s session before resolving a path', (kind) => {
    if (kind === 'uninitialized') mocks.session = null;
    if (kind === 'signed-out') mocks.session = { mode: 'signed-out', dataOwnerId: null, generation: 8 };
    if (kind === 'no-owner') mocks.session!.dataOwnerId = null;
    if (kind === 'boundary') mocks.boundary = true;
    expect(getSettingsReadContext()).toBeNull();
    expect(mocks.peekAuth).not.toHaveBeenCalled();
    expect(mocks.getPath).not.toHaveBeenCalled();
  });

  it.each(['unready', 'unauthenticated', 'other-owner'] as const)('fails closed for %s cloud identity', (kind) => {
    if (kind === 'unready') mocks.auth = null;
    if (kind === 'unauthenticated') mocks.auth!.isAuthenticated = false;
    if (kind === 'other-owner') mocks.auth!.userId = 'other-membership';
    expect(getSettingsReadContext()).toBeNull();
    expect(mocks.getPath).not.toHaveBeenCalled();
  });

  it.each(['', 'relative-profile'])('rejects an unusable profile path %j', (profile) => {
    mocks.profile = profile;
    expect(getSettingsReadContext()).toBeNull();
    expect(mocks.storageKey).not.toHaveBeenCalled();
  });

  it.each(['owner', 'generation', 'mode', 'boundary'] as const)('rechecks %s after capturing the profile', (kind) => {
    mocks.getPath.mockImplementation(() => {
      if (kind === 'owner') mocks.session!.dataOwnerId = 'other-owner';
      if (kind === 'generation') mocks.session!.generation++;
      if (kind === 'mode') mocks.session!.mode = 'local';
      if (kind === 'boundary') mocks.boundary = true;
      return mocks.profile;
    });
    expect(getSettingsReadContext()).toBeNull();
  });

  it('allows the unchanged captured context', () => {
    const context = getSettingsReadContext()!;
    expect(() => assertSettingsReadContext(context)).not.toThrow();
  });

  it.each(['owner', 'generation', 'mode', 'profile', 'boundary', 'auth', 'membership', 'owner-root', 'platform', 'arch'] as const)
  ('throws a static owner-changed error for %s drift', (kind) => {
    const captured = getSettingsReadContext()!;
    if (kind === 'owner') mocks.session!.dataOwnerId = 'private-owner';
    if (kind === 'generation') mocks.session!.generation++;
    if (kind === 'mode') mocks.session!.mode = 'local';
    if (kind === 'profile') mocks.profile = path.resolve('/another-private-profile');
    if (kind === 'boundary') mocks.boundary = true;
    if (kind === 'auth') mocks.auth!.isAuthenticated = false;
    if (kind === 'membership') mocks.auth!.membershipKind = 'personal';
    if (kind === 'owner-root') captured.ownerRoot = '/wrong-owner-root';
    if (kind === 'platform') captured.platform = process.platform === 'win32' ? 'linux' : 'win32';
    if (kind === 'arch') captured.arch = 'different-architecture';
    expect(() => assertSettingsReadContext(captured)).toThrowError(/^SETTINGS_OWNER_CHANGED$/);
  });

  it('does not expose underlying path or identity errors', () => {
    const captured = getSettingsReadContext()!;
    mocks.getPath.mockImplementation(() => { throw new Error('private directory detail'); });
    expect(getSettingsReadContext()).toBeNull();
    expect(() => assertSettingsReadContext(captured)).toThrowError(/^SETTINGS_OWNER_CHANGED$/);
  });
});
