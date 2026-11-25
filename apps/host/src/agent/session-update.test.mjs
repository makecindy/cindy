/**
 * The Host's /sessions/update with the desktop's set-model (session-update.ts, runtime-selection.ts).
 * - Rule: a user's model or provider pick is the desktop's (sessionRuntimeSelectionApply.ts, the user
 *   branch of handleSetModel): an intent until the next send, returned as
 *   { deferred: true, superseded: false, pendingUntilSend: true } and published as the task's
 *   agentSwitchIntent; the task row and the running Agent keep their route. Picking the current
 *   model again replaces the intent with one for the current route, as the desktop registers it. The window gate and a rebuild run when the intent lands at the
 *   send (input-queue.test.mjs, model change at send).
 * - Gap: the Host applied a model change at once and refused a shrink at danger outright (its own
 *   window gate), where the desktop rebuilds at the send.
 * - Tier: unit, through the real entries over a migrated profile database; providers and windows come
 *   from fixture ports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { INDEFINITE_SNOOZE_UNTIL } from '@cindy/maker-shared/live-task-priority';
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
import { createHostSessionUpdate } from './session-update.ts';
import { createHostService } from '../service.mjs';
import { lockSessionRoute } from './session-route-lock.mjs';
import { createHostSessionMovePorts, createRecentWorkdirsChangedPush } from './session-move.ts';
import { createHostTouchUserSend } from './touch-user-send.ts';
import { setLiveCcSessionBridge } from '../../../desktop/src/main/maker-host/claude-transcript-relocation.ts';
import { listRecentWorkdirs, upsertRecentWorkdir } from '../../../desktop/src/main/localDb/ipc/recentWorkdirsCore.ts';
import { readSessionContextWindowBudget } from '../../../desktop/src/main/maker-host/session-context-budget-store.js';
import { createSessionContextBudget } from '../../../desktop/src/main/maker-host/sessionContextBudgetCore.ts';
import { ownerScopedPath } from '../../../desktop/src/main/ownerContext.ts';
import { appliedContextWindowBudgets, pendingSessionContextWindowBudgetReconciles } from '../../../desktop/src/main/maker-ipc/sessionContextWindowBudgetState.js';
import { setModelWithWindowConfirmation } from '../../../desktop/src/renderer/features/cc-agent/lib/modelWindowConfirmation.ts';
import { bindTaskRestoreRetention, createHostTaskRestore } from './task-restore.ts';
import { taskManagementStore } from '../../../desktop/src/main/task-management/store.ts';
import { ARCHIVE_CANDIDATE_SELECT, taskArchiveKeepReason } from '../../../desktop/src/main/task-management/eligibility.ts';
import { setSessionRouteLockImplementation } from '../../../desktop/src/main/localDb/sessionRouteLock.ts';
import { withSendToSessionLock, withSessionRestartLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.ts';
import { botProfiles, botSessionLinks } from '../../../desktop/src/main/localDb/schema.ts';
import { createHostRuntimeSelection } from './runtime-selection.ts';
import { Maker } from '@cindy/maker-core';
import { getSessionLastLiveUsage, _resetSessionLastLiveUsageForTests } from '../../../desktop/src/main/maker-ipc/sessionLastLiveUsage.ts';

// Route windows of the fixture providers; a model they do not list has no verified window.
const WINDOWS = { big: 200_000, small: 100_000, huge: 300_000 };
// Each model offers two efforts, so an effort change has a value to keep (resolveSessionRuntimeAxes).
const model = id => ({ id, efforts: ['low', 'high'], defaultEffort: 'high', supportsFastMode: false });
const VIEWS = ['prov-a', 'prov-b'].map(id => ({ id, connected: true, agents: ['claude-code'], source: 'user',
  routing: { 'claude-code': {} }, models: { 'claude-code': Object.keys(WINDOWS).map(model) } }));
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function fixture(t, opts = {}) {
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
  const taskRestore = createHostTaskRestore({ getOwner: () => database, publish: event => events.push(event) });
  const restoreCalls = [];
  const restoreTaskToActive = (id, options) => { restoreCalls.push(['task list', id]); return taskRestore.restoreTaskToActive(id, options); };
  const maker = {
    getSession: id => live.get(id) ?? null,
    getSessionMeta: id => live.get(id) ? { id, agentKind: live.get(id).agentKind } : null,
    closeSession: async id => { live.delete(id); },
    // As Maker (maker.ts): the runtimes it holds; a budget rebuild reads them.
    listActiveSessions: () => [...live.values()],
  };
  const selection = createHostRuntimeSelection({
    getMaker: () => maker, getMakerIfReady: () => maker,
    publish: event => events.push(event),
    createDbMessage: async () => {},
    pendingHandoff: { set() {}, readGeneration: () => 0 },
    listProviderViews: async () => VIEWS,
    resolveConfiguredContextWindow: (_catalog, _agentKind, _providerId, modelId, budget) => {
      const window = WINDOWS[modelId] ?? null;
      return window !== null && budget ? Math.min(window, budget) : window;
    },
    // The fixture's budgets first, then the task's stored preference (what /sessions/update writes).
    readStoredSessionContextWindowBudget: async id => budgets.has(id) ? budgets.get(id) : readSessionContextWindowBudget(id),
    // As the budget core: a change matters when the route's configured window differs.
    contextWindowBudgetChangesEffectiveWindow: ({ modelId, previous, next }) => {
      const window = budget => (WINDOWS[modelId] ?? null) !== null && budget ? Math.min(WINDOWS[modelId], budget) : WINDOWS[modelId] ?? null;
      return window(previous) !== window(next);
    },
    codexProxyAuthInjectionState: () => null,
    inputQueue: { contextRecoveryRollover: () => null, sessionDbAgentKind: () => 'cc', isTurnRunning: () => false,
      wakeSession() {}, refreshQueuedRoute() {}, cancelUsageLimitWait() {} },
    log: quiet,
  });
  // The move's ports as main.ts binds them; the executor is the fixture's: its turns still settling, and
  // its close of an idle runtime (recorded).
  const settling = new Set();
  const closedByExecutor = [];
  const closeGate = { current: null };
  const sessionMove = createHostSessionMovePorts({
    profileDir: profile,
    getMakerIfReady: () => maker,
    isTurnRunning: id => settling.has(id),
    closeRuntime: async id => { closedByExecutor.push(id); await closeGate.current; live.delete(id); },
    publish: event => events.push(event),
  });
  setLiveCcSessionBridge(sessionMove.liveCcSessionBridge);
  t.after(() => setLiveCcSessionBridge(null));
  const update = createHostSessionUpdate({
    restoreTaskToActive,
    persistSessionFields: (...args) => selection.persistSessionFields(...args),
    publish: event => events.push(event),
    setModel: (...args) => selection.setModel(...args),
    move: sessionMove.move,
    ...(opts.onSoftDelete ? { onSoftDelete: opts.onSoftDelete } : {}),
  });
  const task = async (id, { agentKind = 'claude-code', model = 'big', contextTokens = 0, workDir = root } = {}) => {
    await storage.create({ id, title: 'Window fixture', agentKind, model, workDir, providerId: 'prov-a' });
    await database.drizzle.update(sessions).set({ contextTokens }).where(eq(sessions.id, id));
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
  const liveSession = id => live.get(id);
  const closeRuntime = async id => { live.delete(id); };
  return { update, task, runtime, row, events, budgets, database, taskRestore, restoreCalls, selection, liveSession, closeRuntime,
    root, profile, settling, closedByExecutor, closeGate };
}

const intentOf = f => f.events.filter(event => event.type === 'session_changed'
  && Object.hasOwn(event.patch ?? {}, 'agentSwitchIntent')).at(-1)?.patch.agentSwitchIntent;

for (const inTurn of [false, true]) {
  test(`model change ${inTurn ? 'during a turn' : 'while idle'}: a user's pick is an intent until the next send`, { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const id = `intent-${inTurn ? 'turn' : 'idle'}`;
    // Usage at danger for the smaller window: the gate runs at the send, not here.
    await f.task(id, { contextTokens: 95_000 });
    const session = f.runtime(id, { inTurn });
    const answer = await f.update(id, { model: 'small' });
    assert.deepEqual(answer.runtimeSelection, { deferred: true, superseded: false, pendingUntilSend: true });
    assert.equal((await f.row(id)).model, 'big', 'the task row keeps its model');
    assert.deepEqual(session.setModelCalls, [], 'the running Agent keeps its model');
    assert.equal(getSessionProvider(id), 'prov-a', 'the provider registration is unchanged');
    assert.equal(intentOf(f)?.model, 'small', 'the intent is published');
    assert.equal(f.selection.projectIntent(id)?.model, 'small', 'and shown to a reconnecting client');
  });
}

// As the desktop's user branch (sessionRuntimeSelectionApply.ts, the picker records intent only): a
// pick of the task's current model is an intent too, replacing the earlier one; it lands at the send
// with no route change.
test('model change: picking the current model again replaces the intent with the current route', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('intent-back');
  f.runtime('intent-back');
  await f.update('intent-back', { model: 'small' });
  const back = await f.update('intent-back', { model: 'big' });
  assert.equal(back.runtimeSelection.pendingUntilSend, true);
  assert.equal(intentOf(f)?.model, 'big');
  assert.equal(f.selection.projectIntent('intent-back')?.model, 'big');
  assert.equal((await f.row('intent-back')).model, 'big');
});

test('model change: other fields are written at once, and a provider-only pick is an intent too', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('intent-other');
  f.runtime('intent-other');
  await f.update('intent-other', { title: 'Renamed' });
  assert.equal((await f.row('intent-other')).title, 'Renamed');
  const answer = await f.update('intent-other', { providerId: 'prov-b' });
  assert.equal(answer.runtimeSelection.pendingUntilSend, true);
  assert.equal((await f.row('intent-other')).providerId, 'prov-a', 'the row keeps its provider until the send');
  assert.equal(intentOf(f)?.providerId, 'prov-b');
});

// A missing task is NOT_FOUND, typed as updateSessionInDb answers it (it was a plain error, HTTP 500).
const notFound = { code: 'NOT_FOUND', message: '[NOT_FOUND] Session 不存在' };
test('model change: a task that does not exist is NOT_FOUND, and a runtime left without its row is not changed', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.update('window-missing', { model: 'small' }), notFound);
  await assert.rejects(f.update('window-missing', { title: 'Renamed' }), notFound);
  // Before the gate, the running Agent was switched and then the missing row reported.
  const orphan = f.runtime('window-orphan');
  await assert.rejects(f.update('window-orphan', { model: 'small' }), notFound);
  assert.deepEqual(orphan.setModelCalls, []);
});

/**
 * The old path for runtime settings (A8): /sessions/update refuses them and names their entry.
 * - Rule: effort, fast mode, permission mode and Plan mode each have an entry that runs the desktop's
 *   handler (runtime-selection.ts); a second path here would be a second implementation. Refused as
 *   the desktop's updateSessionInDb refuses directory grants: UNSUPPORTED_CAPABILITY naming the entry.
 *   A field this entry does not write (an engine switch included) is INVALID_PARAMS naming it. The
 *   patch is checked before anything is read or changed, and refused whole.
 * - Gap: the Host wrote these fields to the row and the running Agent directly, beside their entries,
 *   and an unknown field answered a plain error (500).
 * - Minimal failing input: one field each; a field with a user's pick pending; a mixed patch.
 * - Tier: unit, through the real entries over a migrated profile database.
 */
