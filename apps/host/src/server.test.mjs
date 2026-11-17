import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createWebAuth } from './web-auth.mjs';
import { WebSocket } from 'ws';
import { createPlatformClientBridge } from './platform/client-bridge.ts';
import { createHostPlatformRpc } from '@cindy/maker-shared/host-platform-rpc';

import { createHostServer } from './server.mjs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createOwnerBoundaryStop, runOwnerBoundary } from './agent/owner-boundary.ts';
import { markSessionTurnEnded, drainSessionActiveTurnWrites } from '../../desktop/src/main/localDb/sessionActiveTurn.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';

const TOKEN = 'test-token-value';

// Real socket, bridge and RPC; only the signed-client executor is synthetic.
// Covers authentication, freeze admission and lost replies without real input.
test('platform socket pins Host and owner and never replays a lost operation', async t => {
  let ownerCurrent = true;
  const bridge = createPlatformClientBridge({ ownerId: 'fixture-owner',
    assertCurrent() { if (!ownerCurrent) throw Error('OWNER_CHANGED'); } });
  const server = createHostServer({ token: TOKEN, instanceId: 'fixture-host', platformClient: () => bridge,
    probe: () => ({}), isOwnerReady: () => true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { bridge.close(); server.close(); });
  const url = `ws://127.0.0.1:${server.address().port}/control/platform/socket`;
  const refused = headers => new Promise(resolve => {
    const socket = new WebSocket(url, { headers });
    socket.on('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
    socket.on('error', () => {});
  });
  assert.equal(await refused({ authorization: `Bearer ${TOKEN}`, 'x-cindy-host-instance': 'old-host' }), 403);
  assert.equal(await refused({ cookie: 'cindy_host_web=fixture', 'x-cindy-host-instance': 'fixture-host' }), 403);
  assert.equal(await refused({ authorization: `Bearer ${TOKEN}`, 'x-cindy-host-instance': 'fixture-host', origin: 'http://127.0.0.1' }), 403);
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}`, 'x-cindy-host-instance': 'fixture-host' } });
  let dispatched = 0, finish, received;
  let seen = new Promise(resolve => { received = resolve; });
  const rpc = createHostPlatformRpc(socket, { assertCurrent() {}, execute: async operation => {
    if (operation.method === 'identity') { assert.equal(operation.ownerId, 'fixture-owner'); return { id: 'fixture-client', pid: process.pid, protocol: 1 }; }
    if (operation.method === 'freeze' || operation.method === 'resume') return true;
    dispatched++; received(); return new Promise(resolve => { finish = resolve; });
  } });
  t.after(() => { rpc.close(); socket.terminate(); });
  const work = bridge.call({ method: 'computer.call', name: 'click' });
  await seen;
  await assert.rejects(bridge.control('prepare', { id: 'fixture-client', pid: process.pid }), /BUSY/);
  finish('clicked'); assert.equal(await work, 'clicked'); assert.equal(dispatched, 1);
  await bridge.control('prepare', { id: 'fixture-client', pid: process.pid });
  seen = new Promise(resolve => { received = resolve; });
  const waiting = bridge.call({ method: 'computer.call', name: 'submit' });
  assert.equal(bridge.status().waiting, 1);
  await bridge.control('cancel', { id: 'fixture-client', pid: process.pid });
  await seen;
  const uncertain = assert.rejects(waiting, /UNCERTAIN/);
  socket.terminate(); await uncertain;
  assert.equal(dispatched, 2);
  ownerCurrent = false;
  await assert.rejects(bridge.call({ method: 'computer.call' }), /OWNER_CHANGED/);
});

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

test('model-access retry performs synchronization and Codex route reads the actual runtime', async t => {
  let retries = 0;
  const ready = { state: 'ok', source: 'server', endpoint: 'https://fixture.invalid', accountTier: null };
  const request = await withServer(t, {
    modelAccess: () => ({ ...ready, state: 'failed' }),
    retryModelAccess: async () => { retries++; return ready; },
    codexRuntimeRoute: () => ({ authInjection: 'provider-oauth' }),
  });
  const options = { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{}' };
  assert.equal((await request('/api/model-access/retry', { method: 'POST' })).status, 401);
  assert.equal(retries, 0);
  assert.equal((await request('/api/model-access', options)).body.state, 'failed');
  assert.equal(retries, 0);
  assert.deepEqual((await request('/api/model-access/retry', options)).body, ready);
  assert.equal(retries, 1);
  assert.deepEqual((await request('/api/agents/codex-runtime-route', options)).body, { authInjection: 'provider-oauth' });
});

test('plugin confirmation replies use the authenticated controller, never a caller supplied in JSON', async t => {
  const auth = createWebAuth();
  const cookie = `cindy_host_web=${auth.exchange(auth.pair())}`;
  const authenticated = auth.caller(cookie);
  const replies = [];
  const request = await withServer(t, { webAuth: auth,
    resolvePluginConfirmation: (caller, kind, requestId, confirmed) => {
      replies.push({ caller, kind, requestId, confirmed }); return caller === authenticated;
    },
  });
  const body = JSON.stringify({ requestId: 'pending', confirmed: true, caller: 'web:forged' });
  const headers = { cookie, 'content-type': 'application/json' };
  assert.equal((await request('/api/ghosts/confirm/resolve', { method: 'POST', body })).status, 401);
  assert.deepEqual((await request('/api/ghosts/confirm/resolve', { method: 'POST', headers, body })).body, { handled: true });
  assert.deepEqual(replies, [{ caller: authenticated, kind: 'confirm', requestId: 'pending', confirmed: true }]);
  assert.equal((await request('/api/ghosts/confirm/resolve', { method: 'POST', headers,
    body: JSON.stringify({ requestId: 'pending', confirmed: 'yes' }) })).status, 400);
  assert.equal(replies.length, 1);
  // Installed declarations do not expose a supplementary approval endpoint.
  assert.equal((await request('/api/ghosts/request-task-approval', { method: 'POST', headers,
    body: JSON.stringify({ id: 'demo', capability: 'host-tools:terminal' }) })).status, 404);
});

test('managed stop requires the profile bearer and the current instance, never a browser cookie', async (t) => {
  let stopped = 0;
  const webAuth = createWebAuth();
  const cookie = webAuth.exchange(webAuth.pair());
  const request = await withServer(t, { webAuth, instanceId: 'current', requestStop: () => stopped++ });
  const init = { method: 'POST', body: JSON.stringify({ instanceId: 'current' }) };
  assert.equal((await request('/control/stop', init)).status, 401);
  assert.equal((await request('/control/stop', { ...init, headers: { cookie: `cindy_host_web=${cookie}` } })).status, 401);
  assert.equal((await request('/control/stop', { ...init, headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ instanceId: 'old' }) })).status, 409);
  assert.equal(stopped, 0);
  const result = await request('/control/stop', { ...init, headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, { stopping: true });
  assert.equal(stopped, 1);
});

// Pinned client handover: a reused address must not accept the old client's writes.
// Existing stop tests only fence stop itself; enqueue and event attachment need it too.
test('a pinned client can inspect its Host but cannot write to or subscribe to a replacement', async t => {
  let writes = 0;
  const request = await withServer(t, { instanceId: 'current',
    probe: () => ({ pid: 42, runtime: { state: 'ready' }, remote: { status: 'online' } }),
    input: { enqueue: () => { writes++; return {}; } } });
  const headers = { authorization: `Bearer ${TOKEN}`, 'x-cindy-host-instance': 'current' };
  const current = await request('/control/attachment', { method: 'POST', headers });
  assert.deepEqual(current.body, { protocol: 1, instanceId: 'current', pid: 42, ready: true, remoteReady: true, clientHandoffReady: false });
  assert.equal((await request('/control/attachment', { method: 'POST' })).status, 401);
  for (const pathname of ['/api/input/enqueue', '/events']) {
    const response = await request(pathname, { method: pathname === '/events' ? 'GET' : 'POST',
      headers: { ...headers, 'x-cindy-host-instance': 'previous' }, body: '{}' });
    assert.equal(response.status, 409);
    assert.equal(response.body.error, 'host_instance_changed');
  }
  assert.equal(writes, 0);
});

test('shutdown stops listening and waits for in-flight storage work before disposal', async (t) => {
  let entered;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const server = createHostServer({ token: TOKEN, listSessions: async () => { entered(); await pending; return []; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { release(); server.closeAllConnections(); server.close(); });
  const { port } = server.address();
  const response = fetch(`http://127.0.0.1:${port}/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } });
  await started;
  let drained = false;
  const drain = server.stopAccepting().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(server.listening, false);
  assert.equal(drained, false);
  release();
  assert.deepEqual(await (await response).json(), { sessions: [] });
  await drain;
  assert.equal(drained, true);
});

test('logout requires the bearer and reports server revocation', async (t) => {
  const request = await withServer(t);
  assert.equal((await request('/logout', { method: 'POST' })).status, 401);
  const signedOut = await request('/logout', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.deepEqual(signedOut.body, { signedOut: true, serverRevoked: true });
});

test('logout cancels an admitted login before waiting for the request drain', async t => {
  let enter, complete;
  const entered = new Promise(resolve => { enter = resolve; });
  let cancelled = 0;
  let signedOut = false;
  const request = await withServer(t, {
    agentAuthInvoke: async () => { enter(); return new Promise(resolve => { complete = resolve; }); },
    cancelPendingAuth: async () => { cancelled++; complete({ authenticated: false, errorReason: 'login_cancelled' }); },
    logout: () => { signedOut = true; return { signedOut: true }; },
  });
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const login = request('/api/agents/login', { method: 'POST', headers, body: JSON.stringify({ agentKind: 'codex' }) });
  await entered;
  const logout = await request('/logout', { method: 'POST', headers });
  assert.equal((await login).body.authenticated, false);
  assert.equal(cancelled, 1);
  assert.equal(signedOut, true);
  assert.equal(logout.body.signedOut, true);
});

test('expired browser sessions release only their own authenticated controller', () => {
  let now = 0;
  const auth = createWebAuth({ now: () => now });
  const released = [];
  auth.onSessionRevoke(caller => released.push(caller));
  const first = auth.exchange(auth.pair());
  const firstCaller = auth.caller(`cindy_host_web=${first}`);
  now = 1_000;
  const second = auth.exchange(auth.pair());
  const secondCaller = auth.caller(`cindy_host_web=${second}`);
  now = 12 * 60 * 60_000;
  assert.equal(auth.accepts(`cindy_host_web=${first}`), false);
  assert.equal(auth.accepts(`cindy_host_web=${second}`), true);
  assert.deepEqual(released, [firstCaller]);
  assert.ok(!firstCaller.includes(first));
  auth.clear();
  assert.deepEqual(released, [firstCaller, secondCaller]);
});

// Account teardown must not close storage underneath another request or accept
// more private work while two clients are concurrently signing out.
// 测试价值
// - 生产入口：server.mjs 的 HTTP 退出登录（POST /logout），配 main.ts 同样的接线：beginOwnerBoundaryStop 是
//   createOwnerBoundaryStop 的 begin，logout 经 runOwnerBoundary 拆运行时；回合结束写入用真实的 markSessionTurnEnded。
// - 规则：放行表第五节“甲：账号边界停止提前置位”与 agent/owner-boundary.ts 的不变式：begin 在关平台客户端之前；
//   begin 之后必须到达 dispose，压制必须释放。
// - 现有覆盖缺口：取消挂起的登录被拒、或关平台客户端同步抛错时，不调 deps.logout（停止态的输入运行时不会被重建，
//   之后每次发送都被拒），或连 release 都不调（之后所有回合都不写结束时间）。
// - 最小失败输入：一次退出登录，前置的一步失败。
// - tier：unit（真实 HTTP 回环与临时 SQLite，无真实等待）。
for (const failure of ['cancelPendingAuth rejects', 'platformClient.close throws']) {
  test(`logout, when ${failure}: the stop begins before the platform client closes, the logout still reaches dispose, and the stop is released`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-logout-boundary-'));
    const sqlite = new Database(path.join(root, 'markers.sqlite'));
    sqlite.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY, active_turn_started_at INTEGER, last_turn_ended_at INTEGER); INSERT INTO sessions(id) VALUES (\'after\')');
    setCurrentDbClient({ drizzle: drizzle(sqlite) }, 'logout-boundary-test');
    t.after(() => { clearCurrentDbClient(); sqlite.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const order = [];
    let stopping = false;
    const boundary = createOwnerBoundaryStop({ beginStop: () => { stopping = true; order.push('begin'); } });
    const request = await withServer(t, {
      beginOwnerBoundaryStop: () => boundary.begin(),
      platformClient: () => ({ close: () => {
        order.push('close');
        if (failure === 'platformClient.close throws') throw new Error('platform close failed');
      } }),
      cancelPendingAuth: async () => { if (failure === 'cancelPendingAuth rejects') throw new Error('login cancel failed'); },
      // As main.ts: the logout's own boundary; its dispose replaces the stopped input runtime with a fresh one.
      logout: async () => {
        const { errors } = await runOwnerBoundary(boundary, { dispose: async () => { order.push('dispose'); stopping = false; } });
        if (errors.length) throw errors[0];
        return { signedOut: true };
      },
    });
    const response = await request('/logout', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    assert.equal(response.body.signedOut, true, 'signed out cleanly');
    assert.deepEqual(order, ['begin', 'close', 'begin', 'dispose']);
    assert.equal(stopping, false, 'the stopped input runtime was replaced');
    // The suppression is released: the next turn's end is written.
    markSessionTurnEnded('after');
    await drainSessionActiveTurnWrites('after');
    assert.equal(typeof sqlite.prepare('SELECT last_turn_ended_at AS endedAt FROM sessions WHERE id = ?').get('after').endedAt, 'number');
  });
}

test('logout drains owner requests, revokes streams and serializes concurrent callers', async (t) => {
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let signOuts = 0;
  let revoked;
  const revocation = new Promise(resolve => { revoked = resolve; });
  const webAuth = createWebAuth();
  webAuth.onRevoke(revoked);
  const request = await withServer(t, {
    webAuth,
    listSessions: async () => { enter(); await blocked; return []; },
    logout: () => { signOuts++; return { signedOut: true }; },
  });
  t.after(release);
  const headers = { authorization: `Bearer ${TOKEN}` };
  const pending = request('/sessions', { headers });
  await entered;
  const first = request('/logout', { method: 'POST', headers });
  await revocation;
  const second = request('/logout', { method: 'POST', headers });
  assert.equal((await request('/sessions', { headers })).status, 409);
  assert.equal(signOuts, 0);
  assert.equal((await request('/web/pair', { method: 'POST', headers })).status, 409);
  assert.equal((await request('/web/session', { method: 'POST', body: JSON.stringify({ code: 'old-code' }) })).status, 409);
  release();
  await pending;
  assert.equal((await first).body.signedOut, true);
  assert.equal((await second).body.signedOut, true);
  assert.equal(signOuts, 1);
});

test('history requires the bearer and returns the requested page', async (t) => {
  const request = await withServer(t);
  assert.equal((await request('/sessions/s1/messages')).status, 401);
  const page = await request('/sessions/s1/messages?limit=5', { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.deepEqual(page.body.messages, [{ id: 'm1', sessionId: 's1', limit: 5 }]);
});

// Queue recovery reads durable state before it answers. Serializing the Promise
// itself used to produce {} and silently hide the restored queue after restart.
test('input projection awaits recovery and steer includes the authoritative state', async (t) => {
  const projection = { sessionId: 's', pendingQueue: [{ clientId: 'saved' }], queuePaused: true };
  const request = await withServer(t, { input: {
    projection: async () => projection,
    steer: async () => projection,
  } });
  const init = { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ sessionId: 's' }) };
  assert.deepEqual((await request('/api/input/projection', init)).body, projection);
  assert.deepEqual((await request('/api/input/steer', init)).body, { ok: true, projection });
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
  assert.equal(failed.body.message, 'storage offline');
});

// Rule: a typed error from an /api entry answers with the shared table's status, as the IPC route
// (typed-error.mjs); the message stays the whole `[CODE] message`, which the web client reads the
// code from. Gap: every failure here answered 500, a refused model change included. Only an exactly
// typed error in the table changes; a code mismatch, a code outside the table or a plain error stay 500.
test('typed errors from /api entries answer with their table status; anything else stays 500', async (t) => {
  const typed = (code, text = `[${code}] refused`) => Object.assign(new Error(text), { code });
  let failure;
  const request = await withServer(t, { updateSession: () => { throw failure; } });
  const call = () => request('/api/sessions/update', { method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's', patch: { model: 'small' } }) });
  for (const [code, status] of [['MODEL_WINDOW_PROTECTION_UNAVAILABLE', 409], ['PRECONDITION_FAILED', 409],
    ['INVALID_PARAMS', 400], ['UNSUPPORTED_CAPABILITY', 501]]) {
    failure = typed(code);
    const answer = await call();
    assert.equal(answer.status, status, code);
    assert.deepEqual(answer.body, { error: code, message: `[${code}] refused` });
  }
  for (const untyped of [typed('NOT_IN_TABLE'), typed('INVALID_PARAMS', '[NOT_FOUND] mismatch'),
    new Error('[INVALID_PARAMS] no code property')]) {
    failure = untyped;
    const answer = await call();
    assert.equal(answer.status, 500, untyped.message);
    assert.deepEqual(answer.body, { error: 'internal_error', message: untyped.message });
  }
});

// Only an Error's message is part of the client contract. Any other thrown value
// may stringify to a stack or an internal path, so no error body may echo it.
test('thrown values that are not errors are never serialised to the client', async (t) => {
  const raw = { toString: () => 'boom\n    at internal (/private/host/internal.js:1:1)' };
  const request = await withServer(t, {
    listSessions: () => { throw raw; },
    capabilities: () => { throw raw; },
  });
  const headers = { authorization: `Bearer ${TOKEN}` };
  const failed = await request('/sessions', { headers });
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: 'internal_error', message: 'Unexpected error' });
  const capabilities = await request('/api/capabilities', { method: 'POST', headers, body: JSON.stringify({ agentKind: 'codex' }) });
  assert.equal(capabilities.status, 404);
  assert.deepEqual(capabilities.body, { error: 'agent_not_registered', message: 'Unexpected error' });
});

