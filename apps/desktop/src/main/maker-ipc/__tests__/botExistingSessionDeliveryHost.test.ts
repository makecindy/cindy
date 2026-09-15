import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { InteractionDecision, InteractionRequest, Session } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopBotExistingSessionDelivery } from '../botExistingSessionDeliveryHost';
import { installDesktopInteractionHandler } from '../interactionRouter';
import { existingSessionDeliveryClientId } from '../botExistingSessionDelivery';

const state = vi.hoisted(() => ({ scope: 'owner:1', owner: 'owner', pending: false, client: {} as { drizzle?: unknown } }));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => state.scope,
  getActiveAppSession: () => ({ dataOwnerId: state.owner }),
  isAppSessionBoundaryPending: () => state.pending,
}));
vi.mock('../../localDb/client/current', () => ({ getDbClient: () => state.client }));
vi.mock('../../i18n', () => ({ t: (key: string) => key === 'botExistingSessionDelivery.remoteTarget' ? 'Remote host: {{hostId}}' : key }));
const input = { callerSessionId: 'bot-main', targetSessionId: 'fable-original', message: 'Confirm receipt only.', idempotencyKey: 'test-once' };
let db: Database.Database;
beforeEach(() => {
  state.scope = 'owner:1'; state.owner = 'owner'; state.pending = false;
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, source TEXT, status TEXT,
      cleared_at INTEGER, model TEXT, agent_kind TEXT, provider_id TEXT, permission_mode TEXT,
      working_dir TEXT, remote_host_id TEXT, effort TEXT, fast_mode INTEGER, plan_mode_enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE bot_session_links (session_id TEXT, bot_id TEXT, role TEXT);
    CREATE TABLE messages (session_id TEXT, client_id TEXT, content TEXT, agent_meta TEXT);
    INSERT INTO sessions VALUES ('bot-main','Teammate','bot','active',NULL,'gpt','codex','openai','ask','/bot',NULL,'medium',0,0);
    INSERT INTO sessions VALUES ('fable-original','Original Fable','chat','active',NULL,'fable','claude-code','anthropic','ask','/project',NULL,'high',0,0);
    INSERT INTO bot_profiles VALUES ('teammate','active');
    INSERT INTO bot_session_links VALUES ('bot-main','teammate','canonical');
  `);
  state.client = { drizzle: drizzle(db) };
});
afterEach(() => db.close());

function harness() {
  let generation = 1;
  let permissionGeneration = 1;
  let running = true;
  const caller = {
    id: input.callerSessionId,
    get stablePermissionModeState() { return { mode: 'ask', generation: permissionGeneration }; },
    getTurnGeneration: () => 1,
    getStatus: () => 'active',
    isTurnRunning: () => running,
    onStatusChange: vi.fn(() => vi.fn()),
    setInteractionListener: vi.fn(),
    runHostInteraction: async (_request: InteractionRequest, resolve: () => Promise<InteractionDecision>) => resolve(),
  };
  const approve = vi.fn<(request: InteractionRequest) => Promise<InteractionDecision>>(async () => ({ kind: 'permission', behavior: 'allow' }));
  installDesktopInteractionHandler(caller, approve);
  const queue = new Map<string, { message: string }>();
  const enqueue = vi.fn((message: string, id: string) => queue.set(id, { message }));
  const deps = {
    getLiveSession: (id: string) => id === caller.id ? caller as unknown as Session : undefined,
    restoreQueue: vi.fn(async () => undefined),
    getInputGeneration: () => generation,
    assertInputCurrent: (_id: string, expected: number) => { if (generation !== expected) throw new Error('cleared'); },
    findQueued: (_id: string, id: string) => queue.get(id) ?? null,
    hasKnownInput: (_id: string, id: string) => queue.has(id),
    withTargetLock: async <T>(_id: string, action: () => Promise<T>) => action(),
    prepare: vi.fn(async (request: typeof input, clientId: string) => () => { enqueue(request.message, clientId); }),
    flush: vi.fn(async () => undefined),
  };
  return { service: createDesktopBotExistingSessionDelivery(deps), deps, approve, enqueue, queue,
    downgrade: () => { permissionGeneration++; }, clearTarget: () => { generation++; }, stopCaller: () => { running = false; } };
}

describe('existing Session delivery Host authorization', () => {
  it('resolves the caller from ownership rows and presents the real target with the exact body', async () => {
    const h = harness();
    expect(await h.service.send(input)).toMatchObject({ ok: true, targetSessionId: 'fable-original' });
    expect(h.approve).toHaveBeenCalledOnce();
    expect(h.approve.mock.calls[0][0]).toMatchObject({ kind: 'permission',
      input: { session_id: 'fable-original', title: 'Original Fable', message: input.message,
        model: 'fable', agent_kind: 'claude-code', provider_id: 'anthropic', permission_mode: 'ask',
        plan_mode_enabled: false, effort: 'high', fast_mode: false },
      metadata: { hostOwnedConfirmation: 'bot_existing_session_delivery' } });
    expect(h.enqueue).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT model, permission_mode FROM sessions WHERE id=?').get(input.targetSessionId))
      .toEqual({ model: 'fable', permission_mode: 'ask' });
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 2 });
  });
  it.each(['missing', 'archived', 'deleted', 'bot'])('rejects an unavailable or teammate target (%s) before prompting', async kind => {
    if (kind === 'missing') db.prepare('DELETE FROM sessions WHERE id=?').run(input.targetSessionId);
    else db.prepare(`UPDATE sessions SET ${kind === 'bot' ? 'source' : 'status'}=? WHERE id=?`).run(kind, input.targetSessionId);
    const h = harness(); expect(await h.service.send(input)).toMatchObject({ ok: false });
    expect(h.approve).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled();
  });
  it('rejects a paused teammate before any delivery confirmation', async () => {
    db.prepare("UPDATE bot_profiles SET status='paused'").run();
    const h = harness(); expect(await h.service.send(input)).toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
    expect(h.approve).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled();
  });
  it('rejects a Review target before prompting or preparing external input', async () => {
    db.prepare("UPDATE sessions SET source='review' WHERE id=?").run(input.targetSessionId);
    const h = harness();
    expect(await h.service.send(input)).toMatchObject({ ok: false, errorCode: 'INVALID_TARGET' });
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.deps.restoreQueue).not.toHaveBeenCalled();
    expect(h.deps.prepare).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it.each([null, 'ssh-original-host'])('shows the actual execution location before approval (remote=%s)', async remoteHostId => {
    db.prepare('UPDATE sessions SET remote_host_id=? WHERE id=?').run(remoteHostId, input.targetSessionId);
    const h = harness();
    expect(await h.service.send(input)).toMatchObject({ ok: true });
    expect(h.approve.mock.calls[0][0]).toMatchObject({ input: {
      remote_host_id: remoteHostId, working_directory: '/project',
      execution_location: remoteHostId ? `Remote host: ${remoteHostId}` : 'botExistingSessionDelivery.localTarget',
    } });
    expect(db.prepare('SELECT remote_host_id FROM sessions WHERE id=?').get(input.targetSessionId))
      .toEqual({ remote_host_id: remoteHostId });
  });
  it('does not accept a noncanonical caller even if its model can call the tool', async () => {
    db.prepare("UPDATE bot_session_links SET role='child'").run();
    const h = harness(); expect(await h.service.send(input)).toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
    expect(h.approve).not.toHaveBeenCalled();
  });
  it.each(['owner', 'permission', 'cleared', 'model', 'remote', 'title', 'plan', 'stopped'])('rejects a late allow decision after %s changes', async kind => {
    const h = harness(); h.approve.mockImplementation(async () => {
      if (kind === 'owner') state.scope = 'owner:2';
      if (kind === 'permission') h.downgrade();
      if (kind === 'cleared') h.clearTarget();
      if (kind === 'model') db.prepare('UPDATE sessions SET model=? WHERE id=?').run('other',input.targetSessionId);
      if (kind === 'remote') db.prepare('UPDATE sessions SET remote_host_id=? WHERE id=?').run('other-host',input.targetSessionId);
      if (kind === 'title') db.prepare('UPDATE sessions SET title=? WHERE id=?').run('Renamed',input.targetSessionId);
      if (kind === 'plan') db.prepare('UPDATE sessions SET plan_mode_enabled=1 WHERE id=?').run(input.targetSessionId);
      if (kind === 'stopped') h.stopCaller();
      return { kind: 'permission', behavior: 'allow' };
    });
    expect(await h.service.send(input)).toMatchObject({ ok: false }); expect(h.enqueue).not.toHaveBeenCalled();
  });
  it('reuses a persisted receipt after restart, including a transcript the user has cleared', async () => {
    db.prepare('INSERT INTO messages (session_id,client_id,content) VALUES (?,?,?)').run(input.targetSessionId, existingSessionDeliveryClientId(input), input.message);
    db.prepare('UPDATE sessions SET cleared_at=123 WHERE id=?').run(input.targetSessionId);
    const h = harness(); expect(await h.service.send(input)).toMatchObject({ ok: true, reused: true });
    expect(h.approve).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled();
  });
  it('reuses the original authorization body after a hook rewrites the persisted message', async () => {
    db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run(input.targetSessionId,
      existingSessionDeliveryClientId(input), 'Hook-rewritten message',
      JSON.stringify({ origin: { kind: 'session', senderSessionId: input.callerSessionId, displayText: input.message } }));
    const h = harness();
    expect(await h.service.send(input)).toMatchObject({ ok: true, reused: true });
    expect(await h.service.send({ ...input, message: 'Different instruction' }))
      .toMatchObject({ ok: false, errorCode: 'IDEMPOTENCY_CONFLICT' });
    expect(h.approve).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled();
  });
  it('rejects a persisted key with a different body', async () => {
    db.prepare('INSERT INTO messages (session_id,client_id,content) VALUES (?,?,?)').run(input.targetSessionId, existingSessionDeliveryClientId(input), 'different');
    const h = harness(); expect(await h.service.send(input)).toMatchObject({ ok: false, errorCode: 'IDEMPOTENCY_CONFLICT' });
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
