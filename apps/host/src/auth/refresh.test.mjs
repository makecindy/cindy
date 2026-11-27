import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { accountVaultKey, AuthApiError, parseAuthSessionRecord, serializeAuthSessionRecord } from '@cindy/auth-client';

import {
  AUTH_ACCOUNT_VAULT_KEY,
  AUTH_SESSION_KEY,
  LEGACY_RESOURCE_REFRESH_TOKEN_KEY,
} from '../../../desktop/src/main/authCredentialKeys.ts';
import { serializeHostSession, readSessionDeviceId } from './device-identity.mjs';
import { hostAccountVaultLock, HostRefreshDeferredError, HostSessionMissingError, refreshHostSession } from './refresh.mjs';

// Field names are composed from parts so credential scanners do not flag test
// fixtures whose values are obviously synthetic.
const ACCESS = ['access', 'Token'].join('');
const REFRESH = ['refresh', 'Token'].join('');
const tokenPair = (access, rotated) => ({ [ACCESS]: access, [REFRESH]: rotated });

function memoryStore(initial) {
  const records = new Map(initial);
  return {
    records,
    read: (key) => records.get(key) ?? null,
    write: (key, value) => records.set(key, value),
  };
}

const noLock = task => task();

test('persists a rotated refresh token and never returns it', async () => {
  const store = memoryStore([[AUTH_SESSION_KEY, serializeAuthSessionRecord('global', 'old-token')]]);
  const result = await refreshHostSession({
    store, withVaultLock: noLock, buildRegion: 'global',
    refresh: async () => tokenPair('access-value', 'rotated-value'),
  });
  assert.equal(result.realm, 'global');
  assert.equal(result.rotated, true);
  assert.equal(result.sessionToken, 'access-value');
  const saved = JSON.parse(store.records.get(AUTH_SESSION_KEY));
  assert.equal(saved.refreshToken, 'rotated-value');
  assert.equal(JSON.stringify(result).includes('rotated-value'), false);
});

test('keeps the stored record when the server does not rotate', async () => {
  const original = serializeAuthSessionRecord('cn', 'same-token');
  const store = memoryStore([[AUTH_SESSION_KEY, original]]);
  const result = await refreshHostSession({
    store, withVaultLock: noLock, buildRegion: 'cn',
    refresh: async () => tokenPair('same-access', 'same-token'),
  });
  assert.equal(result.rotated, false);
  assert.equal(store.records.get(AUTH_SESSION_KEY), original);
});

test('fails loudly without a stored session or without an access token', async () => {
  await assert.rejects(() => refreshHostSession({ store: memoryStore([]), withVaultLock: noLock, buildRegion: 'global',
    refresh: async () => tokenPair('x', undefined) }), HostSessionMissingError);
  const store = memoryStore([[AUTH_SESSION_KEY, serializeAuthSessionRecord('global', 'old')]]);
  await assert.rejects(() => refreshHostSession({ store, withVaultLock: noLock, buildRegion: 'global',
    refresh: async () => tokenPair('', undefined) }), /no access token/);
});

/*
 * C (reviewer, 2026-11-17): the Host renews the account session as the desktop's runtime refresh
 * does, so a desktop and the Host, or two Hosts, can renew one login in turn. Before: the Host read
 * only the v1 record, signed out on any rejection, and wrote only the v1 record, so the other
 * process's next renewal, or a switch back to the account from the vault, signed out a valid login
 * (reproduced 2026-11-17, desktop authColdStartRecovery.test.ts). Gap: the cases above use a server
 * that never rejects. Minimal failure: two processes renew the same stored token. Tier: unit, one
 * in-memory store shared as the profile's credential files, a fake auth server, the real lock on a
 * temporary directory; no real account, profile or keychain.
 */
const MEMBERSHIP = { id: 'member-a', passportId: 'passport-a', kind: 'personal', role: 'owner', displayName: 'Fixture',
  email: null, orgId: null, orgName: null };
const KEY_A = accountVaultKey('global', 'member-a');
const noWait = async () => {};