const DEDICATED = [['effort', 'low', /set-effort/], ['fastMode', true, /set-fast-mode/],
  ['permissionMode', 'bypassPermissions', /set-permission-mode/], ['planModeEnabled', true, /set-plan-mode/]];
const sessionPatchEvents = (f, id) => f.events.filter(event => event.type === 'session_changed' && event.sessionId === id);
// A runtime that records every setting call made on it.
function recordingRuntime(f, id) {
  const session = f.runtime(id);
  session.calls = [];
  for (const name of ['setEffort', 'setFastMode', 'setPermissionMode', 'setPlanMode']) {
    session[name] = async value => { session.calls.push([name, value]); };
  }
  return session;
}

test('runtime settings: /sessions/update refuses each one, naming its entry, and changes nothing', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('old-path');
  const session = recordingRuntime(f, 'old-path');
  const before = await f.row('old-path');
  for (const [field, value, entry] of DEDICATED) {
    await assert.rejects(f.update('old-path', { [field]: value }), error =>
      error.code === 'UNSUPPORTED_CAPABILITY' && entry.test(error.message) && error.message.includes(field), field);
  }
  assert.deepEqual(session.calls, [], 'the running Agent is not touched');
  assert.deepEqual(await f.row('old-path'), before, 'the task row is not written');
  assert.deepEqual(sessionPatchEvents(f, 'old-path'), []);
});

test('runtime settings: with a user\'s pick pending, an effort through /sessions/update is refused and the pick keeps its effort', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('old-path-pending');
  const session = recordingRuntime(f, 'old-path-pending');
  await f.update('old-path-pending', { model: 'small' });
  const intent = f.selection.projectIntent('old-path-pending');
  await assert.rejects(f.update('old-path-pending', { effort: 'low' }), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.deepEqual(f.selection.projectIntent('old-path-pending'), intent);
  assert.equal(intent.model, 'small');
  assert.deepEqual(session.calls, []);
  assert.equal((await f.row('old-path-pending')).effort, 'high');
});

test('/sessions/update: an engine switch or an unknown field is INVALID_PARAMS naming the fields', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('old-path-unknown');
  const before = await f.row('old-path-unknown');
  await assert.rejects(f.update('old-path-unknown', { agentKind: 'codex' }), error =>
    error.code === 'INVALID_PARAMS' && /agentKind/.test(error.message));
  // The working directory is written here since A5 (the move tests below); only the unknown field is named.
  await assert.rejects(f.update('old-path-unknown', { title: 'Renamed', workingDir: '/tmp', colour: 'red' }), error =>
    error.code === 'INVALID_PARAMS' && /: colour$/.test(error.message));
  assert.deepEqual(await f.row('old-path-unknown'), before);
  assert.deepEqual(sessionPatchEvents(f, 'old-path-unknown'), []);
});

test('/sessions/update: a mixed patch is refused whole, before any read or model pick', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('old-path-mixed');
  const session = recordingRuntime(f, 'old-path-mixed');
  const before = await f.row('old-path-mixed');
  await assert.rejects(f.update('old-path-mixed', { title: 'Renamed', permissionMode: 'bypassPermissions' }),
    { code: 'UNSUPPORTED_CAPABILITY' });
  await assert.rejects(f.update('old-path-mixed', { model: 'small', effort: 'low' }), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.deepEqual(await f.row('old-path-mixed'), before, 'the title is not written');
  assert.equal(f.selection.projectIntent('old-path-mixed'), null, 'no model pick is registered');
  assert.equal(intentOf(f), undefined);
  assert.deepEqual(session.calls, []);
  assert.deepEqual(sessionPatchEvents(f, 'old-path-mixed'), []);
  // Nothing is read first either: a task that does not exist is refused for its fields, not "not found".
  await assert.rejects(f.update('old-path-missing', { model: 'small', effort: 'low' }), { code: 'UNSUPPORTED_CAPABILITY' });
});

