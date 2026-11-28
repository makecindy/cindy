// Host turn usage recording (release table row 13, 3d): the desktop's turn recorders fed by the Host's
// turn executor, over a real owner database.
//
// Test value
// - Production entry and observable result: turn-executor.mjs listen() with usage-recording.ts, as main.ts
//   wires them; the daily usage tables, the task row and the reply's agent_meta in a real owner database
//   (better-sqlite3, the desktop migrations), and the device-link pushes the Host forwards.
// - Rule: release table row 13 (3d, reviewer 2026-11-18): usage recorded exactly once per turn, late usage
//   kept, the account that started the turn, no request on the recording path, no per-party file, phase 1
//   usage pushes not forwarded.
// - Gap: the desktop's own tests drive these recorders through its pipeline with mocked sinks; nothing ran
//   them through the Host executor and its owner database.
// - Minimal failing input: one Claude done with usage after a reply (or a paired done after a terminal error).
// - Tier: Host unit (node:test), temporary profile and HOME; no network, no real account.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PUSH_FORWARD_ALLOWLIST } from '@cindy/device-link';
import { createTurnExecutor } from './turn-executor.mjs';
import { createHostUsageRecording } from './usage-recording.ts';
import { PHASE1_UNFORWARDED_USAGE_CHANNELS, INTENTIONALLY_FORWARDED_USAGE_CHANNELS, withoutPhaseOneUsagePushes } from './usage-push-channels.ts';
import { createHostMessageStore } from '../message-store.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { openOwnerDatabase } from '../../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { setCurrentDbClient, clearCurrentDbClient, getCurrentDbClientSnapshot } from '../../../desktop/src/main/localDb/client/current.ts';
import { bindHostCompanyReporting } from '../company-token-reporting.ts';
import { companyExecutionReporting, startCompanyUsage } from '../../../desktop/src/main/usage/companyTokenFacts.ts';
import { getActiveCatalog, setActiveCatalog } from '../../../desktop/src/main/maker-host/active-catalog.ts';
import { setSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.ts';
import * as broadcastTap from '../../../desktop/src/main/device-link/broadcast-tap.ts';
import { recordSessionTurnSpend } from '../../../desktop/src/main/sessionSpendBroadcasterCore.ts';
import { setActiveLedgerCurrency } from '../../../desktop/src/main/usage/ledgerCurrency.ts';
import { hostRuntimeLayout } from '../runtime-layout.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-usage-recording-')));
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, shared: process.env.XDT_OFFICIAL_SHARED_PROFILE };
process.env.HOME = path.join(root, 'home');
process.env.USERPROFILE = path.join(root, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
// A fixture profile: the development guard against migrating the official shared profile is lifted to open it.
delete process.env.XDT_OFFICIAL_SHARED_PROFILE;

// Outbound requests on the recording path fail the test (case 10).
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls += 1; throw new Error('no request on the usage recording path'); };

configureAppDataDir(path.join(root, 'app-data'));
configureHostOwner({ userDataDir: root, ownerId: 'usage-a' });
const layout = hostRuntimeLayout();
async function openOwner(ownerId) {
  const opened = await openOwnerDatabase({ userDataDir: root, ownerId, isPackaged: false,
    drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath });
  return { sqlite: opened.db, client: createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() }) };
}
const ownerA = await openOwner('usage-a');
const ownerB = await openOwner('usage-b');
const useOwner = owner => { clearCurrentDbClient(); setCurrentDbClient(owner.client, owner === ownerA ? 'usage-a' : 'usage-b'); };
useOwner(ownerA);
// The account's ledger currency, as a model catalog sync sets it (usage/modelPricingCore.ts).
setActiveLedgerCurrency('USD');

