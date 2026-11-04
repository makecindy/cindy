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
    ...deps,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  return async (path, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
}

test('health is public while task data requires the profile bearer', async (t) => {
  const request = await withServer(t);
  assert.equal((await request('/health')).status, 200);

  const denied = await request('/sessions');
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('www-authenticate'), 'Bearer');

  const allowed = await request('/sessions', { authorization: `Bearer ${TOKEN}` });
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body.sessions.map((s) => s.id), ['s1']);
  assert.equal((await request('/sessions', { authorization: 'Bearer wrong' })).status, 401);
});

test('me reports the bound owner without leaking credentials', async (t) => {
  const request = await withServer(t);
  const me = await request('/me', { authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(me.body, { owner: 'owner-1', authenticated: true, realm: 'global' });
  assert.equal(JSON.stringify(me.body).includes('token'), false);
});

test('unknown routes and internal failures stay JSON', async (t) => {
  const request = await withServer(t, {
    listSessions: () => { throw new Error('storage offline'); },
  });
  assert.equal((await request('/nope')).status, 404);
  const failed = await request('/sessions', { authorization: `Bearer ${TOKEN}` });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error, 'internal_error');
});