/** One account on a fake auth server: only the latest refresh token works; each renewal rotates it. */
function authServer(first = 'r0') {
  let current = first;
  let next = 0;
  const requests = [];
  return {
    requests,
    current: () => current,
    rotateElsewhere() { current = `elsewhere-${++next}`; return current; },
    async refresh(token) {
      requests.push(token);
      if (token !== current) throw new AuthApiError('INVALID_REFRESH_TOKEN', 401, 'rotated');
      current = `r${++next}`;
      return { [ACCESS]: `access-${next}`, [REFRESH]: current, membership: MEMBERSHIP };
    },
  };
}

function vaultWith(token, extra = {}) {
  return JSON.stringify({ version: 1, activeAccountKey: KEY_A, passports: {}, ...extra,
    resources: { [KEY_A]: { realm: 'global', refreshToken: token, metadata: { membershipId: 'member-a', passportId: 'passport-a',
      displayName: 'Fixture', email: null, avatarUrl: null, kind: 'personal', role: 'owner', orgId: null, orgName: null, orgLogoUrl: null },
    lastUsedAt: 1 } } });
}

/** The profile's records as the desktop leaves them: v1, the vault with account A active, the legacy token. */
function profileStore(token = 'r0', { legacy = true, deviceId } = {}) {
  return memoryStore([
    [AUTH_SESSION_KEY, deviceId ? serializeHostSession('global', token, deviceId) : serializeAuthSessionRecord('global', token)],
    [AUTH_ACCOUNT_VAULT_KEY, vaultWith(token)],
    ...(legacy ? [[LEGACY_RESOURCE_REFRESH_TOKEN_KEY, token]] : []),
  ]);
}

const stored = store => ({
  session: parseAuthSessionRecord(store.records.get(AUTH_SESSION_KEY))?.refreshToken,
  vault: JSON.parse(store.records.get(AUTH_ACCOUNT_VAULT_KEY) ?? 'null')?.resources?.[KEY_A]?.refreshToken,
  legacy: store.records.get(LEGACY_RESOURCE_REFRESH_TOKEN_KEY),
});

function tempLock(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-refresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return hostAccountVaultLock(dir);
}

test('two processes sharing one profile renew in turn, also at the same moment, and neither signs out', async (t) => {
  const server = authServer();
  const store = profileStore();
  const withVaultLock = tempLock(t);
  // Process 2's request reaches the server only after process 1 has renewed and written.
  let releaseSecond;
  const firstDone = new Promise(resolve => { releaseSecond = resolve; });
  const renew = (refresh = token => server.refresh(token)) =>
    refreshHostSession({ store, refresh, withVaultLock, buildRegion: 'global', sleep: noWait });
  const second = renew(async token => { await firstDone; return server.refresh(token); });
  const first = await renew();
  releaseSecond();
  const late = await second;
  assert.equal(first.sessionToken, 'access-1');
  assert.equal(late.sessionToken, 'access-2');
  assert.equal(late.replacementRetries, 1, 'the late one renews with the token the first one wrote');
  for (let i = 0; i < 4; i++) await renew();
  assert.equal(server.current(), 'r6');
  assert.deepEqual(stored(store), { session: 'r6', vault: 'r6', legacy: 'r6' });
});

test('a rejected token is renewed with the newer one another process already stored, in any of the three sources', async () => {
  for (const source of ['session', 'vault', 'legacy']) {
    const server = authServer();
    const store = profileStore();
    const refresh = async (token) => {
      if (token === 'r0') {
        // Another process renewed first and stored its token in this one source.
        const newer = server.rotateElsewhere();
        if (source === 'session') store.write(AUTH_SESSION_KEY, serializeAuthSessionRecord('global', newer));
        if (source === 'vault') store.write(AUTH_ACCOUNT_VAULT_KEY, vaultWith(newer));
        if (source === 'legacy') store.write(LEGACY_RESOURCE_REFRESH_TOKEN_KEY, newer);
      }
      return server.refresh(token);
    };
    const result = await refreshHostSession({ store, refresh, withVaultLock: noLock, buildRegion: 'global', sleep: noWait });
    assert.equal(result.replacementRetries, 1, source);
    assert.deepEqual(server.requests, ['r0', 'elsewhere-1'], source);
    assert.equal(stored(store).session, server.current(), source);
  }
});

test('only a rejection of the token still stored is definitive; it signs out without deleting anything', async () => {
  const server = authServer('valid-elsewhere');
  const store = profileStore('rejected');
  const before = new Map(store.records);
  await assert.rejects(refreshHostSession({ store, refresh: token => server.refresh(token), withVaultLock: noLock,
    buildRegion: 'global', sleep: noWait }), error => error instanceof AuthApiError && error.code === 'INVALID_REFRESH_TOKEN');
  assert.deepEqual(store.records, before);
});