let profileHeld = false;
let gatewayPricing = null;
const usage = createHostUsageRecording({
  pricing: { getGatewayModelPricing: async () => gatewayPricing, getGatewayModelPricingForModel: async () => gatewayPricing,
    getGatewayAccountCurrency: () => 'USD' },
  isOpenAiSubscriptionProviderId: () => false,
  readGatewayKey: () => 'fixture-gateway-key',
  codexProxyAuthInjection: () => 'env-key',
  isProfileHeld: () => profileHeld,
});
after(async () => {
  usage.close();
  clearCurrentDbClient();
  await ownerA.client.dispose();
  await ownerB.client.dispose();
  globalThis.fetch = realFetch;
  for (const [key, value] of [['HOME', savedEnv.HOME], ['USERPROFILE', savedEnv.USERPROFILE], ['XDT_OFFICIAL_SHARED_PROFILE', savedEnv.shared]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  // Windows cannot unlink either database while its SQLite handle is open.
  assert.equal(ownerA.sqlite.open, false);
  assert.equal(ownerB.sqlite.open, false);
  fs.rmSync(root, { recursive: true, force: true });
});

let taskSeq = 0;
/** A task in both owner databases, a fake runtime for it and a Host turn executor wired as main.ts does. */
function harness({ agentKind = 'claude-code', provider = 'fixture-api', failFirstAssistantRow = false } = {}) {
  const id = `task-${++taskSeq}`;
  for (const owner of [ownerA, ownerB]) {
    owner.sqlite.prepare(`INSERT INTO sessions(id,source,status,created_at,updated_at,model) VALUES (?, 'desktop', 'active', 1, 1, 'claude-sonnet-4-6')`).run(id);
  }
  setSessionProvider(id, provider);
  const listeners = new Set();
  let generation = 1;
  const session = {
    id, instanceId: `runtime-${id}`, agentKind, remoteHostId: null, agentDeviceId: null, workDir: root,
    getTurnGeneration: () => generation, isTurnRunning: () => false,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    holdEventStream() {}, async abort() {},
  };
  const emit = event => { for (const listener of [...listeners]) listener({ sessionTurnGeneration: generation, ...event }); };
  const store = createHostMessageStore({ getOwner: getCurrentDbClientSnapshot, publish() {} });
  // A failing reply write pauses the task's write queue (messagePersistBroadcaster.ts failedWrites).
  let failAssistant = failFirstAssistantRow;
  const persistMessage = async (sid, input, options) => {
    if (failAssistant && input.role === 'assistant') { failAssistant = false; throw new Error('disk full'); }
    return store(sid, input, options);
  };
  const persistenceErrors = [];
  let runtimeOwner = null;
  const maker = { getSession: sid => (sid === id ? session : null), async closeSession() {} };
  const executor = createTurnExecutor({
    getMaker: () => maker,
    assertCurrent() { if (runtimeOwner === null) runtimeOwner = getCurrentDbClientSnapshot(); if (runtimeOwner !== getCurrentDbClientSnapshot()) throw new Error('input runtime owner changed'); },
    isCurrent: () => runtimeOwner !== null && runtimeOwner === getCurrentDbClientSnapshot(),
    isStoppingRuntime: () => false, hub: { publish() {} }, persistMessage,
    getOwner: getCurrentDbClientSnapshot,
    onPersistenceError: (_id, error) => { persistenceErrors.push(error); }, onTerminal() {}, markStarted: async () => {}, markEnded: async () => {},
    usage, runtimeOwner: () => runtimeOwner,
  });
  const base = { a: globalTotals(ownerA), b: globalTotals(ownerB) };
  return {
    id, session, emit, executor, persistenceErrors,
    /** What this test added to an owner's daily tables, and the task's row. */
    added(owner = ownerA) {
      const now = globalTotals(owner); const was = owner === ownerA ? base.a : base.b;
      const task = owner.sqlite.prepare('SELECT total_cost_amount AS amount, total_token_usage AS tokens FROM sessions WHERE id = ?').get(id);
      const sessionUsage = owner.sqlite.prepare('SELECT COALESCE(SUM(tokens),0) AS tokens FROM daily_session_usage WHERE session_id = ?').get(id);
      return { spend: round(now.spend - was.spend), model: { input: now.input - was.input, output: now.output - was.output },
        sessionTokens: sessionUsage.tokens, task: { amount: task.amount ?? 0, tokens: task.tokens ?? 0 } };
    },
    nextGeneration() { generation += 1; },
    begin: () => executor.beginHostTurn(id),
    reply(clientId, text = 'reply') { emit({ type: 'text', source: agentKind, data: { text, isFinal: true }, agentMeta: { uuid: clientId } }); },
    async settled() {
      for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));
      await usage.drain(); usage.open();
    },
  };
}

const claudeDone = (costUSD, inputTokens = 100, outputTokens = 20, extra = {}) => ({ type: 'done', source: 'claude-code', data: {
  total_cost_usd: costUSD, modelUsageCumulativeStartsAtZero: true,
  modelUsage: { 'claude-sonnet-4-6': { inputTokens, outputTokens, costUSD } }, ...extra } });

