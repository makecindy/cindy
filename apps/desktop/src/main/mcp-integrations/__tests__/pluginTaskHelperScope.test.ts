import { existsSync, mkdtempSync, promises as fs, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLiziMcpProviders, createXdtHelperMcpServer, type LiziMcpSessionContext } from '@cindy/mcps';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { botSessionLinks, sessions } from '../../localDb/schema.js';
import type { DbClient } from '../../localDb/client/DbClient.js';
import * as surfaces from '../helperSurface.js';

// Exercise the actual Desktop callback, including its account-boundary checks.
const source = readFileSync(new URL('../mcp-providers.ts', import.meta.url), 'utf8');
const begin = source.indexOf('      resolveSurface:');
const callback = source.slice(begin, source.indexOf('      sessionQueue:', begin));
const wired = ts.transpileModule(`return {${callback}}.resolveSurface;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, cleared_at INTEGER DEFAULT 0, status TEXT DEFAULT 'active', remote_host_id TEXT);
    CREATE TABLE messages(client_id TEXT, session_id TEXT, role TEXT, created_at INTEGER, agent_meta TEXT, rewind_at INTEGER);
    CREATE TABLE bot_session_links(session_id TEXT, bot_id TEXT, role TEXT, archived_at INTEGER);
    CREATE TABLE plugin_task_requests(id TEXT PRIMARY KEY, operation TEXT, payload TEXT);
    CREATE TABLE orca_teams(id TEXT PRIMARY KEY, lead_session_id TEXT, status TEXT);
    CREATE TABLE orca_workers(session_id TEXT PRIMARY KEY, team_id TEXT);
    INSERT INTO sessions(id,source) VALUES ('lead','plugin'),('worker','orca'),('legacy','plugin'),('user','user'),('bot','bot');
    INSERT INTO bot_session_links(session_id, bot_id) VALUES ('bot','b');
    INSERT INTO plugin_task_requests VALUES ('lead','create','{}');
    INSERT INTO orca_teams VALUES ('team','lead','completed');
    INSERT INTO orca_workers VALUES ('worker','team');`);
  const db = { drizzle: drizzle(sqlite), queryOne: async (sql: string, args: unknown[]) => sqlite.prepare(sql).get(...args) } as unknown as DbClient;
  let current: DbClient | undefined = db;
  let pending = false;
  let execution = { executing: false, input: null as null | { clientId: string; authoredText?: string; autoResume?: boolean; retrySourceClientId?: string; originKind?: string } };
  const deps = { ...surfaces, sessions, botSessionLinks, eq, tryGetDbClient: () => current,
    getSessionInputProvenance: () => execution,
    isAppSessionBoundaryPending: () => pending };
  const resolve = new Function(...Object.keys(deps), wired)(...Object.values(deps)) as
    (input: { sessionId: string }) => Promise<'default' | 'bot' | 'restricted'>;
  const searchStart = source.indexOf('      searchSessions:');
  const search = source.slice(searchStart, source.indexOf('      logger:', searchStart));
  const searchSessionsFn = vi.fn(async () => [{ sessionId: 'user', snippet: 'synthetic private message' }]);
  // Production routes through the Bot-scope variant; ordinary and plugin callers never widen.
  const searchDeps = { ...deps, searchSessionsWithBotScope: searchSessionsFn, botReadsAccountHistory: async () => false };
  const searchWired = ts.transpileModule(`return {${search}}.searchSessions;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const searchSessions = new Function(...Object.keys(searchDeps), searchWired)(...Object.values(searchDeps)) as
    (query: string, opts: { callerSessionId: string; sessionId?: string }) => Promise<unknown[]>;
  const accessSource = source.slice(source.indexOf('  const withAccountDataAccess ='), source.indexOf('  const providers ='));
  const accessJs = ts.transpileModule(`${accessSource}\nreturn withAccountDataAccess;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const withAccountDataAccess = new Function(...Object.keys(deps), accessJs)(...Object.values(deps));
  return { sqlite, db, resolve, searchSessions, searchSessionsFn, withAccountDataAccess, setCurrent: (next?: DbClient) => { current = next; },
    setExecution: (next: typeof execution) => { execution = next; },
    setPending: () => { pending = true; } };
}