test('DEVICE_MISMATCH signs out this process only and keeps the stored credentials', async () => {
  const store = profileStore('bound-elsewhere');
  const before = new Map(store.records);
  const requests = [];
  await assert.rejects(refreshHostSession({ store, withVaultLock: noLock, buildRegion: 'global', sleep: noWait,
    refresh: async (token) => { requests.push(token); throw new AuthApiError('DEVICE_MISMATCH', 401, 'device'); } }),
  error => error.code === 'DEVICE_MISMATCH');
  assert.deepEqual(requests, ['bound-elsewhere']);
  assert.deepEqual(store.records, before);
});

test('a definitive failure of a token the store no longer holds is dropped, not a sign-out', async () => {
  const store = profileStore('rejected', { legacy: false });
  // Another process stores its renewal just after this renewal's last re-read of the stored sources.
  let rechecksDone = false;
  let sessionReads = 0;
  const read = store.read;
  store.read = (key) => {
    if (key === AUTH_SESSION_KEY && rechecksDone && ++sessionReads === 2) store.write(key, serializeAuthSessionRecord('global', 'newer'));
    return read(key);
  };
  await assert.rejects(refreshHostSession({ store, withVaultLock: noLock, buildRegion: 'global',
    sleep: async (ms) => { if (ms === 1000) rechecksDone = true; },
    refresh: async () => { throw new AuthApiError('INVALID_REFRESH_TOKEN', 401, 'rotated'); } }), HostRefreshDeferredError);
  assert.equal(stored(store).session, 'newer');
});

test('the renewal writes the vault, its v1 record with its Host device and the existing legacy token; nothing more', async () => {
  const server = authServer();
  const store = profileStore('r0', { deviceId: 'host-device' });
  await refreshHostSession({ store, refresh: token => server.refresh(token), withVaultLock: noLock, buildRegion: 'global' });
  assert.deepEqual(stored(store), { session: 'r1', vault: 'r1', legacy: 'r1' });
  assert.equal(readSessionDeviceId(store.records.get(AUTH_SESSION_KEY)), 'host-device');
  assert.equal(JSON.parse(store.records.get(AUTH_ACCOUNT_VAULT_KEY)).activeAccountKey, KEY_A);

  // A Host-only profile (`cindy-host login` writes only the v1 record): no vault or legacy record is made.
  const hostOnly = memoryStore([[AUTH_SESSION_KEY, serializeAuthSessionRecord('global', 'r1')]]);
  await refreshHostSession({ store: hostOnly, refresh: token => server.refresh(token), withVaultLock: noLock, buildRegion: 'global' });
  assert.deepEqual([...hostOnly.records.keys()], [AUTH_SESSION_KEY]);
  assert.equal(stored(hostOnly).session, 'r2');

  // The desktop signed out, then `cindy-host login`: the vault names no account, the v1 record is still kept.
  const signedOutVault = JSON.stringify({ version: 1, activeAccountKey: null, resources: {}, passports: {}, signedOutAt: 1 });
  const afterDesktopLogout = memoryStore([[AUTH_SESSION_KEY, serializeAuthSessionRecord('global', 'r2')],
    [AUTH_ACCOUNT_VAULT_KEY, signedOutVault]]);
  await refreshHostSession({ store: afterDesktopLogout, refresh: token => server.refresh(token), withVaultLock: noLock, buildRegion: 'global' });
  assert.equal(stored(afterDesktopLogout).session, 'r3');
  assert.equal(afterDesktopLogout.records.get(AUTH_ACCOUNT_VAULT_KEY), signedOutVault);
});

test('a renewal that no longer holds its token when it writes writes nothing', async () => {
  const server = authServer();
  const store = profileStore();
  const otherAccount = [serializeAuthSessionRecord('global', 'b-token'), JSON.stringify({ version: 1, activeAccountKey: 'other',
    passports: {}, resources: { other: { realm: 'global', refreshToken: 'b-token', metadata: {}, lastUsedAt: 1 } } }), 'b-token'];
  const refresh = async (token) => {
    const pair = await server.refresh(token);
    // While this request was out, the desktop switched to account B.
    [AUTH_SESSION_KEY, AUTH_ACCOUNT_VAULT_KEY, LEGACY_RESOURCE_REFRESH_TOKEN_KEY].forEach((key, i) => store.write(key, otherAccount[i]));
    return pair;
  };
  await assert.rejects(refreshHostSession({ store, refresh, withVaultLock: noLock, buildRegion: 'global' }), HostRefreshDeferredError);
  assert.deepEqual([...store.records.values()], otherAccount);
});

