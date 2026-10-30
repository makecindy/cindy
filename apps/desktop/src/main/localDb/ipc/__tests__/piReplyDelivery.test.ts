/** Pi RPC → translator → Session → stream persistence → real in-memory SQLite. */
import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';
import { tx } from '../../worker/opHandlers/tx';

import { Session } from '../../../../../../../packages/maker-core/src/session';
import type { AgentSessionHandle } from '../../../../../../../packages/maker-core/src/agents/base-agent';
import type { AgentEvent } from '../../../../../../../packages/maker-core/src/types/events';
import { createAsyncQueue } from '../../../../../../../packages/maker-core/src/agents/shared/async-queue';
import { PiRpcProcess } from '../../../../../../../packages/maker-core/src/agents/pi/rpc-client';
import { attachJsonlReader, type PiTransport } from '../../../../../../../packages/maker-core/src/agents/pi/transport';
import { createPiTranslateContext, disposePiTranslateContext, translatePiEvent } from '../../../../../../../packages/maker-core/src/agents/pi/translator';
import { piSuccessfulReplyFrames, piReplyText, piReplyThinking } from '../../../../test/fixtures/piSuccessfulReply';
import { persistSessionStreamEvent } from '../../../maker-ipc/sessionEventStream';
import type { PreparedSessionEvent } from '../../../maker-ipc/sessionEventPreparation';
import { clearSessionPersistState, drainPersistQueue, flushAssistantBlock, noteSessionAgentKind } from '../../../messagePersistBroadcaster';

const h = vi.hoisted(() => ({
  sqlite: null as Database.Database | null,
  client: null as {
    drizzle: ReturnType<typeof drizzle>;
    tx: (name: string, args: unknown) => Promise<unknown>;
    exec: (sql: string, params?: unknown[]) => Promise<Database.RunResult>;
    query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  } | null,
  broadcast: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: h.broadcast } }] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() }),
}));
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() }),
}));
vi.mock('../../../maker-host/codex-local-sessions', () => ({
  importExternalCodexMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../maker-host/claude-local-sessions', () => ({
  importExternalClaudeCodeMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../embedders/chat-history-embedder', () => ({
  onMessageCreated: vi.fn(async () => undefined),
}));
vi.mock('../../../git-context/prRefsStore', () => ({
  recomputePrRefsForSession: vi.fn(async () => undefined),
  recordPrRefsForMessage: vi.fn(async () => undefined),
}));
vi.mock('../../../cindy-media/chatAttachments', () => ({
  commitMessageMediaRefs: vi.fn(async () => null),
  collectCindyMediaHashes: vi.fn(() => []),
}));
vi.mock('../../../cindy-media/ledger', () => ({
  removeRefs: vi.fn(async () => undefined),
  removeSessionAttachmentRefIfUnreferencedByLiveMessage: vi.fn(async () => undefined),
}));
vi.mock('../../../device-link/invoke-context', () => ({
  isDeviceLinkInvoke: vi.fn(() => false),
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: vi.fn(() => null),
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => h.client,
}));

