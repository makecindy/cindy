import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { sessions, botSessionLinks, botProfiles, projectAliases, recentWorkdirs } from '../../desktop/src/main/localDb/schema.ts';
import { configureHostOwner } from './agent/claude-auth.mjs';
import { getActiveDataOwnerPushStamp, commitVolatileAppSession } from '../../desktop/src/main/appSessionState.ts';
import { writeProjectsRootDirectory } from '../../desktop/src/main/projects-root-settings.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostConfirmations } from './host-confirmations.ts';
import { createHostToolService } from './agent/host-tools.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { createHostServer } from './server.mjs';
import { createWebAuth } from './web-auth.mjs';
import { createEventHub } from './events.mjs';
import { startHostEventStream } from '@cindy/maker-shared/host-event-stream';
import { createLiziMcpProviders } from '@cindy/mcps';
import { handlePluginHostToolRequest } from '../../desktop/src/main/cindy-brain/hostToolSlot.ts';
import { createHostToolRuntime, setHostToolProviders } from '../../desktop/src/main/mcp-integrations/hostToolCaller.ts';

// Unit: existing installation and business confirmations use the Host's
// window-bound confirmation bridge; a different paired controller, disconnection
// or stale owner must never become an affirmative owner decision.
test('plugin confirmations bind the reply to the selected authenticated controller', async () => {
  const confirmations = createHostConfirmations({ current: () => true });
  const first = [], second = [];
  const disconnectFirst = confirmations.connect('web:first', event => { first.push(event); return true; });
  const disconnectSecond = confirmations.connect('web:second', event => { second.push(event); return true; });
  try {
    const answer = confirmations.confirm({ ghostId: 'demo', ghostName: 'Demo', body: 'Run command?',
      confirmText: null, cancelText: null, danger: false });
    assert.equal(first.length, 0);
    assert.equal(second[0].channel, 'ghosts:confirm-request');
    const id = second[0].payload.requestId;
    assert.equal(confirmations.resolve('web:first', 'confirm', id, true), false);
    assert.equal(confirmations.resolve('web:second', 'install', id, true), false);
    assert.equal(confirmations.resolve('web:second', 'confirm', id, true), true);
    assert.equal(await answer, true);
    assert.equal(confirmations.resolve('web:second', 'confirm', id, true), false);
    assert.equal(second.at(-1).channel, 'ghosts:confirm-dismissed');
  } finally { disconnectFirst(); disconnectSecond(); confirmations.close(); }
});

test('disconnect, plugin stop and owner change cancel only their own pending confirmations', async () => {
  let current = true;
  const confirmations = createHostConfirmations({ current: () => current });
  const events = [];
  const request = id => confirmations.confirm({ ghostId: id, ghostName: id, body: 'Run?',
    confirmText: null, cancelText: null, danger: false });
  assert.equal(await request('no-client'), false);
  const disconnect = confirmations.connect('web:owner', event => { events.push(event); return true; });
  try {
    const stopped = request('stopped');
    const kept = request('kept');
    confirmations.cancelPlugin('stopped');
    assert.equal(await stopped, false);
    const keptId = events.find(event => event.channel === 'ghosts:confirm-request' && event.payload.ghostId === 'kept').payload.requestId;
    assert.equal(confirmations.resolve('web:owner', 'confirm', keptId, true), true);
    assert.equal(await kept, true);
    const disconnected = request('disconnected');
    disconnect();
    assert.equal(await disconnected, false);
    const release = confirmations.connect('web:other', event => { events.push(event); return true; });
    const stale = request('stale');
    const staleId = events.at(-1).payload.requestId;
    current = false;
    assert.equal(confirmations.resolve('web:other', 'confirm', staleId, true), false);
    release();
    assert.equal(await stale, false);
  } finally { disconnect(); confirmations.close(); }
});