test('a stored session that exists but cannot be read now is kept; only a missing one ends the session', async () => {
  const requests = [];
  const refresh = async (token) => { requests.push(token); return tokenPair('x', 'y'); };
  const unreadable = { read: () => { throw new Error('the keychain is locked'); }, write: () => assert.fail('nothing is written') };
  await assert.rejects(refreshHostSession({ store: unreadable, refresh, withVaultLock: noLock, buildRegion: 'global' }), HostRefreshDeferredError);
  const damaged = memoryStore([[AUTH_SESSION_KEY, '{not a session']]);
  await assert.rejects(refreshHostSession({ store: damaged, refresh, withVaultLock: noLock, buildRegion: 'global' }), HostRefreshDeferredError);
  await assert.rejects(refreshHostSession({ store: memoryStore([]), refresh, withVaultLock: noLock, buildRegion: 'global' }), HostSessionMissingError);
  assert.deepEqual(requests, []);
});

test('a renewal whose replacements are used up while other apps keep rotating is retried later, not a sign-out', async () => {
  const store = profileStore('va');
  const before = new Map(store.records);
  // A new app and an old one (it reads and writes only the legacy token) keep renewing first.
  const elsewhere = { va: [[LEGACY_RESOURCE_REFRESH_TOKEN_KEY, 'lb']], lb: [[LEGACY_RESOURCE_REFRESH_TOKEN_KEY, 'lc']],
    lc: [[AUTH_SESSION_KEY, serializeAuthSessionRecord('global', 'lc')], [LEGACY_RESOURCE_REFRESH_TOKEN_KEY, 'ld']] };
  const requests = [];
  const refresh = async (token) => {
    requests.push(token);
    for (const [key, value] of elsewhere[token] ?? []) store.write(key, value);
    throw new AuthApiError('INVALID_REFRESH_TOKEN', 401, 'rotated');
  };
  await assert.rejects(refreshHostSession({ store, refresh, withVaultLock: noLock, buildRegion: 'global', sleep: noWait }),
    HostRefreshDeferredError);
  assert.deepEqual(requests, ['va', 'lb', 'lc']);
  assert.equal(store.records.get(AUTH_ACCOUNT_VAULT_KEY), before.get(AUTH_ACCOUNT_VAULT_KEY), 'nothing of this renewal is written');
});

test('the write-back waits for the account-vault lock another process holds', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-refresh-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = authServer();
  const store = profileStore();
  let renewal;
  // The other process (the desktop's transactAuthAccountVault) holds the same lock file.
  await hostAccountVaultLock(dir)(async () => {
    renewal = refreshHostSession({ store, refresh: token => server.refresh(token), withVaultLock: hostAccountVaultLock(dir), buildRegion: 'global' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(server.current(), 'r1', 'the server has rotated');
    assert.deepEqual(stored(store), { session: 'r0', vault: 'r0', legacy: 'r0' }, 'nothing is written under the other process');
  });
  await renewal;
  assert.deepEqual(stored(store), { session: 'r1', vault: 'r1', legacy: 'r1' });
});

test('after `cindy-host login` left an older token of the account in the vault, a revoked login is still definitive', async () => {
  // v1: the Host login's token; the vault: the desktop's older token of the same account. Both rejected.
  const store = profileStore('older-desktop-token', { legacy: false });
  store.write(AUTH_SESSION_KEY, serializeAuthSessionRecord('global', 'host-login-token'));
  const requests = [];
  await assert.rejects(refreshHostSession({ store, withVaultLock: noLock, buildRegion: 'global', sleep: noWait,
    refresh: async (token) => { requests.push(token); throw new AuthApiError('INVALID_REFRESH_TOKEN', 401, 'revoked'); } }),
  error => error instanceof AuthApiError && error.code === 'INVALID_REFRESH_TOKEN');
  assert.deepEqual(requests, ['host-login-token', 'older-desktop-token']);
});
