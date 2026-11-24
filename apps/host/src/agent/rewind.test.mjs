import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { configureAppDataDir, configureUserDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { commitVolatileAppSession } from '../../../desktop/src/main/appSessionState.ts';
import { openOwnerDatabase } from '../../../desktop/src/main/localDb/startupCore.ts';
import { configureSqliteVecExtPath } from '../../../desktop/src/main/localDb/sqliteVecLoader.ts';
import { createDbClientForHandle } from '../../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { clearCurrentDbClient, setCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { messages, sessions } from '../../../desktop/src/main/localDb/schema.ts';
import { withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.ts';
import { __resetClaudeTranscriptPathCacheForTesting } from '../../../desktop/src/main/maker-orchestration/claudeTranscriptAnchors.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { hostRuntimeLayout } from '../runtime-layout.mjs';
import { createInputQueue } from './input-queue.mjs';
import { createHostRewind } from './rewind.ts';

async function fixture(t, overrides = {}) {
  const sharedProfile = process.env.XDT_OFFICIAL_SHARED_PROFILE;
  const prevClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  const prevXdtDir = process.env.XDT_USER_DATA_DIR;
  delete process.env.XDT_OFFICIAL_SHARED_PROFILE;
  const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-host-rewind-'));
  const profile = path.join(root, 'profile');
  const workDir = path.join(root, 'work');
  const fakeHome = path.join(root, 'home');
  const fakeClaude = path.join(root, 'claude-config');
  mkdirSync(profile, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(fakeClaude, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = fakeClaude;
  delete process.env.XDT_USER_DATA_DIR;
  t.mock.method(os, 'homedir', () => fakeHome);
  __resetClaudeTranscriptPathCacheForTesting();
  configureHostOwner({ userDataDir: profile, ownerId: 'owner-rewind' });
  configureUserDataDir(profile);
  configureAppDataDir(path.join(root, 'app-data'));
  commitVolatileAppSession('cloud', 'owner-rewind', true);
  const layout = hostRuntimeLayout();
  configureSqliteVecExtPath(layout.sqliteVecPath);
  const opened = await openOwnerDatabase({
    userDataDir: profile, ownerId: 'owner-rewind', isPackaged: false,
    drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath,
  });
  const database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, 'owner-rewind');
  t.after(async () => {
    if (sharedProfile !== undefined) process.env.XDT_OFFICIAL_SHARED_PROFILE = sharedProfile;
    if (prevClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfig;
    if (prevXdtDir === undefined) delete process.env.XDT_USER_DATA_DIR;
    else process.env.XDT_USER_DATA_DIR = prevXdtDir;
    __resetClaudeTranscriptPathCacheForTesting();
    commitVolatileAppSession('signed-out', null, true);
    clearCurrentDbClient();
    await database.dispose();
    configureHostOwner({ userDataDir: profile, ownerId: null });
    rmSync(root, { recursive: true, force: true });
  });

  const events = [];
  const clearedHandoffs = [];
  const recoveredImages = [];
  const lastAssistantUuids = [];
  const bootstrapCalls = [];
  const workDirChecks = [];
  let held = null;
  let holdGeneration = 0;

  const liveSessions = new Map();
  const maker = {
    getSession: id => liveSessions.get(id),
    getSessionMeta: async id => {
      const [row] = await database.drizzle.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      if (!row) return undefined;
      return { id: row.id, agentKind: 'claude-code', model: row.model, providerId: row.providerId, sdkSessionId: row.sdkSessionId, workDir: row.workingDir };
    },
    closeSession: async id => { liveSessions.delete(id); },
    closeSessionIfCurrent: async live => { if (liveSessions.get(live.id) === live) liveSessions.delete(live.id); },
  };

  const queue = createInputQueue({
    getMaker: () => maker,
    statDirectory: async () => ({ isDirectory: () => true }),
    readSession: async id => {
      const [row] = await database.drizzle.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      return row ?? { id, status: 'active', agentKind: 'claude-code', model: 'claude-fable-5-2', workingDir: workDir };
    },
    persistMessage: async () => {},
    sent: () => {},
    admitLocalRoute: async () => {},
    hub: { publish: event => { events.push(event); } },
    ...(overrides.queueDeps ?? {}),
  });
  t.after(async () => { if (overrides.allowFailedDispose) await queue.dispose().catch(() => {}); else await queue.dispose(); });

  const defaultStartPorts = {
    buildCreateOptsWithStderr: opts => ({ ...opts }),
    checkWorkDirExists: async (id, dir, kind) => { workDirChecks.push({ id, dir, kind }); return true; },
    readSessionExtraDirsFromDb: async () => overrides.extraDirs ?? [],
    readSessionWritableDirsFromDb: async () => overrides.writableDirs ?? [],
    bootstrapSession: async (opts, assertAccess, nativeHistoryResume) => {
      assertAccess?.();
      bootstrapCalls.push({ opts, nativeHistoryResume });
      const session = {
        id: opts.id,
        agentKind: opts.agentKind,
        sdkSessionId: opts.resumeSessionId ?? 'sdk-1',
        isTurnRunning: () => false,
        capabilities: { rewindFiles: { supported: true } },
        previewRewindFiles: async () => ({ canRewind: true, filesChanged: ['a.ts'] }),
        commitRewindFiles: async () => ({ canRewind: true, filesChanged: ['a.ts'], sdkSessionId: opts.resumeSessionId ?? 'sdk-1' }),
      };
      liveSessions.set(opts.id, session);
      return { session };
    },
  };

  const rewind = createHostRewind({
    getMaker: () => maker,
    resolveHandoffWindow: async () => 200_000,
    drainSessionPersistence: id => queue.drainSessionPersistence(id),
    setLastAssistantTranscriptUuid: (id, uuid) => { lastAssistantUuids.push([id, uuid]); queue.setLastAssistantTranscriptUuid(id, uuid); },
    startPorts: () => ({ ...defaultStartPorts, ...(overrides.startPorts ?? {}) }),
    withSessionInputStoppedForRewind: (id, action) => queue.withSessionInputStoppedForRewind(id, action),
    profileHoldReason: () => held,
    profileHoldGeneration: () => holdGeneration,
    clearPendingHandoff: id => { clearedHandoffs.push(id); },
    recoverGeneratedImages: async id => { recoveredImages.push(id); },
    publish: event => { events.push(event); },
    ...(overrides.rewindPorts ?? {}),
  });

  async function seed(sessionId, turns, { cold = false } = {}) {
    await database.drizzle.insert(sessions).values({
      id: sessionId, title: 'T', workingDir: workDir, agentKind: 'cc',
      model: 'claude-fable-5-2', status: 'active', sdkSessionId: 'sdk-1',
      createdAt: 1000, updatedAt: 1000,
    });
    let session = null;
    if (!cold) {
      session = {
        id: sessionId,
        agentKind: 'claude-code',
        sdkSessionId: 'sdk-1',
        isTurnRunning: () => false,
        capabilities: { rewindFiles: { supported: true } },
        previewRewindFiles: async () => ({ canRewind: true, filesChanged: ['a.ts'] }),
        commitRewindFiles: async () => ({ canRewind: true, filesChanged: ['a.ts'], sdkSessionId: 'sdk-1' }),
        abort: async () => {},
        onEvent: () => () => {},
      };
      liveSessions.set(sessionId, session);
    }
    let ts = 2000;
    for (const [uId, uUuid, aId, aUuid] of turns) {
      await database.drizzle.insert(messages).values({
        id: `${sessionId}-${uId}`, clientId: uId, sessionId, role: 'user', content: `q-${uId}`,
        agentKind: 'cc', agentMeta: JSON.stringify({ uuid: uUuid }), createdAt: ts++,
      });
      await database.drizzle.insert(messages).values({
        id: `${sessionId}-${aId}`, clientId: aId, sessionId, role: 'assistant', content: `ans-${aId}`,
        agentKind: 'cc', agentMeta: JSON.stringify({ uuid: aUuid }), createdAt: ts++,
      });
    }
    return session;
  }

  return {
    database, rewind, queue, liveSessions, workDir, seed, events,
    clearedHandoffs, recoveredImages, lastAssistantUuids, bootstrapCalls, workDirChecks,
    setHeld: v => { held = v; holdGeneration += 1; },
  };
}

test('Host rewind through real inputQueue commits tail soft-delete and broadcasts', async t => {
  const f = await fixture(t);
  await f.seed('s1', [['u1', 'uu1', 'a1', 'aa1'], ['u2', 'uu2', 'a2', 'aa2']]);

  const preview = await f.rewind.preview('s1', 'u2');
  assert.equal(preview.canRewind, true);
  assert.deepEqual(preview.filesChanged, ['a.ts']);

  const session = await f.rewind.commit('s1', 'u2', { stopIfRunning: true });
  assert.equal(session.id, 's1');
  assert.deepEqual(f.lastAssistantUuids, [['s1', 'aa1']]);
  assert.deepEqual(f.clearedHandoffs, ['s1']);
  assert.deepEqual(f.recoveredImages, ['s1']);
  assert.ok(f.events.some(e => e.type === 'message_deleted' && e.sessionId === 's1' && e.clientId === 'u2'));
  assert.ok(f.events.some(e => e.type === 'subagent_runs_changed' && e.sessionId === 's1'));

  const rows = await f.database.drizzle.select().from(messages).where(eq(messages.sessionId, 's1'));
  const byClient = new Map(rows.map(r => [r.clientId, r]));
  assert.equal(byClient.get('u1').rewindAt, null);
  assert.equal(byClient.get('a1').rewindAt, null);
  assert.notEqual(byClient.get('u2').rewindAt, null);
  assert.notEqual(byClient.get('a2').rewindAt, null);
});

test('Cold rewind uses bootstrapSession(nativeHistoryResume=true), extraDirs, checkWorkDirExists, and refuses held profile', async t => {
  const f = await fixture(t, { extraDirs: ['/readonly-a'], writableDirs: ['/rw-b'] });
  await f.seed('cold-1', [['u1', 'uu1', 'a1', 'aa1'], ['u2', 'uu2', 'a2', 'aa2']], { cold: true });

  f.setHeld('desktop owns profile');
  await assert.rejects(f.rewind.preview('cold-1', 'u2'), /desktop owns profile/);
  assert.equal(f.bootstrapCalls.length, 0);

  f.setHeld(null);
  const preview = await f.rewind.preview('cold-1', 'u2');
  assert.equal(preview.canRewind, true);
  assert.equal(f.workDirChecks.length, 1);
  assert.equal(f.bootstrapCalls.length, 1);
  assert.equal(f.bootstrapCalls[0].nativeHistoryResume, true);
  assert.deepEqual(f.bootstrapCalls[0].opts.extraDirs, ['/readonly-a']);
  assert.equal(f.bootstrapCalls[0].opts.additionalDirectories, undefined);
  assert.deepEqual(f.bootstrapCalls[0].opts.writableDirs, ['/rw-b']);
  assert.equal(f.liveSessions.has('cold-1'), false);
});

test('Rewind refuses when failed history writes exist, when profile hold arrives mid-orchestrator, or when stop abort times out', async t => {
  let persistShouldFail = false;
  let failedPersistHits = 0;
  const f = await fixture(t, {
    allowFailedDispose: true,
    queueDeps: {
      persistMessage: async (_id, msg) => {
        if (persistShouldFail && msg?.role !== 'user') {
          failedPersistHits += 1;
          throw new Error('disk busy');
        }
      },
    },
  });
  await f.seed('s2', [['u1', 'uu1', 'a1', 'aa1'], ['u2', 'uu2', 'a2', 'aa2']]);

  const failListeners = new Set();
  const failSession = {
    id: 's-fail',
    agentKind: 'claude-code',
    sdkSessionId: 'sdk-1',
    isTurnRunning: () => false,
    capabilities: { rewindFiles: { supported: true } },
    previewRewindFiles: async () => ({ canRewind: true, filesChanged: [] }),
    commitRewindFiles: async () => ({ canRewind: true, filesChanged: [], sdkSessionId: 'sdk-1' }),
    abort: async () => {},
    onEvent: fn => { failListeners.add(fn); return () => failListeners.delete(fn); },
  };
  await f.seed('s-fail', [['u1', 'uu1', 'a1', 'aa1'], ['u2', 'uu2', 'a2', 'aa2']], { cold: true });
  f.liveSessions.set('s-fail', failSession);
  f.queue.wireHostSession(failSession);
  await f.queue.beginHostTurn('s-fail');
  persistShouldFail = true;
  for (const fn of [...failListeners]) fn({ type: 'text', data: { text: 'Reply', isFinal: true } });
  for (const fn of [...failListeners]) fn({ type: 'done', data: {} });
  await new Promise(r => setTimeout(r, 40));
  assert.ok(failedPersistHits >= 1);
  await assert.rejects(f.rewind.commit('s-fail', 'u2'), { code: 'PRECONDITION_FAILED' });
  const rowsAfterFail = await f.database.drizzle.select().from(messages).where(eq(messages.sessionId, 's-fail'));
  assert.equal(rowsAfterFail.every(r => r.rewindAt === null), true);
  persistShouldFail = false;

  await assert.rejects(f.rewind.commit('s2', 'u1', { requireLatestUser: true }), { code: 'REWIND_TARGET_NOT_LATEST' });

  let holdTriggered = false;
  const live = f.liveSessions.get('s2');
  const origCommit = live.commitRewindFiles;
  live.commitRewindFiles = async (...args) => {
    if (!holdTriggered) {
      holdTriggered = true;
      f.setHeld('desktop took over mid-rewind');
    }
    return origCommit(...args);
  };
  await assert.rejects(f.rewind.commit('s2', 'u2'), /desktop took over mid-rewind/);
  const rowsAfterMidHold = await f.database.drizzle.select().from(messages).where(eq(messages.sessionId, 's2'));
  assert.equal(rowsAfterMidHold.every(r => r.rewindAt === null), true);
  live.commitRewindFiles = origCommit;
  f.setHeld(null);

  let releaseAbort;
  let abortCalls = 0;
  const hungAbort = new Promise(resolve => { releaseAbort = resolve; });
  const listeners = new Set();
  const runningSession = {
    id: 's-hang',
    agentKind: 'claude-code',
    sdkSessionId: 'sdk-1',
    running: true,
    isTurnRunning: () => runningSession.running,
    onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    abort: () => { abortCalls += 1; return hungAbort; },
  };
  await f.seed('s-hang', [['u1', 'uu1', 'a1', 'aa1']], { cold: true });
  f.liveSessions.set('s-hang', runningSession);
  f.queue.wireHostSession(runningSession);
  await f.queue.beginHostTurn('s-hang');
  let ranAction = false;
  await assert.rejects(
    f.queue.withSessionInputStoppedForRewind('s-hang', async () => { ranAction = true; }, 80),
    { code: 'SESSION_RUNNING' },
  );
  assert.equal(abortCalls, 1);
  assert.equal(ranAction, false);
  runningSession.running = false;
  for (const fn of [...listeners]) fn({ type: 'done', data: {} });
  releaseAbort();

  let releaseLock;
  const locked = new Promise(resolve => { releaseLock = resolve; });
  let enteredLock;
  const lockReady = new Promise(resolve => { enteredLock = resolve; });
  const holder = withSendToSessionLock('s2', async () => { enteredLock(); await locked; });
  await lockReady;
  const blocked = f.rewind.commit('s2', 'u2', { requireLatestUser: true });
  f.setHeld('desktop owns profile');
  releaseLock();
  await holder;
  await assert.rejects(blocked, /desktop owns profile/);
});
