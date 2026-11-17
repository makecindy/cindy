/**
 * #8478: inspect/commit a real share bundle, then read its persisted PR associations.
 * Existing share-import tests fake the DB; store tests bypass the import entry.
 * Minimal failure: a visible PR in a db-only bundle after v2 backfill is complete.
 * Tier: db (real SQLite transaction + public projection); separate from the unit
 * import suite so its filesystem/media matrix does not gain a database dependency.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../client/DbClient';
import { tx } from '../worker/opHandlers/tx';
import { messages, migrationMeta, orcaTeams, orcaWorkers, sessionPrRefs, sessions } from '../schema';
import { commitShareImport, inspectShareFile } from '../../session-share/sessionShareImport';
import { buildPlainFile } from '../../session-share/xdtshareCrypto';
import {
  ensurePrRefsBackfill, listPrRefs, managePrRefs, recordPrRefsForImportedMessages,
  setPrRefsChangedListener,
} from '../../git-context/prRefsStore';

const h = vi.hoisted(() => ({
  client: null as unknown,
  afterCommit: null as (() => void) | null,
  changed: vi.fn(),
}));
vi.mock('../client/current', () => ({
  getDbClient: () => h.client,
  getCurrentDbClientUserId: () => 'share-fixture',
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../maker-host/model-route-guard-live.js', () => ({
  resolveNewTaskDefaultModelRoute: async () => ({ model: 'fixture', providerId: null }),
}));
// This db-only fixture has no media, native transcripts or worktree operations.
vi.mock('../../maker-host/codex-local-sessions.js', () => ({ importSharedCodexThread: vi.fn(), removeSharedCodexThread: vi.fn() }));
vi.mock('../../worktree/WorktreeManager.js', () => ({ createWorktree: vi.fn(), detectCwd: vi.fn(), removeWorktreeForSession: vi.fn(), suggestName: vi.fn() }));
vi.mock('../../cindy-media/ingest.js', () => ({ ingestMedia: vi.fn() }));
vi.mock('../../cindy-media/ledger.js', () => ({ removeSessionRefs: vi.fn(), removeSessionRefsIfDeleted: vi.fn() }));
vi.mock('../../imageCacheStore.desktop.js', () => ({ getCacheRoot: vi.fn(), getSessionDir: vi.fn(), removeSession: vi.fn(), resolveSafe: vi.fn() }));
vi.mock('../../videoCacheStore.js', () => ({ resolveSafe: vi.fn() }));
vi.mock('../../modelCacheStore.js', () => ({ resolveSafe: vi.fn() }));
vi.mock('../dialogueWorkspace.js', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));

const root = mkdtempSync(path.join(os.tmpdir(), 'share-pr-refs-'));
const sqlite = new Database(':memory:');
const db = drizzle(sqlite);
for (const table of [sessions, messages, sessionPrRefs, migrationMeta, orcaTeams, orcaWorkers] as SQLiteTable[]) {
  const config = getTableConfig(table);
  sqlite.exec(`CREATE TABLE "${config.name}" (${config.columns.map(c => `"${c.name}" ${c.getSQLType()}${c.primary ? ' PRIMARY KEY' : ''}`).join(', ')})`);
}
sqlite.exec(
  'CREATE UNIQUE INDEX pr_identity ON session_pr_refs(session_id,provider,host,owner,repo,pr_number)',
);
sqlite.exec('CREATE UNIQUE INDEX message_identity ON messages(session_id,client_id)');
const client = {
  drizzle: db,
  query: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params),
  queryOne: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).get(...params),
  tx: async (name: string, args: unknown) => {
    const result = tx(sqlite, { name, args });
    h.afterCommit?.();
    return result;
  },
} as unknown as DbClient;
const assertStillValid = () => {
  if (h.client !== client) throw Object.assign(new Error('Account changed'), { code: 'PERMISSION_DENIED' });
};
const scope = {
  dbClient: client,
  assertStillValid,
  refCompensationScope: { journalDir: path.join(root, 'journal'), ownerStorageKey: 'a'.repeat(20), assertStillValid },
};
const url = (n: number) => `https://github.com/example/repo/pull/${n}`;
function row(n: number, overrides: Record<string, unknown> = {}) {
  return { id: `m${n}`, clientId: `c${n}`, role: 'assistant', content: JSON.stringify(url(n)),
    createdAt: 20, rewindAt: null, toolUseId: null, agentMeta: null, ...overrides };
}
const visibleAndHiddenRows = (base: number) => [
  row(base, { role: 'user' }), row(base + 1),
  row(base + 2, { createdAt: 10 }), // clear boundary
  row(base + 3, { rewindAt: 30 }),
  row(base + 4, { role: 'tool_result' }),
  row(base + 5, { agentMeta: JSON.stringify({ mcpApp: true }), content: JSON.stringify({ mcpApp: {
    version: 1, serverId: 'fixture', serverRevision: '1', resourceUri: 'ui://fixture/app',
    tool: { name: 'save', inputSchema: { type: 'object' } }, arguments: { secret: url(base + 6) },
    result: { content: [{ type: 'text', text: url(base + 5) }],
      structuredContent: { secret: url(base + 7) }, _meta: { secret: url(base + 8) } },
  } }) }),
];

async function bundle(brokenWorker = false) {
  const zip = new JSZip();
  const leadRows = visibleAndHiddenRows(100);
  const workerRows = visibleAndHiddenRows(200);
  if (brokenWorker) workerRows.push(workerRows[0]); // real UNIQUE failure after lead inserts
  zip.file('session.json', JSON.stringify({ clearedAt: 10 }));
  zip.file('messages.jsonl', leadRows.map(r => JSON.stringify(r)).join('\n'));
  zip.file('orca/workers/0/session.json', JSON.stringify({ clearedAt: 10 }));
  zip.file('orca/workers/0/messages.jsonl', workerRows.map(r => JSON.stringify(r)).join('\n'));
  zip.file('manifest.json', JSON.stringify({
    formatVersion: 2, minReaderVersion: 2, appVersion: '9.9.9', platform: 'darwin',
    exportedAt: '2026-11-03T00:00:00.000Z', agentKind: 'cc', title: 'PR import fixture',
    workspaceKind: 'project', originalWorkingDir: null, sdkSessionIds: [], activeSdkSessionId: null,
    exportFidelity: 'db-only', counts: { messages: leadRows.length, media: 0 }, entries: [], transcripts: [],
    orca: { teamStatus: 'active', workers: [{ index: 0, agentKind: 'cc', title: 'Worker', role: 'developer',
      label: 'fixture', status: 'done', focused: false, sdkSessionIds: [], activeSdkSessionId: null,
      counts: { messages: workerRows.length }, transcripts: [] }] },
  }));
  const file = path.join(root, 'fixture.xdtshare');
  writeFileSync(file, buildPlainFile(await zip.generateAsync({ type: 'nodebuffer' })));
  return inspectShareFile(file);
}
function commit(draftId: string) {
  return commitShareImport({ draftId, workingDir: root, projectsRootOverride: path.join(root, 'claude'),
    sharedMediaRootOverride: path.join(root, 'media'), piSessionsRootOverride: path.join(root, 'pi') }, scope);
}
const numbers = async (id: string) => (await listPrRefs(id)).map(r => r.prNumber).sort((a, b) => a - b);

beforeEach(() => {
  sqlite.exec('DELETE FROM sessions; DELETE FROM messages; DELETE FROM session_pr_refs; DELETE FROM migration_meta; DELETE FROM orca_teams; DELETE FROM orca_workers;');
  db.insert(migrationMeta).values({ key: 'git_context_pr_refs_backfill_v2', value: 'done' }).run();
  h.client = client;
  h.afterCommit = null;
  h.changed.mockReset();
  setPrRefsChangedListener(h.changed);
});
afterAll(() => { sqlite.close(); rmSync(root, { recursive: true, force: true }); });

describe('share import PR associations', () => {
  it('publishes only persisted public lead and worker mentions after backfill is complete', async () => {
    const draft = await bundle();
    const result = await commit(draft.draftId);
    const worker = db.select().from(orcaWorkers).get()!;
    expect(await numbers(result.sessionId)).toEqual([100, 101, 105]);
    expect(await numbers(worker.sessionId)).toEqual([200, 201, 205]);
    expect(h.changed.mock.calls.map(([id]) => id).sort()).toEqual([result.sessionId, worker.sessionId].sort());
    await ensurePrRefsBackfill();
    expect(db.select().from(sessionPrRefs).all()).toHaveLength(6);
    await expect(commit(draft.draftId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.select().from(sessions).all()).toHaveLength(2);
  });

  it('keeps manual removals hidden and repeated import reconciliation idempotent', async () => {
    const result = await commit((await bundle()).draftId);
    const [ref] = await listPrRefs(result.sessionId);
    await managePrRefs(result.sessionId, { action: 'remove', id: ref.id }, async () => undefined);
    await recordPrRefsForImportedMessages(result.sessionId);
    await recordPrRefsForImportedMessages(result.sessionId);
    expect(await numbers(result.sessionId)).toEqual([100, 101, 105].filter(n => n !== ref.prNumber));
    expect(db.select().from(sessionPrRefs).all()).toHaveLength(6);
  });

  it('rolls back the graph and emits no associations when a worker insert fails, then allows retry', async () => {
    await expect(commit((await bundle(true)).draftId)).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
    expect(db.select().from(sessions).all()).toEqual([]);
    expect(db.select().from(messages).all()).toEqual([]);
    expect(db.select().from(sessionPrRefs).all()).toEqual([]);
    expect(h.changed).not.toHaveBeenCalled();
    const result = await commit((await bundle()).draftId);
    expect(await numbers(result.sessionId)).toEqual([100, 101, 105]);
  });

  it.each(['after commit', 'between tasks'])('stops publication on account invalidation %s', async (when) => {
    const invalidate = () => { h.client = { drizzle: db }; };
    if (when === 'after commit') h.afterCommit = invalidate;
    else h.changed.mockImplementationOnce(invalidate);
    const draft = await bundle();
    await expect(commit(draft.draftId)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(db.select().from(sessions).all()).toHaveLength(2); // committed graph is preserved
    expect(db.select().from(sessionPrRefs).all()).toHaveLength(when === 'after commit' ? 0 : 3);
    expect(h.changed).toHaveBeenCalledTimes(when === 'after commit' ? 0 : 1);
    h.client = client;
    await expect(commit(draft.draftId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
