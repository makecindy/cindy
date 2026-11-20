import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished, vi } from 'vitest';
import { openOwnerDatabase } from '../localDb/startupCore.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import { createDbClientForHandle } from '../localDb/client/createDbClientForHandle.js';
import { clearCurrentDbClient, getCurrentDbClientSnapshot, setCurrentDbClient } from '../localDb/client/current.js';
import { configureUserDataDir } from '../userDataPath.js';
import { commitActiveAppSession, LOCAL_DATA_OWNER_ID, getActiveDataOwnerPushStamp } from '../appSessionState.js';
import { isDataOwnerPushCurrent, setDataOwnerGeneration } from '../../renderer/contexts/dataOwnerGeneration.js';
import { drainPersistQueue } from '../messagePersistBroadcaster.desktop.js';
import { BrowserWindow } from 'electron';
import * as mutations from '../localDb/messageMutations.js';
import * as pricing from '../usage/modelPricing.js';
import * as routeGuard from '../maker-host/model-route-guard-live.js';
import { setSessionProvider } from '../maker-host/session-provider-store.js';
import { setActiveLedgerCurrency, __resetActiveLedgerCurrencyForTesting } from '../usage/ledgerCurrency.js';
import * as turnDefaults from '../maker-ipc/turnUsageSessionDefaults.js';
import { Session, type AgentEvent, type AgentSessionHandle } from '@cindy/maker-core';
import { wireSessionToIpc } from '../maker-ipc/register.js';
import { setImmediate } from 'node:timers/promises';
import { readAgentTodayUsage, recordModelTurnUsage } from '../usageBroadcaster.js';

const noop = () => {};
const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => logger };

