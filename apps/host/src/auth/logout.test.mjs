import assert from 'node:assert/strict';
import test from 'node:test';

import { serializeAuthSessionRecord } from '@cindy/auth-client';

import { AUTH_SESSION_KEY } from '../../../desktop/src/main/authCredentialKeys.ts';
import { logoutHostSession } from './logout.mjs';

const ACCESS = ['access', 'Token'].join('');

function memoryStore(initial) {
  const records = new Map(initial);
  return { records, read: (k) => records.get(k) ?? null, write: (k, v) => records.set(k, v), remove: (k) => records.delete(k) };
}

test('revokes on the server and clears every local record', async () => {
  const store = memoryStore([
    [AUTH_SESSION_KEY, serializeAuthSessionRecord('global', 'stored-refresh')],
    ['refresh_token', 'legacy'],
  ]);
  const calls = [];
  const result = await logoutHostSession({
    store,
    refresh: async () => ({ [ACCESS]: 'bearer' }),
    logout: async (token) => { calls.push(token); },
  });
  assert.deepEqual(result, { signedOut: true, serverRevoked: true });
  assert.deepEqual(calls, ['bearer']);
  assert.equal(store.records.size, 0);
});

test('still clears local records when the server call fails', async () => {
  const store = memoryStore([[AUTH_SESSION_KEY, serializeAuthSessionRecord('cn', 'stored-refresh')]]);
  const result = await logoutHostSession({
    store,
    refresh: async () => { throw new Error('network down'); },
    logout: async () => {},
  });
  assert.equal(result.serverRevoked, false);
  assert.match(result.detail, /network down/);
  assert.equal(store.records.has(AUTH_SESSION_KEY), false);
});

test('logout without a stored session is a no-op that still reports the state', async () => {
  const store = memoryStore([]);
  const result = await logoutHostSession({ store, refresh: async () => ({ [ACCESS]: 'x' }), logout: async () => {} });
  assert.deepEqual(result, { signedOut: true, serverRevoked: false, detail: 'no stored session' });
});

test('logout removes the active saved membership without deleting sibling accounts', async () => {
  const a = JSON.stringify(['global', 'account-a']);
  const b = JSON.stringify(['global', 'account-b']);
  const passport = JSON.stringify(['global', 'passport']);
  const metadata = membershipId => ({ membershipId, passportId: 'passport' });
  const store = memoryStore([
    [AUTH_SESSION_KEY, serializeAuthSessionRecord('global', 'stored-refresh')],
    ['cindy_auth_accounts_v1', JSON.stringify({ version: 1, activeAccountKey: a,
      resources: { [a]: { realm: 'global', metadata: metadata('account-a') }, [b]: { realm: 'global', metadata: metadata('account-b') } },
      passports: { [passport]: { realm: 'global', passportId: 'passport', memberships: [metadata('account-a'), metadata('account-b')] } },
    })],
  ]);
  await logoutHostSession({ store, ownerId: 'account-a', passportId: 'passport', refresh: async () => ({ [ACCESS]: 'bearer' }), logout: async () => {} });
  const vault = JSON.parse(store.read('cindy_auth_accounts_v1'));
  assert.equal(vault.resources[a], undefined);
  assert.ok(vault.resources[b]);
  assert.deepEqual(vault.passports[passport].memberships.map(m => m.membershipId), ['account-b']);
  assert.deepEqual(JSON.parse(store.read('cindy_auth_account_logout_tombstones_v1')).accountKeys, [a]);
  assert.equal(store.read(AUTH_SESSION_KEY), null);
});
