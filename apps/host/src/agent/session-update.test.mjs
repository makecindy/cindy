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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { hostRuntimeLayout } from '../runtime-layout.mjs';
import { openOwnerDatabase } from '../../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { OwnerSessionStorage } from '../../../desktop/src/main/localDb/sessionStorageAdapter.ts';
import { sessions } from '../../../desktop/src/main/localDb/schema.ts';
import { setSessionProvider, getSessionProvider, clearSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.ts';
import { createHostSessionUpdate } from './session-update.ts';
import { setModelWithWindowConfirmation } from '../../../desktop/src/renderer/features/cc-agent/lib/modelWindowConfirmation.ts';
import { createHostTaskRestore } from './task-restore.ts';
import { setSessionRouteLockImplementation } from '../../../desktop/src/main/localDb/sessionRouteLock.ts';
import { withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.ts';
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
  const taskRestore = createHostTaskRestore({ getOwner: () => database, publish: event => events.push(event) });
  const restoreCalls = [];
  const restoreTaskToActive = (id, options) => { restoreCalls.push(['task list', id]); return taskRestore.restoreTaskToActive(id, options); };
  const maker = {
    getSession: id => live.get(id) ?? null,
    getSessionMeta: id => live.get(id) ? { id, agentKind: live.get(id).agentKind } : null,
    closeSession: async id => { live.delete(id); },
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
    readStoredSessionContextWindowBudget: id => budgets.get(id) ?? null,
    codexProxyAuthInjectionState: () => null,
    inputQueue: { contextRecoveryRollover: () => null, sessionDbAgentKind: () => 'cc', isTurnRunning: () => false,
      wakeSession() {}, refreshQueuedRoute() {}, cancelUsageLimitWait() {} },
    log: quiet,
  });
  const update = createHostSessionUpdate({
    restoreTaskToActive,
    readSessionForRun: async id => (await database.drizzle.select().from(sessions).where(eq(sessions.id, id)))[0],
    publish: event => events.push(event),
    setModel: (...args) => selection.setModel(...args),
  });
  const task = async (id, { agentKind = 'claude-code', model = 'big', contextTokens = 0 } = {}) => {
    await storage.create({ id, title: 'Window fixture', agentKind, model, workDir: root, providerId: 'prov-a' });
    await database.drizzle.update(sessions).set({ contextTokens }).where(eq(sessions.id, id));
    setSessionProvider(id, 'prov-a');
    t.after(() => clearSessionProvider(id));
  };
  const runtime = (id, { model = 'big', inTurn = false, usage, agentKind = 'claude-code' } = {}) => {
    const session = { id, agentKind, model, setModelCalls: [],
      isTurnRunning: () => inTurn,
      getUsageSnapshot: () => usage,
      async setModel(next, options) { session.setModelCalls.push([next, options]); session.model = next; },
      async setEffort() {} };
    live.set(id, session);
    return session;
  };
  const row = async id => (await database.drizzle.select().from(sessions).where(eq(sessions.id, id)))[0];
  return { update, task, runtime, row, events, budgets, database, taskRestore, restoreCalls, selection };
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

test('model change: a task that does not exist is "session not found", as before the gate, and a runtime left without its row is not changed', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.update('window-missing', { model: 'small' }), { message: 'session not found' });
  await assert.rejects(f.update('window-missing', { title: 'Renamed' }), { message: 'session not found' });
  // Before the gate, the running Agent was switched and then the missing row reported.
  const orphan = f.runtime('window-orphan');
  await assert.rejects(f.update('window-orphan', { model: 'small' }), { message: 'session not found' });
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
  await assert.rejects(f.update('old-path-unknown', { title: 'Renamed', workingDir: '/tmp', colour: 'red' }), error =>
    error.code === 'INVALID_PARAMS' && /workingDir, colour/.test(error.message));
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
    ['restore-list', { status: 'active', title: 'Back' }],
    ['restore-send', { status: 'active' }],
  ]);
  assert.deepEqual(f.restoreCalls, [['task list', 'restore-list']]);
  // An active task is left as it is by a send.
  await f.taskRestore.restoreArchivedSessionForSend('restore-send');
  assert.equal(f.events.length, 2);
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
