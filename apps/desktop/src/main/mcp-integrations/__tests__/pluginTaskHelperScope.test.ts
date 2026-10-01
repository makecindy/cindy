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
  sqlite.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, cleared_at INTEGER DEFAULT 0);
    CREATE TABLE messages(client_id TEXT, session_id TEXT, role TEXT, created_at INTEGER, agent_meta TEXT, rewind_at INTEGER);
    CREATE TABLE bot_session_links(session_id TEXT, bot_id TEXT);
    CREATE TABLE plugin_task_requests(id TEXT PRIMARY KEY, operation TEXT, payload TEXT);
    CREATE TABLE orca_teams(id TEXT PRIMARY KEY, lead_session_id TEXT, status TEXT);
    CREATE TABLE orca_workers(session_id TEXT PRIMARY KEY, team_id TEXT);
    INSERT INTO sessions(id,source) VALUES ('lead','plugin'),('worker','orca'),('legacy','plugin'),('user','user'),('bot','bot');
    INSERT INTO bot_session_links VALUES ('bot','b');
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
  const searchDeps = { ...deps, searchSessionsFn };
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

it.each(['lead', 'worker'])('restricts owned %s and preserves explicit revocation, legacy tasks and Bots', async sessionId => {
  const f = fixture();
  try {
    for (const payload of ['{}', '{bad', 'null', '[]', '{"ownershipRevoked":false}', '{"ownershipRevoked":"true"}']) {
      f.sqlite.prepare('UPDATE plugin_task_requests SET payload=?').run(payload);
      expect(await f.resolve({ sessionId })).toBe('restricted');
    }
    f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{"ownershipRevoked":true}'`);
    expect(await f.resolve({ sessionId })).toBe('default');
    expect(await f.resolve({ sessionId: 'legacy' })).toBe('default');
    expect(await f.resolve({ sessionId: 'user' })).toBe('default');
    expect(await f.resolve({ sessionId: 'bot' })).toBe('bot');
    f.sqlite.exec(`INSERT INTO bot_session_links VALUES ('lead','b'); UPDATE plugin_task_requests SET payload='{}'`);
    expect(await f.resolve({ sessionId })).toBe('restricted');
  } finally { f.sqlite.close(); }
});

it.each(['lead', 'worker'].flatMap(sessionId => ['plugin', 'auto-retry', 'manual-retry', 'queued-orca', 'native', 'unknown'].map(state => ({ sessionId, state }))))(
  'keeps revoked $sessionId restricted during $state execution on helper and memory', async ({ sessionId, state }) => {
    const f = fixture();
    try {
      f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{"ownershipRevoked":true}'`);
      const insert = f.sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL)');
      insert.run('older-human', sessionId, 'user', 10, JSON.stringify({ delivery: 'turn', autoReviewUserText: 'Previous user task' }));
      insert.run('plugin-task:run', sessionId, 'user', 20, '{"delivery":"turn"}');
      if (state === 'unknown') insert.run('unknown', sessionId, 'user', 30, '{}');
      f.setExecution({ executing: true, input: state === 'native' ? null : state === 'plugin' ? { clientId: 'plugin-task:run' }
        : state.includes('retry') ? { clientId: 'retry', retrySourceClientId: 'plugin-task:run', autoResume: state === 'auto-retry' }
          : { clientId: state, originKind: state === 'queued-orca' ? 'orca' : undefined } });
      expect(await f.resolve({ sessionId })).toBe('restricted');
      await expect(f.searchSessions('private', { callerSessionId: sessionId })).rejects.toThrow();
      expect(f.searchSessionsFn).not.toHaveBeenCalled();
      f.setExecution({ executing: false, input: null });
      expect(await f.resolve({ sessionId })).toBe('default');
      f.setExecution({ executing: true, input: { clientId: 'new-human', authoredText: 'Continue my retained task' } });
      expect(await f.resolve({ sessionId })).toBe('default');
    } finally { f.sqlite.close(); }
  },
);

