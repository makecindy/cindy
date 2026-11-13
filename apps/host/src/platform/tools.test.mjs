// Integration tier: production Host tools, MCP server and browser router. Only
// the extension transport/OS facts are faked; no real Chrome, input or credentials.
// Regression: rebuilding a UI must not rebuild targets, and a stale owner must
// not start or receive work. Missing platform ports never force another backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHostPlatformTools } from './tools.ts';
import { createHostToolService } from '../agent/host-tools.ts';
import { createHostConfirmations } from '../host-confirmations.ts';
import { createPlatformClientHandoff } from './client-handoff.mjs';
import { createHostService } from '../service.mjs';
import { configureHostOwner } from '../agent/claude-auth.mjs';
import { createBrowserBackendSettingsStore } from '../../../desktop/src/main/browser-backend-settings-store.ts';
import { CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY } from '../../../desktop/src/main/mcp-integrations/codexBuiltinToolPolicy.ts';
const require = createRequire(new URL('../../../desktop/package.json', import.meta.url));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

async function fixture(t, kind = 'user-browser', platformClient) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-platform-unit-'));
  configureHostOwner({ userDataDir: profileDir, ownerId: 'fixture-owner' });
  const settings = createBrowserBackendSettingsStore(() => profileDir);
  settings.writeBrowserBackendKind(kind);
  let current = true;
  const jobs = [];
  const clients = [{ id: 'fixture-browser', connected: true, browser: 'chrome', version: '0.4.43', protocolVersion: '0.4.13' }];
  let answer = async () => ({ ok: true, tabs: [{ id: 7, url: 'https://example.test/retained', title: 'Retained' }] });
  const control = { ghostId: 'test-browser', instanceId: '_root__test-browser', pluginName: 'Test browser', bridge: {
    connectedClients: () => clients,
    status: async () => ({ ok: true, clients }),
    act: async (action, payload) => { jobs.push({ action, payload }); return answer(action, payload); },
  } };
  let powerStarts = 0, powerClosed = 0, refreshes = 0;
  const tools = createHostPlatformTools({ profileDir, client: platformClient,
    assertCurrent: () => { if (!current) throw new Error('PLUGIN_OWNER_CHANGED'); },
    secretIo: { readStrict: () => null, write: () => { throw new Error('No credentials in this fixture'); } },
    browserExtensions: { getPageControl: () => control, getPageControlUnavailableReason: () => 'plugin-missing' },
    uploadRoots: async () => [],
    createPowerMonitor: async () => { powerStarts++; return {
      refresh: async () => { refreshes++; }, assertAvailable: () => {},
      getSystemIdleTime: () => 100, getSystemIdleState: () => 'locked', on: () => {},
      close: async () => { powerClosed++; },
    }; },
  });
  t.after(async () => { await tools.close(); await fs.rm(profileDir, { recursive: true, force: true }); });
  async function client(sessionId) {
    const provider = tools.providers.find(p => p.name === 'cindy_browser');
    const ctx = { sessionId, agentKind: 'claude-code' };
    assert.equal(provider.isEnabled(ctx), true);
    const { instance } = provider.toClaudeSdkConfig(ctx);
    const client = new Client({ name: 'platform-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), instance.connect(b)]);
    t.after(async () => { await client.close(); await instance.close(); });
    return client;
  }
  return { tools, jobs, client, settings, profileDir, stale: () => { current = false; },
    answer: callback => { answer = callback; }, powerFacts: () => ({ powerStarts, powerClosed, refreshes }) };
}

const tabs = client => client.callTool({ name: 'call_tool', arguments: { name: 'browser', args: { action: 'tabs' } } });

test('new MCP attachment sees the same browser target without recreating the backend', async t => {
  const f = await fixture(t);
  const a = await f.client('task-a');
  const first = await tabs(a);
  assert.equal(first.isError, false);
  assert.match(JSON.stringify(first), /https:\/\/example.test\/retained/);
  await a.close();
  const b = await f.client('task-a');
  const second = await tabs(b);
  assert.deepEqual(second, first);
  assert.equal(f.jobs.length, 2);
  assert.equal(f.settings.readBrowserBackendSettings().kind, 'user-browser');
  assert.equal(f.tools.clientHandoffReady, false);
});

// Integration, #9825 / architecture-invariants §5: the upstream Node platform
// providers must also reach the plugin gateway. Existing tests only attached an
// Agent client. One approved browser call must use that same retained target.
test('plugin gateway and Agent attachment share the supplied Node browser provider', async t => {
  const f = await fixture(t);
  const ghost = { enabled: true, dir: '/fixture/browser', approvedHostToolGroups: ['browser'],
    approval: { state: 'approved', revision: 'r1' }, manifest: { id: 'browser', name: 'Browser', agent: { hostTools: ['browser'] } } };
  const confirmations = createHostConfirmations({ current: () => true });
  const service = createHostToolService({ profileDir: f.profileDir, ownerId: 'fixture-owner', current: () => true,
    owner: () => ({ dataOwnerId: 'fixture-owner', ownerGeneration: 1 }), getGhost: () => ghost,
    getSession: () => undefined, manager: {}, confirmations, t: key => key });
  service.providers.push(...f.tools.providers);
  service.services.replace(service.providers);
  t.after(() => { service.close(); confirmations.close(); });
  const agent = await f.client('task-a');
  const expected = await tabs(agent);
  const call = () => service.request('browser', { type: 'host-tool-request', server: 'cindy_browser',
    tool: 'browser', args: { action: 'tabs' } }, () => true);
  assert.deepEqual(await call(), expected);
  assert.equal(f.jobs.length, 2);
  ghost.enabled = false;
  assert.match(JSON.stringify(await call()), /PERMISSION_DENIED/);
  assert.equal(f.jobs.length, 2);
});

test('owner boundary drops an in-flight browser result and refuses later dispatch', async t => {
  const f = await fixture(t);
  const a = await f.client('task-a');
  let finish;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  f.answer(() => { began(); return new Promise(resolve => { finish = resolve; }); });
  const pending = tabs(a);
  await started;
  f.stale();
  finish({ ok: true, tabs: [{ id: 7, url: 'https://example.test/private-result' }] });
  const result = await pending;
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /private-result/);
  assert.equal((await tabs(a)).isError, true);
  // This operation bypasses runtime.call: protecting only page dispatch leaves
  // old MCP attachments able to mutate the new account's browser preferences.
  const switched = await a.callTool({ name: 'call_tool', arguments: {
    name: 'browser', args: { action: 'setBackend', backend: 'external' },
  } });
  assert.equal(switched.isError, true);
  assert.equal(f.settings.readBrowserBackendSettings().kind, 'user-browser');
  assert.equal(f.jobs.length, 1);
});

