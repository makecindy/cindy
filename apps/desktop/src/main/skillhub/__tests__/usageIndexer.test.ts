import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient';
import { prepareSkillUsageCache } from '../usageStore';

const currentDbClientMocks = vi.hoisted(() => ({
  getDbClient: vi.fn(),
  getCurrentDbClientSnapshot: vi.fn(),
}));

vi.mock('../../localDb/client/current', () => ({
  getDbClient: currentDbClientMocks.getDbClient,
  getCurrentDbClientSnapshot: currentDbClientMocks.getCurrentDbClientSnapshot,
}));

import { discoverTranscriptSources, getLocalSkillUsageDiagnosisContext, getLocalSkillUsageRefreshStatus, getLocalSkillUsageSummary, refreshLocalSkillUsageAnalytics } from '../usageIndexer';

const codexThreadId = '019ed672-e5d3-70b0-a160-8bb7e8f3a0b1';
const desktopCodexThreadId = '019ed672-e5d3-70b0-a160-8bb7e8f3a0b2';
const claudeSessionId = '15356275-b340-401f-abd1-3bc2bd4824c5';
const desktopClaudeSessionId = '15356275-b340-401f-abd1-3bc2bd4824c6';
const dayMs = 24 * 60 * 60 * 1000;
const nowMs = Date.UTC(2026, 5, 22, 12);

let tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skill-usage-indexer-'));
  tempRoots.push(dir);
  return dir;
}

async function writeJsonl(file: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{}\n', 'utf-8');
  return realpath(file);
}

async function touchJsonl(file: string, mtimeMs: number): Promise<string> {
  const real = await writeJsonl(file);
  const time = new Date(mtimeMs);
  await utimes(real, time, time);
  return real;
}

function codexLine(value: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: '2026-06-20T01:00:00.000Z',
    ...value,
  });
}

function skillDocument(skillName: string, body: string): string {
  return [
    '---',
    `name: ${skillName}`,
    `description: ${skillName} description`,
    '---',
    `# ${skillName}`,
    '',
    body,
  ].join('\n');
}

function codexSkillInjection(skillName: string, skillDir: string, document: string): string {
  return [
    `<skill name="${skillName}">`,
    `Base directory for this skill: ${skillDir}`,
    '',
    document,
    '</skill>',
  ].join('\n');
}

function createUsageDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE migration_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE skill_usage_sources (
      raw_file_path TEXT PRIMARY KEY,
      analyzer_version TEXT NOT NULL DEFAULT '5',
      agent_kind TEXT NOT NULL,
      session_id TEXT NOT NULL,
      sdk_session_id TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      last_scanned_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT
    );
    CREATE TABLE skill_usage_exposures (
      id TEXT PRIMARY KEY,
      analyzer_version TEXT NOT NULL DEFAULT '5',
      raw_file_path TEXT NOT NULL,
      raw_line_no INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      sdk_session_id TEXT NOT NULL,
      agent_kind TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      skill_path TEXT,
      skill_document_hash TEXT,
      exposure_content_hash TEXT NOT NULL,
      document_hash_source TEXT NOT NULL,
      source TEXT NOT NULL,
      tool_use_id TEXT,
      seen_at INTEGER NOT NULL,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      repeated_tool_call_count INTEGER NOT NULL DEFAULT 0,
      tool_error_count INTEGER NOT NULL DEFAULT 0,
      command_call_count INTEGER NOT NULL DEFAULT 0,
      command_failure_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function recentLocalWindowStartMs(anchorMs: number): number {
  const start = new Date(anchorMs);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 29);
  return start.getTime();
}

function insertUsageExposure(
  db: Database.Database,
  rawFilePath: string,
  options: { analyzerVersion?: string; seenAt?: number; sourceMtimeMs?: number } = {},
): void {
  const analyzerVersion = options.analyzerVersion ?? '7';
  db.prepare("INSERT OR IGNORE INTO migration_meta (key, value) VALUES ('skill_usage_analyzer_version', ?)").run(analyzerVersion);
  db.prepare("INSERT OR IGNORE INTO migration_meta (key, value) VALUES ('skill_usage_last_success_at', '1')").run();
  db.prepare(`
    INSERT INTO skill_usage_sources (
      raw_file_path, analyzer_version, agent_kind, session_id, sdk_session_id,
      mtime_ms, size_bytes, last_scanned_at, status, error
    )
    VALUES (?, ?, 'codex', 'codex-stale', 'stale', ?, 1, 1, 'ok', NULL)
  `).run(rawFilePath, analyzerVersion, options.sourceMtimeMs ?? 1);
  db.prepare(`
    INSERT INTO skill_usage_exposures (
      id, analyzer_version, raw_file_path, raw_line_no, session_id, sdk_session_id, agent_kind,
      skill_name, skill_path, skill_document_hash, exposure_content_hash, document_hash_source,
      source, tool_use_id, seen_at,
      tool_call_count, repeated_tool_call_count, tool_error_count, command_call_count,
      command_failure_count
    )
    VALUES (
      ?, ?, ?, 1, 'codex-stale', 'stale', 'codex',
      'word-doc', NULL, 'doc-current', 'doc-current', 'transcript_file_read',
      'codex_skill_file_read', NULL, ?,
      0, 0, 0, 0, 0
    )
  `).run(`${analyzerVersion}:${rawFilePath}`, analyzerVersion, rawFilePath, options.seenAt ?? nowMs - dayMs);
}

