/**
 * The two reads context recovery makes before it rebuilds a task: the latest user message it will
 * replay, and the latest rebuild marker. The desktop and the Node Host share them, so they live in
 * a module without Electron; these cases pin the rows each one picks and how it parses them.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../schema';
import { UI_ACTION_TRIGGER_PREFIX } from '../../../shared/interruptedTurn.js';

const h = vi.hoisted(() => ({
  client: null as { drizzle: unknown } | null,
}));

vi.mock('../client/current', () => ({ getDbClient: () => h.client }));

import { findLatestContextRebuildMeta, findLatestUserMessageForRebuild } from '../contextRebuildQueries';

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cleared_at INTEGER);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, tool_use_id TEXT, agent_meta TEXT, created_at INTEGER NOT NULL, rewind_at INTEGER
    );
  `);
  sqlite.prepare("INSERT INTO sessions (id, cleared_at) VALUES ('s1', NULL), ('s2', NULL)").run();
  h.client = { drizzle: drizzle(sqlite, { schema: { messages, sessions } }) };
});
afterEach(() => sqlite.close());

let nextId = 0;
function row(r: { session?: string; role: string; content: string; createdAt: number; clientId?: string; agentMeta?: string; toolUseId?: string; rewindAt?: number }): void {
  nextId += 1;
  sqlite.prepare(`INSERT INTO messages (id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`m${nextId}`, r.clientId ?? `c${nextId}`, r.session ?? 's1', r.role, r.content,
    r.toolUseId ?? null, r.agentMeta ?? null, r.createdAt, r.rewindAt ?? null);
}
const marker = (fields: Record<string, unknown>) => JSON.stringify({ handoff: 'h', consumed: false, ...fields });

describe('findLatestContextRebuildMeta', () => {
  it('reads the latest marker of the task, later inserts winning a tie', async () => {
    expect(await findLatestContextRebuildMeta('s1')).toBeNull();
    row({ role: 'context_rebuild', content: marker({ reason: 'old' }), createdAt: 1 });
    row({ role: 'context_rebuild', content: marker({ reason: 'tie-first' }), createdAt: 5 });
    row({ role: 'context_rebuild', content: marker({ reason: 'tie-second' }), createdAt: 5 });
    row({ role: 'context_rebuild', content: marker({ reason: 'other task' }), createdAt: 9, session: 's2' });
    row({ role: 'user', content: marker({ reason: 'not a marker' }), createdAt: 9 });
    expect(await findLatestContextRebuildMeta('s1')).toEqual({ reason: 'tie-second', sourceUserClientId: null });
  });

  it('keeps only fields of the expected types', async () => {
    row({ role: 'context_rebuild', content: marker({
      reason: 'context-overflow', sourceUserClientId: 'u1', sourceAgentKind: 'codex', sourceModel: 'gpt', sourceProviderId: 'p',
    }), createdAt: 1 });
    expect(await findLatestContextRebuildMeta('s1')).toEqual({
      reason: 'context-overflow', sourceUserClientId: 'u1', sourceAgentKind: 'codex', sourceModel: 'gpt', sourceProviderId: 'p',
    });
    row({ role: 'context_rebuild', content: marker({
      reason: 3, sourceUserClientId: 7, sourceAgentKind: 'gemini', sourceModel: null, sourceProviderId: null,
    }), createdAt: 2 });
    expect(await findLatestContextRebuildMeta('s1')).toEqual({ reason: undefined, sourceUserClientId: null });
  });

  it('reads nothing from a marker that is not JSON', async () => {
    row({ role: 'context_rebuild', content: marker({ reason: 'earlier' }), createdAt: 1 });
    row({ role: 'context_rebuild', content: 'not json', createdAt: 2 });
    expect(await findLatestContextRebuildMeta('s1')).toBeNull();
  });
});

describe('findLatestUserMessageForRebuild', () => {
  it('picks the latest user message that is not rewound, not before the clear and not a synthetic trigger', async () => {
    row({ role: 'user', content: JSON.stringify({ text: 'before clear' }), createdAt: 10 });
    row({ role: 'user', content: JSON.stringify({ text: 'wanted' }), createdAt: 20, clientId: 'want',
      agentMeta: JSON.stringify({ source: 'x' }), toolUseId: 't1' });
    row({ role: 'user', content: JSON.stringify({ text: 'earlier' }), createdAt: 19 });
    row({ role: 'assistant', content: JSON.stringify({ text: 'reply' }), createdAt: 30 });
    row({ role: 'user', content: JSON.stringify({ text: 'rewound' }), createdAt: 40, rewindAt: 41 });
    row({ role: 'user', content: JSON.stringify({ text: `${UI_ACTION_TRIGGER_PREFIX} continue` }), createdAt: 50 });
    row({ role: 'user', content: `${UI_ACTION_TRIGGER_PREFIX} raw`, createdAt: 60 });
    row({ role: 'user', content: JSON.stringify({ text: 'other task' }), createdAt: 70, session: 's2' });
    sqlite.prepare("UPDATE sessions SET cleared_at = 10 WHERE id = 's1'").run();
    expect(await findLatestUserMessageForRebuild('s1')).toEqual({
      clientId: 'want', role: 'user', content: { text: 'wanted' }, createdAt: 20, agentMeta: { source: 'x' }, toolUseId: 't1',
    });
  });

  it('breaks a time tie by the later insert', async () => {
    row({ role: 'user', content: JSON.stringify({ text: 'first' }), createdAt: 5, clientId: 'first' });
    row({ role: 'user', content: JSON.stringify({ text: 'second' }), createdAt: 5, clientId: 'second' });
    expect(await findLatestUserMessageForRebuild('s1')).toMatchObject({ clientId: 'second' });
  });

  it('keeps content that is not JSON as text and drops metadata that is not an object', async () => {
    row({ role: 'user', content: 'plain words', createdAt: 1, agentMeta: '[1]' });
    expect(await findLatestUserMessageForRebuild('s1')).toEqual({
      clientId: expect.any(String), role: 'user', content: 'plain words', createdAt: 1, agentMeta: null, toolUseId: null,
    });
    row({ role: 'user', content: JSON.stringify(['array']), createdAt: 2, agentMeta: 'not json' });
    expect(await findLatestUserMessageForRebuild('s1')).toMatchObject({ content: ['array'], agentMeta: null });
  });

  it('looks only at the latest 30 user messages', async () => {
    row({ role: 'user', content: JSON.stringify({ text: 'too old' }), createdAt: 1 });
    for (let i = 0; i < 30; i += 1) row({ role: 'user', content: `${UI_ACTION_TRIGGER_PREFIX} ${i}`, createdAt: 10 + i });
    expect(await findLatestUserMessageForRebuild('s1')).toBeNull();
  });
});