// The renderer's switch to the Claude subscription (CCAgentSessionView handleSwitchToClaudeSubscription)
// writes the route with sessionService.update({ model, providerId }) only when the switch answers
// 'applied' (setModelWithWindowConfirmation). On the Host a user's pick always answers pendingUntilSend
// (or superseded, or an error), so that write never runs and no second intent follows; were it called,
// /sessions/update would register the pick again (the "picking the current model again" test above).
// This pins today's answer, in and out of a turn, through the renderer's own helper.
for (const inTurn of [false, true]) {
  test(`model change: the Claude subscription switch answers 'pending' on the Host ${inTurn ? 'during a turn' : 'while idle'}, so the renderer writes no route`, { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    await f.task('subscription-switch');
    f.runtime('subscription-switch', { inTurn });
    const answer = await setModelWithWindowConfirmation({
      invoke: () => f.selection.setModel('subscription-switch', 'big', 'prov-b', undefined, undefined),
      confirm: async () => { throw new Error('no window confirmation for a pick'); },
    });
    assert.equal(answer, 'pending');
    assert.equal(f.selection.projectIntent('subscription-switch')?.providerId, 'prov-b');
    assert.equal((await f.row('subscription-switch')).providerId, 'prov-a', 'the row keeps its route until the send');
  });
}

/**
 * A task's context window budget through /sessions/update (checkpoint 3b-2).
 * - Rule: the desktop's budget chip saves through local-db:sessions:update (updateSessionInDb): the same
 *   range check (assertSessionContextWindowBudgetPatch, INVALID_PARAMS with the desktop's text), a missing
 *   task NOT_FOUND before anything is written, the budget kept in the task's preference file (no row
 *   write), broadcast, and handed to the runtime hook (the shared budget reconcile). A budget that cannot
 *   be saved fails a budget-only update and is dropped from a mixed one.
 * - Gap: the field was not accepted (a plain error, then INVALID_PARAMS after A8): the web client's
 *   budget never saved on the Host.
 * - Minimal failing input: one budget; each refused value; a missing task; an unreadable preference
 *   file alone and beside a title; a restart waiting on the task.
 * - Tier: unit, through the real entry over a migrated profile database and the real preference store.
 */
const budgetEvents = (f, id) => f.events.filter(event => event.type === 'session_changed' && event.sessionId === id);

test('window budget: /sessions/update keeps it in the preference file and broadcasts it, writing no row', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('budget-set');
  const before = await f.row('budget-set');
  const answer = await f.update('budget-set', { contextWindowBudget: 100_000 });
  assert.equal(answer.id, 'budget-set');
  assert.equal(readSessionContextWindowBudget('budget-set'), 100_000);
  assert.deepEqual(await f.row('budget-set'), before, 'the row is not written (no updatedAt bump)');
  assert.deepEqual(budgetEvents(f, 'budget-set').map(event => event.patch), [{ contextWindowBudget: 100_000 }]);
  await f.update('budget-set', { contextWindowBudget: null });
  assert.equal(readSessionContextWindowBudget('budget-set'), null);
  assert.deepEqual(budgetEvents(f, 'budget-set').map(event => event.patch).at(-1), { contextWindowBudget: null });
});

test('window budget: an idle live runtime is rebuilt for a budget that changes its window', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('budget-live');
  const live = f.runtime('budget-live');
  t.after(() => { appliedContextWindowBudgets.delete('budget-live'); pendingSessionContextWindowBudgetReconciles.delete('budget-live'); });
  await withSendToSessionLock('budget-live', () => f.update('budget-live', { contextWindowBudget: 100_000 }));
  // The applier re-entered the send lock /sessions/update holds and rebuilt the runtime (closed it).
  assert.equal(f.selection.pendingSwitches.get('budget-live'), undefined);
  assert.notEqual(f.liveSession('budget-live'), live, 'the runtime is closed for its rebuild');
  assert.equal(appliedContextWindowBudgets.get('budget-live'), 100_000);
});

test('window budget: an out-of-range value is INVALID_PARAMS with the desktop\'s text, and nothing changes', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('budget-range');
  const before = await f.row('budget-range');
  for (const value of [999, 100_000_001, 300_000.5, '300000']) {
    await assert.rejects(f.update('budget-range', { contextWindowBudget: value }), error =>
      error.code === 'INVALID_PARAMS' && error.message ===
        '[INVALID_PARAMS] contextWindowBudget must be null or an integer within [1000, 100000000]', String(value));
  }
  assert.equal(readSessionContextWindowBudget('budget-range'), null);
  assert.deepEqual(await f.row('budget-range'), before);
  assert.deepEqual(budgetEvents(f, 'budget-range'), []);
});

test('window budget: a task that does not exist is NOT_FOUND and its preference is not written', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.update('budget-missing', { contextWindowBudget: 300_000 }), notFound);
  assert.equal(readSessionContextWindowBudget('budget-missing'), null);
  assert.deepEqual(budgetEvents(f, 'budget-missing'), []);
});

test('window budget: an unreadable preference file fails a budget-only update and spares the title of a mixed one', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('budget-unreadable');
  // The store refuses to write over a preference file it cannot read (it keeps it for a person to fix).
  const prefs = ownerScopedPath('session-context-budget-prefs.json');
  mkdirSync(path.dirname(prefs), { recursive: true });
  writeFileSync(prefs, '{ not json');
  await assert.rejects(f.update('budget-unreadable', { contextWindowBudget: 300_000 }), /unreadable|parse|JSON/i);
  assert.deepEqual(budgetEvents(f, 'budget-unreadable'), [], 'nothing is broadcast for a budget that was not saved');
  await f.update('budget-unreadable', { title: 'Renamed', contextWindowBudget: 300_000 });
  assert.equal((await f.row('budget-unreadable')).title, 'Renamed');
  assert.deepEqual(budgetEvents(f, 'budget-unreadable').map(event => event.patch), [{ title: 'Renamed' }],
    'the title is broadcast, the unsaved budget is not');
});

test('window budget: with a restart waiting on the task, the budget is saved without an error and the next start reads it', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('budget-restart');
  f.runtime('budget-restart');
  t.after(() => { appliedContextWindowBudgets.delete('budget-restart'); pendingSessionContextWindowBudgetReconciles.delete('budget-restart'); });
  let restart;
  await f.update('budget-restart', { contextWindowBudget: 100_000 }, undefined, () => {
    // The profile check runs after /sessions/update acquires the route lock.
    restart = withSessionRestartLock('budget-restart', async () => { await f.closeRuntime('budget-restart'); });
  });
  await restart;
  assert.equal(readSessionContextWindowBudget('budget-restart'), 100_000, 'the budget is saved');
  assert.equal(appliedContextWindowBudgets.has('budget-restart'), false, 'not recorded as applied to the old runtime');
  // The next start reads the task's stored budget (start-options, the budget core's reader).
  const budget = createSessionContextBudget({ resolveContextProviderId: () => null, readSessionContextWindowBudget, logger: quiet });
  assert.equal(await budget.readStoredSessionContextWindowBudget('budget-restart'), 100_000);
});

/**
 * Making an archived task active (task-restore.ts): the task list's restore and a send to the task
 * go through the same writer, the shared transaction `sessions.setStatus`.
 * - Rule: the desktop restores through patchSessionMetaInDb's active branch, whose result is decided
 *   by that transaction: a deleted task stays deleted, a teammate's own task is managed by the
 *   teammate, a group lane is detached in the same transaction. A send also refuses a managed task
 *   the desktop's send refuses (archivedTaskRestore.ts).
 * - Gap: the Host wrote the status column directly, and a send left an archived task archived.
 * - Tier: unit, through the real entries over a migrated profile database.
 */
async function archivedTask(f, id, { status = 'archived', source, lane } = {}) {
  await f.task(id);
  await f.database.drizzle.update(sessions).set({ status, ...(source ? { source } : {}), updatedAt: 1 })
    .where(eq(sessions.id, id));
  if (lane) {
    await f.database.drizzle.insert(botProfiles).values({ id: `bot-${id}`, displayName: 'Teammate', createdAt: 1, updatedAt: 1 });
    await f.database.drizzle.insert(botSessionLinks).values({ id: `link-${id}`, botId: `bot-${id}`, sessionId: id, role: lane, createdAt: 1 });
  }
}
const linkOf = async (f, id) => (await f.database.drizzle.select().from(botSessionLinks).where(eq(botSessionLinks.sessionId, id)))[0];

