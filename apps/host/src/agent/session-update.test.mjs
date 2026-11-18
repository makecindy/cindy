/**
 * The Host's /sessions/update with the model-switch window gate (session-update.ts,
 * model-window-gate.ts).
 * - Rule: a model change from a client is gated as the desktop gates one from a Device Link client
 *   (register.ts applySessionRuntimeSelection, `isRemote`): a verified shrink whose usage is at
 *   danger or overflow is refused with PRECONDITION_FAILED and the desktop's text, before anything
 *   changes; anything unverified goes through. The Host applies a change during a turn at once
 *   (no deferred selection), so it is gated as if idle.
 * - Gap: Host model changes had no window gate at all, and /sessions/update had no test.
 * - Tier: unit, through the real entry over a migrated profile database; windows come from a fake
 *   route resolver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createContextOverflowRollover } from '../../../desktop/src/main/maker-ipc/contextOverflowRollover.ts';
import { commitContextRebuildWithPorts } from '../../../desktop/src/main/localDb/contextRebuildPersistence.ts';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { hostRuntimeLayout } from '../runtime-layout.mjs';
import { openOwnerDatabase } from '../../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { OwnerSessionStorage } from '../../../desktop/src/main/localDb/sessionStorageAdapter.ts';
import { sessions, messages } from '../../../desktop/src/main/localDb/schema.ts';
import { estimateHandoffTokens } from '../../../desktop/src/main/maker-ipc/agentHandoff.ts';
import { setSessionProvider, getSessionProvider, clearSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.ts';
import { planUserRuntimeModelSwitch } from '../../../desktop/src/shared/runtimeModelSwitchGate.ts';
import { createHostSessionUpdate } from './session-update.ts';
import { createInputQueue } from './input-queue.mjs';
import { MODEL_WINDOW_REBUILD_UNSUPPORTED } from './model-window-gate.ts';

// Route windows of the fixture catalog; a model it does not know has no verified window.
const WINDOWS = { big: 200_000, small: 100_000, huge: 300_000 };

async function fixture(t) {
  // The development build refuses to migrate what it takes for the official shared profile
  // (XDT_OFFICIAL_SHARED_PROFILE=1 inside a Cindy task); this is a fixture profile.
  const sharedProfile = process.env.XDT_OFFICIAL_SHARED_PROFILE;
  delete process.env.XDT_OFFICIAL_SHARED_PROFILE;
  t.after(() => { if (sharedProfile !== undefined) process.env.XDT_OFFICIAL_SHARED_PROFILE = sharedProfile; });
  const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-host-session-update-'));
  const profile = path.join(root, 'profile');
  mkdirSync(profile, { recursive: true });
  configureHostOwner({ userDataDir: profile, ownerId: 'owner-session-update' });
  configureAppDataDir(path.join(root, 'app-data'));
  const layout = hostRuntimeLayout();
  const opened = await openOwnerDatabase({ userDataDir: profile, ownerId: 'owner-session-update',
    isPackaged: false, drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath });
  const database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, 'owner-session-update');
  t.after(async () => {
    clearCurrentDbClient(); await database.dispose();
    configureHostOwner({ userDataDir: profile, ownerId: null });
    rmSync(root, { recursive: true, force: true });
  });
  const storage = new OwnerSessionStorage({ db: () => database });
  const live = new Map();
  const events = [];
  const budgets = new Map();
  const update = createHostSessionUpdate({
    getLiveSession: id => live.get(id),
    closeRejectedPiRuntime: async (id, expected) => { if (live.get(id) === expected) live.delete(id); },
    readSessionForRun: async id => (await database.drizzle.select().from(sessions).where(eq(sessions.id, id)))[0],
    publish: event => events.push(event),
    modelWindow: () => ({
      resolveRouteWindow: (_agentKind, modelId, _providerId, budget, verification) => {
        if (modelId === 'display-only') return verification ? null : 100_000;
        const window = WINDOWS[modelId] ?? null;
        return window !== null && budget ? Math.min(window, budget) : window;
      },
      readSessionBudget: async id => budgets.get(id) ?? null,
    }),
  });
  const task = async (id, { agentKind = 'claude-code', model = 'big', contextTokens = 0, sdkSessionId } = {}) => {
    await storage.create({ id, title: 'Window fixture', agentKind, model, workDir: root, providerId: 'prov-a' });
    await database.drizzle.update(sessions).set({ contextTokens, ...(sdkSessionId ? { sdkSessionId } : {}) }).where(eq(sessions.id, id));
    setSessionProvider(id, 'prov-a');
    t.after(() => clearSessionProvider(id));
  };
  const runtime = (id, { model = 'big', inTurn = false, usage, agentKind = 'claude-code', finalPiWindow } = {}) => {
    const session = { id, agentKind, model, setModelCalls: [],
      isTurnRunning: () => inTurn,
      getUsageSnapshot: () => usage,
      ...(agentKind === 'pi' ? { previewModelSwitch: async () => ({ action: 'hot', windowVerified: false }) } : {}),
      async setModel(next, options) {
        session.setModelCalls.push([next, options]); session.model = next;
        if (finalPiWindow !== undefined) usage = { ...usage, contextWindow: finalPiWindow };
      },
      async setEffort() {} };
    live.set(id, session);
    return session;
  };
  const row = async id => (await database.drizzle.select().from(sessions).where(eq(sessions.id, id)))[0];
  const handoffs = new Map();
  const history = new Map();
  const listMessages = id => database.drizzle.select().from(messages).where(eq(messages.sessionId, id));
  const rollover = createContextOverflowRollover({
    getSessionRow: row, getLiveSession: id => live.get(id),
    drainPersistQueue: async () => {},
    closeSession: async id => { live.delete(id); },
    listMessages: async id => [{ role: 'user', content: 'Preserve the previous request.', clientId: 'source', createdAt: 1 }, ...(history.get(id) ?? [])],
    findLatestRebuildMeta: async () => null,
    commitRebuild: (id, handoff, meta) => commitContextRebuildWithPorts({
      now: Date.now, createId: randomUUID, tx: (name, args) => database.tx(name, args),
    }, id, handoff, meta),
    setPendingHandoff: (id, handoff) => handoffs.set(id, handoff),
    withCloseSuppressed: (_id, run) => run(),
    log: { warn() {}, info() {}, debug() {} },
  });
  return { update, task, runtime, row, events, budgets, handoffs, history, listMessages, live, rollover };
}

// #11352 / DB tier: prewarm must use the same window gate as dispatch before opening Pi.
// Existing dispatch coverage misses this entry. A single display-only window must leave
// both the saved model and the native binding intact and prevent a preparation receipt.
test('remote Pi skill preparation refuses an owner route with an unverified window', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const id = 'pi-prewarm-unverified';
  const sdkSessionId = 'pi-native-before-prewarm';
  await f.task(id, { agentKind: 'pi', contextTokens: 95_000, sdkSessionId });
  const saved = await f.row(id);
  const live = f.runtime(id, { agentKind: 'pi', usage: { contextWindow: 200_000, contextTokens: 95_000 } });
  live.workDir = saved.workingDir;
  live.abort = async () => {};
  const queue = createInputQueue({
    getMaker: () => ({ getSession: () => live }),
    hub: { publish() {} },
    readSession: f.row,
    applyPendingAgentSwitch: (sessionId, prepare) => f.update(sessionId, { model: 'display-only' }, {
      ...prepare, assertCurrent() {},
    }),
  });
  try {
    await assert.rejects(queue.preparePiSkillRuntime(id, saved.workingDir, { applyPendingOwnerSelection: true }),
      /target context window or current usage could not be verified/);
    const after = await f.row(id);
    assert.equal(after.model, saved.model);
    assert.equal(after.sdkSessionId, sdkSessionId);
    assert.deepEqual(live.setModelCalls, []);
  } finally { await queue.dispose(); }
});

// Each cell: the task's usage and the change it asks for. `refused`: the Host's verdict.
const CELLS = [
  { name: 'a verified shrink at danger', contextTokens: 95_000, target: 'small', refused: true },
  { name: 'a verified shrink at overflow', contextTokens: 150_000, target: 'small', refused: true },
  { name: 'a verified shrink with low usage', contextTokens: 50_000, target: 'small', refused: false },
  { name: 'a larger window', contextTokens: 150_000, target: 'huge', refused: false },
  { name: 'an unverified target window', contextTokens: 150_000, target: 'unlisted', refused: false },
  { name: 'an unverified current window', contextTokens: 150_000, current: 'unlisted', target: 'small', refused: false },
  { name: 'Codex, which compacts natively', agentKind: 'codex', contextTokens: 150_000, target: 'small', refused: false },
];

for (const inTurn of [false, true]) {
  for (const cell of CELLS) {
    test(`model change ${inTurn ? 'during a turn' : 'while idle'}: ${cell.name} is ${cell.refused ? 'refused' : 'applied'}`, { timeout: 30_000 }, async t => {
      const f = await fixture(t);
      const id = `window-${inTurn ? 'turn' : 'idle'}-${CELLS.indexOf(cell)}`;
      const current = cell.current ?? 'big';
      await f.task(id, { agentKind: cell.agentKind, model: current, contextTokens: cell.contextTokens });
      const session = f.runtime(id, { model: current, inTurn, agentKind: cell.agentKind });
      const change = f.update(id, { model: cell.target });
      if (cell.refused) {
        await assert.rejects(change, error => error.code === 'PRECONDITION_FAILED'
          && error.message === `[PRECONDITION_FAILED] ${MODEL_WINDOW_REBUILD_UNSUPPORTED}`);
        assert.equal((await f.row(id)).model, current, 'the task row keeps its model');
        assert.deepEqual(session.setModelCalls, [], 'the running Agent keeps its model');
        assert.equal(getSessionProvider(id), 'prov-a', 'the provider registration is unchanged');
        assert.equal(f.events.length, 0, 'nothing is published');
      } else {
        await change;
        assert.equal((await f.row(id)).model, cell.target);
        assert.deepEqual(session.setModelCalls.map(([model]) => model), [cell.target]);
      }
      // The desktop's Device Link path on the same facts: idle, the same verdict; during a turn the
      // desktop defers the change to the next send (no deferred selection on the Host).
      const plan = planUserRuntimeModelSwitch({ agentKind: cell.agentKind ?? 'claude-code', model: cell.target,
        providerId: 'prov-a', currentFastMode: false, selection: { effort: null, fastMode: false },
        gate: { inTurn, isRemote: true, agentKind: cell.agentKind ?? 'claude-code', runtimeRouteChanged: true,
          verifiedTargetWindow: WINDOWS[cell.target] ?? null, verifiedCurrentWindow: WINDOWS[current],
          contextTokensKnown: true, contextTokens: cell.contextTokens } });
      assert.equal(plan.outcome, inTurn ? 'defer' : cell.refused ? 'reject' : 'hot-apply');
    });
  }
}

test('model change: the running Agent\'s usage counts over the stored usage, and the task\'s window budget caps both windows', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  // Stored usage 0, the runtime reports 95k: refused against the 100k target.
  await f.task('window-live');
  f.runtime('window-live', { usage: { contextTokens: 95_000, contextWindow: 200_000 } });
  await assert.rejects(f.update('window-live', { model: 'small' }), { code: 'PRECONDITION_FAILED' });
  // 300k to 200k at 195k is refused; with a 150k budget both windows are 150k, not a shrink.
  await f.task('window-unbudgeted', { model: 'huge', contextTokens: 195_000 });
  f.runtime('window-unbudgeted', { model: 'huge' });
  await assert.rejects(f.update('window-unbudgeted', { model: 'big' }), { code: 'PRECONDITION_FAILED' });
  await f.task('window-budget', { model: 'huge', contextTokens: 195_000 });
  f.budgets.set('window-budget', 150_000);
  f.runtime('window-budget', { model: 'huge' });
  await f.update('window-budget', { model: 'big' });
  assert.equal((await f.row('window-budget')).model, 'big');
});

test('model change: a provider-only change is gated on the same model, and other fields never are', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('window-other', { contextTokens: 150_000 });
  f.runtime('window-other');
  await f.update('window-other', { title: 'Renamed', effort: 'high' });
  assert.equal((await f.row('window-other')).title, 'Renamed');
  // Same model on another provider: the windows are the same, the change goes through.
  await f.update('window-other', { providerId: 'prov-b' });
  assert.equal((await f.row('window-other')).providerId, 'prov-b');
});

test('model change: a cold task (no running Agent) is gated on its stored model and usage', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('window-cold', { contextTokens: 150_000 });
  await assert.rejects(f.update('window-cold', { model: 'small' }), { code: 'PRECONDITION_FAILED' });
  await f.update('window-cold', { model: 'huge' });
  assert.equal((await f.row('window-cold')).model, 'huge');
  // A cold Pi task's current window is only what its runtime reports: unverified, so it goes through.
  await f.task('window-cold-pi', { agentKind: 'pi', contextTokens: 150_000 });
  await f.update('window-cold-pi', { model: 'small' });
  assert.equal((await f.row('window-cold-pi')).model, 'small');
});

test('model change: a task that does not exist is "session not found", as before the gate, and a runtime left without its row is not changed', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.update('window-missing', { model: 'small' }), { message: 'session not found' });
  await assert.rejects(f.update('window-missing', { title: 'Renamed' }), { message: 'session not found' });
  // Before the gate, the running Agent was switched and then the missing row reported.
  const orphan = f.runtime('window-orphan');
  await assert.rejects(f.update('window-orphan', { model: 'small' }), { message: 'session not found' });
  assert.deepEqual(orphan.setModelCalls, []);
});

// 2026-11-18 owner Device Link decision. The old service-level tests reject 95k/100k;
// at the scheduled application boundary, the real recovery transaction must move the route and
// native binding together. Use the existing migrated SQLite fixture and real rollover (DB tier).
test('owner dispatch rebuilds Claude and hot Pi on the host-verified window and keeps an unverifiable Pi route', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const apply = { prepareModelWindowSwitch: f.rollover.prepareModelWindowSwitch, assertCurrent() {}, nextInputChars: 45_000 };
  const cases = [
    { id: 'owner-claude', agentKind: 'claude-code', model: 'small', expectedModel: 'small' },
    // The target catalog is larger than the source. The final native Pi window is smaller.
    { id: 'owner-pi', agentKind: 'pi', model: 'huge', finalPiWindow: 100_000, expectedModel: 'huge' },
    { id: 'owner-pi-unverified', agentKind: 'pi', model: 'small', finalPiWindow: 0, expectedModel: 'big' },
    { id: 'owner-unverified-catalog', agentKind: 'claude-code', model: 'display-only', expectedModel: 'big' },
  ];
  for (const { id, agentKind, model, finalPiWindow, expectedModel } of cases) {
    await f.task(id, { agentKind, contextTokens: 95_000, sdkSessionId: `native-${id}` });
    f.runtime(id, { agentKind, finalPiWindow, usage: { contextTokens: 95_000, contextWindow: 200_000 } });
    if (expectedModel !== 'big') {
      f.history.set(id, [{ role: 'assistant', content: 'Prior output '.repeat(6_000), clientId: 'reply', createdAt: 2 }]);
    }
    const result = f.update(id, { model }, apply);
    if (expectedModel === 'big') {
      await assert.rejects(result, { code: 'PRECONDITION_FAILED' });
      assert.equal((await f.row(id)).sdkSessionId, `native-${id}`);
      assert.equal(f.handoffs.has(id), false);
    } else {
      await result;
      assert.equal((await f.row(id)).sdkSessionId, null);
      assert.equal((await f.row(id)).contextTokens, 0);
      const handoff = f.handoffs.get(id);
      assert.match(handoff, /Preserve the previous request/);
      assert.ok(handoff.length > 16_000);
      assert.ok(estimateHandoffTokens(handoff) <= 20_000);
      const marker = (await f.listMessages(id)).find(message => message.role === 'context_rebuild');
      assert.equal(JSON.parse(marker.content).handoffCoverage, 'condensed');
    }
    assert.equal((await f.row(id)).model, expectedModel);
    assert.equal(f.live.has(id), id === 'owner-unverified-catalog');
  }
});
