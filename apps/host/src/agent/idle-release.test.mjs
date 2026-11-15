import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { hostRuntimeLayout } from '../runtime-layout.mjs';
import { openOwnerDatabase } from '../../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { OwnerSessionStorage } from '../../../desktop/src/main/localDb/sessionStorageAdapter.ts';
import { AgentInputCoordinator } from '../../../desktop/src/main/maker-ipc/agent-input-coordinator.ts';
import { withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.ts';
import {
  noteClaudeSessionTurnState, recordClaudeApiActivity, resetClaudeBackgroundActivityForTests,
} from '../../../desktop/src/main/maker-host/claude-session-background-activity.ts';
import { createHostIdleRelease } from './idle-release.ts';

const MINUTE = 60_000;

// Ordinary tasks in this owner's real (migrated) database: the desktop's ordinary-task SQL and the Pi
// candidate queries run against the schema the Host opens, not a hand-made table.
async function fixture(t) {
  const sharedProfile = process.env.XDT_OFFICIAL_SHARED_PROFILE;
  delete process.env.XDT_OFFICIAL_SHARED_PROFILE;
  t.after(() => { if (sharedProfile !== undefined) process.env.XDT_OFFICIAL_SHARED_PROFILE = sharedProfile; });
  const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-host-idle-release-'));
  const profile = path.join(root, 'profile');
  mkdirSync(profile, { recursive: true });
  configureHostOwner({ userDataDir: profile, ownerId: 'owner-idle-release' });
  configureAppDataDir(path.join(root, 'app-data'));
  const layout = hostRuntimeLayout();
  const opened = await openOwnerDatabase({ userDataDir: profile, ownerId: 'owner-idle-release',
    isPackaged: false, drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath });
  const database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, 'owner-idle-release');
  const storage = new OwnerSessionStorage({ db: () => database });
  const clock = { monotonic: 0, wall: Date.parse('2026-11-15T00:00:00Z') };
  const live = new Map();
  const closes = [];
  const maker = {
    listActiveSessions: () => [...live.values()],
    getSession: id => live.get(id),
    async closeSessionIfCurrent(session, reason, options) {
      closes.push({ id: session.id, reason, options });
      if (live.get(session.id) !== session) return 'not-current';
      if (options?.onlyIfIdle && !(await session.closeIfIdle())) return 'busy';
      live.delete(session.id);
      return 'closed';
    },
  };
  const queued = new Map();
  const coordinator = new AgentInputCoordinator({
    sendToAgent: async () => 'accepted', steerToAgent: async () => {}, abortSession: async () => {},
    isTurnRunning: () => false, getTurnGeneration: () => 0, hasPendingInteraction: () => false,
    getAgentKind: () => 'claude-code', getSdkSessionId: async () => undefined,
    hasAssistantProgressAfter: async () => false, createUserMessage: async () => undefined,
    touchUserSend: async () => {}, emitProjection: () => {}, persistQueueSnapshot: async () => {},
    loadQueueSnapshot: async id => queued.get(id) ?? [], getPersistedClientIds: async () => new Set(),
  });
  const running = new Set();
  const interactions = new Set();
  let claudeMinutes = 30;
  const release = createHostIdleRelease({
    coordinator, getMaker: () => maker,
    isTurnPendingCompletion: id => running.has(id),
    hasPendingInteraction: id => interactions.has(id),
    readClaudeMinutes: () => claudeMinutes,
    clock: { monotonic: () => clock.monotonic, wall: () => clock.wall },
  });
  t.after(async () => {
    release.stop();
    resetClaudeBackgroundActivityForTests();
    clearCurrentDbClient(); await database.dispose();
    configureHostOwner({ userDataDir: profile, ownerId: null });
    rmSync(root, { recursive: true, force: true });
  });
  /** A task row and its live runtime, idle since now. */
  async function task(id, agentKind) {
    const dbKind = agentKind === 'claude-code' ? 'cc' : agentKind;
    await storage.create({ id, title: id, agentKind, model: 'model', workDir: root });
    opened.db.prepare('UPDATE sessions SET sdk_session_id = ?, updated_at = ?, last_turn_ended_at = ?, user_send_at = ? WHERE id = ?')
      .run(`native-${id}`, clock.wall, clock.wall, clock.wall, id);
    assert.equal(opened.db.prepare('SELECT agent_kind FROM sessions WHERE id = ?').get(id).agent_kind, dbKind);
    let generation = 0;
    const listeners = new Set();
    const session = {
      id, agentKind, remoteHostId: null, agentDeviceId: null, sdkSessionId: `native-${id}`,
      tasks: [], turnRunning: false,
      getStatus: () => 'active', getTurnGeneration: () => generation,
      isTurnRunning: () => session.turnRunning, listBackgroundTasks: () => session.tasks,
      countPendingWakeContinuations: () => 0, manageAsyncUserQuestions: () => ({ questions: [] }),
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      closeIfIdle: async () => true, close: async () => {}, hasLiveBackgroundWork: async () => false,
      /** A send started a new turn on this runtime. */
      startTurn() { generation += 1; for (const listener of listeners) listener({ type: 'status', data: { isRunning: true } }); },
    };
    live.set(id, session);
    return session;
  }
  /** Moves both clocks forward, as idle time passes. */
  function pass(ms) { clock.monotonic += ms; clock.wall += ms; }
  const released = () => closes.filter(close => !live.has(close.id)).map(close => close.id).sort();
  return { task, pass, release, closes, released, queued, running, interactions, live,
    setClaudeMinutes(minutes) { claudeMinutes = minutes; } };
}