// The desktop's set-effort, set-fast-mode, set-thinking-enabled, set-permission-mode and set-plan-mode
// reach their Host entries with the IPC arguments the web client passes (shim.js), and answer what the
// entry returns.
test('effort, Fast mode, thinking, permission and Plan routes pass the desktop IPC arguments to their entries', async (t) => {
  const calls = [];
  const request = await withServer(t, {
    setSessionEffort: (...args) => { calls.push(['effort', ...args]); return { deferred: true, superseded: false, pendingUntilSend: true }; },
    setSessionFastMode: (...args) => { calls.push(['fast', ...args]); return undefined; },
    setSessionThinkingEnabled: (...args) => { calls.push(['thinking', ...args]); return undefined; },
    setSessionPermissionMode: (...args) => { calls.push(['permission', ...args]); return true; },
    setSessionPlanMode: (...args) => { calls.push(['plan', ...args]); return undefined; },
  });
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const post = (path, body) => request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const effort = await post('/api/sessions/set-effort', { sessionId: 's1', effort: 'low' });
  assert.equal(effort.status, 200);
  assert.deepEqual(effort.body, { deferred: true, superseded: false, pendingUntilSend: true });
  assert.equal((await post('/api/sessions/set-fast-mode', { sessionId: 's1', fastMode: 'ultrafast' })).status, 200);
  assert.equal((await post('/api/sessions/set-thinking-enabled', { sessionId: 's1', enabled: false })).status, 200);
  const permission = await post('/api/sessions/set-permission-mode', { sessionId: 's1', mode: 'auto' });
  assert.equal(permission.status, 200);
  assert.equal(permission.body, true);
  assert.equal((await post('/api/sessions/set-plan-mode', { sessionId: 's1', enabled: true })).status, 200);
  assert.deepEqual(calls, [['effort', 's1', 'low'], ['fast', 's1', 'ultrafast'], ['thinking', 's1', false],
    ['permission', 's1', 'auto'], ['plan', 's1', true]]);
});

