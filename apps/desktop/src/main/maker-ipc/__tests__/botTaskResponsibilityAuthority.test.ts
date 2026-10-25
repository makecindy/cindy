import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { botDelegations, botProfiles, botSessionLinks, sessions } from '../../localDb/schema.js';

// Exercise the real authority queries against SQLite, without Electron startup.
// PR #6813 inserted another exported function between the queried functions, breaking
// the old substring boundary before any authority assertions ran. Extract exactly the
// named production declaration so the existing identity/ownership checks still execute.
// Minimum fixture: canonical, human, group and remote callers; two bots' delegation rows.
// Tier: existing unit authority regression; real SQLite, no new cases or app startup.
// Single-file run: 989ms; all original caller and delegation assertions retained.
const source = readFileSync(new URL('../botWorkbenchTools.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('botWorkbenchTools.ts', source, ts.ScriptTarget.Latest, true);
function bind(name: string, db: ReturnType<typeof drizzle>) {
  const declaration = parsed.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing production function: ${name}`);
  const chunk = declaration.getText(parsed).replace(/^export\s+/, '');
  const js = ts.transpileModule(`${chunk}; return ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const deps = { getDbClient: () => ({ drizzle: db }), and, desc, eq, isNotNull, botDelegations, botProfiles, botSessionLinks, sessions };
  return new Function(...Object.keys(deps), js)(...Object.values(deps));
}

it('derives caller identity from the active local canonical link and creation only from its own delegation rows', async () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(`CREATE TABLE sessions(id TEXT, source TEXT, status TEXT, remote_host_id TEXT);
      CREATE TABLE bot_profiles(id TEXT, status TEXT);
      CREATE TABLE bot_session_links(session_id TEXT, bot_id TEXT, role TEXT, archived_at INTEGER);
      CREATE TABLE bot_delegations(requesting_bot_id TEXT, child_session_id TEXT, status TEXT, last_error TEXT, created_at INTEGER);
      INSERT INTO sessions VALUES ('canonical','bot','active',NULL),('human','desktop','active',NULL),('group','bot','active',NULL),('remote','bot','active','host');
      INSERT INTO bot_profiles VALUES ('one','active'),('two','active');
      INSERT INTO bot_session_links VALUES ('canonical','one','canonical',NULL),('group','one','group',NULL),('remote','one','canonical',NULL);
      INSERT INTO bot_delegations VALUES ('one','own-across-directory','completed',NULL,1),('two','their-task','running',NULL,2),('one',NULL,'pending',NULL,3);`);
    const db = drizzle(sqlite);
    const resolve = bind('resolveWorkbenchCaller', db);
    const creations = bind('listBotDelegationChildren', db);
    expect(await resolve('canonical')).toEqual({ ok: true, botId: 'one' });
    expect(await resolve('human')).toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
    expect(await resolve('group')).toMatchObject({ ok: false, errorCode: 'BOT_MAIN_TASK_REQUIRED' });
    expect(await resolve('remote')).toMatchObject({ ok: false, errorCode: 'REMOTE_WORKBENCH_UNAVAILABLE' });
    expect([...(await creations('one')).keys()]).toEqual(['own-across-directory']);
    expect([...(await creations('two')).keys()]).toEqual(['their-task']);
    sqlite.exec("UPDATE bot_session_links SET archived_at=1 WHERE session_id='canonical'");
    expect(await resolve('canonical')).toMatchObject({ ok: false, errorCode: 'BOT_SESSION_INACTIVE' });
  } finally { sqlite.close(); }
});


