import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accountVaultKey, type AuthRegion } from '@cindy/auth-client';
import { getMobileAuthOwner, setMobileAuthOwner, invalidateMobileAuthOwnerForSwitch } from '@/auth/authOwnerGeneration';

const storage = vi.hoisted(() => ({ values: new Map<string, string>(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
import { __testing, clearClipboardInvitationHistory, hasSeenClipboardInvitation, invitationDigest, rememberClipboardInvitation } from '@/device-link/clipboardInvitationHistory';

const account = '["global","guest"]';
const key = __testing.storageKey(account);
const token = 'A'.repeat(43);
const digest = invitationDigest(token);
const day = 24 * 60 * 60_000;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T00:00:00Z'));
  __testing.reset(); storage.values.clear();
  storage.getItem.mockReset().mockImplementation(async (k: string) => storage.values.get(k) ?? null);
  storage.setItem.mockReset().mockImplementation(async (k: string, value: string) => { storage.values.set(k, value); });
  storage.removeItem.mockReset().mockImplementation(async (k: string) => { storage.values.delete(k); });
});
afterEach(async () => { await __testing.flush(); vi.useRealTimers(); });

// Execute the actual provider's synchronous logout prelude with committed
// identity refs, real owner fencing and real history storage logic. Native auth
// cleanup starts after this block and is irrelevant to choosing the owner key.
const authSource = readFileSync(resolve(process.cwd(), 'src/auth/AuthContext.tsx'), 'utf8');
const logoutStart = authSource.indexOf('const clearLocalSession = useCallback');
const historyStart = authSource.indexOf('const invitationHistoryOwner =', logoutStart);
const historyEnd = authSource.indexOf('setAccountGeneration(', historyStart);
if (logoutStart < 0 || historyStart < 0 || historyEnd < historyStart) throw new Error('Logout history prelude not found');
const logoutHistory = new Function(
  'getMobileAuthOwner', 'setMobileAuthOwner', 'clearClipboardInvitationHistory',
  'accountVaultKey', 'userRef', 'activeAuthRealmRef',
  authSource.slice(historyStart, historyEnd) + '\nreturn clearInvitationHistory;',
);

it.each([
  { realm: 'global', phase: 'active' },
  { realm: 'global', phase: 'switching' },
  { realm: 'cn', phase: 'switching' },
  { realm: 'cn', phase: 'rollback' },
  { realm: 'cn', phase: 'switched' },
  { realm: 'global', phase: 'no-user' },
] as const)('terminal logout clears only the committed history ($realm / $phase)', async ({ realm, phase }) => {
  const keys = [accountVaultKey('global', 'guest'), accountVaultKey('cn', 'guest'), accountVaultKey('global', 'other')];
  for (const ownerKey of keys) await rememberClipboardInvitation(ownerKey, digest);
  const userRef: { current: { id: string } | null } = { current: { id: 'guest' } };
  const realmRef: { current: AuthRegion } = { current: realm };
  setMobileAuthOwner('guest', realm);
  if (phase !== 'active') invalidateMobileAuthOwnerForSwitch();
  if (phase === 'rollback') setMobileAuthOwner('guest', realm);
  if (phase === 'switched') {
    userRef.current = { id: 'other' }; realmRef.current = 'global';
    setMobileAuthOwner('other', 'global');
  }
  if (phase === 'no-user') userRef.current = null;
  try {
    // Switch invalidation, successful activation and rollback themselves retain
    // all histories. Only terminal logout starts account-scoped removal.
    for (const ownerKey of keys) expect(await hasSeenClipboardInvitation(ownerKey, digest)).toBe(true);
    const expectedClearedKey = userRef.current ? accountVaultKey(realmRef.current, userRef.current.id) : '';
    const clearing = logoutHistory(getMobileAuthOwner, setMobileAuthOwner, clearClipboardInvitationHistory, accountVaultKey, userRef, realmRef);
    expect(getMobileAuthOwner().accountKey).toBe('');
    expect(getMobileAuthOwner().switching).toBeUndefined();
    await clearing;
    __testing.reset(); // Cold start must not restore the terminated account.
    for (const ownerKey of keys) {
      expect(await hasSeenClipboardInvitation(ownerKey, digest)).toBe(ownerKey !== expectedClearedKey);
      expect(storage.values.has(__testing.storageKey(ownerKey))).toBe(ownerKey !== expectedClearedKey);
    }
  } finally { setMobileAuthOwner(null); }
});

it('stores only SHA-256 digests and timestamps and reloads them after losing all memory', async () => {
  await rememberClipboardInvitation(account, digest);
  const raw = storage.values.get(key)!;
  expect(raw).not.toContain(token);
  expect(JSON.parse(raw)).toEqual({ version: 1, entries: [{ digest, seenAt: Date.now() }] });
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  __testing.reset();
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
  expect(await hasSeenClipboardInvitation('["cn","guest"]', digest)).toBe(false);
});

it('expires records at 30 days without extending TTL on reads', async () => {
  await rememberClipboardInvitation(account, digest);
  vi.setSystemTime(Date.now() + 29 * day);
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
  vi.setSystemTime(Date.now() + day);
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
  expect(storage.values.has(key)).toBe(false);
  __testing.reset();
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
  await rememberClipboardInvitation(account, invitationDigest('new'));
  expect(JSON.parse(storage.values.get(key)!).entries).toHaveLength(1);
});

it('keeps only the most recent 16 distinct invitations in memory and on disk', async () => {
  for (let i = 0; i < 17; i++) {
    vi.setSystemTime(Date.now() + 1);
    await rememberClipboardInvitation(account, invitationDigest(String(i)));
  }
  expect(await hasSeenClipboardInvitation(account, invitationDigest('0'))).toBe(false);
  expect(JSON.parse(storage.values.get(key)!).entries).toHaveLength(16);
  __testing.reset();
  expect(await hasSeenClipboardInvitation(account, invitationDigest('0'))).toBe(false);
  expect(await hasSeenClipboardInvitation(account, invitationDigest('16'))).toBe(true);
});

it('merges concurrent discoveries with a delayed disk read and serializes writes', async () => {
  const saved = invitationDigest('saved');
  let finish!: (raw: string) => void;
  storage.getItem.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let releaseWrite!: () => void;
  storage.setItem.mockImplementationOnce(async (k: string, value: string) => {
    await new Promise<void>(resolve => { releaseWrite = resolve; });
    storage.values.set(k, value);
  });
  const first = rememberClipboardInvitation(account, digest);
  await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledTimes(1));
  const secondDigest = invitationDigest('second');
  const second = rememberClipboardInvitation(account, secondDigest);
  finish(JSON.stringify({ version: 1, entries: [{ digest: saved, seenAt: Date.now() - 1 }] }));
  await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(1));
  const thirdDigest = invitationDigest('third');
  const third = rememberClipboardInvitation(account, thirdDigest);
  await Promise.resolve();
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  releaseWrite(); await Promise.all([first, second, third]);
  __testing.reset();
  for (const item of [saved, digest, secondDigest, thirdDigest]) {
    expect(await hasSeenClipboardInvitation(account, item)).toBe(true);
  }
});