const round = value => Math.round(value * 1e6) / 1e6;
function globalTotals(owner) {
  const spend = owner.sqlite.prepare('SELECT COALESCE(SUM(cost_amount),0) AS amount FROM daily_spend').get().amount;
  const model = owner.sqlite.prepare('SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output FROM daily_model_usage').get();
  const sessionTokens = owner.sqlite.prepare('SELECT COALESCE(SUM(tokens),0) AS tokens FROM daily_session_usage').get().tokens;
  return { spend, input: model.input, output: model.output, sessionTokens };
}
function turnCostOf(owner, id) {
  return Object.fromEntries(owner.sqlite.prepare(`SELECT client_id AS clientId, agent_meta AS meta FROM messages WHERE session_id = ? AND role = 'assistant'`)
    .all(id).map(row => [row.clientId, JSON.parse(row.meta ?? '{}').turnCost?.amount ?? null]));
}

const segment = { id: 'pi:1', model: 'test-model', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0 };
const piReceipt = settlementId => ({ settlementId, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0,
  receipts: [{ ...segment, id: `pi:${settlementId}`, recordedAt: Date.now() }] });
const xdQuote = { xd: { 'test-model': { providerId: 'xd', modelId: 'test-model', currency: 'USD', source: 'gateway',
  inputPerMtok: 1000, outputPerMtok: 2000, cacheReadPerMtok: 100 } } };
const receiptRows = (owner, id) => owner.sqlite.prepare('SELECT priced FROM pi_usage_receipts WHERE session_id = ?').all(id);

// Case 1: one turn of each engine records once, where the desktop's recorders record it.
test('usage-recording: a Claude turn records its spend and tokens once, on its reply', async () => {
  const h = harness();
  await h.begin();
  h.emit({ type: 'status', source: 'claude-code', data: { isRunning: true } });
  h.reply('reply');
  h.emit(claudeDone(2));
  await h.settled();
  const t = h.added();
  assert.equal(t.task.amount, 2);
  assert.deepEqual(t.model, { input: 100, output: 20 });
  assert.equal(t.sessionTokens, 120);
  assert.deepEqual(Object.values(turnCostOf(ownerA, h.id)), [2]);
});

test('usage-recording: a Codex turn records its tokens once', async () => {
  const h = harness({ agentKind: 'codex' });
  await h.begin();
  h.emit({ type: 'status', source: 'codex', data: { isRunning: true } });
  h.reply('reply');
  h.emit({ type: 'done', source: 'codex', data: { usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 10 } } });
  await h.settled();
  const t = h.added();
  assert.deepEqual(t.model, { input: 100, output: 20 });
  assert.equal(t.task.tokens, 130);
});

test('usage-recording: a Pi turn records its request receipt once', async () => {
  const h = harness({ agentKind: 'pi' });
  await h.begin();
  h.emit({ type: 'status', source: 'pi', data: { isRunning: true } });
  const usageFacts = piReceipt('pi-turn');
  h.emit({ type: 'account_usage', source: 'pi', data: { type: 'pi/request_usage', usage: usageFacts } });
  h.reply('reply');
  h.emit({ type: 'done', source: 'pi', data: { usage: usageFacts } });
  await h.settled();
  assert.equal(receiptRows(ownerA, h.id).length, 1);
  assert.deepEqual(h.added().model, { input: 100, output: 20 });
});

// Case 1b: the turn cost write waits behind a reply write that failed (the task's queue paused); the queue's
// retry replays it outside any recording context, and it still lands once on the reply.
test('usage-recording: a turn cost queued behind a failed write lands once when the writes are retried', async () => {
  const h = harness({ failFirstAssistantRow: true });
  await h.begin();
  h.reply('paused');
  h.emit(claudeDone(2));
  await h.settled();
  assert.ok(h.persistenceErrors.length > 0, 'the reply write failed');
  assert.deepEqual(Object.values(turnCostOf(ownerA, h.id)), []);
  await h.executor.retryPersistence(h.id);
  await h.settled();
  assert.deepEqual(Object.values(turnCostOf(ownerA, h.id)), [2]);
  assert.equal(h.added().task.amount, 2);
});

