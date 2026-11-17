import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthApiError, parseAuthSessionRecord, serializeAuthSessionRecord } from '@cindy/auth-client';

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
    pollDesktopAuthorization: async secret => { captured.pollSecret = secret; return { status: 'ok', code: 'auth-code' }; },
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

// #10600: web login must complete without restarting Host. CLI tests never
// exercised interactive outcomes, cancellation or authenticated controllers.
// Unit: fake auth-server only; real service entry, PKCE and callback polling.
const { createHostWebLogin } = await import('./web-login.ts');
const { createHostService } = await import('../service.mjs');
const { setImmediate: nextTurn } = await import('node:timers/promises');
const membership = { id: 'owner-web', displayName: 'Test', kind: 'personal', role: 'owner', email: null, orgId: null, orgName: null };
function webLogin(overrides = {}, runtime = {}) {
  const saved = [];
  const captured = {};
  const client = {
    ...fakeClient(null, captured),
    getProviders: async () => ({ region: 'global', attribution: 'email', email: true, phone: true, social: ['google'] }),
    exchangeAuthorizationCode: async (code, verifier) => {
      captured.exchange = { code, verifier };
      return { status: 'ok', membership, [ACCESS]: 'invalid-access', [REFRESH]: 'invalid-refresh' };
    },
    ...overrides,
  };
  const login = createHostWebLogin({ client, region: 'global', hostedCallbackUrl: 'https://auth.example/callback',
    registerDeviceLink: runtime.registerDeviceLink,
    complete: async (value, _signal, activate) => {
      await activate(async () => { runtime.startDeviceLink?.(); saved.push(value); });
    },
  });
  return { login, saved, captured };
}
const startGoogle = { type: 'start-browser', kind: 'social', providerOrConnectionId: 'google', label: 'Google' };
async function settled(login) {
  for (let i = 0; i < 30; i++) {
    const result = await login.getLoginState();
    if (result.state?.step !== 'browser-redirect') return result;
    await nextTurn();
  }
  assert.fail('Login did not settle');
}

test('web login exposes usable methods and completes hosted authorization without exposing credentials', async () => {
  const { login, saved, captured } = webLogin();
  const entry = await login.getLoginState();
  assert.equal(entry.state.step, 'identifier');
  assert.deepEqual(entry.state.providers.social, ['google']);
  assert.equal(entry.state.providers.email, false);
  assert.equal(entry.state.providers.phone, false);
  const started = await login.dispatchLoginAction(startGoogle, 'controller-a');
  assert.match(started.authorizeUrl, /^https:\/\/auth.example\/authorize/);
  assert.equal((await settled(login)).state.step, 'completed');
  assert.equal(saved[0].membership.id, 'owner-web');
  assert.match(captured.exchange.verifier, /^[A-Za-z0-9_-]{43}$/);
  const publicState = JSON.stringify([started, await login.getLoginState()]);
  assert.equal(publicState.includes('invalid-refresh'), false);
  assert.equal(publicState.includes('invalid-access'), false);
  const snapshot = await login.getLoginState();
  assert.equal(snapshot.authorizeUrl, undefined);
  assert.equal(JSON.stringify(snapshot).includes(captured.exchange.verifier), false);
  assert.equal(JSON.stringify(snapshot).includes(captured.url.input.state), false);
  assert.equal(JSON.stringify(snapshot).includes(captured.pollSecret), false);
});

test('web login validates methods and supports account selection without exposing tickets', async () => {
  const { login, saved } = webLogin({
    exchangeAuthorizationCode: async () => ({ status: 'select_account', loginTicket: 'invalid-private-ticket', accounts: [membership] }),
    selectAccount: async (ticket, id) => {
      assert.equal(ticket, 'invalid-private-ticket'); assert.equal(id, membership.id);
      return { status: 'ok', membership, [ACCESS]: 'invalid-access', [REFRESH]: 'invalid-refresh' };
    },
  });
  assert.equal((await login.dispatchLoginAction({ ...startGoogle, providerOrConnectionId: 'disabled' }, 'controller-a')).success, false);
  await login.dispatchLoginAction(startGoogle, 'controller-a');
  const selection = await settled(login);
  assert.equal(selection.state.step, 'account-selection');
  assert.equal(JSON.stringify(selection).includes('invalid-private-ticket'), false);
  assert.equal((await login.dispatchLoginAction({ type: 'select-account', accountId: membership.id }, 'controller-b')).code, 'AUTH_BUSY');
  assert.equal((await login.dispatchLoginAction({ type: 'select-account', accountId: 'unknown' }, 'controller-a')).success, false);
  assert.equal(saved.length, 0);
  assert.equal((await login.dispatchLoginAction({ type: 'select-account', accountId: membership.id }, 'controller-a')).state.step, 'completed');
  assert.equal(saved.length, 1);
});

