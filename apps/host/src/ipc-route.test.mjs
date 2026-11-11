/*
 * 测试价值
 * - 生产入口与可观察结果：createHostServer + createHostIpcRoute 的 `POST /api/ipc/<channel>` 与
 *   `POST /control/ipc-manifest`；调用方看到的状态码、拒绝码，以及处理函数是否被执行。
 * - Bug／规则依据：docs/host/headless-runtime-plan.md 第 1a 批准入设计（受众先于查表、必须带实例头、
 *   合同指纹、owner 入口与出口两次比对、参数校验先于处理函数、不允许空成功）。
 * - 现有覆盖缺口：新路由；server.test.mjs 只覆盖既有专用路由的实例头。
 * - 最小失败输入：网页 cookie 调用、缺实例头、旧指纹、处理期间切账号、空白会话 id。
 * - tier：unit（真实 loopback HTTP 与内存 SQLite，无外部进程）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableColumns, getTableName } from 'drizzle-orm';
import {
  HOST_IPC_ENTRIES, checkHostIpcValue, findHostIpcEntry, hostIpcFingerprint, hostIpcPath,
} from '@cindy/maker-shared/host-ipc-registry';

import { createHostServer } from './server.mjs';
import { createHostIpcRoute } from './ipc-route.mjs';
import { createWebAuth } from './web-auth.mjs';
import { projectHostAuthState } from './auth-state.ts';
import { getActiveAppSession, getActiveDataOwnerPushStamp } from '../../desktop/src/main/appSessionState.ts';
import { configureHostOwner } from './agent/claude-auth.mjs';
import { setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { sessions } from '../../desktop/src/main/localDb/schema.ts';
import { listSideChats } from '../../desktop/src/main/maker-orchestration/side-chat-list.ts';

const TOKEN = 'ipc-test-token';
const CHANNEL = 'maker:side-chat:list:v1';
const ENTRY = findHostIpcEntry(CHANNEL);
const OWNER = { dataOwnerId: 'owner-1', ownerGeneration: 3 };

async function serve(t, deps) {
  const server = createHostServer({ token: TOKEN, instanceId: 'host-a', probe: () => ({}), isOwnerReady: () => true, ...deps });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  return (path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const pinned = (extra = {}) => ({ authorization: `Bearer ${TOKEN}`, 'x-cindy-host-instance': 'host-a',
  'x-cindy-ipc-contract': hostIpcFingerprint(ENTRY), ...extra });

test('admission runs in order and the handler only runs for an admitted call', async t => {
  let calls = 0;
  let owner = OWNER;
  const route = createHostIpcRoute({ instanceId: 'host-a', readOwnerStamp: () => owner,
    bindings: { [CHANNEL]: async ([id]) => { calls++; return [{ id: `${id}-child` }]; } } });
  const webAuth = createWebAuth();
  const cookie = `cindy_host_web=${webAuth.exchange(webAuth.pair())}`;
  const request = await serve(t, { ipcRoute: route, webAuth });
  const call = (headers, body = { args: ['parent'], owner: OWNER }, channel = CHANNEL) =>
    request(hostIpcPath(channel), { headers, body });
  const code = response => response.body.error?.code ?? response.body.error;

  const rejected = [
    // [label, request, status, code]
    ['no credential', call({ 'x-cindy-host-instance': 'host-a' }), 401, 'unauthorized'],
    // A browser session learns nothing about registered names, known or not.
    ['web caller, registered', call({ cookie }), 403, 'audience_denied'],
    ['web caller, unknown', call({ cookie }, undefined, 'maker:nope'), 403, 'audience_denied'],
    ['missing instance pin', call({ authorization: `Bearer ${TOKEN}` }), 428, 'host_instance_required'],
    ['stale instance', call(pinned({ 'x-cindy-host-instance': 'host-old' })), 409, 'host_instance_changed'],
    ['unknown channel', call(pinned(), undefined, 'maker:nope'), 404, 'channel_unknown'],
    ['stale contract', call(pinned({ 'x-cindy-ipc-contract': 'old' })), 409, 'contract_mismatch'],
    ['other account', call(pinned(), { args: ['parent'], owner: { ...OWNER, dataOwnerId: 'owner-2' } }), 409, 'owner_scope_changed'],
    ['older generation', call(pinned(), { args: ['parent'], owner: { ...OWNER, ownerGeneration: 2 } }), 409, 'owner_scope_changed'],
    ['no owner stamp', call(pinned(), { args: ['parent'] }), 400, 'INVALID_PARAMS'],
    ['blank id', call(pinned(), { args: ['  '], owner: OWNER }), 400, 'INVALID_PARAMS'],
    ['extra argument', call(pinned(), { args: ['parent', 'x'], owner: OWNER }), 400, 'INVALID_PARAMS'],
  ];
  for (const [label, pending, status, expected] of rejected) {
    const response = await pending;
    assert.equal(response.status, status, label);
    assert.equal(code(response), expected, label);
  }
  assert.equal(calls, 0, 'no rejected call reached the handler');

  const ok = await call(pinned());
  assert.deepEqual([ok.status, ok.body], [200, { ok: true, result: [{ id: 'parent-child' }] }]);
  assert.equal(calls, 1);

  // Owner runtime gate (server) answers before the route when the account is not ready.
  const paused = await serve(t, { ipcRoute: route, isOwnerReady: () => false });
  assert.deepEqual((await paused(hostIpcPath(CHANNEL), { headers: pinned(), body: { args: ['p'], owner: OWNER } })).body,
    { error: 'owner_runtime_unavailable' });
});

test('a read that straddles an account switch is dropped, and typed errors keep their code', async t => {
  let owner = OWNER;
  const route = createHostIpcRoute({ instanceId: 'host-a', readOwnerStamp: () => owner,
    bindings: { [CHANNEL]: async ([id]) => {
      if (id === 'switch') { owner = { dataOwnerId: 'owner-2', ownerGeneration: 4 }; return [{ id: 'leaked' }]; }
      if (id === 'typed') throw Object.assign(new Error('[NOT_FOUND] Source task is unavailable'), { code: 'NOT_FOUND' });
      throw new Error('/private/path/db.sqlite is locked');
    } } });
  const request = await serve(t, { ipcRoute: route });
  const call = id => request(hostIpcPath(CHANNEL), { headers: pinned(), body: { args: [id], owner: OWNER } });

  const straddled = await call('switch');
  assert.equal(straddled.status, 409);
  assert.deepEqual(straddled.body, { ok: false, error: { code: 'owner_scope_changed', message: 'Active account changed' } });
  owner = OWNER;
  assert.deepEqual((await call('typed')).body, { ok: false, error: { code: 'NOT_FOUND', message: 'Source task is unavailable' } });
  // Untyped failures never serialise their text (paths, SQL) to the caller.
  assert.deepEqual((await call('untyped')).body, { ok: false, error: { code: 'INTERNAL', message: 'Host handler failed' } });
});

test('manifest needs the bearer and the pin, lists bound entries, and an old Host answers 404', async t => {
  const route = createHostIpcRoute({ instanceId: 'host-a', readOwnerStamp: () => OWNER,
    bindings: { [CHANNEL]: () => [] } });
  const request = await serve(t, { ipcRoute: route });
  assert.equal((await request('/control/ipc-manifest', { headers: { 'x-cindy-host-instance': 'host-a' } })).status, 401);
  assert.equal((await request('/control/ipc-manifest', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 428);
  assert.equal((await request('/control/ipc-manifest', { headers: pinned({ 'x-cindy-host-instance': 'host-old' }) })).status, 409);
  const manifest = await request('/control/ipc-manifest', { headers: pinned() });
  assert.deepEqual(manifest.body, { protocol: 1, instanceId: 'host-a',
    entries: [{ channel: CHANNEL, fingerprint: hostIpcFingerprint(ENTRY) }] });

  const old = await serve(t, {});
  assert.deepEqual((await old('/control/ipc-manifest', { headers: pinned() })).body, { error: 'not_found' });
  assert.deepEqual((await old(hostIpcPath(CHANNEL), { headers: pinned(), body: { args: ['p'], owner: OWNER } })).body,
    { error: 'not_found' });
});

test('every registered entry is bound or explicitly unsupported; unsupported answers instead of empty success', async t => {
  assert.throws(() => createHostIpcRoute({ instanceId: 'h', readOwnerStamp: () => OWNER, bindings: {} }), /bound or declared unsupported/);
  assert.throws(() => createHostIpcRoute({ instanceId: 'h', readOwnerStamp: () => OWNER,
    bindings: { [CHANNEL]: () => [], 'maker:nope': () => [] } }), /not a registered entry/);
  const route = createHostIpcRoute({ instanceId: 'host-a', readOwnerStamp: () => OWNER, bindings: {}, unsupported: [CHANNEL] });
  assert.deepEqual(route.manifest().entries, []);
  const request = await serve(t, { ipcRoute: route });
  const response = await request(hostIpcPath(CHANNEL), { headers: pinned(), body: { args: ['p'], owner: OWNER } });
  assert.deepEqual([response.status, response.body.error.code], [501, 'channel_unsupported']);
});

test('the auth state a proxy stamps from equals the app-session stamp the route compares', t => {
  // Production order: configureHostOwner commits the app session, then main.ts
  // publishes runtime.owner and projects auth from the session generation.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-ipc-'));
  t.after(() => { configureHostOwner({ userDataDir: profile, ownerId: null }); fs.rmSync(profile, { recursive: true, force: true }); });
  configureHostOwner({ userDataDir: profile, ownerId: 'owner-consistency' });
  const auth = projectHostAuthState({ account: { authenticated: true, realm: 'global' },
    accountUser: { id: 'owner-consistency', name: 'Owner' }, owner: 'owner-consistency',
    generation: getActiveAppSession().generation, deviceId: null });
  assert.equal(auth.canEnterApp, true);
  assert.deepEqual({ dataOwnerId: auth.dataOwnerId, ownerGeneration: auth.ownerGeneration }, getActiveDataOwnerPushStamp());
});

test('side-chat binding returns the contract shape from a real database, unchanged by JSON', async t => {
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE "${getTableName(sessions)}" (${Object.values(getTableColumns(sessions))
    .map(column => `"${column.name}" ${column.getSQLType()}`).join(',')})`);
  sqlite.exec(`INSERT INTO sessions(id,parent_session_id,source,status,created_at,updated_at) VALUES
    ('second','parent','side-chat','archived',2,2), ('first','parent','side-chat','active',1,1),
    ('gone','parent','side-chat','deleted',3,3), ('fork','parent','desktop','active',4,4),
    ('other','elsewhere','side-chat','active',5,5)`);
  const client = createDbClientForHandle({ db: sqlite, drizzle: drizzle(sqlite) });
  setCurrentDbClient(client, 'isolated');
  t.after(() => clearCurrentDbClient(client));
  const result = await listSideChats('parent');
  assert.deepEqual(result, [{ id: 'first' }, { id: 'second' }]);
  assert.equal(checkHostIpcValue(ENTRY.result, result), null);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.ok(HOST_IPC_ENTRIES.includes(ENTRY));
});