test('computer OS worker is lazy, shared across attachments and disposed only by Host', async t => {
  const f = await fixture(t);
  assert.equal(f.powerFacts().powerStarts, 0);
  assert.deepEqual(await f.tools.computer.getComputerMcpDeps().describeDesktop(), { screen_locked: true });
  assert.deepEqual(await f.tools.computer.getComputerMcpDeps().describeDesktop(), { screen_locked: true });
  assert.deepEqual(f.powerFacts(), { powerStarts: 1, refreshes: 2, powerClosed: 0 });
  await f.tools.close();
  assert.equal(f.powerFacts().powerClosed, 1);
  await assert.rejects(f.tools.computer.getComputerMcpDeps().describeDesktop(), /CLOSED/);
});

test('frozen task policy and an unavailable embedded backend cannot be bypassed', async t => {
  const f = await fixture(t, 'rsb-webview');
  const provider = f.tools.providers.find(p => p.name === 'cindy_browser');
  assert.equal(provider.isEnabled({ agentKind: 'codex', vendorOptions: { [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['browser'] } }), false);
  const a = await f.client('task-a');
  const result = await tabs(a);
  assert.match(JSON.stringify(result), /persistent embedded browser is not connected/);
  assert.equal(f.settings.readBrowserBackendSettings().kind, 'rsb-webview');
  assert.equal(f.jobs.length, 0);
});


test('Host refuses foreground and background writes before opening a native driver session', async t => {
  const f = await fixture(t);
  for (const delivery_mode of ['foreground', 'background']) {
    await assert.rejects(f.tools.computer.callComputerDriverTool('click', { delivery_mode, pid: 42 }, { sessionId: 'task-a' }), /INPUT_COORDINATOR_UNAVAILABLE/);
  }
  assert.equal(f.powerFacts().powerStarts, 0);
});


// Production closeSession previously cleaned only an unused Host-side driver.
// A delegated task must release its actual client session, and an old account
// must not send cleanup into the new account's executor.
test('delegated computer cleanup never waits for or reaches a replacement client', async t => {
  const gate = createPlatformClientHandoff({ assertCurrent() {} });
  t.after(() => gate.close());
  const calls = [];
  const f = await fixture(t, 'user-browser', gate);
  // No client, no computer use: close is a no-op, not an undispatched request.
  await f.tools.closeSession('unused');
  assert.equal(gate.status().waiting, 0);
  const identity = { id: 'client-a', pid: 42 };
  gate.attach({ ...identity, call: async op => { calls.push(op); }, canDetach: async () => true, resume: async () => true });
  await gate.call({ method: 'computer.call' }, { sessionId: 'task-a' });
  await f.tools.closeSession('task-a');
  assert.equal(calls.at(-1).method, 'computer.closeSession');
  await gate.call({ method: 'computer.call' }, { sessionId: 'task-paused' });
  await gate.prepare(identity);
  await f.tools.closeSession('task-paused');
  assert.equal(gate.status().waiting, 0);
  await gate.cancel(identity);
  await gate.call({ method: 'computer.call' }, { sessionId: 'task-lost' });
  gate.lost(identity);
  await f.tools.closeSession('task-lost');
  assert.equal(gate.status().waiting, 0);
  f.stale();
  await assert.rejects(f.tools.closeSession('new-account-task'), /OWNER_CHANGED/);
});

// Real service + production browser controller/MCP. A settings response must
// change the executor used by the very next task, not just a settings file.
test('Host browser settings change the active task backend and reject stale owners', async t => {
  const f = await fixture(t, 'rsb-webview');
  const service = createHostService({ browserBackend: (handler, payload) => f.tools.browserSettings[handler](undefined, payload) });
  const a = await f.client('settings-task');
  const before = await tabs(a);
  assert.match(JSON.stringify(before), /persistent embedded browser is not connected/);
  const state = () => service('/api/browser-backend/get-state');
  assert.equal((await state()).body.active, 'rsb-webview');
  await assert.rejects(service('/api/browser-backend/set-kind', { kind: 'invalid' }));
  const changed = await service('/api/browser-backend/set-kind', { kind: 'user-browser' });
  assert.deepEqual(changed.body, { ok: true, active: 'user-browser' });
  assert.equal((await state()).body.active, 'user-browser');
  assert.equal((await tabs(a)).isError, false);
  assert.equal(f.jobs.length, 1);
  f.stale();
  await assert.rejects(service('/api/browser-backend/set-kind', { kind: 'external' }), /OWNER_CHANGED/);
  assert.equal(createBrowserBackendSettingsStore(() => f.profileDir).readBrowserBackendSettings().kind, 'user-browser');
});

// Production controller + dispatch gate: switching backend disposes its actual
// executor, and disconnect/replacement never redirects disposal into a new one.
test('embedded backend disposal follows the executing window without waiting for replacements', async t => {
  const gate = createPlatformClientHandoff({ assertCurrent() {} });
  t.after(() => gate.close());
  const methods = [];
  const identity = { id: 'old', pid: 42 };
  gate.attach({ ...identity, canDetach: async () => true, resume: async () => true,
    call: async op => { methods.push(op.method); return { ok: true, tabs: [] }; } });
  const f = await fixture(t, 'rsb-webview', gate);
  const a = await f.client('task');
  assert.equal((await tabs(a)).isError, false);
  await f.tools.browserSettings.setKind(undefined, { kind: 'user-browser' });
  assert.deepEqual(methods, ['browser.call', 'browser.dispose']);
  await f.tools.browserSettings.setKind(undefined, { kind: 'rsb-webview' });
  await tabs(a);
  await gate.prepare(identity); gate.detach(identity);
  const replacement = [];
  gate.attach({ id: 'new', pid: 43, canDetach: async () => true, resume: async () => true,
    call: async op => { replacement.push(op.method); return { ok: true, tabs: [] }; } });
  await f.tools.browserSettings.setKind(undefined, { kind: 'user-browser' });
  assert.deepEqual(replacement, []);
  assert.equal(gate.status().waiting, 0);
});

// Same production gate for actions and probes: disposal must revoke every
// pending generation before an attach/resume can wake it (old code replayed it).
for (const frozen of [false, true]) for (const probe of [false, true]) {
  test(`disposed browser generation cannot dispatch after ${frozen ? 'resume' : 'attach'} (${probe ? 'probe' : 'call'})`, { timeout: 5000 }, async t => {
    const gate = createPlatformClientHandoff({ assertCurrent() {} });
    t.after(() => gate.close());
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const call = gate.call;
    gate.call = (...args) => { const pending = call(...args); entered(); return pending; };
    let dispatched = 0;
    const identity = { id: 'executor', pid: 42 };
    const executor = { ...identity, canDetach: async () => true, resume: async () => true,
      call: async () => { dispatched++; return { ok: true, tabs: [] }; } };
    if (frozen) { gate.attach(executor); await gate.prepare(identity); }
    const f = await fixture(t, 'rsb-webview', gate);
    const client = await f.client('task');
    const pending = probe ? f.tools.browserSettings.getHealth(undefined) : tabs(client);
    await started;
    assert.equal(gate.status().waiting, 1);
    await f.tools.browserSettings.setKind(undefined, { kind: 'user-browser' });
    await pending;
    assert.equal(gate.status().waiting, 0);
    if (frozen) await gate.cancel(identity); else gate.attach(executor);
    assert.equal(dispatched, 0);
  });
}