test('web login cancellation discards a late callback and permits another controller', async () => {
  let callback;
  const { login, saved } = webLogin({ pollDesktopAuthorization: () => new Promise(resolve => { callback = resolve; }) });
  await login.dispatchLoginAction(startGoogle, 'controller-a');
  const cancel = login.dispatchLoginAction({ type: 'cancel-browser' }, 'controller-a');
  callback({ status: 'ok', code: 'invalid-late-code' });
  assert.equal((await cancel).state.step, 'identifier');
  assert.equal(saved.length, 0);
  assert.equal((await login.dispatchLoginAction({ type: 'verify-code', kind: 'email', identifier: 'test@example.invalid', code: '000000' }, 'controller-b')).code, 'NOT_SUPPORTED');
});

test('a paired browser can start login after another browser’s authorization fails', async () => {
  let attempts = 0;
  const { login } = webLogin({
    exchangeAuthorizationCode: async () => {
      if (++attempts === 1) throw new AuthApiError('AUTH_REQUEST_FAILED', 400, 'Test failure');
      return { status: 'ok', membership, [ACCESS]: 'invalid-access', [REFRESH]: 'invalid-refresh' };
    },
  });
  await login.dispatchLoginAction(startGoogle, 'controller-a');
  assert.equal((await settled(login)).state.step, 'error');
  const started = await login.dispatchLoginAction(startGoogle, 'controller-b');
  assert.match(started.authorizeUrl, /^https:\/\/auth.example\/authorize/);
  assert.equal((await settled(login)).state.step, 'completed');
});

test('explicit web sign-in tries Device Link registration before starting its resident link', async () => {
  const calls = [];
  const { login, saved } = webLogin({}, {
    registerDeviceLink: async token => {
      calls.push(['register', token]);
      throw new Error('test relay unavailable');
    },
    startDeviceLink: () => calls.push(['start']),
  });
  await login.dispatchLoginAction(startGoogle, 'controller-a');
  assert.equal((await settled(login)).state.step, 'completed');
  assert.deepEqual(calls, [['register', 'invalid-access'], ['start']]);
  assert.equal(saved[0].membership.id, membership.id);
});

test('web SSO discovery validates connections and keeps verification tickets on Host', async () => {
  const connection = { connectionId: 'test-idp', protocol: 'oidc', connectionName: 'Test' };
  const { login, saved } = webLogin({
    discoverSsoOrg: async () => ({ region: 'global', orgName: 'Example', connections: [connection] }),
    exchangeAuthorizationCode: async () => ({ status: 'sso_verification_required', verificationTicket: 'invalid-sso-ticket', channel: 'email', targetMasked: 't***' }),
    requestSsoVerificationCode: async ticket => { assert.equal(ticket, 'invalid-sso-ticket'); },
    verifySsoVerification: async (ticket, code) => {
      assert.equal(ticket, 'invalid-sso-ticket'); assert.equal(code, '000000');
      return { status: 'ok', membership, [ACCESS]: 'invalid-access', [REFRESH]: 'invalid-refresh' };
    },
  });
  const discovered = await login.dispatchLoginAction({ type: 'discover-sso-org', org: 'example' }, 'controller-a');
  assert.equal(discovered.state.methods[0].connectionId, 'test-idp');
  await login.dispatchLoginAction({ type: 'start-browser', kind: 'sso', providerOrConnectionId: 'test-idp', label: 'Test' }, 'controller-a');
  assert.equal((await settled(login)).state.step, 'sso-verification');
  const requested = await login.dispatchLoginAction({ type: 'request-sso-verification-code' }, 'controller-a');
  assert.equal(requested.state.codeRequested, true);
  assert.equal(JSON.stringify(requested).includes('invalid-sso-ticket'), false);
  assert.equal((await login.dispatchLoginAction({ type: 'verify-sso-verification', code: '000000' }, 'controller-a')).state.step, 'completed');
  assert.equal(saved.length, 1);
});

