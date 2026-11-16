/**
 * The Host's /sessions/update with the desktop's set-model (session-update.ts, runtime-selection.ts).
 * - Rule: a user's model or provider pick is the desktop's (sessionRuntimeSelectionApply.ts, the user
 *   branch of handleSetModel): an intent until the next send, returned as
 *   { deferred: true, superseded: false, pendingUntilSend: true } and published as the task's
 *   agentSwitchIntent; the task row and the running Agent keep their route. Picking the current
 *   model again cancels the intent. The window gate and a rebuild run when the intent lands at the
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
import { createHostTaskRestore } from './task-restore.ts';
import { setSessionRouteLockImplementation } from '../../../desktop/src/main/localDb/sessionRouteLock.ts';
import { withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.ts';
import { botProfiles, botSessionLinks } from '../../../desktop/src/main/localDb/schema.ts';
import { createHostRuntimeSelection } from './runtime-selection.ts';

// Route windows of the fixture providers; a model they do not list has no verified window.
const WINDOWS = { big: 200_000, small: 100_000, huge: 300_000 };
const model = id => ({ id, efforts: [], defaultEffort: null, supportsFastMode: false });
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
    getMaker: () => maker,
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
    getLiveSession: id => live.get(id),
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