test('restore: the task list and a send make an archived task active through the same transaction', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await archivedTask(f, 'restore-list');
  await archivedTask(f, 'restore-send');
  const updated = await f.update('restore-list', { status: 'active', title: 'Back' });
  assert.equal(updated.status, 'active');
  assert.equal(updated.title, 'Back');
  await f.taskRestore.restoreArchivedSessionForSend('restore-send');
  for (const id of ['restore-list', 'restore-send']) {
    const row = await f.row(id);
    assert.equal(row.status, 'active');
    assert.ok(row.updatedAt > 1, 'the transaction stamps updated_at');
  }
  // One event per route: the task list's carries its whole patch, a send's the new status.
  assert.deepEqual(f.events.map(e => [e.sessionId, e.patch]), [
    ['restore-list', { status: 'active', title: 'Back', snoozedUntil: null, snoozedAt: null }],
    ['restore-send', { status: 'active', snoozedUntil: null, snoozedAt: null }],
  ]);
  assert.deepEqual(f.restoreCalls, [['task list', 'restore-list']]);
  // An active task is left as it is by a send.
  await f.taskRestore.restoreArchivedSessionForSend('restore-send');
  assert.equal(f.events.length, 2);
});

/**
 * The restore is recorded for idle archiving (task-restore.ts bindTaskRestoreRetention).
 * - Rule: the desktop's task management installs the restore observer (task-management/service.ts):
 *   a restored task is kept for its retention days ('restored', eligibility.ts) before idle archiving
 *   may archive it again (release table 甲 22).
 * - Gap: the Host installed none, so a task restored on the Host carried no restoredAt. The Host runs
 *   no idle archiving; the desktop does when it opens the same profile itself, and archived the task
 *   straight away.
 * - Minimal failing input: an archived, long-unused task restored through the task list or a send.
 * - Tier: unit, through the Host's restore entries over a migrated profile database, then the
 *   desktop's own retention decision on the row the desktop's archiving reads.
 */
test('restore: both routes record the restore, so later idle archiving keeps the task', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  t.after(bindTaskRestoreRetention());
  await archivedTask(f, 'restore-kept-list');
  await archivedTask(f, 'restore-kept-send');
  await f.update('restore-kept-list', { status: 'active' });
  await f.taskRestore.restoreArchivedSessionForSend('restore-kept-send');
  const restoredAt = taskManagementStore.restoredAt();
  const idle = { ready: true, viewed: new Set(), drafts: new Set(), remoteUnknown: false };
  for (const id of ['restore-kept-list', 'restore-kept-send']) {
    assert.ok(restoredAt[id] > Date.now() - 60_000, `${id} has its restore time`);
    // Unused for a long time: without the record the desktop's archiving would pick it at once.
    await f.database.drizzle.update(sessions).set({ lastActivityAt: 1, userSendAt: null, updatedAt: 1 })
      .where(eq(sessions.id, id));
    const row = await f.database.queryOne(`${ARCHIVE_CANDIDATE_SELECT} WHERE s.id = ?`, [id]);
    const decide = at => taskArchiveKeepReason(row, { now: Date.now(), days: 7, restoredAt: at, protection: idle, busy: false });
    assert.equal(decide(restoredAt[id]), 'restored');
    assert.equal(decide(undefined), null, 'the same row without the record is archived');
  }
});

test('restore: a deleted task stays deleted on both routes', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await archivedTask(f, 'restore-deleted', { status: 'deleted' });
  await assert.rejects(f.update('restore-deleted', { status: 'active' }), { code: 'PRECONDITION_FAILED' });
  await assert.rejects(f.taskRestore.restoreArchivedSessionForSend('restore-deleted'), { code: 'NOT_FOUND' });
  assert.equal((await f.row('restore-deleted')).status, 'deleted');
});

test('restore: a teammate\'s own task is refused, a group lane is restored and detached', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await archivedTask(f, 'restore-teammate', { source: 'bot', lane: 'canonical' });
  await assert.rejects(f.update('restore-teammate', { status: 'active' }), { code: 'PRECONDITION_FAILED' });
  await assert.rejects(f.taskRestore.restoreArchivedSessionForSend('restore-teammate'), { code: 'PRECONDITION_FAILED' });
  assert.equal((await f.row('restore-teammate')).status, 'archived');

  for (const [id, route] of [['restore-group-list', 'list'], ['restore-group-send', 'send']]) {
    await archivedTask(f, id, { source: 'bot', lane: 'group' });
    if (route === 'list') await f.update(id, { status: 'active' });
    else await f.taskRestore.restoreArchivedSessionForSend(id);
    assert.equal((await f.row(id)).status, 'active');
    assert.ok((await linkOf(f, id)).archivedAt > 0, 'restored history is never the live group receiver again');
  }
});

// Unit: the route lock a restore takes. The Host installs the task's send lock as the shared route
// lock bridge (main.ts, as the desktop's registerAll does). Rule: a send already holding the lock
// restores re-entrantly; a restore from outside it (context recovery's replay) waits for the holder.
test('restore: a send holding the task lock restores re-entrantly, and a restore outside it waits for the lock', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  setSessionRouteLockImplementation(withSendToSessionLock);
  t.after(() => setSessionRouteLockImplementation(null));
  await archivedTask(f, 'restore-locked');
  // Re-entrant: the send path already holds the task's lock.
  await withSendToSessionLock('restore-locked', () => f.taskRestore.restoreArchivedSessionForSend('restore-locked'));
  assert.equal((await f.row('restore-locked')).status, 'active');

  await f.database.drizzle.update(sessions).set({ status: 'archived' }).where(eq(sessions.id, 'restore-locked'));
  let release;
  const held = withSendToSessionLock('restore-locked', () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  let restored = false;
  const restoring = f.taskRestore.restoreArchivedSessionForSend('restore-locked').then(() => { restored = true; });
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored, false, 'waits while another holder has the task lock');
  assert.equal((await f.row('restore-locked')).status, 'archived');
  release();
  await held;
  await restoring;
  assert.equal((await f.row('restore-locked')).status, 'active');
});

