import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { messages, sessions } from '../../localDb/schema';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: state.db }) }));

import { createTurnModelAttribution } from '../turnModelAttribution';

// The send transaction's turn-model attribution, shared by the desktop and the Node Host: a
// dispatched user turn records the model that ran it; when the previous turn of the same engine
// ran another model, one model-change card follows; an owner change records nothing.
describe('turn model attribution', () => {
  function fixture() {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cleared_at INTEGER);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, agent_meta TEXT, created_at INTEGER NOT NULL, rewind_at INTEGER
      );
    `);
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    const insert = sqlite.prepare('INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('m1', 'first', 's1', 'user', 'hello', JSON.stringify({ executionModel: { agentKind: 'codex', model: 'gpt-a', providerId: 'p' } }), 1);
    insert.run('m2', 'second', 's1', 'user', 'again', null, 2);
    state.db = drizzle(sqlite, { schema: { messages, sessions } });
    let current = true;
    const patches: unknown[] = [];
    const cards: unknown[] = [];
    const writes: Promise<void>[] = [];
    const attribute = createTurnModelAttribution({
      maker: { getSession: () => ({ agentKind: 'codex', model: 'gpt-b' }) },
      getSessionProvider: () => 'p',
      captureDataOwnerBroadcastScope: () => 'owner',
      isDataOwnerBroadcastScopeCurrent: () => current,
      enqueueDurableWrite: (_label, write) => { const done = write(); writes.push(done); return done; },
      patchMessageAgentMeta: async (_sessionId, clientId, patch) => { patches.push({ clientId, ...patch }); return true; },
      createDbMessage: async (_sessionId, body) => { cards.push(body); },
      log: { warn: vi.fn() },
    });
    return { attribute, patches, cards, settle: () => Promise.all(writes), changeOwner: () => { current = false; } };
  }

  it('records the model and publishes one change card when the model changed', async () => {
    const f = fixture();
    f.attribute('s1', 'second');
    await f.settle();
    expect(f.patches).toEqual([{ clientId: 'second', executionModel: { agentKind: 'codex', model: 'gpt-b', providerId: 'p' } }]);
    expect(f.cards).toEqual([expect.objectContaining({
      clientId: 'model-change:second', role: 'assistant', agentKind: 'codex',
      agentMeta: { modelChange: { fromModel: 'gpt-a', toModel: 'gpt-b', modelOnly: true } },
    })]);
  });

  it('records nothing once the data owner changed', async () => {
    const f = fixture();
    f.changeOwner();
    f.attribute('s1', 'second');
    await f.settle();
    expect(f.patches).toEqual([]);
    expect(f.cards).toEqual([]);
  });
});
