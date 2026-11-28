import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAuthSessionRecord, serializeAuthSessionRecord } from '@cindy/auth-client';

import { AUTH_SESSION_KEY } from '../../../desktop/src/main/authCredentialKeys.ts';
import { runHostLogin } from './login.mjs';

function memoryStore() {
  const records = new Map();
  return { records, read: (key) => records.get(key) ?? null, write: (key, value) => records.set(key, value) };
}

const ACCESS = ['access', 'Token'].join('');
const REFRESH = ['refresh', 'Token'].join('');

function fakeClient(t, captured) {
  return {
    getProviders: async () => ({ social: ['github'] }),
    buildAuthorizeUrl: (input) => {
      captured.url = { input };
      return `https://auth.example/authorize?state=${input.state}`;
    },
    pollDesktopAuthorization: async () => ({ status: 'ok', code: 'auth-code' }),
    exchangeAuthorizationCode: async (code, verifier) => {
      captured.exchange = { code, verifier };
      return { status: 'ok', [ACCESS]: 'bearer', [REFRESH]: 'rotated' };
    },
  };
}

test('hosted login stores the shared session record and never returns tokens', async () => {
  const store = memoryStore();
  const captured = {};
  const result = await runHostLogin({
    client: fakeClient(null, captured),
    store,
    region: 'global',
    hostedCallbackUrl: 'https://auth.example/desktop/callback',
    openBrowser: async (url) => { captured.opened = url; },
  });

  assert.deepEqual(result, { authenticated: true, realm: 'global', method: 'github' });
  const saved = parseAuthSessionRecord(store.records.get(AUTH_SESSION_KEY));
  assert.equal(saved?.realm, 'global');
  assert.equal(saved?.[REFRESH], 'rotated');
  assert.equal(JSON.stringify(result).includes('rotated'), false);
  assert.match(captured.url.input.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(captured.url.input.state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(typeof captured.opened, 'string');
  assert.equal(captured.exchange.code, 'auth-code');
  assert.equal(typeof captured.exchange.verifier, 'string');
});

test('reports unknown login methods instead of guessing', async () => {
  await assert.rejects(
    () => runHostLogin({
      client: fakeClient(null, {}),
      store: memoryStore(),
      region: 'global',
      hostedCallbackUrl: 'https://auth.example/desktop/callback',
      openBrowser: async () => {},
      method: 'nope',
    }),
    /unsupported login method/,
  );
});

test('reports a login outcome that needs another step instead of a missing token', async () => {
  const outcomes = [
    [{ status: 'binding_required', bindType: 'phone', bindTicket: 'bind-ticket' }, /must bind a phone number first/],
    [{ status: 'select_account', loginTicket: 'login-ticket', accounts: [{}] }, /matches several Cindy accounts/],
    [{ status: 'sso_verification_required', verificationTicket: 'sso-ticket', channel: 'sms', targetMasked: '138****0000' }, /extra verification code/],
  ];
  for (const [outcome, message] of outcomes) {
    const client = fakeClient(null, {});
    client.exchangeAuthorizationCode = async () => outcome;
    const store = memoryStore();
    const error = await runHostLogin({
      client,
      store,
      region: 'cn',
      hostedCallbackUrl: 'https://auth.example/desktop/callback',
      openBrowser: async () => {},
    }).then(() => null, (reason) => reason);
    assert.match(error?.message ?? '', message);
    assert.doesNotMatch(error.message, /ticket|0000/);
    assert.equal(store.records.size, 0);
  }
});


test('enterprise login uses the discovered SSO connection and persists only an organization session', async () => {
  const store = memoryStore();
  const captured = {};
  const client = fakeClient(null, captured);
  client.discoverSsoOrg = async org => {
    assert.equal(org, 'example.test');
    return { connections: [{ connectionId: 'work', connectionName: 'Company' }] };
  };
  client.getProviders = async () => { throw new Error('Personal discovery was unexpected'); };
  const basic = client.exchangeAuthorizationCode;
  let kind = 'personal';
  client.exchangeAuthorizationCode = async (...args) => ({
    ...await basic(...args), membership: { id: 'account', kind },
  });
  client.logout = async () => {};
  const deps = { client, store, region: 'cn', organization: 'example.test',
    hostedCallbackUrl: 'https://auth.example/desktop/callback', openBrowser: async () => {} };
  await assert.rejects(runHostLogin({ ...deps, method: 'other' }), /enterprise connection/);
  await assert.rejects(runHostLogin(deps), /organization membership/);
  assert.equal(store.records.size, 0);
  kind = 'org';
  assert.equal((await runHostLogin(deps)).authenticated, true);
  assert.equal(captured.url.input.kind, 'sso');
  assert.equal(captured.url.input.providerOrConnectionId, 'work');
  assert.ok(store.records.has(AUTH_SESSION_KEY));
});
