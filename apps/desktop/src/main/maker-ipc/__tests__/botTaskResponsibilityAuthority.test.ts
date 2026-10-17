import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { botDelegations, botProfiles, botSessionLinks, sessions } from '../../localDb/schema.js';

// Exercise the real authority queries against SQLite, without Electron startup.
const source = readFileSync(new URL('../botWorkbenchTools.ts', import.meta.url), 'utf8');
function bind(name: string, end: string, db: ReturnType<typeof drizzle>) {
  const start = source.indexOf(`async function ${name}`);
  const chunk = source.slice(start, source.indexOf(end, start));
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
    const resolve = bind('resolveWorkbenchCaller', 'async function readWorkbenchTarget', db);
    const creations = bind('listBotDelegationChildren', '/** Exact responsibility IDs', db);
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
