// Unit tier. Basis: review of #13286 — a group draft must not be readable once its account's session ended,
// even when deleting it from AsyncStorage fails; signing out keeps it (maintainer decision). Gap covered: every
// account-record write decides in one place which generations it voids; nothing else creates or keeps one.
import { accountVaultKey, passportVaultKey } from '@cindy/auth-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStorage = vi.hoisted(() => ({
  value: null as string | null,
  readError: null as Error | null,
  writeError: null as Error | null,
  delete: vi.fn(async () => {
    secureStorage.value = null;
  }),
  set: vi.fn(async (_key: string, value: string) => {
    if (secureStorage.writeError) {
      const error = secureStorage.writeError;
      secureStorage.writeError = null;
      throw error;
    }
    secureStorage.value = value;
  }),
}));

vi.mock('../secureStorage', () => ({
  deleteSecureItem: secureStorage.delete,
  getSecureItem: vi.fn(async () => {
    if (secureStorage.readError) throw secureStorage.readError;
    return secureStorage.value;
  }),
  setSecureItem: secureStorage.set,
}));

import {
  clearMobileAccountVault,
  commitMobileLoginSessions,
  commitMobileRuntimeResourceSession,
  commitMobileSavedAccountActivation,
  ensureMobileGroupDraftEpoch,
  invalidateMobileGroupDraftEpochs,
  onMobileGroupDraftEpochsInvalidated,
  parseMobileAccountVault,
  patchMobileAccountMetadata,
  readMobileAccountVault,
  reconcileMobileActiveAuthSession,
  rememberMobilePassportSession,
  removeMobilePassport,
  removeMobilePassportSessionIfCurrent,
  removeMobileResourceSessionIfCurrent,
  replaceMobilePassportSessionIfCurrent,
  replaceMobileResourceSessionIfCurrent,
  settleGroupDraftEpochs,
  transactMobileAccountVault,
  type InvalidatedGroupDraftEpoch,
  type MobileAccountVault,
} from '../mobileAccountVault';

const meta = (id: string, passportId = 'passport-a') => ({
  membershipId: id, passportId, displayName: id, email: null, avatarUrl: null,
  kind: 'org' as const, role: 'member' as const, orgId: 'org', orgName: 'Org', orgLogoUrl: null,
});
const membership = (id: string, passportId = 'passport-a') => ({
  id, passportId, displayName: id, kind: 'org' as const, role: 'member' as const, email: null,
  orgId: 'org', orgName: 'Org', orgSlug: null, orgLogoUrl: null, avatarUrl: null,
});
const A = accountVaultKey('cn', 'a');
const B = accountVaultKey('cn', 'b');
const C = accountVaultKey('cn', 'c');
const PASSPORT = passportVaultKey('cn', 'passport-a');

/** A signed in with a resource; B only listed under A's passport; C has its own resource. All have drafts. */
function seed(overrides: Partial<MobileAccountVault> = {}): void {
  const vault: MobileAccountVault = {
    version: 1,
    activeAccountKey: A,
    resources: {
      [A]: { realm: 'cn', refreshToken: 'a-refresh', metadata: meta('a'), lastUsedAt: 2 },
      [C]: { realm: 'cn', refreshToken: 'c-refresh', metadata: meta('c', 'passport-c'), lastUsedAt: 1 },
    },
    passports: {
      [PASSPORT]: { realm: 'cn', passportId: 'passport-a', accountRefreshToken: 'passport-refresh', memberships: [meta('a'), meta('b')] },
    },
    groupDraftEpochs: { [A]: 'epoch-a', [B]: 'epoch-b', [C]: 'epoch-c' },
    ...overrides,
  };
  secureStorage.value = JSON.stringify(vault);
}
const epochs = () => (JSON.parse(secureStorage.value!) as MobileAccountVault).groupDraftEpochs ?? {};
const vaultWrites = () => secureStorage.set.mock.calls.length;

let invalidations: InvalidatedGroupDraftEpoch[][] = [];
onMobileGroupDraftEpochsInvalidated((invalidated) => { invalidations.push([...invalidated]); });