// Case 2: an automatic resume continues the runtime; Claude's cumulative model usage is recorded as deltas.
test('usage-recording: a resumed turn adds only its own delta of the cumulative usage', async () => {
  const h = harness();
  await h.begin();
  h.reply('first');
  h.emit(claudeDone(2, 100, 20));
  await h.settled();
  await h.begin();
  h.reply('resumed');
  h.emit({ type: 'done', source: 'claude-code', data: { total_cost_usd: 5,
    modelUsage: { 'claude-sonnet-4-6': { inputTokens: 250, outputTokens: 50, costUSD: 5 } } } });
  await h.settled();
  const t = h.added();
  assert.equal(t.task.amount, 5);
  assert.deepEqual(t.model, { input: 250, output: 50 });
  assert.deepEqual(Object.values(turnCostOf(ownerA, h.id)).sort(), [2, 3]);
});

// Cases 3 and 4: a failed turn's usage comes on its paired done, after the Host's turn ended (:559); it is
// recorded once on the failed reply. A replay on a new runtime is a turn of its own.
test('usage-recording: a failed turn records its paired done once, on the failed reply; its replay separately', async () => {
  const h = harness();
  await h.begin();
  h.reply('failed');
  h.emit({ type: 'error', source: 'claude-code', data: { message: 'prompt is too long', isTerminal: true } });
  h.emit(claudeDone(2));
  await h.settled();
  const failedCost = turnCostOf(ownerA, h.id);
  assert.deepEqual(Object.values(failedCost), [2]);
  await h.executor.close(h.id);
  // The replay's new runtime is wired with the task's provider again (the close cleared it).
  setSessionProvider(h.id, 'fixture-api');
  h.nextGeneration();
  await h.begin();
  h.reply('replayed');
  h.emit(claudeDone(1.5, 40, 10));
  await h.settled();
  const t = h.added();
  assert.equal(t.task.amount, 3.5);
  assert.deepEqual(t.model, { input: 140, output: 30 });
  assert.deepEqual(Object.values(turnCostOf(ownerA, h.id)).sort(), [1.5, 2]);
});

// Case 5: a Claude continuation boundary does not settle; the product turn's usage lands on the last reply
// that carried output.
test('usage-recording: across a continuation boundary the turn cost lands once, on the last reply with output', async () => {
  const h = harness();
  await h.begin();
  h.reply('segment');
  h.emit({ ...claudeDone(2, 100, 20), turnContinuationId: 1 });
  h.emit({ type: 'done', source: 'claude-code', data: { total_cost_usd: 3,
    modelUsage: { 'claude-sonnet-4-6': { inputTokens: 150, outputTokens: 30, costUSD: 3 } } } });
  await h.settled();
  // The final segment's delta (1) lands on the reply the boundary kept; the task row has both segments.
  assert.deepEqual(Object.values(turnCostOf(ownerA, h.id)), [1]);
  assert.equal(h.added().task.amount, 3);
});

// Case 6: a background turn's done carries its own usage.
test('usage-recording: a background turn records its usage once', async () => {
  const h = harness();
  await h.begin();
  h.reply('foreground');
  h.emit(claudeDone(2));
  await h.settled();
  h.emit({ type: 'text', source: 'claude-code', turnScope: 'background', data: { text: 'background', isFinal: true } });
  h.emit({ ...claudeDone(4, 200, 40), data: { total_cost_usd: 4,
    modelUsage: { 'claude-sonnet-4-6': { inputTokens: 200, outputTokens: 40, costUSD: 4 } } }, turnScope: 'background' });
  await h.settled();
  assert.equal(h.added().task.amount, 4);
});

// Case 7: a stopped Codex turn's done carries partial usage: tokens once, no money without a quote.
test('usage-recording: an interrupted Codex turn records its tokens once and no money without a quote', async () => {
  const h = harness({ agentKind: 'codex' });
  await h.begin();
  h.reply('partial');
  h.emit({ type: 'done', source: 'codex', data: { raw: { id: 'turn', status: 'interrupted' },
    usage: { promptTokens: 30, completionTokens: 5 } } });
  await h.settled();
  const t = h.added();
  assert.deepEqual(t.model, { input: 30, output: 5 });
  assert.equal(t.task.amount ?? 0, 0);
});

