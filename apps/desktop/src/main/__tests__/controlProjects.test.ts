/**
 * /ctr session picker invariants.
 *
 * The picker is built in main process code, so keep the regression check close
 * to the query source: Orca worker sessions must not be attachable from Feishu.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  rows: [] as Array<{
    id?: string;
    title?: string;
    workingDir: string | null;
    userSendAt: number | null;
    updatedAt: number;
  }>,
}));

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: {
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
  listSessionsForWorkspace,
} from '../im/shared/controlProjects';

const source = readFileSync(
  resolve(__dirname, '..', 'im', 'shared', 'controlProjects.ts'),
  'utf8',
);

describe('/ctr control project/session picker', () => {
  beforeEach(() => {
    dbMock.rows = [];
  });

  it('filters Orca worker sessions from attachable /ctr session lists', () => {
    expect(source).toContain("ne(sessions.orcaRole, 'worker')");
    expect(source).toContain('isNull(sessions.orcaRole)');
    // 4 = 定义 + 3 个 attachable 查询(listProjectsForControl /
    // listRecentSessionsForPicker / listSessionsForWorkspace)都必须带该谓词。
    expect(source.match(/attachableSessionPredicate\(\)/g)).toHaveLength(4);
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
