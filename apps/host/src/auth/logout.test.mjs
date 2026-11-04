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
