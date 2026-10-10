import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { brandUserDataDirName } from '@cindy/maker-shared/brand-identity';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import type { SupportedLocale } from '../../shared/locale';
import type { SkillUsageRefreshStatus } from '../../shared/skillUsageRefresh';
export type { SkillUsageRefreshStatus } from '../../shared/skillUsageRefresh';

import type { DbClient } from '../localDb/client/DbClient.js';
import { getCurrentDbClientSnapshot, getDbClient, type CurrentDbClientSnapshot } from '../localDb/client/current.js';

import { analyzeSkillUsageTranscript, hashSkillContent, type SkillUsageAgentKind } from './usageAnalyzer';
import {
  deleteSkillUsageRecordsBefore,
  deleteSkillUsageRecordsBeforeWithClient,
  getSkillUsageDiagnosisContextFromClient,
  getSkillUsageDiagnosisContextFromDb,
  getSkillUsageSummaryFromClient,
  getSkillUsageSummaryFromDb,
  listSkillUsageSourcesWithRecentExposures,
  listSkillUsageSourcesWithRecentExposuresFromClient,
  markSkillUsageSourceFailed,
  markSkillUsageSourceFailedWithClient,
  persistSkillUsageAnalysis,
  persistSkillUsageAnalysisWithClient,
  prepareSkillUsageCache,
  prepareSkillUsageCacheWithClient,
  type SkillUsageDiagnosisContext,
  type SkillUsageRecentSourceRecord,
  type SkillUsageSummary,
} from './usageStore';
import { recentWindowStartMs } from './usageWindow';

