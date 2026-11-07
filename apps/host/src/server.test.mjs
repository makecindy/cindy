import assert from 'node:assert/strict';
import test from 'node:test';

import { createHostServer } from './server.mjs';

const TOKEN = 'test-token-value';

async function withServer(t, deps) {
  const server = createHostServer({
    token: TOKEN,
    probe: () => ({ status: 'ok' }),
    me: () => ({ owner: 'owner-1', authenticated: true, realm: 'global' }),
    listSessions: () => [{ id: 's1', title: 'task', agentKind: 'claude-code', model: 'm', workDir: '/w', updatedAt: 1 }],
    logout: () => ({ signedOut: true, serverRevoked: true }),
    listPlugins: () => ({ plugins: [], namespace: 'canonical', legacyNamespacePresent: false }),
    history: (sessionId, limit) => [{ id: 'm1', sessionId, limit }],
    ...deps,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  return async (path, { method = 'GET', headers = {}, body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
}

test('health is public while task data requires the profile bearer', async (t) => {
  const request = await withServer(t);
  assert.equal((await request('/health')).status, 200);

  const denied = await request('/sessions');
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('www-authenticate'), 'Bearer');

  const allowed = await request('/sessions', { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body.sessions.map((s) => s.id), ['s1']);
  assert.equal((await request('/sessions', { headers: { authorization: 'Bearer wrong' } })).status, 401);
});

test('logout requires the bearer and reports server revocation', async (t) => {
  const request = await withServer(t);
  assert.equal((await request('/logout', { method: 'POST' })).status, 401);
  const signedOut = await request('/logout', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.deepEqual(signedOut.body, { signedOut: true, serverRevoked: true });
});

test('history requires the bearer and returns the requested page', async (t) => {
  const request = await withServer(t);
  assert.equal((await request('/sessions/s1/messages')).status, 401);
  const page = await request('/sessions/s1/messages?limit=5', { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.deepEqual(page.body.messages, [{ id: 'm1', sessionId: 's1', limit: 5 }]);
});

test('me reports the bound owner without leaking credentials', async (t) => {
  const request = await withServer(t);
  const me = await request('/me', { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.deepEqual(me.body, { owner: 'owner-1', authenticated: true, realm: 'global' });
  assert.equal(JSON.stringify(me.body).includes('token'), false);
});

test('api auth endpoints report state and allow refreshing without leaking tokens', async (t) => {
  let refreshed = false;
  const request = await withServer(t, {
    getAuthState: () => ({ authenticated: true, owner: 'owner-1', realm: 'global', user: { id: 'u1' } }),
    refreshAuth: () => {
      refreshed = true;
      return { ok: true, authenticated: true, user: { id: 'u1' } };
    },
  });

  const state = await request('/api/auth/state', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(state.status, 200);
  assert.deepEqual(state.body, { authenticated: true, owner: 'owner-1', realm: 'global', user: { id: 'u1' } });

  const refresh = await request('/api/auth/refresh', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(refresh.status, 200);
  assert.deepEqual(refresh.body, { ok: true, authenticated: true, user: { id: 'u1' } });
  assert.equal(refreshed, true);
});

test('unknown routes and internal failures stay JSON', async (t) => {
  const request = await withServer(t, {
    listSessions: () => { throw new Error('storage offline'); },
  });
  assert.equal((await request('/nope')).status, 404);
  const failed = await request('/sessions', { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error, 'internal_error');
});

test('cross-engine switch returns a deferred intent and exposes it for the renderer', async (t) => {
  let intent = null;
  const request = await withServer(t, {
    switchSessionAgent: (sessionId, targetAgentKind, model, providerId) => {
      intent = { targetAgentKind, model, providerId };
      return { switched: false, agentKind: targetAgentKind, model, engineReady: true, deferred: true };
    },
    getSessionAgentSwitchIntent: () => intent,
  });
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  const switched = await request('/api/sessions/switch-agent', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      sessionId: 's1',
      targetAgentKind: 'pi',
      model: 'group/deepseek',
      providerId: 'magpie-debian',
      effort: 'high',
    }),
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.deferred, true);
  assert.equal(switched.body.switched, false);
  assert.equal(switched.body.agentKind, 'pi');

  const read = await request('/api/sessions/agent-switch-intent', {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId: 's1' }),
  });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, {
    targetAgentKind: 'pi',
    model: 'group/deepseek',
    providerId: 'magpie-debian',
  });
});
