/**
 * sessionRepoWorkspaceKind.test.ts
 * ---------------------------------------------------------------------------
 * `/project` 把 IM 会话切到项目目录后, 这条行的 `workspaceKind='project'` 是
 * **用户的显式选择**。它归档后被新消息复活(或撞上 createSession 的 upsert
 * 冲突分支)时, 渠道声明的默认归属曾经无条件盖回 'dialogue' —— 于是:
 *   - sidebar 里会话跳出项目分组, 而 workingDir 仍指着那个项目;
 *   - 两个 bot 的 `/project`、`/settings` 把真项目报成「对话」。
 *
 * 这里跑的是**真 SQLite**, 不是能接住任何写法的假 db: 修复用的是一条
 * `case when ... end` SET 表达式(避免读改写的并发覆盖), 而 CASE 里引用
 * `sessions.working_dir` 在 `ON CONFLICT DO UPDATE` 的 SET 子句里到底指哪一行,
 * 只有真 SQLite 答得准。表结构由 `getTableConfig(sessions)` 从生产 schema
 * 现推, 不手抄 —— 手抄的列会跟着 schema 漂移, 测试照绿。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '/tmp/never-used-here' },
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  maskPath: (p: string) => p,
}));
vi.mock('../../../maker-host/session-provider-store', () => ({
  setSessionProvider: vi.fn(),
}));
vi.mock('../../defaultSessionSettings', () => ({
  getImDefaultEffortFor: vi.fn(() => 'high'),
  resolveImSessionDefaults: vi.fn(async () => ({
    agentKind: 'claude-code',
    model: 'claude-opus-4-8',
    effort: 'high',
    permissionMode: 'auto',
    fastMode: false,
    providerId: null,
  })),
}));

let db: ReturnType<typeof drizzle>;
vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => ({ drizzle: db }),
}));

const { sessions } = await import('../../../localDb/schema');
const { createImSessionRepo } = await import('../sessionRepo');
const { switchSessionWorkingDir } = await import('../sessionRepo');
import type { ImOrchestratorConfig, ImSessionNamespace } from '../types';

const MANAGED_DIR = '/tmp/im-working-dir/telegram-bot1';
const PROJECT_DIR = '/Users/chris/Code/Github/cindy';

const ns = {
  source: 'telegram',
  workspaceKind: 'dialogue',
  sessionIdFor: (bot: string, user: string) => `tg_${bot}_${user}`,
  defaultTitle: () => 'Telegram',
  ensureWorkingDir: () => MANAGED_DIR,
  extraInsertColumns: (bot: string, user: string) => ({ imBotContextId: bot, imUserId: user }),
} as unknown as ImSessionNamespace;

/** 从生产 schema 现推 CREATE TABLE —— 列跟着 schema 走, 不手抄。 */
function createTableSql(): string {
  const config = getTableConfig(sessions);
  const cols = config.columns.map((col) => {
    const parts = [`"${col.name}"`, col.getSQLType()];
    if (col.primary) parts.push('PRIMARY KEY');
    if (col.notNull) parts.push('NOT NULL');
    const dflt = col.default;
    if (dflt !== undefined && typeof dflt !== 'object') {
      parts.push(`DEFAULT ${typeof dflt === 'string' ? `'${dflt}'` : Number(dflt)}`);
    }
    return parts.join(' ');
  });
  return `CREATE TABLE "${config.name}" (${cols.join(', ')})`;
}

function repo() {
  return createImSessionRepo({ agentKind: 'claude-code' } as ImOrchestratorConfig, ns);
}

async function kindOf(id: string): Promise<string> {
  const rows = await db.select().from(sessions);
  return rows.find((r) => r.id === id)!.workspaceKind;
}

beforeEach(() => {
  const raw = new Database(':memory:');
  raw.exec(createTableSql());
  db = drizzle(raw);
});

describe('workspaceKind 在复活 / upsert 冲突时的归属', () => {
  it('`/project` 切出去的行复活后仍留在项目分组', async () => {
    const r = repo();
    const created = await r.createSession('bot1', 'u1');
    expect(await kindOf(created.id)).toBe('dialogue');

    // 用户 /project 切到真实项目目录
    await switchSessionWorkingDir(created.id, PROJECT_DIR, 'project');
    expect(await kindOf(created.id)).toBe('project');

    // 桌面端归档 → 用户从 Telegram 再发一条消息
    await db.update(sessions).set({ status: 'archived' });
    const revived = await r.findActiveSession('bot1', 'u1');

    expect(await kindOf(created.id)).toBe('project');
    // 返回值必须与库里一致 —— caller 拿它直接渲染 /project、/settings 的显示名
    expect(revived?.workspaceKind).toBe('project');
    expect(revived?.workingDir).toBe(PROJECT_DIR);
  });

  it('还留在托管目录里的老行, 复活时照旧被校正成渠道归属', async () => {
    const r = repo();
    const created = await r.createSession('bot1', 'u1');
    // 老版本留下的默认值
    await db.update(sessions).set({ workspaceKind: 'project', status: 'archived' });

    const revived = await r.findActiveSession('bot1', 'u1');

    expect(await kindOf(created.id)).toBe('dialogue');
    expect(revived?.workspaceKind).toBe('dialogue');
  });

  it('老版本刷坏的存量行(dialogue + 项目目录)读出来就是项目, 不用等归档', async () => {
    // 这批行是老版本的复活/upsert 无条件写 'dialogue' 留下的: workingDir 还在项目
    // 里, 归属却成了「对话」。只保护未来的复活救不了它们 —— 只要用户不再归档一次
    // 就永远显示成「对话」。只读路径按目录现算, 立刻自愈。
    const r = repo();
    const created = await r.createSession('bot1', 'u1');
    await db
      .update(sessions)
      .set({ workingDir: PROJECT_DIR, workspaceKind: 'dialogue' });

    expect((await r.peekSession('bot1', 'u1'))?.workspaceKind).toBe('project');
    expect((await r.findActiveSession('bot1', 'u1'))?.workspaceKind).toBe('project');
    // 这一行还是 active, 没走复活, 库里那一列仍是脏的 —— 下一次复活才落定。
    expect(await kindOf(created.id)).toBe('dialogue');
  });

  it('存量脏行下一次复活时把库里那一列也修好', async () => {
    const r = repo();
    const created = await r.createSession('bot1', 'u1');
    await db
      .update(sessions)
      .set({ workingDir: PROJECT_DIR, workspaceKind: 'dialogue', status: 'archived' });

    await r.findActiveSession('bot1', 'u1');

    // sidebar 的归组读的是这一列, 不修它会话就一直待在「对话」分组。
    expect(await kindOf(created.id)).toBe('project');
  });

  it('createSession 撞上残留行时同样不动用户选的项目归属', async () => {
    const r = repo();
    const created = await r.createSession('bot1', 'u1');
    await switchSessionWorkingDir(created.id, PROJECT_DIR, 'project');
    await db.update(sessions).set({ status: 'deleted' });

    // 并发首消息 / 桌面端软删后的重建都会走 onConflictDoUpdate 分支
    const again = await r.createSession('bot1', 'u1');

    expect(again.id).toBe(created.id);
    expect(await kindOf(created.id)).toBe('project');
    expect(again.workingDir).toBe(PROJECT_DIR);
  });
});