export interface TranscriptSource {
  agentKind: SkillUsageAgentKind;
  rawFilePath: string;
  sessionId: string;
  sdkSessionId: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface TranscriptDiscoveryOptions {
  homeDir?: string;
  appDataDir?: string;
  userDataDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  maxSourcesPerRefresh?: number;
  maxDiscoveredTranscriptFiles?: number;
  nowMs?: number;
  statSource?: (file: string) => Promise<SourceStat | null>;
}

export interface SkillUsageRefreshOptions extends TranscriptDiscoveryOptions {
  readTranscriptFile?: (file: string) => Promise<string>;
}

interface TranscriptDiscoveryContext {
  homeDir: string;
  appDataDir: string;
  userDataDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

interface SourceStat {
  mtimeMs: number;
  sizeBytes: number;
}

interface TranscriptFileCollection {
  files: string[];
  hadIncompleteDiscovery: boolean;
}

interface JsonlFileCollectionOptions {
  maxFiles?: number;
}

interface CachedSourceStat {
  analyzerVersion: string;
  agentKind: SkillUsageAgentKind;
  sessionId: string;
  mtimeMs: number;
  sizeBytes: number;
  status: string;
}

type SkillUsageDatabase = Database.Database | DbClient;

export interface SkillUsageSummaryResult {
  success: true;
  summary: SkillUsageSummary;
  refreshing: boolean;
  refreshStatus: SkillUsageRefreshStatus;
}

export interface SkillUsageDiagnosisContextResult {
  success: true;
  context: SkillUsageDiagnosisContext;
  refreshStatus: SkillUsageRefreshStatus;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_SOURCES_PER_REFRESH = 1_000;
const MAX_DISCOVERED_TRANSCRIPT_FILES = 100_000;
const TRANSCRIPT_STAT_CONCURRENCY = 32;
const MIN_BACKGROUND_REFRESH_INTERVAL_MS = 15_000;
// 只用于派生缓存失效；格式不匹配时直接清空并重建，不读取旧格式统计。
const ANALYZER_VERSION = '7';
interface SkillUsageRefreshState {
  promise: Promise<void> | null;
  lastBackgroundRefreshFinishedAt: number;
  status: SkillUsageRefreshStatus;
  ownerKey: string | null;
  initialization: Promise<void> | null;
}
const refreshStateByDatabase = new WeakMap<object, SkillUsageRefreshState>();
let activeRefreshCount = 0;

export async function getLocalSkillUsageSummary(params: {
  skillName: string;
  currentSkillContent?: string | null;
  db?: Database.Database;
  client?: DbClient;
}): Promise<SkillUsageSummaryResult> {
  const currentDocumentHash = params.currentSkillContent
    ? hashSkillContent(params.currentSkillContent)
    : null;
  const database = params.db ?? params.client ?? getDbClient();
  await initializeSkillUsageCache(database);
  requestLocalSkillUsageAnalyticsRefresh(database);
  const analyzerVersion = ANALYZER_VERSION;
  const refreshStatus = getLocalSkillUsageRefreshStatus(database);
  const refreshing = isLocalSkillUsageAnalyticsRefreshing(database);
  return {
    success: true,
    summary: isRawDatabase(database)
      ? getSkillUsageSummaryFromDb(database, {
          skillName: params.skillName,
          currentDocumentHash,
          currentDocumentContent: params.currentSkillContent ?? null,
          analyzerVersion,
        })
      : await getSkillUsageSummaryFromClient(database, {
          skillName: params.skillName,
          currentDocumentHash,
          currentDocumentContent: params.currentSkillContent ?? null,
          analyzerVersion,
        }),
    refreshing,
    refreshStatus,
  };
}

export async function getLocalSkillUsageDiagnosisContext(params: {
  skillName: string;
  currentSkillContent?: string | null;
  skillPath?: string | null;
  locale?: SupportedLocale;
  db?: Database.Database;
  client?: DbClient;
}): Promise<SkillUsageDiagnosisContextResult> {
  const currentDocumentHash = params.currentSkillContent
    ? hashSkillContent(params.currentSkillContent)
    : null;
  const database = params.db ?? params.client ?? getDbClient();
  await initializeSkillUsageCache(database);
  requestLocalSkillUsageAnalyticsRefresh(database);
  const analyzerVersion = ANALYZER_VERSION;
  const refreshStatus = getLocalSkillUsageRefreshStatus(database);
  return {
    success: true,
    refreshStatus,
    context: isRawDatabase(database)
      ? getSkillUsageDiagnosisContextFromDb(database, {
          skillName: params.skillName,
          currentDocumentHash,
          currentDocumentContent: params.currentSkillContent ?? null,
          analyzerVersion,
          skillPath: params.skillPath ?? null,
          locale: params.locale,
          refreshStatus,
        })
      : await getSkillUsageDiagnosisContextFromClient(database, {
          skillName: params.skillName,
          currentDocumentHash,
          currentDocumentContent: params.currentSkillContent ?? null,
          analyzerVersion,
          skillPath: params.skillPath ?? null,
          locale: params.locale,
          refreshStatus,
        }),
  };
}

export function isLocalSkillUsageAnalyticsRefreshing(database?: SkillUsageDatabase): boolean {
  return database
    ? getRefreshState(database).promise !== null
    : activeRefreshCount > 0;
}

export function getLocalSkillUsageRefreshStatus(database: SkillUsageDatabase = getDbClient()): SkillUsageRefreshStatus {
  return { ...getRefreshState(database).status };
}

export function requestLocalSkillUsageAnalyticsRefresh(
  database: SkillUsageDatabase = getDbClient(),
): Promise<void> | null {
  const state = getRefreshState(database);
  if (state.promise) return state.promise;
  const now = Date.now();
  if (now - state.lastBackgroundRefreshFinishedAt < MIN_BACKGROUND_REFRESH_INTERVAL_MS) return null;
  return startLocalSkillUsageAnalyticsRefresh(database);
}

export function refreshLocalSkillUsageAnalytics(
  database: SkillUsageDatabase = getDbClient(),
  options: SkillUsageRefreshOptions = {},
): Promise<void> {
  return startLocalSkillUsageAnalyticsRefresh(database, options);
}

function startLocalSkillUsageAnalyticsRefresh(
  database: SkillUsageDatabase,
  options: SkillUsageRefreshOptions = {},
): Promise<void> {
  const state = getRefreshState(database);
  if (!state.promise) {
    activeRefreshCount += 1;
    state.status = { ...state.status, phase: 'discovering', scanned: 0, total: 0, incomplete: false, missingCount: 0, error: null };
    state.promise = runLocalSkillUsageAnalyticsRefresh(database, options, state).catch((error: unknown) => {
      state.status = { ...state.status, phase: 'incomplete', incomplete: true, error: error instanceof Error ? error.message : String(error) };
    }).finally(() => {
      state.lastBackgroundRefreshFinishedAt = Date.now();
      state.promise = null;
      activeRefreshCount -= 1;
    });
  }
  return state.promise;
}

function getRefreshState(database: SkillUsageDatabase): SkillUsageRefreshState {
  const snapshot = captureRefreshSnapshot(database);
  const ownerKey = snapshot ? `${snapshot.userId}:${snapshot.clientEpoch}` : null;
  const existing = refreshStateByDatabase.get(database);
  if (existing?.ownerKey === ownerKey) return existing;
  const state: SkillUsageRefreshState = {
    promise: null,
    lastBackgroundRefreshFinishedAt: 0,
    ownerKey,
    initialization: null,
    status: { phase: 'idle', scanned: 0, total: 0, lastSuccessAt: null, hasSnapshot: false, incomplete: false, missingCount: 0, error: null },
  };
  refreshStateByDatabase.set(database, state);
  return state;
}

function initializeSkillUsageCache(database: SkillUsageDatabase): Promise<void> {
  const state = getRefreshState(database);
  if (!state.initialization) {
    const snapshot = captureRefreshSnapshot(database);
    state.initialization = (async () => {
      if (!isRefreshDatabaseStable(snapshot)) return;
      if (isRawDatabase(database)) prepareSkillUsageCache(database, ANALYZER_VERSION);
      else await prepareSkillUsageCacheWithClient(database, ANALYZER_VERSION);
      if (!isRefreshDatabaseStable(snapshot)) return;
      const sql = "SELECT value FROM migration_meta WHERE key = 'skill_usage_last_success_at'";
      const row = isRawDatabase(database)
        ? database.prepare(sql).get() as { value: string } | undefined
        : await database.queryOne<{ value: string }>(sql);
      const lastSuccessAt = Number(row?.value) || null;
      state.status.lastSuccessAt = lastSuccessAt;
      state.status.hasSnapshot = lastSuccessAt !== null;
    })().catch((error: unknown) => {
      state.initialization = null;
      throw error;
    });
  }
  return state.initialization;
}

async function runLocalSkillUsageAnalyticsRefresh(
  database: SkillUsageDatabase,
  options: SkillUsageRefreshOptions = {},
  state: SkillUsageRefreshState = getRefreshState(database),
): Promise<void> {
  // In-process DbClient resolves getRawDb() dynamically. Keep the refresh tied
  // to the owner/epoch it started with so an account switch cannot redirect a
  // later write, cleanup, or promotion into the next owner's database.
  const snapshot = captureRefreshSnapshot(database);
  if (!isRefreshDatabaseStable(snapshot)) return;
  await initializeSkillUsageCache(database);
  if (!isRefreshDatabaseStable(snapshot)) return;
  const nowMs = options.nowMs ?? Date.now();
  const recentSince = recentWindowStartMs(nowMs);
  const platform = options.platform ?? process.platform;
  const discovery = await discoverTranscriptSourcesForRefresh({ ...options, nowMs });
  const cachedRecent = await statCachedRecentSources(
    database,
    recentSince,
    options.statSource ?? statSource,
  );
  if (!isRefreshDatabaseStable(snapshot)) return;
  const readTranscriptFile = options.readTranscriptFile ?? ((file: string) => fs.readFile(file, 'utf-8'));
  const sourceBatchSize = Math.max(1, options.maxSourcesPerRefresh ?? MAX_SOURCES_PER_REFRESH);
  const sources = mergeTranscriptSources(discovery.sources, cachedRecent.sources, platform);
  const cachedSourceStats = await readCachedSourceStats(database, sources.map((source) => source.rawFilePath));
  const dirtySources = sources.filter((source) => !isCachedSourceFresh(cachedSourceStats, source));
  const indexedIdentities = new Map<string, TranscriptSource>();
  // 刷新失败仍需保护已有证据，不能把文件变脏等同于尚无有效结果。
  for (const source of cachedRecent.snapshotSources) {
    const key = `${source.agentKind}:${source.sessionId}`;
    const previous = indexedIdentities.get(key);
    if (!previous || compareTranscriptSourcesByRecency(source, previous) < 0) indexedIdentities.set(key, source);
  }
  for (const source of sources) {
    if (!isCachedSourceFresh(cachedSourceStats, source)) continue;
    const cached = cachedSourceStats.get(source.rawFilePath)!;
    const key = `${cached.agentKind}:${cached.sessionId}`;
    const previous = indexedIdentities.get(key);
    if (!previous || compareTranscriptSourcesByRecency(source, previous) < 0) indexedIdentities.set(key, source);
  }
  state.status = { ...state.status, phase: 'indexing', total: sources.length, scanned: sources.length - dirtySources.length };
  const scannedAt = Date.now();
  let failedCount = 0;
  for (let start = 0; start < dirtySources.length; start += sourceBatchSize) {
    const batch = dirtySources.slice(start, start + sourceBatchSize);
    for (const discoveredSource of batch) {
      let source = discoveredSource;
      if (!isRefreshDatabaseStable(snapshot)) return;
      try {
        const text = await readTranscriptFile(source.rawFilePath);
        const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
        source = resolveTranscriptIdentity(source, lines);
        const identity = `${source.agentKind}:${source.sessionId}`;
        const previous = indexedIdentities.get(identity);
        // 旧 home 或归档目录可能保留副本；不能让较旧副本覆盖已索引的新日志。
        if (previous && normalizePathForCompare(previous.rawFilePath, platform) !== normalizePathForCompare(source.rawFilePath, platform)
          && compareTranscriptSourcesByRecency(previous, source) <= 0) continue;
        validateTranscriptLines(lines);
        const analysis = analyzeSkillUsageTranscript({
          agentKind: source.agentKind,
          sessionId: source.sessionId,
          sdkSessionId: source.sdkSessionId,
          rawFilePath: source.rawFilePath,
          lines,
        });
        if (!isRefreshDatabaseStable(snapshot)) return;
        await persistSkillUsageAnalysisInDatabase(database, {
          rawFilePath: source.rawFilePath,
          analyzerVersion: ANALYZER_VERSION,
          agentKind: source.agentKind,
          sessionId: source.sessionId,
          sdkSessionId: source.sdkSessionId,
          mtimeMs: source.mtimeMs,
          sizeBytes: source.sizeBytes,
          scannedAt,
        }, analysis);
        indexedIdentities.set(identity, source);
      } catch (err) {
        failedCount += 1;
        if (!isRefreshDatabaseStable(snapshot)) return;
        await markSkillUsageSourceFailedInDatabase(database, {
          rawFilePath: source.rawFilePath,
          analyzerVersion: ANALYZER_VERSION,
          agentKind: source.agentKind,
          sessionId: source.sessionId,
          sdkSessionId: source.sdkSessionId,
          mtimeMs: source.mtimeMs,
          sizeBytes: source.sizeBytes,
          scannedAt,
          error: err instanceof Error ? err.message : String(err),
        });
        state.status.error ??= err instanceof Error ? err.message : String(err);
      } finally {
        state.status.scanned += 1;
      }
    }
    if (start + sourceBatchSize < dirtySources.length) await yieldToEventLoop();
  }
  if (!isRefreshDatabaseStable(snapshot)) return;
  if (!discovery.hadDiscoveryFailure && !cachedRecent.hadStatFailure) {
    state.status.missingCount = await markMissingSources(database, cachedRecent.missingPaths, recentSince);
    if (!isRefreshDatabaseStable(snapshot)) return;
    await deleteSkillUsageRecordsBeforeInDatabase(database, ANALYZER_VERSION, recentSince);
  }
  if (!discovery.hadDiscoveryFailure && !cachedRecent.hadStatFailure && failedCount === 0) {
    if (!isRefreshDatabaseStable(snapshot)) return;
    const lastSuccessAt = await finishSkillUsageRefresh(database);
    state.status = { ...state.status, phase: 'complete', lastSuccessAt, hasSnapshot: true };
  } else {
    state.status = { ...state.status, phase: 'incomplete', incomplete: true,
      error: state.status.error ?? (discovery.hadDiscoveryFailure ? 'transcript_discovery_incomplete' : 'transcript_stat_failed') };
  }
}

async function markMissingSources(database: SkillUsageDatabase, rawFilePaths: string[], recentSince: number): Promise<number> {
  if (rawFilePaths.length > 0) {
    const sql = `UPDATE skill_usage_sources SET status = 'missing', error = NULL, last_scanned_at = ?
      WHERE raw_file_path IN (SELECT CAST(value AS TEXT) FROM json_each(?))`;
    const params = [Date.now(), JSON.stringify(rawFilePaths)];
    if (isRawDatabase(database)) database.prepare(sql).run(...params);
    else await database.exec(sql, params);
  }
  const sql = `SELECT COUNT(*) AS count FROM skill_usage_sources missing
    WHERE missing.status = 'missing' AND missing.last_scanned_at >= ?
      AND NOT EXISTS (SELECT 1 FROM skill_usage_sources current
        WHERE current.agent_kind = missing.agent_kind AND current.session_id = missing.session_id AND current.status = 'ok')`;
  const row = isRawDatabase(database) ? database.prepare(sql).get(recentSince) as { count: number }
    : await database.queryOne<{ count: number }>(sql, [recentSince]);
  return row?.count ?? 0;
}

// 原生会话身份用于统计；Pi 的 sdkSessionId 则继续保存恢复入口，不能混为一个键。
function resolveTranscriptIdentity(source: TranscriptSource, lines: string[]): TranscriptSource {
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch { continue; }
    if (source.agentKind === 'pi' && record.type === 'session' && typeof record.id === 'string') {
      return { ...source, sessionId: `pi-${record.id}` };
    }
    if (source.agentKind === 'codex' && record.type === 'session_meta') {
      const payload = record.payload as { id?: unknown } | undefined;
      if (typeof payload?.id === 'string') return { ...source, sessionId: `codex-${payload.id}`, sdkSessionId: payload.id };
    }
    if (source.agentKind === 'claude-code' && typeof record.sessionId === 'string') {
      const childId = typeof record.agentId === 'string' ? record.agentId
        : path.basename(path.dirname(source.rawFilePath)) === 'subagents' ? path.basename(source.rawFilePath, '.jsonl') : null;
      const identity = childId ? `${record.sessionId}:${childId}` : record.sessionId;
      return { ...source, sessionId: `claude-${identity}`, sdkSessionId: identity };
    }
  }
  return source;
}

function validateTranscriptLines(lines: string[]): void {
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      const record: unknown = JSON.parse(lines[index]);
      if (record && typeof record === 'object' && !Array.isArray(record)) continue;
    } catch { /* 写入中的尾行下次重试，不把半份日志替换进已有快照。 */ }
    throw new Error(`transcript_parse_failed: line ${index + 1}`);
  }
}