beforeEach(() => {
  secureStorage.value = null;
  secureStorage.readError = null;
  secureStorage.writeError = null;
  vi.clearAllMocks();
  invalidations = [];
});

describe('settleGroupDraftEpochs (pure)', () => {
  const base = (): MobileAccountVault => parseMobileAccountVault((seed(), secureStorage.value));

  it('voids an account that loses its last way to continue, and only that one', () => {
    const before = base();
    const after = base();
    after.passports[PASSPORT]!.memberships = [meta('a')];
    expect(settleGroupDraftEpochs({ before, after })).toEqual({
      epochs: { [A]: 'epoch-a', [C]: 'epoch-c' },
      invalidated: [{ accountKey: B, epoch: 'epoch-b' }],
    });
  });

  it('keeps an account that still has a passport listing after its resource session is removed', () => {
    const before = base();
    const after = base();
    delete after.resources[A];
    expect(settleGroupDraftEpochs({ before, after }).invalidated).toEqual([]);
  });

  it('voids the current account when a session is installed with no session record, unless signed out', () => {
    expect(settleGroupDraftEpochs({ before: base(), after: base(), sessionRecordPresent: false }).invalidated)
      .toEqual([{ accountKey: A, epoch: 'epoch-a' }]);
    expect(settleGroupDraftEpochs({ before: base(), after: base(), sessionRecordPresent: true }).invalidated).toEqual([]);
    expect(settleGroupDraftEpochs({ before: base(), after: base() }).invalidated).toEqual([]);
    const signedOut = { ...base(), activeAccountKey: null, resources: {}, passports: {}, signedOutAt: 1 };
    expect(settleGroupDraftEpochs({ before: signedOut, after: base(), sessionRecordPresent: false }).invalidated).toEqual([]);
  });

  it('voids listed accounts, never creates a generation, and reports only accounts that had one', () => {
    const before = base();
    const after = base();
    delete after.groupDraftEpochs![C];
    const settled = settleGroupDraftEpochs({ before, after, invalidate: [C, A, accountVaultKey('cn', 'none')] });
    expect(settled.epochs).toEqual({ [B]: 'epoch-b' });
    expect(settled.invalidated).toEqual([{ accountKey: A, epoch: 'epoch-a' }]);
  });
});

