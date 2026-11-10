import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createWebAuth } from './web-auth.mjs';

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
    return new Promise((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${port}${path}`, { method, headers }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode,
          body: response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text,
          headers: new Headers(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])),
        }));
      });
      req.on('error', reject);
      req.end(body);
    });
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

// Regression: a stranger could GET / then reuse its cookie to read every task.
// Exercise real HTTP with an isolated fake profile; no real credentials (unit).
test('browser pairing gates boot data, cookies and API access', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-web-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head></html>');
  const request = await withServer(t, { webDir: dir, bootValues: () => ({ title: '</script><script>bad()</script>', owner: 'private-owner' }) });
  const home = await request('/');
  assert.equal(home.headers.get('set-cookie'), null);
  assert.equal(home.body.includes('private-owner'), false);
  assert.equal((await request('/web/pair', { method: 'POST' })).status, 401);
  const paired = await request('/web/pair', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  const exchange = { method: 'POST', body: JSON.stringify({ code: paired.body.code }) };
  const connected = await request('/web/session', exchange);
  const cookie = connected.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/web/session', exchange)).status, 401);
  const app = await request('/', { headers: { cookie } });
  assert.equal(app.body.includes('private-owner'), true);
  assert.equal(app.body.includes('</script><script>bad()'), false);
  assert.equal((await request('/api/sessions/list', { method: 'POST', headers: { cookie } })).status, 200);
  assert.equal((await request('/api/sessions/list', { method: 'POST', headers: { cookie, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/sessions', { headers: { host: 'evil.example', authorization: `Bearer ${TOKEN}` } })).status, 403);
  await request('/logout', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal((await request('/api/sessions/list', { method: 'POST', headers: { cookie } })).status, 401);
});

test('expired pairing codes and browser sessions cannot authorize a client', () => {
  let now = 0;
  const auth = createWebAuth({ now: () => now });
  const expired = auth.pair();
  now = 60_000;
  assert.equal(auth.exchange(expired), null);
  const session = auth.exchange(auth.pair());
  assert.equal(auth.accepts(`cindy_host_web=${session}`), true);
  now += 12 * 60 * 60_000;
  assert.equal(auth.accepts(`cindy_host_web=${session}`), false);
});
