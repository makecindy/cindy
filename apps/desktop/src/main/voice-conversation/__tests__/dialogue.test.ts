import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { messages, sessions } from '../../localDb/schema.js';
import { tx as runInprocTx } from '../../localDb/worker/opHandlers/tx.js';

// Regression: a real call could not start because its createMessage options
// combined incompatible publication guards. The old resolved create mock hid
// this contract. Unit tier: real dialogue + createMessage + in-memory SQLite
// transaction, with owner/clear races; no user data, devices or paid requests.
const h = vi.hoisted(() => ({
  owner: 'owner-a',
  boundaryPending: false,
  snapshot: {} as object,
  sqlite: null as Database.Database | null,
  beforeInsert: undefined as (() => void) | undefined,
  afterInsert: undefined as (() => void) | undefined,
  query: vi.fn(),
  queryOne: vi.fn(),
  exec: vi.fn(),
  broadcast: vi.fn(),
  windowSend: vi.fn(),
  warn: vi.fn(),
  generate: vi.fn(),
  dispatch: vi.fn(),
  emit: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: h.windowSend },
  }] },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() }),
}));
vi.mock('../../maker-host/codex-local-sessions.js', () => ({
  importExternalCodexMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../maker-host/claude-local-sessions.js', () => ({
  importExternalClaudeCodeMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../embedders/chat-history-embedder.js', () => ({
  onMessageCreated: vi.fn(async () => undefined),
}));
vi.mock('../../git-context/prRefsStore.js', () => ({
  recomputePrRefsForSession: vi.fn(async () => undefined),
  recordPrRefsForMessage: vi.fn(async () => undefined),
}));
vi.mock('../../cindy-media/chatAttachments.js', () => ({
  commitMessageMediaRefs: vi.fn(async () => undefined),
  collectCindyMediaHashes: vi.fn(() => []),
}));
vi.mock('../../cindy-media/ledger.js', () => ({
  removeRefs: vi.fn(async () => undefined),
  removeSessionAttachmentRefIfUnreferencedByLiveMessage: vi.fn(async () => undefined),
}));
vi.mock('../../device-link/invoke-context.js', () => ({
  isDeviceLinkInvoke: vi.fn(() => false),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => h.boundaryPending,
}));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => h.snapshot,
  getDbClient: () => (h.snapshot as { client: unknown }).client,
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerScopeKey: h.owner }),
  isDataOwnerBroadcastScopeCurrent: (scope: { ownerScopeKey?: string }) =>
    !h.boundaryPending && scope.ownerScopeKey === h.owner,
  getSafeDataOwnerPushStamp: () => undefined,
  tapWindowBroadcast: h.broadcast,
}));
vi.mock('../../maker-ipc/forwardedRequest.js', () => ({
  formatForwardedRequest: (original: unknown, supplement: unknown) =>
    JSON.stringify({ original, supplement }),
}));
vi.mock('../../utility-model/oneShotCandidates.js', () => ({
  requestExplicitUtilityText: h.generate,
}));
vi.mock('../semanticExit.js', () => ({
  readVoiceCompanionRoute: async () => ({
    providerId: 'selected',
    agentKind: 'codex',
    model: 'chosen',
  }),
}));
vi.mock('../taskBridge.js', () => ({
  dispatchVoiceTask: h.dispatch,
  readVoiceCallMemory: async () => 'Read-only facts',
}));
import { CompanionCallDialogue } from '../dialogue.js';
import * as messageStore from '../../localDb/ipc/messages.js';

