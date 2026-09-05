import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  catalogSessionForGrouping,
  quickSwitcherProjects,
  searchQuickSwitcher,
} from '../../../renderer/features/cc-agent/lib/quickSwitcher';

const h = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null }));
vi.mock('../client/current', () => ({ getDbClient: () => ({ drizzle: h.db }) }));
import { listQuickSwitcherCatalog } from '../quickSwitcher';

let sqlite: Database.Database;
afterEach(() => sqlite?.close());

describe('title catalogue database query', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, working_dir TEXT, workspace_kind TEXT, remote_host_id TEXT, agent_kind TEXT, status TEXT, source TEXT, orca_role TEXT, parent_session_id TEXT, pinned_at INTEGER, user_send_at INTEGER, updated_at INTEGER, created_at INTEGER);
      CREATE TABLE messages (session_id TEXT, rewind_at INTEGER);
      CREATE INDEX messages_session_id_idx ON messages(session_id);`);
    h.db = drizzle(sqlite);
  });

  it('paginates all visible history and excludes messages, deleted rows and workers', async () => {
    const insert = sqlite.prepare(
      'INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 270; i++)
      insert.run(
        String(i).padStart(3, '0'),
        `History ${i}`,
        '/repo',
        'project',
        null,
        'cc',
        i === 269 ? 'archived' : 'active',
        'desktop',
        null,
        null,
        null,
        null,
        i,
        i,
      );
    insert.run(
      'deleted',
      'Deleted',
      '/repo',
      'project',
      null,
      'cc',
      'deleted',
      'desktop',
      null,
      null,
      null,
      null,
      1,
      1,
    );
    insert.run(
      'worker',
      'Worker',
      '/repo',
      'project',
      null,
      'cc',
      'active',
      'desktop',
      'worker',
      null,
      null,
      null,
      1,
      1,
    );
    sqlite.prepare('INSERT INTO messages VALUES (?, NULL)').run('269');
    const first = await listQuickSwitcherCatalog(null);
    const second = await listQuickSwitcherCatalog(first.nextCursor);
    const third = await listQuickSwitcherCatalog(second.nextCursor);
    expect(first.sessions).toHaveLength(128);
    expect(second.sessions).toHaveLength(128);
    expect(third.sessions).toHaveLength(14);
    expect(third.nextCursor).toBeNull();
    expect(third.sessions.at(-1)).toMatchObject({
      id: '269',
      status: 'archived',
      _count: { messages: 1 },
    });
    expect(first.sessions[0]._count.messages).toBe(0);
    expect(first.sessions[0]).not.toHaveProperty('preview');
  });

  it.each(['desktop', 'shared'])(
    'finds a %s project by name when userSendAt is null and all its messages are rewound',
    async (source) => {
      const insertSession = sqlite.prepare(
        'INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const id of ['draft', 'live', 'rewound', 'mixed']) {
        // These logical project paths are grouping inputs, never host filesystem paths.
        insertSession.run(
          id,
          'History',
          `/projects/${id}`,
          'project',
          null,
          'cc',
          'active',
          source,
          null,
          null,
          null,
          null,
          1,
          1,
        );
      }
      const insertMessage = sqlite.prepare('INSERT INTO messages VALUES (?, ?)');
      insertMessage.run('live', null);
      insertMessage.run('rewound', 2);
      insertMessage.run('mixed', null);
      insertMessage.run('mixed', 2);

      const page = await listQuickSwitcherCatalog(null);
      const sessions = page.sessions.map(catalogSessionForGrouping);
      const projects = quickSwitcherProjects(sessions, new Map(), [], process.platform);
      const result = searchQuickSwitcher({
        query: 'rewound',
        sessions,
        projects,
        hiddenProjectKeys: new Set(),
        platform: process.platform,
        unnamedLabel: 'Untitled',
      });
      expect(result.total).toBe(1);
      expect(result.results[0]).toMatchObject({
        kind: 'project',
        project: { workingDir: '/projects/rewound', sessions: [{ id: 'rewound' }] },
      });
      expect(page.sessions.map((session) => [session.id, session._count.messages])).toEqual([
        ['draft', 0],
        ['live', 1],
        ['mixed', 1],
        ['rewound', 1],
      ]);
      expect(projects.map((project) => project.workingDir)).not.toContain('/projects/draft');
    },
  );
});
