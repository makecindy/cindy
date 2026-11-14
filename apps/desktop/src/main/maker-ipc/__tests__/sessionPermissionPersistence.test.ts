import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tx as runWorkerTx } from '../../localDb/worker/opHandlers/tx.js';

const h = vi.hoisted(() => ({
  sqlite: null as Database.Database | null,
  owner: null as object | null,
  live: new Map<string, { stablePermissionModeState: {mode: string}; setPermissionMode: ReturnType<typeof vi.fn> }>(),
  patched: vi.fn(),
  close: vi.fn(),
  forget: vi.fn(),
}));

vi.mock('../../maker-host/index.js', () => ({ getMakerIfReady: () => ({ getSession: (id: string) => h.live.get(id), closeSession: h.close }) }));
vi.mock('../../localDb/ipc/sessions.js', () => ({ broadcastSessionPatched: h.patched }));
vi.mock('../../remote-agent/executor/credentialGrants.js', () => ({ forgetCredentialGrants: h.forget }));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => h.owner,
  getDbClient: () => ({
    tx: (name: string, args: unknown) => runWorkerTx(h.sqlite!, { name, args } as never),
  }),
}));

import { syncBotLanePermission, syncBotLinkedLanePermissions } from '../botPermissionSync.js';
import { persistPermissionModeWithoutRuntime, profilePermissionForSessionMode } from '../sessionPermissionPersistence.js';
import { prepareBotPermissionDispatch, retryBotWelcomePermissionDispatch, withBotPermissionChangeForBot } from '../botPermissionDispatch.js';
import { withSendToSessionLock } from '../sendToSessionLock.js';
import { Session, type AgentSessionHandle } from '@cindy/maker-core';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function welcomeRuntime() {
  const closed = deferred();
  const send = vi.fn(async (..._args: unknown[]) => {});
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
  const session = new Session({
    id: 'chat', agentKind: 'claude-code', workDir: process.cwd(), permissionMode: 'ask',
    capabilities: { permissionModes: [{ id: 'ask' }, { id: 'auto' }, { id: 'bypassPermissions' }], setPermissionModeMidSession: { supported: true } } as never,
    logger, turnStallMs: 0,
    handle: {
      id: 'welcome', agentKind: 'claude-code', send,
      async *events() { await closed.promise; },
      async abort() {}, async close() { closed.resolve(); },
      async setPermissionMode() {}, isTurnRunning: () => false,
      setInteractionResolver() {},
      getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    } as unknown as AgentSessionHandle,
  });
  return { session, send };
}