// Unit: Node's real provider assembly must dispatch installed declarations
// without a separate approval. Prior coverage required first-use/per-call UI.
// Minimal input is terminal_list; it creates no PTY or command process.
test('Node provider assembly uses installation authority without supplementary confirmation', async () => {
  const database = { drizzle: {} };
  setCurrentDbClient(database, 'owner');
  const ghost = { enabled: true, dir: '/fixture/demo',
    approval: { state: 'approved', revision: 'r1' },
    manifest: { schemaVersion: 3, id: 'demo', name: 'Demo', version: '1.0.0', kind: 'chip', entry: 'main.js',
      agent: { hostTools: ['terminal'] } } };
  const confirmations = createHostConfirmations({ current: () => true });
  let prompts = 0;
  const disconnect = confirmations.connect('web:owner', () => { prompts++; return true; });
  confirmations.install = confirmations.confirm = async () => { throw new Error('unexpected supplementary confirmation'); };
  let ownerCurrent = true;
  const service = createHostToolService({ profileDir: '/fixture', ownerId: 'owner', current: () => ownerCurrent,
    owner: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }), getGhost: () => ghost,
    getSession: () => undefined, confirmations, t: key => key,
  });
  const call = () => service.request('demo', { type: 'host-tool-request', server: 'cindy_helper', tool: 'terminal_list', args: {} }, () => true);
  const body = result => JSON.parse(result.content.find(item => item.type === 'text').text);
  try {
    assert.deepEqual(body(await call()).jobs, []);
    ghost.approvedHostToolGroups = [];
    assert.deepEqual(body(await call()).jobs, []);
    ghost.enabled = false;
    assert.equal(body(await call()).errorCode, 'PERMISSION_DENIED');
    ghost.enabled = true;
    ghost.manifest.agent.hostTools = [];
    ghost.approvedHostToolGroups = ['terminal'];
    assert.equal(body(await call()).errorCode, 'PERMISSION_DENIED');
    ghost.manifest.agent.hostTools = ['terminal'];
    ghost.approval = { state: 'legacy-unapproved' };
    assert.equal(body(await call()).errorCode, 'PERMISSION_DENIED');
    ghost.approval = { state: 'approved', revision: 'r1' };
    ownerCurrent = false;
    assert.equal(body(await call()).errorCode, 'PERMISSION_DENIED');
    assert.equal(prompts, 0);
  } finally { disconnect(); confirmations.close(); service.close(); clearCurrentDbClient(database); }
});

// Unit: a headless plugin must read the owner's existing tasks through the
// production helper provider, not a plugin-only list or a fabricated Session.
// The minimal failure is one approved history group and one persisted task.
test('Node history provider reads the current owner database and refuses a stale owner', async () => {
  let ownerCurrent = true;
  let afterRead = () => {};
  const rows = [{ id: 'existing-task', title: 'Existing task', workingDir: '/project', agentKind: 'cc',
    workspaceKind: 'project', model: 'fixture', status: 'active', source: 'desktop',
    orcaRole: null, parentSessionId: null, createdAt: 1, updatedAt: 1, userSendAt: null,
    hiddenAt: null, lastActivityAt: 1, companionJson: null }];
  const database = { drizzle: { select(fields) {
    const result = fields.cnt ? [{ sessionId: rows[0].id, cnt: 2 }] : rows;
    const query = { then: resolve => { afterRead(); resolve(result); } };
    for (const key of ['from', 'where', 'orderBy', 'groupBy', 'limit']) query[key] = () => query;
    return query;
  } } };
  setCurrentDbClient(database, 'owner');
  const ghost = { enabled: true, dir: '/fixture/history', approvedHostToolGroups: ['history'],
    approval: { state: 'approved', revision: 'r1' }, manifest: { schemaVersion: 3,
      id: 'history', name: 'History', version: '1.0.0', kind: 'chip', entry: 'main.js', agent: { hostTools: ['history'] } } };
  const confirmations = createHostConfirmations({ current: () => ownerCurrent });
  const service = createHostToolService({ profileDir: '/fixture', ownerId: 'owner', current: () => ownerCurrent,
    owner: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }), getGhost: () => ghost,
    getSession: () => undefined, manager: {}, confirmations, t: key => key });
  const call = () => service.request('history', { type: 'host-tool-request', server: 'cindy_helper',
    tool: 'list_sessions', args: { limit: 10 } }, () => true);
  const body = result => JSON.parse(result.content.find(item => item.type === 'text').text);
  try {
    const result = body(await call());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sessions[0].id, 'existing-task');
    assert.equal(result.sessions[0].messageCount, 2);
    afterRead = () => { ownerCurrent = false; };
    assert.equal(body(await call()).ok, false, 'an owner change during the read never returns the old account data');
    assert.equal(body(await call()).ok, false);
  } finally { service.close(); confirmations.close(); clearCurrentDbClient(database); }
});

