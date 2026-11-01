/**
 * /ctr session picker invariants.
 *
 * The picker is built in main process code, so keep the regression check close
 * to the query source: Orca worker sessions must not be attachable from Feishu.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const dbMock = vi.hoisted(() => ({
  drizzle: null as ReturnType<typeof drizzle> | null,
  rows: [] as Array<{
    id?: string;
    title?: string;
    workingDir: string | null;
    projectDir?: string | null;
    userSendAt: number | null;
    updatedAt: number;
  }>,
}));

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: dbMock.drizzle ?? {
      select: () => ({
        from: () => ({
          where: () => {
            const query = Promise.resolve(dbMock.rows) as Promise<typeof dbMock.rows> & {
              orderBy: () => Promise<typeof dbMock.rows>;
            };
            query.orderBy = () => Promise.resolve(dbMock.rows);
            return query;
          },
        }),
      }),
    },
  }),
}));

import {
  listProjectsForControl,
  listRecentSessionsForPicker,
  listSessionsForWorkspace,
} from '../im/shared/controlProjects';
import { listWorkLouderCodexTaskCatalog } from '../worklouder-codex/taskSlots';

describe('/ctr control project/session picker', () => {
  beforeEach(() => {
    dbMock.rows = [];
    dbMock.drizzle = null;
  });

  it('keeps tasks running in checkouts under their selected project', async () => {
    dbMock.rows = [{ id: 'task', title: 'Task', workingDir: '/tmp/checkout', projectDir: '/project', userSendAt: 1, updatedAt: 1 }];
    expect((await listProjectsForControl()).map(row => row.workingDir)).toEqual(['/project']);
    expect((await listSessionsForWorkspace('/project')).map(row => row.id)).toEqual(['task']);
    expect(await listSessionsForWorkspace('/tmp/checkout')).toEqual([]);
  });

  // Unit, #6529: hidden follow-ups leaked into IM and keyboard task pickers.
  // The old query mock ignored WHERE; execute the production catalog queries
  // against in-memory SQLite instead. Minimal rows: ordinary + side-chat +
  // review + worker, with a follow-up-only directory to exercise project lists.
  it('keeps attached tasks and workers out of ordinary IM and keyboard catalogs', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, source TEXT,
        status TEXT, working_dir TEXT, project_dir TEXT, orca_role TEXT, user_send_at INTEGER,
        updated_at INTEGER, pinned_at INTEGER)`);
      const insert = sqlite.prepare('INSERT INTO sessions (id, title, source, status, working_dir, orca_role, user_send_at, updated_at, pinned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const [id, source, role, dir] of [
        ['main', 'desktop', null, '/workspace/main'],
        ['child', 'side-chat', null, '/workspace/main'],
        ['review', 'review', null, '/workspace/main'],
        ['worker', 'desktop', 'worker', '/workspace/main'],
        ['child-only-project', 'side-chat', null, '/workspace/follow-up'],
      ]) insert.run(id, id, source, 'active', dir, role, 1000, 1000, null);
      dbMock.drizzle = drizzle(sqlite);
      expect((await listProjectsForControl()).map(row => row.workingDir)).toEqual(['/workspace/main']);
      expect((await listRecentSessionsForPicker()).map(row => row.id)).toEqual(['main']);
      expect((await listSessionsForWorkspace('/workspace/main')).map(row => row.id)).toEqual(['main']);
      const keyboard = await listWorkLouderCodexTaskCatalog();
      for (const rows of [keyboard.sidebar, keyboard.lastSent, keyboard.options]) {
        expect(rows.map(row => row.id)).toEqual(['main']);
      }
    } finally {
      dbMock.drizzle = null;
      sqlite.close();
    }
  });

  it('groups worktree sessions with the base project for Feishu control', async () => {
    dbMock.rows = [
      {
        id: 'worktree-session',
        title: 'Worktree Session',
        workingDir: '\\\\?\\D:\\AI\\tl_web_agent\\.worktrees\\cx-20260526-104440',
        userSendAt: 2_000,
        updatedAt: 1_500,
      },
      {
        id: 'base-session',
        title: 'Base Session',
        workingDir: 'D:\\AI\\tl_web_agent',
        userSendAt: 1_000,
        updatedAt: 900,
      },
      {
        id: 'other-session',
        title: 'Other Session',
        workingDir: 'D:\\AI\\other_project',
        userSendAt: 500,
        updatedAt: 400,
      },
    ];

    const projects = await listProjectsForControl();

    expect(projects.filter((p) => p.workingDir === 'D:/AI/tl_web_agent')).toEqual([
      {
        workingDir: 'D:/AI/tl_web_agent',
        displayName: 'tl_web_agent',
        latestActivityMs: 2_000,
      },
    ]);

    const sessions = await listSessionsForWorkspace('D:/AI/tl_web_agent');
    expect(sessions.map((s) => s.id)).toEqual(['worktree-session', 'base-session']);
  });

  it('falls back to the session title when a dialogue workspace dir ends in a session UUID', async () => {
    dbMock.rows = [
      {
        id: '30c1ae07-5508-4c2e-9f1a-1234567890ab',
        title: '聊聊周报怎么写',
        workingDir:
          '/Users/me/Library/Application Support/xdt-maker/dialogues/2026-06-03/30c1ae07-5508-4c2e-9f1a-1234567890ab',
        userSendAt: 3_000,
        updatedAt: 2_900,
      },
    ];

    const projects = await listProjectsForControl();

    expect(projects).toEqual([
      {
        workingDir:
          '/Users/me/Library/Application Support/xdt-maker/dialogues/2026-06-03/30c1ae07-5508-4c2e-9f1a-1234567890ab',
        displayName: '聊聊周报怎么写',
        latestActivityMs: 3_000,
      },
    ]);
  });

  it('keeps the raw UUID basename when the dialogue session has a blank title', async () => {
    dbMock.rows = [
      {
        id: 'b1ffc8d2-0000-4aaa-bbbb-ccccddddeeee',
        title: '   ',
        workingDir:
          '/Users/me/Library/Application Support/xdt-maker/dialogues/2026-06-03/b1ffc8d2-0000-4aaa-bbbb-ccccddddeeee',
        userSendAt: 1_000,
        updatedAt: 900,
      },
    ];

    const projects = await listProjectsForControl();

    expect(projects).toEqual([
      {
        workingDir:
          '/Users/me/Library/Application Support/xdt-maker/dialogues/2026-06-03/b1ffc8d2-0000-4aaa-bbbb-ccccddddeeee',
        displayName: 'b1ffc8d2-0000-4aaa-bbbb-ccccddddeeee',
        latestActivityMs: 1_000,
      },
    ]);
  });
});