describe('every account-record write', () => {
  it.each([
    ['B is dropped from the member list (sync / switch)', () => replaceMobilePassportSessionIfCurrent({
      realm: 'cn', passportId: 'passport-a', expectedAccountRefreshToken: 'passport-refresh',
      accountRefreshToken: 'passport-refresh', memberships: [membership('a')] }), [B]],
    ['the passport is definitively rejected', () => removeMobilePassportSessionIfCurrent('cn', 'passport-a', 'passport-refresh'), [B]],
    ['the passport is deleted', () => removeMobilePassport('cn', 'passport-a'), [A, B]],
    ['a new login replaces the member list without B', () => commitMobileLoginSessions({
      pair: { accessToken: 'x', refreshToken: 'a-new', membership: membership('a') } as never,
      realm: 'cn', passportId: 'passport-a', accountRefreshToken: 'passport-new', memberships: [membership('a')],
    }, () => undefined, { sessionRecordPresent: true }), [B]],
    ['the same Passport is remembered without B', () => rememberMobilePassportSession({
      realm: 'cn', passportId: 'passport-a', accountRefreshToken: 'passport-new', memberships: [membership('a')] }), [B]],
    ['C\'s resource session is rejected and removed', () => removeMobileResourceSessionIfCurrent({ accountKey: C, expectedRefreshToken: 'c-refresh' }), [C]],
    ['A\'s resource session is removed but A stays on the passport', () => removeMobileResourceSessionIfCurrent({ accountKey: A, expectedRefreshToken: 'a-refresh' }), []],
    ['a refresh rotates A', () => replaceMobileResourceSessionIfCurrent({
      accountKey: A, expectedRefreshToken: 'a-refresh', realm: 'cn', passportId: 'passport-a',
      pair: { accessToken: 'x', refreshToken: 'a-rotated', membership: membership('a') } as never }), []],
    ['a runtime refresh commits for A', () => commitMobileRuntimeResourceSession({
      expectedRefreshToken: 'a-refresh', realm: 'cn', passportId: 'passport-a',
      pair: { accessToken: 'x', refreshToken: 'a-rotated', membership: membership('a') } as never }), []],
    ['metadata of known memberships is patched', () => patchMobileAccountMetadata({
      realm: 'cn', passportId: 'passport-a', memberships: [membership('a')] as never }), []],
    ['switching with the session record present', () => commitMobileSavedAccountActivation(C, () => undefined, { sessionRecordPresent: true }), []],
    ['switching with no session record (orphan session)', () => commitMobileSavedAccountActivation(C, () => undefined, { sessionRecordPresent: false }), [A]],
    ['logging in with no session record (orphan session)', () => commitMobileLoginSessions({
      pair: { accessToken: 'x', refreshToken: 'c-new', membership: membership('c', 'passport-c') } as never,
      realm: 'cn', passportId: 'passport-c', memberships: [membership('c', 'passport-c')],
    }, () => undefined, { sessionRecordPresent: false }), [A]],
  ] as const)('%s', async (_name, write, voided) => {
    seed();
    await write();
    const left = epochs();
    for (const key of [A, B, C]) expect(key in left).toBe(!(voided as readonly string[]).includes(key));
    expect(invalidations.flat().map(entry => entry.accountKey).sort()).toEqual([...voided].sort());
    expect(vaultWrites()).toBe(1);
  });

  it('keeps every generation through sign-out, so the same account gets its drafts back', async () => {
    seed();
    await clearMobileAccountVault();
    const vault = JSON.parse(secureStorage.value!) as MobileAccountVault;
    expect(vault).toMatchObject({ activeAccountKey: null, resources: {}, passports: {}, groupDraftEpochs: { [A]: 'epoch-a', [B]: 'epoch-b', [C]: 'epoch-c' } });
    expect(typeof vault.signedOutAt).toBe('number');
    // Signing back in after signing out is not an orphan session and keeps A's generation.
    await commitMobileLoginSessions({
      pair: { accessToken: 'x', refreshToken: 'a-new', membership: membership('a') } as never,
      realm: 'cn', passportId: 'passport-a', memberships: [membership('a')],
    }, () => undefined, { sessionRecordPresent: false });
    expect(epochs()[A]).toBe('epoch-a');
    expect(invalidations).toEqual([]);
  });

  it('rolls generations back with the credentials when the follow-up step fails, and reports nothing', async () => {
    seed();
    const before = secureStorage.value;
    await expect(transactMobileAccountVault((vault) => {
      vault.passports[PASSPORT]!.memberships = [meta('a')];
    }, () => { throw new Error('session write failed'); })).rejects.toThrow('session write failed');
    expect(secureStorage.value).toBe(before);
    expect(invalidations).toEqual([]);
  });

  it('drops a damaged generation field without failing the credentials around it', async () => {
    seed({ groupDraftEpochs: ['bad'] as never });
    await expect(readMobileAccountVault({ strict: true })).resolves.toMatchObject({ activeAccountKey: A });
    expect((await readMobileAccountVault({ strict: true })).groupDraftEpochs).toBeUndefined();
    seed({ groupDraftEpochs: { [A]: 'epoch-a', [B]: 7 } as never });
    expect((await readMobileAccountVault({ strict: true })).groupDraftEpochs).toEqual({ [A]: 'epoch-a' });
  });
});