it.each(['lead', 'worker'])('uses the ordinary surface for %s regardless of the creating plugin receipt', async sessionId => {
  const f = fixture();
  try {
    f.setExecution({ executing: true, input: { clientId: 'plugin-task:run' } });
    for (const payload of ['{}', '{bad', 'null', '[]', '{"ownershipRevoked":false}', '{"ownershipRevoked":true}']) {
      f.sqlite.prepare('UPDATE plugin_task_requests SET payload=?').run(payload);
      expect(await f.resolve({ sessionId })).toBe('default');
    }
    f.sqlite.exec('DROP TABLE plugin_task_requests');
    expect(await f.resolve({ sessionId })).toBe('default');
    f.setExecution({ executing: false, input: null });
    expect(await f.resolve({ sessionId })).toBe('default');
    expect(await f.resolve({ sessionId: 'legacy' })).toBe('default');
    expect(await f.resolve({ sessionId: 'user' })).toBe('default');
    expect(await f.resolve({ sessionId: 'bot' })).toBe('bot');
    f.sqlite.exec(`INSERT INTO bot_session_links(session_id, bot_id) VALUES ('lead','b')`);
    expect(await f.resolve({ sessionId })).toBe(sessionId === 'lead' ? 'bot' : 'default');
  } finally { f.sqlite.close(); }
});

it.each(['missing caller', 'missing DB', 'pending', 'switched after read'] as const)('fails closed: %s', async state => {
  const f = fixture();
  try {
    if (state === 'missing caller') f.sqlite.exec("DELETE FROM sessions WHERE id='lead'");
    if (state === 'missing DB') f.setCurrent();
    if (state === 'pending') f.setPending();
    if (state === 'switched after read') {
      const query = f.db.queryOne.bind(f.db);
      f.db.queryOne = async <T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined> => {
        const row = await query<T>(sql, params); f.setCurrent(); return row;
      };
    }
    expect(await f.resolve({ sessionId: 'lead' })).toBe('restricted');
  } finally { f.sqlite.close(); }
});

