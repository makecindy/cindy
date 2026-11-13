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
  setControlProjectCatalogSource,
} from '../im/shared/controlProjects';
import { listWorkLouderCodexTaskCatalog } from '../worklouder-codex/taskSlots';

describe('/ctr control project/session picker', () => {
  beforeEach(() => {
    dbMock.rows = [];
    dbMock.drizzle = null;
    setControlProjectCatalogSource(null);
  });

  // 规则(2026-11-13): 个人机器人 /ctr 与 /project 列的项目就是侧栏的本机项目。生产入口
  // listProjectsForControl(宿主注入侧栏项目)。此前清单只按活跃任务的目录分组: 没有任务的
  // 项目不出现, 侧栏里移除的项目还在, 名字也不跟侧栏。最小输入: 一个改过名且有任务的项目、
  // 一个没有任务的项目、一个已移除但仍有任务的项目、一条不在任何项目里的对话任务。
  it('lists the sidebar projects with their sidebar names, without removed ones', async () => {
    dbMock.rows = [
      { id: 'a', title: 'A', workingDir: '/code/cindy', userSendAt: 5_000, updatedAt: 1 },
      { id: 'b', title: 'B', workingDir: '/code/removed', userSendAt: 9_000, updatedAt: 1 },
      {
        id: '30c1ae07-5508-4c2e-9f1a-1234567890ab',
        title: '聊聊周报',
        workingDir: '/data/dialogues/2026-06-03/30c1ae07-5508-4c2e-9f1a-1234567890ab',
        userSendAt: 7_000,
        updatedAt: 1,
      },
    ];
    setControlProjectCatalogSource(async () => ({
      projects: [
        { path: '/code/cindy', name: '主仓库', lastUsedAtMs: 5_000 },
        { path: '/code/empty', name: 'empty', lastUsedAtMs: 6_000 },
      ],
      isRemoved: (directory) => directory === '/code/removed',
    }));

    // /ctr: 项目(含没有任务的) + 可接管的对话任务; 已移除的项目不在。
    expect((await listProjectsForControl()).map((row) => [row.displayName, row.workingDir])).toEqual([
      ['聊聊周报', '/data/dialogues/2026-06-03/30c1ae07-5508-4c2e-9f1a-1234567890ab'],
      ['empty', '/code/empty'],
      ['主仓库', '/code/cindy'],
    ]);
    // /project: 只列项目。
    expect(
      (await listProjectsForControl({ projectsOnly: true })).map((row) => row.displayName),
    ).toEqual(['empty', '主仓库']);

    // PR #10291 review(第五轮): 侧栏里起了同一个名字的两个项目, 卡片上不能是两个一样的按钮。
    setControlProjectCatalogSource(async () => ({
      projects: [
        { path: '/work/a/api', name: '后端', lastUsedAtMs: 2 },
        { path: '/work/b/server', name: '后端', lastUsedAtMs: 1 },
      ],
      isRemoved: () => false,
    }));
    expect(
      (await listProjectsForControl({ projectsOnly: true })).map((row) => row.displayName),
    ).toEqual(['后端 · api', '后端 · server']);
    // 表情占两个 UTF-16 单元: 后缀要落在按钮文字的 30 单元截断之内, 否则两个按钮仍然一样。
    const emoji = '😀'.repeat(20);
    setControlProjectCatalogSource(async () => ({
      projects: [
        { path: '/work/a/api', name: emoji, lastUsedAtMs: 2 },
        { path: '/work/b/server', name: emoji, lastUsedAtMs: 1 },
      ],
      isRemoved: () => false,
    }));
    const labels = (await listProjectsForControl({ projectsOnly: true })).map((row) => row.displayName);
    expect(labels.every((label) => label.length <= 30)).toBe(true);
    expect(new Set(labels).size).toBe(2);
    // 截断点落在完整字符上: 不留下半个表情(孤立的代理项)。
    expect(labels.every((label) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(label))).toBe(true);

    // 只在第 30 个 UTF-16 单元之后才不同的两个名字, 截断后按钮一样, 同样要区分。
    const long = 'a-very-long-project-name-that-keeps-going';
    setControlProjectCatalogSource(async () => ({
      projects: [
        { path: '/work/a/api', name: `${long}-one`, lastUsedAtMs: 2 },
        { path: '/work/b/server', name: `${long}-two`, lastUsedAtMs: 1 },
      ],
      isRemoved: () => false,
    }));
    const longLabels = (await listProjectsForControl({ projectsOnly: true })).map((row) => row.displayName);
    expect(longLabels.every((label) => label.length <= 30)).toBe(true);
    expect(new Set(longLabels).size).toBe(2);

    // PR #10291 review: 上限只用于卡片展示; 按按钮标记找回项目时要能查到全部。
    setControlProjectCatalogSource(async () => ({
      projects: Array.from({ length: 25 }, (_, index) => ({
        path: `/code/p${index}`,
        name: `p${index}`,
        lastUsedAtMs: 100 - index,
      })),
      isRemoved: () => false,
    }));
    expect(await listProjectsForControl({ projectsOnly: true })).toHaveLength(19);
    expect(
      (await listProjectsForControl({ projectsOnly: true, all: true })).map((row) => row.displayName),
    ).toContain('p24');

    // 侧栏项目读不到时退回按活跃任务的目录分组(原行为)。
    setControlProjectCatalogSource(async () => null);
    expect((await listProjectsForControl()).map((row) => row.workingDir)).toContain('/code/removed');
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
