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
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { hostRuntimeLayout } from '../runtime-layout.mjs';
import { openOwnerDatabase } from '../../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { OwnerSessionStorage } from '../../../desktop/src/main/localDb/sessionStorageAdapter.ts';
import { sessions } from '../../../desktop/src/main/localDb/schema.ts';
import { setSessionProvider, getSessionProvider, clearSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.ts';
import { planUserRuntimeModelSwitch } from '../../../desktop/src/shared/runtimeModelSwitchGate.ts';
import { createHostSessionUpdate } from './session-update.ts';
import { createHostTaskRestore } from './task-restore.ts';
import { botProfiles, botSessionLinks } from '../../../desktop/src/main/localDb/schema.ts';
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
  const taskRestore = createHostTaskRestore({ getOwner: () => database, publish: event => events.push(event) });
  const restoreCalls = [];
  const restoreTaskToActive = (id, options) => { restoreCalls.push(['task list', id]); return taskRestore.restoreTaskToActive(id, options); };
  const update = createHostSessionUpdate({
    restoreTaskToActive,
    getLiveSession: id => live.get(id),
    readSessionForRun: async id => (await database.drizzle.select().from(sessions).where(eq(sessions.id, id)))[0],
    publish: event => events.push(event),
    modelWindow: () => ({
      resolveRouteWindow: (_agentKind, modelId, _providerId, budget) => {
        const window = WINDOWS[modelId] ?? null;
        return window !== null && budget ? Math.min(window, budget) : window;
      },
      readSessionBudget: async id => budgets.get(id) ?? null,
    }),
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
  return { update, task, runtime, row, events, budgets, database, taskRestore, restoreCalls };
}

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
