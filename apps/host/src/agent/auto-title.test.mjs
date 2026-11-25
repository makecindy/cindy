import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { configureAppDataDir, configureUserDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { commitVolatileAppSession } from '../../../desktop/src/main/appSessionState.ts';
import { runDeviceLinkInvokeContext } from '../../../desktop/src/main/device-link/invoke-context.ts';
import { openOwnerDatabase } from '../../../desktop/src/main/localDb/startupCore.ts';
import { configureSqliteVecExtPath } from '../../../desktop/src/main/localDb/sqliteVecLoader.ts';
import { createDbClientForHandle } from '../../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { clearCurrentDbClient, setCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { messages, sessions } from '../../../desktop/src/main/localDb/schema.ts';
import { DEFAULT_DRAFT_SESSION_TITLE } from '../../../../packages/maker-shared/src/sessionTitle.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { hostRuntimeLayout } from '../runtime-layout.mjs';
import { createInputQueue } from './input-queue.mjs';
import { createHostAutoTitle } from './auto-title.ts';
import { createHostSessionUpdate } from './session-update.ts';

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, 15));
  }
  throw new Error('Timed out waiting for condition');
}

async function fixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-host-auto-title-'));
  const profile = path.join(root, 'profile');
  const workDir = path.join(root, 'work');
  mkdirSync(profile, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  configureHostOwner({ userDataDir: profile, ownerId: 'owner-title' });
  configureUserDataDir(profile);
  configureAppDataDir(path.join(root, 'app-data'));
  commitVolatileAppSession('cloud', 'owner-title', true);
  const layout = hostRuntimeLayout();
  configureSqliteVecExtPath(layout.sqliteVecPath);
  const opened = await openOwnerDatabase({
    userDataDir: profile, ownerId: 'owner-title', isPackaged: false,
    drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath,
  });
  const database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, 'owner-title');
  t.after(async () => {
    commitVolatileAppSession('signed-out', null, true);
    clearCurrentDbClient();
    await database.dispose();
    configureHostOwner({ userDataDir: profile, ownerId: null });
    rmSync(root, { recursive: true, force: true });
  });

  const events = [];
  const oneShotPrompts = [];
  let held = null;
  let holdGeneration = 0;
  let nextAiTitle = overrides.nextAiTitle ?? (async () => ({ ok: true, text: 'AI Smart Title' }));
  const liveSessions = new Map();

  const autoReview = {
    settings: { readAuxiliaryModelSettings: () => ({ models: [] }) },
    chain: {
      getEffectiveAuxiliaryModelChain: () => ({ source: 'auto', candidates: [] }),
      getEffectiveAuxiliaryModelChainSnapshot: () => 'auto:[]',
    },
    isOneShotRouteDisabled: async () => false,
    oneShot: {
      agentSupportsOneShot: () => false,
      requestUtilityText: async (_maker, prompt, opts) => {
        oneShotPrompts.push({ prompt, opts });
        if (opts?.beforeDispatch && !(await opts.beforeDispatch())) {
          return { ok: false, reason: 'before-dispatch-cancelled' };
        }
        return nextAiTitle(prompt, opts);
      },
    },
  };
  const maker = {
    getSession: id => liveSessions.get(id),
    createSession: async opts => {
      const listeners = new Set();
      const session = {
        id: opts.id,
        agentKind: opts.agentKind ?? 'claude-code',
        running: false,
        isTurnRunning: () => session.running,
        onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); },
        abort: async () => {},
        send: async (_text, sendOpts = {}) => {
          sendOpts.onAccepted?.(sendOpts.signal);
          sendOpts.onDispatching?.();
          session.running = true;
          queueMicrotask(() => {
            session.running = false;
            for (const fn of [...listeners]) fn({ type: 'done', data: {} });
          });
          return { accepted: true };
        },
        steer: async () => ({ accepted: true }),
      };
      liveSessions.set(opts.id, session);
      return session;
    },
    oneShot: async () => '',
  };

  let queue;
  const autoTitle = createHostAutoTitle({
    getAutoReview: () => autoReview,
    getMaker: () => maker,
    profileHoldReason: () => held,
    profileHoldGeneration: () => holdGeneration,
    hasEnabledUserMessageHookGhost: () => overrides.screeningActive?.() ?? false,
    drainHistories: () => queue.drainHistories(),
    isSessionTurnPendingCompletion: id => queue.isTurnRunning(id),
    publish: event => events.push(event),
    resolveLocale: () => 'zh-CN',
  });

  queue = createInputQueue({
    getMaker: () => maker,
    statDirectory: async () => ({ isDirectory: () => true }),
    readSession: async id => {
      const [row] = await database.drizzle.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      return row ?? { id, status: 'active', agentKind: 'claude-code', model: 'claude-fable-5-2', workingDir: workDir };
    },
    persistMessage: async () => {},
    sent: () => {},
    admitLocalRoute: async () => {},
    hub: { publish: event => events.push(event) },
    prepareDeviceLinkAutoTitle: (id, queued) => autoTitle.prepareDeviceLinkAutoTitle(id, queued),
  });
  t.after(async () => { await queue.dispose(); });

  async function seedSession(id, { title = DEFAULT_DRAFT_SESSION_TITLE, agentKind = 'cc', updatedAt = 1000 } = {}) {
    await database.drizzle.insert(sessions).values({
      id, title, workingDir: workDir, agentKind,
      model: 'claude-fable-5-2', status: 'active', createdAt: 1000, updatedAt,
    });
  }

  async function readSession(id) {
    const [row] = await database.drizzle.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row;
  }

  return {
    database, queue, autoTitle, events, oneShotPrompts, liveSessions, workDir,
    seedSession, readSession,
    setHeld: v => { held = v ?? null; holdGeneration += 1; },
    setNextAiTitle: fn => { nextAiTitle = fn; },
  };
}

