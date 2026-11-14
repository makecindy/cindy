/*
 * 测试价值
 * - 生产入口与可观察结果：createHostServer + createHostIpcRoute 的 `POST /api/ipc/<channel>` 与
 *   `POST /control/ipc-manifest`；调用方看到的状态码、拒绝码，以及处理函数是否被执行；
 *   桌面代理 createHostIpcProxy 用真实 fetch 连真实 server + 生产绑定（createHostIpcBindings）时窗口拿到的结果。
 * - Bug／规则依据：docs/host/headless-runtime-plan.md 第 1a 批准入设计（受众先于查表、必须带实例头、
 *   合同指纹、owner 入口与出口两次比对、参数校验先于处理函数、不允许空成功）。
 * - 现有覆盖缺口：新路由；server.test.mjs 只覆盖既有专用路由的实例头；代理与路由各自的测试都用假对象，
 *   路径编码、头名与信封是否对得上只靠共享常量。
 * - 最小失败输入：网页 cookie 调用、缺实例头、旧指纹、处理期间切账号、空白会话 id、处理函数多返回一个字段、
 *   某族绑定了别族的通道、同一通道绑定两次、返回形状表与登记表的字段或可选性不一致。
 * - tier：unit + 进程内联调（真实 loopback HTTP 与内存 SQLite，无外部进程；真实进程见 scripts/ipc-route.e2e.mjs）。
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
  HOST_IPC_ENTRIES, HOST_IPC_FAMILIES, checkHostIpcValue, findHostIpcEntry, hostIpcFingerprint, hostIpcPath,
} from '@cindy/maker-shared/host-ipc-registry';

import { createHostServer } from './server.mjs';
import { createHostIpcRoute } from './ipc-route.mjs';
import {
  HOST_IPC_RESULT_FIELDS, createHostIpcBindings, createHostIpcFamilyBindings, mergeHostIpcBindings,
} from './ipc-bindings/index.ts';
import { createHostIpcProxy } from '../../desktop/src/main/host-ipc-proxy.ts';
import { createWebAuth } from './web-auth.mjs';
import { projectHostAuthState } from './auth-state.ts';
import { getActiveAppSession, getActiveDataOwnerPushStamp } from '../../desktop/src/main/appSessionState.ts';
import { configureHostOwner } from './agent/claude-auth.mjs';
import { setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { sessions } from '../../desktop/src/main/localDb/schema.ts';
import { listSideChats } from '../../desktop/src/main/maker-orchestration/side-chat-list.ts';
import { lifoCleanup } from './test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

const TOKEN = 'ipc-test-token';
const CHANNEL = 'maker:side-chat:list:v1';
const ENTRY = findHostIpcEntry(CHANNEL);
const OWNER = { dataOwnerId: 'owner-1', ownerGeneration: 3 };
const BACKGROUND = 'maker:session-background-tasks:list';
/** Unit tests below bind the side-chat channel only; every other entry is declared unsupported. */
const OTHERS = HOST_IPC_ENTRIES.map(entry => entry.channel).filter(channel => channel !== CHANNEL);

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