test('cross-engine switch returns a deferred intent and exposes it for the renderer', async (t) => {
  let intent = null;
  let forwarded = null;
  const request = await withServer(t, {
    switchSessionAgent: (...args) => {
      forwarded = args;
      const [, targetAgentKind, model, providerId] = args;
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
      options: { confirmedContextWindow: 128_000 },
      thinking: false,
    }),
  });
  assert.equal(switched.status, 200);
  // The desktop IPC's arguments reach the entry, including its options and the thinking choice.
  assert.deepEqual(forwarded, ['s1', 'pi', 'group/deepseek', 'magpie-debian', 'high', undefined, { confirmedContextWindow: 128_000 }, false]);
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

// Remote enablement is an operator action, scoped to this running instance.
// A browser cookie or stale discovery file cannot toggle an unrelated process.
test('remote control changes require the local profile bearer and current instance', async t => {
  let called = 0;
  const request = await withServer(t, { instanceId: 'live', remoteControl: async (action, body) => { called++; return { action, deviceId: body.deviceId }; } });
  const body = JSON.stringify({ instanceId: 'live', action: 'enable' });
  assert.equal((await request('/control/remote', { method: 'POST', body })).status, 401);
  assert.equal((await request('/control/remote', { method: 'POST', body: JSON.stringify({ instanceId: 'old', action: 'enable' }), headers: { authorization: `Bearer ${TOKEN}` } })).status, 409);
  assert.equal(called, 0);
  const reply = await request('/control/remote', { method: 'POST', body, headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(reply.status, 200); assert.equal(reply.body.action, 'enable'); assert.equal(called, 1);
});

test('expired-account boundary revokes browser access and drains admitted writes', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const webAuth = createWebAuth();
  const cookie = webAuth.exchange(webAuth.pair());
  const server = createHostServer({ token: TOKEN, webAuth,
    listSessions: async () => { entered(); await gate; return []; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { release(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const first = fetch(`${base}/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } });
  await started;
  let drained = false;
  const pause = server.pauseOwnerRequests().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  assert.equal(webAuth.accepts(`cindy_host_web=${cookie}`), false);
  assert.equal((await fetch(`${base}/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 409);
  assert.equal((await fetch(`${base}/web/pair`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status, 409);
  release(); await first; await pause;
  assert.equal(drained, true);
});

// Regression: a disconnected embedded browser queues get-health. The HTTP
// boundary must cancel it before draining writers, without a replacement window.
for (const boundary of ['logout', 'expired-owner', 'stop']) {
  test(`${boundary} cancels platform waits before draining HTTP`, { timeout: 5000 }, async t => {
    const bridge = createPlatformClientBridge({ ownerId: 'fixture-owner', assertCurrent() {} });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const server = createHostServer({ token: TOKEN, platformClient: () => bridge,
      browserBackend: () => { entered(); return bridge.call({ method: 'browser.probe' }); },
      logout: async () => { assert.equal(bridge.status().waiting, 0); return { authenticated: false }; },
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { bridge.close(); server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const pending = fetch(`${base}/api/browser-backend/get-health`, { method: 'POST', headers, body: '{}' });
    await started;
    assert.equal(bridge.status().waiting, 1);
    if (boundary === 'logout') {
      const response = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, 200);
    } else if (boundary === 'expired-owner') await server.pauseOwnerRequests();
    else await server.stopAccepting();
    assert.equal((await pending).status, 500);
    assert.equal(bridge.status().waiting, 0);
  });
}

// 测试价值
// - 生产入口：server.mjs 的 createHostServer（窗口与网页端的 owner 请求都经它）。
// - 规则：并存方案 A 后续（审核方 2026-11-17 定）。Host 因桌面占用而启动被拒时，owner 请求的 409 要带原因码和一句
//   能说清原因与做法的话，客户端据此显示人话，不再是笼统的 "not ready"；Host 说不出原因时只有 `error`，
//   旧客户端照旧。
// - 现有覆盖缺口：之前 409 只有 `{ error: 'owner_runtime_unavailable' }`。
// - 最小失败输入：未就绪的 Host 收到一次 owner 请求。tier：unit（本机回环 HTTP）。
test('a refused owner request says why when the Host knows, and stays a bare error otherwise', async t => {
  const reason = { reason: 'HOST_PROFILE_IN_USE_BY_DESKTOP', message: 'Quit the desktop app, then restart the Host.' };
  const ask = async ownerUnavailableReason => {
    const server = createHostServer({ token: TOKEN, instanceId: 'fixture-host', probe: () => ({}), isOwnerReady: () => false,
      ...(ownerUnavailableReason ? { ownerUnavailableReason } : {}) });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/list`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{}' });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await ask(() => reason), { status: 409, body: { error: 'owner_runtime_unavailable', ...reason } });
  assert.deepEqual(await ask(() => null), { status: 409, body: { error: 'owner_runtime_unavailable' } });
  assert.deepEqual(await ask(undefined), { status: 409, body: { error: 'owner_runtime_unavailable' } });
});