test('Device Link enqueue writes immediate placeholder then AI smart title without bumping updatedAt', async t => {
  let releaseAi;
  const aiGate = new Promise(resolve => { releaseAi = resolve; });
  const f = await fixture(t, {
    nextAiTitle: async () => {
      await aiGate;
      return { ok: true, text: '重构自动命名链路' };
    },
  });
  await f.seedSession('s1', { updatedAt: 1234 });

  await runDeviceLinkInvokeContext({ controllerDeviceId: 'phone-1', controllerPlatform: 'ios', channel: 'maker:input:enqueue' }, () =>
    f.queue.enqueue('s1', { clientId: 'c1', text: '把远程任务的自动重命名修复一下' }),
  );

  await waitFor(async () => (await f.readSession('s1')).title === '把远程任务的自动重命名修复一下');
  assert.equal((await f.readSession('s1')).updatedAt, 1234);

  releaseAi();
  await waitFor(async () => (await f.readSession('s1')).title === '重构自动命名链路');
  assert.equal((await f.readSession('s1')).updatedAt, 1234);
  const titlePatches = f.events.filter(e => e.type === 'session_changed' && e.sessionId === 's1' && e.patch?.title);
  assert.deepEqual(titlePatches.map(e => e.patch.title), ['把远程任务的自动重命名修复一下', '重构自动命名链路']);
});

test('Attachment-only placeholder skips title model and manual rename blocks in-flight smart title', async t => {
  let releaseAi;
  const aiGate = new Promise(resolve => { releaseAi = resolve; });
  const f = await fixture(t, {
    nextAiTitle: async () => {
      await aiGate;
      return { ok: true, text: 'AI Late Title' };
    },
  });
  await f.seedSession('s-attach');

  const r1 = await f.autoTitle.runAutoTitle({ sessionId: 's-attach', text: 'image.png', isUserText: false });
  assert.deepEqual(r1, { applied: true, done: false });
  assert.equal((await f.readSession('s-attach')).title, 'image.png');
  assert.equal(f.oneShotPrompts.length, 0);

  const p2 = f.autoTitle.runAutoTitle({ sessionId: 's-attach', text: '用户真正的提问', isUserText: true });
  await waitFor(async () => (await f.readSession('s-attach')).title === '用户真正的提问');
  f.autoTitle.markManuallyRenamed('s-attach');
  releaseAi();
  const r2 = await p2;
  assert.equal(r2.applied, true);
  assert.equal((await f.readSession('s-attach')).title, '用户真正的提问');
});