test('admission runs in order and the handler only runs for an admitted call', { timeout: TEST_TIMEOUT_MS }, async t => {
  let calls = 0;
  let owner = OWNER;
  const route = createHostIpcRoute({ instanceId: 'host-a', readOwnerStamp: () => owner, unsupported: OTHERS,
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

test('a read that straddles an account switch is dropped, and typed errors keep their code', { timeout: TEST_TIMEOUT_MS }, async t => {
  let owner = OWNER;
  const route = createHostIpcRoute({ instanceId: 'host-a', readOwnerStamp: () => owner, unsupported: OTHERS,
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

test('manifest needs the bearer and the pin, lists bound entries, and an old Host answers 404', { timeout: TEST_TIMEOUT_MS }, async t => {
  const route = createHostIpcRoute({ instanceId: 'host-a', readOwnerStamp: () => OWNER, unsupported: OTHERS,
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

test('every registered entry is bound or explicitly unsupported; unsupported answers instead of empty success', { timeout: TEST_TIMEOUT_MS }, async t => {
  assert.throws(() => createHostIpcRoute({ instanceId: 'h', readOwnerStamp: () => OWNER, bindings: {} }), /bound or declared unsupported/);
  assert.throws(() => createHostIpcRoute({ instanceId: 'h', readOwnerStamp: () => OWNER, unsupported: OTHERS,
    bindings: { [CHANNEL]: () => [], 'maker:nope': () => [] } }), /not a registered entry/);
  const route = createHostIpcRoute({ instanceId: 'host-a', readOwnerStamp: () => OWNER, bindings: {},
    unsupported: HOST_IPC_ENTRIES.map(entry => entry.channel) });
  assert.deepEqual(route.manifest().entries, []);
  const request = await serve(t, { ipcRoute: route });
  const response = await request(hostIpcPath(CHANNEL), { headers: pinned(), body: { args: ['p'], owner: OWNER } });
  assert.deepEqual([response.status, response.body.error.code], [501, 'channel_unsupported']);
});

test('the auth state a proxy stamps from equals the app-session stamp the route compares', { timeout: TEST_TIMEOUT_MS }, t => {
  t = lifoCleanup(t);
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

test('side-chat binding returns the contract shape from a real database, unchanged by JSON', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
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

test('a result outside the contract is still returned, but logged as result_mismatch naming the field only', { timeout: TEST_TIMEOUT_MS }, async t => {
  const events = [];
  const route = createHostIpcRoute({ instanceId: 'host-a', readOwnerStamp: () => OWNER, unsupported: OTHERS,
    log: event => events.push(event), bindings: { [CHANNEL]: () => [{ id: 'child', title: 'private title' }] } });
  const request = await serve(t, { ipcRoute: route });
  const response = await request(hostIpcPath(CHANNEL), { headers: pinned(), body: { args: ['parent'], owner: OWNER } });
  assert.deepEqual(response.body, { ok: true, result: [{ id: 'child', title: 'private title' }] });
  assert.deepEqual(events.map(({ ms: _ms, ...event }) => event), [{ channel: CHANNEL, caller: 'local', outcome: 'result_mismatch',
    detail: 'result[0].title is not part of the contract' }]);
});

test('Host bindings mirror the registry families, and the production table binds every entry once', { timeout: TEST_TIMEOUT_MS }, () => {
  const families = createHostIpcFamilyBindings({ getLiveSession: () => undefined });
  assert.deepEqual(Object.keys(families), Object.keys(HOST_IPC_FAMILIES));
  for (const [family, bindings] of Object.entries(families)) {
    assert.deepEqual(Object.keys(bindings).sort(), HOST_IPC_FAMILIES[family].map(entry => entry.channel).sort(), family);
  }
  assert.throws(() => mergeHostIpcBindings({ a: { [CHANNEL]: () => [] }, b: { [CHANNEL]: () => [] } }), /bound twice \(again in b\)/);
  // Every registered entry bound, none left unsupported: the route's own startup check passes.
  assert.doesNotThrow(() => createHostIpcRoute({ instanceId: 'h', readOwnerStamp: () => OWNER,
    bindings: createHostIpcBindings({ getLiveSession: () => undefined }) }));
});

// Type half: the ResultFields tables in ipc-bindings/ stop type checking when the
// types a handler returns change. This half keeps those tables equal to the
// registry, so a maker-core field change cannot reach a window as result_mismatch only.
test('every object in a registered result has a shape table equal to the registry schema', { timeout: TEST_TIMEOUT_MS }, () => {
  const objectTables = (schema, at, out = {}) => {
    if (schema.type === 'array') return objectTables(schema.items, `${at}[]`, out);
    if (schema.type !== 'object') return out;
    out[at] = Object.fromEntries(Object.entries(schema.properties)
      .map(([key, property]) => [key, property.optional ? 'optional' : 'required']));
    for (const [key, property] of Object.entries(schema.properties)) objectTables(property, `${at}.${key}`, out);
    return out;
  };
  const withObjects = HOST_IPC_ENTRIES.filter(entry => Object.keys(objectTables(entry.result, 'result')).length);
  assert.deepEqual(Object.keys(HOST_IPC_RESULT_FIELDS).sort(), withObjects.map(entry => entry.channel).sort());
  for (const entry of withObjects) {
    assert.deepEqual(HOST_IPC_RESULT_FIELDS[entry.channel], objectTables(entry.result, 'result'), entry.channel);
  }
});

test('desktop proxy and Host route agree over real HTTP with the production bindings', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE "${getTableName(sessions)}" (${Object.values(getTableColumns(sessions))
    .map(column => `"${column.name}" ${column.getSQLType()}`).join(',')})`);
  sqlite.exec(`INSERT INTO sessions(id,parent_session_id,source,status,created_at,updated_at) VALUES
    ('child','parent','side-chat','active',1,1)`);
  const client = createDbClientForHandle({ db: sqlite, drizzle: drizzle(sqlite) });
  setCurrentDbClient(client, 'isolated');
  t.after(() => clearCurrentDbClient(client));
  const tasks = [{ taskId: 't1', taskType: 'local_bash', backgroundCommandKind: 'service', toolUseId: 'u1', title: 'dev server',
    provider: 'claude-code', outputFile: '/tmp/t1.out' }, { taskId: 't2' }];
  const live = { listBackgroundTasks: () => tasks, countPendingWakeContinuations: () => 1 };
  let owner = OWNER;
  const events = [];
  const route = createHostIpcRoute({ instanceId: 'host-a', readOwnerStamp: () => owner, log: event => events.push(event),
    bindings: createHostIpcBindings({ getLiveSession: id => (id === 'running' ? live : undefined) }) });
  const server = createHostServer({ token: TOKEN, instanceId: 'host-a', probe: () => ({ runtime: { state: 'ready' } }),
    isOwnerReady: () => true, ipcRoute: route, getAuthState: () => ({ ...owner, canEnterApp: true }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  let view = { ...OWNER, canEnterApp: true };
  const proxy = createHostIpcProxy({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: TOKEN, instanceId: 'host-a',
    readOwner: () => view, applyAuthState: state => { view = state; } });
  const background = findHostIpcEntry(BACKGROUND);

  assert.deepEqual(await proxy.invoke(ENTRY, ['parent']), [{ id: 'child' }]);
  assert.deepEqual(await proxy.invoke(background, ['running']), { tasks, pendingContinuations: 1 });
  // Embedded parity: a session this Host does not run has no background tasks.
  assert.deepEqual(await proxy.invoke(background, ['']), { tasks: [], pendingContinuations: 0 });
  // The Host validator's rejection reaches the window as the IPC error the renderer decodes.
  await assert.rejects(proxy.invoke(ENTRY, ['  ']),
    { code: 'INVALID_PARAMS', message: '[INVALID_PARAMS] argument 1 must not be blank' });

  // An account boundary on the Host: this call fails, the window state is refreshed once, the next call passes.
  owner = { ...OWNER, ownerGeneration: OWNER.ownerGeneration + 1 };
  await assert.rejects(proxy.invoke(background, ['running']), { code: 'OWNER_CHANGED' });
  for (let tries = 0; view.ownerGeneration !== owner.ownerGeneration && tries < 100; tries++) await new Promise(r => setTimeout(r, 10));
  assert.equal((await proxy.invoke(background, ['running'])).pendingContinuations, 1);

  // A contract the Host does not have never reaches the route.
  const calls = events.length;
  await assert.rejects(proxy.invoke({ ...ENTRY, contractVersion: 2 }, ['parent']), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.equal(events.length, calls);
  assert.deepEqual([...new Set(events.map(event => event.outcome))].sort(), ['INVALID_PARAMS', 'ok', 'owner_scope_changed']);

  // An older Host without the route: unsupported, not a raw error.
  const old = createHostServer({ token: TOKEN, instanceId: 'host-old', probe: () => ({}), isOwnerReady: () => true });
  await new Promise(resolve => old.listen(0, '127.0.0.1', resolve));
  t.after(() => old.close());
  const oldProxy = createHostIpcProxy({ baseUrl: `http://127.0.0.1:${old.address().port}`, token: TOKEN, instanceId: 'host-old',
    readOwner: () => view, applyAuthState: () => undefined });
  await assert.rejects(oldProxy.invoke(background, ['running']), { code: 'UNSUPPORTED_CAPABILITY' });
});
