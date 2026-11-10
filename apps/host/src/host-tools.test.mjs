import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostConfirmations } from './host-confirmations.ts';
import { createHostToolService } from './agent/host-tools.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { createHostServer } from './server.mjs';
import { createWebAuth } from './web-auth.mjs';
import { createEventHub } from './events.mjs';
import { startHostEventStream } from '@cindy/maker-shared/host-event-stream';

// Unit: an installed plugin has no task to attach approval to. Reuse the Host's
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

// Existing gateway tests exercise Desktop ports; this enters Node's production
// provider assembly, receipt writer and the same helper registry. Minimal input:
// one declared terminal group with no first-use approval. No PTY is spawned.
test('Node provider assembly preserves first-use approval, explicit retry and per-call refusal', async () => {
  const database = { drizzle: {} };
  setCurrentDbClient(database, 'owner');
  const ghost = { enabled: true, dir: '/fixture/demo', approvedHostToolGroups: [],
    approval: { state: 'approved', revision: 'r1' },
    manifest: { schemaVersion: 3, id: 'demo', name: 'Demo', version: '1.0.0', kind: 'chip', entry: 'main.js',
      agent: { hostTools: ['terminal'] } } };
  const confirmations = createHostConfirmations({ current: () => true });
  let deliver;
  const nextEvent = () => new Promise(resolve => { deliver = resolve; });
  const disconnect = confirmations.connect('web:owner', event => { if (event.channel.endsWith('request')) deliver?.(event); return true; });
  let writes = 0;
  const service = createHostToolService({ profileDir: '/fixture', ownerId: 'owner', current: () => true,
    owner: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }), getGhost: () => ghost,
    getSession: () => undefined, confirmations, t: key => key,
    manager: { approveTaskCapability: async (id, revision, current, capability) => {
      assert.equal(id, 'demo'); assert.equal(revision, 'r1'); assert.equal(current(), true);
      assert.equal(capability, 'host-tools:terminal'); writes++;
      ghost.approvedHostToolGroups.push('terminal'); return true;
    } },
  });
  const call = (tool, args = {}) => service.request('demo', { type: 'host-tool-request', server: 'cindy_helper', tool, args }, () => true);
  const body = result => JSON.parse(result.content.find(item => item.type === 'text').text);
  try {
    let event = nextEvent();
    const refused = call('terminal_list');
    const first = await event;
    assert.equal(first.channel, 'ghosts:install-consent:request');
    assert.equal(first.payload.facts.added[0].key, 'agent:host-tools:terminal');
    assert.equal(confirmations.resolve('web:owner', 'install', first.payload.requestId, false), true);
    assert.equal(body(await refused).errorCode, 'PERMISSION_DENIED');
    assert.equal(body(await call('terminal_list')).errorCode, 'PERMISSION_DENIED');
    assert.equal(writes, 0);
    event = nextEvent();
    const retry = service.approveGroup('demo', 'terminal', () => true, true);
    const requested = await event;
    confirmations.resolve('web:owner', 'install', requested.payload.requestId, true);
    assert.equal(await retry, true); assert.equal(writes, 1);
    assert.deepEqual(body(await call('terminal_list')).jobs, []);
    event = nextEvent();
    const command = call('terminal_start', { program: { command: 'fixture-command', args: ['value'] } });
    const prompt = await event;
    assert.equal(prompt.channel, 'ghosts:confirm-request');
    assert.match(prompt.payload.body, /fixture-command/);
    confirmations.resolve('web:owner', 'confirm', prompt.payload.requestId, false);
    assert.equal(body(await command).errorCode, 'PERMISSION_DENIED');
    assert.deepEqual(body(await call('terminal_list')).jobs, []);
  } finally { disconnect(); confirmations.close(); service.close(); clearCurrentDbClient(database); }
});

test('negotiated HTTP event streams deliver one live owner dialog without putting it in replay history', async t => {
  const confirmations = createHostConfirmations({ current: () => true });
  const events = createEventHub(), auth = createWebAuth();
  const cookie = `cindy_host_web=${auth.exchange(auth.pair())}`;
  const server = createHostServer({ token: 'fixture', instanceId: 'fixture', events, webAuth: auth,
    connectController: confirmations.connect, resolvePluginConfirmation: confirmations.resolve });
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