test('idle release: ordinary Claude, Codex and Pi tasks release their runtimes after 30 idle minutes, idle-only and resumable', async t => {
  const f = await fixture(t);
  await f.task('claude', 'claude-code');
  await f.task('codex', 'codex');
  await f.task('pi', 'pi');
  await f.release.scanNow();
  f.pass(29 * MINUTE);
  await f.release.scanNow();
  assert.deepEqual(f.released(), [], 'not before 30 minutes');
  f.pass(2 * MINUTE);
  await f.release.scanNow();
  assert.deepEqual(f.released(), ['claude', 'codex', 'pi']);
  for (const close of f.closes) {
    assert.equal(close.reason, 'runtime-refresh', 'a transient close: task resources and native identity stay');
    assert.deepEqual(close.options, { onlyIfIdle: true });
  }
});

test('idle release: the Claude override in the profile root shortens Claude only', async t => {
  const f = await fixture(t);
  f.setClaudeMinutes(5);
  await f.task('claude', 'claude-code');
  await f.task('codex', 'codex');
  await f.release.scanNow();
  f.pass(6 * MINUTE);
  await f.release.scanNow();
  assert.deepEqual(f.released(), ['claude']);
});

test('idle release: queued input, a settling turn, a pending interaction, a background task or Claude background activity keep the runtime', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-15T00:00:00Z') });
  const f = await fixture(t);
  const queued = await f.task('queued', 'claude-code');
  f.queued.set('queued', [{ clientId: 'next', text: 'next', persistedContent: 'next', model: 'model', effort: 'medium',
    permissionMode: 'default', workingDir: '/repo',
    chatMessage: { clientId: 'next', role: 'user', content: 'next', isStreaming: false, createdAt: '2026-11-15T00:00:00.000Z' },
    createOpts: { agentKind: 'claude-code', workingDir: '/repo', model: 'model', effort: 'medium', permissionMode: 'default' } }]);
  await f.task('settling', 'codex');
  f.running.add('settling');
  // The desktop's Claude and Codex watchers read pending interactions; its Pi watcher does not
  // (a Pi turn waiting on one is still running), and neither does the Host's.
  await f.task('asking', 'codex');
  f.interactions.add('asking');
  const background = await f.task('background', 'codex');
  background.tasks = [{ taskId: 'build' }];
  // Claude's sub-agent still calls the model after the turn ended (the proxy records it).
  await f.task('subagent', 'claude-code');
  noteClaudeSessionTurnState('subagent', true);
  noteClaudeSessionTurnState('subagent', false);
  t.mock.timers.tick(5_000);
  recordClaudeApiActivity('native-subagent', 'subagent');
  await f.release.scanNow();
  f.pass(31 * MINUTE);
  await f.release.scanNow();
  assert.deepEqual(f.released(), [], 'every runtime is kept');
  assert.ok(queued, 'the queued task has a live runtime');
});

test('idle release: a release waits for the task\'s send lock and leaves a runtime whose send started meanwhile', async t => {
  const f = await fixture(t);
  const session = await f.task('sending', 'claude-code');
  await f.release.scanNow();
  f.pass(31 * MINUTE);
  let releaseLock;
  const held = new Promise(resolve => { releaseLock = resolve; });
  const sending = withSendToSessionLock('sending', async () => { await held; session.startTurn(); });
  const scanning = f.release.scanNow();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.closes, [], 'the release waits for the send that holds the lock');
  releaseLock();
  await sending;
  await scanning;
  assert.deepEqual(f.released(), [], 'the send started a new turn: the runtime stays');
});
