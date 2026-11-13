import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { botProfiles, botSessionLinks, sessions } from '../../localDb/schema.js';
import type { TeammateCallerResult } from '../botTaskCreation.js';

// Exercise the real identity and creation queries against SQLite, without Electron startup.
// Extract exactly the named production declarations (PR #6813 broke a substring boundary once),
// so the caller and creator checks still execute. Tier: unit authority regression; real SQLite.
const source = readFileSync(new URL('../botTaskCreation.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('botTaskCreation.ts', source, ts.ScriptTarget.Latest, true);
function declarations(names: readonly string[]): string {
  return names.map((name) => {
    const declaration = parsed.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration) throw new Error(`Missing production function: ${name}`);
    return declaration.getText(parsed).replace(/^export\s+/, '');
  }).join('\n');
}
const js = ts.transpileModule(
  `${declarations(['resolveTeammateMainCaller', 'readWorkbenchTarget', 'resolveBotTaskCreator', 'captureBotCreatedTaskResponsibility'])};
  return { captureBotCreatedTaskResponsibility, resolveTeammateMainCaller };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function fixture(role: string) {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions(id TEXT, source TEXT, status TEXT, remote_host_id TEXT, orca_role TEXT);
    CREATE TABLE bot_profiles(id TEXT, status TEXT);
    CREATE TABLE bot_session_links(id TEXT, session_id TEXT, bot_id TEXT, role TEXT, archived_at INTEGER);
    INSERT INTO sessions VALUES ('caller','bot','active',NULL,NULL),('created','desktop','active',NULL,NULL),
      ('human','desktop','active',NULL,NULL),('remote','bot','active','host',NULL);
    INSERT INTO bot_profiles VALUES ('hihi','active');
  `);
  sqlite.prepare("INSERT INTO bot_session_links VALUES ('link', ?, ?, ?, NULL)").run('caller', 'hihi', role);
  sqlite.prepare("INSERT INTO bot_session_links VALUES ('remote-link', 'remote', 'hihi', 'canonical', NULL)").run();
  const save = vi.fn(async () => {});
  const broadcast = vi.fn();
  const remoteBroadcast = vi.fn();
  const deps = {
    getDbClient: () => ({ drizzle: drizzle(sqlite) }),
    and, eq, inArray, isNull, botProfiles, botSessionLinks, sessions,
    isAppSessionBoundaryPending: () => false,
    activeOwnerScopeKey: () => 'synthetic-owner',
    ownerScopedUserDataPath: () => '/synthetic-owner-home',
    setTaskResponsibility: save,
    broadcastBotLinkedProjectsChanged: broadcast,
    broadcastBotRemoteResourceChanged: remoteBroadcast,
  };
  const api = new Function(...Object.keys(deps), js)(...Object.values(deps)) as {
    captureBotCreatedTaskResponsibility(id: string): Promise<null | ((id: string) => Promise<void>)>;
    resolveTeammateMainCaller(id: string): Promise<TeammateCallerResult>;
  };
  return { sqlite, save, broadcast, remoteBroadcast, ...api };
}

it('derives caller identity only from an active local main-chat link', async () => {
  const f = fixture('canonical');
  try {
    expect(await f.resolveTeammateMainCaller('caller')).toEqual({ ok: true, botId: 'hihi' });
    expect(await f.resolveTeammateMainCaller('human')).toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
    expect(await f.resolveTeammateMainCaller('remote')).toMatchObject({ ok: false, errorCode: 'REMOTE_WORKBENCH_UNAVAILABLE' });
    f.sqlite.exec("UPDATE bot_session_links SET archived_at=1 WHERE session_id='caller'");
    expect(await f.resolveTeammateMainCaller('caller')).toMatchObject({ ok: false, errorCode: 'BOT_SESSION_INACTIVE' });
  } finally { f.sqlite.close(); }
});

// 生产入口: captureBotCreatedTaskResponsibility; 结果: 新任务保存伙伴归属并通知列表刷新。
// Bug: 飞书 channel / group 调用方被主任务检查误排除,任务标题旁缺伙伴头像。
// 最小失败输入: active Bot + active channel link + 新 desktop 任务。tier: unit,内存 SQLite。
it.each(['canonical', 'thread', 'channel', 'group'])(
  'records the creator of a fresh task from the active %s companion conversation', async (role) => {
    const f = fixture(role);
    try {
      const record = await f.captureBotCreatedTaskResponsibility('caller');
      expect(record).not.toBeNull();
      await record!('created');
      expect(f.save).toHaveBeenCalledWith('/synthetic-owner-home', 'hihi', 'created', true, expect.any(Function), { created: true });
      expect(f.broadcast).toHaveBeenCalledWith('hihi');
      // Phones re-read the roster's follow links, so the new task shows the teammate's mark there too.
      expect(f.remoteBroadcast).toHaveBeenCalledWith('hihi');
      // Teammate V2 (2026-11-08, no teammate-only gates): any lane of the teammate is the teammate;
      // changing its project links still needs the task's ordinary authorization.
      expect(await f.resolveTeammateMainCaller('caller')).toEqual({ ok: true, botId: 'hihi' });
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
  ['channel', "UPDATE bot_session_links SET archived_at=1 WHERE session_id='caller'"],
] as const)('does not claim creation from an ineligible caller (%s, %s)', async (role, update) => {
  const f = fixture(role);
  try {
    if (update) f.sqlite.exec(update);
    expect(await f.captureBotCreatedTaskResponsibility('caller')).toBeNull();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.broadcast).not.toHaveBeenCalled();
  } finally { f.sqlite.close(); }
});