describe('restart repair of a missing session record (orphan session)', () => {
  const repair = (writePersistedSession = vi.fn(async () => undefined)) => reconcileMobileActiveAuthSession({
    readPersistedSession: async () => null,
    writePersistedSession,
    clearPersistedSession: vi.fn(async () => undefined),
  });

  it('voids the current account\'s generation in the account record before restoring the session', async () => {
    seed();
    const order: string[] = [];
    secureStorage.set.mockImplementationOnce(async (_key, value) => { order.push('vault'); secureStorage.value = value; });
    await repair(vi.fn(async () => { order.push('session'); }));
    expect(order).toEqual(['vault', 'session']);
    expect(epochs()).toEqual({ [B]: 'epoch-b', [C]: 'epoch-c' });
    expect(invalidations).toEqual([[{ accountKey: A, epoch: 'epoch-a' }]]);
  });

  it('writes exactly as before when the current account has no generation', async () => {
    seed({ groupDraftEpochs: { [C]: 'epoch-c' } });
    const writePersistedSession = vi.fn(async () => undefined);
    await repair(writePersistedSession);
    expect(vaultWrites()).toBe(0);
    expect(writePersistedSession).toHaveBeenCalledOnce();
  });

  it('does not restore the session when voiding the generation cannot be written', async () => {
    seed();
    secureStorage.writeError = new Error('keychain write failed');
    const writePersistedSession = vi.fn(async () => undefined);
    await expect(repair(writePersistedSession)).rejects.toThrow('keychain write failed');
    expect(writePersistedSession).not.toHaveBeenCalled();
    expect(epochs()[A]).toBe('epoch-a');
  });

  it('leaves a signed-out record alone', async () => {
    seed({ activeAccountKey: null, resources: {}, passports: {}, signedOutAt: 1 });
    await repair();
    expect(vaultWrites()).toBe(0);
    expect(epochs()[A]).toBe('epoch-a');
  });
});

describe('ensuring and voiding a generation', () => {
  it('creates one random generation on first use and returns it afterwards without writing', async () => {
    seed({ groupDraftEpochs: undefined });
    const create = vi.fn(() => 'fresh');
    await expect(ensureMobileGroupDraftEpoch(A, create)).resolves.toBe('fresh');
    await expect(ensureMobileGroupDraftEpoch(A, create)).resolves.toBe('fresh');
    expect(create).toHaveBeenCalledOnce();
    expect(vaultWrites()).toBe(1);
  });

  it('gives a new generation, never the voided one, after an older version rewrote the record without the field', async () => {
    seed();
    const stripped = JSON.parse(secureStorage.value!);
    delete stripped.groupDraftEpochs;
    secureStorage.value = JSON.stringify(stripped);
    await expect(ensureMobileGroupDraftEpoch(A, () => 'replacement')).resolves.toBe('replacement');
  });

  it.each([
    ['the account cannot continue', () => seed(), accountVaultKey('cn', 'gone')],
    ['the device is signed out', () => seed({ activeAccountKey: null, resources: {}, passports: {}, signedOutAt: 1 }), A],
  ])('returns none without writing when %s', async (_name, arrange, accountKey) => {
    arrange();
    await expect(ensureMobileGroupDraftEpoch(accountKey, () => 'fresh')).resolves.toBeNull();
    expect(vaultWrites()).toBe(0);
  });

  it('returns none when the record cannot be read or written', async () => {
    seed({ groupDraftEpochs: undefined });
    secureStorage.readError = new Error('locked');
    await expect(ensureMobileGroupDraftEpoch(A, () => 'fresh')).resolves.toBeNull();
    secureStorage.readError = null;
    secureStorage.writeError = new Error('write failed');
    await expect(ensureMobileGroupDraftEpoch(A, () => 'fresh')).resolves.toBeNull();
  });

  it('voids a terminated account\'s generation, and writes nothing when it has none', async () => {
    seed({ groupDraftEpochs: { [C]: 'epoch-c' } });
    await invalidateMobileGroupDraftEpochs([A]);
    expect(vaultWrites()).toBe(0);
    seed();
    await invalidateMobileGroupDraftEpochs([A]);
    expect(epochs()).toEqual({ [B]: 'epoch-b', [C]: 'epoch-c' });
    expect(invalidations).toEqual([[{ accountKey: A, epoch: 'epoch-a' }]]);
  });
});
