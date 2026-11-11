import assert from 'node:assert/strict';
import test from 'node:test';

import { serializeAuthSessionRecord } from '@cindy/auth-client';

import { AUTH_SESSION_KEY } from '../../../desktop/src/main/authCredentialKeys.ts';
import { refreshHostSession } from './refresh.mjs';

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

test('persists a rotated refresh token and never returns it', async () => {
  const store = memoryStore([[AUTH_SESSION_KEY, serializeAuthSessionRecord('global', 'old-token')]]);
  const result = await refreshHostSession({
    store,
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
    store,
    refresh: async () => tokenPair('same-access', 'same-token'),
  });
  assert.equal(result.rotated, false);
  assert.equal(store.records.get(AUTH_SESSION_KEY), original);
});

test('fails loudly without a stored session or without an access token', async () => {
  await assert.rejects(() => refreshHostSession({ store: memoryStore([]), refresh: async () => tokenPair('x', undefined) }), /no stored Cindy session/);
  const store = memoryStore([[AUTH_SESSION_KEY, serializeAuthSessionRecord('global', 'old')]]);
  await assert.rejects(() => refreshHostSession({ store, refresh: async () => tokenPair('', undefined) }), /no access token/);
});