// Unit: §29 only exposes services supplied by this execution host. Unlike a
// temporarily unready Desktop, Node has no production scheduler. One approved
// scheduler invocation must report unsupported rather than invite retry; the
// existing gateway still rejects disabled installations before this result.
test('Node reports an unavailable scheduler as unsupported by the execution environment', async () => {
  const ghost = { enabled: true, dir: '/fixture/scheduler', approvedHostToolGroups: ['scheduler'],
    approval: { state: 'approved', revision: 'r1' }, manifest: { schemaVersion: 3,
      id: 'scheduler', name: 'Scheduler', version: '1.0.0', kind: 'chip', entry: 'main.js', agent: { hostTools: ['scheduler'] } } };
  const confirmations = createHostConfirmations({ current: () => true });
  const service = createHostToolService({ profileDir: '/fixture', ownerId: 'owner', current: () => true,
    owner: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }), getGhost: () => ghost,
    getSession: () => undefined, manager: {}, confirmations, t: key => key });
  const call = () => service.request('scheduler', { type: 'host-tool-request', server: 'cindy_scheduler',
    tool: 'schedule_list', args: {} }, () => true);
  const body = result => JSON.parse(result.content.find(item => item.type === 'text').text);
  try {
    assert.deepEqual(body(await call()), { ok: false, errorCode: 'UNSUPPORTED_CAPABILITY',
      message: 'This execution environment does not support the requested Host service.' });
    ghost.enabled = false;
    assert.equal(body(await call()).errorCode, 'PERMISSION_DENIED');
  } finally { service.close(); confirmations.close(); }
});

// #9825 A/B, unit: use the production Node gateway and discovery executor, not
// forwarded caller metadata. The Node plugin connection is not assembled;
// no Node observation runtime may be constructed, while Desktop retains its path.
test('Node plugins cannot create computer snapshots or execute, while Desktop plugins retain the provider', async () => {
  const database = { drizzle: {} };
  setCurrentDbClient(database, 'owner');
  const owner = { dataOwnerId: 'owner', ownerGeneration: 1 };
  const ghost = { enabled: true, dir: '/fixture/computer', approvedHostToolGroups: ['computer', 'discovery'],
    approval: { state: 'approved', revision: 'r1' }, manifest: { id: 'computer', name: 'Computer',
      agent: { hostTools: ['computer', 'discovery'] } } };
  let executions = 0, runtimes = 0, prompts = 0;
  const provider = createLiziMcpProviders({ enabled: ['computer'], computer: {
    getStatus: async () => ({}), callTool: async () => { executions++; return { windows: [] }; },
  } }).find(p => p.name === 'cindy_computer');
  const factory = provider.toHostTools;
  provider.toHostTools = context => { runtimes++; return factory(context); };
  const confirmations = createHostConfirmations({ current: () => true });
  const disconnect = confirmations.connect('web:owner', () => { prompts++; return false; });
  const service = createHostToolService({ profileDir: '/fixture', ownerId: 'owner', current: () => true,
    owner: () => owner, getGhost: () => ghost, getSession: () => undefined, manager: {}, confirmations, t: key => key });
  service.providers.push(provider); service.services.replace(service.providers);
  const request = { type: 'host-tool-request', server: 'cindy_computer', tool: 'list_windows', args: {} };
  const body = value => JSON.parse(value.content.find(item => item.type === 'text').text);
  try {
    for (let i = 0; i < 2; i++) {
      const result = body(await service.request('computer', request, () => true));
      assert.equal(result.errorCode, 'UNSUPPORTED_CAPABILITY');
      assert.match(result.message, /not connected/i);
    }
    assert.equal(runtimes, 0); assert.equal(prompts, 0); assert.equal(executions, 0);
    const discovery = body(await service.request('computer', { ...request, server: 'cindy_helper', tool: 'host_services' }, () => true));
    assert.equal(discovery.ok, true, JSON.stringify(discovery));
    assert.deepEqual(discovery.services.find(s => s.group === 'computer'), {
      group: 'computer', server: 'cindy_computer', tools: [], available: false, reason: 'unsupported', declared: true,
    });
    assert.equal(service.services.list({ agentKind: 'codex', workingDir: '' }).find(s => s.group === 'computer').available, true);
    const agent = provider.toHostTools({ agentKind: 'codex', workingDir: '', sessionId: 'task' });
    try { assert.notEqual((await agent.call('list_windows', {})).isError, true); }
    finally { await agent.close(); }
    assert.equal(executions, 1);
    setHostToolProviders([provider], owner);
    const desktop = await handlePluginHostToolRequest('computer', request, () => true, {
      owner: () => owner, getGhost: () => ghost,
      createRuntime: (server, caller) => createHostToolRuntime(server, caller, '', 'r1'),
    });
    assert.notEqual(desktop.isError, true); assert.equal(executions, 2);
  } finally { service.close(); disconnect(); confirmations.close(); setHostToolProviders([], { ...owner, ownerGeneration: 2 }); clearCurrentDbClient(database); }
});