// Case 8: late usage. A done after a stop ended the Host's turn is recorded; an earlier generation's late done
// does not take the next turn's reply.
test('usage-recording: a done after the turn was stopped is still recorded once', async () => {
  const h = harness({ agentKind: 'codex' });
  await h.begin();
  h.reply('stopped');
  await h.executor.abort(h.id);
  h.emit({ type: 'done', source: 'codex', data: { usage: { promptTokens: 30, completionTokens: 5 } } });
  await h.settled();
  assert.deepEqual(h.added().model, { input: 30, output: 5 });
});

test('usage-recording: a previous generation\'s late done stays off the next turn\'s reply', async () => {
  const h = harness();
  await h.begin();
  h.reply('failed');
  h.emit({ type: 'error', source: 'claude-code', data: { message: 'failed', isTerminal: true } });
  await h.settled();
  h.nextGeneration();
  await h.begin();
  h.reply('next');
  h.emit({ ...claudeDone(2), sessionTurnGeneration: 1 });
  await h.settled();
  const costs = turnCostOf(ownerA, h.id);
  const nextReply = ownerA.sqlite.prepare(`SELECT client_id AS id FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY rowid DESC LIMIT 1`).get(h.id).id;
  assert.equal(costs[nextReply], null);
  assert.equal(h.added().task.amount, 2);
});

// Case 9: the account that started the turn. Switch first, then the old turn's done; and a switch while the
// recorder still waits for the turn's model (the Codex model rows are written after it), before its writes.
test('usage-recording: an old turn\'s usage never reaches the next account\'s database', async () => {
  const before = globalTotals(ownerB);
  const first = harness();
  await first.begin();
  first.reply('old-a');
  useOwner(ownerB);
  first.emit(claudeDone(2));
  await first.settled();
  useOwner(ownerA);
  const second = harness({ agentKind: 'codex' });
  await second.begin();
  second.reply('old-b');
  second.emit({ type: 'done', source: 'codex', data: { usage: { promptTokens: 30, completionTokens: 5 } } });
  useOwner(ownerB);
  await second.settled();
  useOwner(ownerA);
  assert.deepEqual(globalTotals(ownerB), before);
  for (const h of [first, second]) assert.equal(h.added(ownerB).task.amount, 0);
});

test('usage-recording: a write port called outside a task context is dropped', async () => {
  const { recordTurnSpend } = await import('../../../desktop/src/main/maker-ipc/turnUsagePorts.ts');
  const before = globalTotals(ownerA).spend;
  await recordTurnSpend({ amount: 9, currency: 'USD', approximate: false, kind: 'actual-cost' });
  assert.equal(globalTotals(ownerA).spend, before);
});

// Case 10: nothing on the recording path asks a server (the four quota refreshes are bound empty).
test('usage-recording: no request was made on the recording path', () => {
  assert.equal(fetchCalls, 0);
});

// Case 11: while a desktop uses the profile, a turn that is allowed to finish still writes its usage, and so
// does its late paired done.
test('usage-recording: during the profile hold a finishing turn and its late done are recorded', async () => {
  profileHeld = true;
  try {
    const h = harness();
    await h.begin();
    h.reply('held');
    h.emit({ type: 'error', source: 'claude-code', data: { message: 'failed', isTerminal: true } });
    h.emit(claudeDone(2));
    await h.settled();
    assert.equal(h.added().task.amount, 2);
  } finally { profileHeld = false; }
});

// Case 13: closing the runtime clears its usage tables; a new runtime's first cumulative report is only its baseline.
test('usage-recording: a new runtime after close starts its cumulative baseline again', async () => {
  const h = harness();
  await h.begin();
  h.reply('first');
  h.emit({ type: 'done', source: 'claude-code', data: { total_cost_usd: 2 } });
  await h.settled();
  await h.executor.close(h.id);
  setSessionProvider(h.id, 'fixture-api');
  h.nextGeneration();
  await h.begin();
  h.reply('second');
  h.emit({ type: 'done', source: 'claude-code', data: { total_cost_usd: 3 } });
  await h.settled();
  assert.equal(h.added().task.amount ?? 0, 0);
});