describe('discoverTranscriptSources', () => {
  afterEach(async () => {
    currentDbClientMocks.getDbClient.mockReset();
    currentDbClientMocks.getCurrentDbClientSnapshot.mockReset();
    await Promise.all(
      tempRoots.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
    );
    tempRoots = [];
  });

  it('keeps one stable observation and replaces its evidence path after a native Codex log is archived', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(homeDir, '.codex');
    const original = await writeJsonl(path.join(codexHome, 'sessions', 'arbitrary-name.jsonl'));
    const archive = path.join(codexHome, 'archived_sessions', 'renamed.jsonl');
    await writeFile(original, [
      codexLine({ type: 'session_meta', payload: { id: codexThreadId } }),
      codexLine({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text',
        text: codexSkillInjection('word-doc', path.join(root, 'word-doc'), skillDocument('word-doc', 'Rules.')),
      }] } }),
    ].join('\n'));
    const db = createUsageDb();
    const options = { homeDir, userDataDir: path.join(root, 'user-data'), appDataDir: path.join(root, 'app-data'), env: {}, nowMs };
    try {
      await refreshLocalSkillUsageAnalytics(db, options);
      const first = db.prepare('SELECT id FROM skill_usage_exposures').pluck().get();
      expect(first).toBeTypeOf('string');
      await mkdir(path.dirname(archive), { recursive: true });
      await rename(original, archive);
      await refreshLocalSkillUsageAnalytics(db, options);
      expect(db.prepare('SELECT id, raw_file_path AS rawFilePath, session_id AS sessionId FROM skill_usage_exposures').all())
        .toEqual([{ id: first, rawFilePath: archive, sessionId: `codex-${codexThreadId}` }]);
      expect(db.prepare('SELECT raw_file_path FROM skill_usage_sources').all()).toEqual([{ raw_file_path: archive }]);
      expect(getLocalSkillUsageRefreshStatus(db)).toMatchObject({ phase: 'complete', incomplete: false, hasSnapshot: true, missingCount: 0 });
    } finally { db.close(); }
  });

  it('marks confirmed missing cached files without blocking the analyzer rebuild', async () => {
    const root = await makeTempRoot();
    const missing = path.join(root, 'missing.jsonl');
    const db = createUsageDb();
    insertUsageExposure(db, missing, { analyzerVersion: '7' });
    try {
      await refreshLocalSkillUsageAnalytics(db, {
        homeDir: path.join(root, 'home'), userDataDir: path.join(root, 'user-data'),
        appDataDir: path.join(root, 'app-data'), env: {}, nowMs,
      });
      expect(db.prepare('SELECT status FROM skill_usage_sources WHERE raw_file_path = ?').pluck().get(missing)).toBe('missing');
      expect(db.prepare("SELECT value FROM migration_meta WHERE key = 'skill_usage_analyzer_version'").pluck().get()).toBe('7');
      expect(getLocalSkillUsageRefreshStatus(db)).toMatchObject({ phase: 'complete', missingCount: 1, hasSnapshot: true });
    } finally { db.close(); }
  });

  it.each([false, true])('keeps the newest native log across repeated refreshes (older duplicate corrupt=%s)', async (corruptOlder) => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(homeDir, '.codex');
    const current = await writeJsonl(path.join(codexHome, 'sessions', 'current.jsonl'));
    const older = await writeJsonl(path.join(codexHome, 'archived_sessions', 'older.jsonl'));
    for (const [file, skillName, mtimeMs] of [[current, 'word-doc', nowMs], [older, 'stale-skill', nowMs - 1_000]] as const) {
      await writeFile(file, [
        codexLine({ type: 'session_meta', payload: { id: codexThreadId } }),
        codexLine({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text',
          text: codexSkillInjection(skillName, path.join(root, skillName), skillDocument(skillName, 'Rules.')),
        }] } }),
      ].join('\n') + (corruptOlder && file === older ? '\n{"type":' : ''));
      await utimes(file, new Date(mtimeMs), new Date(mtimeMs));
    }
    const db = createUsageDb();
    const options = { homeDir, userDataDir: path.join(root, 'user-data'), appDataDir: path.join(root, 'app-data'), env: {}, nowMs };
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await refreshLocalSkillUsageAnalytics(db, options);
        expect(db.prepare('SELECT raw_file_path AS rawFilePath, skill_name AS skillName FROM skill_usage_exposures').all())
          .toEqual([{ rawFilePath: current, skillName: 'word-doc' }]);
        expect(getLocalSkillUsageRefreshStatus(db)).toMatchObject({ phase: 'complete', incomplete: false });
      }
    } finally { db.close(); }
  });

  it.each([
    ['read', true], ['parse', true], ['stat', true],
    ['read', false], ['parse', false], ['stat', false],
  ] as const)('preserves valid duplicate-log evidence on %s failure (existing snapshot=%s) and retries the same path', async (failure, hasSnapshot) => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const current = await writeJsonl(path.join(homeDir, '.codex', 'sessions', 'current.jsonl'));
    const older = await writeJsonl(path.join(homeDir, '.codex', 'archived_sessions', 'older.jsonl'));
    const header = codexLine({ type: 'session_meta', payload: { id: codexThreadId } });
    const skill = (skillName: string) => codexLine({ type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text',
        text: codexSkillInjection(skillName, path.join(root, skillName), skillDocument(skillName, 'Rules.')),
      }],
    } });
    const currentText = [header, skill('old-skill'), skill('latest-skill')].join('\n');
    await writeFile(current, currentText);
    await writeFile(older, [header, skill('old-skill')].join('\n'));
    await utimes(current, new Date(nowMs - 1_000), new Date(nowMs - 1_000));
    await utimes(older, new Date(nowMs - 2_000), new Date(nowMs - 2_000));
    const db = createUsageDb();
    const options = { homeDir, userDataDir: path.join(root, 'user-data'), appDataDir: path.join(root, 'app-data'), env: {}, nowMs };
    const readEvidence = () => db.prepare('SELECT skill_name AS skillName, raw_file_path AS rawFilePath FROM skill_usage_exposures ORDER BY skill_name').all();
    try {
      if (hasSnapshot) await refreshLocalSkillUsageAnalytics(db, options);
      const before = readEvidence();
      const lastSuccessAt = getLocalSkillUsageRefreshStatus(db).lastSuccessAt;
      if (hasSnapshot) expect(before).toEqual([
        { skillName: 'latest-skill', rawFilePath: current }, { skillName: 'old-skill', rawFilePath: current },
      ]);
      await writeFile(current, currentText + (failure === 'parse' ? '\n{"type":' : '\n{}'));
      await utimes(current, new Date(nowMs), new Date(nowMs));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await refreshLocalSkillUsageAnalytics(db, {
          ...options,
          readTranscriptFile: async (file) => {
            if (failure === 'read' && file === current) throw Object.assign(new Error('locked'), { code: 'EACCES' });
            return readFile(file, 'utf-8');
          },
          statSource: async (file) => {
            if (failure === 'stat' && file === current) throw Object.assign(new Error('locked'), { code: 'EACCES' });
            const info = await stat(file);
            return { mtimeMs: Math.round(info.mtimeMs), sizeBytes: info.size };
          },
        });
        expect(readEvidence()).toEqual(hasSnapshot ? before : [{ skillName: 'old-skill', rawFilePath: older }]);
        expect(getLocalSkillUsageRefreshStatus(db)).toMatchObject({ phase: 'incomplete', hasSnapshot, lastSuccessAt });
      }

      await writeFile(current, [currentText, skill('recovered-skill')].join('\n'));
      await utimes(current, new Date(nowMs), new Date(nowMs));
      await refreshLocalSkillUsageAnalytics(db, options);
      expect(readEvidence()).toEqual([
        { skillName: 'latest-skill', rawFilePath: current }, { skillName: 'old-skill', rawFilePath: current },
        { skillName: 'recovered-skill', rawFilePath: current },
      ]);
      expect(getLocalSkillUsageRefreshStatus(db)).toMatchObject({ phase: 'complete', hasSnapshot: true, incomplete: false });
    } finally { db.close(); }
  });

  it('preserves the prior snapshot and marks the scan incomplete on transient cached-file IO failure', async () => {
    const root = await makeTempRoot();
    const db = createUsageDb();
    const rawFilePath = path.join(root, 'temporarily-locked.jsonl');
    insertUsageExposure(db, rawFilePath, { analyzerVersion: '7' });
    try {
      await refreshLocalSkillUsageAnalytics(db, {
        homeDir: path.join(root, 'home'), userDataDir: path.join(root, 'user-data'),
        appDataDir: path.join(root, 'app-data'), env: {}, nowMs,
        statSource: async () => { throw Object.assign(new Error('locked'), { code: 'EACCES' }); },
      });
      expect(db.prepare('SELECT status FROM skill_usage_sources').pluck().get()).toBe('ok');
      expect(db.prepare("SELECT value FROM migration_meta WHERE key = 'skill_usage_analyzer_version'").pluck().get()).toBe('7');
      expect(getLocalSkillUsageRefreshStatus(db)).toMatchObject({ phase: 'incomplete', incomplete: true, missingCount: 0, hasSnapshot: true });
    } finally { db.close(); }
  });

  it('preserves the old snapshot when a JSONL tail is incomplete and retries it after the writer finishes', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const rawFilePath = await writeJsonl(path.join(homeDir, '.codex', 'sessions', 'growing.jsonl'));
    const db = createUsageDb();
    insertUsageExposure(db, rawFilePath, { analyzerVersion: '7' });
    const options = { homeDir, userDataDir: path.join(root, 'user-data'), appDataDir: path.join(root, 'app-data'), env: {}, nowMs };
    try {
      await refreshLocalSkillUsageAnalytics(db, { ...options, readTranscriptFile: async () => '{}\n{"type":' });
      expect(db.prepare('SELECT analyzer_version FROM skill_usage_exposures').pluck().get()).toBe('7');
      expect(getLocalSkillUsageRefreshStatus(db)).toMatchObject({ phase: 'incomplete', hasSnapshot: true, error: 'transcript_parse_failed: line 2' });
      await refreshLocalSkillUsageAnalytics(db, { ...options, readTranscriptFile: async () => '\uFEFF{}\n{"type":"message"}\n' });
      expect(getLocalSkillUsageRefreshStatus(db)).toMatchObject({ phase: 'complete', incomplete: false, hasSnapshot: true, error: null });
      expect(db.prepare("SELECT value FROM migration_meta WHERE key = 'skill_usage_analyzer_version'").pluck().get()).toBe('7');
    } finally { db.close(); }
  });

  it('initializes the single cache once for concurrent readers and never returns obsolete observations', async () => {
    const root = await makeTempRoot();
    const db = createUsageDb();
    const oldPath = path.join(root, 'old.jsonl');
    const homeDir = path.join(root, 'home');
    await writeJsonl(path.join(homeDir, '.codex', 'sessions', 'current.jsonl'));
    insertUsageExposure(db, oldPath, { analyzerVersion: '6', seenAt: Date.now() });
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => { releaseInitialization = resolve; });
    const tx = vi.fn(async (_name: string, args: { kind: string; analyzerVersion: string }) => {
      if (args.kind === 'prepareCache') {
        await initializationGate;
        prepareSkillUsageCache(db, args.analyzerVersion);
      }
    });
    const client = {
      query: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
      queryOne: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
      exec: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
      tx,
    } as unknown as DbClient;
    try {
      // 所有读取共享这次受控后台扫描，避免测试访问真实用户的 Agent home。
      const refresh = refreshLocalSkillUsageAnalytics(client, {
        homeDir, userDataDir: path.join(root, 'user-data'), appDataDir: path.join(root, 'app-data'), env: {},
        readTranscriptFile: async () => { throw new Error('temporarily unavailable'); },
      });
      const summaryResult = getLocalSkillUsageSummary({ skillName: 'word-doc', client });
      const diagnosisResult = getLocalSkillUsageDiagnosisContext({ skillName: 'word-doc', client });
      releaseInitialization();
      const [summary, diagnosis] = await Promise.all([summaryResult, diagnosisResult]);
      await refresh;
      expect(summary.summary.totalUseCount).toBe(0);
      expect(diagnosis.context.evidence).toEqual([]);
      expect(summary.refreshStatus.hasSnapshot).toBe(false);
      expect(diagnosis.refreshStatus.hasSnapshot).toBe(false);
      expect(tx.mock.calls.filter(([, args]) => args.kind === 'prepareCache')).toHaveLength(1);
      expect(getLocalSkillUsageRefreshStatus(client)).toMatchObject({ phase: 'incomplete', hasSnapshot: false, lastSuccessAt: null });
    } finally { db.close(); }
  });

  it('coalesces refreshes per database without reusing another owner refresh', async () => {
    const root = await makeTempRoot();
    const firstDb = createUsageDb();
    const secondDb = createUsageDb();
    const options = {
      homeDir: path.join(root, 'home'),
      appDataDir: path.join(root, 'app-data'),
      userDataDir: path.join(root, 'user-data'),
      env: {},
      platform: 'win32' as const,
      nowMs,
    };

    try {
      const firstRefresh = refreshLocalSkillUsageAnalytics(firstDb, options);
      const coalescedRefresh = refreshLocalSkillUsageAnalytics(firstDb, options);
      const secondRefresh = refreshLocalSkillUsageAnalytics(secondDb, options);

      expect(coalescedRefresh).toBe(firstRefresh);
      expect(secondRefresh).not.toBe(firstRefresh);
      await Promise.all([firstRefresh, secondRefresh]);
    } finally {
      firstDb.close();
      secondDb.close();
    }
  });

  it('uses the current DbClient and batches freshness lookup for multiple transcripts', async () => {
    const root = await makeTempRoot();
    const db = createUsageDb();
    const firstPath = path.join(root, 'first.jsonl');
    const secondPath = path.join(root, 'second.jsonl');
    insertUsageExposure(db, firstPath, { sourceMtimeMs: 100 });
    insertUsageExposure(db, secondPath, { sourceMtimeMs: 200 });
    db.prepare(
      "INSERT OR REPLACE INTO migration_meta (key, value) VALUES ('skill_usage_analyzer_version', '7')",
    ).run();

    const query = vi.fn(async (sql: string, params: unknown[] = []) => (
      db.prepare(sql).all(...params) as unknown[]
    ));
    const client = {
      query,
      queryOne: vi.fn(async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params)),
      exec: vi.fn(async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params)),
      tx: vi.fn(async () => undefined),
    } as unknown as DbClient;
    currentDbClientMocks.getDbClient.mockReturnValue(client);
    currentDbClientMocks.getCurrentDbClientSnapshot.mockReturnValue({
      client,
      userId: 'owner-a',
      clientEpoch: 1,
    });

    try {
      await refreshLocalSkillUsageAnalytics(undefined, {
        homeDir: path.join(root, 'home'),
        appDataDir: path.join(root, 'app-data'),
        userDataDir: path.join(root, 'user-data'),
        env: {},
        platform: 'win32',
        nowMs,
        statSource: async (file) => {
          if (file === firstPath) return { mtimeMs: 100, sizeBytes: 1 };
          if (file === secondPath) return { mtimeMs: 200, sizeBytes: 1 };
          return null;
        },
      });

      const freshnessCalls = query.mock.calls.filter(([sql]) => (
        typeof sql === 'string' && sql.includes('FROM json_each(?) wanted')
      ));
      expect(currentDbClientMocks.getDbClient).toHaveBeenCalledTimes(1);
      expect(freshnessCalls).toHaveLength(1);
      expect(JSON.parse(String(freshnessCalls[0][1]?.[0]))).toEqual([secondPath, firstPath]);
    } finally {
      db.close();
    }
  });

  it('cancels an in-flight client refresh when the database owner changes', async () => {
    const root = await makeTempRoot();
    const db = createUsageDb();
    const file = path.join(root, 'switch.jsonl');
    await writeJsonl(file);
    insertUsageExposure(db, file, { sourceMtimeMs: 100 });
    let switched = false;
    const query = vi.fn(async (sql: string, params: unknown[] = []) => (
      db.prepare(sql).all(...params) as unknown[]
    ));
    const client = {
      query,
      queryOne: vi.fn(async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params)),
      exec: vi.fn(async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params)),
      tx: vi.fn(async () => undefined),
    } as unknown as DbClient;
    currentDbClientMocks.getDbClient.mockReturnValue(client);
    currentDbClientMocks.getCurrentDbClientSnapshot.mockImplementation(() => switched
      ? { client, userId: 'owner-b', clientEpoch: 2 }
      : { client, userId: 'owner-a', clientEpoch: 1 });

    try {
      await refreshLocalSkillUsageAnalytics(undefined, {
        homeDir: path.join(root, 'home'),
        appDataDir: path.join(root, 'app-data'),
        userDataDir: path.join(root, 'user-data'),
        env: {},
        platform: 'win32',
        nowMs,
        statSource: async () => ({ mtimeMs: 101, sizeBytes: 1 }),
        readTranscriptFile: async () => {
          switched = true;
          return '{}\n';
        },
      });

      expect(client.tx).toHaveBeenCalledExactlyOnceWith('skillUsage.applyMutation', { kind: 'prepareCache', analyzerVersion: '7' });
    } finally {
      db.close();
    }
  });

  it('discovers default, XDMaker and configured transcript homes without dropping subagent files', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'roaming');
    const codexHome = path.join(homeDir, '.codex');
    const desktopCodexHome = path.join(userDataDir, 'codex-home');
    const claudeHome = path.join(homeDir, '.claude');
    const desktopClaudeHome = path.join(userDataDir, 'claude-home');

    const codexDefaultFile = await writeJsonl(
      path.join(codexHome, 'sessions', '2026', '06', '19', `rollout-2026-06-19T01-00-00-${codexThreadId}.jsonl`),
    );
    const codexDesktopFile = await writeJsonl(
      path.join(desktopCodexHome, 'sessions', '2026', '06', '19', `rollout-2026-06-19T01-00-00-${desktopCodexThreadId}.jsonl`),
    );
    const claudeDefaultFile = await writeJsonl(
      path.join(claudeHome, 'projects', '-repo', `${claudeSessionId}.jsonl`),
    );
    const claudeSubagentFile = await writeJsonl(
      path.join(claudeHome, 'projects', '-repo', claudeSessionId, 'subagents', 'agent-a.jsonl'),
    );
    const claudeSecondSubagentFile = await writeJsonl(
      path.join(claudeHome, 'projects', '-other-repo', claudeSessionId, 'subagents', 'agent-a.jsonl'),
    );
    const claudeDesktopFile = await writeJsonl(
      path.join(desktopClaudeHome, 'projects', '-repo', `${desktopClaudeSessionId}.jsonl`),
    );

    const sources = await discoverTranscriptSources({
      homeDir,
      appDataDir,
      userDataDir,
      platform: 'win32',
      env: {
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: desktopClaudeHome,
      },
      nowMs,
    });

    const paths = sources.map((source) => source.rawFilePath).sort();
    expect(paths).toEqual([
      claudeDefaultFile,
      claudeDesktopFile,
      claudeSecondSubagentFile,
      claudeSubagentFile,
      codexDefaultFile,
      codexDesktopFile,
    ].sort());
    expect(sources.filter((source) => source.rawFilePath === codexDefaultFile)).toHaveLength(1);
    expect(sources.find((source) => source.rawFilePath === codexDesktopFile)).toMatchObject({
      agentKind: 'codex',
      sessionId: `codex-${desktopCodexThreadId}`,
      sdkSessionId: desktopCodexThreadId,
    });
    expect(sources.find((source) => source.rawFilePath === claudeSubagentFile)).toMatchObject({
      agentKind: 'claude-code',
    });
    expect(sources.find((source) => source.rawFilePath === claudeSecondSubagentFile)).toMatchObject({
      agentKind: 'claude-code',
    });
    const firstSubagent = sources.find((source) => source.rawFilePath === claudeSubagentFile);
    const secondSubagent = sources.find((source) => source.rawFilePath === claudeSecondSubagentFile);
    expect(firstSubagent?.sdkSessionId).not.toBe(secondSubagent?.sdkSessionId);
    expect(firstSubagent?.sessionId).not.toBe(secondSubagent?.sessionId);
  });

  it('returns discovered transcript sources by recency', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'roaming');
    const codexHome = path.join(homeDir, '.codex');

    const oldFile = await touchJsonl(
      path.join(codexHome, 'sessions', '2026', '06', '19', 'rollout-old.jsonl'),
      1_000,
    );
    const latestFile = await touchJsonl(
      path.join(codexHome, 'sessions', '2026', '06', '20', 'rollout-latest.jsonl'),
      3_000,
    );
    const middleFile = await touchJsonl(
      path.join(codexHome, 'sessions', '2026', '06', '21', 'rollout-middle.jsonl'),
      2_000,
    );

    const sources = await discoverTranscriptSources({
      homeDir,
      appDataDir,
      userDataDir,
      platform: 'win32',
      env: { CODEX_HOME: codexHome },
      nowMs: 4_000,
    });

    expect(sources.map((source) => source.rawFilePath)).toEqual([
      latestFile,
      middleFile,
      oldFile,
    ]);
  });

  it('uses the local 30-day calendar window when filtering transcript sources', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'roaming');
    const codexHome = path.join(homeDir, '.codex');
    const windowStartMs = recentLocalWindowStartMs(nowMs);

    const recentFile = await touchJsonl(
      path.join(codexHome, 'sessions', '2026', '06', '20', 'rollout-recent.jsonl'),
      windowStartMs,
    );
    const oldFile = await touchJsonl(
      path.join(codexHome, 'sessions', '2026', '05', '01', 'rollout-old.jsonl'),
      windowStartMs - 1,
    );

    const sources = await discoverTranscriptSources({
      homeDir,
      appDataDir,
      userDataDir,
      platform: 'win32',
      env: { CODEX_HOME: codexHome },
      nowMs,
    });

    expect(sources.map((source) => source.rawFilePath)).toEqual([recentFile]);
    expect(sources.map((source) => source.rawFilePath)).not.toContain(oldFile);
  });

  it('reprocesses cached recent observations even when transcript mtime is outside the window', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'roaming');
    const codexHome = path.join(homeDir, '.codex');
    const document = skillDocument('word-doc', 'Use markitdown for Word files.');
    const skillDir = path.join(root, 'skills', 'word-doc');
    const transcriptText = codexLine({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: codexSkillInjection('word-doc', skillDir, document) }],
      },
    });
    const oldMtimeMs = recentLocalWindowStartMs(nowMs) - 1;
    const rawFilePath = await touchJsonl(
      path.join(codexHome, 'sessions', '2026', '05', '01', 'rollout-old-mtime-recent-seen.jsonl'),
      oldMtimeMs,
    );
    await writeFile(rawFilePath, `${transcriptText}\n`, 'utf-8');
    const oldMtime = new Date(oldMtimeMs);
    await utimes(rawFilePath, oldMtime, oldMtime);
    const db = createUsageDb();
    db.prepare(`
      INSERT INTO skill_usage_sources (
        raw_file_path, analyzer_version, agent_kind, session_id, sdk_session_id,
        mtime_ms, size_bytes, last_scanned_at, status, error
      )
      VALUES (?, '7', 'codex', 'codex-old-mtime', 'old-mtime', 1, 1, 1, 'ok', NULL)
    `).run(rawFilePath);
    db.prepare(`
      INSERT INTO skill_usage_exposures (
        id, analyzer_version, raw_file_path, raw_line_no, session_id, sdk_session_id, agent_kind,
        skill_name, skill_path, skill_document_hash, exposure_content_hash, document_hash_source,
        source, tool_use_id, seen_at,
        tool_call_count, repeated_tool_call_count, tool_error_count, command_call_count,
        command_failure_count
      )
      VALUES (
        '7:old-mtime', '7', ?, 1, 'codex-old-mtime', 'old-mtime', 'codex',
        'word-doc', NULL, 'doc-old', 'doc-old', 'transcript_file_read',
        'codex_skill_file_read', NULL, ?,
        0, 0, 0, 0, 0
      )
    `).run(rawFilePath, nowMs - dayMs);
    db.prepare("INSERT OR REPLACE INTO migration_meta (key, value) VALUES ('skill_usage_analyzer_version', '7')").run();

    try {
      await refreshLocalSkillUsageAnalytics(db, {
        homeDir,
        appDataDir,
        userDataDir,
        platform: 'win32',
        env: { CODEX_HOME: codexHome },
        nowMs,
      });

      const row = db.prepare(`
        SELECT analyzer_version AS analyzerVersion, skill_name AS skillName
        FROM skill_usage_exposures
      `).get() as { analyzerVersion: string; skillName: string } | undefined;
      const activeVersion = db.prepare(`
        SELECT value FROM migration_meta WHERE key = 'skill_usage_analyzer_version'
      `).pluck().get();
      expect(row).toEqual({ analyzerVersion: '7', skillName: 'word-doc' });
      expect(activeVersion).toBe('7');
    } finally {
      db.close();
    }
  });

  it('keeps resumed Codex conversations from old date directories when the file mtime is recent', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'roaming');
    const codexHome = path.join(homeDir, '.codex');
    const oldDateRecentFile = await touchJsonl(
      path.join(codexHome, 'sessions', '2026', '05', '01', 'rollout-old-date-recent-mtime.jsonl'),
      nowMs,
    );
    const recentFile = await writeJsonl(
      path.join(codexHome, 'sessions', '2026', '06', '20', 'rollout-recent.jsonl'),
    );
    const stattedFiles: string[] = [];

    const sources = await discoverTranscriptSources({
      homeDir,
      appDataDir,
      userDataDir,
      platform: 'win32',
      env: { CODEX_HOME: codexHome },
      nowMs,
      statSource: async (file) => {
        stattedFiles.push(file);
        return { mtimeMs: file === oldDateRecentFile ? nowMs : recentLocalWindowStartMs(nowMs), sizeBytes: 1 };
      },
    });

    expect(sources.map((source) => source.rawFilePath)).toEqual([oldDateRecentFile, recentFile]);
    expect(stattedFiles).toEqual(expect.arrayContaining([oldDateRecentFile, recentFile]));
  });

  it('keeps cached usage records when transcript discovery has stat failures', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'roaming');
    const codexHome = path.join(homeDir, '.codex');
    const staleFile = await touchJsonl(
      path.join(codexHome, 'sessions', '2026', '06', '19', 'rollout-stale.jsonl'),
      1_000,
    );
    const db = createUsageDb();
    insertUsageExposure(db, staleFile);

    try {
      await refreshLocalSkillUsageAnalytics(db, {
        homeDir,
        appDataDir,
        userDataDir,
        platform: 'win32',
        env: { CODEX_HOME: codexHome },
        maxSourcesPerRefresh: 1,
        nowMs: 4_000,
        statSource: async () => null,
      });

      const row = db.prepare('SELECT COUNT(*) AS count FROM skill_usage_exposures').get() as { count: number };
      expect(row.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('keeps cached usage records when a transcript root cannot be enumerated', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'roaming');
    const codexHome = path.join(homeDir, '.codex');
    const sessionsPath = path.join(codexHome, 'sessions');
    await mkdir(codexHome, { recursive: true });
    await writeFile(sessionsPath, 'not a directory', 'utf-8');
    const staleFile = path.join(codexHome, 'sessions', '2026', '06', '19', 'rollout-stale.jsonl');
    const db = createUsageDb();
    insertUsageExposure(db, staleFile);

    try {
      await refreshLocalSkillUsageAnalytics(db, {
        homeDir,
        appDataDir,
        userDataDir,
        platform: 'win32',
        env: { CODEX_HOME: codexHome },
        nowMs,
      });

      const row = db.prepare('SELECT COUNT(*) AS count FROM skill_usage_exposures').get() as { count: number };
      expect(row.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('keeps cached usage records when a dirty transcript cannot be read', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'roaming');
    const codexHome = path.join(homeDir, '.codex');
    const rawFilePath = await touchJsonl(
      path.join(codexHome, 'sessions', '2026', '06', '20', 'rollout-read-failure.jsonl'),
      nowMs,
    );
    const db = createUsageDb();
    insertUsageExposure(db, rawFilePath, { analyzerVersion: '7', sourceMtimeMs: 1 });

    try {
      await refreshLocalSkillUsageAnalytics(db, {
        homeDir,
        appDataDir,
        userDataDir,
        platform: 'win32',
        env: { CODEX_HOME: codexHome },
        nowMs,
        readTranscriptFile: async () => {
          throw new Error('file locked');
        },
      });

      const row = db.prepare('SELECT COUNT(*) AS count FROM skill_usage_exposures').get() as { count: number };
      expect(row.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('discards obsolete cached statistics even when the first rebuild cannot read a transcript', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'roaming');
    const codexHome = path.join(homeDir, '.codex');
    const rawFilePath = await touchJsonl(
      path.join(codexHome, 'sessions', '2026', '06', '20', 'rollout-no-active-meta.jsonl'),
      nowMs,
    );
    const db = createUsageDb();
    insertUsageExposure(db, rawFilePath, { analyzerVersion: '6', sourceMtimeMs: 1 });

    try {
      await refreshLocalSkillUsageAnalytics(db, {
        homeDir,
        appDataDir,
        userDataDir,
        platform: 'win32',
        env: { CODEX_HOME: codexHome },
        nowMs,
        readTranscriptFile: async () => {
          throw new Error('file locked');
        },
      });

      const activeVersion = db.prepare(`
        SELECT value FROM migration_meta WHERE key = 'skill_usage_analyzer_version'
      `).pluck().get();
      expect(activeVersion).toBe('7');
      expect(db.prepare('SELECT COUNT(*) FROM skill_usage_exposures').pluck().get()).toBe(0);
      expect(db.prepare("SELECT value FROM migration_meta WHERE key = 'skill_usage_last_success_at'").get()).toBeUndefined();
      expect(getLocalSkillUsageRefreshStatus(db)).toMatchObject({ phase: 'incomplete', hasSnapshot: false, lastSuccessAt: null });
    } finally {
      db.close();
    }
  });

  it('does not treat partial observations from an unfinished first scan as a completed snapshot', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'roaming');
    const codexHome = path.join(homeDir, '.codex');
    const db = createUsageDb();
    insertUsageExposure(db, path.join(codexHome, 'sessions', 'partial-current.jsonl'), {
      analyzerVersion: '7',
      seenAt: nowMs,
    });
    db.prepare("DELETE FROM migration_meta WHERE key = 'skill_usage_last_success_at'").run();

    try {
      await refreshLocalSkillUsageAnalytics(db, {
        homeDir,
        appDataDir,
        userDataDir,
        platform: 'win32',
        env: { CODEX_HOME: codexHome },
        nowMs,
        statSource: async () => { throw new Error('temporarily unavailable'); },
      });

      expect(db.prepare('SELECT COUNT(*) FROM skill_usage_exposures').pluck().get()).toBe(1);
      expect(getLocalSkillUsageRefreshStatus(db)).toMatchObject({ phase: 'incomplete', hasSnapshot: false, lastSuccessAt: null });
    } finally {
      db.close();
    }
  });

  it('drains all recent dirty records across refresh batches before recording a successful refresh', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'roaming');
    const codexHome = path.join(homeDir, '.codex');
    const sessionsDir = path.join(codexHome, 'sessions');
    const db = createUsageDb();
    let oldestFile = '';

    for (let index = 0; index < 3; index += 1) {
      const file = path.join(sessionsDir, `rollout-${`${index}`.padStart(4, '0')}.jsonl`);
      const real = await writeJsonl(file);
      if (index === 0) oldestFile = real;
    }
    insertUsageExposure(db, oldestFile);

    let readCallCount = 0;
    try {
      await refreshLocalSkillUsageAnalytics(db, {
        homeDir,
        appDataDir,
        userDataDir,
        platform: 'win32',
        env: { CODEX_HOME: codexHome },
        nowMs,
        maxSourcesPerRefresh: 2,
        statSource: async (file) => {
          const basename = path.basename(file, '.jsonl');
          const mtimeMs = Number.parseInt(basename.replace('rollout-', ''), 10);
          return { mtimeMs: nowMs - (3 - mtimeMs) * 1_000, sizeBytes: 1 };
        },
        readTranscriptFile: async () => {
          readCallCount += 1;
          return '{}\n';
        },
      });

      const row = db.prepare('SELECT COUNT(*) AS count FROM skill_usage_exposures').get() as { count: number };
      const activeVersion = db.prepare(`
        SELECT value FROM migration_meta WHERE key = 'skill_usage_analyzer_version'
      `).pluck().get();
      expect(readCallCount).toBe(3);
      expect(row.count).toBe(0);
      expect(activeVersion).toBe('7');
      expect(getLocalSkillUsageRefreshStatus(db)).toMatchObject({ phase: 'complete', scanned: 3, total: 3, hasSnapshot: true });
    } finally {
      db.close();
    }
  });

  it('does not record a complete snapshot when transcript discovery hits the file cap', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'roaming');
    const codexHome = path.join(homeDir, '.codex');
    const sessionsDir = path.join(codexHome, 'sessions', '2026', '06', '20');
    const firstFile = await writeJsonl(path.join(sessionsDir, 'rollout-0000.jsonl'));
    await writeJsonl(path.join(sessionsDir, 'rollout-0001.jsonl'));
    const db = createUsageDb();
    insertUsageExposure(db, firstFile, { analyzerVersion: '6' });

    let readCallCount = 0;
    try {
      await refreshLocalSkillUsageAnalytics(db, {
        homeDir,
        appDataDir,
        userDataDir,
        platform: 'win32',
        env: { CODEX_HOME: codexHome },
        maxDiscoveredTranscriptFiles: 1,
        nowMs,
        statSource: async () => ({ mtimeMs: nowMs, sizeBytes: 1 }),
        readTranscriptFile: async () => {
          readCallCount += 1;
          return '{}\n';
        },
      });

      const row = db.prepare(`
        SELECT COUNT(*) AS count FROM skill_usage_exposures WHERE analyzer_version = '6'
      `).get() as { count: number };
      const activeVersion = db.prepare(`
        SELECT value FROM migration_meta WHERE key = 'skill_usage_analyzer_version'
      `).pluck().get();
      expect(readCallCount).toBeGreaterThan(0);
      expect(row.count).toBe(0);
      expect(activeVersion).toBe('7');
      expect(getLocalSkillUsageRefreshStatus(db)).toMatchObject({ phase: 'incomplete', incomplete: true, hasSnapshot: false, lastSuccessAt: null });
    } finally {
      db.close();
    }
  });
});