test('regenerateTitle reads SQLite messages, rejects empty sessions, and refuses while profile is held', async t => {
  const f = await fixture(t, { nextAiTitle: async () => ({ ok: true, text: '排查部署超时' }) });
  await f.seedSession('s-empty');
  await assert.rejects(f.autoTitle.regenerateTitle({ sessionId: 's-empty' }), { code: 'TITLE_NO_MATERIAL' });

  await f.seedSession('s-chat');
  await f.database.drizzle.insert(messages).values([
    { id: 'm1', clientId: 'u1', sessionId: 's-chat', role: 'user', content: '部署一直卡超时怎么办', agentKind: 'cc', createdAt: 2000 },
    { id: 'm2', clientId: 'a1', sessionId: 's-chat', role: 'assistant', content: '我们先看日志确认超时点', agentKind: 'cc', createdAt: 2001 },
  ]);

  const regenerated = await f.autoTitle.regenerateTitle({ sessionId: 's-chat' });
  assert.deepEqual(regenerated, { title: '排查部署超时' });

  f.setHeld('desktop owns profile');
  await assert.rejects(f.autoTitle.regenerateTitle({ sessionId: 's-chat' }), /desktop owns profile/);
  await assert.rejects(f.autoTitle.generateTitle({ message: 'hi', agentKind: 'claude-code' }), /desktop owns profile/);
  const heldRun = await f.autoTitle.runAutoTitle({ sessionId: 's-empty', text: 'should skip' });
  assert.deepEqual(heldRun, { applied: false, done: false });
  assert.equal((await f.readSession('s-empty')).title, DEFAULT_DRAFT_SESSION_TITLE);
});

test('Browser runAutoTitle skips placeholder write when user-message screening hook is active', async t => {
  const f = await fixture(t, { screeningActive: () => true });
  await f.seedSession('s-screened');
  const res = await f.autoTitle.runAutoTitle({ sessionId: 's-screened', text: 'secret text' });
  assert.deepEqual(res, { applied: false, done: false });
  assert.equal((await f.readSession('s-screened')).title, DEFAULT_DRAFT_SESSION_TITLE);
  assert.equal(f.oneShotPrompts.length, 0);
  assert.equal(f.events.filter(e => e.type === 'session_changed' && e.sessionId === 's-screened').length, 0);
});

test('In-flight smart title from before a profile hold/release cycle is discarded', async t => {
  let releaseAi;
  const aiGate = new Promise(resolve => { releaseAi = resolve; });
  const f = await fixture(t, {
    nextAiTitle: async () => {
      await aiGate;
      return { ok: true, text: 'Stale Pre-Hold Title' };
    },
  });
  await f.seedSession('s-hold-cycle');

  const run = f.autoTitle.runAutoTitle({ sessionId: 's-hold-cycle', text: 'Keep This Name' });
  await waitFor(() => f.oneShotPrompts.length === 1);
  f.setHeld('desktop took profile');
  f.setHeld(null);
  releaseAi();
  await run;
  assert.equal((await f.readSession('s-hold-cycle')).title, 'Keep This Name');
});

test('Mixed session update records manual rename before async follow-up writes so same-value rename wins', async t => {
  let releaseAi;
  const aiGate = new Promise(resolve => { releaseAi = resolve; });
  const f = await fixture(t, {
    nextAiTitle: async () => {
      await aiGate;
      return { ok: true, text: 'AI Overwrites Saved Title' };
    },
  });
  const title = 'Keep My Exact Placeholder';
  await f.seedSession('s-mixed-rename');
  const run = f.autoTitle.runAutoTitle({ sessionId: 's-mixed-rename', text: title });
  await waitFor(() => f.oneShotPrompts.length === 1);

  const update = createHostSessionUpdate({
    publish: () => { releaseAi(); },
    persistSessionFields: async () => { await run; },
    restoreTaskToActive: async () => {},
    setModel: async () => ({}),
    onManualTitleWrite: id => f.autoTitle.markManuallyRenamed(id),
    move: {
      lookupSessionWorktreeBinding: async () => null,
      closeIdleSessionForMove: async () => true,
      broadcastRecentWorkdirsChanged: () => {},
    },
  });
  const updated = await update('s-mixed-rename', { title, contextWindowBudget: 32768 });
  await run;
  assert.equal(updated.title, title);
  assert.equal((await f.readSession('s-mixed-rename')).title, title);
});