// Case 14: phase 1 usage pushes stay off the device-link; other pushes go as before. Every forwardable
// `usage:` channel is classified, so a new one cannot slip through.
test('usage-recording: the device-link tap drops the phase 1 usage channels and forwards the rest', async () => {
  const usageChannels = [...PUSH_FORWARD_ALLOWLIST].filter(channel => channel.startsWith('usage:'));
  for (const channel of usageChannels) {
    assert.ok(PHASE1_UNFORWARDED_USAGE_CHANNELS.has(channel) !== INTENTIONALLY_FORWARDED_USAGE_CHANNELS.has(channel), channel);
  }
  for (const channel of [...PHASE1_UNFORWARDED_USAGE_CHANNELS, ...INTENTIONALLY_FORWARDED_USAGE_CHANNELS.keys()]) {
    assert.ok(PUSH_FORWARD_ALLOWLIST.has(channel), `${channel} is not forwardable at all`);
  }
  const forwarded = [];
  broadcastTap.setBroadcastTapListener(withoutPhaseOneUsagePushes((channel, payload) => { forwarded.push(channel); }));
  try {
    await recordSessionTurnSpend('task-1', { amount: 1, currency: 'USD', approximate: false, kind: 'actual-cost' });
    const other = [...PUSH_FORWARD_ALLOWLIST].find(channel => !channel.startsWith('usage:'));
    broadcastTap.tapWindowBroadcast(other, {});
    for (const channel of PHASE1_UNFORWARDED_USAGE_CHANNELS) broadcastTap.tapWindowBroadcast(channel, {});
    assert.deepEqual(forwarded, [other]);
  } finally { broadcastTap.setBroadcastTapListener(null); }
});

// Case 15: Pi receipts. A receipt without a price waits in its own account's database; it is priced once
// prices are back, not while a desktop uses the profile, and never in another account's database.
test('usage-recording: a pending Pi receipt is priced on retry, after the profile hold, in its own account only', async () => {
  const h = harness({ agentKind: 'pi', provider: 'xd' });
  await h.begin();
  h.emit({ type: 'account_usage', source: 'pi', data: { type: 'pi/request_usage', usage: piReceipt('pending') } });
  await h.settled();
  assert.deepEqual(receiptRows(ownerA, h.id).map(row => row.priced), [0]);
  gatewayPricing = xdQuote;
  try {
    profileHeld = true;
    await usage.retryPending();
    assert.deepEqual(receiptRows(ownerA, h.id).map(row => row.priced), [0]);
    useOwner(ownerB);
    profileHeld = false;
    usage.onProfileReleased();
    await usage.drain(); usage.open();
    assert.deepEqual(receiptRows(ownerA, h.id).map(row => row.priced), [0]);
    assert.deepEqual(h.added(ownerB), { spend: 0, model: { input: 0, output: 0 }, sessionTokens: 0, task: { amount: 0, tokens: 0 } });
    useOwner(ownerA);
    await usage.retryPending();
    await usage.drain(); usage.open();
    assert.deepEqual(receiptRows(ownerA, h.id).map(row => row.priced), [1]);
    assert.ok(h.added().task.amount > 0);
  } finally { gatewayPricing = null; profileHeld = false; useOwner(ownerA); }
});

test('usage-recording: the owner teardown waits for the Pi writes and starts no new recording', async () => {
  const h = harness({ agentKind: 'pi' });
  await h.begin();
  h.emit({ type: 'account_usage', source: 'pi', data: { type: 'pi/request_usage', usage: piReceipt('drained') } });
  await usage.drain();
  assert.equal(receiptRows(ownerA, h.id).length, 1);
  h.emit({ type: 'account_usage', source: 'pi', data: { type: 'pi/request_usage', usage: piReceipt('after-drain') } });
  await usage.drain();
  usage.open();
  assert.equal(receiptRows(ownerA, h.id).length, 1);
});

// Case 12: per-party usage (provider-usage-by-party.json) is not written in phase 1.
test('usage-recording: no per-party usage file was written', () => {
  const found = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else if (entry.name === 'provider-usage-by-party.json') found.push(full);
  } };
  walk(root);
  assert.deepEqual(found, []);
});