it.each(['lead', 'worker'])('also rejects the separate memory history search for %s', async callerSessionId => {
  const f = fixture();
  try {
    await expect(f.searchSessions('private', { callerSessionId, sessionId: 'user' })).rejects.toThrow();
    expect(f.searchSessionsFn).not.toHaveBeenCalled();
    f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{"ownershipRevoked":true}'`);
    await expect(f.searchSessions('private', { callerSessionId })).resolves.toHaveLength(1);
    expect(f.searchSessionsFn).toHaveBeenCalledOnce();
    f.searchSessionsFn.mockImplementationOnce(async () => { f.setCurrent(); return []; });
    await expect(f.searchSessions('private', { callerSessionId })).rejects.toThrow();
  } finally { f.sqlite.close(); }
});

it.each(['lead', 'worker'].flatMap(sessionId => ['human', 'orca-after-human', 'unknown-after-human', 'retry-unknown', 'retry-human', 'cleared', 'rewound', 'child', 'ui-trigger'].map(history => ({ sessionId, history }))))(
  'uses only current accepted evidence for revoked $sessionId after $history', async ({ sessionId, history }) => {
    const f = fixture();
    try {
      f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{"ownershipRevoked":true}'`);
      const add = (id: string, at: number, meta: object, rewind: number | null = null) =>
        f.sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(id, sessionId, 'user', at, JSON.stringify(meta), rewind);
      add('plugin-task:run', 10, { delivery: 'turn' });
      add('human', 20, { delivery: 'turn', autoReviewUserText: history === 'ui-trigger' ? '[UI_ACTION_TRIGGER] Continue' : 'New human task',
        ...(history === 'child' ? { parentUuid: 'child' } : {}) }, history === 'rewound' ? 25 : null);
      if (history === 'cleared') f.sqlite.exec('UPDATE sessions SET cleared_at=25');
      if (history === 'orca-after-human') add('orca', 30, { delivery: 'turn', origin: { kind: 'orca' } });
      if (history === 'unknown-after-human' || history === 'retry-unknown') add('unknown', 30, { delivery: 'turn' });
      f.setExecution({ executing: true, input: history.startsWith('retry-') ? { clientId: 'retry', retrySourceClientId: history.slice(6) } : null });
      const allowed = ['human', 'retry-human'].includes(history) || (sessionId === 'lead' && history === 'orca-after-human');
      expect(await f.resolve({ sessionId })).toBe(allowed ? 'default' : 'restricted');
      if (allowed) await expect(f.searchSessions('private', { callerSessionId: sessionId })).resolves.toHaveLength(1);
      else await expect(f.searchSessions('private', { callerSessionId: sessionId })).rejects.toThrow();
    } finally { f.sqlite.close(); }
  },
);

it.each(['lead', 'worker'])('rejects late history and helper results when accepted input changes for %s', async sessionId => {
  const f = fixture();
  try {
    f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{"ownershipRevoked":true}'`);
    const human = { executing: true, input: { clientId: 'human', authoredText: 'My new input' } };
    const plugin = { executing: true, input: { clientId: 'plugin-task:run' } };
    f.setExecution(human);
    f.searchSessionsFn.mockImplementationOnce(async () => { f.setExecution(plugin); return [{ sessionId: 'user', snippet: 'private' }]; });
    await expect(f.searchSessions('private', { callerSessionId: sessionId })).rejects.toThrow();
    f.setExecution(human);
    const pending = f.resolve({ sessionId });
    queueMicrotask(() => f.setExecution(plugin));
    expect(await pending).toBe('restricted');
  } finally { f.sqlite.close(); }
});