// Close convergence (runtime-selection.ts attachMaker):
// - Rule: as the desktop's per-session status listener finalizes every closed runtime
//   (sessionBindingLifecycle.ts → finalizeClosedSession → rememberSessionLastLiveUsage), each close of a
//   task's runtime is seen exactly once, whichever path closed it, and its usage is read from the closed
//   session at that moment (a cold Pi model change's window check reads it, sessionLastLiveUsage.ts).
// - Gap: the Host kept no last live usage.
// - Tier: unit, through a real Maker and its sessions; the agent is a fixture handle. Each Host path
//   reaches the Maker through the entry named in its test.
const closeAgent = handles => ({
  capabilities: Object.fromEntries(['switchModel', 'effort', 'setPermissionModeMidSession', 'rewind', 'memory']
    .map(key => [key, { supported: false, reason: 'not-implemented' }]).concat([['permissionModes', []]])),
  startSession: async opts => {
    let usage = { tokenUsage: 0, contextTokens: 80_000, contextWindow: 200_000, costUsd: 0 };
    let closing = false;
    const handle = { id: `native-${handles.length}`, agentKind: 'claude-code', model: opts.model, closedReads: 0,
      send: async () => {}, steer: async () => {}, abort: async () => {},
      // The usage is gone one macrotask after the close: only a read at the close itself sees it.
      close: async () => { closing = true; setImmediate(() => { usage = undefined; }); },
      events: async function* () { await new Promise(() => {}); },
      // Maker reads no usage on a close; each read after it began is the convergence's.
      getUsageSnapshot: () => { if (closing) handle.closedReads += 1; return usage; },
      setInteractionResolver: () => {} };
    handles.push(handle);
    return handle;
  },
  dispose: async () => {},
});
function closeFixture(t) {
  _resetSessionLastLiveUsageForTests();
  const rows = new Map();
  const storage = {
    create: async meta => { const row = { ...meta, createdAt: Date.now(), updatedAt: Date.now() }; rows.set(row.id, row); return row; },
    get: async id => rows.get(id) ?? null,
    list: async () => [...rows.values()],
    update: async (id, patch) => { const next = { ...rows.get(id), ...patch, updatedAt: Date.now() }; rows.set(id, next); return next; },
    compareAndClearSdkSessionId: async () => false,
    delete: async id => { rows.delete(id); },
  };
  const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return silent; } };
  const handles = [];
  const maker = new Maker({ agents: { 'claude-code': closeAgent(handles) }, storage, logger: silent });
  const selection = createHostRuntimeSelection({
    getMaker: () => maker, getMakerIfReady: () => maker, publish: () => {}, createDbMessage: async () => {},
    pendingHandoff: { set() {}, readGeneration: () => 0 }, listProviderViews: async () => VIEWS,
    resolveConfiguredContextWindow: () => null, readStoredSessionContextWindowBudget: () => null,
    contextWindowBudgetChangesEffectiveWindow: () => false,
    codexProxyAuthInjectionState: () => null,
    inputQueue: { contextRecoveryRollover: () => null, sessionDbAgentKind: () => 'cc', isTurnRunning: () => false,
      wakeSession() {}, refreshQueuedRoute() {}, cancelUsageLimitWait() {} },
    log: quiet,
  });
  // Called detached, as a caller may destructure it: the subscription does not depend on `this`.
  const { attachMaker } = selection;
  const off = attachMaker(maker);
  t.after(async () => { off(); await maker.shutdown(); _resetSessionLastLiveUsageForTests(); });
  // Which task each fixture runtime belongs to, in start order.
  const runtimes = [];
  const start = async id => {
    const session = await maker.createSession({ id, agentKind: 'claude-code', model: 'big', providerId: 'prov-a', workingDir: os.tmpdir() });
    runtimes.push([id, handles.at(-1)]);
    return session;
  };
  // The closes the convergence saw: one entry per read of a closing runtime's usage.
  const seen = () => runtimes.flatMap(([id, handle]) => Array(handle.closedReads).fill(id));
  const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };
  const remembered = id => {
    const usage = getSessionLastLiveUsage(id);
    return usage && { contextTokens: usage.contextTokens, contextWindow: usage.contextWindow };
  };
  return { maker, start, seen, settle, remembered, off };
}

const CLOSE_PATHS = [
  // turn-executor.mjs closeRuntime: an idle release, and a refresh of the runtime it still holds.
  ['idle release', (maker, id) => maker.closeSession(id)],
  ['idle release of the current runtime', (maker, id, session) => maker.closeSessionIfCurrent(session, 'runtime-refresh')],
  // runtime-selection.ts agentSwitchDeps.closeSession (performSessionAgentSwitch).
  ['engine switch', (maker, id) => maker.closeSession(id, 'agent-switch')],
  // context-recovery-assembly.ts rollover closeSession (a context rebuild).
  ['rebuild', (maker, id) => maker.closeSession(id, 'runtime-refresh')],
  // main.ts deleteSession → inputQueue.disposeSession → executor.close → closeRuntime.
  ['delete', (maker, id) => maker.closeSession(id)],
  // main.ts disposeOwnerRuntime: inputQueue.dispose closes each runtime, then maker.shutdown.
  ['shutdown', (maker, id) => maker.shutdown()],
];
for (const [name, close] of CLOSE_PATHS) {
  test(`close convergence: ${name} is seen once, with the usage the runtime had at its close`, { timeout: 30_000 }, async t => {
    const f = closeFixture(t);
    const session = await f.start(`close-${name}`);
    await close(f.maker, session.id, session);
    await f.settle();
    assert.deepEqual(f.seen(), [session.id]);
    assert.deepEqual(f.remembered(session.id), { contextTokens: 80_000, contextWindow: 200_000 });
    assert.equal(session.getUsageSnapshot(), undefined, 'the fixture runtime has dropped its usage since');
  });
}

test('close convergence: a runtime closed twice, or closed and then shut down, is seen once; the task\'s next runtime once more', { timeout: 30_000 }, async t => {
  const f = closeFixture(t);
  const first = await f.start('close-twice');
  await Promise.all([f.maker.closeSession(first.id), f.maker.closeSession(first.id)]);
  await f.settle();
  assert.deepEqual(f.seen(), ['close-twice']);
  const next = await f.start('close-twice');
  assert.notEqual(next, first);
  const other = await f.start('close-then-shutdown');
  await f.maker.closeSession(other.id);
  await f.maker.shutdown();
  await f.settle();
  assert.deepEqual(f.seen().sort(), ['close-then-shutdown', 'close-twice', 'close-twice']);
});

test('close convergence: after the owner runtime unsubscribes, a close is not seen', { timeout: 30_000 }, async t => {
  const f = closeFixture(t);
  const session = await f.start('close-after-off');
  f.off();
  await f.maker.closeSession(session.id);
  await f.settle();
  assert.deepEqual(f.seen(), []);
  assert.equal(f.remembered(session.id), undefined);
});

// Rule: the Host refuses a task whose Agent runs on another computer with its remote execution refusal
// (send-preflight.ts assertHostTaskExecutionSupported: UNSUPPORTED_CAPABILITY), where the desktop hands
// the change to that computer (handleSetModel → applyAgentDeviceRuntimeSelection). Gap: the Host's
// binding threw a plain error, answered as an untyped 500. Such a row reaches the Host by migration.
test('model change: a task whose Agent runs on another computer is refused as remote execution, with nothing changed', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('on-device');
  await f.database.drizzle.update(sessions).set({ agentDeviceId: 'other-computer' }).where(eq(sessions.id, 'on-device'));
  await assert.rejects(f.update('on-device', { model: 'small' }), error =>
    error.code === 'UNSUPPORTED_CAPABILITY' && /remote execution/.test(error.message));
  assert.equal((await f.row('on-device')).model, 'big');
  assert.equal(intentOf(f), undefined);
});

// Effort and thinking changes (checkpoint 3b, the desktop's SET_EFFORT and SET_THINKING_ENABLED bodies
// from sessionRuntimeAxisSettings.ts):
// - Rule: with no pick pending, an effort change applies to the task's runtime and row at once; with a
//   user's pick pending, it goes into that pick (stagePendingUserRuntimeAxis) and the running model is
//   left alone. A thinking change applies to the runtime, after the Review check.
// - Gap: the Host applied an effort change to the running model and row even with a pick pending, and
//   had no thinking entry.
test('effort: with no pick pending, the change applies to the task\'s runtime and row at once', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('effort-live');
  const live = f.runtime('effort-live');
  const applied = [];
  live.setEffort = async effort => { applied.push(effort); };
  await f.selection.setEffort('effort-live', 'low');
  assert.deepEqual(applied, ['low']);
  assert.equal((await f.row('effort-live')).effort, 'low');
});

test('effort: with a user\'s pick pending, the change goes into the pick and the running model is left alone', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('effort-pending');
  const live = f.runtime('effort-pending');
  const applied = [];
  live.setEffort = async effort => { applied.push(effort); };
  await f.update('effort-pending', { model: 'small' });
  const answer = await f.selection.setEffort('effort-pending', 'low');
  assert.deepEqual(answer, { deferred: true, superseded: false, pendingUntilSend: true });
  assert.deepEqual(applied, [], 'the running model keeps its effort');
  assert.equal((await f.row('effort-pending')).effort, 'high', 'the task row keeps its effort until the pick lands');
  assert.equal(f.selection.projectIntent('effort-pending')?.effort, 'low', 'the pick carries the new effort');
  assert.equal(f.selection.projectIntent('effort-pending')?.model, 'small');
});