it.each(['codex', 'claude-code', 'pi'] as const)('keeps helper tools available after plugin revocation for %s', async agentKind => {
  const f = fixture();
  const history = { resolveSessionScope: vi.fn(async () => ({ ok: true as const, sessionIds: null })),
    listWorkdirs: vi.fn(), listSessions: vi.fn(async () => ({ ok: true as const, page: { items: [], nextCursor: null, hasMore: false } })),
    getMessages: vi.fn(), searchChatHistory: vi.fn() };
  const listSessionQueue = vi.fn(), sendToSession = vi.fn(), messageAgent = vi.fn();
  const server = createXdtHelperMcpServer({ resolveSurface: f.resolve, history,
    sessionQueue: { listSessionQueue, listSessionQueuedCounts: vi.fn() }, sendToSession,
    botMessaging: { messageAgent, checkMessage: vi.fn() } },
  { agentKind, workingDir: '/answer', sessionId: 'worker' });
  const client = new Client({ name: 'plugin-helper-scope', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  const payload = (result: Awaited<ReturnType<typeof client.callTool>>) => JSON.parse((result.content as Array<{ text: string }>)[0].text);
  try {
    expect(payload(await client.callTool({ name: 'list_tools', arguments: {} })).categories.length).toBeGreaterThan(0);
    expect(payload(await client.callTool({ name: 'call_tool', arguments: { name: 'list_sessions', args: {} } }))).toMatchObject({ ok: true });
    expect(history.listSessions).toHaveBeenCalledOnce();
    f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{"ownershipRevoked":true}'`);
    f.setExecution({ executing: true, input: { clientId: 'plugin-task:run' } });
    expect(payload(await client.callTool({ name: 'list_tools', arguments: {} })).categories.length).toBeGreaterThan(0);
    expect(payload(await client.callTool({ name: 'call_tool', arguments: { name: 'list_sessions', args: {} } }))).toMatchObject({ ok: true });
    expect(history.listSessions).toHaveBeenCalledTimes(2);
    f.sqlite.exec('DROP TABLE plugin_task_requests');
    expect(payload(await client.callTool({ name: 'call_tool', arguments: { name: 'list_sessions', args: {} } }))).toMatchObject({ ok: true });
  } finally { await client.close(); await server.close(); f.sqlite.close(); }
});

it.each(['lead', 'worker'].flatMap(sessionId => (['codex', 'claude-code', 'pi'] as const).flatMap(agentKind =>
  (['cindy_scheduler', 'cindy_slack', 'cindy_memory'] as const).map(name => ({ sessionId, agentKind, name })))))(
  'allows $sessionId through $agentKind $name regardless of plugin creation source', async ({ sessionId, agentKind, name }) => {
    const f = fixture();
    const privateData = [{ id: 'private', displayName: 'Synthetic private contact', prompt: 'Synthetic private schedule' }];
    const read = vi.fn(async () => privateData);
    const manager = vi.fn(() => ({ isEnabled: () => true, getStore: () => ({ list: async () => (await read()).map(item => ({ filename: 'private.md', frontmatter: { title: item.displayName } })) }) }));
    const scheduler = vi.fn(() => ({ list: read }));
    const getBridge = vi.fn(() => ({ availability: () => ({ bound: true, connected: true, serverSupportsTools: true }),
      callTool: async () => ({ ok: true, result: await read() }) }));
    const { withAccountDataAccess } = f;
    const providers = createLiziMcpProviders({ enabled: [name],
      memory: { getManager: manager, withAccountDataAccess, searchSessions: read },
      scheduler: { getScheduler: scheduler, withAccountDataAccess },
      slackHook: { getBridge, withAccountDataAccess },
    } as unknown as Parameters<typeof createLiziMcpProviders>[0]);
    const workingDir = mkdtempSync(join(tmpdir(), 'plugin-account-scope-'));
    let liveId = sessionId;
    const ctx: LiziMcpSessionContext = { agentKind, workingDir, memoryScopeKey: 'fixture', sessionId,
      ...(agentKind !== 'claude-code' ? { sessionId: undefined, getSessionContext: () => ({ agentKind, workingDir, memoryScopeKey: 'fixture', sessionId: liveId }) } : {}) };
    const config = await providers[0]!.toClaudeSdkConfig(ctx);
    const server = (config as { instance: ReturnType<typeof createXdtHelperMcpServer> }).instance;
    const client = new Client({ name: 'plugin-account-scope', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    const call = (spill = false) => client.callTool(name === 'cindy_slack'
      ? { name: 'slack_call_tool', arguments: { name: 'search', ...(spill ? { out_file: 'private.json' } : {}) } }
      : { name: 'call_tool', arguments: { name: name === 'cindy_memory' ? 'memory_list' : 'schedule_list', args: {} } });
    const denied = (result: unknown) => {
      expect(result).toMatchObject({ isError: true });
      expect(JSON.parse((result as {content:Array<{text:string}>}).content[0]!.text)).toMatchObject({ok:false,errorCode:'CAPABILITY_NOT_AVAILABLE'});
      expect(JSON.stringify(result)).not.toContain('Synthetic private');
    };
    try {
      const listed = await client.callTool({ name: name === 'cindy_slack' ? 'slack_list_tools' : 'list_tools', arguments: {} });
      expect(listed.isError).not.toBe(true);
      expect(JSON.stringify(await call())).toContain('Synthetic private');
      f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{"ownershipRevoked":true}'`);
      f.setExecution({ executing: true, input: { clientId: 'plugin-task:run' } });
      expect((await client.callTool({ name: name === 'cindy_slack' ? 'slack_list_tools' : 'list_tools', arguments: {} })).isError).not.toBe(true);
      expect(JSON.stringify(await call())).toContain('Synthetic private');
      f.setExecution({ executing: true, input: { clientId: 'new-human', authoredText: 'My own request' } });
      expect(JSON.stringify(await call())).toContain('Synthetic private');
      read.mockImplementationOnce(async () => { f.setCurrent(); return privateData; });
      denied(await call(true));
      expect(existsSync(join(workingDir, 'private.json'))).toBe(false);
      f.setCurrent(f.db);
      read.mockImplementationOnce(async () => { f.setExecution({ executing: true, input: { clientId: 'plugin-task:run' } }); return privateData; });
      expect(JSON.stringify(await call())).toContain('Synthetic private');
      f.setExecution({ executing: true, input: { clientId: 'new-human', authoredText: 'My own request' } });
      if (name === 'cindy_slack') {
        // A changed account during the spill must block the result.
        const mkdir = fs.mkdir.bind(fs);
        const spy = vi.spyOn(fs, 'mkdir').mockImplementation(async (...args) => {
          const result = await mkdir(...args);
          if (String(args[0]) === workingDir) f.setCurrent();
          return result;
        });
        try {
          denied(await call(true));
          expect(existsSync(join(workingDir, 'private.json'))).toBe(false);
        } finally { spy.mockRestore(); f.setCurrent(f.db); }
      }
      if (agentKind !== 'claude-code') {
        f.setExecution({ executing: true, input: { clientId: 'plugin-task:run' } });
        liveId = 'user';
        expect(JSON.stringify(await call())).toContain('Synthetic private');
        liveId = sessionId;
        expect(JSON.stringify(await call())).toContain('Synthetic private');
        f.setExecution({ executing: true, input: { clientId: 'new-human', authoredText: 'My own request' } });
      }
      f.setPending();
      denied(await call());
    } finally { await client.close(); await server.close(); f.sqlite.close(); rmSync(workingDir, { recursive: true, force: true }); }
  },
);
