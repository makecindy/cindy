/**
 * Unit: real chat embedder enqueue/provider entry points, in-memory SQLite only.
 * Contract: provider-sharing §4.1 — saving a link must not invoke any model.
 * Existing history-search tests cover retrieval, not automatic indexing/privacy.
 * Minimal failure: one excluded message while indexing is enabled, or a persisted
 * excluded row read by an already queued job after restart. No network or timers.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Message } from '../../../renderer/lib/ccAgent.types';
import type { EmbeddingProvider } from '../../embedding-host/providers';
import type { ChatHistoryEmbedderDeps } from '../chat-history-embedder';
import {
  onMessageCreated, resetCacheForNewDb, setChatEmbeddingEnabled, setupChatHistoryEmbedder,
} from '../chat-history-embedder';

const link = 'https://example.invalid/provider-share/join#fixture-not-a-real-token';
let sqlite: Database.Database;
let provider: EmbeddingProvider;
let deps: ChatHistoryEmbedderDeps;
const enqueueJobs = vi.fn();

function start() {
  setupChatHistoryEmbedder(deps);
  setChatEmbeddingEnabled(true);
}
function message(agentMeta: Message['agentMeta']): Message {
  return { id: 'saved', clientId: 'provider-share-link', sessionId: 'task', role: 'user',
    content: link, createdAt: new Date(100).toISOString(), agentMeta } as Message;
}
beforeEach(() => {
  resetCacheForNewDb();
  enqueueJobs.mockReset().mockResolvedValue(undefined);
  sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE messages (id TEXT, role TEXT, content TEXT, agent_meta TEXT, rewind_at INTEGER)');
  deps = {
    service: {
      registerVecTable: vi.fn(), registerProvider: (value: EmbeddingProvider) => { provider = value; }, enqueueJobs,
    },
    getDbClient: () => ({
      queryOne: async () => ({ value: '1' }),
      query: async (sql: string, params: unknown[]) => sqlite.prepare(sql).all(...params),
    }),
    log: { info: vi.fn(), warn: vi.fn() },
  } as unknown as ChatHistoryEmbedderDeps;
  start();
});
afterEach(() => { resetCacheForNewDb(); sqlite.close(); });

it('never enqueues a save-only message even with chat indexing enabled', async () => {
  await onMessageCreated(message({ excludeFromEmbedding: true }));
  expect(enqueueJobs).not.toHaveBeenCalled();
});

it('reads the persisted exclusion after restart before exposing text to queued/retried jobs', async () => {
  const insert = sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)');
  insert.run('saved', 'user', JSON.stringify(link), JSON.stringify({ excludeFromEmbedding: true }), null);
  insert.run('ordinary', 'user', JSON.stringify('ordinary message'), null, null);
  insert.run('rewound', 'user', JSON.stringify('rewound message'), null, 1);
  resetCacheForNewDb();
  start();
  expect(await provider.getTextsForJobs(['saved', 'ordinary', 'rewound', 'missing'].map((sourceId, rowid) => ({
    rowid, sourceId, chunkIndex: 0,
  })))).toEqual([
    { rowid: 0, text: null }, { rowid: 1, text: 'ordinary message' },
    { rowid: 2, text: null }, { rowid: 3, text: null },
  ]);
  // Exclusion affects automatic embedding, not the readable/copyable stored URL.
  expect(JSON.parse((sqlite.prepare('SELECT content FROM messages WHERE id = ?').get('saved') as { content: string }).content)).toBe(link);
});

it.each([null, { excludeFromEmbedding: false }])('preserves normal indexing when exclusion is %j', async agentMeta => {
  const msg = { ...message(agentMeta), content: 'ordinary message' };
  await onMessageCreated(msg);
  expect(enqueueJobs).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    source: 'chat', items: [expect.objectContaining({ sourceId: 'saved' })],
  }));
  sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(
    'saved', 'user', JSON.stringify(msg.content), JSON.stringify(agentMeta), null,
  );
  expect(await provider.getTextsForJobs([{ rowid: 1, sourceId: 'saved', chunkIndex: 0 }]))
    .toEqual([{ rowid: 1, text: 'ordinary message' }]);
});