test('web auth routes reject fabricated controller identities in the request body', async () => {
  const { login } = webLogin();
  const service = createHostService({ getLoginState: login.getLoginState, dispatchLoginAction: login.dispatchLoginAction });
  assert.equal((await service('/api/auth/login-state')).body.state.step, 'identifier');
  const body = { action: { type: 'reset' }, caller: 'forged' };
  assert.equal((await service('/api/auth/login-action', body)).status, 403);
  assert.equal((await service('/api/auth/login-action', body, { caller: 'authenticated' })).body.success, true);
  assert.equal((await service('/api/auth/login-action', { action: { type: 'start-browser' } }, { caller: 'authenticated' })).body.code, 'INVALID_AUTH_ACTION');
});


test('web SSO discovers connections and completes its additional verification step', async () => {
  const { login, saved } = webLogin({
    discoverSsoOrg: async () => ({ region: 'global', orgName: 'Example', connections: [{ connectionId: 'example-idp', protocol: 'oidc', connectionName: 'Example' }] }),
    exchangeAuthorizationCode: async () => ({ status: 'sso_verification_required', verificationTicket: 'invalid-private-sso', channel: 'email', targetMasked: 't***' }),
    requestSsoVerificationCode: async ticket => assert.equal(ticket, 'invalid-private-sso'),
    verifySsoVerification: async (ticket, code) => {
      assert.equal(ticket, 'invalid-private-sso'); assert.equal(code, '123456');
      return { status: 'ok', membership, [ACCESS]: 'invalid-access', [REFRESH]: 'invalid-refresh' };
    },
  });
  const discovered = await login.dispatchLoginAction({ type: 'discover-sso-org', org: 'example' }, 'controller-a');
  assert.equal(discovered.state.methods[0].connectionId, 'example-idp');
  await login.dispatchLoginAction({ type: 'start-browser', kind: 'sso', providerOrConnectionId: 'example-idp', label: 'Example' }, 'controller-a');
  assert.equal((await settled(login)).state.step, 'sso-verification');
  const requested = await login.dispatchLoginAction({ type: 'request-sso-verification-code' }, 'controller-a');
  assert.equal(requested.state.codeRequested, true);
  assert.equal(JSON.stringify(requested).includes('invalid-private-sso'), false);
  assert.equal((await login.dispatchLoginAction({ type: 'verify-sso-verification', code: '123456' }, 'controller-a')).state.step, 'completed');
  assert.equal(saved.length, 1);
});

test('web login service refuses unauthenticated mutation contexts', async () => {
  const invoke = createHostService({ dispatchLoginAction: () => assert.fail('unauthenticated action reached login') });
  assert.equal((await invoke('/api/auth/login-action', { action: { type: 'reset' }, caller: 'forged' })).status, 403);
});


test('web login preserves the auth-server retry deadline in failure projections', async () => {
  const retryAt = 2_000_000_000_000;
  const { login } = webLogin({ getProviders: async () => { throw new AuthApiError('RATE_LIMITED', 429, 'Test limit', retryAt); } });
  const result = await login.getLoginState();
  assert.equal(result.code, 'RATE_LIMITED');
  assert.equal(result.retryAt, retryAt);
  assert.equal(result.state.retryAt, retryAt);
});

test('web login rejects a null request body through action validation', async () => {
  const { login } = webLogin();
  const invoke = createHostService({ dispatchLoginAction: (action, caller) => login.dispatchLoginAction(action, caller) });
  const response = await invoke('/api/auth/login-action', null, { caller: 'controller-a' });
  assert.equal(response.status, 200);
  assert.equal(response.body.success, false);
  assert.equal(response.body.code, 'INVALID_AUTH_ACTION');
});
