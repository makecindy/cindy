import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import type { DbClient } from '../../localDb/client/DbClient.js';
import {
  clearCurrentDbClient,
  setCurrentDbClient,
} from '../../localDb/client/current.js';
import * as schema from '../../localDb/schema.js';
import { hydrateQueuedAgentReferences } from '../agentInputReferences.js';

describe('hydrateQueuedAgentReferences message visibility', () => {
  let rawDb: Database.Database;
  let client: DbClient;

  beforeEach(() => {
    rawDb = new Database(':memory:');
    rawDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cleared_at INTEGER
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        rewind_at INTEGER
      );
      CREATE TABLE bot_profiles (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL,
        attention_reason TEXT
      );
      CREATE TABLE bot_session_links (
        bot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        archived_at INTEGER
      );
      CREATE TABLE bot_runtime_snapshots (
        bot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        prepared_at INTEGER NOT NULL
      );
      CREATE TABLE bot_delegations (
        id TEXT PRIMARY KEY,
        requesting_bot_id TEXT NOT NULL,
        target_bot_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO sessions (id, cleared_at) VALUES ('source-session', NULL);
    `);
    client = {
      query: async <T = unknown>(sql: string, params: unknown[] = []) =>
        rawDb.prepare(sql).all(...params) as T[],
      queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
        rawDb.prepare(sql).get(...params) as T | undefined,
      exec: async (sql, params = []) => rawDb.prepare(sql).run(...params),
      tx: async () => {
        throw new Error('tx is not used by this test');
      },
      drizzle: drizzle(rawDb, { schema }),
      vecAvailable: false,
      dispose: async () => {},
    };
    setCurrentDbClient(client, 'test-user');
  });

  afterEach(() => {
    clearCurrentDbClient(client);
    rawDb.close();
  });

  function seedMessage(rewindAt: number | null): void {
    rawDb.prepare(`
      INSERT INTO messages (
        id, client_id, session_id, role, content, created_at, rewind_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'row-1',
      'target-message',
      'source-session',
      'assistant',
      'Authoritative visible body',
      200,
      rewindAt,
    );
  }

  function queued(capturedText = 'Composer-captured fallback'): AgentInputQueuedMessage {
    const href = 'cindy://session/source-session?message=target-message';
    const text = `inspect ${href}`;
    const reference = {
      kind: 'message' as const,
      start: text.indexOf(href),
      end: text.length,
      href,
      sessionId: 'source-session',
      messageClientId: 'target-message',
      text: capturedText,
    };
    return {
      clientId: 'queued-message',
      text,
      persistedContent: JSON.stringify({ text, agentReferences: [reference] }),
      agentReferences: [reference],
      model: 'claude-opus-4-7',
      effort: 'medium',
      permissionMode: 'default',
      workingDir: '/repo',
      chatMessage: {
        clientId: 'queued-message',
        role: 'user',
        content: text,
        isStreaming: false,
        createdAt: '2026-07-23T00:00:00.000Z',
      },
      createOpts: {
        agentKind: 'claude-code',
        workingDir: '/repo',
        model: 'claude-opus-4-7',
        effort: 'medium',
        permissionMode: 'default',
        userPrompt: '',
        makerMemoryEnabled: true,
        displayReasoning: 'summarized',
      },
    };
  }

  it('hydrates a visible target from the authoritative host DB', async () => {
    seedMessage(null);

    const hydrated = await hydrateQueuedAgentReferences(queued());

    expect(hydrated.agentReferences?.[0]).toMatchObject({
      kind: 'message',
      text: 'Authoritative visible body',
    });
  });

  it('does not re-inject a rewound target through captured fallback text', async () => {
    seedMessage(300);

    const hydrated = await hydrateQueuedAgentReferences(queued());

    expect(hydrated.agentReferences?.[0]).not.toHaveProperty('text');
    expect(JSON.parse(hydrated.persistedContent).agentReferences[0]).not.toHaveProperty('text');
  });

  it('does not re-inject a target hidden by the session clear boundary', async () => {
    seedMessage(null);
    rawDb.prepare('UPDATE sessions SET cleared_at = ? WHERE id = ?')
      .run(250, 'source-session');

    const hydrated = await hydrateQueuedAgentReferences(queued());

    expect(hydrated.agentReferences?.[0]).not.toHaveProperty('text');
    expect(JSON.parse(hydrated.persistedContent).agentReferences[0]).not.toHaveProperty('text');
  });

  it('attaches current host Bot state without persisting a stale snapshot', async () => {
    rawDb.exec(`
      INSERT INTO bot_profiles (id, display_name, status, attention_reason)
      VALUES ('bot-b', '小柴', 'active', NULL);
      INSERT INTO bot_session_links (bot_id, session_id, role, archived_at)
      VALUES ('bot-b', 'bot-b-main', 'canonical', NULL);
      INSERT INTO bot_runtime_snapshots (bot_id, session_id, status, prepared_at)
      VALUES ('bot-b', 'bot-b-main', 'applied', 100);
      INSERT INTO bot_delegations (id, requesting_bot_id, target_bot_id, status)
      VALUES ('delegation-1', 'bot-a', 'bot-b', 'running');
    `);
    const href = 'cindy://bot/bot-b';
    const text = `@${href}`;
    const reference = {
      kind: 'bot' as const,
      start: 1,
      end: text.length,
      href,
      botId: 'bot-b',
      name: '旧名字',
    };
    const input = queued();
    input.text = text;
    input.persistedContent = JSON.stringify({ text, agentReferences: [reference] });
    input.agentReferences = [reference];

    const hydrated = await hydrateQueuedAgentReferences(input, {
      isSessionTurnRunning: (sessionId) => sessionId === 'bot-b-main',
    });

    expect(hydrated.agentReferences?.[0]).toMatchObject({
      kind: 'bot',
      botId: 'bot-b',
      name: '小柴',
      hostSnapshot: {
        availability: 'ready',
        activity: 'working',
        activeDelegations: 1,
      },
    });
    expect(JSON.parse(hydrated.persistedContent).agentReferences[0])
      .not.toHaveProperty('hostSnapshot');
  });
});