// 生产入口: captureBotCreatedTaskResponsibility; 结果: 新任务保存伙伴归属并通知列表刷新。
// Bug: 飞书 channel / group 调用方被工作台权限检查误排除,任务标题旁缺伙伴头像。
// 现有覆盖只测 canonical 身份查询或 mock 掉整个调用方解析,没有覆盖专线创建链路。
// 最小失败输入: active Bot + active channel link + 新 desktop 任务。tier: unit,内存 SQLite。
const chunk = source.slice(source.indexOf('export async function resolveWorkbenchCaller'), source.indexOf('type Failure = {'));
const js = ts.transpileModule(
  `${chunk.replaceAll('export ', '')}; return { captureBotCreatedTaskResponsibility, resolveWorkbenchCaller };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function fixture(role: string) {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions(id TEXT, source TEXT, status TEXT, remote_host_id TEXT, orca_role TEXT);
    CREATE TABLE bot_profiles(id TEXT, status TEXT);
    CREATE TABLE bot_session_links(id TEXT, session_id TEXT, bot_id TEXT, role TEXT, archived_at INTEGER);
    CREATE TABLE bot_delegations(id TEXT, child_session_id TEXT);
    INSERT INTO sessions VALUES ('caller','bot','active',NULL,NULL),('created','desktop','active',NULL,NULL);
    INSERT INTO bot_profiles VALUES ('hihi','active');
  `);
  sqlite.prepare("INSERT INTO bot_session_links VALUES ('link', ?, ?, ?, NULL)").run('caller', 'hihi', role);
  const save = vi.fn(async () => {});
  const broadcast = vi.fn();
  const remoteBroadcast = vi.fn();
  const deps = {
    getDbClient: () => ({ drizzle: drizzle(sqlite) }),
    and, desc, eq, inArray, isNotNull, isNull, botDelegations, botProfiles, botSessionLinks, sessions,
    isAppSessionBoundaryPending: () => false,
    activeOwnerScopeKey: () => 'synthetic-owner',
    ownerScopedUserDataPath: () => '/synthetic-owner-home',
    setTaskResponsibility: save,
    broadcastBotWorkbenchChanged: broadcast,
    broadcastBotRemoteResourceChanged: remoteBroadcast,
  };
  const api = new Function(...Object.keys(deps), js)(...Object.values(deps)) as {
    captureBotCreatedTaskResponsibility(id: string): Promise<null | ((id: string) => Promise<void>)>;
    resolveWorkbenchCaller(id: string): Promise<{ ok: boolean; errorCode?: string }>;
  };
  return { sqlite, save, broadcast, remoteBroadcast, ...api };
}

it.each(['canonical', 'thread', 'channel', 'group'])(
  'records the creator of a fresh task from the active %s companion conversation', async (role) => {
    const f = fixture(role);
    try {
      const record = await f.captureBotCreatedTaskResponsibility('caller');
      expect(record).not.toBeNull();
      await record!('created');
      expect(f.save).toHaveBeenCalledWith('/synthetic-owner-home', 'hihi', 'created', true, expect.any(Function));
      expect(f.broadcast).toHaveBeenCalledWith('hihi');
      // Phones re-read the roster's follow links, so the new task shows the teammate's mark there too.
      expect(f.remoteBroadcast).toHaveBeenCalledWith('hihi');
      // Recognizing a creator must not grant a channel/group conversation workbench access.
      if (role === 'channel' || role === 'group') {
        expect(await f.resolveWorkbenchCaller('caller')).toMatchObject({ ok: false, errorCode: 'BOT_MAIN_TASK_REQUIRED' });
      }
    } finally { f.sqlite.close(); }
  },
);

it.each([
  ['history', ''],
  ['delegation', ''],
  ['channel', "UPDATE sessions SET source='desktop' WHERE id='caller'"],
  ['channel', "UPDATE sessions SET status='archived' WHERE id='caller'"],
  ['channel', "UPDATE sessions SET remote_host_id='ssh-host' WHERE id='caller'"],
  ['channel', "UPDATE bot_profiles SET status='paused'"],
  ['channel', 'UPDATE bot_session_links SET archived_at=1'],
] as const)('does not claim creation from an ineligible caller (%s, %s)', async (role, update) => {
  const f = fixture(role);
  try {
    if (update) f.sqlite.exec(update);
    expect(await f.captureBotCreatedTaskResponsibility('caller')).toBeNull();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.broadcast).not.toHaveBeenCalled();
  } finally { f.sqlite.close(); }
});