test('negotiated HTTP event streams deliver one live owner dialog without putting it in replay history', async t => {
  const confirmations = createHostConfirmations({ current: () => true });
  const events = createEventHub(), auth = createWebAuth();
  const cookie = `cindy_host_web=${auth.exchange(auth.pair())}`;
  const server = createHostServer({ token: 'fixture', instanceId: 'fixture', events, webAuth: auth,
    connectController: confirmations.connect, resolvePluginConfirmation: confirmations.resolve });
  let eventResponse;
  server.prependListener('request', (request, response) => {
    if (request.url.startsWith('/events')) eventResponse = response;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let connected, prompted, connection;
  const ready = new Promise(resolve => { connected = resolve; });
  const dialog = new Promise(resolve => { prompted = resolve; });
  const received = [];
  t.after(async () => { connection?.stop(); confirmations.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  connection = startHostEventStream({ confirmations: true,
    open: (query, signal) => fetch(`${base}/events${query}`, { headers: { cookie }, signal }),
    onState: state => { if (state.status === 'connected') connected(); },
    onEvent: event => { received.push(event); if (event.channel === 'ghosts:confirm-request') prompted(event.payload); },
  });
  await ready;
  // Unit with loopback HTTP: a legitimate business confirmation must report
  // refusal when the writer cannot deliver, even if a reply arrives. Host tool
  // calls no longer initiate this UI. Exercise both writable states without
  // timing-dependent slow-network sleeps or executing a command.
  const write = eventResponse.write;
  for (const initial of [1024 * 1024 + 1, 0]) {
    let buffered = initial;
    Object.defineProperty(eventResponse, 'writableLength', { configurable: true, get: () => buffered });
    eventResponse.write = function (data, ...rest) {
      if (String(data).includes('"type":"host_prompt"')) {
        const frame = JSON.parse(String(data).slice('data: '.length));
        if (frame.channel === 'ghosts:confirm-request') queueMicrotask(() => {
          confirmations.resolve(auth.caller(cookie), 'confirm', frame.payload.requestId, true);
        });
        buffered = 16 * 1024; return false;
      }
      return write.call(this, data, ...rest);
    };
    assert.equal(await confirmations.confirm({ ghostId: 'demo', ghostName: 'Demo', body: 'Confirm selected business operation?',
      confirmText: null, cancelText: null, danger: false }), false);
  }
  // A false write result whose buffer already drained can still deliver.
  Object.defineProperty(eventResponse, 'writableLength', { configurable: true, get: () => 0 });
  eventResponse.write = function (data, ...rest) { write.call(this, data, ...rest); return false; };
  const answer = confirmations.confirm({ ghostId: 'demo', ghostName: 'Demo', body: 'Run?',
    confirmText: null, cancelText: null, danger: false });
  const prompt = await dialog;
  assert.equal(events.currentSeq(), 0);
  assert.equal(events.getEventsSince(0).length, 0);
  const reply = await fetch(`${base}/api/ghosts/confirm/resolve`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: prompt.requestId, confirmed: true }) });
  assert.deepEqual(await reply.json(), { handled: true });
  assert.equal(await answer, true);
  assert.equal(received[0].type, 'plugin_push');
});

// Integration: the Node provider previously exposed no project callbacks. Exercise
// its actual MCP dispatch, shared core, isolated SQLite and temporary directories;
// no Electron shim, credentials, Git service or real user paths are involved.
test('Node AI tools create, inspect and edit the complete project profile in the current owner', async t => {
  const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'host-project-tools-')));
  configureHostOwner({ userDataDir: profile, ownerId: 'projects-owner' });
  const sqlite = new Database(':memory:');
  for (const table of [sessions, botSessionLinks, botProfiles, projectAliases, recentWorkdirs]) {
    sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${Object.values(getTableColumns(table)).map(column =>
      `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`).join(',')})`);
  }
  sqlite.exec("INSERT INTO sessions(id,title,source,status,workspace_kind,created_at,updated_at) VALUES ('task','Task','desktop','active','dialogue',1,1)");
  const db = createDbClientForHandle({ db: sqlite, drizzle: drizzle(sqlite) });
  setCurrentDbClient(db, 'projects-owner');
  const root = path.join(profile, 'projects'), first = path.join(profile, 'first'), second = path.join(profile, 'second');
  await Promise.all([root, first, second].map(dir => fs.mkdir(dir)));
  await writeProjectsRootDirectory(root);
  let current = true;
  const changes = [];
  const confirmations = createHostConfirmations({ current: () => current });
  const service = createHostToolService({ profileDir: profile, ownerId: 'projects-owner', current: () => current,
    owner: () => getActiveDataOwnerPushStamp(), deviceId: () => 'this-host', onProjectsChanged: catalogChanged => { changes.push(catalogChanged); },
    getGhost: () => null, getSession: () => undefined, confirmations, t: key => key,
    taskActions: { input: () => ({ key: 'input', ownerInput: true, boundary: 'input' }) },
  });
  const runtime = service.providers.find(provider => provider.name === 'cindy_helper').toHostTools({
    agentKind: 'codex', workingDir: profile, sessionId: 'task' });
  t.after(async () => {
    await runtime.close(); service.close(); confirmations.close(); clearCurrentDbClient(db); sqlite.close();
    commitVolatileAppSession('signed-out', null, true);
    await fs.rm(profile, { recursive: true, force: true });
  });
  const body = result => JSON.parse(result.content.find(item => item.type === 'text').text);
  const call = async (name, args) => body(await runtime.call(name, args));
  const discovery = { tools: runtime.list() };
  for (const name of ['create_project', 'list_projects', 'get_project_info', 'get_project_icon', 'update_project_info', 'rename_project', 'remove_project'])
    assert.ok(discovery.tools.some(tool => tool.name === name), name);
  const created = await call('create_project', { name: 'Demo', icon: '🌿', directories: [{ path: first }, { path: second }], device: 'this-host' });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.device, 'this-host');
  const normalized = value => value.replace(/\\/g, '/');
  assert.equal(created.project_key, `local:${normalized(path.join(root, 'Demo'))}`);
  assert.equal((await fs.stat(created.working_dir)).isDirectory(), true);
  const project = await call('get_project_info', { project_key: created.project_key });
  assert.equal(project.project.name, 'Demo');
  assert.equal(project.project.icon, '🌿');
  assert.equal(project.project.main_directory, created.working_dir);
  assert.deepEqual(project.project.directories, [{ path: first, access: 'write' }, { path: second, access: 'write' }]);
  const saved = await call('update_project_info', { project_key: created.project_key, field: 'profile',
    value: { name: 'Updated', icon: 'symbol:Code', directories: [{ path: second, access: 'read' }, { path: first, access: 'write' }] } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const edited = await call('get_project_info', { project_key: created.project_key });
  assert.equal(edited.project.name, 'Updated');
  assert.deepEqual(edited.project.directories, [{ path: second, access: 'read' }, { path: first, access: 'write' }]);
  assert.deepEqual(changes, [true, false], 'metadata changes do not rescan the directory catalog');
  const list = await call('list_projects', {});
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.ok(list.projects.some(item => item.working_dir === created.working_dir));
  assert.equal((await call('update_project_info', { project_key: created.project_key, field: 'profile', value: { directories: [] } })).ok, true);
  assert.deepEqual((await call('get_project_info', { project_key: created.project_key })).project.directories, []);
  current = false;
  const stale = await call('update_project_info', { project_key: created.project_key, field: 'name', value: 'Wrong owner' });
  assert.equal(stale.ok, false);
  assert.equal(sqlite.prepare('SELECT alias FROM project_aliases WHERE project_key = ?').get(created.project_key).alias, 'Updated');
});