type RefreshSnapshot = CurrentDbClientSnapshot | null;

function captureRefreshSnapshot(database: SkillUsageDatabase): RefreshSnapshot {
  if (isRawDatabase(database)) return null;
  const snapshot = getCurrentDbClientSnapshot();
  return snapshot?.client === database ? snapshot : null;
}

function isRefreshDatabaseStable(snapshot: RefreshSnapshot): boolean {
  if (!snapshot) return true;
  const current = getCurrentDbClientSnapshot();
  return current?.client === snapshot.client
    && current.userId === snapshot.userId
    && current.clientEpoch === snapshot.clientEpoch;
}

async function finishSkillUsageRefresh(database: SkillUsageDatabase): Promise<number> {
  const lastSuccessAt = Date.now();
  const sql = `INSERT INTO migration_meta (key, value) VALUES ('skill_usage_last_success_at', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  if (isRawDatabase(database)) database.prepare(sql).run(String(lastSuccessAt));
  else await database.exec(sql, [String(lastSuccessAt)]);
  return lastSuccessAt;
}

function isRawDatabase(database: SkillUsageDatabase): database is Database.Database {
  return 'prepare' in database && typeof database.prepare === 'function';
}

async function persistSkillUsageAnalysisInDatabase(
  database: SkillUsageDatabase,
  source: Parameters<typeof persistSkillUsageAnalysis>[1],
  analysis: Parameters<typeof persistSkillUsageAnalysis>[2],
): Promise<void> {
  if (isRawDatabase(database)) persistSkillUsageAnalysis(database, source, analysis);
  else await persistSkillUsageAnalysisWithClient(database, source, analysis);
}

async function markSkillUsageSourceFailedInDatabase(
  database: SkillUsageDatabase,
  source: Parameters<typeof markSkillUsageSourceFailed>[1],
): Promise<void> {
  if (isRawDatabase(database)) markSkillUsageSourceFailed(database, source);
  else await markSkillUsageSourceFailedWithClient(database, source);
}

async function deleteSkillUsageRecordsBeforeInDatabase(
  database: SkillUsageDatabase,
  analyzerVersion: string,
  recentSince: number,
): Promise<void> {
  if (isRawDatabase(database)) deleteSkillUsageRecordsBefore(database, analyzerVersion, recentSince);
  else await deleteSkillUsageRecordsBeforeWithClient(database, analyzerVersion, recentSince);
}

export async function discoverTranscriptSources(options: TranscriptDiscoveryOptions = {}): Promise<TranscriptSource[]> {
  const result = await discoverTranscriptSourcesForRefresh(options);
  return result.sources;
}

async function discoverTranscriptSourcesForRefresh(options: TranscriptDiscoveryOptions = {}): Promise<{
  sources: TranscriptSource[];
  hadDiscoveryFailure: boolean;
}> {
  const context = resolveTranscriptDiscoveryContext(options);
  const recentSince = recentWindowStartMs(options.nowMs ?? Date.now());
  const maxDiscoveredTranscriptFiles = Math.max(
    1,
    options.maxDiscoveredTranscriptFiles ?? MAX_DISCOVERED_TRANSCRIPT_FILES,
  );
  const [claudeHomes, codexHomes, piHomes] = await Promise.all([
    uniqueExistingDirectories(claudeHomeCandidates(context), context.platform),
    uniqueExistingDirectories(codexHomeCandidates(context), context.platform),
    uniqueExistingDirectories(piHomeCandidates(context), context.platform),
  ]);
  const [claudeFileGroups, codexFileGroups, piFileGroups] = await Promise.all([
    Promise.all(claudeHomes.map((home) => collectJsonlFiles(
      path.join(home, 'projects'),
      { maxFiles: maxDiscoveredTranscriptFiles },
    ))),
    Promise.all(codexHomes.flatMap((home) => [
      collectJsonlFiles(path.join(home, 'sessions'), { maxFiles: maxDiscoveredTranscriptFiles }),
      collectJsonlFiles(path.join(home, 'archived_sessions'), { maxFiles: maxDiscoveredTranscriptFiles }),
    ])),
    Promise.all(piHomes.flatMap((home) => [
      collectJsonlFiles(path.join(home, 'sessions'), { maxFiles: maxDiscoveredTranscriptFiles }),
      collectPiSubagentTranscripts(path.join(home, 'runtime', 'pi-subagent-runs'), maxDiscoveredTranscriptFiles),
    ])),
  ]);
  const hadIncompleteDiscovery = [...claudeFileGroups, ...codexFileGroups, ...piFileGroups].some((group) => group.hadIncompleteDiscovery);
  const claudeFiles = uniquePaths(claudeFileGroups.flatMap((group) => group.files), context.platform);
  const codexFiles = uniquePaths(codexFileGroups.flatMap((group) => group.files), context.platform);
  const piFiles = uniquePaths(piFileGroups.flatMap((group) => group.files), context.platform);
  const candidates = [
    ...claudeFiles.map((file): Omit<TranscriptSource, 'mtimeMs' | 'sizeBytes'> => {
      const sdkSessionId = claudeSdkSessionIdFromFile(file);
      return {
        agentKind: 'claude-code',
        rawFilePath: file,
        sessionId: `claude-${sdkSessionId}`,
        sdkSessionId,
      };
    }),
    ...codexFiles.map((file): Omit<TranscriptSource, 'mtimeMs' | 'sizeBytes'> => {
      const sdkSessionId = codexThreadIdFromFile(file);
      return {
        agentKind: 'codex',
        rawFilePath: file,
        sessionId: `codex-${sdkSessionId}`,
        sdkSessionId,
      };
    }),
    ...piFiles.map((file): Omit<TranscriptSource, 'mtimeMs' | 'sizeBytes'> => ({
      agentKind: 'pi',
      rawFilePath: file,
      // Pi 原生恢复入口是 session 文件绝对路径，不从带日期的文件名猜 UUID。
      // 发现阶段尚未读取 header；无法确认原生身份时避免合并恰好同名的文件。
      sessionId: `pi-${createHash('sha256').update(normalizePathForCompare(file, context.platform)).digest('hex').slice(0, 32)}`,
      sdkSessionId: file,
    })),
  ];
  const result = await statTranscriptSources(
    candidates,
    options.statSource ?? statSource,
    recentSince,
  );
  return {
    sources: result.sources,
    hadDiscoveryFailure: hadIncompleteDiscovery || result.hadStatFailure,
  };
}

function claudeSdkSessionIdFromFile(file: string): string {
  const basename = path.basename(file, '.jsonl');
  if (path.basename(path.dirname(file)) !== 'subagents') return basename;
  const suffix = createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 12);
  return `${basename}-${suffix}`;
}

async function collectPiSubagentTranscripts(root: string, maxFiles: number): Promise<TranscriptFileCollection> {
  const result: TranscriptFileCollection = { files: [], hadIncompleteDiscovery: false };
  async function directories(dir: string): Promise<string[]> {
    try {
      return (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
    } catch (error) {
      if (!isMissingCollectionRoot(root, dir, error)) result.hadIncompleteDiscovery = true;
      return [];
    }
  }
  for (const parent of await directories(root)) {
    for (const run of await directories(parent)) {
      if (result.files.length >= maxFiles) return { ...result, hadIncompleteDiscovery: true };
      const group = await collectJsonlFiles(path.join(run, 'sessions'), { maxFiles: maxFiles - result.files.length });
      result.files.push(...group.files);
      result.hadIncompleteDiscovery ||= group.hadIncompleteDiscovery;
    }
  }
  return result;
}

function resolveTranscriptDiscoveryContext(options: TranscriptDiscoveryOptions): TranscriptDiscoveryContext {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const appDataDir = options.appDataDir ?? env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming');
  return {
    homeDir,
    appDataDir,
    userDataDir: options.userDataDir ?? env.XDT_USER_DATA_DIR ?? defaultXdtUserDataDir(platform, homeDir, appDataDir, env),
    env,
    platform,
  };
}

// 生产调用链 options 为空时会落到这里(不经 app.getPath),目录名必须与
// Electron userData 实际目录一致——从 brand-identity 派生,改名时自动跟随。
function defaultXdtUserDataDir(
  platform: NodeJS.Platform,
  homeDir: string,
  appDataDir: string,
  env: NodeJS.ProcessEnv,
): string {
  // 按现有区域目录映射取值(global=CindyGlobal,cn=Cindy，同机双装分库)。
  const dirName = brandUserDataDirName(CURRENT_CINDY_REGION);
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', dirName);
  if (platform === 'win32') return path.join(appDataDir, dirName);
  return path.join(env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config'), dirName);
}

function claudeHomeCandidates(context: TranscriptDiscoveryContext): string[] {
  return [
    context.env.CLAUDE_CONFIG_DIR ?? '',
    path.join(context.homeDir, '.claude'),
    path.join(context.userDataDir, 'claude-home'),
  ];
}

function codexHomeCandidates(context: TranscriptDiscoveryContext): string[] {
  const candidates = [
    context.env.CODEX_HOME ?? '',
    path.join(context.homeDir, '.codex'),
    path.join(context.userDataDir, 'codex-home'),
  ];
  if (context.platform === 'darwin') {
    const appSupport = path.join(context.homeDir, 'Library', 'Application Support');
    candidates.push(path.join(appSupport, 'Codex', 'codex-home'), path.join(appSupport, 'Codex'));
  } else if (context.platform === 'win32') {
    candidates.push(path.join(context.appDataDir, 'Codex', 'codex-home'), path.join(context.appDataDir, 'Codex'));
  } else {
    candidates.push(path.join(context.env.XDG_CONFIG_HOME ?? path.join(context.homeDir, '.config'), 'codex'));
  }
  return candidates;
}

function piHomeCandidates(context: TranscriptDiscoveryContext): string[] {
  const configured = context.env.PI_CODING_AGENT_DIR;
  return [
    configured ? path.resolve(configured.replace(/^~(?=$|[\\/])/, () => context.homeDir)) : '',
    path.join(context.homeDir, '.pi', 'agent'),
    path.join(context.userDataDir, 'pi-agent-home'),
  ];
}

async function uniqueExistingDirectories(candidates: string[], platform: NodeJS.Platform): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.trim()) continue;
    const real = await realDirectoryPath(candidate);
    if (!real) continue;
    const key = normalizePathForCompare(real, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real);
  }
  return out;
}

async function realDirectoryPath(candidate: string): Promise<string | null> {
  try {
    const real = await fs.realpath(candidate);
    const stat = await fs.stat(real);
    return stat.isDirectory() ? real : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function uniquePaths(files: string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    const key = normalizePathForCompare(file, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function normalizePathForCompare(filePath: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(filePath);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function collectJsonlFiles(
  root: string,
  options: JsonlFileCollectionOptions = {},
): Promise<TranscriptFileCollection> {
  const files: string[] = [];
  let hadIncompleteDiscovery = false;
  const maxFiles = Math.max(1, options.maxFiles ?? MAX_DISCOVERED_TRANSCRIPT_FILES);
  const stack = [root];
  while (stack.length > 0 && files.length < maxFiles) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (!isMissingCollectionRoot(root, dir, err)) hadIncompleteDiscovery = true;
      continue;
    }
    const sortedEntries = [...entries].sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of sortedEntries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
        if (files.length >= maxFiles) {
          hadIncompleteDiscovery = true;
          break;
        }
      }
    }
    if (files.length >= maxFiles) break;
    for (const entry of [...sortedEntries].reverse()) {
      if (!entry.isDirectory()) continue;
      const childDir = path.join(dir, entry.name);
      stack.push(childDir);
    }
  }
  if (stack.length > 0) hadIncompleteDiscovery = true;
  return { files, hadIncompleteDiscovery };
}

function isMissingCollectionRoot(root: string, dir: string, err: unknown): boolean {
  return dir === root && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function statCachedRecentSources(
  database: SkillUsageDatabase,
  recentSince: number,
  statFile: (file: string) => Promise<SourceStat | null>,
): Promise<{ sources: TranscriptSource[]; snapshotSources: TranscriptSource[]; hadStatFailure: boolean; missingPaths: string[] }> {
  const cachedSources = isRawDatabase(database)
    ? listSkillUsageSourcesWithRecentExposures(database, ANALYZER_VERSION, recentSince)
    : await listSkillUsageSourcesWithRecentExposuresFromClient(database, ANALYZER_VERSION, recentSince);
  if (cachedSources.length === 0) return { sources: [], snapshotSources: [], hadStatFailure: false, missingPaths: [] };
  const result = await statTranscriptSourcesWithoutRecentFilter(cachedSources, statFile);
  return result;
}

async function statTranscriptSourcesWithoutRecentFilter(
  cachedSources: SkillUsageRecentSourceRecord[],
  statFile: (file: string) => Promise<SourceStat | null>,
): Promise<{ sources: TranscriptSource[]; snapshotSources: TranscriptSource[]; hadStatFailure: boolean; missingPaths: string[] }> {
  const sources: TranscriptSource[] = [];
  const snapshotSources: TranscriptSource[] = [];
  const missingPaths: string[] = [];
  let hadStatFailure = false;
  for (const cached of cachedSources) {
    try {
      const stat = await statFile(cached.rawFilePath);
      if (!stat) {
        missingPaths.push(cached.rawFilePath);
        continue;
      }
      sources.push({ ...cached, ...stat });
      snapshotSources.push({ ...cached, ...stat });
    } catch {
      hadStatFailure = true;
      snapshotSources.push(cached);
    }
  }
  return { sources, snapshotSources, hadStatFailure, missingPaths };
}

async function statTranscriptSources(
  candidates: Array<Omit<TranscriptSource, 'mtimeMs' | 'sizeBytes'>>,
  statFile: (file: string) => Promise<SourceStat | null>,
  recentSince: number,
): Promise<{ sources: TranscriptSource[]; hadStatFailure: boolean }> {
  if (candidates.length === 0) {
    return { sources: [], hadStatFailure: false };
  }

  const sources: TranscriptSource[] = [];
  let nextIndex = 0;
  let hadStatFailure = false;
  const workerCount = Math.min(TRANSCRIPT_STAT_CONCURRENCY, candidates.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < candidates.length) {
      const candidate = candidates[nextIndex];
      nextIndex += 1;
      try {
        const stat = await statFile(candidate.rawFilePath);
        if (!stat) {
          hadStatFailure = true;
          continue;
        }
        if (stat.mtimeMs < recentSince) continue;
        sources.push({ ...candidate, ...stat });
      } catch {
        hadStatFailure = true;
      }
    }
  });
  await Promise.all(workers);
  sources.sort(compareTranscriptSourcesByRecency);
  return { sources, hadStatFailure };
}

function mergeTranscriptSources(
  discoveredSources: TranscriptSource[],
  cachedSources: TranscriptSource[],
  platform: NodeJS.Platform,
): TranscriptSource[] {
  const byPath = new Map<string, TranscriptSource>();
  for (const source of cachedSources) {
    byPath.set(normalizePathForCompare(source.rawFilePath, platform), source);
  }
  for (const source of discoveredSources) {
    byPath.set(normalizePathForCompare(source.rawFilePath, platform), source);
  }
  return [...byPath.values()].sort(compareTranscriptSourcesByRecency);
}

function compareTranscriptSourcesByRecency(a: TranscriptSource, b: TranscriptSource): number {
  return b.mtimeMs - a.mtimeMs || b.sizeBytes - a.sizeBytes || a.rawFilePath.localeCompare(b.rawFilePath);
}

function isCachedSourceFresh(
  cachedSourceStats: ReadonlyMap<string, CachedSourceStat>,
  source: TranscriptSource,
): boolean {
  const cached = cachedSourceStats.get(source.rawFilePath);
  return (
    cached?.status === 'ok' &&
    cached.analyzerVersion === ANALYZER_VERSION &&
    cached.mtimeMs === source.mtimeMs &&
    cached.sizeBytes === source.sizeBytes
  );
}

async function statSource(file: string): Promise<SourceStat | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    return { mtimeMs: Math.round(stat.mtimeMs), sizeBytes: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readCachedSourceStats(
  database: SkillUsageDatabase,
  rawFilePaths: string[],
): Promise<Map<string, CachedSourceStat>> {
  if (rawFilePaths.length === 0) return new Map();
  const sql = `
    SELECT
      s.raw_file_path AS rawFilePath,
      s.analyzer_version AS analyzerVersion,
      s.agent_kind AS agentKind,
      s.session_id AS sessionId,
      s.mtime_ms AS mtimeMs,
      s.size_bytes AS sizeBytes,
      s.status
    FROM json_each(?) wanted
    JOIN skill_usage_sources s
      ON s.raw_file_path = CAST(wanted.value AS TEXT)
  `;
  const params = [JSON.stringify(rawFilePaths)];
  const rows = isRawDatabase(database)
    ? database.prepare(sql).all(...params) as Array<CachedSourceStat & { rawFilePath: string }>
    : await database.query<CachedSourceStat & { rawFilePath: string }>(sql, params);
  return new Map(rows.map((row) => [row.rawFilePath, row]));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function codexThreadIdFromFile(file: string): string {
  const name = path.basename(file, '.jsonl');
  return UUID_RE.exec(name)?.[0] ?? name;
}