function setupDb(): void {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cleared_at INTEGER,
      list_preview TEXT,
      list_preview_role TEXT,
      list_message_count INTEGER,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      agent_kind TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
    CREATE UNIQUE INDEX uniq_messages_session_client ON messages(session_id, client_id);
  `);
  sqlite.prepare("INSERT INTO sessions (id, cleared_at, status) VALUES ('s1', NULL, 'active')").run();
  const db = drizzle(sqlite, {
    schema: { messages, sessions },
  });
  h.sqlite = sqlite;
  h.client = {
    drizzle: db,
    tx: async (name: string, args: unknown) => tx(sqlite, { name, args }),
    exec: vi.fn(async (sql: string, params: unknown[] = []) => h.sqlite!.prepare(sql).run(...params)),
    query: vi.fn(async (sql: string, params: unknown[] = []) => h.sqlite!.prepare(sql).all(...params)),
  };
}

const logger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn(), fatal: vi.fn(),
  child: () => logger,
};

function createReplay() {
  const stdout = new PassThrough();
  const queue = createAsyncQueue<AgentEvent>();
  const ctx = createPiTranslateContext(logger);
  const transport: PiTransport = {
    pid: undefined,
    writeLine: vi.fn(async () => undefined),
    onLine: (listener) => { attachJsonlReader(stdout, listener); return () => undefined; },
    onClose: () => () => undefined,
    close: async () => { stdout.destroy(); },
    isClosed: () => stdout.destroyed,
  };
  new PiRpcProcess({
    transport, logger, onExit: vi.fn(),
    onEvent: (event) => translatePiEvent(event, queue, ctx),
  });
  const handle = {
    id: 'pi-replay', agentKind: 'pi', model: 'z-ai/glm-5.3-flash',
    events: () => queue, setInteractionResolver: vi.fn(),
    isTurnRunning: () => ctx.isStreaming,
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    close: async () => { disposePiTranslateContext(ctx); queue.end(); stdout.destroy(); },
  } as unknown as AgentSessionHandle;
  const session = new Session({
    id: 's1', agentKind: 'pi', workDir: process.cwd(), handle,
    capabilities: {} as never, logger, turnStallMs: 0,
  });
  const received: AgentEvent[] = [];
  const persistIds: string[] = [];
  session.onEvent((event) => {
    received.push(event);
    const result = persistSessionStreamEvent({ log: logger, orcaTeamServiceForEvents: null }, session, {
      event, eventAgentMeta: event.agentMeta ?? null,
    } as PreparedSessionEvent);
    if (result.persistId) persistIds.push(result.persistId);
    // The existing terminal consumer uses this same helper at done/error.
    if (event.type === 'done') flushAssistantBlock(session.id);
  });
  return {
    session, received, persistIds, transport,
    async feed(frames: unknown[], chunkSize = 17) {
      const bytes = Buffer.from(frames.map((frame) => JSON.stringify(frame)).join('\r\n') + '\r\n');
      for (let i = 0; i < bytes.length; i += chunkSize) stdout.write(bytes.subarray(i, i + chunkSize));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await drainPersistQueue();
    },
  };
}

function rows() {
  return h.sqlite!.prepare('SELECT role, content, client_id, agent_meta FROM messages ORDER BY rowid').all() as
    Array<{ role: string; content: string; client_id: string; agent_meta: string | null }>;
}

describe('Pi successful reply delivery (#3696)', () => {
  let replay: ReturnType<typeof createReplay>;
  beforeEach(() => {
    vi.clearAllMocks();
    setupDb();
    clearSessionPersistState('s1');
    noteSessionAgentKind('s1', 'pi');
    replay = createReplay();
  });
  afterEach(async () => {
    await replay.session.close();
    await drainPersistQueue();
    clearSessionPersistState('s1');
    h.sqlite?.close();
  });

  it.each([true, false])('persists thinking and full text before settlement (streamed=%s)', async (streamed) => {
    const fixture = piSuccessfulReplyFrames({ streamed });
    await replay.feed(fixture.generation);
    expect(replay.received.filter((event) => event.type === 'done')).toEqual([]);
    expect(logger.error.mock.calls).toEqual([]);
    expect(h.warn.mock.calls).toEqual([]);
    expect(replay.received.some((event) => event.type === 'text')).toBe(true);
    expect(rows().map((row) => row.role)).toEqual(['thinking', 'assistant']);
    expect(rows()[0].content).toContain(piReplyThinking);
    expect(rows()[1].content).toBe(piReplyText);
    const assistant = rows().find((row) => row.role === 'assistant')!;
    expect(JSON.parse(assistant.agent_meta ?? '{}').turnCompleted).toBeUndefined();
    expect(replay.persistIds.every((id) => id === assistant.client_id)).toBe(true);
    expect(h.broadcast).toHaveBeenCalledWith('local-db:messages:created', expect.objectContaining({
      message: expect.objectContaining({ clientId: assistant.client_id, role: 'assistant', content: piReplyText }),
    }));
    await replay.feed(fixture.settlement);
    expect(rows().filter((row) => row.role === 'assistant')).toHaveLength(1);
    expect(replay.received.filter((event) => event.type === 'done')).toMatchObject([
      { data: { status: 'completed', result: piReplyText, usage: { outputTokens: 684 } } },
    ]);
    expect(replay.received.find((event) => event.type === 'done')?.data).not.toHaveProperty('silentStop');
    expect(replay.transport.writeLine).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('retains a completed message when another assistant reply starts before agent_settled', async () => {
    const first = piSuccessfulReplyFrames();
    await replay.feed(first.generation);
    const secondText = '第二条独立回复，不应覆盖上一条正文。';
    const second = piSuccessfulReplyFrames({ text: secondText });
    // Queued follow-up: no tool boundary or product settlement between replies.
    await replay.feed([first.settlement[0], ...second.generation.slice(1)]);
    await replay.feed(second.settlement);
    expect(rows().filter((row) => row.role === 'assistant').map((row) => row.content))
      .toEqual([piReplyText, secondText]);
  });

  it('does not duplicate an authoritative final snapshot or lose it when the consumer closes', async () => {
    const fixture = piSuccessfulReplyFrames();
    await replay.feed(fixture.generation, 1); // UTF-8 characters split across stdout chunks.
    await replay.feed(fixture.generation.slice(-1));
    await replay.session.close();
    clearSessionPersistState('s1');
    expect(rows().filter((row) => row.role === 'assistant').map((row) => row.content))
      .toEqual([piReplyText]);
  });
});