async function databases() {
  // These are dedicated temporary profiles, including in an embedded developer worktree.
  vi.stubEnv('XDT_OFFICIAL_SHARED_PROFILE', '0');
  onTestFinished(() => { vi.unstubAllEnvs(); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l340-'));
  configureUserDataDir(root);
  commitActiveAppSession('cloud', 'a');
  const drizzleDir = fileURLToPath(new URL('../../../drizzle/', import.meta.url));
  const vec = process.platform === 'darwin' ? 'vec0.dylib' : process.platform === 'win32' ? 'vec0.dll' : 'vec0.so';
  const sqliteVecExtPath = path.resolve(drizzleDir, '../native/sqlite-vec', process.platform + '-' + process.arch, vec);
  const handles: Array<Awaited<ReturnType<typeof openOwnerDatabase>>> = [];
  onTestFinished(() => {
    clearCurrentDbClient();
    for (const handle of handles) handle.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function open(ownerId: string) {
    const handle = await openOwnerDatabase({ userDataDir: root, ownerId, isPackaged: false, drizzleDir, sqliteVecExtPath });
    handles.push(handle);
    const client = createDbClientForHandle({ db: handle.db, drizzle: handle.drizzle });
    return { db: handle.db, client, activate: () => setCurrentDbClient(client, ownerId) };
  }
  const a = await open('a');
  const b = await open('b');
  a.activate();
  return { a, b, open };
}

function renewAppSession() {
  const original = commitActiveAppSession('cloud', 'a');
  const db = getCurrentDbClientSnapshot();
  const renewed = commitActiveAppSession('cloud', 'a', true);
  expect(renewed.dataOwnerId).toBe(original.dataOwnerId);
  expect(renewed.generation).toBe(original.generation + 1);
  expect(getCurrentDbClientSnapshot()).toBe(db);
}

async function codexTotal() {
  const value = await readAgentTodayUsage('codex');
  if (!('totalTokens' in value) || typeof value.totalTokens !== 'number') throw new Error('missing Codex token snapshot');
  return value.totalTokens;
}

function delayModelCommitAck(client: DbClient) {
  const committed = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const tx = client.tx.bind(client);
  client.tx = async <R>(name: string, args: unknown): Promise<R> => {
    const result = await tx<R>(name, args);
    if (name === 'usage.recordModelUsage') {
      committed.resolve();
      await resume.promise;
    }
    return result;
  };
  return { committed, resume };
}

function bindSession(id: string, agentKind: 'codex' | 'claude-code' | 'pi', beforeTurn?: (session: Session) => Promise<void>) {
  type Packet = { event: AgentEvent; consumed(): void };
  let next = Promise.withResolvers<Packet | null>();
  let running = false;
  const handle = {
    steer: async () => {},
    id, model: 'fixture', agentKind, send: async () => { running = true; },
    isTurnRunning: () => running, setInteractionResolver() {},
    close: async () => { next.resolve(null); },
    async *events() {
      while (true) {
        const packet = await next.promise;
        if (!packet) return;
        next = Promise.withResolvers<Packet | null>();
        yield packet.event;
        packet.consumed();
      }
    },
  } as unknown as AgentSessionHandle;
  const session = new Session({ id, agentKind, workDir: os.tmpdir(), handle, beforeTurn,
    capabilities: { sameTurnSteer: { supported: true } } as never, logger, turnStallMs: 0 });
  wireSessionToIpc(session);
  onTestFinished(async () => { next.resolve(null); await session.close(); });
  return {
    session,
    async send(vendorIdle = true) {
      expect((await session.send('test')).accepted).toBe(true);
      if (!vendorIdle) return;
      running = false; // The vendor may be idle before its terminal packet arrives.
    },
    deliver(event: AgentEvent) {
      const consumed = Promise.withResolvers<void>();
      next.resolve({ event, consumed: consumed.resolve });
      return consumed.promise; // Session has classified this packet and requested the next one.
    },
  };
}


// L340, desktop db tier. A provider completes an actual Session.send after the committed
// account changes. Both databases contain the same task ID. The old generation fence also
// dropped this receipt on a forced same-account renewal. Exercise the real recorder and SQL.
it.each(['codex', 'claude-code', 'pi'] as const)('settles %s against the account that started its turn', async kind => {
  const { a, b } = await databases();
  const id = randomUUID();
  for (const db of [a.db, b.db]) {
    db.prepare("INSERT INTO sessions(id,source,status,created_at,updated_at,model) VALUES (?,'desktop','active',1,1,'fixture')").run(id);
  }
  const turn = bindSession(id, kind);
  const finish = async (n: number) => {
    const data = kind === 'codex' ? { usage: { promptTokens: 7, completionTokens: 3 } }
      : kind === 'pi' ? { usage: { settlementId: String(n), receipts: [{ id: String(n), model: 'fixture',
        recordedAt: Date.now(), inputTokens: 7, outputTokens: 3, unpriced: true }] } }
      : { modelUsageCumulativeStartsAtZero: true,
        modelUsage: { fixture: { inputTokens: n * 7, outputTokens: n * 3, costUSD: 0 } } };
    await turn.deliver({ type: 'done', source: kind, data } as AgentEvent);
    await setImmediate();
  };
  const daily = (db: typeof a.db) => db.prepare('SELECT tokens FROM daily_session_usage WHERE session_id=?').pluck().all(id);
  const models = (db: typeof a.db) => db.prepare('SELECT SUM(input_tokens) + SUM(output_tokens) FROM daily_model_usage').pluck().get();
  await turn.send();
  await finish(1);
  expect(daily(a.db)).toEqual([10]);
  await turn.send();
  renewAppSession();
  await finish(2);
  expect.soft(daily(a.db)).toEqual([20]);
  expect.soft(models(a.db)).toBe(20);
  await turn.send();
  commitActiveAppSession('cloud', 'b');
  b.activate();
  await finish(3);
  expect(daily(b.db)).toEqual([]);
  expect(models(b.db)).toBeNull();
});


// Desktop db tier. Neither an identical task id nor reconnecting the old client may
// restore a turn after a real mode/owner transition; a new connection of the same
// committed identity, including one opened after wiring, remains eligible.
it.each(['return to A', 'sign out', 'cloud to local', 'local to cloud', 'same connection replaced',
  'DB becomes ready', 'switched during prepare'] as const)('settles a real Codex completion when %s', async scenario => {
  const { a, b, open } = await databases();
  const local = await open(LOCAL_DATA_OWNER_ID);
  const start = scenario === 'local to cloud' ? local : a;
  const id = randomUUID();
  for (const owner of [a, b, local]) {
    owner.db.prepare("INSERT INTO sessions(id,source,status,created_at,updated_at,model) VALUES (?,'desktop','active',1,1,'fixture')").run(id);
  }
  if (start === local) commitActiveAppSession('local');
  start.activate();
  if (scenario === 'DB becomes ready') clearCurrentDbClient();
  const turn = bindSession(id, 'codex', scenario === 'switched during prepare' ? async () => {
    commitActiveAppSession('cloud', 'b'); b.activate();
  } : undefined);
  if (scenario === 'DB becomes ready') a.activate(); // real lease admission also requires a database
  await turn.send();
  switch (scenario) {
    case 'return to A':
      commitActiveAppSession('cloud', 'b'); b.activate();
      commitActiveAppSession('cloud', 'a'); a.activate(); break;
    case 'sign out':
      commitActiveAppSession('signed-out'); break; // outgoing DB deliberately remains installed
    case 'cloud to local':
      commitActiveAppSession('local'); local.activate(); break;
    case 'local to cloud':
      commitActiveAppSession('cloud', 'a'); a.activate(); break;
    case 'same connection replaced':
      (await open('a')).activate(); break;
    case 'DB becomes ready':
      a.activate(); break;
  }
  const before = await codexTotal();
  await turn.deliver({ type: 'done', source: 'codex', data: { usage: { promptTokens: 7, completionTokens: 3 } } } as AgentEvent);
  await setImmediate();
  const admitted = scenario === 'DB becomes ready' || scenario === 'same connection replaced';
  expect(await codexTotal()).toBe(before + (admitted ? 10 : 0));
  for (const owner of [a, b, local]) {
    const tokens = owner === a && admitted ? 10 : 0;
    expect(owner.db.prepare('SELECT total_token_usage FROM sessions WHERE id=?').pluck().get(id)).toBe(tokens);
    expect(owner.db.prepare('SELECT tokens FROM daily_session_usage WHERE session_id=?').pluck().all(id)).toEqual(tokens ? [10] : []);
    expect(owner.db.prepare('SELECT input_tokens+output_tokens FROM daily_model_usage').pluck().all()).toEqual(tokens ? [10] : []);
  }
});

// Two independently committed writes. Pause only the acknowledgement from SQLite.
// A same-account renewal must finish the daily task write; a genuine switch
// keeps the model transaction and starts no follow-up against either account.
it.each(['renew', 'switch'] as const)('resumes an acknowledged-in-SQLite model write on %s', async scenario => {
  const { a, b } = await databases();
  const id = randomUUID();
  for (const owner of [a, b]) {
    owner.db.prepare("INSERT INTO sessions(id,source,status,created_at,updated_at,model) VALUES (?,'desktop','active',1,1,'fixture')").run(id);
  }
  const turn = bindSession(id, 'codex');
  const ack = delayModelCommitAck(a.client);
  await turn.send();
  try {
    await turn.deliver({ type: 'done', source: 'codex', data: { usage: { promptTokens: 7, completionTokens: 3 } } } as AgentEvent);
    await ack.committed.promise;
    if (scenario === 'renew') renewAppSession();
    else { commitActiveAppSession('cloud', 'b'); b.activate(); }
  } finally { ack.resume.resolve(); }
  await setImmediate();
  const query = (owner: typeof a) => owner.db.prepare('SELECT tokens FROM daily_session_usage WHERE session_id=?').pluck().all(id);
  expect(a.db.prepare('SELECT input_tokens+output_tokens FROM daily_model_usage').pluck().all()).toEqual([10]);
  expect(query(a)).toEqual(scenario === 'renew' ? [10] : []);
  expect(query(b)).toEqual([]);
  expect(b.db.prepare('SELECT input_tokens FROM daily_model_usage').all()).toEqual([]);
});


// A real runtime may have an older vendor turn, a preparation that never dispatches,
// or provider-initiated work. Only the accepted event should change the SQL totals.
it('retains the original turn through a cancelled reservation and an engine-initiated continuation', async () => {
  const { a } = await databases();
  const id = randomUUID();
  a.db.prepare("INSERT INTO sessions(id,source,status,created_at,updated_at,model) VALUES (?,'desktop','active',1,1,'fixture')").run(id);
  const turn = bindSession(id, 'claude-code');
  await turn.send(true);
  const result = await turn.session.send('cancel', { afterTurnReserved: async () => {
    renewAppSession();
    expect(turn.session.cancelPendingSend()).toBe(true);
  } });
  expect(result.accepted).toBe(false);
  const done = (n: number) => turn.deliver({ source: 'claude-code', type: 'done', data: {
    modelUsageCumulativeStartsAtZero: true, modelUsage: { fixture: { inputTokens: n * 7, outputTokens: n * 3, costUSD: 0 } },
  } } as AgentEvent);
  await done(1);
  await setImmediate();
  expect(a.db.prepare('SELECT tokens FROM daily_session_usage WHERE session_id=?').pluck().get(id)).toBe(10);
  await turn.deliver({ source: 'claude-code', type: 'status', data: { providerInitiatedTurn: true, isRunning: true } } as AgentEvent);
  await done(2);
  await setImmediate();
  expect(a.db.prepare('SELECT tokens FROM daily_session_usage WHERE session_id=?').pluck().get(id)).toBe(20);
});

// Same-owner generation repair while a real turn is running. Observe the posted frame
// with the renderer's actual owner check and read the assistant's durable usage metadata.
it('delivers completed Codex usage only to the renewed window and patches its assistant message', async () => {
  const { a } = await databases();
  const id = randomUUID();
  a.db.prepare("INSERT INTO sessions(id,source,status,created_at,updated_at,model) VALUES (?,'desktop','active',1,1,'fixture')").run(id);
  const window = new BrowserWindow({ show: false });
  const send = vi.spyOn(window.webContents, 'send');
  const windows = vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([window]);
  onTestFinished(() => { send.mockRestore(); windows.mockRestore(); });
  const turn = bindSession(id, 'codex');
  await turn.send(false);
  const old = getActiveDataOwnerPushStamp();
  renewAppSession();
  await turn.session.steer('additional context');
  await turn.deliver({ source: 'codex', type: 'text', data: { text: 'Reply', isFinal: true } } as AgentEvent);
  await turn.deliver({ source: 'codex', type: 'done', data: { usage: { promptTokens: 7, completionTokens: 3 } } } as AgentEvent);
  await setImmediate();
  await drainPersistQueue();
  const frame = send.mock.calls.find(([channel]) => channel === 'usage:today-tokens-changed');
  expect(frame).toBeDefined();
  const stamp = frame![2];
  expect(stamp).toEqual(getActiveDataOwnerPushStamp());
  setDataOwnerGeneration(old.dataOwnerId, old.ownerGeneration);
  expect(isDataOwnerPushCurrent(stamp)).toBe(false);
  setDataOwnerGeneration(old.dataOwnerId, getActiveDataOwnerPushStamp().ownerGeneration);
  expect(isDataOwnerPushCurrent(stamp)).toBe(true);
  const rows = a.db.prepare("SELECT agent_meta FROM messages WHERE session_id=? AND role='assistant'").pluck().all(id);
  expect(rows.map(row => JSON.parse(String(row)).turnUsageDetails?.totalTokens)).toContain(10);
});

// Non-turn model writes use the existing API without a Session or a signed-in window.
it('records an independently submitted model delta through the original direct API', async () => {
  const { a } = await databases();
  commitActiveAppSession('signed-out');
  await recordModelTurnUsage({ agentKind: 'codex', model: 'direct', inputTokensDelta: 7, outputTokensDelta: 3,
    cacheReadTokensDelta: 0, cacheCreateTokensDelta: 0 });
  expect(a.db.prepare('SELECT input_tokens+output_tokens FROM daily_model_usage').pluck().all()).toEqual([10]);
});


// A cumulative-only Claude packet has no per-request segments. Keep the established
// process baseline and original pay-as-you-go model route over a same-account repair.
it('writes the charged Claude cost delta once after a same-owner repair', async () => {
  const { a } = await databases();
  const id = randomUUID();
  a.db.prepare("INSERT INTO sessions(id,source,status,created_at,updated_at,model) VALUES (?,'desktop','active',1,1,'fixture')").run(id);
  // The only synthetic provider is admitted by the fixture catalog.
  const route = vi.spyOn(routeGuard, 'verdictForModelRoute').mockResolvedValue({ kind: 'pass' });
  const currency = vi.spyOn(pricing, 'getGatewayAccountCurrency').mockResolvedValue('USD');
  onTestFinished(() => { route.mockRestore(); currency.mockRestore(); });
  setSessionProvider(id, 'fixture-api');
  setActiveLedgerCurrency('USD');
  onTestFinished(() => { setSessionProvider(id, null); __resetActiveLedgerCurrencyForTesting(); });
  const turn = bindSession(id, 'claude-code');
  for (const cumulative of [5, 7]) {
    await turn.send();
    await turn.deliver({ type: 'status', source: 'claude-code', data: { isRunning: true } } as AgentEvent);
    if (cumulative === 7) renewAppSession();
    await turn.deliver({ type: 'text', source: 'claude-code', data: { text: 'Metered reply', isFinal: true } } as AgentEvent);
    await turn.deliver({ type: 'done', source: 'claude-code', data: { total_cost_usd: cumulative } } as AgentEvent);
    await setImmediate();
    await drainPersistQueue();
  }
  expect(a.db.prepare('SELECT total_cost_amount FROM sessions WHERE id=?').pluck().get(id)).toBe(2);
  const today = await readAgentTodayUsage('claude-code');
  expect(today.money).toMatchObject({ currency: 'USD', amount: 2 });
  const messages = a.db.prepare("SELECT agent_meta FROM messages WHERE session_id=? AND role='assistant'").pluck().all(id);
  expect(messages.map(value => JSON.parse(String(value))?.turnCostUsd).filter(Boolean)).toEqual([2]);
});

// Observe a real DB model read that predates the account switch. The synchronous
// task token write is valid; continuations awakened afterward must not start a model write.
it('keeps accepted tokens while pricing/model lookup was pending at account switch', async () => {
  const { a, b } = await databases();
  const id = randomUUID();
  a.db.prepare("INSERT INTO sessions(id,source,status,created_at,updated_at,model) VALUES (?,'desktop','active',1,1,'fixture')").run(id);
  const read = turnDefaults.readSessionModelForUsage;
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const spy = vi.spyOn(turnDefaults, 'readSessionModelForUsage').mockImplementation(async target => {
    const row = await read(target); entered.resolve(); await resume.promise; return row;
  });
  onTestFinished(() => { resume.resolve(); spy.mockRestore(); });
  const turn = bindSession(id, 'codex');
  await turn.send();
  await turn.deliver({ type: 'done', source: 'codex', data: { usage: { promptTokens: 7, completionTokens: 3 } } } as AgentEvent);
  await entered.promise;
  commitActiveAppSession('cloud', 'b'); b.activate(); resume.resolve();
  await setImmediate();
  expect(a.db.prepare('SELECT total_token_usage FROM sessions WHERE id=?').pluck().get(id)).toBe(10);
  for (const owner of [a, b]) {
    expect(owner.db.prepare('SELECT input_tokens FROM daily_model_usage').all()).toEqual([]);
    expect(owner.db.prepare('SELECT tokens FROM daily_session_usage').all()).toEqual([]);
  }
});

// The message patch and both sides of a schedule ledger correction are a single
// admitted operation. Switch at the actual SQLite UPDATE, before the ledger opens.
it('finishes the admitted message and both scheduled runs in A after switch', async () => {
  const { a, b } = await databases();
  const { bindSessionUsageAccount } = await import('../usage/sessionUsageOwner.js');
  const { turnUsageAdmission } = await import('../usage/turnUsageAdmission.js');
  const { recordTurnCostOnMessage } = await import('../turnCostBroadcaster.js');
  for (const owner of [a, b]) {
    owner.db.exec("INSERT INTO sessions(id,source,status,created_at,updated_at) VALUES ('task','desktop','active',1,1)");
    owner.db.exec("INSERT INTO schedules(id,name,prompt,cron_expr,timezone,agent_kind,created_at,updated_at) VALUES ('s','job','run','0 0 * * *','UTC','codex',1,1)");
    owner.db.exec("INSERT INTO schedule_runs(id,schedule_id,session_id,fired_at,status,cost_amount,cost_currency) VALUES ('first','s','task',1,'success',1,'USD'),('second','s','task',2,'success',0,'USD')");
    owner.db.prepare("INSERT INTO messages(id,client_id,session_id,role,content,agent_meta,created_at) VALUES ('m','msg','task','assistant','reply',?,1)").run(JSON.stringify({
      origin: { kind: 'scheduler', runId: 'first', scheduleId: 's' }, turnCostUsd: 1,
    }));
  }
  const write = mutations.patchMessageAgentMetaWithResultRow;
  const ack = vi.spyOn(mutations, 'patchMessageAgentMetaWithResultRow').mockImplementation(async (...args) => {
    const result = await write(...args);
    commitActiveAppSession('cloud', 'b'); b.activate();
    return result;
  });
  onTestFinished(() => { ack.mockRestore(); });
  const account = bindSessionUsageAccount();
  account.reserve(1); account.dispatch(1);
  const recorded = await turnUsageAdmission.run(account.forEvent(1), () => recordTurnCostOnMessage({
    sessionId: 'task', clientId: 'msg', money: { amount: 2, currency: 'USD', kind: 'actual-cost', approximate: false },
    turnOrigin: { kind: 'scheduler', runId: 'second', scheduleId: 's' },
  }));
  expect(ack).toHaveBeenCalled();
  expect(recorded).toBe(true);
  for (const owner of [a, b]) {
    const values = owner.db.prepare('SELECT cost_amount FROM schedule_runs ORDER BY id').pluck().all();
    expect(values).toEqual(owner === a ? [0, 2] : [1, 0]);
    const meta = JSON.parse(String(owner.db.prepare("SELECT agent_meta FROM messages WHERE id='m'").pluck().get()));
    expect(meta.turnCostUsd).toBe(owner === a ? 2 : 1);
  }
});

// Pi receipts are idempotent at the SQLite ledger. Keep the first billing route
// and confirmed currency for replays across same-account window/client repairs.
it('deduplicates the same Pi settlement and keeps its confirmed currency after reconnect', async () => {
  const { a, open } = await databases();
  const id = randomUUID();
  a.db.prepare("INSERT INTO sessions(id,source,status,created_at,updated_at,model) VALUES (?,'desktop','active',1,1,'fixture')").run(id);
  const turn = bindSession(id, 'pi');
  setActiveLedgerCurrency('CNY');
  onTestFinished(() => __resetActiveLedgerCurrencyForTesting());
  const data = { usage: { settlementId: 'one', receipts: [{ id: 'receipt', model: 'fixture', recordedAt: Date.now(),
    inputTokens: 7, outputTokens: 3, unpriced: true }] } };
  for (const n of [0, 1]) {
    await turn.send();
    if (n) { renewAppSession(); (await open('a')).activate(); }
    await turn.deliver({ source: 'pi', type: 'done', data } as AgentEvent);
    await setImmediate();
  }
  expect(a.db.prepare('SELECT tokens FROM daily_session_usage WHERE session_id=?').pluck().all(id)).toEqual([10]);
  expect(a.db.prepare('SELECT cost_currency FROM daily_model_usage').pluck().all()).toEqual(['CNY']);
});