function createDatabase(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      permission_mode TEXT NOT NULL,
      updated_at INTEGER NOT NULL, source TEXT DEFAULT 'bot', status TEXT DEFAULT 'active'
    );
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY,
      current_version INTEGER NOT NULL, status TEXT DEFAULT 'active'
    );
    CREATE TABLE bot_session_links (
      bot_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE bot_profile_versions (
      bot_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      capabilities_json TEXT NOT NULL
    );
    INSERT INTO sessions (id, permission_mode, updated_at) VALUES ('chat', 'ask', 1);
    INSERT INTO bot_profiles (id, current_version) VALUES ('bot-1', 2);
    INSERT INTO bot_session_links VALUES ('bot-1', 'chat', 'canonical', NULL);
    INSERT INTO bot_profile_versions VALUES ('bot-1', 2, '{"permissions":"ask","memory":true}');
  `);
  return sqlite;
}

describe('permission persistence without a live runtime', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = createDatabase();
    h.sqlite = sqlite;
    h.live.clear(); h.patched.mockClear(); h.forget.mockClear();
    h.close.mockReset().mockImplementation(async (id: string) => { h.live.delete(id); });
    h.owner = { client: {
      tx: async (name: string, args: unknown) => runWorkerTx(sqlite, {name, args} as never),
      query: async (sql: string, params: unknown[]) => sqlite.prepare(sql).all(...params),
    } };

  });

  afterEach(() => { sqlite.close(); h.owner = null; });

  it('maps only the teammate permission values', () => {
    expect(profilePermissionForSessionMode('bypassPermissions')).toBe('trusted');
    expect(profilePermissionForSessionMode('acceptEdits')).toBeNull();
  });

  it('writes the session and the canonical profile together', async () => {
    await expect(persistPermissionModeWithoutRuntime('chat', 'auto')).resolves.toBe(true);
    expect(sqlite.prepare('SELECT permission_mode FROM sessions WHERE id = ?').pluck().get('chat')).toBe('auto');
    expect(JSON.parse(sqlite.prepare('SELECT capabilities_json FROM bot_profile_versions').pluck().get() as string))
      .toMatchObject({ permissions: 'auto', memory: true });
  });

  it('does not report success when the session row is missing', async () => {
    await expect(persistPermissionModeWithoutRuntime('missing', 'ask')).resolves.toBe(false);
    expect(sqlite.prepare('SELECT permission_mode FROM sessions').pluck().get()).toBe('ask');
  });

  // P1 review: a topic's explicit Ask choice previously changed only that row,
  // then pre-send reconciliation restored the canonical's wider authority.
  it.each(['thread', 'channel', 'group'])('persists explicit %s permission for the whole Bot', async role => {
    await persistPermissionModeWithoutRuntime('chat', 'bypassPermissions');
    sqlite.prepare("INSERT INTO sessions (id,permission_mode,updated_at) VALUES ('lane','bypassPermissions',1)").run();
    sqlite.prepare("INSERT INTO bot_session_links VALUES ('bot-1','lane',?,NULL)").run(role);
    await persistPermissionModeWithoutRuntime('lane', 'ask');
    await syncBotLanePermission('lane');
    expect(sqlite.prepare('SELECT DISTINCT permission_mode FROM sessions').pluck().all()).toEqual(['ask']);
    expect(JSON.parse(sqlite.prepare('SELECT capabilities_json FROM bot_profile_versions').pluck().get() as string).permissions).toBe('ask');
  });

  // P1 review, unit: pause at the real async-preparation/synchronous-dispatch
  // boundary. A persisted tightening must invalidate a previously prepared turn,
  // including the interval before the lane's hot switch starts.
  it.each(['pending', 'completed'])('rejects stale dispatch after a %s Bot permission change', async phase => {
    await persistPermissionModeWithoutRuntime('chat', 'bypassPermissions');
    const state = { id: 'chat', stablePermissionModeState: { mode: 'bypassPermissions' } };
    const runtime = state as unknown as Session;
    const dispatch = await prepareBotPermissionDispatch(runtime);
    expect(() => dispatch()).not.toThrow();
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const change = withBotPermissionChangeForBot('bot-1', async () => {
      runWorkerTx(sqlite, { name: 'bots.persistSessionPermission', args: { sessionId: 'chat', mode: 'ask' } });
      entered();
      await pending;
    });
    await started;
    if (phase === 'completed') { release(); await change; }
    try { expect(() => dispatch()).toThrow('Bot permissions changed before dispatch'); }
    finally { release(); await change; }
    state.stablePermissionModeState = { mode: 'ask' };
    expect(() => dispatch()).toThrow('Bot permissions changed before dispatch');
    const fresh = await prepareBotPermissionDispatch(runtime);
    expect(() => fresh()).not.toThrow();
  });

  it('orders permission edits from main and topic without a cross-lane deadlock', async () => {
    sqlite.exec(`INSERT INTO sessions (id,permission_mode,updated_at) VALUES ('topic','ask',1);
      INSERT INTO bot_session_links VALUES ('bot-1','topic','thread',NULL);`);
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const live = { stablePermissionModeState: { mode: 'ask' }, setPermissionMode: vi.fn(async (mode: string) => {
      if (mode === 'bypassPermissions') { entered(); await pending; }
      live.stablePermissionModeState = { mode };
    }) };
    h.live.set('topic', live);
    const main = persistPermissionModeWithoutRuntime('chat', 'bypassPermissions');
    await started;
    const topic = persistPermissionModeWithoutRuntime('topic', 'ask');
    release();
    await Promise.all([main, topic]);
    // This is the cold persistence entry; its initiating topic has no runtime.
    // The next normal reuse consumes the newly saved shared Ask choice.
    await syncBotLanePermission('topic');
    expect(sqlite.prepare('SELECT DISTINCT permission_mode FROM sessions').pluck().all()).toEqual(['ask']);
    expect(live.stablePermissionModeState.mode).toBe('ask');
  });

  it('checks shared authority rather than a stale lane row and allows ordinary sibling repairs', async () => {
    sqlite.exec(`INSERT INTO sessions (id,permission_mode,updated_at) VALUES ('lane','bypassPermissions',1);
      INSERT INTO bot_session_links VALUES ('bot-1','lane','channel',NULL);`);
    const lane = { id: 'lane', stablePermissionModeState: { mode: 'bypassPermissions' } } as unknown as Session;
    const stale = await prepareBotPermissionDispatch(lane);
    expect(() => stale()).toThrow('Bot permissions changed before dispatch');
    const main = { id: 'chat', stablePermissionModeState: { mode: 'ask' } } as unknown as Session;
    const valid = await prepareBotPermissionDispatch(main);
    await syncBotLanePermission('lane');
    await withBotPermissionChangeForBot('another-bot', async () => {});
    expect(() => valid()).not.toThrow();
  });

  // A permission writer may need the same send/restart fence already owned by
  // preparation. The guard must reject, not wait for that writer to finish.
  it('rejects dispatch preparation while a permission writer is waiting on its send fence', async () => {
    let release!: () => void;
    const waitingOnSend = new Promise<void>(resolve => { release = resolve; });
    const change = withBotPermissionChangeForBot('bot-1', () => waitingOnSend);
    const session = { id: 'chat', stablePermissionModeState: { mode: 'ask' } } as unknown as Session;
    try {
      await expect(prepareBotPermissionDispatch(session)).rejects.toThrow('Bot permissions are changing before dispatch');
    } finally { release(); await change; }
  });

  // #10021, unit: the existing guard tests proved rejection only. Exercise real
  // Session.send with a paused permission writer and the same welcome input:
  // the provider must see zero stale sends, then exactly one tools-disabled send.
  it.each(['before-preparation', 'after-preparation', 'completed-change', 'runtime-mode-changed'] as const)(
    'recovers a welcome after %s without waiting inside the send fence', async phase => {
      const { session, send } = welcomeRuntime();
      const prepared = deferred();
      const rejected = deferred();
      const proceed = deferred();
      const writerEntered = deferred();
      const releaseWriter = deferred();
      let change: Promise<void> | undefined;
      let guard: (() => void) | undefined;
      let attempts = 0;
      let persisted = 0;
      const rows = new Set<string>();
      const writePermission = async () => {
        writerEntered.resolve();
        await releaseWriter.promise;
        const persist = async () => {
          runWorkerTx(sqlite, { name: 'bots.persistSessionPermission', args: { sessionId: 'chat', mode: 'auto' } });
        };
        if (phase === 'completed-change' || phase === 'runtime-mode-changed') await persist();
        else await withSendToSessionLock('chat', persist);
        if (phase === 'runtime-mode-changed') await session.setPermissionMode('auto');
      };
      // Automatic reconciliation changes the stable mode without an explicit
      // edit revision; this is the creation-time race reported in #10021.
      const beginChange = () => phase === 'runtime-mode-changed'
        ? writePermission() : withBotPermissionChangeForBot('bot-1', writePermission);
      session.setTurnLifecycleObserver({
        beforeProviderStart: async () => {
          guard = await prepareBotPermissionDispatch(session);
          if (attempts === 1 && phase !== 'before-preparation') {
            prepared.resolve();
            await proceed.promise;
          }
        },
        onDispatching: () => guard?.(),
        onUndispatched() { rejected.resolve(); },
        onTerminal() {},
      });
      if (phase === 'before-preparation') { change = beginChange(); await writerEntered.promise; }
      const result = retryBotWelcomePermissionDispatch('chat', new AbortController().signal, async () => {
        attempts++;
        // The production send entry reconciles the saved authority on every attempt.
        const mode = sqlite.prepare("SELECT permission_mode FROM sessions WHERE id = 'chat'").pluck().get();
        await session.setPermissionMode(mode as 'ask' | 'auto');
        return withSendToSessionLock('chat', () => session.send('Say hello.', {
          toolsDisabled: true,
          messageUuid: 'welcome-uuid',
          onAccepted: async () => { rows.add('welcome-client'); persisted++; },
        })).catch(error => { rejected.resolve(); throw error; });
      }, () => true);
      // Attach immediately so the red baseline cannot produce an unhandled rejection.
      const outcome = result.then(value => ({ value }), error => ({ error }));
      try {
        if (phase !== 'before-preparation') {
          await prepared.promise;
          change = beginChange();
          await writerEntered.promise;
          if (phase === 'completed-change' || phase === 'runtime-mode-changed') {
            // A completed edit can also invalidate the already prepared revision.
            // It needs no restart in this variant, so finish outside the held fence.
            releaseWriter.resolve();
            await change;
          }
          proceed.resolve();
        }
        await rejected.promise;
        expect(send).not.toHaveBeenCalled();
        releaseWriter.resolve();
        await change;
        expect(await outcome).toMatchObject({ value: { accepted: true } });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0]?.[1]).toMatchObject({ toolsDisabled: true, messageUuid: 'welcome-uuid' });
        expect(rows.size).toBe(1);
        expect(persisted).toBe(phase === 'before-preparation' ? 1 : 2);
        expect(attempts).toBe(2);
        expect(session.stablePermissionModeState?.mode).toBe('auto');
      } finally {
        proceed.resolve(); releaseWriter.resolve(); await change; await session.close();
      }
    },
  );

  // A retry is still a new dispatch decision, never permission to use the old
  // wider snapshot. These are distinct cancellation/authority boundaries.
  it.each(['stop', 'account', 'archive', 'missing-profile', 'welcome-ended', 'failed-write'] as const)(
    'does not recover a pending welcome after %s', async boundary => {
      const gate = deferred();
      const recovering = deferred();
      const change = withBotPermissionChangeForBot('bot-1', async () => {
        await gate.promise;
        if (boundary === 'failed-write') throw new Error('permission persistence failed');
      }).catch(error => {
        if (boundary !== 'failed-write') throw error;
        expect(error.message).toBe('permission persistence failed');
      });
      const abort = new AbortController();
      const session = { id: 'chat', stablePermissionModeState: { mode: 'ask' } } as unknown as Session;
      let eligible = true;
      const send = vi.fn(async () => { (await prepareBotPermissionDispatch(session))(); });
      const result = retryBotWelcomePermissionDispatch('chat', abort.signal, send,
        () => { recovering.resolve(); return eligible; });
      const rejected = expect(result).rejects.toThrow('Bot permissions are changing before dispatch');
      await recovering.promise;
      if (boundary === 'stop') abort.abort();
      if (boundary === 'account') h.owner = { client: {} };
      if (boundary === 'archive') sqlite.exec("UPDATE bot_session_links SET archived_at = 1");
      if (boundary === 'missing-profile') sqlite.exec('DELETE FROM bot_profile_versions');
      if (boundary === 'welcome-ended') eligible = false;
      gate.resolve();
      await change;
      await rejected;
      expect(send).toHaveBeenCalledOnce();
    },
  );

  it('reconciles a tightened permission before recovering the welcome', async () => {
    const { session, send } = welcomeRuntime();
    await persistPermissionModeWithoutRuntime('chat', 'bypassPermissions');
    await session.setPermissionMode('bypassPermissions');
    let attempts = 0;
    let guard!: () => void;
    session.setTurnLifecycleObserver({
      beforeProviderStart: async () => {
        guard = await prepareBotPermissionDispatch(session);
        if (attempts === 1) await persistPermissionModeWithoutRuntime('chat', 'ask');
      },
      onDispatching: () => guard(), onUndispatched() {}, onTerminal() {},
    });
    try {
      await expect(retryBotWelcomePermissionDispatch('chat', new AbortController().signal, async () => {
        if (attempts++) await session.setPermissionMode('ask');
        return session.send('Say hello.', { toolsDisabled: true });
      }, () => true)).resolves.toMatchObject({ accepted: true });
      expect(send).toHaveBeenCalledOnce();
      expect(session.stablePermissionModeState?.mode).toBe('ask');
    } finally { await session.close(); }
  });

  it('does not wait under an outer send fence or retry a second permission race', async () => {
    const gate = deferred();
    const change = withBotPermissionChangeForBot('bot-1', () => gate.promise);
    const runtime = { id: 'chat', stablePermissionModeState: { mode: 'ask' } } as unknown as Session;
    const send = vi.fn(async () => { (await prepareBotPermissionDispatch(runtime))(); });
    try {
      await expect(withSendToSessionLock('chat', () => retryBotWelcomePermissionDispatch(
        'chat', new AbortController().signal, send, () => true,
      ))).rejects.toThrow('Bot permissions are changing before dispatch');
      expect(send).toHaveBeenCalledOnce();
    } finally { gate.resolve(); await change; }
    let attempts = 0;
    await expect(retryBotWelcomePermissionDispatch('chat', new AbortController().signal, async () => {
      attempts++;
      const guard = await prepareBotPermissionDispatch(runtime);
      await withBotPermissionChangeForBot('bot-1', async () => {});
      guard();
    }, () => true)).rejects.toThrow('Bot permissions changed before dispatch');
    expect(attempts).toBe(2);
  });

  it('bounds a stuck permission writer and removes its wait timer', async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const waiting = deferred();
    const change = withBotPermissionChangeForBot('bot-1', () => gate.promise);
    const runtime = { id: 'chat', stablePermissionModeState: { mode: 'ask' } } as unknown as Session;
    const send = vi.fn(() => prepareBotPermissionDispatch(runtime));
    try {
      const result = retryBotWelcomePermissionDispatch('chat', new AbortController().signal, send,
        () => { waiting.resolve(); return true; });
      const rejected = expect(result).rejects.toThrow('Bot permissions are changing before dispatch');
      await waiting.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(send).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { gate.resolve(); await change; vi.useRealTimers(); }
  });

  it.each(['accepted', 'unknown-failure', 'precondition-text'] as const)(
    'never repeats a provider request after %s', async outcome => {
      const { session, send } = welcomeRuntime();
      if (outcome !== 'accepted') send.mockRejectedValueOnce(new Error(outcome === 'precondition-text'
        ? '[PRECONDITION_FAILED] Bot permissions changed before dispatch' : 'transport disconnected'));
      try {
        const result = retryBotWelcomePermissionDispatch('chat', new AbortController().signal,
          () => session.send('Say hello.', { toolsDisabled: true }), () => true);
        if (outcome === 'accepted') await expect(result).resolves.toMatchObject({ accepted: true });
        else await expect(result).rejects.toThrow(outcome === 'precondition-text' ? 'PRECONDITION_FAILED' : 'transport disconnected');
        expect(send).toHaveBeenCalledOnce();
      } finally { await session.close(); }
    },
  );

  it('does not replace a newer profile version with a stale capabilities snapshot', async () => {
    sqlite.prepare('UPDATE bot_profiles SET current_version = 3 WHERE id = ?').run('bot-1');
    sqlite.prepare('INSERT INTO bot_profile_versions VALUES (?, ?, ?)').run('bot-1', 3, '{"permissions":"ask","memory":false}');
    await expect(persistPermissionModeWithoutRuntime('chat', 'auto')).resolves.toBe(true);
    expect(JSON.parse(sqlite.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE version = 3').pluck().get() as string))
      .toEqual({ permissions: 'auto', memory: false });
    expect(JSON.parse(sqlite.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE version = 2').pluck().get() as string))
      .toEqual({ permissions: 'ask', memory: true });
  });
  // #6782, unit: real persistence transactions + runtime adapter. Earlier coverage
  // checked only the main row, so live channels could retain a wider permission.
  // Minimal failure: stored Profile ask, already running channel bypass.
  it('repairs and hot-switches every linked lane while preserving other Bots', async () => {
    sqlite.exec(`INSERT INTO sessions (id, permission_mode, updated_at) VALUES ('lane','bypassPermissions',1), ('other','bypassPermissions',1);
      INSERT INTO bot_session_links VALUES ('bot-1','lane','channel',NULL), ('bot-2','other','channel',NULL);`);
    const live = { stablePermissionModeState: { mode: 'bypassPermissions' }, setPermissionMode: vi.fn(async (mode: string) => { live.stablePermissionModeState = {mode}; }) };
    h.live.set('lane', live);
    await syncBotLinkedLanePermissions('chat');
    expect(live.stablePermissionModeState.mode).toBe('ask');
    expect(sqlite.prepare("SELECT permission_mode FROM sessions WHERE id = 'lane'").pluck().get()).toBe('ask');
    expect(sqlite.prepare("SELECT permission_mode FROM sessions WHERE id = 'other'").pluck().get()).toBe('bypassPermissions');
    expect(h.patched).toHaveBeenCalledWith('lane', {permissionMode:'ask'});
    await persistPermissionModeWithoutRuntime('chat', 'bypassPermissions');
    await syncBotLinkedLanePermissions('chat');
    expect(live.stablePermissionModeState.mode).toBe('bypassPermissions');
    h.live.delete('lane');
    await persistPermissionModeWithoutRuntime('chat', 'auto');
    await syncBotLanePermission('lane');
    expect(sqlite.prepare("SELECT permission_mode FROM sessions WHERE id = 'lane'").pluck().get()).toBe('auto');
  });

  it('closes a stale runtime when tightening fails and still synchronizes other lanes', async () => {
    sqlite.exec(`INSERT INTO sessions (id, permission_mode, updated_at) VALUES ('bad','bypassPermissions',1), ('good','bypassPermissions',1);
      INSERT INTO bot_session_links VALUES ('bot-1','bad','channel',NULL), ('bot-1','good','channel',NULL);`);
    const good = { stablePermissionModeState: { mode: 'bypassPermissions' }, setPermissionMode: vi.fn(async (mode: string) => { good.stablePermissionModeState = {mode}; }) };
    h.live.set('bad', { stablePermissionModeState: { mode: 'bypassPermissions' }, setPermissionMode: vi.fn(async () => { throw new Error('switch failed'); }) });
    h.live.set('good', good);
    await expect(syncBotLinkedLanePermissions('chat')).rejects.toThrow('switch failed');
    expect(h.live.has('bad')).toBe(false);
    expect(good.stablePermissionModeState.mode).toBe('ask');
  });

  // #6782, unit: a legacy main/Profile disagreement survived the original fix.
  // Minimal input: main bypass + Profile ask + existing ask lane. Calling the real
  // send/reuse reconciliation must repair both stored siblings and live runtimes.
  it.each([
    ['bypassPermissions', 'ask', 'trusted'],
    ['ask', 'bypassPermissions', 'ask'],
  ])('uses main %s to repair stale %s lanes and Profile together', async (mainMode, staleMode, permission) => {
    sqlite.prepare("UPDATE sessions SET permission_mode = ? WHERE id = 'chat'").run(mainMode);
    sqlite.prepare('UPDATE bot_profile_versions SET capabilities_json = ?')
      .run(JSON.stringify({ permissions: staleMode === 'ask' ? 'ask' : 'trusted', memory: true }));
    sqlite.exec(`INSERT INTO sessions (id, permission_mode, updated_at) VALUES ('lane','ask',1), ('sibling','ask',1);
      INSERT INTO bot_session_links VALUES ('bot-1','lane','channel',NULL), ('bot-1','sibling','group',NULL);`);
    sqlite.prepare("UPDATE sessions SET permission_mode = ? WHERE id != 'chat'").run(staleMode);
    for (const id of ['lane', 'sibling']) {
      const live = { stablePermissionModeState: { mode: staleMode }, setPermissionMode: vi.fn(async (mode: string) => { live.stablePermissionModeState = { mode }; }) };
      h.live.set(id, live);
    }
    await syncBotLanePermission('lane');
    expect(sqlite.prepare('SELECT DISTINCT permission_mode FROM sessions').pluck().all()).toEqual([mainMode]);
    expect(JSON.parse(sqlite.prepare('SELECT capabilities_json FROM bot_profile_versions').pluck().get() as string))
      .toEqual({ permissions: permission, memory: true });
    for (const id of ['lane', 'sibling']) {
      expect(h.live.get(id)?.stablePermissionModeState.mode).toBe(mainMode);
      expect(h.patched).toHaveBeenCalledWith(id, { permissionMode: mainMode });
      expect(h.live.get(id)?.setPermissionMode).toHaveBeenCalledTimes(1);
    }
    // Reload/next send keeps the repaired authority without another hot switch.
    await syncBotLanePermission('lane');
    expect(h.live.get('lane')?.setPermissionMode).toHaveBeenCalledTimes(1);
  });

  it('serializes successive lane updates and discards an outgoing account continuation', async () => {
    sqlite.exec(`INSERT INTO sessions (id, permission_mode, updated_at) VALUES ('lane','bypassPermissions',1);
      INSERT INTO bot_session_links VALUES ('bot-1','lane','channel',NULL);`);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const live = { stablePermissionModeState: { mode: 'bypassPermissions' }, setPermissionMode: vi.fn(async (mode: string) => { entered(); await pending; live.stablePermissionModeState = {mode}; }) };
    h.live.set('lane', live);
    const first = syncBotLanePermission('lane'); await started;
    runWorkerTx(sqlite, {name: 'bots.persistSessionPermission', args: {sessionId: 'chat', mode: 'auto'}});
    const second = syncBotLanePermission('lane'); release();
    await Promise.all([first, second]);
    expect(live.stablePermissionModeState.mode).toBe('auto');
    h.patched.mockClear();
    const owner = h.owner as {client: {tx: unknown}};
    owner.client.tx = async () => { h.owner = {}; return {mode:'ask'}; };
    await expect(syncBotLanePermission('lane')).rejects.toThrow('Account changed');
    expect(h.patched).not.toHaveBeenCalled();
  });

  // Distinct failure branch: repair has already cascaded saved permissions, but
  // the initiating runtime rejects. Siblings must still consume the repair.
  it('finishes a legacy repair on sibling runtimes after the initiating hot switch fails', async () => {
    sqlite.exec(`UPDATE bot_profile_versions SET capabilities_json = '{"permissions":"trusted"}';
      INSERT INTO sessions (id, permission_mode, updated_at) VALUES ('bad','bypassPermissions',1), ('good','bypassPermissions',1);
      INSERT INTO bot_session_links VALUES ('bot-1','bad','channel',NULL), ('bot-1','good','channel',NULL);`);
    const good = { stablePermissionModeState: { mode: 'bypassPermissions' }, setPermissionMode: vi.fn(async (mode: string) => { good.stablePermissionModeState = { mode }; }) };
    h.live.set('bad', { stablePermissionModeState: { mode: 'bypassPermissions' }, setPermissionMode: vi.fn(async () => { throw new Error('switch failed'); }) });
    h.live.set('good', good);
    await expect(syncBotLanePermission('bad')).rejects.toThrow('switch failed');
    expect(h.live.has('bad')).toBe(false);
    expect(good.stablePermissionModeState.mode).toBe('ask');
    expect(sqlite.prepare('SELECT DISTINCT permission_mode FROM sessions').pluck().all()).toEqual(['ask']);
  });

  it.each(['missing', 'plan'])('keeps Profile authority for lanes when main is %s', async kind => {
    if (kind === 'missing') sqlite.exec("DELETE FROM sessions WHERE id = 'chat'");
    else sqlite.exec("UPDATE sessions SET permission_mode = 'plan' WHERE id = 'chat'");
    sqlite.exec(`UPDATE bot_profile_versions SET capabilities_json = '{"permissions":"trusted"}';
      INSERT INTO sessions (id, permission_mode, updated_at) VALUES ('lane','ask',1);
      INSERT INTO bot_session_links VALUES ('bot-1','lane','channel',NULL);`);
    await syncBotLanePermission('lane');
    expect(sqlite.prepare("SELECT permission_mode FROM sessions WHERE id = 'lane'").pluck().get()).toBe('bypassPermissions');
    if (kind === 'plan') {
      await syncBotLanePermission('chat');
      expect(sqlite.prepare("SELECT permission_mode FROM sessions WHERE id = 'chat'").pluck().get()).toBe('plan');
    }
  });

  it.each(['missing', 'malformed'])('does not keep old authority when the active Profile is %s', async failure => {
    sqlite.exec(`INSERT INTO sessions (id, permission_mode, updated_at) VALUES ('lane','bypassPermissions',1);
      INSERT INTO bot_session_links VALUES ('bot-1','lane','channel',NULL);`);
    if (failure === 'missing') sqlite.exec('DELETE FROM bot_profile_versions');
    else sqlite.exec("UPDATE bot_profile_versions SET capabilities_json = 'null'");
    h.live.set('lane', {stablePermissionModeState:{mode:'bypassPermissions'},setPermissionMode:vi.fn()});
    await expect(syncBotLanePermission('lane')).rejects.toThrow('unreadable');
    expect(h.live.has('lane')).toBe(false);
    expect(sqlite.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(2);
  });

});