const originalCreateMessage = messageStore.createMessage;
const createMessage = vi.spyOn(messageStore, 'createMessage');
const calls: CompanionCallDialogue[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.owner = 'owner-a';
  h.boundaryPending = false;
  h.beforeInsert = undefined;
  h.afterInsert = undefined;
  const sqlite = new Database(':memory:');
  h.sqlite = sqlite;
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cleared_at INTEGER, status TEXT DEFAULT 'active',
      list_preview TEXT, list_preview_role TEXT, list_message_count INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, session_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, tool_use_id TEXT, agent_meta TEXT,
      agent_kind TEXT, created_at INTEGER NOT NULL, rewind_at INTEGER,
      UNIQUE(session_id, client_id)
    );
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY, display_name TEXT, canonical_session_id TEXT, current_version INTEGER
    );
    CREATE TABLE bot_profile_versions (
      bot_id TEXT, version INTEGER, identity_source TEXT, capabilities_json TEXT
    );
    INSERT INTO sessions (id) VALUES ('main');
    INSERT INTO bot_profiles VALUES ('bot', 'Cindy', 'main', 1);
    INSERT INTO bot_profile_versions VALUES ('bot', 1, 'Be kind', '{}');
  `);
  h.queryOne.mockImplementation(async (sql: string, params: unknown[] = []) =>
    sqlite.prepare(sql).get(...params));
  h.query.mockImplementation(async (sql: string, params: unknown[] = []) =>
    sql.includes('bot_delegations') ? [] : sqlite.prepare(sql).all(...params));
  h.exec.mockImplementation(async (sql: string, params: unknown[] = []) =>
    sqlite.prepare(sql).run(...params));
  h.snapshot = { client: {
    drizzle: drizzle(sqlite, { schema: { messages, sessions } }),
    query: h.query,
    queryOne: h.queryOne,
    exec: h.exec,
    tx: async (name: string, args: unknown) => {
      if (name === 'message.insert') h.beforeInsert?.();
      const result = runInprocTx(sqlite, { name, args });
      if (name === 'message.insert') h.afterInsert?.();
      return result;
    },
  } };
  createMessage.mockReset();
  createMessage.mockImplementation(originalCreateMessage);
  h.generate.mockResolvedValue({ ok: true, text: '{"say":"Hello."}' });
  h.dispatch.mockResolvedValue(true);
});
afterEach(async () => {
  try {
    await Promise.all(calls.splice(0).map((call) => call.end()));
  } finally {
    h.sqlite?.close();
    vi.useRealTimers();
  }
});
function storedRecord() {
  const row = h.sqlite!.prepare(
    "SELECT content, agent_meta FROM messages WHERE client_id = 'voice-call:call'",
  ).get() as { content: string; agent_meta: string } | undefined;
  return row && { content: row.content, record: JSON.parse(row.agent_meta).voiceCall };
}
it('creates, updates and closes one durable call card through the real message writer', async () => {
  const call = await start();
  expect(storedRecord()).toMatchObject({ content: '', record: { callId: 'call', turns: [] } });
  await call.submit('input', 'Hi', false);
  await vi.waitFor(() => expect(storedRecord()?.record.turns).toHaveLength(2));
  await call.end();
  expect(storedRecord()?.record.endedAt).toEqual(expect.any(Number));
  expect(h.sqlite!.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 });
});
it('rejects initial persistence when clear wins the insert race', async () => {
  h.beforeInsert = () => {
    h.sqlite!.prepare("UPDATE sessions SET cleared_at = 200 WHERE id = 'main'").run();
  };
  await expect(start()).rejects.toThrow('call_record_unavailable');
  expect(storedRecord()).toBeUndefined();
  expect(h.broadcast).not.toHaveBeenCalled();
  expect(h.windowSend).not.toHaveBeenCalled();
  expect(h.warn).toHaveBeenCalledWith('call record persistence failed', {
    callId: 'call', ownerCurrent: true, stage: 'insert', reason: 'cleared',
  });
});
it.each(['owner', 'database', 'boundary'] as const)(
  'does not save or publish through a %s change while a call is opening',
  async (change) => {
    h.afterInsert = () => {
      if (change === 'owner') h.owner = 'owner-b';
      if (change === 'database') h.snapshot = { client: {} };
      if (change === 'boundary') h.boundaryPending = true;
    };
    await expect(start()).rejects.toThrow('call_owner_changed');
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.windowSend).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
  });
async function start() {
  const call = new CompanionCallDialogue({
    callId: 'call',
    botId: 'bot',
    sessionId: 'main',
    emit: h.emit,
  });
  calls.push(call);
  await call.start();
  return call;
}
it('persists one UI-only record and uses the selected route with read-only context', async () => {
  const call = await start();
  expect(await call.submit('input', 'Hi', false)).toBe(true);
  await vi.waitFor(() => expect(h.generate).toHaveBeenCalled());
  expect(h.generate.mock.calls[0][1]).toMatchObject({ providerId: 'selected', model: 'chosen' });
  expect(h.generate.mock.calls[0][0]).toContain('Read-only facts');
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(
    createMessage.mock.calls.every(
      ([session, body]) =>
        session === 'main' && body.content === '' && body.clientId === 'voice-call:call',
    ),
  ).toBe(true);
});
it('ordinary input acceptance does not wait for model generation', async () => {
  h.generate.mockReturnValue(new Promise(() => {}));
  const call = await start();
  expect(await call.submit('input', 'Hi', false)).toBe(true);
});
it('compound exits wait for task acceptance and preserve host input provenance', async () => {
  let accept!: (ok: boolean) => void;
  h.dispatch.mockImplementation(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  const call = await start();
  const pending = call.submit('input', 'Make a plan, then leave.', true);
  await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledOnce());
  const input = h.dispatch.mock.calls[0][0];
  expect(input.persistedContent).toBe('Make a plan, then leave.');
  expect(input.autoReviewUserText.request.userText).toBe('Make a plan, then leave.');
  expect(input.resumeWithStoredPermissionMode).toBe(true);
  accept(true);
  expect(await pending).toBe(true);
});
it('does not read or dispatch through a replaced owner/database', async () => {
  const call = await start();
  h.owner = 'owner-b';
  await expect(call.submit('input', 'Hi', false)).rejects.toThrow('call_owner_changed');
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.dispatch).not.toHaveBeenCalled();
});
it('returns background results by protected input provenance, even after the introduction', async () => {
  const call = await start();
  await call.submit('input', 'Research a plan.', true);
  h.query.mockImplementation(async (sql: string) =>
    sql.includes('bot_delegations') ? [{ status: 'completed', result: 'Three steps.' }] : [],
  );
  await vi.advanceTimersByTimeAsync(650);
  expect(h.generate).toHaveBeenCalledOnce();
  expect(h.generate.mock.calls[0][0]).toContain('Three steps.');
  expect(h.query.mock.calls.find(([sql]) => sql.includes('bot_delegations'))?.[1]).toEqual([
    'main',
    'main',
    'input',
  ]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.generate).toHaveBeenCalledOnce();
});
// Regression: completed main replies are stored as bare text by createMessage;
// JSON.parse alone silently discarded them. The delegation-only case above
// never exercised this path. Unit tier: submit through the real dialogue, write
// a canonical reply through createMessage into SQLite, then observe the saved
// call result/reply. Also retain compatibility with JSON-encoded text.
it.each(['plain', 'json'] as const)('returns a completed %s-text main reply to the call once', async (format) => {
  const call = await start();
  await call.submit('input', 'Check my task list.', true);
  const handoffId = h.dispatch.mock.calls[0][0].clientId;
  await messageStore.createMessage('main', {
    clientId: handoffId, role: 'user', content: 'Check my task list.',
  });
  const result = '待办清单为空。\n日历还需要完成授权。';
  const spoken = '待办清单为空，日历还需要完成授权。';
  await messageStore.createMessage('main', {
    clientId: 'final', role: 'assistant',
    content: format === 'json' ? JSON.stringify(result) : result,
    agentMeta: { assistantPhase: 'final_answer', turnCompleted: true },
  });
  h.generate.mockResolvedValue({ ok: true, text: JSON.stringify({ say: spoken }) });

  await vi.advanceTimersByTimeAsync(650);
  expect(storedRecord()?.record.handoffs).toEqual([
    expect.objectContaining({ id: handoffId, state: 'completed', result }),
  ]);
  expect(storedRecord()?.record.turns).toContainEqual(expect.objectContaining({
    id: 'input:reply:result', role: 'assistant', text: spoken, complete: true,
  }));
  expect(h.emit.mock.calls.at(-1)?.[0].turns).toContainEqual(expect.objectContaining({
    id: 'input:reply:result', text: spoken, complete: true,
  }));
  expect(JSON.parse(h.generate.mock.calls[0][0]).taskResult).toBe(result);
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.generate).toHaveBeenCalledOnce();
  expect(h.dispatch).toHaveBeenCalledOnce();
});
it('waits for the final reply instead of returning history, tools, commentary or empty content', async () => {
  const call = await start();
  await messageStore.createMessage('main', {
    clientId: 'history', role: 'assistant', content: 'An earlier result.',
    agentMeta: { turnCompleted: true },
  });
  await call.submit('input', 'Check my task list.', true);
  await messageStore.createMessage('main', {
    clientId: h.dispatch.mock.calls[0][0].clientId, role: 'user', content: 'Check my task list.',
  });
  await messageStore.createMessage('main', {
    clientId: 'tool', role: 'tool_result', content: 'Internal tool output.',
  });
  await messageStore.createMessage('main', {
    clientId: 'commentary', role: 'assistant', content: 'Checking.',
    agentMeta: { assistantPhase: 'commentary', turnCompleted: true },
  });
  await messageStore.createMessage('main', {
    clientId: 'streaming', role: 'assistant', content: 'An unfinished answer',
    agentMeta: { assistantPhase: 'final_answer', turnCompleted: false },
  });
  await messageStore.createMessage('main', {
    clientId: 'empty', role: 'assistant', content: '  ',
    agentMeta: { turnCompleted: true },
  });
  await messageStore.createMessage('main', {
    clientId: 'structured', role: 'assistant', content: { internal: 'Not spoken text.' },
    agentMeta: { turnCompleted: true },
  });
  await vi.advanceTimersByTimeAsync(650);
  expect(h.generate).not.toHaveBeenCalled();
  expect(storedRecord()?.record.handoffs[0]).toMatchObject({ state: 'accepted' });

  await messageStore.createMessage('main', {
    clientId: 'final', role: 'assistant', content: 'The task list is empty.',
    agentMeta: { assistantPhase: 'final_answer', turnCompleted: true },
  });
  await vi.advanceTimersByTimeAsync(650);
  expect(storedRecord()?.record.handoffs[0]).toMatchObject({
    state: 'completed', result: 'The task list is empty.',
  });
  expect(h.generate).toHaveBeenCalledOnce();
});
it('does not return another user turn as the handed-off task result', async () => {
  const call = await start();
  await call.submit('input', 'Check my task list.', true);
  await messageStore.createMessage('main', {
    clientId: h.dispatch.mock.calls[0][0].clientId, role: 'user', content: 'Check my task list.',
  });
  await messageStore.createMessage('main', {
    clientId: 'next-user', role: 'user', content: 'Tell me a joke instead.',
  });
  await messageStore.createMessage('main', {
    clientId: 'next-answer', role: 'assistant', content: 'An unrelated joke.',
    agentMeta: { assistantPhase: 'final_answer', turnCompleted: true },
  });
  await vi.advanceTimersByTimeAsync(650);
  expect(h.generate).not.toHaveBeenCalled();
  expect(storedRecord()?.record.handoffs[0]).toMatchObject({ state: 'accepted' });
  expect(storedRecord()?.record.turns).toHaveLength(1);
});
it('closing releases result observation but never cancels accepted work', async () => {
  const call = await start();
  await call.submit('input', 'Work in the background.', true);
  await call.end();
  h.query.mockClear();
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.query).not.toHaveBeenCalled();
  expect(h.dispatch).toHaveBeenCalledOnce();
  expect(h.generate).not.toHaveBeenCalled();
});
it('fails startup when the durable call card cannot be created', async () => {
  createMessage.mockRejectedValueOnce(new Error('private transcript and database path'));
  await expect(start()).rejects.toThrow('call_record_unavailable');
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.warn).toHaveBeenCalledWith('call record persistence failed', {
    callId: 'call', ownerCurrent: true, stage: 'insert', reason: 'storage_failed',
  });
  expect(JSON.stringify(h.warn.mock.calls)).not.toContain('private transcript');
});
it('does not republish a card removed by a clear boundary', async () => {
  const call = await start();
  h.broadcast.mockClear();
  const original = storedRecord();
  h.sqlite!.prepare("UPDATE sessions SET cleared_at = ? WHERE id = 'main'").run(Date.now());
  await call.submit('input', 'Hello.', false);
  await vi.advanceTimersByTimeAsync(50);
  expect(storedRecord()).toEqual(original);
  expect(h.broadcast).not.toHaveBeenCalled();
});