it('does not overwrite unread disk data and merges it after a read retry', async () => {
  const saved = invitationDigest('saved');
  const original = JSON.stringify({ version: 1, entries: [{ digest: saved, seenAt: Date.now() - 1 }] });
  storage.values.set(key, original);
  storage.getItem.mockRejectedValueOnce(new Error('unavailable'));
  await rememberClipboardInvitation(account, digest);
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(storage.values.get(key)).toBe(original);
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
  await rememberClipboardInvitation(account, invitationDigest('new'));
  __testing.reset();
  expect(await hasSeenClipboardInvitation(account, saved)).toBe(true);
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
});

it('keeps failed writes in memory and allows later writes to recover', async () => {
  storage.setItem.mockRejectedValueOnce(new Error('unavailable'));
  await rememberClipboardInvitation(account, digest);
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
  await rememberClipboardInvitation(account, invitationDigest('new'));
  __testing.reset();
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
});

it.each(['broken json', 'null', '{"version":1,"entries":[null,{}, {"digest":"plaintext","seenAt":0}]}'])(
  'ignores corrupt records: %s', async raw => {
    storage.values.set(key, raw);
    expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
    await rememberClipboardInvitation(account, digest);
    expect(JSON.parse(storage.values.get(key)!).entries).toEqual([{ digest, seenAt: Date.now() }]);
  },
);

it('never stores an invitation before an account is known', async () => {
  await rememberClipboardInvitation('', digest);
  expect(await hasSeenClipboardInvitation('', digest)).toBe(false);
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(storage.setItem).not.toHaveBeenCalled();
});

it('persists pruning on a cold read and retains only unexpired records without a new invitation', async () => {
  const fresh = invitationDigest('fresh');
  storage.values.set(key, JSON.stringify({ version: 1, entries: [
    { digest, seenAt: Date.now() - 31 * day }, { digest: fresh, seenAt: Date.now() - day },
  ] }));
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
  expect(JSON.parse(storage.values.get(key)!).entries).toEqual([{ digest: fresh, seenAt: Date.now() - day }]);
  await hasSeenClipboardInvitation(account, fresh);
  expect(storage.setItem).toHaveBeenCalledTimes(1);
});

