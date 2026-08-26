/**
 * persistSessionTitleIfStillDraft / isUntitledSessionAwaitingAutoTitle —— 自动
 * 起名的落库出口与资格判定,用内存 sqlite 验证真实条件写语义。
 *
 * 核心不变量:写入只在当前标题等于期望值时生效(user rename wins),且返回值必须
 * 如实反映"库里现在是不是目标标题"——不能凭期望值想当然报成功(PR #510 review)。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as InstanceType<typeof import('better-sqlite3')> | null,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => ({ drizzle: h.db }),
  getCurrentDbClientUserId: () => 'test-user',
}));
vi.mock('../../dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));
vi.mock('../../../git-context/prRefsStore', () => ({
  recomputePrRefsForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../imageCacheStore', () => ({ removeSession: vi.fn(async () => undefined) }));
vi.mock('../recentWorkdirs', () => ({ upsertRecentWorkdir: vi.fn(async () => undefined) }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));
vi.mock('../../agentIslandSessionPatch', () => ({ notifyAgentIslandSessionPatch: vi.fn() }));
vi.mock('../../../messagePersistBroadcaster', () => ({ noteSessionClearBoundary: vi.fn() }));
vi.mock('../../../sessionIds', () => ({ resolveBusinessSessionId: (id: string) => id }));
vi.mock('../../../maker-host/claude-transcript-relocation.js', () => ({
  relocateClaudeTranscriptsForSessionMove: vi.fn(async () => ({ persistedSdkSessionId: null })),
}));

import {
  getOverwritableAutoTitle,
  isUntitledSessionAwaitingAutoTitle,
  persistSessionTitleIfStillDraft,
} from '../sessions';

const SESSION_ID = 's1';

function createDb(initialTitle: string): void {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Maker',
      working_dir TEXT,
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      effort TEXT NOT NULL DEFAULT 'high',
      permission_mode TEXT NOT NULL DEFAULT 'ask',
      status TEXT NOT NULL DEFAULT 'active',
      sdk_session_id TEXT,
      total_token_usage INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      total_cost_amount REAL NOT NULL DEFAULT 0,
      total_cost_currency TEXT,
      total_cost_is_approximate INTEGER NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0,
      fast_mode INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER,
      pinned_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      agent_kind TEXT NOT NULL DEFAULT 'cc',
      user_send_at INTEGER,
      parent_session_id TEXT,
      forked_at_message_id TEXT,
      worktree_path TEXT,
      source TEXT NOT NULL DEFAULT 'desktop',
      feishu_open_id TEXT,
      feishu_bot_app_id TEXT,
      used_project_context INTEGER NOT NULL DEFAULT 0,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      one_m INTEGER NOT NULL DEFAULT 0,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      orca_role TEXT,
      remote_host_id TEXT,
      codex_history_has_product_prompt INTEGER,
      im_bot_context_id TEXT,
      im_user_id TEXT,
      summary TEXT,
      provider_id TEXT,
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      active_turn_started_at INTEGER,
      active_turn_pid INTEGER,
      last_turn_ended_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
  `);
  sqlite
    .prepare(
      `INSERT INTO sessions (id, title, working_dir, workspace_kind, created_at, updated_at)
       VALUES (?, ?, '/proj', 'project', 1, 1)`,
    )
    .run(SESSION_ID, initialTitle);
  h.sqlite = sqlite;
  h.db = drizzle(sqlite, { schema: { messages, sessions } });
}

function currentTitle(): string {
  return (h.sqlite!.prepare('SELECT title FROM sessions WHERE id = ?').get(SESSION_ID) as {
    title: string;
  }).title;
}

// normalizeAutoTitle 的用例随实现搬到 packages/maker-shared/src/__tests__/sessionTitle.test.ts
// (main / renderer / mobile 共用同一份实现,单测跟着实现走)。

describe('persistSessionTitleIfStillDraft — 条件写', () => {
  beforeEach(() => createDb('New Maker'));

  it('标题仍是草稿占位时写入成功', async () => {
    expect(await persistSessionTitleIfStillDraft(SESSION_ID, '帮我排查登录失败')).toBe(true);
    expect(currentTitle()).toBe('帮我排查登录失败');
  });

  it('用户已手动改名 → 期望值不匹配,拒绝写入(user rename wins)', async () => {
    h.sqlite!.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('我自己起的名字', SESSION_ID);

    expect(await persistSessionTitleIfStillDraft(SESSION_ID, '帮我排查登录失败')).toBe(false);
    expect(currentTitle()).toBe('我自己起的名字');
  });

  it('用显式期望值覆盖上一次写的占位', async () => {
    await persistSessionTitleIfStillDraft(SESSION_ID, '帮我排查登录失败');

    expect(
      await persistSessionTitleIfStillDraft(SESSION_ID, '登录失败排查', '帮我排查登录失败'),
    ).toBe(true);
    expect(currentTitle()).toBe('登录失败排查');
  });

  it('目标值等于期望值且库里确实是它 → 无需写入,报成功', async () => {
    h.sqlite!.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('设计稿-v3.png', SESSION_ID);

    expect(
      await persistSessionTitleIfStillDraft(SESSION_ID, '设计稿-v3.png', '设计稿-v3.png'),
    ).toBe(true);
    expect(currentTitle()).toBe('设计稿-v3.png');
  });

  it('目标值等于期望值但期望值已过期 → 如实报失败,不谎称已写入', async () => {
    // 资格检查之后、写入之前用户手动改了名:期望值 '设计稿-v3.png' 已不是库里的值。
    h.sqlite!.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('我自己起的名字', SESSION_ID);

    expect(
      await persistSessionTitleIfStillDraft(SESSION_ID, '设计稿-v3.png', '设计稿-v3.png'),
    ).toBe(false);
    expect(currentTitle()).toBe('我自己起的名字');
  });

  it('空标题 / 写回默认占位一律拒绝', async () => {
    expect(await persistSessionTitleIfStillDraft(SESSION_ID, '   ')).toBe(false);
    expect(await persistSessionTitleIfStillDraft(SESSION_ID, 'New Maker')).toBe(false);
    expect(currentTitle()).toBe('New Maker');
  });

  it('写入前归一化:折叠空白并截断 40 字', async () => {
    await persistSessionTitleIfStillDraft(SESSION_ID, `  ${'排'.repeat(60)}  `);
    expect(currentTitle()).toBe('排'.repeat(40));
  });
});

describe('isUntitledSessionAwaitingAutoTitle — 资格', () => {
  it('标题仍是草稿占位 → 有资格(不看消息数与 userSendAt)', async () => {
    createDb('New Maker');
    h.sqlite!.prepare('UPDATE sessions SET user_send_at = 123 WHERE id = ?').run(SESSION_ID);
    h.sqlite!
      .prepare(
        `INSERT INTO messages (id, client_id, session_id, role, content, created_at)
         VALUES ('m1', 'c1', ?, 'user', '{}', 1)`,
      )
      .run(SESSION_ID);

    expect(await isUntitledSessionAwaitingAutoTitle(SESSION_ID)).toBe(true);
  });

  it('标题等于传入的合成占位 → 仍有资格(等用户打字后替换)', async () => {
    createDb('设计稿-v3.png');

    expect(await isUntitledSessionAwaitingAutoTitle(SESSION_ID, '设计稿-v3.png')).toBe(true);
    expect(await isUntitledSessionAwaitingAutoTitle(SESSION_ID)).toBe(false);
  });

  it('用户手动改过名 → 无资格', async () => {
    createDb('我自己起的名字');

    expect(await isUntitledSessionAwaitingAutoTitle(SESSION_ID, '设计稿-v3.png')).toBe(false);
  });

  it('会话不存在 → 无资格', async () => {
    createDb('New Maker');

    expect(await isUntitledSessionAwaitingAutoTitle('missing')).toBe(false);
  });

  it('fork 会话的 [Fork 占位仍有资格(带 parentSessionId)', async () => {
    createDb('[Fork] 源会话标题');
    h.sqlite!.prepare('UPDATE sessions SET parent_session_id = ? WHERE id = ?').run('src', SESSION_ID);

    expect(await isUntitledSessionAwaitingAutoTitle(SESSION_ID)).toBe(true);
  });

  it('没有 parentSessionId 的 "[Fork] ..." 是用户自己起的名,无资格', async () => {
    createDb('[Fork] 用户自己起的名字');

    expect(await isUntitledSessionAwaitingAutoTitle(SESSION_ID)).toBe(false);
  });
});

describe('getOverwritableAutoTitle — 覆写目标', () => {
  it('返回当前标题本身,而不是草稿默认值', async () => {
    // fork 与合成占位都不等于草稿默认;猜期望值会让条件写直接落空。
    createDb('[Fork] 源会话标题');
    h.sqlite!.prepare('UPDATE sessions SET parent_session_id = ? WHERE id = ?').run('src', SESSION_ID);
    expect(await getOverwritableAutoTitle(SESSION_ID)).toMatchObject({
      title: '[Fork] 源会话标题',
      isDefaultDraftTitle: false,
    });

    createDb('设计稿-v3.png');
    expect(await getOverwritableAutoTitle(SESSION_ID, '设计稿-v3.png')).toMatchObject({
      title: '设计稿-v3.png',
      isDefaultDraftTitle: false,
    });

    createDb('New Maker');
    expect(await getOverwritableAutoTitle(SESSION_ID)).toMatchObject({
      title: 'New Maker',
      isDefaultDraftTitle: true,
    });
  });

  it('带出 DB 权威 agentKind(调用方快照可能因 agent 切换而过期)', async () => {
    createDb('New Maker');
    expect((await getOverwritableAutoTitle(SESSION_ID))?.agentKind).toBe('claude-code');

    h.sqlite!.prepare('UPDATE sessions SET agent_kind = ? WHERE id = ?').run('codex', SESSION_ID);
    expect((await getOverwritableAutoTitle(SESSION_ID))?.agentKind).toBe('codex');

    h.sqlite!.prepare('UPDATE sessions SET agent_kind = ? WHERE id = ?').run('pi', SESSION_ID);
    expect((await getOverwritableAutoTitle(SESSION_ID))?.agentKind).toBe('pi');
  });

  it('用它当期望值就能覆写 fork 占位(端到端条件写)', async () => {
    createDb('[Fork] 源会话标题');
    h.sqlite!.prepare('UPDATE sessions SET parent_session_id = ? WHERE id = ?').run('src', SESSION_ID);

    const target = await getOverwritableAutoTitle(SESSION_ID);
    expect(
      await persistSessionTitleIfStillDraft(SESSION_ID, 'fork 后的第一句话', target!.title),
    ).toBe(true);
    expect(currentTitle()).toBe('fork 后的第一句话');
  });

  it('用户改过名 → null(调用方据此停止尝试)', async () => {
    createDb('我自己起的名字');

    expect(await getOverwritableAutoTitle(SESSION_ID, '设计稿-v3.png')).toBeNull();
  });
});