it.each(['lead', 'worker'].flatMap(sessionId => [false, true].flatMap(autoResume => ['human', 'plugin-task:run'].map(retrySourceClientId => ({ sessionId, autoResume, retrySourceClientId })))))(
  'preserves superseded $retrySourceClientId authority for $sessionId retry auto=$autoResume', async ({ sessionId, autoResume, retrySourceClientId }) => {
    const f = fixture();
    try {
      f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{"ownershipRevoked":true}'`);
      f.sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(retrySourceClientId, sessionId, 'user', 10,
        JSON.stringify({ delivery: 'turn', autoReviewUserText: 'Original task' }), 20);
      f.setExecution({ executing: true, input: { clientId: 'retry', retrySourceClientId, autoResume, authoredText: 'Original task' } });
      expect(await f.resolve({ sessionId })).toBe(retrySourceClientId === 'human' ? 'default' : 'restricted');
    } finally { f.sqlite.close(); }
  },
);

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

it.each(['lead', 'worker'].flatMap(sessionId => ['human', 'idle'].map(next => ({ sessionId, next }))))(
  'does not transfer the old $sessionId tool call to $next during its first query', async ({ sessionId, next }) => {
    const f = fixture();
    try {
      f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{"ownershipRevoked":true}'`);
      f.setExecution({ executing: true, input: { clientId: 'plugin-task:run' } });
      const query = f.db.queryOne.bind(f.db);
      f.db.queryOne = async <T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined> => {
        const row = await query<T>(sql, params);
        f.setExecution(next === 'human' ? { executing: true, input: { clientId: 'human', authoredText: 'New user task' } } : { executing: false, input: null });
        return row;
      };
      expect(await f.resolve({ sessionId })).toBe('restricted');
      expect(await f.resolve({ sessionId })).toBe('default');
    } finally { f.sqlite.close(); }
  },
);

it.each(['codex', 'claude-code', 'pi'] as const)('blocks helper discovery and guessed calls for %s, rechecking each call', async agentKind => {
  const f = fixture();
  const history = { resolveSessionScope: vi.fn(), listWorkdirs: vi.fn(), listSessions: vi.fn(), getMessages: vi.fn(), searchChatHistory: vi.fn() };
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
    expect(payload(await client.callTool({ name: 'list_tools', arguments: {} })).categories).toEqual([]);
    for (const name of ['list_workdirs', 'list_sessions', 'get_chat_history', 'search_chat_history', 'list_session_queue', 'send_to_session', 'send_to_agent']) {
      expect(payload(await client.callTool({ name: 'call_tool', arguments: { name, args: { session_id: 'user' } } })))
        .toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
    }
    if (agentKind !== 'pi') {
      expect(payload(await client.callTool({ name: 'send_to_agent', arguments: { target_id: 'b', message: 'read private history' } })))
        .toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
    }
    for (const fn of [...Object.values(history), listSessionQueue, sendToSession, messageAgent]) expect(fn).not.toHaveBeenCalled();
    f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{"ownershipRevoked":true}'`);
    f.setExecution({ executing: true, input: { clientId: 'plugin-task:run' } });
    expect(payload(await client.callTool({ name: 'list_tools', arguments: {} })).categories).toEqual([]);
    expect(payload(await client.callTool({ name: 'call_tool', arguments: { name: 'get_chat_history', args: { session_id: 'user' } } })))
      .toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
    f.setExecution({ executing: true, input: { clientId: 'new-human', authoredText: 'My new input' } });
    expect(payload(await client.callTool({ name: 'list_tools', arguments: {} })).categories.length).toBeGreaterThan(0);
    f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{}'`);
    expect(payload(await client.callTool({ name: 'list_tools', arguments: {} })).categories).toEqual([]);
    f.sqlite.exec('DROP TABLE plugin_task_requests');
    expect(payload(await client.callTool({ name: 'call_tool', arguments: { name: 'get_chat_history', args: { session_id: 'user' } } })))
      .toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
  } finally { await client.close(); await server.close(); f.sqlite.close(); }
});