it('retries failed expiry cleanup without treating expired records as seen', async () => {
  await rememberClipboardInvitation(account, digest);
  vi.setSystemTime(Date.now() + 30 * day);
  storage.removeItem.mockRejectedValueOnce(new Error('unavailable'));
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
  expect(storage.values.has(key)).toBe(true);
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
  expect(storage.values.has(key)).toBe(false);
});

it('does not overwrite a fresh invitation when TTL cleanup is queued behind an older write', async () => {
  await rememberClipboardInvitation(account, digest);
  let finish!: () => void;
  storage.setItem.mockImplementationOnce(async (k: string, value: string) => {
    await new Promise<void>(resolve => { finish = resolve; }); storage.values.set(k, value);
  });
  const oldWrite = rememberClipboardInvitation(account, invitationDigest('old'));
  await vi.waitFor(() => expect(finish).toBeDefined());
  vi.setSystemTime(Date.now() + 31 * day);
  const cleanup = hasSeenClipboardInvitation(account, digest);
  const fresh = invitationDigest('fresh');
  const newWrite = rememberClipboardInvitation(account, fresh);
  finish(); await Promise.all([oldWrite, cleanup, newWrite]);
  expect(JSON.parse(storage.values.get(key)!).entries).toEqual([{ digest: fresh, seenAt: Date.now() }]);
});

it.each(['read', 'write'] as const)('clears both memory and disk after an in-flight %s without touching another account', async operation => {
  await rememberClipboardInvitation('other-account', digest);
  let finish!: () => void;
  if (operation === 'read') {
    storage.getItem.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return JSON.stringify({ version: 1, entries: [{ digest, seenAt: Date.now() }] });
    });
  } else {
    storage.setItem.mockImplementationOnce(async (k: string, value: string) => {
      await new Promise<void>(resolve => { finish = resolve; }); storage.values.set(k, value);
    });
  }
  const writing = rememberClipboardInvitation(account, digest);
  await vi.waitFor(() => expect(finish).toBeDefined());
  const clearing = clearClipboardInvitationHistory(account);
  expect(clearClipboardInvitationHistory(account)).toBe(clearing);
  await rememberClipboardInvitation(account, invitationDigest('late'));
  finish(); await Promise.all([writing, clearing]);
  expect(storage.values.has(key)).toBe(false);
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
  expect(await hasSeenClipboardInvitation('other-account', digest)).toBe(true);
  // A later login can record fresh offers again.
  await rememberClipboardInvitation(account, digest);
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
});

it('clears an account that was never loaded and permits a failed removal to be retried', async () => {
  storage.values.set(key, JSON.stringify({ version: 1, entries: [{ digest, seenAt: Date.now() }] }));
  storage.removeItem.mockRejectedValueOnce(new Error('unavailable'));
  await expect(clearClipboardInvitationHistory(account)).rejects.toThrow('unavailable');
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
  expect(storage.values.has(key)).toBe(false);
  await rememberClipboardInvitation(account, digest);
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
});

it('does not reload erased digests after removal fails and all process memory is lost', async () => {
  await rememberClipboardInvitation(account, digest);
  storage.removeItem.mockRejectedValueOnce(new Error('remove unavailable'));
  await expect(clearClipboardInvitationHistory(account)).rejects.toThrow('remove unavailable');
  expect(JSON.parse(storage.values.get(key)!)).toEqual({ version: 1, entries: [] });
  __testing.reset(); // Cold start: retain disk only, losing the retired flag and queues.
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
  expect(storage.values.has(key)).toBe(false);
  expect(storage.removeItem).toHaveBeenCalledTimes(2);
});

it('preserves durable erasure across repeated failed removal attempts and restarts', async () => {
  await rememberClipboardInvitation(account, digest);
  storage.removeItem.mockRejectedValue(new Error('remove unavailable'));
  await expect(clearClipboardInvitationHistory(account)).rejects.toThrow('remove unavailable');
  for (let i = 0; i < 2; i++) {
    __testing.reset();
    expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
    expect(JSON.parse(storage.values.get(key)!)).toEqual({ version: 1, entries: [] });
  }
  storage.removeItem.mockImplementation(async (k: string) => { storage.values.delete(k); });
  __testing.reset();
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
  expect(storage.values.has(key)).toBe(false);
});

it('still deletes the history when writing the empty record fails', async () => {
  await rememberClipboardInvitation(account, digest);
  storage.setItem.mockRejectedValueOnce(new Error('write unavailable'));
  await clearClipboardInvitationHistory(account);
  expect(storage.values.has(key)).toBe(false);
  __testing.reset();
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
});