test('thinking: a change applies to the runtime, and a Review task is refused before it', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('thinking-live');
  const live = f.runtime('thinking-live');
  const changes = [];
  live.setThinkingEnabled = async enabled => { changes.push(enabled); };
  await f.selection.setThinkingEnabled('thinking-live', false);
  assert.deepEqual(changes, [false]);
  await f.database.drizzle.update(sessions).set({ source: 'review' }).where(eq(sessions.id, 'thinking-live'));
  await assert.rejects(f.selection.setThinkingEnabled('thinking-live', true),
    error => error.code === 'UNSUPPORTED_CAPABILITY' && /Review task settings/.test(error.message));
  assert.deepEqual(changes, [false], 'the Review task\'s runtime is not touched');
});

// Working-directory move (A5: session-update.ts with the desktop's move steps, sessionWorkingDirMove.ts;
// the Host's ports, session-move.ts):
// - Rule: moving a task to another directory or a dialogue is the desktop's updateSessionInDb (its move
//   steps run as they were moved): the stored form of the directory, the mapper dropping the explicit
//   project, the worktree ownership guard (the desktop's registry, worktrees.json in the profile root),
//   an idle Pi/Codex runtime closed and a running one refused, a Claude task's transcripts copied to the
//   new directory's key, the recent project record, and the patch the steps changed in place published.
// - Gap: /sessions/update refused workingDir and workspaceKind (INVALID_PARAMS): the web client's "move
//   to project" failed and its folder pick changed nothing.
// - Minimal failing input: one move of each kind below; the lock's holder; each registry state.
// - Tier: unit, through the real entry over a migrated profile database, the real registry file and the
//   real transcript copy in an isolated Claude config directory; the runtime is a fixture.
const moveDir = (f, name) => { const dir = path.join(f.root, name); mkdirSync(dir, { recursive: true }); return dir; };
// Host rows and events use forward slashes even when the caller supplies a native Windows path.
const storedDir = dir => dir.split(path.sep).join('/');
const movedEvents = (f, id) => f.events.filter(event => event.type === 'session_changed' && event.sessionId === id);
const recentPushes = f => f.events.filter(event => event.type === 'plugin_push' && event.channel === 'local-db:recent-workdirs:changed');

test('move: an idle Codex task moves to a project; its runtime is closed, and the row, the event and the recent projects follow', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const from = moveDir(f, 'from');
  const to = moveDir(f, 'to');
  // df520e3564: moving a task advances an existing project's usage time.
  await upsertRecentWorkdir(to, 1_000);
  await f.task('move-codex', { agentKind: 'codex', workDir: from });
  await f.database.drizzle.update(sessions).set({ projectDir: from }).where(eq(sessions.id, 'move-codex'));
  f.runtime('move-codex', { agentKind: 'codex' });
  const moved = await f.update('move-codex', { workingDir: `${to}/`, workspaceKind: 'project' });
  assert.equal(moved.workingDir, storedDir(to));
  const row = await f.row('move-codex');
  assert.deepEqual([row.workingDir, row.workspaceKind, row.projectDir], [storedDir(to), 'project', null]);
  assert.deepEqual(f.closedByExecutor, ['move-codex'], 'the idle runtime is closed before the new directory is written');
  assert.equal(f.liveSession('move-codex'), undefined);
  assert.deepEqual(movedEvents(f, 'move-codex').at(-1).patch, { workingDir: storedDir(to), workspaceKind: 'project', projectDir: null });
  // Protocol: the desktop's own push (sessions.ts broadcastRecentWorkdirsChanged sends this channel with
  // { path }); its renderer listens on it (preload localDb.recentWorkdirs.onChanged), reached here through
  // the web shim and the client-mode window. Another channel or payload and the recent list goes stale.
  assert.deepEqual(recentPushes(f), [{ type: 'plugin_push', channel: 'local-db:recent-workdirs:changed', payload: { path: storedDir(to) } }]);
  assert.ok((await listRecentWorkdirs()).find(entry => entry.path === storedDir(to))?.lastUsedAt > new Date(1_000).toISOString());
});

// L338, unit: preserve the executor cleanup for cold Pi/Codex tasks even when Maker
// has already released its live session but executor bindings can still exist.
test('move: cold Pi and Codex tasks still release their executor state', async t => {
  const f = await fixture(t);
  for (const agentKind of ['pi', 'codex']) {
    const id = 'cold-' + agentKind;
    const from = moveDir(f, id + '-from');
    const to = moveDir(f, id + '-to');
    await f.task(id, { agentKind, workDir: from });
    assert.equal(f.liveSession(id), undefined);
    await f.update(id, { workingDir: to });
    assert.equal((await f.row(id)).workingDir, storedDir(to));
    assert.equal(f.closedByExecutor.filter(closed => closed === id).length, 1);
  }
});

test('move: a Claude task\'s transcripts follow it, and the resume id the move persisted is in the row and the published patch', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const claudeConfig = path.join(f.root, 'claude-config');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
  const from = moveDir(f, 'claude-from');
  const to = moveDir(f, 'claude-to');
  const storedId = '11111111-1111-4111-8111-111111111111';
  const liveId = '22222222-2222-4222-8222-222222222222';
  await f.task('move-claude', { workDir: from });
  await f.database.drizzle.update(sessions).set({ sdkSessionId: storedId }).where(eq(sessions.id, 'move-claude'));
  const coldId = 'cold-claude';
  await f.task(coldId, { workDir: from });
  await f.update(coldId, { workingDir: to });
  assert.equal((await f.row(coldId)).workingDir, storedDir(to));
  assert.deepEqual(f.closedByExecutor, [], 'no idle runtime close is needed for a cold task');
  // The live runtime is ahead of the row (a fork whose rows are not written yet); its transcript is on disk.
  const session = f.runtime('move-claude');
  session.sdkSessionId = liveId;
  const source = path.join(claudeConfig, 'projects', 'old-key');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, `${liveId}.jsonl`), '{"type":"user"}\n');
  const patch = { workingDir: `${to}/`, workspaceKind: 'project' };
  let running = true;
  session.isTurnRunning = () => running;
  const before = await f.row('move-claude');
  await assert.rejects(f.update('move-claude', patch), error => error.code === 'PRECONDITION_FAILED');
  assert.deepEqual(await f.row('move-claude'), before);
  assert.equal(f.liveSession('move-claude'), session);
  assert.deepEqual(readdirSync(path.join(claudeConfig, 'projects')), ['old-key']);
  running = false;
  await f.update('move-claude', patch);
  const row = await f.row('move-claude');
  assert.deepEqual([row.workingDir, row.sdkSessionId], [storedDir(to), liveId]);
  assert.deepEqual(movedEvents(f, 'move-claude').at(-1).patch,
    { workingDir: storedDir(to), workspaceKind: 'project', sdkSessionId: liveId, projectDir: null });
  assert.equal(f.liveSession('move-claude'), undefined, 'the Claude runtime in the old directory is closed');
  const copies = readdirSync(path.join(claudeConfig, 'projects'))
    .filter(key => key !== 'old-key' && existsSync(path.join(claudeConfig, 'projects', key, `${liveId}.jsonl`)));
  assert.equal(copies.length, 1, 'the transcript is copied under the new directory\'s key');
});