// An actual Host turn, SQLite and the disk outbox share the same synthetic owner. The only stub
// outside the existing executor fixture is the authenticated policy/participation transport.
test('Host reports the actual direct Codex route once and honors the active profile, consent and membership', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'enterprise-'));
  const preference = path.join(dir, 'analytics-settings.json');
  const outbox = path.join(dir, 'company-token-host', 'company-token-outbox.json');
  const list = () => fs.existsSync(outbox) ? JSON.parse(fs.readFileSync(outbox, 'utf8')).rows : [];
  const setConsent = enabled => fs.writeFileSync(preference, JSON.stringify({ privacyConsentAccepted: true, analyticsEnabled: enabled }));
  const catalog = getActiveCatalog();
  const sample = catalog.providers.find(provider => provider.id === 'openai');
  const source = (id, endpoint, subscription) => ({ ...sample, id, name: id,
    source: subscription ? 'organization' : 'user', access: { kind: subscription ? 'subscription' : 'api-key' },
    routing: { codex: { upstream: endpoint, authStrategy: subscription ? 'oauth-passthrough' : 'api-key-header' } } });
  const gateway = 'https://gateway.example.test';
  const model = 'gpt-test';
  const id = { orgId: 'org-test', member: 'usage-a', owner: 'test-originating-member', generation: 1,
    base: 'https://auth.example.test', device: 'test-host', token: 'fixture' };
  let owner = null;
  let writable = true;
  const calls = [];
  const host = bindHostCompanyReporting({
    directory: dir, identity: () => owner, reportBuild: true, canWrite: () => writable,
    definitivelyInactive: () => false, gatewayEndpoint: () => gateway,
    fetch: async (url, init) => {
      calls.push({ url, body: init.body && JSON.parse(init.body) });
      if (url === id.base + '/api/me') return Response.json({ passportId: 'fixture', identities: [],
        membership: { id: id.member, orgId: id.orgId, kind: 'org', role: 'member', displayName: 'Fixture',
          email: null, orgName: 'Synthetic', companyTokenReporting: { participating: true, models: [model], orgRevision: 1, memberRevision: 1 } } });
      assert.equal(url, id.base + '/api/orgs/org-test/company-token-reporting/participation');
      return Response.json({});
    },
  });
  const wait = async predicate => {
    const deadline = Date.now() + 5_000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate());
  };
  const turn = async (actualProvider, mode, remote = {}) => {
    const h = harness({ agentKind: 'codex', provider: 'fixture-subscription' });
    Object.assign(h.session, remote);
    await h.begin();
    h.emit({ type: 'status', source: 'codex', data: { isRunning: true } });
    h.reply('host-reply');
    h.emit({ type: 'done', source: 'codex', data: { usage: { promptTokens: 47, completionTokens: 8,
      cachedTokens: 4, cacheCreationTokens: 2, execution: { providerId: actualProvider, credentialMode: mode, model } } } });
    await h.settled();
    return h.added();
  };
  try {
    setActiveCatalog({ ...catalog, providers: [...catalog.providers,
      source('fixture-subscription', 'https://sub.example.test', true),
      source('fixture-byok', 'https://api.example.test', false),
      source('fixture-gateway-alias', gateway + '/v1', false)] });
    setConsent(true);
    host.resume();
    assert.deepEqual(calls, []);
    assert.ok(!fs.existsSync(path.dirname(outbox)));
    owner = id;
    host.resume();
    await wait(() => companyExecutionReporting()?.available() === true);
    assert.deepEqual((await turn('fixture-byok', 'api-key')).model, { input: 47, output: 8 });
    const expected = [{ model, day: new Date().toISOString().slice(0, 10), input: 47, output: 8, cacheRead: 4, cacheWrite: 2 }];
    assert.deepEqual(list(), expected);
    await turn('fixture-gateway-alias', 'api-key');
    await turn('fixture-byok', 'gateway-key');
    await turn('missing-provider', 'api-key');
    await turn('fixture-byok', 'api-key', { remoteHostId: 'test-executor' });
    await turn('fixture-byok', 'api-key', { agentDeviceId: 'test-executor' });
    assert.deepEqual(list(), expected);
    const prior = startCompanyUsage();
    writable = false;
    host.suspend();
    assert.equal(startCompanyUsage(), undefined);
    prior([{ model, input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }]);
    assert.deepEqual(list(), expected);
    writable = true;
    host.resume();
    await wait(() => companyExecutionReporting()?.available() === true);
    setConsent(false);
    await wait(() => calls.some(call => call.body?.participating === false));
    assert.deepEqual(list(), []);
    assert.equal(startCompanyUsage(), undefined);
    assert.ok(calls.every(call => call.url.endsWith('/api/me') || call.url.endsWith('/participation')));
  } finally {
    host.dispose();
    setActiveCatalog(catalog);
  }
});
