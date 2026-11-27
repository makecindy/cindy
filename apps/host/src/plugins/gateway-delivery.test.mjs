// Integration (§3.2, release table 8i). Use the production logic-page adapter and shared gateway.
// Losing a page before admission and losing its reply after admission have different native-tool
// outcomes. Only the Playwright process boundary is replaced. No Chromium or profile is opened.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createHeadlessPluginSandbox } from './chromium-sandbox.ts';
import { createSubscriptionGatewayReader } from '../../../desktop/src/main/cindy-brain/runtimePluginHostCore.ts';
import { installedGhostStoragePart } from '../../../desktop/src/shared/pluginIdentity.ts';

const plugin = { manifest: { id: 'fixture', name: 'Fixture', version: '1.0.0', entry: 'main.js',
  subscribe: { hooks: ['will-tool-call'] } }, dir: '/fixture', enabled: true,
  approval: { state: 'approved', revision: 'one' } };

function createGateway(ghost, sendToGhostLogic, log = []) {
  return createSubscriptionGatewayReader({
    availableGhosts: () => [ghost], listGhostNotificationCandidates: async () => [ghost],
    findGhostNotificationTarget: id => id === installedGhostStoragePart(ghost) ? ghost : null,
    getGhostRuntime: () => ({ stateOf: () => 'running' }), sendToGhostLogic,
    broadcastGhostWindowPush() {}, log: { info() {}, warn: (_message, fields) => log.push(fields.why) },
  }).getGhostSubscriptionGateway();
}

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const sandbox = createHeadlessPluginSandbox({ ownerKey: () => 'test', isCurrent: () => true,
    bridgeSource: '', pageHandler: () => () => new Response(), send: async () => ({ ok: true }) });
  t.after(() => sandbox.close());
  const log = [];
  const gateway = createGateway(plugin, sandbox.acceptGatewayDelivery, log);
  const screen = () => gateway.screenControlPoint('will-tool-call', { sessionId: 'unit', engine: 'pi',
    phase: 'call', toolName: 'fixture', toolCallId: 'unit', input: {} },
  { pluginId: installedGhostStoragePart(plugin), onFailure: 'block' }, 100);
  return { sandbox, screen, log };
}

function stubLogicPage(t, evaluate, isClosed = () => false) {
  const page = { on() {}, exposeBinding() {}, route() {}, goto() {}, addScriptTag() {}, isClosed,
    evaluateHandle: async () => ({ evaluate }) };
  const browser = { once() {}, close() {}, isConnected: () => true, async newContext() { return {
    once() {}, on() {}, route() {}, routeWebSocket() {}, async close() {}, browser: () => browser, newPage: async () => page,
  }; } };
  t.mock.method(chromium, 'launch', async () => browser);
}

test('an absent logic page immediately applies the native hook delivery failure policy', async t => {
  const { screen, log } = fixture(t);
  let action;
  const answer = screen().then(result => { action = result.action; });
  await nextTurn();
  assert.equal(action, 'block');
  assert.ok(log.includes('deliver: PLUGIN_PAGE_UNAVAILABLE'));
  await answer;
});

test('a lost reply after logic-page admission follows the native hook deadline once', async t => {
  const { sandbox, screen, log } = fixture(t);
  const envelopes = [];
  let closed = false;
  stubLogicPage(t, async (_deliver, payload) => {
    envelopes.push(payload);
    closed = true;
    throw Error('Page closed after submission');
  }, () => closed);
  await sandbox.adapter.create(plugin).load();
  let action;
  const answer = screen().then(result => { action = result.action; });
  await nextTurn();
  assert.deepEqual(envelopes.map(event => event.name), ['will-tool-call']);
  t.mock.timers.tick(99);
  await nextTurn();
  assert.equal(action, undefined);
  t.mock.timers.tick(1);
  await answer;
  assert.equal(action, 'allow');
  assert.deepEqual(log, ['timeout']);
  assert.equal(envelopes.length, 1);
});

// §3.2, integration: compare both control points under all three task policies.
// Electron's port reports synchronous admission. A renderer error after that
// admission and a silent renderer both leave the original deadline pending.
test('Host control failure directions match the desktop gateway', async t => {
  const { sandbox } = fixture(t);
  let failureMode, delivered;
  stubLogicPage(t, async () => {
    delivered = true;
    if (failureMode === 'handler error') throw Error('fixture handler error');
  });
  const points = ['will-compose-context', 'will-start-turn'];
  const installed = { ...plugin, manifest: { ...plugin.manifest, subscribe: { hooks: points } } };
  await sandbox.adapter.create(installed).load();
  for (const point of points) {
    for (failureMode of ['silent', 'handler error', 'unsubscribed']) {
      const ghost = failureMode === 'unsubscribed'
        ? { ...installed, manifest: { ...installed.manifest, subscribe: { hooks: [] } } } : installed;
      for (const onFailure of ['allow', 'skip', 'block']) {
        delivered = false;
        const host = createGateway(ghost, sandbox.acceptGatewayDelivery);
        const desktop = createGateway(ghost, () => true);
        const data = { sessionId: 'matrix', text: 'input', route: { agentKind: 'pi', model: 'm', providerId: 'p' } };
        const target = { pluginId: installedGhostStoragePart(ghost), onFailure };
        const actual = host.screenControlPoint(point, data, target, 100);
        const expected = desktop.screenControlPoint(point, data, target, 100);
        await nextTurn();
        t.mock.timers.tick(100);
        assert.equal(delivered, failureMode !== 'unsubscribed', `${point}: ${failureMode}`);
        const baseline = await expected;
        assert.equal(baseline.action, onFailure);
        assert.deepEqual(await actual, baseline, `${point}: ${failureMode}: ${onFailure}`);
      }
    }
  }
});