describe('native Pi transcript indexing', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
    tempRoots = [];
  });

  it('discovers persistent default, configured and Desktop sessions without scanning run-tmp', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const userDataDir = path.join(root, 'user-data');
    const configuredHome = path.join(root, 'configured-pi');
    const defaultFile = await writeJsonl(path.join(homeDir, '.pi', 'agent', 'sessions', 'project-a', 'same-name.jsonl'));
    const desktopFile = await writeJsonl(path.join(userDataDir, 'pi-agent-home', 'sessions', 'same-name.jsonl'));
    const configuredFile = await writeJsonl(path.join(configuredHome, 'sessions', 'project-b', 'same-name.jsonl'));
    const subagentFile = await writeJsonl(path.join(userDataDir, 'pi-agent-home', 'runtime', 'pi-subagent-runs', 'parent', 'run', 'sessions', 'child.jsonl'));
    await writeJsonl(path.join(userDataDir, 'pi-agent-home', 'runtime', 'pi-subagent-runs', 'parent', 'run', 'run-tmp', 'sessions', 'ignored.jsonl'));
    await writeJsonl(path.join(userDataDir, 'pi-agent-home', 'run-tmp', 'runtime', 'sessions', 'ignored.jsonl'));
    const options = { homeDir, userDataDir, appDataDir: path.join(root, 'app-data'), nowMs, env: { PI_CODING_AGENT_DIR: configuredHome } };
    const sources = await discoverTranscriptSources(options);
    expect(sources.map(source => source.rawFilePath).sort()).toEqual([defaultFile, desktopFile, configuredFile, subagentFile].sort());
    for (const source of sources) {
      expect(source.agentKind).toBe('pi');
      expect(source.sdkSessionId).toBe(source.rawFilePath);
    }
    expect(new Set(sources.map(source => source.sessionId)).size).toBe(4);
    const repeated = await discoverTranscriptSources(options);
    expect(repeated.map(source => source.sessionId)).toEqual(sources.map(source => source.sessionId));
    const aliased = await discoverTranscriptSources({ ...options, env: { PI_CODING_AGENT_DIR: '~/.pi/agent' } });
    expect(aliased.map(source => source.rawFilePath).sort()).toEqual([defaultFile, desktopFile, subagentFile].sort());
  });

  it('rebuilds native Pi observations and keeps their identity when the resume path changes', async () => {
    const root = await makeTempRoot();
    const homeDir = path.join(root, 'home');
    const userDataDir = path.join(root, 'user-data');
    const rawFilePath = await writeJsonl(path.join(userDataDir, 'pi-agent-home', 'sessions', 'native.jsonl'));
    const document = skillDocument('word-doc', 'Observed Pi skill rules.');
    const timestamp = '2026-06-20T01:00:00.000Z';
    await writeFile(rawFilePath, [
      JSON.stringify({ type: 'session', version: 3, id: 'native-id', cwd: root }),
      JSON.stringify({ type: 'message', id: 'user', parentId: null, timestamp, message: { role: 'user', content: 'Use the skill.' } }),
      JSON.stringify({ type: 'message', id: 'call', parentId: 'user', timestamp, message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'read-id', name: 'read', arguments: { path: path.join(root, 'word-doc', 'SKILL.md') } },
      ] } }),
      JSON.stringify({ type: 'message', id: 'result', parentId: 'call', timestamp, message: {
        role: 'toolResult', toolCallId: 'read-id', content: [{ type: 'text', text: document }], isError: false,
      } }),
    ].join('\n'), 'utf-8');
    const db = createUsageDb();
    db.prepare("INSERT OR REPLACE INTO migration_meta (key, value) VALUES ('skill_usage_analyzer_version', '6')").run();
    try {
      await refreshLocalSkillUsageAnalytics(db, { homeDir, userDataDir, appDataDir: path.join(root, 'app-data'), env: {}, nowMs });
      expect(db.prepare(`SELECT analyzer_version AS version, agent_kind AS agentKind, raw_file_path AS rawFilePath,
        sdk_session_id AS sdkSessionId, raw_line_no AS lineNo, source FROM skill_usage_exposures`).get()).toEqual({
        version: '7', agentKind: 'pi', rawFilePath, sdkSessionId: rawFilePath, lineNo: 4, source: 'pi_skill_file_read',
      });
      expect(db.prepare("SELECT value FROM migration_meta WHERE key = 'skill_usage_analyzer_version'").pluck().get()).toBe('7');
      const observationId = db.prepare('SELECT id FROM skill_usage_exposures').pluck().get();
      const relocated = path.join(path.dirname(rawFilePath), 'renamed.jsonl');
      await rename(rawFilePath, relocated);
      await refreshLocalSkillUsageAnalytics(db, { homeDir, userDataDir, appDataDir: path.join(root, 'app-data'), env: {}, nowMs });
      expect(db.prepare('SELECT id, session_id AS sessionId, sdk_session_id AS sdkSessionId FROM skill_usage_exposures').all())
        .toEqual([{ id: observationId, sessionId: 'pi-native-id', sdkSessionId: relocated }]);
    } finally {
      db.close();
    }
  });
});