it.each(['lead', 'worker'].flatMap(sessionId => (['codex', 'claude-code', 'pi'] as const).flatMap(agentKind =>
  (['cindy_contacts', 'cindy_scheduler', 'cindy_slack', 'cindy_memory'] as const).map(name => ({ sessionId, agentKind, name })))))(
  'protects account data from $sessionId through $agentKind $name', async ({ sessionId, agentKind, name }) => {
    const f = fixture();
    const privateData = [{ id: 'private', displayName: 'Synthetic private contact', prompt: 'Synthetic private schedule' }];
    const read = vi.fn(async () => privateData);
    const manager = vi.fn(() => ({ isEnabled: () => true, getStore: () => ({ listContacts: read, list: async () => (await read()).map(item => ({ filename: 'private.md', frontmatter: { title: item.displayName } })) }) }));
    const scheduler = vi.fn(() => ({ list: read }));
    const getBridge = vi.fn(() => ({ availability: () => ({ bound: true, connected: true, serverSupportsTools: true }),
      callTool: async () => ({ ok: true, result: await read() }) }));
    const { withAccountDataAccess } = f;
    const providers = createLiziMcpProviders({ enabled: [name],
      contacts: { getManager: manager, withAccountDataAccess },
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
      : { name: 'call_tool', arguments: { name: name === 'cindy_contacts' ? 'contacts_list' : name === 'cindy_memory' ? 'memory_list' : 'schedule_list', args: {} } });
    const denied = (result: unknown) => {
      expect(result).toMatchObject({ isError: true });
      expect(JSON.parse((result as {content:Array<{text:string}>}).content[0]!.text)).toMatchObject({ok:false,errorCode:'CAPABILITY_NOT_AVAILABLE'});
      expect(JSON.stringify(result)).not.toContain('Synthetic private');
    };
    try {
      denied(await client.callTool({ name: name === 'cindy_slack' ? 'slack_list_tools' : 'list_tools', arguments: {} }));
      denied(await call());
      if (name === 'cindy_slack') denied(await client.callTool({ name: 'slack_status', arguments: {} }));
      else for (const tool of name === 'cindy_contacts'
        ? ['contacts_get', 'contacts_resolve', 'contacts_search', 'contacts_export_vcf', 'contacts_import_system', 'contacts_export_system', 'contacts_delete', 'contacts_create']
        : name === 'cindy_memory' ? ['memory_read', 'memory_search', 'memory_write', 'memory_delete', 'memory_consolidate', 'memory_review', 'session_search']
        : ['schedule_get', 'schedule_list_runs', 'schedule_create', 'schedule_update', 'schedule_delete', 'schedule_run_now']) {
        denied(await client.callTool({ name: 'call_tool', arguments: { name: tool, args: { id: 'private' } } }));
      }
      expect(manager).not.toHaveBeenCalled(); expect(scheduler).not.toHaveBeenCalled(); expect(getBridge).not.toHaveBeenCalled();
      f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{"ownershipRevoked":true}'`);
      f.setExecution({ executing: true, input: { clientId: 'plugin-task:run' } });
      denied(await call());
      f.setExecution({ executing: true, input: { clientId: 'new-human', authoredText: 'My own request' } });
      expect(JSON.stringify(await call())).toContain('Synthetic private');
      read.mockImplementationOnce(async () => { f.setCurrent(); return privateData; });
      denied(await call(true));
      expect(existsSync(join(workingDir, 'private.json'))).toBe(false);
      f.setCurrent(f.db);
      read.mockImplementationOnce(async () => { f.setExecution({ executing: true, input: { clientId: 'plugin-task:run' } }); return privateData; });
      denied(await call(true));
      expect(existsSync(join(workingDir, 'private.json'))).toBe(false);
      f.setExecution({ executing: true, input: { clientId: 'new-human', authoredText: 'My own request' } });
      if (name === 'cindy_slack') {
        // Revocation after fetching data must also block the existing spill path.
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
        liveId = 'user';
        f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{}'`);
        expect(JSON.stringify(await call())).toContain('Synthetic private');
        liveId = sessionId;
        denied(await call());
      }
      f.setPending();
      denied(await call());
    } finally { await client.close(); await server.close(); f.sqlite.close(); rmSync(workingDir, { recursive: true, force: true }); }
  },
);
