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
  return { tools, jobs, client, settings, stale: () => { current = false; },
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
test('delegated computer cleanup follows the execution client and respects the owner boundary', async t => {
  const sessions = new Set(['task-a']);
  const f = await fixture(t, 'user-browser', { call: async op => {
    assert.equal(op.method, 'computer.closeSession'); sessions.delete(op.sessionId);
  } });
  await f.tools.closeSession('task-a');
  assert.equal(sessions.has('task-a'), false);
  sessions.add('new-account-task'); f.stale();
  await assert.rejects(f.tools.closeSession('new-account-task'), /OWNER_CHANGED/);
  assert.equal(sessions.has('new-account-task'), true);
});
