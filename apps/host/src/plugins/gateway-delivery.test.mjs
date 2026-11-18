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

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const sandbox = createHeadlessPluginSandbox({ ownerKey: () => 'test', isCurrent: () => true,
    bridgeSource: '', pageHandler: () => () => new Response(), send: async () => ({ ok: true }) });
  t.after(() => sandbox.close());
  const log = [];
  const gateway = createSubscriptionGatewayReader({
    availableGhosts: () => [plugin], listGhostNotificationCandidates: async () => [plugin],
    findGhostNotificationTarget: id => id === installedGhostStoragePart(plugin) ? plugin : null,
    getGhostRuntime: () => ({ stateOf: () => 'running' }), sendToGhostLogic: sandbox.acceptGatewayDelivery,
    broadcastGhostWindowPush() {}, log: { info() {}, warn: (_message, fields) => log.push(fields.why) },
  }).getGhostSubscriptionGateway();
  const screen = () => gateway.screenControlPoint('will-tool-call', { sessionId: 'unit', engine: 'pi',
    phase: 'call', toolName: 'fixture', toolCallId: 'unit', input: {} },
  { pluginId: installedGhostStoragePart(plugin), onFailure: 'block' }, 100);
  return { sandbox, screen, log };
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
  const page = { on() {}, exposeBinding() {}, route() {}, goto() {}, addScriptTag() {}, isClosed: () => closed,
    evaluateHandle: async () => ({ async evaluate(_deliver, payload) {
      envelopes.push(payload);
      closed = true;
      throw Error('Page closed after submission');
    } }) };
  const browser = { once() {}, close() {}, isConnected: () => true, async newContext() { return {
    once() {}, on() {}, route() {}, routeWebSocket() {}, async close() {}, browser: () => browser, newPage: async () => page,
  }; } };
  t.mock.method(chromium, 'launch', async () => browser);
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