test('move: inside the task lock the move re-enters it; another holder of the lock waits until the move is done', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  setSessionRouteLockImplementation(withSendToSessionLock);
  t.after(() => setSessionRouteLockImplementation(null));
  const to = moveDir(f, 'locked-to');
  await f.task('move-locked', { agentKind: 'codex', workDir: moveDir(f, 'locked-from') });
  // As main.ts: the entry runs in the task's send lock, and the move takes the route lock again.
  await lockSessionRoute(f.update)('move-locked', { workingDir: to, workspaceKind: 'project' });
  assert.equal((await f.row('move-locked')).workingDir, storedDir(to));

  // The move holds the lock while it closes the runtime; another holder (a send) waits behind it.
  f.runtime('move-locked', { agentKind: 'codex' });
  f.closedByExecutor.length = 0;
  let open;
  f.closeGate.current = new Promise(resolve => { open = resolve; });
  const back = moveDir(f, 'locked-back');
  const moving = lockSessionRoute(f.update)('move-locked', { workingDir: back, workspaceKind: 'project' });
  for (let i = 0; i < 200 && !f.closedByExecutor.includes('move-locked'); i += 1) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.closedByExecutor, ['move-locked'], 'the move is closing the runtime');
  let ran = false;
  const other = withSendToSessionLock('move-locked', async () => { ran = true; return (await f.row('move-locked')).workingDir; });
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(ran, false, 'waits while the move holds the task lock');
  open();
  await moving;
  assert.equal(await other, storedDir(back), 'runs after the move and reads the moved directory');
});

// The desktop's registry: `{ worktrees: { <task>: { path } } }` in the profile root (worktreeStore.ts).
const writeRegistry = (f, text) => writeFileSync(path.join(f.profile, 'worktrees.json'), text);

test('move: the worktree registry decides ownership; no registry is no binding, an unreadable one refuses the move', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const worktree = moveDir(f, path.join('repo', '.cindy-worktrees', 'feature'));
  const elsewhere = moveDir(f, 'elsewhere');
  const unchanged = async (id, patch, check) => {
    const before = await f.row(id);
    await assert.rejects(f.update(id, patch), check);
    assert.deepEqual(await f.row(id), before, 'nothing is written');
  };
  for (const [name, registry, outcome] of [
    ['bound', JSON.stringify({ worktrees: { 'wt-bound': { path: worktree } } }), 'blocked'],
    ['no registry', null, 'moved'],
    ['registry without the task', JSON.stringify({ worktrees: {} }), 'moved'],
    ['not JSON', '{"worktrees":', 'failed'],
    ['not the registry\'s shape', JSON.stringify({ worktrees: [] }), 'failed'],
    ['an entry without a path', JSON.stringify({ worktrees: { 'wt-entry': {} } }), 'failed'],
  ]) {
    const id = { bound: 'wt-bound', 'an entry without a path': 'wt-entry' }[name] ?? `wt-${name.replaceAll(/\W+/g, '-')}`;
    // The task's directory is a managed worktree path either way: a recycled worktree keeps it (no binding).
    await f.task(id, { agentKind: 'codex', workDir: worktree });
    rmSync(path.join(f.profile, 'worktrees.json'), { force: true });
    if (registry !== null) writeRegistry(f, registry);
    const patch = { workingDir: elsewhere, workspaceKind: 'project' };
    if (outcome === 'moved') {
      await f.update(id, patch);
      assert.equal((await f.row(id)).workingDir, storedDir(elsewhere), name);
    } else if (outcome === 'blocked') {
      await unchanged(id, patch, error => error.code === 'PRECONDITION_FAILED'
        && error.message.includes('A worktree session cannot be moved outside its worktree'));
    } else {
      await unchanged(id, patch, error => error instanceof Error && !error.message.includes('cannot be moved outside'));
    }
  }
  // A move inside the bound worktree, and a move to a dialogue, stay allowed.
  writeRegistry(f, JSON.stringify({ worktrees: { 'wt-bound': { path: worktree } } }));
  await f.update('wt-bound', { workingDir: moveDir(f, path.join('repo', '.cindy-worktrees', 'feature', 'sub')) });
  await f.update('wt-bound', { workspaceKind: 'dialogue' });
  assert.equal((await f.row('wt-bound')).workspaceKind, 'dialogue');
});

test('move: a task in a turn, or whose turn is still settling, is not moved and its runtime is not closed', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const to = moveDir(f, 'busy-to');
  for (const [id, agentKind, state] of [
    ['busy-claude', 'claude-code', 'in a turn'],
    ['busy-codex', 'codex', 'in a turn'],
    ['busy-turn', 'pi', 'in a turn'],
    ['busy-settling', 'pi', 'settling'],
  ]) {
    await f.task(id, { agentKind, workDir: moveDir(f, `${id}-from`) });
    const session = f.runtime(id, { agentKind, inTurn: state === 'in a turn' });
    if (state === 'settling') f.settling.add(id);
    const before = await f.row(id);
    await assert.rejects(f.update(id, { workingDir: to, workspaceKind: 'project' }),
      error => error.code === 'PRECONDITION_FAILED' && error.message.includes('运行中的任务不能移动'), state);
    assert.deepEqual(await f.row(id), before, state);
    assert.equal(f.liveSession(id), session, `${state}: the same runtime is kept`);
    assert.deepEqual(movedEvents(f, id), []);
  }
  assert.deepEqual(f.closedByExecutor, []);
});

test('move and window budget: a Review task refuses both, before anything is written', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.task('review-move', { workDir: moveDir(f, 'review-from') });
  await f.database.drizzle.update(sessions).set({ source: 'review' }).where(eq(sessions.id, 'review-move'));
  const before = await f.row('review-move');
  for (const patch of [{ workingDir: moveDir(f, 'review-to'), workspaceKind: 'project' }, { contextWindowBudget: 100_000 }]) {
    await assert.rejects(f.update('review-move', patch),
      error => error.code === 'UNSUPPORTED_CAPABILITY' && /Review task settings/.test(error.message), Object.keys(patch).join());
  }
  assert.deepEqual(await f.row('review-move'), before);
  assert.equal(readSessionContextWindowBudget('review-move'), null, 'the budget preference is not written');
  assert.deepEqual(movedEvents(f, 'review-move'), []);
});

// updatedAt and the send's recent project (A18, A19: the desktop's isSessionSettingsOnlyPatch and
// recordRecentWorkdirForSend, moved out of updateSessionInDb and touchUserSendInDb):
// - Rule: a patch of settings only (title, pin, mute, move) leaves updatedAt alone and a status change
//   moves it (the sidebar orders by it); a user's send records the project it was made in as recent,
//   announced while the owner holds; a stamp that changes nothing records and announces nothing.
// - Gap: the Host bumped updatedAt on every /sessions/update, and its send recorded no recent project.
// - Minimal failing input: each patch below on a task stamped updatedAt = 1; one send, the same send
//   again, a send after the owner changed.
// - Tier: unit, through the real entries over a migrated profile database.
test('updatedAt: settings-only patches leave it, a status change moves it', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const to = moveDir(f, 'stamp-to');
  for (const [name, patch, moves] of [
    ['a title', { title: 'Renamed' }, false],
    ['a pin', { pinnedAt: new Date().toISOString() }, false],
    ['a mute', { notificationsMuted: true }, false],
    ['a move', { workingDir: to, workspaceKind: 'project' }, false],
    ['an archive', { status: 'archived' }, true],
  ]) {
    const id = `stamp-${name.replaceAll(' ', '-')}`;
    await f.task(id, { agentKind: 'codex', workDir: moveDir(f, `${id}-from`) });
    await f.database.drizzle.update(sessions).set({ updatedAt: 1 }).where(eq(sessions.id, id));
    await f.update(id, patch);
    const row = await f.row(id);
    if (moves) assert.ok(row.updatedAt > 1, name);
    else assert.equal(row.updatedAt, 1, name);
    assert.ok(movedEvents(f, id).length > 0, `${name}: still published`);
  }
});

