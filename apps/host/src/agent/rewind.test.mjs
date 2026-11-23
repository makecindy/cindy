import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { configureAppDataDir, configureUserDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { configureSqliteVecExtPath } from '../../../desktop/src/main/localDb/sqliteVecLoader.ts';
import { commitVolatileAppSession } from '../../../desktop/src/main/appSessionState.ts';
import { openOwnerDatabase } from '../../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { clearCurrentDbClient, setCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { messages, sessions } from '../../../desktop/src/main/localDb/schema.ts';
import { withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { hostRuntimeLayout } from '../runtime-layout.mjs';
import { createHostRewind } from './rewind.ts';

async function fixture(t, overrides = {}) {
  const sharedProfile = process.env.XDT_OFFICIAL_SHARED_PROFILE;
  delete process.env.XDT_OFFICIAL_SHARED_PROFILE;
  t.after(() => { if (sharedProfile !== undefined) process.env.XDT_OFFICIAL_SHARED_PROFILE = sharedProfile; });
  const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-host-rewind-'));
  const profile = path.join(root, 'profile');
  const workDir = path.join(root, 'work');
  mkdirSync(profile, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  configureHostOwner({ userDataDir: profile, ownerId: 'owner-rewind' });
  configureUserDataDir(profile);
  configureAppDataDir(path.join(root, 'app-data'));
  commitVolatileAppSession('cloud', 'owner-rewind', true);
  const layout = hostRuntimeLayout();
  configureSqliteVecExtPath(layout.sqliteVecPath);
  const opened = await openOwnerDatabase({
    userDataDir: profile, ownerId: 'owner-rewind', isPackaged: false,
    drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecExtPath,
  });
  const database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, 'owner-rewind');
  t.after(async () => {
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
  const stopCalls = [];
  let held = null;
  let drained = 0;

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

  const rewind = createHostRewind({
    getMaker: () => maker,
    resolveHandoffWindow: async () => 200_000,
    drainSessionPersistence: async () => { drained++; },
    setLastAssistantTranscriptUuid: (id, uuid) => { lastAssistantUuids.push([id, uuid]); },
    restoreSession: async () => { throw new Error('unexpected cold restore'); },
    withSessionInputStoppedForRewind: async (id, action) => { stopCalls.push(id); return action(); },
    profileHoldReason: () => held,
    clearPendingHandoff: id => { clearedHandoffs.push(id); },
    recoverGeneratedImages: async id => { recoveredImages.push(id); },
    publish: event => { events.push(event); },
    ...overrides,
  });

  async function seed(sessionId, turns) {
    await database.drizzle.insert(sessions).values({
      id: sessionId, title: 'T', workingDir: workDir, agentKind: 'cc',
      model: 'claude-fable-5-2', status: 'active', sdkSessionId: 'sdk-1',
      createdAt: 1000, updatedAt: 1000,
    });
    const session = {
      id: sessionId,
      agentKind: 'claude-code',
      sdkSessionId: 'sdk-1',
      isTurnRunning: () => false,
      capabilities: { rewindFiles: { supported: true } },
      previewRewindFiles: async () => ({ canRewind: true, filesChanged: ['a.ts'] }),
      commitRewindFiles: async () => ({ canRewind: true, filesChanged: ['a.ts'], sdkSessionId: 'sdk-1' }),
    };
    liveSessions.set(sessionId, session);
    let ts = 2000;
    for (const [uId, uUuid, aId, aUuid] of turns) {
      await database.drizzle.insert(messages).values({
        id: `m-${uId}`, clientId: uId, sessionId, role: 'user', content: `q-${uId}`,
        agentKind: 'cc', agentMeta: JSON.stringify({ uuid: uUuid }), createdAt: ts++,
      });
      await database.drizzle.insert(messages).values({
        id: `m-${aId}`, clientId: aId, sessionId, role: 'assistant', content: `ans-${aId}`,
        agentKind: 'cc', agentMeta: JSON.stringify({ uuid: aUuid }), createdAt: ts++,
      });
    }
    return session;
  }

  return { database, rewind, seed, events, clearedHandoffs, recoveredImages, lastAssistantUuids, stopCalls, getDrained: () => drained, setHeld: v => { held = v; } };
}

test('Host rewind preview and commit soft-delete tail, update transcript parent, clear handoff and broadcast', async t => {
  const f = await fixture(t);
  await f.seed('s1', [['u1', 'uu1', 'a1', 'aa1'], ['u2', 'uu2', 'a2', 'aa2']]);

  const preview = await f.rewind.preview('s1', 'u2');
  assert.equal(preview.canRewind, true);
  assert.deepEqual(preview.filesChanged, ['a.ts']);

  const session = await f.rewind.commit('s1', 'u2');
  assert.equal(session.id, 's1');
  assert.equal(f.getDrained(), 1);
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

test('Host rewind edit-resend enforces requireLatestUser, stopIfRunning and post-lock profile hold', async t => {
  const f = await fixture(t);
  await f.seed('s2', [['u1', 'uu1', 'a1', 'aa1'], ['u2', 'uu2', 'a2', 'aa2']]);

  await assert.rejects(f.rewind.commit('s2', 'u1', { requireLatestUser: true }), { code: 'REWIND_TARGET_NOT_LATEST' });

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

  f.setHeld(null);
  const edited = await f.rewind.commit('s2', 'u2', { requireLatestUser: true, stopIfRunning: true });
  assert.equal(edited.id, 's2');
  assert.deepEqual(f.stopCalls, ['s2']);
  assert.equal(f.events.some(e => e.type === 'message_deleted'), false);
});