// §3.2 DB: the upstream Inbox writes through /api/sessions/update in client mode.
// This entry rejected snoozedUntil. A valid future deadline must save and publish both
// timestamps without changing the task status or activity. ccda86c776 also reserves
// one ISO value past the one-year limit. A regular date alone misses that branch.
// Minimal failing input: the reserved value through the same service, with no other patch.
// Invalid input must still write nothing. This DB case reuses the existing migrated fixture.
test('task snooze: the Host update saves, rejects and clears the date like the desktop', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const id = 'snoozed-task';
  await f.task(id);
  await f.database.drizzle.update(sessions).set({ updatedAt: 1 }).where(eq(sessions.id, id));
  const invoke = createHostService({ updateSession: lockSessionRoute(f.update) });
  const update = patch => invoke('/api/sessions/update', { sessionId: id, patch });
  const snoozedUntil = new Date(Date.now() + 3_600_000).toISOString();
  const { status, body: saved } = await update({ snoozedUntil });
  assert.equal(status, 200);
  assert.equal(saved.status, 'active');
  assert.equal(saved.snoozedUntil, snoozedUntil);
  const row = await f.row(id);
  assert.equal(row.updatedAt, 1);
  assert.equal(row.snoozedUntil, Date.parse(snoozedUntil));
  assert.equal(row.snoozedAt, Date.parse(saved.snoozedAt));
  assert.ok(row.snoozedAt > 0);
  assert.deepEqual(movedEvents(f, id).at(-1).patch, { snoozedUntil, snoozedAt: saved.snoozedAt });

  const pushes = f.events.length;
  for (const invalid of [123, 'not-a-date', '2000-01-01T00:00:00.000Z', new Date(Date.now() + 367 * 86_400_000).toISOString()]) {
    await assert.rejects(update({ title: 'Do not apply', snoozedUntil: invalid }), {
      code: 'INVALID_PARAMS',
      message: '[INVALID_PARAMS] snoozedUntil must be a future ISO timestamp within one year',
    });
  }
  assert.deepEqual(await f.row(id), row);
  assert.equal(f.events.length, pushes);

  const { status: indefiniteStatus, body: indefinite } = await update({ snoozedUntil: INDEFINITE_SNOOZE_UNTIL });
  assert.equal(indefiniteStatus, 200);
  assert.equal(indefinite.snoozedUntil, INDEFINITE_SNOOZE_UNTIL);
  const indefiniteRow = await f.row(id);
  assert.equal(indefiniteRow.snoozedUntil, Date.parse(INDEFINITE_SNOOZE_UNTIL));
  assert.equal(indefiniteRow.updatedAt, 1);
  assert.deepEqual(movedEvents(f, id).at(-1).patch,
    { snoozedUntil: INDEFINITE_SNOOZE_UNTIL, snoozedAt: indefinite.snoozedAt });

  const { body: cancelled } = await update({ snoozedUntil: null });
  assert.deepEqual([cancelled.snoozedUntil, cancelled.snoozedAt], [null, null]);
  assert.deepEqual(movedEvents(f, id).at(-1).patch, { snoozedUntil: null, snoozedAt: null });
  await update({ snoozedUntil });
  const { body: archived } = await update({ status: 'archived' });
  assert.deepEqual([archived.status, archived.snoozedUntil, archived.snoozedAt], ['archived', null, null]);
  const archivedRow = await f.row(id);
  assert.deepEqual([archivedRow.snoozedUntil, archivedRow.snoozedAt], [null, null]);
  assert.deepEqual(movedEvents(f, id).at(-1).patch, { status: 'archived', snoozedUntil: null, snoozedAt: null });
});

// df520e3564: a send in an unregistered directory must neither add a project nor push a project refresh.
// The existing fixture covered recency and owner checks, but not the registered/unregistered boundary.
test('send: only a registered project becomes recent and is announced; an unchanged stamp or another owner announces nothing', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const project = moveDir(f, 'sent-project');
  await f.task('sent', { workDir: project });
  const owner = { client: f.database };
  // The owner the entry reads first, then the one current when it announces (an account switch during
  // the write when they differ).
  let after = owner;
  let reads = 0;
  const touch = createHostTouchUserSend({ getOwner: () => (reads++ === 0 ? owner : after), publish: event => f.events.push(event),
    broadcastRecentWorkdirsChanged: createRecentWorkdirsChangedPush(event => f.events.push(event)) });
  await touch('sent', 4_000);
  assert.equal((await listRecentWorkdirs()).some(entry => entry.path === storedDir(project)), false);
  assert.deepEqual(recentPushes(f), []);
  await upsertRecentWorkdir(project, 1_000);

  reads = 0;
  await touch('sent', 5_000);
  assert.equal((await listRecentWorkdirs()).find(entry => entry.path === storedDir(project))?.lastUsedAt, new Date(5_000).toISOString());
  assert.deepEqual(recentPushes(f), [{ type: 'plugin_push', channel: 'local-db:recent-workdirs:changed', payload: { path: storedDir(project) } }]);
  assert.equal(movedEvents(f, 'sent').at(-1).patch.userSendAt, new Date(5_000).toISOString());
  const events = f.events.length;
  reads = 0;
  await touch('sent', 5_000);
  assert.equal(f.events.length, events, 'the same stamp again changes nothing');
  reads = 0;
  after = { client: f.database };
  await touch('sent', 6_000);
  assert.equal(f.events.length, events, 'nothing is announced once the owner changed during the send');
  assert.equal((await f.row('sent')).userSendAt, 6_000, 'the entry\'s own database is still stamped');
});

test('archive and soft-delete use terminal transaction, guard deleteTarget, stop runtime and broadcast unpin summary', async t => {
  const softDeleted = [];
  const f = await fixture(t, { onSoftDelete: async id => { softDeleted.push(id); } });
  await f.task('arch');
  await f.database.drizzle.update(sessions).set({ pinnedAt: 1000, summary: 'pinned', snoozedUntil: Date.now() + 60_000, snoozedAt: 1000 }).where(eq(sessions.id, 'arch'));
  const archived = await f.update('arch', { status: 'archived', pinnedAt: null });
  assert.equal(archived.status, 'archived');
  assert.equal(archived.pinnedAt, null);
  assert.equal(archived.snoozedUntil, null);
  assert.equal((await f.row('arch')).summary, null);
  assert.equal(movedEvents(f, 'arch').at(-1).patch.summary, null);
  await f.task('del');
  await f.task('child');
  await f.database.drizzle.update(sessions).set({ parentSessionId: 'del', source: 'side-chat', sideChatPromoted: false }).where(eq(sessions.id, 'child'));
  await assert.rejects(f.update('del', { status: 'deleted' }, { deleteTarget: 'side-chat' }), { code: 'PRECONDITION_FAILED' });
  assert.equal((await f.row('del')).status, 'active');
  const deleted = await f.update('del', { status: 'deleted' }, { deleteTarget: 'task' });
  assert.equal(deleted.status, 'deleted');
  assert.equal((await f.row('del')).status, 'deleted');
  assert.equal((await f.row('child')).status, 'deleted');
  assert.deepEqual(softDeleted, ['del', 'child']);
  await assert.rejects(f.update('del', { status: 'archived', pinnedAt: null }), { code: 'PRECONDITION_FAILED' });
  assert.equal((await f.row('del')).status, 'deleted');
});

// PR 12316, SQLite integration: a queued send needs the route lock while parent cleanup
// fails. Both committed deletions must reach observers and the child must still stop.
test('soft delete releases the route lock before draining and isolates parent cleanup failure', { timeout: 10_000 }, async t => {
  const cleaned = [];
  let releaseSend;
  const sendReady = new Promise(resolve => { releaseSend = resolve; });
  const send = sendReady.then(() => withSendToSessionLock('parent', async () => {}));
  const f = await fixture(t, { onSoftDelete: async id => {
    cleaned.push(id);
    if (id === 'parent') {
      releaseSend();
      await send;
      throw new Error('parent abort failed');
    }
  } });
  await f.task('parent');
  await f.task('child');
  await f.database.drizzle.update(sessions).set({ parentSessionId: 'parent', source: 'side-chat', sideChatPromoted: false }).where(eq(sessions.id, 'child'));
  await assert.rejects(f.update('parent', { status: 'deleted' }), /parent abort failed/);
  assert.deepEqual(cleaned.sort(), ['child', 'parent']);
  for (const id of cleaned) assert.equal(movedEvents(f, id).at(-1).status, 'deleted');
});
